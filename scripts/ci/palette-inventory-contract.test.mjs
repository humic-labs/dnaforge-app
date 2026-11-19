import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const driver = fileURLToPath(
  new URL('../../apps/desktop/scripts/palette-enzyme-journey.mjs', import.meta.url)
);
const source = readFileSync(driver, 'utf8');
const start = source.indexOf('const sourceFiles =');
const end = source.indexOf('const args =', start);
assert.ok(start >= 0 && end > start, 'Actual palette fingerprint boundary is missing');
const fingerprint = new vm.Script(`${source.slice(start, end)}\nsourceFingerprint;`, {
  filename: driver,
});

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'dnaforge-palette-inventory-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (args, options = {}) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', ...options });
  git(['init', '--quiet']);
  const selected = new Map([
    ['apps/desktop/src/beta.ts', 'export const beta = 2;\n'],
    ['apps/desktop/scripts/fixture script.mjs', 'export const command = 1;\n'],
    ['packages/tool/alpha.ts', 'export const alpha = 3;\n'],
  ]);
  for (const [file, bytes] of selected) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), bytes);
  }
  git(['add', 'apps/desktop']);
  const hash = createHash('sha256');
  for (const [file, bytes] of [...selected].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(file);
    hash.update(bytes);
  }
  return {
    root,
    git,
    expected: hash.digest('hex'),
    run: () => fingerprint.runInNewContext({ root, execFileSync, createHash, readFileSync, path }),
  };
}

test('palette source fingerprint survives an oversized unrelated Git inventory and retains exact relevant bytes', (t) => {
  const f = fixture(t);
  const emptyBlob = f.git(['hash-object', '-w', '--stdin'], { input: '' }).trim();
  const entries = Array.from(
    { length: 12000 },
    (_, i) =>
      `100644 ${emptyBlob}\tdocs/unrelated/${String(i).padStart(5, '0')}-${'x'.repeat(100)}.txt\0`
  ).join('');
  f.git(['update-index', '-z', '--index-info'], { input: entries });
  const full = f.git(['ls-files', '-co', '--exclude-standard', '-z'], {
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.ok(
    Buffer.byteLength(full) > 1024 * 1024,
    'Fixture must exceed Node default output buffer'
  );
  assert.equal(f.run(), f.expected);
});

test('palette fingerprint includes changed bytes and untracked package source', (t) => {
  const f = fixture(t);
  assert.equal(f.run(), f.expected);
  writeFileSync(path.join(f.root, 'packages/tool/alpha.ts'), 'export const alpha = 4;\n');
  assert.notEqual(f.run(), f.expected);
});

test('a missing indexed relevant file refuses a palette fingerprint', (t) => {
  const f = fixture(t);
  unlinkSync(path.join(f.root, 'apps/desktop/src/beta.ts'));
  assert.throws(f.run, /ENOENT/u);
});

test('Git inventory failure refuses a palette fingerprint', (t) => {
  const f = fixture(t);
  rmSync(path.join(f.root, '.git'), { recursive: true });
  assert.throws(f.run, /not a git repository/u);
});
