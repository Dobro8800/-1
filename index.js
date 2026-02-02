import express from "express";
import axios from "axios";
import sqlite3 from "sqlite3";
import { open } from "sqlite"; // Для промисов с SQLite

const app = express();
app.use(express.json({ limit: "20mb" }));

/* ================= ENV ================= */
const {
  BOT_TOKEN,
  YANDEX_GPT_API_KEY,
  YANDEX_FOLDER_ID,
  YANDEX_STT_API_KEY,
  PORT = 3000
} = process.env;

const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;
const OWNER_ID = 5030758337;

/* ================= DB ================= */
let db;
(async () => {
  db = await open({
    filename: "./db.sqlite",
    driver: sqlite3.Database
  });

  await db.exec(`CREATE TABLE IF NOT EXISTS subscriptions (user_id INTEGER PRIMARY KEY, until INTEGER)`);
  await db.exec(`CREATE TABLE IF NOT EXISTS usage (user_id INTEGER PRIMARY KEY, count INTEGER)`);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS favorites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      recipe TEXT,
      created_at INTEGER
    )
  `);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS shopping_list (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      item TEXT
    )
  `);
})();

/* ================= STATE ================= */
const state = {};

/* ================= HELPERS ================= */
async function send(chatId, text, keyboard = null) {
  try {
    const payload = { chat_id: chatId, text, parse_mode: "HTML" };
    if (keyboard) payload.reply_markup = keyboard;
    await axios.post(`${TG}/sendMessage`, payload);
  } catch (e) {
    console.error("Send message error:", e.message);
  }
}

function escapeHTML(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function hasSubscription(userId) {
  const row = await db.get(`SELECT until FROM subscriptions WHERE user_id=?`, [userId]);
  return row && row.until > Date.now();
}

async function canUseFree(userId) {
  const row = await db.get(`SELECT count FROM usage WHERE user_id=?`, [userId]);
  return !row || row.count < 3;
}

async function incUsage(userId) {
  await db.run(
    `INSERT INTO usage(user_id,count) VALUES(?,1)
     ON CONFLICT(user_id) DO UPDATE SET count = count + 1`,
    [userId]
  );
}

/* ================= KEYBOARDS ================= */
const dietKeyboard = {
  inline_keyboard: [
    [
      { text: "🥘 Обычное", callback_data: "diet_normal" },
      { text: "🥗 ПП 🔒", callback_data: "diet_pp" }
    ],
    [
      { text: "🌱 Веган", callback_data: "diet_vegan" },
      { text: "🔥 Похудеть 🔒", callback_data: "diet_slim" }
    ]
  ]
};

const dietKeyboardWithAdd = {
  inline_keyboard: [
    ...dietKeyboard.inline_keyboard,
    [{ text: "➕ Добавить продукты", callback_data: "add_products" }]
  ]
};

const timeKeyboard = {
  inline_keyboard: [
    [
      { text: "⏱ до 15 мин", callback_data: "time_15" },
      { text: "⏱ до 30 мин", callback_data: "time_30" }
    ],
    [{ text: "⏱ до 60 мин", callback_data: "time_60" }]
  ]
};

const personsKeyboard = {
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

const kitchenEntryKeyboard = {
  keyboard: [[{ text: "🍽 На кухню" }]],
  resize_keyboard: true
};

const kitchenMenuKeyboard = {
  keyboard: [
    [{ text: "🍳 Новый рецепт" }],
    [{ text: "🔍 Поиск рецепта" }],
    [{ text: "⚡ Быстро приготовить" }],
    [{ text: "🛒 Список покупок" }],
    [{ text: "👤 Профиль" }, { text: "💳 Подписка" }],
    [{ text: "ℹ️ Помощь" }]
  ],
  resize_keyboard: true
};

function recipeActionsKeyboard(hasSub) {
  const buttons = [
    [{ text: "⭐ В избранное", callback_data: "fav_add" }],
    [{ text: "🛒 В список покупок", callback_data: "add_to_shop" }]
  ];

  buttons.push(
    hasSub
      ? [{ text: "🔁 Ещё рецепт", callback_data: "again" }]
      : [{ text: "🔒 Подписка — больше рецептов", callback_data: "paywall" }]
  );

  return { inline_keyboard: buttons };
}

/* ================= STT ================= */
async function recognizeVoice(fileId) {
  const fileRes = await axios.get(`${TG}/getFile?file_id=${fileId}`);
  const filePath = fileRes.data.result.file_path;
  const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
  const audio = await axios.get(fileUrl, { responseType: "arraybuffer" });

  const res = await axios.post(
    "https://stt.api.cloud.yandex.net/speech/v1/stt:recognize",
    audio.data,
    {
      headers: {
        Authorization: `Api-Key ${YANDEX_STT_API_KEY}`,
        "Content-Type": "application/octet-stream"
      },
      params: { lang: "ru-RU" }
    }
  );

  return res.data.result;
}

/* ================= GPT ================= */
async function generateRecipe(data) {
  const prompt = `
Ты — виртуальный шеф-повар по имени НейроШеф.

Продукты: ${data.products}
Тип питания: ${data.diet}
Время: ${data.time}
Персон: ${data.persons}

Правила:
- Можно использовать не все продукты
- Соль, перец и специи можно использовать
- Максимум 5 шагов
- Укажи сложность 1–5
- КБЖУ примерно
- Используй эмодзи умеренно
`;

  const res = await axios.post(
    "https://llm.api.cloud.yandex.net/foundationModels/v1/completion",
    {
      modelUri: `gpt://${YANDEX_FOLDER_ID}/yandexgpt/latest`,
      messages: [{ role: "user", text: prompt }],
      completionOptions: { temperature: 0.4, maxTokens: 900 }
    },
    { headers: { Authorization: `Api-Key ${YANDEX_GPT_API_KEY}` } }
  );

  return res.data.result.alternatives[0].message.text;
}

async function searchRecipe(query) {
  const prompt = `
Ты — профессиональный шеф-повар.

Пользователь ищет рецепт:
"${query}"

Правила:
- Классический рецепт
- Максимум 5 шагов
- КБЖУ примерно
`;

  const res = await axios.post(
    "https://llm.api.cloud.yandex.net/foundationModels/v1/completion",
    {
      modelUri: `gpt://${YANDEX_FOLDER_ID}/yandexgpt/latest`,
      messages: [{ role: "user", text: prompt }],
      completionOptions: { temperature: 0.7, maxTokens: 900 }
    },
    { headers: { Authorization: `Api-Key ${YANDEX_GPT_API_KEY}` } }
  );

  return res.data.result.alternatives[0].message.text;
}

/* ================= INGREDIENT PARSER ================= */
function extractIngredients(text) {
  return text
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.match(/^(\d+\.|•|-|\*)\s*/))
    .map(l => l.replace(/^(\d+\.|•|-|\*)\s*/, ""));
}

/* ================= TELEGRAM ================= */
app.post("/webhook", async (req, res) => {
  res.send("ok"); // отправляем Telegram сразу

  const u = req.body;
  try {
    /* ========== TEXT MESSAGES ========== */
    if (u.message?.text) {
      const chatId = u.message.chat.id;
      const userId = u.message.from.id;
      const text = u.message.text.trim();

      state[userId] ??= {};

      /* 🛒 УДАЛЕНИЕ ИЗ СПИСКА ПОКУПОК */
      if (state[userId].mode === "removeShop") {
        const index = parseInt(text, 10) - 1;

        if (Number.isNaN(index)) {
          state[userId].mode = null;
          return await send(chatId, "👨‍🍳 Выхожу из режима списка покупок", kitchenMenuKeyboard);
        }

        const item = state[userId].shopItems?.[index];
        if (!item) {
          return await send(chatId, "❌ Неверный номер. Попробуй ещё раз.");
        }

        await db.run(`DELETE FROM shopping_list WHERE rowid=? AND user_id=?`, [item.rowid, userId]);

        const rows = await db.all(`SELECT rowid, item FROM shopping_list WHERE user_id=?`, [userId]);
        if (!rows.length) {
          delete state[userId];
          return await send(chatId, "🛒 Список покупок пуст", kitchenMenuKeyboard);
        }

        state[userId] = {
          ...state[userId],
          mode: "removeShop",
          shopItems: rows
        };

        const list = rows.map((r, i) => `🛒 ${i + 1}. ${r.item}`).join("\n");

        return await send(
          chatId,
          `✅ Удалено: <b>${item.item}</b>\n\n${list}\n\n❌ Напиши номер для удаления\n✍️ Или любой текст для выхода`,
          kitchenMenuKeyboard
        );
      }

      /* 🔍 РЕЖИМ: ПОИСК */
      if (state[userId].mode === "search" && !text.startsWith("/")) {
        await send(chatId, "🔍 Ищу рецепт...");
        const recipe = await searchRecipe(text);

        delete state[userId];
        return await send(chatId, recipe, recipeActionsKeyboard(await hasSubscription(userId)));
      }

      /* 📩 РЕЖИМ: ОБРАТНАЯ СВЯЗЬ */
      if (state[userId].mode === "feedback") {
        await send(OWNER_ID, `📩 Обратная связь от ${userId}:\n\n${text}`);
        delete state[userId];
        return await send(chatId, "✅ Сообщение отправлено владельцу", kitchenEntryKeyboard);
      }

      /* 🍅 РЕЖИМ: ВВОД ПРОДУКТОВ */
      if (state[userId].mode === "products" && !text.startsWith("/")) {
        state[userId].products = state[userId].products ? state[userId].products + ", " + text : text;
        return await send(chatId, "🍽 Выбери тип питания:", dietKeyboardWithAdd);
      }

      /* 🚫 ЗАЩИТА ОТ ЦИФР ВНЕ РЕЖИМА */
      if (/^\d+$/.test(text)) {
        return await send(chatId, "🤔 Я не понял, что означает это число", kitchenMenuKeyboard);
      }

      /* ===== КОМАНДЫ ===== */
      if (text === "/start") {
        delete state[userId];
        return await send(
          chatId,
          `👨‍🍳 Привет! Я <b>НейроШеф</b> 🤖  

Пришли продукты:
✍️ текстом через запятую  
🎙 или голосовым сообщением  

Я сам подберу лучший рецепт 👌`,
          kitchenEntryKeyboard
        );
      }

      if (text === "🍽 На кухню") {
        delete state[userId];
        return await send(chatId, "👨‍🍳 Кухня НейроШефа", kitchenMenuKeyboard);
      }

      if (text === "🍳 Новый рецепт") {
        state[userId] = { mode: "products", products: "" };
        return await send(chatId, "🍳 Пришли продукты — текстом или голосом", kitchenEntryKeyboard);
      }

      if (text === "⚡ Быстро приготовить") {
        state[userId] = { mode: "products", fast: true, products: "" };
        return await send(chatId, "⚡ Пришли продукты — рецепт будет до 15 минут");
      }

      if (text === "🔍 Поиск рецепта") {
        state[userId] = { mode: "search" };
        return await send(chatId, "🔍 Напиши, какой рецепт хочешь найти\n\nНапример:\n• паста карбонара\n• суп с фрикадельками");
      }

      if (text === "🛒 Список покупок") {
        const rows = await db.all(`SELECT rowid, item FROM shopping_list WHERE user_id=?`, [userId]);
        if (!rows.length) return await send(chatId, "🛒 Список покупок пуст", kitchenMenuKeyboard);

        state[userId] = { mode: "removeShop", shopItems: rows };
        const list = rows.map((r, i) => `🛒 ${i + 1}. ${r.item}`).join("\n");

        return await send(chatId, `${list}\n\n❌ Напиши номер ингредиента для удаления\n✍️ Или любой текст для выхода`, kitchenMenuKeyboard);
      }

      if (text === "👤 Профиль") {
        delete state[userId];
        const rows = await db.all(`SELECT recipe FROM favorites WHERE user_id=? ORDER BY created_at DESC`, [userId]);
        const list = rows.length ? rows.map((r, i) => `⭐ ${i + 1}. ${r.recipe.split("\n")[0]}`).join("\n") : "Избранных рецептов пока нет";
        return await send(chatId, `👤 Профиль\n\n${list}`, kitchenEntryKeyboard);
      }

      if (text === "ℹ️ Помощь") {
        state[userId] = { mode: "feedback" };
        return await send(chatId, "📩 Напиши сообщение — я передам владельцу", kitchenEntryKeyboard);
      }
    }

    /* ========== VOICE ========== */
    if (u.message?.voice) {
      const chatId = u.message.chat.id;
      const userId = u.message.from.id;
      const text = await recognizeVoice(u.message.voice.file_id);

      await send(chatId, `🎙 Я услышал:\n<b>${text}</b>`);

      state[userId] = { ...state[userId], products: text };
      return await send(chatId, "🍽 Выбери тип питания:", dietKeyboardWithAdd);
    }

    /* ========== CALLBACKS ================= */
    if (u.callback_query) {
      const { data, from, message, id } = u.callback_query;
      const chatId = message.chat.id;
      const userId = from.id;

      await axios.post(`${TG}/answerCallbackQuery`, { callback_query_id: id });

      state[userId] ??= {};
      if (state[userId].mode === "removeShop") delete state[userId].mode;

      const sub = await hasSubscription(userId);

      if (data.startsWith("diet_")) {
        if (["pp", "slim"].includes(data.replace("diet_", "")) && !sub) {
          return await send(chatId, "🔒 Этот режим доступен по подписке");
        }
        state[userId].diet = data.replace("diet_", "");
        return await send(chatId, "⏱ Время готовки:", timeKeyboard);
      }

      if (data === "add_products") {
        state[userId].products ??= "";
        return await send(chatId, "➕ Напиши продукты, которые хочешь добавить");
      }

      if (data.startsWith("time_")) {
        state[userId].time = data.replace("time_", "");
        return await send(chatId, "👥 Количество персон:", personsKeyboard);
      }

      if (data.startsWith("p_")) {
        const free = await canUseFree(userId);
        if (!sub && !free) return await send(chatId, "🔒 Лимит бесплатных рецептов исчерпан");

        state[userId].persons = data.replace("p_", "");
        if (state[userId].fast) state[userId].time = "15";

        await send(chatId, "👨‍🍳 НейроШеф готовит рецепт...");
        const recipe = await generateRecipe(state[userId]);

        if (!sub) await incUsage(userId);
        delete state[userId];

        return await send(chatId, recipe, recipeActionsKeyboard(sub));
      }

      if (data === "fav_add") {
        await db.run(`INSERT INTO favorites(user_id, recipe, created_at) VALUES (?, ?, ?)`, [userId, message.text, Date.now()]);
        return await send(chatId, "⭐ Рецепт добавлен в избранное!");
      }

      if (data === "add_to_shop") {
        const ingredients = extractIngredients(message.text);

        if (!ingredients.length) return await send(chatId, "❌ Не удалось извлечь ингредиенты");

        for (const item of ingredients) {
          await db.run(`INSERT INTO shopping_list(user_id,item) VALUES(?,?)`, [userId, item]);
        }

        return await send(chatId, "🛒 Ингредиенты добавлены в список покупок!");
      }

      if (data === "again") {
        delete state[userId];
        return await send(chatId, "🍳 Пришли продукты заново", kitchenEntryKeyboard);
      }

      if (data === "paywall") {
        return await send(chatId, "🔒 Подписка скоро будет подключена 😉");
      }
    }
  } catch (e) {
    console.error("Webhook error:", e.message);
  }
});

/* ================= SERVER ================= */
app.get("/", (_, res) => res.send("OK"));
app.listen(PORT, () => console.log("👨‍🍳 НейроШеф запущен"));
