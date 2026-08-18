// Автотест session.js (T5, контракт §6): медиана, правила §5.3 и §7.2,
// схема файла сессии §6.1, имя файла.
//
// Запуск (node на PATH — v6.17.1, ES-модулей не понимает, §12 контракта):
//
//   C:\Users\user\AppData\Roaming\nvm\v24.4.0\node.exe session.selftest.mjs
//
// Только stdlib: ни npm-пакетов, ни тест-раннера (§0 контракта).
//
// Мини-DOM здесь не нужен: session.js не знает ни про document, ни про сеть.
// Подменяется единственная косвенная зависимость — fetch. Модуль тянет
// catalog.js, а тот берёт catalog.json запросом (§5 контракта); в node
// относительный './catalog.json' не разрешается, поэтому отдаём файл
// с диска — тем же приёмом, что и cheatsheet.selftest.mjs.
// localStorage не подставляем намеренно: store.js ловит его отсутствие сам,
// офлайн-копии каталога в тесте не заводится, и проверка «каталог ещё
// не загружен» ниже работает честно. Она обязана идти первой: каталог
// мемоизирован в модуле и выгрузить его обратно нельзя.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CATALOG_PATH = new URL('./catalog.json', import.meta.url);

globalThis.fetch = async (url) => {
  // Сети в тесте быть не должно вообще: §0 запрещает посторонние хосты,
  // а лишний запрос означал бы, что session.js завёл свою зависимость.
  assert.ok(String(url).includes('catalog.json'), `неожиданный запрос: ${url}`);
  return { ok: true, status: 200, json: async () => JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) };
};

const session = await import('./session.js');
const catalog = await import('./catalog.js');

const { median, validateReps, buildSession, sessionFileName } = session;

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

// Проверяем не только факт исключения, но и что текст русский и по делу:
// пользователю нельзя показывать голое «ошибка» (§4 контракта, T2).
function russian(fragment) {
  return (error) => {
    assert.ok(error instanceof Error, `ожидалось Error, получено ${typeof error}`);
    assert.match(error.message, /[а-яё]/i, `текст не русский: ${error.message}`);
    assert.ok(error.message.includes(fragment), `в тексте нет «${fragment}»: ${error.message}`);
    return true;
  };
}

// Сессия §6.1 целиком — база для проверок отдельных полей.
const BASE = Object.freeze({
  date: '2026-08-14',
  time: '07:20',
  protocolVersion: 1,
  conditions: { fasted: true, post_void: true, hours_since_training: 24 },
  entries: [{ key: 'waist_who', raw: [86.5, 87.0, 86.8], note: '' }]
});

console.log('Самопроверка T5: session.js');

// --- Каталог ещё не загружен (эти проверки обязаны идти первыми) ----------

await step('validateReps: каталога нет — сообщение без единицы, функция не падает', () => {
  const { warnings } = validateReps('waist_who', [86.5, 88.2, 87.0], null);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, 'spread');
  assert.ok(warnings[0].message.includes('1,7'), warnings[0].message);
  assert.ok(!warnings[0].message.includes('см'), `единица взялась из ниоткуда: ${warnings[0].message}`);
});

await step('buildSession: каталога нет — unit пустой, сборка не срывается', () => {
  const file = buildSession(BASE);
  assert.equal(file.entries[0].unit, '');
  assert.equal(file.entries[0].value, 86.8);
});

await step('каталог загружается — дальше единицы берутся из него', async () => {
  const list = await catalog.loadCatalog();
  assert.equal(list.length, 22, 'в catalog.json должно быть 22 замера (§5 спеки)');
  assert.equal(catalog.getMeasurement('waist_who').unit, 'cm');
  assert.equal(catalog.getMeasurement('weight').unit, 'kg');
});

// --- Медиана --------------------------------------------------------------

await step('median: нечётное число повторов — средний элемент', () => {
  assert.equal(median([86.5, 87.0, 86.8]), 86.8);
  assert.equal(median([87.0, 86.5, 86.8]), 86.8, 'порядок ввода не важен');
  assert.equal(median([1, 2, 3, 4, 100]), 3);
});

await step('median: чётное число повторов — среднее двух средних', () => {
  assert.equal(median([86.4, 86.6]), 86.5);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  // Ширина стопы: (10.1 + 10.2) / 2 во float это 10.149999999999999,
  // наивный Math.round дал бы 10,1.
  assert.equal(median([10.1, 10.2]), 10.2);
});

await step('median: один повтор — он же и медиана', () => {
  assert.equal(median([70.4]), 70.4);
  assert.equal(median([178]), 178);
  assert.equal(median(['86,8']), 86.8, 'запятая с телефонной клавиатуры');
});

await step('median: округление до 0,1, половинки вверх', () => {
  assert.equal(median([86.44]), 86.4);
  assert.equal(median([86.45]), 86.5);
  assert.equal(median([86.85]), 86.9);
  assert.equal(median([86.80000000000001]), 86.8, 'хвост float съеден');
});

await step('median: нечисловые элементы отбрасываются, а не роняют функцию', () => {
  assert.equal(median([86.5, null, undefined, Number.NaN, Number.POSITIVE_INFINITY, 'абв', {}, [], true, 87.0, 86.8]), 86.8);
  assert.equal(median(['86,5', '87.0', '86,8']), 86.8);
  assert.equal(median([86.5, '', '   ', 87.5]), 87, 'пустая строка — это не ноль');
});

await step('median: пустой список и ни одного числа — null', () => {
  assert.equal(median([]), null);
  assert.equal(median(['абв', null, Number.NaN, {}]), null);
  assert.equal(median(null), null);
  assert.equal(median(undefined), null);
  assert.equal(median('86.8'), null, 'не массив — не список повторов');
});

// --- Разброс между повторами (§5.3) ---------------------------------------

await step('validateReps: разброс ровно 1 — молчим, 1,1 — предупреждаем', () => {
  assert.deepEqual(validateReps('waist_who', [86.5, 87.5, 87.0], null).warnings, []);
  const { warnings } = validateReps('waist_who', [86.5, 87.6, 87.0], null);
  assert.equal(warnings.length, 1);
  assert.deepEqual(Object.keys(warnings[0]), ['code', 'message', 'requiresConfirm']);
  assert.equal(warnings[0].code, 'spread');
  assert.equal(warnings[0].requiresConfirm, false);
  assert.ok(warnings[0].message.includes('1,1'), `нет самого разброса: ${warnings[0].message}`);
  assert.ok(warnings[0].message.includes('см'), warnings[0].message);
});

await step('validateReps: граница считается по округлённому разбросу, не по float', () => {
  // 64.4 - 63.4 во float это 1.000000000000007. Голое сравнение с порогом
  // выдало бы предупреждение на разбросе ровно в 1 см.
  assert.deepEqual(validateReps('thigh', [63.4, 64.4, 64.0], null).warnings, []);
  assert.deepEqual(validateReps('calf', [63.9, 64.9], null).warnings, []);
});

await step('validateReps: один повтор — разброса не существует', () => {
  assert.deepEqual(validateReps('weight', [70.2], null).warnings, []);
  assert.deepEqual(validateReps('height', [178], null).warnings, []);
  assert.deepEqual(validateReps('waist_who', [], null).warnings, []);
  // Из трёх полей заполнено одно — сравнивать по-прежнему нечего.
  assert.deepEqual(validateReps('waist_who', [86.5, '', null], null).warnings, []);
});

// --- Отклонение от предыдущего значения (§7.2) ----------------------------

await step('validateReps: отклонение ровно 5 — молчим, 5,1 — предупреждаем', () => {
  assert.deepEqual(validateReps('waist_who', [86.8, 86.8, 86.8], 81.8).warnings, []);
  assert.deepEqual(validateReps('waist_who', [86.8, 86.8, 86.8], 91.8).warnings, [], 'знак не важен');
  const { warnings } = validateReps('waist_who', [86.8, 86.8, 86.8], 81.7);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, 'deviation');
  assert.equal(warnings[0].requiresConfirm, true, '§7.2 требует подтверждения');
  assert.ok(warnings[0].message.includes('5,1'), `нет самого отклонения: ${warnings[0].message}`);
  assert.ok(warnings[0].message.includes('81,7') && warnings[0].message.includes('86,8'), warnings[0].message);
});

await step('validateReps: граница отклонения тоже не плывёт от float', () => {
  // 64.4 - 59.4 во float это 5.000000000000007.
  assert.deepEqual(validateReps('weight', [64.4], 59.4).warnings, []);
});

await step('validateReps: первого замера не с чем сравнивать', () => {
  assert.deepEqual(validateReps('waist_who', [86.8], null).warnings, []);
  assert.deepEqual(validateReps('waist_who', [86.8], undefined).warnings, []);
  assert.deepEqual(validateReps('waist_who', [86.8], Number.NaN).warnings, []);
  assert.deepEqual(validateReps('waist_who', [86.8], '').warnings, []);
});

await step('validateReps: оба предупреждения могут сработать одновременно', () => {
  const { warnings } = validateReps('waist_who', [86.0, 88.0, 87.0], 70.0);
  assert.deepEqual(warnings.map((item) => item.code), ['spread', 'deviation']);
  assert.deepEqual(warnings.map((item) => item.requiresConfirm), [false, true]);
});

await step('validateReps: единица из каталога — у веса килограммы', () => {
  const { warnings } = validateReps('weight', [70.4], 60.0);
  assert.equal(warnings[0].code, 'deviation');
  assert.ok(warnings[0].message.includes('кг'), warnings[0].message);
  assert.ok(!warnings[0].message.includes('см'), warnings[0].message);
});

await step('validateReps: незнакомый ключ — сообщение без единицы, без исключения', () => {
  const { warnings } = validateReps('нет_такого_замера', [86.0, 88.0], 70);
  assert.deepEqual(warnings.map((item) => item.code), ['spread', 'deviation']);
  for (const warning of warnings) {
    assert.ok(!/см|кг/.test(warning.message), warning.message);
  }
  assert.deepEqual(validateReps(null, [86.0, 88.0], null).warnings.length, 1);
});

// --- Сборка файла сессии (§6.1) -------------------------------------------

await step('buildSession: результат — ровно схема §6.1, без лишних полей', () => {
  const file = buildSession(BASE);
  assert.deepEqual(Object.keys(file), ['date', 'time', 'protocol_version', 'conditions', 'entries']);
  assert.deepEqual(Object.keys(file.conditions), ['fasted', 'post_void', 'hours_since_training']);
  assert.deepEqual(Object.keys(file.entries[0]), ['key', 'raw', 'value', 'unit', 'protocol_version', 'note']);
  // Пример из §6.1 спеки дословно.
  assert.deepEqual(file, {
    date: '2026-08-14',
    time: '07:20',
    protocol_version: 1,
    conditions: { fasted: true, post_void: true, hours_since_training: 24 },
    entries: [{
      key: 'waist_who',
      raw: [86.5, 87.0, 86.8],
      value: 86.8,
      unit: 'cm',
      protocol_version: 1,
      note: ''
    }]
  });
});

await step('buildSession: сериализуется в JSON в порядке §6.1', () => {
  const json = JSON.stringify(buildSession(BASE));
  assert.ok(json.startsWith('{"date":"2026-08-14","time":"07:20","protocol_version":1,"conditions":'), json);
  assert.deepEqual(JSON.parse(json), buildSession(BASE), 'потерь при сериализации нет');
});

await step('buildSession: value — медиана, unit из каталога, порядок записей входной', () => {
  const file = buildSession({
    ...BASE,
    entries: [
      { key: 'weight', raw: [70.4] },
      { key: 'waist_who', raw: ['86,5', '87.0', '86,8'], note: '  мерил после душа  ' },
      { key: 'height', raw: [178] }
    ]
  });
  assert.deepEqual(file.entries.map((item) => item.key), ['weight', 'waist_who', 'height']);
  assert.deepEqual(file.entries.map((item) => item.unit), ['kg', 'cm', 'cm']);
  assert.deepEqual(file.entries.map((item) => item.value), [70.4, 86.8, 178]);
  assert.deepEqual(file.entries[1].raw, [86.5, 87, 86.8], 'строки нормализованы в числа');
  assert.equal(file.entries[1].note, 'мерил после душа');
  assert.equal(file.entries[0].note, '', 'note по умолчанию — пустая строка');
});

await step('buildSession: запись без единого числа в raw в файл не попадает', () => {
  const file = buildSession({
    ...BASE,
    entries: [
      { key: 'waist_who', raw: [86.5, 87.0, 86.8] },
      { key: 'hip', raw: [] },
      { key: 'chest', raw: ['', null, 'абв'] },
      { key: 'neck', raw: null },
      { key: '   ', raw: [40] },
      null,
      { key: 'calf', raw: [38.2, ''] }
    ]
  });
  assert.deepEqual(file.entries.map((item) => item.key), ['waist_who', 'calf']);
  assert.deepEqual(file.entries[1].raw, [38.2]);
});

await step('buildSession: пустая сессия — ошибка по-русски', () => {
  assert.throws(() => buildSession({ ...BASE, entries: [] }), russian('нет ни одного значения'));
  assert.throws(() => buildSession({ ...BASE, entries: undefined }), russian('нет ни одного значения'));
  assert.throws(() => buildSession({ ...BASE, entries: [{ key: 'hip', raw: [] }] }), russian('нет ни одного значения'));
});

await step('buildSession: невалидная дата — ошибка с внятным текстом', () => {
  const bad = ['', '   ', '14.08.2026', '2026-8-14', '2026-13-01', '2026-02-31',
    '2026-08-14T07:20:00Z', '2026-08-14.json', null, undefined, 20260814, {}];
  for (const value of bad) {
    assert.throws(() => buildSession({ ...BASE, date: value }), russian('Дата сессии'), `прошло: ${String(value)}`);
  }
  assert.equal(buildSession({ ...BASE, date: '2028-02-29' }).date, '2028-02-29', 'високосный год существует');
  assert.equal(buildSession({ ...BASE, date: ' 2026-08-14 ' }).date, '2026-08-14', 'пробелы по краям срезаны');
});

await step('buildSession: невалидное время — ошибка с внятным текстом', () => {
  const bad = ['', '7:20', '25:00', '07:60', '0720', '07:20:00', '07-20', null, undefined, 720];
  for (const value of bad) {
    assert.throws(() => buildSession({ ...BASE, time: value }), russian('Время сессии'), `прошло: ${String(value)}`);
  }
  assert.equal(buildSession({ ...BASE, time: '00:00' }).time, '00:00');
  assert.equal(buildSession({ ...BASE, time: '23:59' }).time, '23:59');
});

await step('buildSession: conditions — строго булевы, часы либо число, либо null', () => {
  assert.deepEqual(buildSession({ ...BASE, conditions: undefined }).conditions,
    { fasted: false, post_void: false, hours_since_training: null });
  assert.deepEqual(buildSession({ ...BASE, conditions: { fasted: true, post_void: false, hours_since_training: '' } }).conditions,
    { fasted: true, post_void: false, hours_since_training: null }, 'поле не заполнено — null, а не 0');
  assert.deepEqual(buildSession({ ...BASE, conditions: { fasted: false, post_void: true, hours_since_training: 0 } }).conditions,
    { fasted: false, post_void: true, hours_since_training: 0 }, 'ноль часов — это значение');
  const loose = buildSession({ ...BASE, conditions: { fasted: 'да', post_void: 1, hours_since_training: '12' } }).conditions;
  assert.equal(loose.fasted, false, 'строка не булево');
  assert.equal(loose.post_void, false);
  assert.equal(loose.hours_since_training, 12);
});

await step('buildSession: protocol_version проставляется и корню, и каждой записи', () => {
  const file = buildSession({
    ...BASE,
    protocolVersion: 3,
    entries: [{ key: 'hip', raw: [95.0] }, { key: 'neck', raw: [38.4] }]
  });
  assert.equal(file.protocol_version, 3);
  assert.deepEqual(file.entries.map((item) => item.protocol_version), [3, 3]);
});

await step('buildSession: версия протокола — целое число, мусор не проходит', () => {
  for (const value of [undefined, null, 0, -1, 1.5, 'один', Number.NaN, {}]) {
    assert.throws(() => buildSession({ ...BASE, protocolVersion: value }), russian('Версия протокола'), `прошло: ${String(value)}`);
  }
  assert.equal(buildSession({ ...BASE, protocolVersion: '2' }).protocol_version, 2);
});

// --- Имя файла сессии -----------------------------------------------------

await step('sessionFileName: свободное имя', () => {
  assert.equal(sessionFileName('2026-08-14', []), '2026-08-14.json');
  assert.equal(sessionFileName('2026-08-14'), '2026-08-14.json');
  assert.equal(sessionFileName('2026-08-14', undefined), '2026-08-14.json');
  assert.equal(sessionFileName('2026-08-14', null), '2026-08-14.json');
});

await step('sessionFileName: одна коллизия и несколько подряд', () => {
  assert.equal(sessionFileName('2026-08-14', ['2026-08-14.json']), '2026-08-14--2.json');
  assert.equal(sessionFileName('2026-08-14', ['2026-08-14.json', '2026-08-14--2.json']), '2026-08-14--3.json');
  assert.equal(sessionFileName('2026-08-14',
    ['2026-08-14--3.json', '2026-08-14.json', '2026-08-14--2.json']), '2026-08-14--4.json', 'порядок списка не важен');
});

await step('sessionFileName: занят номер, но не соседний — берём первый свободный', () => {
  assert.equal(sessionFileName('2026-08-14', ['2026-08-14.json', '2026-08-14--3.json']), '2026-08-14--2.json');
  assert.equal(sessionFileName('2026-08-14', ['2026-08-14--2.json']), '2026-08-14.json', 'базовое имя свободно');
});

await step('sessionFileName: сравнение имён регистронезависимое', () => {
  assert.equal(sessionFileName('2026-08-14', ['2026-08-14.JSON']), '2026-08-14--2.json');
  assert.equal(sessionFileName('2026-08-14', ['2026-08-14.json', '2026-08-14--2.Json']), '2026-08-14--3.json');
});

await step('sessionFileName: посторонние имена и мусор в списке игнорируются', () => {
  assert.equal(sessionFileName('2026-08-14',
    ['index.json', '.gitkeep', 'README.md', '2026-08-13.json', '2026-08-14--2.json', null, 42, {}, '']),
  '2026-08-14.json');
  assert.equal(sessionFileName('2026-08-14', [' 2026-08-14.json ']), '2026-08-14--2.json', 'пробелы по краям не спасают');
  assert.equal(sessionFileName('2026-08-14', ['data/2026-08-14.json']), '2026-08-14.json', 'в списке имена, а не пути');
});

await step('sessionFileName: битая дата — та же ошибка, что и в buildSession', () => {
  assert.throws(() => sessionFileName('14.08.2026', []), russian('Дата сессии'));
  assert.throws(() => sessionFileName(undefined, []), russian('Дата сессии'));
});

// --- Иммутабельность файла сессии (§6.1 спеки, чек-лист §10) --------------

await step('§10: модуль не умеет править сессию — только собирать новую', () => {
  assert.deepEqual(Object.keys(session).sort(),
    ['buildSession', 'median', 'sessionFileName', 'validateReps'],
    'появился экспорт сверх §6 контракта — проверь, не путь ли это к правке старого файла');
});

console.log(`Итог: ${passed} ок, ${failed} провалено.`);
process.exitCode = failed === 0 ? 0 : 1;
