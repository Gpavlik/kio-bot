const { google } = require('googleapis');
const { GoogleAuth } = require('google-auth-library');

// Авторизація через змінну середовища
const auth = new GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const sheets = google.sheets({ version: 'v4', auth });

// ID твоєї таблиці
const spreadsheetId = '1LHbfKAtkkbBk6noyZsad7_geQ-uWCWT2xtmKKKKK0Vo';

// Читання всіх рядків з аркуша Users
async function getUsersFromSheet() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'Users!A1:Z1000'
  });
  return res.data.values;
}

// Перевірка, чи chatId є в колонці D
async function isVerified(chatId) {
  const rows = await getUsersFromSheet();
  for (let i = 1; i < rows.length; i++) {
    const storedChatId = Number(rows[i][3]);
    if (storedChatId === Number(chatId)) {
      return true;
    }
  }
  return false;
}

module.exports = {
  getUsersFromSheet,
  isVerified
};
