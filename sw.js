// Service worker (T7, §7 спеки и §11 контракта). Классический скрипт,
// не ES-модуль: модульные SW до сих пор не везде поддержаны, а сборщика,
// который сделал бы из модуля классику, в проекте нет (§0 контракта).
//
// Стратегии:
//   навигация      — оболочка из кэша (index.html), сеть только если копии нет;
//   ./catalog.json — network-first с откатом в кэш;
//   прочая статика — cache-first, промах дозагружается в кэш;
//   api.github.com — НЕ ПЕРЕХВАТЫВАЕТСЯ ВООБЩЕ (см. ниже).
//
// Почему index.json здесь не кэшируется, хотя §8 спеки просит «оболочку
// и последний index.json»: index.json лежит в приватном repo B и приходит
// только из api.github.com — с токеном в заголовке и с параметром _cb,
// уникальным на каждый запрос (§4 контракта). Совпадений в CacheStorage
// такой запрос не даст никогда, а положить туда ответ значило бы завести
// вторую копию приватных данных рядом с той, которую уже ведёт store.js.
// Роль «последнего index.json» исполняет bm.index_cache в localStorage:
// шпаргалка рисуется из него ещё до первого сетевого запроса (T4).

const VERSION = '2026-08-19-1'; // ПОДНИМАТЬ ПРИ КАЖДОМ ДЕПЛОЕ
const CACHE_NAME = `bm-shell-${VERSION}`;

// Префикс обязателен: на github.io все проекты пользователя делят один
// origin, и в caches.keys() лежат чужие кэши. Удаляем только свои.
const CACHE_PREFIX = 'bm-shell-';

// Оболочка целиком. Список ведётся руками — сборщика нет. Каждый новый
// модуль обязан появиться здесь, иначе офлайн-старт сломается ровно на том
// экране, который его импортирует. Сторож полноты — sw.selftest.mjs.
const SHELL = [
  './index.html',
  './style.css',
  './app.js',
  './store.js',
  './github.js',
  './catalog.js',
  './session.js',
  './queue.js',
  './sparkline.js',
  './figure.js',
  './asof.js',
  './screens/cheatsheet.js',
  './screens/figure.js',
  './screens/entry.js',
  './screens/history.js',
  './screens/settings.js',
  './catalog.json',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

// Промах по этим файлам установку не валит: без иконки хуже выглядит
// установка на домашний экран, но приложение работает. Всё остальное
// из SHELL — код и стиль, без них офлайн-старта нет.
const OPTIONAL = [
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

// Сеть на «lie-fi» не отвечает и не падает. Ждать её на catalog.json нельзя:
// первый рендер шпаргалки ждёт каталог, а §8 спеки требует отрисовки < 1 с.
const NETWORK_TIMEOUT_MS = 2500;

function scopeURL(path) {
  return new URL(path, self.location.href).href;
}

// ===== Установка ==========================================================

async function precache() {
  const cache = await caches.open(CACHE_NAME);
  const failed = [];

  // Поштучно, а не cache.addAll: addAll атомарен, и одна отсутствующая
  // иконка оставила бы приложение вообще без кэша оболочки.
  await Promise.all(SHELL.map(async (path) => {
    try {
      // cache: 'reload' — копия берётся из сети мимо HTTP-кэша браузера,
      // иначе новая версия закэшировала бы старые файлы.
      await cache.add(new Request(scopeURL(path), { cache: 'reload' }));
    } catch {
      failed.push(path);
    }
  }));

  const fatal = failed.filter((path) => !OPTIONAL.includes(path));
  if (fatal.length > 0) {
    // Установка проваливается намеренно: половина оболочки в кэше хуже,
    // чем её отсутствие — предыдущая версия остаётся рабочей.
    throw new Error(`Оболочка не закэширована: ${fatal.join(', ')}`);
  }
  if (failed.length > 0) {
    console.warn('[sw] не закэшировано (некритично):', failed.join(', '));
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache());
});

// skipWaiting() здесь нет намеренно. Стратегия cache-first раздаёт модули
// из кэша своей версии; если новый worker захватит уже открытую страницу,
// старый app.js начнёт подтягивать новые screens/*.js через import().
// Новая версия включается при следующем полном запуске приложения,
// а про её готовность app.js говорит уведомлением.

// ===== Активация ==========================================================

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

// ===== Ответы =============================================================

function offlineResponse() {
  return new Response('Нет сети, и копии этого файла в кэше нет.', {
    status: 503,
    statusText: 'Offline',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
}

function fetchWithTimeout(request, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(request, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function handleNavigate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(scopeURL('./index.html'));
  if (cached) return cached;
  try {
    return await fetch(request);
  } catch {
    return offlineResponse();
  }
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetchWithTimeout(request, NETWORK_TIMEOUT_MS);
    if (response && response.ok) {
      await cache.put(request, response.clone());
      return response;
    }
    // 404 или 500 после деплоя: старая копия полезнее страницы ошибки.
    const cached = await cache.match(request, { ignoreSearch: true });
    return cached ?? response;
  } catch {
    const cached = await cache.match(request, { ignoreSearch: true });
    return cached ?? offlineResponse();
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return cached;
  try {
    const response = await fetch(request);
    // Кладём только удачные ответы: закэшированная 404 пережила бы деплой,
    // который её чинит.
    if (response && response.ok) await cache.put(request, response.clone());
    return response;
  } catch {
    return offlineResponse();
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Чужой origin — мимо, без respondWith. Прежде всего api.github.com:
  // его запросы несут токен и обязаны идти в сеть как есть (§0, §4).
  if (url.origin !== self.location.origin) return;
  // Соседние проекты на том же github.io — не наша зона.
  if (!url.pathname.startsWith(new URL('./', self.location.href).pathname)) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigate(request));
    return;
  }
  if (url.pathname === new URL('./catalog.json', self.location.href).pathname) {
    event.respondWith(networkFirst(request));
    return;
  }
  event.respondWith(cacheFirst(request));
});

// Новая оболочка захватывает открытую страницу только по явной команде из
// Настроек (T8). Без неё ожидающий worker включится при следующем запуске.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'skip-waiting') self.skipWaiting();
});
