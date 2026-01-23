import express from "express";
import axios from "axios";
import sqlite3 from "sqlite3";

const BOT_TOKEN = process.env.BOT_TOKEN;
const GEMINI_KEY = process.env.GEMINI_KEY;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const app = express();
app.use(express.json({ limit: "20mb" }));

// ===== База пользователей =====
const db = new sqlite3.Database("./users.db");
db.run(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  subscribed INTEGER DEFAULT 0,
  until INTEGER DEFAULT 0
)
`);

// ===== Временное хранение состояния пользователя =====
const state = {}; // { userId: { products } }

// ===== Вспомогательные функции =====
function send(chatId, text, keyboard = null) {
  const payload = { chat_id: chatId, text, parse_mode: "HTML" };
  if (keyboard) payload.reply_markup = keyboard; // только если есть объект
  return axios.post(`${TELEGRAM_API}/sendMessage`, payload)
    .catch(e => console.error("Ошибка sendMessage:", e.response?.data || e.message));
}

function getUser(id) {
  return new Promise(resolve => {
    db.get("SELECT * FROM users WHERE id = ?", [id], (e, row) => {
      if (!row) {
        db.run("INSERT INTO users (id) VALUES (?)", [id]);
        resolve({ subscribed: 0, until: 0 });
      } else resolve(row);
    });
  });
}

function isActive(user) {
  return user.subscribed && user.until > Date.now();
}

// ===== Кнопки выбора питания =====
function dietKeyboard(sub = false) {
  return {
    inline_keyboard: [
      [
        { text: "🥘 Обычное", callback_data: "diet_normal" },
        { text: "🥗 ПП", callback_data: "diet_healthy" }
      ],
      [{ text: "🌱 Веган", callback_data: "diet_vegan" }],
      [
        { text: sub ? "🔥 Похудеть" : "🔥 Похудеть ⭐", callback_data: "diet_slim" },
        { text: sub ? "⚡ Быстро" : "⚡ Быстро ⭐", callback_data: "diet_fast" }
      ]
    ]
  };
}

function paywall(chatId) {
  return send(
    chatId,
    "⭐ <b>Доступно по подписке</b>\n\n🔥 Похудение\n⚡ Быстрые рецепты\n📊 КБЖУ\n\n349₽ / месяц"
  );
}

// ===== Генерация рецепта через Gemini AI =====
async function generateRecipe(products, diet, premium) {
  const dietMap = {
    normal: "обычное домашнее питание",
    healthy: "правильное питание",
    vegan: "строго веганское блюдо",
    slim: "блюдо для похудения с минимальной калорийностью",
    fast: "очень быстрое блюдо (до 15 минут)"
  };

  const prompt = `
Ты профессиональный повар.
Тип питания: ${dietMap[diet]}
Используй ТОЛЬКО эти продукты: ${products}

Сделай ОДИН рецепт.
Формат:
<b>Название</b>
⏱ Время | 👥 Порции
1. шаг
2. шаг
3. шаг
4. шаг
5. шаг
${premium ? "КБЖУ в конце" : ""}
`;

  try {
    const res = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_KEY}`,
      { contents: [{ parts: [{ text: prompt }] }] }
    );
    return res.data.candidates[0].content.parts[0].text;
  } catch (e) {
    console.error("Ошибка Gemini:", e.response?.data || e.message);
    return "❌ Не удалось сгенерировать рецепт, попробуй позже.";
  }
}

// ===== Webhook =====
app.post("/", async (req, res) => {
  const update = req.body;
  res.send("ok"); // сразу подтверждаем Telegram

  // ===== Message handling =====
  if (update.message) {
    const msg = update.message;
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    console.log("Получен update:", JSON.stringify(msg, null, 2));

    if (msg.text === "/start") {
      return send(
        chatId,
        "👋 Я твой <b>личный повар</b>\n\nПришли продукты текстом через запятую 🍅🥩"
      );
    }

    // Продукты через запятую
    if (msg.text && msg.text.includes(",")) {
      state[userId] = { products: msg.text };
      const user = await getUser(userId);
      return send(chatId, "🍽 Выбери тип питания:", dietKeyboard(isActive(user) || false));
    }
  }

  // ===== Callback buttons =====
  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message.chat.id;
    const userId = cb.from.id;
    const diet = cb.data.replace("diet_", "");

    const user = await getUser(userId);

    if ((diet === "slim" || diet === "fast") && !isActive(user)) {
      return paywall(chatId);
    }

    if (!state[userId]) {
      return send(chatId, "❗ Пришли продукты заново");
    }

    send(chatId, "👨‍🍳 Готовлю рецепт…");

    const recipe = await generateRecipe(
      state[userId].products,
      diet,
      isActive(user)
    );

    delete state[userId];
    return send(chatId, recipe);
  }
});

// ===== Сервер =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Bot running"));
