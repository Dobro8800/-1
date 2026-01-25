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

if (!BOT_TOKEN || !YANDEX_GPT_API_KEY || !YANDEX_STT_API_KEY || !YANDEX_FOLDER_ID) {
  throw new Error("ENV variables are missing");
}

// ===== USER STATE =====
const state = {};
const subscriptions = {}; // mock подписок

// ===== HEALTH =====
app.get("/", (_, res) => res.send("OK"));

// ===== SEND MESSAGE =====
async function send(chatId, text, keyboard = null) {
  const payload = { chat_id: chatId, text, parse_mode: "HTML" };
  if (keyboard) payload.reply_markup = keyboard;
  await axios.post(`${TELEGRAM_API}/sendMessage`, payload);
}

// ===== KEYBOARDS =====
const dietKeyboard = () => ({
  inline_keyboard: [
    [{ text: "🥘 Обычное", callback_data: "diet_normal" }],
    [{ text: "🥗 ПП", callback_data: "diet_healthy" }],
    [{ text: "🌱 Веган", callback_data: "diet_vegan" }],
    [
      { text: "🔥 Похудеть 🔒", callback_data: "diet_slim" },
      { text: "⚡ Быстро 🔒", callback_data: "diet_fast" }
    ]
  ]
});

const timeKeyboard = () => ({
  inline_keyboard: [
    [
      { text: "⚡ До 15 мин", callback_data: "time_15" },
      { text: "⏱ До 30 мин", callback_data: "time_30" }
    ],
    [{ text: "🍳 До 60 мин", callback_data: "time_60" }]
  ]
});

const personsKeyboard = () => ({
  inline_keyboard: [
    [
      { text: "👤 1", callback_data: "p_1" },
      { text: "👥 2", callback_data: "p_2" },
      { text: "👨‍👩‍👧‍👦 4", callback_data: "p_4" }
    ]
  ]
});

const againKeyboard = (hasSub) => ({
  inline_keyboard: [
    hasSub
      ? [{ text: "🔁 Другой рецепт", callback_data: "again" }]
      : [{ text: "🔒 Другой рецепт (подписка)", callback_data: "paywall" }]
  ]
});

// ===== STT =====
async function speechToText(buffer) {
  const res = await axios.post(
    "https://stt.api.cloud.yandex.net/speech/v1/stt:recognize",
    buffer,
    {
      headers: {
        Authorization: `Api-Key ${YANDEX_STT_API_KEY}`,
        "Content-Type": "audio/ogg"
      },
      params: { folderId: YANDEX_FOLDER_ID, lang: "ru-RU" }
    }
  );
  return res.data.result;
}

// ===== GPT =====
async function generateRecipe(data) {
  const prompt = `
Ты профессиональный повар.

Продукты: ${data.products}
Тип питания: ${data.diet}
Максимальное время готовки: ${data.time} минут
Количество персон: ${data.persons}

Сделай ОДИН рецепт.

Формат:
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
    "https://llm.api.cloud.yandex.net/foundationModels/v1/completion",
    {
      modelUri: `gpt://${YANDEX_FOLDER_ID}/yandexgpt/latest`,
      messages: [{ role: "user", text: prompt }],
      completionOptions: { temperature: 0.6, maxTokens: 500 }
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
app.post("/webhook", async (req, res) => {
  res.send("ok");
  const update = req.body;

  const msg = update.message;
  const cb = update.callback_query;

  if (msg?.text === "/start") {
    await send(msg.chat.id, "👋 Пришли продукты голосом или текстом через запятую");
    return;
  }

  if (msg?.text && msg.text.includes(",")) {
    state[msg.from.id] = {
      products: msg.text,
      chatId: msg.chat.id
    };
    await send(msg.chat.id, "🍽 Выбери тип питания:", dietKeyboard());
    return;
  }

  if (msg?.voice) {
    const fileId = msg.voice.file_id;
    const file = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.data.result.file_path}`;
    const audio = await axios.get(url, { responseType: "arraybuffer" });
    const text = await speechToText(audio.data);

    state[msg.from.id] = { products: text, chatId: msg.chat.id };
    await send(msg.chat.id, `🧺 Ты сказал:\n<b>${text}</b>\n\nВыбери тип питания:`, dietKeyboard());
    return;
  }

  if (cb) {
    const userId = cb.from.id;
    const chatId = cb.message.chat.id;
    const data = cb.data;

    await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
      callback_query_id: cb.id
    });

    const s = state[userId];
    if (!s) return send(chatId, "❗ Начни сначала");

    if (data.startsWith("diet_")) {
      const diet = data.replace("diet_", "");
      if (["slim", "fast"].includes(diet) && !subscriptions[userId]) {
        return send(chatId, "🔒 Этот режим доступен по подписке");
      }
      s.diet = diet;
      return send(chatId, "⏱ Максимальное время готовки?", timeKeyboard());
    }

    if (data.startsWith("time_")) {
      s.time = data.replace("time_", "");
      return send(chatId, "👥 На сколько персон готовим?", personsKeyboard());
    }

    if (data.startsWith("p_")) {
      s.persons = data.replace("p_", "");
      await send(chatId, "👨‍🍳 Готовлю рецепт…");
      const recipe = await generateRecipe(s);
      await send(chatId, recipe, againKeyboard(subscriptions[userId]));
      return;
    }

    if (data === "again") {
      await send(chatId, "👨‍🍳 Готовлю другой рецепт…");
      const recipe = await generateRecipe(s);
      return send(chatId, recipe, againKeyboard(true));
    }

    if (data === "paywall") {
      return send(chatId, "💳 Подписка 349₽/мес\n(здесь будет оплата)");
    }
  }
});

// ===== START =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Bot started on", PORT));
