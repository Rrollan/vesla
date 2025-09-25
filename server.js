// --- ЗАВИСИМОСТИ ---
const express = require('express');
const path = require('path');
const admin = require('firebase-admin');
const cron = require('node-cron');
const fetch = require('node-fetch');

// --- ИНИЦИАЛИЗАЦИЯ ---
const app = express();
const PORT = process.env.PORT || 10000; // Render предоставит этот порт

// --- ИНИЦИАЛИЗАЦИЯ FIREBASE ADMIN SDK ---
// ВАЖНО: Мы используем блок try...catch, чтобы приложение не "падало",
// если секретный файл не найден (например, при локальном запуске).
try {
  const serviceAccount = require('/etc/secrets/serviceAccountKey.json'); 
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
} catch (error) {
  console.error("Ключ сервисного аккаунта Firebase не найден. Cron-задачи не будут работать.");
  console.log("Это нормально, если вы не настраивали секретный файл.");
}

const db = admin.firestore();
const TELEGRAM_BOT_TOKEN = '8227812944:AAFy8ydOkUeCj3Qkjg7_Xsq6zyQpcUyMShY'; // Ваш токен

// --- ЛОГИКА СЕРВЕРА ---

// 1. Отдаем статические файлы (index.html, logo.jpg и т.д.)
// Express будет искать файлы в той же папке, где лежит server.js
app.use(express.static(path.join(__dirname, '/')));

// 2. Отдаем index.html при заходе на главную страницу
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- ЛОГИКА PUSH-УВЕДОМЛЕНИЙ (CRON JOB) ---
async function checkAndNotifyUsers() {
  // Эта функция будет работать, только если Firebase Admin SDK успешно инициализировался
  if (!admin.apps.length) {
      console.log('Firebase Admin не инициализирован, пропуск задачи уведомлений.');
      return;
  }
  console.log('Запуск ежедневной проверки уведомлений...');
  try {
      const settingsSnap = await db.collection('settings').doc('config').get();
      const orderCooldownDays = settingsSnap.exists ? settingsSnap.data().orderCooldownDays : 7;
      
      const usersQuery = db.collection('users')
                          .where('lastOrderTimestamp', '!=', null)
                          .where('cooldownNotified', '==', false);

      const usersSnap = await usersQuery.get();
      if (usersSnap.empty) {
          console.log("Нет пользователей для уведомления.");
          return;
      }

      const now = new Date();
      const promises = [];

      usersSnap.forEach(doc => {
          const user = doc.data();
          const lastOrderDate = new Date(user.lastOrderTimestamp);
          const cooldownEndDate = new Date(lastOrderDate.setDate(lastOrderDate.getDate() + orderCooldownDays));

          if (now >= cooldownEndDate && user.telegramId) {
              const message = `🎉 Привет, ${user.registration.firstName}! У вас снова доступна возможность сделать заказ по бартеру. Ждем вас!`;
              const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
              const body = JSON.stringify({ chat_id: user.telegramId, text: message });

              console.log(`Отправка уведомления: ${user.registration.firstName} (${user.telegramId})`);
              const sendPromise = fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
                  .then(res => res.json())
                  .then(json => {
                      if (json.ok) return doc.ref.update({ cooldownNotified: true });
                      else console.error(`Ошибка Telegram для ${user.telegramId}: ${json.description}`);
                  })
                  .catch(err => console.error(`Ошибка сети для ${user.telegramId}:`, err));
              promises.push(sendPromise);
          }
      });

      await Promise.all(promises);
      console.log('Проверка завершена.');
  } catch (error) {
      console.error('Ошибка в задаче уведомлений:', error);
  }
}

// Запуск планировщика каждый день в 9:00 по времени Алматы
cron.schedule('0 9 * * *', checkAndNotifyUsers, { timezone: "Asia/Almaty" });

// --- ЗАПУСК СЕРВЕРА ---
app.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
    console.log('Планировщик уведомлений активен.');
});
