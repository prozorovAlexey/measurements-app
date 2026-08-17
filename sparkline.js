// Компактный SVG-график истории (T8, §7.3 спеки).
// Модуль не знает ни про сеть, ни про экран: получает готовые точки и
// возвращает один SVGElement. Смена protocol_version всегда разрывает линию.

const SVG_NS = 'http://www.w3.org/2000/svg';
const DEFAULT_WIDTH = 280;
const DEFAULT_HEIGHT = 48;
const PADDING = 3;

function dimension(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function dateStamp(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const stamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const date = new Date(stamp);
  if (
    date.getUTCFullYear() !== Number(match[1])
    || date.getUTCMonth() !== Number(match[2]) - 1
    || date.getUTCDate() !== Number(match[3])
  ) return null;
  return stamp;
}

function protocolVersion(value) {
  return Number.isInteger(value) && value >= 1 ? value : '?';
}

function normalize(points) {
  if (!Array.isArray(points)) return [];
  const result = [];
  for (let order = 0; order < points.length; order += 1) {
    const point = points[order];
    const stamp = dateStamp(point?.date);
    if (stamp === null || !Number.isFinite(point?.value)) continue;
    result.push({
      date: point.date,
      stamp,
      value: point.value,
      protocol: protocolVersion(point.protocol_version),
      order
    });
  }
  result.sort((left, right) => left.stamp - right.stamp || left.order - right.order);
  return result;
}

function segments(points) {
  const result = [];
  for (const point of points) {
    const current = result[result.length - 1];
    if (!current || current.protocol !== point.protocol) {
      result.push({ protocol: point.protocol, points: [point] });
    } else {
      current.points.push(point);
    }
  }
  return result;
}

function coordinate(value, min, max, start, length, invert = false) {
  if (min === max) return start + length / 2;
  // Масштабируем до вычитания: max-min переполняется для [-1e308, 1e308].
  const scale = Math.max(Math.abs(min), Math.abs(max), 1);
  const scaledMin = min / scale;
  const span = max / scale - scaledMin;
  const rawRatio = span === 0 ? 0.5 : (value / scale - scaledMin) / span;
  const ratio = Number.isFinite(rawRatio) ? Math.min(1, Math.max(0, rawRatio)) : 0.5;
  return start + (invert ? 1 - ratio : ratio) * length;
}

function number(value) {
  const rounded = Math.round(value * 100) / 100;
  return String(Number.isFinite(rounded) ? rounded : value);
}

export function sparkline(points, { width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT } = {}) {
  const svgWidth = dimension(width, DEFAULT_WIDTH);
  const svgHeight = dimension(height, DEFAULT_HEIGHT);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'sparkline');
  svg.setAttribute('viewBox', `0 0 ${number(svgWidth)} ${number(svgHeight)}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Динамика замера по датам');
  svg.setAttribute('preserveAspectRatio', 'none');

  const prepared = normalize(points);
  if (prepared.length === 0) {
    svg.classList.add('sparkline--empty');
    return svg;
  }

  const stamps = prepared.map((point) => point.stamp);
  const values = prepared.map((point) => point.value);
  const minStamp = Math.min(...stamps);
  const maxStamp = Math.max(...stamps);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const xPadding = Math.min(PADDING, svgWidth / 2);
  const yPadding = Math.min(PADDING, svgHeight / 2);
  const plotWidth = Math.max(0, svgWidth - xPadding * 2);
  const plotHeight = Math.max(0, svgHeight - yPadding * 2);
  const latestProtocol = prepared[prepared.length - 1].protocol;

  const position = (point) => ({
    x: coordinate(point.stamp, minStamp, maxStamp, xPadding, plotWidth),
    y: coordinate(point.value, minValue, maxValue, yPadding, plotHeight, true)
  });

  for (const segment of segments(prepared)) {
    const path = document.createElementNS(SVG_NS, 'path');
    const coordinates = segment.points.map(position);
    let d = coordinates.map((point, index) => `${index === 0 ? 'M' : 'L'} ${number(point.x)} ${number(point.y)}`).join(' ');
    // Одинокая точка остаётся отдельным <path>; round linecap рисует её точкой.
    if (coordinates.length === 1) d += ` L ${number(coordinates[0].x)} ${number(coordinates[0].y)}`;
    path.setAttribute('d', d);
    path.setAttribute('data-protocol-version', String(segment.protocol));
    path.setAttribute('class', segment.protocol === latestProtocol
      ? 'sparkline__line sparkline__line--current'
      : 'sparkline__line sparkline__line--previous');
    svg.append(path);
  }

  return svg;
}
