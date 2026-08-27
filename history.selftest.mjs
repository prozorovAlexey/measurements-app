// Самопроверка экрана истории T8 (§7.3 спеки).
//
//   C:\Users\user\AppData\Roaming\nvm\v24.4.0\node.exe history.selftest.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';

import { accountDataDir, accountIndexPath } from './accounts.js';

// 'alex' — уже реальный мигрированный аккаунт в data-репозитории (T29).
const ACCOUNT = 'alex';
const INDEX_PATH = accountIndexPath(ACCOUNT);
const DIR = accountDataDir(ACCOUNT);

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
  Object.defineProperty(node, 'childElementCount', { get: () => node.children.length });
  node.classList = {
    add: (...names) => { for (const name of names) if (name) classes.add(name); },
    contains: (name) => classes.has(name),
    toggle: (name, force) => {
      const active = force === undefined ? !classes.has(name) : Boolean(force);
      if (active) classes.add(name);
      else classes.delete(name);
      return active;
    }
  };
  node.append = (...children) => {
    for (const child of children) {
      child.parentNode = node;
      node.children.push(child);
    }
  };
  node.prepend = (...children) => {
    for (const child of children) child.parentNode = node;
    node.children.unshift(...children);
  };
  node.replaceChildren = (...children) => {
    node.children = [];
    node.append(...children);
  };
  node.remove = () => {};
  node.setAttribute = (name, value) => {
    node.attributes.set(name, String(value));
    if (name === 'class') node.className = value;
  };
  node.getAttribute = (name) => node.attributes.get(name) ?? null;
  node.removeAttribute = (name) => { node.attributes.delete(name); };
  node.addEventListener = (type, handler) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(handler);
  };
  return node;
}

function walk(node, result = []) {
  for (const child of node.children) {
    result.push(child);
    walk(child, result);
  }
  return result;
}

function textOf(node) {
  return [node, ...walk(node)].map((item) => item.textContent).filter(Boolean).join(' ');
}

function byClass(root, className) {
  return walk(root).filter((node) => node.classList.contains(className));
}

const appRoot = createElement('main');
const headerStatus = createElement('span');
const screenTitle = createElement('h1');
const toastHost = createElement('div');

globalThis.window = {
  addEventListener() {},
  removeEventListener() {}
};
globalThis.document = {
  readyState: 'loading',
  createElement,
  createElementNS: (_namespace, tag) => createElement(tag),
  getElementById(id) {
    if (id === 'app') return appRoot;
    if (id === 'header-status') return headerStatus;
    if (id === 'screen-title') return screenTitle;
    if (id === 'toast-host') return toastHost;
    return null;
  },
  querySelectorAll: () => []
};
globalThis.location = { hash: '#/unknown' };

const storage = new Map([['bm.token', 'github_pat_fixture'], ['bm.active_account', ACCOUNT]]);
globalThis.localStorage = {
  getItem: (key) => storage.get(String(key)) ?? null,
  setItem: (key, value) => { storage.set(String(key), String(value)); },
  removeItem: (key) => { storage.delete(String(key)); }
};

const catalog = JSON.parse(readFileSync(new URL('./catalog.json', import.meta.url), 'utf8'));
const index = {
  generated_at: '2026-08-15T09:30:00Z',
  latest: { waist_who: { date: '2026-08-15', value: 86.2, protocol_version: 2 } },
  series: {
    waist_who: [
      { date: '2026-07-01', value: 88.2, protocol_version: 1 },
      { date: '2026-08-14', value: 86.8, protocol_version: 1 },
      { date: '2026-08-15', value: 86.2, protocol_version: 2 }
    ]
  }
};
const sessions = new Map([
  ['accounts/alex/data/2026-08-14.json', JSON.stringify({
    date: '2026-08-14',
    time: '09:12',
    protocol_version: 1,
    entries: [{
      key: 'waist_who',
      raw: [86.5, 87, 86.8],
      value: 86.8,
      unit: 'cm',
      protocol_version: 1,
      note: ''
    }]
  })],
  ['accounts/alex/data/2026-08-15.json', JSON.stringify({
    date: '2026-08-15',
    time: '09:20',
    protocol_version: 2,
    entries: [{
      key: 'waist_who',
      raw: [86.2],
      value: 86.2,
      unit: 'cm',
      protocol_version: 2,
      note: 'быстрый ввод, один повтор'
    }]
  })]
]);
const calls = [];
let activeIndex = index;
let hangGitHub = false;
const unreadable = new Set();

function jsonReply(payload) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(payload)
  };
}

function fileReply(content, path) {
  return jsonReply({
    type: 'file',
    encoding: 'base64',
    content: Buffer.from(content, 'utf8').toString('base64'),
    sha: `sha-${path}`
  });
}

globalThis.fetch = async (url) => {
  if (String(url) === './catalog.json') {
    return { ok: true, json: async () => catalog };
  }
  if (hangGitHub) return new Promise(() => {});
  const target = new URL(String(url));
  const path = decodeURIComponent(target.pathname.split('/contents/')[1] ?? '');
  calls.push(path);
  if (path === INDEX_PATH) return fileReply(JSON.stringify(activeIndex), path);
  if (path === DIR) {
    return jsonReply(Array.from(sessions, ([filePath, content]) => ({
      type: 'file',
      name: filePath.split('/').at(-1),
      path: filePath,
      sha: `sha-${filePath}`,
      size: content.length
    })));
  }
  if (unreadable.has(path)) {
    return { ok: false, status: 500, headers: { get: () => null }, text: async () => '' };
  }
  if (sessions.has(path)) return fileReply(sessions.get(path), path);
  return { ok: false, status: 404, headers: { get: () => null }, text: async () => '' };
};

const history = await import('./screens/history.js');
let passed = 0;
let failed = 0;

async function step(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`✗ ${name}: ${error.message}`);
  }
}

await step('контракт экрана и таблица дата / значение / повторы / протокол', async () => {
  const root = createElement('div');
  await history.render(root, { key: 'waist_who' });
  const text = textOf(root);
  assert.equal(history.title, 'История');
  for (const heading of ['Дата', 'Значение', 'Повторы', 'Протокол']) assert.ok(text.includes(heading), text);
  assert.ok(text.includes('15.08.2026'), text);
  assert.ok(text.includes('86,5 · 87 · 86,8'), text);
  assert.ok(text.includes('быстрый ввод, один повтор'), text);
  assert.ok(text.includes('v1') && text.includes('v2'), text);
  assert.equal(byClass(root, 'history-protocol-break').length, 1);
});

await step('спарклайн разбит по версиям протокола и index закэширован', async () => {
  const root = createElement('div');
  await history.render(root, { key: 'waist_who' });
  const svg = byClass(root, 'sparkline')[0];
  assert.ok(svg, 'SVG не найден');
  assert.equal(svg.children.filter((node) => node.tagName === 'PATH').length, 2);
  // T32: кэш index.json — per-account (bm.<id>.index_cache), не общий bm.index_cache.
  const cached = JSON.parse(storage.get(`bm.${ACCOUNT}.index_cache`));
  assert.deepEqual(cached.data, index);
});

await step('cache-first: готовый спарклайн виден сразу при зависшей сети', async () => {
  storage.set(`bm.${ACCOUNT}.index_cache`, JSON.stringify({ data: index, fetchedAt: '2026-08-15T09:30:00Z' }));
  hangGitHub = true;
  const root = createElement('div');
  const pending = history.render(root, { key: 'waist_who' });
  assert.equal(byClass(root, 'sparkline').length, 1, 'кэш скрыт до первого await');
  assert.equal(headerStatus.textContent, 'Из кэша');
  history.destroy();
  hangGitHub = false;
  void pending;
});

await step('lagging index: финальный граф строится из свежих raw sessions', async () => {
  activeIndex = {
    generated_at: '2026-08-14T09:30:00Z',
    latest: { waist_who: { date: '2026-08-14', value: 86.8, protocol_version: 1 } },
    series: { waist_who: index.series.waist_who.slice(0, 2) }
  };
  const root = createElement('div');
  await history.render(root, { key: 'waist_who' });
  const svg = byClass(root, 'sparkline')[0];
  const protocols = svg.children.map((node) => node.getAttribute('data-protocol-version'));
  assert.deepEqual(protocols, ['1', '2'], 'новая session есть в таблице, но не на графике');
  assert.ok(textOf(root).includes('15.08.2026'), textOf(root));
  activeIndex = index;
});

await step('absent/invalid raw не фабрикуется из value и показывается прочерком', async () => {
  sessions.set('accounts/alex/data/2026-08-16.json', JSON.stringify({
    date: '2026-08-16',
    time: '09:20',
    protocol_version: 2,
    entries: [{ key: 'waist_who', value: 86.1, unit: 'cm', protocol_version: 2 }]
  }));
  sessions.set('accounts/alex/data/2026-08-17.json', JSON.stringify({
    date: '2026-08-17',
    time: '09:20',
    protocol_version: 2,
    entries: [{ key: 'waist_who', raw: [86, 'мусор', 86.2], value: 86.1, unit: 'cm', protocol_version: 2 }]
  }));
  const root = createElement('div');
  await history.render(root, { key: 'waist_who' });
  const repeats = byClass(root, 'history-table__reps');
  assert.deepEqual(repeats.slice(0, 2).map((node) => node.textContent), ['—', '—']);
  sessions.delete('accounts/alex/data/2026-08-16.json');
  sessions.delete('accounts/alex/data/2026-08-17.json');
});

await step('protocol_version нормализован одинаково; валидные версии не склеены', async () => {
  const fixtures = [
    ['2026-08-16', '2'],
    ['2026-08-17', 0],
    ['2026-08-18', 1.5],
    ['2026-08-19', 3]
  ];
  for (const [date, protocol] of fixtures) {
    sessions.set(`accounts/alex/data/${date}.json`, JSON.stringify({
      date,
      time: '09:20',
      protocol_version: protocol,
      entries: [{ key: 'waist_who', raw: [86], value: 86, unit: 'cm', protocol_version: protocol }]
    }));
  }
  const root = createElement('div');
  await history.render(root, { key: 'waist_who' });
  const svg = byClass(root, 'sparkline')[0];
  const protocols = svg.children.map((node) => node.getAttribute('data-protocol-version'));
  assert.ok(protocols.includes('1') && protocols.includes('2') && protocols.includes('3'), protocols.join(','));
  assert.ok(protocols.includes('?'), 'невалидные версии не сведены к unknown');
  assert.ok(!protocols.includes('0') && !protocols.includes('1.5'), protocols.join(','));
  const tableProtocols = byClass(root, 'history-table__protocol').map((node) => node.textContent);
  assert.ok(tableProtocols.filter((value) => value === 'v?').length >= 3, tableProtocols.join(','));
  assert.ok(textOf(root).includes('v?'), 'легенда использует другую нормализацию');
  for (const [date] of fixtures) sessions.delete(`accounts/alex/data/${date}.json`);
});

await step('числа форматируются вручную с запятой, без ICU', async () => {
  sessions.set('accounts/alex/data/2026-08-16.json', JSON.stringify({
    date: '2026-08-16',
    time: '09:20',
    protocol_version: 2,
    entries: [{ key: 'waist_who', raw: [86.25], value: 86.25, unit: 'cm', protocol_version: 2 }]
  }));
  const root = createElement('div');
  await history.render(root, { key: 'waist_who' });
  assert.ok(textOf(root).includes('86,25'), textOf(root));
  const source = readFileSync(new URL('./screens/history.js', import.meta.url), 'utf8');
  assert.ok(!/toLocaleString/.test(source), 'формат зависит от ICU');
  sessions.delete('accounts/alex/data/2026-08-16.json');
});

await step('битый/нечитаемый файл не уничтожает валидные строки', async () => {
  sessions.set('accounts/alex/data/2026-08-16.json', '{битый json');
  sessions.set('accounts/alex/data/2026-08-17.json', JSON.stringify({
    date: '2026-08-17',
    time: '09:20',
    entries: [{ key: 'weight', raw: [64], value: 64 }]
  }));
  sessions.set('accounts/alex/data/2026-08-18.json', JSON.stringify({
    date: '2026-08-18',
    time: '09:20',
    entries: [{ key: 'waist_who', raw: [86], value: 86 }]
  }));
  unreadable.add('accounts/alex/data/2026-08-18.json');

  const root = createElement('div');
  await history.render(root, { key: 'waist_who' });
  const text = textOf(root);
  assert.ok(text.includes('15.08.2026'), text);
  assert.ok(text.includes('Часть сессий пропущена'), text);
  assert.ok(text.includes('accounts/alex/data/2026-08-16.json'), text);
  assert.ok(text.includes('accounts/alex/data/2026-08-18.json'), text);
  assert.ok(!text.includes('accounts/alex/data/2026-08-17.json'), 'файл без выбранного key помечен ошибкой');
  assert.equal(headerStatus.textContent, 'Частичные данные');

  unreadable.clear();
  sessions.delete('accounts/alex/data/2026-08-16.json');
  sessions.delete('accounts/alex/data/2026-08-17.json');
  sessions.delete('accounts/alex/data/2026-08-18.json');
});

await step('unreadable единственный raw сохраняет index sparkline и предупреждение', async () => {
  const saved = Array.from(sessions.entries());
  sessions.clear();
  sessions.set('accounts/alex/data/2026-08-14.json', saved[0][1]);
  unreadable.add('accounts/alex/data/2026-08-14.json');
  try {
    const root = createElement('div');
    await history.render(root, { key: 'waist_who' });
    const svg = byClass(root, 'sparkline')[0];
    assert.ok(svg, 'index sparkline затёрт пустыми rows');
    assert.equal(svg.children.filter((node) => node.tagName === 'PATH').length, 2);
    assert.equal(byClass(root, 'history-table__amount').length, 0);
    assert.ok(textOf(root).includes('accounts/alex/data/2026-08-14.json'), textOf(root));
  } finally {
    unreadable.clear();
    sessions.clear();
    for (const [path, content] of saved) sessions.set(path, content);
  }
});

await step('суффиксы --N сортируются численно при одинаковых date/time', async () => {
  for (const [suffix, value] of [[2, 2], [10, 10]]) {
    sessions.set(`accounts/alex/data/2026-08-20--${suffix}.json`, JSON.stringify({
      date: '2026-08-20',
      time: '09:20',
      protocol_version: 2,
      entries: [{ key: 'waist_who', raw: [value], value, unit: 'cm', protocol_version: 2, note: '' }]
    }));
  }
  const root = createElement('div');
  await history.render(root, { key: 'waist_who' });
  assert.deepEqual(
    byClass(root, 'history-table__amount').slice(0, 2).map((node) => node.textContent),
    ['10 см', '2 см']
  );
  sessions.delete('accounts/alex/data/2026-08-20--2.json');
  sessions.delete('accounts/alex/data/2026-08-20--10.json');
});

await step('экран читает только index и исходные сессии, но ничего не пишет', () => {
  assert.ok(calls.includes(INDEX_PATH));
  assert.ok(calls.includes(DIR));
  assert.ok(calls.includes('accounts/alex/data/2026-08-14.json'));
  assert.ok(calls.includes('accounts/alex/data/2026-08-15.json'));
  const source = readFileSync(new URL('./screens/history.js', import.meta.url), 'utf8');
  assert.ok(!/writeFile|enqueue|\bsha\b/.test(source), 'история получила путь к изменению данных');
});

await step('неизвестный ключ объясняется и не запускает GitHub-запросы', async () => {
  calls.length = 0;
  const root = createElement('div');
  await history.render(root, { key: 'нет-такого' });
  assert.ok(textOf(root).includes('Замер не найден'), textOf(root));
  assert.deepEqual(calls, []);
});

await step('CSS содержит все новые классы истории', () => {
  const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8');
  for (const name of [
    'history-card__head',
    'history-chart__summary',
    'history-chart__plot',
    'history-table',
    'history-table__reps',
    'history-protocol-break',
    'sparkline__line'
  ]) {
    assert.ok(css.includes(`.${name}`), `нет .${name}`);
  }
});

await step('history CSS-классы не пересекаются с общими row/value/date/label/cheat', async () => {
  const root = createElement('div');
  await history.render(root, { key: 'waist_who' });
  const names = walk(root)
    .flatMap((node) => String(node.className).split(/\s+/))
    .filter((name) => name.startsWith('history-'));
  for (const name of names) {
    assert.ok(!/(row|value|date|label|cheat)/i.test(name), `опасный класс: ${name}`);
  }
});

history.destroy();
console.log(`Итог: ${passed} ок, ${failed} провалено.`);
process.exitCode = failed === 0 ? 0 : 1;
