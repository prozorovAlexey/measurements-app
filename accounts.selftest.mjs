// Автотест accounts.js и его дополнений в store.js (T28, §17 контракта).
//
// Запуск (node на PATH — старая сборка без ES-модулей, §12 контракта):
//
//   C:\Users\user\AppData\Roaming\nvm\v24.4.0\node.exe accounts.selftest.mjs
//
// Только stdlib: ни npm-пакетов, ни тест-раннера (§0 контракта).
//
// localStorage подставлен той же заглушкой, что и в queue.selftest.mjs —
// store.js больше ни от чего не зависит. hashPassword/verifyPassword гоняют
// настоящий globalThis.crypto.subtle (Node ≥ 15 отдаёт webcrypto без
// импорта) — не имитацию, ровно как в браузере.

import assert from 'node:assert/strict';

// ===== Заглушка localStorage (как в queue.selftest.mjs) ====================

const storage = new Map();

globalThis.localStorage = {
  getItem: (key) => (storage.has(String(key)) ? storage.get(String(key)) : null),
  setItem: (key, value) => { storage.set(String(key), String(value)); },
  removeItem: (key) => { storage.delete(String(key)); }
};

const accounts = await import('./accounts.js');
const store = await import('./store.js');

const {
  LOGIN_PATTERN, MIN_PASSWORD_LENGTH,
  validateLogin, validatePassword,
  parseRegistry, findAccount, upsertAccount, removeAccount,
  hashPassword, verifyPassword,
  accountDataDir, accountIndexPath, accountProfilePath
} = accounts;

let passed = 0;
let failed = 0;

async function step(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`✗ ${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

// Провал по-русски: пользователю нельзя показывать message без кириллицы.
function russian(result) {
  assert.equal(result.ok, false, 'ожидался ok:false');
  assert.match(result.message, /[а-яё]/i, `текст не русский: ${result.message}`);
  return true;
}

console.log('Самопроверка T28: accounts.js + store.js');

// ===== validateLogin ========================================================

await step('validateLogin: корректный логин — id в нижнем регистре, label как введено', () => {
  const result = validateLogin('Tanya');
  assert.deepEqual(result, { ok: true, id: 'tanya', label: 'Tanya' });
});

await step('validateLogin: пограничная длина 2 и 20 символов — проходит', () => {
  assert.equal(validateLogin('ab').ok, true);
  assert.equal(validateLogin('a'.repeat(20)).ok, true);
});

await step('validateLogin: пустая строка — отказ по-русски', () => {
  russian(validateLogin(''));
  russian(validateLogin(undefined));
  russian(validateLogin(null));
});

await step('validateLogin: длина вне 2–20 — отказ', () => {
  russian(validateLogin('a')); // 1 символ
  russian(validateLogin('a'.repeat(21))); // 21 символ
});

await step('validateLogin: кириллица — отказ', () => {
  russian(validateLogin('Таня'));
  russian(validateLogin('логин'));
});

await step('validateLogin: пробелы (внутри, по краям) — отказ', () => {
  russian(validateLogin('ta nya'));
  russian(validateLogin(' tanya'));
  russian(validateLogin('tanya '));
  russian(validateLogin(' tanya '));
});

await step('validateLogin: запрещённая пунктуация — отказ', () => {
  russian(validateLogin('tanya!'));
  russian(validateLogin('tanya.name'));
  russian(validateLogin('tanya@x'));
  russian(validateLogin('tanya/x'));
});

await step('validateLogin: id всегда в нижнем регистре независимо от ввода', () => {
  assert.equal(validateLogin('TANYA').id, 'tanya');
  assert.equal(validateLogin('TaNyA').id, 'tanya');
  assert.equal(validateLogin('alex_2').id, 'alex_2');
  assert.equal(validateLogin('Alex-2').id, 'alex-2');
});

await step('LOGIN_PATTERN и MIN_PASSWORD_LENGTH — контракт §17', () => {
  assert.ok(LOGIN_PATTERN instanceof RegExp);
  assert.equal(MIN_PASSWORD_LENGTH, 4);
});

// ===== validatePassword =====================================================

await step('validatePassword: пустая строка и 3 символа — отказ', () => {
  russian(validatePassword(''));
  russian(validatePassword('   ')); // после trim пусто
  russian(validatePassword('abc')); // 3 символа
});

await step('validatePassword: 4 символа и длиннее — проходит', () => {
  assert.deepEqual(validatePassword('abcd'), { ok: true, value: 'abcd' });
  assert.equal(validatePassword('очень-длинный-пароль-1234').ok, true);
});

await step('validatePassword: обрезаются только края, внутренние пробелы остаются', () => {
  const result = validatePassword('  pass word  ');
  assert.deepEqual(result, { ok: true, value: 'pass word' });
});

// ===== parseRegistry =========================================================

await step('parseRegistry: мусор на входе не роняет функцию, всегда {version, accounts}', () => {
  for (const garbage of [null, undefined, 42, 'строка', [], [1, 2, 3], {}, true]) {
    const result = parseRegistry(garbage);
    assert.deepEqual(Object.keys(result).sort(), ['accounts', 'version']);
    assert.ok(Array.isArray(result.accounts), `garbage=${JSON.stringify(garbage)}`);
  }
});

await step('parseRegistry: нет поля accounts — пустой список, не исключение', () => {
  const result = parseRegistry({ version: 1 });
  assert.deepEqual(result, { version: 1, accounts: [] });
});

await step('parseRegistry: битые записи отбрасываются, хорошие остаются', () => {
  const raw = {
    version: 1,
    accounts: [
      { id: 'tanya', label: 'Tanya', salt: 'aa', hash: 'bb', createdAt: '2026-08-01' },
      { label: 'Без логина', salt: 'aa', hash: 'bb' }, // нет id
      { id: 'alex', salt: 'aa', hash: 'bb' }, // нет label
      { id: 'noHash', label: 'X', salt: 'aa' }, // нет hash
      null,
      42,
      'строка',
      { id: 'valid2', label: 'Valid2', salt: 'cc', hash: 'dd' }
    ]
  };
  const result = parseRegistry(raw);
  assert.deepEqual(result.accounts.map((item) => item.id).sort(), ['tanya', 'valid2']);
  assert.deepEqual(result.accounts.find((item) => item.id === 'tanya'), {
    id: 'tanya', label: 'Tanya', salt: 'aa', hash: 'bb', createdAt: '2026-08-01'
  });
});

await step('parseRegistry: версия не целое или меньше 1 — дефолт 1', () => {
  assert.equal(parseRegistry({ version: 0, accounts: [] }).version, 1);
  assert.equal(parseRegistry({ version: 'один', accounts: [] }).version, 1);
  assert.equal(parseRegistry({ version: 1.5, accounts: [] }).version, 1);
  assert.equal(parseRegistry({ version: 3, accounts: [] }).version, 3);
});

// ===== findAccount ===========================================================

const REGISTRY = Object.freeze({
  version: 1,
  accounts: [
    Object.freeze({ id: 'tanya', label: 'Tanya', salt: 'aa', hash: 'bb', createdAt: '2026-08-01' }),
    Object.freeze({ id: 'alex', label: 'Alex', salt: 'cc', hash: 'dd', createdAt: '2026-08-02' })
  ]
});

await step('findAccount: регистронезависимый поиск по id', () => {
  assert.deepEqual(findAccount(REGISTRY, 'Tanya'), REGISTRY.accounts[0]);
  assert.deepEqual(findAccount(REGISTRY, 'TANYA'), REGISTRY.accounts[0]);
  assert.deepEqual(findAccount(REGISTRY, 'tanya'), REGISTRY.accounts[0]);
});

await step('findAccount: неизвестный логин — null', () => {
  assert.equal(findAccount(REGISTRY, 'unknown'), null);
  assert.equal(findAccount(REGISTRY, ''), null);
  assert.equal(findAccount(REGISTRY, null), null);
  assert.equal(findAccount({ accounts: [] }, 'tanya'), null);
  assert.equal(findAccount(null, 'tanya'), null);
});

// ===== upsertAccount ==========================================================

await step('upsertAccount: новый id — добавляется в конец, вход не мутируется', () => {
  const before = JSON.parse(JSON.stringify(REGISTRY));
  const next = upsertAccount(REGISTRY, { id: 'nova', label: 'Nova', salt: 'ee', hash: 'ff', createdAt: '2026-08-27' });

  assert.equal(next.accounts.length, 3);
  assert.equal(next.accounts[2].id, 'nova');
  assert.equal(REGISTRY.accounts.length, 2, 'исходный реестр вырос');
  assert.deepEqual(REGISTRY, before, 'исходный реестр изменился');
});

await step('upsertAccount: существующий id — замена без дублирования', () => {
  const before = JSON.parse(JSON.stringify(REGISTRY));
  const next = upsertAccount(REGISTRY, { id: 'alex', label: 'Alex2', salt: 'zz', hash: 'yy', createdAt: '2026-08-28' });

  assert.equal(next.accounts.length, 2, 'replace размножил запись');
  const replaced = next.accounts.find((item) => item.id === 'alex');
  assert.deepEqual(replaced, { id: 'alex', label: 'Alex2', salt: 'zz', hash: 'yy', createdAt: '2026-08-28' });
  assert.equal(REGISTRY.accounts.length, 2, 'исходный реестр вырос');
  assert.deepEqual(REGISTRY.accounts.find((item) => item.id === 'alex'), before.accounts.find((item) => item.id === 'alex'),
    'исходная запись alex подменилась на месте');
});

// ===== removeAccount (T34) ===================================================

await step('removeAccount: убирает запись по id, вход не мутируется', () => {
  const before = JSON.parse(JSON.stringify(REGISTRY));
  const next = removeAccount(REGISTRY, 'alex');

  assert.equal(next.accounts.length, 1);
  assert.equal(next.accounts.some((item) => item.id === 'alex'), false);
  assert.deepEqual(next.accounts[0], REGISTRY.accounts[0]);
  assert.equal(REGISTRY.accounts.length, 2, 'исходный реестр вырос');
  assert.deepEqual(REGISTRY, before, 'исходный реестр изменился');
});

await step('removeAccount: неизвестный id — состав не меняется, но объект новый', () => {
  const next = removeAccount(REGISTRY, 'unknown');
  assert.equal(next.accounts.length, 2);
  assert.notEqual(next, REGISTRY, 'вернулся тот же объект реестра, а не копия');
  assert.deepEqual(next.accounts, REGISTRY.accounts);
});

await step('removeAccount: version сохраняется, дефолт 1 для отсутствующей/некорректной', () => {
  assert.equal(removeAccount({ version: 3, accounts: [] }, 'x').version, 3);
  assert.equal(removeAccount({ accounts: [] }, 'x').version, 1);
  assert.equal(removeAccount({ version: 0, accounts: [] }, 'x').version, 1);
});

await step('removeAccount: мусор на входе не роняет функцию, всегда {version, accounts}', () => {
  for (const garbage of [null, undefined, 42, 'строка', [], true]) {
    const result = removeAccount(garbage, 'alex');
    assert.deepEqual(Object.keys(result).sort(), ['accounts', 'version']);
    assert.ok(Array.isArray(result.accounts), `garbage=${JSON.stringify(garbage)}`);
  }
});

// ===== hashPassword / verifyPassword ========================================

await step('hashPassword/verifyPassword: раунд-трип совпадающего пароля — true', async () => {
  const hashed = await hashPassword('correct horse battery staple');
  assert.equal(typeof hashed.salt, 'string');
  assert.equal(typeof hashed.hash, 'string');
  assert.equal(hashed.iterations, 100000);
  assert.match(hashed.salt, /^[0-9a-f]{32}$/, '16 байт соли = 32 hex-символа');
  assert.match(hashed.hash, /^[0-9a-f]{64}$/, '32 байта хеша (SHA-256) = 64 hex-символа');

  const ok = await verifyPassword('correct horse battery staple', hashed);
  assert.equal(ok, true);
});

await step('hashPassword/verifyPassword: неверный пароль — false', async () => {
  const hashed = await hashPassword('верный-пароль-1');
  assert.equal(await verifyPassword('неверный-пароль', hashed), false);
});

await step('hashPassword: без явной соли — два вызова дают РАЗНЫЕ соль и хеш (случайность)', async () => {
  const a = await hashPassword('тот же самый пароль');
  const b = await hashPassword('тот же самый пароль');
  assert.notEqual(a.salt, b.salt, 'соль не случайна — подозрение на Math.random() или константу');
  assert.notEqual(a.hash, b.hash);
});

await step('hashPassword: одна и та же соль — одинаковый хеш (детерминизм при фиксированной соли)', async () => {
  const first = await hashPassword('пароль-с-фиксированной-солью', 'aabbccddeeff00112233445566778899');
  const second = await hashPassword('пароль-с-фиксированной-солью', 'aabbccddeeff00112233445566778899');
  assert.equal(first.salt, 'aabbccddeeff00112233445566778899');
  assert.equal(second.salt, first.salt);
  assert.equal(second.hash, first.hash, 'та же соль обязана давать тот же хеш — иначе соль не используется по-настоящему');
});

// ===== Пути в repo B =========================================================

await step('accountDataDir/accountIndexPath/accountProfilePath: точная форма пути', () => {
  assert.equal(accountDataDir('alex'), 'accounts/alex/data');
  assert.equal(accountIndexPath('alex'), 'accounts/alex/index.json');
  assert.equal(accountProfilePath('alex'), 'accounts/alex/profile.json');
});

// ===== store.js: новые ключи ================================================

await step('§17: новые ключи KEYS — точные строки контракта', () => {
  assert.equal(store.KEYS.activeAccount, 'bm.active_account');
  assert.equal(store.KEYS.lastLogin, 'bm.last_login');
  assert.equal(store.KEYS.accountsCache, 'bm.accounts_cache');
});

await step('setActiveAccount/getActiveAccount/clearActiveAccount: раунд-трип', () => {
  storage.clear();
  assert.equal(store.getActiveAccount(), null, 'по умолчанию — null');
  assert.equal(store.setActiveAccount(''), false, 'пустая строка — отказ');
  assert.equal(store.setActiveAccount('   '), false, 'строка из пробелов — отказ');
  assert.equal(store.setActiveAccount('tanya'), true);
  assert.equal(store.getActiveAccount(), 'tanya');
  store.clearActiveAccount();
  assert.equal(store.getActiveAccount(), null, 'clearActiveAccount не удалил ключ');
});

await step('clearActiveAccount не трогает соседние ключи', () => {
  storage.clear();
  store.setActiveAccount('tanya');
  store.setLastLogin('Tanya');
  store.clearActiveAccount();
  assert.equal(store.getLastLogin(), 'Tanya', 'clearActiveAccount задел bm.last_login');
});

await step('setLastLogin/getLastLogin: раунд-трип', () => {
  storage.clear();
  assert.equal(store.getLastLogin(), null);
  assert.equal(store.setLastLogin(''), false);
  assert.equal(store.setLastLogin('Tanya'), true);
  assert.equal(store.getLastLogin(), 'Tanya');
});

await step('setAccountsCache/getAccountsCache: fetchedAt проставлен ISO-строкой', () => {
  storage.clear();
  assert.equal(store.getAccountsCache(), null);
  const written = store.setAccountsCache({ version: 1, accounts: [] });
  assert.deepEqual(written.data, { version: 1, accounts: [] });
  assert.match(written.fetchedAt, /^\d{4}-\d{2}-\d{2}T/);

  const read = store.getAccountsCache();
  assert.deepEqual(read.data, { version: 1, accounts: [] });
  assert.equal(read.fetchedAt, written.fetchedAt);
});

await step('setAccountIndexCache: разные профили не пересекаются', () => {
  storage.clear();
  store.setAccountIndexCache('tanya', { totals: 'tanya-data' });
  store.setAccountIndexCache('alex', { totals: 'alex-data' });

  assert.deepEqual(store.getAccountIndexCache('tanya').data, { totals: 'tanya-data' });
  assert.deepEqual(store.getAccountIndexCache('alex').data, { totals: 'alex-data' });
  assert.equal(store.getAccountIndexCache('nobody'), null, 'неизвестный профиль — null, а не чужие данные');
});

await step('setAccountProfile: разные профили не пересекаются', () => {
  storage.clear();
  store.setAccountProfile('tanya', { sex: 'female' });
  store.setAccountProfile('alex', { sex: 'male' });

  assert.deepEqual(store.getAccountProfile('tanya'), { sex: 'female' });
  assert.deepEqual(store.getAccountProfile('alex'), { sex: 'male' });
  assert.deepEqual(store.getAccountProfile('nobody'), { sex: 'male' }, 'дефолт для неизвестного профиля — male');
});

await step('getAccountIndexCache/getAccountProfile: невалидный accountId ведёт себя как «не найдено»', () => {
  storage.clear();
  assert.equal(store.getAccountIndexCache(''), null);
  assert.equal(store.getAccountIndexCache(null), null);
  assert.deepEqual(store.getAccountProfile(''), { sex: 'male' });
  assert.equal(store.setAccountIndexCache('', { x: 1 }), false);
  assert.equal(store.setAccountProfile('', { sex: 'female' }), false);
});

await step('clearAccountCache: удаляет index_cache и profile ровно одного профиля', () => {
  storage.clear();
  store.setAccountIndexCache('tanya', { a: 1 });
  store.setAccountProfile('tanya', { sex: 'female' });
  store.setAccountIndexCache('alex', { a: 2 });
  store.setAccountProfile('alex', { sex: 'male' });

  const cleared = store.clearAccountCache('tanya');
  assert.equal(cleared, true);
  assert.equal(store.getAccountIndexCache('tanya'), null);
  assert.deepEqual(store.getAccountProfile('tanya'), { sex: 'male' }, 'дефолт после очистки');
  // Соседний профиль не тронут.
  assert.deepEqual(store.getAccountIndexCache('alex').data, { a: 2 });
  assert.deepEqual(store.getAccountProfile('alex'), { sex: 'male' });
});

// ===== migrateLegacyProfile ==================================================

await step('migrateLegacyProfile: переносит старые ключи, идемпотентна', () => {
  storage.clear();
  // Старые ключи ровно в той форме, что производят getIndexCache/getProfile.
  store.setIndexCache({ legacy: 'index' });
  store.setProfile({ sex: 'female' });
  assert.notEqual(storage.get(store.KEYS.index), undefined, 'фикстура не легла');
  assert.notEqual(storage.get(store.KEYS.profile), undefined, 'фикстура не легла');

  const migrated = store.migrateLegacyProfile('alex');
  assert.equal(migrated, true, 'первый вызов обязан перенести хотя бы один ключ');

  assert.deepEqual(store.getAccountIndexCache('alex').data, { legacy: 'index' });
  assert.deepEqual(store.getAccountProfile('alex'), { sex: 'female' });

  assert.equal(storage.has(store.KEYS.index), false, 'старый bm.index_cache не удалён');
  assert.equal(storage.has(store.KEYS.profile), false, 'старый bm.profile не удалён');

  const again = store.migrateLegacyProfile('alex');
  assert.equal(again, false, 'повторный вызов не идемпотентен');
  assert.deepEqual(store.getAccountIndexCache('alex').data, { legacy: 'index' }, 'данные не потерялись при повторном вызове');
});

await step('migrateLegacyProfile: нечего переносить — false, без исключения', () => {
  storage.clear();
  assert.equal(store.migrateLegacyProfile('nobody'), false);
  assert.equal(store.migrateLegacyProfile(''), false, 'невалидный accountId — тоже false, не исключение');
});

await step('migrateLegacyProfile: переносит только отсутствующую половину', () => {
  storage.clear();
  store.setIndexCache({ legacy: 'only-index' });
  // profile для alex уже есть — переносить его не нужно.
  store.setAccountProfile('alex', { sex: 'female' });

  const migrated = store.migrateLegacyProfile('alex');
  assert.equal(migrated, true, 'index должен был перенестись');
  assert.deepEqual(store.getAccountIndexCache('alex').data, { legacy: 'only-index' });
  assert.deepEqual(store.getAccountProfile('alex'), { sex: 'female' }, 'уже существовавший профиль не тронут');
  assert.equal(storage.has(store.KEYS.index), false);
});

// ===== Сторож: старые функции store.js не тронуты ============================

await step('§17: устройство-общие функции store.js существуют без изменений сигнатур', () => {
  for (const name of [
    'getToken', 'setToken', 'clearToken',
    'getRepoConfig', 'setRepoConfig',
    'getIndexCache', 'setIndexCache',
    'getCatalogCache', 'setCatalogCache',
    'getCheatsheetOpens', 'bumpCheatsheetOpens',
    'getOpens', 'bumpOpens',
    'getProfile', 'setProfile',
    'getThemeOverride', 'setThemeOverride',
    'getShowAllCallouts', 'setShowAllCallouts'
  ]) {
    assert.equal(typeof store[name], 'function', `${name} пропал или перестал быть функцией`);
  }
  assert.equal(store.KEYS.token, 'bm.token');
  assert.equal(store.KEYS.profile, 'bm.profile');
});

console.log(`Итог: ${passed} ок, ${failed} провалено.`);
process.exitCode = failed === 0 ? 0 : 1;
