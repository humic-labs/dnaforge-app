#!/usr/bin/env node

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const desktopDir = path.resolve(__dirname, '..');
const apiDir = path.resolve(desktopDir, '..', 'api');
const repoRoot = path.resolve(desktopDir, '..', '..');
const sidecarExe = path.join(
  desktopDir,
  'resources',
  'binaries',
  'waypoint-api-x86_64-pc-windows-msvc',
  'waypoint-api.exe'
);

const sourceRoots = [
  path.join(apiDir, 'src'),
  path.join(apiDir, 'run_server.py'),
  path.join(apiDir, 'pyproject.toml'),
  path.join(apiDir, 'uv.lock'),
  path.join(apiDir, 'scripts', 'build-sidecar.sh'),
  path.join(repoRoot, 'scripts', 'python-runtime-security.cjs'),
  path.join(repoRoot, 'scripts', 'ci-setup-secure-python.mjs'),
  path.join(repoRoot, '.ci', 'python-runtime-security.json'),
  path.join(repoRoot, 'packages', 'core', 'agent-tools'),
  path.join(repoRoot, 'packages', 'core', 'compute-endpoints', 'manifests'),
  path.join(repoRoot, 'packages', 'annotation', 'src'),
  path.join(repoRoot, 'packages', 'annotation', 'pyproject.toml'),
];

function newestMtimeMs(targetPath) {
  if (!fs.existsSync(targetPath)) return 0;
  const stat = fs.statSync(targetPath);
  if (!stat.isDirectory()) return stat.mtimeMs;

  let newest = stat.mtimeMs;
  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    if (
      entry.name === '__pycache__' ||
      entry.name === '.pytest_cache' ||
      entry.name === '.venv' ||
      entry.name === 'build' ||
      entry.name === 'dist'
    ) {
      continue;
    }
    newest = Math.max(newest, newestMtimeMs(path.join(targetPath, entry.name)));
  }
  return newest;
}

function findGitBash() {
  const candidates = [
    process.env.GIT_BASH,
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    'bash',
  ].filter(Boolean);

  return candidates.find((candidate) => {
    if (candidate === 'bash') return true;
    return fs.existsSync(candidate);
  });
}

function commandWorks(command) {
  const result = spawnSync(command, ['--version'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  return !result.error && result.status === 0;
}

function findWindowsPython() {
  if (process.env.PYTHON && commandWorks(process.env.PYTHON)) {
    return process.env.PYTHON.replace(/\\/g, '/');
  }

  const where = spawnSync('where.exe', ['python'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const candidates =
    where.status === 0
      ? where.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
      : ['python'];

  const usable = candidates.find(
    (candidate) => !candidate.toLowerCase().includes('\\windowsapps\\') && commandWorks(candidate)
  );
  return (usable || 'python').replace(/\\/g, '/');
}

const force = process.argv.includes('--force');
const sidecarMtime = fs.existsSync(sidecarExe) ? fs.statSync(sidecarExe).mtimeMs : 0;
const sourceMtime = Math.max(...sourceRoots.map(newestMtimeMs));

if (!force && sidecarMtime > sourceMtime) {
  console.log('[build-windows-sidecar] Existing Windows sidecar is fresh.');
  process.exit(0);
}

const bash = findGitBash();
if (!bash) {
  console.error(
    '[build-windows-sidecar] Git Bash not found. Install Git for Windows or set GIT_BASH.'
  );
  process.exit(1);
}

console.log('[build-windows-sidecar] Building Windows sidecar...');
const python = findWindowsPython();
console.log(`[build-windows-sidecar] Using Python override: ${python}`);
const result = spawnSync(bash, ['scripts/build-sidecar.sh'], {
  cwd: apiDir,
  env: { ...process.env, PYTHON: python },
  stdio: 'inherit',
  windowsHide: true,
});

if (result.error) {
  console.error(`[build-windows-sidecar] Failed to launch Git Bash: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
