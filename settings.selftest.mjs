// Автотест экрана настроек в объёме T8 (§7.4 спеки): PAT, счётчик открытий,
// JSON-экспорт, состояние офлайн-очереди и кнопка «отправить сейчас».
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

const calls = [];
let putReply = { kind: 'ok' };
const remoteFiles = new Map();

function jsonReply(payload) {
  return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(payload) };
}

globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  assert.ok(target.startsWith('https://api.github.com/'), `неожиданный хост: ${target}`);
  const method = String(init.method ?? 'GET').toUpperCase();
  const path = decodeURIComponent(new URL(target).pathname.split('/contents/')[1] ?? '');
  calls.push({ method, path });

  if (method === 'PUT') {
    if (putReply.kind === 'offline') throw new TypeError('сети нет (заглушка теста)');
    if (putReply.kind === 'status') {
      return { ok: false, status: putReply.status, headers: { get: () => null }, text: async () => '' };
    }
    return jsonReply({ content: { sha: 'sha-written', path }, commit: { sha: 'commit' } });
  }
  if (path === 'data') {
    return jsonReply(Array.from(remoteFiles, ([filePath, content]) => ({
      type: 'file',
      name: filePath.split('/').at(-1),
      path: filePath,
      sha: `sha-${filePath}`,
      size: content.length
    })));
  }
  if (remoteFiles.has(path)) {
    return jsonReply({
      type: 'file',
      encoding: 'base64',
      content: Buffer.from(remoteFiles.get(path), 'utf8').toString('base64'),
      sha: `sha-${path}`
    });
  }
  return jsonReply([]);
};

const settings = await import('./screens/settings.js');
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
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => { setTimeout(resolve, 0); });
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

async function renderScreen(options = {}) {
  const {
    jobs = [],
    opens = null,
    put = { kind: 'ok' },
    remote = [],
    token = TOKEN
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
  if (token) storage.set(store.KEYS.token, token);
  if (opens) storage.set(store.KEYS.opens, JSON.stringify(opens));
  for (const [path, content] of remote) remoteFiles.set(path, content);

  for (const value of jobs) {
    await queue.enqueue({
      path: `data/${DAY}.json`,
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

await step('T8: экспорт скачивает валидный JSON со всеми файлами сессий', async () => {
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
      ['data/2026-08-15.json', second],
      ['data/README.txt', 'не сессия'],
      [`data/${DAY}--2.json`, first],
      [`data/${DAY}.json`, first]
    ]
  });
  for (let copy = 1; copy <= 3; copy += 1) {
    await queue.enqueue({
      path: `data/${DAY}.json`,
      content: first,
      message: `дубль ${copy}`
    });
  }
  await queue.enqueue({ path: 'data/2026-08-16.json', content: pending, message: 'офлайн-сессия' });
  await queue.enqueue({ path: 'data/2026-08-17.json', content: '{битый json', message: 'мусор' });
  await queue.enqueue({ path: 'notes/task.json', content: pending, message: 'не session job' });
  await queue.enqueue({ path: 'data/2026-08-18.json', content: '{"kind":"не сессия"}', message: 'не session object' });
  await queue.enqueue({ path: 'data/2026-08-19.json', content: JSON.stringify({ ...pendingData, date: '2026-02-30' }), message: 'битая дата' });
  await queue.enqueue({ path: 'data/2026-08-20.json', content: JSON.stringify({ ...pendingData, time: '25:00' }), message: 'битое время' });
  await queue.enqueue({ path: 'data/2026-08-21.json', content: JSON.stringify({ ...pendingData, entries: [1, 2] }), message: 'не entries' });
  await queue.enqueue({ path: 'data/2026-08-22.json', content: JSON.stringify({ ...pendingData, entries: [{ ...pendingData.entries[0], key: '' }] }), message: 'нет key' });
  await queue.enqueue({ path: 'data/2026-08-23.json', content: JSON.stringify({ ...pendingData, date: [pendingData.date] }), message: 'date array' });
  await queue.enqueue({ path: 'data/2026-08-24.json', content: JSON.stringify({ ...pendingData, time: [pendingData.time] }), message: 'time array' });
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
  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`).sort(), [
    'GET data',
    `GET data/${DAY}--2.json`,
    `GET data/${DAY}.json`,
    'GET data/2026-08-15.json'
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

  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), ['GET data', `PUT data/${DAY}.json`]);
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
    [`data/${DAY}.json`, `data/${DAY}--2.json`]
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

await step('чек-лист §10: экспорт только читает repo B и не правит сессии', () => {
  assert.ok(!/writeFile/.test(CODE), 'экран настроек получил путь к правке repo B');
  assert.match(CODE, /listRepoFiles\('data'\)/, 'экспорт не перечисляет файлы сессий');
  assert.match(CODE, /readFile\(file\.path\)/, 'экспорт не читает исходные сессии');
  assert.ok(!/\bsha\b/i.test(CODE), 'в коде появилось sha');
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
