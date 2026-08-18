// Автотест шпаргалки и модуля каталога (T4): чистые функции + отрисовка.
//
// Запуск (node на PATH — v6.17.1, ES-модулей не понимает, §12 контракта):
//
//   C:\Users\user\AppData\Roaming\nvm\v24.4.0\node.exe cheatsheet.selftest.mjs
//
// Только stdlib: ни npm-пакетов, ни тест-раннера, ни jsdom (§0 контракта).
//
// Браузера здесь нет, а screens/cheatsheet.js статически импортирует app.js,
// который при загрузке ищет элементы оболочки и запускает роутер. Подставляем
// минимальные заглушки: getElementById отдаёт null для #app, и монтирование
// экрана обрывается внутри app.js на первой же операции с DOM — исключение
// там перехвачено, до import() экрана дело не доходит. Отдельно подставлен
// только #header-status: на нём проверяется индикатор состояния данных (§7.1).
// Сам экран тест зовёт напрямую — render(root, params) с собственным root.
//
// Мини-DOM ниже реализует ровно ту часть API, которую трогают cheatsheet.js
// и app.js. Он нужен ради сквозного правила §13 контракта: устаревшие значения
// не скрываются никогда. Чистые функции эту регрессию не ловят — строку можно
// спрятать и с исправным isStale, поэтому проверяется само дерево узлов.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';

// ===== Мини-DOM ===========================================================

function createElement(tag) {
  const classes = new Set();
  const listeners = new Map();

  const node = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentNode: null,
    textContent: '',
    style: {},
    hidden: false,
    dataset: {},
    attributes: new Map()
  };

  // className и classList — один источник истины, как в браузере.
  Object.defineProperty(node, 'className', {
    get: () => Array.from(classes).join(' '),
    set: (value) => {
      classes.clear();
      for (const name of String(value ?? '').split(/\s+/)) if (name) classes.add(name);
    }
  });
  Object.defineProperty(node, 'childElementCount', { get: () => node.children.length });

  node.classList = {
    add: (...names) => { for (const name of names) if (name) classes.add(name); },
    remove: (...names) => { for (const name of names) classes.delete(name); },
    contains: (name) => classes.has(name),
    toggle: (name, force) => {
      const on = force === undefined ? !classes.has(name) : Boolean(force);
      if (on) classes.add(name);
      else classes.delete(name);
      return on;
    }
  };

  node.append = (...nodes) => {
    for (const child of nodes) {
      child.parentNode = node;
      node.children.push(child);
    }
  };
  node.prepend = (...nodes) => {
    for (const child of nodes) child.parentNode = node;
    node.children.unshift(...nodes);
  };
  node.replaceChildren = (...nodes) => {
    for (const child of node.children) child.parentNode = null;
    node.children = [];
    node.append(...nodes);
  };
  node.remove = () => {
    const parent = node.parentNode;
    if (!parent) return;
    parent.children = parent.children.filter((child) => child !== node);
    node.parentNode = null;
  };

  node.setAttribute = (name, value) => { node.attributes.set(name, String(value)); };
  node.removeAttribute = (name) => { node.attributes.delete(name); };
  node.getAttribute = (name) => (node.attributes.has(name) ? node.attributes.get(name) : null);

  node.addEventListener = (type, handler) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(handler);
  };
  node.removeEventListener = (type, handler) => {
    listeners.set(type, (listeners.get(type) ?? []).filter((fn) => fn !== handler));
  };
  // Не часть DOM — способ теста нажать кнопку.
  node.dispatch = (type) => {
    for (const handler of (listeners.get(type) ?? []).slice()) handler({ type });
  };

  return node;
}

// Всё поддерево в порядке обхода сверху вниз, слева направо.
function walk(node, out = []) {
  for (const child of node.children) {
    out.push(child);
    walk(child, out);
  }
  return out;
}

function describeNode(node) {
  return node.className ? `${node.tagName}.${node.className.replace(/\s+/g, '.')}` : node.tagName;
}

// ===== Заглушки браузера ==================================================

const headerStatus = createElement('span');

globalThis.window = {
  addEventListener() {},
  removeEventListener() {}
};
globalThis.document = {
  createElement,
  getElementById: (id) => (id === 'header-status' ? headerStatus : null),
  querySelectorAll: () => []
};
globalThis.location = { hash: '#/' };

// Хранилище выключено до DOM-блока намеренно: проверка «провал загрузки
// каталога сбрасывает мемоизацию» ниже опирается на то, что офлайн-копии
// каталога нет. Доступный localStorage замаскировал бы её.
const storage = new Map();
let storageEnabled = false;

function requireStorage() {
  if (!storageEnabled) throw new Error('localStorage недоступен (заглушка теста)');
}

globalThis.localStorage = {
  getItem(key) {
    requireStorage();
    return storage.has(String(key)) ? storage.get(String(key)) : null;
  },
  setItem(key, value) {
    requireStorage();
    storage.set(String(key), String(value));
  },
  removeItem(key) {
    requireStorage();
    storage.delete(String(key));
  }
};

// fetch подменяем целиком: сети в тесте быть не должно.
// catalog.json читается с диска, api.github.com отвечает по режиму githubReply.
const CATALOG_PATH = new URL('./catalog.json', import.meta.url);
let fetchCalls = 0;
let fetchBroken = false;
let githubReply = { kind: 'offline' };

function githubResponse() {
  if (githubReply.kind === 'offline') throw new TypeError('сети нет (заглушка теста)');
  if (githubReply.kind === 'status') {
    return {
      ok: false,
      status: githubReply.status,
      headers: { get: () => null },
      text: async () => githubReply.body ?? ''
    };
  }
  // Contents API отдаёт файл в base64 — github.js разворачивает его сам.
  const payload = {
    type: 'file',
    encoding: 'base64',
    content: Buffer.from(JSON.stringify(githubReply.body), 'utf8').toString('base64'),
    sha: 'fixture-sha'
  };
  return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
}

globalThis.fetch = async (url) => {
  fetchCalls += 1;
  if (fetchBroken) throw new TypeError('сети нет (заглушка теста)');
  if (String(url).includes('api.github.com')) return githubResponse();
  const text = readFileSync(CATALOG_PATH, 'utf8');
  return { ok: true, status: 200, json: async () => JSON.parse(text) };
};

const cheat = await import('./screens/cheatsheet.js');
const catalog = await import('./catalog.js');
const store = await import('./store.js');

const { isStale, formatValue, formatDate, describeCacheAge, shortenStatus } = cheat;

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

// Дата N дней назад в местном календаре, привязанная к полудню: сдвиг
// на целые сутки в миллисекундах ломался бы на переходе на летнее время.
function daysAgoISO(days) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - days);
  return date.toISOString();
}

console.log('Самопроверка T4: screens/cheatsheet.js + catalog.js');

// --- Геттеры каталога до загрузки (должны идти первыми) -------------------

await step('catalog: геттеры до loadCatalog() отдают пустоту, а не падают', () => {
  assert.deepEqual(catalog.dynamicMeasurements(), []);
  assert.deepEqual(catalog.staticMeasurements(), []);
  assert.deepEqual(catalog.cheatsheetMeasurements(), []);
  assert.equal(catalog.getMeasurement('weight'), null);
  assert.equal(catalog.getMeasurement(''), null);
  assert.equal(catalog.getMeasurement(null), null);
});

// --- Устаревание ----------------------------------------------------------

await step('isStale: статика (frequency_days === null) не устаревает никогда', () => {
  assert.equal(isStale('2000-01-01', null, '2026-08-16'), false);
  assert.equal(isStale('2000-01-01', undefined, '2026-08-16'), false);
  assert.equal(isStale('1990-05-05', 0, '2026-08-16'), false);
});

await step('isStale: граница ровно frequency_days x 2 — ещё не устарело', () => {
  // 2026-07-05 -> 2026-08-16 это ровно 42 дня = 21 x 2.
  assert.equal(isStale('2026-07-05', 21, '2026-08-16'), false);
  assert.equal(isStale('2026-07-04', 21, '2026-08-16'), true, 'на день больше — устарело');
  // Вес: frequency_days = 7, граница 14 дней.
  assert.equal(isStale('2026-08-02', 7, '2026-08-16'), false);
  assert.equal(isStale('2026-08-01', 7, '2026-08-16'), true);
  // Сегодняшний замер свежий по определению.
  assert.equal(isStale('2026-08-16', 7, '2026-08-16'), false);
});

await step('isStale: today принимается и объектом Date', () => {
  const today = new Date('2026-08-16T12:00:00Z');
  assert.equal(isStale('2026-07-05', 21, today), false);
  assert.equal(isStale('2026-07-04', 21, today), true);
});

await step('isStale: нет даты или дата битая — не устарело', () => {
  assert.equal(isStale(null, 21, '2026-08-16'), false);
  assert.equal(isStale('', 21, '2026-08-16'), false);
  assert.equal(isStale('14.08.2026', 21, '2026-08-16'), false);
  assert.equal(isStale('2026-02-31', 21, '2026-08-16'), false);
});

// --- Формат значения ------------------------------------------------------

await step('formatValue: число + единица, без хвостовых нулей', () => {
  assert.equal(formatValue(86.8, 'cm'), '86,8 см');
  assert.equal(formatValue(86.80, 'cm'), '86,8 см');
  assert.equal(formatValue(70, 'kg'), '70 кг');
  assert.equal(formatValue(70.0, 'kg'), '70 кг');
  assert.equal(formatValue(0.5, 'cm'), '0,5 см');
  assert.equal(formatValue(86.80000000000001, 'cm'), '86,8 см', 'хвост float съеден');
  assert.equal(formatValue('86.8', 'cm'), '86,8 см', 'строка из JSON тоже число');
});

await step('formatValue: незнакомая единица — как есть, пустая — без единицы', () => {
  assert.equal(formatValue(12, 'in'), '12 in');
  assert.equal(formatValue(42, ''), '42');
  assert.equal(formatValue(42, null), '42');
});

await step('formatValue: значения нет — прочерк', () => {
  assert.equal(formatValue(null, 'cm'), '—');
  assert.equal(formatValue(undefined, 'cm'), '—');
  assert.equal(formatValue('', 'cm'), '—');
  assert.equal(formatValue('  ', 'cm'), '—');
  assert.equal(formatValue(Number.NaN, 'cm'), '—');
  assert.equal(formatValue(Number.POSITIVE_INFINITY, 'cm'), '—');
  assert.equal(formatValue({}, 'cm'), '—');
});

// --- Формат даты ----------------------------------------------------------

await step('formatDate: 2026-08-14 -> 14.08.2026', () => {
  assert.equal(formatDate('2026-08-14'), '14.08.2026');
  assert.equal(formatDate('2026-01-05'), '05.01.2026');
  assert.equal(formatDate('2026-12-31'), '31.12.2026');
  assert.equal(formatDate('2026-08-14T07:20:00Z'), '14.08.2026');
});

await step('formatDate: мусор — пустая строка', () => {
  assert.equal(formatDate(''), '');
  assert.equal(formatDate(null), '');
  assert.equal(formatDate(undefined), '');
  assert.equal(formatDate('14.08.2026'), '');
  assert.equal(formatDate('2026-13-01'), '');
  assert.equal(formatDate('2026-02-31'), '', 'несуществующая дата');
});

// --- Возраст кэша ---------------------------------------------------------

await step('describeCacheAge: сегодня / вчера / N дней назад', () => {
  const now = new Date('2026-08-16T12:00:00Z');
  assert.equal(describeCacheAge('2026-08-16', now), 'Из кэша, обновлено сегодня');
  assert.equal(describeCacheAge('2026-08-15', now), 'Из кэша, обновлено вчера');
  assert.equal(describeCacheAge('2026-08-14', now), 'Из кэша, обновлено 2 дня назад');
  assert.equal(describeCacheAge('2026-08-11', now), 'Из кэша, обновлено 5 дней назад');
  assert.equal(describeCacheAge('2026-07-26', now), 'Из кэша, обновлено 21 день назад');
  assert.equal(describeCacheAge('2026-07-25', now), 'Из кэша, обновлено 22 дня назад');
  assert.equal(describeCacheAge('2026-07-05', now), 'Из кэша, обновлено 42 дня назад');
});

await step('describeCacheAge: ISO-метка store.js считается по местному дню', () => {
  assert.equal(describeCacheAge(daysAgoISO(0)), 'Из кэша, обновлено сегодня');
  assert.equal(describeCacheAge(daysAgoISO(1)), 'Из кэша, обновлено вчера');
  assert.equal(describeCacheAge(daysAgoISO(2)), 'Из кэша, обновлено 2 дня назад');
  assert.equal(describeCacheAge(daysAgoISO(11)), 'Из кэша, обновлено 11 дней назад');
});

await step('describeCacheAge: часы ушли вперёд и битая метка не ломают текст', () => {
  const now = new Date('2026-08-16T12:00:00Z');
  assert.equal(describeCacheAge('2026-08-20', now), 'Из кэша, обновлено сегодня');
  assert.equal(describeCacheAge('не дата', now), 'Из кэша');
  assert.equal(describeCacheAge(null, now), 'Из кэша');
  assert.equal(describeCacheAge('', now), 'Из кэша');
});

// --- Статус в шапке -------------------------------------------------------

await step('shortenStatus: короткое не трогаем, длинное режем по слову', () => {
  assert.equal(shortenStatus('Нет сети.'), 'Нет сети.');
  assert.equal(shortenStatus('Файл или репозиторий не найден.'), 'Файл или репозиторий не найден.');

  const long = 'Токен не задан. Открой Настройки и вставь PAT.';
  const short = shortenStatus(long);
  assert.ok(short.length <= 40, `влезает в 40 символов, а вышло ${short.length}`);
  assert.ok(short.endsWith('…'), 'обрезка помечена многоточием');
  assert.ok(long.startsWith(short.slice(0, -1)), 'начало сообщения сохранено');
  assert.ok(!short.slice(0, -1).endsWith(' '), 'висячего пробела перед многоточием нет');
});

// --- Каталог --------------------------------------------------------------

await step('catalog: загрузка catalog.json и выборки §5', async () => {
  const list = await catalog.loadCatalog();
  assert.equal(list.length, 22, 'все 22 замера раздела 5 спеки');
  assert.equal(catalog.dynamicMeasurements().length, 12);
  assert.equal(catalog.staticMeasurements().length, 10);
  assert.equal(catalog.cheatsheetMeasurements().length, 22);
  assert.equal(catalog.getMeasurement('waist_who').label, 'Талия (WHO)');
  assert.equal(catalog.getMeasurement('waist_who').frequency_days, 21);
  assert.equal(catalog.getMeasurement('height').frequency_days, null, 'у статики частоты нет');
  assert.equal(catalog.getMeasurement('нет такого'), null);
});

await step('catalog: порядок выборок — как в файле, без пересортировки', async () => {
  const list = await catalog.loadCatalog();
  const keys = list.map((item) => item.key);
  assert.equal(keys[0], 'weight');
  assert.equal(keys[1], 'waist_who');
  assert.equal(keys[keys.length - 1], 'finger_index');
  assert.equal(catalog.dynamicMeasurements()[0].key, 'weight');
  assert.equal(catalog.staticMeasurements()[0].key, 'height');
  // Порядок «Для покупок» из §7.1: chest/hip/neck идут раньше статики.
  const shopping = list
    .filter((item) => item.class === 'static' || ['chest', 'hip', 'neck'].includes(item.key))
    .map((item) => item.key);
  assert.deepEqual(shopping.slice(0, 3), ['hip', 'chest', 'neck']);
  assert.equal(shopping[3], 'height');
  assert.equal(shopping.length, 13);
});

await step('catalog: параллельные вызовы делят один fetch', async () => {
  const fresh = await import('./catalog.js?parallel');
  const before = fetchCalls;
  await Promise.all([fresh.loadCatalog(), fresh.loadCatalog(), fresh.loadCatalog()]);
  assert.equal(fetchCalls - before, 1, 'мемоизируется промис, а не результат');
});

await step('catalog: провал загрузки сбрасывает мемоизацию', async () => {
  const fresh = await import('./catalog.js?offline');
  fetchBroken = true;
  const before = fetchCalls;
  try {
    await assert.rejects(() => fresh.loadCatalog());
    await assert.rejects(() => fresh.loadCatalog());
    assert.equal(fetchCalls - before, 2, 'вторая попытка реально ушла в сеть');
  } finally {
    fetchBroken = false;
  }
});

// --- Отрисовка: сквозное правило §13 --------------------------------------
//
// Дальше проверяется само дерево узлов после render(). Всё, что ниже, — про
// один инвариант: «устаревшие значения не скрываются. Никогда». Замер старше
// frequency_days x 2 помечается приглушённой датой, но остаётся на экране
// в полном размере; замер без значения показывается с прочерком.

storageEnabled = true; // с этого места store.js видит хранилище, см. комментарий выше

await step('catalog: cached hydration не рассогласовывает resolved loadCatalog', async () => {
  const consistent = await import('./catalog.js?cache-consistency');
  const rawA = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
  const loadedA = await consistent.loadCatalog();
  const weightA = consistent.getMeasurement('weight');
  const versionA = consistent.protocolVersion();

  const rawB = JSON.parse(JSON.stringify(rawA));
  rawB.protocol_version = versionA + 1;
  rawB.measurements.find((item) => item.key === 'weight').label = 'Вес из кэша B';
  storage.set(store.KEYS.catalog, JSON.stringify({
    data: rawB,
    fetchedAt: new Date().toISOString()
  }));

  const hydrated = consistent.loadCachedCatalog();
  const loadedAgain = await consistent.loadCatalog();
  assert.equal(hydrated, loadedA, 'hydration вернула уже применённый entries A');
  assert.equal(loadedAgain, loadedA, 'memoized loadCatalog по-прежнему возвращает A');
  assert.equal(consistent.getMeasurement('weight'), weightA, 'геттер не переключился на B');
  assert.equal(consistent.getMeasurement('weight').label, 'Вес');
  assert.equal(consistent.protocolVersion(), versionA, 'protocolVersion остался от A');

  store.setCatalogCache(rawA); // не оставляем B следующим DOM-проверкам
});

const CATALOG = await catalog.loadCatalog();
const SHOPPING_EXTRA = ['chest', 'hip', 'neck'];
const SHOPPING_KEYS = CATALOG
  .filter((item) => item.class === 'static' || SHOPPING_EXTRA.includes(item.key))
  .map((item) => item.key);
const DYNAMIC_KEYS = CATALOG.filter((item) => item.class === 'dynamic').map((item) => item.key);
const TOTAL_ROWS = SHOPPING_KEYS.length + DYNAMIC_KEYS.length; // 11 + 10

// 'YYYY-MM-DD' N дней назад в местном календаре (полдень — чтобы перевод
// часов не сдвинул дату), как в daysAgoISO выше.
function dateAgo(days) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - days);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function latestEntry(value, days) {
  return { value, date: dateAgo(days), protocol_version: 1 };
}

// Правдоподобный агрегат §6.2: часть замеров свежие, часть старше
// frequency_days x 2, часть отсутствует вовсе, у одного битая дата.
// Динамика: граница 42 дня (frequency_days 21), у веса — 14 (7).
const FULL_INDEX = {
  generated_at: new Date().toISOString(),
  latest: {
    weight: latestEntry(78.4, 2),
    waist_who: latestEntry(86.8, 60), // устарело
    waist_umbilicus: latestEntry(89.1, 10),
    hip: latestEntry(96.5, 210), // устарело, и попадает в обе секции
    chest: latestEntry(99.2, 5),
    // neck отсутствует целиком — строка обязана остаться
    biceps_relaxed: latestEntry(32.4, 120), // устарело
    // biceps_flexed отсутствует
    thigh: latestEntry(56.1, 14),
    calf: { value: 38.3, date: 'позавчера', protocol_version: 1 }, // значение есть, дата битая
    height: latestEntry(178, 400), // статика не устаревает никогда
    foot_length: latestEntry(26.5, 400),
    // foot_width отсутствует
    inseam: latestEntry(82, 400),
    sleeve: latestEntry(61.5, 400),
    // shoulder_width отсутствует
    head_circ: latestEntry(57, 400),
    waist_natural: latestEntry(84, 300)
  },
  series: {
    weight: [
      { date: dateAgo(30), value: 79.6, protocol_version: 1 },
      { date: dateAgo(2), value: 78.4, protocol_version: 1 }
    ]
  }
};

// Полугодовая давность у всей динамики: строк обязано остаться столько же.
const STALE_INDEX = {
  generated_at: new Date().toISOString(),
  latest: Object.fromEntries(CATALOG.map((item, i) => [item.key, latestEntry(80 + i, 180)])),
  series: {}
};

const EMPTY_INDEX = { latest: {}, series: {} };

// Отрисовка одного экрана с заданными кэшем, токеном и ответом GitHub.
async function renderScreen(options = {}) {
  const {
    cache = null,
    fetchedAt = daysAgoISO(3),
    github = { kind: 'ok', body: FULL_INDEX },
    token = 'github_pat_fixture'
  } = options;

  cheat.destroy(); // гасим предыдущий экран: поздний ответ сети не должен дорисовать чужой root
  storage.clear();
  if (token) storage.set(store.KEYS.token, token);
  if (cache) storage.set(store.KEYS.index, JSON.stringify({ data: cache, fetchedAt }));
  githubReply = github;
  headerStatus.className = '';
  headerStatus.textContent = '';
  headerStatus.hidden = false;

  const root = createElement('div');
  await cheat.render(root, {});
  return root;
}

// Фоновое обновление уходит в микрозадачи — ждём макрозадачей.
async function flush() {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => { setTimeout(resolve, 0); });
}

function sectionsOf(root) {
  return root.children.filter((node) => node.classList.contains('cheat-section'));
}

function rowsOf(section) {
  return section.children.filter((node) => node.classList.contains('cheat-row'));
}

function allRows(root) {
  return sectionsOf(root).flatMap(rowsOf);
}

function actionsOf(root) {
  return root.children.find((node) => node.classList.contains('cheat-actions'));
}

function keyOf(row) {
  return decodeURIComponent(String(row.href).replace('#/history/', ''));
}

function readRow(row) {
  const inner = walk(row);
  const name = inner.find((node) => node.classList.contains('cheat-row__name'));
  const date = inner.find((node) => node.classList.contains('date'));
  const value = inner.find((node) => node.classList.contains('value'));
  const unit = inner.find((node) => node.classList.contains('cheat-row__unit'));
  return {
    node: row,
    key: keyOf(row),
    label: name ? name.textContent : null,
    date,
    value,
    unit,
    dateText: date ? date.textContent : null,
    valueText: value ? value.textContent : null,
    unitText: unit ? unit.textContent : '',
    stale: Boolean(date && date.classList.contains('date--stale'))
  };
}

await step('§13 DOM: после render() не скрыт ни один узел экрана', async () => {
  const root = await renderScreen({ cache: FULL_INDEX });
  await flush();

  const nodes = walk(root);
  assert.ok(nodes.length > 40, `дерево подозрительно мелкое: ${nodes.length} узлов`);
  for (const node of nodes) {
    const where = describeNode(node);
    assert.equal(node.hidden, false, `${where}: hidden === true`);
    assert.equal(node.getAttribute('hidden'), null, `${where}: атрибут hidden`);
    assert.notEqual(node.getAttribute('aria-hidden'), 'true', `${where}: aria-hidden`);
    assert.notEqual(node.style.display, 'none', `${where}: display: none`);
    assert.notEqual(node.style.visibility, 'hidden', `${where}: visibility: hidden`);
    assert.notEqual(node.style.visibility, 'collapse', `${where}: visibility: collapse`);
    assert.ok(
      !/hidden|collapse|invisible|sr-only/i.test(node.className),
      `${where}: класс, прячущий узел`
    );
  }

  // И ни одной пустой строки: у каждой есть подпись, значение и дата.
  const rows = allRows(root).map(readRow);
  assert.equal(rows.length, TOTAL_ROWS);
  for (const row of rows) {
    assert.ok(row.label, `${row.key}: нет подписи`);
    assert.ok(row.valueText, `${row.key}: нет значения`);
    assert.ok(row.dateText, `${row.key}: нет даты`);
  }
  cheat.destroy();
});

await step('§13 DOM: число строк не зависит от данных', async () => {
  const cases = [
    ['полный index.json', { cache: FULL_INDEX }],
    ['пустой агрегат { latest: {}, series: {} }', { cache: EMPTY_INDEX, github: { kind: 'ok', body: EMPTY_INDEX } }],
    ['кэша нет и сеть молчит', { cache: null, github: { kind: 'offline' } }],
    ['все значения устаревшие', { cache: STALE_INDEX, github: { kind: 'ok', body: STALE_INDEX } }]
  ];

  let reference = null;
  for (const [name, options] of cases) {
    const root = await renderScreen(options);
    await flush();
    const shape = sectionsOf(root).map((section) => rowsOf(section).map(keyOf));
    assert.deepEqual(
      shape.map((keys) => keys.length),
      [SHOPPING_KEYS.length, DYNAMIC_KEYS.length],
      `${name}: не 11 + 10 строк`
    );
    if (reference === null) reference = shape;
    else assert.deepEqual(shape, reference, `${name}: состав строк разъехался`);
    cheat.destroy();
  }
});

await step('§13 DOM: устаревание красит только дату, значение полноразмерное', async () => {
  const root = await renderScreen({ cache: FULL_INDEX });
  await flush();
  const rows = allRows(root).map(readRow);

  // hip встречается дважды — он есть в обеих секциях.
  const stale = rows.filter((row) => row.stale).map((row) => row.key).sort();
  assert.deepEqual(stale, ['biceps_relaxed', 'hip', 'hip', 'waist_who']);

  for (const row of rows) {
    assert.equal(row.value.classList.contains('date--stale'), false, `${row.key}: метка просрочки уехала на значение`);
    // Единственный класс значения — value (плюс value--empty, когда данных нет):
    // ни приглушения, ни уменьшения кегля.
    const expected = row.valueText === '—' ? 'value value--empty' : 'value';
    assert.equal(row.value.className, expected, `${row.key}: классы значения`);
  }

  const hip = rows.find((row) => row.key === 'hip');
  assert.equal(hip.valueText, '96,5', 'устаревшее значение показано числом, а не прочерком');
  assert.equal(hip.unitText, 'см');
  assert.equal(hip.dateText, formatDate(dateAgo(210)));
  assert.equal(hip.date.className, 'date date--stale');

  // Статика не устаревает никогда, даже спустя 400 дней.
  assert.equal(rows.find((row) => row.key === 'height').stale, false);
  assert.equal(rows.find((row) => row.key === 'weight').stale, false, 'замер двухдневной давности свежий');
  cheat.destroy();
});

await step('§13 DOM: замер без значения показан прочерком и текстом «нет данных»', async () => {
  const root = await renderScreen({ cache: FULL_INDEX });
  await flush();
  const rows = allRows(root).map(readRow);

  const empty = rows.filter((row) => row.valueText === '—').map((row) => row.key).sort();
  // neck попадает в обе секции, поэтому в списке дважды.
  assert.deepEqual(empty, [
    'biceps_flexed', 'finger_index', 'foot_width', 'forearm',
    'neck', 'neck', 'pelvis', 'shoulder_width', 'wrist'
  ]);

  for (const row of rows.filter((item) => item.valueText === '—')) {
    assert.ok(row.value.classList.contains('value--empty'), `${row.key}: нет класса value--empty`);
    assert.ok(row.value.classList.contains('value'), `${row.key}: потерян класс value`);
    assert.equal(row.dateText, 'нет данных', `${row.key}: текст даты`);
    assert.equal(row.unit, undefined, `${row.key}: единица без значения не рисуется`);
  }

  // Значение есть, а дата не разбирается — молчать про это нельзя.
  const calf = rows.find((row) => row.key === 'calf');
  assert.equal(calf.valueText, '38,3');
  assert.equal(calf.dateText, 'дата неизвестна');
  assert.equal(calf.stale, false);
  cheat.destroy();
});

await step('§7.1 DOM: chest/hip/neck есть в обеих секциях', async () => {
  const root = await renderScreen({ cache: FULL_INDEX });
  await flush();
  const [shopping, dynamic] = sectionsOf(root);

  assert.equal(shopping.children[0].tagName, 'H2');
  assert.equal(shopping.children[0].textContent, 'Для покупок');
  assert.equal(dynamic.children[0].textContent, 'Динамика');

  const shoppingKeys = rowsOf(shopping).map(keyOf);
  const dynamicKeys = rowsOf(dynamic).map(keyOf);
  for (const key of SHOPPING_EXTRA) {
    assert.ok(shoppingKeys.includes(key), `${key} пропал из «Для покупок»`);
    assert.ok(dynamicKeys.includes(key), `${key} пропал из «Динамики»`);
  }
  cheat.destroy();
});

await step('DOM: порядок строк — как в catalog.json, без пересортировки', async () => {
  const root = await renderScreen({ cache: FULL_INDEX });
  await flush();
  const [shopping, dynamic] = sectionsOf(root);
  assert.deepEqual(rowsOf(shopping).map(keyOf), SHOPPING_KEYS);
  assert.deepEqual(rowsOf(dynamic).map(keyOf), DYNAMIC_KEYS);
  // Порядок §7.1: hip, chest, neck идут раньше восьми статических.
  assert.deepEqual(SHOPPING_KEYS.slice(0, 3), ['hip', 'chest', 'neck']);

  // Подписи — из каталога, а не из index.json.
  const byKey = new Map(CATALOG.map((item) => [item.key, item]));
  for (const row of allRows(root).map(readRow)) {
    assert.equal(row.label, byKey.get(row.key).label, `${row.key}: подпись`);
  }
  cheat.destroy();
});

await step('DOM: строка целиком — ссылка #/history/<key>', async () => {
  const root = await renderScreen({ cache: FULL_INDEX });
  await flush();
  for (const row of allRows(root)) {
    const key = keyOf(row);
    assert.equal(row.tagName, 'A', `${key}: строка не ссылка`);
    assert.equal(row.href, `#/history/${encodeURIComponent(key)}`);
    // Ключ прогнан через encodeURIComponent — в хэше нет сырых спецсимволов.
    assert.ok(/^#\/history\/[A-Za-z0-9\-._~%]+$/.test(row.href), `${key}: ключ не экранирован`);
    assert.ok(row.classList.contains('row') && row.classList.contains('cheat-row'));
  }
  cheat.destroy();
});

await step('DOM: кнопка «Обновить» есть всегда и заблокирована на время запроса', async () => {
  const root = await renderScreen({ cache: FULL_INDEX });
  const button = actionsOf(root).children[0];
  assert.equal(button.tagName, 'BUTTON');
  assert.equal(button.textContent, 'Обновить');
  assert.equal(button.type, 'button');
  assert.equal(button.disabled, true, 'во время загрузки кнопка заблокирована');
  assert.equal(root.children[root.children.length - 1], actionsOf(root), 'кнопка под секциями');

  await flush();
  assert.equal(actionsOf(root).children[0].disabled, false, 'после ответа кнопка снова доступна');

  const before = fetchCalls;
  actionsOf(root).children[0].dispatch('click');
  assert.equal(actionsOf(root).children[0].disabled, true, 'повторный клик заблокирован на время запроса');
  await flush();
  assert.equal(fetchCalls - before, 1, 'клик ушёл в сеть ровно один раз');
  assert.equal(actionsOf(root).children[0].disabled, false);
  cheat.destroy();
});

await step('DOM: ошибка сети не стирает данные, карточка добавляется сверху', async () => {
  const root = await renderScreen({ cache: FULL_INDEX, github: { kind: 'status', status: 404 } });
  await flush();

  const notice = root.children[0];
  assert.ok(notice.classList.contains('cheat-notice'), 'карточка ошибки не первая на экране');
  assert.equal(notice.children[0].textContent, 'Данные не обновились');
  assert.equal(notice.children[1].className, 'warn');
  assert.equal(notice.children[1].textContent, 'Файл или репозиторий не найден.');

  const rows = allRows(root).map(readRow);
  assert.equal(rows.length, TOTAL_ROWS, 'строки пережили ошибку');
  assert.equal(rows.find((row) => row.key === 'weight').valueText, '78,4');
  assert.equal(rows.find((row) => row.key === 'waist_who').valueText, '86,8');
  assert.equal(rows.find((row) => row.key === 'waist_who').stale, true, 'просрочка помечена и после сбоя');
  assert.equal(rows.filter((row) => row.valueText !== '—').length, 16, 'из кэша показаны все значения');
  cheat.destroy();
});

await step('DOM: no-token — в карточке ошибки ссылка на #/settings', async () => {
  const root = await renderScreen({ token: null, cache: null });
  await flush();

  const notice = root.children[0];
  assert.ok(notice.classList.contains('cheat-notice'));
  assert.equal(notice.children[1].textContent, 'Токен не задан. Открой Настройки и вставь PAT.');
  const link = walk(notice).find((node) => node.tagName === 'A');
  assert.ok(link, 'ссылки в настройки нет');
  assert.equal(link.href, '#/settings');
  assert.ok(link.classList.contains('cheat-notice__link'));

  // Данных нет вовсе, но каркас строк на месте — не белый экран (§8 спеки).
  assert.equal(allRows(root).length, TOTAL_ROWS);
  cheat.destroy();
});

await step('DOM: индикатор состояния данных в шапке (§7.1)', async () => {
  const fresh = await renderScreen({ cache: FULL_INDEX });
  assert.equal(headerStatus.textContent, 'Обновляю…', 'первый рендер сообщает о фоновом запросе');
  assert.equal(headerStatus.hidden, false);
  await flush();
  assert.equal(headerStatus.textContent, 'Актуально');
  assert.ok(headerStatus.classList.contains('status--ok'));
  assert.equal(allRows(fresh).length, TOTAL_ROWS);

  // Сеть не ответила, а кэш есть — в шапке возраст данных, не текст ошибки.
  await renderScreen({ cache: FULL_INDEX, github: { kind: 'offline' }, fetchedAt: daysAgoISO(3) });
  await flush();
  assert.equal(headerStatus.textContent, 'Из кэша, обновлено 3 дня назад');
  assert.ok(headerStatus.classList.contains('status--stale'));

  // Ни кэша, ни сети — коротким текстом ошибка.
  await renderScreen({ cache: null, github: { kind: 'offline' } });
  await flush();
  assert.equal(headerStatus.textContent, 'Нет сети.');
  assert.ok(headerStatus.classList.contains('status--error'));
  cheat.destroy();
});

await step('§13 CSS: style.css не прячет ни строку, ни устаревшую дату', () => {
  const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8');
  const watched = ['.cheat', '.row', '.value', '.date', '.label'];
  let checked = 0;

  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim();
    if (!watched.some((needle) => selector.includes(needle))) continue;
    checked += 1;
    for (const declaration of match[2].split(';')) {
      const colon = declaration.indexOf(':');
      if (colon === -1) continue;
      const prop = declaration.slice(0, colon).trim().toLowerCase();
      const value = declaration.slice(colon + 1).trim().toLowerCase().replace(/\s*!important$/, '');
      const hides = (prop === 'display' && value === 'none')
        || (prop === 'visibility' && (value === 'hidden' || value === 'collapse'))
        || (prop === 'opacity' && Number(value) === 0)
        || (['font-size', 'height', 'max-height'].includes(prop) && /^0(\D|$)/.test(value));
      assert.equal(hides, false, `${selector} { ${prop}: ${value} } прячет замер`);
    }
  }
  assert.ok(checked >= 10, `правил шпаргалки в style.css нашлось только ${checked}`);
});

console.log(`Итог: ${passed} ок, ${failed} провалено.`);
process.exitCode = failed === 0 ? 0 : 1;
