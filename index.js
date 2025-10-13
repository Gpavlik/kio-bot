require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

const adminChatId = Number(process.env.ADMIN_CHAT_ID);
const users = {
  [adminChatId]: {
    name: 'Адміністратор',
    username: 'admin',
    orders: [],
    verificationRequested: false
  }
};

const activeOrders = {};
const verifiedUsers = new Set([adminChatId]);
const verificationRequests = {};
const pendingMessages = [];
let currentReplyTarget = null;
const pendingTTN = {};


// 🧾 Головна клавіатура
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

// 🚀 Старт
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const { first_name, username } = msg.from;

  if (!users[chatId]) {
    users[chatId] = {
      name: first_name || 'Невідомо',
      username: username || 'невідомо',
      orders: [],
      verificationRequested: false
    };
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

// 💬 Обробка повідомлень
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const isAdmin = chatId === adminChatId;
  if (!text) return;

  // 🔐 Верифікація
if (!verifiedUsers.has(chatId) && !isAdmin) {
  const request = verificationRequests[chatId];
  if (!request) return;

  if (Date.now() - request.createdAt > 24 * 60 * 60 * 1000) {
    delete verificationRequests[chatId];
    users[chatId].verificationRequested = false;
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

// ❓ Запитання в режимі questionMode
if (activeOrders[chatId]?.questionMode) {
  pendingMessages.push({
    chatId,
    username: users[chatId].username,
      text
    });
    delete activeOrders[chatId];
    bot.sendMessage(chatId, `✅ Ваше запитання надіслано оператору.`);
    bot.sendMessage(adminChatId, `❓ Запитання від @${users[chatId].username}:\n${text}`, {
      reply_markup: {
        inline_keyboard: [[
          { text: '✍️ Відповісти', callback_data: `reply_${chatId}` }
        ]]
      }
    });
    return;
  }

  // 📩 Команда "Відповісти користувачу"
  if (isAdmin && text === '📩 Відповісти користувачу') {
    if (pendingMessages.length === 0) {
      bot.sendMessage(chatId, '✅ Немає запитів без відповіді.');
      return;
    }

    pendingMessages.forEach((req) => {
      bot.sendMessage(chatId, `🧾 Запит від @${req.username}:\n\n${req.text}`, {
        reply_markup: {
          inline_keyboard: [[
            { text: '✍️ Відповісти', callback_data: `reply_${req.chatId}` }
          ]]
        }
      });
    });
    return;
  }

  // ✍️ Відповідь оператора
  if (isAdmin && currentReplyTarget) {
    bot.sendMessage(currentReplyTarget, `📬 Відповідь від оператора:\n\n${text}`);
    bot.sendMessage(chatId, `✅ Відповідь надіслано.`);

    const index = pendingMessages.findIndex(m => m.chatId === currentReplyTarget);
    if (index !== -1) pendingMessages.splice(index, 1);

    currentReplyTarget = null;
    return;
  }

// 🔘 Обробка інлайн-кнопок
bot.on('callback_query', (query) => {
  const data = query.data;

  if (data.startsWith('verify_')) {
    const chatId = parseInt(data.split('_')[1], 10);
    verifiedUsers.add(chatId);
    delete verificationRequests[chatId];
    users[chatId].verificationRequested = false;
    bot.sendMessage(chatId, `✅ Доступ надано. Ви можете користуватись ботом.`, getMainKeyboard(chatId));
    bot.answerCallbackQuery(query.id);
    return;
  }

  if (data.startsWith('reply_')) {
    currentReplyTarget = parseInt(data.split('_')[1], 10);
    bot.sendMessage(adminChatId, `✍️ Напишіть відповідь для користувача ${currentReplyTarget}`);
    bot.answerCallbackQuery(query.id);
    return;
  }
});

  // 🛒 Старт замовлення
  if (text === '🛒 Зробити замовлення') {
    activeOrders[chatId] = {};
    bot.sendMessage(chatId, `📦 Скільки одиниць товару бажаєте замовити?`);
    return;
  }

  // ❌ Скасувати
  if (text === '❌ Скасувати') {
    const user = users[chatId];
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

   axios.post('https://script.google.com/macros/s/AKfycbwOYG4ZyY4e5UB9AV8Jb6jWRAHWHVQWvym2tnXo3JPraY3LbRm3X9ubwpbaPlnJxkdG/exec', {
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

  // 📜 Історія замовлень
  if (text === '📜 Історія замовлень') {
    const user = users[chatId];
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

  // 🛠 Інформаційні кнопки
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
if (text === '📁 Клінічні випадки') {
  bot.sendMessage(chatId, '📄 Натисніть кнопку нижче, щоб завантажити PDF:', {
    reply_markup: {
      inline_keyboard: [[
        { text: '⬇️ Завантажити PDF', url: 'https://drive.google.com/file/d/1MmwidOi8dMMAP40413FgnDB-NwZPbMT9/view?usp=drive_link' }
      ]]
    }
  });
  return;
}

});
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!activeOrders[chatId] || activeOrders[chatId].questionMode) return;

  const order = activeOrders[chatId];

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

    axios.post('https://script.google.com/macros/s/AKfycbwOYG4ZyY4e5UB9AV8Jb6jWRAHWHVQWvym2tnXo3JPraY3LbRm3X9ubwpbaPlnJxkdG/exec', {
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
});

bot.on('callback_query', (query) => {
  const data = query.data;
  const adminId = query.message.chat.id;

  if (data.startsWith('ttn_')) {
    const [_, targetId, timestamp] = data.split('_');
    pendingTTN[adminId] = { targetId, timestamp };
    bot.sendMessage(adminId, `✍️ Введіть номер ТТН для користувача ${targetId}:`);
    bot.answerCallbackQuery(query.id);
    return;
  }

  // інші callback'и...
});

bot.on('message', (msg) => {
  const adminId = msg.chat.id;
  const text = msg.text;

  if (pendingTTN[adminId]) {
    const { targetId, timestamp } = pendingTTN[adminId];

    bot.sendMessage(targetId, `🚚 Ваше замовлення відправлено!\n📦 Номер ТТН: ${text}`);
    bot.sendMessage(adminId, `✅ ТТН надіслано користувачу @${users[targetId].username} (${targetId})`);
    
    // (опціонально) зберегти ТТН у orders
    const userOrders = users[targetId]?.orders || [];
    const order = userOrders.find(o => o.timestamp == timestamp);
    if (order) order.ttn = text;

    delete pendingTTN[adminId];
    return;
  }

  // інші повідомлення...
});



bot.on('callback_query', (query) => {
  const data = query.data;

  // 🔐 Верифікація
  if (data.startsWith('verify_')) {
    const targetId = parseInt(data.split('_')[1], 10);
    const request = verificationRequests[targetId];
    if (!request || !users[targetId]) {
      bot.answerCallbackQuery(query.id, { text: '⛔️ Запит не знайдено.' });
      return;
    }
if (data.startsWith('reply_')) {
  currentReplyTarget = parseInt(data.split('_')[1], 10);
  bot.sendMessage(adminChatId, `✍️ Напишіть відповідь для користувача ${currentReplyTarget}`);
  bot.answerCallbackQuery(query.id);
  return;
}
    verifiedUsers.add(targetId);
    users[targetId].verificationRequested = false;

    axios.post('https://script.google.com/macros/s/AKfycbwOYG4ZyY4e5UB9AV8Jb6jWRAHWHVQWvym2tnXo3JPraY3LbRm3X9ubwpbaPlnJxkdG/exec', {
      action: 'addUser',
      timestamp: Date.now(),
      chatId: targetId,
      name: request.name,
      username: users[targetId].username,
      phone: request.phone,
      town: request.town,
      workplace: request.workplace,
      verifierName: request.verifierName // 👈 Додано ПІБ співробітника
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

    axios.post('https://script.google.com/macros/s/AKfycbwOYG4ZyY4e5UB9AV8Jb6jWRAHWHVQWvym2tnXo3JPraY3LbRm3X9ubwpbaPlnJxkdG/exec', {
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

    axios.post('https://script.google.com/macros/s/AKfycbwOYG4ZyY4e5UB9AV8Jb6jWRAHWHVQWvym2tnXo3JPraY3LbRm3X9ubwpbaPlnJxkdG/exec', {
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

  // ✍️ Відповідь оператором
  if (data.startsWith('reply_')) {
    currentReplyTarget = parseInt(data.split('_')[1], 10);
    bot.sendMessage(adminChatId, `✍️ Напишіть відповідь для користувача ${currentReplyTarget}`);
    bot.answerCallbackQuery(query.id);
    return;
  }
});

bot.onText(/\/adminpanel/, (msg) => {
  const chatId = msg.chat.id;
  if (chatId !== adminChatId) {
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

bot.onText(/\/reply (\d+) (.+)/, (msg, match) => {
  if (msg.chat.id !== adminChatId) return;
  const targetId = parseInt(match[1], 10);
  const replyText = match[2];
  bot.sendMessage(targetId, `📩 Повідомлення від оператора:\n${replyText}`);
  bot.sendMessage(adminChatId, `✅ Відповідь надіслано.`);
});

bot.onText(/\/send (\d+)/, (msg, match) => {
  if (msg.chat.id !== adminChatId) return;
  const targetId = parseInt(match[1], 10);
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
  axios.post('https://script.google.com/macros/s/AKfycbwOYG4ZyY4e5UB9AV8Jb6jWRAHWHVQWvym2tnXo3JPraY3LbRm3X9ubwpbaPlnJxkdG/exec', {
    action: 'updateStatus',
    timestamp: order.timestamp,
    chatId: chatId,
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

bot.onText(/\/verify (\d+)/, (msg, match) => {
  if (msg.chat.id !== adminChatId) return;
  const targetId = parseInt(match[1], 10);
  verifiedUsers.add(targetId);
  if (users[targetId]) users[targetId].verificationRequested = false;
  bot.sendMessage(adminChatId, `✅ Користувач ${targetId} верифікований.`);
  bot.sendMessage(targetId, `🔓 Вам надано доступ до бота. Можете почати користування.`, getMainKeyboard(targetId));
});

bot.onText(/\/unverify (\d+)/, (msg, match) => {
  if (msg.chat.id !== adminChatId) return;
  const targetId = parseInt(match[1], 10);
  verifiedUsers.delete(targetId);
  bot.sendMessage(adminChatId, `🚫 Користувач ${targetId} більше не має доступу.`);
  bot.sendMessage(targetId, `🔒 Ваш доступ до бота було відкликано оператором.`);
});
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
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
bot.on("polling_error", (error) => {
  console.error("❌ Polling error:", error.message);
});

console.log('🤖 Бот запущено...');
bot.sendMessage(adminChatId, '🤖 Бот запущено і готовий до роботи.');
