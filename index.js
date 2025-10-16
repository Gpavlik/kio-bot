require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { getUsersFromSheet, isVerified: isVerifiedFromSheet} = require('./googleSheets');

const token = process.env.BOT_TOKEN;
const adminChatId = Number(process.env.ADMIN_CHAT_ID);
const bot = new TelegramBot(token, { polling: true });
// 🧠 Менеджер користувачів
const {
  loadUsers,
  updateUser,
  isVerified,
  getUser,
  users,
  verifiedUsers
} = require('./userManager');

loadUsers(); // ⏱️ Зчитати користувачів при запуску
const verificationRequests = {};
const activeOrders = {};
const pendingMessages = [];
const pendingTTN = {};
let currentReplyTarget = null;
const lastSent = {};

// 🎛️ Головна клавіатура
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

// 🕒 Захист від спаму
function safeSend(chatId, text, options) {
  const now = Date.now();
  if (!lastSent[chatId] || now - lastSent[chatId] > 5000) {
    bot.sendMessage(chatId, text, options);
    lastSent[chatId] = now;
  }
}
// 🚀 Старт
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const { first_name, username } = msg.from;

  try {
    const verified = await isVerified(chatId);

    if (!verified) {
      bot.sendMessage(chatId, `🔐 Для доступу до бота, будь ласка, введіть Ваше ПІБ:`);
      verificationRequests[chatId] = {
        step: 1,
        createdAt: Date.now(),
        username: username || 'невідомо'
      };
      return;
    }

    verifiedUsers.add(chatId);
    users[chatId] = users[chatId] || {
      name: first_name || 'Невідомо',
      username: username || 'невідомо',
      orders: [],
      verificationRequested: false
    };

    bot.sendMessage(
      chatId,
      `Вітаємо, ${first_name || 'користувачу'}! Я бот для замовлення продукту Kiomedine. Щоб почати, оберіть опцію з клавіатури нижче:`,
      getMainKeyboard(chatId)
    );
  } catch (error) {
    console.error('Помилка при перевірці доступу:', error);
    bot.sendMessage(chatId, `⚠️ Виникла помилка при перевірці доступу. Спробуйте пізніше.`);
  }
});
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  const user = getUser(chatId);
  const isUserVerified = isVerified(chatId);

  // ✅ Дозволити /start навіть не верифікованим
  if (text === '/start') {
    if (isUserVerified) {
      bot.sendMessage(chatId, `👋 Ви вже верифіковані.`, getMainKeyboard(chatId));
    } else {
      verificationRequests[chatId] = {
        name: msg.from.first_name,
        username: msg.from.username
      };
      bot.sendMessage(adminChatId, `📥 Запит на верифікацію від @${msg.from.username} (${chatId})`, {
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Надати доступ', callback_data: `verify_${chatId}` }
          ]]
        }
      });
      bot.sendMessage(chatId, `⏳ Очікуйте підтвердження від адміністратора.`);
    }
    return;
  }

  // 🔒 Блокувати все інше, якщо не верифікований
  if (!isUserVerified) {
    bot.sendMessage(chatId, `🔒 Ви ще не верифіковані. Натисніть /start або зверніться до оператора.`);
    return;
  }

  // ✅ Верифікований користувач — обробляємо далі
  bot.sendMessage(chatId, `👋 Вітаю, ${user.name}!`, getMainKeyboard(chatId));



  // 🔐 Верифікація
  if (!verifiedUsers.has(chatId) && !isAdmin) {
    const request = verificationRequests[chatId];
    if (!request) return;

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

        bot.sendMessage(adminChatId, `🔐 Запит на верифікацію:\n👤 ${request.name}\n📞 ${request.phone}\n🏙️ ${request.town}\n🏢 ${request.workplace}\n👤 Співробітник: ${request.verifierName}\n🆔 chatId: ${chatId}`, {
          reply_markup: {
            inline_keyboard: [[{ text: '✅ Надати доступ', callback_data: `verify_${chatId}` }]]
          }
        });
        return;
    }
    return;
  }

  // ❓ Задати запитання
  if (activeOrders[chatId]?.questionMode) {
    pendingMessages.push({ chatId, username: user?.username || 'невідомо', text });
    delete activeOrders[chatId];
    bot.sendMessage(chatId, `✅ Ваше запитання надіслано оператору.`);
    bot.sendMessage(adminChatId, `❓ Запитання від @${user?.username || 'невідомо'}:\n${text}`, {
      reply_markup: {
        inline_keyboard: [[{ text: '✍️ Відповісти', callback_data: `reply_${chatId}` }]]
      }
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

  // 🛒 Старт замовлення
  if (text === '🛒 Зробити замовлення') {
    activeOrders[chatId] = {};
    bot.sendMessage(chatId, `📦 Скільки одиниць товару бажаєте замовити?`);
    return;
  }
});

// 📦 Обробка замовлення
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const user = users[chatId];
  const order = activeOrders[chatId];
  const isAdmin = chatId === adminChatId;

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

      axios.post('https://script.google.com/macros/s/AKfycbwkrfLvG2rOzbu2CJNBGk20_wWoBE7ZEc_1qDIdXZbaqzyqoAAHmtvpDCadEUNtyU1h/exec', {
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

  // 📦 Введення ТТН
if (isAdmin && pendingTTN[chatId]) {
  const { targetId, timestamp } = pendingTTN[chatId];
  const user = users[targetId];
  const order = user?.orders?.find(o => o.timestamp == Number(timestamp));

  if (!order) {
    bot.sendMessage(chatId, `❌ Замовлення не знайдено для ТТН.`);
    delete pendingTTN[chatId];
    return;
  }

  order.ttn = text;

  try {
    await axios.post('https://script.google.com/macros/s/AKfycbwkrfLvG2rOzbu2CJNBGk20_wWoBE7ZEc_1qDIdXZbaqzyqoAAHmtvpDCadEUNtyU1h/exec', {
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
    bot.sendMessage(chatId, `Остеоартрит — дегенеративне захворювання, що супроводжується підвищеним тертям у суглобах, болем і функціональними порушеннями. Однією з причин є окислювальне руйнування ендогенних мастильних полімерів (гіалуронатів) під дією вільних радикалів.
KioMedinevsOne — засіб для підвищення в’язкості синовіальної рідини, призначений для внутрішньосуглобових ін’єкцій. Основний компонент — лінійне (незшите) похідне хітозану нетваринного походження, отримане з печериці Agaricus bisporus та модифіковане запатентованою технологією.
Препарат забезпечує змащення, знижує тертя, нейтралізує вільні радикали та зменшує вплив окисного стресу на суглоб. Після введення його компоненти розкладаються в організмі та є нетоксичними для тканин.`);
    return;
  }

  // 📦 Склад
  if (text === '📦 Склад') {
    bot.sendMessage(chatId, `Кожна упаковка KioMedinevsOne містить один попередньо наповнений шприц з 3 ml (мл)
стерильного розчину, упакований у блістер, інструкцію щодо застосування та етикетки.
В 1 ml (мл) розчину міститься 20 mg (мг) похідного хітозану, 35 mg (мг) сорбіту та
фосфатна-буферна вода для ін'єкцій qs (рН 7,2 ± 0,2, 270-330 mOsmol/kg (мОсмоль/кг)).
Попередньо наповнений шприц призначений лише для одноразового використання.`);
    return;
  }

  // ⚙️ Ефект
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

  // ⚠️ Увага
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

  // 📝 Застосування
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
// $ Ціна
  if (text === '$ Ціна') {
    bot.sendMessage(chatId, `Ціна за 1 упаковку (3 ml) KioMedinevsOne становить 8500 грн.`);
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
  }});
bot.on('callback_query', async (query) => {
  const data = query.data;
  const adminId = query.message.chat.id;

  // 🔐 Верифікація
  if (data.startsWith('verify_')) {
  const targetId = parseInt(data.split('_')[1], 10);
  const request = verificationRequests[targetId];

  updateUser(targetId, {
    name: request?.name || 'Невідомо',
    username: request?.username || 'невідомо',
    verified: true,
    orders: []
  });

  bot.sendMessage(targetId, `🔓 Вам надано доступ до бота.`, getMainKeyboard(targetId));
  bot.sendMessage(adminChatId, `✅ Доступ надано користувачу @${request?.username} (${targetId})`);
  bot.answerCallbackQuery(query.id, { text: 'Доступ надано ✅' });
  delete verificationRequests[targetId];
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
      await axios.post('https://script.google.com/macros/s/AKfycbwOYG4ZyY4e5UB9AV8Jb6jWRAHWHVQWvym2tnXo3JPraY3LbRm3X9ubwpbaPlnJxkdG/exec', {
        action: 'updateStatus',
        timestamp: order.timestamp,
        chatId: targetId,
        status: 'прийнято'
      });

      bot.sendMessage(targetId, `🚚 Ваше замовлення прийнято і вже в дорозі!`);
      bot.sendMessage(adminChatId, `✅ Замовлення від @${user.username} позначено як "прийнято".`);
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
    const user = users[targetId];
    const order = user?.orders?.find(o => o.timestamp == Number(timestamp));
    if (!order || order.status === 'прийнято') {
      bot.answerCallbackQuery(query.id, { text: '⛔️ Не можна скасувати прийняте замовлення.' });
      return;
    }

    order.status = 'скасовано';

    try {
      await axios.post('https://script.google.com/macros/s/AKfycbwOYG4ZyY4e5UB9AV8Jb6jWRAHWHVQWvym2tnXo3JPraY3LbRm3X9ubwpbaPlnJxkdG/exec', {
        action: 'updateStatus',
        timestamp: order.timestamp,
        chatId: targetId,
        status: 'скасовано'
      });

      bot.sendMessage(targetId, `❌ Ваше замовлення було скасовано оператором.`);
      bot.sendMessage(adminChatId, `❌ Замовлення від @${user.username} було скасовано.`);
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
  if (chatId !== adminChatId) {
    bot.sendMessage(chatId, '⛔️ У вас немає доступу до панелі оператора.');
    return;
  }

  bot.sendMessage(chatId, `👨‍💼 Панель оператора активна. Оберіть дію:`, {
    reply_markup: {
      keyboard: [
        ['📋 Переглянути всі замовлення'],
        ['📩 Відповісти користувачу', '🚚 Підтвердити доставку'],
        ['📊 Статистика', '🔙 Назад до користувацького меню']
      ],
      resize_keyboard: true
    }
  });
});

// ✅ Верифікація вручну
bot.onText(/\/verify (\d+)/, (msg, match) => {
  if (msg.chat.id !== adminChatId) return;
  const targetId = parseInt(match[1], 10);

  verifiedUsers.add(targetId);
  users[targetId] = users[targetId] || {
    name: 'Невідомо',
    username: 'невідомо',
    orders: [],
    verificationRequested: false
  };
  users[targetId].justVerified = true;

  bot.sendMessage(adminChatId, `✅ Користувач ${targetId} верифікований.`);
  bot.sendMessage(targetId, `🔓 Вам надано доступ до бота. Можете почати користування.`, getMainKeyboard(targetId));
});

// 🚫 Відкликання доступу
bot.onText(/\/unverify (\d+)/, (msg, match) => {
  const targetId = parseInt(match[1], 10);
  if (msg.chat.id !== adminChatId) return;

  verifiedUsers.delete(targetId);
  bot.sendMessage(adminChatId, `🚫 Користувач ${targetId} більше не має доступу.`);
  bot.sendMessage(targetId, `🔒 Ваш доступ до бота було відкликано оператором.`);
});

// ✍️ Відповідь оператором через /reply
bot.onText(/\/reply (\d+) (.+)/, (msg, match) => {
  if (msg.chat.id !== adminChatId) return;
  const targetId = parseInt(match[1], 10);
  const replyText = match[2];
  bot.sendMessage(targetId, `📩 Повідомлення від оператора:\n${replyText}`);
  bot.sendMessage(adminChatId, `✅ Відповідь надіслано.`);
});

// 🚚 Підтвердження доставки через /send
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
    order.status = 'прийнято';
    bot.sendMessage(targetId, `🚚 Ваше замовлення прийнято і вже в дорозі!`);
    bot.sendMessage(adminChatId, `✅ Замовлення від @${user.username} позначено як "прийнято".`);
    return;
  }

  bot.sendMessage(targetId, `🚚 Ваше замовлення вже в дорозі! Дякуємо за довіру ❤️`);
  bot.sendMessage(adminChatId, `✅ Доставку підтверджено.`);
});

// 📊 Статистика
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (chatId !== adminChatId) return;

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
