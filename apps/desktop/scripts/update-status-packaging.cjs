const { mkdirSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { spawnSync } = require('node:child_process');
const { Arch } = require('builder-util');

function buildMacUpdateStatusHelper(context, desktopRoot, run = spawnSync) {
  if (context.electronPlatformName !== 'darwin') return;
  const arch = typeof context.arch === 'number' ? Arch[context.arch] : context.arch;
  const clangArch = arch === 'x64' ? 'x86_64' : arch;
  if (!['arm64', 'x86_64'].includes(clangArch))
    throw new Error(`Unsupported macOS updater-status architecture: ${arch}`);
  const output = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    'Contents/Helpers/dnaforge-update-status'
  );
  mkdirSync(dirname(output), { recursive: true });
  const result = run(
    '/usr/bin/xcrun',
    [
      'clang',
      '-fobjc-arc',
      '-fblocks',
      '-O2',
      '-mmacosx-version-min=12.0',
      join(desktopRoot, 'resources/helpers-src/dnaforge-update-status.m'),
      '-framework',
      'AppKit',
      '-arch',
      clangArch,
      '-o',
      output,
    ],
    { encoding: 'utf8' }
  );
  if (result.status !== 0)
    throw new Error(
      `Failed to build macOS updater-status helper: ${String(result.stderr ?? '').trim()}`
    );
  return output;
}
exports.buildMacUpdateStatusHelper = buildMacUpdateStatusHelper;
