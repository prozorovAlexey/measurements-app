// Автотест экрана настроек в объёме T8 (§7.4 спеки) + T34 (§17 контракта):
// PAT, счётчик открытий, JSON-экспорт активного профиля, состояние офлайн-
// очереди, кнопка «отправить сейчас», смена пароля, смена модели тела
// и удаление профиля.
//
// Запуск (node на PATH — v6.17.1, ES-модулей не понимает, §12 контракта):
//
//   C:\Users\user\AppData\Roaming\nvm\v24.4.0\node.exe settings.selftest.mjs
//
// Только stdlib: ни npm-пакетов, ни тест-раннера, ни jsdom (§0 контракта).
//
// IndexedDB здесь намеренно НЕ подставлен: queue.js уходит на запасной бэкенд
// в памяти, и проверяется ветка «браузер не даёт сохранить очередь на диск».
// Обратная ветка (полноценное хранилище) закрыта в entry.selftest.mjs, где
// заглушка IndexedDB есть: бэкенд выбирается один раз за загрузку страницы,
// и в одном процессе обе ветки не пройти.
//
// Мини-DOM — тот же, что в cheatsheet.selftest.mjs и entry.selftest.mjs.
// Скопирован намеренно: общий модуль-хелпер связал бы тесты разных задач.
//
// accounts.json/profile.json стабятся отдельно от remoteFiles (тот держит
// только файлы сессий) — тем же приёмом, что и в login.selftest.mjs:
// изменяемое состояние + счётчик PUT-попыток, чтобы проверить перечитывающий
// повтор на 409-конфликте (T34, приём read-sha-write-retry).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';

// ===== Мини-DOM ===========================================================

const clickedLinks = [];

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
    value: '',
    checked: false,
    disabled: false
  };

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
  node.dispatch = (type) => {
    for (const handler of (listeners.get(type) ?? []).slice()) handler({ type, target: node });
  };
  node.click = () => {
    if (node.tagName === 'A') clickedLinks.push({ href: node.href, download: node.download });
    node.dispatch('click');
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
globalThis.location = { hash: '#/settings' };

const downloadBlobs = new Map();
let blobNumber = 0;
URL.createObjectURL = (blob) => {
  const url = `blob:fixture-${blobNumber += 1}`;
  downloadBlobs.set(url, blob);
  return url;
};
URL.revokeObjectURL = () => {};

const storage = new Map();
let failStorageSet = false;
let failStorageRemove = false;

globalThis.localStorage = {
  getItem: (key) => (storage.has(String(key)) ? storage.get(String(key)) : null),
  setItem: (key, value) => {
    if (failStorageSet) throw new Error('storage set blocked');
    storage.set(String(key), String(value));
  },
  removeItem: (key) => {
    if (failStorageRemove) throw new Error('storage remove blocked');
    storage.delete(String(key));
  }
};

// ===== Заглушка сети ======================================================

const TOKEN = 'github_pat_fixture';
const DAY = '2026-08-14';
const ACCOUNT = 'alex';
const DATA_DIR = `accounts/${ACCOUNT}/data`; // == accounts.accountDataDir(ACCOUNT)

const calls = [];
let putReply = { kind: 'ok' };
const remoteFiles = new Map();

// accounts.json — изменяемое состояние + счётчик PUT-попыток (как в
// login.selftest.mjs): нужно проверить и обычную запись, и перечитывающий
// повтор на 409-конфликте.
let accountsState = null; // { data, sha } | null (=> accounts.json ещё не создан)
let accountsPutMode = 'ok'; // 'ok' | 'conflict-once' | 'fail'
let accountsPutAttempts = 0;

// profile.json по каждому профилю — та же идея, отдельно от accountsState.
let profileState = new Map(); // accountId -> { data, sha }
let profilePutMode = 'ok';
let profilePutAttempts = 0;

function jsonReply(payload) {
  return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(payload) };
}

function notFoundReply() {
  return { ok: false, status: 404, headers: { get: () => null }, text: async () => '' };
}

function conflictReply() {
  return {
    ok: false,
    status: 409,
    headers: { get: () => null },
    text: async () => JSON.stringify({ message: 'sha does not match' })
  };
}

function failReply(status = 500) {
  return { ok: false, status, headers: { get: () => null }, text: async () => '' };
}

globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  assert.ok(target.startsWith('https://api.github.com/'), `неожиданный хост: ${target}`);
  const method = String(init.method ?? 'GET').toUpperCase();
  const path = decodeURIComponent(new URL(target).pathname.split('/contents/')[1] ?? '');
  calls.push({ method, path, body: typeof init.body === 'string' ? JSON.parse(init.body) : null });

  if (path === 'accounts.json') {
    if (method === 'GET') {
      if (!accountsState) return notFoundReply();
      return jsonReply({
        type: 'file',
        encoding: 'base64',
        content: Buffer.from(JSON.stringify(accountsState.data), 'utf8').toString('base64'),
        sha: accountsState.sha
      });
    }
    if (method === 'PUT') {
      accountsPutAttempts += 1;
      if (accountsPutMode === 'conflict-once' && accountsPutAttempts === 1) return conflictReply();
      if (accountsPutMode === 'fail') return failReply();
      const written = JSON.parse(init.body);
      accountsState = {
        data: JSON.parse(Buffer.from(written.content, 'base64').toString('utf8')),
        sha: `reg-sha-${accountsPutAttempts}`
      };
      return jsonReply({ content: { sha: accountsState.sha, path }, commit: { sha: 'commit' } });
    }
  }

  if (path.startsWith('accounts/') && path.endsWith('/profile.json')) {
    const accountId = path.split('/')[1];
    if (method === 'GET') {
      const stored = profileState.get(accountId);
      if (!stored) return notFoundReply();
      return jsonReply({
        type: 'file',
        encoding: 'base64',
        content: Buffer.from(JSON.stringify(stored.data), 'utf8').toString('base64'),
        sha: stored.sha
      });
    }
    if (method === 'PUT') {
      profilePutAttempts += 1;
      if (profilePutMode === 'conflict-once' && profilePutAttempts === 1) return conflictReply();
      if (profilePutMode === 'fail') return failReply();
      const written = JSON.parse(init.body);
      const next = {
        data: JSON.parse(Buffer.from(written.content, 'base64').toString('utf8')),
        sha: `profile-sha-${profilePutAttempts}`
      };
      profileState.set(accountId, next);
      return jsonReply({ content: { sha: next.sha, path }, commit: { sha: 'commit' } });
    }
  }

  if (method === 'PUT') {
    if (putReply.kind === 'offline') throw new TypeError('сети нет (заглушка теста)');
    if (putReply.kind === 'status') {
      return { ok: false, status: putReply.status, headers: { get: () => null }, text: async () => '' };
    }
    return jsonReply({ content: { sha: 'sha-written', path }, commit: { sha: 'commit' } });
  }
  if (remoteFiles.has(path)) {
    return jsonReply({
      type: 'file',
      encoding: 'base64',
      content: Buffer.from(remoteFiles.get(path), 'utf8').toString('base64'),
      sha: `sha-${path}`
    });
  }
  // Листинг директории: и настоящий accountDataDir(ACCOUNT), и любой другой
  // путь с файлами в remoteFiles под ним — GitHub Contents API отдаёт массив
  // и для пустой (ещё не заведённой) директории.
  const dirPrefix = `${path}/`;
  const dirMatches = Array.from(remoteFiles.keys()).filter((key) => key.startsWith(dirPrefix));
  if (dirMatches.length > 0 || path === DATA_DIR) {
    return jsonReply(dirMatches.map((filePath) => ({
      type: 'file',
      name: filePath.split('/').at(-1),
      path: filePath,
      sha: `sha-${filePath}`,
      size: remoteFiles.get(filePath).length
    })));
  }
  return jsonReply([]);
};

const settings = await import('./screens/settings.js');
const accounts = await import('./accounts.js');
const github = await import('./github.js');
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

async function settle() {
  // T34: смена пароля и смена модели тела на conflict-once цепляют реальный
  // PBKDF2 (verifyPassword + hashPassword) и до двух PUT с перечитыванием —
  // длиннее, чем что-либо в этом файле раньше. 8 тиков местами не хватало
  // (флуктуация реального времени хеширования) — с запасом взято 20, как
  // и в login.selftest.mjs (10) с поправкой на более длинную цепочку здесь.
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => { setTimeout(resolve, 0); });
}

function sessionText(value) {
  return JSON.stringify({
    date: DAY,
    time: '09:12',
    protocol_version: 1,
    conditions: { fasted: true, post_void: true, hours_since_training: 24 },
    entries: [{
      key: 'waist_who',
      raw: [value],
      value,
      unit: 'cm',
      protocol_version: 1,
      note: ''
    }]
  }, null, 2);
}

// T34: реестр с одним профилем (ACCOUNT) — общая фикстура для карточек
// пароля и удаления. hashPassword гоняет настоящий crypto.subtle, как
// в accounts.selftest.mjs/login.selftest.mjs — не имитацию.
const CURRENT_PASSWORD = 'Qwe123';
const currentHash = await accounts.hashPassword(CURRENT_PASSWORD);
const ACCOUNT_RECORD = {
  id: ACCOUNT, label: 'Alex', salt: currentHash.salt, hash: currentHash.hash, createdAt: '2026-08-01'
};
const BASE_REGISTRY = { version: 1, accounts: [ACCOUNT_RECORD] };

async function renderScreen(options = {}) {
  const {
    jobs = [],
    opens = null,
    put = { kind: 'ok' },
    remote = [],
    token = TOKEN,
    activeAccount = ACCOUNT,
    registry = null,
    registrySha = 'reg-sha-0',
    profile = null,
    profileSha = 'profile-sha-0',
    accountsPutModeOpt = 'ok',
    profilePutModeOpt = 'ok'
  } = options;

  settings.destroy();
  for (const job of await queue.listJobs()) await queue.removeJob(job.id);
  storage.clear();
  failStorageSet = false;
  failStorageRemove = false;
  calls.length = 0;
  clickedLinks.length = 0;
  downloadBlobs.clear();
  remoteFiles.clear();
  toastHost.replaceChildren();
  putReply = put;
  accountsState = registry ? { data: registry, sha: registrySha } : null;
  accountsPutMode = accountsPutModeOpt;
  accountsPutAttempts = 0;
  profileState = new Map();
  if (profile) profileState.set(activeAccount, { data: profile, sha: profileSha });
  profilePutMode = profilePutModeOpt;
  profilePutAttempts = 0;
  if (token) storage.set(store.KEYS.token, token);
  if (opens) storage.set(store.KEYS.opens, JSON.stringify(opens));
  if (activeAccount) storage.set(store.KEYS.activeAccount, activeAccount);
  for (const [path, content] of remote) remoteFiles.set(path, content);

  for (const value of jobs) {
    await queue.enqueue({
      path: `${DATA_DIR}/${DAY}.json`,
      content: sessionText(value),
      message: `Сессия ${DAY} 09:12`
    });
  }

  const root = createElement('div');
  await settings.render(root, {});
  await settle();
  return root;
}

function byClass(root, className) {
  return walk(root).filter((node) => node.classList.contains(className));
}

function jobCards(root) {
  return byClass(root, 'queue-job');
}

function buttons(node) {
  return walk(node).filter((item) => item.tagName === 'BUTTON');
}

function inputs(node) {
  return walk(node).filter((item) => item.tagName === 'INPUT');
}

function buttonWith(root, text) {
  return buttons(root).find((item) => item.textContent === text);
}

function sendButton(root) {
  return buttonWith(root, 'Отправить сейчас') ?? buttonWith(root, 'Отправляю…');
}

async function click(button) {
  assert.ok(button, 'кнопки нет на экране');
  button.dispatch('click');
  await settle();
}

// --- T34: карточки пароля/тела/удаления --------------------------------

function passwordCardOf(root) {
  return byClass(root, 'settings-password')[0];
}

function bodyCardOf(root) {
  return byClass(root, 'settings-body')[0];
}

function deleteCardOf(root) {
  return byClass(root, 'settings-delete')[0];
}

function currentPasswordInput(root) {
  return inputs(passwordCardOf(root)).find((item) => item.autocomplete === 'current-password');
}

function newPasswordInput(root) {
  return inputs(passwordCardOf(root)).find((item) => item.autocomplete === 'new-password');
}

async function type(input, value) {
  input.value = value;
  input.dispatch('input');
  await settle();
}

function putCalls(path) {
  return calls.filter((call) => call.method === 'PUT' && call.path === path);
}

function getCalls(path) {
  return calls.filter((call) => call.method === 'GET' && call.path === path);
}

function decodePutContent(call) {
  return Buffer.from(call.body.content, 'base64').toString('utf8');
}

const toasts = () => toastHost.children.map((node) => node.textContent);

console.log('Самопроверка T6: screens/settings.js');

// --- Контракт экрана ------------------------------------------------------

await step('контракт §2: title, render, destroy', () => {
  assert.equal(settings.title, 'Настройки');
  assert.equal(typeof settings.render, 'function');
  assert.equal(typeof settings.destroy, 'function');
});

await step('§7.4: PAT скрыт, сохраняется и очищается через store.js', async () => {
  const root = await renderScreen();
  let input = inputs(root)[0];
  assert.ok(input, 'нет поля PAT');
  assert.equal(input.type, 'password');
  assert.equal(input.value, TOKEN);
  assert.ok(!textOf(root).includes(TOKEN), 'PAT показан обычным текстом');

  await click(buttonWith(root, 'Очистить PAT'));
  assert.equal(store.getToken(), null);
  input = inputs(root)[0];
  input.value = 'github_pat_new';
  await click(buttonWith(root, 'Сохранить PAT'));
  assert.equal(store.getToken(), 'github_pat_new');
});

await step('PAT: classic/чужой формат отвергается, подсказка фиксирует срок и repo B', async () => {
  const root = await renderScreen({ token: null });
  const input = inputs(root)[0];
  for (const bad of ['ghp_classic', 'github_pat_', 'обычный-токен']) {
    input.value = bad;
    await click(buttonWith(root, 'Сохранить PAT'));
    assert.equal(store.getToken(), null, `сохранён ${bad}`);
  }
  assert.ok(toasts().some((text) => text.includes('github_pat_')), toasts().join(' | '));
  assert.ok(textOf(root).includes('не больше 1 года'), textOf(root));
  assert.ok(textOf(root).includes('только для repo B'), textOf(root));
  assert.ok(textOf(root).includes('не может проверить'), textOf(root));
});

await step('legacy ghp_ виден как неподходящий, не уходит в Authorization и очищается', async () => {
  const root = await renderScreen({ token: 'ghp_legacy_saved' });
  assert.equal(inputs(root)[0].value, 'ghp_legacy_saved');
  assert.ok(textOf(root).includes('не является fine-grained PAT'), textOf(root));
  assert.equal(store.getStoredToken(), 'ghp_legacy_saved');
  assert.equal(store.getToken(), null);
  await assert.rejects(
    github.readFile('index.json'),
    (error) => error?.kind === 'no-token'
  );
  assert.deepEqual(calls, [], 'legacy токен дошёл до fetch/Authorization');
  await click(buttonWith(root, 'Очистить PAT'));
  assert.equal(store.getStoredToken(), null);
});

await step('ошибки setToken/clearToken не выдаются за успех и различаются', async () => {
  let root = await renderScreen({ token: null });
  let input = inputs(root)[0];
  input.value = 'github_pat_valid';
  failStorageSet = true;
  await click(buttonWith(root, 'Сохранить PAT'));
  assert.equal(store.getToken(), null);
  assert.ok(toasts().some((text) => text.includes('сохранить PAT')), toasts().join(' | '));
  assert.ok(!toasts().some((text) => text === 'PAT сохранён.'), toasts().join(' | '));

  root = await renderScreen({ token: 'github_pat_existing' });
  failStorageRemove = true;
  await click(buttonWith(root, 'Очистить PAT'));
  assert.equal(store.getToken(), 'github_pat_existing');
  assert.ok(toasts().some((text) => text.includes('удалить PAT')), toasts().join(' | '));
  assert.ok(!toasts().some((text) => text.includes('PAT удалён')), toasts().join(' | '));
});

await step('§7.4/T15: счётчик открытий шпаргалки (этап 1) виден и заморожен', async () => {
  const lastAt = new Date(2026, 7, 14, 9, 12).toISOString();
  const root = await renderScreen({ opens: { count: 7, lastAt } });
  const legacyBlock = byClass(root, 'settings-metric-block--legacy')[0];
  assert.ok(legacyBlock, 'блок старого счётчика шпаргалки не найден');
  assert.equal(byClass(legacyBlock, 'settings-metric')[0]?.textContent, '7');
  assert.ok(textOf(legacyBlock).includes('14.08.2026, 09:12'), textOf(legacyBlock));
});

await step('T15: счётчики opens.sizes и opens.app видны отдельно от старого', async () => {
  const root = await renderScreen({ opens: null });
  const sizesBlock = byClass(root, 'settings-metric-block--sizes')[0];
  const appBlock = byClass(root, 'settings-metric-block--app')[0];
  assert.ok(sizesBlock, 'блок счётчика «Размеры» не найден');
  assert.ok(appBlock, 'блок счётчика запусков приложения не найден');
  assert.equal(byClass(sizesBlock, 'settings-metric')[0]?.textContent, '0');
  assert.equal(byClass(appBlock, 'settings-metric')[0]?.textContent, '0');
});

await step('T8/T34: экспорт скачивает валидный JSON только активного профиля', async () => {
  const first = sessionText(86.8);
  const secondData = JSON.parse(sessionText(64.2));
  secondData.date = '2026-08-15';
  secondData.time = '09:20';
  secondData.entries[0].key = 'weight';
  secondData.entries[0].unit = 'kg';
  const second = JSON.stringify(secondData);
  const pendingData = JSON.parse(sessionText(64.1));
  pendingData.date = '2026-08-16';
  pendingData.time = '09:25';
  pendingData.entries[0].key = 'weight';
  pendingData.entries[0].unit = 'kg';
  const pending = JSON.stringify(pendingData);
  const root = await renderScreen({
    remote: [
      [`${DATA_DIR}/2026-08-15.json`, second],
      [`${DATA_DIR}/README.txt`, 'не сессия'],
      [`${DATA_DIR}/${DAY}--2.json`, first],
      [`${DATA_DIR}/${DAY}.json`, first]
    ]
  });
  for (let copy = 1; copy <= 3; copy += 1) {
    await queue.enqueue({
      path: `${DATA_DIR}/${DAY}.json`,
      content: first,
      message: `дубль ${copy}`
    });
  }
  await queue.enqueue({ path: `${DATA_DIR}/2026-08-16.json`, content: pending, message: 'офлайн-сессия' });
  await queue.enqueue({ path: `${DATA_DIR}/2026-08-17.json`, content: '{битый json', message: 'мусор' });
  await queue.enqueue({ path: 'notes/task.json', content: pending, message: 'чужой путь' });
  // T34: задание чужого профиля — job.accountId === 'other' !== активного,
  // должно быть исключено фильтром loadQueuedSessions(), а не только регэкспом пути.
  await queue.enqueue({ path: 'accounts/other/data/2026-08-16.json', content: pending, message: 'чужой профиль' });
  await queue.enqueue({ path: `${DATA_DIR}/2026-08-18.json`, content: '{"kind":"не сессия"}', message: 'не session object' });
  await queue.enqueue({ path: `${DATA_DIR}/2026-08-19.json`, content: JSON.stringify({ ...pendingData, date: '2026-02-30' }), message: 'битая дата' });
  await queue.enqueue({ path: `${DATA_DIR}/2026-08-20.json`, content: JSON.stringify({ ...pendingData, time: '25:00' }), message: 'битое время' });
  await queue.enqueue({ path: `${DATA_DIR}/2026-08-21.json`, content: JSON.stringify({ ...pendingData, entries: [1, 2] }), message: 'не entries' });
  await queue.enqueue({ path: `${DATA_DIR}/2026-08-22.json`, content: JSON.stringify({ ...pendingData, entries: [{ ...pendingData.entries[0], key: '' }] }), message: 'нет key' });
  await queue.enqueue({ path: `${DATA_DIR}/2026-08-23.json`, content: JSON.stringify({ ...pendingData, date: [pendingData.date] }), message: 'date array' });
  await queue.enqueue({ path: `${DATA_DIR}/2026-08-24.json`, content: JSON.stringify({ ...pendingData, time: [pendingData.time] }), message: 'time array' });
  await settle();
  await click(buttonWith(root, 'Скачать всё как JSON'));

  assert.equal(clickedLinks.length, 1, 'скачивание не началось');
  assert.match(clickedLinks[0].download, /^body-measurements-\d{4}-\d{2}-\d{2}\.json$/);
  const blob = downloadBlobs.get(clickedLinks[0].href);
  assert.ok(blob, 'скачанный Blob не найден');
  const exported = JSON.parse(await blob.text());
  assert.deepEqual(exported, [
    JSON.parse(first),
    JSON.parse(first),
    JSON.parse(second),
    JSON.parse(first),
    JSON.parse(pending)
  ]);
  assert.deepEqual(calls.filter((call) => call.method === 'GET').map((call) => call.path).sort(), [
    DATA_DIR,
    `${DATA_DIR}/${DAY}--2.json`,
    `${DATA_DIR}/${DAY}.json`,
    `${DATA_DIR}/2026-08-15.json`
  ].sort());
});

await step('T8 update: waiting и installing worker получают skip-waiting без гонки', async () => {
  function target(extra = {}) {
    const listeners = new Map();
    return {
      ...extra,
      addEventListener(type, handler) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(handler);
      },
      removeEventListener(type, handler) {
        listeners.set(type, (listeners.get(type) ?? []).filter((fn) => fn !== handler));
      },
      dispatch(type) {
        for (const handler of (listeners.get(type) ?? []).slice()) handler({ type });
      },
      listenerCount(type) {
        return (listeners.get(type) ?? []).length;
      }
    };
  }

  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const messages = [];
  let registration;
  const serviceWorker = target({
    getRegistration: async () => registration
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { serviceWorker }
  });

  try {
    let waitingUpdateCalls = 0;
    const waiting = target({ postMessage: (message) => { messages.push(['waiting', message]); } });
    registration = target({
      waiting,
      installing: null,
      async update() {
        waitingUpdateCalls += 1;
        throw new TypeError('offline');
      }
    });
    let root = await renderScreen();
    await click(buttonWith(root, 'Обновить приложение'));
    assert.deepEqual(messages, [['waiting', { type: 'skip-waiting' }]]);
    assert.equal(waitingUpdateCalls, 0, 'готовый waiting worker зачем-то потребовал сеть');
    assert.ok(toasts().some((text) => text.includes('Включаю новую версию')), toasts().join(' | '));
    assert.equal(serviceWorker.listenerCount('controllerchange'), 1);
    serviceWorker.dispatch('controllerchange');
    assert.equal(serviceWorker.listenerCount('controllerchange'), 0, 'controllerchange listener не самоочистился');

    let finishUpdate;
    const installing = target({
      state: 'installing',
      postMessage: (message) => { messages.push(['installing', message]); }
    });
    registration = target({
      waiting: null,
      installing: null,
      update() {
        return new Promise((resolve) => { finishUpdate = resolve; });
      }
    });
    root = await renderScreen();
    await click(buttonWith(root, 'Обновить приложение'));
    assert.equal(registration.listenerCount('updatefound'), 1, 'наблюдение началось после update()');
    registration.installing = installing;
    registration.dispatch('updatefound');
    finishUpdate(registration);
    await settle();
    assert.ok(buttonWith(root, 'Проверяю…'), 'медленная установка ложно признана отсутствующей');
    assert.notDeepEqual(messages.at(-1), ['installing', { type: 'skip-waiting' }]);
    // Контролируемая задержка без реальных пяти секунд: пока state не installed,
    // observer остаётся жив независимо от количества event-loop циклов.
    await settle();
    installing.state = 'installed';
    registration.waiting = installing;
    installing.dispatch('statechange');
    await settle();
    assert.deepEqual(messages.at(-1), ['installing', { type: 'skip-waiting' }]);
    assert.equal(registration.listenerCount('updatefound'), 0);

    registration = target({
      waiting: null,
      installing: null,
      update: async () => registration
    });
    root = await renderScreen();
    assert.equal(serviceWorker.listenerCount('controllerchange'), 0, 'старый controllerchange не снят');
    await click(buttonWith(root, 'Обновить приложение'));
    assert.ok(toasts().some((text) => text.includes('Новая версия не найдена')), toasts().join(' | '));

    let finishLateUpdate;
    const late = target({
      state: 'installing',
      postMessage: (message) => { messages.push(['late', message]); }
    });
    registration = target({
      waiting: null,
      installing: null,
      update: () => new Promise((resolve) => { finishLateUpdate = resolve; })
    });
    root = await renderScreen();
    await click(buttonWith(root, 'Обновить приложение'));
    assert.equal(registration.listenerCount('updatefound'), 1);
    const messageCount = messages.length;
    settings.destroy();
    assert.equal(registration.listenerCount('updatefound'), 0, 'destroy не снял updatefound');
    assert.equal(serviceWorker.listenerCount('controllerchange'), 0, 'destroy не снял controllerchange');
    finishLateUpdate(registration);
    registration.installing = late;
    registration.dispatch('updatefound');
    late.state = 'installed';
    registration.waiting = late;
    late.dispatch('statechange');
    await settle();
    assert.equal(late.listenerCount('statechange'), 0, 'late update после destroy навесил statechange');
    assert.equal(messages.length, messageCount, 'late completion отправил skip-waiting после destroy');
    assert.equal(toasts().length, 0, 'late completion показал toast после destroy');

    let reloads = 0;
    location.reload = () => { reloads += 1; };
    const throwing = target({
      postMessage() {
        throw new Error('postMessage blocked');
      }
    });
    registration = target({
      waiting: throwing,
      installing: null,
      update: async () => registration
    });
    root = await renderScreen();
    await click(buttonWith(root, 'Обновить приложение'));
    assert.equal(serviceWorker.listenerCount('controllerchange'), 0, 'postMessage exception оставил controllerchange');
    serviceWorker.dispatch('controllerchange');
    assert.equal(reloads, 0, 'несвязанное controllerchange перезагрузило страницу');
    assert.ok(toasts().some((text) => text.includes('postMessage blocked')), toasts().join(' | '));
    delete location.reload;
  } finally {
    delete location.reload;
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else delete globalThis.navigator;
  }
});

await step('§7.4: пустая очередь названа словами, кнопка отправки заблокирована', async () => {
  const root = await renderScreen();

  assert.equal(jobCards(root).length, 0);
  assert.equal(byClass(root, 'queue-empty').length, 1, 'нет строки про пустую очередь');
  assert.ok(textOf(root).includes('Очередь пуста'), textOf(root));
  assert.equal(sendButton(root).disabled, true, 'отправлять нечего, а кнопка активна');
  assert.equal(calls.length, 0, 'пустая очередь полезла в сеть');
});

await step('§7.4: задание видно целиком — путь, время, статус', async () => {
  const root = await renderScreen({ jobs: [86.8] });

  const cards = jobCards(root);
  assert.equal(cards.length, 1);
  const text = textOf(cards[0]);
  assert.ok(text.includes(`data/${DAY}.json`), `нет пути файла: ${text}`);
  assert.ok(text.includes('Ожидает отправки'), `нет статуса: ${text}`);
  assert.ok(/Поставлено \d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}/.test(text), `нет времени постановки: ${text}`);
  assert.equal(sendButton(root).disabled, false);
});

await step('T6: без постоянного хранилища экран об этом предупреждает', async () => {
  const root = await renderScreen({ jobs: [86.8] });
  assert.equal(queue.isPersistent(), false, 'в этом тесте IndexedDB быть не должно');
  const warned = byClass(root, 'warn').some((node) => node.textContent.includes('на диск'));
  assert.ok(warned, `нет предупреждения про хранилище: ${textOf(root)}`);
});

// --- Отправка -------------------------------------------------------------

await step('§7.4: «Отправить сейчас» дошлёт очередь и скажет об этом', async () => {
  const root = await renderScreen({ jobs: [86.8] });
  await click(sendButton(root));

  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), [`GET ${DATA_DIR}`, `PUT ${DATA_DIR}/${DAY}.json`]);
  assert.deepEqual(await queue.listJobs(), [], 'задание осталось в очереди');
  assert.equal(jobCards(root).length, 0, 'экран не обновился после отправки');
  assert.ok(toasts().some((text) => text.includes('Отправлено: 1')), toasts().join(' | '));
});

await step('§7.4: две сессии одного дня уезжают разными файлами', async () => {
  const root = await renderScreen({ jobs: [86.8, 87.4] });
  assert.equal(jobCards(root).length, 2);
  await click(sendButton(root));

  assert.deepEqual(
    calls.filter((call) => call.method === 'PUT').map((call) => call.path),
    [`${DATA_DIR}/${DAY}.json`, `${DATA_DIR}/${DAY}--2.json`]
  );
  assert.equal(byClass(root, 'queue-empty').length, 1);
});

await step('провал отправки: причина в уведомлении и в самом задании', async () => {
  const root = await renderScreen({ jobs: [86.8], put: { kind: 'offline' } });
  await click(sendButton(root));

  assert.equal(jobCards(root).length, 1, 'задание пропало вместе с сессией');
  assert.ok(textOf(root).includes('Нет сети.'), textOf(root));
  assert.ok(toasts().some((text) => text.includes('Нет сети.')), toasts().join(' | '));
  assert.equal(sendButton(root).disabled, false, 'повторить отправку нечем');
});

await step('нет токена: задание помечено «Не отправилось»', async () => {
  const root = await renderScreen({ jobs: [86.8], token: null });
  await click(sendButton(root));

  assert.ok(textOf(root).includes('Не отправилось'), textOf(root));
  assert.ok(textOf(root).includes('Токен не задан.'), textOf(root));
});

// --- Удаление -------------------------------------------------------------

await step('удаление задания двухшаговое: сначала подтверждение', async () => {
  const root = await renderScreen({ jobs: [86.8] });

  await click(buttonWith(root, 'Удалить'));
  assert.equal((await queue.listJobs()).length, 1, 'задание удалилось с первого нажатия');
  assert.ok(textOf(root).includes('пропадут навсегда'), textOf(root));

  await click(buttonWith(root, 'Отмена'));
  assert.equal((await queue.listJobs()).length, 1);
  assert.ok(buttonWith(root, 'Удалить'), 'кнопка удаления не вернулась');

  await click(buttonWith(root, 'Удалить'));
  await click(buttonWith(root, 'Удалить навсегда'));
  assert.deepEqual(await queue.listJobs(), []);
  assert.equal(jobCards(root).length, 0);
});

// --- T34: смена пароля ------------------------------------------------------

await step('смена пароля: верный текущий — новый хеш уходит в PUT accounts.json, поля очищаются', async () => {
  const root = await renderScreen({ registry: BASE_REGISTRY });
  await type(currentPasswordInput(root), CURRENT_PASSWORD);
  await type(newPasswordInput(root), 'NewPass1');
  await click(buttonWith(passwordCardOf(root), 'Сменить пароль'));

  const puts = putCalls('accounts.json');
  assert.equal(puts.length, 1, 'ожидался ровно один PUT реестра');
  const written = JSON.parse(decodePutContent(puts[0]));
  const record = written.accounts.find((item) => item.id === ACCOUNT);
  assert.ok(record, 'записи профиля нет в записанном реестре');
  assert.notEqual(record.hash, ACCOUNT_RECORD.hash, 'хеш не изменился');
  assert.notEqual(record.salt, ACCOUNT_RECORD.salt, 'соль не пересчитана заново');
  assert.equal(await accounts.verifyPassword('NewPass1', record), true, 'новый пароль не проходит verifyPassword по записанному хешу');

  assert.ok(toasts().some((text) => text === 'Пароль изменён.'), toasts().join(' | '));
  assert.equal(currentPasswordInput(root).value, '', 'поле текущего пароля не очистилось');
  assert.equal(newPasswordInput(root).value, '', 'поле нового пароля не очистилось');
});

await step('смена пароля: неверный текущий — «Неверный пароль.», реестр не пишется', async () => {
  const root = await renderScreen({ registry: BASE_REGISTRY });
  await type(currentPasswordInput(root), 'wrong-current');
  await type(newPasswordInput(root), 'NewPass1');
  await click(buttonWith(passwordCardOf(root), 'Сменить пароль'));

  assert.equal(putCalls('accounts.json').length, 0, 'реестр записан при неверном текущем пароле');
  assert.ok(toasts().some((text) => text === 'Неверный пароль.'), toasts().join(' | '));
});

await step('смена пароля: короткий новый пароль — отказ клиентской валидацией, без сети', async () => {
  const root = await renderScreen({ registry: BASE_REGISTRY });
  await type(currentPasswordInput(root), CURRENT_PASSWORD);
  await type(newPasswordInput(root), 'abc');
  await click(buttonWith(passwordCardOf(root), 'Сменить пароль'));

  assert.equal(getCalls('accounts.json').length, 0, 'валидация нового пароля сходила в сеть');
  assert.match(textOf(passwordCardOf(root)), /[а-яё]/i, 'нет русского текста об ошибке валидации');
});

await step('T34 verify: 409-конфликт при смене пароля — перечитывает и повторяет запись', async () => {
  const root = await renderScreen({ registry: BASE_REGISTRY, accountsPutModeOpt: 'conflict-once' });
  await type(currentPasswordInput(root), CURRENT_PASSWORD);
  await type(newPasswordInput(root), 'NewPass1');
  await click(buttonWith(passwordCardOf(root), 'Сменить пароль'));

  assert.equal(putCalls('accounts.json').length, 2, 'после конфликта не случилось повторной записи');
  assert.equal(getCalls('accounts.json').length, 2, 'после конфликта не случилось перечитывания реестра');
  assert.ok(toasts().some((text) => text === 'Пароль изменён.'), toasts().join(' | '));
});

// --- T34: модель тела --------------------------------------------------------

await step('модель тела: переключение пишет profile.json (read-sha-write) и обновляет локально', async () => {
  const root = await renderScreen({ profile: { sex: 'male' } });
  assert.equal(store.getAccountProfile(ACCOUNT).sex, 'male');

  await click(buttonWith(bodyCardOf(root), 'Женский'));

  assert.equal(store.getAccountProfile(ACCOUNT).sex, 'female', 'локальный профиль не обновился сразу');
  const puts = putCalls(`accounts/${ACCOUNT}/profile.json`);
  assert.equal(puts.length, 1, 'ожидался ровно один PUT profile.json');
  assert.deepEqual(JSON.parse(decodePutContent(puts[0])), { sex: 'female' });
  const active = byClass(bodyCardOf(root), 'fig-sex__item--active')[0];
  assert.equal(active?.textContent, 'Женский', 'активная пилюля не переключилась в DOM');
});

await step('модель тела: повторный клик по уже активному варианту не пишет сеть', async () => {
  const root = await renderScreen({ profile: { sex: 'male' } });
  await click(buttonWith(bodyCardOf(root), 'Мужской'));
  assert.equal(putCalls(`accounts/${ACCOUNT}/profile.json`).length, 0, 'клик по уже активному полу ушёл в сеть');
});

await step('модель тела: провал записи — toast с текстом ошибки, локальное значение не откатывается', async () => {
  const root = await renderScreen({ profile: { sex: 'male' }, profilePutModeOpt: 'fail' });
  await click(buttonWith(bodyCardOf(root), 'Женский'));

  assert.equal(store.getAccountProfile(ACCOUNT).sex, 'female', 'локальное значение откатилось при сетевой ошибке');
  assert.ok(toasts().some((text) => text.includes('Неожиданный ответ GitHub')), toasts().join(' | '));
});

await step('T34 verify: 409-конфликт при смене модели тела — перечитывает и повторяет запись', async () => {
  const root = await renderScreen({ profile: { sex: 'male' }, profilePutModeOpt: 'conflict-once' });
  await click(buttonWith(bodyCardOf(root), 'Женский'));

  const puts = putCalls(`accounts/${ACCOUNT}/profile.json`);
  assert.equal(puts.length, 2, 'после конфликта не случилось повторной записи profile.json');
  assert.deepEqual(JSON.parse(decodePutContent(puts[1])), { sex: 'female' });
});

// --- T34: удаление профиля ---------------------------------------------------

await step('удаление профиля: без заданий очереди — подтверждение без текста про сессии', async () => {
  const root = await renderScreen({ registry: BASE_REGISTRY });
  await click(buttonWith(deleteCardOf(root), 'Удалить профиль'));

  assert.ok(textOf(deleteCardOf(root)).includes('удалён навсегда'), textOf(deleteCardOf(root)));
  assert.ok(!textOf(deleteCardOf(root)).includes('Несинхронизированных'), 'пустая очередь показала текст про сессии');
});

await step('удаление профиля: с заданиями — текст с числом несинхронизированных сессий', async () => {
  const root = await renderScreen({ registry: BASE_REGISTRY, jobs: [86.8, 87.4] });
  await click(buttonWith(deleteCardOf(root), 'Удалить профиль'));

  assert.ok(textOf(deleteCardOf(root)).includes('Несинхронизированных сессий: 2'), textOf(deleteCardOf(root)));
});

await step('удаление профиля: «Отмена» возвращает к исходной кнопке без удаления', async () => {
  const root = await renderScreen({ registry: BASE_REGISTRY, jobs: [86.8] });
  await click(buttonWith(deleteCardOf(root), 'Удалить профиль'));
  await click(buttonWith(deleteCardOf(root), 'Отмена'));

  assert.ok(buttonWith(deleteCardOf(root), 'Удалить профиль'), 'кнопка запроса подтверждения не вернулась');
  assert.equal((await queue.listJobs()).length, 1, 'отмена всё равно удалила задание');
  assert.equal(store.getActiveAccount(), ACCOUNT, 'отмена всё равно разлогинила профиль');
});

await step('T34 verify: подтверждение удаляет задания профиля, реестр, локальный кэш и переходит на #/login', async () => {
  const root = await renderScreen({ registry: BASE_REGISTRY, jobs: [86.8, 87.4] });
  store.setAccountIndexCache(ACCOUNT, { totals: 'cached' });
  globalThis.location.hash = '#/settings-test';

  await click(buttonWith(deleteCardOf(root), 'Удалить профиль'));
  await click(buttonWith(deleteCardOf(root), 'Удалить навсегда'));

  assert.deepEqual(await queue.listJobs(), [], 'задания профиля не были удалены из очереди');
  const puts = putCalls('accounts.json');
  assert.equal(puts.length, 1, 'ожидался ровно один PUT реестра');
  const written = JSON.parse(decodePutContent(puts[0]));
  assert.equal(written.accounts.some((item) => item.id === ACCOUNT), false, 'запись профиля осталась в реестре');
  assert.equal(store.getActiveAccount(), null, 'активный профиль не сброшен');
  assert.equal(store.getAccountIndexCache(ACCOUNT), null, 'локальный кэш профиля не очищен');
  assert.equal(globalThis.location.hash, '#/login', 'не случился переход на экран входа');
  assert.ok(toasts().some((text) => text === 'Профиль удалён.'), toasts().join(' | '));
});

await step('удаление профиля: задания другого профиля в очереди не трогаются', async () => {
  const root = await renderScreen({ registry: BASE_REGISTRY, jobs: [86.8] });
  await queue.enqueue({ path: 'accounts/other/data/2026-08-14.json', content: sessionText(50), message: 'чужой профиль' });
  await settle();

  await click(buttonWith(deleteCardOf(root), 'Удалить профиль'));
  await click(buttonWith(deleteCardOf(root), 'Удалить навсегда'));

  const remaining = await queue.listJobs();
  assert.equal(remaining.length, 1, 'задание чужого профиля тоже было удалено');
  assert.equal(remaining[0].accountId, 'other');
});

// --- Живое состояние -------------------------------------------------------

await step('очередь пополнилась со стороны — экран это показывает', async () => {
  const root = await renderScreen();
  assert.equal(jobCards(root).length, 0);

  await queue.enqueue({ path: `data/${DAY}.json`, content: sessionText(88), message: 'Сессия' });
  await settle();

  assert.equal(jobCards(root).length, 1, 'экран не увидел новое задание');
});

await step('destroy снимает слушателя очереди', async () => {
  const root = await renderScreen();
  settings.destroy();
  await queue.enqueue({ path: `data/${DAY}.json`, content: sessionText(88), message: 'Сессия' });
  await settle();

  assert.equal(jobCards(root).length, 0, 'закрытый экран продолжает перерисовываться');
});

// --- Чистые функции --------------------------------------------------------

await step('формат времени постановки — 14.08.2026, 09:12', () => {
  const when = new Date(2026, 7, 14, 9, 12);
  assert.equal(settings.formatWhen(when.toISOString()), '14.08.2026, 09:12');
  assert.equal(settings.formatWhen('ерунда'), '');
});

await step('подписи статусов — на русском и для всех трёх состояний', () => {
  assert.equal(settings.stateLabel('pending'), 'Ожидает отправки');
  assert.equal(settings.stateLabel('sending'), 'Отправляю…');
  assert.equal(settings.stateLabel('failed'), 'Не отправилось');
  assert.match(settings.stateLabel('что-то новое'), /[а-яё]/i);
});

// --- Сторожа инвариантов ----------------------------------------------------

const SOURCE = readFileSync(new URL('./screens/settings.js', import.meta.url), 'utf8');
const CODE = SOURCE.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');

await step('§0: экран не знает про localStorage, IndexedDB, innerHTML и внешние адреса', () => {
  assert.ok(!/localStorage/.test(SOURCE), 'localStorage живёт только в store.js (§3 контракта)');
  assert.ok(!/indexedDB/.test(SOURCE), 'IndexedDB живёт только в queue.js (контракт §7)');
  assert.ok(!/innerHTML|insertAdjacentHTML|document\.write/.test(SOURCE), 'разметка строкой');
  assert.ok(!/https?:\/\//.test(CODE), 'внешний адрес в коде экрана');
});

// T34 завела в экран настоящий writeFile/sha (пароль, тело, удаление
// профиля) — прежний тотальный запрет на весь файл больше не подходит.
// Сторож сузился до самих функций экспорта: loadSessions()/loadQueuedSessions()
// обязаны остаться read-only, что бы ни появилось в остальном модуле.
await step('чек-лист §10: loadSessions()/loadQueuedSessions() только читают repo B', () => {
  const loadSessionsBody = SOURCE.slice(
    SOURCE.indexOf('async function loadSessions('),
    SOURCE.indexOf('function validDate(')
  );
  const loadQueuedBody = SOURCE.slice(
    SOURCE.indexOf('async function loadQueuedSessions('),
    SOURCE.indexOf('function canonical(')
  );
  assert.ok(loadSessionsBody.length > 0 && loadQueuedBody.length > 0, 'не удалось вырезать тело функций экспорта');
  assert.ok(!/writeFile/.test(loadSessionsBody), 'loadSessions() получила путь к правке repo B');
  assert.ok(!/writeFile/.test(loadQueuedBody), 'loadQueuedSessions() получила путь к правке repo B');
  assert.ok(!/\bsha\b/i.test(`${loadSessionsBody}\n${loadQueuedBody}`), 'экспорт использует sha — признак записи');
  assert.match(CODE, /listRepoFiles\(accountDataDir\(getActiveAccount\(\)\)\)/, 'экспорт не перечисляет файлы сессий активного профиля');
  assert.match(CODE, /readFile\(file\.path\)/, 'экспорт не читает исходные сессии');
});

await step('§13 DOM: ни одно задание не спрятано', async () => {
  const root = await renderScreen({ jobs: [86.8, 87.4] });
  for (const node of walk(root)) {
    assert.equal(node.hidden, false, 'узел скрыт через hidden');
    assert.notEqual(node.getAttribute('aria-hidden'), 'true', 'узел скрыт через aria-hidden');
    assert.notEqual(node.style.display, 'none', 'узел скрыт через display');
    assert.ok(!/hidden|collapse|invisible|sr-only/i.test(node.className), `класс, прячущий узел: ${node.className}`);
  }
});

await step('CSS: каждый класс очереди описан в style.css', async () => {
  const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8');
  const classes = new Set();

  // Два прохода: с заданиями и с подтверждением удаления — вместе они дают
  // все узлы карточки очереди.
  const first = await renderScreen({ jobs: [86.8], put: { kind: 'offline' } });
  await click(sendButton(first));
  const second = await renderScreen({ jobs: [86.8] });
  await click(buttonWith(second, 'Удалить'));
  const third = await renderScreen();

  for (const root of [first, second, third]) {
    for (const node of [root, ...walk(root)]) {
      for (const name of String(node.className).split(/\s+/)) {
        if (name.startsWith('queue-')) classes.add(name);
      }
    }
  }

  assert.ok(classes.size >= 7, `классов очереди нашлось только ${classes.size}`);
  for (const name of classes) {
    assert.ok(css.includes(`.${name}`), `класс .${name} не описан в style.css`);
  }
});

console.log(`Итог: ${passed} ок, ${failed} провалено.`);
process.exitCode = failed === 0 ? 0 : 1;
