const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const verifier = fs.readFileSync(path.join(__dirname, 'verify-package.cjs'), 'utf8');
const start = verifier.indexOf('const OBSOLETE_MCP_COMPANION =');
const end = verifier.indexOf("console.log('\\n  [check 4]", start);
assert.ok(start > 0 && end > start, 'native SQLite verification section is present');
const section = verifier.slice(start, end);

function verify(t, { arch = 'arm64', entries = [], architectureError = false, abiError = false }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packaged-sqlite-layout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const unpacked = path.join(root, 'app.asar.unpacked');
  const sqlite = path.join(unpacked, 'node_modules', 'better-sqlite3');
  for (const entry of entries) {
    const file = path.join(sqlite, entry);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'fixture');
  }
  const electron = path.join(root, 'electron');
  fs.writeFileSync(electron, 'fixture');
  const result = { failures: [], warnings: [], architectures: [], probes: [] };
  vm.runInNewContext(section, {
    fs, path, process, console: { log() {} },
    APP_DIR: root,
    ASAR_UNPACKED: unpacked,
    MONOREPO_ROOT: root,
    targetPlatform: 'darwin', targetArch: arch, hostArch: arch,
    require: () => electron,
    ok() {}, fail: (message) => result.failures.push(message),
    warn: (message) => result.warnings.push(message),
    describeNativeBinary: (file) => {
      result.architectures.push(path.relative(sqlite, file));
      if (architectureError) throw new Error('binary architecture mismatch');
      return 'Mach-O fixture';
    },
    spawnSync: (command, args, options) => {
      assert.equal(command, electron);
      assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1');
      result.probes.push(args);
      return { status: abiError ? 3 : 0, stdout: '', stderr: abiError ? 'NODE_MODULE_VERSION mismatch' : '' };
    },
    isAbiError: (output) => output.includes('NODE_MODULE_VERSION'),
  });
  return result;
}

for (const arch of ['arm64', 'x64']) {
  test(`verifies the packaged SQLite 13 darwin-${arch} prebuild`, (t) => {
    const chosen = `prebuilds/darwin-${arch}.node`;
    const result = verify(t, { arch, entries: [chosen] });
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.architectures, [chosen]);
    assert.equal(result.probes.length, 1);
    assert.ok(result.probes[0][1].includes(chosen));
  });
}

test('retains support for the legacy rebuilt SQLite layout', (t) => {
  const chosen = 'build/Release/better_sqlite3.node';
  const result = verify(t, { entries: [chosen] });
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.architectures, [chosen]);
  assert.equal(result.probes.length, 1);
});

test('checks the runtime preferred prebuild when a stale legacy binary also exists', (t) => {
  const chosen = 'prebuilds/darwin-arm64.node';
  const result = verify(t, { entries: [chosen, 'build/Release/better_sqlite3.node'] });
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.architectures, [chosen]);
});

test('does not accept a prebuild for a different architecture', (t) => {
  const result = verify(t, { entries: ['prebuilds/darwin-x64.node'] });
  assert.ok(result.failures.length > 0);
  assert.deepEqual(result.probes, []);
});

test('keeps rejecting a selected binary with the wrong architecture', (t) => {
  const result = verify(t, { entries: ['prebuilds/darwin-arm64.node'], architectureError: true });
  assert.ok(result.failures.some((message) => message.includes('architecture mismatch')));
});

test('keeps rejecting a selected binary with an Electron ABI mismatch', (t) => {
  const result = verify(t, { entries: ['prebuilds/darwin-arm64.node'], abiError: true });
  assert.ok(result.failures.some((message) => message.includes('WRONG Node/Electron ABI')));
});
