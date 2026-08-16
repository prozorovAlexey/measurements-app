// Автотест экрана настроек в объёме T6 (§7.4 спеки): состояние офлайн-очереди
// и кнопка «отправить сейчас». PAT, счётчик открытий и экспорт — задача T8,
// их здесь нет.
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

const storage = new Map();

globalThis.localStorage = {
  getItem: (key) => (storage.has(String(key)) ? storage.get(String(key)) : null),
  setItem: (key, value) => { storage.set(String(key), String(value)); },
  removeItem: (key) => { storage.delete(String(key)); }
};

// ===== Заглушка сети ======================================================

const TOKEN = 'ghp_fixture';
const DAY = '2026-08-14';

const calls = [];
let putReply = { kind: 'ok' };

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
  return jsonReply([]);
};

const settings = await import('./screens/settings.js');
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
  return JSON.stringify({ date: DAY, time: '09:12', entries: [{ key: 'waist_who', value }] }, null, 2);
}

async function renderScreen(options = {}) {
  const { jobs = [], put = { kind: 'ok' }, token = TOKEN } = options;

  settings.destroy();
  for (const job of await queue.listJobs()) await queue.removeJob(job.id);
  storage.clear();
  calls.length = 0;
  toastHost.replaceChildren();
  putReply = put;
  if (token) storage.set(store.KEYS.token, token);

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

await step('чек-лист §10: экран не пишет и не читает файлы сессий сам', () => {
  assert.ok(!/writeFile|readFile/.test(CODE), 'экран настроек полез в repo B мимо очереди');
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
