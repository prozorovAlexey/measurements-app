// Загрузка catalog.json и выборки по нему (§5 контракта).
//
// Мемоизируется промис, а не результат: два экрана, стартовавшие одновременно,
// делят один fetch. Провал не запоминается — следующий вызов обязан
// попробовать снова.
//
// Про localStorage модуль не знает: офлайн-копия каталога живёт в store.js.
// До появления service worker (T7) это единственный способ открыть шпаргалку
// в авиарежиме — требование §8 спеки «отрисована < 1 с при холодном старте».
//
// Синхронные геттеры до loadCatalog() не падают, а отдают пустой результат:
// экран, вызвавший их раньше времени, нарисует каркас, а не белый экран.

import { getCatalogCache, setCatalogCache } from './store.js';

const CATALOG_URL = './catalog.json';

let pending = null; // промис загрузки, пока она идёт или уже удалась
let entries = []; // порядок — строго как в файле, пересортировки нет нигде
let index = new Map();

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
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
      show_in_cheatsheet: item.show_in_cheatsheet !== false
    }));
  }

  return result;
}

function apply(list) {
  entries = Object.freeze(list);
  index = new Map(list.map((item) => [item.key, item]));
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
    const cached = getCatalogCache();
    list = normalize(cached ? cached.data : null);
  }

  if (list.length === 0) {
    throw new Error('Каталог замеров не загрузился. Проверь подключение и повтори.');
  }

  apply(list);
  return list;
}

// -> массив записей в порядке catalog.json.
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
