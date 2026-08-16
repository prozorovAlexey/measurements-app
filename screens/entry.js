// Экран ввода сессии (§7.2 спеки, T5, контракт §2).
//
// Главная ценность экрана — не поля, а текст протокола над ними: проект
// заведён из-за того, что запись «талия 87» не говорит, где именно мерили
// (§1 спеки). Поэтому landmark и posture печатаются в каждом блоке замера
// и не прячутся ни под «подробности», ни под всплывающую подсказку.
//
// Файл сессии иммутабелен (§6.1, чек-лист §10). В этом файле нет ни чтения
// существующей сессии, ни sha: writeFile зовётся только без него, то есть
// физически способен лишь создать новый файл. Появится sha — появится
// и путь к правке истории, поэтому его здесь быть не должно.
//
// Форма переживает провал записи: пятнадцать минут возни с сантиметровой
// лентой нельзя терять из-за пропавшей сети. Ошибка показывается текстом
// рядом с кнопкой, значения остаются в полях, повторное нажатие «Сохранить»
// шлёт ту же сессию заново.
//
// Перерисовка точечная, а не replaceChildren на весь экран, как в шпаргалке:
// полный перерендер на каждое нажатие клавиши уносил бы фокус и каретку
// из поля, в которое печатают. Пересоздаются только производные узлы —
// медиана, предупреждения и сообщения под кнопкой; в них нет ничего,
// что можно держать в фокусе во время ввода.
//
// previousValue для проверки отклонения берётся из кэша index.json сразу
// (приём T4), обновление уходит в фон и пересчитывает предупреждения.
// Нет ни сети, ни кэша — сравнивать не с чем, и проверка отклонения молчит:
// это осознанное поведение, а не пропущенная ошибка.

import { navigate, toast } from '../app.js';
import { GitHubError, listFiles, readFile, writeFile } from '../github.js';
import { getIndexCache, setIndexCache } from '../store.js';
import { getMeasurement, loadCatalog, protocolVersion } from '../catalog.js';
import { buildSession, median, sessionFileName, validateReps } from '../session.js';

export const title = 'Ввод сессии';

const INDEX_PATH = 'index.json';
const DATA_DIR = 'data';

const UNITS = new Map([['cm', 'см'], ['kg', 'кг']]);

// §5.3 спеки: общие правила измерения показываются именно на экране ввода.
const RULES = Object.freeze([
  'Утро: после туалета, до еды, до тренировки.',
  'Лента прилегает плотно, но не вдавливается в кожу.',
  'Каждый обхват — три повтора, в значение идёт медиана.',
  'Разброс между повторами больше 1 см — перемерить.',
  'Изменение меньше ~2 см на обхватах — это ошибка измерения, а не динамика.'
]);

// Про задержку сказано прямо: index.json собирает GitHub Action, и без этой
// строчки исчезнувшее из шпаргалки значение выглядит как потерянная запись.
const SAVED_TEXT = 'Сессия сохранена. В шпаргалке значение появится после сборки index.json — обычно это десятки секунд.';

const SAVE_TEXT = 'Сохранить сессию';
const SAVING_TEXT = 'Сохраняю…';

let mountToken = 0;
let state = null;

// ===== Чистые функции =====================================================
// Экспортируются ради entry.selftest.mjs — прецедент utf8ToBase64 в github.js
// и formatValue в шпаргалке (§13 контракта). Приложение зовёт их отсюда же.

function pad2(number) {
  return String(number).padStart(2, '0');
}

// Сегодняшний день по календарю пользователя, а не по UTC: замер, сделанный
// утром в Москве, не должен уехать во вчера.
export function todayISO(now = new Date()) {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

// 'ЧЧ:ММ' — формат поля time и схемы §6.1.
export function currentTime(now = new Date()) {
  return `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
}

// Число вручную, без toLocaleString: результат обязан совпадать в браузере
// и в node с урезанным ICU (решение T4, §13 контракта).
function formatNumber(value) {
  const rounded = Math.round(value * 100) / 100;
  return String(rounded).replace('.', ',');
}

function unitLabel(unit) {
  const code = typeof unit === 'string' ? unit.trim() : '';
  if (code === '') return '';
  // Незнакомая единица показывается как есть — врать про неё нечего.
  return UNITS.get(code) ?? code;
}

// 86.8, 'cm' -> '86,8 см'.
export function formatMeasure(value, unit) {
  const suffix = unitLabel(unit);
  const text = formatNumber(value);
  return suffix === '' ? text : `${text} ${suffix}`;
}

// 'Ориентир: … / Поза: …' — обе строки каталога, пустые пропускаются.
export function protocolLines(measurement) {
  const lines = [];
  const landmark = typeof measurement.landmark === 'string' ? measurement.landmark.trim() : '';
  const posture = typeof measurement.posture === 'string' ? measurement.posture.trim() : '';
  if (landmark !== '') lines.push(`Ориентир: ${landmark}`);
  if (posture !== '') lines.push(`Поза: ${posture}`);
  return lines;
}

// ===== Разбор данных ======================================================

function errorText(error) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim() !== '') return error.trim();
  return 'Не удалось сохранить сессию.';
}

// latest из §6.2 -> Map. Через Map, а не по ключам объекта: в JSON может
// прилететь ключ вроде '__proto__' (решение T4).
function latestMap(data) {
  const map = new Map();
  const latest = data && typeof data === 'object' ? data.latest : null;
  if (!latest || typeof latest !== 'object') return map;
  for (const [key, entry] of Object.entries(latest)) {
    if (entry && typeof entry === 'object') map.set(key, entry);
  }
  return map;
}

// Предыдущее значение для validateReps. Нет данных — null, и проверка
// отклонения молчит: подтверждать нечего.
function previousValue(key) {
  if (state === null) return null;
  const entry = state.latest.get(key);
  if (!entry) return null;
  const number = Number(entry.value);
  return Number.isFinite(number) ? number : null;
}

function measurementsFor(mode) {
  if (state === null) return [];
  if (mode === 'full') return state.all.filter((item) => item.class === 'dynamic');
  // Отдельные замеры — по всему каталогу: рост и длину стопы тоже когда-то
  // надо измерить, и другого экрана для них нет.
  return state.all.filter((item) => state.selected.has(item.key));
}

function blankValue(measurement) {
  return { reps: new Array(measurement.reps).fill(''), note: '', confirmed: false };
}

// ===== Узлы ===============================================================

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

// input внутри label: не нужны id с for, и подпись целиком становится
// тач-целью (§0: тач-цели не меньше --tap).
function makeField(labelText, input, className) {
  const field = el('label', className ? `field ${className}` : 'field');
  field.append(el('span', 'label', labelText), input);
  return field;
}

function makeInput(type, value, onInput) {
  const input = document.createElement('input');
  input.type = type;
  input.value = value ?? '';
  const handler = () => onInput(input.value);
  input.addEventListener('input', handler);
  // change — это потеря фокуса и выбор в нативном пикере даты; пересчёт
  // обязан случиться и там (§7.2: пересчёт на ввод и на потерю фокуса).
  input.addEventListener('change', handler);
  return input;
}

// type="text" + inputmode, а не type="number": телефонная клавиатура даёт
// запятую, для type="number" такое значение невалидно, и .value приходит
// пустым — введённый замер молча пропал бы. Запятую разбирает session.js.
function makeNumericInput(value, onInput, mode = 'decimal') {
  const input = makeInput('text', value, onInput);
  input.setAttribute('inputmode', mode);
  input.autocomplete = 'off';
  return input;
}

function makeCheckbox(text, checked, onChange, className) {
  const label = el('label', className ?? 'entry-choice');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = Boolean(checked);
  input.addEventListener('change', () => onChange(input.checked));
  label.append(input, el('span', null, text));
  return { label, input };
}

function makeRadio(text, checked, onChange) {
  const label = el('label', 'entry-choice');
  const input = document.createElement('input');
  input.type = 'radio';
  input.name = 'entry-mode';
  input.checked = Boolean(checked);
  input.addEventListener('change', () => {
    if (input.checked) onChange();
  });
  label.append(input, el('span', null, text));
  return { label, input };
}

function makeButton(text, className, onClick) {
  const button = el('button', className, text);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

function buildNotice(heading, error) {
  const card = el('section', 'card');
  card.append(el('h2', null, heading));
  card.append(el('p', 'warn', errorText(error)));
  return card;
}

// ===== Блок замера ========================================================

function buildBlock(measurement) {
  const key = measurement.key;
  const item = state.values.get(key);

  const card = el('section', 'card entry-block');
  card.dataset.key = key;

  const head = el('h2', null, measurement.label);
  const unit = unitLabel(measurement.unit);
  if (unit !== '') head.append(el('span', 'entry-block__unit', unit));
  card.append(head);

  // Протокол — прямо над полями, до единого поля ввода (§7.2 спеки).
  for (const line of protocolLines(measurement)) card.append(el('p', 'entry-protocol', line));

  // Полей ровно reps из каталога: три у обхватов, одно у веса и статики.
  const reps = el('div', 'entry-reps');
  for (let i = 0; i < measurement.reps; i += 1) {
    const caption = measurement.reps === 1 ? 'Значение' : `Повтор ${i + 1}`;
    const input = makeNumericInput(item.reps[i], (value) => {
      item.reps[i] = value;
      updateBlock(key);
    });
    reps.append(makeField(caption, input, 'entry-rep'));
  }
  card.append(reps);

  const medianLine = el('p', 'entry-median');
  card.append(medianLine);

  const warnings = el('div', 'entry-warnings');
  card.append(warnings);

  const note = makeInput('text', item.note, (value) => {
    item.note = value;
  });
  card.append(makeField('Заметка (необязательно)', note, 'entry-note'));

  state.blocks.set(key, { card, medianLine, warnings, needsConfirm: false });
  updateBlock(key);
  return card;
}

// Пересчёт производных узлов блока: медиана и предупреждения §5.3 / §7.2.
// Своей валидации здесь нет — только validateReps из session.js.
function updateBlock(key) {
  if (state === null) return;
  const refs = state.blocks.get(key);
  const item = state.values.get(key);
  if (!refs || !item) return;

  const measurement = getMeasurement(key);
  const value = median(item.reps);
  refs.medianLine.textContent = value === null
    ? 'Медиана: —'
    : `Медиана: ${formatMeasure(value, measurement ? measurement.unit : '')}`;
  refs.medianLine.classList.toggle('entry-median--empty', value === null);

  const { warnings } = validateReps(key, item.reps, previousValue(key));
  const nodes = [];
  let needsConfirm = false;
  for (const warning of warnings) {
    nodes.push(el('p', 'warn', warning.message));
    if (warning.requiresConfirm) needsConfirm = true;
  }
  if (needsConfirm) {
    // §7.2: «предупреждение с требованием подтвердить». Пока галочки нет,
    // кнопка «Сохранить» заблокирована.
    const confirm = makeCheckbox('Значение проверено — сохранить как есть', item.confirmed, (checked) => {
      item.confirmed = checked;
      // Сам блок не перерисовываем: узел, по которому только что щёлкнули,
      // не должен исчезнуть из-под пальца.
      updateSave();
    }, 'entry-choice entry-confirm');
    nodes.push(confirm.label);
  }
  refs.warnings.replaceChildren(...nodes);
  refs.needsConfirm = needsConfirm;

  updateSave();
}

function refreshBlocks() {
  if (state === null) return;
  for (const key of Array.from(state.blocks.keys())) updateBlock(key);
}

// Отклонение больше 5 см без подтверждения — единственная причина
// заблокировать сохранение. Разброс повторов только предупреждает.
function needsConfirmation() {
  if (state === null) return false;
  for (const [key, refs] of state.blocks) {
    if (!refs.needsConfirm) continue;
    const item = state.values.get(key);
    if (item && !item.confirmed) return true;
  }
  return false;
}

// ===== Сообщения под кнопкой ==============================================

function previousHint() {
  if (state.indexLoading) return 'Предыдущие значения ещё загружаются — проверка отклонения включится, когда они придут.';
  if (state.latest.size > 0) return '';
  const reason = state.indexError === null ? '' : ` ${errorText(state.indexError)}`;
  return `Предыдущих значений нет, поэтому отклонение от прошлого замера не проверяется.${reason}`;
}

function updateSave() {
  if (state === null || !state.nodes.save) return;
  const blocked = needsConfirmation();
  state.nodes.save.disabled = state.saving || blocked;
  state.nodes.save.textContent = state.saving ? SAVING_TEXT : SAVE_TEXT;

  const nodes = [];
  if (state.error !== null) {
    // Текст GitHubError уже русский и конкретный (§4 контракта) —
    // показываем как есть.
    nodes.push(el('p', 'warn', errorText(state.error)));
    if (state.error instanceof GitHubError && state.error.kind === 'no-token') {
      const link = el('a', 'btn', 'Открыть настройки');
      link.href = '#/settings';
      nodes.push(link);
    }
  }
  if (blocked) {
    nodes.push(el('p', 'field__hint', 'Отметь подтверждение у замера с предупреждением — тогда кнопка разблокируется.'));
  }
  const hint = previousHint();
  if (hint !== '') nodes.push(el('p', 'field__hint', hint));
  state.nodes.messages.replaceChildren(...nodes);
}

// ===== Карточки экрана ====================================================

function buildRulesCard() {
  const card = el('section', 'card');
  card.append(el('h2', null, 'Правила измерения'));
  const list = el('ul', 'entry-rules');
  for (const rule of RULES) list.append(el('li', null, rule));
  card.append(list);
  return card;
}

function setMode(mode) {
  if (state === null || state.mode === mode) return;
  state.mode = mode;
  if (state.nodes.modeFull) state.nodes.modeFull.checked = mode === 'full';
  if (state.nodes.modeCustom) state.nodes.modeCustom.checked = mode === 'custom';
  paintPicker();
  paintBlocks();
}

function paintPicker() {
  const picker = state.nodes.picker;
  if (!picker) return;
  if (state.mode !== 'custom') {
    picker.replaceChildren();
    return;
  }
  const nodes = [];
  for (const measurement of state.all) {
    const box = makeCheckbox(measurement.label, state.selected.has(measurement.key), (checked) => {
      if (checked) state.selected.add(measurement.key);
      else state.selected.delete(measurement.key);
      paintBlocks();
    }, 'entry-choice');
    box.label.dataset.key = measurement.key;
    nodes.push(box.label);
  }
  picker.replaceChildren(...nodes);
}

function buildCompositionCard() {
  const card = el('section', 'card');
  card.append(el('h2', null, 'Состав сессии'));

  const modes = el('div', 'entry-modes');
  const full = makeRadio('Полная сессия — все динамические замеры', state.mode === 'full', () => setMode('full'));
  const custom = makeRadio('Отдельные замеры — любые из каталога', state.mode === 'custom', () => setMode('custom'));
  state.nodes.modeFull = full.input;
  state.nodes.modeCustom = custom.input;
  modes.append(full.label, custom.label);
  card.append(modes);

  card.append(el('p', 'field__hint', 'Статику вроде роста и длины стопы тоже когда-то надо измерить — она в списке отдельных замеров.'));

  const picker = el('div', 'entry-picker');
  state.nodes.picker = picker;
  card.append(picker);
  paintPicker();
  return card;
}

function paintBlocks() {
  if (state === null || !state.nodes.list) return;
  state.blocks = new Map();
  const list = measurementsFor(state.mode);
  const nodes = list.map(buildBlock);
  if (nodes.length === 0) {
    const empty = el('section', 'card');
    empty.append(el('p', 'field__hint', 'Ни один замер не отмечен. Отметь в «Составе сессии», что будешь мерить.'));
    nodes.push(empty);
  }
  state.nodes.list.replaceChildren(...nodes);
  updateSave();
}

function buildConditionsCard() {
  const card = el('section', 'card');
  card.append(el('h2', null, 'Условия сессии'));

  // Дата и время редактируемы: вчерашний замер должно быть можно внести.
  const when = el('div', 'entry-datetime');
  when.append(makeField('Дата', makeInput('date', state.date, (value) => {
    state.date = value;
  })));
  when.append(makeField('Время', makeInput('time', state.time, (value) => {
    state.time = value;
  })));
  card.append(when);

  // Оба флага включены по умолчанию: протокол §5.3 — утренний, натощак,
  // после туалета. Снять галочку проще, чем вспомнить её поставить.
  const checks = el('div', 'entry-conditions');
  const fasted = makeCheckbox('Натощак, до еды', state.conditions.fasted, (checked) => {
    state.conditions.fasted = checked;
  });
  fasted.label.dataset.condition = 'fasted';
  const postVoid = makeCheckbox('После туалета', state.conditions.post_void, (checked) => {
    state.conditions.post_void = checked;
  });
  postVoid.label.dataset.condition = 'post_void';
  checks.append(fasted.label, postVoid.label);
  card.append(checks);

  // Поле необязательное: пусто -> null в файле, а не ноль. Ноль часов
  // означает «тренировка только что» — совсем другое утверждение.
  const hours = makeNumericInput(state.conditions.hours, (value) => {
    state.conditions.hours = value;
  }, 'numeric');
  card.append(makeField('Часов после тренировки (необязательно)', hours));

  return card;
}

function buildSaveCard() {
  const card = el('section', 'card entry-save');
  const button = makeButton(SAVE_TEXT, 'btn btn--primary', () => {
    void save();
  });
  state.nodes.save = button;
  card.append(button);

  const messages = el('div', 'entry-messages');
  state.nodes.messages = messages;
  card.append(messages);
  return card;
}

function paint() {
  const list = el('div', 'entry-blocks');
  state.nodes.list = list;
  state.root.replaceChildren(
    buildRulesCard(),
    buildCompositionCard(),
    list,
    buildConditionsCard(),
    buildSaveCard()
  );
  paintBlocks();
  updateSave();
}

// ===== Предыдущие значения ================================================

// Ответ, пришедший после ухода с экрана или после нового render(),
// не должен трогать чужую форму (§13 контракта, приём T1 про mountToken).
function outdated(token) {
  return state === null || state.token !== token;
}

async function runRefresh(token) {
  try {
    const file = await readFile(INDEX_PATH);
    const data = JSON.parse(file.content);
    if (outdated(token)) return;
    setIndexCache(data);
    state.latest = latestMap(data);
    state.indexError = null;
  } catch (error) {
    if (outdated(token)) return;
    // Кэш остаётся тем же: свежих предыдущих значений нет — сравниваем
    // со старыми, это лучше, чем не сравнивать вовсе.
    state.indexError = error;
  }
  if (outdated(token)) return;
  state.indexLoading = false;
  refreshBlocks();
  updateSave();
}

// ===== Сохранение =========================================================

function collectEntries() {
  const list = [];
  for (const measurement of measurementsFor(state.mode)) {
    const item = state.values.get(measurement.key);
    if (!item) continue;
    // Повторы уходят строками: разбор запятой и отсев пустых полей —
    // задача session.js, дублировать его логику здесь нельзя.
    list.push({ key: measurement.key, raw: item.reps.slice(), note: item.note });
  }
  return list;
}

async function save() {
  if (state === null || state.saving) return;
  const token = state.token;
  state.error = null;

  let session;
  try {
    session = buildSession({
      date: state.date,
      time: state.time,
      // Версия методики — из catalog.json, а не константа: значение,
      // подписанное чужой версией, портит весь ряд (§5 спеки).
      protocolVersion: protocolVersion(),
      conditions: {
        fasted: state.conditions.fasted,
        post_void: state.conditions.post_void,
        hours_since_training: state.conditions.hours
      },
      entries: collectEntries()
    });
  } catch (error) {
    state.error = error;
    updateSave();
    return;
  }

  state.saving = true;
  updateSave();

  try {
    // Имя занимаем по фактическому содержимому data/: вторая сессия
    // за день уезжает в '--2' (§6.1).
    const files = await listFiles(DATA_DIR);
    const name = sessionFileName(session.date, files.map((file) => file.name));
    // sha не передаётся никогда: файл сессии всегда новый. Это и есть
    // техническая гарантия иммутабельности из чек-листа §10.
    await writeFile(`${DATA_DIR}/${name}`, JSON.stringify(session, null, 2), {
      message: `Сессия ${session.date} ${session.time}`
    });
    if (outdated(token)) return;
    toast(SAVED_TEXT, 'ok');
    navigate('#/');
  } catch (error) {
    // T6: сюда встраивается офлайн-очередь. Вместо показа ошибки (или сразу
    // после неё) сессия кладётся в queue.js — enqueue({ path, content,
    // message }) со статусом «ожидает отправки», flush() дошлёт её при
    // появлении сети, а экран сообщает, что запись поставлена в очередь.
    // Форма при этом остаётся заполненной до подтверждения записи.
    if (outdated(token)) return;
    state.saving = false;
    state.error = error;
    updateSave();
  }
}

// ===== Контракт экрана ====================================================

export async function render(root, params) {
  const token = ++mountToken;
  state = null;

  let all;
  try {
    all = await loadCatalog();
  } catch (error) {
    // Пока грузился каталог, мог случиться переход на другой экран.
    if (token !== mountToken) return;
    const card = buildNotice('Каталог замеров не загрузился', error);
    card.append(makeButton('Повторить', 'btn', () => {
      void render(root, params);
    }));
    root.replaceChildren(card);
    return;
  }
  if (token !== mountToken) return;

  const cache = getIndexCache();
  const now = new Date();
  state = {
    token,
    root,
    all,
    mode: 'full',
    // Пустой набор для режима «отдельные замеры»: список отмечает пользователь.
    selected: new Set(),
    values: new Map(all.map((item) => [item.key, blankValue(item)])),
    conditions: { fasted: true, post_void: true, hours: '' },
    date: todayISO(now),
    time: currentTime(now),
    latest: latestMap(cache ? cache.data : null),
    indexLoading: true,
    indexError: null,
    saving: false,
    error: null,
    blocks: new Map(),
    nodes: {}
  };

  // Форма рисуется до сети: сеть нужна только для предыдущих значений.
  paint();
  void runRefresh(token);
}

export function destroy() {
  // Токен растёт и здесь: незавершённый runRefresh обязан увидеть отмену,
  // даже если следующий экран ещё не смонтирован.
  mountToken += 1;
  state = null;
}
