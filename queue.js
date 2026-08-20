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
const DATA_DIR = 'data';

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

// ===== Склейка дня и оверлей (T14, §7.5 спеки) ============================
// «Все значения одного дня — один срез»: восемь значений, внесённых по
// одному, обязаны доехать одним файлом сессии, а не восемью. Склейка идёт
// только по заданиям, ещё НЕ ушедшим в repo B — задание в статусе 'sending'
// не трогаем: его PUT уже может быть в пути, и дописать в отправляемое
// содержимое значило бы потерять запись. Такая запись просто заводит новое
// задание; sessionFileName разведёт файлы по --N при отправке (§6.1).

function pad2(value) {
  return String(value).padStart(2, '0');
}

function currentTimeStamp() {
  const now = new Date();
  return `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
}

// entry: { key, raw, value, unit, protocol_version, note } — одна запись §6.1.
// Существующее неотправленное задание того же дня получает ещё одну запись
// в content.entries (повторный ключ заменяется последним значением — шторку
// открывают дважды, когда ошиблись, и это не два разных замера). Иначе
// заводится новое задание с минимальной сессией быстрого ввода: условия
// шторка не спрашивает никогда (§7.5 спеки), поэтому здесь всегда дефолты.
export async function enqueueEntry({ date, entry, message }) {
  const day = requireText(date, 'дата записи');
  if (!entry || typeof entry !== 'object' || typeof entry.key !== 'string' || entry.key.trim() === '') {
    throw new Error('Внутренняя ошибка очереди: запись замера не задана.');
  }
  const commitMessage = requireText(message, 'текст коммита');
  const record = { ...entry, key: entry.key.trim() };

  let target = null;
  for (const job of await listJobs()) {
    if (job.status === 'sending') continue;
    let parsed;
    try {
      parsed = JSON.parse(job.content);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || parsed.date !== day || !Array.isArray(parsed.entries)) continue;
    // Идём по возрастанию id — последний найденный является самым свежим
    // заданием этого дня, в него и доливаем.
    target = { job, parsed };
  }

  if (target) {
    const entries = target.parsed.entries.filter((item) => item?.key !== record.key);
    entries.push(record);
    await update({ ...target.job, content: JSON.stringify({ ...target.parsed, entries }, null, 2) });
    notify();
    return target.job.id;
  }

  const session = {
    date: day,
    time: currentTimeStamp(),
    protocol_version: record.protocol_version,
    conditions: { fasted: false, post_void: false, hours_since_training: null },
    entries: [record]
  };
  return enqueue({
    path: `${DATA_DIR}/${sessionFileName(day, [])}`,
    content: JSON.stringify(session, null, 2),
    message: commitMessage
  });
}

// -> { '<date>': { '<key>': { value, protocol_version, jobId, status } } }
// Только задания, ещё лежащие в очереди — отправленное снимается с неё,
// а его данные приходят к экрану уже через index.json. Питает оверлей среза
// в asof.js: без него чип сегодняшней даты и значение из шторки не появились
// бы до пересборки index.json Action'ом (30–60 с) и не появились бы вовсе
// в офлайне (§7.5 спеки).
export async function pendingEntries() {
  const byDate = new Map();

  for (const job of await listJobs()) {
    let parsed;
    try {
      parsed = JSON.parse(job.content);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.date !== 'string' || !Array.isArray(parsed.entries)) continue;

    if (!byDate.has(parsed.date)) byDate.set(parsed.date, new Map());
    const byKey = byDate.get(parsed.date);
    for (const item of parsed.entries) {
      if (!item || typeof item.key !== 'string' || !Number.isFinite(item.value)) continue;
      // Порядок — по возрастанию id задания, поэтому при дублирующемся ключе
      // на ту же дату (два задания одного дня — редкий случай, когда первое
      // застряло в 'sending') побеждает более позднее действие пользователя.
      byKey.set(item.key, {
        value: item.value,
        protocol_version: Number.isInteger(item.protocol_version) ? item.protocol_version : null,
        jobId: job.id,
        status: job.status
      });
    }
  }

  const result = new Map();
  for (const [day, byKey] of byDate) result.set(day, Object.fromEntries(byKey));
  return Object.fromEntries(result);
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
