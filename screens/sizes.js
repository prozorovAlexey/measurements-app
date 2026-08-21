// Экран «Размеры» (T15, §7.7 спеки, §14 контракта). Заменяет шпаргалку
// (§7.1) и наследует её нефункциональные требования: офлайн-первичность,
// крупный шрифт, дата рядом со значением, устаревшее — приглушённым цветом,
// индикатор источника данных. Это тот экран, который открывается в магазине,
// поэтому его счётчик открытий и меряет гейт (§2 спеки).
//
// Пять карточек размеров считает чистый sizes.js (§5.4) — дефолтов там нет
// ни одного, нет замера — карточка называет его вслух вместо расчётной
// цифры. Ниже — семь замеров вне фигуры (show_on_figure: false), вводятся
// той же шторкой, что и на «Фигуре» (createSheetController из T13/T15):
// «один компонент с двумя точками вызова, а не два похожих» (§14 контракта).
//
// Запись данных этот экран не делает никакой другой: только шторка, только
// через очередь, только на сегодня — writeFile/listFiles здесь нет.

import { setHeaderStatus } from '../app.js';
import { sliceAt } from '../asof.js';
import {
  getMeasurement,
  loadCachedCatalog,
  loadCatalog,
  offFigureMeasurements,
  sizeMeasurements
} from '../catalog.js';
import { GitHubError, readFile } from '../github.js';
import { createSheetController, todayISO } from './figure.js';
import { onQueueChange, pendingEntries } from '../queue.js';
import { sizeFor } from '../sizes.js';
import { bumpOpens, getIndexCache, getProfile, setIndexCache } from '../store.js';

export const title = 'Размеры';

const INDEX_PATH = 'index.json';
const UNIT_LABELS = new Map([['cm', 'см'], ['kg', 'кг']]);
const DAY_MS = 86400000;
const DAY_FORMS = Object.freeze(['день', 'дня', 'дней']);
const SIZE_DISCLAIMER = 'Ориентир: сетки брендов расходятся на 1–2 размера.';

const CARDS = Object.freeze([
  { scale: 'clothing', label: 'Одежда' },
  { scale: 'shirt', label: 'Рубашка' },
  { scale: 'jeans', label: 'Джинсы' },
  { scale: 'shoe', label: 'Обувь' },
  { scale: 'ring', label: 'Кольцо' }
]);

// Формула §5.4 перечисляет замеры составной карточки в определённом порядке
// (воротник, потом рукав; талия, потом шов) — каталожный порядок этого
// не даёт (та же причина, что у FIGURE_ORDER/OFF_FIGURE_ORDER в catalog.js).
const CARD_KEY_ORDER = Object.freeze({
  shirt: Object.freeze(['neck', 'sleeve']),
  jeans: Object.freeze(['waist_natural', 'inseam'])
});

let mountToken = 0;
let state = null;
let offQueue = null;

// ===== Мелкие узлы и форматирование =======================================
// Дубли cheatsheet.js/figure.js намеренно: модуль экрана не импортирует
// другой экран (прецедент formatNumber, T5 §13 контракта) — единственное
// исключение из этого правила в T15 — шторка из figure.js.

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return '—';
  const rounded = Math.round(value * 100) / 100;
  return String(rounded).replace('.', ',');
}

function formatMeasurement(value, unit) {
  if (!Number.isFinite(value)) return '—';
  const suffix = UNIT_LABELS.get(unit) ?? (typeof unit === 'string' ? unit.trim() : '');
  return suffix ? `${formatNumber(value)} ${suffix}` : formatNumber(value);
}

function formatDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ''));
  return match ? `${match[3]}.${match[2]}.${match[1]}` : '';
}

function pluralDays(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return DAY_FORMS[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return DAY_FORMS[1];
  return DAY_FORMS[2];
}

function toDayStamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

// «из кэша, обновлено 3 дня назад» — то же правило, что было в шпаргалке (§7.1).
function describeCacheAge(fetchedAtISO, now = new Date()) {
  const from = toDayStamp(fetchedAtISO);
  const to = toDayStamp(now);
  if (from === null || to === null) return 'Из кэша';
  const days = Math.round((to - from) / DAY_MS);
  if (days <= 0) return 'Из кэша, обновлено сегодня';
  if (days === 1) return 'Из кэша, обновлено вчера';
  return `Из кэша, обновлено ${days} ${pluralDays(days)} назад`;
}

function errorText(error) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error.trim();
  return 'Не удалось обновить данные.';
}

function shortenStatus(text) {
  const value = String(text ?? '').trim();
  if (value.length <= 40) return value;
  const cut = value.slice(0, 39);
  const boundary = cut.lastIndexOf(' ');
  return `${(boundary >= 24 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

function pointOf(slice, key) {
  const point = slice && slice[key];
  return point && Number.isFinite(point.value) ? point : null;
}

// Устарело, если прошло больше frequency_days x 2 — тот же порог, что
// в figure.js (§5.3 спеки), источник возраста — asof.sliceAt().
function stale(entry, point) {
  return Number.isFinite(entry.frequency_days)
    && entry.frequency_days > 0
    && Number.isFinite(point?.ageDays)
    && point.ageDays > entry.frequency_days * 2;
}

function parseIndex(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('index.json содержит некорректный JSON.');
  }
  if (!isRecord(data)) throw new Error('index.json имеет неверный формат.');
  return data;
}

// ===== Пять карточек размеров (§5.4 спеки) ================================

function orderedMeasurements(scale) {
  const list = sizeMeasurements(scale);
  const order = CARD_KEY_ORDER[scale];
  if (!order) return list;
  return list.slice().sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
}

function valuesFor(scale, slice) {
  const measurements = orderedMeasurements(scale);
  const values = {};
  for (const measurement of measurements) {
    const point = pointOf(slice, measurement.key);
    values[measurement.key] = point ? point.value : null;
  }
  return { measurements, values };
}

function buildSizeCard(card, slice, sex) {
  const { measurements, values } = valuesFor(card.scale, slice);
  const result = sizeFor(card.scale, values, { sex });

  const wrap = el('article', result.missing.length > 0
    ? 'sizecard sizecard--missing kpi'
    : 'sizecard kpi');
  const dot = el('span', 'kpi__dot');
  dot.setAttribute('aria-hidden', 'true');
  wrap.append(dot, el('h2', 'sizecard__label kpi__label', card.label));

  const primaryText = result.primary && result.letter ? `${result.primary} (${result.letter})` : result.primary;
  if (primaryText) {
    const figures = el('div', 'sizecard__figures kpi__figures');
    figures.append(el('strong', 'sizecard__primary kpi__value', primaryText));
    wrap.append(figures);
  }
  if (result.secondary) wrap.append(el('p', 'sizecard__secondary', result.secondary));

  const cmParts = measurements
    .map((measurement) => (Number.isFinite(values[measurement.key])
      ? `${measurement.label}: ${formatMeasurement(values[measurement.key], measurement.unit)}`
      : null))
    .filter(Boolean);
  if (cmParts.length > 0) wrap.append(el('p', 'sizecard__cm kpi__sub', cmParts.join(' · ')));

  if (result.missing.length > 0) {
    const names = result.missing.map((key) => getMeasurement(key)?.label ?? key).join(', ');
    wrap.append(el('p', 'sizecard__missing kpi__sub', `Нужен замер: ${names}`));
  }

  wrap.append(el('p', 'sizecard__disclaimer field__hint', SIZE_DISCLAIMER));
  return wrap;
}

function buildSizeCards(slice, sex) {
  const section = el('section', 'sizecards kpi-grid');
  section.setAttribute('aria-label', 'Размеры по вещам');
  for (const card of CARDS) section.append(buildSizeCard(card, slice, sex));
  return section;
}

// ===== Список семи замеров вне фигуры (§7.7 спеки) ========================

function buildOffRow(entry, point) {
  const row = el('div', point ? 'mrow' : 'mrow mrow--missing');
  row.dataset.key = entry.key;
  row.setAttribute('role', 'button');
  row.setAttribute('tabindex', '0');
  row.setAttribute('aria-label', `Внести замер: ${entry.label}`);
  const open = () => state?.sheetCtrl?.open(entry.key);
  row.addEventListener('click', open);
  row.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    open();
  });

  const heading = el('div', 'mrow__heading');
  heading.append(el('span', 'mrow__name', entry.label));

  const reading = el('div', 'mrow__reading');
  if (!point) {
    reading.append(
      el('strong', 'mrow__amount mrow__amount--missing', '—'),
      el('span', 'mrow__when', 'не измерено')
    );
  } else {
    const amount = el('strong', 'mrow__amount', formatMeasurement(point.value, entry.unit));
    const when = el('span', point.pending
      ? 'mrow__when pending'
      : (stale(entry, point) ? 'mrow__when mrow__when--stale' : 'mrow__when'));
    when.textContent = point.pending ? 'Ожидает отправки' : (formatDate(point.date) || 'дата неизвестна');
    reading.append(amount, when);
  }

  row.append(heading, reading);
  return row;
}

function buildOffList(measurements, slice) {
  const section = el('section', 'mgroup sizes-measurements card');
  section.setAttribute('aria-labelledby', 'sizes-measurements-title');

  const heading = el('header', 'sizes-measurements__head');
  const titleNode = el('h2', 'sizes-measurements__title', 'Остальные замеры');
  titleNode.id = 'sizes-measurements-title';
  heading.append(titleNode, el('span', 'sizes-measurements__hint', 'Нажмите строку, чтобы внести'));

  const list = el('div', 'sizes-measurements__list');
  for (const entry of measurements) list.append(buildOffRow(entry, pointOf(slice, entry.key)));
  section.append(heading, list);
  return section;
}

function buildNotice(error) {
  const card = el('section', 'card');
  card.append(el('h2', null, 'Данные не обновились'), el('p', 'warn', errorText(error)));
  if (error instanceof GitHubError && error.kind === 'no-token') {
    const link = el('a', 'btn', 'Открыть настройки');
    link.href = '#/settings';
    card.append(link);
  }
  return card;
}

function buildActions(loading) {
  const actions = el('div', 'fig-actions');
  const refresh = el('button', 'btn', loading ? 'Обновляю…' : 'Обновить');
  refresh.type = 'button';
  refresh.disabled = loading;
  refresh.addEventListener('click', requestRefresh);
  actions.append(refresh);
  return actions;
}

// ===== Состояние экрана ====================================================

function outdated(token) {
  return state === null || state.token !== token || token !== mountToken;
}

function applyStatus() {
  if (state === null) return;
  if (state.loading) {
    setHeaderStatus(state.index ? 'Обновляю…' : 'Загрузка…', null);
    return;
  }
  if (state.error && !state.index) {
    setHeaderStatus(shortenStatus(errorText(state.error)), 'error');
    return;
  }
  if (state.error) {
    setHeaderStatus(describeCacheAge(state.fetchedAt), 'stale');
    return;
  }
  setHeaderStatus('Актуально', 'ok');
}

function paint() {
  if (state === null) return;
  const nodes = [];
  if (state.error) nodes.push(buildNotice(state.error));

  if (!state.catalogReady) {
    const loading = el('section', 'card');
    loading.append(
      el('h2', null, state.loading ? 'Загружаем каталог' : 'Каталог недоступен'),
      el('p', 'field__hint', 'Каталог нужен для подписей, размеров и списка замеров.')
    );
    nodes.push(loading, buildActions(state.loading));
    state.mainHost.replaceChildren(...nodes);
    applyStatus();
    return;
  }

  const pending = state.pending;
  const slice = sliceAt(state.index, todayISO(), pending);
  state.slice = slice;
  const sex = getProfile().sex;

  nodes.push(buildSizeCards(slice, sex));
  nodes.push(buildOffList(state.offMeasurements, slice));
  nodes.push(buildActions(state.loading));

  state.mainHost.replaceChildren(...nodes);
  applyStatus();
}

async function runRefresh(token) {
  try {
    const file = await readFile(INDEX_PATH);
    const data = parseIndex(file.content);
    if (outdated(token)) return;
    setIndexCache(data);
    state.index = data;
    state.fetchedAt = new Date().toISOString();
    state.error = null;
  } catch (error) {
    if (outdated(token)) return;
    state.error = error;
  }
  if (outdated(token)) return;
  state.loading = false;
  paint();
}

async function loadScreenData(token) {
  try {
    await loadCatalog();
    if (outdated(token)) return;
    state.offMeasurements = offFigureMeasurements();
    state.catalogReady = true;
    state.error = null;
  } catch (error) {
    if (outdated(token)) return;
    state.error = error;
    state.loading = false;
    paint();
    return;
  }
  if (outdated(token)) return;

  // Первая отрисовка — из кэша, до первого GitHub GET (§8 спеки).
  paint();
  void runRefresh(token);
}

function requestRefresh() {
  if (state === null || state.loading) return;
  state.loading = true;
  state.error = null;
  paint();
  if (state.catalogReady) void runRefresh(state.token);
  else void loadScreenData(state.token);
}

function handleOnline() {
  requestRefresh();
}

// Оверлей очереди — та же логика, что на «Фигуре» (T14): значение из шторки
// обязано появиться сразу, до пересборки index.json Action'ом и в офлайне.
async function refreshPending(token) {
  let pending;
  try {
    pending = await pendingEntries();
  } catch {
    return;
  }
  if (outdated(token)) return;
  state.pending = pending;
  paint();
}

export async function render(root, params) {
  const token = ++mountToken;
  window.removeEventListener('online', handleOnline);
  if (offQueue) { offQueue(); offQueue = null; }

  const cache = getIndexCache();
  const cachedCatalog = loadCachedCatalog();
  const mainHost = el('div', 'sizes-main');
  const sheetHost = el('div', 'sheet-host');
  root.append(mainHost, sheetHost);

  state = {
    token,
    root,
    mainHost,
    sheetHost,
    offMeasurements: cachedCatalog.length > 0 ? offFigureMeasurements() : [],
    catalogReady: cachedCatalog.length > 0,
    index: cache && isRecord(cache.data) ? cache.data : null,
    fetchedAt: cache ? cache.fetchedAt : null,
    slice: {},
    pending: {},
    sheetCtrl: null,
    error: null,
    loading: true
  };
  state.sheetCtrl = createSheetController({
    host: sheetHost,
    getPoint: (key) => pointOf(state.slice, key),
    onSaved: () => {}
  });

  // §2 спеки: открытие экрана «Размеры» — это и есть измерение гейта.
  // Каждый заход считается, а не только первый за загрузку страницы —
  // экран больше не стартовый, попасть на него можно только явной навигацией.
  bumpOpens('sizes');

  window.addEventListener('online', handleOnline);
  offQueue = onQueueChange(() => { void refreshPending(token); });
  paint();
  void loadScreenData(token);
  void refreshPending(token);
}

export function destroy() {
  window.removeEventListener('online', handleOnline);
  if (offQueue) { offQueue(); offQueue = null; }
  if (state?.sheetCtrl) state.sheetCtrl.destroy();
  mountToken += 1;
  state = null;
}
