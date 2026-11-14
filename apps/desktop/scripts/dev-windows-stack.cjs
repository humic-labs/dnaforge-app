const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function windowsProcessIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid Windows process ID');
  try {
    return JSON.parse(
      execFileSync(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$ErrorActionPreference='Stop'; $p=Get-Process -Id ${pid}; @{pid=$p.Id; started=$p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString(); executable=$p.Path} | ConvertTo-Json -Compress`,
        ],
        { encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
      )
    );
  } catch {
    return null;
  }
}

function samePath(first, second) {
  return (
    typeof first === 'string' &&
    typeof second === 'string' &&
    path.resolve(first).toLowerCase() === path.resolve(second).toLowerCase()
  );
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function recordWindowsStack(appDir, guardian, pid, readIdentity = windowsProcessIdentity) {
  const identity = readIdentity(pid);
  if (
    !identity ||
    identity.pid !== pid ||
    !identity.started ||
    !samePath(identity.executable, guardian)
  ) {
    throw new Error('Cannot verify the newly started Windows process guardian');
  }
  const file = path.join(appDir, '.cache/windows-dev-stack.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ appDir, ...identity }), { mode: 0o600 });
}

function stopWindowsStack(
  appDir,
  guardian,
  { readIdentity = windowsProcessIdentity, kill = process.kill, alive = isAlive } = {}
) {
  const file = path.join(appDir, '.cache/windows-dev-stack.json');
  if (!fs.existsSync(file)) return null;
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (
    !samePath(saved.appDir, appDir) ||
    !samePath(saved.executable, guardian) ||
    !Number.isSafeInteger(saved.pid) ||
    saved.pid <= 0 ||
    typeof saved.started !== 'string'
  ) {
    throw new Error('Refusing to stop an unverified Windows dev stack');
  }
  const live = readIdentity(saved.pid);
  if (!live) {
    if (alive(saved.pid)) throw new Error('Cannot verify the running Windows process identity');
    return null;
  }
  if (
    live.pid !== saved.pid ||
    live.started !== saved.started ||
    !samePath(live.executable, guardian)
  ) {
    throw new Error('Refusing to stop a reused Windows process ID');
  }
  kill(saved.pid, 'SIGTERM');
  return saved.pid;
}

module.exports = { windowsProcessIdentity, recordWindowsStack, stopWindowsStack };
