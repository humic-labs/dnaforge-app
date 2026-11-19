import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [appArgument, genbankFile, snapgeneControl, reportPath, cancelFlag] = process.argv.slice(2);
if (process.platform !== 'darwin' || !reportPath) {
  throw new Error(
    'Usage: node verify-macos-default-file-open.mjs <DNAForge.app> <GenBank source> <.dna control> <new report.json> [--cancel-first]'
  );
}
const user = userInfo();
const hosted =
  process.env.GITHUB_ACTIONS === 'true' &&
  process.env.RUNNER_ENVIRONMENT === 'github-hosted' &&
  user.username === 'runner';
if (!hosted && !/^dnaforge-assoc-test-[a-z0-9]+$/.test(user.username)) {
  throw new Error(
    'Use an isolated macOS test account named dnaforge-assoc-test-<id> on a disposable VM.'
  );
}
assert.match(snapgeneControl, /\.dna$/i);
const app = realpathSync(appArgument);
const contents = join(app, 'Contents');
const helper = join(contents, 'Helpers', 'dnaforge-file-association');
const executable = realpathSync(
  join(
    contents,
    'MacOS',
    execFileSync(
      '/usr/bin/plutil',
      ['-extract', 'CFBundleExecutable', 'raw', join(contents, 'Info.plist')],
      { encoding: 'utf8' }
    ).trim()
  )
);
const appId = execFileSync(
  '/usr/bin/plutil',
  ['-extract', 'CFBundleIdentifier', 'raw', join(contents, 'Info.plist')],
  { encoding: 'utf8' }
).trim();
assert.equal(appId, 'com.dnaforge.desktop');
const registry = JSON.parse(
  readFileSync(new URL('../resources/file-associations.json', import.meta.url))
);
const family = registry.families.find((item) => item.id === 'genbank');
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const sourceHash = hash(genbankFile);
const run = mkdtempSync(join(tmpdir(), 'dnaforge-default-test-'));
const samples = Object.fromEntries(
  family.extensions.map((extension) => {
    const file = join(run, randomUUID() + '.' + extension);
    copyFileSync(genbankFile, file);
    return [extension, file];
  })
);
const docs = { ...samples, dna: realpathSync(snapgeneControl) };
function snapshot() {
  return Object.fromEntries(
    Object.entries(docs).map(([extension, file]) => [
      extension,
      JSON.parse(execFileSync(helper, ['inspect-file', file], { encoding: 'utf8' })),
    ])
  );
}
function processIds() {
  return execFileSync('/bin/ps', ['-U', user.username, '-o', 'pid=,comm='], { encoding: 'utf8' })
    .split('\n')
    .flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
      return match && match[2] === executable ? [Number(match[1])] : [];
    });
}
function requestDefault(target, types, extensions) {
  execFileSync(helper, ['set-extensions', target, types.join(','), ...extensions], {
    stdio: 'inherit',
  });
}
const before = snapshot();
assert.deepEqual(processIds(), [], 'Close the installed candidate before this cold-launch proof.');
assert.ok(
  Object.values(before).every((state) => state.handler?.path),
  'Choose an alternate handler for the sample files first.'
);
for (const extension of family.extensions) {
  const state = before[extension];
  assert.notEqual(state.handler.bundleId, appId);
  assert.ok(
    state.candidates.some((item) => item.bundleId === appId && realpathSync(item.path) === app)
  );
}
const store = join(
  user.homedir,
  'Library',
  'Application Support',
  'DNAForge',
  'quick-look-packages'
);
async function openThroughFinder(file) {
  execFileSync('/usr/bin/open', ['-g', file]);
  const timeout = Date.now() + 90000;
  do {
    if (existsSync(store)) {
      for (const child of readdirSync(store, { withFileTypes: true })) {
        if (!child.isDirectory() || child.name.startsWith('.')) continue;
        const manifest = join(store, child.name, 'quick-look.json');
        if (!existsSync(manifest)) continue;
        const data = JSON.parse(readFileSync(manifest));
        if (
          data.sourceFileName === basename(file) &&
          data.sourceContentHash === sourceHash &&
          data.records?.length
        ) {
          const ids = processIds();
          assert.equal(ids.length, 1, 'Expected exactly one instance of the installed app.');
          assert.equal(hash(file), sourceHash);
          return { file, manifest, pid: ids[0], sourceHash };
        }
      }
    }
    await delay(250);
  } while (Date.now() < timeout);
  throw new Error('macOS open did not materialize the expected Quick Look document: ' + file);
}
assert.ok(!existsSync(reportPath), 'Use a new report path for this run.');
const report = { app, user: user.username, before, cancel: 'not exercised', opens: [] };
try {
  if (cancelFlag === '--cancel-first') {
    console.error('Cancel the first macOS confirmation in the disposable session.');
    let requestFailed = false;
    try {
      requestDefault(app, [family.macos.contentType, ...family.macos.aliases], family.extensions);
    } catch {
      requestFailed = true;
    }
    const afterCancel = snapshot();
    for (const extension of Object.keys(docs))
      assert.deepEqual(afterCancel[extension].handler, before[extension].handler);
    assert.ok(requestFailed, 'The first request was not declined.');
    report.cancel =
      'declined request preserved all handlers (system interaction observed by operator)';
  }
  console.error('macOS may require confirmation. Confirm this change in the disposable session.');
  requestDefault(app, [family.macos.contentType, ...family.macos.aliases], family.extensions);
  report.after = snapshot();
  for (const ext of family.extensions)
    assert.equal(realpathSync(report.after[ext].handler.path), app);
  assert.deepEqual(report.after.dna.handler, before.dna.handler);
  for (const file of Object.values(samples)) report.opens.push(await openThroughFinder(file));
  assert.equal(
    new Set(report.opens.map((open) => open.pid)).size,
    1,
    'Cold and warm files must reach the same process.'
  );
  report.openVerdict = 'passed';
} finally {
  try {
    const observed = snapshot();
    const restoredTypes = new Set();
    for (const [ext, prior] of Object.entries(before)) {
      if (
        observed[ext].handler?.path === prior.handler.path ||
        restoredTypes.has(prior.contentType)
      )
        continue;
      console.error('Confirm restoration to ' + prior.handler.path + ' if macOS asks.');
      requestDefault(prior.handler.path, [prior.contentType], [ext]);
      restoredTypes.add(prior.contentType);
    }
    report.restored = snapshot();
    for (const ext of Object.keys(docs))
      assert.deepEqual(report.restored[ext].handler, before[ext].handler);
    report.restoreVerdict = 'passed';
  } finally {
    writeFileSync(reportPath, JSON.stringify(report, null, 2), { flag: 'wx' });
  }
}
