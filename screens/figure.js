// Read-only экран фигуры (T12, §7.5 спеки).
// Срез и окраска Δ приходят только из asof.js; экран не знает про файлы
// сессий и не имеет пути к их созданию или изменению.

import { setHeaderStatus, toast } from '../app.js';
import { delta, sliceAt, sliceDates } from '../asof.js';
import { figureMeasurements, getMeasurement, loadCachedCatalog, loadCatalog, protocolVersion } from '../catalog.js';
import { silhouette } from '../figure.js';
import { readFile } from '../github.js';
import { enqueueEntry, flush, isPersistent, listJobs, onQueueChange, pendingEntries } from '../queue.js';
import { buildSession } from '../session.js';
import {
  getIndexCache,
  getProfile,
  setIndexCache,
  setProfile
} from '../store.js';

export const title = 'Фигура';

const INDEX_PATH = 'index.json';
// §7.5 спеки: цена быстрого ввода — один повтор вместо трёх, помечается словами.
const QUICK_NOTE = 'быстрый ввод, один повтор';
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
let offQueue = null;

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

function changeFor(index, entry, current, pending) {
  const before = previousDay(current?.date);
  const previous = before ? pointOf(sliceAt(index, before, pending), entry.key) : null;
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

// ===== Шторка быстрого ввода (T13, §7.5 спеки) ============================
// Пишет всегда новой сессией через существующую точку входа очереди T6
// (enqueue из queue.js) — склейка дня появится только в T14. Значение уходит
// всегда на сегодня, какая бы дата ни была выбрана в полосе дат сверху
// (§7.5: «Запишется на …» — не «срез»).

function pad2(number) {
  return String(number).padStart(2, '0');
}

export function todayISO(now = new Date()) {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

export function currentTime(now = new Date()) {
  return `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
}

// Округление к шагу диапазона и клампу в границы — та же идея, что у
// bump() в шаблоне, но без мутации состояния.
export function stepClamp(value, range) {
  if (!range) return value;
  const steps = Math.round((value - range.min) / range.step);
  const stepped = range.min + steps * range.step;
  const clamped = Math.min(range.max, Math.max(range.min, stepped));
  return Math.round(clamped * 1000) / 1000;
}

// Стартовое значение поля: текущая точка среза, иначе середина диапазона.
// Дефолт нужен только черновику поля ввода — в файл сессии уходит то,
// что реально выставил пользователь, а не он.
export function seedDraft(entry, point) {
  if (point && Number.isFinite(point.value)) return point.value;
  if (entry.ui_range) return stepClamp((entry.ui_range.min + entry.ui_range.max) / 2, entry.ui_range);
  return 0;
}

// '86,5' -> 86.5, телефонная клавиатура даёт запятую (как в session.js).
function parseDraft(text) {
  const trimmed = String(text ?? '').trim().replace(',', '.');
  if (trimmed === '') return null;
  const number = Number(trimmed);
  return Number.isFinite(number) ? number : null;
}

// 'Ориентир: … / Поза: …' — дословный дубль entry.js: логика модуля экрана
// не должна импортировать другой экран (прецедент formatNumber, T5 §13).
function protocolLines(measurement) {
  const lines = [];
  const landmark = typeof measurement.landmark === 'string' ? measurement.landmark.trim() : '';
  const posture = typeof measurement.posture === 'string' ? measurement.posture.trim() : '';
  if (landmark !== '') lines.push(`Ориентир: ${landmark}`);
  if (posture !== '') lines.push(`Поза: ${posture}`);
  return lines;
}

function openSheet(key) {
  if (state === null) return;
  const entry = getMeasurement(key);
  if (!entry) return;
  const point = pointOf(state.slice, key);
  state.sheet = { key, entry, point, draft: seedDraft(entry, point), saving: false, error: null };
  paintSheet();
}

function closeSheet() {
  if (state === null || !state.sheet) return;
  state.sheet = null;
  paintSheet();
}

function buildSheet(sheet) {
  const { entry, point } = sheet;

  const scrim = el('div', 'sheet__scrim');
  scrim.addEventListener('click', (event) => {
    if (event.target === scrim) closeSheet();
  });

  const card = el('div', 'sheet');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.addEventListener('click', (event) => event.stopPropagation());
  card.append(el('div', 'sheet__grip'));

  const head = el('div', 'sheet__head');
  head.append(el('span', 'sheet__title', entry.label));
  head.append(el('span', 'sheet__date', `Запишется на ${formatDate(todayISO())}`));
  card.append(head);

  for (const line of protocolLines(entry)) card.append(el('p', 'sheet__protocol', line));

  card.append(el('p', 'sheet__hint', point
    ? `Было ${formatMeasurement(point.value, entry.unit)}`
    : 'Первый замер'));

  const stepper = el('div', 'sheet__stepper');
  const dec = el('button', 'sheet__step', '−');
  dec.type = 'button';
  dec.setAttribute('aria-label', 'Уменьшить');
  const valueBox = el('div', 'sheet__value');
  const input = document.createElement('input');
  input.type = 'text';
  input.setAttribute('inputmode', 'decimal');
  input.autocomplete = 'off';
  input.className = 'sheet__input';
  input.value = formatNumber(sheet.draft);
  const unit = el('span', 'sheet__unit', UNIT_LABELS.get(entry.unit) ?? (entry.unit || ''));
  valueBox.append(input, unit);
  const inc = el('button', 'sheet__step', '+');
  inc.type = 'button';
  inc.setAttribute('aria-label', 'Увеличить');
  stepper.append(dec, valueBox, inc);
  card.append(stepper);

  let slider = null;
  if (entry.ui_range) {
    slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'sheet__slider';
    slider.min = String(entry.ui_range.min);
    slider.max = String(entry.ui_range.max);
    slider.step = String(entry.ui_range.step);
    slider.value = String(sheet.draft);
    card.append(slider);
    const range = el('div', 'sheet__range');
    range.append(el('span', null, formatMeasurement(entry.ui_range.min, entry.unit)));
    range.append(el('span', null, formatMeasurement(entry.ui_range.max, entry.unit)));
    card.append(range);
  }

  const errorLine = el('p', 'sheet__error', sheet.error ? errorText(sheet.error) : undefined);
  card.append(errorLine);

  function setDraft(next) {
    const step = entry.ui_range ? entry.ui_range.step : 1;
    const clamped = entry.ui_range ? stepClamp(next, entry.ui_range) : Math.round(next / step) * step;
    sheet.draft = clamped;
    input.value = formatNumber(clamped);
    if (slider) slider.value = String(clamped);
  }

  const step = entry.ui_range ? entry.ui_range.step : 1;
  dec.addEventListener('click', () => setDraft(sheet.draft - step));
  inc.addEventListener('click', () => setDraft(sheet.draft + step));
  input.addEventListener('change', () => {
    const parsed = parseDraft(input.value);
    if (parsed === null) input.value = formatNumber(sheet.draft);
    else setDraft(parsed);
  });
  if (slider) slider.addEventListener('input', () => setDraft(Number(slider.value)));

  const actions = el('div', 'sheet__actions');
  const history = el('a', 'btn', 'История');
  history.href = `#/history/${encodeURIComponent(entry.key)}`;
  const cancel = el('button', 'btn', 'Отмена');
  cancel.type = 'button';
  cancel.addEventListener('click', closeSheet);
  const save = el('button', 'btn btn--primary', sheet.saving ? 'Сохраняю…' : 'Сохранить');
  save.type = 'button';
  save.disabled = sheet.saving;
  save.addEventListener('click', () => { void saveSheet(); });
  actions.append(history, cancel, save);
  card.append(actions);

  scrim.append(card);
  return scrim;
}

function paintSheet() {
  if (state === null) return;
  if (!state.sheet) {
    state.sheetHost.replaceChildren();
    return;
  }
  state.sheetHost.replaceChildren(buildSheet(state.sheet));
}

// Файл сессии всегда новый (§6.1): очередь T6 умеет только создавать файлы,
// sha сюда не передаётся никогда — путь к правке существующей сессии
// физически отсутствует.
async function saveSheet() {
  if (state === null || !state.sheet || state.sheet.saving) return;
  const token = state.token;
  const sheet = state.sheet;

  sheet.saving = true;
  sheet.error = null;
  paintSheet();

  const now = new Date();
  const date = todayISO(now);

  let session;
  try {
    session = buildSession({
      date,
      time: currentTime(now),
      protocolVersion: protocolVersion(),
      // Шторка не спрашивает условия — записывать их со слов, которых
      // не было, значило бы придумать данные (§0 контракта).
      conditions: { fasted: false, post_void: false, hours_since_training: null },
      entries: [{ key: sheet.key, raw: [sheet.draft], note: QUICK_NOTE }]
    });
  } catch (error) {
    if (outdated(token)) return;
    sheet.saving = false;
    sheet.error = error;
    paintSheet();
    return;
  }

  let id;
  try {
    // enqueueEntry (T14) склеивает несколько значений одного дня в один
    // файл сессии — голая постановка в очередь из T6 писала бы каждое
    // значение отдельным файлом.
    id = await enqueueEntry({
      date: session.date,
      entry: session.entries[0],
      message: `Быстрый ввод: ${sheet.entry.label} ${session.date}`
    });
  } catch (error) {
    if (outdated(token)) return;
    sheet.saving = false;
    sheet.error = error;
    paintSheet();
    return;
  }

  await flush();
  if (outdated(token)) return;
  const job = (await listJobs()).find((item) => item.id === id);
  if (outdated(token)) return;

  if (!job) {
    toast(`Записано: ${formatMeasurement(sheet.draft, sheet.entry.unit)}`, 'ok');
    state.sheet = null;
    paintSheet();
    return;
  }

  if (!isPersistent()) {
    sheet.saving = false;
    sheet.error = new Error(`${job.lastError ?? ''} Сессия в очереди, но браузер не дал сохранить её на диск — не закрывай вкладку.`.trim());
    paintSheet();
    return;
  }

  toast('Сессия в очереди — отправлю, когда появится связь.', 'stale');
  state.sheet = null;
  paintSheet();
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

function buildDateStrip(dates, selectedDate, pendingDates) {
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
    // T14: чип сегодняшнего числа обязан появиться до пересборки index.json
    // и в офлайне (§7.5 спеки) — источник этих дат queue.pendingEntries().
    if (pendingDates.has(date)) chip.classList.add('chip--pending');
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
  guide.setAttribute('tabindex', '0');
  guide.setAttribute('role', 'button');
  guide.setAttribute('aria-label', `Внести замер: ${entry.label}`);
  const edge = left ? node.x1 : node.x2;
  const end = left ? 54 : 306;
  const textX = left ? 48 : 312;

  // Тач-цель шире тонкой выноски: прозрачный прямоугольник ловит клик,
  // сама линия остаётся волосяной (§7.5: тап открывает шторку ввода).
  const hit = svgEl('rect', 'fig-guide__hit');
  const hitLeft = Math.min(edge, end, textX) - 4;
  const hitRight = Math.max(edge, end, textX) + 4;
  hit.setAttribute('x', hitLeft);
  hit.setAttribute('y', node.y - 14);
  hit.setAttribute('width', hitRight - hitLeft);
  hit.setAttribute('height', 30);

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

  const reading = svgEl('text', measured && point.pending
    ? 'fig-guide__reading pending'
    : 'fig-guide__reading');
  reading.setAttribute('x', textX);
  reading.setAttribute('y', node.y + 10);
  reading.setAttribute('text-anchor', left ? 'end' : 'start');
  reading.textContent = measured ? formatMeasurement(point.value, entry.unit) : '—';

  guide.append(hit, line, name, reading);
  guide.addEventListener('click', () => openSheet(entry.key));
  guide.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    openSheet(entry.key);
  });
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

function buildRow(entry, point, index, pending) {
  const row = el('div', point ? 'mrow' : 'mrow mrow--missing');
  row.dataset.key = entry.key;
  row.setAttribute('role', 'button');
  row.setAttribute('tabindex', '0');
  row.setAttribute('aria-label', `Внести замер: ${entry.label}`);
  row.addEventListener('click', () => openSheet(entry.key));
  row.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    openSheet(entry.key);
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
    // T14: значение из очереди не подтверждено — «ожидает отправки» вместо
    // даты, единственный тон для этого случая — .pending (§10 контракта).
    const when = el('span', point.pending
      ? 'mrow__when pending'
      : (stale(entry, point) ? 'mrow__when mrow__when--stale' : 'mrow__when'));
    when.textContent = point.pending ? 'Ожидает отправки' : (formatDate(point.date) || 'дата неизвестна');
    reading.append(amount, when);

    const change = changeFor(index, entry, point, pending);
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

function buildGroups(measurements, slice, index, pending) {
  const byKey = new Map(measurements.map((entry) => [entry.key, entry]));
  const fragment = [];

  for (const group of GROUPS) {
    const section = el('section', 'mgroup card');
    section.append(el('h2', null, group.title));
    for (const key of group.keys) {
      const entry = byKey.get(key);
      if (entry) section.append(buildRow(entry, pointOf(slice, key), index, pending));
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
    state.mainHost.replaceChildren(...nodes);
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
    state.mainHost.replaceChildren(...nodes);
    applyStatus();
    return;
  }

  const pending = state.pending;
  const dates = sliceDates(state.index, pending);
  if (!dates.includes(state.selectedDate)) state.selectedDate = dates.at(-1) ?? null;
  if (dates.length > 0) {
    nodes.push(buildDateStrip(dates, state.selectedDate, new Set(Object.keys(pending))));
  }

  const slice = state.selectedDate ? sliceAt(state.index, state.selectedDate, pending) : {};
  state.slice = slice;
  const measured = state.measurements.filter((entry) => pointOf(slice, entry.key)).length;
  const empty = measured === 0;

  const layout = el('div', 'figure-layout');
  layout.append(buildFigureCard(state.measurements, slice, state.profile, empty));

  const summary = el('div', 'figure-summary');
  summary.append(empty ? buildEmptyState() : buildKpis(slice));
  summary.append(...buildGroups(state.measurements, slice, state.index, pending));
  summary.append(buildActions(state.loading));
  layout.append(summary);
  nodes.push(layout);

  state.mainHost.replaceChildren(...nodes);
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

// T14: оверлей очереди — чип сегодняшней даты и значение из шторки обязаны
// появиться сразу после сохранения и в офлайне, до пересборки index.json
// Action'ом (§7.5 спеки). Подписка на очередь переживает флаки сети: любая
// её мутация (постановка, отправка, провал) перерисовывает экран.
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
  if (mountedRoot) mountedRoot.classList.remove('figure-screen');
  const cache = getIndexCache();
  const profile = getProfile();
  const cachedCatalog = loadCachedCatalog();
  mountedRoot = root;
  root.classList.add('figure-screen');
  // Хост шторки — отдельный узел рядом с основным содержимым: paint()
  // перерисовывает только mainHost, и открытая шторка переживает фоновое
  // обновление данных (§7.5: шторка не должна закрываться сама по себе).
  const mainHost = el('div', 'figure-main');
  const sheetHost = el('div', 'sheet-host');
  root.append(mainHost, sheetHost);
  state = {
    token,
    root,
    mainHost,
    sheetHost,
    measurements: cachedCatalog.length > 0 ? figureMeasurements() : [],
    index: cache && isRecord(cache.data) ? cache.data : null,
    selectedDate: null,
    slice: {},
    sheet: null,
    profile,
    pending: {},
    catalogReady: cachedCatalog.length > 0,
    error: null,
    loading: true
  };

  // Listener ставится до первой сети: неудачную загрузку каталога можно
  // повторить событием online, не перезагружая страницу.
  window.addEventListener('online', handleOnline);
  offQueue = onQueueChange(() => { void refreshPending(token); });
  paint();
  void loadScreenData(token);
  void refreshPending(token);
}

export function destroy() {
  window.removeEventListener('online', handleOnline);
  if (offQueue) { offQueue(); offQueue = null; }
  if (mountedRoot) mountedRoot.classList.remove('figure-screen');
  mountedRoot = null;
  mountToken += 1;
  state = null;
}
