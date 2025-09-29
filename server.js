// --- ЗАВИСИМОСТИ ---
const express = require('express');
const path = require('path');
const admin = require('firebase-admin');
const cron = require('node-cron');
const TelegramBot = require('node-telegram-bot-api');
const xlsx = require('xlsx');
const fs = require('fs');

// ЗАВИСИМОСТИ ДЛЯ РУЧНОГО УПРАВЛЕНИЯ
const fileUpload = require('express-fileupload');
const sharp = require('sharp');
const axios = require('axios');
const FormData = require('form-data');

// --- ИНИЦИАЛИЗАЦИЯ ---
const app = express();
const PORT = process.env.PORT || 10000;
const TELEGRAM_BOT_TOKEN = '8227812944:AAFy8ydOkUeCj3Qkjg7_Xsq6zyQpcUyMShY'; 

// --- ИНИЦИАЛИЗАЦИЯ FIREBASE ADMIN SDK ---
try {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_KEY 
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)
    : require('./serviceAccountKey.json');
  
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  }
} catch (error) {
  console.error("КРИТИЧЕСКАЯ ОШИБКА: Ключ сервисного аккаунта Firebase не найден. Убедитесь, что файл serviceAccountKey.json существует или переменная окружения FIREBASE_SERVICE_ACCOUNT_KEY установлена.");
}

const db = admin.firestore();
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);

// --- MIDDLEWARE ---
app.use(express.static(path.join(__dirname, '/')));
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use(fileUpload());
app.use(express.json({ limit: '10mb' }));

// --- ГЛАВНЫЙ МАРШРУТ ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ======================================================================
// === ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ===
// ======================================================================

function determineBloggerLevel(followersCount) {
    const count = Number(followersCount) || 0;
    if (count <= 6000) return { level: 'micro', text: 'Микроблогер' };
    if (count <= 10500) return { level: 'macro-a', text: 'Макроблогер тип A' };
    return { level: 'macro-b', text: 'Макроблогер тип B' };
}

function calculateBloggerRating(user) {
    const { followersCount = 0, avgViews = 0 } = user.registration || {};
    const strikes = user.strikes || 0;
    const followersScore = followersCount > 0 ? Math.log10(followersCount) * 2.5 : 0;
    const viewsScore = avgViews > 0 ? Math.log10(avgViews) * 4.5 : 0;
    let rating = ((followersScore + viewsScore - (strikes * 1.5)) / 25) * 10;
    return Math.max(1, Math.min(10, rating)).toFixed(1);
}

function personalizeMessage(template, user) {
    if (!user) return template;
    
    const registrationData = user.registration || {};
    const levelInfo = determineBloggerLevel(registrationData.followersCount);
    const rating = calculateBloggerRating(user);

    const instagramLogin = (registrationData.instagramLogin || '').replace('@', '');
    const instagramLink = `[@${instagramLogin}](https://www.instagram.com/${instagramLogin})`;

    return template
        .replace(/{firstName}/g, registrationData.firstName || '')
        .replace(/{instagramLogin}/g, instagramLink) 
        .replace(/{followersCount}/g, registrationData.followersCount || '0')
        .replace(/{level}/g, levelInfo.text || '')
        .replace(/{rating}/g, rating || '0.0');
}

async function sendAdminNotification(orderData, screenshotFileBuffer) {
  const adminSnapshot = await db.collection('admins').get();
  if (adminSnapshot.empty) return;

  const adminDocs = adminSnapshot.docs.filter(doc => doc.data().receivesNotifications !== false);
  if (adminDocs.length === 0) return;

  const adminChatIds = adminDocs.map(doc => doc.id);
  
  const instagramLogin = (orderData.instagram || '').replace('@', '');
  const instagramLink = `[@${instagramLogin}](https://www.instagram.com/${instagramLogin})`;

  let message = `*Новая заявка на бартер*\n\n` +
                `📝 *Заказ:* \`${orderData.orderNumber}\`\n` +
                `👤 *Блогер:*\n` +
                `Имя: ${orderData.userName}\n` +
                `Телефон: \`${orderData.phone}\`\n` +
                `Instagram: ${instagramLink}\n` +
                `Уровень: ${determineBloggerLevel(orderData.followersCount).text}`;

    // ИЗМЕНЕНИЕ: Логика для отображения V-Coins или Сета
    if (orderData.vcoin_cost) {
        const itemsList = orderData.items.map(item => `- ${item.name} (x${item.quantity})`).join('\n');
        message += `\n\n🛍️ *Выбранные блюда:*\n${itemsList}\n` +
                   `*Стоимость:* ${orderData.vcoin_cost.toFixed(1)} VC\n` +
                   `*К доплате:* *${(orderData.payment_due_tenge || 0).toFixed(0)} ₸*`;
    } else if (orderData.setName) {
        message += `\n🍱 *Выбранный набор:* ${orderData.setName}`;
    }

  message += `\n\n🗓 *Доставка:*\n` +
             `Дата: ${orderData.date} в ${orderData.time}\n` +
             `Город: ${orderData.city}\n` +
             `Адрес: ${orderData.street}, п. ${orderData.entrance || '-'}, эт. ${orderData.floor || '-'}\n` +
             `Комментарий: ${orderData.comment || '-'}`;
  
  for (const chatId of adminChatIds) {
    try {
      await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
      console.error(`Ошибка отправки админу ${chatId}:`, error.response?.body?.description || error.message);
    }
  }
}

async function sendExcelFile(chatId, data, fileNamePrefix, sheetName) {
    if (!data || !Array.isArray(data) || !chatId) {
        throw new Error('Неверные данные для экспорта.');
    }
    
    if (data.length === 0) {
        await bot.sendMessage(chatId, `⚠️ Не удалось создать экспорт: список (${fileNamePrefix}) пуст.`);
        return;
    }
    const processedData = data.map(row => {
        const newRow = {};
        for (const key in row) {
            const value = row[key];
            if (typeof value === 'string' && value.startsWith('=HYPERLINK')) {
                const match = value.match(/=HYPERLINK\("([^"]+)", "([^"]+)"\)/);
                if (match) {
                    newRow[key] = { t: 's', v: match[2], l: { Target: match[1], Tooltip: 'Перейти по ссылке' } };
                } else {
                    newRow[key] = value;
                }
            } else {
                newRow[key] = value;
            }
        }
        return newRow;
    });

    const worksheet = xlsx.utils.json_to_sheet(processedData);
    
    const columnWidths = Object.keys(processedData[0]).map(key => ({
        wch: processedData.reduce((w, r) => Math.max(w, String(r[key] || '').length), key.length + 2)
    }));
    worksheet['!cols'] = columnWidths;

    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, sheetName);
    
    const fileBuffer = xlsx.write(workbook, { bookType: 'xlsx', type: 'buffer' });
    const date = new Date().toISOString().split('T')[0];
    const fileName = `${fileNamePrefix}_export_${date}.xlsx`;

    await bot.sendDocument(chatId, fileBuffer, {}, { 
        filename: fileName, 
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' 
    });
}

// ======================================================================
// === API МАРШРУТЫ ===
// ======================================================================
app.post('/api/create-order', async (req, res) => {
    try {
        if (!req.body.order) {
            return res.status(400).json({ error: 'Order data is missing.' });
        }
        const orderData = JSON.parse(req.body.order);
        const userRef = db.collection('users').doc(orderData.userId);

        // Используем транзакцию для безопасного чтения и обновления баланса
        await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userRef);
            if (!userDoc.exists) {
                throw new Error("Пользователь не найден");
            }
            const userData = userDoc.data();
            const orderRef = db.collection('orders').doc(orderData.id);

            // Общие данные для обновления пользователя
            const userUpdates = {
                orders: admin.firestore.FieldValue.arrayUnion({
                    id: orderData.id,
                    orderNumber: orderData.orderNumber,
                    status: 'new',
                    createdAt: orderData.createdAt
                }),
                tags: admin.firestore.FieldValue.arrayUnion(orderData.city.toLowerCase().replace(/\s/g, '-'))
            };

            // ИЗМЕНЕНИЕ: Логика для V-Coins
            if (orderData.vcoin_cost && orderData.vcoin_cost > 0) {
                // Это заказ за V-Coins
                const currentBalance = userData.vcoin_balance || 0;
                userUpdates.vcoin_balance = currentBalance - orderData.vcoin_cost;
            } else {
                // Это обычный заказ для микроблогера (сет), используем кулдаун
                userUpdates.lastOrderTimestamp = orderData.createdAt;
                userUpdates.cooldownNotified = false;
            }
            
            // Записываем данные в рамках транзакции
            transaction.set(orderRef, orderData);
            transaction.update(userRef, userUpdates);
        });
        
        // Уведомление админам отправляется после успешной транзакции
        await sendAdminNotification(orderData);

        res.status(201).json({ message: 'Заказ успешно создан' });
    } catch (error) {
        console.error('Ошибка при создании заказа на сервере:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера при создании заказа.' });
    }
});

app.post('/api/upload-menu-image', async (req, res) => {
    const IMGBB_API_KEY = '5148efee12c90f87021e50e0155d17a0'; 

    if (!IMGBB_API_KEY || IMGBB_API_KEY === 'YOUR_IMGBB_API_KEY_HERE') {
        return res.status(500).json({ error: 'API ключ для ImgBB не настроен на сервере.' });
    }
    if (!req.files || !req.files.image) {
        return res.status(400).json({ error: 'Файл изображения не был загружен.' });
    }
    const imageFile = req.files.image;

    try {
        const processedImageBuffer = await sharp(imageFile.data)
            .resize(500, 500, { fit: 'cover', position: 'center' })
            .webp({ quality: 80 })
            .toBuffer();
            
        const formData = new FormData();
        formData.append('key', IMGBB_API_KEY);
        formData.append('image', processedImageBuffer.toString('base64'));

        const response = await axios.post('https://api.imgbb.com/1/upload', formData);

        if (response.data.success) {
            res.status(200).json({ success: true, imageUrl: response.data.data.url });
        } else {
            throw new Error(response.data.error?.message || 'Не удалось загрузить изображение в ImgBB');
        }
    } catch (error) {
        console.error('Ошибка обработки или загрузки изображения:', error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Внутренняя ошибка сервера при загрузке изображения.' });
    }
});

app.post('/api/export-users', async (req, res) => {
    try {
        const { data, chatId } = req.body;
        // ИЗМЕНЕНИЕ: Добавлены поля V-Coins в экспорт
        const formattedData = data.map(user => {
            const reg = user.registration || user;
            const instagramLogin = (reg.instagramLogin || '').replace('@', '');
            const url = `https://www.instagram.com/${instagramLogin}`;
            return {
                'Имя': reg.firstName, 'Телефон': reg.phone,
                'Instagram': `=HYPERLINK("${url}", "@${instagramLogin}")`,
                'Подписчики': reg.followersCount, 'Просмотры': reg.avgViews, 'Рейтинг': calculateBloggerRating(user),
                'Уровень': determineBloggerLevel(reg.followersCount).text, 
                'Баланс V-Coins': user.vcoin_balance || 0,
                'Лимит V-Coins': user.vcoin_allowance || 0,
                'Статус лояльности': user.loyaltyStatus || 'standard',
                'Заблокирован': user.isBlocked ? 'Да' : 'Нет', 'Причина блокировки': user.blockReason, 'Штрафы': user.strikes || 0,
                'Теги': (user.tags || []).join('; '), 'Дата регистрации': new Date(user.registrationDate).toLocaleDateString('ru-RU'),
            };
        });
        await sendExcelFile(chatId, formattedData, 'users', 'Пользователи');
        res.status(200).json({ message: 'Файл успешно отправлен.' });
    } catch (error) {
        console.error('Ошибка при экспорте пользователей:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера.' });
    }
});

app.post('/api/export-orders', async (req, res) => {
    try {
        const { data, chatId } = req.body;
        // ИЗМЕНЕНИЕ: Добавлены поля V-Coins в экспорт
        const formattedData = data.map(order => {
            const instagramLogin = (order.instagram || '').replace('@', '');
            const url = `https://www.instagram.com/${instagramLogin}`;
            return {
                'Номер заказа': order.orderNumber, 'Статус': getStatusInfo(order.status).text, 'Имя блогера': order.userName,
                'Телефон блогера': order.phone,
                'Instagram': `=HYPERLINK("${url}", "@${instagramLogin}")`,
                'Город': order.city, 'Адрес': `${order.street}, п. ${order.entrance || '-'}, эт. ${order.floor || '-'}`,
                'Дата доставки': order.date, 'Время доставки': order.time,
                'Стоимость (VC)': order.vcoin_cost ? order.vcoin_cost.toFixed(1) : '-',
                'К доплате (₸)': order.payment_due_tenge ? order.payment_due_tenge.toFixed(0) : 0,
                'Выбранный набор': order.setName || 'Меню',
                'Комментарий': order.comment, 'Ссылка на отчет': order.reportLink,
                'Дата создания': new Date(order.createdAt).toLocaleString('ru-RU')
            };
        });
        await sendExcelFile(chatId, formattedData, 'orders', 'Заказы');
        res.status(200).json({ message: 'Файл успешно отправлен.' });
    } catch (error) {
        console.error('Ошибка при экспорте заказов:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера.' });
    }
});

app.post('/api/broadcast', async (req, res) => {
    const { message, tags, senderChatId } = req.body;
    if (!message || !senderChatId) { return res.status(400).json({ error: 'Отсутствует текст сообщения или ID отправителя.' }); }
    
    res.status(202).json({ message: 'Рассылка запущена.' });

    (async () => {
        try {
            let usersQuery = db.collection('users');
            if (tags && tags.length > 0) {
                usersQuery = usersQuery.where("tags", "array-contains-any", tags);
            }
            const usersSnapshot = await usersQuery.get();

            if (usersSnapshot.empty) {
                return await bot.sendMessage(senderChatId, '⚠️ Рассылка завершена. Не найдено пользователей по вашим критериям.');
            }
            
            const usersToSend = usersSnapshot.docs
                .map(doc => doc.data())
                .filter(user => user.telegramId); 

            if (usersToSend.length === 0) {
                return await bot.sendMessage(senderChatId, '⚠️ Рассылка завершена. Пользователи найдены, но ни у кого из них нет Telegram ID.');
            }
            let successCount = 0, errorCount = 0;
            
            for (const user of usersToSend) {
                try {
                    const personalizedText = personalizeMessage(message, user);
                    await bot.sendMessage(user.telegramId, personalizedText, { parse_mode: 'Markdown' });
                    successCount++;
                } catch (e) {
                    console.error(`Ошибка отправки пользователю ${user.telegramId}:`, e.response?.body?.description || e.message);
                    errorCount++;
                }
                await new Promise(resolve => setTimeout(resolve, 100)); 
            }
            await bot.sendMessage(senderChatId, `✅ Рассылка завершена!\n\nУспешно отправлено: ${successCount}\nОшибок: ${errorCount}`);
        } catch (error) {
            console.error('Критическая ошибка в процессе рассылки:', error);
            await bot.sendMessage(senderChatId, `❌ Произошла критическая ошибка во время рассылки: ${error.message}`);
        }
    })();
});

app.post('/api/import-menu-from-file', async (req, res) => {
    try {
        if (!req.files || !req.files.menuFile) {
            return res.status(400).json({ error: 'Файл меню не был загружен.' });
        }

        const menuFile = req.files.menuFile;
        let fileContent = menuFile.data.toString('utf8');
        if (fileContent.charCodeAt(0) === 0xFEFF) fileContent = fileContent.slice(1);
        
        const newMenuItems = JSON.parse(fileContent);
        if (!Array.isArray(newMenuItems)) {
             return res.status(400).json({ error: 'Содержимое файла должно быть списком (массивом) [...] блюд.' });
        }

        const menuCollection = db.collection('menu');
        const oldMenuSnapshot = await menuCollection.get();
        const batchDelete = db.batch();
        oldMenuSnapshot.docs.forEach(doc => batchDelete.delete(doc.ref));
        await batchDelete.commit();

        const batchWrite = db.batch();
        newMenuItems.forEach(item => {
            if (item.name && typeof item.price === 'number') {
                const newDocRef = menuCollection.doc();
                batchWrite.set(newDocRef, {
                    name: item.name || 'Без названия', description: item.description || '',
                    price: item.price || 0, category: item.category || 'Без категории',
                    subcategory: item.subcategory || '', imageUrl: item.imageUrl || '',
                    isVisible: item.isVisible !== false // По умолчанию видимо
                });
            }
        });
        await batchWrite.commit();
        res.status(200).json({ success: true, message: `Успешно импортировано ${newMenuItems.length} блюд.` });
    } catch (error) {
        console.error('Ошибка во время импорта меню из файла:', error);
        res.status(500).json({ error: 'Произошла ошибка на сервере во время импорта.' });
    }
});

// ======================================================================
// === ПЛАНИРОВЩИКИ И УВЕДОМЛЕНИЯ ===
// ======================================================================
async function sendTelegramNotification(chatId, text) {
    try {
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error(`Ошибка отправки в Telegram для ${chatId}:`, error.response ? error.response.body : error.message);
    }
}

async function checkAndNotifyUsers() {
    try {
        const settingsDoc = await db.collection('settings').doc('config').get();
        const cooldownDays = settingsDoc.exists ? settingsDoc.data().orderCooldownDays : 7;
        const now = new Date();
        
        // ИЗМЕНЕНИЕ: Уведомления о кулдауне только для тех, у кого нет V-Coins
        const usersSnapshot = await db.collection('users')
            .where('lastOrderTimestamp', '!=', null)
            .where('cooldownNotified', '==', false)
            .where('vcoin_allowance', '==', 0)
            .get();
        
        if (usersSnapshot.empty) return;

        for (const doc of usersSnapshot.docs) {
            const user = doc.data();
            const lastOrderDate = new Date(user.lastOrderTimestamp);
            const nextAvailableDate = new Date(lastOrderDate.getTime());
            nextAvailableDate.setDate(lastOrderDate.getDate() + cooldownDays);

            if (now >= nextAvailableDate && user.telegramId) {
                const message = `👋 ${user.registration.firstName}, отличные новости! Вы снова можете оформить заказ на бартер. Ждем вашу заявку!`;
                await sendAndUpdate(user.telegramId, message, doc.ref, { cooldownNotified: true });
            }
        }
    } catch (error) {
        console.error("Ошибка в checkAndNotifyUsers:", error);
    }
}

async function checkReportReminders() {
     try {
        const now = new Date();
        const reminderTime = new Date(now.getTime() - (24 * 60 * 60 * 1000));
        
        const ordersSnapshot = await db.collection('orders')
            .where('status', '==', 'delivered')
            .where('reminderSent', '==', false)
            .get();

        if (ordersSnapshot.empty) return;

        for (const doc of ordersSnapshot.docs) {
            const order = doc.data();
            const deliveryDate = new Date(order.createdAt);
            
            if (deliveryDate <= reminderTime && order.userId) {
                const userDoc = await db.collection('users').doc(order.userId).get();
                if (userDoc.exists && userDoc.data().telegramId) {
                    const message = `🔔 Напоминание: Прошло 24 часа с момента доставки вашего заказа *${order.orderNumber}*. Пожалуйста, не забудьте сдать отчет в личном кабинете.`;
                    await sendAndUpdate(userDoc.data().telegramId, message, doc.ref, { reminderSent: true });
                } else {
                    await doc.ref.update({ reminderSent: true });
                }
            }
        }
    } catch (error) {
        console.error("Ошибка в checkReportReminders:", error);
    }
}

async function sendAndUpdate(chatId, message, docRef, updateData) {
    try {
        await sendTelegramNotification(chatId, message);
        await docRef.update(updateData);
    } catch (err) {
        console.error(`Сетевая или DB ошибка для ${chatId}:`, err.message);
    }
}

// Задачи по расписанию
cron.schedule('0 9 * * *', checkAndNotifyUsers, { timezone: "Asia/Almaty" });
cron.schedule('0 * * * *', checkReportReminders, { timezone: "Asia/Almaty" }); 

// НОВЫЙ CRON JOB: Еженедельное начисление V-Coins
cron.schedule('1 0 * * 1', async () => {
    console.log('Запуск еженедельного начисления V-Coins...');
    try {
        const usersRef = db.collection('users');
        const snapshot = await usersRef.where('vcoin_allowance', '>', 0).get();

        if (snapshot.empty) {
            console.log('Нет пользователей для начисления V-Coins.');
            return;
        }

        const batch = db.batch();
        snapshot.forEach(doc => {
            const user = doc.data();
            // Устанавливаем баланс равным еженедельному лимиту
            batch.update(doc.ref, { vcoin_balance: user.vcoin_allowance });
        });

        await batch.commit();
        console.log(`V-Coins начислены для ${snapshot.size} пользователей.`);
    } catch (error) {
        console.error("Критическая ошибка при еженедельном начислении V-Coins:", error);
    }
}, {
    timezone: "Asia/Almaty"
});

// --- ЗАПУСК СЕРВЕРА ---
app.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
    console.log('Планировщики активны.');
});
