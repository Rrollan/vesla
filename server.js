// --- ЗАВИСИМОСТИ ---
const express = require('express');
const path = require('path');
const admin = require('firebase-admin');
const cron = require('node-cron');
const fetch = require('node-fetch');

// --- ИНИЦИАЛИЗАЦИЯ ---
const app = express();
const PORT = process.env.PORT || 10000;

// --- ИНИЦИАЛИЗАЦИЯ FIREBASE ADMIN SDK ---
try {
  const serviceAccount = require('/etc/secrets/serviceAccountKey.json'); 
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
} catch (error) {
  console.error("Ключ сервисного аккаунта Firebase не найден. Cron-задачи не будут работать.");
}

const db = admin.firestore();
const TELEGRAM_BOT_TOKEN = '8227812944:AAFy8ydOkUeCj3Qkjg7_Xsq6zyQpcUyMShY'; // Ваш токен

// --- ЛОГИКА СЕРВЕРА ---
app.use(express.static(path.join(__dirname, '/')));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- PUSH-УВЕДОМЛЕНИЯ ---

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
      if (usersSnap.empty) return;

      const now = new Date();
      const promises = [];
      usersSnap.forEach(doc => {
          const user = doc.data();
          const lastOrderDate = new Date(user.lastOrderTimestamp);
          const cooldownEndDate = new Date(lastOrderDate.setDate(lastOrderDate.getDate() + orderCooldownDays));

          if (now >= cooldownEndDate && user.telegramId) {
              const message = `🎉 Привет, ${user.registration.firstName}! У вас снова доступна возможность сделать заказ по бартеру. Ждем вас!`;
              promises.push(sendNotificationAndUpdate(user.telegramId, message, doc.ref, { cooldownNotified: true }));
          }
      });
      await Promise.all(promises);
      console.log('Проверка доступности заказов завершена.');
  } catch (error) {
      console.error('Ошибка в задаче уведомлений о доступности:', error);
  }
}

// 2. Напоминание о сдаче отчета (каждый час)
async function checkReportReminders() {
    if (!admin.apps.length) return;
    console.log('Запуск ежечасной проверки напоминаний об отчетах...');
    try {
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const twentyThreeHoursAgo = new Date(Date.now() - 23 * 60 * 60 * 1000);

        const ordersQuery = db.collection('orders')
                                .where('status', '==', 'delivered')
                                .where('reminderSent', '==', false)
                                .where('createdAt', '<=', twentyThreeHoursAgo.toISOString())
                                .where('createdAt', '>=', twentyFourHoursAgo.toISOString());
        
        const ordersSnap = await ordersQuery.get();
        if (ordersSnap.empty) return;

        const promises = [];
        ordersSnap.forEach(doc => {
            const order = doc.data();
            if (order.userId) {
                const message = `⏰ Напоминание: остался 1 час для сдачи отчета по заказу #${order.orderNumber}. Пожалуйста, не забудьте прикрепить ссылку в приложении.`;
                // Получаем ID пользователя для отправки
                db.collection('users').doc(order.userId).get().then(userDoc => {
                    if (userDoc.exists && userDoc.data().telegramId) {
                       promises.push(sendNotificationAndUpdate(userDoc.data().telegramId, message, doc.ref, { reminderSent: true }));
                    }
                });
            }
        });
        await Promise.all(promises);
        console.log('Проверка напоминаний об отчетах завершена.');
    } catch (error) {
        console.error('Ошибка в задаче напоминаний об отчетах:', error);
    }
}

// Вспомогательная функция для отправки
async function sendNotificationAndUpdate(chatId, message, docRef, updateData) {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const body = JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'Markdown' });
    try {
        const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
        const json = await response.json();
        if (json.ok) {
            await docRef.update(updateData);
            console.log(`Уведомление для ${chatId} отправлено, документ обновлен.`);
        } else {
            console.error(`Ошибка Telegram для ${chatId}: ${json.description}`);
        }
    } catch (err) {
        console.error(`Сетевая ошибка для ${chatId}:`, err);
    }
}


// --- ПЛАНИРОВЩИКИ ---
cron.schedule('0 9 * * *', checkAndNotifyUsers, { timezone: "Asia/Almaty" });
cron.schedule('0 * * * *', checkReportReminders, { timezone: "Asia/Almaty" }); // Каждый час в 00 минут

// --- ЗАПУСК СЕРВЕРА ---
app.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
    console.log('Планировщики активны.');
});
