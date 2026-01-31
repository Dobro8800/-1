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
      recipe TEXT,
      created_at INTEGER
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS shopping_list (
      user_id INTEGER,
      item TEXT
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
    [{ text: "ℹ️ Помощь" }],
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
// ⬅️ без изменений (оставлено как у тебя)

/* ================= TELEGRAM ================= */
app.post("/webhook", async (req, res) => {
  res.send("ok");
  const u = req.body;

  const chatId = u.message?.chat?.id || u.callback_query?.message?.chat?.id;
  const userId = u.message?.from?.id || u.callback_query?.from?.id;
  const text = u.message?.text;

  /* ---------- TEXT ---------- */
  if (text) {

    /* --- REMOVE SHOP MODE --- */
    if (state[userId]?.removeShop) {
      const index = parseInt(text, 10) - 1;

      if (Number.isNaN(index)) {
        delete state[userId].removeShop;
      } else {
        const item = state[userId].shopItems[index];
        if (!item) return send(chatId, "❌ Неверный номер. Попробуй ещё раз.");

        db.run(
          `DELETE FROM shopping_list WHERE rowid=? AND user_id=?`,
          [item.rowid, userId],
          () => {
            db.all(
              `SELECT rowid, item FROM shopping_list WHERE user_id=?`,
              [userId],
              (_, rows) => {
                if (!rows.length) {
                  delete state[userId];
                  return send(chatId, "🛒 Список покупок пуст", kitchenMenuKeyboard);
                }

                state[userId] = { ...state[userId], removeShop: true, shopItems: rows };
                const list = rows.map((r, i) => `🛒 ${i + 1}. ${r.item}`).join("\n");
                return send(
                  chatId,
                  `✅ Удалено: <b>${item.item}</b>\n\n${list}\n\n❌ Напиши номер ингредиента, чтобы удалить ещё`,
                  kitchenMenuKeyboard
                );
              }
            );
          }
        );
        return;
      }
    }

    /* --- FEEDBACK --- */
    if (state[userId]?.feedback) {
      await send(OWNER_ID, `📩 Обратная связь от ${userId}:\n\n${text}`);
      delete state[userId].feedback;
      return send(chatId, "✅ Сообщение отправлено владельцу", kitchenEntryKeyboard);
    }

    /* --- SEARCH --- */
    if (state[userId]?.search && !text.startsWith("/")) {
      await send(chatId, "🔍 Ищу рецепт...");
      const recipe = await searchRecipe(text);
      delete state[userId].search;
      return send(chatId, recipe, recipeActionsKeyboard(await hasSubscription(userId)));
    }

    /* --- PRODUCTS --- */
    if (state[userId]?.products && !text.startsWith("/")) {
      state[userId].products += ", " + text;
      return send(chatId, "✅ Продукты добавлены. Продолжаем 👌", dietKeyboardWithAdd);
    }

    /* --- COMMANDS --- */
    if (text === "/start") {
      return send(chatId, "👨‍🍳 Привет! Я <b>НейроШеф</b> 🤖", kitchenEntryKeyboard);
    }

    if (text === "🍽 На кухню") return send(chatId, "👨‍🍳 Кухня НейроШефа", kitchenMenuKeyboard);

    if (text === "🍳 Новый рецепт") return send(chatId, "🍳 Пришли продукты — текстом или голосом", kitchenEntryKeyboard);

    if (text === "⚡ Быстро приготовить") {
      state[userId] = { ...state[userId], fast: true };
      return send(chatId, "⚡ Быстрый режим включён!");
    }

    if (text === "🔍 Поиск рецепта") {
      state[userId] = { ...state[userId], search: true };
      return send(chatId, "🔍 Напиши, какой рецепт хочешь найти");
    }

    if (text === "🛒 Список покупок") {
      db.all(`SELECT rowid, item FROM shopping_list WHERE user_id=?`, [userId], (_, rows) => {
        if (!rows.length) return send(chatId, "🛒 Список покупок пуст", kitchenMenuKeyboard);
        state[userId] = { ...state[userId], removeShop: true, shopItems: rows };
        const list = rows.map((r, i) => `🛒 ${i + 1}. ${r.item}`).join("\n");
        return send(chatId, `🛒 Список покупок:\n${list}`, kitchenMenuKeyboard);
      });
      return;
    }

    if (text === "ℹ️ Помощь") {
      state[userId] = { ...state[userId], feedback: true };
      return send(chatId, "📩 Напиши сообщение — я передам владельцу", kitchenEntryKeyboard);
    }

    state[userId] = { ...state[userId], products: text };
    return send(chatId, "🍽 Выбери тип питания:", dietKeyboardWithAdd);
  }

  /* ---------- VOICE ---------- */
  if (u.message?.voice) {
    const voiceText = await recognizeVoice(u.message.voice.file_id);
    state[userId] = { ...state[userId], products: voiceText };
    return send(chatId, "🍽 Выбери тип питания:", dietKeyboardWithAdd);
  }

  /* ---------- CALLBACK ---------- */
  if (u.callback_query) {
    const { data, from, message, id } = u.callback_query;
    const chatId = message.chat.id;
    const userId = from.id;

    state[userId] ??= {};
    delete state[userId].removeShop;

    await axios.post(`${TG}/answerCallbackQuery`, { callback_query_id: id });
    const sub = await hasSubscription(userId);

    if (data.startsWith("diet_")) {
      state[userId].diet = data.replace("diet_", "");
      return send(chatId, "⏱ Время готовки:", timeKeyboard);
    }

    if (data.startsWith("time_")) {
      state[userId].time = data.replace("time_", "");
      return send(chatId, "👥 Количество персон:", personsKeyboard);
    }

    if (data.startsWith("p_")) {
      state[userId].persons = data.replace("p_", "");
      await send(chatId, "👨‍🍳 НейроШеф готовит рецепт...");
      const recipe = await generateRecipe(state[userId]);
      return send(chatId, recipe, recipeActionsKeyboard(sub));
    }

    if (data === "add_products") {
      state[userId].products ??= "";
      return send(chatId, "➕ Напиши продукты, которые хочешь добавить");
    }

    if (data === "again") return send(chatId, "🍳 Пришли продукты заново", kitchenEntryKeyboard);
    if (data === "paywall") return send(chatId, "🔒 Подписка скоро будет подключена 😉");
  }
});

app.get("/", (_, res) => res.send("OK"));
app.listen(PORT, () => console.log("👨‍🍳 НейроШеф запущен"));
