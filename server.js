// --- ЗАВИСИМОСТИ ---
const express = require('express');
const path = require('path');
const admin = require('firebase-admin');
const cron = require('node-cron');
const fetch = require('node-fetch');
const TelegramBot = require('node-telegram-bot-api'); // <-- Новая зависимость

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
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN); // <-- Инициализация бота

// --- MIDDLEWARE ---
app.use(express.static(path.join(__dirname, '/')));
app.use(express.json({ limit: '10mb' })); // Увеличиваем лимит для данных экспорта
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
// === НОВЫЙ БЛОК: API ДЛЯ ЭКСПОРТА В CSV ===
// ======================================================================

// Вспомогательная функция для конвертации массива объектов в CSV-строку
function convertToCSV(data) {
    if (!data || data.length === 0) return '';
    const headers = Object.keys(data[0]);
    const sanitize = (value) => {
        const strValue = String(value === null || value === undefined ? '' : value);
        if (/[",\n]/.test(strValue)) {
            return `"${strValue.replace(/"/g, '""')}"`;
        }
        return strValue;
    };
    const headerRow = headers.join(',');
    const dataRows = data.map(row => headers.map(header => sanitize(row[header])).join(','));
    // Добавляем BOM для корректного отображения кириллицы в Excel
    return '\uFEFF' + [headerRow, ...dataRows].join('\n');
}

// Эндпоинт для экспорта пользователей
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

        const formattedData = users.map(user => {
            const reg = user.registration || user;
            const followers = reg.followersCount || 0;
            return {
                'Имя': reg.firstName, 'Телефон': reg.phone, 'Instagram': reg.instagramLogin,
                'Подписчики': followers, 'Просмотры': reg.avgViews,
                'Уровень': followers <= 6000 ? 'Микроблогер' : (followers <= 10500 ? 'Макроблогер тип A' : 'Макроблогер тип B'),
                'Статус лояльности': user.loyaltyStatus || 'standard',
                'Заблокирован': user.isBlocked ? 'Да' : 'Нет', 'Причина блокировки': user.blockReason,
                'Штрафы': user.strikes || 0, 'Теги': (user.tags || []).join('; '),
                'Дата регистрации': new Date(user.registrationDate).toLocaleDateString('ru-RU'),
            };
        });

        const csvData = convertToCSV(formattedData);
        const fileBuffer = Buffer.from(csvData, 'utf-8');
        const date = new Date().toISOString().split('T')[0];
        const fileName = `users_export_${date}.csv`;

        await bot.sendDocument(chatId, fileBuffer, {}, { filename: fileName, contentType: 'text/csv' });
        res.status(200).json({ message: 'Файл успешно отправлен.' });
    } catch (error) {
        console.error('Ошибка при экспорте пользователей:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера при создании файла.' });
    }
});

// Эндпоинт для экспорта заказов
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
        
        const statuses = { 'new': 'Новый', 'confirmed': 'Подтвержден', 'delivered': 'Доставлен', 'awaiting_review': 'На проверке', 'completed': 'Завершен', 'rejected': 'Отклонен' };

        const formattedData = orders.map(order => ({
            'Номер заказа': order.orderNumber, 'Статус': statuses[order.status] || order.status,
            'Имя блогера': order.userName, 'Телефон блогера': order.phone, 'Instagram': order.instagram,
            'Город': order.city, 'Адрес': `${order.street}, п. ${order.entrance || '-'}, эт. ${order.floor || '-'}`,
            'Дата доставки': order.date, 'Время доставки': order.time,
            'Выбранный набор': order.setName || 'Свой заказ', 'Комментарий': order.comment,
            'Ссылка на отчет': order.reportLink, 'Дата создания': new Date(order.createdAt).toLocaleString('ru-RU')
        }));
        
        const csvData = convertToCSV(formattedData);
        const fileBuffer = Buffer.from(csvData, 'utf-8');
        const date = new Date().toISOString().split('T')[0];
        const fileName = `orders_export_${date}.csv`;

        await bot.sendDocument(chatId, fileBuffer, {}, { filename: fileName, contentType: 'text/csv' });
        res.status(200).json({ message: 'Файл успешно отправлен.' });
    } catch (error) {
        console.error('Ошибка при экспорте заказов:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера при создании файла.' });
    }
});


// ======================================================================
// === API ДЛЯ МАССОВОЙ РАССЫЛКИ ===
// ======================================================================
app.post('/api/broadcast', async (req, res) => {
    // ... ваш код рассылки остается без изменений ...
    const { message, tags, senderChatId } = req.body;
    if (!message || !senderChatId) { return res.status(400).json({ error: 'Отсутствует текст сообщения или ID отправителя.' }); }
    res.status(202).json({ message: 'Рассылка запущена.' });
    (async () => {
        try {
            let usersQuery = db.collection('users');
            if (tags && tags.length > 0) { usersQuery = usersQuery.where("tags", "array-contains-any", tags); }
            const usersSnapshot = await usersQuery.get();
            if (usersSnapshot.empty) { return await bot.sendMessage(senderChatId, '⚠️ Рассылка завершена. Не найдено пользователей по вашим критериям.'); }
            const usersToSend = usersSnapshot.docs.map(doc => doc.data().telegramId).filter(id => id);
            if (usersToSend.length === 0) { return await bot.sendMessage(senderChatId, '⚠️ Рассылка завершена. Пользователи найдены, но ни у кого из них нет Telegram ID.');}
            let successCount = 0, errorCount = 0;
            for (const chatId of usersToSend) {
                try {
                    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
                    successCount++;
                } catch (e) { errorCount++; }
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
// ... ваш код планировщиков остается без изменений, за исключением функции отправки
async function sendTelegramNotification(chatId, text) {
    // Эта функция теперь просто обертка для новой библиотеки
    try {
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    } catch (error) {
        // Ошибки теперь лучше обрабатываются в вызывающих функциях
        console.error(`Ошибка отправки в Telegram для ${chatId}:`, error.response ? error.response.body : error.message);
        throw error; // Пробрасываем ошибку дальше
    }
}
//... остальной код планировщиков без изменений...
async function checkAndNotifyUsers() { /* ... */ }
async function checkReportReminders() { /* ... */ }
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
