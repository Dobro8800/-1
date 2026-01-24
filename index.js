import express from "express";
import axios from "axios";

const app = express();
app.use(express.json({ limit: "20mb" }));

// ===== ENV =====
const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const YANDEX_GPT_API_KEY = process.env.YANDEX_GPT_API_KEY;
const YANDEX_STT_API_KEY = process.env.YANDEX_STT_API_KEY;
const YANDEX_FOLDER_ID = process.env.YANDEX_FOLDER_ID;

// ===== USER STATE =====
const state = {}; 
// state[userId] = { products }

// ===== TELEGRAM =====
async function send(chatId, text, keyboard = null) {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: "HTML"
  };
  if (keyboard) payload.reply_markup = keyboard;

  await axios.post(`${TELEGRAM_API}/sendMessage`, payload);
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
        { text: "🔥 Похудеть", callback_data: "diet_slim" },
        { text: "⚡ Быстро", callback_data: "diet_fast" }
      ]
    ]
  };
}

// ===== SPEECHKIT STT =====
async function speechToText(oggBuffer) {
  const res = await axios.post(
    "https://stt.api.cloud.yandex.net/speech/v1/stt:recognize",
    oggBuffer,
    {
      headers: {
        Authorization: `Api-Key ${YANDEX_STT_API_KEY}`,
        "Content-Type": "audio/ogg"
      },
      params: {
        folderId: YANDEX_FOLDER_ID,
        lang: "ru-RU"
      }
    }
  );

  return res.data.result;
}

// ===== YANDEX GPT 5.1 =====
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

  const res = await axios.post(
    "https://llm.api.cloud.yandex.net/foundationModels/v1/chat/completions",
    {
      model: "yandexgpt-5.1",
      messages: [{ role: "user", text: prompt }],
      temperature: 0.6,
      maxTokens: 600
    },
    {
      headers: {
        Authorization: `Api-Key ${YANDEX_GPT_API_KEY}`,
        "x-folder-id": YANDEX_FOLDER_ID
      }
    }
  );

  return res.data.result.alternatives[0].message.text;
}

// ===== WEBHOOK =====
app.post("/", async (req, res) => {
  res.send("ok");
  const update = req.body;

  try {
    // ===== TEXT =====
    if (update.message?.text) {
      const chatId = update.message.chat.id;
      const userId = update.message.from.id;
      const text = update.message.text;

      if (text === "/start") {
        return send(
          chatId,
          "👋 Я <b>бот-повар</b>\n\n🎤 Пришли голосом продукты\n✍️ или напиши через запятую"
        );
      }

      if (text.includes(",")) {
        state[userId] = { products: text };
        return send(chatId, "🍽 Выбери тип питания:", dietKeyboard());
      }
    }

    // ===== VOICE =====
    if (update.message?.voice) {
      const chatId = update.message.chat.id;
      const userId = update.message.from.id;
      const fileId = update.message.voice.file_id;

      const fileRes = await axios.get(
        `${TELEGRAM_API}/getFile?file_id=${fileId}`
      );

      const filePath = fileRes.data.result.file_path;
      const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;

      const audioRes = await axios.get(fileUrl, {
        responseType: "arraybuffer"
      });

      const text = await speechToText(audioRes.data);

      state[userId] = { products: text };

      return send(
        chatId,
        `🧺 Ты сказал:\n<b>${text}</b>\n\nВыбери тип питания:`,
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

      await send(chatId, "👨‍🍳 Готовлю рецепт…");

      const recipe = await generateRecipe(
        state[userId].products,
        diet
      );

      delete state[userId];
      return send(chatId, recipe);
    }
  } catch (e) {
    console.error("ERROR:", e.response?.data || e.message);
  }
});

// ===== START =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Bot started"));
