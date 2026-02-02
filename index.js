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

function recipeActionsKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "⭐ В избранное", callback_data: "fav_add" }],
      [{ text: "🛒 Добавить в список покупок", callback_data: "add_to_shop" }],
      [{ text: "🔙 На кухню", callback_data: "menu_back" }]
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
    // Строки начинающиеся с символов ингредиентов
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
app.post("/webhook", async (req, res) => {
  res.send("ok");
  const u = req.body;
  const chatId = u.message?.chat.id || u.callback_query?.message.chat.id;
  const userId = u.message?.from.id || u.callback_query?.from.id;

  state[userId] ??= {};

  /* ========== TEXT MESSAGES ========== */
  if (u.message?.text) {
    const text = u.message.text.trim();

    // Ввод продуктов
    if (state[userId].mode === "products") {
      if (text === "🍽 На кухню") {
        delete state[userId];
        return showMainMenu(chatId);
      }

      state[userId].products = state[userId].products
        ? state[userId].products + ", " + text
        : text;

      await send(chatId, `Вы написали:\n<b>${text}</b>`);
      return send(chatId, "🍽 Выберите тип питания:", dietKeyboardWithAdd);
    }

    // Команды
    if (text === "/start") {
      delete state[userId];
      return send(
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
      return showMainMenu(chatId);
    }
  }

  /* ========== VOICE MESSAGES ========== */
  if (u.message?.voice) {
    const text = await recognizeVoice(u.message.voice.file_id);
    state[userId].mode = "products";
    state[userId].products = state[userId].products
      ? state[userId].products + ", " + text
      : text;

    await send(chatId, `🎙 Я услышал:\n<b>${text}</b>`);
    return send(chatId, "🍽 Выберите тип питания:", dietKeyboardWithAdd);
  }

  /* ========== CALLBACKS ========== */
  if (u.callback_query) {
    const { data, message, id } = u.callback_query;

    await axios.post(`${TG}/answerCallbackQuery`, { callback_query_id: id });

    const sub = await hasSubscription(userId);
    const free = await canUseFree(userId);

    // Выбор типа питания
    if (data.startsWith("diet_")) {
      if (["pp","slim"].includes(data.replace("diet_","")) && !sub)
        return send(chatId, "🔒 Этот режим доступен по подписке");

      state[userId].diet = data.replace("diet_","");
      if (state[userId].fast) {
        state[userId].time = "15";
        return send(chatId, "⚡ Рецепт будет готов до 15 минут\n👥 Выберите количество персон:", personsKeyboard);
      }
      return send(chatId, "⏱ Время готовки:", timeKeyboard);
    }

    // Выбор времени
    if (data.startsWith("time_")) {
      state[userId].time = data.replace("time_","");
      return send(chatId, "👥 Количество персон:", personsKeyboard);
    }

    // Выбор персон
    if (data.startsWith("p_")) {
      state[userId].persons = data.replace("p_","");
      if (!sub && !free) return send(chatId, "🔒 Лимит бесплатных рецептов исчерпан");

      await send(chatId,"👨‍🍳 НейроШеф готовит рецепт...");
      const recipe = await generateRecipe(state[userId]);
      if (!sub) incUsage(userId);
      delete state[userId];

      return send(chatId, recipe, recipeActionsKeyboard());
    }

    // Добавить продукты
    if (data === "add_products") {
      state[userId].mode = "products";
      return send(chatId, "➕ Напиши продукты, которые хочешь добавить");
    }

    // Добавить в избранное
    if (data === "fav_add") {
      const lines = message.text.split("\n");
      const titleLine = lines[0].trim();
      const name = titleLine.startsWith("🍽") ? titleLine.replace("🍽 ","").slice(0,35) : "Рецепт";

      db.run(
        `INSERT INTO favorites(user_id,name,recipe,created_at) VALUES(?,?,?,?)`,
        [userId, name, message.text, Date.now()]
      );
      return send(chatId, "⭐ Рецепт добавлен в избранное!");
    }

    // Добавить в список покупок
    if (data === "add_to_shop") {
      const ingredients = extractIngredients(message.text);
      if (!ingredients.length) return send(chatId,"❌ Не удалось извлечь ингредиенты");

      ingredients.forEach(item => {
        db.run(`INSERT INTO shopping_list(user_id,item) VALUES(?,?)`,[userId,item]);
      });

      return send(chatId,"🛒 Ингредиенты добавлены в список покупок!");
    }

      // Быстро приготовить
    if (data === "menu_fast") {
      state[userId] = { mode: "products", fast: true, products: "" };
      return send(chatId,"⚡ Пришли продукты — рецепт будет готов до 15 минут");
    }

    // На кухню
    if (data === "menu_back") {
      delete state[userId];
      return showMainMenu(chatId);
    }

    // Новый рецепт
    if (data === "menu_new") {
      state[userId] = { mode: "products", products: "" };
      return send(chatId,"🍳 Пришли продукты — текстом или голосом", kitchenEntryKeyboard);
    }

    // Поиск рецепта
    if (data === "menu_search") {
      state[userId] = { mode:"search" };
      return send(chatId,"🔍 Напиши, какой рецепт хочешь найти\n\nНапример:\n• паста карбонара\n• суп с фрикадельками");
    }

    // Список покупок
    if (data === "menu_shop") {
      db.all(`SELECT id,item,bought FROM shopping_list WHERE user_id=?`,[userId],(_,rows)=>{
        if(!rows.length) return send(chatId,"🛒 Список покупок пуст");

        const keyboard = rows.map(r=>[{text:`${r.bought?"✅":"🛒"} ${r.item}`,callback_data:`shop_toggle_${r.id}`}]);
        keyboard.push([{text:"❌ Удалить все",callback_data:"shop_clear"}]);
        return send(chatId,"🛒 Ваш список покупок:",{inline_keyboard:keyboard});
      });
    }

    // Избранное
    if (data === "menu_fav") {
      db.all(`SELECT id,name FROM favorites WHERE user_id=? ORDER BY created_at DESC`,[userId],(_,rows)=>{
        if(!rows.length) return send(chatId,"⭐ Избранных рецептов пока нет");

        const keyboard = rows.map(r=>[
          {text:r.name,callback_data:`fav_${r.id}`},
          {text:"🔄 Приготовить снова",callback_data:`fav_again_${r.id}`},
          {text:"❌ Удалить",callback_data:`fav_del_${r.id}`}
        ]);
        return send(chatId,"⭐ Ваши избранные рецепты:",{inline_keyboard:keyboard});
      });
    }

    // Профиль
    if (data === "menu_profile") {
      return showProfile(chatId,userId);
    }

    // TODO: Реакция на удаление/повторение в избранном и список покупок
    // shop_toggle_{id}, shop_clear, fav_del_{id}, fav_again_{id}
  }
});

/* ================= SERVER ================= */
app.get("/",(_,res)=>res.send("OK"));
app.listen(PORT,()=>console.log("👨‍🍳 НейроШеф запущен"));
