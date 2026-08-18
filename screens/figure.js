// Read-only экран фигуры (T12, §7.5 спеки).
// Срез и окраска Δ приходят только из asof.js; экран не знает про файлы
// сессий и не имеет пути к их созданию или изменению.

import { setHeaderStatus } from '../app.js';
import { delta, sliceAt, sliceDates } from '../asof.js';
import { figureMeasurements, loadCachedCatalog, loadCatalog } from '../catalog.js';
import { silhouette } from '../figure.js';
import { readFile } from '../github.js';
import {
  getIndexCache,
  getProfile,
  setIndexCache,
  setProfile
} from '../store.js';

export const title = 'Фигура';

const INDEX_PATH = 'index.json';
const SVG_NS = 'http://www.w3.org/2000/svg';
const UNIT_LABELS = new Map([['cm', 'см'], ['kg', 'кг']]);

const GROUPS = Object.freeze([
  Object.freeze({ title: 'Базовые', keys: Object.freeze(['weight', 'height']) }),
  Object.freeze({
    title: 'Корпус',
    keys: Object.freeze(['neck', 'shoulder_width', 'chest', 'waist_who', 'pelvis', 'hip'])
  }),
  Object.freeze({
    title: 'Руки',
    keys: Object.freeze(['biceps_relaxed', 'forearm', 'wrist', 'finger_index'])
  }),
  Object.freeze({ title: 'Ноги', keys: Object.freeze(['thigh', 'calf', 'foot_length']) })
]);

const CALLOUT_KEYS = Object.freeze([
  'shoulder_width', 'chest', 'waist_who', 'pelvis', 'hip',
  'biceps_relaxed', 'thigh', 'calf', 'foot_length'
]);

const CALLOUT_SIDE = new Map([
  ['shoulder_width', 'left'],
  ['chest', 'right'],
  ['waist_who', 'left'],
  ['pelvis', 'right'],
  ['hip', 'left'],
  ['biceps_relaxed', 'right'],
  ['thigh', 'left'],
  ['calf', 'right'],
  ['foot_length', 'left']
]);

let mountToken = 0;
let state = null;
let mountedRoot = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svgEl(tag, className) {
  const node = document.createElementNS(SVG_NS, tag);
  if (className) node.setAttribute('class', className);
  return node;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function formatNumber(value, digits = 1) {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits
  }).format(value);
}

function formatMeasurement(value, unit) {
  if (!Number.isFinite(value)) return '—';
  const suffix = UNIT_LABELS.get(unit) ?? (typeof unit === 'string' ? unit.trim() : '');
  return suffix ? `${formatNumber(value)} ${suffix}` : formatNumber(value);
}

function formatDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  return match ? `${match[3]}.${match[2]}.${match[1]}` : '';
}

function pointOf(slice, key) {
  const point = slice && slice[key];
  return point && Number.isFinite(point.value) ? point : null;
}

function valuesOf(measurements, slice) {
  return Object.fromEntries(measurements.map((entry) => {
    const point = pointOf(slice, entry.key);
    return [entry.key, point ? point.value : null];
  }));
}

function previousDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ''))) return null;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function changeFor(index, entry, current) {
  const before = previousDay(current?.date);
  const previous = before ? pointOf(sliceAt(index, before), entry.key) : null;
  return delta(previous, current, entry);
}

function formatDelta(change, unit) {
  if (!Number.isFinite(change?.value)) return '';
  const absolute = formatMeasurement(Math.abs(change.value), unit);
  if (change.value > 0) return `+${absolute}`;
  if (change.value < 0) return `−${absolute}`;
  return formatMeasurement(0, unit);
}

function stale(entry, point) {
  return Number.isFinite(entry.frequency_days)
    && entry.frequency_days > 0
    && Number.isFinite(point?.ageDays)
    && point.ageDays > entry.frequency_days * 2;
}

// Хелпер остаётся общим для T16, но до появления маршрута compare вторая
// под-вкладка намеренно не является ссылкой.
export function figureSubtabs(active = 'figure') {
  const nav = el('nav', 'subtabs');
  nav.setAttribute('aria-label', 'Вид фигуры');

  const figure = el('a', 'subtabs__item', 'Фигура');
  figure.href = '#/figure';
  if (active === 'figure') {
    figure.classList.add('subtabs__item--active');
    figure.setAttribute('aria-current', 'page');
  }

  const compare = el('span', 'subtabs__item subtabs__item--disabled', 'Сравнение');
  compare.setAttribute('aria-disabled', 'true');
  nav.append(figure, compare);
  return nav;
}

function buildDateStrip(dates, selectedDate) {
  const section = el('section', 'fig-dates');
  section.setAttribute('aria-label', 'Дата среза');

  for (const date of dates) {
    const chip = el('button', 'chip', formatDate(date));
    chip.type = 'button';
    chip.dataset.date = date;
    if (date === selectedDate) {
      chip.classList.add('chip--active');
      chip.setAttribute('aria-pressed', 'true');
    } else {
      chip.setAttribute('aria-pressed', 'false');
    }
    chip.addEventListener('click', () => {
      if (state === null || state.selectedDate === date) return;
      state.selectedDate = date;
      paint();
    });
    section.append(chip);
  }

  return section;
}

function buildProfileField(profile) {
  const field = el('label', 'fig-profile');
  const label = el('span', 'fig-profile__label', 'Силуэт');
  const select = el('select', 'fig-profile__select');
  select.setAttribute('aria-label', 'Пол фигуры');

  const male = el('option', null, 'Мужской');
  male.value = 'male';
  const female = el('option', null, 'Женский');
  female.value = 'female';
  select.append(male, female);
  select.value = profile.sex;
  select.addEventListener('change', () => {
    if (state === null) return;
    state.profile = setProfile({ sex: select.value });
    paint();
  });

  field.append(label, select);
  return field;
}

function buildCallout(entry, point, node) {
  const side = CALLOUT_SIDE.get(entry.key) ?? 'right';
  const left = side === 'left';
  const measured = point !== null && node.measured;
  const guide = svgEl('g', measured
    ? 'fig-guide fig-guide--active'
    : 'fig-guide fig-guide--missing');
  const edge = left ? node.x1 : node.x2;
  const end = left ? 54 : 306;
  const textX = left ? 48 : 312;

  const line = svgEl('line');
  line.setAttribute('x1', edge);
  line.setAttribute('x2', end);
  line.setAttribute('y1', node.y);
  line.setAttribute('y2', node.y);

  const name = svgEl('text', 'fig-guide__name');
  name.setAttribute('x', textX);
  name.setAttribute('y', node.y - 4);
  name.setAttribute('text-anchor', left ? 'end' : 'start');
  name.textContent = entry.label;

  const reading = svgEl('text', 'fig-guide__reading');
  reading.setAttribute('x', textX);
  reading.setAttribute('y', node.y + 10);
  reading.setAttribute('text-anchor', left ? 'end' : 'start');
  reading.textContent = measured ? formatMeasurement(point.value, entry.unit) : '—';

  guide.append(line, name, reading);
  return guide;
}

function buildFigureCard(measurements, slice, profile, empty) {
  const values = valuesOf(measurements, slice);
  const geometry = silhouette(values, { figure: profile.sex });
  const card = el('section', empty ? 'fig-card fig-card--empty' : 'fig-card');
  card.append(buildProfileField(profile));

  const svg = svgEl('svg', 'fig-svg');
  svg.setAttribute('viewBox', '0 0 360 552');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-labelledby', 'figure-svg-title');

  const svgTitle = svgEl('title');
  svgTitle.setAttribute('id', 'figure-svg-title');
  svgTitle.textContent = empty ? 'Приглушённый силуэт без замеров' : 'Силуэт по выбранному срезу';

  const ground = svgEl('ellipse', 'fig-ground');
  ground.setAttribute('cx', '180');
  ground.setAttribute('cy', geometry.ground.y);
  ground.setAttribute('rx', geometry.ground.r);
  ground.setAttribute('ry', '5');

  const body = svgEl('path', 'fig-body');
  body.setAttribute('d', geometry.paths[0].d);

  svg.append(svgTitle, ground, body);

  const byKey = new Map(measurements.map((entry) => [entry.key, entry]));
  for (const key of CALLOUT_KEYS) {
    const entry = byKey.get(key);
    const node = entry?.svg_id ? geometry.nodes[entry.svg_id] : null;
    if (!entry || !node) continue;
    svg.append(buildCallout(entry, pointOf(slice, key), node));
  }

  card.append(svg);
  return card;
}

function buildKpi(label, value, sub, tone) {
  const card = el('article', `kpi${tone ? ` kpi--${tone}` : ''}`);
  card.append(
    el('span', 'kpi__label', label),
    el('strong', value === '—' ? 'kpi__value kpi__value--missing' : 'kpi__value', value),
    el('span', 'kpi__sub', sub)
  );
  return card;
}

function buildKpis(slice) {
  const weight = pointOf(slice, 'weight');
  const height = pointOf(slice, 'height');
  const waist = pointOf(slice, 'waist_who');
  const hip = pointOf(slice, 'hip');
  const bmi = weight && height && height.value > 0
    ? weight.value / ((height.value / 100) ** 2)
    : null;
  const whr = waist && hip && hip.value > 0 ? waist.value / hip.value : null;

  const grid = el('section', 'kpi-grid', undefined);
  grid.setAttribute('aria-label', 'Ключевые показатели');
  grid.append(
    buildKpi(
      'Вес',
      weight ? formatMeasurement(weight.value, 'kg') : '—',
      weight ? formatDate(weight.date) : 'не измерено',
      'weight'
    ),
    buildKpi(
      'ИМТ',
      bmi === null ? '—' : formatNumber(bmi, 1),
      bmi === null ? 'нужны рост и вес' : 'расчётный',
      'bmi'
    ),
    buildKpi(
      'Талия / бёдра',
      whr === null ? '—' : formatNumber(whr, 2),
      whr === null ? 'нужны талия WHO и бёдра' : 'расчётный WHR',
      'whr'
    )
  );
  return grid;
}

function buildEmptyState() {
  const card = el('section', 'fig-empty card');
  card.append(
    el('h2', null, 'Фигура ждёт первых замеров'),
    el('p', null, 'Внесите рост и вес, чтобы фигура стала вашей.')
  );
  const link = el('a', 'btn btn--primary', 'Внести полную сессию');
  link.href = '#/entry';
  card.append(link);
  return card;
}

function buildRow(entry, point, index) {
  const row = el('div', point ? 'mrow' : 'mrow mrow--missing');
  row.dataset.key = entry.key;

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
    const when = el('span', stale(entry, point) ? 'mrow__when mrow__when--stale' : 'mrow__when');
    when.textContent = formatDate(point.date) || 'дата неизвестна';
    reading.append(amount, when);

    const change = changeFor(index, entry, point);
    const changeText = formatDelta(change, entry.unit);
    if (changeText) {
      const changeNode = el('span', `mrow__delta delta delta--${change.tone}`, changeText);
      changeNode.setAttribute('aria-label', `Изменение: ${changeText}`);
      reading.append(changeNode);
    }
  }

  row.append(heading, reading);
  return row;
}

function buildGroups(measurements, slice, index) {
  const byKey = new Map(measurements.map((entry) => [entry.key, entry]));
  const fragment = [];

  for (const group of GROUPS) {
    const section = el('section', 'mgroup card');
    section.append(el('h2', null, group.title));
    for (const key of group.keys) {
      const entry = byKey.get(key);
      if (entry) section.append(buildRow(entry, pointOf(slice, key), index));
    }
    fragment.push(section);
  }

  return fragment;
}

function buildActions(loading) {
  const actions = el('div', 'fig-actions');
  const full = el('a', 'btn btn--primary', 'Полная сессия');
  full.href = '#/entry';
  const refresh = el('button', 'btn', loading ? 'Обновляю…' : 'Обновить');
  refresh.type = 'button';
  refresh.disabled = loading;
  refresh.addEventListener('click', requestRefresh);
  actions.append(full, refresh);
  return actions;
}

function buildNotice(error) {
  const card = el('section', 'fig-notice card');
  card.append(
    el('h2', null, 'Данные не обновились'),
    el('p', 'warn', errorText(error))
  );
  return card;
}

function applyStatus() {
  if (state === null) return;
  if (state.loading) {
    setHeaderStatus(state.index ? 'Обновляю…' : 'Загрузка…', null);
    return;
  }
  if (state.error && (!state.catalogReady || !state.index)) {
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
  const nodes = [figureSubtabs('figure')];
  if (state.error) nodes.push(buildNotice(state.error));

  if (!state.catalogReady) {
    const loading = el('section', 'fig-loading card');
    loading.append(
      el('h2', null, state.loading ? 'Загружаем каталог' : 'Каталог недоступен'),
      el('p', 'field__hint', 'Каталог нужен для подписей и порядка замеров фигуры.')
    );
    nodes.push(loading, buildActions(state.loading));
    state.root.replaceChildren(...nodes);
    applyStatus();
    return;
  }

  if (!state.index) {
    const loading = el('section', 'fig-loading card');
    loading.append(
      el('h2', null, 'Загружаем измерения'),
      el('p', 'field__hint', 'Силуэт появится после чтения кэша или index.json.')
    );
    nodes.push(loading, buildActions(state.loading));
    state.root.replaceChildren(...nodes);
    applyStatus();
    return;
  }

  const dates = sliceDates(state.index);
  if (!dates.includes(state.selectedDate)) state.selectedDate = dates.at(-1) ?? null;
  if (dates.length > 0) nodes.push(buildDateStrip(dates, state.selectedDate));

  const slice = state.selectedDate ? sliceAt(state.index, state.selectedDate) : {};
  const measured = state.measurements.filter((entry) => pointOf(slice, entry.key)).length;
  const empty = measured === 0;

  const layout = el('div', 'figure-layout');
  layout.append(buildFigureCard(state.measurements, slice, state.profile, empty));

  const summary = el('div', 'figure-summary');
  summary.append(empty ? buildEmptyState() : buildKpis(slice));
  summary.append(...buildGroups(state.measurements, slice, state.index));
  summary.append(buildActions(state.loading));
  layout.append(summary);
  nodes.push(layout);

  state.root.replaceChildren(...nodes);
  applyStatus();
}

function outdated(token) {
  return state === null || state.token !== token || token !== mountToken;
}

async function runRefresh(token) {
  try {
    const file = await readFile(INDEX_PATH);
    const data = parseIndex(file.content);
    if (outdated(token)) return;
    setIndexCache(data);
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
    state.measurements = figureMeasurements();
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

  // Кэш index.json уже лежит в state: показываем его до первого GitHub GET.
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

export async function render(root, params) {
  const token = ++mountToken;
  window.removeEventListener('online', handleOnline);
  if (mountedRoot) mountedRoot.classList.remove('figure-screen');
  const cache = getIndexCache();
  const profile = getProfile();
  const cachedCatalog = loadCachedCatalog();
  mountedRoot = root;
  root.classList.add('figure-screen');
  state = {
    token,
    root,
    measurements: cachedCatalog.length > 0 ? figureMeasurements() : [],
    index: cache && isRecord(cache.data) ? cache.data : null,
    selectedDate: null,
    profile,
    catalogReady: cachedCatalog.length > 0,
    error: null,
    loading: true
  };

  // Listener ставится до первой сети: неудачную загрузку каталога можно
  // повторить событием online, не перезагружая страницу.
  window.addEventListener('online', handleOnline);
  paint();
  void loadScreenData(token);
}

export function destroy() {
  window.removeEventListener('online', handleOnline);
  if (mountedRoot) mountedRoot.classList.remove('figure-screen');
  mountedRoot = null;
  mountToken += 1;
  state = null;
}
