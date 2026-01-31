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
const OWNER_ID = 5030758337; // ← ВСТАВЬ СВОЙ TELEGRAM ID

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
async function generateRecipe(data) {
  const prompt = `
Ты — виртуальный шеф-повар по имени НейроШеф.

Продукты: ${data.products}
Тип питания: ${data.diet}
Время: ${data.time}
Персон: ${data.persons}
Правила:
- Можно использовать не все продукты
- Соль, перец молотый и специи можно использовать
- Максимум 5 шагов приготовления
- Укажи сложность по шкале 1–5
- КБЖУ рассчитай ПРИМЕРНО
- Используй эмодзи умеренно
Максимум 5 шагов. КБЖУ примерно.

Формат:
<b>👨‍🍳 Название</b>

⭐ Сложность: X/5
⏱ Время приготовления
👥 Количество персон

<b>🧺 Ингредиенты</b>
• ...

<b>🔥 Приготовление</b>
1️⃣ ...
2️⃣ ...
3️⃣ ...
4️⃣ ...
5️⃣ ...

<b>📊 КБЖУ </b>

<b>💡 Совет от НейроШефа</b>
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

Пользователь ищет рецепт по запросу:
"${query}"

Правила:
- Если блюдо существует — дай КЛАССИЧЕСКИЙ рецепт
- Не выдумывай странные вариации
- Максимум 5 шагов
- Укажи сложность 1–5
- КБЖУ примерно
- Пиши чётко и понятно
- Используй эмодзи умеренно

Формат:
<b>🔍 Название блюда</b>

⭐ Сложность: X/5
⏱ Время приготовления

<b>🧺 Ингредиенты</b>
• ...

<b>🔥 Приготовление</b>
1️⃣ ...
2️⃣ ...
3️⃣ ...
4️⃣ ...
5️⃣ ...

<b>💡 Совет от НейроШефа</b>
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

/* ================= TELEGRAM ================= */
app.post("/webhook", async (req, res) => {
  res.send("ok");
  const u = req.body;

  const chatId = u.message?.chat?.id || u.callback_query?.message?.chat?.id;
  const userId = u.message?.from?.id || u.callback_query?.from?.id;
  const text = u.message?.text;

  // --- Текстовые сообщения ---
  if (text) {

    // ❌ Удаление ингредиента из списка покупок
    if (state[userId]?.removeShop) {
    if (state[userId]?.removeShop) {
  const index = parseInt(text, 10) - 1;

  // Если пользователь ввёл НЕ число — выходим из режима удаления
  if (Number.isNaN(index)) {
    delete state[userId].removeShop; // сброс режима
    return; // дальше текст обработается другими if (командами)
  }

  const item = state[userId].shopItems[index];
  if (!item) {
    return send(chatId, "❌ Неверный номер. Попробуй ещё раз.");
  }

  // Удаляем выбранный ингредиент
  db.run(
    `DELETE FROM shopping_list WHERE rowid=? AND user_id=?`,
    [item.rowid, userId],
    function (err) {
      if (err) {
        console.error(err);
        return send(chatId, "❌ Ошибка при удалении из базы данных");
      }

      db.all(
        `SELECT rowid, item FROM shopping_list WHERE user_id=?`,
        [userId],
        function (_, rows) {
          if (!rows.length) {
            delete state[userId];
            return send(chatId, "🛒 Список покупок пуст", kitchenMenuKeyboard);
          }

          state[userId] = { removeShop: true, shopItems: rows };
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

  return; // важно оставить, чтобы не шли другие if
}


    // --- Обратная связь ---
    if (state[userId]?.feedback) {
      await send(OWNER_ID, `📩 Обратная связь от ${userId}:\n\n${text}`);
      delete state[userId].feedback;
      return send(chatId, "✅ Сообщение отправлено владельцу", kitchenEntryKeyboard);
    }

    // --- Поиск рецепта ---
    if (state[userId]?.search && !text.startsWith("/")) {
      const query = text;
      await send(chatId, "🔍 Ищу рецепт...");
      const recipe = await searchRecipe(query);
      delete state[userId];
      return send(chatId, recipe, recipeActionsKeyboard(await hasSubscription(userId)));
    }

    // --- Добавление продуктов ---
    if (state[userId]?.products && !text.startsWith("/")) {
      state[userId].products += ", " + text;
      return send(chatId, "✅ Продукты добавлены. Продолжаем 👌", dietKeyboardWithAdd);
    }

    // --- Стандартные команды ---
    if (text === "/start") {
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
      return send(chatId, "👨‍🍳 Кухня НейроШефа", kitchenMenuKeyboard);
    }

    if (text === "🍳 Новый рецепт") {
      return send(chatId, "🍳 Пришли продукты — текстом или голосом", kitchenEntryKeyboard);
    }

    if (text === "⚡ Быстро приготовить") {
      state[userId] = { fast: true };
      return send(
        chatId,
        "⚡ Быстрый режим включён!\n\nПришли продукты — я подберу рецепт до 15 минут 👌"
      );
    }

    if (text === "🔍 Поиск рецепта") {
      state[userId] = { search: true };
      return send(
        chatId,
        "🔍 Напиши, какой рецепт хочешь найти\n\nНапример:\n• паста карбонара\n• суп с фрикадельками\n• десерт без сахара"
      );
    }

    if (text === "👤 Профиль") {
      db.all(
        `SELECT recipe FROM favorites WHERE user_id=? ORDER BY created_at DESC`,
        [userId],
        (_, rows) => {
          const list = rows.length
            ? rows.map((r, i) => `⭐ ${i + 1}. ${r.recipe.split("\n")[0]}`).join("\n")
            : "Избранных рецептов пока нет";
          send(chatId, `👤 Профиль\n\n${list}`, kitchenEntryKeyboard);
        }
      );
      return;
    }

    if (text === "🛒 Список покупок") {
      db.all(
        `SELECT rowid, item FROM shopping_list WHERE user_id=?`,
        [userId],
        (_, rows) => {
          if (!rows.length) {
            return send(chatId, "🛒 Список покупок пуст", kitchenMenuKeyboard);
          }
          state[userId] = { removeShop: true, shopItems: rows };
          const list = rows.map((r, i) => `🛒 ${i + 1}. ${r.item}`).join("\n");
          return send(
            chatId,
            `🛒 Список покупок:\n${list}\n\n❌ Напиши номер ингредиента, чтобы удалить`,
            kitchenMenuKeyboard
          );
        }
      );
      return;
    }

    if (text === "ℹ️ Помощь") {
      state[userId] = { feedback: true };
      return send(chatId, "📩 Напиши сообщение — я передам владельцу", kitchenEntryKeyboard);
    }

    // --- Если текст не попал под условия ---
    state[userId] = { products: text };
    return send(chatId, "🍽 Выбери тип питания:", dietKeyboardWithAdd);
  }

  // --- Голосовые сообщения ---
  if (u.message?.voice) {
    const text = await recognizeVoice(u.message.voice.file_id);
    await send(chatId, `🎙 Я услышал:\n<b>${text}</b>`);
    state[userId] = { products: text };
    return send(chatId, "🍽 Выбери тип питания:", dietKeyboardWithAdd);
  }

  // --- Callback queries ---
  if (u.callback_query) {
    const { data, from, message, id } = u.callback_query;
    const chatId = message.chat.id;
    const userId = from.id;

    await axios.post(`${TG}/answerCallbackQuery`, { callback_query_id: id });
    const sub = await hasSubscription(userId);

    // --- Обработка callback ---
    if (data.startsWith("diet_")) {
      if (["pp", "slim"].includes(data.replace("diet_", "")) && !sub) {
        return send(chatId, "🔒 Этот режим доступен по подписке");
      }
      state[userId].diet = data.replace("diet_", "");
      return send(chatId, "⏱ Время готовки:", timeKeyboard);
    }

    if (data === "add_products") {
      return send(chatId, "➕ Напиши продукты, которые хочешь добавить");
    }

    if (data.startsWith("time_")) {
      state[userId].time = data.replace("time_", "");
      return send(chatId, "👥 Количество персон:", personsKeyboard);
    }

    if (data.startsWith("p_")) {
      const free = await canUseFree(userId);
      if (!sub && !free) {
        return send(chatId, "🔒 Лимит бесплатных рецептов исчерпан");
      }

      state[userId].persons = data.replace("p_", "");
      if (state[userId].fast) state[userId].time = "15";

      await send(chatId, "👨‍🍳 НейроШеф готовит рецепт...");
      const recipe = await generateRecipe(state[userId]);
      if (!sub) incUsage(userId);
      delete state[userId];

      return send(chatId, recipe, recipeActionsKeyboard(sub));
    }

    if (data === "fav_add") {
      db.run(
        `INSERT INTO favorites(user_id, recipe, created_at) VALUES (?, ?, ?)`,
        [userId, message.text, Date.now()]
      );
      return send(chatId, "⭐ Рецепт добавлен в избранное!");
    }

    if (data === "add_to_shop") {
      const ingredients = message.text
        .split("🧺 Ингредиенты")[1]
        ?.split("🔥")[0]
        ?.split("\n")
        .filter(l => l.trim().startsWith("•"))
        .map(l => l.replace("•", "").trim());

      if (!ingredients) return send(chatId, "❌ Не удалось извлечь ингредиенты");

      ingredients.forEach(item => {
        db.run(`INSERT INTO shopping_list(user_id,item) VALUES(?,?)`, [userId, item]);
      });

      return send(chatId, "🛒 Ингредиенты добавлены в список покупок!");
    }

    if (data === "again") return send(chatId, "🍳 Пришли продукты заново", kitchenEntryKeyboard);
    if (data === "paywall") return send(chatId, "🔒 Подписка скоро будет подключена 😉");
  }
});

app.get("/", (_, res) => res.send("OK"));
app.listen(PORT, () => console.log("👨‍🍳 НейроШеф запущен"));
      
