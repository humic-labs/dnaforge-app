#!/usr/bin/env node

const { execSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { isAbiError } = require('./native-abi-patterns.cjs');
const { strictRuntimeAbiError } = require('./native-abi-verification-policy.cjs');

function runtimeAbiVerify(electronPath, targetBsqlDir) {
  const probe =
    `try { new (require(${JSON.stringify(targetBsqlDir)}))(':memory:').prepare('SELECT 1').get(); } ` +
    `catch (e) { process.stderr.write('ABI_PROBE_FAIL ' + (e && e.message ? e.message : String(e))); process.exit(3); } ` +
    `process.exit(0);`;

  const res = spawnSync(electronPath, ['-e', probe], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  if (res.error) return 'inconclusive';
  if (res.status === 0) return 'pass';
  const out = `${res.stdout || ''}\n${res.stderr || ''}`;
  if (isAbiError(out)) return 'abi-fail';
  return 'inconclusive';
}

if (process.env.CI && !process.env.EXPLICIT_REBUILD) {
  console.log(
    '[rebuild-native] CI detected without EXPLICIT_REBUILD — skipping postinstall (explicit rebuild step handles this)'
  );
  process.exit(0);
}

const monoRoot = path.resolve(__dirname, '..', '..', '..');
console.log('[rebuild-native] monorepo root:', monoRoot);

function detectHardwareArch() {
  if (os.platform() === 'darwin') {
    try {
      const val = execSync('sysctl -n hw.optional.arm64 2>/dev/null', {
        encoding: 'utf8',
      }).trim();
      if (val === '1') return 'arm64';
    } catch {}
  }
  if (os.platform() === 'win32') {
    return process.arch === 'x64' ? 'x86_64' : process.arch;
  }

  try {
    return execSync('uname -m', { encoding: 'utf8' }).trim();
  } catch {
    return process.arch === 'x64' ? 'x86_64' : process.arch;
  }
}

const hwArch = process.env.ARCH || detectHardwareArch();

const targetArch =
  process.env.ARCH || (hwArch === 'x86_64' ? 'x64' : hwArch === 'aarch64' ? 'arm64' : hwArch);

const expectedFileString = targetArch === 'arm64' ? 'arm64' : 'x86_64';

console.log(`[rebuild-native] hardware: ${hwArch} → target: ${targetArch}`);
require('./prepare-terminal-native.cjs').prepareTerminalNative(monoRoot, targetArch);

let electronVersion;
try {
  const epkg = require(path.join(monoRoot, 'node_modules/electron/package.json'));
  electronVersion = epkg.version;
} catch {
  try {
    electronVersion = execSync('npx electron --version', { encoding: 'utf8' })
      .trim()
      .replace('v', '');
  } catch {
    console.error('[rebuild-native] FATAL: cannot determine Electron version');
    process.exit(1);
  }
}
console.log(`[rebuild-native] Electron version: ${electronVersion}`);

let bsqlDir;

const hoistedPath = path.join(monoRoot, 'node_modules', 'better-sqlite3');
if (fs.existsSync(path.join(hoistedPath, 'binding.gyp'))) {
  bsqlDir = hoistedPath;
} else {
  try {
    const found = execSync(
      'find node_modules/.pnpm -path "*/better-sqlite3/binding.gyp" -not -path "*/@types/*" 2>/dev/null',
      { encoding: 'utf8', cwd: monoRoot }
    ).trim();
    if (found) {
      bsqlDir = path.dirname(path.join(monoRoot, found.split('\n')[0]));
    }
  } catch {}
}

if (!bsqlDir || !fs.existsSync(bsqlDir)) {
  console.error('[rebuild-native] FATAL: cannot find better-sqlite3 in node_modules');
  process.exit(1);
}
console.log(`[rebuild-native] better-sqlite3 at: ${bsqlDir}`);

let electronPath = null;
try {
  const resolved = require(path.join(monoRoot, 'node_modules', 'electron'));
  if (typeof resolved === 'string') electronPath = resolved;
} catch {}
let canRuntimeVerify = false;
if (electronPath && fs.existsSync(electronPath)) {
  const runtime = spawnSync(electronPath, ['-p', 'process.arch'], {
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  canRuntimeVerify = runtime.status === 0 && runtime.stdout.trim() === targetArch;
}
const strictRuntimeAbiVerify = process.env.REQUIRE_ELECTRON_ABI_VERIFY === '1';

if (canRuntimeVerify && runtimeAbiVerify(electronPath, bsqlDir) === 'pass') {
  console.log(
    '[rebuild-native] ✅ better-sqlite3 already loads under Electron ABI — skipping rebuild'
  );
  process.exit(0);
}

function binCommand(name) {
  return os.platform() === 'win32' ? `${name}.cmd` : name;
}

function resolveBin(binDir, name) {
  const names = os.platform() === 'win32' ? [`${name}.cmd`, name] : [name];
  return (
    names
      .map((candidate) => path.join(binDir, candidate))
      .find((candidate) => fs.existsSync(candidate)) || null
  );
}

const hoistedPrebuild = resolveBin(path.join(monoRoot, 'node_modules', '.bin'), 'prebuild-install');
const isolatedPrebuild = resolveBin(path.join(bsqlDir, 'node_modules', '.bin'), 'prebuild-install');
const prebuildBin = hoistedPrebuild || isolatedPrebuild;

if (!prebuildBin) {
  console.error(
    '[rebuild-native] FATAL: prebuild-install not found in node_modules/.bin (checked isolated + hoisted paths)'
  );
  process.exit(1);
}
console.log(`[rebuild-native] prebuild-install at: ${prebuildBin}`);

const prebuildArgs = [
  '--runtime',
  'electron',
  '--target',
  electronVersion,
  '--arch',
  targetArch,
  '--verbose',
];
console.log(`[rebuild-native] running: ${prebuildBin} ${prebuildArgs.join(' ')}`);

const { execFileSync } = require('child_process');

function execTool(command, args, options) {
  const useShell = os.platform() === 'win32' && /\.cmd$/i.test(command);
  if (!useShell) {
    return execFileSync(command, args, options);
  }

  const result = spawnSync(command, args, { ...options, shell: true });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
  return result;
}

try {
  execTool(prebuildBin, prebuildArgs, { stdio: 'inherit', cwd: bsqlDir });
} catch (err) {
  console.error(
    '[rebuild-native] prebuild-install failed, trying @electron/rebuild as fallback...'
  );
  try {
    const rebuildArgs = [
      '@electron/rebuild',
      '--module-dir',
      path.join(monoRoot, 'apps', 'desktop'),
      '-f',
      '-o',
      'better-sqlite3',
      '--arch',
      targetArch,
      '--version',
      electronVersion,
    ];
    if (targetArch === 'x64' && os.platform() === 'darwin') {
      execFileSync('arch', ['-x86_64', 'npx', ...rebuildArgs], {
        stdio: 'inherit',
        cwd: monoRoot,
      });
    } else {
      execTool(binCommand('npx'), rebuildArgs, { stdio: 'inherit', cwd: monoRoot });
    }
  } catch {
    console.error('[rebuild-native] FATAL: both prebuild-install and @electron/rebuild failed');
    process.exit(1);
  }
}

const binaryPath = path.join(bsqlDir, 'build', 'Release', 'better_sqlite3.node');

if (!fs.existsSync(binaryPath)) {
  console.error(`[rebuild-native] FATAL: binary not found at ${binaryPath}`);
  process.exit(1);
}

if (os.platform() === 'win32') {
  console.log(
    '[rebuild-native] (skipping Unix file arch check on Windows; Electron ABI probe verifies loadability below)'
  );
} else {
  const fileOutput = execSync(`file "${binaryPath}"`, { encoding: 'utf8' }).trim();
  console.log(`[rebuild-native] binary: ${fileOutput}`);

  const archPatterns = targetArch === 'arm64' ? ['arm64', 'aarch64'] : ['x86_64', 'x86-64'];
  const archMatch = archPatterns.some((pat) => fileOutput.includes(pat));

  if (archMatch) {
    console.log(`[rebuild-native] ✅ VERIFIED: better_sqlite3.node is ${targetArch}`);
  } else {
    console.error(
      `[rebuild-native] ❌ ARCH MISMATCH: expected ${targetArch} (patterns: ${archPatterns.join(', ')})`
    );
    console.error(`[rebuild-native] This WILL crash Electron at runtime.`);
    process.exit(1);
  }
}

if (canRuntimeVerify) {
  const verdict = runtimeAbiVerify(electronPath, bsqlDir);
  if (verdict === 'pass') {
    console.log('[rebuild-native] ✅ ABI VERIFIED: better-sqlite3 loads + runs under Electron');
  } else if (verdict === 'abi-fail') {
    console.error(
      '[rebuild-native] ❌ ABI MISMATCH after prebuild-install — forcing a source rebuild'
    );

    try {
      fs.rmSync(binaryPath, { force: true });
    } catch {}
    try {
      execTool(
        binCommand('npx'),
        [
          '@electron/rebuild',
          '--module-dir',
          path.join(monoRoot, 'apps', 'desktop'),
          '-f',
          '-o',
          'better-sqlite3',
          '--arch',
          targetArch,
          '--version',
          electronVersion,
        ],
        { stdio: 'inherit', cwd: monoRoot }
      );
    } catch {
      console.error('[rebuild-native] FATAL: @electron/rebuild fallback failed after ABI mismatch');
      process.exit(1);
    }
    if (runtimeAbiVerify(electronPath, bsqlDir) !== 'pass') {
      console.error(
        '[rebuild-native] FATAL: better-sqlite3 still fails the Electron ABI check after rebuild'
      );
      process.exit(1);
    }
    console.log('[rebuild-native] ✅ ABI VERIFIED after @electron/rebuild');
  } else {
    const strictError = strictRuntimeAbiError({
      strict: strictRuntimeAbiVerify,
      canRuntimeVerify,
      verdict,
    });
    if (strictError) {
      console.error(`[rebuild-native] FATAL: ${strictError}`);
      process.exit(1);
    }
    console.warn(
      '[rebuild-native] ⚠️  could not run the Electron ABI probe (inconclusive) — arch check passed, proceeding'
    );
  }
} else {
  const strictError = strictRuntimeAbiError({
    strict: strictRuntimeAbiVerify,
    canRuntimeVerify,
    verdict: null,
  });
  if (strictError) {
    console.error(`[rebuild-native] FATAL: ${strictError}`);
    process.exit(1);
  }
  console.log(
    `[rebuild-native] (skipping Electron ABI probe: ${electronPath ? 'cross-arch build' : 'electron binary not found'})`
  );
}
