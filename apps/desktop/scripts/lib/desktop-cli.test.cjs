const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { stageDesktopCli } = require('./desktop-cli.cjs');

test('the bundled command works by full path and symlink without a language runtime', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dnaforge-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resourcesDir = path.join(root, "App ' with $ spaces", 'Resources');
  const binary = path.join(resourcesDir, 'binaries/waypoint-api-aarch64-apple-darwin/waypoint-api');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, '#!/bin/sh\nprintf "%s\\n" "$@"\nexit 7\n', { mode: 0o755 });
  const launcher = stageDesktopCli({ resourcesDir, platform: 'darwin', arch: 'arm64' });
  const link = path.join(root, 'dnaforge');
  fs.symlinkSync(path.relative(root, launcher), link);
  for (const executable of [launcher, link]) {
    const result = spawnSync(
      executable,
      ['jobs', '--connection', "a path/'$() &.json", 'catalog'],
      {
        cwd: root,
        env: { PATH: '/usr/bin:/bin' },
        encoding: 'utf8',
        timeout: 5000,
      }
    );
    assert.equal(result.status, 7, result.stderr);
    assert.deepEqual(result.stdout.trimEnd().split('\n'), [
      '--cli',
      'jobs',
      '--connection',
      "a path/'$() &.json",
      'catalog',
    ]);
  }
});

test('packaging refuses an absent or unsupported target executable', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dnaforge-cli-missing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(
    () => stageDesktopCli({ resourcesDir: root, platform: 'darwin', arch: 'arm64' }),
    /executable/
  );
  assert.throws(
    () => stageDesktopCli({ resourcesDir: root, platform: 'win32', arch: 'arm64' }),
    /Unsupported/
  );
  assert.equal(fs.existsSync(path.join(root, 'cli')), false);
});

test('Windows packaging uses its bundled native executable and preserves command exit status', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dnaforge-cli-windows-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binary = path.join(root, 'binaries/waypoint-api-x86_64-pc-windows-msvc/waypoint-api.exe');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, 'target fixture');
  const launcher = stageDesktopCli({ resourcesDir: root, platform: 'win32', arch: 'x64' });
  assert.equal(path.basename(launcher), 'dnaforge.cmd');
  const contents = fs.readFileSync(launcher, 'utf8');
  assert.match(contents, /setlocal DisableDelayedExpansion/);
  assert.match(contents, /set "DNAFORGE_CLI_LAUNCHER=%~f0"/);
  assert.match(contents, /DNAFORGE_WINDOWS_SELF_REMOVE/);
  assert.match(contents, /if \/i not "%~1"=="uninstall-cli"/);
  assert.match(
    contents,
    /"%~dp0\.\.\\binaries\\waypoint-api-x86_64-pc-windows-msvc\\waypoint-api.exe" --cli %\*/
  );
  assert.match(contents, /if not "%_DNAFORGE_CLI_STATUS%"=="75" exit \/b %_DNAFORGE_CLI_STATUS%/);
  assert.match(contents, /del \/f \/q "%~f0"/);
  assert.match(contents, /if exist "%~f0" exit \/b 1/);
});
