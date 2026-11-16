import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
const sourceRoot = fileURLToPath(new URL('../../../', import.meta.url));
const builder = 'apps/desktop/scripts/build-ngs-tools.mjs';
const verifier = 'apps/desktop/scripts/lib/ngs-tools.cjs';
const nativeVerifier = 'apps/desktop/scripts/lib/native-binary.cjs';
const lock = '.ci/ngs-tools-source.lock.json';
const closure = [builder, verifier, nativeVerifier, lock];
const sentinel = 'NGS_RECIPE_PRE_DOWNLOAD_STOP';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'public-ngs-recipe-')));
  roots.push(root);
  const repository = join(root, 'repository');
  const originals = new Map(closure.map(name => [name, readFileSync(join(sourceRoot, name))]));
  for (const [name, bytes] of originals) {
    mkdirSync(dirname(join(repository, name)), { recursive: true });
    writeFileSync(join(repository, name), bytes);
  }
  const preload = join(root, 'boundary.cjs');
  writeFileSync(preload, `
const fs = require('node:fs');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const os = require('node:os');
const { syncBuiltinESMExports } = require('node:module');
const record = event => fs.appendFileSync(process.env.NGS_RECIPE_TRACE, JSON.stringify(event) + '\\n');
const read = fs.readFileSync;
fs.readFileSync = function(file, ...options) {
  record({ type: 'read', file: String(file) });
  return read.call(this, file, ...options);
};
const createHash = crypto.createHash;
crypto.createHash = function(...options) {
  const hash = createHash.apply(this, options);
  const update = hash.update;
  hash.update = function(bytes, ...rest) {
    if (typeof bytes === 'string' && bytes.startsWith('{')) {
      let recipe;
      try { recipe = JSON.parse(bytes); } catch {}
      if (recipe?.profile === 'local-bam-v1' && recipe.builderSha256)
        record({ type: 'recipe', recipe,
          recipeKey: createHash('sha256').update(bytes).digest('hex') });
    }
    return update.call(this, bytes, ...rest);
  };
  return hash;
};
Object.defineProperty(process, 'platform', { value: 'darwin' });
os.arch = () => 'arm64';
childProcess.execFileSync = function(command, args) {
  record({ type: 'command', command, args });
  if (command === '/usr/bin/xcrun') {
    const query = args.join(' ');
    if (query === '--sdk macosx --find clang') return '/fixture-toolchain/clang\\n';
    if (query === '--sdk macosx --show-sdk-path') return '/fixture-sdk\\n';
    if (query === '--sdk macosx --show-sdk-build-version') return 'fixture-sdk-build\\n';
  }
  if (command === '/fixture-toolchain/clang' && args.join(' ') === '--version')
    return 'fixture-clang-version\\n';
  if (command === '/usr/bin/curl') throw new Error(${JSON.stringify(sentinel)});
  throw new Error('Unexpected recipe-boundary subprocess: ' + command);
};
syncBuiltinESMExports();
`);
  const observe = (name, changed) => {
    for (const [file, bytes] of originals)
      writeFileSync(join(repository, file), file === changed ? Buffer.concat([bytes, Buffer.from('\n')]) : bytes);
    const trace = join(root, name + '.jsonl');
    const result = spawnSync(process.execPath, ['--require', preload, join(repository, builder),
      '--arch', 'arm64', '--output-dir', join(root, name + '-output'),
      '--cache-dir', join(root, name + '-cache')], {
      env: { PATH: process.env.PATH, NGS_RECIPE_TRACE: trace }, encoding: 'utf8',
      timeout: 5000, maxBuffer: 64 * 1024,
    });
    const events = existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
    const hashes = Object.fromEntries(closure.map(file => [file, sha256(readFileSync(join(repository, file)))]));
    return { name, result, events, hashes };
  };
  return { repository, observe };
}

test('the public NGS builder fingerprints its public recipe before the first download', t => {
  const current = fixture();
  const observations = [current.observe('baseline'),
    ...closure.map((file, index) => current.observe('changed-' + index, file))];
  t.diagnostic(JSON.stringify(observations.map(({ name, result, events }) => ({
    name, exitCode: result.status,
    stop: result.stderr.includes(sentinel) ? sentinel : result.stderr.match(/ENOENT[^\n]*/u)?.[0] ?? result.error?.message,
    recipes: events.filter(event => event.type === 'recipe').length,
    curlCalls: events.filter(event => event.type === 'command' && event.command === '/usr/bin/curl').length,
  }))));
  for (const observed of observations) {
    assert.equal(observed.result.error, undefined);
    assert.equal(observed.result.status, 1);
    assert.match(observed.result.stderr, new RegExp(sentinel, 'u'));
    const records = observed.events.filter(event => event.type === 'recipe');
    assert.equal(records.length, 1);
    const expected = {
      target: 'aarch64-apple-darwin', profile: 'local-bam-v1',
      builderSha256: observed.hashes[builder], verifierSha256: observed.hashes[verifier],
      nativeBinaryVerifierSha256: observed.hashes[nativeVerifier], sourceLockSha256: observed.hashes[lock],
      compiler: 'fixture-clang-version', sdk: 'fixture-sdk-build', deploymentTarget: '12.0',
    };
    assert.deepEqual(records[0].recipe, expected);
    assert.equal(records[0].recipeKey, sha256(JSON.stringify(expected)));
    const commands = observed.events.filter(event => event.type === 'command');
    assert.equal(commands.at(-1).command, '/usr/bin/curl');
    assert.equal(commands.filter(event => event.command === '/usr/bin/curl').length, 1);
    const privateInputs = ['.github/workflows/ngs-tools-build.yml', 'scripts/verify-owned-ngs-tools.py'];
    for (const relative of privateInputs) {
      assert.equal(existsSync(join(current.repository, relative)), false);
      assert.ok(!observed.events.some(event => event.type === 'read' && event.file === join(current.repository, relative)));
    }
  }
  const keys = observations.map(observed => observed.events.find(event => event.type === 'recipe').recipeKey);
  assert.equal(new Set(keys).size, closure.length + 1);
});
