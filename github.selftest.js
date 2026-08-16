// Ручная приёмка T2 (§9 спеки): «из консоли браузера успешно создаётся
// и читается тестовый файл в repo B».
//
// Запуск — из консоли браузера на открытом приложении, токен уже должен быть
// сохранён в Настройках:
//
//   const t = await import('./github.selftest.js'); await t.selfTest();
//
// Тест пишет в КОРЕНЬ repo B, а не в data/. Директория data/ — append-only
// хранилище сессий, и служебному файлу там не место: T3 обошёл бы его по маске
// имени, но полагаться на это незачем. Удаление файлов не входит в контракт §4,
// поэтому _selftest.json остаётся лежать в корне; вреда от него нет, удалить
// можно через веб-интерфейс GitHub.

import { readFile, readFileOrNull, writeFile, listFiles, GitHubError, utf8ToBase64 } from './github.js';

const TEST_PATH = '_selftest.json';
const MISSING_PATH = '_selftest_missing_00000000.json';

function describe(err) {
  if (err instanceof GitHubError) return `${err.kind} — ${err.message}`;
  return err && err.message ? err.message : String(err);
}

export async function selfTest() {
  const result = { passed: 0, failed: 0 };
  const state = { sha: null, payload: '' };

  async function step(name, fn) {
    try {
      await fn();
      result.passed += 1;
      console.log(`✓ ${name}`);
    } catch (err) {
      result.failed += 1;
      console.error(`✗ ${name}: ${describe(err)}`);
    }
  }

  function assert(cond, why) {
    if (!cond) throw new Error(why);
  }

  console.log(`Самопроверка github.js, файл ${TEST_PATH}`);

  // 1. Запись файла с меткой времени и кириллицей.
  await step('1. запись файла', async () => {
    const existing = await readFileOrNull(TEST_PATH);
    state.payload = JSON.stringify({
      _selftest: true,
      note: 'Проверка записи: талия «WHO», бицепс напряжённый 🧍 — ёжик Ъ Ь Э Ю Я',
      at: new Date().toISOString()
    }, null, 2);
    const written = await writeFile(TEST_PATH, state.payload, {
      message: 'Самопроверка github.js (T2)',
      sha: existing ? existing.sha : undefined
    });
    assert(typeof written.sha === 'string' && written.sha !== '', 'в ответе нет sha');
    assert(written.commit && typeof written.commit.sha === 'string', 'в ответе нет sha коммита');
    state.sha = written.sha;
  });

  // 2. Чтение обратно и побайтовое сравнение.
  await step('2. чтение обратно, побайтовое совпадение', async () => {
    assert(state.sha !== null, 'предыдущий шаг не прошёл');
    const read = await readFile(TEST_PATH);
    assert(read.content === state.payload, 'содержимое не совпало посимвольно');
    assert(utf8ToBase64(read.content) === utf8ToBase64(state.payload), 'содержимое не совпало побайтово');
    assert(typeof read.sha === 'string' && read.sha !== '', 'в ответе нет sha');
    state.sha = read.sha;
  });

  // 3. Файл виден в листинге директории.
  await step('3. файл виден в listFiles("")', async () => {
    const files = await listFiles('');
    assert(Array.isArray(files), 'listFiles вернул не массив');
    const found = files.find((f) => f.path === TEST_PATH);
    assert(Boolean(found), `в корне репозитория нет ${TEST_PATH} (файлов: ${files.length})`);
    assert(typeof found.size === 'number' && found.size > 0, 'размер файла не пришёл');
  });

  // 4. Перезапись с актуальным sha — ветка обновления.
  await step('4. перезапись с sha', async () => {
    assert(state.sha !== null, 'нет sha от предыдущих шагов');
    const next = `${state.payload}\n`;
    const written = await writeFile(TEST_PATH, next, {
      message: 'Самопроверка github.js: перезапись с sha',
      sha: state.sha
    });
    assert(written.sha !== state.sha, 'sha после перезаписи не изменился');
    state.payload = next;
    state.sha = written.sha;
  });

  // 5. Перезапись без sha обязана дать kind 'conflict'.
  await step('5. перезапись без sha -> conflict', async () => {
    try {
      await writeFile(TEST_PATH, `${state.payload}конфликт\n`, {
        message: 'Самопроверка github.js: ожидаемый конфликт'
      });
    } catch (err) {
      assert(err instanceof GitHubError, `ожидался GitHubError, пришло ${describe(err)}`);
      assert(err.kind === 'conflict', `ожидался kind conflict, пришёл ${err.kind}`);
      return;
    }
    throw new Error('запись без sha прошла успешно, конфликта не было');
  });

  // 6. Чтение заведомо отсутствующего пути.
  await step('6. чтение несуществующего файла -> not-found', async () => {
    try {
      await readFile(MISSING_PATH);
    } catch (err) {
      assert(err instanceof GitHubError, `ожидался GitHubError, пришло ${describe(err)}`);
      assert(err.kind === 'not-found', `ожидался kind not-found, пришёл ${err.kind}`);
      assert(await readFileOrNull(MISSING_PATH) === null, 'readFileOrNull вернул не null');
      return;
    }
    throw new Error('несуществующий файл прочитался');
  });

  console.log(`Итог: ${result.passed} ок, ${result.failed} провалено.`);
  console.log(`Служебный ${TEST_PATH} остался в корне репозитория с данными. В агрегат он не попадёт (там только data/), удалить можно через веб-интерфейс GitHub.`);
  return result;
}
