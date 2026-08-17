// Автотест экрана ввода сессии (T5, §7.2 спеки): состав формы, живая медиана,
// предупреждения §5.3 / §7.2, схема файла §6.1 и запись в repo B.
//
// Запуск (node на PATH — v6.17.1, ES-модулей не понимает, §12 контракта):
//
//   C:\Users\user\AppData\Roaming\nvm\v24.4.0\node.exe entry.selftest.mjs
//
// Только stdlib: ни npm-пакетов, ни тест-раннера, ни jsdom (§0 контракта).
//
// Браузера здесь нет, а screens/entry.js статически импортирует app.js,
// который при загрузке ищет элементы оболочки и запускает роутер (решение T4,
// §13 контракта). Подставляем мини-DOM: #app отдаётся как null, поэтому
// монтирование внутри app.js обрывается на первой же операции с DOM —
// исключение там перехвачено. Отдельно подставлены #toast-host (на нём
// проверяется уведомление после сохранения) и #header-status.
//
// Мини-DOM ниже — тот же, что в cheatsheet.selftest.mjs, плюс поля ввода:
// value, checked, disabled и события input/change. Код скопирован намеренно:
// общий модуль-хелпер связал бы между собой тесты разных задач.
//
// IndexedDB тоже подставлен: с T6 сохранение идёт через очередь, и без
// хранилища queue.js уходит на запасной бэкенд в памяти — то есть проверялась
// бы редкая ветка «браузер не дал сохранить на диск», а не основная.
// Заглушка урезана до методов, которыми пользуется queue.js.
//
// Каталог подменяется фикстурой с "protocol_version": 7 — в файле на диске
// версия 1, и она же значение по умолчанию в catalog.js. Только при
// подменённой версии видно, что штамп записи действительно приехал
// из catalog.json, а не из константы.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

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
    attributes: new Map(),
    // Поля ввода: значения по умолчанию как у настоящих элементов.
    value: '',
    checked: false,
    disabled: false
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
  // Не часть DOM — способ теста нажать кнопку или напечатать в поле.
  node.dispatch = (type) => {
    for (const handler of (listeners.get(type) ?? []).slice()) handler({ type, target: node });
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

// textContent в мини-DOM — обычное поле, а не вычисляемое: собираем текст
// поддерева сами.
function textOf(node) {
  return [node, ...walk(node)].map((item) => item.textContent).filter(Boolean).join(' ');
}

// ===== Заглушки браузера ==================================================

const headerStatus = createElement('span');
const toastHost = createElement('div');

globalThis.window = {
  addEventListener() {},
  removeEventListener() {}
};
globalThis.document = {
  createElement,
  getElementById: (id) => {
    if (id === 'header-status') return headerStatus;
    if (id === 'toast-host') return toastHost;
    return null;
  },
  querySelectorAll: () => []
};
globalThis.location = { hash: '#/entry' };

// ===== Заглушка IndexedDB =================================================

function idbRequest(run) {
  const request = { onsuccess: null, onerror: null, result: undefined, error: null };
  queueMicrotask(() => {
    request.result = run();
    if (request.onsuccess) request.onsuccess({ target: request });
  });
  return request;
}

const dbRows = new Map();
let dbNextKey = 1;

function idbStore() {
  return {
    add: (record) => idbRequest(() => {
      const id = dbNextKey;
      dbNextKey += 1;
      dbRows.set(id, { ...record, id });
      return id;
    }),
    put: (record) => idbRequest(() => {
      dbRows.set(record.id, { ...record });
      return record.id;
    }),
    delete: (id) => idbRequest(() => { dbRows.delete(id); }),
    getAll: () => idbRequest(() => Array.from(dbRows.keys()).sort((a, b) => a - b).map((id) => ({ ...dbRows.get(id) })))
  };
}

globalThis.indexedDB = {
  open() {
    const stores = new Set();
    const db = {
      objectStoreNames: { contains: (id) => stores.has(id) },
      createObjectStore: (id) => { stores.add(id); return idbStore(); },
      transaction: () => ({ objectStore: idbStore })
    };
    const request = { onsuccess: null, onerror: null, onupgradeneeded: null, result: db };
    setTimeout(() => {
      if (request.onupgradeneeded) request.onupgradeneeded({ target: request });
      if (request.onsuccess) request.onsuccess({ target: request });
    }, 0);
    return request;
  }
};

const storage = new Map();

globalThis.localStorage = {
  getItem(key) {
    return storage.has(String(key)) ? storage.get(String(key)) : null;
  },
  setItem(key, value) {
    storage.set(String(key), String(value));
  },
  removeItem(key) {
    storage.delete(String(key));
  }
};

// ===== Заглушка сети ======================================================
// Сети в тесте быть не должно: catalog.json читается с диска, api.github.com
// отвечает по режимам ниже, любой другой хост — ошибка (§0 контракта).

const CATALOG_PATH = new URL('./catalog.json', import.meta.url);
const CATALOG_RAW = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
const CATALOG_FIXTURE = { ...CATALOG_RAW, protocol_version: 7 };
const PROTOCOL_VERSION = 7;

const INDEX_PATH = 'index.json';

const githubCalls = [];
let indexReply = { kind: 'data', body: null };
let putReply = { kind: 'ok' };
let dataFiles = [];

function jsonReply(payload) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(payload)
  };
}

function failureReply(status, body = '') {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    text: async () => body
  };
}

// git-хэш содержимого — то же, что GitHub кладёт в поле sha листинга.
function gitSha(content) {
  const bytes = Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

// Contents API отдаёт файл в base64 — github.js разворачивает его сам.
function fileEnvelope(data) {
  return {
    type: 'file',
    encoding: 'base64',
    content: Buffer.from(JSON.stringify(data), 'utf8').toString('base64'),
    sha: 'index-sha'
  };
}

globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  if (!target.includes('api.github.com')) {
    assert.ok(target.includes('catalog.json'), `неожиданный запрос: ${target}`);
    return { ok: true, status: 200, json: async () => CATALOG_FIXTURE };
  }

  const method = String(init.method ?? 'GET').toUpperCase();
  const path = decodeURIComponent(new URL(target).pathname.split('/contents/')[1] ?? '');
  githubCalls.push({ method, path, body: typeof init.body === 'string' ? JSON.parse(init.body) : null });

  if (method === 'PUT') {
    if (putReply.kind === 'offline') throw new TypeError('сети нет (заглушка теста)');
    if (putReply.kind === 'status') return failureReply(putReply.status, putReply.body ?? '');
    // sha настоящий, как у GitHub: по нему очередь узнаёт содержимое,
    // которое уже записано, и не создаёт дубль сессии (T6).
    const sha = gitSha(Buffer.from(JSON.parse(init.body).content, 'base64').toString('utf8'));
    dataFiles.push({ name: path.split('/').pop(), sha });
    return jsonReply({ content: { sha, path }, commit: { sha: 'commit-sha' } });
  }
  if (path === INDEX_PATH) {
    if (indexReply.kind === 'offline') throw new TypeError('сети нет (заглушка теста)');
    if (indexReply.kind === 'status') return failureReply(indexReply.status);
    return jsonReply(fileEnvelope(indexReply.body));
  }
  if (path === 'data') {
    return jsonReply(dataFiles.map((file) => ({
      type: 'file', name: file.name, path: `data/${file.name}`, sha: file.sha, size: 10
    })));
  }
  throw new Error(`неожиданный запрос к GitHub: ${method} ${path}`);
};

const entry = await import('./screens/entry.js');
const catalog = await import('./catalog.js');
const store = await import('./store.js');
const queue = await import('./queue.js');

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

const DYNAMIC_KEYS = CATALOG_RAW.measurements.filter((item) => item.class === 'dynamic').map((item) => item.key);
const STATIC_KEYS = CATALOG_RAW.measurements.filter((item) => item.class === 'static').map((item) => item.key);
const ALL_KEYS = CATALOG_RAW.measurements.map((item) => item.key);
const WAIST = CATALOG_RAW.measurements.find((item) => item.key === 'waist_who');

function indexWith(latest) {
  return { generated_at: new Date().toISOString(), latest, series: {} };
}

const EMPTY_INDEX = indexWith({});
// Предыдущее значение рядом с вводимым: сработает только разброс повторов.
const INDEX_NEAR = indexWith({ waist_who: { value: 87, date: '2026-08-01', protocol_version: 7 } });
// Предыдущее значение далеко: сработает отклонение > 5 см.
const INDEX_FAR = indexWith({ waist_who: { value: 80, date: '2026-08-01', protocol_version: 7 } });

// Фоновое обновление и сохранение уходят в микрозадачи — ждём макрозадачей.
// С T6 цепочка длиннее: очередь, отправка, повторное чтение очереди.
async function settle() {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => { setTimeout(resolve, 0); });
}

async function renderScreen(options = {}) {
  const {
    index = null,
    github = { kind: 'data', body: index ?? EMPTY_INDEX },
    token = 'github_pat_fixture',
    files = [],
    put = { kind: 'ok' }
  } = options;

  entry.destroy(); // гасим предыдущий экран: поздний ответ не должен дорисовать чужой root
  // Очередь переживает экран — между тестами её надо опустошать вручную,
  // иначе застрявшее задание уедет вместе со следующей сессией.
  for (const job of await queue.listJobs()) await queue.removeJob(job.id);
  storage.clear();
  githubCalls.length = 0;
  toastHost.replaceChildren();
  globalThis.location.hash = '#/entry';
  if (token) storage.set(store.KEYS.token, token);
  if (index) {
    storage.set(store.KEYS.index, JSON.stringify({ data: index, fetchedAt: new Date().toISOString() }));
  }
  indexReply = github;
  putReply = put;
  dataFiles = files.map((name) => ({ name, sha: `sha-${name}` }));

  const root = createElement('div');
  await entry.render(root, {});
  await settle();
  return root;
}

// ===== Запросы к дереву ===================================================

function byClass(root, className) {
  return walk(root).filter((node) => node.classList.contains(className));
}

function blocksOf(root) {
  return byClass(root, 'entry-block');
}

function keysOf(root) {
  return blocksOf(root).map((block) => block.dataset.key);
}

function blockOf(root, key) {
  const block = blocksOf(root).find((item) => item.dataset.key === key);
  assert.ok(block, `блока замера «${key}» нет на экране`);
  return block;
}

function inputsIn(node) {
  return walk(node).filter((item) => item.tagName === 'INPUT');
}

function repsOf(block) {
  const box = byClass(block, 'entry-reps')[0];
  return box ? inputsIn(box) : [];
}

function medianOf(block) {
  return byClass(block, 'entry-median')[0];
}

function warningsOf(block) {
  const box = byClass(block, 'entry-warnings')[0];
  return box ? box.children.filter((node) => node.classList.contains('warn')) : [];
}

function confirmOf(block) {
  const label = byClass(block, 'entry-confirm')[0];
  return label ? inputsIn(label)[0] : null;
}

function noteOf(block) {
  const field = byClass(block, 'entry-note')[0];
  return field ? inputsIn(field)[0] : null;
}

function saveButton(root) {
  return walk(root).find((node) => node.tagName === 'BUTTON');
}

function messagesText(root) {
  const box = byClass(root, 'entry-messages')[0];
  return box ? box.children.map((node) => node.textContent).join(' | ') : '';
}

function modeInputs(root) {
  const box = byClass(root, 'entry-modes')[0];
  return box ? inputsIn(box) : [];
}

function pickerLabels(root) {
  const box = byClass(root, 'entry-picker')[0];
  return box ? box.children : [];
}

function conditionInput(root, name) {
  const label = walk(root).find((node) => node.dataset && node.dataset.condition === name);
  return label ? inputsIn(label)[0] : null;
}

function inputByType(root, type) {
  return walk(root).find((node) => node.tagName === 'INPUT' && node.type === type);
}

function typeInto(input, value) {
  input.value = value;
  input.dispatch('input');
}

function toggle(input, checked) {
  input.checked = checked;
  input.dispatch('change');
}

function fillReps(block, values) {
  const inputs = repsOf(block);
  values.forEach((value, i) => typeInto(inputs[i], value));
}

async function clickSave(root) {
  saveButton(root).dispatch('click');
  await settle();
}

function putCall() {
  return githubCalls.find((call) => call.method === 'PUT');
}

function savedSession() {
  const call = putCall();
  assert.ok(call, 'записи в repo B не было');
  return JSON.parse(Buffer.from(call.body.content, 'base64').toString('utf8'));
}

console.log('Самопроверка T5: screens/entry.js');

// --- Контракт экрана ------------------------------------------------------

await step('контракт §2: title, render, destroy', () => {
  assert.equal(entry.title, 'Ввод сессии');
  assert.equal(typeof entry.render, 'function');
  assert.equal(typeof entry.destroy, 'function');
  assert.match(entry.todayISO(), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(entry.currentTime(), /^\d{2}:\d{2}$/);
});

// --- Состав формы ---------------------------------------------------------

await step('по умолчанию — полная сессия: все динамические замеры в порядке каталога', async () => {
  const root = await renderScreen({ index: INDEX_NEAR });
  assert.deepEqual(keysOf(root), DYNAMIC_KEYS);
  assert.equal(blocksOf(root).length, 10);

  const [full, custom] = modeInputs(root);
  assert.equal(full.type, 'radio');
  assert.equal(full.checked, true, 'полная сессия не выбрана по умолчанию');
  assert.equal(custom.checked, false);
  assert.equal(pickerLabels(root).length, 0, 'в полной сессии список замеров не нужен');
});

await step('§7.2: полей повторов ровно reps из каталога, поля числовые', async () => {
  const root = await renderScreen({ index: INDEX_NEAR });

  const waist = repsOf(blockOf(root, 'waist_who'));
  assert.equal(waist.length, 3, 'у обхвата талии три повтора');
  const weight = repsOf(blockOf(root, 'weight'));
  assert.equal(weight.length, 1, 'у веса один повтор');

  for (const block of blocksOf(root)) {
    const measurement = CATALOG_RAW.measurements.find((item) => item.key === block.dataset.key);
    const inputs = repsOf(block);
    assert.equal(inputs.length, measurement.reps, `${block.dataset.key}: число полей`);
    for (const input of inputs) {
      // type="number" на телефоне теряет значение с запятой — только text.
      assert.equal(input.type, 'text', `${block.dataset.key}: тип поля`);
      assert.equal(input.getAttribute('inputmode'), 'decimal', `${block.dataset.key}: inputmode`);
    }
  }

  assert.ok(textOf(blockOf(root, 'waist_who')).includes('Повтор 3'), 'повторы не подписаны');
  assert.ok(textOf(blockOf(root, 'weight')).includes('Значение'));
  assert.ok(noteOf(blockOf(root, 'waist_who')), 'нет поля заметки');
});

await step('§7.2: текст протокола (landmark + posture) стоит в блоке замера', async () => {
  const root = await renderScreen({ index: INDEX_NEAR });
  const text = textOf(blockOf(root, 'waist_who'));
  assert.ok(text.includes(WAIST.landmark), `нет ориентира: ${WAIST.landmark}`);
  assert.ok(text.includes(WAIST.posture), `нет позы: ${WAIST.posture}`);

  // И так у каждого блока: неоднозначность «где мерили» — это §1 спеки.
  for (const block of blocksOf(root)) {
    const measurement = CATALOG_RAW.measurements.find((item) => item.key === block.dataset.key);
    const body = textOf(block);
    assert.ok(body.includes(measurement.landmark), `${measurement.key}: нет landmark`);
    assert.ok(body.includes(measurement.posture), `${measurement.key}: нет posture`);
    assert.ok(byClass(block, 'entry-protocol').length >= 1, `${measurement.key}: нет строки протокола`);
  }
});

await step('§5.3: общие правила измерения показаны на экране ввода', async () => {
  const root = await renderScreen({ index: INDEX_NEAR });
  const text = textOf(root);
  assert.ok(text.includes('Правила измерения'));
  assert.ok(/вдавлив/i.test(text), 'нет правила про вдавливание ленты');
  assert.ok(text.includes('три повтора'), 'нет правила про три повтора');
  assert.ok(text.includes('больше 1 см'), 'нет правила про разброс');
  assert.ok(text.includes('2 см'), 'нет порога интерпретации динамики');
});

// --- Медиана --------------------------------------------------------------

await step('§7.2: медиана пересчитывается вживую, запятая и точка равноправны', async () => {
  const root = await renderScreen({ index: INDEX_NEAR });
  const block = blockOf(root, 'waist_who');
  assert.equal(medianOf(block).textContent, 'Медиана: —', 'пустой блок');
  assert.ok(medianOf(block).classList.contains('entry-median--empty'));

  const inputs = repsOf(block);
  typeInto(inputs[0], '86.5');
  assert.equal(medianOf(block).textContent, 'Медиана: 86,5 см', 'один повтор — он же медиана');
  typeInto(inputs[1], '87.0');
  assert.equal(medianOf(block).textContent, 'Медиана: 86,8 см', 'двух повторов — среднее');
  typeInto(inputs[2], '86,8');
  assert.equal(medianOf(block).textContent, 'Медиана: 86,8 см');
  assert.equal(medianOf(block).classList.contains('entry-median--empty'), false);

  // Запятая с телефонной клавиатуры — основной случай ввода.
  fillReps(block, ['86,5', '87,0', '86,9']);
  assert.equal(medianOf(block).textContent, 'Медиана: 86,9 см');

  const weight = blockOf(root, 'weight');
  typeInto(repsOf(weight)[0], '78,4');
  assert.equal(medianOf(weight).textContent, 'Медиана: 78,4 кг', 'единица берётся из каталога');

  // Значение стёрли — медиана возвращается к прочерку, а не к нулю.
  fillReps(block, ['', '', '']);
  assert.equal(medianOf(block).textContent, 'Медиана: —');
});

// --- Предупреждения -------------------------------------------------------

await step('§5.3: разброс повторов предупреждает, но сохранять не мешает', async () => {
  const root = await renderScreen({ index: INDEX_NEAR });
  const block = blockOf(root, 'waist_who');
  fillReps(block, ['86,0', '88,0', '87,0']);

  const warnings = warningsOf(block);
  assert.equal(warnings.length, 1, 'ожидалось одно предупреждение');
  assert.ok(warnings[0].textContent.includes('Разброс'), warnings[0].textContent);
  assert.ok(warnings[0].classList.contains('warn'));
  assert.equal(confirmOf(block), null, 'разброс подтверждения не требует');
  assert.equal(saveButton(root).disabled, false, 'разброс заблокировал сохранение');
});

await step('§7.2: отклонение > 5 см блокирует «Сохранить» до подтверждения', async () => {
  const root = await renderScreen({ index: INDEX_FAR });
  const block = blockOf(root, 'waist_who');
  fillReps(block, ['90,0', '90,0', '90,0']);

  const warnings = warningsOf(block);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].textContent.includes('Отклонение'), warnings[0].textContent);
  assert.ok(warnings[0].textContent.includes('было 80'), 'в тексте нет предыдущего значения');

  const confirm = confirmOf(block);
  assert.ok(confirm, 'чекбокса подтверждения нет');
  assert.equal(confirm.type, 'checkbox');
  assert.equal(confirm.checked, false);
  assert.equal(saveButton(root).disabled, true, 'кнопка не заблокирована до подтверждения');
  assert.ok(messagesText(root).includes('Отметь подтверждение'), 'непонятно, почему кнопка серая');

  toggle(confirm, true);
  assert.equal(saveButton(root).disabled, false, 'подтверждение не разблокировало кнопку');

  toggle(confirmOf(block), false);
  assert.equal(saveButton(root).disabled, true, 'снятая галочка снова блокирует');

  // Подтверждение переживает правку соседнего поля: галочка не сбрасывается
  // молча, пока предупреждение то же самое.
  toggle(confirmOf(block), true);
  typeInto(repsOf(block)[2], '90,1');
  assert.equal(confirmOf(block).checked, true);
  assert.equal(saveButton(root).disabled, false);
});

await step('нет ни сети, ни кэша — проверка отклонения молчит', async () => {
  const root = await renderScreen({ index: null, github: { kind: 'offline' } });
  const block = blockOf(root, 'waist_who');
  fillReps(block, ['120,0', '120,0', '120,0']);

  assert.deepEqual(warningsOf(block).map((node) => node.textContent), [], 'сравнивать не с чем');
  assert.equal(confirmOf(block), null);
  assert.equal(saveButton(root).disabled, false);
  // Молчание объяснено на экране, а не спрятано.
  const text = messagesText(root);
  assert.ok(text.includes('Предыдущих значений нет'), text);
  assert.ok(text.includes('Нет сети.'), text);
});

// --- Выбор состава --------------------------------------------------------

await step('§7.2: переключение режима меняет набор блоков, статика доступна', async () => {
  const root = await renderScreen({ index: INDEX_NEAR });
  assert.equal(blocksOf(root).length, 10);

  const [full, custom] = modeInputs(root);
  custom.checked = true;
  custom.dispatch('change');
  assert.equal(blocksOf(root).length, 0, 'в отдельных замерах ничего не отмечено');
  assert.equal(full.checked, false, 'радиокнопки не синхронизированы');

  const labels = pickerLabels(root);
  assert.equal(labels.length, ALL_KEYS.length, 'в списке должен быть весь каталог, включая статику');
  assert.deepEqual(labels.map((label) => label.dataset.key), ALL_KEYS);
  for (const key of STATIC_KEYS) {
    assert.ok(labels.some((label) => label.dataset.key === key), `${key} недоступен для ввода`);
  }

  const pick = (key) => toggle(inputsIn(labels.find((label) => label.dataset.key === key))[0], true);
  pick('weight');
  pick('height');
  assert.deepEqual(keysOf(root), ['weight', 'height'], 'блоки не совпали с отметками');
  assert.equal(repsOf(blockOf(root, 'height')).length, 1, 'у статики один повтор');

  // Обратно в полную сессию — снова все динамические.
  full.checked = true;
  full.dispatch('change');
  assert.deepEqual(keysOf(root), DYNAMIC_KEYS);
  assert.equal(pickerLabels(root).length, 0);
});

await step('введённые значения переживают переключение режима', async () => {
  const root = await renderScreen({ index: INDEX_NEAR });
  typeInto(repsOf(blockOf(root, 'weight'))[0], '78,4');

  const [full, custom] = modeInputs(root);
  toggle(custom, true);
  const label = pickerLabels(root).find((item) => item.dataset.key === 'weight');
  toggle(inputsIn(label)[0], true);
  assert.equal(repsOf(blockOf(root, 'weight'))[0].value, '78,4', 'значение потерялось при выборе замера');

  toggle(full, true);
  assert.equal(repsOf(blockOf(root, 'weight'))[0].value, '78,4', 'значение потерялось при возврате');
  assert.equal(medianOf(blockOf(root, 'weight')).textContent, 'Медиана: 78,4 кг');
});

// --- Условия сессии -------------------------------------------------------

await step('§6.1: дата и время по умолчанию, оба редактируемы; условия включены', async () => {
  const root = await renderScreen({ index: INDEX_NEAR });

  const date = inputByType(root, 'date');
  const time = inputByType(root, 'time');
  assert.ok(date && time, 'нет полей даты и времени');
  assert.equal(date.value, entry.todayISO());
  assert.match(time.value, /^\d{2}:\d{2}$/);

  assert.equal(conditionInput(root, 'fasted').checked, true, 'натощак должно стоять по умолчанию');
  assert.equal(conditionInput(root, 'post_void').checked, true, 'после туалета — тоже');

  // Вчерашний замер вносить можно: поле принимает любую дату.
  typeInto(date, '2026-08-14');
  assert.equal(date.value, '2026-08-14');
});

// --- Сохранение -----------------------------------------------------------

await step('§6.1: сохранённый файл совпадает со схемой ключ в ключ', async () => {
  const root = await renderScreen({ index: INDEX_NEAR });
  const block = blockOf(root, 'waist_who');
  fillReps(block, ['86,5', '87,0', '86,8']);
  typeInto(noteOf(block), '  мерил после душа  ');
  await clickSave(root);

  const session = savedSession();
  assert.deepEqual(Object.keys(session), ['date', 'time', 'protocol_version', 'conditions', 'entries']);
  assert.deepEqual(Object.keys(session.conditions), ['fasted', 'post_void', 'hours_since_training']);
  assert.deepEqual(Object.keys(session.entries[0]), ['key', 'raw', 'value', 'unit', 'protocol_version', 'note']);

  assert.equal(session.date, entry.todayISO());
  assert.match(session.time, /^\d{2}:\d{2}$/);
  assert.deepEqual(session.conditions, { fasted: true, post_void: true, hours_since_training: null });
  assert.equal(session.entries.length, 1, 'незаполненные замеры в файл не попадают');
  assert.deepEqual(session.entries[0].raw, [86.5, 87, 86.8], 'запятая разобрана в числа');
  assert.equal(session.entries[0].value, 86.8);
  assert.equal(session.entries[0].unit, 'cm');
  assert.equal(session.entries[0].note, 'мерил после душа');

  // Файл читают глазами прямо в GitHub — отступ 2 обязателен.
  const text = Buffer.from(putCall().body.content, 'base64').toString('utf8');
  assert.equal(text, JSON.stringify(session, null, 2));
});

await step('условия сессии доезжают до файла: снятая галочка и часы', async () => {
  const root = await renderScreen({ index: INDEX_NEAR });
  fillReps(blockOf(root, 'waist_who'), ['86,5', '87,0', '86,8']);
  toggle(conditionInput(root, 'fasted'), false);
  const hours = walk(root).find((node) => node.getAttribute('inputmode') === 'numeric');
  assert.ok(hours, 'нет поля «часов после тренировки»');
  typeInto(hours, '24');
  await clickSave(root);

  assert.deepEqual(savedSession().conditions, { fasted: false, post_void: true, hours_since_training: 24 });
});

await step('protocol_version приезжает из catalog.json, а не из константы', async () => {
  assert.equal(CATALOG_RAW.protocol_version, 1, 'фикстура перестала отличаться от файла на диске');
  assert.equal(catalog.protocolVersion(), PROTOCOL_VERSION, 'каталог подменён неудачно');

  const root = await renderScreen({ index: INDEX_NEAR });
  fillReps(blockOf(root, 'waist_who'), ['86,5', '87,0', '86,8']);
  await clickSave(root);

  const session = savedSession();
  assert.equal(session.protocol_version, PROTOCOL_VERSION, 'в корне сессии не версия каталога');
  assert.equal(session.entries[0].protocol_version, PROTOCOL_VERSION, 'в записи не версия каталога');
});

await step('путь записи — data/<YYYY-MM-DD>.json, и только новый файл', async () => {
  const root = await renderScreen({ index: INDEX_NEAR });
  fillReps(blockOf(root, 'waist_who'), ['86,5', '87,0', '86,8']);
  await clickSave(root);

  // Ровно три запроса: предыдущие значения, листинг data/ и запись.
  // Чтения существующей сессии среди них нет — правкой тут заняться нечем.
  assert.deepEqual(
    githubCalls.map((call) => `${call.method} ${call.path}`),
    [`GET ${INDEX_PATH}`, 'GET data', `PUT data/${entry.todayISO()}.json`]
  );
});

await step('§6.1: вторая сессия за день уезжает в --2', async () => {
  const today = entry.todayISO();
  const root = await renderScreen({ index: INDEX_NEAR, files: [`${today}.json`, 'заметка.txt'] });
  fillReps(blockOf(root, 'waist_who'), ['86,5', '87,0', '86,8']);
  await clickSave(root);

  assert.equal(putCall().path, `data/${today}--2.json`);
});

await step('чек-лист §10: writeFile вызывается без sha — правки старой сессии невозможны', async () => {
  const root = await renderScreen({ index: INDEX_NEAR, files: [`${entry.todayISO()}.json`] });
  fillReps(blockOf(root, 'waist_who'), ['86,5', '87,0', '86,8']);
  await clickSave(root);

  const body = putCall().body;
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'sha'), false, 'в теле PUT появился sha');
  assert.deepEqual(Object.keys(body).sort(), ['branch', 'content', 'message']);
  assert.ok(body.message.includes(entry.todayISO()), `бесполезный commit message: ${body.message}`);
});

await step('§7.2: успех — уведомление про задержку Action и переход на шпаргалку', async () => {
  const root = await renderScreen({ index: INDEX_NEAR });
  fillReps(blockOf(root, 'waist_who'), ['86,5', '87,0', '86,8']);
  await clickSave(root);

  const texts = toastHost.children.map((node) => node.textContent);
  assert.equal(texts.length, 1, 'уведомления о сохранении нет');
  assert.ok(texts[0].includes('сохранена'), texts[0]);
  assert.ok(/index\.json|десятки секунд/.test(texts[0]), `нет предупреждения о задержке: ${texts[0]}`);
  assert.equal(globalThis.location.hash, '#/', 'перехода на шпаргалку не случилось');
});

await step('T6: нет сети — сессия ложится в очередь, а не теряется', async () => {
  const root = await renderScreen({ index: INDEX_NEAR, put: { kind: 'offline' } });
  const block = blockOf(root, 'waist_who');
  fillReps(block, ['86,5', '87,0', '86,8']);
  typeInto(noteOf(block), 'после душа');
  await clickSave(root);

  const jobs = await queue.listJobs();
  assert.equal(jobs.length, 1, 'сессия не доехала ни до repo B, ни до очереди');
  assert.equal(jobs[0].status, 'pending');
  assert.equal(jobs[0].lastError, 'Нет сети.');
  const session = JSON.parse(jobs[0].content);
  assert.equal(session.entries[0].value, 86.8, 'в очередь легло не то значение');
  assert.equal(session.entries[0].note, 'после душа');

  // Пользователю сказали и про причину, и про то, что запись не пропала.
  const texts = toastHost.children.map((node) => node.textContent);
  assert.equal(texts.length, 1, 'уведомления об очереди нет');
  assert.ok(texts[0].includes('Нет сети.'), texts[0]);
  assert.ok(texts[0].includes('очереди'), texts[0]);
  assert.equal(globalThis.location.hash, '#/', 'экран ввода не отпустил: сессия уже сохранена');
});

await step('T6: сеть вернулась — очередь дошлёт ту же сессию без повторного ввода', async () => {
  putReply = { kind: 'ok' };
  const result = await queue.flush();

  assert.deepEqual(result, { sent: 1, failed: 0, errors: [] });
  assert.equal(savedSession().entries[0].value, 86.8);
  assert.equal(putCall().path, `data/${entry.todayISO()}.json`);
  assert.deepEqual(await queue.listJobs(), []);
});

await step('T6: провал по вине токена — очередь помечает задание failed', async () => {
  const root = await renderScreen({
    index: INDEX_NEAR,
    put: { kind: 'status', status: 403 }
  });
  fillReps(blockOf(root, 'waist_who'), ['86,5', '87,0', '86,8']);
  await clickSave(root);

  const jobs = await queue.listJobs();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, 'failed', 'нет прав — само не рассосётся');
  assert.equal(jobs[0].lastError, 'У токена нет прав на этот репозиторий.');

  const texts = toastHost.children.map((node) => node.textContent);
  assert.ok(texts[0].includes('У токена нет прав на этот репозиторий.'), texts[0]);
  assert.ok(texts[0].includes('Настройках'), `не сказано, где смотреть очередь: ${texts[0]}`);
});

await step('T6: тексты очереди — на русском и с причиной', () => {
  const pending = entry.queuedText({ status: 'pending', lastError: 'Нет сети.' });
  assert.ok(pending.startsWith('Нет сети.'), pending);
  assert.ok(pending.includes('очереди'), pending);

  const failed = entry.queuedText({ status: 'failed', lastError: 'Токен не задан. Открой Настройки и вставь PAT.' });
  assert.ok(failed.includes('Токен не задан.'), failed);
  assert.ok(failed.includes('Настройках'), failed);

  for (const text of [pending, failed]) assert.match(text, /[а-яё]/i, `текст не русский: ${text}`);
});

await step('T6: пока сессия сохраняется, второе нажатие ничего не делает', async () => {
  const root = await renderScreen({ index: INDEX_NEAR, put: { kind: 'offline' } });
  fillReps(blockOf(root, 'waist_who'), ['86,5', '87,0', '86,8']);
  // Оба нажатия — до того, как первое досчиталось: защита от двойного тапа.
  saveButton(root).dispatch('click');
  saveButton(root).dispatch('click');
  await settle();

  assert.equal((await queue.listJobs()).length, 1, 'двойной тап поставил в очередь два задания');
});

await step('пустая сессия не уходит в сеть, а объясняет, чего не хватает', async () => {
  const root = await renderScreen({ index: INDEX_NEAR });
  await clickSave(root);

  assert.equal(putCall(), undefined, 'пустая сессия ушла в repo B');
  assert.equal(githubCalls.filter((call) => call.path === 'data').length, 0, 'лишний листинг data/');
  const text = messagesText(root);
  assert.match(text, /[а-яё]/i, `текст не русский: ${text}`);
  assert.ok(text.includes('нет ни одного значения'), text);
  assert.equal(blocksOf(root).length, 10, 'форма пережила отказ');
});

// --- Сторожа инвариантов --------------------------------------------------

const SOURCE = readFileSync(new URL('./screens/entry.js', import.meta.url), 'utf8');
// Комментарии из проверки вычёркиваем: слово sha в объяснении, почему его
// здесь нет, — не нарушение.
const CODE = SOURCE.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');

await step('чек-лист §10: в коде экрана нет ни одного пути к правке файла сессии', () => {
  assert.ok(!/\bsha\b/i.test(CODE), 'в коде появилось sha — это путь к перезаписи существующего файла');
  // С T6 экран вообще не пишет в repo B: единственный writeFile проекта
  // живёт в queue.js, и там же его сторожит queue.selftest.mjs.
  assert.equal((CODE.match(/writeFile\(/g) ?? []).length, 0, 'экран снова пишет в repo B мимо очереди');
  assert.equal((CODE.match(/readFile\(/g) ?? []).length, 1, 'экран читает что-то ещё, кроме index.json');
  assert.ok(CODE.includes('readFile(INDEX_PATH)'), 'единственное чтение — не index.json');
  assert.ok(!/readFileOrNull/.test(CODE));
});

await step('§0: экран не знает про localStorage, innerHTML и внешние адреса', () => {
  assert.ok(!/localStorage/.test(SOURCE), 'localStorage живёт только в store.js (§3 контракта)');
  assert.ok(!/innerHTML|insertAdjacentHTML|document\.write/.test(SOURCE), 'разметка строкой');
  assert.ok(!/https?:\/\//.test(CODE), 'внешний адрес в коде экрана');
  assert.ok(!/indexedDB/.test(SOURCE), 'IndexedDB живёт только в queue.js (контракт §7)');
});

await step('CSS: каждый класс экрана описан в style.css', async () => {
  const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8');
  const classes = new Set();
  const collect = (root) => {
    for (const node of [root, ...walk(root)]) {
      for (const name of String(node.className).split(/\s+/)) {
        if (name.startsWith('entry-')) classes.add(name);
      }
    }
  };

  // Два прохода: полная сессия с подтверждением отклонения и режим
  // отдельных замеров — вместе они дают все узлы экрана.
  const first = await renderScreen({ index: INDEX_FAR });
  fillReps(blockOf(first, 'waist_who'), ['90,0', '90,0', '90,0']);
  collect(first);

  const second = await renderScreen({ index: INDEX_NEAR });
  toggle(modeInputs(second)[1], true);
  toggle(inputsIn(pickerLabels(second).find((label) => label.dataset.key === 'height'))[0], true);
  collect(second);

  assert.ok(classes.size >= 15, `классов экрана нашлось только ${classes.size}`);
  for (const name of classes) {
    assert.ok(css.includes(`.${name}`), `класс .${name} не описан в style.css`);
  }
});

console.log(`Итог: ${passed} ок, ${failed} провалено.`);
process.exitCode = failed === 0 ? 0 : 1;
