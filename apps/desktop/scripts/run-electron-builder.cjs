#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const APP_DIR = join(__dirname, '..');
const PKG = join(__dirname, '..', 'package.json');
const shell = process.platform === 'win32';

function run(command, args) {
  const executable = process.platform === 'win32' ? `${command}.cmd` : command;
  return spawnSync(executable, args, {
    stdio: 'inherit',
    shell,
  });
}

function optionPresent(args, option) {
  return args.some((argument) => argument === option || argument.startsWith(`${option}=`));
}

function resolveTargetArch(args, env = process.env, hostArch = process.arch) {
  for (const candidate of ['arm64', 'x64', 'ia32', 'armv7l']) {
    if (optionPresent(args, `--${candidate}`)) return candidate === 'armv7l' ? 'arm' : candidate;
  }
  return env.EB_ARCH || env.ARCH || env.npm_config_arch || hostArch;
}

function ensureDugiteRuntimeForPackage({
  args,
  env = process.env,
  execute = spawnSync,
  appDir = APP_DIR,
  hostArch = process.arch,
} = {}) {
  if (optionPresent(args, '--prepackaged')) return { skipped: true };

  const arch = resolveTargetArch(args, env, hostArch);
  const provisioner = join(appDir, 'scripts', 'ensure-dugite-git.cjs');
  const result = execute(process.execPath, [provisioner, '--arch', arch], {
    cwd: appDir,
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error || result.signal || result.status !== 0) {
    const detail = result.error?.message || result.signal || `exit ${result.status}`;
    const error = new Error(`bundled Git readiness failed for ${arch}: ${detail}`);
    error.exitCode = result.status ?? 1;
    throw error;
  }
  return { skipped: false, arch };
}

function main(scriptArgs = process.argv.slice(2)) {
  const before = readFileSync(PKG);
  let result;
  try {
    ensureDugiteRuntimeForPackage({ args: scriptArgs });

    result = run('pnpm', ['exec', 'electron-builder', ...scriptArgs]);
  } catch (error) {
    console.error(`[run-electron-builder] ${error.message}`);
    result = { status: error.exitCode ?? 1, error };
  }

  if (result.error && result.error.code === 'ENOENT') {
    console.error(
      '[run-electron-builder] pnpm is required for package collection but was not found. ' +
        'Install the root packageManager toolchain; refusing the unsafe npx/npm fallback.'
    );
  }

  try {
    const after = readFileSync(PKG);
    if (!before.equals(after)) {
      writeFileSync(PKG, before);
      console.warn(
        '[run-electron-builder] restored source package.json — electron-builder ' +
          'rewrote it in place ().'
      );
    }
  } catch (error) {
    console.error('[run-electron-builder] failed to restore package.json:', error.message);
    return result.status === 0 ? 1 : (result.status ?? 1);
  }

  return result.status ?? (result.error ? 1 : 0);
}

if (require.main === module) process.exit(main());

module.exports = {
  ensureDugiteRuntimeForPackage,
  main,
  optionPresent,
  resolveTargetArch,
};
