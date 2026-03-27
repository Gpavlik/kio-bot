require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const pendingReply = {}; // ключ — chatId адміністратора, значення — chatId користувача
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

// ✅ Стартова точка
async function startBot() {
  try {
    // Очистка черги апдейтів, щоб не тягнути історію
    await bot.getUpdates({ offset: -1 });
    console.log('🧹 Черга апдейтів очищена');
  } catch (err) {
    console.error('❌ Помилка очищення апдейтів:', err.message);
  }

  await reloadOrdersFromSheet();
  await syncUsersFromSheet();

  console.log('🚀 Бот запущено і кеш оновлено');
  // тут можна додати bot.on(...) та інші обробники
}

startBot().catch(err => console.error('❌ Помилка запуску бота:', err));

function getOrderKeyboard(order) {
  const buttons = [];

  if (order.paymentStatus !== 'оплачено') {
    buttons.push({ text: '💳 Оплачено', callback_data: `paid_${order.chatId}_${order.timestamp}` });
  }

  if (!order.ttn) {
    buttons.push({ text: '📦 Надіслати ТТН', callback_data: `ttn_${order.chatId}_${order.timestamp}` });
  }

  return { inline_keyboard: buttons.map(btn => [btn]) };
}

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
    const res = await axios.get('https://script.google.com/macros/s/AKfycbx9VpoHx_suctQ-8yKVHvRBuSWvjvGEzQ9SXDZK7yJP1RBS2KOp3m8xXxIEttTKetTr/exec', {
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
    const response = await axios.get('https://script.google.com/macros/s/AKfycbx9VpoHx_suctQ-8yKVHvRBuSWvjvGEzQ9SXDZK7yJP1RBS2KOp3m8xXxIEttTKetTr/exec?action=getUsers');
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

let broadcastPayload = { text: null, photos: [], document: null, caption: null };
let broadcastMode = false;
let mediaGroups = {};

// Запуск режиму розсилки

// 📢 Запуск режиму розсилки з підтвердженням
bot.onText(/\/broadcast/, async (msg) => {
  if (!isAdmin(msg.chat.id)) return;

  await bot.sendMessage(msg.chat.id, `📢 Ви дійсно хочете створити нову розсилку?`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Так', callback_data: 'confirm_broadcast' }],
        [{ text: '❌ Ні', callback_data: 'cancel_broadcast' }]
      ]
    }
  });
});

// Обробка підтвердження/скасування
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;

  if (query.data === 'confirm_broadcast') {
    broadcastMode = true;
    broadcastPayload = { text: null, photos: [], document: null, caption: null };
    await bot.sendMessage(chatId, `📢 Режим розсилки активовано. Надішліть текст, фото, групу фото або документ. Коли будете готові — напишіть /sendbroadcast\n\n❌ Для виходу використайте /cancelbroadcast`);
  }

  if (query.data === 'cancel_broadcast') {
    broadcastMode = false;
    broadcastPayload = { text: null, photos: [], document: null, caption: null };
    await bot.sendMessage(chatId, `❌ Розсилка скасована.`);
  }
});

// 🚀 Відправка розсилки
bot.onText(/\/sendbroadcast/, async (msg) => {
  if (!isAdmin(msg.chat.id)) return;

  console.log('🚀 broadcastPayload перед розсилкою:', broadcastPayload);
  console.log('👥 Кількість користувачів:', cachedUsers.length);

  let success = 0, failed = 0;
  const { text: broadcastText, photos, document, caption } = broadcastPayload;

  for (const user of cachedUsers) {
    const id = Number(user.chatId);
    if (!id || isNaN(id)) continue;

    try {
      if (Array.isArray(photos) && photos.length > 1) {
        const mediaGroup = photos.map((fileId, i) => ({
          type: 'photo',
          media: fileId,
          caption: i === 0 ? (caption || broadcastText || '') : undefined
        }));
        await bot.sendMediaGroup(id, mediaGroup);
      } else if (Array.isArray(photos) && photos.length === 1) {
        await bot.sendPhoto(id, photos[0], { caption: caption || broadcastText || '' });
      } else if (document) {
        await bot.sendDocument(id, document, { caption: caption || broadcastText || '' });
      } else if (broadcastText) {
        await bot.sendMessage(id, `📢 ${broadcastText}`);
      }

      console.log(`➡️ Надіслано користувачу ${id}`);
      success++;
    } catch (err) {
      console.error(`❌ Не вдалося надіслати ${id}:`, err.response?.body || err.message);
      failed++;
    }

    await new Promise(res => setTimeout(res, 1000)); // throttle
  }

  await bot.sendMessage(msg.chat.id, `✅ Розсилка завершена.\n📬 Успішно: ${success}\n⚠️ Помилки: ${failed}`);

  broadcastPayload = { text: null, photos: [], document: null, caption: null };
  broadcastMode = false;
});

// ❌ Скасування розсилки вручну
bot.onText(/\/cancelbroadcast/, async (msg) => {
  if (!isAdmin(msg.chat.id)) return;

  broadcastMode = false;
  broadcastPayload = { text: null, photos: [], document: null, caption: null };

  await bot.sendMessage(msg.chat.id, `❌ Режим розсилки вимкнено. Ви можете почати нову розсилку командою /broadcast`);
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
    const res = await axios.post('https://script.google.com/macros/s/AKfycbx9VpoHx_suctQ-8yKVHvRBuSWvjvGEzQ9SXDZK7yJP1RBS2KOp3m8xXxIEttTKetTr/exec', {
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



bot.onText(/📊 Статистика/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return;

  try {
    const [orderRes, userRes] = await Promise.all([
      axios.get('https://script.google.com/macros/s/AKfycbx9VpoHx_suctQ-8yKVHvRBuSWvjvGEzQ9SXDZK7yJP1RBS2KOp3m8xXxIEttTKetTr/exec?action=getStats', {
        params: { action: 'getStats' }
      }),
      axios.get('https://script.google.com/macros/s/AKfycbx9VpoHx_suctQ-8yKVHvRBuSWvjvGEzQ9SXDZK7yJP1RBS2KOp3m8xXxIEttTKetTr/exec?action=getUserOrderStats', {
        params: { action: 'getUserOrderStats' }
      })
    ]);

    const orders = orderRes.data;
    const users = userRes.data;

    // ✅ Перевірка на валідність
    if (!users || !Array.isArray(users.users)) {
      console.warn('⚠️ users.users не є масивом:', users);
      return bot.sendMessage(chatId, `⚠️ Дані користувачів не отримано або мають неправильний формат.`);
    }

   const header =
  `📊 Статистика замовлень:\n` +
  `🔢 Всього: ${orders.total} замовлень / ${orders.totalQuantity} уп.\n` +
  `✅ Прийнято: ${orders.accepted} / ${orders.acceptedQuantity} уп.\n` +
  `❌ Скасовано: ${orders.canceled}\n` +
  `⏳ Очікує: ${orders.pending}\n` +
  `📦 Відправлено: ${orders.sent} / ${orders.sentQuantity} уп.\n` +
  `💳 Оплачено: ${orders.paid} / ${orders.paidQuantity} уп.\n` +
  `💰 Заробіток: ${orders.profit.toLocaleString('uk-UA')} грн\n\n` +
  `👥 Статистика користувачів:\n` +
  `🔢 Всього: ${users.totalUsers}\n` +
  `📦 З замовленнями: ${users.withOrders}\n` +
  `🚫 Без замовлень: ${users.withoutOrders}\n\n` +
  `🧑‍💼 Статистика по операторах:\n` +
  (Array.isArray(users.operators)
    ? users.operators.map(op =>
        `👤 ${op.name} — 👥 ${op.totalUsers} корист., 📦 ${op.totalOrders} зам., ` +
        `${op.totalQuantity} уп., 💰 ${op.totalProfit.toLocaleString('uk-UA')} грн`
      ).join('\n')
    : '—');

bot.sendMessage(chatId, header);

// ✅ Формуємо список користувачів текстом
const userList = users.users.map(u =>
  `👤 ${u.name} (${u.town}) — останнє замовлення: ${u.lastOrderDate || 'ніколи'}, всього: ${u.totalOrders || 0} зам.`
).join('\n');

// ✅ Відправляємо одним повідомленням
bot.sendMessage(chatId, `${header}\n\n${userList}`);
  } catch (err) { 
    console.error('❌ Помилка отримання статистики:', err.message);
    bot.sendMessage(chatId, `⚠️ Не вдалося отримати статистику: ${err.message}`);
  }
});

bot.on('callback_query', async (query) => {
  try {
    const chatId = query.message?.chat?.id || query.from?.id; // ✅ fallback
    const data = query.data;

    if (!chatId) {
      console.warn('⚠️ callback_query без chatId:', query);
      if (query.id) {
        await bot.answerCallbackQuery(query.id, { text: '⚠️ Помилка: немає chatId', show_alert: true });
      }
      return;
    }

    if (!data) {
      console.warn('⚠️ callback_query без data:', query);
      if (query.id) {
        await bot.answerCallbackQuery(query.id, { text: '⚠️ Помилка: немає даних', show_alert: true });
      }
      return;
    }

    console.log('📥 Отримано callback_query:', { chatId, data });

    const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbx9VpoHx_suctQ-8yKVHvRBuSWvjvGEzQ9SXDZK7yJP1RBS2KOp3m8xXxIEttTKetTr/exec';


 if (query.data === 'confirm_broadcast') {
    broadcastMode = true;
    broadcastPayload = { text: null, photos: [], document: null, caption: null };
    await bot.sendMessage(chatId, `📢 Режим розсилки активовано. Надішліть контент і завершіть командою /sendbroadcast`);
  }

  if (query.data === 'cancel_broadcast') {
    broadcastMode = false;
    broadcastPayload = { text: null, photos: [], document: null, caption: null };
    await bot.sendMessage(chatId, `❌ Розсилка скасована.`);
  }



  // 💰 Оплата
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
    const operator = cachedUsers.find(u => String(u.chatId) === String(query.from?.id));
    const operatorName = operator?.name || query.from?.first_name || 'невідомо';

    try {
      await axios.post(SCRIPT_URL, {
        action: 'add',
        timestamp: order.timestamp,
        chatId,
        name: order.name,
        username: user.username,
        town: user.town || 'Невідомо',
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
        operatorName
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
      `📦 ${order.quantity} шт\n🏙 ${order.city}\n👤 ${order.name}\n📮 НП: ${order.np}\n📞 Телефон: ${order.phone}\n💰 Оплата: ${order.paymentMethod}`;

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

  // ✅ Отримуємо список користувачів
  let users = [];
  try {
    const userSheet = await axios.get(SCRIPT_URL, { params: { action: 'getUsers' } });
    users = userSheet.data?.users || [];
  } catch (err) {
    console.error('❌ Помилка отримання користувачів:', err.message);
  }

  // ✅ Верифікація
  if (typeof data === 'string' && data.startsWith('verify_')) {
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
  if (typeof data === 'string' && data.startsWith('msg_')) {
    const targetChatId = Number(data.split('_')[1]);
    pendingMessage[chatId] = targetChatId;

    await bot.sendMessage(chatId, `✉️ Напишіть відповідь для користувача ${targetChatId}`);
    await bot.answerCallbackQuery(query.id);
    return;
  }

  // ✍️ Відповідь користувачу
  if (typeof data === 'string' && data.startsWith('reply_')) {
    const targetChatId = data.split('_')[1];
    pendingReply[chatId] = targetChatId;

    const summary = getCustomerSummary?.(targetChatId, users) || targetChatId;
    await bot.sendMessage(chatId, `✍️ Введіть відповідь для користувача ${summary}`);
    await bot.answerCallbackQuery(query.id);
    return;
  }

  // ✅ Прийняти замовлення
  if (typeof data === 'string' && data.startsWith('accept_')) {
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
if (typeof data === 'string' && data.startsWith('cancel_')) {
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
 if (typeof data === 'string' && data.startsWith('ttn_')) {
  const [_, targetIdStr, timestampStr] = data.split('_');
  const targetId = Number(targetIdStr);
  const timestamp = Number(timestampStr);
  const orderId = `${targetId}_${timestamp}`;
  const order = ordersById[orderId];

  if (!order) {
    await bot.sendMessage(chatId, `❌ Замовлення не знайдено.`);
    return;
  }

  // 🔍 Перевірка: чи вже є ТТН
  if (order.ttn) {
    await bot.sendMessage(chatId, `✅ ТТН вже введено: ${order.ttn}`);
    return;
  }

  pendingTTN[chatId] = { targetId, timestamp };

  const summary = getCustomerSummary(targetId, users, order);
  await bot.sendMessage(chatId, `✍️ Введіть номер ТТН для користувача ${summary}`);
  await bot.answerCallbackQuery(query.id);

  const updatedKeyboard = getOrderKeyboard(order);

  for (const msg of order.adminMessages || []) {
    try {
      await bot.editMessageReplyMarkup(updatedKeyboard, {
        chat_id: msg.chatId,
        message_id: msg.messageId
      });
    } catch (err) {
      if (!err.message.includes('message is not modified')) {
        console.error('❌ Помилка оновлення клавіатури:', err.message);
      }
    }
  }

  return;
}


// 💳 Позначити як оплачено
  if (typeof data === 'string' && data.startsWith('paid_')) {
  const [_, targetIdStr, timestampStr] = data.split('_');
  const targetId = Number(targetIdStr);
  const timestamp = Number(timestampStr);
  const orderId = `${targetId}_${timestamp}`;
  const order = ordersById[orderId];

  if (!order) {
    await bot.sendMessage(chatId, `❌ Замовлення не знайдено: ${orderId}`);
    return;
  }

  // 🔍 Перевірка: чи вже оплачено
  if (order.paymentStatus === 'оплачено') {
    await bot.sendMessage(chatId, `✅ Статус вже оновлено: *оплачено*`, { parse_mode: 'Markdown' });
    return;
  }

  order.paymentStatus = 'оплачено';
  order.chatId = targetId;
  order.timestamp = timestamp;

  try {
    await axios.post(SCRIPT_URL, {
      action: 'updatePayment',
      timestamp,
      chatId: targetId,
      paymentStatus: 'оплачено'
    });

    const updatedKeyboard = getOrderKeyboard(order);

    for (const msg of order.adminMessages || []) {
      try {
        await bot.editMessageReplyMarkup(updatedKeyboard, {
          chat_id: msg.chatId,
          message_id: msg.messageId
        });
      } catch (err) {
        if (!err.message.includes('message is not modified')) {
          console.error('❌ Помилка оновлення клавіатури:', err.message);
        }
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
  } catch (err) {
    console.error('❌ Помилка у callback_query:', err.message, err.stack);
    if (query.id) {
      await bot.answerCallbackQuery(query.id, { text: '⚠️ Внутрішня помилка', show_alert: true });
    }
  }
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = typeof msg.text === 'string' ? msg.text : ''; // ✅ захист від undefined
  const caption = typeof msg.caption === 'string' ? msg.caption : ''; // ✅ оголошуємо
  const { first_name, username } = msg.from || {};
  const userIsAdmin = isAdmin(chatId);
  const isUserVerified = isVerified(chatId);
  const user = cachedUsers.find(u => String(u.chatId) === String(chatId)) || {};

  if (text === '/adminpanel') return;

  console.log(`📩 Повідомлення від ${chatId} (@${username}) | isAdmin=${userIsAdmin} | isVerified=${isUserVerified} | text="${text}"`);
  console.log('📥 Отримано повідомлення:', {
    chatId,
    text,
    caption,
    hasPhoto: !!msg.photo,
    hasDocument: !!msg.document,
    hasSticker: !!msg.sticker,
    hasContact: !!msg.contact
  });
   // Якщо це не команда (типу /start) і користувач верифікований
  if (typeof msg.text === 'string' && !msg.text.startsWith('/') && isVerified(chatId) && !shownMenuOnce.has(chatId)) {
    const keyboard = getMainKeyboard(chatId);
    if (keyboard) {
      await bot.sendMessage(chatId, '📲 Головне меню доступне:', keyboard);
      shownMenuOnce.add(chatId);
    }
  }

  // 🔘 /start — запуск верифікації або головного меню
  if (text === '/start') {
    if (isUserVerified) {
      await bot.sendMessage(chatId, `👋 Ви вже верифіковані.`, getMainKeyboard(chatId));
    } else {
      verificationRequests[chatId] = {
        step: 1,
        createdAt: Date.now(),
        username: username || 'невідомо',
        name: first_name || 'Невідомо'
      };
      await bot.sendMessage(chatId, `🔐 Для доступу до бота, будь ласка, введіть Ваше ПІБ:`);
    }
    return;
  }

  // ✉️ Надсилання повідомлення користувачу
  if (userIsAdmin && pendingMessage[chatId]) {
    const targetId = pendingMessage[chatId];

    try {
      await bot.sendMessage(targetId, `📩 Повідомлення від адміністратора:\n\n${text}`);
      await bot.sendMessage(chatId, `✅ Повідомлення надіслано.`);
    } catch (err) {
      console.error('❌ Не вдалося надіслати повідомлення:', err.message);
      await bot.sendMessage(chatId, `❌ Не вдалося надіслати повідомлення: ${err.message}`);
    }

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
    await bot.sendMessage(chatId, `🔒 Ви ще не верифіковані. Натисніть /start або зверніться до оператора.`);
    return;
  }
if (text.trim() !== '') {
    if (text === '🔙 Назад до користувацького меню') {
      await bot.sendMessage(chatId, `🔄 Повертаємось до головного меню.`, getMainKeyboard(chatId));
      return;
    }

    if (text.startsWith('/')) {
      // тут обробка команд
      return;
    }

    if (isVerified(chatId) && !shownMenuOnce.has(chatId)) {
      await bot.sendMessage(chatId, `📲 Головне меню`, getMainKeyboard(chatId));
      shownMenuOnce.add(chatId);
      return;
    }
  } else {
    console.log('⚠️ msg.text відсутній або порожній, тип повідомлення:', Object.keys(msg));
  }

  // 🔹 Якщо прийшло фото
  if (msg.photo && !broadcastMode) {
    await bot.sendMessage(chatId, '🖼 Ви надіслали фото. Дякуємо!');
    return;
  }

  // 🔹 Якщо прийшов документ
  if (msg.document && !broadcastMode) {
    await bot.sendMessage(chatId, '📄 Ви надіслали документ. Дякуємо!');
    return;
  }

  // 🔹 Якщо прийшов стікер
  if (msg.sticker && !broadcastMode) {
    await bot.sendMessage(chatId, '😄 Гарний стікер!');
    return;
  }

  // 🔹 Якщо прийшов контакт
  if (msg.contact && !broadcastMode) {
    await bot.sendMessage(chatId, `📞 Контакт отримано: ${msg.contact.phone_number}`);
    return;
  }
// 📢 Режим розсилки

  if (isAdmin(chatId) && broadcastMode) {

       if (text.startsWith('/')) {
        // якщо це команда, не додаємо у payload
        return;
    }
    // 📸 Альбом (media_group_id)
    if (msg.media_group_id) {
      if (!mediaGroups[msg.media_group_id]) {
        mediaGroups[msg.media_group_id] = [];
      }

      const fileId = msg.photo[msg.photo.length - 1].file_id;
      mediaGroups[msg.media_group_id].push({ fileId, caption });

      // невелика затримка щоб дочекатись усіх фото альбому
      setTimeout(() => {
        if (mediaGroups[msg.media_group_id]) {
          broadcastPayload.photos = mediaGroups[msg.media_group_id].map(p => p.fileId);
          broadcastPayload.caption = mediaGroups[msg.media_group_id][0].caption || '';
          delete mediaGroups[msg.media_group_id];
          bot.sendMessage(chatId, `🖼 Альбом з ${broadcastPayload.photos.length} фото додано. Напишіть /sendbroadcast для запуску.`);
        }
      }, 1000);
      return;
    }

    // 📸 Одиночне фото
    if (msg.photo) {
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      broadcastPayload.photos.push(fileId);

      if (caption.trim() !== '') {
        broadcastPayload.caption = caption;
      }

      await bot.sendMessage(chatId, `🖼 Фото додано${broadcastPayload.caption ? ' з текстом' : ''}. Напишіть /sendbroadcast для запуску.`);
      return;
    }

    // 📄 Документ
    if (msg.document) {
      const fileId = msg.document.file_id;
      broadcastPayload.document = fileId;

      if (caption.trim() !== '') {
        broadcastPayload.caption = caption;
      }

      await bot.sendMessage(chatId, `📄 Документ додано${broadcastPayload.caption ? ' з текстом' : ''}. Напишіть /sendbroadcast для запуску.`);
      return;
    }

    // ✉️ Текст
    if (text.trim() !== '' && !text.startsWith('/')) {
      broadcastPayload.text = text;
      await bot.sendMessage(chatId, `✉️ Текст збережено. Напишіть /sendbroadcast для запуску.`);
      return;
    }
  }



  // 🔹 Якщо нічого з вище
  //ait bot.sendMessage(chatId, 'ℹ️ Повідомлення отримано, але я його не можу обробити.');


// ❓ Задати запитання
if (text === '❓ Задати запитання') {
  await bot.sendMessage(chatId, `✍️ Напишіть своє запитання, і оператор відповість найближчим часом.`);
  activeOrders[chatId] = { questionMode: true };
  return;
}

// 📞 Зв’язатися з оператором
if (text === '📞 Зв’язатися з оператором') {
  await bot.sendMessage(chatId, `📞 Ви можете зв’язатися з оператором напряму:`);
  await bot.sendContact(chatId, '+380504366713', 'Оператор');
  return;
}

// 📬 Відповідь адміністратора
if (userIsAdmin && pendingReply[chatId]) {
  const targetChatId = pendingReply[chatId];

  try {
    await bot.sendMessage(targetChatId, `📩 Відповідь від оператора:\n\n${text}`);
    await bot.sendMessage(chatId, `✅ Відповідь надіслано.`);

    const index = pendingMessages.findIndex(m => m.chatId === targetChatId);
    if (index !== -1) pendingMessages.splice(index, 1);

    delete pendingReply[chatId];
  } catch (err) {
    console.error('❌ Не вдалося надіслати відповідь:', err.message);
    await bot.sendMessage(chatId, `❌ Не вдалося надіслати відповідь: ${err.message}`);
  }

  return;
}

  // ❓ Обробка запитання користувача
if (activeOrders[chatId]?.questionMode) {
  pendingMessages.push({ chatId, username: user?.username || 'невідомо', text });
  delete activeOrders[chatId];
  await bot.sendMessage(chatId, `✅ Ваше запитання надіслано оператору.`);

  adminChatIds.forEach(id => {
    if (!id || isNaN(id)) return;
    bot.sendMessage(id, `❓ Запитання від @${user?.name || 'невідомо'}:\n${text}`, {
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
  const order = ordersById[orderId];

  if (!order) {
    await bot.sendMessage(chatId, `❌ Замовлення не знайдено.`);
    delete pendingTTN[chatId];
    return;
  }

  order.ttn = text;
  order.status = 'відправлено';
  order.chatId = targetId;
  order.timestamp = timestamp;

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
    await axios.post(SCRIPT_URL, {
      action: 'updateTTN',
      timestamp: order.timestamp,
      chatId: targetId,
      ttn: text,
      status: 'відправлено'
    });

    await bot.sendMessage(targetId, userMessage);
    await bot.sendMessage(chatId, adminMessage);

    const updatedKeyboard = getOrderKeyboard(order);

    for (const msg of order.adminMessages || []) {
      await bot.editMessageReplyMarkup(updatedKeyboard, {
        chat_id: msg.chatId,
        message_id: msg.messageId
      });
    }
  } catch (err) {
    console.error('❌ Помилка надсилання ТТН:', err.message);
    await bot.sendMessage(chatId, `⚠️ Не вдалося надіслати ТТН: ${err.message}`);
  }

  delete pendingTTN[chatId];
  return;
}

// 🛒 Початок замовлення
if (text === '🛒 Зробити замовлення') {
  activeOrders[chatId] = {};
  await bot.sendMessage(chatId, `📦 Скільки одиниць товару бажаєте замовити?`);
  return;
}

// 🧾 Обробка замовлення
const order = activeOrders[chatId];
if (order) {
  if (!order.quantity) {
    if (!/^\d+$/.test(text)) {
      await bot.sendMessage(chatId, `❗ Введіть кількість у вигляді числа (наприклад: 1, 2, 3...)`);
      return;
    }
    order.quantity = Number(text); // ✅ краще зберігати як число
    await bot.sendMessage(chatId, `🏙 Вкажіть місто доставки:`);
    return;
  }

  if (!order.city) {
    order.city = text;
    await bot.sendMessage(chatId, `👤 Вкажіть ПІБ отримувача:`);
    return;
  }

  if (!order.name) {
    order.name = text;
    await bot.sendMessage(chatId, `📮 Вкажіть номер відділення Нової Пошти:`);
    return;
  }

  if (!order.np) {
    order.np = text;
    await bot.sendMessage(chatId, `📞 Вкажіть ваш номер телефону для зв’язку:`);
    order.phone = '__awaiting__';
    return;
  }

  if (order.phone === '__awaiting__') {
    if (!/^(\+380|0)\d{9}$/.test(text)) {
      await bot.sendMessage(chatId, `❗ Будь ласка, введіть коректний номер телефону.`);
      return;
    }

    order.phone = text;

    await bot.sendMessage(chatId, `💰 Оберіть спосіб оплати:`, {
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

// ✅ ПІБ оператора (якщо треба саме ім’я оператора, краще msg.from.first_name)
const operatorName = msg.from?.first_name || user.name || 'невідомо';

await bot.sendMessage(chatId, 
  `✅ Замовлення очікує обробки!\n\n📦 Кількість: ${order.quantity}\n🏙 Місто: ${order.city}\n👤 ПІБ: ${order.name}\n📮 НП: ${order.np}\n📞 Телефон: ${order.phone}`
);

// 📤 Надсилання в Google Таблицю
try {
  await axios.post(SCRIPT_URL, {
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
adminChatIds.forEach(async id => {
  if (!id || isNaN(id)) return;

  await bot.sendMessage(id,
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

  await bot.sendMessage(chatId, found ? report : '📭 Немає замовлень.');
  return;
}

// 📢 Зробити розсилку
if (userIsAdmin && text === '📢 Зробити розсилку') {
  broadcastMode = true;
  broadcastPayload = {};
  await bot.sendMessage(chatId, `📢 Введіть текст повідомлення або надішліть фото. Коли будете готові — напишіть /sendbroadcast`);
  return;
}

// 📩 Відповісти користувачу
if (userIsAdmin && text === '📩 Відповісти користувачу') {
  if (pendingMessages.length === 0) {
    await bot.sendMessage(chatId, `📭 Немає нових запитань від користувачів.`);
    return;
  }

  const next = pendingMessages[0];
  currentReplyTarget = next.chatId;
  const name = next.name || 'Невідомо';
  const town = next.town || 'Невідомо';
  await bot.sendMessage(chatId, `✍️ Відповідаєте користувачу ${name}, ${town} (@${next.username}):\n\n"${next.text}"`);
  return;
}

// 🚚 Підтвердити доставку
if (userIsAdmin && text === '🚚 Підтвердити доставку') {
  await bot.sendMessage(chatId, `📦 Натисніть кнопку "📦 Надіслати ТТН" під замовленням, щоб ввести номер.`);
  return;
}

// 🔙 Назад до користувацького меню
if (text === '🔙 Назад до користувацького меню') {
  await bot.sendMessage(chatId, `🔄 Повертаємось до головного меню.`, getMainKeyboard(chatId));
  return;
}

// 🧼 Catch-all: якщо нічого не спрацювало
//if (typeof text === 'string' && text.trim() !== '' && !text.startsWith('/')) {
//  await bot.sendMessage(chatId, `🤖 Не впізнаю команду. Оберіть опцію з меню нижче:`, getMainKeyboard(chatId));

});