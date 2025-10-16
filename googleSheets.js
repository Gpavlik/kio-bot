const { google } = require('googleapis');
const { GoogleAuth } = require('google-auth-library');

// Авторизація через змінну середовища Railway
const auth = new GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const sheets = google.sheets({ version: 'v4', auth });

// ID таблиці
const spreadsheetId = '1LHbfKAtkkbBk6noyZsad7_geQ-uWCWT2xtmKKKKK0Vo';

// Читання всіх рядків з аркуша Users
async function getUsersFromSheet() {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'Users!A1:Z1000'
    });
    return res.data.values || [];
  } catch (error) {
    console.error('❌ Помилка при читанні таблиці:', error);
    throw error;
  }
}

// Перевірка, чи chatId є в колонці D
async function isVerified(chatId) {
  try {
    const rows = await getUsersFromSheet();
    for (let i = 1; i < rows.length; i++) {
      const storedChatId = Number(rows[i][3]); // колонка D
      if (storedChatId === Number(chatId)) {
        return true;
      }
    }
    return false;
  } catch (error) {
    console.error('❌ Помилка при перевірці доступу:', error);
    return false;
  }
}

module.exports = {
  getUsersFromSheet,
  isVerified
};
