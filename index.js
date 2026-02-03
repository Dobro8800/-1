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
const OWNER_ID = 5030758337;

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
  await axios.post(`${TG}/sendMessage`, payload);
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

function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🍳 Новый рецепт", callback_data: "menu_new" }],
      [{ text: "⚡ Быстро приготовить", callback_data: "menu_fast" }],
      [{ text: "🔍 Поиск рецепта", callback_data: "menu_search" }],
      [{ text: "🛒 Список покупок", callback_data: "menu_shop" }],
      [{ text: "⭐ Избранное", callback_data: "menu_fav" }],
      [{ text: "👤 Профиль", callback_data: "menu_profile" }]
    ]
  };
}

function backKeyboard() {
  return { inline_keyboard: [[{ text: "🔙 Назад", callback_data: "menu_back" }]] };
}

function recipeActionsKeyboard(recipeId = null) {
  const buttons = [
    [{ text: "⭐ В избранное", callback_data: `fav_add${recipeId ? `_${recipeId}` : ""}` }],
    [{ text: "🛒 Добавить в список покупок", callback_data: `add_to_shop${recipeId ? `_${recipeId}` : ""}` }],
    [{ text: "🔙 На кухню", callback_data: "menu_back" }]
  ];
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
- Используй только подходящие продукты, не обязательно использовать все
- Соль, перец и специи можно использовать
- Максимум 5 шагов
- Добавь больше эмодзи в каждом шаге
- Пронумеруй шаги эмодзи: 1️⃣, 2️⃣, 3️⃣
- В начале укажи название блюда: 🍽 <название блюда>
- КБЖУ укажи в конце рецепта
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

/* ================= INGREDIENT PARSER ================= */
function extractIngredients(recipe) {
  const lines = recipe.split("\n");
  const ingredients = [];

  lines.forEach(line => {
    line = line.trim();
    if (!line) return;
    if (/^[-•🍅🥕🧄]/.test(line) || /(\d+ ?(г|мл|шт|чайн|стол|пуч))/.test(line)) {
      ingredients.push(line.replace(/^[-•\s]+/, ""));
    }
  });

  return ingredients;
}

/* ================= TELEGRAM HELPERS ================= */
async function showMainMenu(chatId) {
  return send(chatId, "👨‍🍳 <b>НейроШеф</b>\n\nВыберите действие:", mainMenuKeyboard());
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
      [{ text: "🔙 На кухню", callback_data: "menu_back" }]
    ].filter(r => r.length)
  };

  return send(chatId, text, keyboard);
}

/* ================= ЧАСТЬ 1 ОКОНЧАНИЕ ================= */

/* ================= TELEGRAM ================= */

app.post("/webhook", async (req, res) => {
  res.send("ok");
  const u = req.body;

  /* ========== TEXT MESSAGES ========== */
  if (u.message?.text) {
    const chatId = u.message.chat.id;
    const userId = u.message.from.id;
    const text = u.message.text.trim();

    state[userId] ??= {};

    /* 🚀 Ввод продуктов */
    if (state[userId].mode === "products") {
      state[userId].products ??= "";

      // Дублируем текст пользователя
      await send(chatId, `🎯 Я получил продукты:\n<b>${text}</b>`);

      // Добавляем продукты
      state[userId].products += state[userId].products ? `, ${text}` : text;

      // Предлагаем только выбор типа питания с возможностью добавить продукты
      return send(chatId, "🍽 Выберите тип питания:", dietKeyboardWithAdd);
    }

    /* ⚡ Быстро приготовить */
    if (text === "⚡ Быстро приготовить") {
      state[userId] = { mode: "products", products: "", fast: true, time: "15" };
      await send(chatId, "⚡ Вы выбрали быстро приготовить. Время готовки до 15 минут");
      return send(chatId, "🍽 Пришлите продукты — текстом или голосом", mainMenuKeyboard());
    }

    /* 🔍 Поиск рецепта */
    if (text === "🔍 Поиск рецепта") {
      state[userId] = { mode: "search" };
      return send(chatId, "🔍 Напишите название рецепта для поиска", mainMenuKeyboard());
    }

    /* 🍳 Новый рецепт */
    if (text === "🍳 Новый рецепт") {
      state[userId] = { mode: "products", products: "" };
      return send(chatId, "🍳 Пришлите продукты — текстом или голосом", mainMenuKeyboard());
    }

    /* На кухню */
    if (text === "🍽 На кухню" || text === "/start") {
      delete state[userId];
      return showMainMenu(chatId);
    }

    /* 🚫 Защита от цифр вне режима */
    if (/^\d+$/.test(text)) {
      return send(chatId, "🤔 Я не понял, что означает это число", mainMenuKeyboard());
    }

    /* Другие команды */
    if (text === "ℹ️ Помощь") {
      state[userId] = { mode: "feedback" };
      return send(chatId, "📩 Напиши сообщение — я передам владельцу", mainMenuKeyboard());
    }

    if (text === "🛒 Список покупок") {
      showShoppingList(chatId, userId);
      return;
    }

    if (text === "👤 Избранное") {
      showFavorites(chatId, userId);
      return;
    }
  }

  /* ========== VOICE MESSAGES ========== */
  if (u.message?.voice) {
    const chatId = u.message.chat.id;
    const userId = u.message.from.id;
    const text = await recognizeVoice(u.message.voice.file_id);

    await send(chatId, `🎙 Я услышал:\n<b>${text}</b>`);

    state[userId] ??= {};
    state[userId].products ??= "";
    state[userId].products += state[userId].products ? `, ${text}` : text;

    return send(chatId, "🍽 Выберите тип питания:", dietKeyboardWithAdd);
  }

  /* ========== CALLBACK QUERIES ========== */
  if (u.callback_query) {
    const { data, from, message, id } = u.callback_query;
    const chatId = message.chat.id;
    const userId = from.id;

    await axios.post(`${TG}/answerCallbackQuery`, { callback_query_id: id });
    state[userId] ??= {};

    // Диета
    if (data.startsWith("diet_")) {
      const sub = await hasSubscription(userId);
      const dietChoice = data.replace("diet_", "");
      if (["pp", "slim"].includes(dietChoice) && !sub) {
        return send(chatId, "🔒 Этот режим доступен по подписке");
      }
      state[userId].diet = dietChoice;
      return send(chatId, "👥 Выберите количество персон:", personsKeyboard);
    }

    // Добавить продукты
    if (data === "add_products") {
      return send(chatId, "➕ Напишите продукты, которые хотите добавить");
    }

    // Время
    if (data.startsWith("time_")) {
      state[userId].time = data.replace("time_", "");
      return send(chatId, "👥 Выберите количество персон:", personsKeyboard);
    }

    // Персон
    if (data.startsWith("p_")) {
      const free = await canUseFree(userId);
      const sub = await hasSubscription(userId);
      if (!sub && !free) return send(chatId, "🔒 Лимит бесплатных рецептов исчерпан");

      state[userId].persons = data.replace("p_", "");
      if (state[userId].fast) state[userId].time = "15";

      await send(chatId, "👨‍🍳 НейроШеф готовит рецепт...");
      const recipe = await generateRecipe(state[userId]);

      if (!sub) incUsage(userId);
      state[userId].lastRecipe = recipe;
      delete state[userId];

      return send(chatId, recipe, recipeActionsKeyboard(sub));
    }

    // Другие callback’ы (избранное, список покупок, меню) оставляем как есть
  }


      /* ================= ИЗБРАННОЕ ================= */
        /* ================= ИЗБРАННОЕ ================= */
    if (data.startsWith("fav_add")) {
      const recipe = state[userId].lastRecipe ?? "";
      const nameMatch = recipe.match(/🍽\s*(.+)/);
      const name = nameMatch ? nameMatch[1].split("\n")[0] : "Без названия";

      db.run(
        `INSERT INTO favorites(user_id, name, recipe, created_at)
         VALUES (?, ?, ?, ?)`,
        [userId, name, recipe, Date.now()]
      );

      return send(chatId, `⭐ Рецепт "${name}" добавлен в избранное!`);
    }

    if (data.startsWith("fav_del_")) {
      const id = data.split("_")[2];
      db.run(`DELETE FROM favorites WHERE id=? AND user_id=?`, [id, userId]);
      return send(chatId, "❌ Рецепт удален из избранного");
    }

    if (data.startsWith("fav_again_")) {
      const id = data.split("_")[2];
      db.get(
        `SELECT recipe FROM favorites WHERE id=? AND user_id=?`,
        [id, userId],
        (_, row) => {
          if (!row) return send(chatId, "❌ Рецепт не найден");
          state[userId].lastRecipe = row.recipe;
          return send(chatId, row.recipe, recipeActionsKeyboard());
        }
      );
    }

    if (data.startsWith("fav_view_")) {
      const id = data.split("_")[2];
      db.get(
        `SELECT recipe FROM favorites WHERE id=? AND user_id=?`,
        [id, userId],
        (_, row) => {
          if (!row) return send(chatId, "❌ Рецепт не найден");
          state[userId].lastRecipe = row.recipe;
          return send(chatId, row.recipe, recipeActionsKeyboard());
        }
      );
    }

    /* ================= СПИСОК ПОКУПОК ================= */
    if (data.startsWith("shop_toggle_")) {
      const id = data.split("_")[2];
      db.get(`SELECT bought FROM shopping_list WHERE id=? AND user_id=?`, [id, userId], (_, row) => {
        const newBought = row.bought ? 0 : 1;
        db.run(`UPDATE shopping_list SET bought=? WHERE id=? AND user_id=?`, [newBought, id, userId]);

        db.all(`SELECT id, item, bought FROM shopping_list WHERE user_id=?`, [userId], (_, rows) => {
          const list = rows.map((r, i) => `${r.bought ? "✅" : "🛒"} ${i + 1}. ${r.item}`).join("\n");
          const keyboard = {
            inline_keyboard: [
              ...rows.map((r, i) => [{ text: `${r.bought ? "✅" : "🛒"} ${i + 1}`, callback_data: `shop_toggle_${r.id}` }]),
              [{ text: "❌ Удалить все", callback_data: "shop_clear" }],
              [{ text: "🔙 На кухню", callback_data: "menu_back" }]
            ]
          };
          return send(chatId, list, keyboard);
        });
      });
    }

    if (data === "shop_clear") {
      db.run(`DELETE FROM shopping_list WHERE user_id=?`, [userId]);
      return send(chatId, "🗑 Список покупок очищен", mainMenuKeyboard());
    }

    /* ================= МЕНЮ ================= */
    if (data.startsWith("menu_")) {
      switch (data) {
        case "menu_new":
          state[userId] = { mode: "products", products: "" };
          return send(chatId, "🍳 Пришлите продукты — текстом или голосом", mainMenuKeyboard());
        case "menu_fast":
          state[userId] = { mode: "products", products: "", fast: true, time: "15" };
          await send(chatId, "⚡ Быстро приготовить. Время готовки до 15 минут");
          return send(chatId, "🍽 Пришлите продукты — текстом или голосом", mainMenuKeyboard());
        case "menu_search":
          state[userId] = { mode: "search" };
          return send(chatId, "🔍 Напишите название рецепта для поиска", mainMenuKeyboard());
        case "menu_shop":
          db.all(`SELECT id, item, bought FROM shopping_list WHERE user_id=?`, [userId], (_, rows) => {
            if (!rows.length) return send(chatId, "🛒 Список покупок пуст", mainMenuKeyboard());
            state[userId] = { mode: "removeShop", shopItems: rows };
            const list = rows.map((r, i) => `${r.bought ? "✅" : "🛒"} ${i + 1}. ${r.item}`).join("\n");
            const keyboard = {
              inline_keyboard: [
                ...rows.map((r, i) => [{ text: `${r.bought ? "✅" : "🛒"} ${i + 1}`, callback_data: `shop_toggle_${r.id}` }]),
                [{ text: "❌ Удалить все", callback_data: "shop_clear" }],
                [{ text: "🔙 На кухню", callback_data: "menu_back" }]
              ]
            };
            return send(chatId, list, keyboard);
          });
          break;
        case "menu_fav":
          db.all(`SELECT id, name FROM favorites WHERE user_id=? ORDER BY created_at DESC`, [userId], (_, rows) => {
            if (!rows.length) return send(chatId, "⭐ У вас пока нет избранных рецептов", mainMenuKeyboard());
            const keyboard = {
              inline_keyboard: rows.map(r => [
                { text: r.name.length > 25 ? r.name.slice(0, 25) + "…" : r.name, callback_data: `fav_view_${r.id}` },
                { text: "❌", callback_data: `fav_del_${r.id}` },
                { text: "🔁", callback_data: `fav_again_${r.id}` }
              ]).concat([[{ text: "🔙 На кухню", callback_data: "menu_back" }]])
            };
            return send(chatId, "⭐ Избранные рецепты:", keyboard);
          });
          break;
        case "menu_profile":
          return showProfile(chatId, userId);
      }
    }
  


    /* ================= ТЕСТОВОЕ ПРОДЛЕНИЕ ================= */
    if (data === "sub_test") {
      const until = Date.now() + 24 * 60 * 60 * 1000; // +1 день
      db.run(`INSERT INTO subscriptions(user_id, until) VALUES(?, ?) ON CONFLICT(user_id) DO UPDATE SET until=?`, [userId, until, until]);
      return send(chatId, "✅ Подписка продлена на 1 день для теста");
    }
  }
});

/* ================= SERVER ================= */
app.get("/", (_, res) => res.send("OK"));
app.listen(PORT, () => console.log("👨‍🍳 НейроШеф запущен"));
