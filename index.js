import express from "express";
import axios from "axios";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.json({ limit: "20mb" }));

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const YC_VISION_API_KEY = process.env.YC_VISION_API_KEY;
const YC_GPT_API_KEY = process.env.YC_GPT_API_KEY;
const YC_FOLDER_ID = process.env.YC_FOLDER_ID;

// ===== временное состояние пользователей =====
const state = {}; 
// { userId: { products } }

// ===== Telegram helpers =====
async function send(chatId, text, keyboard = null) {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
  };
  if (keyboard) payload.reply_markup = keyboard;

  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, payload);
  } catch (e) {
    console.error("sendMessage error:", e.response?.data || e.message);
  }
}

function dietKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "🥘 Обычное", callback_data: "diet_normal" },
        { text: "🥗 ПП", callback_data: "diet_healthy" }
      ],
      [{ text: "🌱 Веган", callback_data: "diet_vegan" }],
      [
        { text: "🔥 Похудеть ⭐", callback_data: "diet_slim" },
        { text: "⚡ Быстро ⭐", callback_data: "diet_fast" }
      ]
    ]
  };
}

// ===== Yandex Vision =====
async function recognizeProductsFromImage(base64Image) {
  const body = {
    folderId: YC_FOLDER_ID,
    analyzeSpecs: [{
      content: base64Image,
      features: [{ type: "LABEL_DETECTION", maxResults: 10 }]
    }]
  };

  const res = await axios.post(
    "https://vision.api.cloud.yandex.net/vision/v1/batchAnalyze",
    body,
    {
      headers: {
        Authorization: `Api-Key ${YC_VISION_API_KEY}`
      }
    }
  );

  const labels = res.data.results[0].results[0].labelDetection.labels;
  return labels.map(l => l.description).join(", ");
}

// ===== Yandex GPT =====
async function generateRecipe(products, diet) {
  const prompt = `
Ты профессиональный повар.

Продукты: ${products}
Тип питания: ${diet}

Сделай ОДИН рецепт.
Формат строго такой:

<b>Название блюда</b>
⏱ Время | 👥 Порции
1. шаг
2. шаг
3. шаг
4. шаг
5. шаг
КБЖУ
`;

  const body = {
    modelUri: `gpt://${YC_FOLDER_ID}/yandexgpt-lite`,
    completionOptions: {
      temperature: 0.6,
      maxTokens: 600
    },
    messages: [{ role: "user", text: prompt }]
  };

  const res = await axios.post(
    "https://llm.api.cloud.yandex.net/foundationModels/v1/completion",
    body,
    {
      headers: {
        Authorization: `Api-Key ${YC_GPT_API_KEY}`
      }
    }
  );

  return res.data.result.alternatives[0].message.text;
}

// ===== Webhook =====
app.post("/", async (req, res) => {
  res.send("ok");
  const update = req.body;

  // ===== TEXT =====
  if (update.message?.text) {
    const chatId = update.message.chat.id;
    const userId = update.message.from.id;
    const text = update.message.text;

    if (text === "/start") {
      return send(
        chatId,
        "👋 Я твой <b>личный повар</b>\n\n📸 Пришли фото продуктов\nили\n✍️ напиши продукты через запятую"
      );
    }

    if (text.includes(",")) {
      state[userId] = { products: text };
      return send(chatId, "🍽 Выбери тип питания:", dietKeyboard());
    }
  }

  // ===== PHOTO =====
  if (update.message?.photo) {
    const chatId = update.message.chat.id;
    const userId = update.message.from.id;
    const fileId = update.message.photo.at(-1).file_id;

    const fileRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
    const filePath = fileRes.data.result.file_path;
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
    const img = await axios.get(fileUrl, { responseType: "arraybuffer" });
    const base64 = Buffer.from(img.data).toString("base64");

    const products = await recognizeProductsFromImage(base64);
    state[userId] = { products };

    return send(
      chatId,
      `🧺 Я вижу:\n<b>${products}</b>\n\nВыбери тип питания:`,
      dietKeyboard()
    );
  }

  // ===== BUTTONS =====
  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message.chat.id;
    const userId = cb.from.id;
    const diet = cb.data.replace("diet_", "");

    if (!state[userId]) {
      return send(chatId, "❗ Пришли продукты заново");
    }

    send(chatId, "👨‍🍳 Готовлю рецепт…");

    try {
      const recipe = await generateRecipe(state[userId].products, diet);
      delete state[userId];
      return send(chatId, recipe);
    } catch (e) {
      console.error(e);
      return send(chatId, "❌ Ошибка генерации рецепта");
    }
  }
});

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Bot started"));
