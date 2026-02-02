import express from "express";
import axios from "axios";
import sqlite3 from "sqlite3";

/* ================= APP ================= */
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
const db = new sqlite3.Database("./db.sqlite");

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      user_id INTEGER PRIMARY KEY,
      until INTEGER
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS usage (
      user_id INTEGER PRIMARY KEY,
      count INTEGER
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS favorites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      recipe TEXT,
      created_at INTEGER
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS shopping_list (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      item TEXT,
      bought INTEGER DEFAULT 0
    )
  `);
});

/* ================= STATE ================= */
const state = {};

/* ================= HELPERS ================= */
async function send(chatId, text, keyboard = null) {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: "HTML"
  };

  if (keyboard) payload.reply_markup = keyboard;

  await axios.post(`${TG}/sendMessage`, payload);
}

async function edit(chatId, messageId, text, keyboard = null) {
  const payload = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML"
  };

  if (keyboard) payload.reply_markup = keyboard;

  await axios.post(`${TG}/editMessageText`, payload);
}

function hasSubscription(userId) {
  return new Promise(resolve => {
    db.get(
      `SELECT until FROM subscriptions WHERE user_id=?`,
      [userId],
      (_, row) => resolve(Boolean(row && row.until > Date.now()))
    );
  });
}

function getFreeUsage(userId) {
  return new Promise(resolve => {
    db.get(
      `SELECT count FROM usage WHERE user_id=?`,
      [userId],
      (_, row) => resolve(row ? row.count : 0)
    );
  });
}

function canUseFree(userId) {
  return new Promise(resolve => {
    db.get(
      `SELECT count FROM usage WHERE user_id=?`,
      [userId],
      (_, row) => resolve(!row || row.count < 3)
    );
  });
}

function incUsage(userId) {
  db.run(
    `INSERT INTO usage(user_id, count)
     VALUES (?, 1)
     ON CONFLICT(user_id) DO UPDATE SET count = count + 1`,
    [userId]
  );
}

/* ================= INLINE MENUS ================= */
function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🍳 Новый рецепт", callback_data: "menu_new" }],
      [{ text: "⚡ Быстро приготовить", callback_data: "menu_fast" }],
      [{ text: "🔍 Поиск рецепта", callback_data: "menu_search" }],
      [{ text: "⭐ Избранное", callback_data: "menu_fav" }],
      [{ text: "🛒 Список покупок", callback_data: "menu_shop" }],
      [{ text: "👤 Профиль", callback_data: "menu_profile" }]
    ]
  };
}

function backKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🔙 Назад", callback_data: "menu_back" }]
    ]
  };
}

/* ================= DIET / TIME / PERSONS ================= */
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

/* ================= REPLY KEYBOARDS ================= */
const inputKeyboard = {
  keyboard: [[{ text: "⏹ Завершить ввод" }]],
  resize_keyboard: true
};

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

СОБЛЮДАЙ ФОРМАТ СТРОГО. ЕСЛИ ФОРМАТ НАРУШЕН — ОТВЕТ НЕДЕЙСТВИТЕЛЕН.

ФОРМАТ:

🍽 НАЗВАНИЕ:
Название блюда

🧾 ИНГРЕДИЕНТЫ:
1️⃣ продукт — количество
2️⃣ продукт — количество

👨‍🍳 ПРИГОТОВЛЕНИЕ:
1️⃣ шаг
2️⃣ шаг

⏱ ВРЕМЯ:
${data.time} минут

🔥 СОВЕТ:
Короткий совет

ДАННЫЕ:
Продукты: ${data.products}
Тип питания: ${data.diet}
Персон: ${data.persons}
`;

  const res = await axios.post(
    "https://llm.api.cloud.yandex.net/foundationModels/v1/completion",
    {
      modelUri: `gpt://${YANDEX_FOLDER_ID}/yandexgpt/latest`,
      messages: [{ role: "user", text: prompt }],
      completionOptions: { temperature: 0.4, maxTokens: 900 }
    },
    {
      headers: {
        Authorization: `Api-Key ${YANDEX_GPT_API_KEY}`
      }
    }
  );

  return res.data.result.alternatives[0].message.text;
}

/* ================= PARSERS ================= */
function extractIngredients(recipe) {
  const start = recipe.indexOf("🧾 ИНГРЕДИЕНТЫ:");
  const end = recipe.indexOf("👨‍🍳 ПРИГОТОВЛЕНИЕ:");

  if (start === -1 || end === -1) return [];

  return recipe
    .slice(start, end)
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.startsWith("1️⃣") || l.startsWith("2️⃣") || l.startsWith("3️⃣") || l.startsWith("4️⃣") || l.startsWith("5️⃣"))
    .map(l => l.replace(/^\d️⃣\s*/, "").split("—")[0].trim());
}

function extractSteps(recipe) {
  const start = recipe.indexOf("👨‍🍳 ПРИГОТОВЛЕНИЕ:");
  const end = recipe.indexOf("⏱ ВРЕМЯ:");

  if (start === -1 || end === -1) return [];

  return recipe
    .slice(start, end)
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.startsWith("1️⃣") || l.startsWith("2️⃣") || l.startsWith("3️⃣") || l.startsWith("4️⃣") || l.startsWith("5️⃣"))
    .map(l => l.replace(/^\d️⃣\s*/, ""));
}

/* ===== END OF PART 1 ===== */
/* ================= UI HELPERS ================= */
async function showMainMenu(chatId) {
  return send(
    chatId,
    "👨‍🍳 <b>НейроШеф</b>\n\nЧто будем готовить?",
    mainMenuKeyboard()
  );
}

async function showProfile(chatId, userId) {
  const sub = await hasSubscription(userId);
  const used = await getFreeUsage(userId);
  const left = Math.max(0, 3 - used);

  let text =
    `👤 <b>Профиль</b>\n\n` +
    `💳 Подписка: ${sub ? "активна ✅" : "нет ❌"}\n` +
    `🎁 Бесплатные рецепты: ${left} / 3`;

  const keyboard = {
    inline_keyboard: [
      !sub
        ? [{ text: "🔄 Тестовое продление подписки", callback_data: "sub_test" }]
        : [],
      [{ text: "🔙 Назад", callback_data: "menu_back" }]
    ].filter(r => r.length)
  };

  return send(chatId, text, keyboard);
}

async function showFavorites(chatId, userId) {
  db.all(
    `SELECT id, recipe FROM favorites WHERE user_id=? ORDER BY created_at DESC`,
    [userId],
    (_, rows) => {
      if (!rows.length) {
        return send(
          chatId,
          "⭐ Избранных рецептов пока нет",
          backKeyboard()
        );
      }

      state[userId] = {
        mode: "fav_remove",
        favItems: rows
      };

      const list = rows
        .map((r, i) => `⭐ ${i + 1}. ${r.recipe.split("\n")[0].replace("🍽 НАЗВАНИЕ:", "").trim()}`)
        .join("\n");

      send(
        chatId,
        `⭐ <b>Избранные рецепты</b>\n\n${list}\n\n❌ Напиши номер для удаления`,
        backKeyboard()
      );
    }
  );
}

async function showShopping(chatId, userId) {
  db.all(
    `SELECT id, item, bought FROM shopping_list WHERE user_id=?`,
    [userId],
    (_, rows) => {
      if (!rows.length) {
        return send(chatId, "🛒 Список покупок пуст", backKeyboard());
      }

      state[userId] = {
        mode: "shop",
        shopItems: rows
      };

      const list = rows
        .map(
          (r, i) =>
            `${r.bought ? "✅" : "🛒"} ${i + 1}. ${r.item}`
        )
        .join("\n");

      const keyboard = {
        inline_keyboard: [
          [{ text: "🧹 Удалить всё", callback_data: "shop_clear" }],
          [{ text: "🔙 Назад", callback_data: "menu_back" }]
        ]
      };

      send(chatId, `🛒 <b>Список покупок</b>\n\n${list}\n\n✍️ Напиши номер: удалить / отметить купленным`, keyboard);
    }
  );
}

/* ================= TELEGRAM ================= */
app.post("/webhook", async (req, res) => {
  res.send("ok");
  const u = req.body;

  /* ===== TEXT ===== */
  if (u.message?.text) {
    const chatId = u.message.chat.id;
    const userId = u.message.from.id;
    const text = u.message.text.trim();

    state[userId] ??= {};

    /* --- favorites remove --- */
    if (state[userId].mode === "fav_remove") {
      const index = parseInt(text) - 1;
      const item = state[userId].favItems?.[index];
      if (!item) return send(chatId, "❌ Неверный номер");

      db.run(`DELETE FROM favorites WHERE id=?`, [item.id]);
      delete state[userId];
      return showFavorites(chatId, userId);
    }

    /* --- shopping actions --- */
    if (state[userId].mode === "shop") {
      const index = parseInt(text) - 1;
      const item = state[userId].shopItems?.[index];
      if (!item) return send(chatId, "❌ Неверный номер");

      if (item.bought) {
        db.run(`DELETE FROM shopping_list WHERE id=?`, [item.id]);
      } else {
        db.run(`UPDATE shopping_list SET bought=1 WHERE id=?`, [item.id]);
      }

      delete state[userId];
      return showShopping(chatId, userId);
    }

    /* --- products input --- */
    if (state[userId].mode === "products") {
      if (text === "⏹ Завершить ввод") {
        return send(chatId, "🍽 Выбери тип питания:", dietKeyboardWithAdd);
      }

      state[userId].products =
        state[userId].products
          ? state[userId].products + ", " + text
          : text;

      return send(chatId, "✅ Продукты добавлены", inputKeyboard);
    }

    /* --- search --- */
    if (state[userId].mode === "search") {
      await send(chatId, "🔍 Ищу рецепт...");
      const recipe = await generateRecipe({ products: text, diet: "обычное", time: "30", persons: "2" });
      delete state[userId];
      return send(chatId, recipe, recipeActionsKeyboard(true));
    }

    if (text === "/start") {
      delete state[userId];
      return showMainMenu(chatId);
    }
  }

  /* ===== VOICE ===== */
  if (u.message?.voice) {
    const chatId = u.message.chat.id;
    const userId = u.message.from.id;
    const text = await recognizeVoice(u.message.voice.file_id);

    state[userId] = { mode: "products", products: text };
    return send(chatId, "🍽 Выбери тип питания:", dietKeyboardWithAdd);
  }

  /* ===== CALLBACKS ===== */
  if (u.callback_query) {
    const { data, from, message, id } = u.callback_query;
    const chatId = message.chat.id;
    const userId = from.id;

    await axios.post(`${TG}/answerCallbackQuery`, { callback_query_id: id });
    state[userId] ??= {};

    if (data === "menu_back") {
      delete state[userId];
      return showMainMenu(chatId);
    }

    if (data === "menu_new") {
      state[userId] = { mode: "products", products: "" };
      return send(chatId, "🍳 Пришли продукты", inputKeyboard);
    }

    if (data === "menu_fast") {
      state[userId] = { mode: "products", products: "", fast: true };
      return send(chatId, "⚡ Пришли продукты", inputKeyboard);
    }

    if (data === "menu_search") {
      state[userId] = { mode: "search" };
      return send(chatId, "🔍 Напиши название рецепта");
    }

    if (data === "menu_fav") return showFavorites(chatId, userId);
    if (data === "menu_shop") return showShopping(chatId, userId);
    if (data === "menu_profile") return showProfile(chatId, userId);

    if (data === "sub_test") {
      db.run(
        `INSERT INTO subscriptions(user_id, until)
         VALUES (?, ?)
         ON CONFLICT(user_id) DO UPDATE SET until=?`,
        [userId, Date.now() + 7 * 86400000, Date.now() + 7 * 86400000]
      );
      return showProfile(chatId, userId);
    }

    if (data.startsWith("diet_")) {
      state[userId].diet = data.replace("diet_", "");
      return send(chatId, "⏱ Время:", timeKeyboard);
    }

    if (data.startsWith("time_")) {
      state[userId].time = data.replace("time_", "");
      return send(chatId, "👥 Персон:", personsKeyboard);
    }

    if (data.startsWith("p_")) {
      state[userId].persons = data.replace("p_", "");
      if (state[userId].fast) state[userId].time = "15";

      await send(chatId, "👨‍🍳 Готовлю рецепт...");
      const recipe = await generateRecipe(state[userId]);

      const ingredients = extractIngredients(recipe);
      ingredients.forEach(item => {
        db.run(`INSERT INTO shopping_list(user_id,item) VALUES(?,?)`, [userId, item]);
      });

      delete state[userId];
      return send(chatId, recipe, {
        inline_keyboard: [
          [{ text: "⭐ В избранное", callback_data: "fav_add" }],
          [{ text: "🔙 В меню", callback_data: "menu_back" }]
        ]
      });
    }

    if (data === "fav_add") {
      db.run(
        `INSERT INTO favorites(user_id, recipe, created_at) VALUES(?,?,?)`,
        [userId, message.text, Date.now()]
      );
      return send(chatId, "⭐ Рецепт сохранён!");
    }

    if (data === "shop_clear") {
      db.run(`DELETE FROM shopping_list WHERE user_id=?`, [userId]);
      return showShopping(chatId, userId);
    }
  }
});

/* ================= SERVER ================= */
app.get("/", (_, res) => res.send("OK"));
app.listen(PORT, () => console.log("👨‍🍳 НейроШеф запущен"));
