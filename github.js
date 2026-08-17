// Доступ к GitHub Contents API (§4 контракта, T2).
// Единственный сетевой модуль приложения. Хост только api.github.com.
//
// Правила, которые здесь нельзя нарушать:
//  - токен берётся исключительно из store.js, никогда не логируется
//    и никогда не попадает в URL — только в заголовок Authorization;
//  - каждый GET снабжён 'Cache-Control: no-cache' и параметром _cb,
//    иначе CDN GitHub отдаёт значение до пяти минут давности (§4 спеки);
//  - наружу летит только GitHubError с конкретным kind, голого Error нет
//    ни в одной ветке — экраны показывают текст ошибки как есть.

import { getRepoConfig, getStoredToken, isFineGrainedToken } from './store.js';

const API_ROOT = 'https://api.github.com';
const API_VERSION = '2022-11-28';

// Тексты — дословно из таблицы §4 контракта.
const MESSAGES = {
  'no-token': 'Токен не задан. Открой Настройки и вставь PAT.',
  unauthorized: 'Токен недействителен или отозван. Нужен новый PAT.',
  forbidden: 'У токена нет прав на этот репозиторий.',
  'rate-limit': 'Лимит запросов GitHub исчерпан, попробуй позже.',
  'not-found': 'Файл или репозиторий не найден.',
  conflict: 'Файл изменился на сервере. Обнови данные и повтори.',
  offline: 'Нет сети.'
};

export class GitHubError extends Error {
  constructor(kind, message, status) {
    super(message);
    this.name = 'GitHubError';
    this.kind = kind;
    this.status = status ?? null;
  }
}

// --- Тексты ошибок --------------------------------------------------------

function unknownMessage(status) {
  if (Number.isFinite(status)) return `Неожиданный ответ GitHub: ${status}.`;
  // Ветка без HTTP-ответа: подставлять «null» в шаблон бессмысленно.
  return 'Неожиданный ответ GitHub: запрос не выполнен.';
}

function fail(kind, status) {
  const message = kind === 'unknown' ? unknownMessage(status) : MESSAGES[kind];
  return new GitHubError(kind, message ?? unknownMessage(status), status ?? null);
}

// Ошибка использования модуля (пустой путь, не строка). Наружу всё равно
// уходит GitHubError — вызывающий код не должен ловить два типа исключений.
function misuse(text) {
  return new GitHubError('unknown', text, null);
}

// --- Base64 (кириллица и эмодзи) -----------------------------------------
// Связка btoa + unescape + encodeURIComponent — устаревший хак поверх
// выпиленной из стандарта функции. Работаем через TextEncoder/TextDecoder.
// Экспортируются для автотестов round-trip, приложением не используются.

const CHUNK = 0x8000; // порция для fromCharCode, чтобы не переполнить стек

export function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(String(text));
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToUtf8(base64) {
  // GitHub отдаёт base64 с переводами строк каждые 60 символов.
  const clean = String(base64).replace(/\s+/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i) & 0xff;
  return new TextDecoder('utf-8').decode(bytes);
}

// --- Построение запроса ---------------------------------------------------

function encodePath(path) {
  return String(path)
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
}

function contentsUrl(path) {
  const { owner, repo, branch } = getRepoConfig();
  const encoded = encodePath(path);
  const base = `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents`;
  const url = new URL(encoded ? `${base}/${encoded}` : base);
  url.searchParams.set('ref', branch);
  return url;
}

function requireToken() {
  const token = getStoredToken();
  if (!isFineGrainedToken(token)) throw fail('no-token', null);
  return token;
}

function headers(token, extra) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    ...extra
  };
}

// Единственная точка вызова fetch. TypeError от fetch — это офлайн.
async function send(url, init) {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (err instanceof TypeError) throw fail('offline', null);
    throw fail('unknown', null);
  }
}

async function getJson(path) {
  const token = requireToken();
  const url = contentsUrl(path);
  url.searchParams.set('_cb', String(Date.now()));
  const response = await send(url.toString(), {
    method: 'GET',
    cache: 'no-store',
    headers: headers(token, { 'Cache-Control': 'no-cache' })
  });
  if (!response.ok) throw await errorFor(response);
  return parseJson(response);
}

async function parseJson(response) {
  let text = '';
  try {
    text = await response.text();
  } catch {
    throw fail('unknown', response.status);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw fail('unknown', response.status);
  }
}

// --- Классификация ответов ------------------------------------------------

async function bodyText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function headerValue(response, name) {
  try {
    const value = response.headers?.get(name);
    return typeof value === 'string' ? value.trim() : null;
  } catch {
    return null;
  }
}

// 403/429 — это лимит только при явном x-ratelimit-remaining: 0.
// Иначе это отсутствие прав у токена, и совет «попробуй позже» вреден.
function isRateLimited(response) {
  return headerValue(response, 'x-ratelimit-remaining') === '0';
}

// 422 GitHub отдаёт и на «sha не передан для существующего файла» (это
// конфликт по §4), и на любое другое невалидное тело запроса.
function mentionsSha(text) {
  if (!text) return false;
  let probe = text;
  try {
    const parsed = JSON.parse(text);
    const parts = [];
    if (typeof parsed?.message === 'string') parts.push(parsed.message);
    if (Array.isArray(parsed?.errors)) parts.push(JSON.stringify(parsed.errors));
    if (parts.length > 0) probe = parts.join(' ');
  } catch {
    // Не JSON — ищем прямо в тексте.
  }
  return /\bsha\b/i.test(probe);
}

async function errorFor(response) {
  const status = response.status;
  if (status === 401) return fail('unauthorized', status);
  if (status === 403 || status === 429) {
    return fail(isRateLimited(response) ? 'rate-limit' : 'forbidden', status);
  }
  if (status === 404) return fail('not-found', status);
  if (status === 409) return fail('conflict', status);
  if (status === 422) {
    return fail(mentionsSha(await bodyText(response)) ? 'conflict' : 'unknown', status);
  }
  return fail('unknown', status);
}

// --- Публичное API --------------------------------------------------------

export async function readFile(path) {
  if (typeof path !== 'string' || encodePath(path) === '') {
    throw misuse('Внутренняя ошибка: путь к файлу не задан.');
  }
  const payload = await getJson(path);
  if (Array.isArray(payload)) {
    // По этому пути лежит директория, а не файл.
    throw fail('not-found', 200);
  }
  if (payload?.type !== 'file' || payload.encoding !== 'base64' || typeof payload.content !== 'string') {
    // Файл больше 1 МБ отдаётся с encoding: 'none' — для сессий недостижимо.
    throw fail('unknown', 200);
  }
  let content;
  try {
    content = base64ToUtf8(payload.content);
  } catch {
    throw fail('unknown', 200);
  }
  return { content, sha: payload.sha };
}

export async function readFileOrNull(path) {
  try {
    return await readFile(path);
  } catch (err) {
    if (err instanceof GitHubError && err.kind === 'not-found') return null;
    throw err;
  }
}

export async function writeFile(path, content, options = {}) {
  if (typeof path !== 'string' || encodePath(path) === '') {
    throw misuse('Внутренняя ошибка: путь к файлу не задан.');
  }
  if (typeof content !== 'string') {
    throw misuse('Внутренняя ошибка: содержимое файла должно быть строкой.');
  }
  const { message, sha } = options ?? {};
  const token = requireToken();
  const { branch } = getRepoConfig();
  const body = {
    message: typeof message === 'string' && message.trim() !== ''
      ? message
      : `${sha ? 'Обновление' : 'Добавление'} ${path}`,
    content: utf8ToBase64(content),
    branch
  };
  // sha уходит в тело только если он есть: для нового файла GitHub его не ждёт.
  if (typeof sha === 'string' && sha !== '') body.sha = sha;

  const url = contentsUrl(path);
  url.searchParams.delete('ref'); // ветка для PUT задаётся в теле
  const response = await send(url.toString(), {
    method: 'PUT',
    headers: headers(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body)
  });
  if (!response.ok) throw await errorFor(response);
  const payload = await parseJson(response);
  return {
    sha: payload?.content?.sha ?? null,
    path: payload?.content?.path ?? path,
    commit: { sha: payload?.commit?.sha ?? null }
  };
}

export async function listFiles(dir) {
  let payload;
  try {
    payload = await getJson(typeof dir === 'string' ? dir : '');
  } catch (err) {
    // Нет директории — нет файлов. Это не ошибка: /data/ может ещё не быть.
    if (err instanceof GitHubError && err.kind === 'not-found') return [];
    throw err;
  }
  // По пути оказался файл, а не директория — списка в нём нет.
  if (!Array.isArray(payload)) return [];
  return payload
    .filter((item) => item && item.type === 'file')
    .map((item) => ({
      name: item.name,
      path: item.path,
      sha: item.sha,
      size: item.size
    }));
}
