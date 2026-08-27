// Настройки (T8, §7.4 спеки): PAT, счётчик открытий шпаргалки, экспорт
// исходных сессий, управление обновлением приложения и офлайн-очередь.
//
// Экран — единственное место, где видно, что сессия ещё не уехала в repo B,
// поэтому он показывает задания целиком: путь файла, время постановки,
// статус и текст последней ошибки. Скрывать неотправленное нельзя ровно
// по той же причине, по которой шпаргалка не прячет устаревшие замеры
// (§13 контракта).
//
// Удаление задания — единственная кнопка в приложении, которая уничтожает
// введённые замеры, поэтому она двухшаговая. Правкой истории это не является:
// удалить можно только то, что ещё не записано в repo B.

import { navigate, toast } from '../app.js';
import {
  accountDataDir,
  accountProfilePath,
  findAccount,
  hashPassword,
  parseRegistry,
  removeAccount,
  upsertAccount,
  validatePassword,
  verifyPassword
} from '../accounts.js';
import { GitHubError, listFiles as listRepoFiles, readFile, readFileOrNull, writeFile } from '../github.js';
import { flush, isPersistent, listJobs, onQueueChange, removeJob } from '../queue.js';
import {
  clearAccountCache,
  clearActiveAccount,
  clearToken,
  getAccountProfile,
  getActiveAccount,
  getCheatsheetOpens,
  getOpens,
  getStoredToken,
  isFineGrainedToken,
  setAccountProfile,
  setToken
} from '../store.js';

export const title = 'Настройки';

const FLUSH_TEXT = 'Отправить сейчас';
const FLUSHING_TEXT = 'Отправляю…';
const EXPORT_TEXT = 'Скачать всё как JSON';
const EXPORTING_TEXT = 'Собираю JSON…';
const SESSION_NAME = /^\d{4}-\d{2}-\d{2}(?:--\d+)?\.json$/i;
const REGISTRY_PATH = 'accounts.json';
const MAX_WRITE_ATTEMPTS = 3;

const STATES = new Map([
  ['pending', 'Ожидает отправки'],
  ['sending', 'Отправляю…'],
  ['failed', 'Не отправилось']
]);

let mountToken = 0;
let state = null;

// ===== Чистые функции =====================================================

function pad2(number) {
  return String(number).padStart(2, '0');
}

// ISO -> '14.08.2026, 09:12'. Формат даты — тот же, что в шпаргалке (T4).
// Вручную, без toLocaleString: результат обязан совпадать в браузере
// и в node с урезанным ICU (§13 контракта).
export function formatWhen(iso) {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return '';
  const day = `${pad2(when.getDate())}.${pad2(when.getMonth() + 1)}.${when.getFullYear()}`;
  return `${day}, ${pad2(when.getHours())}:${pad2(when.getMinutes())}`;
}

export function stateLabel(status) {
  return STATES.get(status) ?? 'Ожидает отправки';
}

// ===== Мелкие узлы ========================================================

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function makeButton(text, className, onClick) {
  const button = el('button', className, text);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

// Общий текст ошибки для новых карточек T34 (пароль, тело, удаление) — та же
// идиома, что errorText() в screens/figure.js и screens/login.js, у каждого
// экрана своя копия с подходящим дефолтом (§14 контракта: три похожих места
// лучше преждевременной общей абстракции).
function errorText(error) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim() !== '') return error.trim();
  return 'Действие не выполнено.';
}

function buildSettingsHeading(kicker, titleText, metaText = null, metaTone = null) {
  const heading = el('header', 'settings-card__head');
  const titles = el('div', 'settings-card__titles');
  titles.append(
    el('span', 'settings-card__kicker', kicker),
    el('h2', 'settings-card__title', titleText)
  );
  heading.append(titles);
  if (metaText !== null) {
    const classes = ['settings-card__meta'];
    if (metaTone) classes.push(`settings-card__meta--${metaTone}`);
    heading.append(el('span', classes.join(' '), metaText));
  }
  return heading;
}

// ===== PAT, счётчик и экспорт ============================================

function paintToken() {
  if (state === null || !state.nodes.token) return;
  const card = state.nodes.token;
  const storedToken = getStoredToken();
  const tokenValid = storedToken !== null && isFineGrainedToken(storedToken);
  const heading = buildSettingsHeading(
    'GitHub',
    'Доступ к данным',
    storedToken === null ? 'PAT не задан' : (tokenValid ? 'PAT сохранён' : 'Нужно заменить'),
    storedToken === null ? 'muted' : (tokenValid ? 'good' : 'warning')
  );
  const field = el('label', 'field settings-field');
  field.append(el('span', 'settings-field__label', 'Fine-grained PAT'));

  const input = el('input', 'settings-token__input');
  input.type = 'password';
  input.name = 'github-token';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.value = storedToken ?? '';
  field.append(input);
  if (storedToken && !tokenValid) {
    field.append(el('span', 'warn settings-field__warning', 'Сохранённый токен не является fine-grained PAT. Замени его или очисти.'));
  }
  field.append(el('span', 'field__hint settings-field__hint', 'Нужен fine-grained PAT со сроком не больше 1 года и правом Contents: read and write только для repo B. Токен хранится только в этом браузере; приложение не может проверить реальный срок и scope.'));

  const actions = el('div', 'settings-actions settings-actions--token');
  actions.append(makeButton('Сохранить PAT', 'btn btn--primary', () => {
    if (!isFineGrainedToken(input.value)) {
      toast('Нужен fine-grained PAT с префиксом github_pat_.', 'error');
      return;
    }
    if (!setToken(input.value)) {
      toast('Не удалось сохранить PAT: хранилище браузера недоступно.', 'error');
      return;
    }
    paintToken();
    toast('PAT сохранён.', 'ok');
  }));
  const clear = makeButton('Очистить PAT', 'btn btn--danger', () => {
    if (!clearToken()) {
      toast('Не удалось удалить PAT: хранилище браузера недоступно.', 'error');
      return;
    }
    paintToken();
    toast('PAT удалён из браузера.', 'stale');
  });
  clear.disabled = storedToken === null;
  actions.append(clear);

  card.replaceChildren(heading, field, actions);
}

// Блок одного счётчика: заголовок, крупное число, время последнего события.
// modifier — доп. класс поверх settings-metric-block, чтобы отличать три
// блока в разметке (гейт §2 спеки завязан на T15-приёмку «старый счётчик
// шпаргалки не потерян»).
function metricBlock(modifier, heading, count, lastAt, emptyHint) {
  const block = el('article', `settings-metric-block settings-metric-block--${modifier}`);
  block.append(el('h3', null, heading));
  block.append(el('p', 'settings-metric', String(count)));
  block.append(el('p', 'field__hint', lastAt ? `Последнее: ${formatWhen(lastAt)}` : emptyHint));
  return block;
}

// §2 спеки: opens.sizes и opens.app — рабочий гейт с T15. bm.cheatsheet_opens
// (этап 1) не удаляется и не мигрируется — это уже накопленное измерение,
// переписать его новым счётчиком значило бы подделать наблюдение (§14 контракта).
function buildUsage() {
  const card = el('section', 'card settings-card settings-usage');
  card.append(
    buildSettingsHeading('На устройстве', 'Открытия', 'Локально', 'muted'),
    el('p', 'settings-card__intro', 'Счётчики помогают понять, какие части трекера действительно используются.')
  );

  const opensV2 = getOpens();
  const grid = el('div', 'settings-usage__grid');
  grid.append(metricBlock('sizes', 'Размеры', opensV2.sizes.count, opensV2.sizes.lastAt, 'Ещё не открывались.'));
  grid.append(metricBlock('app', 'Запуски приложения', opensV2.app.count, opensV2.app.lastAt, 'Ещё не запускалось.'));

  const legacy = getCheatsheetOpens();
  grid.append(metricBlock('legacy', 'Шпаргалка · этап 1', legacy.count, legacy.lastAt, 'Шпаргалка не открывалась.'));
  card.append(grid);

  return card;
}

function parseSession(text, path) {
  try {
    const session = JSON.parse(text);
    if (!session || typeof session !== 'object' || Array.isArray(session)) throw new Error();
    return session;
  } catch {
    throw new Error(`${path} содержит некорректный JSON.`);
  }
}

// До T29/T30 читал listRepoFiles('data') — путь, которого для accountId
// !== 'alex' больше ни у кого нет (T30 сознательно оставил починку на T34).
async function loadSessions() {
  const files = (await listRepoFiles(accountDataDir(getActiveAccount())))
    .filter((file) => typeof file.name === 'string' && SESSION_NAME.test(file.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  return Promise.all(files.map(async (file) => {
    const result = await readFile(file.path);
    return parseSession(result.content, file.path);
  }));
}

function validDate(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const stamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const date = new Date(stamp);
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() === Number(match[2]) - 1
    && date.getUTCDate() === Number(match[3]);
}

function validTime(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  return Boolean(match && Number(match[1]) < 24 && Number(match[2]) < 60);
}

function validProtocol(value) {
  return Number.isInteger(value) && value >= 1;
}

function validEntry(entry) {
  return Boolean(
    entry
    && typeof entry === 'object'
    && !Array.isArray(entry)
    && typeof entry.key === 'string'
    && entry.key.trim() !== ''
    && Array.isArray(entry.raw)
    && entry.raw.length > 0
    && entry.raw.every(Number.isFinite)
    && Number.isFinite(entry.value)
    && typeof entry.unit === 'string'
    && entry.unit.trim() !== ''
    && validProtocol(entry.protocol_version)
    && typeof entry.note === 'string'
  );
}

function isSession(data) {
  const conditions = data?.conditions;
  return Boolean(
    data
    && typeof data === 'object'
    && !Array.isArray(data)
    && validDate(data.date)
    && validTime(data.time)
    && validProtocol(data.protocol_version)
    && conditions
    && typeof conditions === 'object'
    && !Array.isArray(conditions)
    && typeof conditions.fasted === 'boolean'
    && typeof conditions.post_void === 'boolean'
    && (conditions.hours_since_training === null
      || (Number.isFinite(conditions.hours_since_training) && conditions.hours_since_training >= 0))
    && Array.isArray(data.entries)
    && data.entries.length > 0
    && data.entries.every(validEntry)
  );
}

// Фильтр по job.accountId (поле есть с T30) вместо перестройки регэкспа
// пути под динамический accounts/<id>/data/... — надёжнее и переживает
// смену схемы пути без правки этого экрана.
async function loadQueuedSessions() {
  const jobs = await listJobs();
  const accountId = getActiveAccount();
  const sessions = [];
  for (const job of jobs) {
    if (job.accountId !== accountId || typeof job.content !== 'string') continue;
    try {
      const data = JSON.parse(job.content);
      if (isSession(data)) sessions.push(data);
    } catch {
      // Мусорное задание не делает весь экспорт непригодным.
    }
  }
  return sessions;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const key of Object.keys(value).sort()) result[key] = canonical(value[key]);
  return result;
}

function mergeSessions(remote, queued) {
  const result = remote.slice();
  const remainingRemote = new Map();
  for (const session of remote) {
    const key = JSON.stringify(canonical(session));
    remainingRemote.set(key, (remainingRemote.get(key) ?? 0) + 1);
  }
  for (const session of queued) {
    const key = JSON.stringify(canonical(session));
    const copies = remainingRemote.get(key) ?? 0;
    if (copies > 0) {
      remainingRemote.set(key, copies - 1);
      continue;
    }
    result.push(session);
  }
  return result;
}

function downloadSessions(sessions) {
  const content = `${JSON.stringify(sessions, null, 2)}\n`;
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = el('a');
  link.href = url;
  link.download = `body-measurements-${new Date().toISOString().slice(0, 10)}.json`;
  state.root.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function paintExport() {
  if (state === null || !state.nodes.export) return;
  const card = state.nodes.export;
  const button = makeButton(state.exportBusy ? EXPORTING_TEXT : EXPORT_TEXT, 'btn btn--primary', () => {
    void exportSessions();
  });
  button.disabled = state.exportBusy;
  card.replaceChildren(
    buildSettingsHeading('Резервная копия', 'Экспорт данных', 'JSON', 'muted'),
    el('p', 'settings-card__intro', 'Скачивает одним файлом серверные сессии и корректные сессии, которые ещё ждут в офлайн-очереди.'),
    el('div', 'settings-actions settings-actions--single')
  );
  card.children[2].append(button);
}

async function exportSessions() {
  if (state === null || state.exportBusy) return;
  const token = state.token;
  state.exportBusy = true;
  paintExport();
  try {
    const [remote, queued] = await Promise.all([loadSessions(), loadQueuedSessions()]);
    const sessions = mergeSessions(remote, queued);
    if (outdated(token)) return;
    downloadSessions(sessions);
    toast(`Сессий в экспорте: ${sessions.length}`, 'ok');
  } catch (error) {
    if (!outdated(token)) {
      toast(error instanceof Error && error.message ? error.message : 'Экспорт не удался.', 'error');
    }
  } finally {
    if (!outdated(token)) {
      state.exportBusy = false;
      paintExport();
    }
  }
}

function updateSupported() {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
}

function observeUpdate(registration) {
  const owner = state;
  let worker = null;
  let settled = false;
  let resolvePromise;

  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });

  const removeListeners = () => {
    if (typeof registration.removeEventListener === 'function') {
      registration.removeEventListener('updatefound', watchRegistration);
    }
    if (worker && typeof worker.removeEventListener === 'function') {
      worker.removeEventListener('statechange', check);
    }
  };

  const destroyCancel = () => finish(null);

  function finish(value) {
    if (settled) return;
    settled = true;
    removeListeners();
    if (owner) owner.cleanups.delete(destroyCancel);
    resolvePromise(value);
  }

  function check() {
    if (settled) return;
    if (registration.waiting) {
      finish(registration.waiting);
      return;
    }
    if (worker?.state === 'installed') {
      finish(worker);
      return;
    }
    if (worker?.state === 'redundant' || worker?.state === 'activated') finish(null);
  }

  function watchWorker(next) {
    if (settled) return;
    if (!next || next === worker) return;
    if (worker && typeof worker.removeEventListener === 'function') {
      worker.removeEventListener('statechange', check);
    }
    worker = next;
    if (typeof worker.addEventListener === 'function') worker.addEventListener('statechange', check);
    check();
  }

  function watchRegistration() {
    if (settled) return;
    watchWorker(registration.installing);
    check();
  }

  if (owner) owner.cleanups.add(destroyCancel);
  if (typeof registration.addEventListener === 'function') {
    registration.addEventListener('updatefound', watchRegistration);
  }
  watchWorker(registration.installing);
  check();

  return {
    promise,
    cancel: destroyCancel,
    updateFinished() {
      if (settled) return;
      watchWorker(registration.installing);
      check();
      // update() завершился без updatefound, installing и waiting — это
      // достоверная ветка «новой версии нет», ждать событие больше некого.
      if (!settled && !worker && !registration.installing && !registration.waiting) finish(null);
    }
  };
}

function listenForControllerChange(token) {
  const owner = state;
  const serviceWorker = navigator.serviceWorker;
  let active = true;
  const remove = () => {
    if (!active) return;
    active = false;
    if (typeof serviceWorker.removeEventListener === 'function') {
      serviceWorker.removeEventListener('controllerchange', handle);
    }
    if (owner) owner.cleanups.delete(remove);
  };
  const handle = () => {
    remove();
    if (!outdated(token) && typeof location.reload === 'function') location.reload();
  };
  if (owner) owner.cleanups.add(remove);
  serviceWorker.addEventListener('controllerchange', handle);
  return remove;
}

function activateWorker(worker, token) {
  if (outdated(token)) return;
  const stopControllerListener = listenForControllerChange(token);
  try {
    worker.postMessage({ type: 'skip-waiting' });
  } catch (error) {
    stopControllerListener();
    throw error;
  }
  toast('Включаю новую версию…', 'stale');
}

async function updateApp() {
  if (state === null || state.updateBusy) return;
  if (!updateSupported()) {
    toast('Обновления недоступны в этом браузере.', 'error');
    return;
  }
  const token = state.token;
  state.updateBusy = true;
  paintUpdate();
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (outdated(token)) return;
    if (!registration) throw new Error('Service worker ещё не установлен. Перезапусти приложение.');
    // Уже установленная версия не требует сети: кнопка должна включить её
    // даже офлайн, не вызывая registration.update().
    if (registration.waiting) {
      activateWorker(registration.waiting, token);
      return;
    }
    const observation = observeUpdate(registration);
    try {
      await registration.update();
    } catch (error) {
      observation.cancel();
      throw error;
    }
    observation.updateFinished();
    if (outdated(token)) return;
    const worker = await observation.promise;
    if (outdated(token)) return;
    if (!worker) {
      toast('Новая версия не найдена.', 'ok');
      return;
    }
    activateWorker(worker, token);
  } catch (error) {
    if (!outdated(token)) {
      toast(error instanceof Error && error.message ? error.message : 'Проверить обновление не удалось.', 'error');
    }
  } finally {
    if (!outdated(token)) {
      state.updateBusy = false;
      paintUpdate();
    }
  }
}

function paintUpdate() {
  if (state === null || !state.nodes.update) return;
  const card = state.nodes.update;
  const supported = updateSupported();
  const button = makeButton(state.updateBusy ? 'Проверяю…' : 'Обновить приложение', 'btn', () => {
    void updateApp();
  });
  button.disabled = state.updateBusy || !supported;
  card.replaceChildren(
    buildSettingsHeading(
      'Версия',
      'Приложение',
      state.updateBusy ? 'Проверка…' : (supported ? 'Готово' : 'Недоступно'),
      state.updateBusy ? null : (supported ? 'good' : 'muted')
    ),
    el('p', 'settings-card__intro', 'Проверяет новую оболочку и включает её по явной команде.'),
    el('div', 'settings-actions settings-actions--single')
  );
  card.children[2].append(button);
}

// ===== Смена пароля (T34) =================================================
// Тот же приём read-sha-write-retry-on-conflict, что createAccount() в
// screens/login.js (строки ~379-424): читаем реестр, проверяем текущий
// пароль через accounts.verifyPassword, пишем новый хеш, на conflict —
// один перечитывающий повтор (id не меняется, поэтому веток «занято» нет).
// Логаут не выполняется — bm.active_account пароль не хранит, менять нечего.

function paintPassword() {
  if (state === null || !state.nodes.password) return;
  const card = state.nodes.password;
  const heading = buildSettingsHeading('Профиль', 'Смена пароля');

  const currentField = el('label', 'field settings-field');
  currentField.append(el('span', 'settings-field__label', 'Текущий пароль'));
  const currentInput = el('input', 'settings-token__input');
  currentInput.type = 'password';
  currentInput.autocomplete = 'current-password';
  currentInput.spellcheck = false;
  currentInput.value = state.password.current;
  currentInput.addEventListener('input', () => {
    if (state === null) return;
    state.password.current = currentInput.value;
  });
  currentField.append(currentInput);

  const nextField = el('label', 'field settings-field');
  nextField.append(el('span', 'settings-field__label', 'Новый пароль'));
  const nextInput = el('input', 'settings-token__input');
  nextInput.type = 'password';
  nextInput.autocomplete = 'new-password';
  nextInput.spellcheck = false;
  nextInput.value = state.password.next;
  nextInput.addEventListener('input', () => {
    if (state === null) return;
    state.password.next = nextInput.value;
  });
  nextField.append(nextInput);

  const actions = el('div', 'settings-actions settings-actions--single');
  if (state.password.error) actions.append(el('p', 'warn', state.password.error));
  const button = makeButton(state.password.busy ? 'Меняю…' : 'Сменить пароль', 'btn btn--primary', () => {
    void changePassword();
  });
  button.disabled = state.password.busy;
  actions.append(button);

  card.replaceChildren(heading, currentField, nextField, actions);
}

async function changePassword() {
  if (state === null || state.password.busy) return;
  const token = state.token;
  const accountId = getActiveAccount();
  const currentValue = state.password.current;
  const validation = validatePassword(state.password.next);
  if (!validation.ok) {
    state.password.error = validation.message;
    paintPassword();
    return;
  }

  state.password.busy = true;
  state.password.error = null;
  paintPassword();

  let registry;
  let sha;
  try {
    const file = await readFile(REGISTRY_PATH);
    if (outdated(token)) return;
    registry = parseRegistry(JSON.parse(file.content));
    sha = file.sha;
  } catch (error) {
    if (outdated(token)) return;
    state.password.busy = false;
    state.password.error = errorText(error);
    paintPassword();
    return;
  }

  const account = findAccount(registry, accountId);
  if (!account) {
    state.password.busy = false;
    state.password.error = 'Профиль не найден в реестре.';
    paintPassword();
    return;
  }

  const verified = await verifyPassword(currentValue, account);
  if (outdated(token)) return;
  if (!verified) {
    state.password.busy = false;
    toast('Неверный пароль.', 'error');
    paintPassword();
    return;
  }

  let hashed;
  try {
    hashed = await hashPassword(validation.value);
  } catch (error) {
    if (outdated(token)) return;
    state.password.busy = false;
    state.password.error = errorText(error);
    paintPassword();
    return;
  }
  if (outdated(token)) return;

  let newRegistry = upsertAccount(registry, { ...account, salt: hashed.salt, hash: hashed.hash });
  let lastError = null;
  let written = false;

  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
    try {
      await writeFile(REGISTRY_PATH, `${JSON.stringify(newRegistry, null, 2)}\n`, {
        message: `Смена пароля: ${account.label}`,
        sha
      });
      written = true;
      break;
    } catch (error) {
      if (outdated(token)) return;
      lastError = error;
      const conflict = error instanceof GitHubError && error.kind === 'conflict';
      if (!conflict || attempt === MAX_WRITE_ATTEMPTS) break;

      // Кто-то мог сменить реестр между нашим чтением и записью —
      // перечитываем и повторяем на свежей копии (тот же приём, что в
      // login.js).
      let fresh;
      try {
        fresh = await readFile(REGISTRY_PATH);
      } catch (rereadError) {
        if (outdated(token)) return;
        lastError = rereadError;
        break;
      }
      if (outdated(token)) return;

      registry = parseRegistry(JSON.parse(fresh.content));
      sha = fresh.sha;
      const freshAccount = findAccount(registry, accountId) ?? account;
      newRegistry = upsertAccount(registry, { ...freshAccount, salt: hashed.salt, hash: hashed.hash });
    }
  }

  if (!written) {
    state.password.busy = false;
    state.password.error = errorText(lastError);
    paintPassword();
    return;
  }

  state.password.busy = false;
  state.password.current = '';
  state.password.next = '';
  toast('Пароль изменён.', 'ok');
  paintPassword();
}

// ===== Модель тела (T34) ===================================================
// Та же сегментированная пилюля male/female, что buildSexField/buildSexItem
// в screens/figure.js, и тот же приём remote-записи profile.json
// (read-sha-write-retry-on-conflict), что T32 добавил там же — код
// скопирован, а не импортирован: контракт задачи прямо просит не выносить
// в общий модуль ради двух вызовов (§14 контракта).

function buildSexItem(label, sex, active) {
  const item = el('button', active ? 'fig-sex__item fig-sex__item--active' : 'fig-sex__item', label);
  item.type = 'button';
  item.setAttribute('role', 'radio');
  item.setAttribute('aria-checked', active ? 'true' : 'false');
  item.addEventListener('click', () => {
    if (state === null || state.profile.sex === sex) return;
    const accountId = getActiveAccount();
    state.profile = setAccountProfile(accountId, { sex });
    paintBody();
    void writeRemoteProfile(accountId, sex);
  });
  return item;
}

function buildSexField(profile) {
  const field = el('div', 'fig-sex');
  field.setAttribute('role', 'radiogroup');
  field.setAttribute('aria-label', 'Модель тела');
  field.append(
    buildSexItem('Мужской', 'male', profile.sex === 'male'),
    buildSexItem('Женский', 'female', profile.sex === 'female')
  );
  return field;
}

async function writeRemoteProfile(accountId, sex) {
  const path = accountProfilePath(accountId);
  const body = `${JSON.stringify({ sex }, null, 2)}\n`;
  const message = `Смена модели тела: ${sex}`;

  let sha = null;
  try {
    const existing = await readFileOrNull(path);
    sha = existing ? existing.sha : null;
  } catch (error) {
    toast(errorText(error), 'error');
    return;
  }

  try {
    await writeFile(path, body, { sha, message });
    return;
  } catch (error) {
    if (!(error instanceof GitHubError) || error.kind !== 'conflict') {
      toast(errorText(error), 'error');
      return;
    }
  }

  // Кто-то (другое устройство того же профиля) мог записать profile.json
  // между нашим чтением и записью — перечитываем и повторяем один раз.
  let fresh;
  try {
    fresh = await readFileOrNull(path);
  } catch (error) {
    toast(errorText(error), 'error');
    return;
  }
  try {
    await writeFile(path, body, { sha: fresh ? fresh.sha : null, message });
  } catch (error) {
    toast(errorText(error), 'error');
  }
}

function paintBody() {
  if (state === null || !state.nodes.body) return;
  const card = state.nodes.body;
  const heading = buildSettingsHeading('Профиль', 'Модель тела');
  const field = el('div', 'settings-field');
  field.append(el('span', 'settings-field__label', 'Силуэт'), buildSexField(state.profile));
  card.replaceChildren(heading, field);
}

// ===== Удаление профиля (T34) ==============================================
// Реально удаляется только запись в accounts.json — файлы accounts/<id>/data/**,
// index.json, profile.json в repo B не удаляются: в github.js нет DELETE-
// обёртки над Contents API, заводить её ради одной кнопки — за пределами
// задачи (осознанный выбор архитектора, план accounts-plan-T28-T35.md).

function paintDelete() {
  if (state === null || !state.nodes.delete) return;
  const card = state.nodes.delete;
  const heading = buildSettingsHeading('Профиль', 'Удаление профиля');
  const intro = el(
    'p',
    'settings-card__intro',
    'Удаляет вход в этот профиль: логин и пароль пропадут из общего реестра. Внесённые замеры в репозитории с данными не удаляются.'
  );
  const actions = el('div', 'settings-actions');

  if (state.delete.confirming) {
    const accountId = getActiveAccount();
    const pendingCount = state.jobs.filter((job) => job.accountId === accountId).length;
    const warnText = pendingCount > 0
      ? `Несинхронизированных сессий: ${pendingCount}. Они пропадут вместе с профилем.`
      : 'Профиль будет удалён навсегда.';
    actions.append(el('p', 'warn', warnText));
    const confirm = makeButton(state.delete.busy ? 'Удаляю…' : 'Удалить навсегда', 'btn btn--danger', () => {
      void deleteAccount();
    });
    confirm.disabled = state.delete.busy;
    actions.append(confirm);
    const cancel = makeButton('Отмена', 'btn', () => {
      if (state === null || state.delete.busy) return;
      state.delete.confirming = false;
      paintDelete();
    });
    cancel.disabled = state.delete.busy;
    actions.append(cancel);
  } else {
    actions.append(makeButton('Удалить профиль', 'btn btn--danger', () => {
      if (state === null) return;
      state.delete.confirming = true;
      paintDelete();
    }));
  }

  card.replaceChildren(heading, intro, actions);
}

async function deleteAccount() {
  if (state === null || state.delete.busy) return;
  const token = state.token;
  const accountId = getActiveAccount();
  state.delete.busy = true;
  paintDelete();

  let jobsToRemove;
  try {
    jobsToRemove = (await listJobs()).filter((job) => job.accountId === accountId);
  } catch (error) {
    if (outdated(token)) return;
    state.delete.busy = false;
    toast(errorText(error), 'error');
    paintDelete();
    return;
  }
  if (outdated(token)) return;

  for (const job of jobsToRemove) {
    await removeJob(job.id);
    if (outdated(token)) return;
  }

  let registry;
  let sha;
  try {
    const file = await readFile(REGISTRY_PATH);
    if (outdated(token)) return;
    registry = parseRegistry(JSON.parse(file.content));
    sha = file.sha;
  } catch (error) {
    if (outdated(token)) return;
    state.delete.busy = false;
    toast(errorText(error), 'error');
    paintDelete();
    return;
  }

  const newRegistry = removeAccount(registry, accountId);
  try {
    await writeFile(REGISTRY_PATH, `${JSON.stringify(newRegistry, null, 2)}\n`, {
      message: `Удаление профиля ${accountId}`,
      sha
    });
  } catch (error) {
    if (outdated(token)) return;
    state.delete.busy = false;
    toast(errorText(error), 'error');
    paintDelete();
    return;
  }
  if (outdated(token)) return;

  clearAccountCache(accountId);
  clearActiveAccount();
  toast('Профиль удалён.', 'stale');
  navigate('#/login');
}

// ===== Карточка очереди ===================================================

function buildJob(job) {
  const item = el('li', `queue-job queue-job--${job.status}`);
  item.dataset.job = String(job.id);

  const heading = el('div', 'queue-job__head');
  heading.append(
    el('p', 'queue-job__path', job.path),
    el('p', `queue-job__state queue-job__state--${job.status}`, stateLabel(job.status))
  );
  item.append(heading);
  item.append(el('p', 'queue-job__when', `Поставлено ${formatWhen(job.createdAt)}`));

  // Текст ошибки — как есть: он уже русский и конкретный (§4 контракта).
  if (typeof job.lastError === 'string' && job.lastError.trim() !== '') {
    item.append(el('p', 'warn queue-job__error', job.lastError));
  }

  const actions = el('div', 'queue-actions queue-actions--job');
  if (state.confirmId === job.id) {
    actions.append(el('p', 'warn', 'Замеры из этой сессии пропадут навсегда.'));
    actions.append(makeButton('Удалить навсегда', 'btn btn--danger', () => {
      void dropJob(job.id);
    }));
    actions.append(makeButton('Отмена', 'btn', () => {
      state.confirmId = null;
      paintQueue();
    }));
  } else {
    actions.append(makeButton('Удалить', 'btn', () => {
      state.confirmId = job.id;
      paintQueue();
    }));
  }
  item.append(actions);

  return item;
}

function paintQueue() {
  if (state === null || !state.nodes.queue) return;
  const card = state.nodes.queue;
  const metaText = state.busy
    ? 'Отправка…'
    : (state.jobs.length === 0 ? 'Всё отправлено' : `Заданий: ${state.jobs.length}`);
  const metaTone = state.busy ? null : (state.jobs.length === 0 ? 'good' : 'pending');
  const heading = buildSettingsHeading('Синхронизация', 'Очередь отправки', metaText, metaTone);
  const meta = heading.children[1];
  if (meta) meta.setAttribute('aria-live', 'polite');
  const nodes = [heading];

  nodes.push(el('p', 'settings-card__intro', 'Сессия сначала попадает сюда и только потом уходит в репозиторий с данными. Пока задание в очереди, замеры не потеряны.'));

  if (!isPersistent()) {
    nodes.push(el('p', 'warn settings-notice', 'Браузер не даёт сохранить очередь на диск: незакрытая вкладка — единственное, что её держит.'));
  }

  if (state.jobs.length === 0) {
    const empty = el('div', 'queue-empty');
    empty.append(
      el('strong', 'queue-empty__title', 'Очередь пуста'),
      el('span', 'queue-empty__text', 'Все сессии отправлены.')
    );
    nodes.push(empty);
  } else {
    const list = el('ul', 'queue-list');
    list.setAttribute('aria-label', 'Неотправленные сессии');
    for (const job of state.jobs) list.append(buildJob(job));
    nodes.push(list);
  }

  const actions = el('div', 'queue-actions queue-actions--flush');
  const button = makeButton(state.busy ? FLUSHING_TEXT : FLUSH_TEXT, 'btn btn--primary', () => {
    void sendNow();
  });
  // Пустую очередь отправлять нечего, но кнопку показываем всегда: её
  // отсутствие читалось бы как «отправка сломалась».
  button.disabled = state.busy || state.jobs.length === 0;
  actions.append(button);
  nodes.push(actions);

  card.replaceChildren(...nodes);
}

// ===== Действия ===========================================================

function outdated(token) {
  return state === null || state.token !== token;
}

async function reload() {
  // Слушатель очереди мог сработать уже после ухода с экрана.
  if (state === null) return;
  const token = state.token;
  let jobs;
  try {
    jobs = await listJobs();
  } catch {
    jobs = [];
  }
  if (outdated(token)) return;
  state.jobs = jobs;
  // Подтверждение снимается, если задания уже нет: кнопка не должна
  // висеть над пустотой.
  if (state.confirmId !== null && !jobs.some((job) => job.id === state.confirmId)) {
    state.confirmId = null;
  }
  paintQueue();
  // Число несинхронизированных сессий в подтверждении удаления профиля
  // обязано поспевать за очередью — иначе там мог остаться счётчик от
  // заданий, которые сама же отправка уже сняла.
  if (state.delete.confirming) paintDelete();
}

async function dropJob(id) {
  const token = state.token;
  await removeJob(id);
  if (outdated(token)) return;
  state.confirmId = null;
  toast('Задание удалено.', 'stale');
  await reload();
}

async function sendNow() {
  if (state === null || state.busy) return;
  const token = state.token;
  state.busy = true;
  paintQueue();

  const result = await flush();
  if (outdated(token)) return;
  state.busy = false;
  await reload();
  if (outdated(token)) return;

  if (result.sent > 0) toast(`Отправлено: ${result.sent}`, 'ok');
  // Показываем первую причину: остальные видны в списке заданий.
  if (result.failed > 0) toast(result.errors[0] ?? 'Отправить не удалось.', 'error');
}

// ===== Контракт экрана ====================================================

export async function render(root, params) {
  const token = ++mountToken;
  state = {
    token,
    root,
    jobs: [],
    busy: false,
    exportBusy: false,
    updateBusy: false,
    confirmId: null,
    password: { current: '', next: '', busy: false, error: null },
    profile: getAccountProfile(getActiveAccount()),
    delete: { confirming: false, busy: false },
    unsubscribe: null,
    cleanups: new Set(),
    nodes: {}
  };

  const tokenCard = el('section', 'card settings-card settings-token');
  state.nodes.token = tokenCard;

  const usage = buildUsage();

  const exportCard = el('section', 'card settings-card settings-export');
  state.nodes.export = exportCard;

  const queue = el('section', 'card settings-card settings-queue');
  state.nodes.queue = queue;

  const update = el('section', 'card settings-card settings-update');
  state.nodes.update = update;

  const tools = el('section', 'settings-tools');
  tools.setAttribute('aria-label', 'Обслуживание приложения');
  tools.append(exportCard, update);

  const passwordCard = el('section', 'card settings-card settings-password');
  state.nodes.password = passwordCard;

  const bodyCard = el('section', 'card settings-card settings-body');
  state.nodes.body = bodyCard;

  const deleteCard = el('section', 'card settings-card settings-delete');
  state.nodes.delete = deleteCard;

  const screen = el('div', 'settings-screen');
  screen.append(tokenCard, usage, tools, passwordCard, bodyCard, queue, deleteCard);
  root.replaceChildren(screen);
  paintToken();
  paintExport();
  paintQueue();
  paintUpdate();
  paintPassword();
  paintBody();
  paintDelete();

  // Очередь меняется и без участия экрана: досылка по событию online.
  state.unsubscribe = onQueueChange(() => {
    void reload();
  });
  await reload();
}

export function destroy() {
  if (state && typeof state.unsubscribe === 'function') state.unsubscribe();
  if (state) {
    for (const cleanup of Array.from(state.cleanups)) cleanup();
    state.cleanups.clear();
  }
  mountToken += 1;
  state = null;
}
