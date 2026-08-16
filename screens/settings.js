// Настройки (§7.4 спеки). В T6 сделан только раздел офлайн-очереди:
// состояние заданий и кнопка «отправить сейчас». Ввод и очистка PAT,
// счётчик открытий шпаргалки и экспорт JSON — T8.
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

import { toast } from '../app.js';
import { flush, isPersistent, listJobs, onQueueChange, removeJob } from '../queue.js';

export const title = 'Настройки';

const FLUSH_TEXT = 'Отправить сейчас';
const FLUSHING_TEXT = 'Отправляю…';

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

// ===== Карточка очереди ===================================================

function buildJob(job) {
  const item = el('li', 'queue-job');
  item.dataset.job = String(job.id);

  item.append(el('p', 'queue-job__path', job.path));
  item.append(el('p', 'queue-job__when', `Поставлено ${formatWhen(job.createdAt)}`));

  const status = el('p', `queue-job__state queue-job__state--${job.status}`, stateLabel(job.status));
  item.append(status);

  // Текст ошибки — как есть: он уже русский и конкретный (§4 контракта).
  if (typeof job.lastError === 'string' && job.lastError.trim() !== '') {
    item.append(el('p', 'warn', job.lastError));
  }

  const actions = el('div', 'queue-actions');
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
  const nodes = [el('h2', null, 'Очередь отправки')];

  nodes.push(el('p', 'field__hint', 'Сессия сначала попадает сюда и только потом уходит в репозиторий с данными. Пока задание в очереди, замеры не потеряны.'));

  if (!isPersistent()) {
    nodes.push(el('p', 'warn', 'Браузер не даёт сохранить очередь на диск: незакрытая вкладка — единственное, что её держит.'));
  }

  if (state.jobs.length === 0) {
    nodes.push(el('p', 'queue-empty', 'Очередь пуста — всё отправлено.'));
  } else {
    const list = el('ul', 'queue-list');
    for (const job of state.jobs) list.append(buildJob(job));
    nodes.push(list);
  }

  const actions = el('div', 'queue-actions');
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
    confirmId: null,
    unsubscribe: null,
    nodes: {}
  };

  const queue = el('section', 'card settings-queue');
  state.nodes.queue = queue;

  const rest = el('section', 'card');
  rest.append(el('h2', null, 'Остальное'));
  rest.append(el('p', 'field__hint', 'Токен, счётчик открытий шпаргалки и выгрузка всех замеров одним файлом появятся в задаче T8.'));

  root.replaceChildren(queue, rest);
  paintQueue();

  // Очередь меняется и без участия экрана: досылка по событию online.
  state.unsubscribe = onQueueChange(() => {
    void reload();
  });
  await reload();
}

export function destroy() {
  if (state && typeof state.unsubscribe === 'function') state.unsubscribe();
  mountToken += 1;
  state = null;
}
