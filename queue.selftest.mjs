// Автотест офлайн-очереди (T6, §7.2 и §7.4 спеки, контракт §7).
//
// Запуск (node на PATH — v6.17.1, ES-модулей не понимает, §12 контракта):
//
//   C:\Users\user\AppData\Roaming\nvm\v24.4.0\node.exe queue.selftest.mjs
//
// Только stdlib: ни npm-пакетов, ни тест-раннера, ни fake-indexeddb (§0).
//
// IndexedDB подставлен ниже вручную — ровно те методы, которыми пользуется
// queue.js. Настоящее хранилище нужно именно здесь: в остальных тестах
// (экран ввода, настройки) indexedDB не объявлен, и очередь сама уходит
// на запасной бэкенд в памяти — это и есть их заглушка.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// ===== Заглушка IndexedDB =================================================

function fakeRequest(run) {
  const request = { onsuccess: null, onerror: null, result: undefined, error: null };
  // Обработчики навешиваются уже после возврата запроса — отвечаем асинхронно.
  queueMicrotask(() => {
    try {
      request.result = run();
      if (request.onsuccess) request.onsuccess({ target: request });
    } catch (err) {
      request.error = err;
      if (request.onerror) request.onerror({ target: request });
    }
  });
  return request;
}

function fakeStore(rows, keys) {
  return {
    add(record) {
      return fakeRequest(() => {
        const id = keys.next;
        keys.next += 1;
        rows.set(id, { ...record, id });
        return id;
      });
    },
    put(record) {
      return fakeRequest(() => {
        rows.set(record.id, { ...record });
        return record.id;
      });
    },
    delete(id) {
      return fakeRequest(() => {
        rows.delete(id);
        return undefined;
      });
    },
    getAll() {
      // Настоящий getAll отдаёт записи в порядке ключа.
      return fakeRequest(() => Array.from(rows.keys()).sort((a, b) => a - b).map((id) => ({ ...rows.get(id) })));
    }
  };
}

const dbRows = new Map();
const dbKeys = { next: 1 };
const upgrades = [];
let openCalls = 0;

globalThis.indexedDB = {
  open(name, version) {
    openCalls += 1;
    const stores = new Set();
    const db = {
      name,
      version,
      objectStoreNames: { contains: (id) => stores.has(id) },
      createObjectStore: (id) => {
        stores.add(id);
        upgrades.push(id);
        return fakeStore(dbRows, dbKeys);
      },
      transaction: (id, mode) => {
        assert.equal(id, 'jobs', `очередь открыла чужое хранилище: ${id}`);
        assert.ok(mode === 'readonly' || mode === 'readwrite', `странный режим: ${mode}`);
        return { objectStore: () => fakeStore(dbRows, dbKeys) };
      }
    };
    const request = { onsuccess: null, onerror: null, onupgradeneeded: null, result: db, error: null };
    setTimeout(() => {
      if (request.onupgradeneeded) request.onupgradeneeded({ target: request });
      if (request.onsuccess) request.onsuccess({ target: request });
    }, 0);
    return request;
  }
};

// ===== Заглушки браузера ==================================================

const storage = new Map();

globalThis.localStorage = {
  getItem: (key) => (storage.has(String(key)) ? storage.get(String(key)) : null),
  setItem: (key, value) => { storage.set(String(key), String(value)); },
  removeItem: (key) => { storage.delete(String(key)); }
};

// ===== Заглушка сети ======================================================
// Хост только api.github.com: любой другой запрос — нарушение §0 контракта.

const TOKEN = 'github_pat_fixture';
const DAY = '2026-08-14';

const calls = [];
let dataFiles = [];
let putReply = { kind: 'ok' };
let listReply = { kind: 'ok' };

function jsonReply(payload) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(payload)
  };
}

function failureReply(status, body = '', head = {}) {
  return {
    ok: false,
    status,
    headers: { get: (name) => head[String(name).toLowerCase()] ?? null },
    text: async () => body
  };
}

globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  assert.ok(target.startsWith('https://api.github.com/'), `неожиданный хост: ${target}`);
  const method = String(init.method ?? 'GET').toUpperCase();
  const path = decodeURIComponent(new URL(target).pathname.split('/contents/')[1] ?? '');
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
  calls.push({ method, path, body });

  if (method === 'PUT') {
    if (putReply.kind === 'offline') throw new TypeError('сети нет (заглушка теста)');
    if (putReply.kind === 'status') return failureReply(putReply.status, putReply.body ?? '', putReply.head ?? {});
    // sha в ответе настоящий, как у GitHub: по нему очередь узнаёт уже
    // записанное содержимое, не перечитывая каталог.
    const sha = gitSha(Buffer.from(body.content, 'base64').toString('utf8'));
    dataFiles.push({ name: path.split('/').pop(), sha });
    return jsonReply({ content: { sha, path }, commit: { sha: 'commit' } });
  }
  if (listReply.kind === 'offline') throw new TypeError('сети нет (заглушка теста)');
  if (listReply.kind === 'status') return failureReply(listReply.status);
  return jsonReply(dataFiles.map((file) => ({
    type: 'file', name: file.name, path: `data/${file.name}`, sha: file.sha, size: 10
  })));
};

// Тот же хэш, что считает queue.js, но независимой реализацией.
function gitSha(content) {
  const bytes = Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

const queue = await import('./queue.js');
const store = await import('./store.js');

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

// ===== Фикстуры ===========================================================

function sessionText(value) {
  return JSON.stringify({ date: DAY, time: '09:12', entries: [{ key: 'waist_who', value }] }, null, 2);
}

function job(value, name = `${DAY}.json`) {
  return { path: `data/${name}`, content: sessionText(value), message: `Сессия ${DAY} 09:12` };
}

async function reset(options = {}) {
  const { token = TOKEN, files = [] } = options;
  for (const item of await queue.listJobs()) await queue.removeJob(item.id);
  storage.clear();
  if (token) storage.set(store.KEYS.token, token);
  calls.length = 0;
  dataFiles = files.map((name) => ({ name, sha: `sha-${name}` }));
  putReply = { kind: 'ok' };
  listReply = { kind: 'ok' };
}

const puts = () => calls.filter((call) => call.method === 'PUT');
const gets = () => calls.filter((call) => call.method === 'GET');
const wrote = () => puts().map((call) => call.path);

function bodyText(call) {
  return Buffer.from(call.body.content, 'base64').toString('utf8');
}

// ===== Хранилище ==========================================================

await step('очередь легла в IndexedDB: одна база bm-queue, одно хранилище jobs', async () => {
  await reset();
  await queue.enqueue(job(86.8));
  assert.equal(openCalls, 1, 'база открывается один раз за загрузку страницы');
  assert.deepEqual(upgrades, ['jobs'], 'создано не то хранилище');
  assert.equal(queue.isPersistent(), true, 'очередь считает себя непостоянной при живом IndexedDB');
  assert.equal(dbRows.size, 1, 'задание не доехало до хранилища');
});

await step('§7: у задания ровно поля контракта, статус pending', async () => {
  await reset();
  const id = await queue.enqueue(job(86.8));
  const jobs = await queue.listJobs();

  assert.equal(jobs.length, 1);
  assert.deepEqual(
    Object.keys(jobs[0]).sort(),
    ['content', 'createdAt', 'id', 'lastError', 'message', 'path', 'status'].sort()
  );
  assert.equal(jobs[0].id, id);
  assert.equal(jobs[0].status, 'pending');
  assert.equal(jobs[0].lastError, null);
  assert.match(jobs[0].createdAt, /^\d{4}-\d{2}-\d{2}T/);
});

await step('порядок FIFO: что поставили первым, то первым и уходит', async () => {
  await reset();
  await queue.enqueue(job(86.8));
  await queue.enqueue(job(87.4));
  const jobs = await queue.listJobs();
  assert.deepEqual(jobs.map((item) => item.id).sort((a, b) => a - b), jobs.map((item) => item.id));

  await queue.flush();
  assert.deepEqual(wrote(), [`data/${DAY}.json`, `data/${DAY}--2.json`], 'порядок отправки нарушен');
  assert.equal(JSON.parse(bodyText(puts()[0])).entries[0].value, 86.8, 'первым ушло не первое задание');
});

await step('removeJob убирает задание, listJobs его больше не видит', async () => {
  await reset();
  const id = await queue.enqueue(job(86.8));
  await queue.removeJob(id);
  assert.deepEqual(await queue.listJobs(), []);
});

// ===== Отправка ===========================================================

await step('flush отправляет и снимает задание с очереди', async () => {
  await reset();
  await queue.enqueue(job(86.8));
  const result = await queue.flush();

  assert.deepEqual(result, { sent: 1, failed: 0, errors: [] });
  assert.deepEqual(wrote(), [`data/${DAY}.json`]);
  assert.deepEqual(await queue.listJobs(), [], 'отправленное задание осталось в очереди');
  assert.equal(JSON.parse(bodyText(puts()[0])).entries[0].value, 86.8);
});

await step('пустая очередь не трогает сеть', async () => {
  await reset();
  const result = await queue.flush();
  assert.deepEqual(result, { sent: 0, failed: 0, errors: [] });
  assert.equal(calls.length, 0, 'запрос при пустой очереди');
});

await step('чек-лист §10: PUT уходит без sha — правка старой сессии невозможна', async () => {
  await reset({ files: [`${DAY}.json`] });
  await queue.enqueue(job(86.8));
  await queue.flush();

  const body = puts()[0].body;
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'sha'), false, 'в теле PUT появился sha');
  assert.deepEqual(Object.keys(body).sort(), ['branch', 'content', 'message']);
});

await step('§6.1: имя занято чужим устройством — сессия уезжает в --2', async () => {
  await reset({ files: [`${DAY}.json`, 'заметка.txt'] });
  await queue.enqueue(job(86.8));
  await queue.flush();

  assert.deepEqual(wrote(), [`data/${DAY}--2.json`]);
});

await step('имя свободно — используется как есть, без --N', async () => {
  await reset({ files: ['2026-08-13.json'] });
  await queue.enqueue(job(86.8));
  await queue.flush();

  assert.deepEqual(wrote(), [`data/${DAY}.json`]);
});

await step('повтор не размножает сессию: содержимое уже лежит в data/', async () => {
  await reset();
  const content = sessionText(86.8);
  // Предыдущая попытка доехала, но ответ потерялся: файл в репозитории есть.
  dataFiles = [{ name: `${DAY}.json`, sha: await queue.blobSha(content) }];
  await queue.enqueue({ path: `data/${DAY}.json`, content, message: 'Сессия' });
  const result = await queue.flush();

  assert.deepEqual(puts(), [], 'сессия записана вторым файлом');
  assert.deepEqual(result, { sent: 1, failed: 0, errors: [] });
  assert.deepEqual(await queue.listJobs(), [], 'задание зависло в очереди');
});

await step('два одинаковых задания в одном прогоне дают один файл', async () => {
  await reset();
  await queue.enqueue(job(86.8));
  await queue.enqueue(job(86.8));
  const result = await queue.flush();

  assert.deepEqual(wrote(), [`data/${DAY}.json`], 'одна и та же сессия записана дважды');
  assert.equal(result.sent, 2, 'дубль должен считаться доставленным, а не провалившимся');
  assert.deepEqual(await queue.listJobs(), []);
});

await step('подбор имени: занятое уезжает в --N, посторонний файл не трогаем', () => {
  assert.equal(queue.resolveName(`${DAY}.json`, []), `${DAY}.json`);
  assert.equal(queue.resolveName(`${DAY}.json`, ['2026-08-13.json']), `${DAY}.json`);
  assert.equal(queue.resolveName(`${DAY}.json`, [`${DAY}.json`]), `${DAY}--2.json`);
  assert.equal(queue.resolveName(`${DAY}.json`, [`${DAY}.json`, `${DAY}--2.json`]), `${DAY}--3.json`);
  // Регистр не различаем: на Windows и macOS это тот же файл.
  assert.equal(queue.resolveName(`${DAY}.json`, [`${DAY}.JSON`]), `${DAY}--2.json`);
  // Задание, поставленное как --2, при свободном основном имени займёт его.
  assert.equal(queue.resolveName(`${DAY}--2.json`, [`${DAY}--2.json`]), `${DAY}.json`);
  // Не файл сессии — переименовывать нечего.
  assert.equal(queue.resolveName('заметка.txt', ['заметка.txt']), 'заметка.txt');
});

await step('blobSha совпадает с git-хэшем, который отдаёт GitHub', async () => {
  for (const text of ['', 'привет', sessionText(86.8)]) {
    assert.equal(await queue.blobSha(text), gitSha(text), `разошлись на «${text.slice(0, 20)}»`);
  }
});

await step('листинг каталога — один на прогон, а не на задание', async () => {
  await reset();
  await queue.enqueue(job(86.8));
  await queue.enqueue(job(87.4));
  await queue.flush();

  assert.equal(gets().length, 1, `листингов ${gets().length}`);
  assert.equal(gets()[0].path, 'data');
});

// ===== Ошибки =============================================================

await step('нет сети: задание ждёт в очереди со статусом pending', async () => {
  await reset();
  await queue.enqueue(job(86.8));
  listReply = { kind: 'offline' };
  const result = await queue.flush();

  assert.deepEqual(result, { sent: 0, failed: 1, errors: ['Нет сети.'] });
  const jobs = await queue.listJobs();
  assert.equal(jobs.length, 1, 'задание пропало вместе с сессией');
  assert.equal(jobs[0].status, 'pending');
  assert.equal(jobs[0].lastError, 'Нет сети.');
});

await step('сеть вернулась — то же задание доезжает без повторного ввода', async () => {
  listReply = { kind: 'ok' };
  const result = await queue.flush();

  assert.deepEqual(result, { sent: 1, failed: 0, errors: [] });
  assert.deepEqual(wrote(), [`data/${DAY}.json`]);
  assert.deepEqual(await queue.listJobs(), []);
});

await step('нет токена: статус failed — само не починится', async () => {
  await reset({ token: null });
  await queue.enqueue(job(86.8));
  const result = await queue.flush();

  assert.equal(result.failed, 1);
  assert.deepEqual(result.errors, ['Токен не задан. Открой Настройки и вставь PAT.']);
  const jobs = await queue.listJobs();
  assert.equal(jobs[0].status, 'failed');
  assert.equal(jobs[0].lastError, 'Токен не задан. Открой Настройки и вставь PAT.');
});

await step('токен вставили — провалившееся задание уходит на следующем flush', async () => {
  storage.set(store.KEYS.token, TOKEN);
  const result = await queue.flush();

  assert.deepEqual(result, { sent: 1, failed: 0, errors: [] });
  assert.deepEqual(await queue.listJobs(), []);
});

await step('403 без прав — failed; 403 по лимиту и 500 — pending', async () => {
  await reset();
  await queue.enqueue(job(86.8));

  putReply = { kind: 'status', status: 403 };
  await queue.flush();
  assert.equal((await queue.listJobs())[0].status, 'failed', 'нет прав — ждать бессмысленно');
  assert.equal((await queue.listJobs())[0].lastError, 'У токена нет прав на этот репозиторий.');

  // Тот же код ответа, но с исчерпанным лимитом — это «попробуй позже» (§4).
  putReply = { kind: 'status', status: 403, head: { 'x-ratelimit-remaining': '0' } };
  await queue.flush();
  assert.equal((await queue.listJobs())[0].status, 'pending', 'лимит запросов проходит сам');
  assert.equal((await queue.listJobs())[0].lastError, 'Лимит запросов GitHub исчерпан, попробуй позже.');

  putReply = { kind: 'status', status: 500 };
  await queue.flush();
  assert.equal((await queue.listJobs())[0].status, 'pending', '500 — временная поломка сервера');
});

await step('конфликт имени (422 про sha) — pending: имя подберётся заново', async () => {
  await reset();
  await queue.enqueue(job(86.8));
  putReply = { kind: 'status', status: 422, body: JSON.stringify({ message: 'Invalid request. "sha" wasn\'t supplied.' }) };
  await queue.flush();

  const jobs = await queue.listJobs();
  assert.equal(jobs[0].status, 'pending');
  assert.equal(jobs[0].lastError, 'Файл изменился на сервере. Обнови данные и повтори.');
});

await step('провал одного задания не отменяет отправку остальных', async () => {
  await reset();
  await queue.enqueue(job(86.8));
  await queue.enqueue(job(87.4));
  // Первый PUT падает, второй проходит.
  let first = true;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(init.method).toUpperCase() === 'PUT' && first) {
      first = false;
      calls.push({ method: 'PUT', path: 'data/провал', body: null });
      return failureReply(500);
    }
    return original(url, init);
  };
  const result = await queue.flush();
  globalThis.fetch = original;

  assert.equal(result.sent, 1);
  assert.equal(result.failed, 1);
  assert.equal((await queue.listJobs()).length, 1, 'в очереди должно остаться ровно упавшее задание');
});

// ===== Подписка и параллельность ==========================================

await step('onQueueChange зовётся на каждую мутацию и снимается отпиской', async () => {
  await reset();
  let hits = 0;
  const off = queue.onQueueChange(() => { hits += 1; });

  const id = await queue.enqueue(job(86.8));
  assert.ok(hits >= 1, 'постановка в очередь не уведомила');
  const afterEnqueue = hits;
  await queue.removeJob(id);
  assert.ok(hits > afterEnqueue, 'удаление не уведомило');

  off();
  const before = hits;
  await queue.enqueue(job(87.4));
  assert.equal(hits, before, 'слушатель остался после отписки');
});

await step('два flush подряд не отправляют сессию дважды', async () => {
  await reset();
  await queue.enqueue(job(86.8));
  const [a, b] = await Promise.all([queue.flush(), queue.flush()]);

  assert.deepEqual(wrote(), [`data/${DAY}.json`], `записей ${wrote().length}`);
  assert.equal(a.sent + b.sent, 1, 'сессия посчитана отправленной дважды');
  assert.deepEqual(await queue.listJobs(), []);
});

await step('flush, начатый после enqueue, видит новое задание', async () => {
  await reset();
  await queue.enqueue(job(86.8));
  const slow = queue.flush();
  const id = await queue.enqueue(job(87.4));
  await slow;
  await queue.flush();

  assert.equal((await queue.listJobs()).find((item) => item.id === id), undefined, 'задание не отправлено');
});

// ===== Сторожа инвариантов ================================================

const SOURCE = readFileSync(new URL('./queue.js', import.meta.url), 'utf8');
const CODE = SOURCE.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');

await step('§0: очередь не знает про localStorage, DOM и внешние адреса', () => {
  assert.ok(!/localStorage/.test(SOURCE), 'localStorage живёт только в store.js (§3 контракта)');
  assert.ok(!/document\.|innerHTML/.test(CODE), 'очередь трогает DOM');
  assert.ok(!/https?:\/\//.test(CODE), 'внешний адрес в коде очереди');
});

await step('чек-лист §10: в очереди ровно одна запись файла и ни одного sha в её теле', () => {
  assert.equal((CODE.match(/writeFile\(/g) ?? []).length, 1, 'записей больше одной');
  assert.ok(!/writeFile\([^)]*sha/s.test(CODE), 'sha уходит в writeFile');
  assert.ok(!/readFile/.test(CODE), 'очередь читает файлы — ей это не нужно');
});

console.log(`Итог: ${passed} ок, ${failed} провалено.`);
process.exitCode = failed === 0 ? 0 : 1;
