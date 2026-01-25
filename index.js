import express from "express";
import axios from "axios";
import sqlite3 from "sqlite3";

const app = express();
app.use(express.json({ limit: "20mb" }));

/* ================= ENV ================= */
const {
  BOT_TOKEN,
  YANDEX_GPT_API_KEY,
  YANDEX_FOLDER_ID,
  YANDEX_STT_API_KEY,
  YOOKASSA_SHOP_ID,
  YOOKASSA_SECRET_KEY,
  PORT = 3000
} = process.env;

const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;

/* ================= DB ================= */
const db = new sqlite3.Database("./db.sqlite");
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS subscriptions (user_id INTEGER PRIMARY KEY, until INTEGER)`);
  db.run(`CREATE TABLE IF NOT EXISTS usage (user_id INTEGER PRIMARY KEY, count INTEGER)`);
});

/* ================= STATE ================= */
const state = {};
let dailyTip = null;
let dailyTipDate = null;

/* ================= HELPERS ================= */
async function send(chatId, text, keyboard = null) {
  const payload = { chat_id: chatId, text, parse_mode: "HTML" };
  if (keyboard) payload.reply_markup = keyboard;
  await axios.post(`${TG}/sendMessage`, payload);
}

function hasSubscription(userId) {
  return new Promise(resolve => {
    db.get(`SELECT until FROM subscriptions WHERE user_id=?`, [userId], (_, row) => {
      resolve(row && row.until > Date.now());
    });
  });
}

function canUseFree(userId) {
  return new Promise(resolve => {
    db.get(`SELECT count FROM usage WHERE user_id=?`, [userId], (_, row) => {
      resolve(!row || row.count < 3);
    });
  });
}

function incUsage(userId) {
  db.run(
    `INSERT INTO usage(user_id, count) VALUES(?,1)
     ON CONFLICT(user_id) DO UPDATE SET count = count + 1`,
    [userId]
  );
}

/* ================= KEYBOARDS ================= */
const dietKeyboard = {
  inline_keyboard: [
    [{ text: "🥘 Обычное", callback_data: "diet_normal" }, { text: "🥗 ПП", callback_data: "diet_healthy" }],
    [{ text: "🌱 Веган", callback_data: "diet_vegan" }],
    [{ text: "🔥 Похудеть 🔒", callback_data: "diet_slim" }]
  ]
};

const timeKeyboard = () => ({
  inline_keyboard: [[{ text: "⏱ до 30 мин", callback_data: "time_30" }, { text: "⏱ до 60 мин", callback_data: "time_60" }]]
});

const personsKeyboard = () => ({
  inline_keyboard: [[{ text: "👤 1", callback_data: "p_1" }, { text: "👥 2", callback_data: "p_2" }]]
});

/* ================= YANDEX ================= */
async function generateRecipe(data) {
  const prompt = `
Ты — виртуальный шеф-повар НейроШеф.

Продукты: ${data.products}
Тип питания: ${data.diet}
Время: ${data.time}
Персон: ${data.persons}

Можно использовать не все продукты.

Формат:
<b>👨‍🍳 Название</b>

⭐ Сложность: X/5
⏱ Время:
👥 Порции:

<b>🧺 Ингредиенты</b>
• ...

<b>🔥 Приготовление</b>
1️⃣ ...

<b>📊 КБЖУ</b>

<b>💡 Совет от НейроШефа</b>
`;

  const res = await axios.post(
    "https://llm.api.cloud.yandex.net/foundationModels/v1/completion",
    {
      modelUri: `gpt://${YANDEX_FOLDER_ID}/yandexgpt/latest`,
      messages: [{ role: "user", text: prompt }],
      completionOptions: { temperature: 0.7, maxTokens: 800 }
    },
    { headers: { Authorization: `Api-Key ${YANDEX_GPT_API_KEY}` } }
  );

  return res.data.result.alternatives[0].message.text;
}

async function getDailyTip() {
  const today = new Date().toDateString();
  if (dailyTipDate === today) return dailyTip;

  const res = await axios.post(
    "https://llm.api.cloud.yandex.net/foundationModels/v1/completion",
    {
      modelUri: `gpt://${YANDEX_FOLDER_ID}/yandexgpt/latest`,
      messages: [{ role: "user", text: "Дай короткий кулинарный совет от шеф-повара" }],
      completionOptions: { temperature: 0.6, maxTokens: 100 }
    },
    { headers: { Authorization: `Api-Key ${YANDEX_GPT_API_KEY}` } }
  );

  dailyTip = res.data.result.alternatives[0].message.text;
  dailyTipDate = today;
  return dailyTip;
}

/* ================= TELEGRAM ================= */
app.post("/webhook", async (req, res) => {
  res.send("ok");
  const u = req.body;

  if (u.message?.text) {
    const chatId = u.message.chat.id;
    const userId = u.message.from.id;

    if (u.message.text === "/start") {
      const tip = await getDailyTip();
      return send(chatId,
        `👨‍🍳 Привет! Я <b>НейроШеф</b>\n\n` +
        `Пришли продукты текстом или голосом.\n\n` +
        `<b>💡 Совет дня:</b>\n${tip}`
      );
    }

    state[userId] = { products: u.message.text };
    return send(chatId, "🍽 Выбери тип питания:", dietKeyboard);
  }

  if (u.callback_query) {
    const { data, from, message, id } = u.callback_query;
    const chatId = message.chat.id;
    const userId = from.id;
    await axios.post(`${TG}/answerCallbackQuery`, { callback_query_id: id });

    if (data.startsWith("diet_")) {
      state[userId].diet = data.replace("diet_", "");
      return send(chatId, "⏱ Время готовки:", timeKeyboard());
    }

    if (data.startsWith("time_")) {
      state[userId].time = data.replace("time_", "");
      return send(chatId, "👥 Количество персон:", personsKeyboard());
    }

    if (data.startsWith("p_")) {
      const sub = await hasSubscription(userId);
      const free = await canUseFree(userId);
      if (!sub && !free) {
        return send(chatId, "🔒 Лимит бесплатных рецептов исчерпан");
      }

      await send(chatId, "👨‍🍳 НейроШеф готовит рецепт...");
      const recipe = await generateRecipe({ ...state[userId], persons: data.replace("p_", "") });

      if (!sub) incUsage(userId);
      delete state[userId];
      return send(chatId, recipe);
    }
  }
});

app.get("/", (_, res) => res.send("OK"));
app.listen(PORT, () => console.log("👨‍🍳 НейроШеф запущен"));
