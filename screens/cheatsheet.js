// Шпаргалка — стартовый экран (§7.1 спеки, T4).
//
// Сквозное правило контракта (§13): устаревшие значения не скрываются никогда.
// Замер старше frequency_days x 2 получает приглушённую дату (.date--stale)
// и остаётся на своём месте в полном размере. Ни одной ветки, которая
// выбрасывает строку из вывода, в этом файле быть не должно: в магазине
// одежды замер полугодовой давности полезнее пустого места.
//
// Порядок работы (§8 спеки — отрисовка < 1 с при холодном старте офлайн):
//   1) рисуем из кэша store.js сразу, не дожидаясь сети;
//   2) параллельно читаем index.json из приватного repo B;
//   3) сеть не ответила — оставляем нарисованное и объясняем, что случилось
//      и когда кэш обновлялся.

import { getIndexCache, setIndexCache } from '../store.js';
import { readFile } from '../github.js';
import { loadCatalog, cheatsheetMeasurements } from '../catalog.js';

export const title = 'Шпаргалка';

const INDEX_PATH = 'index.json';

// Эти три динамических замера дублируются в «Для покупок» намеренно (§7.1):
// в магазине они нужны рядом с ростом и длиной рукава.
export const SHOPPING_EXTRA_KEYS = Object.freeze(['chest', 'hip', 'neck']);

export const SECTION_TITLES = Object.freeze({
  shopping: 'Для покупок',
  dynamic: 'Динамика'
});

const EMPTY_VALUE = '—'; // тире вместо числа: пустое место подсказывает, что пора мерить
const NO_DATE_TEXT = 'ещё не измерено';
const BAD_DATE_TEXT = 'дата неизвестна'; // значение есть, а дата битая — молчать нельзя

const UNITS = Object.freeze({ cm: 'см', kg: 'кг' });

const MONTHS = Object.freeze([
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'
]);

const DAY_MS = 86400000;

// ===== Чистая логика (без DOM, покрыта автотестом) ========================

// Русские числительные: 1 день / 2 дня / 5 дней.
export function plural(count, one, few, many) {
  const n = Math.abs(Math.trunc(count));
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function parseDayStart(dateStr) {
  if (typeof dateStr !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const stamp = Date.UTC(year, month - 1, day);
  const probe = new Date(stamp);
  // Отсекаем 2026-02-31 и прочие несуществующие даты.
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return { stamp, year, month, day };
}

// Возраст замера в календарных днях. Считаем по полуночи UTC с обеих сторон,
// иначе переход на летнее время даёт лишние ±1 день.
export function ageInDays(dateStr, now) {
  const parsed = parseDayStart(dateStr);
  if (!parsed) return null;
  const reference = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const today = Date.UTC(reference.getFullYear(), reference.getMonth(), reference.getDate());
  return Math.round((today - parsed.stamp) / DAY_MS);
}

// Устаревание применимо только к динамическим замерам: статика меряется один
// раз, и её возраст ничего не значит (frequency_days === null).
export function isStale(measurement, dateStr, now) {
  const frequency = measurement?.frequency_days;
  if (!Number.isFinite(frequency) || frequency <= 0) return false;
  const age = ageInDays(dateStr, now);
  if (age === null) return false;
  // Ровно frequency_days x 2 — ещё не устарело, граница включительно.
  return age > frequency * 2;
}

export function formatValue(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return EMPTY_VALUE;
  const rounded = Math.round(value * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return text.replace('.', ',');
}

export function formatUnit(unit) {
  if (typeof unit !== 'string' || unit.trim() === '') return '';
  return UNITS[unit] ?? unit;
}

// Дата замера — везде в одном виде: «14 августа», с годом, если он не текущий.
export function formatMeasurementDate(dateStr, now) {
  const parsed = parseDayStart(dateStr);
  if (!parsed) return NO_DATE_TEXT;
  const reference = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const text = `${parsed.day} ${MONTHS[parsed.month - 1]}`;
  return parsed.year === reference.getFullYear() ? text : `${text} ${parsed.year}`;
}

// Возраст кэша для индикатора состояния данных: «3 дня назад».
export function formatAge(iso, now) {
  if (typeof iso !== 'string' || iso.trim() === '') return null;
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return null;
  const reference = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const ms = Math.max(0, reference.getTime() - then.getTime());
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} ${plural(minutes, 'минуту', 'минуты', 'минут')} назад`;
  const hours = Math.floor(ms / 3600000);
  if (hours < 24) return `${hours} ${plural(hours, 'час', 'часа', 'часов')} назад`;
  const days = Math.floor(ms / DAY_MS);
  return `${days} ${plural(days, 'день', 'дня', 'дней')} назад`;
}

function latestEntry(latest, key) {
  if (typeof latest !== 'object' || latest === null) return null;
  const entry = latest[key];
  if (typeof entry !== 'object' || entry === null) return null;
  return entry;
}

// Строка шпаргалки. Строится всегда, даже когда значения нет и когда оно
// древнее: отсутствие числа — такая же полезная информация, как число.
export function buildRow(measurement, latest, now) {
  const entry = latestEntry(latest, measurement.key);
  const value = typeof entry?.value === 'number' && Number.isFinite(entry.value) ? entry.value : null;
  const date = typeof entry?.date === 'string' ? entry.date : null;
  let dateText = formatMeasurementDate(date, now);
  if (dateText === NO_DATE_TEXT && value !== null) dateText = BAD_DATE_TEXT;
  return {
    key: measurement.key,
    label: typeof measurement.label === 'string' ? measurement.label : measurement.key,
    value,
    valueText: formatValue(value),
    hasValue: value !== null,
    unitText: value === null ? '' : formatUnit(measurement.unit),
    date,
    dateText,
    stale: isStale(measurement, date, now)
  };
}

// Две секции §7.1. Одна и та же запись может попасть в обе — это намеренно.
// Ни одна строка здесь не отбрасывается: любой замер каталога получает место.
export function buildSections(measurements, latest, now) {
  const shopping = [];
  const dynamic = [];
  const list = Array.isArray(measurements) ? measurements : [];
  for (const measurement of list) {
    if (!measurement || typeof measurement.key !== 'string') continue;
    const row = buildRow(measurement, latest, now);
    if (measurement.class === 'static' || SHOPPING_EXTRA_KEYS.includes(measurement.key)) {
      shopping.push(row);
    }
    if (measurement.class === 'dynamic') {
      dynamic.push(row);
    }
  }
  return [
    { id: 'shopping', title: SECTION_TITLES.shopping, rows: shopping },
    { id: 'dynamic', title: SECTION_TITLES.dynamic, rows: dynamic }
  ];
}

// Индикатор состояния данных (§7.1). state:
//   { phase: 'fresh' | 'cache' | 'empty', fetchedAt, error: { kind, message } | null }
export function statusFor(state, now) {
  const phase = state?.phase;
  const error = state?.error ?? null;
  if (phase === 'fresh') return { text: 'актуально', tone: 'ok' };
  if (phase === 'cache') {
    const age = formatAge(state?.fetchedAt, now);
    return { text: age ? `из кэша, обновлено ${age}` : 'из кэша', tone: 'stale' };
  }
  if (error?.kind === 'no-token') {
    // Первый запуск без токена — это не авария, а нормальное состояние.
    return { text: 'нет данных, нужен токен', tone: 'stale' };
  }
  if (error) return { text: error.message, tone: 'error' };
  return { text: 'нет данных', tone: 'stale' };
}

// Пояснение на самом экране: в шапку длинный текст не влезает.
export function noticeFor(state, now, catalogError) {
  if (catalogError) {
    return {
      tone: 'error',
      heading: 'Каталог замеров не загрузился',
      text: catalogError.message,
      link: null
    };
  }
  const error = state?.error ?? null;
  if (!error) return null;

  const fromCache = state?.phase === 'cache';
  const age = formatAge(state?.fetchedAt, now);
  const cacheNote = fromCache
    ? `Показаны значения из кэша${age ? `, он обновлялся ${age}` : ''}.`
    : '';

  if (error.kind === 'no-token') {
    return {
      tone: 'info',
      heading: 'Токен GitHub ещё не задан',
      text: `${error.message} До этого свежие значения подтянуть неоткуда.${cacheNote ? ` ${cacheNote}` : ''}`,
      link: { href: '#/settings', text: 'Открыть настройки' }
    };
  }
  return {
    tone: fromCache ? 'warn' : 'error',
    heading: fromCache ? 'Данные не обновились' : 'Данные не загрузились',
    text: cacheNote ? `${error.message} ${cacheNote}` : error.message,
    link: null
  };
}

// Из ошибки github.js берём готовый человеческий текст под каждый kind (§4).
export function toErrorInfo(error) {
  if (error && typeof error.kind === 'string' && typeof error.message === 'string') {
    return { kind: error.kind, message: error.message };
  }
  if (error instanceof Error && error.message) {
    return { kind: 'unknown', message: error.message };
  }
  return { kind: 'unknown', message: 'Неизвестная ошибка загрузки данных.' };
}

// ===== Отрисовка ==========================================================

let renderToken = 0;
let view = null;
let onlineHandler = null;
let appModule = null;

// app.js импортируется лениво: статический импорт замкнул бы цикл
// app.js -> screens/cheatsheet.js -> app.js и потребовал бы DOM даже для
// автотеста чистой логики.
async function setStatus(status) {
  try {
    if (!appModule) appModule = await import('../app.js');
    appModule.setHeaderStatus(status.text, status.tone);
  } catch {
    // Вне приложения (автотест) шапки нет — это не повод падать.
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderNotice(notice) {
  const card = el('section', 'card cheat-notice');
  card.append(el('h2', null, notice.heading));

  const body = el('p', notice.tone === 'info' ? 'field__hint' : 'warn', notice.text);
  card.append(body);

  if (notice.link) {
    const link = el('a', 'btn cheat-notice__link', notice.link.text);
    link.href = notice.link.href;
    card.append(link);
  }
  return card;
}

function renderRow(row) {
  const node = el('div', 'row cheat-row');

  const info = el('div', 'cheat-row__info');
  info.append(el('span', 'label cheat-row__name', row.label));

  const date = el('span', 'date cheat-row__date', row.dateText);
  // Приглушаем только цвет даты: строка остаётся на месте и в полном размере.
  if (row.stale) date.classList.add('date--stale');
  info.append(date);

  const amount = el('div', 'cheat-row__value');
  const value = el('span', 'value', row.valueText);
  if (!row.hasValue) value.classList.add('value--empty');
  amount.append(value);
  if (row.unitText) amount.append(el('span', 'cheat-row__unit', row.unitText));

  node.append(info, amount);
  return node;
}

function renderSection(section) {
  const card = el('section', 'card cheat-section');
  card.append(el('h2', null, section.title));
  for (const row of section.rows) card.append(renderRow(row));
  return card;
}

function paint(current) {
  const now = new Date();
  const nodes = [];

  const notice = noticeFor(current.state, now, current.catalogError);
  if (notice) nodes.push(renderNotice(notice));

  const latest = current.state.index?.latest ?? null;
  for (const section of buildSections(current.measurements, latest, now)) {
    nodes.push(renderSection(section));
  }

  current.root.replaceChildren(...nodes);
  setStatus(statusFor(current.state, now));
}

function cachedState() {
  const cached = getIndexCache();
  if (!cached) return { phase: 'empty', index: null, fetchedAt: null, error: null };
  return { phase: 'cache', index: cached.data, fetchedAt: cached.fetchedAt, error: null };
}

async function refresh(current, token) {
  if (token !== renderToken) return;
  try {
    const file = await readFile(INDEX_PATH);
    const data = JSON.parse(file.content);
    if (token !== renderToken) return;
    const entry = setIndexCache(data);
    current.state = {
      phase: 'fresh',
      index: data,
      fetchedAt: entry?.fetchedAt ?? new Date().toISOString(),
      error: null
    };
  } catch (error) {
    if (token !== renderToken) return;
    const info = error instanceof SyntaxError
      ? { kind: 'bad-json', message: 'index.json на сервере не разбирается как JSON.' }
      : toErrorInfo(error);
    // Кэш остаётся ровно таким, каким был: нарисованное не стираем.
    current.state = { ...current.state, error: info };
  }
  paint(current);
}

export async function render(root, params) {
  const token = ++renderToken;
  detachOnline(); // повторный render без destroy не должен копить слушателей

  let measurements = [];
  let catalogError = null;
  try {
    await loadCatalog();
    measurements = cheatsheetMeasurements();
  } catch (error) {
    catalogError = error instanceof Error ? error : new Error(String(error));
  }
  // Пока грузился каталог, мог случиться переход на другой экран.
  if (token !== renderToken) return;

  const current = { root, measurements, catalogError, state: cachedState() };
  view = current;

  // Первая отрисовка — синхронно из кэша, до любого сетевого запроса.
  paint(current);

  // Сеть не блокирует render(): экран уже на месте, обновление придёт позже.
  refresh(current, token).catch(() => {
    // refresh сам разбирает свои ошибки; сюда попадать нечему.
  });

  if (typeof window !== 'undefined') {
    onlineHandler = () => {
      if (view === current && token === renderToken) refresh(current, token).catch(() => {});
    };
    window.addEventListener('online', onlineHandler);
  }
}

function detachOnline() {
  if (onlineHandler && typeof window !== 'undefined') {
    window.removeEventListener('online', onlineHandler);
  }
  onlineHandler = null;
}

export function destroy() {
  // Смена токена гасит ответ сети, который придёт уже после ухода с экрана.
  renderToken += 1;
  view = null;
  detachOnline();
}
