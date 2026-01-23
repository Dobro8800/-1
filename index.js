import express from "express";
import axios from "axios";

const BOT_TOKEN = process.env.BOT_TOKEN;
const GEMINI_KEY = process.env.GEMINI_KEY;

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const app = express();
app.use(express.json());

// Проверяем переменные окружения
if (!BOT_TOKEN) console.error("❌ BOT_TOKEN не подхватился!");
if (!GEMINI_KEY) console.error("❌ GEMINI_KEY не подхватился!");

console.log("Бот запускается...");

// Вспомогательная функция отправки сообщения
async function sendMessage(chatId, text) {
  if (!BOT_TOKEN) return console.error("BOT_TOKEN отсутствует, сообщение не отправлено");
  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text
    });
  } catch (err) {
    console.error("Ошибка отправки сообщения:", err.response?.data || err.message);
  }
}

// Webhook для Telegram
app.post("/", async (req, res) => {
  res.send("ok"); // Сразу подтверждаем Telegram
  const update = req.body;

  console.log("=== Получен update ===");
  console.log(JSON.stringify(update, null, 2));

  if (!update.message) return;

  const chatId = update.message.chat.id;
  const text = update.message.text;

  if (text === "/start") {
    sendMessage(chatId, "👋 Привет! Бот живой ✅\nОтправь любое сообщение, и я покажу, что получил.");
  } else {
    sendMessage(chatId, `Ты написал: ${text}`);
  }
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running на порту ${PORT}`));
