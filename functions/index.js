// functions/index.js
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const fetch = require("node-fetch");

admin.initializeApp();

const db = admin.firestore();

exports.sendTelegramBroadcast = functions.firestore
    .document("broadcasts/{broadcastId}")
    .onCreate(async (snap, context) => {
      const broadcastData = snap.data();
      const messageText = broadcastData.text;
      const tagFilter = broadcastData.tag;

      try {
        let usersQuery = db.collection("users");

        if (tagFilter) {
          console.log(`Рассылка по тегу: ${tagFilter}`);
          usersQuery = usersQuery.where("tags", "array-contains", tagFilter);
        }

        const usersSnapshot = await usersQuery.get();
        if (usersSnapshot.empty) {
          console.log("Не найдено пользователей для рассылки.");
          await snap.ref.update({ status: "completed", sentCount: 0 });
          return;
        }

        const telegramPromises = [];
        const BOT_TOKEN = functions.config().telegram.token;

        usersSnapshot.forEach(doc => {
          const user = doc.data();
          if (user.telegramId) {
            const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
            const promise = fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: user.telegramId,
                    text: messageText,
                    parse_mode: 'Markdown',
                    disable_web_page_preview: true
                })
            }).then(res => res.json());
            
            telegramPromises.push(promise);
          }
        });

        const results = await Promise.allSettled(telegramPromises);
        
        const sentCount = results.filter(r => r.status === 'fulfilled' && r.value.ok).length;
        console.log(`Рассылка завершена. Успешно отправлено: ${sentCount} из ${telegramPromises.length}`);

        await snap.ref.update({ status: "completed", sentCount: sentCount });

      } catch (error) {
        console.error("Критическая ошибка при рассылке:", error);
        await snap.ref.update({ status: "error", errorMessage: error.message });
      }
    });
