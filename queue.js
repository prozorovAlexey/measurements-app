// Офлайн-очередь записей в repo B (T6, §7.2 и §7.4 спеки, контракт §7).
//
// Через очередь проходит КАЖДАЯ запись сессии, а не только та, что не ушла
// с первого раза. Причина: пока сессия существует только в полях формы,
// её теряет любой сбой — закрытая вкладка, убитая система процессом, разряд
// батареи посреди PUT. Сначала запись ложится в IndexedDB, и лишь потом
// уходит в сеть; пользователь видит «сохранено» только после подтверждения
// от GitHub. Побочный выигрыш — вся логика записи (свободное имя, отсутствие
// sha, разбор ошибок) живёт в одном месте, а не дублируется в экране ввода.
//
// Файл сессии иммутабелен (§6.1, чек-лист §10): writeFile здесь зовётся
// ровно один раз и никогда с sha, то есть физически способен только создать
// новый файл. Появится sha — появится путь к правке истории.
//
// Повторная отправка не размножает сессии. Перед записью считается git-sha
// содержимого (blob-хэш) и сравнивается с sha файлов, которые уже лежат
// в каталоге: листинг их и так отдаёт, лишних запросов нет. Совпадение
// означает, что предыдущая попытка на самом деле доехала, а ответ потерялся
// по дороге, — задание просто снимается с очереди.

import { GitHubError, listFiles, writeFile } from './github.js';
import { sessionFileName } from './session.js';

const DB_NAME = 'bm-queue';
const DB_VERSION = 1;
const STORE = 'jobs';

// 'data/2026-08-14--2.json' -> день сессии, по нему подбирается свободное имя.
const SESSION_NAME = /^(\d{4}-\d{2}-\d{2})(?:--\d+)?\.json$/i;

// ===== Хранилище ==========================================================
// Бэкенд выбирается один раз за загрузку страницы: либо IndexedDB, либо
// память. Переключаться на ходу нельзя — очередь расползлась бы по двум
// хранилищам, и часть заданий стала бы невидимой.

const memory = new Map();
let memoryNextId = 1;

let dbPromise = null;
let persistent = typeof globalThis.indexedDB !== 'undefined';

// false — IndexedDB недоступен (приватный режим, отключённое хранилище).
// Очередь работает, но не переживёт закрытие вкладки, и об этом обязан
// сказать экран: обещать «отправлю позже» и потерять сессию нельзя.
export function isPersistent() {
  return persistent;
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Хранилище очереди отказало.'));
  });
}

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    const idb = globalThis.indexedDB;
    if (!idb) {
      persistent = false;
      resolve(null);
      return;
    }
    let request;
    try {
      request = idb.open(DB_NAME, DB_VERSION);
    } catch {
      persistent = false;
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      persistent = false;
      resolve(null);
    };
  });
  return dbPromise;
}

async function store(mode) {
  const db = await openDb();
  if (!db) return null;
  return db.transaction(STORE, mode).objectStore(STORE);
}

async function readAll() {
  const box = await store('readonly');
  if (!box) return Array.from(memory.values()).map((job) => ({ ...job }));
  const rows = await requestToPromise(box.getAll());
  return Array.isArray(rows) ? rows : [];
}

async function insert(record) {
  const box = await store('readwrite');
  if (!box) {
    const id = memoryNextId;
    memoryNextId += 1;
    memory.set(id, { ...record, id });
    return id;
  }
  // Поля id в записи нет: ключ раздаёт autoIncrement.
  return requestToPromise(box.add(record));
}

async function update(record) {
  const box = await store('readwrite');
  if (!box) {
    if (memory.has(record.id)) memory.set(record.id, { ...record });
    return;
  }
  await requestToPromise(box.put(record));
}

async function drop(id) {
  const box = await store('readwrite');
  if (!box) return memory.delete(id);
  await requestToPromise(box.delete(id));
  return true;
}

// ===== Подписка ===========================================================

const listeners = new Set();

// Возвращает функцию отписки: экран настроек снимает слушателя в destroy().
export function onQueueChange(handler) {
  if (typeof handler !== 'function') return () => {};
  listeners.add(handler);
  return () => listeners.delete(handler);
}

function notify() {
  for (const handler of Array.from(listeners)) {
    try {
      handler();
    } catch {
      // Упавший слушатель не должен рвать отправку очереди.
    }
  }
}

// ===== Публичное API ======================================================

function requireText(value, what) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Внутренняя ошибка очереди: ${what} не задан.`);
  }
  return value;
}

// job: { path, content, message }. id, createdAt и статус проставляются здесь.
export async function enqueue(job) {
  const source = job ?? {};
  if (typeof source.content !== 'string') {
    throw new Error('Внутренняя ошибка очереди: содержимое файла должно быть строкой.');
  }
  const record = {
    path: requireText(source.path, 'путь к файлу'),
    content: source.content,
    message: requireText(source.message, 'текст коммита'),
    createdAt: new Date().toISOString(),
    status: 'pending',
    lastError: null
  };
  const id = await insert(record);
  notify();
  return id;
}

// Порядок — по возрастанию id, то есть по времени постановки: очередь FIFO.
export async function listJobs() {
  const jobs = await readAll();
  return jobs.slice().sort((a, b) => a.id - b.id);
}

export async function removeJob(id) {
  const key = Number(id);
  if (!Number.isFinite(key)) return false;
  const removed = await drop(key);
  notify();
  return removed !== false;
}

// ===== Отправка ===========================================================

// Ошибка, после которой повтор осмыслен сам по себе. Всё остальное
// (нет токена, токен отозван, нет прав, нет репозитория) ждёт действий
// пользователя: задание остаётся в очереди, но помечено как провалившееся.
// conflict сюда входит: имя занял кто-то другой между листингом и записью,
// на следующем прогоне подберётся свободное.
function isRetryable(error) {
  if (!(error instanceof GitHubError)) return true;
  if (error.kind === 'offline' || error.kind === 'rate-limit' || error.kind === 'conflict') return true;
  if (error.kind === 'unknown') return error.status === null || error.status >= 500;
  return false;
}

function errorText(error) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim() !== '') return error.trim();
  return 'Не удалось отправить запись.';
}

// git-хэш содержимого: sha1('blob <длина в байтах>\0' + байты). Ровно это
// значение GitHub отдаёт в поле sha листинга, поэтому сравнение точное.
// Нет crypto.subtle (не защищённый контекст) — проверка молчит, отправка
// идёт как обычно.
export async function blobSha(content) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const encoder = new TextEncoder();
  const body = encoder.encode(String(content));
  const header = encoder.encode(`blob ${body.length}\0`);
  const payload = new Uint8Array(header.length + body.length);
  payload.set(header, 0);
  payload.set(body, header.length);
  try {
    const digest = await subtle.digest('SHA-1', payload);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return null;
  }
}

function splitPath(path) {
  const slash = String(path).lastIndexOf('/');
  if (slash === -1) return { dir: '', name: String(path) };
  return { dir: String(path).slice(0, slash), name: String(path).slice(slash + 1) };
}

// Имя занимают по фактическому содержимому каталога, а не по тому, что было
// известно в момент постановки в очередь: пока сессия ждала сеть, тот же день
// мог записать другой телефон (§6.1, чек-лист §10 про два устройства).
export function resolveName(name, existingNames) {
  const taken = new Set(
    (Array.isArray(existingNames) ? existingNames : [])
      .filter((item) => typeof item === 'string')
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item !== '')
  );
  if (!taken.has(String(name).trim().toLowerCase())) return name;

  const match = SESSION_NAME.exec(String(name).trim());
  // Не файл сессии — переименовывать нечего, пусть решает GitHub.
  if (!match) return name;
  return sessionFileName(match[1], Array.from(taken));
}

async function sendJob(job, listings) {
  const { dir, name } = splitPath(job.path);

  if (!listings.has(dir)) {
    // Листинг каталога — один на прогон: заданий обычно несколько, а каталог
    // у них общий. После успешной записи кэш дополняется вручную ниже.
    try {
      listings.set(dir, { files: await listFiles(dir), error: null });
    } catch (error) {
      listings.set(dir, { files: [], error });
    }
  }
  const listing = listings.get(dir);
  if (listing.error) throw listing.error;

  const sha = await blobSha(job.content);
  if (sha !== null && listing.files.some((file) => file.sha === sha)) {
    // Файл с таким же содержимым уже лежит в репозитории: предыдущая попытка
    // доехала, а ответ потерялся. Второй раз писать нельзя — это дубль сессии.
    return { path: listing.files.find((file) => file.sha === sha).path, duplicate: true };
  }

  const target = resolveName(name, listing.files.map((file) => file.name));
  const path = dir === '' ? target : `${dir}/${target}`;
  // sha не передаётся никогда: очередь умеет только создавать новые файлы.
  const written = await writeFile(path, job.content, { message: job.message });
  listing.files.push({ name: target, path, sha: written.sha, size: job.content.length });
  return { path, duplicate: false };
}

async function runFlush() {
  const result = { sent: 0, failed: 0, errors: [] };
  const jobs = await listJobs();
  if (jobs.length === 0) return result;

  const listings = new Map();

  // Строго последовательно: параллельная отправка двух сессий одного дня
  // разошлась бы по одному и тому же свободному имени и словила 409 сама
  // на себе (контракт §7).
  for (const job of jobs) {
    await update({ ...job, status: 'sending' });
    notify();

    try {
      await sendJob(job, listings);
      await drop(job.id);
      result.sent += 1;
    } catch (error) {
      const message = errorText(error);
      await update({
        ...job,
        status: isRetryable(error) ? 'pending' : 'failed',
        lastError: message
      });
      result.failed += 1;
      if (!result.errors.includes(message)) result.errors.push(message);
    }
    notify();
  }

  return result;
}

let chain = null;

// Вызывается при старте приложения, по событию online и кнопкой в настройках.
// Параллельные вызовы выстраиваются в цепочку, а не сливаются в один: тот,
// кто поставил задание и сразу позвал flush(), обязан дождаться прогона,
// который начался ПОСЛЕ его постановки.
export function flush() {
  const next = chain ? chain.then(runFlush, runFlush) : runFlush();
  chain = next.then(() => {}, () => {});
  return next;
}
