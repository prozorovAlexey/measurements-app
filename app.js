// Bootstrap + hash-роутер + монтирование экранов (§2 контракта).
// Экраны грузятся динамическим import() — каркас не тянет их код заранее.

import { bumpOpens, getActiveAccount, getThemeOverride, setThemeOverride } from './store.js';
import { flush, listJobs } from './queue.js';

const SCREENS = {
  figure: () => import('./screens/figure.js'),
  compare: () => import('./screens/compare.js'),
  sizes: () => import('./screens/sizes.js'),
  entry: () => import('./screens/entry.js'),
  history: () => import('./screens/history.js'),
  settings: () => import('./screens/settings.js'),
  login: () => import('./screens/login.js')
};

// T16: «Сравнение» — вторая под-вкладка «Фигуры» (§2 контракта), своей
// иконки в таббаре у неё нет — подсвечивается тот же tab, что и «Фигура».
const TAB_ALIASES = { compare: 'figure' };

const TOAST_MS = 3200;
const TONES = ['ok', 'stale', 'error'];

const appEl = document.getElementById('app');
const shellEl = document.getElementById('app-shell');
const titleEl = document.getElementById('screen-title');
const subtitleEl = document.getElementById('screen-subtitle');
const statusEl = document.getElementById('header-status');
const toastHost = document.getElementById('toast-host');
const themeToggleEl = document.getElementById('theme-toggle');
const tabs = Array.from(document.querySelectorAll('.tabbar__item'));

let currentModule = null;
let mountToken = 0;
let firstScreenHandled = false;

// --- Разбор хэша ---------------------------------------------------------

function normalizeHash(hash) {
  const body = String(hash ?? '').trim().replace(/^#/, '');
  if (body === '' || body === '/') return '#/';
  return body.startsWith('/') ? `#${body}` : `#/${body}`;
}

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// null — маршрут неизвестен.
// T15: дефолт «#/» — «Фигура» (§2 контракта), шпаргалка удалена вместе
// с отдельным «#/figure».
function resolveRoute(hash) {
  const parts = normalizeHash(hash).slice(1).split('/').filter(Boolean).map(decodeSegment);
  if (parts.length === 0) return { name: 'figure', params: {} };
  if (parts.length === 1 && parts[0] === 'compare') return { name: 'compare', params: {} };
  if (parts.length === 1 && parts[0] === 'sizes') return { name: 'sizes', params: {} };
  if (parts.length === 1 && parts[0] === 'entry') return { name: 'entry', params: {} };
  if (parts.length === 1 && parts[0] === 'settings') return { name: 'settings', params: {} };
  if (parts.length === 1 && parts[0] === 'login') return { name: 'login', params: {} };
  if (parts.length === 2 && parts[0] === 'history') return { name: 'history', params: { key: parts[1] } };
  return null;
}

// --- Шапка, вкладки, уведомления ----------------------------------------

function markActiveTab(name) {
  const tabName = TAB_ALIASES[name] ?? name;
  for (const tab of tabs) {
    const active = tab.dataset.tab === tabName;
    tab.classList.toggle('tabbar__item--active', active);
    if (active) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
}

// Двухколоночная раскладка шаблона нужна и «Сравнению» (§10 контракта):
// таблица «было/стало/Δ» тоже выигрывает от лишней ширины на десктопе.
function markLayout(name) {
  if (!shellEl) return;
  shellEl.classList.toggle('app-shell--figure', name === 'figure' || name === 'compare');
}

const SCREEN_SUBTITLES = {
  figure: 'Текущие значения',
  compare: 'Сопоставление срезов',
  sizes: 'Расчёты по вашим замерам',
  entry: 'Новая полная сессия',
  history: 'Динамика показателя',
  settings: 'Синхронизация и параметры',
  login: 'Вход'
};

export function setHeaderSubtitle(text) {
  if (!subtitleEl) return;
  const value = typeof text === 'string' ? text.trim() : '';
  subtitleEl.textContent = value;
  subtitleEl.hidden = value === '';
}

// --- Тема (T17) ------------------------------------------------------------
// index.html ставит [data-theme] инлайновым скриптом до первой отрисовки
// (тайминг — комментарий там же); здесь тот же атрибут применяется на
// последующих переключениях и синхронизируется визуальный статус свитча.

const darkMedia = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

function effectiveTheme() {
  const override = getThemeOverride();
  if (override) return override;
  return darkMedia && darkMedia.matches ? 'dark' : 'light';
}

function paintThemeToggle() {
  if (!themeToggleEl) return;
  const dark = effectiveTheme() === 'dark';
  themeToggleEl.setAttribute('aria-checked', String(dark));
}

function applyTheme() {
  const override = getThemeOverride();
  // document.documentElement отсутствует в мини-DOM самопроверок экранов
  // (они стабят только getElementById/querySelectorAll, см. compare.selftest.mjs) —
  // приложению в браузере он всегда есть, поэтому проверка только для тестов.
  if (document.documentElement) {
    if (override) document.documentElement.dataset.theme = override;
    else delete document.documentElement.dataset.theme;
  }
  paintThemeToggle();
}

if (themeToggleEl) {
  themeToggleEl.addEventListener('click', () => {
    setThemeOverride(effectiveTheme() === 'dark' ? 'light' : 'dark');
    applyTheme();
  });
}

// Без ручного override переключатель обязан следовать системной теме и в
// реальном времени — иначе после «сна» вкладки его состояние разойдётся
// с уже применённой через медиа-запрос палитрой.
if (darkMedia) {
  const onSystemChange = () => { if (!getThemeOverride()) paintThemeToggle(); };
  if (typeof darkMedia.addEventListener === 'function') darkMedia.addEventListener('change', onSystemChange);
  else if (typeof darkMedia.addListener === 'function') darkMedia.addListener(onSystemChange);
}

applyTheme();

export function setHeaderStatus(text, tone) {
  if (!statusEl) return;
  const value = typeof text === 'string' ? text.trim() : '';
  statusEl.className = 'status';
  if (!value) {
    statusEl.textContent = '';
    statusEl.hidden = true;
    return;
  }
  if (TONES.includes(tone)) statusEl.classList.add(`status--${tone}`);
  statusEl.textContent = value;
  statusEl.hidden = false;
}

export function toast(message, tone) {
  const value = typeof message === 'string' ? message.trim() : '';
  if (!value || !toastHost) return;
  const el = document.createElement('div');
  el.className = 'toast';
  if (TONES.includes(tone)) el.classList.add(`toast--${tone}`);
  el.textContent = value;
  toastHost.append(el);
  setTimeout(() => el.remove(), TOAST_MS);
}

// --- Сообщение об ошибке вместо белого экрана (чек-лист §10 спеки) -------

function describeError(error) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error.trim();
  return 'Подробностей нет.';
}

function showFailure(heading, detail) {
  if (!appEl) return;
  const card = document.createElement('section');
  card.className = 'card';

  const h = document.createElement('h2');
  h.textContent = heading;

  const reason = document.createElement('p');
  reason.className = 'warn';
  reason.textContent = detail;

  const hint = document.createElement('p');
  hint.className = 'field__hint';
  hint.textContent = 'Попробуй обновить страницу.';

  card.append(h, reason, hint);

  // Если на экране уже что-то есть (например, заполненная форма) — не стираем его.
  if (appEl.childElementCount === 0) appEl.replaceChildren(card);
  else appEl.prepend(card);

  setHeaderStatus('Ошибка', 'error');
}

// --- Монтирование экрана -------------------------------------------------

async function mount(route) {
  const token = ++mountToken;

  if (currentModule && typeof currentModule.destroy === 'function') {
    try {
      currentModule.destroy();
    } catch {
      // Падение destroy не должно блокировать переход.
    }
  }
  currentModule = null;
  appEl.replaceChildren();
  setHeaderStatus(null);
  markActiveTab(route.name);
  markLayout(route.name);

  let mod;
  try {
    mod = await SCREENS[route.name]();
  } catch (error) {
    if (token !== mountToken) return;
    showFailure('Экран не загрузился', describeError(error));
    return;
  }
  // Пока грузился модуль, мог случиться новый переход.
  if (token !== mountToken) return;

  if (titleEl) titleEl.textContent = typeof mod.title === 'string' && mod.title ? mod.title : 'Замеры';
  setHeaderSubtitle(SCREEN_SUBTITLES[route.name] ?? 'Личный трекер замеров');
  currentModule = mod;

  try {
    await mod.render(appEl, route.params);
  } catch (error) {
    if (token !== mountToken) return;
    showFailure('Экран не отрисовался', describeError(error));
    return;
  }
  if (token !== mountToken) return;

  // opens.app (T15, §2 спеки) — ровно один раз за загрузку страницы,
  // независимо от того, какой экран открылся первым.
  if (!firstScreenHandled) {
    firstScreenHandled = true;
    bumpOpens('app');
  }
}

function router() {
  const route = resolveRoute(location.hash);
  if (!route) {
    // Неизвестный хэш — дефолтный экран шпаргалки.
    navigate('#/');
    return;
  }
  // Гейт входа (T31, §17 контракта): без активного профиля доступен только
  // сам экран входа; с активным профилем экран входа недоступен — например,
  // кнопка «Назад» браузера или старая закладка не должны вернуть уже
  // вошедшего человека на форму логина.
  const account = getActiveAccount();
  if (!account && route.name !== 'login') {
    navigate('#/login');
    return;
  }
  if (account && route.name === 'login') {
    navigate('#/');
    return;
  }
  mount(route).catch((error) => showFailure('Экран не открылся', describeError(error)));
}

export function navigate(hash) {
  const next = normalizeHash(hash);
  if (location.hash === next) {
    router(); // тот же хэш — hashchange не сработает, перерисовываем сами
    return;
  }
  location.hash = next;
}

// --- Глобальные ошибки ---------------------------------------------------

window.onerror = function onGlobalError(message, source, lineno, colno, error) {
  const detail = error ? describeError(error) : describeError(message);
  showFailure('Что-то пошло не так', detail);
  return false; // не глушим вывод в консоль
};

window.addEventListener('unhandledrejection', (event) => {
  showFailure('Что-то пошло не так', describeError(event.reason));
});

// --- Офлайн-очередь (T6) --------------------------------------------------

// Досылка при старте и при появлении сети (§9 спеки, T6). Пустая очередь
// сеть не трогает: холодный старт и так занят загрузкой шпаргалки.
// Про неудачу молчим — она видна в настройках, а всплывающее уведомление
// на каждом мигании связи только мешало бы.
async function flushQueue() {
  let jobs;
  try {
    jobs = await listJobs();
  } catch {
    return; // хранилище очереди недоступно — приложению это не мешает
  }
  if (jobs.length === 0) return;
  const { sent } = await flush();
  if (sent > 0) toast(`Из очереди отправлено: ${sent}`, 'ok');
}

window.addEventListener('online', () => {
  void flushQueue();
});

// --- Service worker (T7) --------------------------------------------------

// Про готовое обновление говорим словами: skipWaiting() в sw.js нет
// намеренно, новая версия включается при следующем полном запуске.
function watchUpdates(registration) {
  registration.addEventListener('updatefound', () => {
    const worker = registration.installing;
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      // controller уже есть — значит это обновление, а не первая установка,
      // про которую пользователю знать незачем.
      if (worker.state === 'installed' && navigator.serviceWorker.controller) {
        toast('Обновление загружено, включится при следующем запуске', 'stale');
      }
    });
  });
}

function registerServiceWorker() {
  // updateViaCache: 'none' — сам sw.js всегда проверяется в сети. Иначе
  // HTTP-кэш браузера законсервировал бы версию кэша вместе со скриптом.
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
    .then(watchUpdates)
    .catch(() => {
      // Регистрация не прошла — приложение просто работает без офлайна.
      // Молча: на http:// без TLS и в приватном окне это норма, а не поломка.
    });
}

// Регистрируем после load: установка тянет всю оболочку и конкурировала бы
// за сеть с первой отрисовкой шпаргалки (§8 спеки).
if ('serviceWorker' in navigator) {
  if (document.readyState === 'complete') registerServiceWorker();
  else window.addEventListener('load', registerServiceWorker, { once: true });
}

// --- Старт ---------------------------------------------------------------

window.addEventListener('hashchange', router);
router();
void flushQueue();
