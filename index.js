require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { getUsersFromSheet, isVerified: isVerifiedFromSheet } = require('./googleSheets');

const token = process.env.BOT_TOKEN;

const adminChatIds = (process.env.ADMIN_CHAT_IDS || '')
  .split(',')
  .map(id => Number(id.trim()))
  .filter(id => !isNaN(id));

function isAdmin(chatId) {
  return adminChatIds.includes(Number(chatId));
}

const bot = new TelegramBot(token, { polling: true });

const {
  loadUsers,
  updateUser,
  isVerified,
  getUser,
  users,
  verifiedUsers
} = require('./userManager');

loadUsers();

const verificationRequests = {};
const activeOrders = {};
const pendingMessages = [];
const pendingTTN = {};
let currentReplyTarget = null;
const lastSent = {};

function getMainKeyboard(chatId) {
  if (!verifiedUsers.has(chatId) && !isAdmin(chatId)) return undefined;
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

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const { first_name, username } = msg.from || {};
  const displayName = first_name || 'користувачу';

  console.log(`➡️ /start від ${chatId} (@${username})`);

  try {
    const verified = await isVerified(chatId);
    const isAdminUser = isAdmin(chatId);

    console.log(`🔍 Статус: isAdmin=${isAdminUser}, isVerified=${verified}`);

    if (!verified && !isAdminUser) {
      if (!verificationRequests[chatId]) {
        verificationRequests[chatId] = {
          step: 1,
          createdAt: Date.now(),
          username: username || 'невідомо'
        };
      }

      bot.sendMessage(chatId, `🔐 Для доступу до бота, будь ласка, введіть Ваше ПІБ:`);
      return;
    }

    // Ініціалізація користувача
    if (!users[chatId]) {
      users[chatId] = {
        name: displayName,
        username: username || 'невідомо',
        orders: [],
        verificationRequested: false,
        verified: true
      };
      updateUser(chatId, users[chatId]);
    }

    verifiedUsers.add(chatId);

    const keyboard = getMainKeyboard(chatId);
    bot.sendMessage(
      chatId,
      `👋 Вітаю, ${users[chatId].name}! Оберіть опцію з меню нижче:`,
      keyboard || {}
    );
  } catch (error) {
    console.error('❌ Помилка при перевірці доступу:', error.message);
    bot.sendMessage(chatId, `⚠️ Виникла помилка при перевірці доступу. Спробуйте пізніше.`);
  }
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  const { first_name, username } = msg.from || {};
  const user = getUser(chatId) || {};
  const userIsAdmin = isAdmin(chatId);
  const isUserVerified = await isVerified(chatId);

  console.log(`📩 Повідомлення від ${chatId} (@${username}) | isAdmin=${userIsAdmin} | isVerified=${isUserVerified} | text="${text}"`);

  if (text === '/start') {
    if (isUserVerified) {
      bot.sendMessage(chatId, `👋 Ви вже верифіковані.`, getMainKeyboard(chatId));
    } else {
      verificationRequests[chatId] = {
        step: 1,
        createdAt: Date.now(),
        username: username || 'невідомо',
        name: first_name || 'Невідомо'
      };
      bot.sendMessage(chatId, `🔐 Для доступу до бота, будь ласка, введіть Ваше ПІБ:`);
    }
    return;
  }

  if (!isUserVerified && verificationRequests[chatId]) {
    const request = verificationRequests[chatId];

    if (Date.now() - request.createdAt > 24 * 60 * 60 * 1000) {
      delete verificationRequests[chatId];
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

        adminChatIds.forEach(id => {
          if (!id || isNaN(id)) return;
          try {
            bot.sendMessage(id, `🔐 Запит на верифікацію:\n👤 ${request.name}\n📞 ${request.phone}\n🏙️ ${request.town}\n🏢 ${request.workplace}\n👤 Співробітник: ${request.verifierName}\n🆔 chatId: ${chatId}`, {
              reply_markup: {
                inline_keyboard: [[{ text: '✅ Надати доступ', callback_data: `verify_${chatId}` }]]
              }
            });
          } catch (err) {
            console.error(`❌ Не вдалося надіслати запит адміну ${id}:`, err.message);
          }
        });
        return;
    }
    return;
  }

  if (!isUserVerified && !userIsAdmin) {
    bot.sendMessage(chatId, `🔒 Ви ще не верифіковані. Натисніть /start або зверніться до оператора.`);
    return;
  }

  if (activeOrders[chatId]?.questionMode) {
    pendingMessages.push({ chatId, username: user?.username || 'невідомо', text });
    delete activeOrders[chatId];
    bot.sendMessage(chatId, `✅ Ваше запитання надіслано оператору.`);

    adminChatIds.forEach(id => {
      if (!id || isNaN(id)) return;
      bot.sendMessage(id, `❓ Запитання від @${user?.username || 'невідомо'}:\n${text}`, {
        reply_markup: {
          inline_keyboard: [[{ text: '✍️ Відповісти', callback_data: `reply_${chatId}` }]]
        }
      });
    });
    return;
  }

  if (userIsAdmin && currentReplyTarget) {
    bot.sendMessage(currentReplyTarget, `📬 Відповідь від оператора:\n\n${text}`);
    bot.sendMessage(chatId, `✅ Відповідь надіслано.`);
    const index = pendingMessages.findIndex(m => m.chatId === currentReplyTarget);
    if (index !== -1) pendingMessages.splice(index, 1);
    currentReplyTarget = null;
    return;
  }

  if (text === '🛒 Зробити замовлення') {
    activeOrders[chatId] = {};
    bot.sendMessage(chatId, `📦 Скільки одиниць товару бажаєте замовити?`);
    return;
  }

  const keyboard = getMainKeyboard(chatId);
  });


bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  const user = users[chatId];
  const order = activeOrders[chatId];
  const userIsAdmin = isAdmin(chatId);

  // 🧾 Обробка замовлення
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

      // 🧠 Ініціалізація користувача, якщо ще не існує
      if (!users[chatId]) {
        users[chatId] = {
          name: msg.from?.first_name || 'Невідомо',
          username: msg.from?.username || 'невідомо',
          orders: [],
          verified: false
        };
      }

      users[chatId].orders = users[chatId].orders || [];
      users[chatId].orders.push(order);

      bot.sendMessage(chatId, `✅ Замовлення прийнято!\n\n📦 Кількість: ${order.quantity}\n🏙 Місто: ${order.city}\n👤 ПІБ: ${order.address}\n📮 НП: ${order.np}\n📞 Телефон: ${order.phone}`);

      // 📤 Надсилання в Google Таблицю
      try {
        await axios.post('https://script.google.com/macros/s/AKfycbxPotyVDDFaKvMNmjTZEnTqPqX0ijbkZKWD_rxcNCu5rU4nELrm5Aska7TOrSALrvfI/exec', {
          action: 'add',
          timestamp: order.timestamp,
          chatId,
          name: users[chatId].name,
          username: users[chatId].username,
          quantity: order.quantity,
          city: order.city,
          address: order.address,
          np: order.np,
          phone: order.phone,
          status: order.status
        });
        console.log(`✅ Замовлення записано для ${order.address}`);
      } catch (err) {
        console.error(`❌ Помилка запису замовлення: ${err.message}`);
        adminChatIds.forEach(id => {
          if (!id || isNaN(id)) return;
          bot.sendMessage(id, `⚠️ Не вдалося записати замовлення від @${users[chatId].username}: ${err.message}`);
        });
      }

      // 📢 Повідомлення адміністраторам
      adminChatIds.forEach(id => {
        if (!id || isNaN(id)) return;
        bot.sendMessage(id, `📬 НОВЕ ЗАМОВЛЕННЯ від @${users[chatId].username}\n\n📦 ${order.quantity} шт\n🏙 ${order.city}\n👤 ${order.address}\n📮 НП: ${order.np}\n📞 Телефон: ${order.phone}`, {
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
      });

      delete activeOrders[chatId];
      return;
    }
  }

  // 📦 Обробка ТТН від адміністратора
  if (userIsAdmin && pendingTTN[chatId]) {
    const { targetId, timestamp } = pendingTTN[chatId];
    const targetUser = users[targetId];
    const order = targetUser?.orders?.find(o => o.timestamp == Number(timestamp));

    if (!order) {
      bot.sendMessage(chatId, `❌ Замовлення не знайдено для ТТН.`);
      delete pendingTTN[chatId];
      return;
    }

    order.ttn = text;

    try {
      await axios.post('https://script.google.com/macros/s/AKfycbxPotyVDDFaKvMNmjTZEnTqPqX0ijbkZKWD_rxcNCu5rU4nELrm5Aska7TOrSALrvfI/exec', {
        action: 'updateTTN',
        timestamp: order.timestamp,
        chatId: targetId,
        ttn: text
      });

      bot.sendMessage(targetId, `📦 Ваш номер ТТН: ${text}`);
      bot.sendMessage(chatId, `✅ ТТН записано.`);
    } catch (err) {
      console.error('❌ Помилка запису ТТН:', err.message);
      bot.sendMessage(chatId, `⚠️ Не вдалося записати ТТН: ${err.message}`);
    }

    delete pendingTTN[chatId];
    return;
  }


  bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  const user = users[chatId];

  // ℹ️ Інформація
  if (text === 'ℹ️ Інформація') {
    bot.sendMessage(chatId, `KioMedinevsOne — медичний виріб для віскосуплементації синовіальної рідини при симптоматичному лікуванні остеоартриту колінного суглоба.`, {
      reply_markup: {
        keyboard: [
          ['🛠 Дія', '📦 Склад'],
          ['⚙️ Ефект', '⚠️ Увага'],
          ['💡 Клінічні випадки'],
          ['$ Ціна'],
          ['📝 Застосування', '🔙 Назад']
        ],
        resize_keyboard: true
      }
    });
    return;
  }

  // 🛠 Дія
  if (text === '🛠 Дія') {
    bot.sendMessage(chatId, `Остеоартрит — дегенеративне захворювання... (скорочено для прикладу)`);
    return;
  }

  // 📦 Склад
  if (text === '📦 Склад') {
    bot.sendMessage(chatId, `Кожна упаковка KioMedinevsOne містить...`);
    return;
  }

  // ⚙️ Ефект
  if (text === '⚙️ Ефект') {
    bot.sendMessage(chatId, `Один курс лікування передбачає одну внутрішньосуглобову ін'єкцію...`);
    return;
  }

  // ⚠️ Увага
  if (text === '⚠️ Увага') {
    bot.sendMessage(chatId, `• Протипоказання та застереження щодо застосування KioMedinevsOne...`);
    return;
  }

  // 📝 Застосування
  if (text === '📝 Застосування') {
    bot.sendMessage(chatId, `Перед кожною ін'єкцією KioMedinevsOne слід видалити синовіальну рідину...`);
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

  // $ Ціна
  if (text === '$ Ціна') {
    bot.sendMessage(chatId, `💰 Ціна за 1 упаковку (3 мл): 8500 грн.`);
    return;
  }

  // 🔙 Назад
  if (text === '🔙 Назад') {
    bot.sendMessage(chatId, `🔙 Повертаємось до головного меню.`, getMainKeyboard(chatId));
    return;
  }

  // 📜 Історія замовлень
  if (text === '📜 Історія замовлень') {
    if (!user?.orders?.length) {
      bot.sendMessage(chatId, `📭 У Вас поки немає замовлень.`);
      return;
    }

    const historyText = user.orders.map((order, i) => 
      `#${i + 1}\n📦 ${order.quantity} шт\n🏙 ${order.city}\n👤 ${order.address}\n📮 НП: ${order.np}\n📞 ${order.phone}\n📌 Статус: ${order.status || 'очікує'}\n`
    ).join('\n');

    bot.sendMessage(chatId, `🕘 Історія Ваших замовлень:\n\n${historyText}`);
    return;
  }

  // ❌ Скасувати
  if (text === '❌ Скасувати') {
    if (activeOrders[chatId]) {
      delete activeOrders[chatId];
      bot.sendMessage(chatId, `⛔️ Замовлення скасовано до завершення.`);
      return;
    }

    const lastOrder = user?.orders?.[user.orders.length - 1];
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
});

bot.on('callback_query', async (query) => {
  const adminId = query.message.chat.id;
  const data = query.data;

  if (!isAdmin(adminId)) {
    bot.answerCallbackQuery(query.id, { text: '⛔️ Доступ лише для адміністраторів.' });
    return;
  }

  // ✅ Верифікація
  if (data.startsWith('verify_')) {
    const targetId = parseInt(data.split('_')[1], 10);
    const request = verificationRequests[targetId];

    if (!request) {
      bot.answerCallbackQuery(query.id, { text: '⛔️ Запит не знайдено.' });
      return;
    }

    updateUser(targetId, {
      name: request.name || 'Невідомо',
      username: request.username || 'невідомо',
      verified: true,
      orders: []
    });

    bot.sendMessage(targetId, `🔓 Вам надано доступ до бота.`, getMainKeyboard(targetId));
    adminChatIds.forEach(id => {
      if (!id || isNaN(id)) return;
      bot.sendMessage(id, `✅ Доступ надано користувачу @${request.username} (${targetId})`);
    });

    try {
      await axios.post('https://script.google.com/macros/s/AKfycbxPotyVDDFaKvMNmjTZEnTqPqX0ijbkZKWD_rxcNCu5rU4nELrm5Aska7TOrSALrvfI/exec', {
        action: 'add',
        chatId: targetId,
        name: request.name,
        username: request.username,
        phone: request.phone || '',
        town: request.town || '',
        workplace: request.workplace || '',
        verifierName: request.verifierName || ''
      });
    } catch (err) {
      console.error('❌ Помилка запису в таблицю:', err.message);
    }

    delete verificationRequests[targetId];
    bot.answerCallbackQuery(query.id, { text: '✅ Доступ надано' });
    return;
  }

  // ✅ Прийняти замовлення
  if (data.startsWith('accept_')) {
    const [_, targetId, timestamp] = data.split('_');
    const user = getUser(targetId);
    const order = user?.orders?.find(o => o.timestamp == Number(timestamp));

    if (!order || order.status === 'скасовано') {
      bot.answerCallbackQuery(query.id, { text: '⛔️ Замовлення не знайдено або скасовано.' });
      return;
    }

    if (order.status === 'прийнято') {
      bot.answerCallbackQuery(query.id, { text: 'ℹ️ Замовлення вже прийнято.' });
      return;
    }

    order.status = 'прийнято';

    try {
      await axios.post('https://script.google.com/macros/s/AKfycbxPotyVDDFaKvMNmjTZEnTqPqX0ijbkZKWD_rxcNCu5rU4nELrm5Aska7TOrSALrvfI/exec', {
        action: 'updateStatus',
        timestamp: order.timestamp,
        chatId: targetId,
        status: 'прийнято'
      });

      bot.sendMessage(targetId, `🚚 Ваше замовлення прийнято і вже в дорозі!`);
      adminChatIds.forEach(id => {
        if (!id || isNaN(id)) return;
        bot.sendMessage(id, `✅ Замовлення від @${user.username} позначено як "прийнято".`);
      });
      bot.answerCallbackQuery(query.id, { text: '✅ Прийнято' });
    } catch (err) {
      console.error('❌ Помилка оновлення статусу:', err.message);
      bot.answerCallbackQuery(query.id, { text: '⚠️ Помилка оновлення' });
    }
    return;
  }

  // ❌ Скасувати замовлення
  if (data.startsWith('cancel_')) {
    const [_, targetId, timestamp] = data.split('_');
    const user = getUser(targetId);
    const order = user?.orders?.find(o => o.timestamp == Number(timestamp));

    if (!order || order.status === 'прийнято') {
      bot.answerCallbackQuery(query.id, { text: '⛔️ Не можна скасувати прийняте замовлення.' });
      return;
    }

    order.status = 'скасовано';

    try {
      await axios.post('https://script.google.com/macros/s/AKfycbxPotyVDDFaKvMNmjTZEnTqPqX0ijbkZKWD_rxcNCu5rU4nELrm5Aska7TOrSALrvfI/exec', {
        action: 'updateStatus',
        timestamp: order.timestamp,
        chatId: targetId,
        status: 'скасовано'
      });

      bot.sendMessage(targetId, `❌ Ваше замовлення було скасовано оператором.`);
      adminChatIds.forEach(id => {
        if (!id || isNaN(id)) return;
        bot.sendMessage(id, `❌ Замовлення від @${user.username} було скасовано.`);
      });
      bot.answerCallbackQuery(query.id, { text: '❌ Скасовано' });
    } catch (err) {
      console.error('❌ Помилка оновлення статусу:', err.message);
      bot.answerCallbackQuery(query.id, { text: '⚠️ Помилка оновлення' });
    }
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

  // 📩 Відповідь оператором
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
  if (!isAdmin(chatId)) {
    bot.sendMessage(chatId, '⛔️ У вас немає доступу до панелі оператора.');
    return;
  }

  bot.sendMessage(chatId, `👨‍💼 Панель оператора активна. Оберіть дію:`, {
    reply_markup: {
      keyboard: [
        ['📋 Переглянути всі замовлення'],
        ['📩 Відповісти користувачу', '🚚 Підтвердити доставку'],
        ['📊 Статистика', '📢 Зробити розсилку'],
        ['🔙 Назад до користувацького меню']
      ],
      resize_keyboard: true
    }
  });
});
});
// ✅ Верифікація вручну
bot.onText(/\/verify (\d+)/, (msg, match) => {
  if (!isAdmin(msg.chat.id)) return;
  const targetId = parseInt(match[1], 10);

  verifiedUsers.add(targetId);
  users[targetId] = users[targetId] || {
    name: 'Невідомо',
    username: 'невідомо',
    orders: [],
    verificationRequested: false
  };
  users[targetId].justVerified = true;

  adminChatIds.forEach(id => {
    if (!id || isNaN(id)) return;
    bot.sendMessage(id, `✅ Користувач ${targetId} верифікований.`);
  });

  bot.sendMessage(targetId, `🔓 Вам надано доступ до бота. Можете почати користування.`, getMainKeyboard(targetId));
});

// ❌ Відкликання доступу
bot.onText(/\/unverify (\d+)/, (msg, match) => {
  if (!isAdmin(msg.chat.id)) return;
  const targetId = parseInt(match[1], 10);

  verifiedUsers.delete(targetId);

  adminChatIds.forEach(id => {
    if (!id || isNaN(id)) return;
    bot.sendMessage(id, `🚫 Користувач ${targetId} більше не має доступу.`);
  });

  bot.sendMessage(targetId, `🔒 Ваш доступ до бота було відкликано оператором.`);
});

// 📩 Відповідь оператором
bot.onText(/\/reply (\d+) (.+)/, (msg, match) => {
  if (!isAdmin(msg.chat.id)) return;
  const targetId = parseInt(match[1], 10);
  const replyText = match[2];

  bot.sendMessage(targetId, `📩 Повідомлення від оператора:\n${replyText}`);
  adminChatIds.forEach(id => {
    if (!id || isNaN(id)) return;
    bot.sendMessage(id, `✅ Відповідь надіслано.`);
  });
});

// 🚚 Підтвердження доставки
bot.onText(/\/send (\d+)/, (msg, match) => {
  if (!isAdmin(msg.chat.id)) return;
  const targetId = parseInt(match[1], 10);
  const user = getUser(targetId);

  if (!user || !user.orders || user.orders.length === 0) {
    adminChatIds.forEach(id => {
      if (!id || isNaN(id)) return;
      bot.sendMessage(id, `⛔️ Замовлення не знайдено.`);
    });
    return;
  }

  const order = user.orders[user.orders.length - 1];

  if (order.status === 'скасовано') {
    adminChatIds.forEach(id => {
      if (!id || isNaN(id)) return;
      bot.sendMessage(id, `⛔️ Це замовлення вже скасовано.`);
    });
    return;
  }

  if (order.status !== 'прийнято') {
    order.status = 'прийнято';
    bot.sendMessage(targetId, `🚚 Ваше замовлення прийнято і вже в дорозі!`);
    adminChatIds.forEach(id => {
      if (!id || isNaN(id)) return;
      bot.sendMessage(id, `✅ Замовлення від @${user.username} позначено як "прийнято".`);
    });
    return;
  }

  bot.sendMessage(targetId, `🚚 Ваше замовлення вже в дорозі! Дякуємо за довіру ❤️`);
  adminChatIds.forEach(id => {
    if (!id || isNaN(id)) return;
    bot.sendMessage(id, `✅ Доставку підтверджено.`);
  });
});
let broadcastPayload = { text: null, photoPath: null };
let broadcastMode = false;

// 🔘 Запуск режиму розсилки
bot.onText(/\/broadcast/, (msg) => {
  if (!isAdmin(msg.chat.id)) return;

  broadcastMode = true;
  broadcastPayload = { text: null, photoPath: null };

  adminChatIds.forEach(id => {
    if (!id || isNaN(id)) return;
    bot.sendMessage(id, `📢 Надішліть текст повідомлення для розсилки. Якщо хочете додати фото — надішліть його окремо після тексту.`);
  });
});

// 🚀 Відправка розсилки
bot.onText(/\/sendbroadcast/, async (msg) => {
  if (!isAdmin(msg.chat.id)) return;

  const { text, photoPath } = broadcastPayload;
  if (!text) {
    adminChatIds.forEach(id => {
      if (!id || isNaN(id)) return;
      bot.sendMessage(id, `⚠️ Спочатку надішліть текст повідомлення.`);
    });
    return;
  }

  let success = 0;
  let failed = 0;

  for (const id of verifiedUsers) {
    try {
      if (photoPath) {
        await bot.sendPhoto(id, photoPath, { caption: text });
      } else {
        await bot.sendMessage(id, `📢 ${text}`);
      }
      success++;
    } catch (err) {
      console.error(`❌ Не вдалося надіслати ${id}:`, err.message);
      failed++;
    }
  }

  adminChatIds.forEach(id => {
    if (!id || isNaN(id)) return;
    bot.sendMessage(id, `✅ Розсилка завершена.\n📬 Успішно: ${success}\n⚠️ Помилки: ${failed}`);
  });

  broadcastPayload = { text: null, photoPath: null };
  broadcastMode = false; // 🔚 Вихід з режиму
});

// 📥 Обробка повідомлень лише в режимі розсилки
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  const userIsAdmin = isAdmin(chatId);

  if (!userIsAdmin || !broadcastMode) return;

  if (msg.photo) {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    const file = await bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    broadcastPayload.photoPath = fileUrl;
    bot.sendMessage(chatId, `🖼 Фото додано. Тепер надішліть текст або /sendbroadcast для запуску.`);
    return;
  }

  if (!broadcastPayload.text && text && !text.startsWith('/')) {
    broadcastPayload.text = text;
    bot.sendMessage(chatId, `✉️ Текст збережено. Якщо хочете — додайте фото або напишіть /sendbroadcast для запуску.`);
    return;
  }
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  const userIsAdmin = isAdmin(chatId);

  if (!userIsAdmin) return;

  if (text === '📋 Переглянути всі замовлення') {
    let report = '📋 Усі замовлення:\n\n';
    let found = false;

    for (const uid in users) {
      const u = users[uid];
      if (!u.orders || u.orders.length === 0) continue;

      found = true;
      report += `👤 @${u.username} (${u.name})\n`;
      u.orders.forEach((order, i) => {
        report += `  #${i + 1} 📦 ${order.quantity} шт\n  🏙 ${order.city}\n  🏠 ${order.address}\n  📮 НП: ${order.np}\n  📞 ${order.phone}\n  📌 Статус: ${order.status || 'очікує'}\n\n`;
      });
    }

    bot.sendMessage(chatId, found ? report : '📭 Немає замовлень.');
    return;
  }

  if (text === '📊 Статистика') {
    let totalOrders = 0;
    let totalUsers = Object.keys(users).length;
    let totalQuantity = 0;

    for (const uid in users) {
      const u = users[uid];
      u.orders.forEach(order => {
        totalOrders++;
        const qty = parseInt(order.quantity);
        if (!isNaN(qty)) totalQuantity += qty;
      });
    }

    const stats = `📊 Статистика:\n\n👥 Користувачів: ${totalUsers}\n📦 Замовлень: ${totalOrders}\n📈 Сумарна кількість товару: ${totalQuantity} шт`;
    bot.sendMessage(chatId, stats);
    return;
  }
});
