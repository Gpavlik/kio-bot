const TelegramBot = require('node-telegram-bot-api');
const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

async function initBot(reloadOrdersFromSheet, syncUsersFromSheet) {
  // Оновлюємо кеш
  await reloadOrdersFromSheet();
  await syncUsersFromSheet();

  // Очищаємо чергу апдейтів
  try {
    const updates = await bot.getUpdates({ offset: -1 });
    console.log(`🧹 Очищено ${updates.length} старих апдейтів`);
  } catch (err) {
    console.error('❌ Помилка очищення апдейтів:', err.message);
  }

  console.log('🚀 Бот запущено і кеш оновлено');
  return bot;
}

module.exports = initBot;
