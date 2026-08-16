// Bootstrap + hash-роутер + монтирование экранов (§2 контракта).
// Экраны грузятся динамическим import() — каркас не тянет их код заранее.

import { bumpCheatsheetOpens } from './store.js';
import { flush, listJobs } from './queue.js';

const SCREENS = {
  cheatsheet: () => import('./screens/cheatsheet.js'),
  entry: () => import('./screens/entry.js'),
  history: () => import('./screens/history.js'),
  settings: () => import('./screens/settings.js')
};

const TOAST_MS = 3200;
const TONES = ['ok', 'stale', 'error'];

const appEl = document.getElementById('app');
const titleEl = document.getElementById('screen-title');
const statusEl = document.getElementById('header-status');
const toastHost = document.getElementById('toast-host');
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
function resolveRoute(hash) {
  const parts = normalizeHash(hash).slice(1).split('/').filter(Boolean).map(decodeSegment);
  if (parts.length === 0) return { name: 'cheatsheet', params: {} };
  if (parts.length === 1 && parts[0] === 'entry') return { name: 'entry', params: {} };
  if (parts.length === 1 && parts[0] === 'settings') return { name: 'settings', params: {} };
  if (parts.length === 2 && parts[0] === 'history') return { name: 'history', params: { key: parts[1] } };
  return null;
}

// --- Шапка, вкладки, уведомления ----------------------------------------

function markActiveTab(name) {
  for (const tab of tabs) {
    const active = tab.dataset.tab === name;
    tab.classList.toggle('tabbar__item--active', active);
    if (active) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
}

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
  currentModule = mod;

  try {
    await mod.render(appEl, route.params);
  } catch (error) {
    if (token !== mountToken) return;
    showFailure('Экран не отрисовался', describeError(error));
    return;
  }
  if (token !== mountToken) return;

  // Счётчик открытий шпаргалки — ровно один раз за загрузку страницы.
  if (!firstScreenHandled) {
    firstScreenHandled = true;
    if (route.name === 'cheatsheet') bumpCheatsheetOpens();
  }
}

function router() {
  const route = resolveRoute(location.hash);
  if (!route) {
    // Неизвестный хэш — дефолтный экран шпаргалки.
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
