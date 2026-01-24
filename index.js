import express from "express";
import axios from "axios";

const app = express();
app.use(express.json({ limit: "20mb" }));

// ===== ENV =====
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("BOT_TOKEN is not defined in environment variables");

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const YANDEX_GPT_API_KEY = process.env.YANDEX_GPT_API_KEY;
if (!YANDEX_GPT_API_KEY) throw new Error("YANDEX_GPT_API_KEY is not defined");

const YANDEX_STT_API_KEY = process.env.YANDEX_STT_API_KEY;
if (!YANDEX_STT_API_KEY) throw new Error("YANDEX_STT_API_KEY is not defined");

const YANDEX_FOLDER_ID = process.env.YANDEX_FOLDER_ID;
if (!YANDEX_FOLDER_ID) throw new Error("YANDEX_FOLDER_ID is not defined");

// ===== USER STATE =====
const state = {}; // state[userId] = { products, chatId } — добавим chatId для надёжности

// ===== HEALTH CHECK =====
app.get("/", (req, res) => {
  res.send("OK");
});

// ===== TELEGRAM SEND =====
async function send(chatId, text, keyboard = null) {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: "HTML"
  };
  if (keyboard) payload.reply_markup = keyboard;

  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, payload);
  } catch (error) {
    console.error("Failed to send message:", error.response?.data || error.message);
    throw error; // Пусть обработается в webhook
  }
}

// ===== KEYBOARD =====
function dietKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "🥘 Обычное", callback_data: "diet_normal" },
        { text: "🥗 ПП", callback_data: "diet_healthy" }
      ],
      [{ text: "🌱 Веган", callback_data: "diet_vegan" }],
      [
        { text: "🔥 Похудеть", callback_data: "diet_slim" },
        { text: "⚡ Быстро", callback_data: "diet_fast" }
      ]
    ]
  };
}

// ===== SPEECHKIT STT =====
async function speechToText(oggBuffer) {
  try {
    const res = await axios.post(
      "https://stt.api.cloud.yandex.net/speech/v1/stt:recognize",
      oggBuffer,
      {
        headers: {
          Authorization: `Api-Key ${YANDEX_STT_API_KEY}`,
          "Content-Type": "audio/ogg"
        },
        params: {
          folderId: YANDEX_FOLDER_ID,
          lang: "ru-RU"
        },
        timeout: 10000 // Защита от зависания
      }
    );

    if (!res.data.result) {
      throw new Error("Yandex STT returned empty result");
    }

    return res.data.result.trim();
  } catch (error) {
    console.error("STT Error:", error.response?.data || error.message);
    throw new Error("Не удалось распознать речь. Попробуйте повторить.");
  }
}

// ===== YANDEX GPT 5.1 =====
async function generateRecipe(products, diet) {
  const prompt = `
Ты профессиональный повар.

Продукты: ${products}
Тип питания: ${diet}

Сделай ОДИН рецепт.
Формат строго такой:

<b>Название блюда</b>
⏱ Время | 👥 Порции
1. шаг
2. шаг
3. шаг
4. шаг
5. шаг
КБЖУ
`;

  try {
    const res = await axios.post(
      "https://llm.api.cloud.yandex.net/foundationModels/v1/chat/completions",
      {
        model: "yandexgpt-5.1",
        messages: [{ role: "user", text: prompt }],
        temperature: 0.6,
        maxTokens: 600
      },
      {
        headers: {
          Authorization: `Api-Key ${YANDEX_GPT_API_KEY}`,
          "x-folder-id": YANDEX_FOLDER_ID,
          "Content-Type": "application/json"
        },
        timeout: 15000
      }
    );

    const response = res.data;
    if (!response.result?.alternatives?.[0]?.message?.text) {
      throw new Error("Yandex GPT returned invalid response structure");
    }

    return response.result.alternatives[0].message.text.trim();
  } catch (error) {
    console.error("GPT Error:", error.response?.data || error.message);
    throw new Error("Не удалось сгенерировать рецепт. Попробуйте позже.");
  }
}

// ===== WEBHOOK =====
app.post("/webhook", async (req, res) => {
  try {
    const update = req.body;

    // Ответ Telegram сразу — чтобы не таймаутить
    res.send("ok");

    // ===== TEXT =====
    if (update.message?.text) {
      const chatId = update.message.chat.id;
      const userId = update.message.from.id;
      const text = update.message.text.trim();

      if (text === "/start") {
        return send(
          chatId,
          "👋 Я <b>бот-повар</b>\n\n🎤 Пришли голосом продукты\n✍️ или напиши через запятую"
        );
      }

      if (text.includes(",")) {
        state[userId] = { products: text, chatId }; // Сохраняем chatId на случай ошибки
        return send(chatId, "🍽 Выбери тип питания:", dietKeyboard());
      }
    }

    // ===== VOICE =====
    if (update.message?.voice) {
      const chatId = update.message.chat.id;
      const userId = update.message.from.id;
      const fileId = update.message.voice.file_id;

      const fileRes = await axios.get(
        `${TELEGRAM_API}/getFile?file_id=${fileId}`
      );

      const filePath = fileRes.data.result.file_path;
      const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;

      const audioRes = await axios.get(fileUrl, {
        responseType: "arraybuffer"
      });

      const text = await speechToText(audioRes.data);

      state[userId] = { products: text, chatId };

      return send(
        chatId,
        `🧺 Ты сказал:\n<b>${text}</b>\n\nВыбери тип питания:`,
        dietKeyboard()
      );
    }

    // ===== BUTTONS =====
    if (update.callback_query) {
      const cb = update.callback_query;
      const chatId = cb.message.chat.id;
      const userId = cb.from.id;
      const diet = cb.data.replace("diet_", "");

      // Проверяем, есть ли пользователь в состоянии
      if (!state[userId]) {
        return send(chatId, "❗ Пришли продукты заново");
      }

      await send(chatId, "👨‍🍳 Готовлю рецепт…");

      const recipe = await generateRecipe(
        state[userId].products,
        diet
      );

      delete state[userId]; // Очистка состояния
      return send(chatId, recipe);
    }

    // Если ничего не обработано — всё равно OK
  } catch (error) {
    console.error("WEBHOOK ERROR:", error.response?.data || error.message || error);
    // Не отправляем ошибку в ответ — Telegram ждёт 200 OK
    // Логируем и игнорируем, чтобы не ломать вебхук
  }
});

// ===== START =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Bot started on port", PORT);
});
