const { google } = require('googleapis');
const { GoogleAuth } = require('google-auth-library');

const auth = new GoogleAuth({
  keyFile: 'credentials.json', // шлях до service account JSON
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const sheets = google.sheets({ version: 'v4', auth });

const spreadsheetId = '1LHbfKAtkkbBk6noyZsad7_geQ-uWCWT2xtmKKKKK0Vo'; // заміни на свій ID

async function getUsersFromSheet() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'Users!A1:Z1000' // або інший діапазон
  });
  return res.data.values;
}

async function isVerified(chatId) {
  const rows = await getUsersFromSheet();
  for (let i = 1; i < rows.length; i++) {
    const storedChatId = Number(rows[i][3]); // колонка D
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
