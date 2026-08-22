// Геометрия силуэта (T10, §14 архитектурного контракта).
// Модуль получает только готовые значения замеров и возвращает числа и SVG-path.

const CENTER_X = 180;
const BODY_TOP = 28;
const BODY_HEIGHT = 488;
const TAU = 6.2832;

const DEFAULTS = Object.freeze({
  height: 175,
  neck: 38,
  chest: 100,
  waist_who: 80,
  pelvis: 98,
  hip: 98,
  thigh: 55,
  calf: 37,
  biceps_relaxed: 32,
  forearm: 27,
  wrist: 17,
  shoulder_width: 46,
  foot_length: 26.5
});

function clamp(value, min, max) {
  return value < min ? min : (value > max ? max : value);
}

function smoothMaximum(left, right, softness) {
  return 0.5 * (
    left
    + right
    + Math.sqrt((left - right) * (left - right) + softness)
  );
}

function sample(keyframes, fraction) {
  const count = keyframes.length;
  if (fraction <= keyframes[0][0]) return keyframes[0][1];
  if (fraction >= keyframes[count - 1][0]) return keyframes[count - 1][1];

  const slopes = [];
  for (let index = 0; index < count - 1; index += 1) {
    slopes.push(
      (keyframes[index + 1][1] - keyframes[index][1])
      / (keyframes[index + 1][0] - keyframes[index][0])
    );
  }

  const tangents = new Array(count);
  tangents[0] = slopes[0];
  tangents[count - 1] = slopes[count - 2];
  for (let index = 1; index < count - 1; index += 1) {
    if (slopes[index - 1] * slopes[index] <= 0) {
      tangents[index] = 0;
    } else {
      tangents[index] = (slopes[index - 1] + slopes[index]) / 2;
      const limit = 3 * Math.min(Math.abs(slopes[index - 1]), Math.abs(slopes[index]));
      tangents[index] = Math.sign(tangents[index]) * Math.min(
        Math.abs(tangents[index]),
        limit
      );
    }
  }

  let interval = 0;
  while (interval < count - 2 && fraction > keyframes[interval + 1][0]) {
    interval += 1;
  }
  const start = keyframes[interval];
  const end = keyframes[interval + 1];
  const span = end[0] - start[0];
  const ratio = (fraction - start[0]) / span;
  const ratio2 = ratio * ratio;
  const ratio3 = ratio2 * ratio;
  return (2 * ratio3 - 3 * ratio2 + 1) * start[1]
    + (ratio3 - 2 * ratio2 + ratio) * span * tangents[interval]
    + (-2 * ratio3 + 3 * ratio2) * end[1]
    + (ratio3 - ratio2) * span * tangents[interval + 1];
}

function coordinate(value) {
  return String(Math.round(value * 100) / 100);
}

// Замкнутый centripetal Catmull–Rom по контрольным точкам { x, y, t }.
// Поле t уменьшает касательную у углов, не меняя фиксированную топологию.
function outline(points) {
  const count = points.length;
  const at = (index) => points[(index % count + count) % count];
  const pair = (x, y) => `${coordinate(x)} ${coordinate(y)}`;
  const knot = (left, right) => Math.max(
    1e-3,
    Math.sqrt(Math.hypot(right.x - left.x, right.y - left.y))
  );
  const control = (a0, a1, a2, leftKnot, rightKnot) => (
    leftKnot * leftKnot * a2
    - rightKnot * rightKnot * a0
    + (2 * leftKnot * leftKnot + 3 * leftKnot * rightKnot + rightKnot * rightKnot) * a1
  ) / (3 * leftKnot * (leftKnot + rightKnot));

  let path = `M ${pair(points[0].x, points[0].y)}`;
  for (let index = 0; index < count; index += 1) {
    const previous = at(index - 1);
    const current = at(index);
    const next = at(index + 1);
    const afterNext = at(index + 2);
    const firstKnot = knot(previous, current);
    const secondKnot = knot(current, next);
    const thirdKnot = knot(next, afterNext);
    const currentTension = current.t == null ? 1 : current.t;
    const nextTension = next.t == null ? 1 : next.t;
    const firstControlX = current.x + (
      control(previous.x, current.x, next.x, firstKnot, secondKnot) - current.x
    ) * currentTension;
    const firstControlY = current.y + (
      control(previous.y, current.y, next.y, firstKnot, secondKnot) - current.y
    ) * currentTension;
    const secondControlX = next.x + (
      control(afterNext.x, next.x, current.x, thirdKnot, secondKnot) - next.x
    ) * nextTension;
    const secondControlY = next.y + (
      control(afterNext.y, next.y, current.y, thirdKnot, secondKnot) - next.y
    ) * nextTension;
    path += ` C ${pair(firstControlX, firstControlY)}, ${pair(secondControlX, secondControlY)}, ${pair(next.x, next.y)}`;
  }
  return `${path} Z`;
}

function prepareValues(values) {
  const source = values && typeof values === 'object' ? values : {};
  const resolved = {};
  const measured = {};
  const defaults = [];

  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const value = source[key];
    const present = Number.isFinite(value) && value > 0;
    resolved[key] = present ? value : fallback;
    measured[key] = present;
    if (!present) defaults.push(key);
  }

  return { resolved, measured, defaults };
}

function geometry(values, measured, figure) {
  const height = values.height;
  const pixelsPerCentimeter = BODY_HEIGHT / height;
  const female = figure === 'female';
  const y = (fraction) => BODY_TOP + BODY_HEIGHT * fraction;
  // Обхват (см) -> полуширина спереди (px) с анатомическим клампом.
  const halfWidth = (key, coefficient, min, max) => clamp(
    values[key] / TAU * coefficient * pixelsPerCentimeter,
    min * BODY_HEIGHT,
    max * BODY_HEIGHT
  );

  const neck = halfWidth('neck', 0.86, 0.019, 0.038);
  const chest = halfWidth('chest', female ? 1 : 1.037, 0.062, 0.112);
  const waist = halfWidth('waist_who', female ? 1.02 : 1.053, 0.044, 0.106);
  const pelvis = halfWidth('pelvis', female ? 1.14 : 1.073, 0.055, 0.108);
  const glutes = halfWidth('hip', female ? 1.16 : 1.095, 0.056, 0.112);
  const thigh = halfWidth('thigh', 1.03, 0.032, 0.064);
  const calf = halfWidth('calf', 1, 0.022, 0.043);
  const biceps = halfWidth('biceps_relaxed', 1, 0.019, 0.042);
  const forearm = halfWidth('forearm', 1, 0.016, 0.034);
  const wrist = halfWidth('wrist', 1, 0.011, 0.022);
  const shoulder = Math.max(
    chest * 1.10,
    clamp(
      values.shoulder_width / 2 * pixelsPerCentimeter * (female ? 0.95 : 1),
      0.095 * BODY_HEIGHT,
      0.16 * BODY_HEIGHT
    )
  );
  const footWidth = clamp(
    values.foot_length * pixelsPerCentimeter * 0.20,
    0.021 * BODY_HEIGHT,
    0.036 * BODY_HEIGHT
  );
  const headHeight = BODY_HEIGHT * 0.130;
  const headWidth = Math.max(headHeight * 0.365, neck * 1.05);

  // Оси ног сходятся книзу; ширины задаются бедром и икрой.
  const thighWidth = thigh * 1.06;
  const thighAxis = Math.max(glutes * 0.985 - thighWidth, thigh * 0.5);
  const kneeAxis = Math.max(thighAxis * 1.04, calf * 1.05 + BODY_HEIGHT * 0.008);
  const ankleAxis = kneeAxis * 0.94;
  const legAxes = [
    [0.508, thighAxis], [0.545, thighAxis], [0.715, kneeAxis], [0.942, ankleAxis]
  ];
  const legAxis = (fraction) => sample(legAxes, fraction);
  const hipJoin = Math.max(thighWidth, glutes * 0.985 - thighAxis);
  const legWidths = [
    [0.508, hipJoin], [0.56, thighWidth], [0.655, thigh * 0.85],
    [0.715, calf * 0.93], [0.775, calf * 1.02], [0.84, calf * 0.83],
    [0.90, calf * 0.58],
    [0.942, calf * 0.45]
  ];
  const legGaps = [
    [0.512, 1], [0.60, 7], [0.715, 10], [0.79, 10.5],
    [0.87, 11], [0.942, 12]
  ];
  const legOuter = (fraction) => legAxis(fraction) + sample(legWidths, fraction);
  const legInner = (fraction) => smoothMaximum(
    legAxis(fraction) - sample(legWidths, fraction),
    sample(legGaps, fraction),
    18
  );

  const torsoSides = [
    [0.219, chest * 0.895], [0.278, chest], [0.392, waist],
    [0.448, pelvis], [0.478, glutes],
    [0.508, glutes * 0.985]
  ];
  const sideAt = (fraction) => (
    fraction >= 0.508 ? legOuter(fraction) : sample(torsoSides, fraction)
  );

  // Внешний контур руки несёт замер, внутренний держит зазор от корпуса.
  const palm = wrist * 1.28;
  const elbow = (biceps + forearm) / 2 * 0.86;
  const shoulderAxis = shoulder - biceps * 1.06;
  const handAxis = Math.max(
    shoulderAxis + biceps * 0.55,
    sideAt(0.53) + Math.max(4, BODY_HEIGHT * 0.0095) + palm
  );
  // Показатель степени < 1: ось руки уходит от корпуса быстро сразу после
  // плеча, а не только у кисти — иначе бицепс упирается в зазор до корпуса
  // и рендерится куда тоньше своего обхвата (жалоба "рука как соломинка").
  const armAxis = (fraction) => (
    shoulderAxis
    + (handAxis - shoulderAxis)
      * Math.pow(clamp((fraction - 0.214) / 0.316, 0, 1), 0.6)
  );
  // Предплечье сужается к запястью монотонно: если измеренное запястье
  // толще дефолтного предплечья, оно не должно раздувать кисть после сужения.
  const forearmUpper = Math.min(elbow, forearm * 1.02);
  const forearmLower = Math.min(forearmUpper, forearm * 0.80);
  const wristWidth = Math.min(forearmLower, wrist);
  const armWidths = [
    [0.214, biceps * 1.06], [0.262, biceps * 1.05], [0.30, biceps],
    [0.345, biceps * 0.92], [0.383, elbow], [0.43, forearmUpper],
    [0.465, forearmLower], [0.492, wristWidth]
  ];
  // Возвращено к исходным значениям: раздувание зазора не убирало залом
  // (тот был из-за немонотонного torsoSides/armWidths, уже поправлено выше),
  // а только зря утоньшало руку.
  const armGaps = [
    [0.252, 1.8], [0.29, 3.4], [0.345, 5.2], [0.392, 6.0],
    [0.45, 4.5], [0.492, 3.6]
  ];
  const armOuter = (fraction) => Math.min(
    armAxis(fraction) + sample(armWidths, fraction),
    shoulder * 1.14
  );
  const armInner = (fraction) => {
    const width = sample(armWidths, fraction);
    return Math.min(
      armOuter(fraction) - Math.max(4, width * 1.05),
      smoothMaximum(
        armAxis(fraction) - width,
        sideAt(fraction) + sample(armGaps, fraction),
        8
      )
    );
  };

  // Правая половина: макушка -> промежность. Затем зеркалирование относительно CENTER_X.
  const right = [];
  const add = (offsetX, fraction, tension) => {
    right.push({ x: CENTER_X + offsetX, y: y(fraction), t: tension });
  };
  add(0, 0);
  add(headWidth * 0.60, 0.009);
  add(headWidth * 0.98, 0.036);
  add(headWidth, 0.066);
  add(headWidth * 0.88, 0.096);
  add(headWidth * 0.68, 0.117);
  add(Math.max(headWidth * 0.42, neck * 0.88), 0.132);
  add(neck, 0.148);
  for (let index = 1; index <= 6; index += 1) {
    const ratio = index / 6;
    const eased = ratio * ratio * (3 - 2 * ratio);
    add(
      neck + (shoulder - neck) * Math.pow(eased, 0.85),
      0.148 + 0.065 * ratio
    );
  }
  add(armOuter(0.262), 0.262);
  add(armOuter(0.31), 0.31);
  add(armOuter(0.383), 0.383);
  add(armOuter(0.43), 0.43);
  add(armOuter(0.472), 0.472);
  add(armOuter(0.492), 0.492);
  add(handAxis + palm * 0.82, 0.512, 0.85);
  add(handAxis + palm, 0.548);
  add(handAxis + palm * 0.90, 0.572, 0.8);
  add(handAxis + palm * 0.54, 0.5885, 0.6);
  add(handAxis - palm * 0.34, 0.592, 0.6);
  add(handAxis - palm * 0.88, 0.566);
  add(handAxis - palm * 1.02, 0.530, 0.85);
  add(handAxis - palm * 0.72, 0.502, 0.9);
  add(armInner(0.492), 0.489);
  add(armInner(0.455), 0.455);
  add(armInner(0.41), 0.41);
  add(armInner(0.383), 0.383);
  add(armInner(0.33), 0.33);
  add(armInner(0.29), 0.29);
  add(armInner(0.262), 0.262, 0.6);
  add(sideAt(0.256) + 1.2, 0.252, 0.5);
  add(sideAt(0.288), 0.288);
  add(sideAt(0.34), 0.34);
  add(sideAt(0.392), 0.392);
  add(sideAt(0.448), 0.448);
  add(sideAt(0.478), 0.478);
  add(legOuter(0.508), 0.508);
  add(legOuter(0.545), 0.545);
  add(legOuter(0.655), 0.655);
  add(legOuter(0.715), 0.715);
  add(legOuter(0.775), 0.775);
  add(legOuter(0.84), 0.84);
  add(legOuter(0.90), 0.90);
  add(legOuter(0.925), 0.925);
  add(ankleAxis + calf * 0.42, 0.950);
  add(ankleAxis + footWidth * 0.72, 0.978);
  add(ankleAxis + footWidth, 0.9975, 0.65);
  add(ankleAxis + footWidth * 0.72, 1, 0.5);
  add(ankleAxis - footWidth * 0.54, 1, 0.5);
  add(ankleAxis - footWidth * 0.66, 0.9895, 0.6);
  add(ankleAxis - footWidth * 0.40, 0.972, 0.85);
  add(ankleAxis - calf * 0.36, 0.950);
  add(legInner(0.925), 0.928);
  add(legInner(0.90), 0.90);
  add(legInner(0.84), 0.84);
  add(legInner(0.775), 0.775);
  add(legInner(0.715), 0.715);
  add(legInner(0.63), 0.63);
  add(legInner(0.545), 0.545);
  add(legInner(0.525), 0.525, 0.9);
  add(0, 0.512);

  const full = right.slice();
  for (let index = right.length - 2; index > 0; index -= 1) {
    const point = right[index];
    full.push({ x: 2 * CENTER_X - point.x, y: point.y, t: point.t });
  }

  const torsoNode = (key, fraction, extent) => ({
    y: y(fraction),
    x1: CENTER_X - extent,
    x2: CENTER_X + extent,
    measured: measured[key]
  });
  const rightLimbNode = (key, fraction, inner, outer) => ({
    y: y(fraction),
    x1: CENTER_X + Math.min(inner, outer),
    x2: CENTER_X + Math.max(inner, outer),
    measured: measured[key]
  });
  const leftLimbNode = (key, fraction, inner, outer) => ({
    y: y(fraction),
    x1: CENTER_X - Math.max(inner, outer),
    x2: CENTER_X - Math.min(inner, outer),
    measured: measured[key]
  });

  return {
    path: outline(full),
    nodes: {
      shoulder: torsoNode('shoulder_width', 0.214, shoulder),
      chest: torsoNode('chest', 0.278, chest),
      waist: torsoNode('waist_who', 0.392, waist),
      pelvis: torsoNode('pelvis', 0.448, pelvis),
      glutes: torsoNode('hip', 0.478, glutes),
      biceps: rightLimbNode('biceps_relaxed', 0.345, armInner(0.345), armOuter(0.345)),
      thigh: leftLimbNode('thigh', 0.575, legInner(0.575), legOuter(0.575)),
      calf: rightLimbNode('calf', 0.79, legInner(0.79), legOuter(0.79)),
      foot: leftLimbNode(
        'foot_length',
        0.988,
        ankleAxis - footWidth * 0.70,
        ankleAxis + footWidth
      ),
      neck: torsoNode('neck', 0.148, neck),
      forearm: rightLimbNode('forearm', 0.43, armInner(0.43), armOuter(0.43)),
      wrist: rightLimbNode('wrist', 0.492, armInner(0.492), armOuter(0.492))
    },
    ground: {
      y: y(1) + 6,
      r: Math.max(glutes * 1.7, shoulder + 20)
    }
  };
}

export function silhouette(values, { figure = 'male' } = {}) {
  const { resolved, measured, defaults } = prepareValues(values);
  const result = geometry(resolved, measured, figure === 'female' ? 'female' : 'male');
  return {
    paths: [{ d: result.path }],
    nodes: result.nodes,
    ground: result.ground,
    defaults
  };
}
