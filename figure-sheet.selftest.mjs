// Самопроверка T13: шторка быстрого ввода на экране «Фигура» (§7.5 спеки).
//
// Запуск:
//   C:\Users\user\AppData\Roaming\nvm\v24.4.0\node.exe figure-sheet.selftest.mjs
//
// Только stdlib. Мини-DOM проверяет итоговое дерево и реальный сетевой
// раунд-трип записи (GET листинга + PUT файла), а не детали реализации.

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { accountDataDir, accountIndexPath } from './accounts.js';

// ===== Мини-DOM (тот же приём, что в figure-screen.selftest.mjs) =========

function createElement(tag) {
  const classes = new Set();
  const listeners = new Map();
  const node = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentNode: null,
    textContent: '',
    hidden: false,
    style: {},
    dataset: {},
    attributes: new Map()
  };

  Object.defineProperty(node, 'className', {
    get: () => Array.from(classes).join(' '),
    set: (value) => {
      classes.clear();
      for (const name of String(value ?? '').split(/\s+/)) if (name) classes.add(name);
    }
  });

  node.classList = {
    add: (...names) => { for (const name of names) if (name) classes.add(name); },
    remove: (...names) => { for (const name of names) classes.delete(name); },
    contains: (name) => classes.has(name)
  };

  node.append = (...nodes) => {
    for (const child of nodes) {
      child.parentNode = node;
      node.children.push(child);
    }
  };
  node.replaceChildren = (...nodes) => {
    for (const child of node.children) child.parentNode = null;
    node.children = [];
    node.append(...nodes);
  };

  node.setAttribute = (name, value) => {
    node.attributes.set(name, String(value));
    if (name === 'class') node.className = value;
  };
  node.getAttribute = (name) => (node.attributes.has(name) ? node.attributes.get(name) : null);
  node.addEventListener = (type, handler) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(handler);
  };
  node.removeEventListener = (type, handler) => {
    listeners.set(type, (listeners.get(type) ?? []).filter((item) => item !== handler));
  };
  node.dispatch = (type, extra = {}) => {
    for (const handler of (listeners.get(type) ?? []).slice()) {
      handler({ type, target: node, currentTarget: node, preventDefault() {}, stopPropagation() {}, ...extra });
    }
  };

  return node;
}

function walk(node, out = []) {
  for (const child of node.children) {
    out.push(child);
    walk(child, out);
  }
  return out;
}

function byClass(root, name) {
  return walk(root).filter((node) => node.classList.contains(name));
}

function firstByClass(root, name) {
  return byClass(root, name)[0] ?? null;
}

// ===== Заглушки браузера ==================================================

const headerStatus = createElement('span');
const windowListeners = new Map();
globalThis.window = {
  addEventListener(type, handler) {
    if (!windowListeners.has(type)) windowListeners.set(type, []);
    windowListeners.get(type).push(handler);
  },
  removeEventListener(type, handler) {
    windowListeners.set(type, (windowListeners.get(type) ?? []).filter((item) => item !== handler));
  }
};
globalThis.document = {
  createElement,
  createElementNS: (namespace, tag) => createElement(tag),
  getElementById: (id) => (id === 'header-status' ? headerStatus : null),
  querySelectorAll: () => []
};
globalThis.location = { hash: '#/figure' };

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => (storage.has(String(key)) ? storage.get(String(key)) : null),
  setItem: (key, value) => { storage.set(String(key), String(value)); },
  removeItem: (key) => { storage.delete(String(key)); }
};

const CATALOG_PATH = new URL('./catalog.json', import.meta.url);
const CATALOG_RAW = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));

// git-хэш содержимого — то же самое, что GitHub кладёт в поле sha листинга.
function gitSha(content) {
  const bytes = Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

function fileEnvelope(data) {
  return {
    type: 'file',
    encoding: 'base64',
    content: Buffer.from(JSON.stringify(data), 'utf8').toString('base64'),
    sha: 'index-sha'
  };
}

function jsonReply(payload) {
  return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(payload) };
}

// 'alex' — уже реальный мигрированный аккаунт в data-репозитории (T29).
const ACCOUNT = 'alex';
const INDEX_PATH = accountIndexPath(ACCOUNT);
const DIR = accountDataDir(ACCOUNT);

let indexReply = { generated_at: new Date().toISOString(), latest: {}, series: {} };
let dataFiles = []; // предзаполненные файлы data/, как будто уже лежат в repo B
const githubCalls = [];

globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  if (!target.includes('api.github.com')) {
    return { ok: true, status: 200, json: async () => CATALOG_RAW };
  }

  const method = String(init.method ?? 'GET').toUpperCase();
  const path = decodeURIComponent(new URL(target).pathname.split('/contents/')[1] ?? '');
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
  githubCalls.push({ method, path, body });

  if (method === 'PUT') {
    const content = Buffer.from(body.content, 'base64').toString('utf8');
    const sha = gitSha(content);
    dataFiles.push({ name: path.split('/').pop(), sha, content });
    return jsonReply({ content: { sha, path }, commit: { sha: 'commit-sha' } });
  }
  if (path === INDEX_PATH) return jsonReply(fileEnvelope(indexReply));
  if (path === DIR) {
    return jsonReply(dataFiles.map((file) => ({
      type: 'file', name: file.name, path: `${DIR}/${file.name}`, sha: file.sha, size: 10
    })));
  }
  throw new Error(`неожиданный запрос к GitHub: ${method} ${path}`);
};

const figureScreen = await import('./screens/figure.js');
const store = await import('./store.js');

let passed = 0;
let failed = 0;

async function step(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`✗ ${name}: ${error?.message ?? String(error)}`);
  }
}

async function settle() {
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => { setTimeout(resolve, 0); });
}

// Закрытие шторки теперь анимированное (SHEET_CLOSE_MS) — узел убирается
// из DOM таймером в createSheetController, а не сразу по close().
async function settleSheetClose() {
  await new Promise((resolve) => { setTimeout(resolve, figureScreen.SHEET_CLOSE_MS + 20); });
}

function indexWith(series) {
  return { generated_at: new Date().toISOString(), latest: {}, series };
}

// Одна прошлая дата и «сегодня» — чтобы полоса дат отдавала больше одного
// чипа и тест мог выбрать заведомо не сегодняшний срез.
const PAST_DATE = '2020-01-01';
const FULL_SERIES = {
  chest: [{ date: PAST_DATE, value: 100, protocol_version: 1 }]
};

async function renderScreen(series = FULL_SERIES) {
  figureScreen.destroy();
  storage.clear();
  githubCalls.length = 0;
  dataFiles = [];
  indexReply = indexWith(series);
  // T31 (не эта задача) добавит гейт логина; T30 предполагает, что к моменту
  // монтирования экрана активный профиль уже есть — сеем его так же, как токен.
  storage.set(store.KEYS.activeAccount, ACCOUNT);
  storage.set(store.KEYS.token, 'github_pat_fixture');
  storage.set(store.KEYS.index, JSON.stringify({ data: indexReply, fetchedAt: new Date().toISOString() }));
  storage.set(store.KEYS.catalog, JSON.stringify({ data: CATALOG_RAW, fetchedAt: new Date().toISOString() }));
  const root = createElement('main');
  root.className = 'screen';
  await figureScreen.render(root, {});
  await settle();
  return root;
}

console.log('Самопроверка T13: screens/figure.js — шторка быстрого ввода');

await step('сторож: оба входа в шторку зовут один и тот же переиспользуемый компонент', () => {
  // T15 (§14 контракта): шторку экспортирует figure.js и переиспользует
  // sizes.js — «один компонент с двумя точками вызова». Открытие живёт
  // в createSheetController(), а не в отдельной openSheet().
  const source = readFileSync(new URL('./screens/figure.js', import.meta.url), 'utf8');
  assert.equal((source.match(/export function createSheetController\(/g) ?? []).length, 1, 'шторка обязана быть ровно одним экспортируемым компонентом');

  const calloutBody = /function buildCallout\([^)]*\) \{([\s\S]*?)\n  return guide;\n\}/.exec(source)?.[1] ?? '';
  const rowBody = /function buildRow\([^)]*\) \{([\s\S]*?)\n  row\.append\(heading, reading\);/.exec(source)?.[1] ?? '';
  assert.match(calloutBody, /state\?\.sheetCtrl\?\.open\(entry\.key\)/, 'выноска обязана звать sheetCtrl.open()');
  assert.match(rowBody, /state\?\.sheetCtrl\?\.open\(entry\.key\)/, 'строка списка обязана звать sheetCtrl.open()');

  assert.doesNotMatch(source, /\b(?:writeFile|listFiles)\b/, 'запись идёт только через очередь queue.js');
  assert.doesNotMatch(source, /\benqueue\(/, 'T14: склейка дня работает только через enqueueEntry(), не через голый enqueue()');
  assert.match(source, /import \{ enqueueEntry, flush, isPersistent, listJobs, onQueueChange, pendingEntries \} from '\.\.\/queue\.js'/);
});

await step('строка списка открывает шторку с протоколом и ссылкой в историю', async () => {
  const root = await renderScreen();
  const row = byClass(root, 'mrow').find((item) => item.dataset.key === 'waist_who');
  assert.ok(row, 'строка талии не найдена');
  row.dispatch('click');
  const sheet = firstByClass(root, 'sheet');
  assert.ok(sheet, 'шторка не открылась по клику на строку');
  assert.equal(firstByClass(sheet, 'sheet__title').textContent, 'Талия (WHO)');
  assert.ok(byClass(sheet, 'sheet__protocol').length >= 1, 'протокол (landmark/posture) не показан');
  const history = walk(sheet).find((node) => node.tagName === 'A');
  assert.equal(history.href, '#/history/waist_who');
  const hint = firstByClass(sheet, 'sheet__hint');
  assert.equal(hint.textContent, 'Первый замер', 'талия WHO не измерялась вовсе — подсказка обязана это сказать');
});

await step('T21: редактор использует новую структуру степпера и протокола', async () => {
  const root = await renderScreen();
  const row = byClass(root, 'mrow').find((item) => item.dataset.key === 'waist_who');
  row.dispatch('click');
  const sheet = firstByClass(root, 'sheet');
  assert.ok(sheet.classList.contains('sheet--editor'), 'шторка конкретного замера обязана быть editor-вида');
  assert.equal(byClass(sheet, 'sheet__protocol--landmark').length, 1, 'ориентир обязан иметь свой уровень контраста');
  assert.equal(byClass(sheet, 'sheet__protocol--posture').length, 1, 'поза обязана иметь свой уровень контраста');
  assert.ok(firstByClass(sheet, 'sheet__value'), 'значение обязано лежать в отдельном жёлобе степпера');
  assert.ok(firstByClass(sheet, 'sheet__slider'), 'ползунок ui_range обязан оставаться частью редактора');

  const styles = readFileSync(new URL('./style.css', import.meta.url), 'utf8');
  assert.match(styles, /\.sheet__value\s*\{[\s\S]*?background:\s*var\(--surface-2\)/, 'жёлоб значения обязан использовать токен вторичной поверхности');
  assert.doesNotMatch(styles, /\.sheet__slider,\s*\.sheet__range\s*\{\s*display:\s*none;/, 'T21: слайдер не должен исчезать в desktop-виде');
});

await step('выноска силуэта открывает ровно ту же шторку', async () => {
  const root = await renderScreen();
  const guide = byClass(root, 'fig-guide').find((node) => node.getAttribute('aria-label') === 'Внести замер: Грудь');
  assert.ok(guide, 'выноска груди не найдена');
  guide.dispatch('click');
  const sheet = firstByClass(root, 'sheet');
  assert.ok(sheet, 'шторка не открылась по клику на выноску');
  assert.equal(firstByClass(sheet, 'sheet__title').textContent, 'Грудь');
  assert.equal(firstByClass(sheet, 'sheet__hint').textContent, 'Было 100 см', 'грудь измерена — подсказка обязана показать прошлое значение');
});

await step('сохранение создаёт новый файл сессии, помечает один повтор и не трогает старые файлы', async () => {
  const root = await renderScreen();
  // Файл прошлой сессии уже лежит в repo B — предзаполняем мок после
  // renderScreen(), которая сама очищает dataFiles при старте.
  dataFiles = [{ name: `${PAST_DATE}.json`, sha: 'existing-sha', content: '{}' }];
  const before = dataFiles.length;

  const row = byClass(root, 'mrow').find((item) => item.dataset.key === 'neck');
  row.dispatch('click');
  const save = byClass(root, 'sheet__actions')[0].children.find((node) => node.textContent === 'Сохранить');
  save.dispatch('click');
  await settle();

  const puts = githubCalls.filter((call) => call.method === 'PUT');
  assert.equal(puts.length, 1, 'ровно один PUT — ровно один новый файл');
  assert.equal(Object.prototype.hasOwnProperty.call(puts[0].body, 'sha'), false, 'sha в теле означал бы правку существующего файла');

  const today = new Date();
  const todayISO = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  assert.equal(puts[0].path, `${DIR}/${todayISO}.json`);

  const written = JSON.parse(Buffer.from(puts[0].body.content, 'base64').toString('utf8'));
  assert.equal(written.date, todayISO);
  assert.equal(written.entries.length, 1);
  assert.equal(written.entries[0].key, 'neck');
  assert.equal(written.entries[0].note, 'быстрый ввод, один повтор');
  assert.equal(written.entries[0].raw.length, 1, 'у быстрого ввода один повтор, а не три');

  assert.equal(dataFiles.length, before + 1, 'старый файл сессии остался на месте, добавился ровно один новый');
  assert.equal(dataFiles[0].content, '{}', 'существующий файл не переписан');

  // Шторка закрывается сама после подтверждённой записи (с анимацией выхода).
  await settleSheetClose();
  assert.equal(byClass(root, 'sheet').length, 0);
});

await step('открытый срез на прошлую дату не даёт записать в прошлое', async () => {
  const root = await renderScreen();
  const chip = byClass(root, 'chip').find((node) => node.dataset.date === PAST_DATE);
  assert.ok(chip, 'чип прошлой даты не найден');
  chip.dispatch('click');
  await settle();

  const row = byClass(root, 'mrow').find((item) => item.dataset.key === 'chest');
  row.dispatch('click');
  const sheet = firstByClass(root, 'sheet');
  const dateLine = firstByClass(sheet, 'sheet__date').textContent;
  assert.doesNotMatch(dateLine, /01\.01\.2020/, 'шторка не должна предлагать запись на выбранный прошлый срез');

  const save = byClass(sheet, 'sheet__actions')[0].children.find((node) => node.textContent === 'Сохранить');
  save.dispatch('click');
  await settle();

  const today = new Date();
  const todayISO = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const put = githubCalls.filter((call) => call.method === 'PUT').at(-1);
  assert.equal(put.path, `${DIR}/${todayISO}.json`, 'запись обязана уйти в сегодняшний файл, а не в файл выбранного среза');
});

await step('отмена не отправляет ничего в очередь', async () => {
  const root = await renderScreen();
  const before = githubCalls.filter((call) => call.method === 'PUT').length;
  const row = byClass(root, 'mrow').find((item) => item.dataset.key === 'wrist');
  row.dispatch('click');
  const cancel = byClass(root, 'sheet__actions')[0].children.find((node) => node.textContent === 'Отмена');
  cancel.dispatch('click');
  await settle();
  await settleSheetClose();
  assert.equal(byClass(root, 'sheet').length, 0, 'шторка обязана закрыться');
  assert.equal(githubCalls.filter((call) => call.method === 'PUT').length, before, 'отмена не должна писать ничего');
});

await step('шаг +/- и ползунок клампятся в ui_range замера', async () => {
  const root = await renderScreen();
  const row = byClass(root, 'mrow').find((item) => item.dataset.key === 'weight');
  row.dispatch('click');
  const sheet = firstByClass(root, 'sheet');
  const buttons = byClass(sheet, 'sheet__step');
  const input = byClass(sheet, 'sheet__input')[0];
  const weightRange = CATALOG_RAW.measurements.find((item) => item.key === 'weight').ui_range;

  // Дефолт при отсутствии замера — середина диапазона.
  const seeded = Number(String(input.value).replace(',', '.'));
  assert.equal(seeded, (weightRange.min + weightRange.max) / 2);

  for (let i = 0; i < 4000; i += 1) buttons[0].dispatch('click'); // «−» много раз подряд
  assert.equal(Number(String(input.value).replace(',', '.')), weightRange.min, 'клампится в минимум диапазона');
});

figureScreen.destroy();
console.log(`Итог: ${passed} ок, ${failed} провалено.`);
process.exitCode = failed === 0 ? 0 : 1;
