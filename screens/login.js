// Экран входа (T31, §17 контракта: «screens/login.js (T31, новый экран)»).
//
// Гейт `app.js` открывает этот экран на любом маршруте, пока в localStorage
// нет активного профиля (`bm.active_account`), и не пускает сюда, когда он
// уже есть — переключателя профиля нет, смена профиля это выход и вход
// (accounts-plan-T28-T35.md, «Модель»).
//
// Два поля — логин и пароль. Провал клиентской валидации (accounts.js)
// не долетает до сети вообще. Дальше — чтение accounts.json (с офлайн-
// откатом на bm.accounts_cache) и один из двух путей: найденный логин
// проверяет пароль, ненайденный предлагает завести профиль — явным вторым
// нажатием, а не молча («Профиля «label» нет. Создать?» — опечатка в логине
// не должна тихо плодить пустые профили).
//
// mountToken — тот же приём отмены поздних ответов, что в entry.js/settings.js:
// каждый render()/destroy() двигает счётчик, все continuation после await
// проверяют outdated(token) перед тем, как тронуть state или DOM.

import { navigate, toast } from '../app.js';
import {
  accountProfilePath,
  findAccount,
  hashPassword,
  parseRegistry,
  upsertAccount,
  validateLogin,
  validatePassword,
  verifyPassword
} from '../accounts.js';
import { GitHubError, readFile, readFileOrNull, writeFile } from '../github.js';
import {
  getAccountsCache,
  getLastLogin,
  getProfile,
  setAccountProfile,
  setAccountsCache,
  setActiveAccount,
  setLastLogin
} from '../store.js';

export const title = 'Вход';

const REGISTRY_PATH = 'accounts.json';
const MAX_WRITE_ATTEMPTS = 3;

const SUBMIT_TEXT = 'Войти';
const SUBMITTING_TEXT = 'Вхожу…';
const CREATE_TEXT = 'Создать профиль';
const CREATING_TEXT = 'Создаю…';

let mountToken = 0;
let state = null;

// ===== Чистые мелочи =======================================================

function pad2(number) {
  return String(number).padStart(2, '0');
}

// Дублирует entry.js::todayISO() тремя строками намеренно (§17 контракта,
// подсказка задачи): импортировать один экран из другого в проекте нигде
// не принято, а дата регистрации — не то значение, ради которого стоит
// заводить первый такой прецедент.
function todayISO(now = new Date()) {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

function errorText(error) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim() !== '') return error.trim();
  return 'Не удалось выполнить вход.';
}

function outdated(token) {
  return state === null || state.token !== token;
}

// ===== Узлы =================================================================

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

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
  input.addEventListener('change', handler);
  return input;
}

function makeButton(text, className, onClick) {
  const button = el('button', className, text);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

// ===== Точечные перерисовки =================================================
// Поля логина/пароля не пересоздаются: полный replaceChildren на каждое
// нажатие клавиши, как в шпаргалке T4, уносил бы фокус и каретку (тот же
// довод, что у entry.js).

function renderFormMessages() {
  if (state === null || !state.nodes.formMessages) return;
  const nodes = [];
  if (state.formError) nodes.push(el('p', 'warn', state.formError));
  state.nodes.formMessages.replaceChildren(...nodes);
}

function updateSubmit() {
  if (state === null || !state.nodes.submit) return;
  state.nodes.submit.disabled = state.busy || state.creating;
  state.nodes.submit.textContent = state.busy ? SUBMITTING_TEXT : SUBMIT_TEXT;
}

function buildSexChoice(value, labelText) {
  const item = el('label', 'login-choice');
  const input = document.createElement('input');
  input.type = 'radio';
  input.name = 'login-sex';
  input.checked = state.sex === value;
  input.addEventListener('change', () => {
    if (state === null || !input.checked) return;
    state.sex = value;
  });
  item.append(input, el('span', null, labelText));
  return item;
}

// Модель тела при регистрации — те же два варианта, что у store.getProfile()
// (§17 контракта: «male/female, как в store.getProfile()»), тот же приём
// сегментированного radio-выбора, что и у screens/figure.js::buildSexField.
function buildCreateCard() {
  const label = state.pendingAccount.label;
  const card = el('section', 'card login-create');
  card.append(el('p', 'login-create__question', `Профиля «${label}» нет. Создать?`));

  const sexField = el('fieldset', 'login-sex');
  sexField.append(el('legend', null, 'Модель тела'));
  const group = el('div', 'login-sex__group');
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', 'Модель тела');
  group.append(buildSexChoice('male', 'Мужской'), buildSexChoice('female', 'Женский'));
  sexField.append(group);
  card.append(sexField);

  const messages = el('div', 'login-create__messages');
  if (state.createError) messages.append(el('p', 'warn', state.createError));
  card.append(messages);

  const actions = el('div', 'login-actions');
  const confirm = makeButton(state.creating ? CREATING_TEXT : CREATE_TEXT, 'btn btn--primary login-create__confirm', () => {
    void createAccount();
  });
  confirm.disabled = state.creating;
  actions.append(confirm);

  const cancel = makeButton('Это не тот логин', 'btn login-create__cancel', () => {
    if (state === null || state.creating) return;
    state.mode = 'login';
    state.pendingAccount = null;
    state.createError = null;
    renderCreateSection();
  });
  cancel.disabled = state.creating;
  actions.append(cancel);
  card.append(actions);

  return card;
}

function renderCreateSection() {
  if (state === null || !state.nodes.createHost) return;
  if (state.mode !== 'confirm-create' || state.pendingAccount === null) {
    state.nodes.createHost.replaceChildren();
    return;
  }
  state.nodes.createHost.replaceChildren(buildCreateCard());
}

function paint() {
  const screen = el('div', 'login-screen');

  const card = el('section', 'card login-card');

  card.append(el('h2', 'login-heading', 'Вход'));

  const loginInput = makeInput('text', state.login, (value) => {
    state.login = value;
  });
  loginInput.autocomplete = 'username';
  loginInput.dataset.field = 'login';
  state.nodes.loginInput = loginInput;
  card.append(makeField('Логин', loginInput));

  const passwordInput = makeInput('password', state.password, (value) => {
    state.password = value;
  });
  passwordInput.autocomplete = 'current-password';
  passwordInput.dataset.field = 'password';
  state.nodes.passwordInput = passwordInput;
  card.append(makeField('Пароль', passwordInput));

  const messages = el('div', 'login-messages');
  state.nodes.formMessages = messages;
  card.append(messages);

  const submit = makeButton(SUBMIT_TEXT, 'btn btn--primary login-submit', () => {
    void submitLogin();
  });
  state.nodes.submit = submit;
  card.append(submit);

  screen.append(card);

  const createHost = el('div', 'login-create-host');
  state.nodes.createHost = createHost;
  screen.append(createHost);

  state.root.replaceChildren(screen);
  updateSubmit();
  renderFormMessages();
  renderCreateSection();
}

// ===== Вход =================================================================

async function submitLogin() {
  if (state === null || state.busy || state.creating) return;
  const token = state.token;

  const loginResult = validateLogin(state.login);
  const passwordResult = validatePassword(state.password);
  const messages = [];
  if (!loginResult.ok) messages.push(loginResult.message);
  if (!passwordResult.ok) messages.push(passwordResult.message);
  if (messages.length > 0) {
    // Клиентская проверка — до единого сетевого запроса.
    state.formError = messages.join(' ');
    renderFormMessages();
    return;
  }

  state.busy = true;
  state.formError = null;
  updateSubmit();
  renderFormMessages();

  let registry;
  let sha = null;
  try {
    const file = await readFile(REGISTRY_PATH);
    if (outdated(token)) return;
    registry = parseRegistry(JSON.parse(file.content));
    sha = file.sha;
    setAccountsCache(registry);
  } catch (error) {
    if (outdated(token)) return;
    if (error instanceof GitHubError && error.kind === 'not-found') {
      // Файла ещё нет — это не ошибка, а легитимно пустой реестр.
      registry = { version: 1, accounts: [] };
      sha = null;
    } else {
      const cached = getAccountsCache();
      if (cached) {
        // Офлайн-путь: вход по кэшу реестра молча, без текста ошибки —
        // это ожидаемый сценарий, а не деградация (T31 verify-чекпоинт).
        registry = parseRegistry(cached.data);
        sha = null;
      } else {
        state.busy = false;
        state.formError = errorText(error);
        updateSubmit();
        renderFormMessages();
        return;
      }
    }
  }

  const account = findAccount(registry, loginResult.label);

  if (!account) {
    state.busy = false;
    state.registry = registry;
    state.registrySha = sha;
    state.mode = 'confirm-create';
    state.pendingAccount = { id: loginResult.id, label: loginResult.label };
    // Пароль уже прошёл валидацию — сохраняем нормализованное значение
    // для хеширования на явном подтверждении, повторно вводить не просим.
    state.password = passwordResult.value;
    state.createError = null;
    updateSubmit();
    renderFormMessages();
    renderCreateSection();
    return;
  }

  const ok = await verifyPassword(passwordResult.value, account);
  if (outdated(token)) return;

  if (!ok) {
    // Приватность здесь формальная (accounts-plan-T28-T35.md) — «неверный
    // пароль» не маскируется под общее «неверный логин или пароль».
    state.busy = false;
    state.formError = 'Неверный пароль.';
    state.password = '';
    if (state.nodes.passwordInput) state.nodes.passwordInput.value = '';
    updateSubmit();
    renderFormMessages();
    return;
  }

  // Best-effort гидратация модели тела: провал чтения не должен блокировать
  // вход, профиль просто останется тем, что уже был закэширован локально.
  try {
    const profileFile = await readFileOrNull(accountProfilePath(account.id));
    if (!outdated(token) && profileFile) {
      const parsed = JSON.parse(profileFile.content);
      if (parsed && (parsed.sex === 'male' || parsed.sex === 'female')) {
        setAccountProfile(account.id, { sex: parsed.sex });
      }
    }
  } catch {
    // Молча: гидратация профиля — необязательный шаг.
  }
  if (outdated(token)) return;

  setActiveAccount(account.id);
  setLastLogin(account.label);
  setAccountsCache(registry);

  toast(`Добро пожаловать, ${account.label}`, 'ok');
  navigate('#/');
}

// ===== Регистрация ==========================================================

async function createAccount() {
  if (state === null || state.creating || state.busy || state.pendingAccount === null) return;
  const token = state.token;
  const { id, label } = state.pendingAccount;
  const sex = state.sex === 'female' ? 'female' : 'male';
  const password = state.password;

  state.creating = true;
  state.createError = null;
  renderCreateSection();

  let hashed;
  try {
    hashed = await hashPassword(password);
  } catch (error) {
    if (outdated(token)) return;
    state.creating = false;
    state.createError = errorText(error);
    renderCreateSection();
    return;
  }
  if (outdated(token)) return;

  const record = { id, label, salt: hashed.salt, hash: hashed.hash, createdAt: todayISO() };

  let registry = state.registry;
  let sha = state.registrySha;
  let newRegistry = upsertAccount(registry, record);
  let lastError = null;
  let written = false;

  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
    try {
      await writeFile(REGISTRY_PATH, `${JSON.stringify(newRegistry, null, 2)}\n`, {
        message: `Регистрация профиля ${label}`,
        sha
      });
      written = true;
      break;
    } catch (error) {
      if (outdated(token)) return;
      lastError = error;
      const conflict = error instanceof GitHubError && error.kind === 'conflict';
      if (!conflict || attempt === MAX_WRITE_ATTEMPTS) break;

      // Кто-то мог зарегистрироваться между нашим чтением и записью —
      // перечитываем и повторяем на свежей копии (§17 контракта).
      let fresh;
      try {
        fresh = await readFile(REGISTRY_PATH);
      } catch (rereadError) {
        if (outdated(token)) return;
        lastError = rereadError;
        break;
      }
      if (outdated(token)) return;

      const freshRegistry = parseRegistry(JSON.parse(fresh.content));
      const raced = findAccount(freshRegistry, id);
      if (raced) {
        // Желаемый логин заняли за это время — это уже не гонка записи,
        // а обычный «логин занят», тот же путь, что у известного логина.
        state.creating = false;
        state.mode = 'login';
        state.pendingAccount = null;
        state.formError = `Логин «${label}» уже занят. Войдите с паролем или выберите другой логин.`;
        updateSubmit();
        renderFormMessages();
        renderCreateSection();
        return;
      }

      registry = freshRegistry;
      sha = fresh.sha;
      newRegistry = upsertAccount(registry, record);
    }
  }

  if (!written) {
    state.creating = false;
    state.registry = registry;
    state.registrySha = sha;
    state.createError = errorText(lastError);
    renderCreateSection();
    return;
  }

  state.registry = newRegistry;

  // Профиль тела — второй, отдельный writeFile. Реестр уже записан: провал
  // здесь не откатывается (нет транзакций поверх Contents API) — известный,
  // документированный зазор, а не пропуск (§17 контракта, план T31).
  try {
    await writeFile(accountProfilePath(id), `${JSON.stringify({ sex }, null, 2)}\n`, {});
  } catch (error) {
    if (outdated(token)) return;
    state.creating = false;
    state.createError = errorText(error);
    renderCreateSection();
    return;
  }
  if (outdated(token)) return;

  setAccountProfile(id, { sex });
  setActiveAccount(id);
  setLastLogin(label);
  setAccountsCache(newRegistry);

  toast(`Добро пожаловать, ${label}`, 'ok');
  navigate('#/');
}

// ===== Контракт экрана =======================================================

export async function render(root, params) {
  const token = ++mountToken;
  state = {
    token,
    root,
    login: getLastLogin() ?? '',
    password: '',
    sex: getProfile().sex === 'female' ? 'female' : 'male',
    busy: false,
    creating: false,
    mode: 'login',
    pendingAccount: null,
    registry: null,
    registrySha: null,
    formError: null,
    createError: null,
    nodes: {}
  };
  paint();
}

export function destroy() {
  mountToken += 1;
  state = null;
}
