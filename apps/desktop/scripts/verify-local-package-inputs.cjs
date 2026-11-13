#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { receiptProblems } = require('../../../scripts/sidecar-build-receipt.cjs');
const { acquireHelperInputs, helperInputStatus } = require('./lib/local-helper-inputs.cjs');
const { helperExecutableName } = require('./lib/verify-package-helpers.cjs');

function normalizeArch(arch) {
  if (arch === 'arm64' || arch === 'aarch64') return 'arm64';
  if (arch === 'x64' || arch === 'x86_64' || arch === 'amd64') return 'x64';
  return null;
}

function defaultHostArch() {
  if (process.platform === 'darwin') {
    const probe = spawnSync('sysctl', ['-n', 'hw.optional.arm64'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0 && probe.stdout.trim() === '1') return 'arm64';
  }
  return normalizeArch(process.arch);
}

function sidecarSpec(platform, arch) {
  if (platform !== 'darwin') {
    throw new Error(`local desktop packaging is unsupported on ${platform}`);
  }
  if (arch === 'arm64') {
    return {
      directory: 'waypoint-api-aarch64-apple-darwin',
      executable: 'waypoint-api',
      target: 'aarch64-apple-darwin',
    };
  }
  if (arch === 'x64') {
    return {
      directory: 'waypoint-api-x86_64-apple-darwin',
      executable: 'waypoint-api',
      target: 'x86_64-apple-darwin',
    };
  }
  throw new Error(`unsupported local package architecture: ${arch || '<unknown>'}`);
}

function packageInputStatus({
  resourcesDir,
  platform,
  arch,
  repoRoot = path.resolve(__dirname, '../../..'),
  helperProbe,
  indexerContractProbe,
}) {
  const helpers = helperInputStatus({
    repoRoot,
    platform,
    arch,
    probe: helperProbe,
    indexerContractProbe,
  });
  const problems = [...helpers.problems];
  let needsSidecarBuild = false;
  let needsToolStage = false;
  const spec = sidecarSpec(platform, arch);
  const sidecarDirectory = path.join(resourcesDir, spec.directory);
  const sidecarExecutable = path.join(sidecarDirectory, spec.executable);

  if (!fs.existsSync(sidecarDirectory) || !fs.statSync(sidecarDirectory).isDirectory()) {
    problems.push(`missing current-architecture sidecar directory: ${sidecarDirectory}`);
    needsSidecarBuild = true;
  } else if (!fs.existsSync(sidecarExecutable) || !fs.statSync(sidecarExecutable).isFile()) {
    problems.push(`missing sidecar executable: ${sidecarExecutable}`);
    needsSidecarBuild = true;
  } else {
    try {
      fs.accessSync(sidecarExecutable, fs.constants.X_OK);
    } catch {
      problems.push(`sidecar executable is not executable: ${sidecarExecutable}`);
      needsSidecarBuild = true;
    }
    const receiptFailures = receiptProblems({
      repoRoot: repoRoot || path.resolve(__dirname, '../../..'),
      sidecarDir: sidecarDirectory,
      target: spec.target,
    });
    if (receiptFailures.length > 0) needsSidecarBuild = true;
    problems.push(...receiptFailures);
  }

  const entries = fs.existsSync(resourcesDir) ? fs.readdirSync(resourcesDir) : [];
  const fastp = path.join(
    path.dirname(resourcesDir),
    'helpers',
    helperExecutableName('fastp', platform, arch)
  );
  if (!fs.existsSync(fastp) || !fs.statSync(fastp).isFile()) {
    problems.push(`missing app-owned fastp helper: ${fastp}`);
    needsToolStage = true;
  }
  for (const requiredPrefix of ['blastn', 'makeblastdb', 'diamond', 'cmscan', 'mafft']) {
    if (!entries.some((entry) => entry.startsWith(requiredPrefix))) {
      problems.push(`missing bundled bioinformatics tool: ${requiredPrefix}`);
      needsToolStage = true;
    }
  }

  return { needsSidecarBuild, needsToolStage, problems };
}

function packageInputProblems(options) {
  return packageInputStatus(options).problems;
}

function defaultCommandRunner({ cwd, label, script }) {
  console.log(`[verify-local-package-inputs] ${label}`);
  const result = spawnSync('bash', [script], {
    cwd,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${String(result.status)}`);
  }
}

function acquirePackageInputs({
  resourcesDir,
  platform,
  arch,
  repoRoot,
  runCommand = defaultCommandRunner,
  helperProbe,
  indexerContractProbe,
  runGit,
}) {
  const inputOptions = {
    resourcesDir,
    platform,
    arch,
    repoRoot,
    helperProbe,
    indexerContractProbe,
  };

  const helpers = acquireHelperInputs(
    { repoRoot, platform, arch, probe: helperProbe, indexerContractProbe },
    { runGit }
  );
  let status = packageInputStatus(inputOptions);
  if (helpers.problems.length > 0) {
    return { ...status, problems: [...new Set([...helpers.problems, ...status.problems])] };
  }
  if (status.problems.length === 0) return status;

  if (status.needsToolStage) {
    runCommand({
      cwd: repoRoot,
      label: 'downloading verified bioinformatics tools',
      script: path.join(repoRoot, 'apps/desktop/scripts/download-binaries.sh'),
    });
    runCommand({
      cwd: repoRoot,
      label: 'staging bioinformatics tools',
      script: path.join(repoRoot, 'apps/desktop/scripts/prepare-bundle-binaries.sh'),
    });
    status = packageInputStatus(inputOptions);
  }

  if (status.needsSidecarBuild) {
    runCommand({
      cwd: path.join(repoRoot, 'apps/api'),
      label: 'building the exact current-source sidecar',
      script: path.join(repoRoot, 'apps/api/scripts/build-sidecar.sh'),
    });
  }

  return packageInputStatus(inputOptions);
}

function readOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function main(args = process.argv.slice(2)) {
  const platform = readOption(args, '--platform') || process.platform;
  const arch = normalizeArch(readOption(args, '--arch')) || defaultHostArch();
  const resourcesDir = path.resolve(
    readOption(args, '--resources-dir') || path.join(__dirname, '..', 'resources', 'binaries')
  );
  const repoRoot = path.resolve(__dirname, '../../..');
  let problems;
  try {
    problems = (args.includes('--acquire') ? acquirePackageInputs : packageInputStatus)({
      resourcesDir,
      platform,
      arch,
      repoRoot,
    }).problems;
  } catch (error) {
    console.error(`[verify-local-package-inputs] acquisition failed: ${error.message}`);
    return 1;
  }

  if (problems.length > 0) {
    console.error('[verify-local-package-inputs] FAILED before Electron packaging:');
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error('\nAcquire and verify the current local package inputs:');
    console.error('  node apps/desktop/scripts/verify-local-package-inputs.cjs --acquire');
    return 1;
  }

  console.log(
    `[verify-local-package-inputs] PASS: ${platform}-${arch} exact-source native helpers, sidecar and bioinformatics tools are staged`
  );
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = {
  acquirePackageInputs,
  defaultHostArch,
  normalizeArch,
  packageInputProblems,
  packageInputStatus,
  sidecarSpec,
};
