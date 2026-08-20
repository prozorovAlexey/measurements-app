// Срезы агрегата index.json и единая семантика Δ (T11, §14 контракта).
//
// Модуль остаётся чистым: экран, очередь, DOM и сеть сюда не проникают.
// Источник истории — series; latest недостаточно для среза в прошлом.

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function epochDay(value) {
  if (typeof value !== 'string') return null;
  const match = DATE.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);

  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return null;
  }

  return Math.floor(timestamp / DAY_MS);
}

function recordMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return new Map();
  return new Map(Object.entries(value));
}

function protocolVersion(value) {
  return Number.isInteger(value) && value >= 1 ? value : null;
}

function pointValue(value) {
  if (Number.isFinite(value)) return value;
  if (value && Number.isFinite(value.value)) return value.value;
  return null;
}

// Точки из очереди (queue.pendingEntries(), T14): { '<date>': { '<key>': { value, protocol_version } } }.
// Читаются через ту же recordMap, что и index.series/latest — на оба уровня,
// потому что содержимое в конечном счёте приходит из JSON файла сессии.
function pendingPointsFor(pending, key) {
  const points = [];
  for (const [day, entries] of recordMap(pending)) {
    const item = recordMap(entries).get(key);
    if (!item || !Number.isFinite(item.value)) continue;
    points.push({ date: day, value: item.value, protocol_version: item.protocol_version });
  }
  return points;
}

function pendingKeys(pending) {
  const keys = new Set();
  for (const entries of recordMap(pending).values()) {
    for (const key of recordMap(entries).keys()) keys.add(key);
  }
  return keys;
}

// -> { <key>: { value, date, protocolVersion, ageDays, pending } | null }
// pending — queue.pendingEntries() (T14) либо null. Запись из очереди
// участвует в выборе «последнего ≤ date» наравне с index.json; при
// совпадении даты побеждает очередь — она новее по определению, поэтому
// её сравнение идёт вторым и не отбрасывает точку при равенстве дня.
export function sliceAt(index, date, pending = null) {
  const targetDay = epochDay(date);
  const series = recordMap(index?.series);
  const latest = recordMap(index?.latest);
  const keys = new Set([...series.keys(), ...latest.keys(), ...pendingKeys(pending)]);
  const result = new Map();

  for (const key of keys) {
    const points = series.get(key);
    let selected = null;
    let selectedDay = null;
    let selectedPending = false;

    if (targetDay !== null && Array.isArray(points)) {
      for (const point of points) {
        const pointDay = epochDay(point?.date);
        if (
          pointDay === null
          || pointDay > targetDay
          || !Number.isFinite(point?.value)
          || (selectedDay !== null && pointDay < selectedDay)
        ) {
          continue;
        }

        selected = point;
        selectedDay = pointDay;
        selectedPending = false;
      }
    }

    if (targetDay !== null) {
      for (const point of pendingPointsFor(pending, key)) {
        const pointDay = epochDay(point.date);
        if (
          pointDay === null
          || pointDay > targetDay
          || (selectedDay !== null && pointDay < selectedDay)
        ) {
          continue;
        }

        selected = point;
        selectedDay = pointDay;
        selectedPending = true;
      }
    }

    result.set(key, selected ? Object.freeze({
      value: selected.value,
      date: selected.date,
      protocolVersion: protocolVersion(selected.protocol_version),
      ageDays: targetDay - selectedDay,
      pending: selectedPending
    }) : null);
  }

  // Object.fromEntries создаёт собственное поле даже для ключа "__proto__",
  // не превращая пришедший JSON в прототип результата.
  return Object.fromEntries(result);
}

// -> ['YYYY-MM-DD', …] по возрастанию, без дублей.
// Даты из очереди (T14) входят в список: чип сегодняшнего числа обязан
// появиться от первой же сохранённой записи, до пересборки index.json
// и в офлайне (§7.5 спеки).
export function sliceDates(index, pending = null) {
  const dates = new Set();

  for (const points of recordMap(index?.series).values()) {
    if (!Array.isArray(points)) continue;
    for (const point of points) {
      if (epochDay(point?.date) !== null && Number.isFinite(point?.value)) {
        dates.add(point.date);
      }
    }
  }

  for (const [day, entries] of recordMap(pending)) {
    if (epochDay(day) === null) continue;
    const hasValue = Array.from(recordMap(entries).values())
      .some((item) => item && Number.isFinite(item.value));
    if (hasValue) dates.add(day);
  }

  return Array.from(dates).sort();
}

// tone описывает направление качества: up — желаемая динамика,
// down — нежелаемая, flat — нейтральная. Только этот результат выбирает
// цвет Δ на экранах этапа 2.
export function delta(prev, cur, entry) {
  const previous = pointValue(prev);
  const current = pointValue(cur);

  if (previous === null || current === null) {
    return { value: null, significant: false, tone: 'flat' };
  }

  const raw = current - previous;
  const value = Object.is(raw, -0) ? 0 : raw;
  const threshold = entry?.unit === 'kg' ? 0.5 : entry?.unit === 'cm' ? 2 : Infinity;
  const significant = Math.abs(value) >= threshold && value !== 0;
  const direction = entry?.direction;

  if (!significant || (direction !== 'up' && direction !== 'down')) {
    return { value, significant, tone: 'flat' };
  }

  const desiredSign = direction === 'up' ? 1 : -1;
  return {
    value,
    significant,
    tone: Math.sign(value) === desiredSign ? 'up' : 'down'
  };
}
