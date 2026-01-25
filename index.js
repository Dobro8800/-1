import express from "express";
import axios from "axios";

const app = express();
app.use(express.json({ limit: "20mb" }));

// ===== ENV =====
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("BOT_TOKEN is not defined");

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const YANDEX_GPT_API_KEY = process.env.YANDEX_GPT_API_KEY;
if (!YANDEX_GPT_API_KEY) throw new Error("YANDEX_GPT_API_KEY is not defined");

const YANDEX_STT_API_KEY = process.env.YANDEX_STT_API_KEY;
if (!YANDEX_STT_API_KEY) throw new Error("YANDEX_STT_API_KEY is not defined");

const YANDEX_FOLDER_ID = process.env.YANDEX_FOLDER_ID;
if (!YANDEX_FOLDER_ID) throw new Error("YANDEX_FOLDER_ID is not defined");

// ===== USER STATE =====
const state = {};

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
    throw error;
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
        timeout: 10000
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

// ===== YANDEX GPT - ИСПРАВЛЕННАЯ ВЕРСИЯ =====
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
      "https://llm.api.cloud.yandex.net/foundationModels/v1/completion", // ← Исправленный URL
      {
        modelUri: `gpt://${YANDEX_FOLDER_ID}/yandexgpt/latest`, // ← Исправленная модель
        messages: [
          {
            role: "user",
            text: prompt
          }
        ],
        completionOptions: {
          temperature: 0.6,
          maxTokens: 600
        }
      },
      {
        headers: {
          Authorization: `Api-Key ${YANDEX_GPT_API_KEY}`,
          "x-folder-id": YANDEX_FOLDER_ID,
          "Content-Type": "application/json"
        },
        timeout: 30000
      }
    );

    console.log("GPT Response:", JSON.stringify(res.data, null, 2)); // ← Для дебага

    const response = res.data;
    if (!response.result?.alternatives?.[0]?.message?.text) {
      console.error("GPT Response structure:", response);
      throw new Error("Yandex GPT returned invalid response structure");
    }

    return response.result.alternatives[0].message.text.trim();
  } catch (error) {
    console.error("GPT Error Details:", {
      message: error.message,
      response: error.response?.data,
      status: error.response?.status,
      url: error.config?.url
    });
    throw new Error("Не удалось сгенерировать рецепт. Попробуйте позже.");
  }
}

// ===== WEBHOOK =====
app.post("/webhook", async (req, res) => {
  try {
    const update = req.body;
    
    // Отвечаем Telegram сразу
    res.send("ok");

    // Обрабатываем асинхронно
    processUpdate(update).catch(error => {
      console.error("Error processing update:", error);
    });
    
  } catch (error) {
    console.error("Webhook error:", error);
    res.send("ok");
  }
});

// ===== ASYNC UPDATE PROCESSING =====
async function processUpdate(update) {
  if (update.message?.text) {
    const chatId = update.message.chat.id;
    const userId = update.message.from.id;
    const text = update.message.text.trim();

    if (text === "/start") {
      await send(
        chatId,
        "👋 Я <b>бот-повар</b>\n\n🎤 Пришли голосом продукты\n✍️ или напиши через запятую"
      );
      return;
    }

    if (text.includes(",")) {
      state[userId] = { products: text, chatId };
      await send(chatId, "🍽 Выбери тип питания:", dietKeyboard());
      return;
    }
  }

  if (update.message?.voice) {
    const chatId = update.message.chat.id;
    const userId = update.message.from.id;
    const fileId = update.message.voice.file_id;

    try {
      const fileRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
      const filePath = fileRes.data.result.file_path;
      const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;

      const audioRes = await axios.get(fileUrl, { responseType: "arraybuffer" });
      const text = await speechToText(audioRes.data);

      state[userId] = { products: text, chatId };

      await send(
        chatId,
        `🧺 Ты сказал:\n<b>${text}</b>\n\nВыбери тип питания:`,
        dietKeyboard()
      );
    } catch (error) {
      await send(chatId, "❌ Ошибка при обработке голоса. Попробуйте ещё раз.");
      console.error("Voice processing error:", error);
    }
    return;
  }

  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message.chat.id;
    const userId = cb.from.id;
    const diet = cb.data.replace("diet_", "");

    try {
      // Отвечаем на callback query
      await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
        callback_query_id: cb.id
      });

      if (!state[userId]) {
        await send(chatId, "❗ Пришли продукты заново");
        return;
      }

      await send(chatId, "👨‍🍳 Готовлю рецепт…");

      const recipe = await generateRecipe(state[userId].products, diet);
      delete state[userId];
      await send(chatId, recipe);
    } catch (error) {
      await send(chatId, "❌ Ошибка при генерации рецепта. Попробуйте позже.");
      console.error("Recipe generation error:", error);
    }
    return;
  }
}

// ===== START =====
const PORT = process.env.PORT || 3000;

// Добавьте в index.js перед app.listen
app.get('/debug-yandex', async (req, res) => {
  console.log('Folder ID:', process.env.YANDEX_FOLDER_ID);
  console.log('API Key exists:', !!process.env.YANDEX_GPT_API_KEY);
  
  try {
    const response = await axios.post(
      'https://llm.api.cloud.yandex.net/foundationModels/v1/completion',
      {
        modelUri: `gpt://${process.env.YANDEX_FOLDER_ID}/yandexgpt-lite`,
        messages: [{ role: 'user', text: 'Тест связи' }]
      },
      {
        headers: {
          'Authorization': `Api-Key ${process.env.YANDEX_GPT_API_KEY}`,
          'x-folder-id': process.env.YANDEX_FOLDER_ID
        }
      }
    );
    
    res.json({ status: 'success', data: response.data });
  } catch (error) {
    res.json({ 
      status: 'error', 
      error: error.response?.data || error.message,
      details: {
        folderId: process.env.YANDEX_FOLDER_ID,
        apiKeyLength: process.env.YANDEX_GPT_API_KEY?.length
      }
    });
  }
});

app.listen(PORT, () => {
  console.log("Bot started on port", PORT);
});
