// --- ЗАВИСИСИМОСТИ ---
const express = require('express');
const path = require('path');
const admin = require('firebase-admin');
const cron = require('node-cron');
const TelegramBot = require('node-telegram-bot-api');
const xlsx = require('xlsx');
const crypto = require('crypto'); // Встроенный модуль для криптографии

// ЗАВИСИМОСТИ ДЛЯ РУЧНОГО УПРАВЛЕНИЯ
const fileUpload = require('express-fileupload');
const sharp = require('sharp');
const axios = require('axios');
const FormData = require('form-data');

// --- ИНИЦИАЛИЗАЦИЯ ---
const app = express();
const PORT = process.env.PORT || 10000;

// ВАЖНО: Храните токен в переменных окружения, а не в коде!
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8227812944:AAFy8ydOkUeCj3Qkjg7_Xsq6zyQpcUyMShY';
const IMGBB_API_KEY = process.env.IMGBB_API_KEY || '5148efee12c90f87021e50e0155d17a0';

// --- ИНИЦИАЛИЗАЦИЯ FIREBASE ADMIN SDK ---
try {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_KEY 
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)
    : require('./serviceAccountKey.json');
  
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
     console.log("Firebase Admin SDK успешно инициализирован.");
  }
} catch (error) {
  console.error("КРИТИЧЕСКАЯ ОШИБКА: Ключ сервисного аккаунта Firebase не найден. Убедитесь, что переменная окружения FIREBASE_SERVICE_ACCOUNT_KEY установлена.");
}

const db = admin.firestore();
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);

// --- MIDDLEWARE ---
app.use(express.static(path.join(__dirname, '/')));
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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
// === MIDDLEWARE ДЛЯ АУТЕНТИФИКАЦИИ ===
// ======================================================================
const checkAuth = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Отсутствует заголовок авторизации' });
    }
    
    const initData = authHeader.split(' ')[1];
    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        params.delete('hash');

        const dataCheckString = Array.from(params.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => `${key}=${value}`)
            .join('\n');

        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(TELEGRAM_BOT_TOKEN).digest();
        const hmac = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

        if (hmac === hash) {
            req.user = JSON.parse(params.get('user'));
            next();
        } else {
            return res.status(403).json({ error: 'Неверная подпись данных. Запрос отклонен.' });
        }
    } catch (error) {
        console.error('Ошибка валидации initData:', error);
        return res.status(400).json({ error: 'Ошибка обработки данных авторизации.' });
    }
};


// ======================================================================
// === ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ===
// ======================================================================

function getStatusInfo(status) {
    const statuses = {
        'new': { text: 'Новый' }, 'confirmed': { text: 'Подтвержден' },
        'delivered': { text: 'Доставлен' }, 'awaiting_review': { text: 'На проверке' },
        'completed': { text: 'Завершен' }, 'rejected': { text: 'Отклонен' }
    };
    return statuses[status] || { text: status };
}

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

async function sendAdminNotification(orderData) {
  const adminSnapshot = await db.collection('admins').where('receivesNotifications', '==', true).get();
  if (adminSnapshot.empty) return;

  const adminChatIds = adminSnapshot.docs.map(doc => doc.id);
  
  const instagramLogin = (orderData.instagram || '').replace('@', '');
  const instagramLink = `[@${instagramLogin}](https://www.instagram.com/${instagramLogin})`;

  let message = `*Новая заявка на бартер*\n\n` +
                `📝 *Заказ:* \`${orderData.orderNumber}\`\n` +
                `👤 *Блогер:*\n` +
                `Имя: ${orderData.userName}\n` +
                `Телефон: \`${orderData.phone}\`\n` +
                `Instagram: ${instagramLink}\n` +
                `Уровень: ${determineBloggerLevel(orderData.followersCount).text}`;

    if (orderData.vcoin_cost) {
        const itemsList = orderData.items.map(item => `- ${item.name} (x${item.quantity})`).join('\n');
        message += `\n\n🛍️ *Выбранные блюда:*\n${itemsList}\n` +
                   `*Стоимость:* ${orderData.vcoin_cost.toFixed(1)} V-Бонусов\n` +
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

// Защищенный маршрут создания заказа
app.post('/api/create-order', checkAuth, async (req, res) => {
    try {
        if (!req.body.order) {
            return res.status(400).json({ error: 'Данные заказа отсутствуют.' });
        }
        
        // --- ИСПРАВЛЕНИЕ ЗДЕСЬ ---
        // Данные уже являются объектом благодаря middleware express.json(), поэтому JSON.parse не нужен.
        const orderData = req.body.order;
        
        const userRef = db.collection('users').doc(orderData.userId);

        await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userRef);
            if (!userDoc.exists) {
                throw new Error("Пользователь не найден");
            }
            const userData = userDoc.data();
            const orderRef = db.collection('orders').doc(orderData.id);

            const userUpdates = {
                orders: admin.firestore.FieldValue.arrayUnion({
                    id: orderData.id,
                    orderNumber: orderData.orderNumber,
                    status: 'new',
                    createdAt: orderData.createdAt
                }),
                tags: admin.firestore.FieldValue.arrayUnion(orderData.city.toLowerCase().replace(/\s/g, '-'))
            };

            if (orderData.vcoin_cost && orderData.vcoin_cost > 0) {
                const currentBalance = userData.vcoin_balance || 0;
                if (currentBalance >= orderData.vcoin_cost) {
                    userUpdates.vcoin_balance = currentBalance - orderData.vcoin_cost;
                } else {
                    userUpdates.vcoin_balance = 0;
                }
            } else {
                userUpdates.lastOrderTimestamp = orderData.createdAt;
                userUpdates.cooldownNotified = false;
            }
            
            transaction.set(orderRef, orderData);
            transaction.update(userRef, userUpdates);
        });
        
        await sendAdminNotification(orderData);

        res.status(201).json({ message: 'Заказ успешно создан' });
    } catch (error) {
        console.error('Ошибка при создании заказа на сервере:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера при создании заказа.' });
    }
});

// Защищенный маршрут загрузки изображения для меню
app.post('/api/upload-menu-image', checkAuth, async (req, res) => {
    if (!IMGBB_API_KEY) {
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


// Защищенный маршрут для импорта меню
app.post('/api/import-menu-from-file', checkAuth, async (req, res) => {
    if (!req.files || !req.files.menuFile) {
        return res.status(400).json({ error: 'Файл меню не был загружен.' });
    }

    try {
        const workbook = xlsx.read(req.files.menuFile.data, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const menuData = xlsx.utils.sheet_to_json(worksheet);

        if (menuData.length === 0) {
            return res.status(400).json({ error: 'Файл пустой или имеет неверный формат.' });
        }
        
        const menuCollection = db.collection('menu');
        const oldMenuSnapshot = await menuCollection.get();
        const deleteBatch = db.batch();
        oldMenuSnapshot.docs.forEach(doc => deleteBatch.delete(doc.ref));
        await deleteBatch.commit();
        
        const addBatch = db.batch();
        let addedCount = 0;
        menuData.forEach(item => {
            if (item.name && item.price) {
                const newItemRef = menuCollection.doc();
                addBatch.set(newItemRef, {
                    name: String(item.name),
                    description: String(item.description || ''),
                    price: Number(item.price),
                    category: String(item.category || 'Без категории'),
                    subcategory: String(item.subcategory || ''),
                    imageUrl: '',
                    isVisible: true
                });
                addedCount++;
            }
        });

        await addBatch.commit();

        res.status(200).json({ message: `Импорт завершен. Добавлено ${addedCount} блюд.` });
    } catch (error) {
        console.error('Ошибка импорта меню из файла:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера при импорте.' });
    }
});


// Защищенный маршрут экспорта пользователей
app.post('/api/export-users', checkAuth, async (req, res) => {
    try {
        const { data, chatId } = req.body;
        const formattedData = data.map(user => {
            const reg = user.registration || user;
            const instagramLogin = (reg.instagramLogin || '').replace('@', '');
            const url = `https://www.instagram.com/${instagramLogin}`;
            return {
                'Имя': reg.firstName, 'Телефон': reg.phone,
                'Instagram': `=HYPERLINK("${url}", "@${instagramLogin}")`,
                'Подписчики': reg.followersCount, 'Просмотры': reg.avgViews, 'Рейтинг': calculateBloggerRating(user),
                'Уровень': determineBloggerLevel(reg.followersCount).text, 
                'Баланс V-Бонусов': user.vcoin_balance || 0,
                'Лимит V-Бонусов': user.vcoin_allowance || 0,
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

// Защищенный маршрут экспорта заказов
app.post('/api/export-orders', checkAuth, async (req, res) => {
    try {
        const { data, chatId } = req.body;
        const formattedData = data.map(order => {
            const instagramLogin = (order.instagram || '').replace('@', '');
            const url = `https://www.instagram.com/${instagramLogin}`;
            return {
                'Номер заказа': order.orderNumber, 'Статус': getStatusInfo(order.status).text, 'Имя блогера': order.userName,
                'Телефон блогера': order.phone,
                'Instagram': `=HYPERLINK("${url}", "@${instagramLogin}")`,
                'Город': order.city, 'Адрес': `${order.street}, п. ${order.entrance || '-'}, эт. ${order.floor || '-'}`,
                'Дата доставки': order.date, 'Время доставки': order.time,
                'Стоимость (V-Бонусы)': order.vcoin_cost ? order.vcoin_cost.toFixed(1) : '-',
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

// Защищенный маршрут для рассылки
app.post('/api/broadcast', checkAuth, async (req, res) => {
    const { message, tags, senderChatId } = req.body;

    if (!message || !senderChatId) {
        return res.status(400).json({ error: 'Требуется сообщение и ID отправителя.' });
    }

    res.status(202).json({ message: 'Процесс рассылки запущен.' });

    try {
        let usersQuery = db.collection('users');
        
        if (tags && tags.length > 0) {
            usersQuery = usersQuery.where('tags', 'array-contains-any', tags);
        }

        const snapshot = await usersQuery.get();
        if (snapshot.empty) {
            await bot.sendMessage(senderChatId, 'Рассылка завершена. Не найдено пользователей по вашим фильтрам.');
            return;
        }

        let successCount = 0;
        let failureCount = 0;
        const totalUsers = snapshot.size;

        await bot.sendMessage(senderChatId, `🚀 Начинаю рассылку... Всего пользователей: ${totalUsers}`);
        
        for (const doc of snapshot.docs) {
            const user = doc.data();
            if (user.telegramId) {
                try {
                    const personalized = personalizeMessage(message, user);
                    await bot.sendMessage(user.telegramId, personalized, { parse_mode: 'Markdown', disable_web_page_preview: true });
                    successCount++;
                } catch (error) {
                    failureCount++;
                    console.error(`Не удалось отправить сообщение ${user.telegramId}:`, error.response?.body?.description || error.message);
                }
            } else {
                failureCount++;
            }
        }

        const reportMessage = `✅ Рассылка завершена!\n\n` +
                              `- Успешно отправлено: ${successCount}\n` +
                              `- Не удалось отправить: ${failureCount}`;
        await bot.sendMessage(senderChatId, reportMessage);

    } catch (error) {
        console.error('КРИТИЧЕСКАЯ ОШИБКА РАССЫЛКИ:', error);
        await bot.sendMessage(senderChatId, `❌ Произошла критическая ошибка во время рассылки. Проверьте логи сервера. \n\nОшибка: ${error.message}`);
    }
});

// ======================================================================
// === CRON ЗАДАЧИ ===
// ======================================================================
cron.schedule('*/30 * * * *', async () => {
    console.log('CRON: Запуск проверки напоминаний об отчетах...');
    try {
        const now = new Date();
        const twentyFourHoursAgo = new Date(now.getTime() - (24 * 60 * 60 * 1000));

        const ordersSnapshot = await db.collection('orders')
            .where('status', '==', 'delivered')
            .where('reminderSent', '==', false)
            .get();

        if (ordersSnapshot.empty) {
            return;
        }

        for (const doc of ordersSnapshot.docs) {
            const order = doc.data();
            const deliveryDate = new Date(order.createdAt); 

            if (deliveryDate <= twentyFourHoursAgo) {
                const userDoc = await db.collection('users').doc(order.userId).get();
                if (userDoc.exists) {
                    const user = userDoc.data();
                    if (user.telegramId) {
                        const message = `👋 Привет, ${user.registration.firstName}! Напоминаем, что мы ждем отчет по вашему заказу \`${order.orderNumber}\`. Пожалуйста, сдайте его в личном кабинете.`;
                        try {
                            await bot.sendMessage(user.telegramId, message, { parse_mode: 'Markdown' });
                            await doc.ref.update({ reminderSent: true });
                            console.log(`CRON: Напоминание отправлено пользователю ${user.telegramId} по заказу ${order.orderNumber}`);
                        } catch (error) {
                            console.error(`CRON: Ошибка отправки напоминания пользователю ${user.telegramId}:`, error.response?.body?.description || error.message);
                        }
                    }
                }
            }
        }
    } catch (error) {
        console.error('CRON: Критическая ошибка при проверке напоминаний:', error);
    }
});


// ======================================================================
// === ЗАПУСК СЕРВЕРА ===
// ======================================================================
app.listen(PORT, () => {
    console.log(`Сервер успешно запущен на порту ${PORT}`);
});
