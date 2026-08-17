// Автотест service worker (T7, §7.5 контракта, §8 спеки).
//
// Запуск (node на PATH — v6.17.1, ES-модулей не понимает, §12 контракта):
//
//   C:\Users\user\AppData\Roaming\nvm\v24.4.0\node.exe sw.selftest.mjs
//
// Только stdlib: ни npm-пакетов, ни тест-раннера, ни моков SW (§0 контракта).
//
// sw.js — классический скрипт, а не ES-модуль, поэтому import() его не берёт:
// исходник выполняется через node:vm в этом же реалме, а недостающие
// глобальные объекты (self, caches, fetch) подставлены ниже вручную.
// Request/Response берутся настоящие — они в node есть.
//
// Сеть отвечает по реальному содержимому каталога measurements-app: файла нет
// на диске — нет и в ответе. Поэтому лишняя строка в списке оболочки валит
// установку и ловится тестом сама собой, отдельной проверки не нужно.

import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const APP_DIR = new URL('./', import.meta.url);
const ORIGIN = 'https://example.github.io';
const SCOPE = '/measurements-app/';
const SW_URL = `${ORIGIN}${SCOPE}sw.js`;

function relToURL(rel) {
  return `${ORIGIN}${SCOPE}${rel.replace(/^\.\//, '')}`;
}

function urlToRel(url) {
  return `./${String(url).slice(`${ORIGIN}${SCOPE}`.length)}`;
}

// ===== Заглушка сети ======================================================

// Пути, которые сеть «потеряла» в текущем сценарии.
const missing = new Set();
let online = true;
let hang = false; // «lie-fi»: соединение есть, ответа нет
const netLog = [];

function urlOf(request) {
  return typeof request === 'string' ? request : request.url;
}

function diskPath(url) {
  const rel = new URL(url).pathname.slice(SCOPE.length);
  return rel === '' ? 'index.html' : rel;
}

globalThis.fetch = function fakeFetch(request, init = {}) {
  const url = urlOf(request);
  netLog.push(url);

  if (hang) {
    // Отвечаем только на abort — иначе запрос висит вечно, как на «lie-fi».
    return new Promise((resolve, reject) => {
      const signal = init.signal;
      if (!signal) return;
      signal.addEventListener('abort', () => reject(new Error('AbortError')));
    });
  }
  if (!online) return Promise.reject(new TypeError('Failed to fetch'));

  const rel = diskPath(url);
  const file = new URL(rel, APP_DIR);
  if (missing.has(`./${rel}`) || !existsSync(file)) {
    return Promise.resolve(new Response('not found', { status: 404 }));
  }
  return Promise.resolve(new Response(readFileSync(file), { status: 200 }));
};

// ===== Заглушка CacheStorage ==============================================

function stripQuery(url) {
  const cut = String(url).indexOf('?');
  return cut === -1 ? String(url) : String(url).slice(0, cut);
}

class FakeCache {
  constructor() {
    this.entries = new Map();
  }

  async add(request) {
    const response = await globalThis.fetch(request);
    // Настоящий Cache.add бросает на любом неуспешном ответе.
    if (!response.ok) throw new TypeError(`bad response for ${urlOf(request)}`);
    this.entries.set(urlOf(request), response);
  }

  async put(request, response) {
    this.entries.set(urlOf(request), response);
  }

  async match(request, options = {}) {
    const url = urlOf(request);
    if (this.entries.has(url)) return this.entries.get(url);
    if (options.ignoreSearch) {
      const bare = stripQuery(url);
      for (const [key, value] of this.entries) {
        if (stripQuery(key) === bare) return value;
      }
    }
    return undefined; // как настоящий Cache: промах — это undefined
  }
}

const cacheStore = new Map();

globalThis.caches = {
  async open(name) {
    if (!cacheStore.has(name)) cacheStore.set(name, new FakeCache());
    return cacheStore.get(name);
  },
  async keys() {
    return Array.from(cacheStore.keys());
  },
  async delete(name) {
    return cacheStore.delete(name);
  }
};

// ===== Заглушка ServiceWorkerGlobalScope ==================================

const listeners = new Map();
let claimed = false;
let skipWaitingCalls = 0;

globalThis.self = {
  location: new URL(SW_URL),
  addEventListener(type, handler) {
    listeners.set(type, handler);
  },
  skipWaiting() {
    skipWaitingCalls += 1;
  },
  clients: {
    async claim() {
      claimed = true;
    }
  }
};

function fireEvent(type, request) {
  const handler = listeners.get(type);
  assert.ok(handler, `sw.js не подписался на '${type}'`);
  const event = { request, waits: [], responded: null };
  event.waitUntil = (promise) => {
    event.waits.push(promise);
    promise.catch(() => {}); // гасим unhandled rejection, сам промис не трогаем
  };
  event.respondWith = (promise) => {
    event.responded = promise;
    promise.catch(() => {});
  };
  handler(event);
  return event;
}

function navigation() {
  // Request с mode: 'navigate' в node не сконструировать — sw.js читает
  // у запроса только method, url и mode, их и подставляем.
  return { url: relToURL('./'), method: 'GET', mode: 'navigate' };
}

function plainRequest(rel, extra = {}) {
  return { url: relToURL(rel), method: 'GET', mode: 'cors', ...extra };
}

// ===== Загрузка sw.js =====================================================

const SW_SOURCE = readFileSync(new URL('./sw.js', APP_DIR), 'utf8');
vm.runInThisContext(SW_SOURCE, { filename: fileURLToPath(new URL('./sw.js', APP_DIR)) });

let passed = 0;
let failed = 0;

async function step(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`✗ ${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

function reset() {
  cacheStore.clear();
  missing.clear();
  netLog.length = 0;
  online = true;
  hang = false;
  claimed = false;
}

// Установка + имя кэша и его содержимое в относительных путях.
async function install() {
  const event = fireEvent('install', null);
  await Promise.all(event.waits);
  assert.equal(cacheStore.size, 1, 'кэшей открыто не один');
  const [name, cache] = Array.from(cacheStore.entries())[0];
  return { name, files: Array.from(cache.entries.keys()).map(urlToRel).sort() };
}

async function installFails() {
  const event = fireEvent('install', null);
  return await Promise.all(event.waits).then(() => null, (error) => error);
}

// ===== Установка ==========================================================

let shell = [];

await step('install: оболочка попадает в версионированный кэш', async () => {
  reset();
  const { name, files } = await install();
  shell = files;
  assert.ok(/^bm-shell-.+/.test(name), `имя кэша без версии: ${name}`);
  assert.ok(files.includes('./index.html'), 'index.html не закэширован');
  assert.ok(files.includes('./app.js'), 'app.js не закэширован');
  assert.ok(files.includes('./catalog.json'), 'catalog.json не закэширован');
  assert.ok(files.includes('./screens/settings.js'), 'экраны не закэшированы');
});

await step('install: копии берутся мимо HTTP-кэша браузера (cache: reload)', async () => {
  reset();
  const seen = [];
  const real = globalThis.fetch;
  globalThis.fetch = (request, init) => {
    if (typeof request !== 'string') seen.push(request.cache);
    return real(request, init);
  };
  try {
    await install();
  } finally {
    globalThis.fetch = real;
  }
  assert.ok(seen.length > 0, 'ни одного Request при установке');
  assert.ok(seen.every((mode) => mode === 'reload'), `не все копии с reload: ${new Set(seen).size} режимов`);
});

await step('install: пропавшая иконка установку не валит', async () => {
  reset();
  missing.add('./icons/icon-maskable-512.png');
  const warn = console.warn;
  console.warn = () => {};
  try {
    const { files } = await install();
    assert.ok(files.includes('./app.js'), 'оболочка не закэширована');
    assert.ok(!files.includes('./icons/icon-maskable-512.png'), 'битая иконка попала в кэш');
  } finally {
    console.warn = warn;
  }
});

await step('install: пропавший модуль установку валит', async () => {
  reset();
  missing.add('./screens/entry.js');
  const error = await installFails();
  assert.ok(error, 'установка прошла с неполной оболочкой');
  assert.match(error.message, /screens\/entry\.js/, `в ошибке нет имени файла: ${error.message}`);
});

// ===== Активация ==========================================================

await step('activate: старые свои кэши удаляются, чужие остаются', async () => {
  reset();
  const { name } = await install();
  cacheStore.set('bm-shell-2020-01-01-1', new FakeCache());
  cacheStore.set('other-project-v3', new FakeCache()); // соседний проект на github.io

  const event = fireEvent('activate', null);
  await Promise.all(event.waits);

  const names = Array.from(cacheStore.keys());
  assert.deepEqual(names.sort(), [name, 'other-project-v3'].sort(), `осталось: ${names.join(', ')}`);
  assert.ok(claimed, 'clients.claim() не позван');
});

await step('install не зовёт skipWaiting: обновление ждёт перезапуска', async () => {
  reset();
  skipWaitingCalls = 0;
  await install();
  fireEvent('activate', null);
  assert.equal(skipWaitingCalls, 0, 'новый worker захватывает открытую страницу');
});

// ===== Стратегии ==========================================================

await step('навигация офлайн отдаёт index.html из кэша', async () => {
  reset();
  await install();
  online = false;
  netLog.length = 0;

  const event = fireEvent('fetch', navigation());
  const response = await event.responded;
  assert.equal(response.status, 200, 'офлайн-старт не удался');
  assert.match(await response.text(), /<main id="app"/, 'отдан не index.html');
});

await step('api.github.com не перехватывается вообще', async () => {
  reset();
  await install();
  const event = fireEvent('fetch', {
    url: 'https://api.github.com/repos/prozorovAlexey/measurements-data/contents/index.json?_cb=1',
    method: 'GET',
    mode: 'cors'
  });
  assert.equal(event.responded, null, 'запрос с токеном прошёл через кэш SW');
});

await step('чужой путь на том же origin не перехватывается', async () => {
  reset();
  await install();
  const event = fireEvent('fetch', { url: `${ORIGIN}/other-project/app.js`, method: 'GET', mode: 'cors' });
  assert.equal(event.responded, null, 'SW полез в соседний проект');
});

await step('не-GET не перехватывается', async () => {
  reset();
  await install();
  const event = fireEvent('fetch', { url: relToURL('./catalog.json'), method: 'PUT', mode: 'cors' });
  assert.equal(event.responded, null, 'запись прошла через кэш');
});

await step('catalog.json: сеть выигрывает у кэша (network-first)', async () => {
  reset();
  await install();
  const cache = Array.from(cacheStore.values())[0];
  await cache.put(relToURL('./catalog.json'), new Response('{"stale":true}', { status: 200 }));
  netLog.length = 0;

  const event = fireEvent('fetch', plainRequest('./catalog.json'));
  const text = await (await event.responded).text();
  assert.ok(netLog.includes(relToURL('./catalog.json')), 'сеть не спрошена');
  assert.ok(!text.includes('"stale"'), 'отдана старая копия при живой сети');
  assert.match(text, /"measurements"/, 'отдан не каталог');
});

await step('catalog.json офлайн: откат в кэш', async () => {
  reset();
  await install();
  online = false;
  const event = fireEvent('fetch', plainRequest('./catalog.json'));
  const response = await event.responded;
  assert.equal(response.status, 200, 'каталог офлайн не отдался');
  assert.match(await response.text(), /"waist_who"/, 'в кэше не каталог');
});

await step('catalog.json на «lie-fi»: копия отдаётся по таймауту (~2,5 с)', async () => {
  reset();
  await install();
  hang = true;
  const started = Date.now();
  const event = fireEvent('fetch', plainRequest('./catalog.json'));
  const response = await event.responded;
  const spent = Date.now() - started;
  assert.equal(response.status, 200, 'каталог не отдался');
  assert.match(await response.text(), /"waist_who"/, 'отдан не каталог');
  assert.ok(spent < 6000, `ждали слишком долго: ${spent} мс`);
});

await step('catalog.json: 404 после деплоя не затирает копию', async () => {
  reset();
  await install();
  missing.add('./catalog.json');
  const event = fireEvent('fetch', plainRequest('./catalog.json'));
  const response = await event.responded;
  assert.equal(response.status, 200, 'вместо копии отдана ошибка');
  assert.match(await response.text(), /"waist_who"/, 'отдан не каталог');
});

await step('статика: попадание в кэш сеть не трогает (cache-first)', async () => {
  reset();
  await install();
  netLog.length = 0;
  const event = fireEvent('fetch', plainRequest('./screens/cheatsheet.js'));
  const response = await event.responded;
  assert.equal(response.status, 200, 'модуль не отдался');
  assert.deepEqual(netLog, [], `сеть спрошена при попадании: ${netLog.join(', ')}`);
});

await step('статика: промах дозагружается и кладётся в кэш', async () => {
  reset();
  await install();
  const cache = Array.from(cacheStore.values())[0];
  cache.entries.delete(relToURL('./style.css'));

  const first = await (fireEvent('fetch', plainRequest('./style.css'))).responded;
  assert.equal(first.status, 200, 'промах не дозагрузился');

  netLog.length = 0;
  const second = await (fireEvent('fetch', plainRequest('./style.css'))).responded;
  assert.equal(second.status, 200, 'второй запрос не удался');
  assert.deepEqual(netLog, [], 'дозагруженное не попало в кэш');
});

await step('статика: 404 в кэш не кладётся', async () => {
  reset();
  await install();
  const event = fireEvent('fetch', plainRequest('./missing-module.js'));
  const response = await event.responded;
  assert.equal(response.status, 404, 'отсутствующий файл ответил не 404');

  const cache = Array.from(cacheStore.values())[0];
  assert.equal(await cache.match(relToURL('./missing-module.js')), undefined, '404 закэширована');
});

await step('статика офлайн и без копии: внятный 503, а не белый экран', async () => {
  reset();
  await install();
  online = false;
  const event = fireEvent('fetch', plainRequest('./missing-module.js'));
  const response = await event.responded;
  assert.equal(response.status, 503, `ответ ${response.status}`);
  assert.match(await response.text(), /Нет сети/, 'сообщение не по-русски и не по делу');
});

await step('T8: skip-waiting принимается только по явной команде', () => {
  skipWaitingCalls = 0;
  const handler = listeners.get('message');
  assert.equal(typeof handler, 'function', 'нет обработчика команды из Настроек');
  handler({ data: { type: 'другая-команда' } });
  assert.equal(skipWaitingCalls, 0, 'неизвестная команда включила worker');
  handler({ data: { type: 'skip-waiting' } });
  assert.equal(skipWaitingCalls, 1, 'новая версия не включилась');
});

// ===== Сторожа инвариантов ================================================

// Граф зависимостей, собранный от index.html: что реально нужно приложению.
// Ровно этот список обязан лежать в SHELL внутри sw.js — иначе офлайн-старт
// сломается на первом же экране, чей модуль забыли вписать.

function stripComments(code) {
  return code.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
}

function refsFromHTML(html) {
  const out = [];
  for (const match of html.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)) {
    const ref = match[1];
    if (/^(?:https?:|data:|mailto:|#)/.test(ref)) continue;
    out.push(ref);
  }
  return out;
}

function refsFromJS(code) {
  const out = [];
  // Покрывает и статический `from './x.js'`, и динамический `import('./y.js')`.
  for (const match of stripComments(code).matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
    out.push(match[1]);
  }
  return out;
}

function refsFromManifest(json) {
  const data = JSON.parse(json);
  return (data.icons ?? []).map((icon) => icon.src).filter((src) => typeof src === 'string');
}

function collectGraph() {
  const seen = new Set();
  const queue = ['./index.html'];

  while (queue.length > 0) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);

    const file = new URL(rel, APP_DIR);
    if (!existsSync(file)) continue;
    const source = readFileSync(file, 'utf8');

    let refs = [];
    if (rel.endsWith('.html')) refs = refsFromHTML(source);
    else if (rel.endsWith('.js')) refs = refsFromJS(source);
    else if (rel.endsWith('manifest.json')) refs = refsFromManifest(source);

    for (const ref of refs) {
      const resolved = new URL(ref, new URL(rel, APP_DIR));
      queue.push(`./${resolved.href.slice(APP_DIR.href.length)}`);
    }
  }
  // sw.js сам себя не кэширует: браузер держит его отдельно и обязан
  // перепроверять в сети (updateViaCache: 'none' в app.js).
  seen.delete('./sw.js');
  return Array.from(seen).sort();
}

await step('сторож: список оболочки покрывает весь граф импортов', () => {
  const graph = collectGraph();
  const forgotten = graph.filter((rel) => !shell.includes(rel));
  assert.deepEqual(forgotten, [], `не вписано в SHELL внутри sw.js: ${forgotten.join(', ')}`);
});

await step('сторож §0: в sw.js нет ни одного внешнего адреса', () => {
  const code = stripComments(SW_SOURCE);
  assert.ok(!/https?:\/\//.test(code), 'внешний адрес в коде service worker');
  assert.ok(!/localStorage|indexedDB/.test(code), 'SW полез в хранилища приложения (§3, §7 контракта)');
});

await step('сторож: версия кэша задана и её видно в имени', async () => {
  const found = /const VERSION = '([^']+)'/.exec(SW_SOURCE);
  assert.ok(found, 'константы VERSION нет — деплой нечем разграничить');
  assert.ok(found[1].trim() !== '', 'версия пустая');

  reset();
  const { name } = await install();
  assert.equal(name, `bm-shell-${found[1]}`, `имя кэша разошлось с VERSION: ${name}`);
});

await step('сторож: app.js регистрирует sw.js и не даёт браузеру кэшировать его', () => {
  const app = stripComments(readFileSync(new URL('./app.js', APP_DIR), 'utf8'));
  assert.match(app, /serviceWorker\.register\('\.\/sw\.js'/, 'регистрации SW нет');
  assert.match(app, /updateViaCache:\s*'none'/, 'sw.js может застрять в HTTP-кэше');
  assert.match(app, /'serviceWorker' in navigator/, 'нет проверки поддержки — упадёт там, где SW нет');
});

console.log(`Итог: ${passed} ок, ${failed} провалено.`);
process.exitCode = failed === 0 ? 0 : 1;
