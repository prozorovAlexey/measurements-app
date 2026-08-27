// Экран «Сравнение» (T16, §7.6 спеки, §14 контракта). Read-only: два среза
// по датам, KPI-дельты и таблица «показатель / было / стало / Δ» по всему
// каталогу. Наложения силуэтов нет — решение 2026-08-17, самая дорогая часть
// шаблона с наименее очевидной пользой (§7.6 спеки).
//
// Δ и её мёртвая зона — исключительно asof.delta(): один источник окраски
// на приложение, те же данные не могут давать два разных вывода на «Фигуре»
// и здесь. Экран не пишет данные вообще — ни writeFile/listFiles, ни очереди:
// сравнение не редактирует сессии, только читает их.

import { setHeaderStatus } from '../app.js';
import { accountIndexPath } from '../accounts.js';
import { delta, sliceAt, sliceDates } from '../asof.js';
import {
  dynamicMeasurements,
  getMeasurement,
  loadCachedCatalog,
  loadCatalog,
  staticMeasurements
} from '../catalog.js';
import { GitHubError, readFileOrNull } from '../github.js';
import { figureSubtabs } from './figure.js';
import { onQueueChange, pendingEntries } from '../queue.js';
import { getAccountIndexCache, getActiveAccount, setAccountIndexCache } from '../store.js';

export const title = 'Сравнение';

const UNIT_LABELS = new Map([['cm', 'см'], ['kg', 'кг']]);
const DAY_MS = 86400000;
const DAY_FORMS = Object.freeze(['день', 'дня', 'дней']);

let mountToken = 0;
let state = null;
let offQueue = null;

// ===== Мелкие узлы и форматирование =======================================
// Дубли figure.js/sizes.js намеренно: модуль экрана не импортирует другой
// экран, кроме единственного разрешённого исключения — figureSubtabs()
// (прецедент formatNumber, T5 §13 контракта).

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatNumber(value, digits = 1) {
  if (!Number.isFinite(value)) return '—';
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
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

function epochDay(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  if (!match) return null;
  return Math.floor(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / DAY_MS);
}

function pluralDays(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return DAY_FORMS[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return DAY_FORMS[1];
  return DAY_FORMS[2];
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

// -> текст дельты либо null, если сравнивать нечего (одна из точек не измерена).
function formatDeltaText(change, unit) {
  if (!Number.isFinite(change?.value)) return null;
  const absolute = formatMeasurement(Math.abs(change.value), unit);
  if (change.value > 0) return `+${absolute}`;
  if (change.value < 0) return `−${absolute}`;
  return formatMeasurement(0, unit);
}

// Единственное место экрана, красящее Δ — тон всегда из asof.delta().tone.
function buildDeltaBadge(change, unit) {
  const text = formatDeltaText(change, unit);
  return el('span', `delta delta--${change?.tone ?? 'flat'}`, text ?? '—');
}

// ===== Даты среза (§7.6: «Два селекта… по датам срезов») ==================

function buildDateField(labelText, dates, selected, modifier, onChange) {
  const field = el('label', `field cmp-date-field cmp-date-field--${modifier}`);
  field.append(el('span', 'label cmp-date-field__label', labelText));
  const select = document.createElement('select');
  select.className = 'cmp-date-field__select';
  select.setAttribute('aria-label', labelText);
  for (const date of dates) {
    const option = document.createElement('option');
    option.value = date;
    option.textContent = formatDate(date);
    if (date === selected) option.selected = true;
    select.append(option);
  }
  select.value = selected;
  select.addEventListener('change', () => onChange(select.value));
  field.append(select);
  return field;
}

function buildDateFields() {
  const wrap = el('section', 'cmp-dates card');
  wrap.setAttribute('aria-label', 'Даты сравнения');
  const arrow = el('span', 'cmp-dates__arrow', '→');
  arrow.setAttribute('aria-hidden', 'true');
  wrap.append(
    buildDateField('Было', state.dates, state.dateA, 'before', (value) => {
      if (state === null) return;
      state.dateA = value;
      paint();
    }),
    arrow,
    buildDateField('Стало', state.dates, state.dateB, 'after', (value) => {
      if (state === null) return;
      state.dateB = value;
      paint();
    })
  );
  return wrap;
}

// Первое открытие — «было» самая ранняя дата, «стало» самая поздняя: это
// и есть весь доступный прогресс. Дальше выбор пользователя переживает
// фоновые обновления (та же идея, что state.selectedDate на «Фигуре»).
function ensureSelectedDates() {
  if (state.dates.length === 0) {
    state.dateA = null;
    state.dateB = null;
    return;
  }
  if (state.dateA === null || !state.dates.includes(state.dateA)) {
    state.dateA = state.dates[0];
  }
  if (state.dateB === null || !state.dates.includes(state.dateB)) {
    state.dateB = state.dates.at(-1);
  }
}

// ===== KPI: Δ веса, Δ талии, ИМТ, число дней между срезами (§7.6 спеки) ====

function buildCompareKpi(label, value, sub, tone = null) {
  const classes = ['kpi', 'kpi--compare'];
  if (tone) classes.push(`kpi--delta-${tone}`);
  const card = el('article', classes.join(' '));
  const dot = el('span', 'kpi__dot');
  dot.setAttribute('aria-hidden', 'true');
  const valueNode = el('strong', value === null ? 'kpi__value kpi__value--missing' : 'kpi__value');
  if (typeof value === 'string') valueNode.textContent = value;
  else if (value) valueNode.append(value);
  card.append(dot, valueNode, el('span', 'kpi__label', label), el('span', 'kpi__sub', sub));
  return card;
}

function buildKpis(sliceA, sliceB) {
  const weightEntry = getMeasurement('weight');
  const waistEntry = getMeasurement('waist_who');
  const weightA = pointOf(sliceA, 'weight');
  const weightB = pointOf(sliceB, 'weight');
  const waistA = pointOf(sliceA, 'waist_who');
  const waistB = pointOf(sliceB, 'waist_who');
  const heightB = pointOf(sliceB, 'height');

  const bmi = weightB && heightB && heightB.value > 0
    ? weightB.value / ((heightB.value / 100) ** 2)
    : null;
  const dayA = epochDay(state.dateA);
  const dayB = epochDay(state.dateB);
  const days = dayA !== null && dayB !== null ? Math.abs(dayB - dayA) : null;
  const weightChange = delta(weightA, weightB, weightEntry);
  const waistChange = delta(waistA, waistB, waistEntry);

  const grid = el('section', 'kpi-grid kpi-grid--4');
  grid.setAttribute('aria-label', 'Сравнение срезов');
  grid.append(
    buildCompareKpi('Δ веса', buildDeltaBadge(weightChange, 'kg'), 'между срезами', weightChange.tone),
    buildCompareKpi('Δ талии', buildDeltaBadge(waistChange, 'cm'), 'между срезами', waistChange.tone),
    buildCompareKpi('ИМТ', bmi === null ? null : formatNumber(bmi, 1), bmi === null ? 'нужны рост и вес' : 'расчётный, на дату «стало»'),
    buildCompareKpi('Между срезами', days === null ? null : `${days} ${pluralDays(days)}`, 'дней')
  );
  return grid;
}

// ===== Таблица «показатель / было / стало / Δ» по всем замерам ============
// Каталожный порядок: §5.1 «Динамические» перед §5.2 «Статические» —
// dynamicMeasurements()/staticMeasurements() сохраняют его без пересортировки.

function buildValueCell(point, unit) {
  const text = point ? formatMeasurement(point.value, unit) : '—';
  return el('td', point?.pending ? 'cmp-table__value pending' : 'cmp-table__value', text);
}

function buildTable(measurements, sliceA, sliceB) {
  const card = el('section', 'cmp-table-card card');
  const heading = el('header', 'cmp-table-card__head');
  heading.append(
    el('h2', 'cmp-table-card__title', 'Изменение размеров'),
    el('span', 'cmp-table-card__range', `${formatDate(state.dateA)} → ${formatDate(state.dateB)}`)
  );
  const wrap = el('div', 'cmp-table-wrap');
  const table = el('table', 'cmp-table');
  table.setAttribute('aria-label', 'Изменение замеров между выбранными датами');

  const thead = el('thead');
  const headRow = el('tr');
  for (const [label, className] of [
    ['Показатель', 'cmp-table__measure'],
    ['Было', null],
    ['Стало', 'cmp-table__after'],
    ['Δ', 'cmp-table__change']
  ]) {
    const cell = el('th', className, label);
    cell.setAttribute('scope', 'col');
    headRow.append(cell);
  }
  thead.append(headRow);

  const tbody = el('tbody');
  for (const entry of measurements) {
    const pointA = pointOf(sliceA, entry.key);
    const pointB = pointOf(sliceB, entry.key);
    const row = el('tr', 'cmp-table__row');
    const name = el('th', 'cmp-table__name', entry.label);
    name.setAttribute('scope', 'row');
    row.append(name);
    row.append(buildValueCell(pointA, entry.unit));
    row.append(buildValueCell(pointB, entry.unit));
    const deltaCell = el('td', 'cmp-table__delta');
    deltaCell.append(buildDeltaBadge(delta(pointA, pointB, entry), entry.unit));
    row.append(deltaCell);
    tbody.append(row);
  }

  table.append(thead, tbody);
  wrap.append(table);
  card.append(heading, wrap);
  return card;
}

// ===== Пустое состояние, ошибки, загрузка ==================================

function buildEmptyState() {
  const card = el('section', 'card');
  card.append(
    el('h2', null, 'Пока не с чем сравнивать'),
    el('p', 'field__hint', 'Нужен хотя бы один срез с данными — внесите сессию, и здесь появятся даты.')
  );
  const link = el('a', 'btn btn--primary', 'Внести полную сессию');
  link.href = '#/entry';
  card.append(link);
  return card;
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

// ===== Состояние экрана =====================================================

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
    setHeaderStatus('Из кэша', 'stale');
    return;
  }
  setHeaderStatus('Актуально', 'ok');
}

function paint() {
  if (state === null) return;
  const nodes = [figureSubtabs('compare')];
  if (state.error) nodes.push(buildNotice(state.error));

  if (!state.catalogReady) {
    const loading = el('section', 'fig-loading card');
    loading.append(
      el('h2', null, state.loading ? 'Загружаем каталог' : 'Каталог недоступен'),
      el('p', 'field__hint', 'Каталог нужен для подписей и списка замеров.')
    );
    nodes.push(loading, buildActions(state.loading));
    state.mainHost.replaceChildren(...nodes);
    applyStatus();
    return;
  }

  if (!state.index) {
    const loading = el('section', 'fig-loading card');
    loading.append(
      el('h2', null, 'Загружаем измерения'),
      el('p', 'field__hint', 'Сравнение появится после чтения кэша или index.json.')
    );
    nodes.push(loading, buildActions(state.loading));
    state.mainHost.replaceChildren(...nodes);
    applyStatus();
    return;
  }

  state.dates = sliceDates(state.index, state.pending);
  ensureSelectedDates();

  if (state.dates.length === 0) {
    nodes.push(buildEmptyState(), buildActions(state.loading));
    state.mainHost.replaceChildren(...nodes);
    applyStatus();
    return;
  }

  const sliceA = sliceAt(state.index, state.dateA, state.pending);
  const sliceB = sliceAt(state.index, state.dateB, state.pending);

  nodes.push(buildDateFields());
  nodes.push(buildKpis(sliceA, sliceB));
  nodes.push(buildTable(state.measurements, sliceA, sliceB));
  nodes.push(buildActions(state.loading));

  state.mainHost.replaceChildren(...nodes);
  applyStatus();
}

async function runRefresh(token) {
  try {
    // Пустой/несуществующий index.json (профиль без первой сессии) — не
    // ошибка, а легитимно пустой индекс.
    const file = await readFileOrNull(accountIndexPath(getActiveAccount()));
    const data = file ? parseIndex(file.content) : {};
    if (outdated(token)) return;
    setAccountIndexCache(getActiveAccount(), data);
    state.index = data;
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
    state.measurements = dynamicMeasurements().concat(staticMeasurements());
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

  // Первая отрисовка — из кэша, до первого GitHub GET (правило T4).
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

// Оверлей очереди — та же логика, что на «Фигуре»/«Размерах» (T14): значение
// из шторки обязано попасть в срез сразу, до пересборки index.json Action'ом
// и в офлайне, иначе «стало» отставало бы от только что сохранённого замера.
async function refreshPending(token) {
  let pending;
  try {
    pending = await pendingEntries(getActiveAccount());
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

  const cache = getAccountIndexCache(getActiveAccount());
  const cachedCatalog = loadCachedCatalog();
  const mainHost = el('div', 'compare-main');
  root.append(mainHost);

  state = {
    token,
    root,
    mainHost,
    measurements: cachedCatalog.length > 0 ? dynamicMeasurements().concat(staticMeasurements()) : [],
    catalogReady: cachedCatalog.length > 0,
    index: cache && isRecord(cache.data) ? cache.data : null,
    dates: [],
    dateA: null,
    dateB: null,
    pending: {},
    error: null,
    loading: true
  };

  window.addEventListener('online', handleOnline);
  offQueue = onQueueChange(() => { void refreshPending(token); });
  paint();
  void loadScreenData(token);
  void refreshPending(token);
}

export function destroy() {
  window.removeEventListener('online', handleOnline);
  if (offQueue) { offQueue(); offQueue = null; }
  mountToken += 1;
  state = null;
}
