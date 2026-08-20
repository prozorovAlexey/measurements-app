// Самопроверка T16: read-only экран «Сравнение», роутер, DS-токены и sw.js.
//
// Запуск:
//   C:\Users\user\AppData\Roaming\nvm\v24.4.0\node.exe compare.selftest.mjs
//
// Только stdlib. Мини-DOM проверяет итоговое дерево, как в figure-screen.selftest.mjs
// (общего test-utils модуля в проекте нет — каждый selftest самодостаточен, §13 контракта).

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';

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
  node.dispatch = (type) => {
    for (const handler of (listeners.get(type) ?? []).slice()) {
      handler({ type, target: node, currentTarget: node });
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

function byTag(root, tag) {
  return walk(root).filter((node) => node.tagName === tag.toUpperCase());
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
globalThis.location = { hash: '#/compare' };

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => (storage.has(String(key)) ? storage.get(String(key)) : null),
  setItem: (key, value) => { storage.set(String(key), String(value)); },
  removeItem: (key) => { storage.delete(String(key)); }
};

const CATALOG_PATH = new URL('./catalog.json', import.meta.url);
const CATALOG_RAW = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
// Ответ «GitHub» на чтение index.json — обязан быть тем же фикстурным
// индексом, что засеян в кэш, иначе фоновый runRefresh() молча затирает его
// пустым объектом раньше, чем тест успевает прочитать DOM.
let githubReply = { generated_at: '2026-01-01T00:00:00Z', latest: {}, series: {} };

globalThis.fetch = async (url) => {
  if (!String(url).includes('api.github.com')) {
    return { ok: true, status: 200, json: async () => CATALOG_RAW };
  }
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

const compareScreen = await import('./screens/compare.js');
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

async function flush() {
  for (let index = 0; index < 3; index += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  }
}

// Два среза, ровно две даты: «было» 2026-08-01, «стало» 2026-08-19 (без
// дополнительных дат — дефолт ensureSelectedDates() берёт их без симуляции
// выбора в select). Талия падает на 3 см при direction: 'down' в каталоге —
// это желаемое снижение, тон обязан быть 'up' (§13 контракта T10-T16:
// направление задаёт каталог, а не приложение).
const CMP_INDEX = {
  generated_at: '2026-08-19T12:00:00Z',
  latest: {},
  series: {
    weight: [
      { date: '2026-08-01', value: 80, protocol_version: 1 },
      { date: '2026-08-19', value: 79.7, protocol_version: 1 } // Δ −0,3 кг — внутри мёртвой зоны (0,5 кг)
    ],
    height: [{ date: '2026-08-01', value: 180, protocol_version: 1 }],
    waist_who: [
      { date: '2026-08-01', value: 90, protocol_version: 1 },
      { date: '2026-08-19', value: 87, protocol_version: 1 } // Δ −3 см — значимо, желаемое направление
    ]
  }
};

function seedStorage(index) {
  storage.clear();
  storage.set(store.KEYS.token, 'github_pat_fixture');
  storage.set(store.KEYS.index, JSON.stringify({ data: index, fetchedAt: '2026-08-19T12:00:00Z' }));
  githubReply = index;
}

async function renderCompare(index) {
  compareScreen.destroy();
  seedStorage(index);
  const root = createElement('main');
  root.className = 'screen';
  await compareScreen.render(root, {});
  await flush();
  return root;
}

async function renderFigure(index) {
  figureScreen.destroy();
  seedStorage(index);
  const root = createElement('main');
  root.className = 'screen';
  await figureScreen.render(root, {});
  await flush();
  return root;
}

console.log('Самопроверка T16: screens/compare.js + роутер + DS-токены');

await step('DOM: две даты-селектора, дефолт «было»=первая, «стало»=последняя', async () => {
  const root = await renderCompare(CMP_INDEX);
  const selects = byTag(root, 'select');
  assert.equal(selects.length, 2, 'два селекта дат не найдены');
  assert.equal(selects[0].value, '2026-08-01', 'было — не самая ранняя дата');
  assert.equal(selects[1].value, '2026-08-19', 'стало — не самая поздняя дата');
});

await step('DOM: таблица покрывает все 22 замера каталога, без группировки на «Фигуре»', async () => {
  const root = await renderCompare(CMP_INDEX);
  const table = firstByClass(root, 'cmp-table');
  assert.ok(table, 'таблица сравнения не отрисована');
  const rows = byTag(table.children.find((c) => c.tagName === 'TBODY') ?? table, 'tr')
    .filter((tr) => tr.parentNode?.tagName === 'TBODY');
  assert.equal(rows.length, 22, `строк в таблице: ${rows.length}, а не 22`);
});

await step('DOM: неизмеренный замер — «—»/«—»/«—», не показан как измеренный', async () => {
  const root = await renderCompare(CMP_INDEX);
  const table = firstByClass(root, 'cmp-table');
  const rows = byTag(table, 'tr').filter((tr) => tr.parentNode?.tagName === 'TBODY');
  const neckRow = rows.find((tr) => tr.children[0]?.textContent === 'Шея');
  assert.ok(neckRow, 'строка «Шея» не найдена');
  const cells = neckRow.children;
  assert.equal(cells[1].textContent, '—', 'неизмеренное «было» не прочерк');
  assert.equal(cells[2].textContent, '—', 'неизмеренное «стало» не прочерк');
  const badge = firstByClass(cells[3], 'delta');
  assert.equal(badge.textContent, '—', 'Δ без данных не прочерк');
  assert.ok(badge.classList.contains('delta--flat'), 'Δ без данных не flat');
});

await step('DOM: Δ веса внутри мёртвой зоны — flat; Δ талии значима и в желаемую сторону — up', async () => {
  const root = await renderCompare(CMP_INDEX);
  const table = firstByClass(root, 'cmp-table');
  const rows = byTag(table, 'tr').filter((tr) => tr.parentNode?.tagName === 'TBODY');

  const weightRow = rows.find((tr) => tr.children[0]?.textContent === 'Вес');
  const weightBadge = firstByClass(weightRow.children[3], 'delta');
  assert.equal(weightBadge.textContent, '−0,3 кг');
  assert.ok(weightBadge.classList.contains('delta--flat'));

  const waistRow = rows.find((tr) => tr.children[0]?.textContent === 'Талия (WHO)');
  const waistBadge = firstByClass(waistRow.children[3], 'delta');
  assert.equal(waistBadge.textContent, '−3 см');
  assert.ok(waistBadge.classList.contains('delta--up'), 'снижение талии с direction: down обязано красится в up');
});

await step('DOM: KPI — Δ веса, Δ талии, ИМТ (расчётный, «стало»), дни между срезами', async () => {
  const root = await renderCompare(CMP_INDEX);
  const kpis = byClass(root, 'kpi');
  assert.equal(kpis.length, 4, `KPI-карточек: ${kpis.length}, а не 4`);

  const bmiCard = kpis.find((k) => firstByClass(k, 'kpi__label')?.textContent === 'ИМТ');
  assert.equal(firstByClass(bmiCard, 'kpi__value').textContent, '24,6');
  assert.equal(firstByClass(bmiCard, 'kpi__sub').textContent, 'расчётный, на дату «стало»');

  const daysCard = kpis.find((k) => firstByClass(k, 'kpi__label')?.textContent === 'Между срезами');
  assert.equal(firstByClass(daysCard, 'kpi__value').textContent, '18 дней');
});

await step('Параллель: waist_who даёт delta--up и на «Фигуре», и в «Сравнении» на одних данных', async () => {
  const figureRoot = await renderFigure(CMP_INDEX);
  const figureRow = byClass(figureRoot, 'mrow').find((row) => row.dataset.key === 'waist_who');
  const figureBadge = firstByClass(figureRow, 'mrow__delta');
  assert.ok(figureBadge.classList.contains('delta--up'), 'Фигура не покрасила снижение талии в up');

  const compareRoot = await renderCompare(CMP_INDEX);
  const table = firstByClass(compareRoot, 'cmp-table');
  const waistRow = byTag(table, 'tr')
    .filter((tr) => tr.parentNode?.tagName === 'TBODY')
    .find((tr) => tr.children[0]?.textContent === 'Талия (WHO)');
  const compareBadge = firstByClass(waistRow.children[3], 'delta');
  assert.ok(compareBadge.classList.contains('delta--up'), 'Сравнение не покрасила снижение талии в up');

  assert.equal(figureBadge.classList.contains('delta--up'), compareBadge.classList.contains('delta--up'));
});

await step('DOM: пустой индекс — приглашение внести сессию, без таблицы и KPI', async () => {
  const root = await renderCompare({ generated_at: '2026-08-19T12:00:00Z', latest: {}, series: {} });
  assert.equal(byClass(root, 'cmp-table').length, 0);
  assert.equal(byClass(root, 'kpi').length, 0);
  const link = byTag(root, 'A').find((a) => a.href === '#/entry');
  assert.ok(link, 'нет ссылки на полную сессию в пустом состоянии');
});

await step('сторож: экран read-only, Δ красится только delta() из asof.js', () => {
  const raw = readFileSync(new URL('./screens/compare.js', import.meta.url), 'utf8');
  const code = raw.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /\b(?:writeFile|listFiles|enqueue|enqueueEntry)\b/, 'compare.js не должен уметь писать данные');
  assert.match(code, /import \{ delta, sliceAt, sliceDates \} from '\.\.\/asof\.js'/);
  assert.doesNotMatch(code, /\btone\s*:/, 'экран не конструирует tone вручную');
});

await step('роутер: app.js знает про #/compare, вкладку «Фигура» и широкую раскладку', () => {
  const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(app, /compare:\s*\(\)\s*=>\s*import\('\.\/screens\/compare\.js'\)/, 'compare не зарегистрирован в SCREENS');
  assert.match(app, /parts\[0\] === 'compare'\) return \{ name: 'compare'/, 'роут #/compare не резолвится');
  assert.match(app, /TAB_ALIASES = \{ compare: 'figure' \}/, 'вкладка «Фигура» не подсвечивается на #/compare');
  assert.match(app, /name === 'figure' \|\| name === 'compare'/, 'широкая раскладка не включена для #/compare');
});

await step('сторож: sw.js несёт compare.js в оболочке', () => {
  const sw = readFileSync(new URL('./sw.js', import.meta.url), 'utf8');
  assert.match(sw, /'\.\/screens\/compare\.js'/, 'compare.js не вписан в SHELL');
});

await step('сторож §0: ни в index.html, ни в style.css нет внешних адресов', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /https?:\/\/|@import\s+url\(/i);
  assert.doesNotMatch(css, /https?:\/\/|@import\s+url\(/i);
});

await step('сторож: тёмная тема переопределяет те же токены, что заданы в :root', () => {
  const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8');
  const rootBlock = /:root\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
  const darkBlock = /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([\s\S]*?)\n  \}/.exec(css)?.[1] ?? '';
  assert.ok(rootBlock && darkBlock, 'не найден :root или тёмный блок');

  const tokenNames = (block) => Array.from(block.matchAll(/(--[a-z0-9-]+):/g)).map((m) => m[1]);
  const figKpiTokens = tokenNames(rootBlock).filter((name) => name.startsWith('--fig-') || name.startsWith('--kpi-') || name === '--accent-strong');
  const darkNames = new Set(tokenNames(darkBlock));

  const missing = figKpiTokens.filter((name) => !darkNames.has(name));
  assert.deepEqual(missing, [], `нет тёмного значения: ${missing.join(', ')}`);
});

compareScreen.destroy();
figureScreen.destroy();
console.log(`Итог: ${passed} ок, ${failed} провалено.`);
process.exitCode = failed === 0 ? 0 : 1;
