// Намеренная заглушка T1 (§11 контракта): service worker ничего не кэширует
// и не регистрируется из app.js. Активный кэш на этапе разработки прячет
// свежие правки. Полноценная стратегия (cache-first для оболочки,
// network-first для index.json, версионирование кэша) появится в T7.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Обработчика 'fetch' нет намеренно — все запросы идут в сеть напрямую.
