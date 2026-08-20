// Пересчёт замеров в размеры одежды/обуви/колец (T15, §5.4 спеки, §14 контракта).
//
// Чистая функция: ни каталога, ни DOM, ни сети, ни localStorage. В отличие
// от figure.js дефолтов здесь нет ни одного — контуру нужна хоть какая-то
// ширина, а размеру без замера дефолт дал бы цифру, по которой купят не тот
// размер. Нет замера — ключ уходит в missing, карточка называет его вслух.

const INCH_CM = 2.54;

function num(value) {
  return Number.isFinite(value) ? value : null;
}

// Ближайшее чётное: одежда UA/EU идёт шагом 2 (48, 50, 52…).
function roundEven(value) {
  const rounded = Math.round(value);
  if (rounded % 2 === 0) return rounded;
  const down = rounded - 1;
  const up = rounded + 1;
  return Math.abs(value - down) <= Math.abs(value - up) ? down : up;
}

function roundStep(value, step) {
  return Math.round(value / step) * step;
}

// Число без toLocaleString — тот же приём, что и в screens/*.js (§13
// контракта, T5): результат обязан совпадать в браузере и в node с урезанным
// ICU. Хвостовых нулей не бывает.
function formatNumber(value) {
  const rounded = Math.round(value * 10) / 10;
  return String(rounded).replace('.', ',');
}

// Пороги буквенной шкалы спекой численно не заданы (§5.4 говорит только,
// что она «применима для одежды и рубашки, от обхвата груди и шеи»)
// — это наше решение, типовые международные грудные и воротниковые сетки.
// Мужская и женская отличаются на 6-8 см на каждый шаг: спека упоминает,
// что сетки различаются по полу, но числами их не задаёт.
const CHEST_LETTER = Object.freeze({
  male: Object.freeze([[0, 'XS'], [88, 'S'], [96, 'M'], [104, 'L'], [112, 'XL'], [120, 'XXL']]),
  female: Object.freeze([[0, 'XS'], [80, 'S'], [86, 'M'], [92, 'L'], [98, 'XL'], [104, 'XXL']])
});
const NECK_LETTER = Object.freeze({
  male: Object.freeze([[0, 'S'], [38, 'M'], [41, 'L'], [44, 'XL']]),
  female: Object.freeze([[0, 'S'], [34, 'M'], [37, 'L'], [40, 'XL']])
});

function letterFrom(table, value, sex) {
  const rows = table[sex === 'female' ? 'female' : 'male'];
  let letter = rows[0][1];
  for (const [min, label] of rows) {
    if (value >= min) letter = label;
  }
  return letter;
}

function empty(missing) {
  return { primary: null, secondary: null, letter: null, missing };
}

function clothing(values, sex) {
  const chest = num(values.chest);
  if (chest === null) return empty(['chest']);
  return {
    primary: `UA/EU ${roundEven(chest / 2)}`,
    secondary: null,
    letter: letterFrom(CHEST_LETTER, chest, sex),
    missing: []
  };
}

function shirt(values, sex) {
  const neck = num(values.neck);
  const sleeve = num(values.sleeve);
  const missing = [];
  if (neck === null) missing.push('neck');
  if (sleeve === null) missing.push('sleeve');
  return {
    primary: neck === null ? null : `Воротник ${Math.round(neck)} см`,
    secondary: sleeve === null ? null : `Рукав ${formatNumber(sleeve)} см`,
    letter: neck === null ? null : letterFrom(NECK_LETTER, neck, sex),
    missing
  };
}

function jeans(values) {
  const waist = num(values.waist_natural);
  const inseam = num(values.inseam);
  const missing = [];
  if (waist === null) missing.push('waist_natural');
  if (inseam === null) missing.push('inseam');
  return {
    primary: waist === null ? null : `W${Math.round(waist / INCH_CM)}`,
    secondary: inseam === null ? null : `L${Math.round(inseam / INCH_CM)}`,
    letter: null,
    missing
  };
}

function shoe(values) {
  const foot = num(values.foot_length);
  if (foot === null) return empty(['foot_length']);
  const size = roundStep((foot + 1.0) * 1.5, 0.5);
  return { primary: `EU ${formatNumber(size)}`, secondary: null, letter: null, missing: [] };
}

function ring(values) {
  const finger = num(values.finger_index);
  if (finger === null) return empty(['finger_index']);
  const diameter = roundStep((finger * 10) / Math.PI, 0.5);
  return { primary: `UA/EU ${formatNumber(diameter)}`, secondary: null, letter: null, missing: [] };
}

const SCALES = Object.freeze({ clothing, shirt, jeans, shoe, ring });

// scale: 'clothing' | 'shirt' | 'jeans' | 'shoe' | 'ring'
// values: { <key>: number | null } — только замеры этой карточки
// -> { primary, secondary, letter, missing }
export function sizeFor(scale, values, { sex = 'male' } = {}) {
  const fn = SCALES[scale];
  if (!fn) return empty([]);
  const source = values && typeof values === 'object' ? values : {};
  return fn(source, sex);
}
