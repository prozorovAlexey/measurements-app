// Самопроверка SVG-спарклайна T8. Только stdlib и минимальный SVG DOM.
//
//   C:\Users\user\AppData\Roaming\nvm\v24.4.0\node.exe sparkline.selftest.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function createNode(tag) {
  const classes = new Set();
  const node = {
    tagName: String(tag).toUpperCase(),
    children: [],
    attributes: new Map()
  };
  Object.defineProperty(node, 'className', {
    get: () => Array.from(classes).join(' '),
    set: (value) => {
      classes.clear();
      for (const name of String(value ?? '').split(/\s+/)) if (name) classes.add(name);
    }
  });
  node.classList = {
    add: (...names) => { for (const name of names) if (name) classes.add(name); },
    contains: (name) => classes.has(name)
  };
  node.setAttribute = (name, value) => {
    node.attributes.set(name, String(value));
    if (name === 'class') node.className = value;
  };
  node.getAttribute = (name) => node.attributes.get(name) ?? null;
  node.append = (...children) => { node.children.push(...children); };
  return node;
}

globalThis.document = {
  createElementNS: (_namespace, tag) => createNode(tag)
};

const { sparkline } = await import('./sparkline.js');

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

await step('пустая или битая серия отдаёт пустой SVG, а не падает', () => {
  const svg = sparkline([{ date: 'не дата', value: 10 }, { date: '2026-01-01', value: NaN }]);
  assert.equal(svg.tagName, 'SVG');
  assert.equal(svg.children.length, 0);
  assert.ok(svg.classList.contains('sparkline--empty'));
});

await step('точки сортируются, координаты конечны, размеры попадают в viewBox', () => {
  const svg = sparkline([
    { date: '2026-03-01', value: 86, protocol_version: 1 },
    { date: '2026-01-01', value: 88, protocol_version: 1 }
  ], { width: 300, height: 60 });
  assert.equal(svg.getAttribute('viewBox'), '0 0 300 60');
  assert.equal(svg.children.length, 1);
  assert.match(svg.children[0].getAttribute('d'), /^M 3 3 L 297 57$/);
  assert.ok(!/NaN|Infinity/.test(svg.children[0].getAttribute('d')));
});

await step('смена protocol_version разрывает линию и визуально помечает старую', () => {
  const svg = sparkline([
    { date: '2026-01-01', value: 88, protocol_version: 1 },
    { date: '2026-02-01', value: 87, protocol_version: 1 },
    { date: '2026-03-01', value: 86.5, protocol_version: 2 }
  ]);
  assert.equal(svg.children.length, 2, 'версии соединены одним path');
  assert.equal(svg.children[0].getAttribute('data-protocol-version'), '1');
  assert.ok(svg.children[0].classList.contains('sparkline__line--previous'));
  assert.equal(svg.children[1].getAttribute('data-protocol-version'), '2');
  assert.ok(svg.children[1].classList.contains('sparkline__line--current'));
});

await step('одна точка остаётся видимым path и не даёт NaN', () => {
  const svg = sparkline([{ date: '2026-01-01', value: 64.2, protocol_version: 1 }]);
  assert.equal(svg.children.length, 1);
  assert.match(svg.children[0].getAttribute('d'), /^M .+ L .+$/);
  assert.ok(!/NaN|Infinity/.test(svg.children[0].getAttribute('d')));
});

await step('экстремальные размеры и значения остаются внутри viewBox', () => {
  for (const options of [
    { width: 0.25, height: 0.5 },
    { width: Number.MAX_VALUE, height: 1 }
  ]) {
    const svg = sparkline([
      { date: '2026-01-01', value: -1e308, protocol_version: 1 },
      { date: '2026-02-01', value: 0, protocol_version: 1 },
      { date: '2026-03-01', value: 1e308, protocol_version: 1 }
    ], options);
    const d = svg.children[0].getAttribute('d');
    assert.ok(!/NaN|Infinity/.test(d), d);
    const coordinates = d.match(/-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi).map(Number);
    for (let index = 0; index < coordinates.length; index += 2) {
      assert.ok(coordinates[index] >= 0 && coordinates[index] <= options.width, `x=${coordinates[index]}`);
      assert.ok(coordinates[index + 1] >= 0 && coordinates[index + 1] <= options.height, `y=${coordinates[index + 1]}`);
    }
  }
});

await step('без библиотек: модуль не импортирует зависимости и классы есть в CSS', () => {
  const source = readFileSync(new URL('./sparkline.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8');
  assert.ok(!/^\s*import\s/m.test(source), 'у спарклайна появилась зависимость');
  assert.match(source, /document\.createElementNS/);
  for (const name of ['sparkline', 'sparkline__line', 'sparkline__line--previous']) {
    assert.ok(css.includes(`.${name}`), `нет .${name} в style.css`);
  }
});

console.log(`Итог: ${passed} ок, ${failed} провалено.`);
process.exitCode = failed === 0 ? 0 : 1;
