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
  PORT = 3000
} = process.env;

const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;

/* ================= DB ================= */
const db = new sqlite3.Database("./db.sqlite");
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS subscriptions (user_id INTEGER PRIMARY KEY, until INTEGER)`);
  db.run(`CREATE TABLE IF NOT EXISTS usage (user_id INTEGER PRIMARY KEY, count INTEGER)`);
  db.run(`
    CREATE TABLE IF NOT EXISTS favorites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      name TEXT,
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
  const payload = { chat_id: chatId, text, parse_mode: "HTML" };
  if (keyboard) payload.reply_markup = keyboard;
  try {
    await axios.post(`${TG}/sendMessage`, payload);
  } catch (e) {
    console.error("Send error:", e.response?.data || e.message);
  }
}

function hasSubscription(userId) {
  return new Promise(resolve => {
    db.get(`SELECT until FROM subscriptions WHERE user_id=?`, [userId], (_, row) =>
      resolve(row && row.until > Date.now())
    );
  });
}

function canUseFree(userId) {
  return new Promise(resolve => {
    db.get(`SELECT count FROM usage WHERE user_id=?`, [userId], (_, row) =>
      resolve(!row || row.count < 3)
    );
  });
}

function getFreeUsage(userId) {
  return new Promise(resolve => {
    db.get(`SELECT count FROM usage WHERE user_id=?`, [userId], (_, row) =>
      resolve(row ? row.count : 0)
    );
  });
}

function incUsage(userId) {
  db.run(
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

function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🍳 Новый рецепт", callback_data: "menu_new" }],
      [{ text: "⚡ Быстро приготовить", callback_data: "menu_fast" }],
      [{ text: "🛒 Список покупок", callback_data: "menu_shop" }],
      [{ text: "⭐ Избранное", callback_data: "menu_fav" }],
      [{ text: "👤 Профиль", callback_data: "menu_profile" }]
    ]
  };
}

function recipeActionsKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "⭐ В избранное", callback_data: "fav_add" }],
      [{ text: "🛒 В список покупок", callback_data: "shop_auto_add" }],
      [{ text: "🔙 В меню", callback_data: "menu_back" }]
    ]
  };
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
  const prompt = `Ты — виртуальный шеф-повар НейроШеф.
Продукты: ${data.products}
Тип питания: ${data.diet}
Время: ${data.time || "не важно"}
Персон: ${data.persons}
Правила: Максимум 5 пронумерованных шагов с эмодзи. В начале название: 🍽 Название. В конце КБЖУ. Список ингредиентов начинай с символа "-".`;

  const res = await axios.post(
    "https://llm.api.cloud.yandex.net/foundationModels/v1/completion",
    {
      modelUri: `gpt://${YANDEX_FOLDER_ID}/yandexgpt/latest`,
      messages: [{ role: "user", text: prompt }],
      completionOptions: { temperature: 0.4, maxTokens: 1000 }
    },
    { headers: { Authorization: `Api-Key ${YANDEX_GPT_API_KEY}` } }
  );
  return res.data.result.alternatives[0].message.text;
}

/* ================= LOGIC ================= */
async function showMainMenu(chatId) {
  return send(chatId, "👨‍🍳 <b>НейроШеф</b>\n\nВыберите действие:", mainMenuKeyboard());
}

async function showProfile(chatId, userId) {
  const sub = await hasSubscription(userId);
  const used = await getFreeUsage(userId);
  const left = Math.max(0, 3 - used);
  let text = `👤 <b>Профиль</b>\n\n💳 Подписка: ${sub ? "активна ✅" : "нет ❌"}\n🎁 Попытки: ${left} / 3`;
  const keyboard = {
    inline_keyboard: [
      !sub ? [{ text: "🔄 Тест подписки (1 день)", callback_data: "sub_test" }] : [],
      [{ text: "🔙 В меню", callback_data: "menu_back" }]
    ].filter(r => r.length)
  };
  return send(chatId, text, keyboard);
}

/* ================= WEBHOOK ================= */
app.post("/webhook", async (req, res) => {
  res.send("ok");
  const u = req.body;

  if (u.message?.text) {
    const chatId = u.message.chat.id;
    const userId = u.message.from.id;
    const text = u.message.text.trim();

    if (text === "/start") return showMainMenu(chatId);

    if (state[userId]?.waitingForShop) {
      db.run(`INSERT INTO shopping_list(user_id, item) VALUES(?,?)`, [userId, text]);
      delete state[userId].waitingForShop;
      return send(chatId, `✅ "${text}" добавлен в список!`, mainMenuKeyboard());
    }

    if (state[userId]?.mode === "products") {
      state[userId].products += (state[userId].products ? ", " : "") + text;
      return send(chatId, `🎯 Текущий набор: <b>${state[userId].products}</b>`, dietKeyboardWithAdd);
    }
  }

  if (u.message?.voice) {
    const chatId = u.message.chat.id;
    const userId = u.message.from.id;
    try {
      const text = await recognizeVoice(u.message.voice.file_id);
      state[userId] ??= { mode: "products", products: "" };
      state[userId].products += (state[userId].products ? ", " : "") + text;
      await send(chatId, `🎙 Я услышал: <i>${text}</i>`);
      return send(chatId, `🎯 Текущий набор: <b>${state[userId].products}</b>`, dietKeyboardWithAdd);
    } catch (e) {
      return send(chatId, "❌ Не удалось распознать голос.");
    }
  }

  if (u.callback_query) {
    const { data, from, message, id } = u.callback_query;
    const chatId = message.chat.id;
    const userId = from.id;
    await axios.post(`${TG}/answerCallbackQuery`, { callback_query_id: id });

    state[userId] ??= {};

    if (data === "menu_back") return showMainMenu(chatId);

    if (data === "menu_new") {
      state[userId] = { mode: "products", products: "" };
      return send(chatId, "🍳 Напишите продукты или отправьте голосовое:");
    }

    if (data === "menu_fast") {
      state[userId] = { mode: "products", products: "", fast: true, time: "15" };
      return send(chatId, "⚡ Режим 'Быстро' (15 мин). Пришлите список продуктов:");
    }

    if (data === "menu_profile") return showProfile(chatId, userId);

    if (data === "add_products") {
      state[userId].mode = "products";
      return send(chatId, "🆕 Добавьте продукты текстом или голосом:");
    }

    if (data.startsWith("diet_")) {
      const sub = await hasSubscription(userId);
      const choice = data.replace("diet_", "");
      if (["pp", "slim"].includes(choice) && !sub) return send(chatId, "🔒 Доступно только по подписке.");
      state[userId].diet = choice;
      return send(chatId, "👥 На скольких человек готовим?", personsKeyboard);
    }

    if (data.startsWith("p_")) {
      state[userId].persons = data.replace("p_", "");
      const sub = await hasSubscription(userId);
      if (!sub && !(await canUseFree(userId))) return send(chatId, "🔒 Лимит исчерпан. Оформите подписку.");

      await send(chatId, "👨‍🍳 НейроШеф думает над рецептом...");
      try {
        const recipe = await generateRecipe(state[userId]);
        if (!sub) incUsage(userId);
        state[userId].lastRecipe = recipe;
        return send(chatId, recipe, recipeActionsKeyboard());
      } catch (e) {
        return send(chatId, "❌ Ошибка генерации рецепта.");
      }
    }

    if (data === "fav_add") {
      const recipe = state[userId]?.lastRecipe;
      if (!recipe) return send(chatId, "❌ Рецепт потерян.");
      const name = recipe.match(/🍽\s*(.+)/)?.[1]?.split("\n")[0] || "Любимый рецепт";
      db.run(`INSERT INTO favorites(user_id, name, recipe, created_at) VALUES(?,?,?,?)`, [userId, name, recipe, Date.now()]);
      return send(chatId, "⭐ Сохранено в избранное!");
    }

    if (data === "menu_fav") {
      db.all(`SELECT id, name FROM favorites WHERE user_id=?`, [userId], (_, rows) => {
        if (!rows?.length) return send(chatId, "⭐ Список избранного пуст.");
        const kb = {
          inline_keyboard: [
            ...rows.map(r => [{ text: r.name, callback_data: `fav_view_${r.id}` }, { text: "❌", callback_data: `fav_del_${r.id}` }]),
            [{ text: "🔙 В меню", callback_data: "menu_back" }]
          ]
        };
        send(chatId, "⭐ Ваше избранное:", kb);
      });
    }

    if (data.startsWith("fav_view_")) {
      const fid = data.split("_")[2];
      db.get(`SELECT recipe FROM favorites WHERE id=? AND user_id=?`, [fid, userId], (_, row) => {
        if (row) {
            state[userId].lastRecipe = row.recipe;
            send(chatId, row.recipe, recipeActionsKeyboard());
        }
      });
    }

    if (data.startsWith("fav_del_")) {
      const fid = data.split("_")[2];
      db.run(`DELETE FROM favorites WHERE id=? AND user_id=?`, [fid, userId]);
      send(chatId, "✅ Удалено из избранного.");
    }

    if (data === "menu_shop") {
      db.all(`SELECT * FROM shopping_list WHERE user_id=?`, [userId], (_, rows) => {
        const listText = rows?.length ? rows.map((r, i) => `${r.bought ? "✅" : "🛒"} ${i+1}. ${r.item}`).join("\n") : "Список пуст";
        const kb = {
          inline_keyboard: [
            [{ text: "➕ Добавить вручную", callback_data: "shop_manual" }],
            [{ text: "🗑 Очистить", callback_data: "shop_clear" }],
            [{ text: "🔙 В меню", callback_data: "menu_back" }]
          ]
        };
        send(chatId, `🛒 <b>Список покупок:</b>\n\n${listText}`, kb);
      });
    }

    if (data === "shop_manual") {
      state[userId].waitingForShop = true;
      return send(chatId, "🖊 Напишите название продукта:");
    }

    if (data === "shop_clear") {
      db.run(`DELETE FROM shopping_list WHERE user_id=?`, [userId]);
      return send(chatId, "🗑 Список очищен.");
    }

    if (data === "shop_auto_add") {
        const recipe = state[userId]?.lastRecipe;
        if (!recipe) return send(chatId, "❌ Рецепт не найден.");
        const ingredients = recipe.split("\n").filter(l => l.trim().startsWith("-"));
        ingredients.forEach(i => {
            db.run(`INSERT INTO shopping_list(user_id, item) VALUES(?,?)`, [userId, i.replace("-", "").trim()]);
        });
        return send(chatId, "🛒 Ингредиенты добавлены в список покупок!");
    }

    if (data === "sub_test") {
      const until = Date.now() + 86400000;
      db.run(`INSERT INTO subscriptions(user_id, until) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET until=?`, [userId, until, until]);
      return send(chatId, "✅ Тестовая подписка на 24 часа активирована!");
    }
  }
});

app.get("/", (req, res) => res.send("Chef is online"));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
