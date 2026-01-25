import express from "express";
import axios from "axios";
import sqlite3 from "sqlite3";

const app = express();
app.use(express.json({ limit: "20mb" }));

/* ================= ENV ================= */
const {
  BOT_TOKEN,
  YANDEX_GPT_API_KEY,
  YANDEX_STT_API_KEY,
  YANDEX_FOLDER_ID,
  YOOKASSA_SHOP_ID,
  YOOKASSA_SECRET_KEY,
  PORT = 3000
} = process.env;

const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;

/* ================= DB ================= */
const db = new sqlite3.Database("./db.sqlite");
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      user_id INTEGER PRIMARY KEY,
      until INTEGER
    )
  `);
});

/* ================= STATE ================= */
const state = {};

/* ================= HELPERS ================= */
async function send(chatId, text, keyboard = null) {
  const payload = { chat_id: chatId, text, parse_mode: "HTML" };
  if (keyboard) payload.reply_markup = keyboard;
  await axios.post(`${TG}/sendMessage`, payload);
}

function hasSubscription(userId) {
  return new Promise(resolve => {
    db.get(
      `SELECT until FROM subscriptions WHERE user_id=?`,
      [userId],
      (err, row) => {
        resolve(row && row.until > Date.now());
      }
    );
  });
}

/* ================= KEYBOARDS ================= */
const dietKeyboard = {
  inline_keyboard: [
    [
      { text: "🥘 Обычное", callback_data: "diet_normal" },
      { text: "🥗 ПП", callback_data: "diet_healthy" }
    ],
    [{ text: "🌱 Веган", callback_data: "diet_vegan" }],
    [
      { text: "🔥 Похудеть 🔒", callback_data: "diet_slim" },
      { text: "⚡ Быстро 🔒", callback_data: "diet_fast" }
    ]
  ]
};

function timeKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "⏱ до 15 мин", callback_data: "time_15" },
        { text: "⏱ до 30 мин", callback_data: "time_30" }
      ],
      [{ text: "⏱ до 60 мин", callback_data: "time_60" }]
    ]
  };
}

function personsKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "👤 1", callback_data: "p_1" },
        { text: "👥 2", callback_data: "p_2" }
      ],
      [
        { text: "👨‍👩‍👧 3", callback_data: "p_3" },
        { text: "👨‍👩‍👧‍👦 4", callback_data: "p_4" }
      ]
    ]
  };
}

function afterRecipeKeyboard(hasSub) {
  if (!hasSub) {
    return {
      inline_keyboard: [
        [{ text: "🔒 Другой рецепт (подписка)", callback_data: "paywall" }]
      ]
    };
  }
  return {
    inline_keyboard: [
      [{ text: "🔁 Другой рецепт", callback_data: "again" }]
    ]
  };
}

/* ================= YANDEX GPT ================= */
async function generateRecipe(data) {
  const prompt = `
Продукты: ${data.products}
Тип питания: ${data.diet}
Время готовки: ${data.time}
Персон: ${data.persons}

Сделай ОДИН рецепт. Используй те ингредиенты, которые нужны для рецепта. Можно исключить ингредиенты, которые не подходят, если это улучшает рецепт.
Формат:

<b>Название</b>
⏱ Время | 👥 Порции
1. шаг
2. шаг
3. шаг
КБЖУ
`;

  const res = await axios.post(
    "https://llm.api.cloud.yandex.net/foundationModels/v1/completion",
    {
      modelUri: `gpt://${YANDEX_FOLDER_ID}/yandexgpt/latest`,
      messages: [{ role: "user", text: prompt }],
      completionOptions: { temperature: 0.6, maxTokens: 700 }
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

/* ================= YANDEX STT ================= */
async function recognizeVoice(fileId) {
  const fileRes = await axios.get(`${TG}/getFile?file_id=${fileId}`);
  const filePath = fileRes.data.result.file_path;
  const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;

  const audioRes = await axios.get(fileUrl, { responseType: "arraybuffer" });
  const audioData = audioRes.data;

  const res = await axios.post(
    "https://stt.api.cloud.yandex.net/speech/v1/stt:recognize",
    audioData,
    {
      headers: {
        "Authorization": `Api-Key ${YANDEX_STT_API_KEY}`,
        "Content-Type": "application/octet-stream"
      },
      params: { lang: "ru-RU" }
    }
  );

  return res.data.result;
}

/* ================= PAYMENT ================= */
async function createPayment(userId) {
  const data = {
    amount: { value: "349.00", currency: "RUB" },
    confirmation: { type: "redirect", return_url: "https://t.me/your_bot" },
    capture: true,
    description: "Подписка на рецепты (30 дней)",
    metadata: { userId }
  };

  const auth = Buffer.from(`${YOOKASSA_SHOP_ID}:${YOOKASSA_SECRET_KEY}`).toString("base64");

  try {
    const res = await axios.post(
      "https://api.yookassa.ru/v3/payments",
      data,
      {
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json"
        }
      }
    );
    return res.data.confirmation.confirmation_url;
  } catch (err) {
    console.error("Ошибка при создании платежа:", err.response?.data || err.message);
    throw new Error("Не удалось создать платеж");
  }
}

/* ================= WEBHOOKS ================= */
app.post("/yookassa", (req, res) => {
  if (req.body.event === "payment.succeeded") {
    const userId = req.body.object.metadata.userId;
    const until = Date.now() + 30 * 24 * 60 * 60 * 1000;
    db.run(`INSERT OR REPLACE INTO subscriptions VALUES (?, ?)`, [userId, until]);
  }
  res.send("ok");
});

/* ================= TELEGRAM ================= */
app.post("/webhook", async (req, res) => {
  res.send("ok");
  const u = req.body;
  const chatId = u.message?.chat?.id;
  const userId = u.message?.from?.id;

  /* ==== Голосовое сообщение ==== */
  if (u.message?.voice) {
    const text = await recognizeVoice(u.message.voice.file_id);
    state[userId] = { products: text };
    await send(chatId, `Вы сказали: ${text}`);
    return send(chatId, "🍽 Тип питания:", dietKeyboard);
  }

  /* ==== Текстовое сообщение ==== */
  if (u.message?.text) {
    const text = u.message.text;
    if (text === "/start") return send(chatId, "👨‍🍳 Пришлите продукты через запятую или голосовым сообщением");

    state[userId] = { products: text };
    return send(chatId, "🍽 Тип питания:", dietKeyboard);
  }

  /* ==== Callback query ==== */
  if (u.callback_query) {
    const { id, data, from, message } = u.callback_query;
    const chatId = message.chat.id;
    const userId = from.id;

    await axios.post(`${TG}/answerCallbackQuery`, { callback_query_id: id });
    const sub = await hasSubscription(userId);

    if (data.startsWith("diet_")) {
      const diet = data.replace("diet_", "");
      if ((diet === "slim" || diet === "fast") && !sub) {
        return send(chatId, "🔒 Только по подписке");
      }
      state[userId].diet = diet;
      return send(chatId, "⏱ Время готовки:", timeKeyboard());
    }

    if (data.startsWith("time_")) {
      state[userId].time = data.replace("time_", "");
      return send(chatId, "👥 Количество персон:", personsKeyboard());
    }

    if (data.startsWith("p_")) {
      state[userId].persons = data.replace("p_", "");
      const recipe = await generateRecipe(state[userId]);
      delete state[userId];
      return send(chatId, recipe, afterRecipeKeyboard(sub));
    }

    if (data === "again") return send(chatId, "🍽 Пришлите продукты заново");

    if (data === "paywall") {
      const url = await createPayment(userId);
      return send(chatId, "💳 Подписка 349₽", {
        inline_keyboard: [[{ text: "Оплатить", url }]]
      });
    }
  }
});

app.get("/", (_, res) => res.send("OK"));
app.listen(PORT, () => console.log("Bot started"));
