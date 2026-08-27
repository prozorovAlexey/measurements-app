// Автотест экрана входа (T31, §17 контракта): клиентская валидация до сети,
// чтение accounts.json с офлайн-откатом на bm.accounts_cache, вход по
// известному логину (верный/неверный пароль) и регистрация неизвестного —
// с явным подтверждением и повтором записи при 409-конфликте.
//
// Запуск (node на PATH — v6.17.1, ES-модулей не понимает, §12 контракта):
//
//   C:\Users\user\AppData\Roaming\nvm\v24.4.0\node.exe login.selftest.mjs
//
// Только stdlib: ни npm-пакетов, ни тест-раннера, ни jsdom (§0 контракта).
//
// screens/login.js статически импортирует ../app.js (как и остальные экраны,
// §13 контракта, приём T4), поэтому мини-DOM ниже — тот же набор заглушек,
// что в entry.selftest.mjs/history.selftest.mjs: #app отдаётся как null,
// монтирование внутри app.js обрывается на первой же операции с DOM,
// исключение там перехвачено.
//
// Важная деталь именно для этого экрана: успешный вход зовёт настоящий
// navigate('#/') из app.js. Если location.hash к этому моменту УЖЕ равен
// '#/', navigate() решает, что это тот же хэш, и вызывает настоящий
// router()/mount() — со случайным экраном фигуры поверх null-root'а.
// Поэтому location.hash перед каждым шагом выставляется в '#/login'
// (не '#/'): тогда navigate('#/') просто присваивает новый хэш и не трогает
// роутер — тот же приём, что держит entry.selftest.mjs (сбрасывает хэш
// в '#/entry' перед каждым рендером).

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

// ===== Мини-DOM (как в entry.selftest.mjs) ================================

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

  return node;
}

function walk(node, out = []) {
  for (const child of node.children) {
    out.push(child);
    walk(child, out);
  }
  return out;
}

function byClass(root, className) {
  return walk(root).filter((node) => node.classList.contains(className));
}

function inputsIn(node) {
  return walk(node).filter((item) => item.tagName === 'INPUT');
}

function textOf(node) {
  return [node, ...walk(node)].map((item) => item.textContent).filter(Boolean).join(' ');
}

// ===== Заглушки браузера ===================================================

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
// '#/unknown' — намеренно непонятный роуту хэш: единственный module-load-time
// вызов router() (внутри app.js, в самом низу файла) должен уйти в ветку
// «неизвестный хэш» и остановиться на простом присваивании location.hash,
// не дойдя ни до гейта входа, ни тем более до mount() (см. комментарий вверху
// файла и историю в history.selftest.mjs — тот же приём).
globalThis.location = { hash: '#/unknown' };

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => (storage.has(String(key)) ? storage.get(String(key)) : null),
  setItem: (key, value) => { storage.set(String(key), String(value)); },
  removeItem: (key) => { storage.delete(String(key)); }
};

// ===== Заглушка сети =======================================================
// Единственный хост — api.github.com (§0 контракта). catalog.js экран входа
// не трогает вовсе, поэтому любой другой запрос — ошибка теста.

let offline = false;
let registryNotFound = false;
let serverRegistry = { version: 1, accounts: [] };
let registryGetCount = 0;
let registryPutAttempts = 0;
let conflictOnFirstPut = false;
let racedAccount = null;
let profileReplyKind = 'not-found'; // 'not-found' | 'data'
let profileData = null;

const githubCalls = [];

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

function fileEnvelope(data, sha) {
  return {
    type: 'file',
    encoding: 'base64',
    content: Buffer.from(JSON.stringify(data), 'utf8').toString('base64'),
    sha
  };
}

globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  assert.ok(target.includes('api.github.com'), `неожиданный внешний запрос: ${target}`);

  const method = String(init.method ?? 'GET').toUpperCase();
  const path = decodeURIComponent(new URL(target).pathname.split('/contents/')[1] ?? '');
  githubCalls.push({ method, path, body: typeof init.body === 'string' ? JSON.parse(init.body) : null });

  if (offline) throw new TypeError('сети нет (заглушка теста)');

  if (path === 'accounts.json') {
    if (method === 'GET') {
      registryGetCount += 1;
      if (registryNotFound) return failureReply(404, '');
      return jsonReply(fileEnvelope(serverRegistry, `reg-sha-${registryGetCount}`));
    }
    if (method === 'PUT') {
      registryPutAttempts += 1;
      if (conflictOnFirstPut && registryPutAttempts === 1) {
        // Гонка: кто-то другой зарегистрировался между нашим чтением и
        // записью — «сервер» получает эту запись прямо сейчас, до повтора.
        if (racedAccount) {
          serverRegistry = { version: 1, accounts: [...serverRegistry.accounts, racedAccount] };
        }
        return failureReply(409, JSON.stringify({ message: 'sha does not match' }));
      }
      const written = JSON.parse(init.body);
      serverRegistry = JSON.parse(Buffer.from(written.content, 'base64').toString('utf8'));
      return jsonReply({ content: { sha: 'reg-sha-new', path }, commit: { sha: 'commit-sha' } });
    }
  }

  if (path.startsWith('accounts/') && path.endsWith('/profile.json')) {
    if (method === 'GET') {
      if (profileReplyKind === 'not-found') return failureReply(404, '');
      return jsonReply(fileEnvelope(profileData, 'profile-sha'));
    }
    if (method === 'PUT') {
      return jsonReply({ content: { sha: 'profile-sha-new', path }, commit: { sha: 'commit-sha-2' } });
    }
  }

  throw new Error(`неожиданный запрос к GitHub: ${method} ${path}`);
};

// ===== Загрузка модулей (после всех заглушек, как в history.selftest.mjs) ===

const login = await import('./screens/login.js');
const accounts = await import('./accounts.js');
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

// ===== Фикстуры =============================================================

const TANYA_PASSWORD = 'Qwe123';
const tanyaHash = await accounts.hashPassword(TANYA_PASSWORD);
const TANYA_ACCOUNT = { id: 'tanya', label: 'Tanya', salt: tanyaHash.salt, hash: tanyaHash.hash, createdAt: '2026-08-20' };
const BASE_REGISTRY = { version: 1, accounts: [TANYA_ACCOUNT] };

// ===== Рендер с чистого листа ===============================================

async function settle() {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => { setTimeout(resolve, 0); });
}

async function renderLogin(options = {}) {
  const {
    registry = BASE_REGISTRY,
    registryIsNotFound = false,
    isOffline = false,
    conflict = false,
    racedAccountRecord = null,
    profileKind = 'not-found',
    profileBody = null,
    token = 'github_pat_fixture',
    lastLogin = null,
    accountsCache = null
  } = options;

  login.destroy();
  storage.clear();
  githubCalls.length = 0;
  toastHost.replaceChildren();
  registryGetCount = 0;
  registryPutAttempts = 0;
  offline = isOffline;
  registryNotFound = registryIsNotFound;
  serverRegistry = registry;
  conflictOnFirstPut = conflict;
  racedAccount = racedAccountRecord;
  profileReplyKind = profileKind;
  profileData = profileBody;

  // См. комментарий вверху файла: не '#/', чтобы navigate('#/') на успехе
  // не дёрнул настоящий router()/mount().
  globalThis.location.hash = '#/login';

  if (token) storage.set(store.KEYS.token, token);
  if (lastLogin) storage.set(store.KEYS.lastLogin, lastLogin);
  if (accountsCache) {
    storage.set(store.KEYS.accountsCache, JSON.stringify({ data: accountsCache, fetchedAt: '2026-08-20T00:00:00.000Z' }));
  }

  const root = createElement('div');
  await login.render(root, {});
  return root;
}

// ===== Запросы к дереву ======================================================

function loginInputOf(root) {
  return walk(root).find((node) => node.tagName === 'INPUT' && node.dataset.field === 'login');
}

function passwordInputOf(root) {
  return walk(root).find((node) => node.tagName === 'INPUT' && node.dataset.field === 'password');
}

function submitButtonOf(root) {
  return byClass(root, 'login-submit')[0];
}

function messagesTextOf(root) {
  const box = byClass(root, 'login-messages')[0];
  return box ? box.children.map((node) => node.textContent).join(' | ') : '';
}

function createCardOf(root) {
  return byClass(root, 'login-create')[0] ?? null;
}

function confirmButtonOf(card) {
  return byClass(card, 'login-create__confirm')[0];
}

function cancelButtonOf(card) {
  return byClass(card, 'login-create__cancel')[0];
}

function sexRadiosOf(card) {
  const group = byClass(card, 'login-sex__group')[0];
  return group ? inputsIn(group) : [];
}

function typeInto(input, value) {
  input.value = value;
  input.dispatch('input');
}

async function clickButton(button) {
  button.dispatch('click');
  await settle();
}

async function clickSubmit(root) {
  await clickButton(submitButtonOf(root));
}

function decodePutContent(call) {
  return Buffer.from(call.body.content, 'base64').toString('utf8');
}

function putCalls(path) {
  return githubCalls.filter((call) => call.method === 'PUT' && call.path === path);
}

function getCalls(path) {
  return githubCalls.filter((call) => call.method === 'GET' && call.path === path);
}

console.log('Самопроверка T31: screens/login.js');

// --- Контракт экрана --------------------------------------------------------

await step('контракт §2: title, render, destroy', () => {
  assert.equal(login.title, 'Вход');
  assert.equal(typeof login.render, 'function');
  assert.equal(typeof login.destroy, 'function');
});

// --- Клиентская валидация ----------------------------------------------------

await step('пустые логин и пароль — валидация без единого сетевого запроса', async () => {
  const root = await renderLogin();
  await clickSubmit(root);

  assert.equal(githubCalls.length, 0, 'валидация сходила в сеть');
  assert.match(messagesTextOf(root), /[а-яё]/i, 'сообщение об ошибке не по-русски');
  assert.equal(store.getActiveAccount(), null);
  assert.equal(createCardOf(root), null, 'экран предложил создать профиль без валидного логина');
});

// --- Неизвестный логин: подтверждение, без записи ----------------------------

await step('логина нет в реестре — предложение создать профиль, PUT не уходит', async () => {
  const root = await renderLogin({ registry: BASE_REGISTRY });
  typeInto(loginInputOf(root), 'Nova');
  typeInto(passwordInputOf(root), 'Secret1');
  await clickSubmit(root);

  assert.equal(getCalls('accounts.json').length, 1, 'реестр не был прочитан ровно один раз');
  assert.equal(githubCalls.filter((call) => call.method === 'PUT').length, 0, 'запись ушла раньше явного подтверждения');

  const card = createCardOf(root);
  assert.ok(card, 'нет карточки подтверждения создания профиля');
  assert.ok(textOf(card).includes('Nova'), 'в тексте нет введённого логина');
  assert.ok(textOf(card).includes('Создать'), 'нет вопроса про создание профиля');
  assert.equal(sexRadiosOf(card).length, 2, 'нет выбора модели тела (male/female)');
});

await step('«Это не тот логин» возвращает к форме входа без записи', async () => {
  const root = await renderLogin({ registry: BASE_REGISTRY });
  typeInto(loginInputOf(root), 'Nova');
  typeInto(passwordInputOf(root), 'Secret1');
  await clickSubmit(root);

  const card = createCardOf(root);
  await clickButton(cancelButtonOf(card));

  assert.equal(createCardOf(root), null, 'карточка подтверждения не исчезла после отмены');
  assert.equal(githubCalls.filter((call) => call.method === 'PUT').length, 0);
});

// --- Регистрация нового профиля ----------------------------------------------

await step('подтверждение создания — запись реестра и профиля, вход выполнен', async () => {
  const root = await renderLogin({ registry: { version: 1, accounts: [] } });
  typeInto(loginInputOf(root), 'Nova');
  typeInto(passwordInputOf(root), 'Secret1');
  await clickSubmit(root);

  const card = createCardOf(root);
  const [, femaleRadio] = sexRadiosOf(card);
  femaleRadio.checked = true;
  femaleRadio.dispatch('change');

  await clickButton(confirmButtonOf(card));

  const registryPuts = putCalls('accounts.json');
  assert.equal(registryPuts.length, 1, 'ожидался ровно один PUT реестра');
  const writtenRegistry = JSON.parse(decodePutContent(registryPuts[0]));
  const created = writtenRegistry.accounts.find((item) => item.id === 'nova');
  assert.ok(created, 'новой записи нет в записанном реестре');
  assert.equal(created.label, 'Nova', 'label не совпадает с введённым написанием');
  assert.ok(created.salt && created.hash, 'нет соли/хеша пароля в записи');
  assert.ok(created.createdAt, 'нет даты регистрации');

  const profilePuts = putCalls('accounts/nova/profile.json');
  assert.equal(profilePuts.length, 1, 'профиль тела не записан');
  assert.deepEqual(JSON.parse(decodePutContent(profilePuts[0])), { sex: 'female' });

  assert.equal(store.getActiveAccount(), 'nova');
  assert.equal(store.getLastLogin(), 'Nova');
  assert.equal(globalThis.location.hash, '#/', 'не случилось перехода на дефолтный экран');

  const toastTexts = toastHost.children.map((node) => node.textContent);
  assert.ok(toastTexts.some((text) => text.includes('Nova')), 'нет приветственного уведомления');
});

// --- Известный логин: пароль --------------------------------------------------

await step('верный пароль по реестру — реальный PBKDF2-round-trip, вход выполнен', async () => {
  const root = await renderLogin({ registry: BASE_REGISTRY });
  typeInto(loginInputOf(root), 'tanya'); // регистронезависимо: Tanya === tanya
  typeInto(passwordInputOf(root), TANYA_PASSWORD);
  await clickSubmit(root);

  assert.equal(store.getActiveAccount(), 'tanya');
  assert.equal(store.getLastLogin(), 'Tanya', 'в поле должен уйти label из реестра, а не введённый регистр');
  assert.equal(globalThis.location.hash, '#/');
  assert.equal(githubCalls.filter((call) => call.method === 'PUT').length, 0, 'вход не пишет в repo B');
});

await step('неверный пароль — «Неверный пароль.», входа не происходит', async () => {
  const root = await renderLogin({ registry: BASE_REGISTRY });
  typeInto(loginInputOf(root), 'tanya');
  typeInto(passwordInputOf(root), 'wrong-password');
  await clickSubmit(root);

  assert.equal(messagesTextOf(root), 'Неверный пароль.');
  assert.equal(store.getActiveAccount(), null, 'активный профиль не должен был установиться');
  assert.equal(globalThis.location.hash, '#/login', 'случился переход при неверном пароле');
  assert.equal(passwordInputOf(root).value, '', 'поле пароля должно очищаться');
  assert.equal(loginInputOf(root).value, 'tanya', 'поле логина не должно очищаться');
});

// --- Офлайн: вход по кэшу реестра --------------------------------------------

await step('T31 verify: офлайн, но реестр закэширован — вход по кэшу проходит', async () => {
  const root = await renderLogin({
    isOffline: true,
    accountsCache: BASE_REGISTRY
  });
  typeInto(loginInputOf(root), 'tanya');
  typeInto(passwordInputOf(root), TANYA_PASSWORD);
  await clickSubmit(root);

  assert.equal(store.getActiveAccount(), 'tanya', 'вход по офлайн-кэшу реестра не сработал');
  assert.equal(globalThis.location.hash, '#/');
  assert.equal(getCalls('accounts.json').length, 1, 'ожидалась ровно одна (неудавшаяся) попытка сети');
  assert.equal(messagesTextOf(root), '', 'офлайн-откат на кэш не должен показываться как ошибка');
});

await step('офлайн и без кэша — показан текст ошибки GitHub как есть', async () => {
  const root = await renderLogin({ isOffline: true });
  typeInto(loginInputOf(root), 'tanya');
  typeInto(passwordInputOf(root), TANYA_PASSWORD);
  await clickSubmit(root);

  assert.equal(store.getActiveAccount(), null);
  assert.equal(messagesTextOf(root), 'Нет сети.');
});

// --- accounts.json ещё не существует -----------------------------------------

await step('accounts.json отсутствует (404) — пустой реестр, не ошибка', async () => {
  const root = await renderLogin({ registryIsNotFound: true });
  typeInto(loginInputOf(root), 'Nova');
  typeInto(passwordInputOf(root), 'Secret1');
  await clickSubmit(root);

  assert.equal(messagesTextOf(root), '', 'отсутствие accounts.json показано как ошибка');
  const card = createCardOf(root);
  assert.ok(card, 'пустой реестр не привёл к предложению создать профиль');
});

// --- Конфликт записи реестра ---------------------------------------------------

await step('T31 verify: 409-конфликт на записи реестра — перечитывает и повторяет с объединением', async () => {
  const racedHash = await accounts.hashPassword('Other12');
  const raced = { id: 'raced', label: 'Raced', salt: racedHash.salt, hash: racedHash.hash, createdAt: '2026-08-26' };

  const root = await renderLogin({
    registry: { version: 1, accounts: [] },
    conflict: true,
    racedAccountRecord: raced
  });
  typeInto(loginInputOf(root), 'Nova');
  typeInto(passwordInputOf(root), 'Secret1');
  await clickSubmit(root);
  await clickButton(confirmButtonOf(createCardOf(root)));

  const registryPuts = putCalls('accounts.json');
  const registryGets = getCalls('accounts.json');
  assert.equal(registryPuts.length, 2, 'после конфликта не случилось повторной записи');
  assert.equal(registryGets.length, 2, 'после конфликта не случилось перечитывания реестра');

  const finalRegistry = JSON.parse(decodePutContent(registryPuts[1]));
  const ids = finalRegistry.accounts.map((item) => item.id).sort();
  assert.deepEqual(ids, ['nova', 'raced'], 'финальная запись не объединила гонку и новую регистрацию');

  assert.equal(store.getActiveAccount(), 'nova');
  assert.equal(globalThis.location.hash, '#/');
});

console.log(`Итог: ${passed} ок, ${failed} провалено.`);
process.exitCode = failed === 0 ? 0 : 1;
