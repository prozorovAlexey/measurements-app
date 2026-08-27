// Экран фигуры (T12, §7.5 спеки).
// Срез и окраска Δ приходят только из asof.js; экран не знает про файлы
// сессий и пишет быстрый ввод только через очередь.

import { setHeaderStatus, setHeaderSubtitle, toast } from '../app.js';
import { accountIndexPath } from '../accounts.js';
import { delta, sliceAt, sliceDates } from '../asof.js';
import { figureMeasurements, getMeasurement, loadCachedCatalog, loadCatalog, protocolVersion } from '../catalog.js';
import { silhouette } from '../figure.js';
import { readFile } from '../github.js';
import { enqueueEntry, flush, isPersistent, listJobs, onQueueChange, pendingEntries } from '../queue.js';
import { buildSession } from '../session.js';
import { sparkline } from '../sparkline.js';
import {
  getActiveAccount,
  getIndexCache,
  getProfile,
  getShowAllCallouts,
  setIndexCache,
  setProfile,
  setShowAllCallouts
} from '../store.js';

export const title = 'Фигура';

// §7.5 спеки: цена быстрого ввода — один повтор вместо трёх, помечается словами.
const QUICK_NOTE = 'быстрый ввод, один повтор';
const SVG_NS = 'http://www.w3.org/2000/svg';
const UNIT_LABELS = new Map([['cm', 'см'], ['kg', 'кг']]);
// Ширина viewBox силуэта (buildFigureCard) — нужна и здесь, чтобы тач-цель
// выноски (buildCallout) могла дотянуться до края канвы.
const FIGURE_WIDTH = 360;

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

// T19: свитч «Показывать все» скрывает второстепенные выноски (таз/голень/
// стопа), оставляя шесть основных — тот же список tier:1, что в макете
// (Замеры - Фигура.dc.html, CALL). По умолчанию свитч включён — все девять,
// как было до T19.
const CALLOUT_PRIMARY = new Set([
  'shoulder_width', 'chest', 'biceps_relaxed', 'waist_who', 'hip', 'thigh'
]);

// Короткая подпись на плашке выноски — только там, где полная подпись
// каталога заметно длиннее (иначе на плашке используется entry.label как есть).
const CALLOUT_SHORT = new Map([
  ['shoulder_width', 'Плечи'],
  ['waist_who', 'Талия'],
  ['biceps_relaxed', 'Бицепс'],
  ['foot_length', 'Стопа']
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

function buildSheet(sheet, { onClose, onSave }) {
  const { entry, point } = sheet;

  const scrim = el('div', 'sheet__scrim');
  scrim.addEventListener('click', (event) => {
    if (event.target === scrim) onClose();
  });

  const card = el('div', 'sheet sheet--editor');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.addEventListener('click', (event) => event.stopPropagation());
  card.append(el('div', 'sheet__grip'));

  const head = el('div', 'sheet__head');
  head.append(el('span', 'sheet__title', entry.label));
  head.append(el('span', 'sheet__date', `Запишется на ${formatDate(todayISO())}`));
  card.append(head);

  const protocols = protocolLines(entry);
  if (protocols.length > 0) {
    const protocol = el('div', 'sheet__protocols');
    for (const line of protocols) {
      const kind = line.startsWith('Ориентир:') ? 'landmark' : 'posture';
      protocol.append(el('p', `sheet__protocol sheet__protocol--${kind}`, line));
    }
    card.append(protocol);
  }

  card.append(el('p', 'sheet__hint', point
    ? `Было ${formatMeasurement(point.value, entry.unit)}`
    : 'Первый замер'));

  const stepper = el('div', 'sheet__stepper');
  stepper.setAttribute('role', 'group');
  stepper.setAttribute('aria-label', `Значение замера «${entry.label}»`);
  const dec = el('button', 'sheet__step', '−');
  dec.type = 'button';
  dec.setAttribute('aria-label', 'Уменьшить');
  const valueBox = el('div', 'sheet__value');
  const input = document.createElement('input');
  input.type = 'text';
  input.setAttribute('inputmode', 'decimal');
  input.setAttribute('aria-label', `Значение, ${UNIT_LABELS.get(entry.unit) ?? (entry.unit || '')}`);
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
    slider.setAttribute('aria-label', `Значение замера «${entry.label}»`);
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
  const history = el('a', 'btn sheet__history', 'История');
  history.href = `#/history/${encodeURIComponent(entry.key)}`;
  const cancel = el('button', 'btn sheet__cancel', 'Отмена');
  cancel.type = 'button';
  cancel.addEventListener('click', onClose);
  const save = el('button', 'btn btn--primary sheet__save', sheet.saving ? 'Сохраняю…' : 'Сохранить');
  save.type = 'button';
  save.disabled = sheet.saving;
  save.addEventListener('click', onSave);
  actions.append(history, cancel, save);
  card.append(actions);

  scrim.append(card);
  return scrim;
}

// Переиспользуемый компонент шторки — одна точка входа для двух экранов
// (T13 «Фигура», T15 «Размеры», §14 контракта: «один компонент с двумя
// точками вызова, а не два похожих»). Хозяин экрана владеет host-узлом,
// сообщает шторке, где взять текущую точку среза для «Было N», и получает
// колбэк onSaved(), чтобы перерисовать свой список — сама шторка ничего
// не знает про layout экрана, который её открыл.
//
// Файл сессии всегда новый (§6.1): очередь T6 умеет только создавать файлы,
// sha сюда не передаётся никогда — путь к правке существующей сессии
// физически отсутствует.
// Длительность анимации закрытия (мс) — должна совпадать с sheet-scrim-out/
// sheet-card-out в style.css: DOM убирается через тот же таймер, а не по
// animationend (иначе при prefers-reduced-motion, где анимация отключена
// в CSS, шторка зависла бы навсегда — событие просто не пришло бы).
export const SHEET_CLOSE_MS = 200;

export function createSheetController({ host, getPoint, onSaved }) {
  let sheet = null;
  let active = true;
  let mountedScrim = null;
  let closeTimer = null;

  function paintSheet({ animateEnter = false } = {}) {
    if (!active) return;
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    if (!sheet) {
      mountedScrim = null;
      host.replaceChildren();
      return;
    }
    mountedScrim = buildSheet(sheet, { onClose: close, onSave: () => { void save(); } });
    if (animateEnter) mountedScrim.classList.add('sheet__scrim--enter');
    host.replaceChildren(mountedScrim);
  }

  function open(key) {
    if (!active) return;
    const entry = getMeasurement(key);
    if (!entry) return;
    const point = getPoint(key);
    sheet = { key, entry, point, draft: seedDraft(entry, point), saving: false, error: null };
    paintSheet({ animateEnter: true });
  }

  // Закрытие всегда проходит через анимацию выхода — по кнопке «Отмена», по
  // клику вне карточки и после успешной записи (§4 задания: анимация
  // закрытия), поэтому save() тоже зовёт close(), а не чистит sheet сама.
  function close() {
    if (!active || !sheet) return;
    sheet = null;
    const scrimNode = mountedScrim;
    if (!scrimNode) {
      host.replaceChildren();
      return;
    }
    scrimNode.classList.remove('sheet__scrim--enter');
    scrimNode.classList.add('is-closing');
    closeTimer = setTimeout(() => {
      closeTimer = null;
      if (mountedScrim !== scrimNode) return;
      mountedScrim = null;
      host.replaceChildren();
    }, SHEET_CLOSE_MS);
  }

  async function save() {
    if (!active || !sheet || sheet.saving) return;
    const current = sheet;
    current.saving = true;
    current.error = null;
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
        entries: [{ key: current.key, raw: [current.draft], note: QUICK_NOTE }]
      });
    } catch (error) {
      if (!active || sheet !== current) return;
      current.saving = false;
      current.error = error;
      paintSheet();
      return;
    }

    let id;
    try {
      // enqueueEntry (T14) склеивает несколько значений одного дня в один
      // файл сессии — голая постановка в очередь из T6 писала бы каждое
      // значение отдельным файлом.
      id = await enqueueEntry({
        accountId: getActiveAccount(),
        date: session.date,
        entry: session.entries[0],
        message: `Быстрый ввод: ${current.entry.label} ${session.date}`
      });
    } catch (error) {
      if (!active || sheet !== current) return;
      current.saving = false;
      current.error = error;
      paintSheet();
      return;
    }

    await flush();
    if (!active || sheet !== current) return;
    const job = (await listJobs()).find((item) => item.id === id);
    if (!active || sheet !== current) return;

    if (!job) {
      toast(`Записано: ${formatMeasurement(current.draft, current.entry.unit)}`, 'ok');
      close();
      if (onSaved) onSaved();
      return;
    }

    if (!isPersistent()) {
      current.saving = false;
      current.error = new Error(`${job.lastError ?? ''} Сессия в очереди, но браузер не дал сохранить её на диск — не закрывай вкладку.`.trim());
      paintSheet();
      return;
    }

    toast('Сессия в очереди — отправлю, когда появится связь.', 'stale');
    close();
    if (onSaved) onSaved();
  }

  function destroy() {
    active = false;
    sheet = null;
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
  }

  return { open, close, destroy, isOpen: () => sheet !== null };
}

// Общий хелпер для «Фигуры» (T12) и «Сравнения» (T16, §14 контракта:
// «полосу под-вкладок рисует общий хелпер из screens/figure.js»).
export function figureSubtabs(active = 'figure') {
  const nav = el('nav', 'subtabs');
  nav.setAttribute('aria-label', 'Вид фигуры');

  // '#/' — стартовый маршрут «Фигуры» (§2 контракта), не '#/figure':
  // отдельного роута под фигуру в таблице §2 нет.
  const figure = el('a', 'subtabs__item', 'Текущие');
  figure.href = '#/';
  if (active === 'figure') {
    figure.classList.add('subtabs__item--active');
    figure.setAttribute('aria-current', 'page');
  }

  const compare = el('a', 'subtabs__item', 'Сравнение');
  compare.href = '#/compare';
  if (active === 'compare') {
    compare.classList.add('subtabs__item--active');
    compare.setAttribute('aria-current', 'page');
  }

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

// Пол фигуры — сегментированная пилюля (T19), не <select>: то же визуальное
// решение из макета, что и у .subtabs выше.
function buildSexItem(label, sex, active) {
  const item = el('button', active ? 'fig-sex__item fig-sex__item--active' : 'fig-sex__item', label);
  item.type = 'button';
  item.setAttribute('role', 'radio');
  item.setAttribute('aria-checked', active ? 'true' : 'false');
  item.addEventListener('click', () => {
    if (state === null || state.profile.sex === sex) return;
    state.profile = setProfile({ sex });
    paint();
  });
  return item;
}

function buildSexField(profile) {
  const field = el('div', 'fig-sex');
  field.setAttribute('role', 'radiogroup');
  field.setAttribute('aria-label', 'Пол фигуры');
  field.append(
    buildSexItem('Мужской', 'male', profile.sex === 'male'),
    buildSexItem('Женский', 'female', profile.sex === 'female')
  );
  return field;
}

// Свитч «Показывать все» под силуэтом (T19) — тот же компонент, что и
// .theme-toggle в шапке (T17): один визуальный контрол, два независимых
// экземпляра с разным aria-label и обработчиком.
function buildPinsToggle(showAll) {
  const row = el('div', 'fig-pins');
  row.append(el('span', 'fig-pins__label', showAll ? 'Показывать все' : 'Только основные'));
  const toggle = el('button', 'theme-toggle');
  toggle.type = 'button';
  toggle.setAttribute('role', 'switch');
  toggle.setAttribute('aria-checked', showAll ? 'true' : 'false');
  toggle.setAttribute('aria-label', 'Показывать все выноски силуэта');
  toggle.append(el('span', 'theme-toggle__knob'));
  toggle.addEventListener('click', () => {
    if (state === null) return;
    state.showAllCallouts = setShowAllCallouts(!state.showAllCallouts);
    paint();
  });
  row.append(toggle);
  return row;
}

// Примерная ширина символа кириллицы для двух кеглей плашки (fig-guide__name
// 6.8px, fig-guide__reading 10.5px) — нужна только чтобы прикинуть, докуда
// тянется текст: не точный замер (getBBox недоступен до вставки узла
// в документ), а достаточный запас, чтобы плашка не обрезала длинные
// значения вроде «100,5 см».
const CALLOUT_NAME_GLYPH = 4.6;
const CALLOUT_READING_GLYPH = 6.6;

function calloutTextSpan(label, readingText) {
  const nameWidth = label.length * CALLOUT_NAME_GLYPH;
  const readingWidth = readingText.length * CALLOUT_READING_GLYPH;
  return Math.max(nameWidth, readingWidth, 20);
}

// Выноска-«плашка» (T19, вариант 1b из NewDesignTemplate/«Выноски -
// Варианты.dc.html», уже применённый в NewDesignTemplate/«Замеры -
// Фигура.dc.html»): скруглённая подложка вокруг подписи+значения видна
// всегда, не только при наведении — line+dot ведут к телу коротким
// хвостиком в макете, но здесь линия по-прежнему тянется до фиксированного
// столбца (54/306): на узком мобильном экране короткие хвостики у самого
// контура быстро налезли бы друг на друга по вертикали при 6-9 выносках
// сразу, а столбец страхует от коллизий (мобильный сценарий — основной,
// §10 контракта; макет — desktop-канва design-tool).
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
  const shortLabel = CALLOUT_SHORT.get(entry.key) ?? entry.label;
  const readingText = measured ? formatMeasurement(point.value, entry.unit) : '—';

  // Тач-цель шире тонкой выноски и обязана дотягиваться до края канвы со
  // стороны подписи: подпись и значение не умещаются в узкий отступ вокруг
  // textX, а pointer-events на самом тексте выключен (наследуется от
  // .fig-guide), поэтому раньше кликался только отрезок линии, а не текст
  // поверх него (§7.5: тап где угодно по выноске открывает шторку ввода).
  const bodyBound = Math.max(edge, end) + 4;
  const attachBound = Math.min(edge, end) - 4;
  const hit = svgEl('rect', 'fig-guide__hit');
  const hitLeft = left ? 4 : attachBound;
  const hitRight = left ? bodyBound : FIGURE_WIDTH - 4;
  hit.setAttribute('x', hitLeft);
  hit.setAttribute('y', node.y - 16);
  hit.setAttribute('width', hitRight - hitLeft);
  hit.setAttribute('height', 34);

  // Плашка вокруг подписи — всегда видна (в отличие от T13, где подсветка
  // появлялась только на фокусе/наведении), цвет несёт состояние
  // измерен/не измерен, hover/focus подсвечивают акцентом (style.css).
  const span = calloutTextSpan(shortLabel, readingText);
  const highlightPad = 6;
  const highlight = svgEl('rect', 'fig-guide__highlight');
  const highlightLeft = left
    ? Math.max(2, textX - span - highlightPad)
    : textX - highlightPad;
  const highlightRight = left
    ? textX + highlightPad
    : Math.min(FIGURE_WIDTH - 2, textX + span + highlightPad);
  highlight.setAttribute('x', highlightLeft);
  highlight.setAttribute('y', node.y - 15);
  highlight.setAttribute('width', highlightRight - highlightLeft);
  highlight.setAttribute('height', 30);
  highlight.setAttribute('rx', 8);

  const line = svgEl('line');
  line.setAttribute('x1', edge);
  line.setAttribute('x2', end);
  line.setAttribute('y1', node.y);
  line.setAttribute('y2', node.y);

  const dot = svgEl('circle', 'fig-guide__dot');
  dot.setAttribute('cx', edge);
  dot.setAttribute('cy', node.y);
  dot.setAttribute('r', 3);

  const name = svgEl('text', 'fig-guide__name');
  name.setAttribute('x', textX);
  name.setAttribute('y', node.y - 4);
  name.setAttribute('text-anchor', left ? 'end' : 'start');
  name.textContent = shortLabel;

  const reading = svgEl('text', measured && point.pending
    ? 'fig-guide__reading pending'
    : 'fig-guide__reading');
  reading.setAttribute('x', textX);
  reading.setAttribute('y', node.y + 10);
  reading.setAttribute('text-anchor', left ? 'end' : 'start');
  reading.textContent = readingText;

  guide.append(hit, highlight, line, dot, name, reading);
  guide.addEventListener('click', () => state?.sheetCtrl?.open(entry.key));
  guide.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    state?.sheetCtrl?.open(entry.key);
  });
  return guide;
}

function buildFigureCard(measurements, slice, profile, empty, showAllCallouts) {
  const values = valuesOf(measurements, slice);
  const geometry = silhouette(values, { figure: profile.sex });
  const card = el('section', empty ? 'fig-card fig-card--empty' : 'fig-card');

  const header = el('div', 'fig-profile');
  header.append(el('span', 'fig-profile__label', 'Силуэт'), buildSexField(profile));
  card.append(header);

  const svg = svgEl('svg', 'fig-svg');
  svg.setAttribute('viewBox', `0 0 ${FIGURE_WIDTH} 552`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-labelledby', 'figure-svg-title');

  const svgTitle = svgEl('title');
  svgTitle.setAttribute('id', 'figure-svg-title');
  svgTitle.textContent = empty ? 'Приглушённый силуэт без замеров' : 'Силуэт по выбранному срезу';

  // Заливка градиентом (T19) — .fig-body ссылается на неё через
  // fill: url(#figure-body-gradient) в style.css, цвет самих стопов тоже
  // идёт из var(--body-grad-*), а не литералом.
  const defs = svgEl('defs');
  const gradient = svgEl('linearGradient');
  gradient.setAttribute('id', 'figure-body-gradient');
  gradient.setAttribute('x1', '0');
  gradient.setAttribute('y1', '0');
  gradient.setAttribute('x2', '0');
  gradient.setAttribute('y2', '1');
  const stopTop = svgEl('stop');
  stopTop.setAttribute('offset', '0');
  stopTop.setAttribute('stop-color', 'var(--body-grad-top)');
  const stopBottom = svgEl('stop');
  stopBottom.setAttribute('offset', '1');
  stopBottom.setAttribute('stop-color', 'var(--body-grad-bottom)');
  gradient.append(stopTop, stopBottom);
  defs.append(gradient);

  const ground = svgEl('ellipse', 'fig-ground');
  ground.setAttribute('cx', '180');
  ground.setAttribute('cy', geometry.ground.y);
  ground.setAttribute('rx', geometry.ground.r);
  ground.setAttribute('ry', '5.5');

  const body = svgEl('path', 'fig-body');
  body.setAttribute('d', geometry.paths[0].d);

  svg.append(svgTitle, defs, ground, body);

  const byKey = new Map(measurements.map((entry) => [entry.key, entry]));
  const calloutKeys = showAllCallouts ? CALLOUT_KEYS : CALLOUT_KEYS.filter((key) => CALLOUT_PRIMARY.has(key));
  for (const key of calloutKeys) {
    const entry = byKey.get(key);
    const node = entry?.svg_id ? geometry.nodes[entry.svg_id] : null;
    if (!entry || !node) continue;
    svg.append(buildCallout(entry, pointOf(slice, key), node));
  }

  card.append(svg);
  card.append(buildPinsToggle(showAllCallouts));
  return card;
}

// Точка-индикатор вместо тонированного фона карточки (T20, макет) — цвет
// несёт тот же смысл, что раньше нёс фон целиком. tone — имя KPI для
// сторожей/детального окна (weight/bmi/whr), status — good/warn для
// ИМТ и WHR (нет status у веса — у него нет диапазона нормы).
function buildKpi(label, value, unit, sub, tone, status) {
  const classes = ['kpi', 'kpi--interactive', `kpi--${tone}`];
  if (status) classes.push(`kpi--${status}`);
  const card = el('article', classes.join(' '));
  card.setAttribute('role', 'button');
  card.setAttribute('tabindex', '0');
  card.setAttribute('aria-haspopup', 'dialog');
  card.setAttribute('aria-label', `Подробнее: ${label}`);
  card.addEventListener('click', () => state?.detailCtrl?.open(tone, card));
  card.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    state?.detailCtrl?.open(tone, card);
  });
  card.append(el('span', 'kpi__dot'));
  const figures = el('div', 'kpi__figures');
  figures.append(el('strong', value === '—' ? 'kpi__value kpi__value--missing' : 'kpi__value', value));
  if (unit) figures.append(el('span', 'kpi__unit', unit));
  card.append(
    figures,
    el('span', 'kpi__label', label),
    el('span', 'kpi__sub', sub)
  );
  return card;
}

function daysBefore(value, days) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ''))) return null;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function weightKpiSub(weight) {
  if (!weight || !state?.selectedDate) return 'не измерено';
  const previousDate = daysBefore(state.selectedDate, 30);
  const previous = previousDate
    ? weightPointsForYear(state.index, state.pending, state.selectedDate)
      .find((point) => point.date >= previousDate && point.date < weight.date)
    : null;
  const change = delta(previous, weight, getMeasurement('weight'));
  if (!Number.isFinite(change.value) || previous?.date === weight.date) return formatDate(weight.date);
  const sign = change.value > 0 ? '+' : change.value < 0 ? '−' : '';
  return `${sign}${formatMeasurement(Math.abs(change.value), 'kg')} за 30 дней`;
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
  const bmiGood = bmi !== null && bmi >= 18.5 && bmi < 25;
  const threshold = state?.profile?.sex === 'female' ? 0.85 : 0.90;
  const whrGood = whr !== null && whr < threshold;

  const grid = el('section', 'kpi-grid', undefined);
  grid.setAttribute('aria-label', 'Ключевые показатели');
  grid.append(
    buildKpi(
      'Вес',
      weight ? formatNumber(weight.value) : '—',
      'кг',
      weightKpiSub(weight),
      'weight'
    ),
    buildKpi(
      'ИМТ',
      bmi === null ? '—' : formatNumber(bmi, 1),
      '',
      bmi === null ? 'нужны рост и вес' : 'расчётный',
      'bmi',
      bmi === null ? null : (bmiGood ? 'good' : 'warn')
    ),
    buildKpi(
      'Талия / бёдра',
      whr === null ? '—' : formatNumber(whr, 2),
      '',
      whr === null ? 'нужны талия WHO и бёдра' : 'расчётный WHR',
      'whr',
      whr === null ? null : (whrGood ? 'good' : 'warn')
    )
  );
  return grid;
}

function oneYearBefore(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ''))) return null;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCFullYear(date.getUTCFullYear() - 1);
  return date.toISOString().slice(0, 10);
}

function weightPointsForYear(index, pending, endDate) {
  const startDate = oneYearBefore(endDate);
  if (!startDate) return [];
  const result = [];
  const seen = new Set();
  for (const date of sliceDates(index, pending)) {
    if (date < startDate || date > endDate) continue;
    const point = pointOf(sliceAt(index, date, pending), 'weight');
    if (!point || point.date !== date || seen.has(point.date)) continue;
    seen.add(point.date);
    result.push({
      date: point.date,
      value: point.value,
      protocol_version: point.protocolVersion
    });
  }
  return result;
}

function detailHead(title, eyebrow, onClose) {
  const head = el('header', 'metric-detail__head');
  const copy = el('div');
  copy.append(
    el('span', 'metric-detail__eyebrow', eyebrow),
    el('h2', 'metric-detail__title', title)
  );
  const close = el('button', 'metric-detail__close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Закрыть подробности');
  close.addEventListener('click', onClose);
  head.append(copy, close);
  return { head, close };
}

function referenceRow(label, range, current, marker) {
  const row = el('li', current ? 'metric-range metric-range--current' : 'metric-range');
  row.append(
    el('span', 'metric-range__label', label),
    el('span', 'metric-range__value', range)
  );
  if (current && marker) row.append(el('span', 'metric-range__marker', marker));
  return row;
}

function buildWeightDetail(onClose) {
  const endDate = state?.selectedDate;
  const points = weightPointsForYear(state?.index, state?.pending, endDate);
  const card = el('section', 'metric-detail metric-detail--weight');
  const { head, close } = detailHead('Вес за 12 месяцев', 'Динамика', onClose);
  card.append(head);

  if (points.length === 0) {
    card.append(el('p', 'metric-detail__empty', 'За этот период замеров веса нет.'));
    return { card, close };
  }

  const first = points[0];
  const last = points.at(-1);
  const change = last.value - first.value;
  const hasChange = points.length > 1;
  const sign = change > 0 ? '+' : change < 0 ? '−' : '';
  const amount = `${sign}${formatMeasurement(Math.abs(change), 'kg')}`;
  const summary = el('div', 'metric-detail__hero');
  summary.append(
    el('strong', 'metric-detail__hero-value', formatMeasurement(last.value, 'kg')),
    el(
      'span',
      `metric-detail__change${hasChange && change > 0 ? ' metric-detail__change--up' : hasChange && change < 0 ? ' metric-detail__change--down' : ''}`,
      hasChange ? `${amount} за период` : 'Нужен ещё один замер'
    )
  );
  card.append(summary);

  const chartBox = el('div', 'metric-detail__chart');
  const chart = sparkline(points, { width: 560, height: 128 });
  chart.setAttribute(
    'aria-label',
    `Вес с ${formatDate(first.date)} по ${formatDate(last.date)}: с ${formatMeasurement(first.value, 'kg')} до ${formatMeasurement(last.value, 'kg')}`
  );
  chartBox.append(chart);
  card.append(chartBox);

  const axis = el('div', 'metric-detail__axis');
  axis.append(
    el('span', null, `${formatDate(first.date)} · ${formatMeasurement(first.value, 'kg')}`),
    el('span', null, `${formatDate(last.date)} · ${formatMeasurement(last.value, 'kg')}`)
  );
  card.append(axis, el('p', 'metric-detail__note', `${points.length} ${points.length === 1 ? 'замер' : points.length < 5 ? 'замера' : 'замеров'} в выбранном годовом окне.`));
  return { card, close };
}

function buildBmiDetail(onClose) {
  const weight = pointOf(state?.slice, 'weight');
  const height = pointOf(state?.slice, 'height');
  const bmi = weight && height && height.value > 0
    ? weight.value / ((height.value / 100) ** 2)
    : null;
  const card = el('section', 'metric-detail metric-detail--bmi');
  const { head, close } = detailHead('Индекс массы тела', 'Ориентиры для взрослых', onClose);
  card.append(head);

  if (bmi === null) {
    card.append(el('p', 'metric-detail__empty', 'Добавьте рост и вес, чтобы увидеть персональный ориентир.'));
  } else {
    card.append(el(
      'p',
      'metric-detail__summary',
      `${formatMeasurement(weight.value, 'kg')} при росте ${formatMeasurement(height.value, 'cm')} — ИМТ ${formatNumber(bmi, 1)}.`
    ));
  }

  const ranges = el('ul', 'metric-ranges');
  ranges.append(
    referenceRow('Недостаточный вес', 'до 18,5', bmi !== null && bmi < 18.5, bmi === null ? '' : `Ваш ИМТ ${formatNumber(bmi, 1)}`),
    referenceRow('Нормальный диапазон', '18,5–24,9', bmi !== null && bmi >= 18.5 && bmi < 25, bmi === null ? '' : `Ваш ИМТ ${formatNumber(bmi, 1)}`),
    referenceRow('Избыточный вес', '25,0–29,9', bmi !== null && bmi >= 25 && bmi < 30, bmi === null ? '' : `Ваш ИМТ ${formatNumber(bmi, 1)}`),
    referenceRow('Ожирение', '30,0 и выше', bmi !== null && bmi >= 30, bmi === null ? '' : `Ваш ИМТ ${formatNumber(bmi, 1)}`)
  );
  card.append(ranges);

  if (height && height.value > 0) {
    const heightM2 = (height.value / 100) ** 2;
    card.append(el(
      'p',
      'metric-detail__personal',
      `При вашем росте нормальному диапазону ИМТ соответствует примерно ${formatNumber(18.5 * heightM2, 1)}–${formatNumber(24.9 * heightM2, 1)} кг.`
    ));
  }
  card.append(el('p', 'metric-detail__note', 'ИМТ — скрининговый ориентир, а не диагноз: он не различает мышечную и жировую массу. Диапазоны — классификация ВОЗ для взрослых.'));
  return { card, close };
}

function buildWhrDetail(onClose) {
  const waist = pointOf(state?.slice, 'waist_who');
  const hip = pointOf(state?.slice, 'hip');
  const whr = waist && hip && hip.value > 0 ? waist.value / hip.value : null;
  const female = state?.profile?.sex === 'female';
  const threshold = female ? 0.85 : 0.90;
  const sexLabel = female ? 'женского' : 'мужского';
  const card = el('section', 'metric-detail metric-detail--whr');
  const { head, close } = detailHead('Талия / бёдра', `WHR для ${sexLabel} профиля`, onClose);
  card.append(head);

  if (whr === null) {
    card.append(el('p', 'metric-detail__empty', 'Добавьте талию WHO и обхват бёдер, чтобы увидеть персональный ориентир.'));
  } else {
    card.append(el(
      'p',
      'metric-detail__summary',
      `${formatMeasurement(waist.value, 'cm')} / ${formatMeasurement(hip.value, 'cm')} = ${formatNumber(whr, 2)}.`
    ));
  }

  const ranges = el('ul', 'metric-ranges');
  ranges.append(
    referenceRow('Ниже порога', `< ${formatNumber(threshold, 2)}`, whr !== null && whr < threshold, whr === null ? '' : `Ваш WHR ${formatNumber(whr, 2)}`),
    referenceRow('Скрининговый порог', `≥ ${formatNumber(threshold, 2)}`, whr !== null && whr >= threshold, whr === null ? '' : `Ваш WHR ${formatNumber(whr, 2)}`)
  );
  card.append(ranges);

  if (waist && hip && hip.value > 0) {
    const thresholdWaist = threshold * hip.value;
    const difference = waist.value - thresholdWaist;
    const position = difference < 0 ? 'ниже' : difference > 0 ? 'выше' : 'на уровне';
    const differenceText = difference === 0 ? '' : ` на ${formatMeasurement(Math.abs(difference), 'cm')}`;
    card.append(el(
      'p',
      'metric-detail__personal',
      `При ваших бёдрах ${formatMeasurement(hip.value, 'cm')} порог соответствует талии ${formatMeasurement(thresholdWaist, 'cm')}. Сейчас талия${differenceText} ${position} порога.`
    ));
  }
  card.append(el('p', 'metric-detail__note', 'WHR — отношение талии WHO к бёдрам. Порог ВОЗ указывает на существенно повышенный метаболический риск, но не заменяет медицинскую оценку.'));
  return { card, close };
}

function buildMetricDetail(kind, onClose) {
  const scrim = el('div', 'sheet__scrim metric-detail__scrim');
  scrim.addEventListener('click', (event) => {
    if (event.target === scrim) onClose();
  });
  const detail = kind === 'weight'
    ? buildWeightDetail(onClose)
    : kind === 'bmi'
      ? buildBmiDetail(onClose)
      : buildWhrDetail(onClose);
  detail.card.setAttribute('role', 'dialog');
  detail.card.setAttribute('aria-modal', 'true');
  detail.card.setAttribute('aria-label', firstText(detail.card, 'metric-detail__title'));
  scrim.append(detail.card);
  return { scrim, close: detail.close };
}

function firstText(root, className) {
  const pending = [...root.children];
  while (pending.length > 0) {
    const node = pending.shift();
    if (node.classList?.contains(className)) return node.textContent;
    pending.push(...node.children);
  }
  return '';
}

export function createMetricDetailController({ host }) {
  let kind = null;
  let trigger = null;
  let active = true;

  function close() {
    if (!active || !kind) return;
    kind = null;
    host.replaceChildren();
    window.removeEventListener('keydown', handleKeydown);
    trigger?.focus?.();
    trigger = null;
  }

  function handleKeydown(event) {
    if (event.key === 'Escape') close();
  }

  function open(nextKind, nextTrigger = null) {
    if (!active || !['weight', 'bmi', 'whr'].includes(nextKind)) return;
    if (kind) window.removeEventListener('keydown', handleKeydown);
    kind = nextKind;
    trigger = nextTrigger;
    const detail = buildMetricDetail(kind, close);
    host.replaceChildren(detail.scrim);
    window.addEventListener('keydown', handleKeydown);
    detail.close.focus?.();
  }

  function destroy() {
    window.removeEventListener('keydown', handleKeydown);
    active = false;
    kind = null;
    trigger = null;
    host.replaceChildren();
  }

  return { open, close, destroy, isOpen: () => kind !== null };
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

// Замер физически влияет на силуэт — акцентная левая граница строки (T20,
// макет). Не про наличие svg_id: рост не рисует свою выноску, но задаёт
// масштаб всей фигуры (figure.js: v.height делит все остальные размеры),
// поэтому вместе с svg_id-замерами он тоже помечен. Единственные два
// исключения — вес (не геометрический размер) и указательный палец
// (не участвует в geom() вовсе, только собственная история).
function affectsFigure(key) {
  return key !== 'weight' && key !== 'finger_index';
}

function buildRow(entry, point, index, pending) {
  const classes = ['mrow'];
  if (!point) classes.push('mrow--missing');
  if (affectsFigure(entry.key)) classes.push('mrow--affects');
  const row = el('div', classes.join(' '));
  row.dataset.key = entry.key;
  row.setAttribute('role', 'button');
  row.setAttribute('tabindex', '0');
  row.setAttribute('aria-label', `Внести замер: ${entry.label}`);
  row.addEventListener('click', () => state?.sheetCtrl?.open(entry.key));
  row.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    state?.sheetCtrl?.open(entry.key);
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

function buildGroups(measurements, slice, index, pending, selectedDate) {
  const byKey = new Map(measurements.map((entry) => [entry.key, entry]));
  const card = el('section', 'measurements-card card');
  const head = el('header', 'measurements-card__head');
  head.append(
    el('h2', 'measurements-card__title', 'Измерения'),
    el('span', 'measurements-card__date', selectedDate ? formatDate(selectedDate) : 'нет данных')
  );
  card.append(head);

  for (const group of GROUPS) {
    const section = el('section', 'mgroup');
    section.append(el('h3', null, group.title));
    for (const key of group.keys) {
      const entry = byKey.get(key);
      if (entry) section.append(buildRow(entry, pointOf(slice, key), index, pending));
    }
    card.append(section);
  }

  return card;
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
  const controls = el('div', 'figure-controls');
  controls.append(figureSubtabs('figure'));
  const nodes = [controls];
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
    controls.append(buildDateStrip(dates, state.selectedDate, new Set(Object.keys(pending))));
  }
  setHeaderSubtitle(state.selectedDate ? `Замер ${formatDate(state.selectedDate)}` : 'Текущие значения');

  const slice = state.selectedDate ? sliceAt(state.index, state.selectedDate, pending) : {};
  state.slice = slice;
  const measured = state.measurements.filter((entry) => pointOf(slice, entry.key)).length;
  const empty = measured === 0;

  const layout = el('div', 'figure-layout');
  layout.append(buildFigureCard(state.measurements, slice, state.profile, empty, state.showAllCallouts));

  const summary = el('div', 'figure-summary');
  summary.append(empty ? buildEmptyState() : buildKpis(slice));
  summary.append(buildGroups(state.measurements, slice, state.index, pending, state.selectedDate));
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
    const file = await readFile(accountIndexPath(getActiveAccount()));
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
  const detailHost = el('div', 'metric-detail-host');
  root.append(mainHost, sheetHost, detailHost);
  state = {
    token,
    root,
    mainHost,
    sheetHost,
    detailHost,
    measurements: cachedCatalog.length > 0 ? figureMeasurements() : [],
    index: cache && isRecord(cache.data) ? cache.data : null,
    selectedDate: null,
    slice: {},
    sheetCtrl: null,
    detailCtrl: null,
    profile,
    showAllCallouts: getShowAllCallouts(),
    pending: {},
    catalogReady: cachedCatalog.length > 0,
    error: null,
    loading: true
  };
  state.sheetCtrl = createSheetController({
    host: sheetHost,
    getPoint: (key) => pointOf(state.slice, key),
    onSaved: () => {}
  });
  state.detailCtrl = createMetricDetailController({ host: detailHost });

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
  if (state?.sheetCtrl) state.sheetCtrl.destroy();
  if (state?.detailCtrl) state.detailCtrl.destroy();
  if (mountedRoot) mountedRoot.classList.remove('figure-screen');
  mountedRoot = null;
  mountToken += 1;
  state = null;
}
