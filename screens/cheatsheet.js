// Шпаргалка — стартовый экран (§7.1 спеки, T4, контракт §2).
//
// Сквозное правило контракта (§13): устаревшие значения не скрываются никогда.
// Замер старше frequency_days x 2 получает приглушённую дату (.date--stale)
// и остаётся на своём месте в полном размере. Ни одной ветки, которая
// выбрасывает строку из вывода, в этом файле быть не должно: в магазине
// одежды замер полугодовой давности полезнее пустого места.
//
// Порядок работы (§8 спеки — отрисовка < 1 с при холодном старте офлайн):
//   1) локальный каталог + кэш index.json из store.js — экран рисуется сразу;
//      кэша нет — рисуется полный каркас строк с прочерками, а не пустота;
//   2) обновление index.json уходит в фон и дорисовывает поверх;
//   3) сеть не ответила — оставляем нарисованное и объясняем, что случилось
//      и когда кэш обновлялся.
// Первый рендер не ждёт сеть ни при каких условиях.
//
// repo B приватный, поэтому raw.githubusercontent.com без авторизации данные
// не отдаёт — читаем только через github.js. Текст у GitHubError уже русский
// и конкретный (§4 контракта), показываем его как есть.

import { setHeaderStatus } from '../app.js';
import { readFile, GitHubError } from '../github.js';
import { getIndexCache, setIndexCache } from '../store.js';
import { loadCatalog, cheatsheetMeasurements } from '../catalog.js';

export const title = 'Шпаргалка';

const INDEX_PATH = 'index.json';

// Эти три динамических замера дублируются в «Для покупок» намеренно (§7.1):
// в магазине они нужны рядом с ростом и длиной рукава.
const SHOPPING_EXTRA_KEYS = Object.freeze(['chest', 'hip', 'neck']);

const UNITS = new Map([['cm', 'см'], ['kg', 'кг']]);
const DAY_MS = 86400000;
const DAY_FORMS = Object.freeze(['день', 'дня', 'дней']);

const EMPTY_VALUE = '—'; // тире вместо числа: пустое место подсказывает, что пора мерить
const NO_DATE_TEXT = 'нет данных';
const BAD_DATE_TEXT = 'дата неизвестна'; // значение есть, а дата битая — молчать нельзя

// Длиннее в .status шапки не влезает — обрезаем по слову.
const STATUS_MAX = 40;

let mountToken = 0;
let state = null;

// ===== Чистые функции =====================================================
// Экспортируются ради cheatsheet.selftest.mjs — прецедент utf8ToBase64
// в github.js (§13 контракта, T2). Приложение зовёт их отсюда же.

// 'YYYY-MM-DD' (и любой ISO, начинающийся с даты) -> части; мусор -> null.
function parseISODate(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const stamp = Date.UTC(year, month - 1, day);
  const probe = new Date(stamp);
  // Отсекаем 2026-02-31 и прочие несуществующие даты.
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return null;
  }
  return { stamp, year, month, day };
}

// Календарный день как метка полуночи UTC: разница считается в сутках
// и не плывёт от часового пояса и перехода на летнее время.
function toDayStamp(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return Date.UTC(value.getFullYear(), value.getMonth(), value.getDate());
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  // Полная метка времени (fetchedAt из store.js) — переводим в местный день:
  // «обновлено сегодня» считается по календарю пользователя, а не по UTC.
  if (/\d{2}:\d{2}/.test(text)) {
    const parsed = new Date(text);
    if (Number.isNaN(parsed.getTime())) return null;
    return Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
  }
  const parts = parseISODate(text);
  return parts ? parts.stamp : null;
}

// Замер устарел, если прошло больше frequency_days x 2 (§7.1).
// Граница включительная: ровно два срока — ещё свежо.
// Статика (frequency_days === null) не устаревает никогда.
export function isStale(dateISO, frequencyDays, today = new Date()) {
  if (!Number.isFinite(frequencyDays) || frequencyDays <= 0) return false;
  const measured = toDayStamp(dateISO);
  const now = toDayStamp(today);
  if (measured === null || now === null) return false;
  return Math.round((now - measured) / DAY_MS) > frequencyDays * 2;
}

// Число руками, без toLocaleString: результат обязан совпадать в браузере
// и в node, где ICU может оказаться урезанным. Хвостовых нулей не бывает —
// String(86.80) это '86.8'.
function formatNumber(number) {
  const rounded = Math.round(number * 100) / 100; // гасим хвосты float
  return String(rounded).replace('.', ',');
}

// 86.8, 'cm' -> '86,8 см'. Значения нет -> прочерк.
export function formatValue(value, unit) {
  if (typeof value !== 'number' && typeof value !== 'string') return EMPTY_VALUE;
  if (typeof value === 'string' && value.trim() === '') return EMPTY_VALUE;
  const number = Number(value);
  if (!Number.isFinite(number)) return EMPTY_VALUE;
  const raw = typeof unit === 'string' ? unit.trim() : '';
  // Незнакомая единица показывается как есть — врать про неё нечего.
  const suffix = raw === '' ? '' : (UNITS.get(raw) ?? raw);
  const text = formatNumber(number);
  return suffix === '' ? text : `${text} ${suffix}`;
}

// '2026-08-14' -> '14.08.2026'. Мусор -> пустая строка.
export function formatDate(dateISO) {
  const parts = parseISODate(dateISO);
  if (!parts) return '';
  const day = String(parts.day).padStart(2, '0');
  const month = String(parts.month).padStart(2, '0');
  return `${day}.${month}.${parts.year}`;
}

// Русские числительные: 1 день / 2 дня / 5 дней.
function pluralDays(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return DAY_FORMS[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return DAY_FORMS[1];
  return DAY_FORMS[2];
}

// Возраст кэша словами (§7.1: «из кэша, обновлено 3 дня назад»).
export function describeCacheAge(fetchedAtISO, now = new Date()) {
  const from = toDayStamp(fetchedAtISO);
  const to = toDayStamp(now);
  if (from === null || to === null) return 'Из кэша';
  const days = Math.round((to - from) / DAY_MS);
  // Отрицательная разница — часы устройства ушли вперёд и вернулись назад.
  if (days <= 0) return 'Из кэша, обновлено сегодня';
  if (days === 1) return 'Из кэша, обновлено вчера';
  return `Из кэша, обновлено ${days} ${pluralDays(days)} назад`;
}

// Текст для .status в шапке: она однострочная, CSS обрежет её многоточием
// по ширине, но обрезка по слову читается лучше обрубка посреди слова.
export function shortenStatus(text, max = STATUS_MAX) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (value.length <= max) return value;
  const cut = value.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  // По слову — только если слово не съедает больше половины строки.
  const head = space > max / 2 ? cut.slice(0, space) : cut;
  return `${head.replace(/[\s.,;:—-]+$/, '')}…`;
}

// ===== Разбор данных ======================================================

function errorText(error) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim() !== '') return error.trim();
  return 'Не удалось обновить данные.';
}

function parseIndex(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('index.json на сервере не разбирается как JSON.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('index.json не похож на агрегат из §6.2 спеки.');
  }
  return data;
}

// latest из §6.2 -> Map. Через Map, а не по ключам объекта: в JSON может
// прилететь ключ вроде '__proto__', и обращение по нему даст не то.
function latestMap(data) {
  const map = new Map();
  const latest = data && typeof data === 'object' ? data.latest : null;
  if (!latest || typeof latest !== 'object') return map;
  for (const [key, entry] of Object.entries(latest)) {
    if (entry && typeof entry === 'object') map.set(key, entry);
  }
  return map;
}

// Порядок обеих секций — строго порядок catalog.json, без пересортировки.
// Одна и та же запись может попасть в обе секции — это намеренно (§7.1).
function shoppingList(measurements) {
  return measurements.filter((item) => item.class === 'static' || SHOPPING_EXTRA_KEYS.includes(item.key));
}

function dynamicList(measurements) {
  return measurements.filter((item) => item.class === 'dynamic');
}

// ===== Отрисовка ==========================================================

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function makeButton(text, onClick, disabled) {
  const button = el('button', 'btn', text);
  button.type = 'button';
  button.disabled = Boolean(disabled);
  button.addEventListener('click', onClick);
  return button;
}

function buildActions(...nodes) {
  const wrap = el('div', 'cheat-actions');
  wrap.append(...nodes);
  return wrap;
}

// Значение и единица — отдельными узлами: с вытянутой руки читается число,
// «см» такого кегля не требует. Единственный источник формата — formatValue,
// здесь только разрез по пробелу.
function valueParts(value, unit) {
  const text = formatValue(value, unit);
  const space = text.indexOf(' ');
  if (space === -1) return { number: text, unit: '' };
  return { number: text.slice(0, space), unit: text.slice(space + 1) };
}

// Строка строится всегда: и без значения, и с древним. Вся строка целиком —
// ссылка в историю замера (экран T8), тач-цель задана в .cheat-row.
function buildRow(measurement, latest, today) {
  const row = el('a', 'row cheat-row');
  row.href = `#/history/${encodeURIComponent(measurement.key)}`;

  const info = el('span', 'cheat-row__info');
  info.append(el('span', 'label cheat-row__name', measurement.label));
  const date = el('span', 'date');

  const box = el('span', 'cheat-row__value');
  const parts = valueParts(latest ? latest.value : null, measurement.unit);
  const value = el('span', 'value', parts.number);
  box.append(value);
  if (parts.unit !== '') box.append(el('span', 'cheat-row__unit', parts.unit));

  if (parts.number === EMPTY_VALUE) {
    // Данных нет — строка всё равно на месте, прятать её нельзя (§13).
    value.classList.add('value--empty');
    date.textContent = NO_DATE_TEXT;
  } else {
    const text = formatDate(latest.date);
    date.textContent = text === '' ? BAD_DATE_TEXT : text;
    // Просрочка помечается только на дате: значение остаётся полноразмерным
    // и обычного цвета (§13).
    if (text !== '' && isStale(latest.date, measurement.frequency_days, today)) {
      date.classList.add('date--stale');
    }
  }

  info.append(date);
  row.append(info, box);
  return row;
}

function buildSection(heading, list, latest, today) {
  const card = el('section', 'card cheat-section');
  card.append(el('h2', null, heading));
  for (const measurement of list) {
    card.append(buildRow(measurement, latest.get(measurement.key) ?? null, today));
  }
  return card;
}

// Полный текст ошибки — карточкой на самом экране: в шапку он не влезает.
function buildNotice(error, heading) {
  const card = el('section', 'card cheat-notice');
  card.append(el('h2', null, heading));
  card.append(el('p', 'warn', errorText(error)));
  if (error instanceof GitHubError && error.kind === 'no-token') {
    const link = el('a', 'btn cheat-notice__link', 'Открыть настройки');
    link.href = '#/settings';
    card.append(link);
  }
  return card;
}

// ===== Состояние экрана ===================================================

// Ответ, пришедший после ухода с экрана или после нового render(),
// не должен рисовать в чужой root (§13 контракта, решение T1 про mountToken).
function outdated(token) {
  return state === null || state.token !== token;
}

function applyStatus() {
  if (state === null) return;
  if (state.loading) {
    setHeaderStatus('Обновляю…', null);
    return;
  }
  if (state.error === null) {
    setHeaderStatus('Актуально', 'ok');
    return;
  }
  // Кэш есть — экран полезен, ошибка ушла в карточку, в шапке возраст данных.
  if (state.index !== null) {
    setHeaderStatus(describeCacheAge(state.fetchedAt, new Date()), 'stale');
    return;
  }
  setHeaderStatus(shortenStatus(errorText(state.error)), 'error');
}

function paint() {
  if (state === null) return;
  const today = new Date();
  const latest = latestMap(state.index);
  const nodes = [];

  if (state.error !== null) nodes.push(buildNotice(state.error, 'Данные не обновились'));
  nodes.push(buildSection('Для покупок', shoppingList(state.measurements), latest, today));
  nodes.push(buildSection('Динамика', dynamicList(state.measurements), latest, today));
  // Без кнопки после ошибки нет способа перезапросить, кроме перезагрузки.
  nodes.push(buildActions(makeButton('Обновить', requestRefresh, state.loading)));

  state.root.replaceChildren(...nodes);
  applyStatus();
}

async function runRefresh(token) {
  try {
    const file = await readFile(INDEX_PATH);
    const data = parseIndex(file.content);
    if (outdated(token)) return;
    const saved = setIndexCache(data);
    state.index = data;
    state.fetchedAt = saved ? saved.fetchedAt : new Date().toISOString();
    state.error = null;
  } catch (error) {
    if (outdated(token)) return;
    // Кэш остаётся ровно таким, каким был: нарисованное не стираем.
    state.error = error;
  }
  if (outdated(token)) return;
  state.loading = false;
  paint();
}

// Кнопка «Обновить» и событие online. Повторный вызов во время запроса
// игнорируется: кнопка в это время и так disabled.
function requestRefresh() {
  if (state === null || state.loading) return;
  state.loading = true;
  paint();
  void runRefresh(state.token);
}

function handleOnline() {
  requestRefresh();
}

// ===== Контракт экрана ====================================================

export async function render(root, params) {
  const token = ++mountToken;
  // Повторный render без destroy не должен копить слушателей.
  window.removeEventListener('online', handleOnline);
  state = null;

  let measurements;
  try {
    await loadCatalog();
    measurements = cheatsheetMeasurements();
  } catch (error) {
    // Пока грузился каталог, мог случиться переход на другой экран.
    if (token !== mountToken) return;
    const card = buildNotice(error, 'Каталог замеров не загрузился');
    card.append(buildActions(makeButton('Повторить', () => {
      void render(root, params);
    })));
    root.replaceChildren(card);
    setHeaderStatus(shortenStatus(errorText(error)), 'error');
    return;
  }
  if (token !== mountToken) return;

  const cache = getIndexCache();
  state = {
    token,
    root,
    measurements,
    index: cache ? cache.data : null,
    fetchedAt: cache ? cache.fetchedAt : null,
    error: null,
    loading: true
  };

  // Первая отрисовка — до любого сетевого запроса (§8 спеки).
  paint();
  window.addEventListener('online', handleOnline);
  void runRefresh(token);
}

export function destroy() {
  window.removeEventListener('online', handleOnline);
  // Токен растёт и здесь: незавершённый runRefresh обязан увидеть отмену,
  // даже если следующий экран ещё не смонтирован.
  mountToken += 1;
  state = null;
}
