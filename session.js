// Сборка файла сессии по §6.1 спеки и правила измерения §5.3 / §7.2 (T5, контракт §6).
//
// Файл сессии иммутабелен: исправление — это новая сессия с note, а не правка
// старой (§6.1 спеки, чек-лист §10). Поэтому модуль умеет ровно одно —
// собрать новый файл. Функции правки существующего здесь нет и появиться
// не должно: пока её нет в session.js, у UI просто нет такого пути.
//
// Ни DOM, ни сети, ни localStorage: чистая логика, которую целиком проверяет
// node (session.selftest.mjs). Записью в repo B занимается экран ввода.
//
// Сквозная мелочь, из-за которой здесь везде округление: значения приходят
// с одним знаком после запятой, но во float 64.4 - 63.4 равно
// 1.000000000000007. Голое сравнение с порогом сделало бы предупреждение
// «разброс больше 1 см» случайным — оно зависело бы от самих чисел, а не
// от разности. Сравниваем то же число, которое показываем пользователю.

import { getMeasurement } from './catalog.js';

// §5.3 спеки: «Разброс между повторами > 1 см — перемерить».
const SPREAD_LIMIT = 1;
// §7.2 спеки: отклонение от предыдущего значения > 5 см требует подтверждения.
const DEVIATION_LIMIT = 5;

// Подписи единиц для текста предупреждений. Коды (cm, kg) уходят в файл как есть.
const UNITS = new Map([['cm', 'см'], ['kg', 'кг']]);

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(\d{2}):(\d{2})$/;

// ===== Числа ==============================================================

// Повторы приходят из полей формы строками, а на телефоне десятичный
// разделитель — запятая. Всё, что не разбирается в конечное число
// (пустая строка, null, NaN, объект), отбрасывается, а не превращается в 0.
function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(',', '.');
  if (text === '') return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function finiteNumbers(values) {
  if (!Array.isArray(values)) return [];
  const result = [];
  for (const item of values) {
    const number = toNumber(item);
    if (number !== null) result.push(number);
  }
  return result;
}

// Округление до 0,1, половинки вверх. Число сначала подрезается до шести
// знаков: (10.1 + 10.2) / 2 во float даёт 10.149999999999999, и наивный
// Math.round вернул бы 10,1 вместо 10,2.
function roundTenth(value) {
  return Math.round(Number((value * 10).toFixed(6))) / 10;
}

// Десятичная запятая, без хвостовых нулей, вручную — без toLocaleString:
// результат обязан совпадать в браузере и в node с урезанным ICU
// (решение T4, §13 контракта).
function formatNumber(value) {
  return String(roundTenth(value)).replace('.', ',');
}

// ===== Каталог ============================================================

// Код единицы для файла сессии. Каталог грузит экран; если его нет
// или ключ незнакомый — пустая строка, но сборка не срывается.
function unitCode(key) {
  const measurement = getMeasurement(key);
  if (!measurement || typeof measurement.unit !== 'string') return '';
  return measurement.unit.trim();
}

// Подпись единицы для текста предупреждения. Незнакомый код показываем
// как есть — врать про него нечего.
function unitLabel(key) {
  const code = unitCode(key);
  if (code === '') return '';
  return UNITS.get(code) ?? code;
}

// '1,4' либо '1,4 см'.
function withUnit(value, unit) {
  const text = formatNumber(value);
  return unit === '' ? text : `${text} ${unit}`;
}

// ===== Медиана ============================================================

// [86.5, 87.0, 86.8] -> 86.8. Чётное число повторов -> среднее двух средних.
// Ни одного числа -> null: ноль здесь означал бы «намерили ноль».
export function median(values) {
  const list = finiteNumbers(values);
  if (list.length === 0) return null;

  const sorted = list.slice().sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  const value = sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;

  return roundTenth(value);
}

// ===== Правила измерения ==================================================

// -> { warnings: [ { code, message, requiresConfirm } ] }
// Пустой список предупреждений — нормальный результат, а не ошибка.
export function validateReps(key, raw, previousValue) {
  const list = finiteNumbers(raw);
  const unit = unitLabel(key);
  const warnings = [];

  // Разброса не существует при одном повторе: у веса и статики reps = 1.
  if (list.length > 1) {
    const spread = roundTenth(Math.max(...list) - Math.min(...list));
    if (spread > SPREAD_LIMIT) {
      warnings.push({
        code: 'spread',
        message: `Разброс между повторами ${withUnit(spread, unit)} — больше ${withUnit(SPREAD_LIMIT, unit)}. Стоит перемерить.`,
        requiresConfirm: false
      });
    }
  }

  const value = median(list);
  const previous = toNumber(previousValue);
  // Первый замер сравнивать не с чем — это не повод предупреждать.
  if (value !== null && previous !== null) {
    const deviation = roundTenth(Math.abs(value - previous));
    if (deviation > DEVIATION_LIMIT) {
      warnings.push({
        code: 'deviation',
        message: `Отклонение от предыдущего значения ${withUnit(deviation, unit)} (было ${withUnit(previous, unit)}, стало ${withUnit(value, unit)}) — больше ${withUnit(DEVIATION_LIMIT, unit)}. Проверь замер и подтверди.`,
        requiresConfirm: true
      });
    }
  }

  return { warnings };
}

// ===== Проверка полей сессии ==============================================

// Значение в текст ошибки: пользователь должен увидеть, что именно не так.
function quote(value) {
  const text = typeof value === 'string' ? value.trim() : String(value);
  return text === '' ? 'пустая строка' : `«${text}»`;
}

// 'YYYY-MM-DD' -> та же строка. Отсекается и 2026-02-31: календарь
// проверяется обратным сравнением через Date.UTC, а не одной регуляркой.
function requireDate(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  const match = DATE_PATTERN.exec(text);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const probe = new Date(Date.UTC(year, month - 1, day));
    if (probe.getUTCFullYear() === year
      && probe.getUTCMonth() === month - 1
      && probe.getUTCDate() === day) {
      return text;
    }
  }
  throw new Error(`Дата сессии задана неверно: ${quote(value)}. Ожидается формат ГГГГ-ММ-ДД.`);
}

// 'HH:MM' -> та же строка. Секунд в схеме §6.1 нет.
function requireTime(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  const match = TIME_PATTERN.exec(text);
  if (match && Number(match[1]) <= 23 && Number(match[2]) <= 59) return text;
  throw new Error(`Время сессии задано неверно: ${quote(value)}. Ожидается формат ЧЧ:ММ.`);
}

// Корневой protocol_version из catalog.json. Мусор — ошибка, а не тихая
// единица по умолчанию: версия решает, с чем значение вообще можно
// сравнивать (§5 спеки), и подделанная версия портит весь ряд.
function requireVersion(value) {
  const number = toNumber(value);
  if (number === null || !Number.isInteger(number) || number < 1) {
    throw new Error(`Версия протокола задана неверно: ${quote(value)}. Ожидается целое число не меньше 1.`);
  }
  return number;
}

// Порядок ключей — как в §6.1.
function buildConditions(source) {
  const raw = source && typeof source === 'object' ? source : {};
  const hours = toNumber(raw.hours_since_training);
  return {
    // Строго булевы: 'on' или 'да' вместо checkbox.checked — баг вызывающего
    // кода, и записывать по нему согласие в файл нельзя.
    fasted: raw.fasted === true,
    post_void: raw.post_void === true,
    // Поле необязательное: не заполнено — null, а не 0. Ноль часов означает
    // «тренировка только что», это совсем другое утверждение.
    hours_since_training: hours !== null && hours >= 0 ? hours : null
  };
}

function buildEntries(list, version) {
  const source = Array.isArray(list) ? list : [];
  const result = [];

  for (const item of source) {
    if (!item || typeof item !== 'object') continue;
    const key = typeof item.key === 'string' ? item.key.trim() : '';
    if (key === '') continue;

    const raw = finiteNumbers(item.raw);
    // Замер, который не мерили, в файл не попадает: запись с пустым raw
    // неотличима от нуля и испортила бы ряд в index.json.
    if (raw.length === 0) continue;

    // Порядок ключей — как в §6.1: файл читают глазами прямо в GitHub.
    result.push({
      key,
      raw,
      value: median(raw),
      unit: unitCode(key),
      // Сегодня версия одна на весь каталог, поэтому у всех записей она
      // общая. Когда методика отдельного замера изменится (§5 спеки),
      // у записи каталога появится собственный protocol_version, и брать
      // его надо будет оттуда — схема файла при этом не меняется.
      protocol_version: version,
      note: typeof item.note === 'string' ? item.note.trim() : ''
    });
  }

  return result;
}

// entries на входе: [ { key, raw: number[], note } ].
// -> объект ровно по §6.1, без единого лишнего поля.
export function buildSession({ date, time, protocolVersion, conditions, entries } = {}) {
  const sessionDate = requireDate(date);
  const sessionTime = requireTime(time);
  const version = requireVersion(protocolVersion);
  const list = buildEntries(entries, version);

  if (list.length === 0) {
    throw new Error('В сессии нет ни одного значения — сохранять нечего. Введи хотя бы один замер.');
  }

  return {
    date: sessionDate,
    time: sessionTime,
    protocol_version: version,
    conditions: buildConditions(conditions),
    entries: list
  };
}

// ===== Имя файла ==========================================================

// '2026-08-14' -> '2026-08-14.json', при коллизии '2026-08-14--2.json'.
// existingNames — имена файлов (не пути) из data/, посторонние допускаются.
export function sessionFileName(date, existingNames) {
  const day = requireDate(date);

  const taken = new Set();
  if (Array.isArray(existingNames)) {
    for (const name of existingNames) {
      if (typeof name !== 'string') continue;
      const text = name.trim();
      // Регистр не различаем: на macOS и Windows '...JSON' — тот же файл,
      // и запись по такому имени затёрла бы чужую сессию.
      if (text !== '') taken.add(text.toLowerCase());
    }
  }

  const first = `${day}.json`;
  if (!taken.has(first.toLowerCase())) return first;

  // Первый свободный номер, а не следующий за максимальным: если файл
  // удалили руками, дыра должна заполниться. Цикл конечен — имён в списке
  // конечное число, и каждый шаг съедает одно из них.
  for (let number = 2; ; number += 1) {
    const name = `${day}--${number}.json`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}
