// История одного замера (T8, §7.3 спеки).
// Спарклайн берётся из агрегированного index.json, а таблица — из исходных
// неизменяемых data/*.json: только там сохранены повторы raw и примечание.

import { setHeaderStatus } from '../app.js';
import { getMeasurement, loadCatalog } from '../catalog.js';
import { readFile, listFiles } from '../github.js';
import { sparkline } from '../sparkline.js';
import { getIndexCache, setIndexCache } from '../store.js';

export const title = 'История';

const INDEX_PATH = 'index.json';
const SESSION_NAME = /^\d{4}-\d{2}-\d{2}(?:--\d+)?\.json$/i;
const UNIT_LABELS = new Map([['cm', 'см'], ['kg', 'кг']]);

let mountToken = 0;
let state = null;

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what} содержит некорректный JSON.`);
  }
}

function indexData(text) {
  const data = parseJson(text, 'index.json');
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('index.json имеет неверный формат.');
  }
  return data;
}

function cachedIndex() {
  const cached = getIndexCache();
  return cached && cached.data && typeof cached.data === 'object' ? cached.data : null;
}

function normalizeProtocolVersion(value) {
  return Number.isInteger(value) && value >= 1 ? value : '?';
}

function seriesFor(data, key) {
  const points = data?.series?.[key];
  if (!Array.isArray(points)) return [];
  return points
    .filter((point) => (
      point
      && typeof point.date === 'string'
      && Number.isFinite(point.value)
    ))
    .map((point) => ({
      date: point.date,
      value: point.value,
      protocol_version: normalizeProtocolVersion(point.protocol_version)
    }));
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return '—';
  const rounded = Math.round(value * 100) / 100;
  return String(Object.is(rounded, -0) ? 0 : rounded).replace('.', ',');
}

function formatValue(value, unit) {
  const number = formatNumber(value);
  if (number === '—') return number;
  const label = UNIT_LABELS.get(unit) ?? unit;
  return label ? `${number} ${label}` : number;
}

function formatDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  if (!match) return 'дата неизвестна';
  return `${match[3]}.${match[2]}.${match[1]}`;
}

function protocolVersion(entry, session) {
  const own = normalizeProtocolVersion(entry?.protocol_version);
  return own === '?' ? normalizeProtocolVersion(session?.protocol_version) : own;
}

function sessionOrder(name) {
  const match = /^(\d{4}-\d{2}-\d{2})(?:--(\d+))?\.json$/i.exec(name);
  return {
    date: match?.[1] ?? '',
    sequence: match?.[2] ? Number(match[2]) : 1
  };
}

function rowFromSession(file, session, key) {
  if (!session || !Array.isArray(session.entries)) return null;
  const entry = session.entries.find((item) => item?.key === key);
  if (!entry || !Number.isFinite(entry.value)) return null;
  const raw = Array.isArray(entry.raw) && entry.raw.every(Number.isFinite) ? entry.raw : [];
  return {
    path: file.path,
    sequence: sessionOrder(file.name).sequence,
    date: nonEmptyString(session.date) ? session.date : '',
    time: /^\d{2}:\d{2}$/.test(session.time) ? session.time : '',
    value: entry.value,
    unit: nonEmptyString(entry.unit) ? entry.unit : '',
    raw,
    protocol: protocolVersion(entry, session),
    note: typeof entry.note === 'string' ? entry.note.trim() : ''
  };
}

function pointsFromRows(rows) {
  return rows.slice().reverse().map((row) => ({
    date: row.date,
    value: row.value,
    protocol_version: normalizeProtocolVersion(row.protocol)
  }));
}

async function loadRows(key) {
  const files = (await listFiles('data'))
    .filter((file) => typeof file.name === 'string' && SESSION_NAME.test(file.name))
    .sort((left, right) => {
      const leftOrder = sessionOrder(left.name);
      const rightOrder = sessionOrder(right.name);
      return leftOrder.date.localeCompare(rightOrder.date)
        || leftOrder.sequence - rightOrder.sequence;
    });
  const sessions = await Promise.allSettled(files.map(async (file) => {
    const result = await readFile(file.path);
    return { file, data: parseJson(result.content, file.path) };
  }));
  const skipped = [];
  const rows = sessions
    .map((result, index) => {
      if (result.status === 'rejected') {
        skipped.push(files[index].path);
        return null;
      }
      return rowFromSession(result.value.file, result.value.data, key);
    })
    .filter(Boolean)
    .sort((left, right) => {
      const byMoment = `${right.date}T${right.time}`.localeCompare(`${left.date}T${left.time}`);
      return byMoment || right.sequence - left.sequence || right.path.localeCompare(left.path);
    });
  return { rows, skipped };
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function errorText(error) {
  if (typeof error === 'string' && error.trim() !== '') return error.trim();
  return error instanceof Error && error.message ? error.message : 'Подробностей нет.';
}

function notice(heading, message) {
  const card = el('section', 'card history-notice');
  card.append(el('h2', null, heading));
  card.append(el('p', 'warn', message));
  return card;
}

function buildChart(measurement, points) {
  const card = el('section', 'card history-chart');
  card.append(el('h2', null, measurement.label));
  if (points.length === 0) {
    card.append(el('p', 'history-empty', 'Для этого замера пока нет данных.'));
    return card;
  }

  card.append(sparkline(points));

  const versions = Array.from(new Set(points.map((point) => point.protocol_version ?? '?')));
  if (versions.length > 1) {
    const legend = el('p', 'field__hint history-legend');
    legend.textContent = `Протоколы ${versions.map((version) => `v${version}`).join(', ')} показаны отдельными линиями.`;
    card.append(legend);
  }
  if (measurement.unit === 'cm') {
    card.append(el('p', 'field__hint', 'Колебания меньше 2 см не считаются заметной динамикой.'));
  }
  return card;
}

function buildTable(measurement, rows) {
  const card = el('section', 'card history-list');
  card.append(el('h2', null, 'Замеры'));
  if (rows.length === 0) {
    card.append(el('p', 'history-empty', 'Исходных сессий с этим замером не найдено.'));
    return card;
  }

  const wrapper = el('div', 'history-table-wrap');
  const table = el('table', 'history-table');
  const head = el('thead');
  const headings = el('tr');
  for (const label of ['Дата', 'Значение', 'Повторы', 'Протокол']) {
    headings.append(el('th', null, label));
  }
  head.append(headings);

  const body = el('tbody');
  let previousProtocol = rows[0].protocol;
  for (const row of rows) {
    const tr = el('tr');
    if (row.protocol !== previousProtocol) tr.className = 'history-protocol-break';

    const when = el('td', 'history-table__when', formatDate(row.date));
    if (row.time) when.append(el('span', 'history-table__time', row.time));
    tr.append(when);
    tr.append(el('td', 'history-table__amount', formatValue(row.value, row.unit || measurement.unit)));

    const repeats = el('td', 'history-table__reps', row.raw.length > 0
      ? row.raw.map(formatNumber).join(' · ')
      : '—');
    if (row.note) repeats.append(el('span', 'history-table__note', row.note));
    tr.append(repeats);
    tr.append(el('td', 'history-table__protocol', `v${row.protocol}`));
    body.append(tr);
    previousProtocol = row.protocol;
  }

  table.append(head, body);
  wrapper.append(table);
  card.append(wrapper);
  return card;
}

function outdated(token) {
  return state === null || state.token !== token;
}

function paint(measurement, points, rows, errors) {
  if (state === null) return;
  const nodes = [buildChart(measurement, points), buildTable(measurement, rows)];
  for (const error of errors) nodes.push(notice(error.heading, errorText(error.reason)));
  state.root.replaceChildren(...nodes);
}

function paintCached(measurement, points) {
  if (state === null) return;
  state.root.replaceChildren(
    buildChart(measurement, points),
    notice('Исходные сессии', 'Загружаю таблицу и проверяю новые замеры…')
  );
}

export async function render(root, params) {
  const token = ++mountToken;
  const key = params && typeof params.key === 'string' ? params.key.trim() : '';
  state = { token, root };
  const cached = cachedIndex();
  const cachedPoints = seriesFor(cached, key);
  const knownMeasurement = getMeasurement(key);
  let cachePainted = false;
  if (cached) {
    // Каталог мог ещё не успеть загрузиться. Он уточнит подпись и единицу позже,
    // но приватный кэш истории не должен ждать ни его, ни GitHub на lie-fi.
    const previewMeasurement = knownMeasurement ?? { label: key || title, unit: '' };
    paintCached(previewMeasurement, cachedPoints);
    setHeaderStatus('Из кэша', 'stale');
    cachePainted = true;
  } else {
    root.replaceChildren(notice('Загрузка истории', 'Читаю замеры…'));
  }

  let measurement;
  try {
    await loadCatalog();
    if (outdated(token)) return;
    measurement = getMeasurement(key);
  } catch (error) {
    if (outdated(token)) return;
    root.replaceChildren(notice('История не загрузилась', errorText(error)));
    setHeaderStatus('Ошибка', 'error');
    return;
  }

  if (!measurement) {
    root.replaceChildren(notice('Замер не найден', key ? `В каталоге нет ключа «${key}».` : 'Ключ замера не задан.'));
    setHeaderStatus('Ошибка', 'error');
    return;
  }

  if (cached && !cachePainted) {
    paintCached(measurement, cachedPoints);
    setHeaderStatus('Из кэша', 'stale');
  }

  const results = await Promise.allSettled([
    readFile(INDEX_PATH).then((result) => indexData(result.content)),
    loadRows(key)
  ]);
  if (outdated(token)) return;

  const errors = [];
  let data = cached;
  let rows = [];
  if (results[0].status === 'fulfilled') {
    data = results[0].value;
    setIndexCache(data);
  } else {
    errors.push({ heading: 'Спарклайн не обновился', reason: results[0].reason });
  }
  if (results[1].status === 'fulfilled') {
    rows = results[1].value.rows;
    if (results[1].value.skipped.length > 0) {
      errors.push({
        heading: 'Часть сессий пропущена',
        reason: `Не удалось прочитать: ${results[1].value.skipped.join(', ')}.`
      });
    }
  } else {
    errors.push({ heading: 'Таблица не загрузилась', reason: results[1].reason });
  }

  const rowsUnavailable = results[1].status === 'rejected'
    || (rows.length === 0 && results[1].value.skipped.length > 0);
  const points = rowsUnavailable ? seriesFor(data, key) : pointsFromRows(rows);
  paint(measurement, points, rows, errors);
  if (errors.length === 0) setHeaderStatus('История обновлена', 'ok');
  else if (points.length > 0 || rows.length > 0) setHeaderStatus('Частичные данные', 'stale');
  else setHeaderStatus('Ошибка', 'error');
}

export function destroy() {
  mountToken += 1;
  state = null;
}
