// --- ЗАВИСИМОСТИ ---
const express = require('express');
const path = require('path');
const admin = require('firebase-admin');
const cron = require('node-cron');
const fetch = require('node-fetch');
const TelegramBot = require('node-telegram-bot-api');
const xlsx = require('xlsx');

// --- ИНИЦИАЛИЗАЦИЯ ---
const app = express();
const PORT = process.env.PORT || 10000;
const TELEGRAM_BOT_TOKEN = '8227812944:AAFy8ydOkUeCj3Qkjg7_Xsq6zyQpcUyMShY'; 

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
// === НОВЫЕ ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ДЛЯ ПЕРСОНАЛИЗАЦИИ ===
// ======================================================================

/**
 * Определяет уровень блогера по количеству подписчиков.
 * @param {number} followersCount - Количество подписчиков.
 * @returns {{level: string, text: string}} - Объект с уровнем и его текстовым представлением.
 */
function determineBloggerLevel(followersCount) {
    const count = Number(followersCount) || 0;
    if (count <= 6000) return { level: 'micro', text: 'Микроблогер' };
    if (count <= 10500) return { level: 'macro-a', text: 'Макроблогер тип A' };
    return { level: 'macro-b', text: 'Макроблогер тип B' };
}

/**
 * Рассчитывает внутренний рейтинг блогера.
 * @param {object} user - Объект пользователя из Firestore.
 * @returns {string} - Рейтинг, округленный до одного знака после запятой.
 */
function calculateBloggerRating(user) {
    const { followersCount = 0, avgViews = 0 } = user.registration || {};
    const strikes = user.strikes || 0;
    const followersScore = followersCount > 0 ? Math.log10(followersCount) * 2.5 : 0;
    const viewsScore = avgViews > 0 ? Math.log10(avgViews) * 4.5 : 0;
    let rating = ((followersScore + viewsScore - (strikes * 1.5)) / 25) * 10;
    return Math.max(1, Math.min(10, rating)).toFixed(1);
}

/**
 * Заменяет плейсхолдеры в шаблоне на реальные данные пользователя.
 * @param {string} template - Шаблон сообщения с плейсхолдерами.
 * @param {object} user - Объект пользователя из Firestore.
 * @returns {string} - Персонализированное сообщение.
 */
function personalizeMessage(template, user) {
    if (!user) return template;
    
    const registrationData = user.registration || {};
    const levelInfo = determineBloggerLevel(registrationData.followersCount);
    const rating = calculateBloggerRating(user);

    return template
        .replace(/{firstName}/g, registrationData.firstName || '')
        .replace(/{instagramLogin}/g, registrationData.instagramLogin || '')
        .replace(/{followersCount}/g, registrationData.followersCount || '0')
        .replace(/{level}/g, levelInfo.text || '')
        .replace(/{rating}/g, rating || '0.0');
}


// ======================================================================
// === API ДЛЯ ЭКСПОРТА В EXCEL (без изменений) ===
// ======================================================================

function convertToExcelBuffer(data, sheetName = 'Sheet1') {
    if (!data || data.length === 0) return null;
    const worksheet = xlsx.utils.json_to_sheet(data);
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, sheetName);
    return xlsx.write(workbook, { bookType: 'xlsx', type: 'buffer' });
}

app.post('/api/export-users', async (req, res) => {
    try {
        const { users, chatId } = req.body;
        if (!users || !Array.isArray(users) || !chatId) {
            return res.status(400).json({ error: 'Отсутствуют данные (users) или ID чата (chatId).' });
        }
        if (users.length === 0) {
            await bot.sendMessage(chatId, "⚠️ Не удалось создать экспорт: список пользователей пуст.");
            return res.status(200).json({ message: 'Нет данных для экспорта.'});
        }
        const fileBuffer = convertToExcelBuffer(users, 'Пользователи');
        if (!fileBuffer) {
             return res.status(500).json({ error: 'Не удалось создать Excel файл.' });
        }
        const date = new Date().toISOString().split('T')[0];
        const fileName = `users_export_${date}.xlsx`;
        await bot.sendDocument(chatId, fileBuffer, {}, { filename: fileName, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetsheet.sheet' });
        res.status(200).json({ message: 'Файл успешно отправлен.' });
    } catch (error) {
        console.error('Ошибка при экспорте пользователей:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера при создании файла.' });
    }
});

app.post('/api/export-orders', async (req, res) => {
    try {
        const { orders, chatId } = req.body;
        if (!orders || !Array.isArray(orders) || !chatId) {
            return res.status(400).json({ error: 'Отсутствуют данные (orders) или ID чата (chatId).' });
        }
        if (orders.length === 0) {
            await bot.sendMessage(chatId, "⚠️ Не удалось создать экспорт: список заказов пуст.");
            return res.status(200).json({ message: 'Нет данных для экспорта.'});
        }
        const fileBuffer = convertToExcelBuffer(orders, 'Заказы');
        if (!fileBuffer) {
             return res.status(500).json({ error: 'Не удалось создать Excel файл.' });
        }
        const date = new Date().toISOString().split('T')[0];
        const fileName = `orders_export_${date}.xlsx`;
        await bot.sendDocument(chatId, fileBuffer, {}, { filename: fileName, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetsheet.sheet' });
        res.status(200).json({ message: 'Файл успешно отправлен.' });
    } catch (error) {
        console.error('Ошибка при экспорте заказов:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера при создании файла.' });
    }
});


// ======================================================================
// === API ДЛЯ МАССОВОЙ РАССЫЛКИ (С ИЗМЕНЕНИЯМИ) ===
// ======================================================================
app.post('/api/broadcast', async (req, res) => {
    const { message, tags, senderChatId } = req.body;
    if (!message || !senderChatId) { return res.status(400).json({ error: 'Отсутствует текст сообщения или ID отправителя.' }); }
    
    res.status(202).json({ message: 'Рассылка запущена.' });

    // Запускаем рассылку в фоновом режиме, чтобы не блокировать ответ клиенту
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
            
            // ИЗМЕНЕНО: Получаем полные данные пользователей, а не только ID
            const usersToSend = usersSnapshot.docs
                .map(doc => doc.data())
                .filter(user => user.telegramId); // Убеждаемся, что у пользователя есть telegramId

            if (usersToSend.length === 0) {
                return await bot.sendMessage(senderChatId, '⚠️ Рассылка завершена. Пользователи найдены, но ни у кого из них нет Telegram ID.');
            }

            let successCount = 0, errorCount = 0;
            
            // ИЗМЕНЕНО: Итерируемся по полным объектам пользователей
            for (const user of usersToSend) {
                try {
                    // НОВОЕ: Персонализируем сообщение для каждого пользователя
                    const personalizedText = personalizeMessage(message, user);
                    
                    await bot.sendMessage(user.telegramId, personalizedText, { parse_mode: 'Markdown' });
                    successCount++;
                } catch (e) {
                    console.error(`Ошибка отправки пользователю ${user.telegramId}:`, e.response?.body?.description || e.message);
                    errorCount++;
                }
                // Задержка для избежания лимитов Telegram API
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
// === ПЛАНИРОВЩИКИ И УВЕДОМЛЕНИЯ (без изменений) ===
// ======================================================================
async function sendTelegramNotification(chatId, text) {
    try {
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error(`Ошибка отправки в Telegram для ${chatId}:`, error.response ? error.response.body : error.message);
        throw error;
    }
}
async function checkAndNotifyUsers() { /* ... код без изменений ... */ }
async function checkReportReminders() { /* ... код без изменений ... */ }
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
