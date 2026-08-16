// Единственный модуль проекта, который знает про localStorage (§3 контракта).
// Любое чтение и запись обёрнуты в try/catch: приватный режим и отключённое
// хранилище не должны ронять приложение. Токен нигде не логируется.

export const KEYS = {
  token: 'bm.token',
  repo: 'bm.repo', // { owner, repo, branch }
  index: 'bm.index_cache', // { data, fetchedAt } fetchedAt — ISO-строка
  catalog: 'bm.catalog_cache', // { data, fetchedAt } то же, для catalog.json
  opens: 'bm.cheatsheet_opens' // { count, lastAt }
};

const DEFAULT_REPO = Object.freeze({
  owner: 'prozorovAlexey',
  repo: 'measurements-data',
  branch: 'main'
});

const DEFAULT_OPENS = Object.freeze({ count: 0, lastAt: null });

function readRaw(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    // Переполнение квоты или запрет хранилища — молча живём дальше.
    return false;
  }
}

function removeRaw(key) {
  try {
    localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function readJSON(key) {
  const raw = readRaw(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // Битое значение равнозначно отсутствию.
    return null;
  }
}

function writeJSON(key, value) {
  try {
    return writeRaw(key, JSON.stringify(value));
  } catch {
    return false;
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// --- Токен ---------------------------------------------------------------

export function getToken() {
  const raw = readRaw(KEYS.token);
  if (!nonEmptyString(raw)) return null;
  return raw.trim();
}

export function setToken(token) {
  if (!nonEmptyString(token)) {
    clearToken();
    return false;
  }
  return writeRaw(KEYS.token, token.trim());
}

export function clearToken() {
  return removeRaw(KEYS.token);
}

// --- Конфиг репозитория с данными ---------------------------------------

export function getRepoConfig() {
  const stored = readJSON(KEYS.repo);
  if (!isPlainObject(stored)) return { ...DEFAULT_REPO };
  return {
    owner: nonEmptyString(stored.owner) ? stored.owner.trim() : DEFAULT_REPO.owner,
    repo: nonEmptyString(stored.repo) ? stored.repo.trim() : DEFAULT_REPO.repo,
    branch: nonEmptyString(stored.branch) ? stored.branch.trim() : DEFAULT_REPO.branch
  };
}

export function setRepoConfig(cfg) {
  const base = getRepoConfig();
  const next = isPlainObject(cfg) ? cfg : {};
  const merged = {
    owner: nonEmptyString(next.owner) ? next.owner.trim() : base.owner,
    repo: nonEmptyString(next.repo) ? next.repo.trim() : base.repo,
    branch: nonEmptyString(next.branch) ? next.branch.trim() : base.branch
  };
  writeJSON(KEYS.repo, merged);
  return merged;
}

// --- Кэш index.json ------------------------------------------------------

export function getIndexCache() {
  const stored = readJSON(KEYS.index);
  if (!isPlainObject(stored)) return null;
  if (!('data' in stored) || stored.data === undefined) return null;
  if (!nonEmptyString(stored.fetchedAt)) return null;
  return { data: stored.data, fetchedAt: stored.fetchedAt };
}

export function setIndexCache(data) {
  const entry = { data, fetchedAt: new Date().toISOString() };
  const ok = writeJSON(KEYS.index, entry);
  return ok ? entry : null;
}

// --- Кэш catalog.json ----------------------------------------------------
// Каталог лежит рядом с приложением и с T7 кэшируется service worker'ом.
// Эта копия — второй слой: она работает там, где SW не поднялся (приватное
// окно, http:// без TLS, отказ регистрации).

export function getCatalogCache() {
  const stored = readJSON(KEYS.catalog);
  if (!isPlainObject(stored)) return null;
  if (!('data' in stored) || stored.data === undefined) return null;
  if (!nonEmptyString(stored.fetchedAt)) return null;
  return { data: stored.data, fetchedAt: stored.fetchedAt };
}

export function setCatalogCache(data) {
  const entry = { data, fetchedAt: new Date().toISOString() };
  const ok = writeJSON(KEYS.catalog, entry);
  return ok ? entry : null;
}

// --- Счётчик открытий шпаргалки (гейт из §2 спеки) -----------------------

export function getCheatsheetOpens() {
  const stored = readJSON(KEYS.opens);
  if (!isPlainObject(stored)) return { ...DEFAULT_OPENS };
  const count = Number.isFinite(stored.count) && stored.count > 0 ? Math.floor(stored.count) : 0;
  return {
    count,
    lastAt: nonEmptyString(stored.lastAt) ? stored.lastAt : null
  };
}

export function bumpCheatsheetOpens() {
  const current = getCheatsheetOpens();
  const next = { count: current.count + 1, lastAt: new Date().toISOString() };
  writeJSON(KEYS.opens, next);
  return next;
}
