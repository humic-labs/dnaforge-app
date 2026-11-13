#!/usr/bin/env node

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const os = require('node:os');
const {
  helperExecutableName,
  helperInstallNeedsFsync,
  helperPlatformSuffix,
} = require('./lib/verify-package-helpers.cjs');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const HELPERS_DIR = path.resolve(__dirname, '..', 'resources', 'helpers');
const DEFAULT_CARGO_TARGET_DIR = path.resolve(REPO_ROOT, '.cache', 'desktop-cargo-target');

function main() {
  const platform = os.platform();
  const arch = os.arch();
  const suffix = helperPlatformSuffix(platform, arch);
  const knownHelpers = ['dna-indexer', 'dna-coverage', 'dna-process-guardian'];
  const requestedHelpers = process.argv.slice(2);
  const helpers = requestedHelpers.length > 0 ? [...requestedHelpers] : [...knownHelpers];
  if (
    platform === 'win32' &&
    helpers.includes('dna-indexer') &&
    !helpers.includes('dna-process-guardian')
  ) {
    helpers.push('dna-process-guardian');
  }

  for (const helper of helpers) {
    if (!knownHelpers.includes(helper)) {
      throw new Error(
        `Unknown helper ${JSON.stringify(helper)}; expected one of: ${knownHelpers.join(', ')}`
      );
    }
  }

  for (const helper of helpers) {
    const extension = platform === 'win32' ? '.exe' : '';
    const dest = path.join(HELPERS_DIR, helperExecutableName(helper, platform, arch));
    const cargoTargetDir = process.env.CARGO_TARGET_DIR
      ? path.resolve(REPO_ROOT, process.env.CARGO_TARGET_DIR)
      : DEFAULT_CARGO_TARGET_DIR;

    console.log(`Building ${helper} for ${suffix}...`);
    const buildTarget = helper === 'dna-coverage' ? suffix : null;
    const cargoArgs = ['build', ...(buildTarget ? ['--locked', '--target', buildTarget] : []), '--release', '--bin', helper];
    execFileSync('cargo', cargoArgs, {
      cwd: REPO_ROOT,
      env: { ...process.env, CARGO_TARGET_DIR: cargoTargetDir },
      stdio: 'inherit',
    });

    const builtBinary = path.join(cargoTargetDir, ...(buildTarget ? [buildTarget] : []), 'release', `${helper}${extension}`);
    if (!fs.existsSync(builtBinary)) {
      throw new Error(`Expected built binary at ${builtBinary}; cargo build did not produce it`);
    }

    fs.mkdirSync(HELPERS_DIR, { recursive: true });
    if (helper === 'dna-coverage') {
      installCoverageWithReceipt(builtBinary, dest, platform, suffix);
    } else {
      installHelperAtomically(builtBinary, dest, platform);
    }

    console.log(`Built: ${dest}`);
  }
  console.log('');
  console.log('Next: `./scripts/download-binaries.sh` (sets up the full tools dir)');
  console.log('      or run electron-builder to bundle into the packaged .app.');
}

function installCoverageWithReceipt(source, destination, platform, target) {
  const staging = fs.mkdtempSync(path.join(HELPERS_DIR, '.coverage-build-'));
  const binary = path.join(staging, path.basename(destination));
  const receipt = path.join(staging, 'coverage-build-provenance.json');
  const producer = path.join(REPO_ROOT, 'scripts', 'coverage-helper-artifact.mjs');
  try {
    installHelperAtomically(source, binary, platform);
    execFileSync(process.execPath, [producer, 'create', target, binary, receipt], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
    installHelperAtomically(binary, destination, platform);
    const installedReceipt = path.join(HELPERS_DIR, 'coverage-build-provenance.json');
    installHelperAtomically(receipt, installedReceipt, platform, 0o644);
    execFileSync(process.execPath, [producer, 'verify', target, destination, installedReceipt], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function installHelperAtomically(source, destination, platform, mode = 0o755) {
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`
  );
  try {
    fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(temporary, mode);
    if (helperInstallNeedsFsync(platform)) {
      const handle = fs.openSync(temporary, 'r');
      try {
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
    }
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

try {
  main();
} catch (err) {
  console.error(err.message || err);
  process.exit(1);
}
