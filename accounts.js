// Логины, пароли и реестр профилей (T28, §17 контракта, план accounts-plan-T28-T35.md).
//
// Чистая логика — ни DOM, ни localStorage, ни fetch, как session.js. Разбор
// accounts.json, валидация полей входа и PBKDF2-хеширование пароля живут
// здесь; чтением/записью файла и localStorage занимается вызывающий код
// (screens/login.js, store.js).
//
// hashPassword/verifyPassword — единственные async-функции модуля: WebCrypto
// (crypto.subtle) асинхронен и в браузере, и в Node ≥ 15 (node:crypto
// webcrypto), поэтому селф-тест гоняет ту же функцию, что и прод, без имитации.

// ===== Логин и пароль ======================================================

// Латиница, цифры, «_» и «-», 2–20 символов. Пробелы (в том числе по краям)
// и любая другая пунктуация уже не попадают в набор — отдельно их проверять
// не нужно, регэксп с якорями ^...$ отсекает их сам.
export const LOGIN_PATTERN = /^[A-Za-z0-9_-]{2,20}$/;
export const MIN_PASSWORD_LENGTH = 4;

// Значение в текст ошибки: пользователь должен увидеть, что именно не так.
function quote(value) {
  const text = typeof value === 'string' ? value : String(value);
  return text.trim() === '' ? 'пустая строка' : `«${text}»`;
}

// -> { ok: true, id, label } | { ok: false, message }
// id — нижний регистр (имя папки в repo B), label — как введено (подпись
// в шапке). Регистр в id меняем только у латиницы, поэтому toLowerCase()
// не искажает написание — недопустимые символы уже отсеяны паттерном.
export function validateLogin(raw) {
  const text = typeof raw === 'string' ? raw : '';
  if (!LOGIN_PATTERN.test(text)) {
    return {
      ok: false,
      message: `Логин задан неверно: ${quote(text)}. Разрешены латинские буквы, цифры, «_» и «-», без пробелов, длиной от 2 до 20 символов.`
    };
  }
  return { ok: true, id: text.toLowerCase(), label: text };
}

// -> { ok: true, value } | { ok: false, message }
// value — пароль, обрезанный по краям (внутренние пробелы — часть пароля).
// Текст пароля в сообщение не попадает: это не то, что стоит эхом
// показывать на экране или сохранять в логе.
export function validatePassword(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, message: `Пароль короче ${MIN_PASSWORD_LENGTH} символов.` };
  }
  return { ok: true, value: text };
}

// ===== Реестр accounts.json =================================================

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// raw — уже распарсенный JSON accounts.json (объект) либо что угодно ещё.
// -> { version, accounts: [{ id, label, salt, hash, createdAt }, …] }
// Битые записи (не объект, пустой/отсутствующий id, label, salt или hash)
// отбрасываются молча: это чтение чужого файла, а не ввод пользователя,
// бросать исключение здесь нечем ловить (см. план приёмки T28).
export function parseRegistry(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const version = Number.isInteger(source.version) && source.version >= 1 ? source.version : 1;
  const list = Array.isArray(source.accounts) ? source.accounts : [];

  const accounts = [];
  for (const item of list) {
    if (!isPlainObject(item)) continue;
    const id = typeof item.id === 'string' ? item.id.trim().toLowerCase() : '';
    const label = typeof item.label === 'string' ? item.label.trim() : '';
    const salt = typeof item.salt === 'string' ? item.salt.trim() : '';
    const hash = typeof item.hash === 'string' ? item.hash.trim() : '';
    if (id === '' || label === '' || salt === '' || hash === '') continue;
    const createdAt = typeof item.createdAt === 'string' ? item.createdAt.trim() : '';
    accounts.push({ id, label, salt, hash, createdAt });
  }

  return { version, accounts };
}

// -> account | null, поиск по id регистронезависимо (Tanya === tanya).
export function findAccount(registry, loginRaw) {
  const list = registry && Array.isArray(registry.accounts) ? registry.accounts : [];
  const text = typeof loginRaw === 'string' ? loginRaw.trim().toLowerCase() : '';
  if (text === '') return null;
  const found = list.find((item) => isPlainObject(item) && typeof item.id === 'string' && item.id.toLowerCase() === text);
  return found ?? null;
}

// -> НОВЫЙ объект реестра с добавленной/заменённой по id записью.
// Вход не мутируется: список копируется через map/push, а не изменяется
// на месте, и результат заменяет объект целиком, а не поле входного.
export function upsertAccount(registry, account) {
  const base = isPlainObject(registry) ? registry : {};
  const version = Number.isInteger(base.version) && base.version >= 1 ? base.version : 1;
  const list = Array.isArray(base.accounts) ? base.accounts : [];
  const id = isPlainObject(account) && typeof account.id === 'string' ? account.id : '';

  let replaced = false;
  const accounts = list.map((item) => {
    if (isPlainObject(item) && item.id === id) {
      replaced = true;
      return { ...account };
    }
    return item;
  });
  if (!replaced) accounts.push({ ...account });

  return { version, accounts };
}

// ===== Пароль: PBKDF2-SHA-256 ==============================================

const PBKDF2_ITERATIONS = 100000;
const SALT_BYTES = 16;
const HASH_BITS = 256;

function webcrypto() {
  return globalThis.crypto ?? null;
}

// Тот же идиома hex-кодирования, что и blobSha в queue.js — единый способ
// на весь проект.
function toHex(bytes) {
  return Array.from(new Uint8Array(bytes)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex) {
  const text = String(hex).trim();
  const bytes = new Uint8Array(Math.floor(text.length / 2));
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(text.substr(i * 2, 2), 16);
  }
  return bytes;
}

async function deriveBits(password, saltBytes, iterations) {
  const crypto = webcrypto();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(String(password)),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    keyMaterial,
    HASH_BITS
  );
}

// -> { salt, hash, iterations } — все hex-строки/число. Соль генерируется
// (16 случайных байт), если saltHex не передан; передан — используется как
// есть, это путь verifyPassword-регрессии и повторного хеширования с той
// же солью, а не путь регистрации.
export async function hashPassword(password, saltHex = null) {
  const crypto = webcrypto();
  if (!crypto || !crypto.subtle) {
    throw new Error('WebCrypto недоступен: посчитать хеш пароля нечем.');
  }
  const saltBytes = typeof saltHex === 'string' && saltHex.trim() !== ''
    ? fromHex(saltHex)
    : crypto.getRandomValues(new Uint8Array(SALT_BYTES));

  const bits = await deriveBits(password, saltBytes, PBKDF2_ITERATIONS);
  return { salt: toHex(saltBytes), hash: toHex(bits), iterations: PBKDF2_ITERATIONS };
}

// -> boolean. Не бросает исключение ни при каких входных данных: битая
// запись реестра (не hex, отсутствующее поле) — это «пароль не подошёл»,
// а не повод ронять экран входа.
export async function verifyPassword(password, account) {
  const source = isPlainObject(account) ? account : {};
  const crypto = webcrypto();
  if (!crypto || !crypto.subtle) return false;
  if (typeof source.salt !== 'string' || typeof source.hash !== 'string') return false;

  const iterations = Number.isInteger(source.iterations) && source.iterations > 0
    ? source.iterations
    : PBKDF2_ITERATIONS;

  try {
    const bits = await deriveBits(password, fromHex(source.salt), iterations);
    return toHex(bits) === source.hash.toLowerCase();
  } catch {
    return false;
  }
}

// ===== Пути в repo B ========================================================

export function accountDataDir(accountId) {
  return `accounts/${accountId}/data`;
}

export function accountIndexPath(accountId) {
  return `accounts/${accountId}/index.json`;
}

export function accountProfilePath(accountId) {
  return `accounts/${accountId}/profile.json`;
}
