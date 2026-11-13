'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { afterEach, describe, it } = require('node:test');
const {
  acquirePackageInputs: acquireInputs,
  packageInputProblems: inputProblems,
  sidecarSpec,
} = require('./verify-local-package-inputs.cjs');
const { SOURCE_INPUTS, writeReceipt } = require('../../../scripts/sidecar-build-receipt.cjs');

const {
  seedHelpers,
  helperProbe,
  indexerContractProbe,
} = require('./lib/local-helper-inputs.fixture.cjs');
const acquirePackageInputs = (options) =>
  acquireInputs({ ...options, helperProbe, indexerContractProbe });
const packageInputProblems = (options) =>
  inputProblems({ ...options, helperProbe, indexerContractProbe });

const temporaryDirectories = [];

function fixtureDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dnaforge-package-inputs-'));
  temporaryDirectories.push(directory);
  return directory;
}

function seedSourceInputs(repoRoot) {
  seedHelpers(repoRoot);
  for (const input of SOURCE_INPUTS) {
    const target = path.join(repoRoot, input);
    if (path.extname(input)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, input);
    } else {
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'fixture.txt'), input);
    }
  }
}

function seedValidInputs(repoRoot, resourcesDir, arch = 'arm64') {
  seedSourceInputs(repoRoot);
  seedSidecar(repoRoot, resourcesDir, arch);
  seedTools(resourcesDir);
}

function seedSidecar(repoRoot, resourcesDir, arch = 'arm64') {
  const spec = sidecarSpec('darwin', arch);
  const sidecarDirectory = path.join(resourcesDir, spec.directory);
  fs.mkdirSync(sidecarDirectory, { recursive: true });
  const executable = path.join(sidecarDirectory, spec.executable);
  fs.writeFileSync(executable, '#!/usr/bin/env bash\nexit 0\n');
  fs.chmodSync(executable, 0o755);
  writeReceipt({
    repoRoot,
    sidecarDir: sidecarDirectory,
    target: spec.target,
    pythonVersion: 'Python 3.12.10',
  });
}

function seedTools(resourcesDir) {
  fs.mkdirSync(resourcesDir, { recursive: true });
  const helpers = path.join(path.dirname(resourcesDir), 'helpers');
  fs.mkdirSync(helpers, { recursive: true });
  for (const target of ['aarch64-apple-darwin', 'x86_64-apple-darwin'])
    fs.writeFileSync(path.join(helpers, `fastp-${target}`), 'fixture');
  for (const tool of ['blastn', 'makeblastdb', 'diamond', 'cmscan', 'mafft']) {
    fs.writeFileSync(path.join(resourcesDir, tool), 'fixture');
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('local package input preflight', () => {
  it('runs before expensive work in every local package command and keeps full verification', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
    );
    for (const scriptName of ['package', 'package:dir', 'package:local']) {
      const script = packageJson.scripts[scriptName];
      assert.ok(
        script.indexOf('verify-local-package-inputs.cjs') < script.indexOf('rebuild-native.cjs'),
        `${scriptName} must preflight before native rebuild`
      );
      assert.doesNotMatch(script, /verify-package\.cjs --stamp-only/);
    }
    assert.doesNotMatch(packageJson.scripts.package, /verify-local-package-inputs\.cjs --acquire/);
    assert.match(packageJson.scripts['package:dir'], /verify-local-package-inputs\.cjs --acquire/);
    assert.match(
      packageJson.scripts['package:local'],
      /verify-local-package-inputs\.cjs --acquire/
    );
    assert.match(packageJson.scripts.postpackage, /verify-package\.cjs$/);
    assert.match(packageJson.scripts['package:dir'], /verify-package\.cjs$/);
    assert.match(packageJson.scripts['package:local'], /verify-package\.cjs$/);
  });

  it('acquires missing tools before building the exact current-source sidecar', () => {
    const repoRoot = fixtureDirectory();
    const resourcesDir = path.join(repoRoot, 'apps/desktop/resources/binaries');
    fs.mkdirSync(resourcesDir, { recursive: true });
    seedSourceInputs(repoRoot);
    const commands = [];

    const status = acquirePackageInputs({
      resourcesDir,
      platform: 'darwin',
      arch: 'arm64',
      repoRoot,
      runCommand: ({ label }) => {
        commands.push(label);
        if (label === 'staging bioinformatics tools') seedTools(resourcesDir);
        if (label === 'building the exact current-source sidecar') {
          seedSidecar(repoRoot, resourcesDir);
        }
      },
    });

    assert.deepEqual(commands, [
      'downloading verified bioinformatics tools',
      'staging bioinformatics tools',
      'building the exact current-source sidecar',
    ]);
    assert.deepEqual(status.problems, []);
  });

  it('rebuilds only the sidecar when its source-bound receipt is stale', () => {
    const repoRoot = fixtureDirectory();
    const resourcesDir = path.join(repoRoot, 'resources');
    fs.mkdirSync(resourcesDir);
    seedValidInputs(repoRoot, resourcesDir);
    fs.appendFileSync(path.join(repoRoot, 'apps/api/run_server.py'), 'changed');
    const commands = [];

    const status = acquirePackageInputs({
      resourcesDir,
      platform: 'darwin',
      arch: 'arm64',
      repoRoot,
      runCommand: ({ label }) => {
        commands.push(label);
        seedSidecar(repoRoot, resourcesDir);
      },
    });

    assert.deepEqual(commands, ['building the exact current-source sidecar']);
    assert.deepEqual(status.problems, []);
  });

  it('does no acquisition work when every package input is already current', () => {
    const repoRoot = fixtureDirectory();
    const resourcesDir = path.join(repoRoot, 'resources');
    fs.mkdirSync(resourcesDir);
    seedValidInputs(repoRoot, resourcesDir);

    const status = acquirePackageInputs({
      resourcesDir,
      platform: 'darwin',
      arch: 'arm64',
      repoRoot,
      runCommand: () => assert.fail('current inputs must not invoke acquisition'),
    });

    assert.deepEqual(status.problems, []);
  });

  it('accepts the exact target sidecar and all shipped bioinformatics tools', () => {
    const repoRoot = fixtureDirectory();
    const resourcesDir = path.join(repoRoot, 'resources');
    fs.mkdirSync(resourcesDir);
    seedValidInputs(repoRoot, resourcesDir);
    assert.deepEqual(
      packageInputProblems({ resourcesDir, platform: 'darwin', arch: 'arm64', repoRoot }),
      []
    );
  });

  it('rejects a foreign-architecture sidecar', () => {
    const repoRoot = fixtureDirectory();
    const resourcesDir = path.join(repoRoot, 'resources');
    fs.mkdirSync(resourcesDir);
    seedValidInputs(repoRoot, resourcesDir, 'x64');
    const problems = packageInputProblems({
      resourcesDir,
      platform: 'darwin',
      arch: 'arm64',
      repoRoot,
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /waypoint-api-aarch64-apple-darwin/);
  });

  it('rejects a missing executable and every absent tool in one fast pass', () => {
    const repoRoot = fixtureDirectory();
    const resourcesDir = path.join(repoRoot, 'resources');
    fs.mkdirSync(resourcesDir);
    seedSourceInputs(repoRoot);
    fs.mkdirSync(path.join(resourcesDir, 'waypoint-api-aarch64-apple-darwin'));
    const problems = packageInputProblems({
      resourcesDir,
      platform: 'darwin',
      arch: 'arm64',
      repoRoot,
    });
    assert.match(problems.join('\n'), /missing sidecar executable/);
    for (const tool of ['blastn', 'makeblastdb', 'diamond', 'cmscan', 'mafft']) {
      assert.match(problems.join('\n'), new RegExp(`missing bundled bioinformatics tool: ${tool}`));
    }
  });

  it('rejects a sidecar receipt after API source changes', () => {
    const repoRoot = fixtureDirectory();
    const resourcesDir = path.join(repoRoot, 'resources');
    fs.mkdirSync(resourcesDir);
    seedValidInputs(repoRoot, resourcesDir);
    fs.appendFileSync(path.join(repoRoot, 'apps/api/run_server.py'), 'changed');
    const problems = packageInputProblems({
      resourcesDir,
      platform: 'darwin',
      arch: 'arm64',
      repoRoot,
    });
    assert.match(problems.join('\n'), /source hash is stale/);
  });

  it('fails through the real CLI before build work and prints the remediation', () => {
    const resourcesDir = fixtureDirectory();
    const result = spawnSync(
      process.execPath,
      [
        path.join(__dirname, 'verify-local-package-inputs.cjs'),
        '--platform',
        'darwin',
        '--arch',
        'arm64',
        '--resources-dir',
        resourcesDir,
      ],
      { encoding: 'utf8' }
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /FAILED before Electron packaging/);
    assert.match(result.stderr, /verify-local-package-inputs\.cjs --acquire/);
  });
});
