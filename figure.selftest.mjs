// Самопроверка чистой геометрии силуэта T10.
//
//   C:\Users\user\AppData\Roaming\nvm\v24.4.0\node.exe figure.selftest.mjs

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { silhouette } from './figure.js';

const BASE = Object.freeze({
  height: 178,
  neck: 39.5,
  shoulder_width: 46,
  chest: 103,
  waist_who: 83.5,
  pelvis: 99.5,
  hip: 99,
  biceps_relaxed: 36.5,
  forearm: 29.8,
  wrist: 17.5,
  thigh: 57.5,
  calf: 39.8,
  foot_length: 26.5
});

const NODE_BY_KEY = Object.freeze({
  neck: 'neck',
  shoulder_width: 'shoulder',
  chest: 'chest',
  waist_who: 'waist',
  pelvis: 'pelvis',
  hip: 'glutes',
  biceps_relaxed: 'biceps',
  forearm: 'forearm',
  wrist: 'wrist',
  thigh: 'thigh',
  calf: 'calf',
  foot_length: 'foot'
});

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

function nodeWidth(result, name) {
  const node = result.nodes[name];
  return node.x2 - node.x1;
}

function assertFiniteResult(result) {
  assert.deepEqual(Object.keys(result), ['paths', 'nodes', 'ground', 'defaults']);
  assert.equal(result.paths.length, 1, 'силуэт должен быть одним path');
  assert.deepEqual(Object.keys(result.paths[0]), ['d']);
  assert.match(result.paths[0].d, /^M .+ Z$/);
  assert.ok(!/NaN|Infinity/.test(result.paths[0].d), result.paths[0].d);
  assert.ok(Number.isFinite(result.ground.y));
  assert.ok(Number.isFinite(result.ground.r));
  for (const [name, node] of Object.entries(result.nodes)) {
    assert.deepEqual(Object.keys(node), ['y', 'x1', 'x2', 'measured'], name);
    assert.ok(Number.isFinite(node.y), `${name}.y`);
    assert.ok(Number.isFinite(node.x1), `${name}.x1`);
    assert.ok(Number.isFinite(node.x2), `${name}.x2`);
    assert.ok(node.x1 <= node.x2, `${name}: x1 > x2`);
    assert.equal(typeof node.measured, 'boolean', `${name}.measured`);
  }
}

function mockupGeometrySignature(result) {
  const mockupNodes = [
    'shoulder', 'chest', 'waist', 'pelvis', 'glutes', 'neck',
    'biceps', 'forearm', 'thigh', 'calf', 'foot'
  ];
  const nodes = Object.fromEntries(mockupNodes.map((key) => [key, {
    y: result.nodes[key].y,
    x1: result.nodes[key].x1,
    x2: result.nodes[key].x2
  }]));
  const payload = JSON.stringify({ path: result.paths[0].d, nodes, ground: result.ground });
  return createHash('sha256').update(payload).digest('hex');
}

console.log('Самопроверка T10: figure.js');

await step('один вход всегда даёт один и тот же путь и не мутируется', () => {
  const before = JSON.stringify(BASE);
  const first = silhouette(BASE);
  const second = silhouette({ ...BASE });
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(BASE), before);
  assertFiniteResult(first);
  assert.deepEqual(first.defaults, []);
  assert.ok(Object.values(first.nodes).every((node) => node.measured));
});

await step('SVG-контур и узлы побайтово соответствуют механике макета', () => {
  const cases = [
    {
      figure: 'male',
      values: {
        height: 178, neck: 38, chest: 100.5, waist_who: 84, pelvis: 90,
        hip: 98, thigh: 53, calf: 38, biceps_relaxed: 30.5, forearm: 28,
        wrist: 20, shoulder_width: 43, foot_length: 27
      },
      signature: '84bf1f1d310da5e4cb064a823f3059fed32d370fea4a87f6682066077f4ca4d5'
    },
    {
      figure: 'female',
      values: {
        height: 163, neck: 31, chest: 118, waist_who: 67, pelvis: 110,
        hip: 126, thigh: 72, calf: 46, biceps_relaxed: 41, forearm: 33,
        wrist: 14, shoulder_width: 39, foot_length: 23
      },
      signature: '899ee679031006a8db7053eca7ba18f3176f643d5f5b3ad627b4fb200203b13e'
    },
    {
      figure: 'male',
      values: {},
      signature: '3d66cfd04af356a7828b998435345726faec4072f5c969777b6dd0a13edea634'
    }
  ];

  for (const testCase of cases) {
    const result = silhouette(testCase.values, { figure: testCase.figure });
    assert.equal(mockupGeometrySignature(result), testCase.signature);
  }

  const callouts = silhouette(cases[0].values).nodes;
  assert.ok(callouts.calf.x1 > 180, 'голень должна быть привязана справа, как в макете');
  assert.ok(callouts.foot.x2 < 180, 'стопа должна быть привязана слева, как в макете');
});

await step('полуширина монотонно растёт вместе с обхватом', () => {
  const inputs = [1, 10, 20, 30, 40, 50, 70, 100, 150, 1e6];
  for (const [key, node] of Object.entries(NODE_BY_KEY)) {
    const widths = inputs.map((value) => nodeWidth(silhouette({ ...BASE, [key]: value }), node));
    assert.ok(widths.some((value, index) => index > 0 && value > widths[index - 1]), `${key}: нет роста`);
    for (let index = 1; index < widths.length; index += 1) {
      assert.ok(widths[index] >= widths[index - 1], `${key}: ${widths[index - 1]} > ${widths[index]}`);
    }
  }

  const femaleWidths = [70, 85, 100, 110].map((chest) => nodeWidth(
    silhouette({ ...BASE, chest }, { figure: 'female' }),
    'chest'
  ));
  for (let index = 1; index < femaleWidths.length; index += 1) {
    assert.ok(femaleWidths[index] > femaleWidths[index - 1]);
  }
});

await step('анатомические клампы срабатывают на обеих границах', () => {
  for (const [key, node] of Object.entries(NODE_BY_KEY)) {
    const width = (value) => nodeWidth(silhouette({ ...BASE, [key]: value }), node);
    const lower = width(1);
    const upper = width(1e6);
    assert.equal(lower, width(10), `${key}: нижний кламп не удерживает ширину`);
    assert.equal(upper, width(1e9), `${key}: верхний кламп не удерживает ширину`);
    assert.ok(lower < upper, `${key}: границы диапазона схлопнулись`);
  }
});

await step('пропущенные и нечисловые ключи дают дефолт, но не NaN', () => {
  const result = silhouette({ height: 178, chest: Number.NaN, calf: null });
  assertFiniteResult(result);
  assert.ok(result.defaults.includes('chest'));
  assert.ok(result.defaults.includes('calf'));
  assert.ok(!result.defaults.includes('height'));
  assert.equal(result.nodes.chest.measured, false);
  assert.equal(result.nodes.calf.measured, false);

  const empty = silhouette();
  assertFiniteResult(empty);
  assert.deepEqual(empty.defaults, [
    'height', 'neck', 'chest', 'waist_who', 'pelvis', 'hip', 'thigh', 'calf',
    'biceps_relaxed', 'forearm', 'wrist', 'shoulder_width', 'foot_length'
  ]);
  assert.ok(Object.values(empty.nodes).every((node) => !node.measured));
});

await step('узлы pelvis и glutes питаются разными каталожными ключами', () => {
  const base = silhouette(BASE);
  const widerPelvis = silhouette({ ...BASE, pelvis: 105 });
  const widerGlutes = silhouette({ ...BASE, hip: 105 });
  assert.ok(nodeWidth(widerPelvis, 'pelvis') > nodeWidth(base, 'pelvis'));
  assert.equal(nodeWidth(widerPelvis, 'glutes'), nodeWidth(base, 'glutes'));
  assert.ok(nodeWidth(widerGlutes, 'glutes') > nodeWidth(base, 'glutes'));
  assert.equal(nodeWidth(widerGlutes, 'pelvis'), nodeWidth(base, 'pelvis'));
});

await step('женская геометрия детерминирована, неизвестный вариант откатывается к мужскому', () => {
  const male = silhouette(BASE);
  const female = silhouette(BASE, { figure: 'female' });
  assert.notEqual(female.paths[0].d, male.paths[0].d);
  assert.deepEqual(female, silhouette(BASE, { figure: 'female' }));
  assert.deepEqual(male, silhouette(BASE, { figure: 'неизвестно' }));
});

await step('модуль остаётся чистым и не тянет зависимости', async () => {
  const source = readFileSync(new URL('./figure.js', import.meta.url), 'utf8');
  assert.ok(!/^\s*import\s/m.test(source), 'у геометрии появилась зависимость');
  for (const forbidden of ['document', 'window', 'localStorage', 'fetch', 'XMLHttpRequest']) {
    assert.ok(!new RegExp(`\\b${forbidden}\\b`).test(source), `найден запрещённый API: ${forbidden}`);
  }
  assert.deepEqual(Object.keys(await import('./figure.js')), ['silhouette']);
});

console.log(`Итог: ${passed} ок, ${failed} провалено.`);
process.exitCode = failed === 0 ? 0 : 1;
