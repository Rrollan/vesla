// --- ЗАВИСИМОСТИ ---
const express = require('express');
const path = require('path');
const admin = require('firebase-admin');
const cron = require('node-cron');
const fetch = require('node-fetch');
const TelegramBot = require('node-telegram-bot-api');
const xlsx = require('xlsx');
const multer = require('multer');

// --- ИНИЦИАЛИЗАЦИЯ ---
const app = express();
const PORT = process.env.PORT || 10000;
const TELEGRAM_BOT_TOKEN = '8227812944:AAFy8ydOkUeCj3Qkjg7_Xsq6zyQpcUyMShY'; 

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// --- ИНИЦИАЛИЗАЦИЯ FIREBASE ADMIN SDK ---
try {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_KEY 
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)
    : require('/etc/secrets/serviceAccountKey.json'); 
  
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  }
} catch (error) {
  console.error("КРИТИЧЕСКАЯ ОШИБКА: Ключ сервисного аккаунта Firebase не найден.");
}
const db = admin.firestore();
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);

// --- MIDDLEWARE ---
app.use(express.static(path.join(__dirname, '/')));
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

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

  if (orderData.setName) message += `\n🍱 *Выбранный набор:* ${orderData.setName}`;

  message += `\n\n🗓 *Доставка:*\n` +
             `Дата: ${orderData.date} в ${orderData.time}\n` +
             `Город: ${orderData.city}\n` +
             `Адрес: ${orderData.street}, п. ${orderData.entrance}, эт. ${orderData.floor}\n` +
             `Комментарий: ${orderData.comment || '-'}`;
  
  for (const chatId of adminChatIds) {
    try {
      if (screenshotFileBuffer) {
        await bot.sendPhoto(chatId, screenshotFileBuffer, { caption: message, parse_mode: 'Markdown' });
      } else {
        await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      }
    } catch (error) {
      console.error(`Ошибка отправки админу ${chatId}:`, error.response?.body?.description || error.message);
    }
  }
}

// ИСПРАВЛЕНО: Улучшенная функция для создания и отправки Excel
async function sendExcelFile(chatId, data, fileNamePrefix, sheetName) {
    if (!data || !Array.isArray(data) || !chatId) {
        throw new Error('Неверные данные для экспорта.');
    }
    
    if (data.length === 0) {
        await bot.sendMessage(chatId, `⚠️ Не удалось создать экспорт: список (${fileNamePrefix}) пуст.`);
        return;
    }

    // Преобразуем данные, чтобы Excel распознал формулы для гиперссылок
    const processedData = data.map(row => {
        const newRow = {};
        for (const key in row) {
            const value = row[key];
            if (typeof value === 'string' && value.startsWith('=HYPERLINK')) {
                // Для ячеек с гиперссылками создаем объект с типом 'f' (formula)
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
    
    // Автоматически настраиваем ширину колонок
    const columnWidths = Object.keys(processedData[0]).map(key => ({
        wch: processedData.reduce((w, r) => Math.max(w, r[key] ? r[key].toString().length : 10), 10)
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

app.post('/api/create-order', upload.single('screenshot'), async (req, res) => {
    try {
        const orderData = JSON.parse(req.body.order);
        const screenshotFile = req.file;

        const batch = db.batch();
        const orderRef = db.collection('orders').doc(orderData.id);
        batch.set(orderRef, orderData);

        const userRef = db.collection('users').doc(orderData.userId);
        const userOrders = { id: orderData.id, orderNumber: orderData.orderNumber, status: 'new', createdAt: orderData.createdAt };
        const cityTag = orderData.city.toLowerCase().replace(/\s/g, '-');
        
        batch.update(userRef, { 
            orders: admin.firestore.FieldValue.arrayUnion(userOrders),
            tags: admin.firestore.FieldValue.arrayUnion(cityTag),
            lastOrderTimestamp: orderData.createdAt,
            cooldownNotified: false
        });

        await batch.commit();
        await sendAdminNotification(orderData, screenshotFile ? screenshotFile.buffer : null);

        res.status(201).json({ message: 'Заказ успешно создан' });
    } catch (error) {
        console.error('Ошибка при создании заказа на сервере:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера при создании заказа.' });
    }
});

app.post('/api/export-users', async (req, res) => {
    try {
        const { data, chatId } = req.body;
        await sendExcelFile(chatId, data, 'users', 'Пользователи');
        res.status(200).json({ message: 'Файл успешно отправлен.' });
    } catch (error) {
        console.error('Ошибка при экспорте пользователей:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера.' });
    }
});

app.post('/api/export-orders', async (req, res) => {
    try {
        const { data, chatId } = req.body;
        await sendExcelFile(chatId, data, 'orders', 'Заказы');
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
        
        const usersSnapshot = await db.collection('users')
            .where('lastOrderTimestamp', '!=', null)
            .where('cooldownNotified', '==', false)
            .get();
        
        if (usersSnapshot.empty) return;

        for (const doc of usersSnapshot.docs) {
            const user = doc.data();
            const lastOrderDate = new Date(user.lastOrderTimestamp);
            // Клонируем дату, чтобы не изменять оригинал
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
        // Уведомление через 24 часа
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
                    // Если пользователя нет, все равно помечаем, чтобы не проверять снова
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
        console.log(`Уведомление для ${chatId} отправлено, документ обновлен.`);
    } catch (err) {
        console.error(`Сетевая или DB ошибка для ${chatId}:`, err.message);
    }
}
cron.schedule('0 9 * * *', checkAndNotifyUsers, { timezone: "Asia/Almaty" });
cron.schedule('0 * * * *', checkReportReminders, { timezone: "Asia/Almaty" }); 

// --- ЗАПУСК СЕРВЕРА ---
app.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
    console.log('Планировщики активны.');
});
