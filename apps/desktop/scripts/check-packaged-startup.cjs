#!/usr/bin/env node

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isAbiError } = require('./native-abi-patterns.cjs');

const ABI_FATAL_MSG =
  'native addon ABI mismatch — better-sqlite3 compiled for the wrong Electron version; run: cd apps/desktop && node scripts/rebuild-native.cjs';

const args = process.argv.slice(2);

function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : null;
}

const archArg = getArg('--arch');
const timeoutMs = Number.parseInt(getArg('--timeout-ms') || '30000', 10);

const hwArch = (() => {
  try {
    const result = spawnSync('sysctl', ['-n', 'hw.optional.arm64'], { encoding: 'utf8' });
    return result.stdout.trim() === '1' ? 'arm64' : 'x64';
  } catch {
    return process.arch === 'arm64' ? 'arm64' : 'x64';
  }
})();

const targetArch = archArg || hwArch;
const builderDirSuffix = targetArch === 'arm64' ? '-arm64' : '';
const appRoot = path.join(
  __dirname,
  '..',
  'dist-electron',
  `mac${builderDirSuffix}`,
  'DNAForge.app'
);
const executable = path.join(appRoot, 'Contents', 'MacOS', 'DNAForge');

function fail(message, details) {
  console.error(`[check-packaged-startup] ❌ ${message}`);
  if (details) {
    console.error(details);
  }
  process.exit(1);
}

function ok(message) {
  console.log(`[check-packaged-startup] ✅ ${message}`);
}

if (!fs.existsSync(executable)) {
  fail(
    `packaged executable not found at ${executable}`,
    'Run: cd apps/desktop && npm run package:dir'
  );
}

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dnaforge-packaged-startup-'));
const logs = { stdout: '', stderr: '' };

const child = spawn(executable, [`--user-data-dir=${userDataDir}`, '--enable-logging'], {
  env: {
    ...process.env,
    ELECTRON_DISABLE_GPU: '1',
    NODE_ENV: 'test',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

child.stdout.on('data', (chunk) => {
  logs.stdout += chunk.toString();
});

child.stderr.on('data', (chunk) => {
  logs.stderr += chunk.toString();
});

let finished = false;

function cleanupAndExit(code, message) {
  if (finished) return;
  finished = true;
  try {
    child.kill('SIGKILL');
  } catch {}

  if (code === 0) {
    ok(message);
    process.exit(0);
  }

  const combined = `${logs.stdout}\n${logs.stderr}`.trim();
  fail(message, combined || '(no process output captured)');
}

child.on('error', (err) => {
  cleanupAndExit(1, `failed to launch packaged app: ${err.message}`);
});

const FATAL_PATTERNS = [
  { re: /ERR_MODULE_NOT_FOUND/, msg: 'ERR_MODULE_NOT_FOUND — missing JS package in asar' },
  { re: /Cannot find package/, msg: 'missing JS dependency in asar' },
  { re: /Cannot find module/, msg: 'missing JS module in asar' },
  {
    re: /\[DB\] FATAL/,
    msg: 'database initialization failed — check for RITM/Sentry bundling or wrong native module version',
  },
  { re: /Database failed to initialize/, msg: 'database initialization failed at startup' },
];

function checkFatalPatterns(combined) {
  if (isAbiError(combined)) return ABI_FATAL_MSG;
  for (const { re, msg } of FATAL_PATTERNS) {
    if (re.test(combined)) return msg;
  }
  return null;
}

child.on('exit', (code, signal) => {
  const combined = `${logs.stdout}\n${logs.stderr}`;
  const fatal = checkFatalPatterns(combined);
  if (fatal) {
    cleanupAndExit(1, `packaged app hit fatal error during startup: ${fatal}`);
    return;
  }

  if (code !== null && code !== 0) {
    cleanupAndExit(1, `packaged app exited early with code ${code}`);
    return;
  }

  if (signal) {
    cleanupAndExit(1, `packaged app exited early with signal ${signal}`);
  }
});

setTimeout(() => {
  const combined = `${logs.stdout}\n${logs.stderr}`;
  const fatal = checkFatalPatterns(combined);
  if (fatal) {
    cleanupAndExit(1, `packaged app hit fatal error during startup: ${fatal}`);
    return;
  }

  cleanupAndExit(0, `packaged app survived startup for ${timeoutMs}ms`);
}, timeoutMs);
