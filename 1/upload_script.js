
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

// ===============================================================
// === НАСТРОЙКИ (ЭТОТ БЛОК НУЖНО ОТРЕДАКТИРОВАТЬ) ===
// ===============================================================

// 1. Вставьте ваш API ключ от ImgBB. Его можно получить на сайте imgbb.com в разделе "About -> API"
const IMGBB_API_KEY = '5148efee12c90f87021e50e0155d17a0'; // Я оставил ваш ключ из server.js

// 2. Укажите путь к папке с вашими изображениями
const PATH_TO_IMAGES_FOLDER = path.join(__dirname, 'menu_images');

// 3. Убедитесь, что путь к вашему serviceAccountKey.json верный
const PATH_TO_SERVICE_ACCOUNT_KEY = './serviceAccountKey.json';

// ===============================================================

// --- ИНИЦИАЛИЗАЦИЯ FIREBASE ---
try {
  const serviceAccount = require(PATH_TO_SERVICE_ACCOUNT_KEY);
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  }
} catch (error) {
  console.error("КРИТИЧЕСКАЯ ОШИБКА: Ключ сервисного аккаунта Firebase не найден.");
  process.exit(1);
}

const db = admin.firestore();

// Вспомогательная функция для создания задержки
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function uploadImages() {
    console.log('🚀 Запуск скрипта автоматической загрузки изображений...');
    
    try {
        // 1. Получаем все блюда из базы данных
        console.log('🔄 Получение списка всех блюд из Firestore...');
        const menuSnapshot = await db.collection('menu').get();
        if (menuSnapshot.empty) {
            console.log('❌ В базе данных нет блюд. Нечего обновлять.');
            return;
        }

        // 2. Создаем карту "Название блюда -> ID документа" для быстрого поиска
        const nameToIdMap = new Map();
        menuSnapshot.forEach(doc => {
            nameToIdMap.set(doc.data().name.toLowerCase(), doc.id);
        });
        console.log(`✅ Найдено ${nameToIdMap.size} блюд в базе.`);

        // 3. Читаем все файлы из локальной папки
        const imageFiles = fs.readdirSync(PATH_TO_IMAGES_FOLDER);
        console.log(`✅ Найдено ${imageFiles.length} файлов изображений в папке.`);

        let updatedCount = 0;
        let skippedCount = 0;

        // 4. Проходим по каждому файлу, загружаем и обновляем запись в базе
        for (const fileName of imageFiles) {
            constitemName = path.parse(fileName).name; // Имя файла без расширения
            const filePath = path.join(PATH_TO_IMAGES_FOLDER, fileName);

            // Ищем ID блюда по имени файла (в нижнем регистре для надежности)
            const docId = nameToIdMap.get(itemName.toLowerCase());

            if (docId) {
                console.log(`\n- Обработка: "${itemName}"`);
                try {
                    const imageBuffer = fs.readFileSync(filePath);
                    
                    const formData = new FormData();
                    formData.append('key', IMGBB_API_KEY);
                    formData.append('image', imageBuffer.toString('base64'));

                    console.log('  📤 Загрузка на ImgBB...');
                    const response = await axios.post('https://api.imgbb.com/1/upload', formData);

                    if (response.data && response.data.success) {
                        const imageUrl = response.data.data.url;
                        await db.collection('menu').doc(docId).update({ imageUrl: imageUrl });
                        console.log(`  ✅ Успешно! Ссылка добавлена в Firestore.`);
                        updatedCount++;
                    } else {
                        console.error('  ❌ Ошибка ответа от ImgBB:', response.data);
                        skippedCount++;
                    }

                } catch (uploadError) {
                    console.error(`  ❌ Произошла ошибка при загрузке файла "${fileName}":`, uploadError.message);
                    skippedCount++;
                }
            } else {
                console.warn(`  ⚠️ Пропущено: Не найдено блюдо в базе для файла "${fileName}"`);
                skippedCount++;
            }

            // ЗАДЕРЖКА, чтобы не превысить лимит API
            console.log('  ...ждем 2 секунды...');
            await sleep(2000); 
        }

        console.log('\n=============================================');
        console.log('🎉 Скрипт завершил работу!');
        console.log(`  - Успешно обновлено: ${updatedCount}`);
        console.log(`  - Пропущено / с ошибкой: ${skippedCount}`);
        console.log('=============================================');

    } catch (error) {
        console.error('❌ Произошла критическая ошибка:', error);
    }
}

// Запускаем основную функцию
uploadImages();
