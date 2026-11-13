const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, statSync, readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { tmpdir } = require('node:os');
const path = require('node:path');

function exerciseBinding(fixtureDir) {
  const Database = require('better-sqlite3');
  const { installTestSqlite } = require('../install-test-sqlite.cjs');
  const binding = installTestSqlite({ fixtureDir });
  assert.equal(binding.version, require('better-sqlite3/package.json').version);
  assert.equal(
    createHash('sha256').update(readFileSync(binding.destination)).digest('hex'),
    binding.sha256
  );
  const databasePath = path.join(fixtureDir, 'sample.sqlite');
  const database = new Database(databasePath, { nativeBinding: binding.destination });
  database.exec('CREATE TABLE sample (name TEXT NOT NULL)');
  database.prepare('INSERT INTO sample VALUES (?)').run('native persistence');
  database.close();
  const reopened = new Database(databasePath, { nativeBinding: binding.destination });
  assert.deepEqual(reopened.prepare('SELECT name FROM sample').get(), {
    name: 'native persistence',
  });
  assert.equal(reopened.pragma('quick_check', { simple: true }), 'ok');
  reopened.close();
  const before = statSync(binding.destination).mtimeMs;
  installTestSqlite({ fixtureDir });
  assert.equal(statSync(binding.destination).mtimeMs, before);
}

if (process.argv[2] === '--exercise-binding') {
  exerciseBinding(process.argv[3]);
} else {
  test('the test binding uses the locked driver and persists real SQLite data', () => {
    const fixtureDir = mkdtempSync(path.join(tmpdir(), 'dnaforge-test-sqlite-'));
    try {
      const result = spawnSync(process.execPath, [__filename, '--exercise-binding', fixtureDir], {
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
}
