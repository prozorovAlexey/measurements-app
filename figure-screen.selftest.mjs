// Самопроверка T12: read-only экран «Фигура», профиль и сторожа инвариантов.
//
// Запуск:
//   C:\Users\user\AppData\Roaming\nvm\v24.4.0\node.exe figure-screen.selftest.mjs
//
// Только stdlib. Мини-DOM проверяет итоговое дерево, а не детали реализации.

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ===== Мини-DOM ===========================================================

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
    if (!node.parentNode) return;
    node.parentNode.children = node.parentNode.children.filter((child) => child !== node);
    node.parentNode = null;
  };

  node.setAttribute = (name, value) => {
    node.attributes.set(name, String(value));
    if (name === 'class') node.className = value;
  };
  node.getAttribute = (name) => (node.attributes.has(name) ? node.attributes.get(name) : null);
  node.removeAttribute = (name) => { node.attributes.delete(name); };
  node.addEventListener = (type, handler) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(handler);
  };
  node.removeEventListener = (type, handler) => {
    listeners.set(type, (listeners.get(type) ?? []).filter((item) => item !== handler));
  };
  node.dispatch = (type, init = {}) => {
    for (const handler of (listeners.get(type) ?? []).slice()) {
      handler({
        type,
        target: node,
        currentTarget: node,
        preventDefault() {},
        ...init
      });
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
    windowListeners.set(
      type,
      (windowListeners.get(type) ?? []).filter((item) => item !== handler)
    );
  }
};

function dispatchWindow(type, init = {}) {
  for (const handler of (windowListeners.get(type) ?? []).slice()) {
    handler({ type, preventDefault() {}, ...init });
  }
}
globalThis.document = {
  createElement,
  createElementNS: (namespace, tag) => createElement(tag),
  getElementById: (id) => (id === 'header-status' ? headerStatus : null),
  querySelectorAll: () => []
};
globalThis.location = { hash: '#/' };

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => (storage.has(String(key)) ? storage.get(String(key)) : null),
  setItem: (key, value) => { storage.set(String(key), String(value)); },
  removeItem: (key) => { storage.delete(String(key)); }
};

const CATALOG_PATH = new URL('./catalog.json', import.meta.url);
const CATALOG_RAW = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
let githubReply = { latest: {}, series: {} };
let catalogBroken = false;
let catalogFetchCalls = 0;
let githubFetchCalls = 0;
let catalogGate = null;

function catalogResponse() {
  return { ok: true, status: 200, json: async () => CATALOG_RAW };
}

globalThis.fetch = async (url) => {
  if (!String(url).includes('api.github.com')) {
    catalogFetchCalls += 1;
    if (catalogGate) {
      return new Promise((resolve, reject) => {
        catalogGate.resolve = () => resolve(catalogResponse());
        catalogGate.reject = reject;
      });
    }
    if (catalogBroken) throw new TypeError('каталог недоступен (заглушка теста)');
    return catalogResponse();
  }
  githubFetchCalls += 1;
  const payload = {
    type: 'file',
    encoding: 'base64',
    content: Buffer.from(JSON.stringify(githubReply), 'utf8').toString('base64'),
    sha: 'fixture-sha'
  };
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(payload)
  };
};

const figureScreen = await import('./screens/figure.js');
const catalog = await import('./catalog.js');
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

async function flush() {
  for (let index = 0; index < 3; index += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  }
}

const FULL_INDEX = {
  generated_at: '2026-08-19T12:00:00Z',
  latest: {},
  series: {
    weight: [
      { date: '2026-08-01', value: 80, protocol_version: 1 },
      { date: '2026-08-19', value: 79.7, protocol_version: 1 }
    ],
    height: [{ date: '2026-01-01', value: 180, protocol_version: 1 }],
    chest: [{ date: '2026-01-01', value: 100, protocol_version: 1 }],
    waist_who: [
      { date: '2026-08-01', value: 90, protocol_version: 1 },
      { date: '2026-08-19', value: 87, protocol_version: 1 }
    ],
    hip: [{ date: '2026-08-19', value: 100, protocol_version: 1 }]
  }
};

const EMPTY_INDEX = { generated_at: '2026-08-19T12:00:00Z', latest: {}, series: {} };

async function renderScreen(index, profile = null) {
  figureScreen.destroy();
  storage.clear();
  storage.set(store.KEYS.token, 'github_pat_fixture');
  storage.set(store.KEYS.index, JSON.stringify({
    data: index,
    fetchedAt: '2026-08-19T12:00:00Z'
  }));
  if (profile) storage.set(store.KEYS.profile, JSON.stringify(profile));
  githubReply = index;
  const root = createElement('main');
  root.className = 'screen';
  await figureScreen.render(root, {});
  await flush();
  return root;
}

console.log('Самопроверка T12: screens/figure.js + профиль + сторожа');

await step('store: профиль по умолчанию мужской, женский сохраняется', () => {
  storage.clear();
  assert.deepEqual(store.getProfile(), { sex: 'male' });
  assert.deepEqual(store.setProfile({ sex: 'female' }), { sex: 'female' });
  assert.deepEqual(store.getProfile(), { sex: 'female' });
  assert.equal(JSON.parse(storage.get(store.KEYS.profile)).sex, 'female');
  assert.deepEqual(store.setProfile({ sex: 'unknown' }), { sex: 'male' });
});

await step('cache-first: полный DOM виден до завершения catalog fetch', async () => {
  figureScreen.destroy();
  storage.clear();
  storage.set(store.KEYS.token, 'github_pat_fixture');
  storage.set(store.KEYS.index, JSON.stringify({
    data: FULL_INDEX,
    fetchedAt: '2026-08-19T12:00:00Z'
  }));
  storage.set(store.KEYS.catalog, JSON.stringify({
    data: CATALOG_RAW,
    fetchedAt: '2026-08-19T12:00:00Z'
  }));
  githubReply = FULL_INDEX;
  catalogBroken = false;
  catalogGate = {};
  const githubBefore = githubFetchCalls;
  const pendingCatalogFailure = assert.rejects(
    catalog.loadCatalog(),
    /Каталог замеров не загрузился/
  );
  assert.equal(
    typeof catalogGate.reject,
    'function',
    'другой экран уже начал сетевую загрузку каталога'
  );

  const root = createElement('main');
  await figureScreen.render(root, {});
  assert.equal(byClass(root, 'mrow').length, 15, 'строки уже взяты из двух кэшей');
  assert.equal(byClass(root, 'kpi').length, 3, 'KPI уже отрисованы');
  assert.equal(byClass(root, 'fig-body').length, 1, 'SVG уже отрисован');
  assert.equal(githubFetchCalls, githubBefore, 'GitHub GET ещё не стартовал');

  const weightA = catalog.getMeasurement('weight');
  const versionA = catalog.protocolVersion();
  const rawB = JSON.parse(JSON.stringify(CATALOG_RAW));
  rawB.protocol_version = versionA + 1;
  rawB.measurements.find((item) => item.key === 'weight').label = 'Вес B во время pending';
  storage.set(store.KEYS.catalog, JSON.stringify({
    data: rawB,
    fetchedAt: '2026-08-19T12:01:00Z'
  }));
  const duringPending = catalog.loadCachedCatalog();
  assert.equal(duringPending.length, 22);
  assert.equal(duringPending.find((item) => item.key === 'weight'), weightA);
  assert.equal(catalog.getMeasurement('weight'), weightA, 'pending не дал применить B');
  assert.equal(catalog.protocolVersion(), versionA, 'pending сохранил protocolVersion A');

  // После доказательства pre-resolve убираем fallback и завершаем зависший
  // fetch ошибкой: pending catalog.js сбросится для следующих lifecycle-тестов.
  storage.delete(store.KEYS.catalog);
  const gate = catalogGate;
  catalogGate = null;
  gate.reject(new TypeError('контролируемый обрыв catalog fetch'));
  await pendingCatalogFailure;
  await flush();
  assert.equal(byClass(root, 'mrow').length, 15, 'уже показанный кэш не стёрт ошибкой');
  assert.equal(headerStatus.textContent, 'Из кэша');
  figureScreen.destroy();
});

await step('lifecycle: ранний destroy снимает class и online-listener', async () => {
  figureScreen.destroy();
  storage.clear();
  storage.set(store.KEYS.token, 'github_pat_fixture');
  storage.set(store.KEYS.index, JSON.stringify({
    data: FULL_INDEX,
    fetchedAt: '2026-08-19T12:00:00Z'
  }));
  catalogBroken = true;

  const onlineBefore = (windowListeners.get('online') ?? []).length;
  const root = createElement('main');
  const rendering = figureScreen.render(root, {});
  assert.ok(root.classList.contains('figure-screen'), 'class ставится при монтировании');
  assert.equal((windowListeners.get('online') ?? []).length, onlineBefore + 1);

  figureScreen.destroy();
  assert.equal(root.classList.contains('figure-screen'), false, 'destroy снял class до ответа каталога');
  assert.equal((windowListeners.get('online') ?? []).length, onlineBefore);
  await rendering;
  await flush();
});

await step('lifecycle: после ошибки каталога online повторяет полный старт', async () => {
  storage.clear();
  storage.set(store.KEYS.token, 'github_pat_fixture');
  storage.set(store.KEYS.index, JSON.stringify({
    data: FULL_INDEX,
    fetchedAt: '2026-08-19T12:00:00Z'
  }));
  githubReply = FULL_INDEX;
  catalogBroken = true;

  const root = createElement('main');
  await figureScreen.render(root, {});
  await flush();
  assert.equal(byClass(root, 'mrow').length, 0, 'без каталога строки не выдумываются');
  assert.equal(firstByClass(root, 'fig-loading').children[0].textContent, 'Каталог недоступен');
  assert.notEqual(headerStatus.textContent, 'Из кэша');
  assert.ok(headerStatus.classList.contains('status--error'));
  const failedCalls = catalogFetchCalls;

  catalogBroken = false;
  dispatchWindow('online');
  await flush();
  assert.equal(catalogFetchCalls, failedCalls + 1, 'online повторил загрузку каталога');
  assert.equal(byClass(root, 'mrow').length, 15, 'кэш дорисован после восстановления каталога');
  figureScreen.destroy();
  assert.equal(root.classList.contains('figure-screen'), false);
});

await step('T12 DOM: список содержит ровно 15 строк в четырёх группах', async () => {
  const root = await renderScreen(FULL_INDEX);
  assert.equal(byClass(root, 'mgroup').length, 4);
  assert.equal(byClass(root, 'mrow').length, 15);
  assert.deepEqual(
    byClass(root, 'mrow').map((row) => row.dataset.key),
    [
      'weight', 'height',
      'neck', 'shoulder_width', 'chest', 'waist_who', 'pelvis', 'hip',
      'biceps_relaxed', 'forearm', 'wrist', 'finger_index',
      'thigh', 'calf', 'foot_length'
    ]
  );
});

await step('T12 DOM: неизмеренное — прочерк и «не измерено», без размера', async () => {
  const root = await renderScreen(FULL_INDEX);
  const neck = byClass(root, 'mrow').find((row) => row.dataset.key === 'neck');
  assert.ok(neck);
  assert.equal(firstByClass(neck, 'mrow__amount').textContent, '—');
  assert.equal(firstByClass(neck, 'mrow__when').textContent, 'не измерено');
  assert.equal(byClass(neck, 'mrow__size').length, 0);
  assert.doesNotMatch(walk(neck).map((node) => node.textContent).join(' '), /\b(?:EU|UA|L|XL)\b/);

  const missingGuides = byClass(root, 'fig-guide--missing');
  assert.ok(missingGuides.length > 0);
  for (const guide of missingGuides) {
    assert.ok(walk(guide).some((node) => node.textContent === '—'));
  }
});

await step('T12 DOM: устаревший замер остаётся полноразмерным', async () => {
  const root = await renderScreen(FULL_INDEX);
  const chest = byClass(root, 'mrow').find((row) => row.dataset.key === 'chest');
  assert.equal(firstByClass(chest, 'mrow__amount').textContent, '100 см');
  assert.equal(firstByClass(chest, 'mrow__amount').className, 'mrow__amount');
  assert.ok(firstByClass(chest, 'mrow__when').classList.contains('mrow__when--stale'));
  assert.equal(chest.hidden, false);
});

await step('T12 DOM: Δ внутри мёртвой зоны получает только flat-тон', async () => {
  const root = await renderScreen(FULL_INDEX);
  const weight = byClass(root, 'mrow').find((row) => row.dataset.key === 'weight');
  const change = firstByClass(weight, 'mrow__delta');
  assert.ok(change, 'дельта веса не показана');
  assert.equal(change.textContent, '−0,3 кг');
  assert.ok(change.classList.contains('delta--flat'));
  assert.equal(change.classList.contains('delta--up'), false);
  assert.equal(change.classList.contains('delta--down'), false);

  const waist = byClass(root, 'mrow').find((row) => row.dataset.key === 'waist_who');
  assert.ok(firstByClass(waist, 'mrow__delta').classList.contains('delta--up'));
});

await step('T12 DOM: девять выносок, SVG использует классы палитры', async () => {
  const root = await renderScreen(FULL_INDEX);
  assert.equal(byClass(root, 'fig-guide').length, 9);
  assert.equal(byClass(root, 'fig-body').length, 1);
  const body = firstByClass(root, 'fig-body');
  assert.ok(body.getAttribute('d')?.startsWith('M '));
  assert.equal(body.getAttribute('fill'), null, 'цвет не должен быть литералом в SVG');
  assert.equal(body.getAttribute('stroke'), null, 'цвет не должен быть литералом в SVG');
});

await step('подробности веса: клик открывает годовой график и показывает изменение', async () => {
  const root = await renderScreen(FULL_INDEX);
  const weight = byClass(root, 'kpi--weight')[0];
  assert.equal(weight.getAttribute('role'), 'button');
  assert.equal(weight.getAttribute('aria-haspopup'), 'dialog');
  weight.dispatch('click');

  const detail = firstByClass(root, 'metric-detail--weight');
  assert.ok(detail, 'окно веса не открылось');
  assert.equal(detail.getAttribute('role'), 'dialog');
  assert.equal(firstByClass(detail, 'metric-detail__title').textContent, 'Вес за 12 месяцев');
  assert.equal(byClass(detail, 'sparkline__line').length, 1);
  assert.match(firstByClass(detail, 'metric-detail__change').textContent, /−0,3 кг за период/);
  assert.match(firstByClass(detail, 'metric-detail__note').textContent, /2 замера/);
});

await step('подробности ИМТ: Enter открывает диапазоны и персональный вес для роста', async () => {
  const root = await renderScreen(FULL_INDEX);
  const bmi = byClass(root, 'kpi--bmi')[0];
  bmi.dispatch('keydown', { key: 'Enter' });

  const detail = firstByClass(root, 'metric-detail--bmi');
  assert.ok(detail, 'окно ИМТ не открылось с клавиатуры');
  assert.equal(byClass(detail, 'metric-range').length, 4);
  assert.equal(firstByClass(detail, 'metric-range__marker').textContent, 'Ваш ИМТ 24,6');
  assert.match(firstByClass(detail, 'metric-detail__personal').textContent, /59,9–80,7 кг/);

  dispatchWindow('keydown', { key: 'Escape' });
  assert.equal(byClass(root, 'metric-detail').length, 0, 'Escape не закрыл окно');
});

await step('подробности WHR: порог зависит от пола и пересчитан в сантиметры талии', async () => {
  const root = await renderScreen(FULL_INDEX);
  byClass(root, 'kpi--whr')[0].dispatch('click');

  const detail = firstByClass(root, 'metric-detail--whr');
  assert.ok(detail, 'окно WHR не открылось');
  assert.match(firstByClass(detail, 'metric-detail__eyebrow').textContent, /мужского профиля/);
  assert.equal(firstByClass(detail, 'metric-range__marker').textContent, 'Ваш WHR 0,87');
  assert.match(firstByClass(detail, 'metric-detail__personal').textContent, /порог соответствует талии 90 см/);
  assert.match(firstByClass(detail, 'metric-detail__personal').textContent, /на 3 см ниже порога/);
});

await step('подробности WHR: женский профиль использует порог 0,85', async () => {
  const root = await renderScreen(FULL_INDEX, { sex: 'female' });
  byClass(root, 'kpi--whr')[0].dispatch('click');

  const detail = firstByClass(root, 'metric-detail--whr');
  assert.match(firstByClass(detail, 'metric-detail__eyebrow').textContent, /женского профиля/);
  assert.equal(firstByClass(detail, 'metric-range__marker').textContent, 'Ваш WHR 0,87');
  assert.match(firstByClass(detail, 'metric-range--current').children[1].textContent, /≥ 0,85/);
  assert.match(firstByClass(detail, 'metric-detail__personal').textContent, /порог соответствует талии 85 см/);
  assert.match(firstByClass(detail, 'metric-detail__personal').textContent, /на 2 см выше порога/);
});

await step('T12 DOM: пустой индекс показывает empty-state, силуэт и 15 прочерков', async () => {
  const root = await renderScreen(EMPTY_INDEX);
  assert.equal(byClass(root, 'fig-empty').length, 1);
  assert.equal(byClass(root, 'fig-card--empty').length, 1);
  assert.equal(byClass(root, 'fig-body').length, 1);
  assert.equal(byClass(root, 'mrow').length, 15);
  assert.equal(byClass(root, 'mrow__amount').filter((node) => node.textContent === '—').length, 15);
  assert.equal(byClass(root, 'fig-dates').length, 0);
});

await step('T15: «#/» — «Фигура» по умолчанию, таббар трёхвкладочный', () => {
  const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(app, /parts\.length === 0[^\n]+name: 'figure'/);
  assert.doesNotMatch(app, /name: 'cheatsheet'/, 'шпаргалка удалена вместе с T15');
  assert.match(html, /href="#\/"\s+data-tab="figure"/);
  assert.match(html, /href="#\/sizes"\s+data-tab="sizes"/);
  assert.doesNotMatch(html, /data-tab="cheatsheet"|data-tab="entry"|data-tab="history"/, 'в таббаре T15 остаются только Фигура, Размеры, Настройки');
  const subtabs = figureScreen.figureSubtabs('figure');
  assert.equal(subtabs.children.length, 2);
  assert.equal(subtabs.children[0].href, '#/');
  assert.ok(subtabs.children[0].classList.contains('subtabs__item--active'));
  assert.equal(subtabs.children[1].href, '#/compare');
  assert.equal(subtabs.children[1].classList.contains('subtabs__item--active'), false);
});

await step('T16: под-вкладка «Сравнение» подсвечивается своим активным маршрутом', () => {
  const subtabs = figureScreen.figureSubtabs('compare');
  assert.equal(subtabs.children[0].classList.contains('subtabs__item--active'), false);
  assert.ok(subtabs.children[1].classList.contains('subtabs__item--active'));
  assert.equal(subtabs.children[1].getAttribute('aria-current'), 'page');
});

await step('сторож: экран read-only и окрашивает Δ только результатом asof.delta()', () => {
  const source = readFileSync(new URL('./screens/figure.js', import.meta.url), 'utf8');
  // T13/T14 добавили шторку быстрого ввода — экран больше не read-only
  // в буквальном смысле, но по-прежнему не трогает GitHub API напрямую:
  // запись идёт только через enqueueEntry() из queue.js (T14, склейка дня).
  assert.doesNotMatch(source, /\b(?:writeFile|listFiles)\b/);
  assert.match(source, /import \{ delta, sliceAt, sliceDates \} from '\.\.\/asof\.js'/);
  assert.equal((source.match(/\bdelta\s*\(/g) ?? []).length, 1, 'ровно один вызов asof.delta()');
  assert.equal((source.match(/change\.tone/g) ?? []).length, 1, 'тон класса берётся из delta().tone');
  assert.doesNotMatch(source, /\btone\s*:/, 'экран не конструирует tone вручную');
  const changeFor = /function changeFor\([^)]*\) \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? '';
  assert.match(changeFor, /const previous = before \?[^;]+: null;/);
  assert.match(changeFor, /return delta\(previous, current, entry\);/);
  assert.doesNotMatch(changeFor, /return\s*\{/);

  const renderBlock = source.slice(
    source.indexOf('export async function render'),
    source.indexOf('export function destroy')
  );
  const cacheAt = renderBlock.indexOf('getIndexCache()');
  const catalogCacheAt = renderBlock.indexOf('loadCachedCatalog()');
  const classAt = renderBlock.indexOf("root.classList.add('figure-screen')");
  const listenerAt = renderBlock.indexOf("window.addEventListener('online', handleOnline)");
  const loadAt = renderBlock.indexOf('void loadScreenData(token)');
  assert.ok(cacheAt >= 0 && cacheAt < classAt, 'кэш читается до class и монтирования');
  assert.ok(catalogCacheAt >= 0 && catalogCacheAt < classAt, 'catalog cache гидрирован до class');
  assert.ok(cacheAt < loadAt, 'кэш читается до запуска загрузки');
  assert.ok(listenerAt >= 0 && listenerAt < loadAt, 'online-listener стоит до первой загрузки');

  const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8');
  const flat = /\.delta--flat\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(flat, /color:\s*var\(--muted\)/);
  assert.doesNotMatch(flat, /--ok|--danger|--accent/);
});

await step('сторож: шаблон не попал в отгружаемые файлы приложения', () => {
  const root = fileURLToPath(new URL('.', import.meta.url));
  const allowed = new Set(['.html', '.css', '.js', '.mjs', '.json']);
  const pending = [root];
  const texts = [];
  while (pending.length > 0) {
    const dir = pending.pop();
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (item.name === '.git') continue;
      const path = join(dir, item.name);
      if (item.isDirectory()) pending.push(path);
      else if (allowed.has(extname(item.name))) texts.push(readFileSync(path, 'utf8'));
    }
  }
  const templateFolder = ['main', 'page', 'design', 'template'].join('-');
  assert.equal(texts.join('\n').toLowerCase().includes(templateFolder), false);
});

figureScreen.destroy();
console.log(`Итог: ${passed} ок, ${failed} провалено.`);
process.exitCode = failed === 0 ? 0 : 1;
