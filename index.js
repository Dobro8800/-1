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
/* ================= KITCHEN MENU ================= */

const kitchenEntryKeyboard = {
  keyboard: [[{ text: "🍽 На кухню" }]],
  resize_keyboard: true,
  one_time_keyboard: false
};

const kitchenMenuKeyboard = {
  keyboard: [
    [{ text: "🍳 Новый рецепт" }],
    [{ text: "💡 Совет дня" }, { text: "👤 Профиль" }],
    [{ text: "💳 Подписка" }, { text: "ℹ️ Помощь" }],
    [{ text: "⬅️ Назад" }]
  ],
  resize_keyboard: true,
  one_time_keyboard: false
};


function afterRecipeKeyboard(hasSub) {
  if (!hasSub) {
    return {
      inline_keyboard: [
        [{ text: "🔒 Подписка — больше рецептов", callback_data: "paywall" }]
      ]
    };
  }
  return {
    inline_keyboard: [
      [{ text: "🔁 Ещё рецепт", callback_data: "again" }]
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
Время готовки: ${data.time}
Количество персон: ${data.persons}

Правила:
- Можно использовать не все продукты
- Соль, перец молотый и специи можно использовать
- Максимум 5 шагов приготовления
- Укажи сложность по шкале 1–5
- КБЖУ рассчитай ПРИМЕРНО
- Используй эмодзи умеренно

Формат:

<b>👨‍🍳 Название блюда</b>

⭐ Сложность: X/5  
⏱ Время:  
👥 Порции:  

<b>🧺 Ингредиенты:</b>
• …

<b>🔥 Приготовление:</b>
1️⃣ …
2️⃣ …
3️⃣ …
4️⃣ …
5️⃣ …

<b>📊 КБЖУ (примерно):</b>
Ккал | Белки | Жиры | Углеводы

<b>💡 Совет от НейроШефа:</b>
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

    /* ================= KITCHEN BUTTONS ================= */

  if (u.message?.text) {
    const chatId = u.message.chat.id;

    if (u.message.text === "🍽 На кухню") {
      return send(
        chatId,
        "👨‍🍳 Добро пожаловать на кухню НейроШефа!\nВыбирай, чем займёмся 👇",
        kitchenMenuKeyboard
      );
    }

    if (u.message.text === "🍳 Новый рецепт") {
      return send(
        chatId,
        "🍳 Пришли продукты — текстом через запятую или голосовым сообщением",
        kitchenEntryKeyboard
      );
    }

    if (u.message.text === "💡 Совет дня") {
      return send(
        chatId,
        "💡 Совет от НейроШефа: пробуй блюдо на каждом этапе приготовления 😉",
        kitchenEntryKeyboard
      );
    }

    if (u.message.text === "👤 Профиль") {
      return send(
        chatId,
        "👤 Профиль НейроШефа\n\nЗдесь скоро появится статистика и история рецептов 👨‍🍳",
        kitchenEntryKeyboard
      );
    }

    if (u.message.text === "💳 Подписка") {
      return send(
        chatId,
        "💳 Подписка НейроШефа\n\nОткрывает ПП, похудение и неограниченные рецепты 🔥",
        kitchenEntryKeyboard
      );
    }

    if (u.message.text === "ℹ️ Помощь") {
      return send(
        chatId,
        "ℹ️ Как пользоваться ботом:\n\n1️⃣ Нажми «Новый рецепт»\n2️⃣ Пришли продукты\n3️⃣ Следуй подсказкам НейроШефа 👨‍🍳",
        kitchenEntryKeyboard
      );
    }

    if (u.message.text === "⬅️ Назад") {
      return send(
        chatId,
        "🍽 Ты снова на кухне. Чем займёмся?",
        kitchenEntryKeyboard
      );
    }
  }


  if (u.message?.text) {
    const chatId = u.message.chat.id;
    const userId = u.message.from.id;

    if (u.message.text === "/start") {
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

    state[userId] = { products: u.message.text };
    return send(chatId, "🍽 Выбери тип питания:", dietKeyboard);
  }

  if (u.message?.voice) {
    const chatId = u.message.chat.id;
    const userId = u.message.from.id;

    const text = await recognizeVoice(u.message.voice.file_id);
    await send(chatId, `🎙 Я услышал:\n<b>${text}</b>`);

    state[userId] = { products: text };
    return send(chatId, "🍽 Выбери тип питания:", dietKeyboard);
  }

  if (u.callback_query) {
    const { data, from, message, id } = u.callback_query;
    const chatId = message.chat.id;
    const userId = from.id;

    await axios.post(`${TG}/answerCallbackQuery`, { callback_query_id: id });

    const sub = await hasSubscription(userId);

    if (data.startsWith("diet_")) {
      if (["pp", "slim"].includes(data.replace("diet_", "")) && !sub) {
        return send(chatId, "🔒 Этот режим доступен по подписке");
      }
      state[userId].diet = data.replace("diet_", "");
      return send(chatId, "⏱ Время готовки:", timeKeyboard);
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
      await send(chatId, "👨‍🍳 НейроШеф готовит рецепт... 🔥");

      const recipe = await generateRecipe(state[userId]);
      if (!sub) incUsage(userId);

      delete state[userId];
      return send(chatId, recipe, afterRecipeKeyboard(sub));
    }

    if (data === "again") {
      return send(chatId, "🍳 Пришли продукты заново — текстом или голосом");
    }

    if (data === "paywall") {
      return send(chatId, "🔒 Подписка скоро будет подключена 😉");
    }
  }
});

app.get("/", (_, res) => res.send("OK"));
app.listen(PORT, () => console.log("👨‍🍳 НейроШеф запущен"));
