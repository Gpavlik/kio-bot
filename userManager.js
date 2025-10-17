const fs = require('fs');
const path = require('path');

const USERS_FILE = path.join(__dirname, 'users.json');

let users = {};
let verifiedUsers = new Set();

// 📥 Завантаження з файлу
function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const data = fs.readFileSync(USERS_FILE, 'utf-8');
      users = JSON.parse(data);
      for (const chatId in users) {
        if (users[chatId]?.verified) {
          verifiedUsers.add(Number(chatId));
        }
      }
      console.log(`✅ Завантажено ${Object.keys(users).length} користувачів`);
    } else {
      console.log('ℹ️ Файл users.json не знайдено. Створюємо новий.');
      saveUsers();
    }
  } catch (err) {
    console.error('❌ Помилка завантаження users.json:', err.message);
  }
}

// 💾 Збереження у файл
function saveUsers() {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf-8');
  } catch (err) {
    console.error('❌ Помилка збереження users.json:', err.message);
  }
}

// 🔄 Оновлення користувача
function updateUser(chatId, data) {
  users[chatId] = {
    ...users[chatId],
    ...data
  };
  if (data.verified) {
    verifiedUsers.add(Number(chatId));
  }
  saveUsers();
}

// 📤 Отримати користувача
function getUser(chatId) {
  return users[chatId] || null;
}

// ✅ Перевірка верифікації
async function isVerified(chatId) {
  return verifiedUsers.has(Number(chatId));
}

// 📦 Експорт
module.exports = {
  users,
  verifiedUsers,
  loadUsers,
  saveUsers,
  updateUser,
  getUser,
  isVerified
};
