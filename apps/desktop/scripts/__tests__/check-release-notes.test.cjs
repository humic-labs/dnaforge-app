const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

function checkNotes({
  history,
  notes = ['0.9.8', '0.9.3'],
  release = false,
  version = '0.9.3',
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-release-notes-'));
  try {
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.mkdirSync(path.join(root, 'src/lib'), { recursive: true });
    fs.copyFileSync(
      path.join(__dirname, '../check-release-notes.cjs'),
      path.join(root, 'scripts/check-release-notes.cjs')
    );
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version, type: 'module' }));
    fs.writeFileSync(
      path.join(root, 'src/lib/release-notes.ts'),
      `export const RELEASE_NOTES = {${notes.map((v) => `'${v}': {}`).join(',')}};\n` +
        `export const VERSION_HISTORY = ${history ? JSON.stringify(history) : "Object.keys(RELEASE_NOTES).sort((a,b)=>b.localeCompare(a,'en',{numeric:true}))"};\n`
    );
    return execFileSync(process.execPath, [path.join(root, 'scripts/check-release-notes.cjs')], {
      env: { ...process.env, DNAFORGE_RELEASE_BUILD: release ? '1' : '0' },
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
test('local validation uses the complete note registry, not the stale package template', () => {
  assert.match(checkNotes({ notes: ['0.9.8'] }), /1 releases are reachable; latest notes 0\.9\.8/);
});
test('release validation rejects an unstamped older package', () => {
  assert.throws(
    () => checkNotes({ release: true }),
    /Release version must be first. Expected 0.9.3, got 0.9.8/
  );
});
test('release validation accepts the CI-stamped version with derived history', () => {
  assert.match(checkNotes({ release: true, version: '0.9.8' }), /latest notes 0\.9\.8/);
});
test('release validation rejects missing content for the stamped version', () => {
  assert.throws(
    () => checkNotes({ release: true, version: '0.9.9' }),
    /Missing release notes for 0.9.9/
  );
});
test('nightly builds skip version coverage even with the shared release flag', () => {
  assert.match(
    checkNotes({ release: true, version: '0.9.9-nightly.37000000' }),
    /Skipped version coverage for nightly prerelease 0\.9\.9-nightly\.37000000/
  );
});
test('nightly builds still validate the complete history', () => {
  assert.throws(
    () => checkNotes({ release: true, version: '0.9.9-nightly.37000000', history: ['0.9.3'] }),
    /include every release note exactly once/
  );
});
test('validation rejects the actual omitted-note regression', () => {
  assert.throws(
    () => checkNotes({ history: ['0.9.3'] }),
    /include every release note exactly once/
  );
});
test('validation rejects duplicate entries', () => {
  assert.throws(
    () => checkNotes({ history: ['0.9.8', '0.9.8', '0.9.3'] }),
    /include every release note exactly once/
  );
});
