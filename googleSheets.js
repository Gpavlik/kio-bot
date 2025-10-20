const { google } = require('googleapis');
const { GoogleAuth } = require('google-auth-library');

// Авторизація через Railway-змінну
const auth = new GoogleAuth({
  credentials: require('./service-account.json'),

  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const sheets = google.sheets({ version: 'v4', auth });

// 📄 ID таблиці
const spreadsheetId = '1LHbfKAtkkbBk6noyZsad7_geQ-uWCWT2xtmKKKKK0Vo';

// 📥 Отримати всі рядки з аркуша Users
async function getUsersFromSheet() {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'Users!A1:Z1000'
    });
    return res.data.values || [];
  } catch (error) {
    console.error('❌ Помилка при читанні таблиці:', error.message);
    throw error;
  }
}

// ✅ Перевірити, чи chatId є в колонці D
async function isVerified(chatId) {
  try {
    const rows = await getUsersFromSheet();
    return rows.some((row, index) => index > 0 && Number(row[3]) === Number(chatId));
  } catch (error) {
    console.error('❌ Помилка при перевірці доступу:', error.message);
    return false;
  }
}

module.exports = {
  getUsersFromSheet,
  isVerified
};
