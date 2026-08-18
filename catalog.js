// Загрузка catalog.json и выборки по нему (§5 контракта).
//
// Мемоизируется промис, а не результат: два экрана, стартовавшие одновременно,
// делят один fetch. Провал не запоминается — следующий вызов обязан
// попробовать снова.
//
// Про хранилище браузера модуль не знает: офлайн-копия каталога живёт
// в store.js — единственном месте проекта, которое с ним работает (§3).
// С T7 первым офлайн-слоем стал service worker (network-first на catalog.json),
// копия в store.js осталась вторым: она работает и там, где SW не поднялся —
// в приватном окне и на http:// без TLS. Требование §8 спеки «отрисована < 1 с
// при холодном старте» закрывают оба слоя.
//
// Синхронные геттеры до loadCatalog() не падают, а отдают пустой результат:
// экран, вызвавший их раньше времени, нарисует каркас, а не белый экран.

import { getCatalogCache, setCatalogCache } from './store.js';

const CATALOG_URL = './catalog.json';

// Версия методики из корня catalog.json (§6.3). Ею штампуется каждая запись
// сессии: без неё нельзя понять, с чем значение вообще сравнимо (§5 спеки).
const DEFAULT_PROTOCOL_VERSION = 1;
const DIRECTIONS = new Set(['down', 'up', 'none']);
const SIZE_SCALES = new Set(['clothing', 'shirt', 'jeans', 'shoe', 'ring']);
const FIGURE_ORDER = Object.freeze([
  'weight', 'height',
  'neck', 'shoulder_width', 'chest', 'waist_who', 'pelvis', 'hip',
  'biceps_relaxed', 'forearm', 'wrist', 'finger_index',
  'thigh', 'calf', 'foot_length'
]);

let pending = null; // промис загрузки, пока она идёт или уже удалась
let entries = []; // порядок — строго как в файле, пересортировки нет нигде
let index = new Map();
let rootVersion = DEFAULT_PROTOCOL_VERSION;

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function normalizeRange(value) {
  if (
    !value
    || !Number.isFinite(value.min)
    || !Number.isFinite(value.max)
    || !Number.isFinite(value.step)
    || value.min >= value.max
    || value.step <= 0
  ) {
    return null;
  }

  return Object.freeze({ min: value.min, max: value.max, step: value.step });
}

// Сырой JSON -> неизменяемый список записей §6.3 спеки.
// Запись без key или label отбрасывается: строка без подписи бесполезна.
function normalize(raw) {
  const list = raw && Array.isArray(raw.measurements) ? raw.measurements : [];
  const result = [];
  const seen = new Set();

  for (const item of list) {
    if (!item || !nonEmptyString(item.key) || !nonEmptyString(item.label)) continue;
    const key = item.key.trim();
    if (seen.has(key)) continue; // дубль ключа — остаётся первый
    seen.add(key);

    result.push(Object.freeze({
      key,
      label: item.label.trim(),
      // Неизвестный класс считаем динамическим: статика — исключение, которое
      // помечается явно, и её frequency_days обязан быть null.
      class: item.class === 'static' ? 'static' : 'dynamic',
      unit: nonEmptyString(item.unit) ? item.unit.trim() : '',
      reps: Number.isFinite(item.reps) && item.reps > 0 ? Math.floor(item.reps) : 1,
      frequency_days: Number.isFinite(item.frequency_days) && item.frequency_days > 0
        ? Math.floor(item.frequency_days)
        : null,
      landmark: typeof item.landmark === 'string' ? item.landmark : '',
      posture: typeof item.posture === 'string' ? item.posture : '',
      show_in_cheatsheet: item.show_in_cheatsheet !== false,
      svg_id: nonEmptyString(item.svg_id) ? item.svg_id.trim() : null,
      direction: DIRECTIONS.has(item.direction) ? item.direction : 'none',
      ui_range: normalizeRange(item.ui_range),
      show_on_figure: item.show_on_figure === true,
      size_scale: SIZE_SCALES.has(item.size_scale) ? item.size_scale : null
    }));
  }

  return result;
}

function apply(list, raw) {
  entries = Object.freeze(list);
  index = new Map(list.map((item) => [item.key, item]));
  const version = raw ? raw.protocol_version : null;
  rootVersion = Number.isInteger(version) && version >= 1 ? version : DEFAULT_PROTOCOL_VERSION;
}

async function fetchCatalog() {
  let raw = null;
  try {
    // no-cache, а не no-store: после деплоя каталог обязан обновиться,
    // а офлайн-сценарий закрыт копией в store.js.
    const response = await fetch(CATALOG_URL, { cache: 'no-cache' });
    if (response.ok) raw = await response.json();
  } catch {
    // Нет сети или битый JSON — уходим в офлайн-копию.
  }

  let list = normalize(raw);
  if (list.length > 0) {
    setCatalogCache(raw);
  } else {
    // Версию берём из того же источника, что и список: иначе запись сессии
    // ушла бы с версией по умолчанию, не имеющей отношения к данным.
    const cached = getCatalogCache();
    raw = cached ? cached.data : null;
    list = normalize(raw);
  }

  if (list.length === 0) {
    throw new Error('Каталог замеров не загрузился. Проверь подключение и повтори.');
  }

  apply(list, raw);
  return list;
}

// -> массив записей в порядке catalog.json.
// Синхронная гидрация нужна T12 для настоящей первой отрисовки из кэша:
// pending она не заполняет, поэтому следующий loadCatalog() по-прежнему
// обязательно выполняет существующую network-first ревалидацию.
export function loadCachedCatalog() {
  // pending хранится и во время запроса, и после успешного resolve. В обоих
  // состояниях entries уже принадлежат этому же жизненному циклу loadCatalog:
  // повторный apply() из изменившегося localStorage рассогласовал бы геттеры
  // с массивом, который возвращает memoized promise.
  if (pending) return entries;
  const cached = getCatalogCache();
  const raw = cached ? cached.data : null;
  const list = normalize(raw);
  if (list.length === 0) return [];
  apply(list, raw);
  return list;
}

export async function loadCatalog() {
  if (pending) return pending;
  pending = fetchCatalog();
  // Неудачная попытка не должна запомниться: сбрасываем мемоизацию.
  // Обработчик навешан раньше пользовательского await, поэтому к моменту
  // повторного вызова pending уже обнулён.
  pending.catch(() => {
    pending = null;
  });
  return pending;
}

export function getMeasurement(key) {
  if (!nonEmptyString(key)) return null;
  return index.get(key.trim()) ?? null;
}

// Каждая выборка отдаёт новый массив: сами записи заморожены,
// но список вызывающий код может сортировать и резать как угодно.

export function dynamicMeasurements() {
  return entries.filter((item) => item.class === 'dynamic');
}

export function staticMeasurements() {
  return entries.filter((item) => item.class === 'static');
}

export function cheatsheetMeasurements() {
  return entries.filter((item) => item.show_in_cheatsheet);
}

export function figureMeasurements() {
  return FIGURE_ORDER
    .map((key) => index.get(key))
    .filter((item) => item?.show_on_figure === true);
}

// Версия методики для штампа записей сессии (§6.1). До загрузки каталога —
// значение по умолчанию: экран ввода всё равно ждёт loadCatalog().
// Когда методика отдельного замера начнёт версионироваться (§5 спеки),
// поле появится у записи каталога и приоритет будет у него.
export function protocolVersion() {
  return rootVersion;
}
