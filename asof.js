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

// -> { <key>: { value, date, protocolVersion, ageDays, pending } | null }
export function sliceAt(index, date) {
  const targetDay = epochDay(date);
  const series = recordMap(index?.series);
  const latest = recordMap(index?.latest);
  const keys = new Set([...series.keys(), ...latest.keys()]);
  const result = new Map();

  for (const key of keys) {
    const points = series.get(key);
    let selected = null;
    let selectedDay = null;

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
      }
    }

    result.set(key, selected ? Object.freeze({
      value: selected.value,
      date: selected.date,
      protocolVersion: protocolVersion(selected.protocol_version),
      ageDays: targetDay - selectedDay,
      pending: false
    }) : null);
  }

  // Object.fromEntries создаёт собственное поле даже для ключа "__proto__",
  // не превращая пришедший JSON в прототип результата.
  return Object.fromEntries(result);
}

// -> ['YYYY-MM-DD', …] по возрастанию, без дублей.
export function sliceDates(index) {
  const dates = new Set();

  for (const points of recordMap(index?.series).values()) {
    if (!Array.isArray(points)) continue;
    for (const point of points) {
      if (epochDay(point?.date) !== null && Number.isFinite(point?.value)) {
        dates.add(point.date);
      }
    }
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
