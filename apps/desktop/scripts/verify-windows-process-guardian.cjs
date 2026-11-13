#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const { existsSync, writeFileSync } = require('node:fs');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const guardian = resolve(process.argv[2] || '');
if (process.platform !== 'win32') {
  throw new Error('The Windows process guardian integration probe must run on Windows.');
}
if (!existsSync(guardian)) throw new Error(`Guardian executable is missing: ${guardian}`);

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

async function waitForMarker(path) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return JSON.parse(await readFile(path, 'utf8'));
    await delay(20);
  }
  throw new Error(`Timed out waiting for process marker: ${path}`);
}

function assertTreeAbsentAtSettlement(pids) {
  const survivors = pids.filter(processExists);
  if (survivors.length > 0) {
    throw new Error(`Guardian process tree survived settlement: ${survivors.join(', ')}`);
  }
}

async function waitForTreeAbsent(pids) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !processExists(pid))) return;
    await delay(20);
  }
  assertTreeAbsentAtSettlement(pids);
}

function waitForClose(child) {
  const closed = new Promise((resolveClose, rejectClose) => {
    child.once('error', rejectClose);
    child.once('close', (code, signal) => resolveClose({ code, signal }));
  });
  void closed.catch(() => {});
  return closed;
}

function launchGuardian(fixture, marker, mode, extraEnv = {}) {
  return spawn(guardian, ['--owner-pid', String(process.pid), '--', process.execPath, fixture], {
    env: {
      SystemRoot: process.env.SystemRoot,
      ComSpec: process.env.ComSpec,
      DNAFORGE_GUARDIAN_MARKER: marker,
      DNAFORGE_GUARDIAN_MODE: mode,
      PATH: '',
      ...extraEnv,
    },
    stdio: 'ignore',
    windowsHide: true,
  });
}

async function verifyPlaywrightElectronPrefix(root) {
  const electron = require('electron');
  const fixture = join(root, 'electron-launch.cjs');
  const marker = join(root, 'electron-ready.json');
  writeFileSync(
    fixture,
    String.raw`
const { app } = require('electron');
const { url } = require('node:inspector');
const { writeFileSync } = require('node:fs');
app.setPath('userData', process.env.DNAFORGE_GUARDIAN_FIXTURE_PROFILE);
app.whenReady().then(() => {
  writeFileSync(process.env.DNAFORGE_GUARDIAN_MARKER, JSON.stringify({
    pid: process.pid,
    parentPid: process.ppid,
    inspector: url(),
    remoteDebuggingPort: app.commandLine.getSwitchValue('remote-debugging-port'),
  }));
  app.quit();
}).catch(() => app.exit(2));
`
  );
  const child = spawn(
    guardian,
    [
      '--inspect=0',
      '--remote-debugging-port=0',
      '--owner-pid',
      String(process.pid),
      '--',
      electron,
      fixture,
    ],
    {
      env: {
        SystemRoot: process.env.SystemRoot,
        ComSpec: process.env.ComSpec,
        DNAFORGE_GUARDIAN_FIXTURE_PROFILE: root,
        DNAFORGE_GUARDIAN_MARKER: marker,
      },
      stdio: 'inherit',
      windowsHide: true,
    }
  );
  const deadline = setTimeout(() => child.kill('SIGKILL'), 15_000);
  try {
    const exit = await waitForClose(child);
    if (exit.code !== 0 || !existsSync(marker)) {
      throw new Error(`Guarded Electron did not reach readiness: ${JSON.stringify(exit)}`);
    }
    const observed = await waitForMarker(marker);
    const inspector = new URL(observed.inspector);
    if (
      !Number.isSafeInteger(observed.pid) ||
      observed.pid <= 0 ||
      observed.parentPid !== child.pid ||
      observed.remoteDebuggingPort !== '0' ||
      inspector.protocol !== 'ws:' ||
      !['127.0.0.1', '[::1]'].includes(inspector.hostname) ||
      Number(inspector.port) <= 0
    ) {
      throw new Error('Guarded Electron did not report the expected owner and debug settings.');
    }
    assertTreeAbsentAtSettlement([child.pid, observed.pid]);
    process.stdout.write(
      'PASS: Guarded Electron accepted the Playwright launch flags and exited.\n'
    );
  } finally {
    clearTimeout(deadline);
  }
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'dnaforge-process-guardian-'));
  const fixture = join(root, 'fixture.cjs');
  const ownerFixture = join(root, 'owner-fixture.cjs');
  const fixtureSource = String.raw`
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  detached: false,
  stdio: 'ignore',
});
writeFileSync(
  process.env.DNAFORGE_GUARDIAN_MARKER,
  JSON.stringify({ worker: process.pid, grandchild: grandchild.pid })
);
if (process.env.DNAFORGE_GUARDIAN_MODE === 'crash') setTimeout(() => process.exit(37), 0);
else setInterval(() => {}, 1000);
`;
  writeFileSync(fixture, fixtureSource);
  writeFileSync(
    ownerFixture,
    String.raw`
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const guardian = spawn(
  process.env.DNAFORGE_GUARDIAN_PATH,
  [
    '--owner-pid',
    String(process.pid),
    '--',
    process.execPath,
    process.env.DNAFORGE_GUARDIAN_FIXTURE,
  ],
  {
    env: {
      SystemRoot: process.env.SystemRoot,
      ComSpec: process.env.ComSpec,
      DNAFORGE_GUARDIAN_MARKER: process.env.DNAFORGE_GUARDIAN_MARKER,
      DNAFORGE_GUARDIAN_MODE: 'hang',
      PATH: '',
    },
    stdio: 'ignore',
    windowsHide: true,
  }
);
guardian.unref();
const deadline = Date.now() + 5000;
const wait = () => {
  if (existsSync(process.env.DNAFORGE_GUARDIAN_MARKER)) process.exit(0);
  if (Date.now() >= deadline) process.exit(2);
  setTimeout(wait, 20);
};
wait();
`
  );
  const cleanupPids = new Set();
  try {
    const killedMarker = join(root, 'guardian-killed.json');
    const killedGuardian = launchGuardian(fixture, killedMarker, 'hang');
    const killedClose = waitForClose(killedGuardian);
    const killedPids = await waitForMarker(killedMarker);
    cleanupPids.add(killedPids.worker);
    cleanupPids.add(killedPids.grandchild);
    process.kill(killedGuardian.pid, 'SIGKILL');
    await killedClose;
    assertTreeAbsentAtSettlement([killedPids.worker, killedPids.grandchild]);
    cleanupPids.delete(killedPids.worker);
    cleanupPids.delete(killedPids.grandchild);

    const crashMarker = join(root, 'worker-crashed.json');
    const crashGuardian = launchGuardian(fixture, crashMarker, 'crash');
    const crashClose = waitForClose(crashGuardian);
    const crashPids = await waitForMarker(crashMarker);
    cleanupPids.add(crashPids.worker);
    cleanupPids.add(crashPids.grandchild);
    const crashExit = await crashClose;
    if (crashExit.code !== 37) {
      throw new Error(`Guardian did not preserve worker exit 37: ${JSON.stringify(crashExit)}`);
    }
    assertTreeAbsentAtSettlement([crashPids.worker, crashPids.grandchild]);
    cleanupPids.delete(crashPids.worker);
    cleanupPids.delete(crashPids.grandchild);

    const ownerExitMarker = join(root, 'owner-exited.json');
    const owner = spawn(process.execPath, [ownerFixture], {
      env: {
        ...process.env,
        DNAFORGE_GUARDIAN_PATH: guardian,
        DNAFORGE_GUARDIAN_FIXTURE: fixture,
        DNAFORGE_GUARDIAN_MARKER: ownerExitMarker,
      },
      stdio: 'ignore',
      windowsHide: true,
    });
    const ownerClose = waitForClose(owner);
    const ownerExitPids = await waitForMarker(ownerExitMarker);
    cleanupPids.add(ownerExitPids.worker);
    cleanupPids.add(ownerExitPids.grandchild);
    const ownerExit = await ownerClose;
    if (ownerExit.code !== 0) {
      throw new Error(`Owner fixture did not exit cleanly: ${JSON.stringify(ownerExit)}`);
    }
    await waitForTreeAbsent([ownerExitPids.worker, ownerExitPids.grandchild]);
    cleanupPids.delete(ownerExitPids.worker);
    cleanupPids.delete(ownerExitPids.grandchild);

    const failMarker = join(root, 'must-not-start.json');
    const failedGuardian = launchGuardian(fixture, failMarker, 'hang', {
      DNAFORGE_GUARDIAN_TEST_FAIL_BEFORE_SPAWN: '1',
    });
    const failedExit = await waitForClose(failedGuardian);
    if (failedExit.code === 0 || existsSync(failMarker)) {
      throw new Error('Forced Job Object setup failure did not fail before child spawn.');
    }
    process.stdout.write(
      'PASS: Windows Job Object guardian binds owner liveness and drains descendants.\n'
    );
    if (process.argv[3] === '--prove-playwright-prefix') {
      await verifyPlaywrightElectronPrefix(root);
    }
  } finally {
    for (const pid of cleanupPids) {
      if (!processExists(pid)) continue;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    await rm(root, { recursive: true, force: true });
  }
}

let settled = false;
process.once('beforeExit', () => {
  if (settled) return;
  process.stderr.write(
    'Windows guardian verification ended before its ownership checks settled.\n'
  );
  process.exitCode = 1;
});
main().then(
  () => {
    settled = true;
  },
  (error) => {
    settled = true;
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
);
