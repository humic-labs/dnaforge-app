const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { recordWindowsStack, stopWindowsStack } = require('./dev-windows-stack.cjs');

function fixture(t) {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-stack-'));
  t.after(() => fs.rmSync(appDir, { recursive: true, force: true }));
  const guardian = path.join(appDir, 'guardian.exe');
  const identity = { pid: 123, started: '987654321', executable: guardian };
  recordWindowsStack(appDir, guardian, identity.pid, () => identity);
  return { appDir, guardian, identity };
}

test('stops only the recorded guardian with the same creation time', (t) => {
  const { appDir, guardian, identity } = fixture(t);
  const killed = [];
  assert.equal(
    stopWindowsStack(appDir, guardian, {
      readIdentity: () => identity,
      kill: (...args) => killed.push(args),
    }),
    identity.pid
  );
  assert.deepEqual(killed, [[identity.pid, 'SIGTERM']]);
});

for (const field of ['pid', 'started', 'executable']) {
  test(`refuses a recycled PID or different executable: ${field}`, (t) => {
    const { appDir, guardian, identity } = fixture(t);
    assert.throws(
      () =>
        stopWindowsStack(appDir, guardian, {
          readIdentity: () => ({ ...identity, [field]: field === 'pid' ? 456 : 'other' }),
          kill: () => assert.fail('Must not terminate an unrelated process'),
        }),
      /reused Windows process ID/
    );
  });
}

test('refuses a receipt from another checkout', (t) => {
  const { appDir, guardian, identity } = fixture(t);
  fs.writeFileSync(
    path.join(appDir, '.cache/windows-dev-stack.json'),
    JSON.stringify({
      appDir: path.join(appDir, 'other'),
      ...identity,
    })
  );
  assert.throws(
    () =>
      stopWindowsStack(appDir, guardian, {
        kill: () => assert.fail('Must not terminate another checkout'),
      }),
    /unverified Windows dev stack/
  );
});

test('refuses a live process whose creation identity cannot be read', (t) => {
  const { appDir, guardian } = fixture(t);
  assert.throws(
    () =>
      stopWindowsStack(appDir, guardian, {
        readIdentity: () => null,
        alive: () => true,
        kill: () => assert.fail('Must not terminate an unverified process'),
      }),
    /Cannot verify the running Windows process identity/
  );
});
