import express from "express";
import axios from "axios";
import sqlite3 from "sqlite3";
import YooCheckout from "@a2seven/yoo-checkout";

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

/* ================= YOOKASSA ================= */
const checkout = new YooCheckout({
  shopId: YOOKASSA_SHOP_ID,
  secretKey: YOOKASSA_SECRET_KEY
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

Сделай ОДИН рецепт.
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

/* ================= PAYMENT ================= */
async function createPayment(userId) {
  const payment = await checkout.createPayment({
    amount: { value: "349.00", currency: "RUB" },
    confirmation: {
      type: "redirect",
      return_url: "https://t.me/your_bot"
    },
    description: "Подписка на рецепты (30 дней)",
    metadata: { userId }
  });

  return payment.confirmation.confirmation_url;
}

/* ================= WEBHOOKS ================= */
app.post("/yookassa", (req, res) => {
  if (req.body.event === "payment.succeeded") {
    const userId = req.body.object.metadata.userId;
    const until = Date.now() + 30 * 24 * 60 * 60 * 1000;

    db.run(
      `INSERT OR REPLACE INTO subscriptions VALUES (?, ?)`,
      [userId, until]
    );
  }
  res.send("ok");
});

/* ================= TELEGRAM ================= */
app.post("/webhook", async (req, res) => {
  res.send("ok");
  const u = req.body;

  if (u.message?.text) {
    const chatId = u.message.chat.id;
    const userId = u.message.from.id;
    const text = u.message.text;

    if (text === "/start") {
      return send(chatId, "👨‍🍳 Пришли продукты через запятую");
    }

    state[userId] = { products: text };
    return send(chatId, "🍽 Тип питания:", dietKeyboard);
  }

  if (u.callback_query) {
    const { id, data, from, message } = u.callback_query;
    const chatId = message.chat.id;
    const userId = from.id;

    await axios.post(`${TG}/answerCallbackQuery`, {
      callback_query_id: id
    });

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

    if (data === "again") {
      return send(chatId, "🍽 Пришли продукты заново");
    }

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
