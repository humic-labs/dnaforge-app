#!/usr/bin/env node
'use strict';


const { createHash } = require('crypto');
const fs = require('fs');
const path = require('path');

const DESKTOP_DIR = path.resolve(__dirname, '..');
const CONTRACT_ROOT = path.resolve(
  DESKTOP_DIR,
  '..',
  '..',
  'packages',
  'core',
  'codex-app-server-contract'
);
const MANIFEST_PATH = path.join(CONTRACT_ROOT, 'src', 'manifest.json');

class CodexAppServerStageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CodexAppServerStageError';
    this.code = code;
  }
}

function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function targetKey(platform, arch) {
  return `${platform}-${arch}`;
}

function assertContained(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes its package root: ${candidate}`);
  }
}

function listFiles(root, dir = root) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(root, absolute));
    } else if (entry.isFile()) {
      files.push(path.relative(root, absolute).split(path.sep).join('/'));
    } else {
      throw new Error(`package resource is not a regular file: ${absolute}`);
    }
  }
  return files.sort();
}

function verifyInventory(packageRoot, target, platform) {
  if (!Array.isArray(target.resources) || target.resources.length === 0) {
    throw new Error(`manifest resource inventory is empty for ${target.triple}`);
  }

  const vendorRoot = path.join(packageRoot, 'vendor', target.triple);
  if (!fs.existsSync(vendorRoot)) {
    throw new Error(`expected vendored resource dir missing: ${vendorRoot}`);
  }

  const expected = target.resources
    .map((entry) => {
      if (
        typeof entry.pathInPackage !== 'string' ||
        !/^[0-9a-f]{64}$/.test(entry.sha256) ||
        typeof entry.executable !== 'boolean'
      ) {
        throw new Error(`invalid manifest resource entry for ${target.triple}`);
      }
      const absolute = path.resolve(packageRoot, entry.pathInPackage);
      assertContained(packageRoot, absolute, 'manifest resource');
      return {
        ...entry,
        absolute,
        relativeToVendor: path.relative(vendorRoot, absolute).split(path.sep).join('/'),
      };
    })
    .sort((a, b) => a.relativeToVendor.localeCompare(b.relativeToVendor, 'en'));

  const actualFiles = listFiles(vendorRoot);
  const expectedFiles = expected.map((entry) => entry.relativeToVendor);
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(
      `package resource inventory mismatch for ${target.triple}: ` +
        `expected ${expectedFiles.join(', ')}, got ${actualFiles.join(', ')}`
    );
  }

  for (const resource of expected) {
    const actual = sha256File(resource.absolute);
    if (actual !== resource.sha256) {
      throw new Error(
        `package resource digest mismatch for ${resource.pathInPackage}: ` +
          `expected ${resource.sha256}, got ${actual}`
      );
    }
    if (
      resource.executable &&
      platform !== 'win32' &&
      (fs.statSync(resource.absolute).mode & 0o111) === 0
    ) {
      throw new Error(`package resource is not executable: ${resource.absolute}`);
    }
  }

  return { vendorRoot, resources: expected };
}

function stageCodexAppServer(options) {
  const { platform, arch, manifest, searchRoots, resourcesRoot, licenseRoot } = options;
  const target = manifest.supportedTargets[targetKey(platform, arch)];
  if (!target) {
    throw new CodexAppServerStageError(
      'UNSUPPORTED_TARGET',
      `no manifest entry for supported build target ${platform}-${arch}`
    );
  }
  if (target.verified !== true) {
    throw new Error(`target ${platform}-${arch} is not verified in the manifest`);
  }

  const packageRoot = searchRoots
    .map((root) => path.resolve(root, target.aliasPackageName))
    .find((candidate) => fs.existsSync(candidate));
  if (!packageRoot) {
    throw new CodexAppServerStageError(
      'OPTIONAL_PACKAGE_MISSING',
      `installed package not found for ${platform}-${arch}: ${target.aliasPackageName}`
    );
  }

  const verified = verifyInventory(packageRoot, target, platform);
  const codexRoot = path.join(resourcesRoot, 'codex-app-server');
  const destination = path.join(codexRoot, target.triple);
  fs.rmSync(codexRoot, { recursive: true, force: true });
  fs.mkdirSync(codexRoot, { recursive: true });
  fs.cpSync(verified.vendorRoot, destination, {
    recursive: true,
    force: true,
    dereference: true,
  });

  for (const resource of verified.resources) {
    const staged = path.join(destination, resource.relativeToVendor);
    if (resource.executable && platform !== 'win32') {
      fs.chmodSync(staged, 0o755);
    }
    if (sha256File(staged) !== resource.sha256) {
      throw new Error(`staged resource digest mismatch: ${staged}`);
    }
  }

  for (const license of manifest.license.files) {
    const source = path.resolve(licenseRoot, license.path);
    assertContained(licenseRoot, source, 'license file');
    if (!fs.existsSync(source) || sha256File(source) !== license.sha256) {
      throw new Error(`license file is missing or changed: ${source}`);
    }
    fs.copyFileSync(source, path.join(codexRoot, path.basename(license.path)));
  }

  return destination;
}

function runCodexAppServerStaging(options) {
  try {
    return {
      status: 'staged',
      destination: stageCodexAppServer(options.stageOptions),
    };
  } catch (error) {
    const canSkip =
      options.bestEffort === true &&
      error instanceof CodexAppServerStageError &&
      (error.code === 'UNSUPPORTED_TARGET' || error.code === 'OPTIONAL_PACKAGE_MISSING');
    if (!canSkip) throw error;
    return { status: 'skipped', reason: error.message };
  }
}

function readManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(`manifest not found: ${MANIFEST_PATH}`);
  }
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}

function main() {
  const result = runCodexAppServerStaging({
    bestEffort: process.argv.includes('--best-effort'),
    stageOptions: {
      platform: process.platform,
      arch: process.arch,
      manifest: readManifest(),
      searchRoots: [
        path.resolve(DESKTOP_DIR, 'node_modules'),
        path.resolve(DESKTOP_DIR, '..', '..', 'node_modules'),
      ],
      resourcesRoot: path.resolve(DESKTOP_DIR, 'resources', 'binaries'),
      licenseRoot: CONTRACT_ROOT,
    },
  });
  if (result.status === 'skipped') {
    console.warn(`[stage-codex-app-server] optional runtime not staged: ${result.reason}`);
    return;
  }
  console.log(`[stage-codex-app-server] staged and verified ${result.destination}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(
      `[stage-codex-app-server] FATAL: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}

module.exports = {
  CodexAppServerStageError,
  runCodexAppServerStaging,
  stageCodexAppServer,
  verifyInventory,
};
