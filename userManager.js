const fs = require('fs');
const path = require('path');

const USERS_FILE = path.join(__dirname, 'users.json');

let users = {};
let verifiedUsers = new Set();

// === Зчитування при запуску ===
function loadUsers() {
  try {
    const raw = fs.readFileSync(USERS_FILE);
    users = JSON.parse(raw);
    verifiedUsers = new Set(
      Object.entries(users)
        .filter(([_, u]) => u.verified)
        .map(([id]) => id)
    );
    console.log(`✅ Завантажено ${verifiedUsers.size} верифікованих користувачів`);
  } catch (err) {
    console.error('❌ Не вдалося зчитати users.json:', err.message);
    users = {};
    verifiedUsers = new Set();
  }
}

// === Збереження у файл ===
function saveUsers() {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    console.log('💾 users.json оновлено');
  } catch (err) {
    console.error('❌ Не вдалося записати users.json:', err.message);
  }
}

// === Додати або оновити користувача ===
function updateUser(chatId, data) {
  users[chatId] = {
    ...users[chatId],
    ...data
  };
  if (data.verified) verifiedUsers.add(chatId);
  saveUsers();
}

// === Перевірити доступ ===
function isVerified(chatId) {
  return verifiedUsers.has(chatId);
}

// === Отримати користувача ===
function getUser(chatId) {
  return users[chatId];
}

module.exports = {
  loadUsers,
  saveUsers,
  updateUser,
  isVerified,
  getUser,
  users,
  verifiedUsers
};
// Завантажити користувачів при ініціалізації модуля
loadUsers();    