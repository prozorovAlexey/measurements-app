// Самопроверка среза на дату, Δ и расширения каталога T11.
//
//   C:\Users\user\AppData\Roaming\nvm\v24.4.0\node.exe asof.selftest.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { delta, sliceAt, sliceDates } from './asof.js';

const catalogRaw = JSON.parse(readFileSync(new URL('./catalog.json', import.meta.url), 'utf8'));
const FIGURE_KEYS = Object.freeze([
  'weight', 'height',
  'neck', 'shoulder_width', 'chest', 'waist_who', 'pelvis', 'hip',
  'biceps_relaxed', 'forearm', 'wrist', 'finger_index',
  'thigh', 'calf', 'foot_length'
]);
const STAGE_TWO_FIELDS = Object.freeze([
  'svg_id', 'direction', 'ui_range', 'show_on_figure', 'size_scale'
]);

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

console.log('Самопроверка T11: asof.js и каталог');

await step('срез выбирает последнее значение не позже даты и считает возраст', () => {
  const index = {
    latest: {
      waist_who: { date: '2026-08-20', value: 83, protocol_version: 2 },
      orphan: { date: '2026-08-10', value: 10, protocol_version: 1 }
    },
    series: {
      waist_who: [
        { date: '2026-07-01', value: 88.2, protocol_version: 1 },
        { date: '2026-08-12', value: 84.1, protocol_version: 2 },
        { date: '2026-08-20', value: 83, protocol_version: 2 }
      ],
      weight: [
        { date: '2026-08-16', value: 79.4, protocol_version: 1 },
        { date: '2026-08-16', value: 79.1, protocol_version: 1 }
      ]
    }
  };

  const result = sliceAt(index, '2026-08-17');
  assert.deepEqual(result.waist_who, {
    value: 84.1,
    date: '2026-08-12',
    protocolVersion: 2,
    ageDays: 5,
    pending: false
  });
  assert.deepEqual(result.weight, {
    value: 79.1,
    date: '2026-08-16',
    protocolVersion: 1,
    ageDays: 1,
    pending: false
  });
  assert.equal(result.orphan, null);
});

await step('отсутствующие и повреждённые ключи index.json срез не ломают', () => {
  assert.deepEqual(sliceAt(null, '2026-08-17'), {});
  assert.deepEqual(sliceAt({}, '2026-08-17'), {});
  assert.deepEqual(sliceAt({ latest: { missing: {} }, series: null }, '2026-08-17'), {
    missing: null
  });

  const hostile = JSON.parse('{"series":{"__proto__":[{"date":"2026-08-17","value":7,"protocol_version":1}]}}');
  const result = sliceAt(hostile, '2026-08-17');
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(Object.hasOwn(result, '__proto__'), true);
  assert.equal(result.__proto__.value, 7);
});

await step('даты срезов уникальны и отсортированы по возрастанию', () => {
  const index = {
    series: {
      weight: [
        { date: '2026-08-17', value: 79 },
        { date: '2026-08-01', value: 81 }
      ],
      waist_who: [
        { date: '2026-08-17', value: 84 },
        { date: '2026-02-30', value: 90 },
        { date: '2026-08-10', value: Number.NaN }
      ]
    }
  };
  assert.deepEqual(sliceDates(index), ['2026-08-01', '2026-08-17']);
  assert.deepEqual(sliceDates(null), []);
});

await step('мёртвая зона Δ нейтральна, её граница уже значима', () => {
  assert.deepEqual(delta(80, 81.9, { unit: 'cm', direction: 'up' }), {
    value: 1.9000000000000057,
    significant: false,
    tone: 'flat'
  });
  assert.deepEqual(delta(80, 82, { unit: 'cm', direction: 'up' }), {
    value: 2,
    significant: true,
    tone: 'up'
  });
  assert.deepEqual(delta(80, 78, { unit: 'cm', direction: 'down' }), {
    value: -2,
    significant: true,
    tone: 'up'
  });
  assert.deepEqual(delta(80, 82, { unit: 'cm', direction: 'down' }), {
    value: 2,
    significant: true,
    tone: 'down'
  });
  assert.deepEqual(delta(80, 82, { unit: 'cm', direction: 'none' }), {
    value: 2,
    significant: true,
    tone: 'flat'
  });
  assert.equal(delta(80, 80.49, { unit: 'kg', direction: 'down' }).significant, false);
  assert.equal(delta(80, 80.5, { unit: 'kg', direction: 'down' }).significant, true);
  assert.deepEqual(delta(null, 80, { unit: 'kg', direction: 'down' }), {
    value: null,
    significant: false,
    tone: 'flat'
  });
});

await step('каталог содержит 22 замера и все поля этапа 2', () => {
  assert.equal(catalogRaw.measurements.length, 22);
  assert.equal(new Set(catalogRaw.measurements.map((item) => item.key)).size, 22);
  assert.deepEqual(
    catalogRaw.measurements.filter((item) => item.show_on_figure).map((item) => item.key).sort(),
    FIGURE_KEYS.slice().sort()
  );
  assert.ok(catalogRaw.measurements.every((item) => (
    STAGE_TWO_FIELDS.every((field) => Object.hasOwn(item, field))
  )));
  assert.ok(catalogRaw.measurements.every((item) => (
    item.ui_range
    && Number.isFinite(item.ui_range.min)
    && Number.isFinite(item.ui_range.max)
    && Number.isFinite(item.ui_range.step)
    && item.ui_range.min < item.ui_range.max
    && item.ui_range.step > 0
  )));

  const byKey = new Map(catalogRaw.measurements.map((item) => [item.key, item]));
  assert.deepEqual(
    [byKey.get('forearm').landmark, byKey.get('forearm').posture],
    ['Максимальный обхват', 'Рука опущена и расслаблена, ладонь развёрнута вперёд']
  );
  assert.deepEqual(
    [byKey.get('pelvis').landmark, byKey.get('pelvis').posture],
    [
      'Горизонтально по наиболее выступающим точкам подвздошных костей',
      'Стопы вместе — отдельная метрика, не смешивать с hip'
    ]
  );
  assert.deepEqual(
    [byKey.get('wrist').landmark, byKey.get('wrist').posture],
    ['Обхват по косточке запястья, ниже шиловидного отростка', 'Рука расслаблена']
  );
  assert.deepEqual(
    [byKey.get('finger_index').landmark, byKey.get('finger_index').posture],
    [
      'Правая рука, обхват у основания указательного пальца — там, где сидит кольцо',
      'Вечером, пальцы тёплые. Отдельно проверить, что кольцо проходит через костяшку'
    ]
  );
});

await step('catalog.js отдаёт пятнадцать строк фигуры в порядке групп макета', async () => {
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key)
  };
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => structuredClone(catalogRaw)
  });

  const catalog = await import('./catalog.js');
  await catalog.loadCatalog();
  assert.deepEqual(catalog.figureMeasurements().map((item) => item.key), FIGURE_KEYS);
  assert.ok(catalog.figureMeasurements().every(Object.isFrozen));
  assert.ok(catalog.figureMeasurements().every((item) => Object.isFrozen(item.ui_range)));
});

await step('asof.js остаётся чистым и экспортирует один источник Δ', async () => {
  const source = readFileSync(new URL('./asof.js', import.meta.url), 'utf8');
  assert.ok(!/^\s*import\s/m.test(source), 'у среза появилась зависимость');
  for (const forbidden of ['document', 'window', 'localStorage', 'fetch', 'XMLHttpRequest']) {
    assert.ok(!new RegExp(`\\b${forbidden}\\b`).test(source), `найден запрещённый API: ${forbidden}`);
  }
  assert.deepEqual(Object.keys(await import('./asof.js')).sort(), ['delta', 'sliceAt', 'sliceDates']);
});

console.log(`Итог: ${passed} ок, ${failed} провалено.`);
process.exitCode = failed === 0 ? 0 : 1;
