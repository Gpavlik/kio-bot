require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });
const user = users[chatId]; 
const adminChatId = Number(process.env.ADMIN_CHAT_ID);
const users = {
  [adminChatId]: {
    name: 'Адміністратор',
    username: 'admin',
    orders: [],
    verificationRequested: false
  }
};

const verifiedUsers = new Set([adminChatId]);
const verificationRequests = {};
const activeOrders = {};
const pendingMessages = [];
const pendingTTN = {};
let currentReplyTarget = null;
const lastSent = {};
function getMainKeyboard(chatId) {
  if (!verifiedUsers.has(chatId)) return undefined;
  return {
    reply_markup: {
      keyboard: [
        ['🛒 Зробити замовлення', 'ℹ️ Інформація'],
        ['📜 Історія замовлень', '📞 Зв’язатися з оператором'],
        ['❓ Задати запитання', '❌ Скасувати']
      ],
      resize_keyboard: true
    }
  };
}

function safeSend(chatId, text, options) {
  const now = Date.now();
  if (!lastSent[chatId] || now - lastSent[chatId] > 5000) {
    bot.sendMessage(chatId, text, options);
    lastSent[chatId] = now;
  }
}
bot.onText(/\/start/, (msg) => {

  const chatId = msg.chat.id;
  const user = users[chatId];
  const isAdmin = chatId === adminChatId;
  const { first_name, username } = msg.from;

  if (!users[chatId]) {
    users[chatId] = {
      name: first_name || 'Невідомо',
      username: username || 'невідомо',
      orders: [],
      verificationRequested: false
    };
  }

  if (users[chatId].justVerified) {
    users[chatId].justVerified = false;
    return;
  }

  if (!verifiedUsers.has(chatId)) {
    if (!users[chatId].verificationRequested) {
      users[chatId].verificationRequested = true;
      verificationRequests[chatId] = { step: 1, createdAt: Date.now() };
      bot.sendMessage(chatId, `🔐 Для доступу до бота, будь ласка, введіть Ваше ПІБ:`);
    } else {
      bot.sendMessage(chatId, `⏳ Очікуйте підтвердження доступу від оператора...`);
    }
    return;
  }

  bot.sendMessage(chatId, `Вітаємо, ${first_name}! Я бот для замовлення продукту Kiomedine. Щоб почати, оберіть опцію з клавіатури нижче:`, getMainKeyboard(chatId));
});
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const isAdmin = chatId === adminChatId;
  const user = users[chatId];

  if (!text) return;

  // 🔐 Верифікація
  if (!verifiedUsers.has(chatId) && !isAdmin) {
    const request = verificationRequests[chatId];
    if (!request) return;

    if (Date.now() - request.createdAt > 24 * 60 * 60 * 1000) {
      delete verificationRequests[chatId];
      user.verificationRequested = false;
      bot.sendMessage(chatId, `⛔️ Ваш запит анульовано через неактивність. Надішліть /start, щоб почати знову.`);
      return;
    }

    switch (request.step) {
      case 1:
        request.name = text;
        request.step = 2;
        bot.sendMessage(chatId, `📞 Введіть Ваш номер телефону:`);
        return;
      case 2:
        if (!/^(\+380|0)\d{9}$/.test(text)) {
          bot.sendMessage(chatId, `❗ Введіть коректний номер телефону.`);
          return;
        }
        request.phone = text;
        request.step = 3;
        bot.sendMessage(chatId, `🏙️ Введіть місто:`);
        return;
      case 3:
        request.town = text;
        request.step = 4;
        bot.sendMessage(chatId, `🏢 Введіть місце роботи:`);
        return;
      case 4:
        request.workplace = text;
        request.step = 5;
        bot.sendMessage(chatId, `👤 Введіть ПІБ співробітника, який проводить верифікацію:`);
        return;
      case 5:
        request.verifierName = text;
        request.step = 6;
        bot.sendMessage(chatId, `⏳ Дані надіслані оператору. Очікуйте підтвердження.`);

        bot.sendMessage(adminChatId, `🔐 Запит на верифікацію:\n👤 ${request.name}\n📞 ${request.phone}\n🏙️ ${request.town}\n🏢 ${request.workplace}\n👤 Співробітник: ${request.verifierName}\n🆔 chatId: ${chatId}`, {
          reply_markup: {
            inline_keyboard: [[{ text: '✅ Надати доступ', callback_data: `verify_${chatId}` }]]
          }
        });
        return;
    }
    return;
  }

  // ✍️ Відповідь оператором після натискання кнопки
  if (isAdmin && currentReplyTarget) {
    bot.sendMessage(currentReplyTarget, `📬 Відповідь від оператора:\n\n${text}`);
    bot.sendMessage(chatId, `✅ Відповідь надіслано.`);

    const index = pendingMessages.findIndex(m => m.chatId === currentReplyTarget);
    if (index !== -1) pendingMessages.splice(index, 1);

    currentReplyTarget = null;
    return;
  }

  // ❓ Запитання користувача
  if (activeOrders[chatId]?.questionMode) {
    pendingMessages.push({ chatId, username: user.username, text });
    delete activeOrders[chatId];
    bot.sendMessage(chatId, `✅ Ваше запитання надіслано оператору.`);
    bot.sendMessage(adminChatId, `❓ Запитання від @${user.username}:\n${text}`, {
      reply_markup: {
        inline_keyboard: [[{ text: '✍️ Відповісти', callback_data: `reply_${chatId}` }]]
      }
    });
    return;
  }

  // 🛒 Старт замовлення
  if (text === '🛒 Зробити замовлення') {
    activeOrders[chatId] = {};
    bot.sendMessage(chatId, `📦 Скільки одиниць товару бажаєте замовити?`);
    return;
  }

  // 🧾 Етапи замовлення
  const order = activeOrders[chatId];
  if (order) {
    if (!order.quantity) {
      if (!/^\d+$/.test(text)) {
        bot.sendMessage(chatId, `❗ Введіть кількість у вигляді числа (наприклад: 1, 2, 3...)`);
        return;
      }
      order.quantity = text;
      bot.sendMessage(chatId, `🏙 Вкажіть місто доставки:`);
      return;
    }

    if (!order.city) {
      order.city = text;
      bot.sendMessage(chatId, `👤 Вкажіть ПІБ отримувача:`);
      return;
    }

    if (!order.address) {
      order.address = text;
      bot.sendMessage(chatId, `📮 Вкажіть номер відділення Нової Пошти:`);
      return;
    }

    if (!order.np) {
      order.np = text;
      bot.sendMessage(chatId, `📞 Вкажіть ваш номер телефону для зв’язку:`);
      order.phone = '__awaiting__';
      return;
    }

    if (order.phone === '__awaiting__') {
      if (!/^(\+380|0)\d{9}$/.test(text)) {
        bot.sendMessage(chatId, `❗ Будь ласка, введіть коректний номер телефону.`);
        return;
      }

      order.phone = text;
      order.timestamp = Date.now();
      order.status = 'очікує';

      if (!users[chatId]) {
        users[chatId] = {
          name: msg.from.first_name || 'Невідомо',
          username: msg.from.username || 'невідомо',
          orders: [],
          verificationRequested: false
        };
      }

      users[chatId].orders.push(order);

      bot.sendMessage(chatId, `✅ Замовлення прийнято!\n\n📦 Кількість: ${order.quantity}\n🏙 Місто: ${order.city}\n👤 ПІБ: ${order.address}\n📮 НП: ${order.np}\n📞 Телефон: ${order.phone}`);

      axios.post('https://script.google.com/macros/s/AKfycbzPr6BOEEd7125kVOOYFkTWw8qg3zoDKla50LSxEszMVvpMM60sVFaQn6k6VdH8Gec0/exec', {
        action: 'add',
        timestamp: order.timestamp,
        chatId: chatId,
        name: users[chatId].name,
        username: users[chatId].username,
        quantity: order.quantity,
        city: order.city,
        address: order.address,
        np: order.np,
        phone: order.phone,
        status: order.status
      }).then(() => {
        console.log(`✅ Замовлення записано для ${order.address}`);
      }).catch((err) => {
        console.error(`❌ Помилка запису замовлення: ${err.message}`);
        bot.sendMessage(adminChatId, `⚠️ Не вдалося записати замовлення від @${users[chatId].username}: ${err.message}`);
      });

      bot.sendMessage(adminChatId, `📬 НОВЕ ЗАМОВЛЕННЯ від @${users[chatId].username}\n\n📦 ${order.quantity} шт\n🏙 ${order.city}\n👤 ${order.address}\n📮 НП: ${order.np}\n📞 Телефон: ${order.phone}`, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Прийняти', callback_data: `accept_${chatId}_${order.timestamp}` },
              { text: '❌ Скасувати', callback_data: `cancel_${chatId}_${order.timestamp}` }
            ],
            [
              { text: '📦 Надіслати ТТН', callback_data: `ttn_${chatId}_${order.timestamp}` }
            ]
          ]
        }
      });

      delete activeOrders[chatId];
      return;
    }
  }
});

bot.on('message', (msg) => {
  const chatId = msg.chat.id;
   const user = users[chatId]; 
  const isAdmin = chatId === adminChatId;
  const text = msg.text;
// ℹ️ Інформація
if (text === 'ℹ️ Інформація') {
  bot.sendMessage(chatId, `KioMedinevsOne — медичний виріб для віскосуплементації синовіальної рідини при симптоматичному лікуванні остеоартриту колінного суглоба.`, {
    reply_markup: {
      keyboard: [
        ['🛠 Дія', '📦 Склад'],
        ['⚙️ Ефект', '⚠️ Увага'],
        ['💡 Клінічні випадки'],
        ['📝 Застосування', '🔙 Назад']
      ],
      resize_keyboard: true
    }
  });
  return;
}

// 🔙 Назад
if (text === '🔙 Назад') {
  bot.sendMessage(chatId, `🔙 Повертаємось до головного меню.`, getMainKeyboard(chatId));
  return;
}

// 🛠 Дія
if (text === '🛠 Дія') {
  bot.sendMessage(chatId, `Остеоартрит — дегенеративне захворювання... [текст повний, як у твоєму коді]`);
  return;
}

// 📦 Склад
if (text === '📦 Склад') {
  bot.sendMessage(chatId, `Кожна упаковка KioMedinevsOne містить... [текст повний]`);
  return;
}

// ⚙️ Ефект
if (text === '⚙️ Ефект') {
  bot.sendMessage(chatId, `Один курс лікування передбачає... [текст повний]`);
  return;
}

// ⚠️ Увага
if (text === '⚠️ Увага') {
  bot.sendMessage(chatId, `• Протипоказання та застереження... [текст повний]`);
  return;
}

// 📝 Застосування
if (text === '📝 Застосування') {
  bot.sendMessage(chatId, `Перед кожною ін'єкцією KioMedinevsOne... [текст повний]`);
  return;
}

// 💡 Клінічні випадки
if (text === '💡 Клінічні випадки') {
  bot.sendDocument(chatId, './KioMedine Patient Cases_v2.0.0.pdf', {
    caption: '📄 Клінічні випадки застосування препарату',
    contentType: 'application/pdf'
  });
  return;
}

// 📜 Історія замовлень
if (text === '📜 Історія замовлень') {
  if (!user.orders.length) {
    bot.sendMessage(chatId, `📭 У Вас поки немає замовлень.`);
    return;
  }

  let historyText = `🕘 Історія Ваших замовлень:\n\n`;
  user.orders.forEach((order, index) => {
    historyText += `#${index + 1}\n📦 ${order.quantity} шт\n🏙 ${order.city}\n🏠 ${order.address}\n📮 НП: ${order.np}\n📞 ${order.phone}\n📌 Статус: ${order.status || 'очікує'}\n\n`;
  });

  bot.sendMessage(chatId, historyText);
  return;
}

// ❌ Скасувати
if (text === '❌ Скасувати') {
  if (activeOrders[chatId]) {
    delete activeOrders[chatId];
    bot.sendMessage(chatId, `⛔️ Замовлення скасовано до завершення.`);
    return;
  }

  const lastOrder = user.orders[user.orders.length - 1];
  if (!lastOrder) {
    bot.sendMessage(chatId, `ℹ️ Немає активного або завершеного замовлення для скасування.`);
    return;
  }

  if (lastOrder.status === 'прийнято') {
    bot.sendMessage(chatId, `⛔️ Прийняте замовлення не можна скасувати.`);
    return;
  }

  lastOrder.status = 'скасовано';
  bot.sendMessage(chatId, `❌ Останнє замовлення позначено як скасоване.`);

  axios.post('https://script.google.com/macros/s/AKfycbzPr6BOEEd7125kVOOYFkTWw8qg3zoDKla50LSxEszMVvpMM60sVFaQn6k6VdH8Gec0/exec', {
    action: 'updateStatus',
    timestamp: lastOrder.timestamp,
    chatId: chatId,
    status: 'скасовано'
  }).then(() => {
    console.log('✅ Статус оновлено в таблиці');
    bot.sendMessage(adminChatId, `❌ Замовлення від @${user.username} було скасовано.`);
  }).catch((err) => {
    console.error('❌ Помилка оновлення статусу:', err.message);
    bot.sendMessage(adminChatId, `⚠️ Не вдалося оновити статус: ${err.message}`);
  });
  return;
}

// ❓ Задати запитання
if (text === '❓ Задати запитання') {
  bot.sendMessage(chatId, `✍️ Напишіть своє запитання, і оператор відповість найближчим часом.`);
  activeOrders[chatId] = { questionMode: true };
  return;
}

// 📞 Зв’язатися з оператором
if (text === '📞 Зв’язатися з оператором') {
  bot.sendContact(chatId, '+380932168041', 'Оператор');
  return;
}

if (isAdmin && pendingTTN[chatId]) {
  const { targetId, timestamp } = pendingTTN[chatId];
  const user = users[targetId];
  const order = user?.orders?.find(o => o.timestamp == Number(timestamp));
  if (!order) {
    bot.sendMessage(chatId, `⛔️ Замовлення не знайдено.`);
    delete pendingTTN[chatId];
    return;
  }

  order.ttn = text;
  bot.sendMessage(targetId, `📦 Ваше замовлення відправлено!\nНомер ТТН: ${text}`);
  bot.sendMessage(chatId, `✅ ТТН надіслано користувачу.`);

  axios.post('https://script.google.com/macros/s/AKfycbzPr6BOEEd7125kVOOYFkTWw8qg3zoDKla50LSxEszMVvpMM60sVFaQn6k6VdH8Gec0/exec', {
    action: 'updateTTN',
    timestamp: order.timestamp,
    chatId: targetId,
    ttn: text
  }).catch((err) => {
    console.error('❌ Помилка оновлення ТТН:', err.message);
    bot.sendMessage(adminChatId, `⚠️ Не вдалося оновити ТТН: ${err.message}`);
  });

  delete pendingTTN[chatId];
  return;
}

});
bot.on('callback_query', (query) => {
  const data = query.data;
  const adminId = query.message.chat.id;
  const isAdmin = chatId === adminChatId;
   const user = users[chatId]; 

  // 🔐 Верифікація
  if (data.startsWith('verify_')) {
    const targetId = parseInt(data.split('_')[1], 10);
    const request = verificationRequests[targetId];
    if (!request || !users[targetId]) {
      bot.answerCallbackQuery(query.id, { text: '⛔️ Запит не знайдено.' });
      return;
    }

    verifiedUsers.add(targetId);
    users[targetId].verificationRequested = false;
    users[targetId].justVerified = true;

    axios.post('https://script.google.com/macros/s/AKfycbzPr6BOEEd7125kVOOYFkTWw8qg3zoDKla50LSxEszMVvpMM60sVFaQn6k6VdH8Gec0/exec', {
      action: 'addUser',
      timestamp: Date.now(),
      chatId: targetId,
      name: request.name,
      username: users[targetId].username,
      phone: request.phone,
      town: request.town,
      workplace: request.workplace,
      verifierName: request.verifierName
    });

    delete verificationRequests[targetId];

    bot.sendMessage(targetId, `🔓 Вам надано доступ до бота.`, getMainKeyboard(targetId));
    bot.sendMessage(adminChatId, `✅ Доступ надано користувачу @${users[targetId].username} (${targetId})`);
    bot.answerCallbackQuery(query.id, { text: 'Доступ надано ✅' });
    return;
  }

  // ✅ Прийняти замовлення
  if (data.startsWith('accept_')) {
    const [_, targetId, timestamp] = data.split('_');
    const user = users[targetId];
    const order = user?.orders?.find(o => o.timestamp == Number(timestamp));
    if (!order || order.status === 'скасовано') {
      bot.answerCallbackQuery(query.id, { text: '⛔️ Замовлення не знайдено або скасовано.' });
      return;
    }
    if (order.status === 'прийнято') {
      bot.answerCallbackQuery(query.id, { text: 'ℹ️ Замовлення вже прийнято.' });
      return;
    }

    axios.post('https://script.google.com/macros/s/AKfycbzPr6BOEEd7125kVOOYFkTWw8qg3zoDKla50LSxEszMVvpMM60sVFaQn6k6VdH8Gec0/exec', {
      action: 'updateStatus',
      timestamp: order.timestamp,
      chatId: targetId,
      status: 'прийнято'
    }).then(() => {
      order.status = 'прийнято';
      bot.sendMessage(targetId, `🚚 Ваше замовлення прийнято і вже в дорозі!`);
      bot.sendMessage(adminChatId, `✅ Замовлення від @${user.username} позначено як "прийнято".`);
      bot.answerCallbackQuery(query.id, { text: '✅ Прийнято' });
    }).catch((err) => {
      console.error('❌ Помилка оновлення статусу:', err.message);
      bot.answerCallbackQuery(query.id, { text: '⚠️ Помилка оновлення' });
    });
    return;
  }

  // ❌ Скасувати замовлення
  if (data.startsWith('cancel_')) {
    const [_, targetId, timestamp] = data.split('_');
    const user = users[targetId];
    const order = user?.orders?.find(o => o.timestamp == Number(timestamp));
    if (!order || order.status === 'прийнято') {
      bot.answerCallbackQuery(query.id, { text: '⛔️ Не можна скасувати прийняте замовлення.' });
      return;
    }

    axios.post('https://script.google.com/macros/s/AKfycbzPr6BOEEd7125kVOOYFkTWw8qg3zoDKla50LSxEszMVvpMM60sVFaQn6k6VdH8Gec0/exec', {
      action: 'updateStatus',
      timestamp: order.timestamp,
      chatId: targetId,
      status: 'скасовано'
    }).then(() => {
      order.status = 'скасовано';
      bot.sendMessage(targetId, `❌ Ваше замовлення було скасовано оператором.`);
      bot.sendMessage(adminChatId, `❌ Замовлення від @${user.username} було скасовано.`);
      bot.answerCallbackQuery(query.id, { text: '❌ Скасовано' });
    }).catch((err) => {
      console.error('❌ Помилка оновлення статусу:', err.message);
      bot.answerCallbackQuery(query.id, { text: '⚠️ Помилка оновлення' });
    });
    return;
  }

  // 📦 Введення ТТН
  if (data.startsWith('ttn_')) {
    const [_, targetId, timestamp] = data.split('_');
    pendingTTN[adminId] = { targetId, timestamp };
    bot.sendMessage(adminId, `✍️ Введіть номер ТТН для користувача ${targetId}:`);
    bot.answerCallbackQuery(query.id);
    return;
  }



  // ✍️ Відповідь оператором
  if (data.startsWith('reply_')) {
    currentReplyTarget = parseInt(data.split('_')[1], 10);
    bot.sendMessage(adminId, `✍️ Напишіть відповідь для користувача ${currentReplyTarget}`);
    bot.answerCallbackQuery(query.id);
    return;
  }
});
// 🧾 Панель оператора
bot.onText(/\/adminpanel/, (msg) => {
  const chatId = msg.chat.id;
  const isAdmin = chatId === adminChatId;
   const user = users[chatId]; 
  if (!isAdmin ) {
    bot.sendMessage(chatId, '⛔️ У вас немає доступу до панелі оператора.');
    return;
  }

  const adminKeyboard = {
    reply_markup: {
      keyboard: [
        ['📋 Переглянути всі замовлення'],
        ['📩 Відповісти користувачу', '🚚 Підтвердити доставку'],
        ['📊 Статистика', '🔙 Назад до користувацького меню']
      ],
      resize_keyboard: true
    }
  };

  bot.sendMessage(chatId, `👨‍💼 Панель оператора активна. Оберіть дію:`, adminKeyboard);
});

// ✍️ Відповідь оператором через /reply
bot.onText(/\/reply (\d+) (.+)/, (msg, match) => {
  if (msg.chat.id !== adminChatId) return;
  const targetId = parseInt(match[1], 10);
  const isAdmin = chatId === adminChatId;
   const user = users[chatId]; 
  const replyText = match[2];
  bot.sendMessage(targetId, `📩 Повідомлення від оператора:\n${replyText}`);
  bot.sendMessage(adminChatId, `✅ Відповідь надіслано.`);
});

// 🚚 Підтвердження доставки через /send
bot.onText(/\/send (\d+)/, (msg, match) => {
  if (msg.chat.id !== adminChatId) return;
  const targetId = parseInt(match[1], 10);
  const isAdmin = chatId === adminChatId;
  const user = users[targetId];
  if (!user || !user.orders || user.orders.length === 0) {
    bot.sendMessage(adminChatId, `⛔️ Замовлення не знайдено.`);
    return;
  }

  const order = user.orders[user.orders.length - 1];
  if (order.status === 'скасовано') {
    bot.sendMessage(adminChatId, `⛔️ Це замовлення вже скасовано.`);
    return;
  }

  if (order.status !== 'прийнято') {
    axios.post('https://script.google.com/macros/s/AKfycbzPr6BOEEd7125kVOOYFkTWw8qg3zoDKla50LSxEszMVvpMM60sVFaQn6k6VdH8Gec0/exec', {
      action: 'updateStatus',
      timestamp: order.timestamp,
      chatId: targetId,
      status: 'прийнято'
    }).then(() => {
      console.log('✅ Статус "прийнято" оновлено в таблиці');
      order.status = 'прийнято';
    }).catch((err) => {
      console.error('❌ Помилка оновлення статусу:', err.message);
    });
  }

  bot.sendMessage(targetId, `🚚 Ваше замовлення вже в дорозі! Дякуємо за довіру ❤️`);
  bot.sendMessage(adminChatId, `✅ Доставку підтверджено.`);
});

// ✅ Верифікація вручну
bot.onText(/\/verify (\d+)/, (msg, match) => {
  if (msg.chat.id !== adminChatId) return;
  const targetId = parseInt(match[1], 10);
  const isAdmin = chatId === adminChatId;
   const user = users[chatId]; 
  verifiedUsers.add(targetId);
  if (users[targetId]) users[targetId].verificationRequested = false;
  users[targetId].justVerified = true;
  bot.sendMessage(adminChatId, `✅ Користувач ${targetId} верифікований.`);
  bot.sendMessage(targetId, `🔓 Вам надано доступ до бота. Можете почати користування.`, getMainKeyboard(targetId));
});

// 🚫 Відкликання доступу
bot.onText(/\/unverify (\d+)/, (msg, match) => {
  if (msg.chat.id !== adminChatId) return;
  const targetId = parseInt(match[1], 10);
  const isAdmin = chatId === adminChatId;
   const user = users[chatId]; 
  verifiedUsers.delete(targetId);
  bot.sendMessage(adminChatId, `🚫 Користувач ${targetId} більше не має доступу.`);
  bot.sendMessage(targetId, `🔒 Ваш доступ до бота було відкликано оператором.`);
});

// 📊 Статистика
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
   const user = users[chatId]; 
  const text = msg.text;
  const isAdmin = chatId === adminChatId;

  if (!isAdmin) return;

  if (text === '📋 Переглянути всі замовлення') {
    let report = '📋 Усі замовлення:\n\n';
    let found = false;

    for (const uid in users) {
      const user = users[uid];
      if (!user.orders || user.orders.length === 0) continue;

      found = true;
      report += `👤 @${user.username} (${user.name})\n`;
      user.orders.forEach((order, i) => {
        report += `  #${i + 1} 📦 ${order.quantity} шт\n  🏙 ${order.city}\n  🏠 ${order.address}\n  📮 НП: ${order.np}\n  📞 ${order.phone}\n  📌 Статус: ${order.status || 'очікує'}\n\n`;
      });
    }

    bot.sendMessage(chatId, found ? report : '📭 Немає замовлень.');
    return;
  }

  if (text === '📩 Відповісти користувачу') {
    bot.sendMessage(chatId, `✏️ Введіть команду у форматі:\n/reply [chatId] [текст повідомлення]`);
    return;
  }

  if (text === '🚚 Підтвердити доставку') {
    bot.sendMessage(chatId, `📦 Введіть команду у форматі:\n/send [chatId]`);
    return;
  }

  if (text === '📊 Статистика') {
    let totalOrders = 0;
    let totalUsers = Object.keys(users).length;
    let totalQuantity = 0;

    for (const uid in users) {
      const user = users[uid];
      user.orders.forEach(order => {
        totalOrders++;
        const qty = parseInt(order.quantity);
        if (!isNaN(qty)) totalQuantity += qty;
      });
    }

    const stats = `📊 Статистика:\n\n👥 Користувачів: ${totalUsers}\n📦 Замовлень: ${totalOrders}\n📈 Сумарна кількість товару: ${totalQuantity} шт`;
    bot.sendMessage(chatId, stats);
    return;
  }

  if (text === '🔙 Назад до користувацького меню') {
    bot.sendMessage(chatId, `🔄 Повертаємося до стандартного меню...`, getMainKeyboard(chatId));
    return;
  }
});

// 🧯 Polling error
bot.on("polling_error", (error) => {
  console.error("❌ Polling error:", error.message);
});

// 🚀 Запуск
console.log('🤖 Бот запущено...');
bot.sendMessage(adminChatId, '🤖 Бот запущено і готовий до роботи.');
