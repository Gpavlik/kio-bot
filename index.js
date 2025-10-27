require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const shownMenuOnce = new Set();
const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

const adminChatIds = (process.env.ADMIN_CHAT_IDS || '')
  .split(',')
  .map(id => Number(id.trim()))
  .filter(id => !isNaN(id));

const ordersById = {};
const pendingMessage = {};
const verificationRequests = {};
const activeOrders = {};
const pendingMessages = [];
const pendingTTN = {};
let currentReplyTarget = null;
const lastSent = {};
let cachedUsers = [];

function isAdmin(chatId) {
  return adminChatIds.includes(Number(chatId));
}

function isVerified(chatId) {
  return cachedUsers.some(u => String(u.chatId) === String(chatId) && u.verified);
}
function getCustomerSummary(chatId, users, order = {}) {
  const customer = users.find(u => String(u.chatId) === String(chatId));
  const name = customer?.name || order.name || 'Невідомо';
  const town = customer?.town || 'Невідомо';
  const date = order.date || '';
  const time = order.time || '';
  const timestamp = date && time ? ` (${date} ${time})` : '';
  return `${name}, ${town}${timestamp}`;
}

async function reloadOrdersFromSheet() {
  try {
    const res = await axios.get('https://script.google.com/macros/s/AKfycbzQ5_NhWSRFFqxOlcthrAem5fshAg0fh19jRYg4ilBxANI-ZXjX_8u7jo3ot3E3EvY/exec', {
      params: { action: 'getOrders' }
    });

    const rows = res.data?.orders || [];

    for (const row of rows) {
      const chatId = Number(row.chatId);
      const timestamp = Number(row.timestamp);
      const orderId = `${chatId}_${timestamp}`;

      ordersById[orderId] = {
        chatId,
        timestamp,
        quantity: row.quantity,
        city: row.city,
        name: row.name,
        np: row.np,
        phone: row.phone,
        paymentMethod: row.paymentMethod,
        status: row.status,
        date: row.date,
        time: row.time
      };
    }

    console.log(`✅ Завантажено ${rows.length} замовлень у кеш`);
  } catch (err) {
    console.error('❌ Помилка завантаження замовлень:', err.message);
  }
}

async function syncUsersFromSheet() {
  try {
    const response = await axios.get('https://script.google.com/macros/s/AKfycbzQ5_NhWSRFFqxOlcthrAem5fshAg0fh19jRYg4ilBxANI-ZXjX_8u7jo3ot3E3EvY/exec');
    const rawUsers = response.data.users || [];

    console.log('📦 Вміст відповіді:', response.data);

    cachedUsers = rawUsers.map(u => ({
  chatId: String(u.chatId),
  name: u.name || 'Невідомо',
  username: u.username || 'невідомо',
  town: u.town || 'Невідомо',
  verified: true,
  orders: []
}));

    console.log(`✅ Завантажено ${cachedUsers.length} користувачів з Google Sheets`);
  } catch (err) {
    console.error('❌ Не вдалося завантажити користувачів з таблиці:', err.message);
  }
}

function getMainKeyboard(chatId) {
  if (!isVerified(chatId) && !isAdmin(chatId)) return undefined;

  return {
    reply_markup: {
      keyboard: [
        [{ text: '🛒 Зробити замовлення' }, { text: 'ℹ️ Інформація' }],
        [{ text: '📜 Історія замовлень' }, { text: '📞 Зв’язатися з оператором' }],
        [{ text: '❓ Задати запитання' }, { text: '❌ Скасувати' }]
      ],
      resize_keyboard: true,
      one_time_keyboard: false
    }
  };
}

// ✅ Стартова точка
async function startBot() {
  await reloadOrdersFromSheet();
  await syncUsersFromSheet();

  console.log('🚀 Бот запущено і кеш оновлено');
  // тут можна додати bot.on(...) та інші обробники
}

startBot();


function safeSend(chatId, text, options) {
  const now = Date.now();
  if (!lastSent[chatId] || now - lastSent[chatId] > 5000) {
    bot.sendMessage(chatId, text, options);
    lastSent[chatId] = now;
  }
}

bot.onText(/\/reloadusers/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return;

  await syncUsersFromSheet();
  bot.sendMessage(chatId, `🔄 Кеш користувачів оновлено. Завантажено ${cachedUsers.length} записів.`);
});


bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const { first_name, username } = msg.from || {};
  const displayName = first_name || 'користувачу';

  console.log(`➡️ /start від ${chatId} (@${username})`);

  try {
    const verified = isVerified(chatId);
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

    const keyboard = getMainKeyboard(chatId);
    bot.sendMessage(chatId, `👋 Вітаю, ${displayName}! Оберіть опцію з меню нижче:`, keyboard || {});
  } catch (error) {
    console.error('❌ Помилка при перевірці доступу:', error.message);
    bot.sendMessage(chatId, `⚠️ Виникла помилка при перевірці доступу. Спробуйте пізніше.`);
  }
});
bot.onText(/\/verify (\d+)/, (msg, match) => {
  if (!isAdmin(msg.chat.id)) return;
  const targetId = parseInt(match[1], 10);

  if (!cachedUsers.some(u => String(u.chatId) === String(targetId))) {
    cachedUsers.push({ chatId: String(targetId) });
  }

  bot.sendMessage(targetId, `🔓 Вам надано доступ до бота. Можете почати користування.`, getMainKeyboard(targetId));
  adminChatIds.forEach(id => bot.sendMessage(id, `✅ Користувач ${targetId} верифікований.`));
});
bot.onText(/\/unverify (\d+)/, (msg, match) => {
  if (!isAdmin(msg.chat.id)) return;
  const targetId = parseInt(match[1], 10);

  cachedUsers = cachedUsers.filter(u => String(u.chatId) !== String(targetId));

  bot.sendMessage(targetId, `🔒 Ваш доступ до бота було відкликано оператором.`);
  adminChatIds.forEach(id => bot.sendMessage(id, `🚫 Користувач ${targetId} більше не має доступу.`));
});
bot.onText(/\/reply (\d+) (.+)/, (msg, match) => {
  if (!isAdmin(msg.chat.id)) return;
  const targetId = parseInt(match[1], 10);
  const replyText = match[2];

  bot.sendMessage(targetId, `📩 Повідомлення від оператора:\n${replyText}`);
  adminChatIds.forEach(id => bot.sendMessage(id, `✅ Відповідь надіслано.`));
});
bot.onText(/\/send (\d+)/, (msg, match) => {
  if (!isAdmin(msg.chat.id)) return;
  const targetId = parseInt(match[1], 10);
  const user = cachedUsers.find(u => String(u.chatId) === String(targetId));

  if (!user || !user.orders || user.orders.length === 0) {
    adminChatIds.forEach(id => bot.sendMessage(id, `⛔️ Замовлення не знайдено.`));
    return;
  }

  const order = user.orders[user.orders.length - 1];

  if (order.status === 'скасовано') {
    adminChatIds.forEach(id => bot.sendMessage(id, `⛔️ Це замовлення вже скасовано.`));
    return;
  }

  if (order.status !== 'прийнято') {
    order.status = 'прийнято';
    bot.sendMessage(targetId, `🚚 Ваше замовлення прийнято і вже в дорозі!`);
    adminChatIds.forEach(id => bot.sendMessage(id, `✅ Замовлення від @${user.username || 'невідомо'} позначено як "прийнято".`));
    return;
  }

  bot.sendMessage(targetId, `🚚 Ваше замовлення вже в дорозі! Дякуємо за довіру ❤️`);
  adminChatIds.forEach(id => bot.sendMessage(id, `✅ Доставку підтверджено.`));
});
let broadcastPayload = { text: null, photoPath: null };
let broadcastMode = false;


// 🔘 Запуск режиму розсилки
bot.onText(/\/broadcast/, (msg) => {
  if (!isAdmin(msg.chat.id)) return;

  broadcastMode = true;
  broadcastPayload = { text: null, photoPath: null };

  bot.sendMessage(msg.chat.id, `📢 Надішліть текст повідомлення для розсилки. Якщо хочете додати фото — надішліть його окремо після тексту.`);
});

// 🚀 Відправка розсилки
bot.onText(/\/sendbroadcast/, async (msg) => {
  if (!isAdmin(msg.chat.id)) return;

  const { text, photoPath } = broadcastPayload;
  if (!text) {
    bot.sendMessage(msg.chat.id, `⚠️ Спочатку надішліть текст повідомлення.`);
    return;
  }

  let success = 0;
  let failed = 0;

  for (const user of cachedUsers) {
    const id = Number(user.chatId);
    if (!id || isNaN(id)) continue;

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

    await new Promise(res => setTimeout(res, 1000)); // throttle 1 сек
  }

  bot.sendMessage(msg.chat.id, `✅ Розсилка завершена.\n📬 Успішно: ${success}\n⚠️ Помилки: ${failed}`);
  broadcastPayload = { text: null, photoPath: null };
  broadcastMode = false;
});

// 🧭 Панель оператора
bot.onText(/\/adminpanel/, (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) {
    bot.sendMessage(chatId, '⛔️ У вас немає доступу до панелі оператора.');
    return;
  }

  bot.sendMessage(chatId, `👨‍💼 Панель оператора активна. Оберіть дію:`, {
    reply_markup: {
      keyboard: [
        ['📩 Відповісти користувачу', '📊 Статистика'],
        ['📢 Зробити розсилку', '🔙 Назад до користувацького меню']
      ],
      resize_keyboard: true
    }
  });
});

// 📜 Історія замовлень
bot.onText(/📜 Історія замовлень/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    const res = await axios.post('https://script.google.com/macros/s/AKfycbzQ5_NhWSRFFqxOlcthrAem5fshAg0fh19jRYg4ilBxANI-ZXjX_8u7jo3ot3E3EvY/exec', {
      action: 'getHistory',
      chatId
    });

    const history = res.data;

    if (!Array.isArray(history) || history.length === 0) {
      bot.sendMessage(chatId, `ℹ️ У вас поки немає замовлень.`);
      return;
    }

    const formatted = history.map((o, i) => 
      `#${i + 1}\n📦 ${o.quantity} шт\n🏙 ${o.city}\n📮 ${o.np}\n📞 ${o.phone}\n📌 Статус: ${o.status}\n📦 ТТН: ${o.ttn || '—'}`
    ).join('\n\n');

    bot.sendMessage(chatId, `📜 Ваша історія замовлень:\n\n${formatted}`);
  } catch (err) {
    console.error('❌ Помилка отримання історії:', err.message);
    bot.sendMessage(chatId, `⚠️ Не вдалося отримати історію: ${err.message}`);
  }
});

// 📊 Статистика
bot.onText(/📊 Статистика/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return;

  try {
    const [orderRes, userRes] = await Promise.all([
      axios.get('https://script.google.com/macros/s/AKfycbzQ5_NhWSRFFqxOlcthrAem5fshAg0fh19jRYg4ilBxANI-ZXjX_8u7jo3ot3E3EvY/exec', { action: 'getStats' }),
      axios.get('https://script.google.com/macros/s/AKfycbzQ5_NhWSRFFqxOlcthrAem5fshAg0fh19jRYg4ilBxANI-ZXjX_8u7jo3ot3E3EvY/exec', { action: 'getUserOrderStats' })
    ]);

    const orders = orderRes.data;
    const users = userRes.data;

    if (!users || !Array.isArray(users.users)) {
      return bot.sendMessage(chatId, `⚠️ Дані користувачів не отримано або мають неправильний формат.`);
    }

    const header = `📊 Статистика замовлень:\n` +
  `🔢 Всього: ${orders.total}\n` +
  `✅ Прийнято: ${orders.accepted}\n` +
  `❌ Скасовано: ${orders.canceled}\n` +
  `⏳ Очікує: ${orders.pending}\n` +
  `📦 Відправлено: ${orders.sent}\n` + // 👈 нове
  `💳 Оплачено: ${orders.paid}\n` +    // 👈 нове
  `💰 Заробіток: ${orders.profit.toLocaleString('uk-UA')} грн\n\n` + // 👈 нове
  `👥 Статистика користувачів:\n` +
  `🔢 Всього: ${users.totalUsers}\n` +
  `📦 З замовленнями: ${users.withOrders}\n` +
  `🚫 Без замовлень: ${users.withoutOrders}\n\n` +
  `📋 Користувачі:`;


    const buttons = users.users.map(u => [{
      text: `${u.name} (${u.town}) — ${u.lastOrderDate}, ${u.totalAcceptedQuantity} уп.`,
      callback_data: `msg_${u.chatId}`
    }]);

    bot.sendMessage(chatId, header, {
      reply_markup: {
        inline_keyboard: buttons
      }
    });
  } catch (err) {
    console.error('❌ Помилка статистики:', err.message);
    bot.sendMessage(chatId, `⚠️ Не вдалося отримати статистику: ${err.message}`);
  }
});
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  console.log('📥 Отримано callback_query:', data);

  const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzQ5_NhWSRFFqxOlcthrAem5fshAg0fh19jRYg4ilBxANI-ZXjX_8u7jo3ot3E3EvY/exec';

  if (data === 'payment_cod' || data === 'payment_prepaid') {
  const order = activeOrders[chatId];
  if (!order) return;

  const now = new Date();
  order.paymentMethod = data === 'payment_cod' ? 'оплата при отриманні' : 'передплата';
  order.paymentStatus = 'неоплачено';
  order.timestamp = Date.now();
  order.date = now.toLocaleDateString('uk-UA');
  order.time = now.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
  order.status = 'очікує';

  const orderId = `${chatId}_${order.timestamp}`;
  ordersById[orderId] = order;

  let user = cachedUsers.find(u => String(u.chatId) === String(chatId));
  if (!user) {
    user = {
      chatId: String(chatId),
      name: query.from?.first_name || 'Невідомо',
      username: query.from?.username || 'невідомо',
      town: 'Невідомо',
      verified: true,
      orders: []
    };
    cachedUsers.push(user);
  }

  user.orders.push(order);

  const resolvedName = user.name || 'Невідомо';
  const userTown = user.town || 'Невідомо';

  let confirmText = `✅ Замовлення надіслано оператору!\n\n📦 Кількість: ${order.quantity}\n🏙 Місто: ${order.city}\n👤 ПІБ: ${order.name}\n📮 НП: ${order.np}\n📞 Телефон: ${order.phone}\n💰 Оплата: ${order.paymentMethod}`;
  if (order.paymentMethod === 'передплата') {
    confirmText += `\n\n💳 Реквізити для оплати:\nФОП Кирієнко Микола Олексійович\nIBAN: UA023510050000026000879268179\nЄДРПОУ: 2609322450\nАТ "УКРСИББАНК"\nПризначення: Передплата за замовлення від ${order.name}, ${order.date} ${order.time}`;
  }

  await bot.sendMessage(chatId, confirmText);

  // ✅ Додаємо ПІБ оператора
  const operator = cachedUsers.find(u => String(u.chatId) === String(query.from.id));
  const operatorName = operator?.name || query.from?.first_name || 'невідомо';

  try {
    await axios.post(SCRIPT_URL, {
      action: 'add',
      timestamp: order.timestamp,
      chatId,
      name: order.name,
      username: user.username,
      town: user.town || 'Невідомо', // ✅ передаємо місто
      quantity: order.quantity,
      city: order.city,
      address: `${order.city}, НП ${order.np}`,
      np: order.np,
      phone: order.phone,
      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus,
      status: order.status,
      date: order.date,
      time: order.time,
      operatorName // ✅ передаємо ПІБ оператора
    });
    console.log(`✅ Замовлення записано для ${order.name}`);
  } catch (err) {
    console.error(`❌ Помилка запису замовлення: ${err.message}`);
    adminChatIds.forEach(id => {
      if (!id || isNaN(id)) return;
      bot.sendMessage(id, `⚠️ Не вдалося записати замовлення від @${user.username}: ${err.message}`);
    });
  }

  // 📬 Повідомлення адміністраторам
  let adminText =
    `📬 НОВЕ ЗАМОВЛЕННЯ від ${resolvedName}, ${userTown}\n\n` +
    `📦 ${order.quantity} шт\n` +
    `🏙 ${order.city}\n` +
    `👤 ${order.name}\n` +
    `📮 НП: ${order.np}\n` +
    `📞 Телефон: ${order.phone}\n` +
    `💰 Оплата: ${order.paymentMethod}`;

  const paymentDetails =
    `\n\n💳 Реквізити для оплати:\nФОП Кирієнко Микола Олексійович\nIBAN: UA023510050000026000879268179\nЄДРПОУ: 2609322450\nАТ "УКРСИББАНК"\nПризначення: Передплата за замовлення від ${order.name}, ${order.date} ${order.time}`;

  order.adminMessages = [];

  for (const id of adminChatIds) {
    if (!id || isNaN(id)) continue;

    const fullAdminText = order.paymentMethod === 'передплата'
      ? adminText + paymentDetails
      : adminText;

    const sent = await bot.sendMessage(id, fullAdminText, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Прийняти', callback_data: `accept_${chatId}_${order.timestamp}` },
            { text: '❌ Скасувати', callback_data: `cancel_${chatId}_${order.timestamp}` }
          ]
        ]
      }
    });

    order.adminMessages.push({ chatId: id, messageId: sent.message_id });
  }

  delete activeOrders[chatId];
  return;
}

// 🔐 Адмінські дії
if (!isAdmin(chatId)) {
  await bot.answerCallbackQuery(query.id, { text: '⛔️ Доступ лише для адміністраторів.' });
  return;
}

// ✅ Отримуємо список користувачів один раз
let users = [];
try {
  const userSheet = await axios.get(SCRIPT_URL, {
    params: { action: 'getUsers' }
  });
  users = userSheet.data?.users || [];
} catch (err) {
  console.error('❌ Помилка отримання користувачів:', err.message);
}

// ✅ Верифікація
if (data.startsWith('verify_')) {
  const targetChatId = data.split('_')[1];
  const request = verificationRequests[targetChatId];
  if (!request || request.verified) {
    await bot.answerCallbackQuery(query.id, { text: '❌ Запит не знайдено або вже оброблено', show_alert: true });
    return;
  }

  await bot.answerCallbackQuery(query.id, { text: '⏳ Верифікація...' });

  try {
    await axios.post(SCRIPT_URL, {
      action: 'addUser',
      name: request.name,
      username: request.username || '',
      chatId: targetChatId,
      phone: request.phone,
      town: request.town,
      workplace: request.workplace,
      verifierName: request.verifierName
    });

    await bot.sendMessage(targetChatId, `✅ Вас верифіковано! Доступ надано.`);
    await bot.sendMessage(chatId, `✅ Користувача ${request.name} додано до таблиці.`);
    delete verificationRequests[targetChatId];
  } catch (err) {
    console.error('❌ Помилка при додаванні користувача:', err.message);
    await bot.sendMessage(chatId, `❌ Не вдалося додати користувача: ${err.message}`);
  }
  return;
}

// ✉️ Повідомлення користувачу
if (data.startsWith('msg_')) {
  const targetId = data.split('_')[1];
  pendingMessage[chatId] = targetId;
  await bot.sendMessage(chatId, `✍️ Введіть повідомлення для користувача ${targetId}:`);
  await bot.answerCallbackQuery(query.id);
  return;
}

// ✅ Прийняти замовлення
if (data.startsWith('accept_')) {
  const [_, targetIdStr, timestampStr] = data.split('_');
  const targetId = Number(targetIdStr);
  const timestamp = Number(timestampStr);
  const orderId = `${targetId}_${timestamp}`;
  const order = ordersById[orderId];

  if (!order) {
    await bot.sendMessage(chatId, `❌ Замовлення не знайдено: ${orderId}`);
    return;
  }

  order.status = 'прийнято';

  const operator = users.find(u => String(u.chatId) === String(query.from.id));
  const operatorName = operator?.name || 'невідомо';

  const newKeyboard = {
    inline_keyboard: [
      [
        { text: '💳 Оплачено', callback_data: `paid_${targetId}_${timestamp}` },
        { text: '📦 Надіслати ТТН', callback_data: `ttn_${targetId}_${timestamp}` }
      ]
    ]
  };

try {
  // ✅ Оновлюємо статус у таблиці
  await axios.post(SCRIPT_URL, {
    action: 'updateStatus',
    timestamp: order.timestamp,
    chatId: targetId,
    status: 'прийнято',
    operatorId: query.from.id // 👈 передаємо chatId оператора
  });

  console.log('📤 Відправляємо updateStatus:', {
    action: 'updateStatus',
    timestamp: order.timestamp,
    chatId: targetId,
    status: 'прийнято',
    operatorId: query.from.id
  });

  
    // ✅ Оновлюємо клавіатуру в повідомленнях адміністраторів
    if (order.adminMessages?.length) {
      for (const msg of order.adminMessages) {
        try {
          await bot.editMessageReplyMarkup(newKeyboard, {
            chat_id: msg.chatId,
            message_id: msg.messageId
          });
        } catch (err) {
          const description = err.response?.body?.description || '';
          if (!description.includes('message is not modified')) {
            console.error(`❌ Помилка редагування клавіатури для ${msg.chatId}:`, err.message);
          }
        }
      }
    }

    // ✅ Уніфіковане повідомлення з ПІБ, містом, датою і часом
    const summary = getCustomerSummary(targetId, users, order);

    await bot.sendMessage(targetId, `✅ Ваше замовлення прийнято та обробляється!`);
    await bot.sendMessage(chatId, `📦 Статус оновлено: прийнято для ${summary}`);
  } catch (err) {
    console.error('❌ Помилка оновлення статусу замовлення:', err.message);
    await bot.sendMessage(chatId, `❌ Помилка оновлення статусу: ${err.message}`);
  }

  return;
}


// ❌ Скасування замовлення
if (data.startsWith('cancel_')) {
  const [_, targetIdStr, timestampStr] = data.split('_');
  const targetId = String(targetIdStr);
  const timestamp = Number(timestampStr);
  const user = cachedUsers.find(u => String(u.chatId) === targetId);
  const order = user?.orders?.find(o => o.timestamp === timestamp);

  if (!order || order.status === 'прийнято') {
    await bot.answerCallbackQuery(query.id, { text: '⛔️ Не можна скасувати прийняте замовлення.' });
    return;
  }

  order.status = 'скасовано';

  try {
    await axios.post(SCRIPT_URL, {
      action: 'updateStatus',
      timestamp: order.timestamp,
      chatId: targetId,
      status: 'скасовано'
    });

    if (order.adminMessages?.length) {
      for (const msg of order.adminMessages) {
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
          chat_id: msg.chatId,
          message_id: msg.messageId
        });
      }
    }

    const summary = getCustomerSummary(targetId, users, order);

    await bot.sendMessage(targetId, `❌ Ваше замовлення було скасовано оператором.`);
    await bot.sendMessage(chatId, `❌ Замовлення ${summary} було скасовано.`);
    await bot.answerCallbackQuery(query.id, { text: '❌ Скасовано' });
  } catch (err) {
    console.error('❌ Помилка оновлення статусу:', err.message);
    await bot.answerCallbackQuery(query.id, { text: '⚠️ Помилка оновлення' });
  }
  return;
}


// 📦 Введення ТТН
if (data.startsWith('ttn_')) {
  const [_, targetIdStr, timestampStr] = data.split('_');
  const targetId = Number(targetIdStr);
  const timestamp = Number(timestampStr);

  pendingTTN[chatId] = { targetId, timestamp };

  const orderId = `${targetId}_${timestamp}`;
  const order = ordersById[orderId];
  const summary = getCustomerSummary(targetId, users, order);

  await bot.sendMessage(chatId, `✍️ Введіть номер ТТН для користувача ${summary}:`);
  await bot.answerCallbackQuery(query.id);
  return;
}


// 💳 Позначити як оплачено
if (data.startsWith('paid_')) {
  const [_, targetIdStr, timestampStr] = data.split('_');
  const targetId = Number(targetIdStr);
  const timestamp = Number(timestampStr);
  const orderId = `${targetId}_${timestamp}`;
  const order = ordersById[orderId];

  if (!order) {
    await bot.sendMessage(chatId, `❌ Замовлення не знайдено: ${orderId}`);
    return;
  }

  order.paymentStatus = 'оплачено';

  try {
    await axios.post(SCRIPT_URL, {
      action: 'updatePayment',
      timestamp,
      chatId: targetId,
      paymentStatus: 'оплачено'
    });

    const updatedKeyboard = {
      inline_keyboard: [
        [{ text: '📦 Надіслати ТТН', callback_data: `ttn_${targetId}_${timestamp}` }]
      ]
    };

    if (order.adminMessages?.length) {
      for (const msg of order.adminMessages) {
        await bot.editMessageReplyMarkup(updatedKeyboard, {
          chat_id: msg.chatId,
          message_id: msg.messageId
        });
      }
    }

    const summary = getCustomerSummary(targetId, users, order);

    await bot.sendMessage(targetId, `💳 Ваше замовлення позначено як *оплачене*. Дякуємо!`, { parse_mode: 'Markdown' });
    await bot.sendMessage(chatId, `✅ Статус оновлено: *оплачено* для ${summary}`, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('❌ Помилка оновлення статусу:', err.message);
    await bot.sendMessage(chatId, `❌ Помилка оновлення статусу: ${err.message}`);
  }
  return;
}


// ❓ Невідома дія
await bot.answerCallbackQuery(query.id, { text: '❓ Невідома дія.' });
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || '';
  const { first_name, username } = msg.from || {};
  const userIsAdmin = isAdmin(chatId);
  const isUserVerified = isVerified(chatId);
  const user = cachedUsers.find(u => String(u.chatId) === String(chatId)) || {};

  if (text === '/adminpanel') return;

  console.log(`📩 Повідомлення від ${chatId} (@${username}) | isAdmin=${userIsAdmin} | isVerified=${isUserVerified} | text="${text}"`);


  // Якщо це не команда (типу /start) і користувач верифікований
if (!msg.text.startsWith('/') && isVerified(chatId) && !shownMenuOnce.has(chatId)) {
  const keyboard = getMainKeyboard(chatId);
  if (keyboard) {
    bot.sendMessage(chatId, '📲 Головне меню доступне:', {
      reply_markup: { keyboard, resize_keyboard: true }
    });
    shownMenuOnce.add(chatId); // ✅ запамʼятати, що вже показали
  }
}




  // 🔘 /start — запуск верифікації або головного меню
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

  // ✉️ Надсилання повідомлення користувачу
  if (userIsAdmin && pendingMessage[chatId]) {
    const targetId = pendingMessage[chatId];
    bot.sendMessage(targetId, `📩 Повідомлення від адміністратора:\n\n${text}`);
    bot.sendMessage(chatId, `✅ Повідомлення надіслано.`);
    delete pendingMessage[chatId];
    return;
  }

  // 🔐 Верифікація — покрокова
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
          bot.sendMessage(id, `🔐 Запит на верифікацію:\n👤 ${request.name}\n📞 ${request.phone}\n🏙️ ${request.town}\n🏢 ${request.workplace}\n👤 Співробітник: ${request.verifierName}\n🆔 chatId: ${chatId}`, {
            reply_markup: {
              inline_keyboard: [[{ text: '✅ Надати доступ', callback_data: `verify_${chatId}` }]]
            }
          });
        });
        return;
    }
    return;
  }

  // 🔒 Заборонити доступ неверифікованим
  if (!isUserVerified && !userIsAdmin) {
    bot.sendMessage(chatId, `🔒 Ви ще не верифіковані. Натисніть /start або зверніться до оператора.`);
    return;
  }

  // 📢 Режим розсилки
  if (userIsAdmin && broadcastMode) {
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
    bot.sendMessage(chatId, `📞 Ви можете зв’язатися з оператором напряму:`);
    bot.sendContact(chatId, '+380504366713', 'Оператор');
    return;
  }

  // 📬 Відповідь адміністратора
  if (userIsAdmin && currentReplyTarget) {
    bot.sendMessage(currentReplyTarget, `📬 Відповідь від оператора:\n\n${text}`);
    bot.sendMessage(chatId, `✅ Відповідь надіслано.`);
    const index = pendingMessages.findIndex(m => m.chatId === currentReplyTarget);
    if (index !== -1) pendingMessages.splice(index, 1);
    currentReplyTarget = null;
    return;
  }

  // ❓ Обробка запитання користувача
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

  // 📦 Введення ТТН
if (userIsAdmin && pendingTTN[chatId]) {
  const { targetId, timestamp } = pendingTTN[chatId];
  const orderId = `${targetId}_${timestamp}`;
  console.log('🔍 Шукаємо orderId:', orderId);

  const order = ordersById[orderId];
  if (!order) {
    bot.sendMessage(chatId, `❌ Замовлення не знайдено.`);
    delete pendingTTN[chatId];
    return;
  }

  order.ttn = text;
  order.status = 'відправлено';

  const unitPrice = 8500;
  const amount = order.quantity * unitPrice;
  const userRecord = cachedUsers.find(u => String(u.chatId) === String(targetId));
  const verifiedName = userRecord?.name || 'Користувач';
    
  const userMessage =
  `Шановний(а) ${verifiedName}, ваше замовлення для ${order.name} підтверджено та вже відправилось в дорогу:\n\n` +
  `📦 Ваше замовлення:\n` +
  `• Кількість: ${order.quantity} уп.\n` +
  `• Місто: ${order.city}\n` +
  `• Сума: ${amount.toLocaleString('uk-UA')} грн\n` +
  `• ТТН: ${text}\n\n` +
  `Дякуємо за замовлення! Сподіваємось на подальшу співпрацю`;
  const adminMessage = `📤 ТТН на замовлення ${verifiedName} для ${order.name} ${order.date} ${order.time} відправлено`;

  try {
    await axios.post('https://script.google.com/macros/s/AKfycbzQ5_NhWSRFFqxOlcthrAem5fshAg0fh19jRYg4ilBxANI-ZXjX_8u7jo3ot3E3EvY/exec', {
      action: 'updateTTN',
      timestamp: order.timestamp,
      chatId: targetId,
      ttn: text,
      status: 'відправлено'
    });

    await bot.sendMessage(targetId, userMessage);
    await bot.sendMessage(chatId, adminMessage);

    // 🧩 Синхронне оновлення клавіатури у всіх адмінів
    if (order.adminMessages && Array.isArray(order.adminMessages)) {
      for (const msg of order.adminMessages) {
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
          chat_id: msg.chatId,
          message_id: msg.messageId
        });
      }
    }
  } catch (err) {
    console.error('❌ Помилка надсилання ТТН:', err.message);
    bot.sendMessage(chatId, `⚠️ Не вдалося надіслати ТТН: ${err.message}`);
  }

  delete pendingTTN[chatId];
  return;
}



  // 🛒 Початок замовлення
if (text === '🛒 Зробити замовлення') {
  activeOrders[chatId] = {};
  bot.sendMessage(chatId, `📦 Скільки одиниць товару бажаєте замовити?`);
  return;
}

// 🧾 Обробка замовлення
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

  if (!order.name) {
    order.name = text;
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
if (order.phone === '__awaiting__') {
  if (!/^(\+380|0)\d{9}$/.test(text)) {
    bot.sendMessage(chatId, `❗ Будь ласка, введіть коректний номер телефону.`);
    return;
  }

  order.phone = text;

  bot.sendMessage(chatId, `💰 Оберіть спосіб оплати:`, {
    reply_markup: {
      inline_keyboard: [
          [{ text: '💵 Оплата при отриманні', callback_data: 'payment_cod' }],
          [{ text: '💳 Передплата', callback_data: 'payment_prepaid' }]
      ]
    }
  });

  return;
}
    order.phone = text;

const now = new Date();
order.timestamp = Date.now();
order.date = now.toLocaleDateString('uk-UA');
order.time = now.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
order.status = 'очікує';

// 🆕 Зберігаємо в ordersById
const orderId = `${chatId}_${order.timestamp}`;
ordersById[orderId] = order;
console.log('✅ Збережено orderId:', orderId);

// 🧾 Додаємо замовлення до cachedUsers
let user = cachedUsers.find(u => String(u.chatId) === String(chatId));
if (!user) {
  user = {
    chatId: String(chatId),
    name: msg.from?.first_name || 'Невідомо',
    username: msg.from?.username || 'невідомо',
    town: order.city || 'Невідомо', // ✅ зберігаємо місто
    orders: []
  };
  cachedUsers.push(user);
}

user.orders = user.orders || [];
user.town = order.city || user.town || 'Невідомо'; // ✅ оновлюємо town
user.name = user.name || order.name || 'Невідомо'; // ✅ оновлюємо name
user.orders.push(order);

// ✅ ПІБ оператора
const operatorName = user.name || msg.from?.first_name || 'невідомо';

bot.sendMessage(chatId, `✅ Замовлення очікує обробки!\n\n📦 Кількість: ${order.quantity}\n🏙 Місто: ${order.city}\n👤 ПІБ: ${order.name}\n📮 НП: ${order.np}\n📞 Телефон: ${order.phone}`);

// 📤 Надсилання в Google Таблицю
try {
      await axios.post('https://script.google.com/macros/s/AKfycbzQ5_NhWSRFFqxOlcthrAem5fshAg0fh19jRYg4ilBxANI-ZXjX_8u7jo3ot3E3EvY/exec', {
        action: 'add',
    timestamp: order.timestamp,
    chatId,
    name: order.name,
    username: user.username,
    town: user.town, // ✅ передаємо місто
    quantity: order.quantity,
    city: order.city,
    address: `${order.city}, НП ${order.np}`, // ✅ повна адреса
    np: order.np,
    phone: order.phone,
    status: 'очікує',
    date: order.date,
    time: order.time,
    operatorName // ✅ передаємо ПІБ оператора
  });
  console.log(`✅ Замовлення записано для ${order.name}`);
} catch (err) {
  console.error(`❌ Помилка запису замовлення: ${err.message}`);
  adminChatIds.forEach(id => {
    if (!id || isNaN(id)) return;
    bot.sendMessage(id, `⚠️ Не вдалося записати замовлення від @${user.username}: ${err.message}`);
  });
}

// 📢 Повідомлення адміністраторам
adminChatIds.forEach(id => {
  if (!id || isNaN(id)) return;

  bot.sendMessage(id,
    `📬 НОВЕ ЗАМОВЛЕННЯ від ${user.name}, ${user.town}\n\n` +
    `📦 ${order.quantity} шт\n` +
    `🏙 ${order.city}\n` +
    `👤 ${order.name}\n` +
    `📮 НП: ${order.np}\n` +
    `📞 Телефон: ${order.phone}`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Прийняти', callback_data: `accept_${chatId}_${order.timestamp}` },
            { text: '❌ Скасувати', callback_data: `cancel_${chatId}_${order.timestamp}` }
          ]
        ]
      }
    }
  );
});

delete activeOrders[chatId];
return;
}
}



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

  if (text === '🛠 Дія') {
    bot.sendMessage(chatId, `Остеоартрит — дегенеративне захворювання, що супроводжується підвищеним тертям у суглобах, болем і функціональними порушеннями. Однією з причин є окислювальне руйнування ендогенних мастильних полімерів (гіалуронатів) під дією вільних радикалів.
KioMedinevsOne — засіб для підвищення в’язкості синовіальної рідини, призначений для внутрішньосуглобових ін’єкцій. Основний компонент — лінійне (незшите) похідне хітозану нетваринного походження, отримане з печериці Agaricus bisporus та модифіковане запатентованою технологією.
Препарат забезпечує змащення, знижує тертя, нейтралізує вільні радикали та зменшує вплив окисного стресу на суглоб. Після введення його компоненти розкладаються в організмі та є нетоксичними для тканин.`);
    return;
  }

  if (text === '📦 Склад') {
    bot.sendMessage(chatId, `Кожна упаковка KioMedinevsOne містить один попередньо наповнений шприц з 3 ml (мл)
стерильного розчину, упакований у блістер, інструкцію щодо застосування та етикетки.
В 1 ml (мл) розчину міститься 20 mg (мг) похідного хітозану, 35 mg (мг) сорбіту та
фосфатна-буферна вода для ін'єкцій qs (рН 7,2 ± 0,2, 270-330 mOsmol/kg (мОсмоль/кг)).
Попередньо наповнений шприц призначений лише для одноразового використання.`);
    return;
  }

  if (text === '⚙️ Ефект') {
    bot.sendMessage(chatId, `Один курс лікування передбачає одну внутрішньосуглобову ін'єкцію КioMedinevsOne
об'ємом 3 ml (мл) у колінний суглоб.
• Клінічні дані рандомізованого контрольованого дослідження за участю пацієнтів з
остеоартритом колінного суглоба показали, що одноразова внутрішньосуглобова
ін'єкція KioMedinevsOne забезпечує значне зменшення болю в суглобах, скутості та
покращення функціональності протягом 6 місяців.
• Лікування можна повторити відповідно до рекомендацій лікаря та симптомів пацієнта.
Термін між курсами лікування може залежати від тяжкості симптомів.
Під час клінічного дослідження профіль безпеки повторної ін'єкції KioMedinevsOne в
колінний суглоб не змінювався після З-місячного інтервалу.`);
    return;
  }

  if (text === '⚠️ Увага') {
    bot.sendMessage(chatId, `•	Протипоказання та застереження щодо застосування KioMedinevsOne
•	Не вводити при підозрі на наявність синовіального випоту.
•	Безпека та ефективність не встановлені для вагітних, жінок у період лактації, дітей та при інших захворюваннях, окрім остеоартриту колінного суглоба.
•	Зберігати в оригінальній упаковці при температурі 2–25 °C. Не заморожувати. Якщо зберігався на холоді — перед використанням витримати 15 хв при кімнатній температурі.
•	Використати одразу після відкриття. Препарат призначений для одноразового застосування одному пацієнту. Не використовувати при пошкодженій упаковці. Повторне використання або стерилізація заборонені.
•	Утилізувати залишки у відповідний контейнер.
•	Введення несе ризик інфікування: необхідне суворе дотримання асептики та обробка шкіри відповідним антисептиком (крім препаратів на основі четвертинних амонієвих сполук).
•	Високий тиск під час ін’єкції може свідчити про неправильне положення голки.
•	Існує ризик травмування голкою під час маніпуляцій.
•	Дані щодо взаємодії з іншими внутрішньосуглобовими препаратами відсутні.`);
    return;
  }

  if (text === '📝 Застосування') {
    bot.sendMessage(chatId, `Перед кожною ін'єкцією KioMedinevsOne слід видалити синовіальну рідину.
• Введення KioMedinevsOne повинне проводитися навченим лікарем, який має досвід
внутрішньосуглобових ін'єкцій у колінний суглоб.
• Місце ін'єкції слід ретельно обробити відповідним антисептичним засобом перед
введенням препарату.
• Техніка внутрішньосуглобової ін'єкції повинна забезпечувати точне введення
KioMedinevsOne в порожнину суглоба. Правильне розміщення гопки у суглобі можливо
контролювати, за необхідності, за допомогою ультразвукової діагностики. Ін'єкції під
контролем УЗД повинні виконуватися лише лікарями з відповідним досвідом роботи в
цій техніці.
• Для введення препарату KioMedinevsOne слід використовувати голку Люера
відповідного розміру, тобто від 20G до 23G, та відповідної довжини. Обережно зніміть
захисний ковпачок зі шприца і в асептичний спосіб під'єднайте голку. Голка повинна бути
міцно з'єднана зі шприцом .
• Введіть увесь вміст шприца в колінний суглоб.
• Після введення препарату голку слід обережно видалити, а місце ін'єкції знову
обробити антисептиком.
• Після використання голку слід утилізувати у відповідний контейнер для гострих предметів.
• Після ін'єкції KioMedinevsOne пацієнт може відчути тимчасове посилення болю в
суглобі, яке зазвичай минає протягом 2-3 днів. Рекомендується застосування холодних компресів і прийом знеболювальних засобів (нестероїдних протизапальних препаратів).
• Пацієнтам слід рекомендувати уникати надмірних фізичних навантажень на суглоб протягом перших 48 годин після ін'єкції.`);
    return;
  }

  if (text === '💡 Клінічні випадки') {
    bot.sendDocument(chatId, './KioMedine Patient Cases_v2.0.0.pdf', {
      caption: '📄 Клінічні випадки застосування препарату',
      contentType: 'application/pdf'
    });
    return;
  }

  if (text === '$ Ціна') {
    bot.sendMessage(chatId, `💰 Ціна за 1 упаковку (3 мл): 8500 грн.`);
    return;
  }

  if (text === '🔙 Назад') {
    bot.sendMessage(chatId, `🔙 Повертаємось до головного меню.`, getMainKeyboard(chatId));
    return;
  }
// 📋 Переглянути всі замовлення
if (userIsAdmin && text === '📋 Переглянути всі замовлення') {
  let report = '📋 Усі замовлення:\n\n';
  let found = false;

  for (const user of cachedUsers) {
    if (!user.orders || user.orders.length === 0) continue;

    found = true;
    const userName = user.name || 'Невідомо';
    const userTown = user.town || 'Невідомо';
    report += `👤 ${userName}, ${userTown} (@${user.username || 'невідомо'})\n`;

    user.orders.forEach((order, i) => {
      const timestamp = order.date && order.time ? `🕒 ${order.date} ${order.time}` : '';
      report +=
        `  #${i + 1} 📦 ${order.quantity} шт\n` +
        `  🏙 ${order.city}\n` +
        `  👤 ${order.name}\n` +
        `  📮 НП: ${order.np}\n` +
        `  📞 ${order.phone}\n` +
        `  💰 Оплата: ${order.paymentMethod || 'не вказано'}\n` +
        `  📌 Статус: ${order.status || 'очікує'}\n` +
        `  ${timestamp}\n\n`;
    });
  }

  bot.sendMessage(chatId, found ? report : '📭 Немає замовлень.');
  return;
}

// 📢 Зробити розсилку
if (userIsAdmin && text === '📢 Зробити розсилку') {
  broadcastMode = true;
  broadcastPayload = {};
  bot.sendMessage(chatId, `📢 Введіть текст повідомлення або надішліть фото. Коли будете готові — напишіть /sendbroadcast`);
  return;
}

// 📩 Відповісти користувачу
if (userIsAdmin && text === '📩 Відповісти користувачу') {
  if (pendingMessages.length === 0) {
    bot.sendMessage(chatId, `📭 Немає нових запитань від користувачів.`);
    return;
  }

  const next = pendingMessages[0];
  currentReplyTarget = next.chatId;
  const name = next.name || 'Невідомо';
  const town = next.town || 'Невідомо';
  bot.sendMessage(chatId, `✍️ Відповідаєте користувачу ${name}, ${town} (@${next.username}):\n\n"${next.text}"`);
  return;
}

// 🚚 Підтвердити доставку
if (userIsAdmin && text === '🚚 Підтвердити доставку') {
  bot.sendMessage(chatId, `📦 Натисніть кнопку "📦 Надіслати ТТН" під замовленням, щоб ввести номер.`);
  return;
}

// 🔙 Назад до користувацького меню
if (text === '🔙 Назад до користувацького меню') {
  bot.sendMessage(chatId, `🔄 Повертаємось до головного меню.`, getMainKeyboard(chatId));
  return;
}
  // 🧼 Catch-all: якщо нічого не спрацювало
  //if (text && !text.startsWith('/')) {
    //bot.sendMessage(chatId, `🤖 Не впізнаю команду. Оберіть опцію з меню нижче:`, getMainKeyboard(chatId));
  //}
});
