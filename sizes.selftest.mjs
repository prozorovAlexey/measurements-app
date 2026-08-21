// Самопроверка T15: пересчёт замеров в размеры (sizes.js, §5.4 спеки) и
// экран «Размеры» (screens/sizes.js, §7.7 спеки, §14 контракта).
//
// Запуск:
//   C:\Users\user\AppData\Roaming\nvm\v24.4.0\node.exe sizes.selftest.mjs
//
// Только stdlib. Часть 1 — чистая функция, без DOM (образец: figure.selftest.mjs).
// Часть 2 — мини-DOM без библиотек (образец: compare.selftest.mjs), шторка
// быстрого ввода проверяется по тому же приёму, что в figure-sheet.selftest.mjs:
// сторож по исходнику плюс DOM-поведение. Общего test-utils модуля в проекте
// нет — файл самодостаточен (§13 контракта).

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';

import { sizeFor } from './sizes.js';

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

console.log('Самопроверка T15: sizes.js + screens/sizes.js');

// ===========================================================================
// Часть 1 — sizeFor() из sizes.js (§5.4 спеки)
// ===========================================================================

const REQUIRED_KEYS = Object.freeze({
  clothing: Object.freeze(['chest']),
  shirt: Object.freeze(['neck', 'sleeve']),
  jeans: Object.freeze(['waist_natural', 'inseam']),
  shoe: Object.freeze(['foot_length']),
  ring: Object.freeze(['finger_index'])
});

await step('clothing: UA/EU = грудь/2 до ближайшего чётного', () => {
  // 103/2 = 51,5 — ближе к 52 (0,5), чем к 50 (1,5).
  assert.equal(sizeFor('clothing', { chest: 103 }).primary, 'UA/EU 52');
  // 101/2 = 50,5 — равноудалено от 50 и 52, тай-брейк round(50.5)=51(odd)->вниз к 50.
  assert.equal(sizeFor('clothing', { chest: 101 }).primary, 'UA/EU 50');
  // 100/2 = 50 — уже чётное, без клампа.
  assert.equal(sizeFor('clothing', { chest: 100 }).primary, 'UA/EU 50');
  const result = sizeFor('clothing', { chest: 103 });
  assert.equal(result.secondary, null, 'у одежды нет второй половины карточки');
  assert.deepEqual(result.missing, []);
});

await step('clothing: нет груди — missing содержит chest, дефолта нет', () => {
  const result = sizeFor('clothing', {});
  assert.deepEqual(result, { primary: null, secondary: null, letter: null, missing: ['chest'] });
});

await step('shirt: воротник целым числом, рукав как есть, missing по каждой половине', () => {
  // Math.round(39.5) = 40.
  let result = sizeFor('shirt', { neck: 39.5, sleeve: 61.3 });
  assert.equal(result.primary, 'Воротник 40 см');
  assert.equal(result.secondary, 'Рукав 61,3 см');
  assert.deepEqual(result.missing, []);

  // Math.round(38.4) = 38.
  result = sizeFor('shirt', { neck: 38.4, sleeve: 45 });
  assert.equal(result.primary, 'Воротник 38 см');
  assert.equal(result.secondary, 'Рукав 45 см');

  result = sizeFor('shirt', { neck: 39.5 }); // рукав не измерен
  assert.equal(result.primary, 'Воротник 40 см');
  assert.equal(result.secondary, null);
  assert.deepEqual(result.missing, ['sleeve']);
  assert.notEqual(result.letter, null, 'буква считается по шее независимо от рукава');

  result = sizeFor('shirt', { sleeve: 61.3 }); // шея не измерена
  assert.equal(result.primary, null);
  assert.equal(result.secondary, 'Рукав 61,3 см');
  assert.deepEqual(result.missing, ['neck']);
  assert.equal(result.letter, null, 'без шеи буквы быть не может');

  result = sizeFor('shirt', {}); // не измерено ничего
  assert.equal(result.primary, null);
  assert.equal(result.secondary, null);
  assert.equal(result.letter, null);
  assert.deepEqual(result.missing, ['neck', 'sleeve'], 'порядок §5.4: воротник, потом рукав');
});

await step('jeans: W = талия/2,54, L = шов/2,54, оба до целого дюйма, буквы нет', () => {
  // 101.6 / 2.54 = 40 ровно; 78.74 / 2.54 = 31 ровно.
  let result = sizeFor('jeans', { waist_natural: 101.6, inseam: 78.74 });
  assert.equal(result.primary, 'W40');
  assert.equal(result.secondary, 'L31');
  assert.equal(result.letter, null);
  assert.deepEqual(result.missing, []);

  result = sizeFor('jeans', { waist_natural: 101.6 }); // шов не измерен
  assert.equal(result.primary, 'W40');
  assert.equal(result.secondary, null);
  assert.deepEqual(result.missing, ['inseam']);

  result = sizeFor('jeans', { inseam: 78.74 }); // талия не измерена
  assert.equal(result.primary, null);
  assert.equal(result.secondary, 'L31');
  assert.deepEqual(result.missing, ['waist_natural']);

  result = sizeFor('jeans', {});
  assert.equal(result.primary, null);
  assert.equal(result.secondary, null);
  assert.deepEqual(result.missing, ['waist_natural', 'inseam'], 'порядок §5.4: талия, потом шов');
});

await step('shoe: EU = (стопа + 1,0) × 1,5, округление до 0,5, буквы нет', () => {
  // (26.5 + 1) * 1.5 = 41.25 -> ближайшие 0,5 это 41,0 и 41,5, ближе 41,5.
  assert.equal(sizeFor('shoe', { foot_length: 26.5 }).primary, 'EU 41,5');
  // (25 + 1) * 1.5 = 39 ровно.
  assert.equal(sizeFor('shoe', { foot_length: 25 }).primary, 'EU 39');
  const result = sizeFor('shoe', { foot_length: 26.5 });
  assert.equal(result.secondary, null);
  assert.equal(result.letter, null);

  const missing = sizeFor('shoe', {});
  assert.deepEqual(missing, { primary: null, secondary: null, letter: null, missing: ['foot_length'] });
});

await step('ring: диаметр мм = обхват×10/π, округление до 0,5, буквы нет', () => {
  // 5 * 10 / π = 15,9155… -> ближайшие 0,5 это 15,5 и 16,0, ближе 16,0.
  assert.equal(sizeFor('ring', { finger_index: 5 }).primary, 'UA/EU 16');
  // 6.5 * 10 / π = 20,6873… -> ближе к 20,5.
  assert.equal(sizeFor('ring', { finger_index: 6.5 }).primary, 'UA/EU 20,5');
  const result = sizeFor('ring', { finger_index: 5 });
  assert.equal(result.secondary, null);
  assert.equal(result.letter, null);

  const missing = sizeFor('ring', {});
  assert.deepEqual(missing, { primary: null, secondary: null, letter: null, missing: ['finger_index'] });
});

await step('нет дефолтов: null/NaN/undefined/отсутствующий ключ — все формы «нет данных» одинаковы', () => {
  const PRIMARY_FIELD = Object.freeze({ clothing: 'primary', shirt: 'primary', jeans: 'primary', shoe: 'primary', ring: 'primary' });
  const SECONDARY_KEY = Object.freeze({ shirt: 'sleeve', jeans: 'inseam' });
  const BAD = [null, Number.NaN, undefined, 'absent'];

  for (const [scale, keys] of Object.entries(REQUIRED_KEYS)) {
    for (const key of keys) {
      for (const bad of BAD) {
        const values = {};
        for (const k of keys) values[k] = 999;
        if (bad === 'absent') delete values[key];
        else values[key] = bad;

        const result = sizeFor(scale, values);
        assert.ok(
          result.missing.includes(key),
          `${scale}.${key} = ${String(bad)} не попал в missing`
        );

        if (keys.length === 1) {
          assert.equal(result.primary, null, `${scale}: одиночный замер отсутствует, но primary не null`);
          assert.equal(result.secondary, null);
        } else if (key === SECONDARY_KEY[scale]) {
          assert.equal(result.secondary, null, `${scale}.${key} отсутствует, но secondary не null`);
          assert.notEqual(result.primary, null, `${scale}: наличие первого замера не должно теряться`);
        } else {
          assert.equal(result.primary, null, `${scale}: первый замер отсутствует (${key}), но primary не null`);
        }
      }
    }
  }
});

await step('неизвестная шкала — пустой результат без исключения', () => {
  assert.deepEqual(sizeFor('unknown-scale', { chest: 100 }), { primary: null, secondary: null, letter: null, missing: [] });
  assert.deepEqual(sizeFor(undefined, undefined), { primary: null, secondary: null, letter: null, missing: [] });
  assert.deepEqual(sizeFor('clothing', null), { primary: null, secondary: null, letter: null, missing: ['chest'] });
  assert.deepEqual(sizeFor('clothing', 'не объект'), { primary: null, secondary: null, letter: null, missing: ['chest'] });
});

await step('буквенная шкала — только у clothing и shirt, у jeans/shoe/ring всегда null', () => {
  assert.equal(sizeFor('jeans', { waist_natural: 80, inseam: 78 }).letter, null);
  assert.equal(sizeFor('shoe', { foot_length: 27 }).letter, null);
  assert.equal(sizeFor('ring', { finger_index: 6 }).letter, null);
  assert.notEqual(sizeFor('clothing', { chest: 100 }).letter, null);
  assert.notEqual(sizeFor('shirt', { neck: 40, sleeve: 60 }).letter, null);
});

await step('буквенная шкала: монотонна по обхвату и различает пол (внутреннее решение, не из спеки)', () => {
  const ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
  const rank = (letter) => ORDER.indexOf(letter);

  for (const sex of ['male', 'female']) {
    let previousChest = -1;
    for (let chest = 60; chest <= 140; chest += 1) {
      const { letter } = sizeFor('clothing', { chest }, { sex });
      assert.ok(letter && ORDER.includes(letter), `clothing/${sex}: неизвестная буква ${letter}`);
      assert.ok(rank(letter) >= previousChest, `clothing/${sex}: буква упала при росте груди (${chest} см)`);
      previousChest = rank(letter);
    }

    let previousNeck = -1;
    for (let neck = 28; neck <= 55; neck += 1) {
      const { letter } = sizeFor('shirt', { neck, sleeve: 60 }, { sex });
      assert.ok(letter && ORDER.includes(letter), `shirt/${sex}: неизвестная буква ${letter}`);
      assert.ok(rank(letter) >= previousNeck, `shirt/${sex}: буква упала при росте шеи (${neck} см)`);
      previousNeck = rank(letter);
    }
  }

  let chestDiffers = false;
  for (let chest = 60; chest <= 140; chest += 1) {
    if (sizeFor('clothing', { chest }, { sex: 'male' }).letter !== sizeFor('clothing', { chest }, { sex: 'female' }).letter) {
      chestDiffers = true;
      break;
    }
  }
  assert.ok(chestDiffers, 'мужская и женская сетка одежды не различаются ни при одном значении груди');

  let neckDiffers = false;
  for (let neck = 28; neck <= 55; neck += 1) {
    const male = sizeFor('shirt', { neck, sleeve: 60 }, { sex: 'male' }).letter;
    const female = sizeFor('shirt', { neck, sleeve: 60 }, { sex: 'female' }).letter;
    if (male !== female) {
      neckDiffers = true;
      break;
    }
  }
  assert.ok(neckDiffers, 'мужская и женская сетка рубашки не различаются ни при одном значении шеи');
});

await step('sizeFor — чистая функция: один вход даёт один выход, values не мутируется', () => {
  const values = Object.freeze({
    chest: 103, neck: 39.5, sleeve: 61.3,
    waist_natural: 101.6, inseam: 78.74,
    foot_length: 26.5, finger_index: 5
  });
  const before = JSON.stringify(values);

  for (const scale of ['clothing', 'shirt', 'jeans', 'shoe', 'ring']) {
    const first = sizeFor(scale, values, { sex: 'male' });
    const second = sizeFor(scale, { ...values }, { sex: 'male' });
    assert.deepEqual(first, second, `${scale}: разные результаты на одинаковых входах`);
  }

  assert.equal(JSON.stringify(values), before, 'values не должен мутироваться (объект заморожен — мутация бросила бы исключение)');
});

await step('sizes.js остаётся чистым: без импортов, без DOM/сети/localStorage', async () => {
  const source = readFileSync(new URL('./sizes.js', import.meta.url), 'utf8');
  // Строки-комментарии убраны перед сканом: шапка файла прозой упоминает
  // localStorage/DOM/сеть (объясняя, чего модуль НЕ делает) — это не код.
  const code = source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.ok(!/^\s*import\s/m.test(code), 'у sizes.js появилась зависимость');
  for (const forbidden of ['document', 'window', 'localStorage', 'fetch', 'XMLHttpRequest']) {
    assert.ok(!new RegExp(`\\b${forbidden}\\b`).test(code), `найден запрещённый API: ${forbidden}`);
  }
  assert.deepEqual(Object.keys(await import('./sizes.js')), ['sizeFor']);
});

// ===========================================================================
// Часть 2 — экран screens/sizes.js (§7.7 спеки, §14 контракта)
// ===========================================================================
// Мини-DOM — тот же приём, что в compare.selftest.mjs / figure-sheet.selftest.mjs.

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

function byTag(root, tag) {
  return walk(root).filter((node) => node.tagName === tag.toUpperCase());
}

function firstByTag(root, tag) {
  return byTag(root, tag)[0] ?? null;
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
globalThis.location = { hash: '#/sizes' };

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => (storage.has(String(key)) ? storage.get(String(key)) : null),
  setItem: (key, value) => { storage.set(String(key), String(value)); },
  removeItem: (key) => { storage.delete(String(key)); }
};

const CATALOG_PATH = new URL('./catalog.json', import.meta.url);
const CATALOG_RAW = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));

let githubReply = { generated_at: '2026-08-19T12:00:00Z', latest: {}, series: {} };
let catalogGate = null; // {} во время «зависшего» fetch каталога, null в обычном режиме
let catalogFetchCalls = 0;
let githubFetchCalls = 0;

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

const sizesScreen = await import('./screens/sizes.js');
const store = await import('./store.js');

async function flush() {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  }
}

function seedStorage(index) {
  storage.clear();
  storage.set(store.KEYS.token, 'github_pat_fixture');
  storage.set(store.KEYS.index, JSON.stringify({ data: index, fetchedAt: '2026-08-19T12:00:00Z' }));
  storage.set(store.KEYS.catalog, JSON.stringify({ data: CATALOG_RAW, fetchedAt: '2026-08-19T12:00:00Z' }));
  githubReply = index;
}

async function renderScreen(index) {
  sizesScreen.destroy();
  seedStorage(index);
  const root = createElement('main');
  root.className = 'screen';
  await sizesScreen.render(root, {});
  await flush();
  return root;
}

// Фикстуры ------------------------------------------------------------------

const EMPTY_INDEX = { generated_at: '2026-08-19T12:00:00Z', latest: {}, series: {} };

// Один общий срез на большинство DOM-тестов:
//  - clothing (chest) и ring (finger_index) — полные карточки;
//  - shirt — есть neck, нет sleeve; jeans — есть waist_natural, нет inseam;
//  - shoe — foot_length не измерен вовсе (карточка целиком «нужен замер»);
//  - из семи «вне фигуры»: waist_umbilicus устарел (> 21*2 дней),
//    biceps_flexed/foot_width/head_circ свежие, inseam и sleeve не измерены.
const SIZE_INDEX = {
  generated_at: '2026-08-19T12:00:00Z',
  latest: {},
  series: {
    chest: [{ date: '2026-08-01', value: 103, protocol_version: 1 }],
    neck: [{ date: '2026-08-01', value: 39.5, protocol_version: 1 }],
    waist_natural: [{ date: '2026-08-01', value: 101.6, protocol_version: 1 }],
    finger_index: [{ date: '2026-08-01', value: 5, protocol_version: 1 }],
    waist_umbilicus: [{ date: '2026-01-01', value: 91.4, protocol_version: 1 }],
    biceps_flexed: [{ date: '2026-08-10', value: 34.2, protocol_version: 1 }],
    foot_width: [{ date: '2026-08-10', value: 10.5, protocol_version: 1 }],
    head_circ: [{ date: '2026-08-10', value: 56, protocol_version: 1 }]
  }
};

const SCREEN_SOURCE = readFileSync(new URL('./screens/sizes.js', import.meta.url), 'utf8');
const disclaimerMatch = /const SIZE_DISCLAIMER = '([^']+)'/.exec(SCREEN_SOURCE);
assert.ok(disclaimerMatch, 'SIZE_DISCLAIMER не найден в screens/sizes.js — проверь константу руками');
const SIZE_DISCLAIMER = disclaimerMatch[1];

// Этот тест обязан идти первым среди DOM-тестов экрана: catalog.js
// мемоизирует успешный fetch каталога на весь процесс (комментарий модуля:
// «провал не запоминается» — про успех этого не сказано, и код это
// подтверждает: pending не сбрасывается после resolve). Если раньше уже
// прошёл хоть один render() с реальной (негейченной) сетью, catalogGate
// повторный fetch каталога уже не перехватит.
await step('офлайн-первичность: первая отрисовка из bm.index_cache/bm.catalog_cache, до GitHub GET', async () => {
  sizesScreen.destroy();
  seedStorage(SIZE_INDEX);
  catalogGate = {};
  const githubBefore = githubFetchCalls;

  const root = createElement('main');
  root.className = 'screen';
  await sizesScreen.render(root, {});

  // Catalog fetch завис на gate — index.json ещё не мог быть запрошен,
  // поэтому и то, и другое пришло синхронно из localStorage.
  assert.equal(typeof catalogGate.reject, 'function', 'catalog fetch не стартовал — гейт не перехватил запрос');
  assert.equal(githubFetchCalls, githubBefore, 'GET к api.github.com стартовал раньше resolve catalog fetch');
  assert.equal(byClass(root, 'sizecard').length, 5, 'карточки размеров ещё не отрисованы из кэша');
  const clothingCard = byClass(root, 'sizecard').find((card) => firstByTag(card, 'h2')?.textContent === 'Одежда');
  assert.ok(firstByClass(clothingCard, 'sizecard__primary'), 'карточка одежды пуста, хотя кэш содержит грудь');
  assert.equal(byClass(root, 'mrow').length, 7, 'список из семи замеров ещё не отрисован из кэша');

  const gate = catalogGate;
  catalogGate = null;
  gate.reject(new TypeError('контролируемый обрыв catalog fetch (тест офлайн-первичности)'));
  await flush();
  sizesScreen.destroy();
});

await step('DOM: пять карточек размеров с дисклеймером в каждой', async () => {
  const root = await renderScreen(SIZE_INDEX);
  const grid = firstByClass(root, 'sizecards');
  const cards = byClass(root, 'sizecard');
  assert.ok(grid.classList.contains('kpi-grid'), 'сетка размеров должна переиспользовать KPI-сетку T20');
  assert.equal(cards.length, 5, `карточек размеров: ${cards.length}, а не 5`);
  assert.deepEqual(cards.map((card) => firstByTag(card, 'h2')?.textContent), [
    'Одежда', 'Рубашка', 'Джинсы', 'Обувь', 'Кольцо'
  ]);
  for (const card of cards) {
    assert.ok(card.classList.contains('kpi'), 'карточка размера должна переиспользовать KPI-карточку T20');
    assert.ok(firstByClass(card, 'kpi__dot'), 'в карточке нет общего KPI-индикатора');
    assert.ok(firstByClass(card, 'kpi__label'), 'заголовок карточки не использует подпись KPI');
    const hints = byClass(card, 'field__hint').map((node) => node.textContent);
    assert.ok(hints.includes(SIZE_DISCLAIMER), 'дисклеймер «ориентир» не найден в карточке');
  }
});

await step('DOM: карточка без замера называет его по имени каталога, не подставляет цифру', async () => {
  const root = await renderScreen(SIZE_INDEX);
  const cards = byClass(root, 'sizecard');

  const shoeCard = cards.find((card) => firstByTag(card, 'h2')?.textContent === 'Обувь');
  assert.equal(byClass(shoeCard, 'sizecard__primary').length, 0, 'у обуви нет замера — дефолтная цифра не должна появиться');
  assert.equal(firstByClass(shoeCard, 'sizecard__missing').textContent, 'Нужен замер: Длина стопы');

  const shirtCard = cards.find((card) => firstByTag(card, 'h2')?.textContent === 'Рубашка');
  assert.ok(firstByClass(shirtCard, 'sizecard__primary'), 'воротник обязан посчитаться при известной шее');
  assert.equal(byClass(shirtCard, 'sizecard__secondary').length, 0, 'рукав не измерен — секции быть не должно');
  assert.equal(firstByClass(shirtCard, 'sizecard__missing').textContent, 'Нужен замер: Длина рукава');

  const jeansCard = cards.find((card) => firstByTag(card, 'h2')?.textContent === 'Джинсы');
  assert.ok(firstByClass(jeansCard, 'sizecard__primary'), 'W обязан посчитаться при известной талии');
  assert.equal(byClass(jeansCard, 'sizecard__secondary').length, 0, 'шов не измерен — секции быть не должно');
  assert.equal(firstByClass(jeansCard, 'sizecard__missing').textContent, 'Нужен замер: Внутр. шов');

  const ringCard = cards.find((card) => firstByTag(card, 'h2')?.textContent === 'Кольцо');
  assert.equal(byClass(ringCard, 'sizecard__missing').length, 0, 'кольцо измерено полностью — «нужен замер» лишний');
});

await step('DOM: составная карточка — не хватает первого замера (шея известна, рукав нет; и наоборот)', async () => {
  const onlyNeck = { generated_at: '2026-08-19T12:00:00Z', latest: {}, series: { neck: [{ date: '2026-08-01', value: 39.5, protocol_version: 1 }] } };
  let root = await renderScreen(onlyNeck);
  let shirtCard = byClass(root, 'sizecard').find((card) => firstByTag(card, 'h2')?.textContent === 'Рубашка');
  assert.ok(firstByClass(shirtCard, 'sizecard__primary'));
  assert.equal(byClass(shirtCard, 'sizecard__secondary').length, 0);
  assert.equal(firstByClass(shirtCard, 'sizecard__missing').textContent, 'Нужен замер: Длина рукава');

  const onlySleeve = { generated_at: '2026-08-19T12:00:00Z', latest: {}, series: { sleeve: [{ date: '2026-08-01', value: 61, protocol_version: 1 }] } };
  root = await renderScreen(onlySleeve);
  shirtCard = byClass(root, 'sizecard').find((card) => firstByTag(card, 'h2')?.textContent === 'Рубашка');
  assert.equal(byClass(shirtCard, 'sizecard__primary').length, 0, 'без шеи воротника быть не должно');
  assert.ok(firstByClass(shirtCard, 'sizecard__secondary'), 'рукав измерен — секция обязана появиться');
  assert.equal(firstByClass(shirtCard, 'sizecard__missing').textContent, 'Нужен замер: Шея');

  const nothing = { generated_at: '2026-08-19T12:00:00Z', latest: {}, series: {} };
  root = await renderScreen(nothing);
  shirtCard = byClass(root, 'sizecard').find((card) => firstByTag(card, 'h2')?.textContent === 'Рубашка');
  assert.equal(byClass(shirtCard, 'sizecard__primary').length, 0);
  assert.equal(byClass(shirtCard, 'sizecard__secondary').length, 0);
  assert.equal(firstByClass(shirtCard, 'sizecard__missing').textContent, 'Нужен замер: Шея, Длина рукава');
});

await step('DOM: список из семи замеров вне фигуры — точный порядок, каждая строка кликабельна', async () => {
  const root = await renderScreen(SIZE_INDEX);
  const section = firstByClass(root, 'sizes-measurements');
  assert.ok(section, 'список остальных замеров не получил контейнер T23');
  assert.ok(firstByClass(section, 'sizes-measurements__list'), 'строки не собраны в визуальный список T23');
  const rows = byClass(root, 'mrow');
  assert.deepEqual(rows.map((row) => row.dataset.key), [
    'waist_umbilicus', 'waist_natural', 'biceps_flexed',
    'foot_width', 'inseam', 'sleeve', 'head_circ'
  ], 'порядок обязан совпасть с OFF_FIGURE_ORDER из catalog.js');

  for (const row of rows) {
    assert.equal(row.getAttribute('role'), 'button');
    assert.equal(row.getAttribute('tabindex'), '0');
  }

  const sleeveRow = rows.find((row) => row.dataset.key === 'sleeve');
  assert.equal(firstByClass(sleeveRow, 'mrow__amount').textContent, '—');
  assert.equal(firstByClass(sleeveRow, 'mrow__when').textContent, 'не измерено');
});

await step('DOM: клик по строке открывает переиспользуемую шторку figure.js', async () => {
  const root = await renderScreen(SIZE_INDEX);
  assert.equal(byClass(root, 'sheet').length, 0, 'шторка не должна быть открыта до клика');

  const row = byClass(root, 'mrow').find((item) => item.dataset.key === 'sleeve');
  row.dispatch('click');
  const sheet = firstByClass(root, 'sheet');
  assert.ok(sheet, 'шторка не открылась по клику на строку списка');
  assert.equal(firstByClass(sheet, 'sheet__title').textContent, 'Длина рукава');

  assert.match(
    SCREEN_SOURCE,
    /import \{ createSheetController, todayISO \} from '\.\/figure\.js'/,
    'шторка обязана переиспользовать createSheetController из screens/figure.js, а не свою копию'
  );
});

await step('bumpOpens("sizes") растёт на каждом render(), не только при первом монтировании', async () => {
  seedStorage(SIZE_INDEX);
  const before = store.getOpens().sizes.count;

  sizesScreen.destroy();
  let root = createElement('main');
  root.className = 'screen';
  await sizesScreen.render(root, {});
  await flush();
  const afterFirst = store.getOpens().sizes.count;
  assert.equal(afterFirst, before + 1, 'первый render() не увеличил счётчик');

  sizesScreen.destroy();
  root = createElement('main');
  root.className = 'screen';
  await sizesScreen.render(root, {});
  await flush();
  const afterSecond = store.getOpens().sizes.count;
  assert.equal(afterSecond, afterFirst + 1, 'повторный render() (повторный заход на экран) не увеличил счётчик');
});

await step('DOM: устаревшее значение вне фигуры остаётся на экране полностью (сквозное правило §13)', async () => {
  const root = await renderScreen(SIZE_INDEX);
  const row = byClass(root, 'mrow').find((item) => item.dataset.key === 'waist_umbilicus');
  assert.ok(row, 'строка «Талия (пупок)» не найдена');
  assert.equal(row.hidden, false);

  const amount = firstByClass(row, 'mrow__amount');
  assert.equal(amount.textContent, '91,4 см', 'устаревшее значение урезано или заменено прочерком');
  assert.ok(!amount.classList.contains('mrow__amount--missing'));

  const when = firstByClass(row, 'mrow__when');
  assert.ok(when.classList.contains('mrow__when--stale'), 'устаревшая дата не помечена приглушённым классом');
  assert.equal(when.textContent, '01.01.2026', 'дата устаревшего значения обязана остаться видимой целиком');

  // Контраст: свежий замер той же природы (dynamic, frequency_days задан) — без --stale.
  const freshRow = byClass(root, 'mrow').find((item) => item.dataset.key === 'biceps_flexed');
  assert.ok(!firstByClass(freshRow, 'mrow__when').classList.contains('mrow__when--stale'));
});

await step('сторож: экран не пишет данные напрямую, enqueue*/writeFile/listFiles — вне screens/sizes.js', () => {
  const code = SCREEN_SOURCE.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(
    code,
    /\b(?:writeFile|listFiles|enqueue|enqueueEntry)\b/,
    'screens/sizes.js обязан оставаться read-only: запись — только через переиспользуемую шторку'
  );

  const figureScreenSource = readFileSync(new URL('./screens/figure.js', import.meta.url), 'utf8');
  assert.match(
    figureScreenSource,
    /\benqueueEntry\(/,
    'переиспользуемая шторка (screens/figure.js) обязана сама уметь писать через enqueueEntry()'
  );
});

await step('сторож §0: ни sizes.js, ни screens/sizes.js не содержат внешних адресов', () => {
  const pureSource = readFileSync(new URL('./sizes.js', import.meta.url), 'utf8');
  assert.doesNotMatch(pureSource, /https?:\/\//i);
  assert.doesNotMatch(SCREEN_SOURCE, /https?:\/\//i);
});

await step('DOM: пустой индекс — экран не падает, карточки и список показывают недостающее', async () => {
  const root = await renderScreen(EMPTY_INDEX);
  const cards = byClass(root, 'sizecard');
  assert.equal(cards.length, 5);
  for (const card of cards) {
    assert.ok(firstByClass(card, 'sizecard__missing'), `карточка "${firstByTag(card, 'h2')?.textContent}" не сообщает о недостающем замере`);
  }

  const rows = byClass(root, 'mrow');
  assert.equal(rows.length, 7);
  for (const row of rows) {
    assert.equal(firstByClass(row, 'mrow__amount').textContent, '—');
    assert.equal(firstByClass(row, 'mrow__when').textContent, 'не измерено');
  }
});

sizesScreen.destroy();
console.log(`Итог: ${passed} ок, ${failed} провалено.`);
process.exitCode = failed === 0 ? 0 : 1;
