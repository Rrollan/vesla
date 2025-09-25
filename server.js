// --- ЗАВИСИМОСТИ ---
const express = require('express');
const path = require('path');
const admin = require('firebase-admin');
const cron = require('node-cron');
const fetch = require('node-fetch');

// --- ИНИЦИАЛИЗАЦИЯ ---
const app = express();
const PORT = process.env.PORT || 10000;
const TELEGRAM_BOT_TOKEN = '8227812944:AAFy8ydOkUeCj3Qkjg7_Xsq6zyQpcUyMShY'; // Ваш токен бота

// --- ИНИЦИАЛИЗАЦИЯ FIREBASE ADMIN SDK ---
try {
  // Render автоматически подставит переменную окружения, если она есть
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_KEY 
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)
    : require('/etc/secrets/serviceAccountKey.json'); 
  
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  }
} catch (error) {
  console.error("КРИТИЧЕСКАЯ ОШИБКА: Ключ сервисного аккаунта Firebase не найден. Проверьте переменные окружения.");
}
const db = admin.firestore();


// --- MIDDLEWARE ---
// Обслуживание статичных файлов (index.html, logo.jpg, и т.д.)
app.use(express.static(path.join(__dirname, '/')));
// Middleware для парсинга JSON-запросов и CORS
app.use(express.json());
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// --- ГЛАВНЫЙ МАРШРУТ (для отдачи index.html) ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});


// ======================================================================
// === НОВЫЙ БЛОК: API ДЛЯ МАССОВОЙ РАССЫЛКИ ===
// ======================================================================
app.post('/api/broadcast', async (req, res) => {
    const { message, tags, senderChatId } = req.body;

    if (!message) {
        return res.status(400).json({ error: 'Текст сообщения обязателен.' });
    }
    if (!senderChatId) {
        return res.status(400).json({ error: 'Не указан ID чата администратора для отчета.' });
    }
    
    // Сразу отвечаем приложению, что задача принята.
    res.status(202).json({ message: 'Рассылка запущена. Отчет о завершении придет в личные сообщения.' });

    // Асинхронно выполняем долгую задачу рассылки
    (async () => {
        try {
            let usersQuery = db.collection('users');
            if (tags && tags.length > 0) {
                usersQuery = usersQuery.where("tags", "array-contains-any", tags);
            }

            const usersSnapshot = await usersQuery.get();
            if (usersSnapshot.empty) {
                await sendTelegramNotification(senderChatId, '⚠️ Рассылка завершена. Не найдено ни одного пользователя по вашим критериям.');
                return;
            }

            const usersToSend = usersSnapshot.docs
                .map(doc => doc.data().telegramId)
                .filter(id => id);

            if (usersToSend.length === 0) {
                 await sendTelegramNotification(senderChatId, '⚠️ Рассылка завершена. Пользователи найдены, но ни у кого из них нет Telegram ID.');
                 return;
            }

            let successCount = 0;
            let errorCount = 0;

            for (const chatId of usersToSend) {
                try {
                    const response = await sendTelegramNotification(chatId, message, true); // true, чтобы получить ответ
                    if (response.ok) successCount++;
                    else errorCount++;
                } catch (e) {
                    errorCount++;
                }
                // Пауза 100 мс (10 сообщений в секунду) для обхода лимитов
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            // Отправляем отчет о завершении администратору
            const reportMessage = `✅ Рассылка завершена!\n\nУспешно отправлено: ${successCount}\nОшибок: ${errorCount}`;
            await sendTelegramNotification(senderChatId, reportMessage);

        } catch (error) {
            console.error('Критическая ошибка в процессе рассылки:', error);
            await sendTelegramNotification(senderChatId, `❌ Произошла критическая ошибка во время рассылки: ${error.message}`);
        }
    })();
});


// ======================================================================
// === ВАШ СТАРЫЙ КОД: ПЛАНИРОВЩИКИ И УВЕДОМЛЕНИЯ (немного улучшен) ===
// ======================================================================

// 1. Уведомление о доступности нового заказа (раз в день)
async function checkAndNotifyUsers() {
  if (!admin.apps.length) return;
  console.log('Запуск ежедневной проверки доступности заказов...');
  try {
      const settingsSnap = await db.collection('settings').doc('config').get();
      const orderCooldownDays = settingsSnap.exists ? settingsSnap.data().orderCooldownDays : 7;
      
      const usersQuery = db.collection('users')
                          .where('lastOrderTimestamp', '!=', null)
                          .where('cooldownNotified', '==', false);
      const usersSnap = await usersQuery.get();
      if (usersSnap.empty) {
          console.log('Проверка доступности: не найдено пользователей для уведомления.');
          return;
      }

      const now = new Date();
      usersSnap.forEach(doc => {
          const user = doc.data();
          const lastOrderDate = new Date(user.lastOrderTimestamp);
          const cooldownEndDate = new Date(lastOrderDate.setDate(lastOrderDate.getDate() + orderCooldownDays));

          if (now >= cooldownEndDate && user.telegramId) {
              const message = `🎉 Привет, ${user.registration.firstName}! У вас снова доступна возможность сделать заказ по бартеру. Ждем вас!`;
              sendAndUpdate(user.telegramId, message, doc.ref, { cooldownNotified: true });
          }
      });
  } catch (error) {
      console.error('Ошибка в задаче уведомлений о доступности:', error);
  }
}

// 2. Напоминание о сдаче отчета (каждый час)
async function checkReportReminders() {
    if (!admin.apps.length) return;
    console.log('Запуск ежечасной проверки напоминаний об отчетах...');
    try {
        const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

        const ordersQuery = db.collectionGroup('orders')
                                .where('status', '==', 'delivered')
                                .where('reminderSent', '==', false)
                                .where('createdAt', '<=', twentyFourHoursAgo)
                                .where('createdAt', '>', twentyFiveHoursAgo);
        
        const ordersSnap = await ordersQuery.get();
        if (ordersSnap.empty) {
            console.log('Проверка напоминаний: не найдено заказов для напоминания.');
            return;
        }

        ordersSnap.forEach(async (doc) => {
            const order = doc.data();
            if (order.userId) {
                const userDoc = await db.collection('users').doc(order.userId).get();
                if (userDoc.exists && userDoc.data().telegramId) {
                   const message = `⏰ Напоминание: остался 1 час для сдачи отчета по заказу #${order.orderNumber}. Пожалуйста, не забудьте прикрепить ссылку в приложении.`;
                   sendAndUpdate(userDoc.data().telegramId, message, doc.ref, { reminderSent: true });
                }
            }
        });
    } catch (error) {
        console.error('Ошибка в задаче напоминаний об отчетах:', error);
    }
}

// Общая вспомогательная функция для отправки
async function sendAndUpdate(chatId, message, docRef, updateData) {
    try {
        const response = await sendTelegramNotification(chatId, message, true);
        if (response.ok) {
            await docRef.update(updateData);
            console.log(`Уведомление для ${chatId} отправлено, документ обновлен.`);
        } else {
            console.error(`Ошибка Telegram для ${chatId}: ${response.description}`);
        }
    } catch (err) {
        console.error(`Сетевая ошибка для ${chatId}:`, err);
    }
}

// Универсальная функция отправки в Telegram
async function sendTelegramNotification(chatId, text, returnResponse = false) {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'Markdown' })
        });
        const result = await response.json();
        if (returnResponse) return result;
        if (!result.ok) throw new Error(result.description);
    } catch (error) {
        console.error(`Ошибка отправки в Telegram для ${chatId}:`, error);
        if (returnResponse) return { ok: false, description: error.message };
        // ** ИСПРАВЛЕНИЕ: ВОЗВРАЩЕНА НЕДОСТАЮЩАЯ СКОБКА **
    }
}


// --- ПЛАНИРОВЩИКИ ---
cron.schedule('0 9 * * *', checkAndNotifyUsers, { timezone: "Asia/Almaty" });
cron.schedule('0 * * * *', checkReportReminders, { timezone: "Asia/Almaty" }); 

// --- ЗАПУСК СЕРВЕРА ---
app.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
    console.log('Планировщики активны.');
});
