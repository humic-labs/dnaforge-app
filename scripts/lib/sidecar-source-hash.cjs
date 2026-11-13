'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const GENERATED_IDENTITY_PATH = 'apps/api/src/_frozen_build_identity.py';
const API_SOURCE_PREFIX = 'apps/api/src/';
const ANNOTATION_SOURCE_PREFIX = 'packages/annotation/src/';
const REQUIRED_SIDECAR_SOURCE_INPUTS = Object.freeze([
  'apps/api/src',
  'apps/api/run_server.py',
  'apps/api/pyproject.toml',
  'apps/api/uv.lock',
  'apps/api/scripts/build-sidecar.sh',
  'apps/api/scripts/pysam.nuitka-package.config.yml',
  'apps/api/scripts/sync-python-dependencies.sh',
  'apps/api/scripts/verify_sidecar_architecture.py',
  'packages/core/agent-tools',
  'packages/core/compute-endpoints/manifests',
  'packages/annotation/src',
  'packages/annotation/pyproject.toml',
  'scripts/lib/sidecar-source-hash.cjs',
  'scripts/sidecar-build-receipt.cjs',
  'scripts/python-runtime-security.cjs',
  'scripts/ci-setup-secure-python.mjs',
  '.ci/python-runtime-security.json',
]);
const REQUIRED_SIDECAR_SOURCE_INPUT_KINDS = Object.freeze({
  'apps/api/src': 'directory',
  'apps/api/run_server.py': 'file',
  'apps/api/pyproject.toml': 'file',
  'apps/api/uv.lock': 'file',
  'apps/api/scripts/build-sidecar.sh': 'file',
  'apps/api/scripts/pysam.nuitka-package.config.yml': 'file',
  'apps/api/scripts/sync-python-dependencies.sh': 'file',
  'apps/api/scripts/verify_sidecar_architecture.py': 'file',
  'packages/core/agent-tools': 'directory',
  'packages/core/compute-endpoints/manifests': 'directory',
  'packages/annotation/src': 'directory',
  'packages/annotation/pyproject.toml': 'file',
  'scripts/lib/sidecar-source-hash.cjs': 'file',
  'scripts/sidecar-build-receipt.cjs': 'file',
  'scripts/python-runtime-security.cjs': 'file',
  'scripts/ci-setup-secure-python.mjs': 'file',
  '.ci/python-runtime-security.json': 'file',
});
const ALLOWED_NON_RUNTIME_SYMLINKS = new Set(['packages/core/agent-tools/AGENTS.md']);
const SIDECAR_SOURCE_HASH_LIMITS = Object.freeze({
  maxFiles: 4_096,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
});

function assertCanonicalSidecarSourceInputs(sourceInputs) {
  if (!Array.isArray(sourceInputs) || sourceInputs.length === 0) {
    throw new Error('sidecar source-input contract must contain at least one path');
  }
  const uniqueInputs = new Set();
  for (const entry of sourceInputs) {
    if (
      typeof entry !== 'string' ||
      entry.length === 0 ||
      path.posix.isAbsolute(entry) ||
      /^[a-zA-Z]:\//u.test(entry) ||
      path.posix.normalize(entry) !== entry ||
      entry.endsWith('/') ||
      entry.trim() !== entry ||
      /[\u0000-\u001f\u007f\\]/u.test(entry) ||
      entry.split('/').some((segment) => segment === '' || segment === '.' || segment === '..') ||
      uniqueInputs.has(entry)
    ) {
      throw new Error('sidecar source-input contract contains a non-canonical path');
    }
    uniqueInputs.add(entry);
  }
  const orderedInputs = [...uniqueInputs].sort();
  for (let index = 1; index < orderedInputs.length; index += 1) {
    if (orderedInputs[index].startsWith(`${orderedInputs[index - 1]}/`)) {
      throw new Error('sidecar source-input contract contains overlapping paths');
    }
  }
}

function assertRequiredSidecarSourceInputs(sourceInputs) {
  assertCanonicalSidecarSourceInputs(sourceInputs);
  if (
    sourceInputs.length !== REQUIRED_SIDECAR_SOURCE_INPUTS.length ||
    sourceInputs.some((entry, index) => entry !== REQUIRED_SIDECAR_SOURCE_INPUTS[index])
  ) {
    throw new Error('sidecar source-input contract does not match verifier-owned coverage');
  }
}

function stableIdentityMatches(left, right) {
  return ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'].every(
    (field) => left[field] === right[field]
  );
}

function relativeFromRoot(canonicalRepoRoot, target) {
  return path.relative(canonicalRepoRoot, target).split(path.sep).join('/');
}

function isGeneratedBuildArtifact(relative, stat) {
  if (relative === GENERATED_IDENTITY_PATH) return true;
  return (
    stat.isDirectory() &&
    (relative.startsWith(API_SOURCE_PREFIX) || relative.startsWith(ANNOTATION_SOURCE_PREFIX)) &&
    relative.split('/').includes('__pycache__')
  );
}

function assertAllowedGuidanceSymlink(canonicalRepoRoot, target, relative) {
  if (!ALLOWED_NON_RUNTIME_SYMLINKS.has(relative)) {
    throw new Error(`sidecar source input contains an unsupported symbolic link: ${relative}`);
  }
  const linkTarget = fs.readlinkSync(target);
  if (linkTarget !== 'CLAUDE.local.md') {
    throw new Error(`sidecar source guidance link has an invalid target: ${relative}`);
  }
  const resolvedTarget = path.join(path.dirname(target), linkTarget);
  const targetStat = fs.lstatSync(resolvedTarget, { bigint: true });
  if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
    throw new Error(`sidecar source guidance link target is not a regular file: ${relative}`);
  }
  const traversal = path.relative(canonicalRepoRoot, resolvedTarget);
  if (path.isAbsolute(traversal) || traversal === '..' || traversal.startsWith(`..${path.sep}`)) {
    throw new Error(`sidecar source guidance link target escapes the repository: ${relative}`);
  }
}

function collectFiles(canonicalRepoRoot, target, state, limits) {
  const stat = fs.lstatSync(target, { bigint: true });
  const relative = relativeFromRoot(canonicalRepoRoot, target);
  if (isGeneratedBuildArtifact(relative, stat)) return;
  if (stat.isSymbolicLink()) {
    assertAllowedGuidanceSymlink(canonicalRepoRoot, target, relative);
    state.files.push({ path: target, stat });
  } else if (stat.isFile()) {
    state.files.push({ path: target, stat });
  } else {
    if (!stat.isDirectory()) {
      throw new Error(`sidecar source input has an unsupported filesystem kind: ${relative}`);
    }
    state.directories.push({ path: target, stat });
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      collectFiles(canonicalRepoRoot, path.join(target, entry.name), state, limits);
    }
  }
  if (state.files.length > limits.maxFiles) {
    throw new Error(`sidecar source input exceeds the ${limits.maxFiles}-file limit`);
  }
}

function normalizedContent(buffer) {
  if (buffer.includes(0)) return buffer;
  try {
    return Buffer.from(UTF8_DECODER.decode(buffer).replace(/\r\n?/g, '\n'), 'utf8');
  } catch {
    return buffer;
  }
}

function boundedLimits(overrides = {}) {
  const limits = {};
  for (const key of ['maxFiles', 'maxFileBytes', 'maxTotalBytes']) {
    const value = overrides[key] ?? SIDECAR_SOURCE_HASH_LIMITS[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > SIDECAR_SOURCE_HASH_LIMITS[key]) {
      throw new Error(`sidecar source hash ${key} limit is invalid`);
    }
    limits[key] = value;
  }
  return limits;
}

function resolveDeclaredInput(canonicalRepoRoot, input) {
  let target = canonicalRepoRoot;
  const segments = input.split('/');
  for (const [index, segment] of segments.entries()) {
    target = path.join(target, segment);
    let stat;
    try {
      stat = fs.lstatSync(target, { bigint: true });
    } catch (error) {
      throw new Error(`sidecar source input is missing or unreadable: ${input}`, {
        cause: error,
      });
    }
    if (index < segments.length - 1) {
      if (stat.isSymbolicLink()) {
        throw new Error(`sidecar source input traverses a symbolic link: ${input}`);
      }
      if (!stat.isDirectory()) {
        throw new Error(`sidecar source input has a non-directory parent: ${input}`);
      }
    }
    if (index === segments.length - 1) {
      if (stat.isSymbolicLink()) {
        throw new Error(`sidecar source input may not be a symbolic link: ${input}`);
      }
      const requiredKind = REQUIRED_SIDECAR_SOURCE_INPUT_KINDS[input];
      if (
        (requiredKind === 'file' && !stat.isFile()) ||
        (requiredKind === 'directory' && !stat.isDirectory())
      ) {
        throw new Error(`sidecar source input has the wrong file kind: ${input}`);
      }
    }
  }
  return target;
}

function readBoundedRegularFile(file, collectedStat, limits) {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) throw new Error(`sidecar source input is not a regular file: ${file}`);
    if (!stableIdentityMatches(collectedStat, before)) {
      throw new Error(`sidecar source input changed before hashing: ${file}`);
    }
    if (before.size > BigInt(limits.maxFileBytes)) {
      throw new Error(`sidecar source input exceeds the per-file byte limit: ${file}`);
    }
    const content = Buffer.allocUnsafe(Number(before.size));
    let offset = 0;
    while (offset < content.length) {
      const bytesRead = fs.readSync(descriptor, content, offset, content.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (offset !== content.length || !stableIdentityMatches(before, after)) {
      throw new Error(`sidecar source input changed while hashing: ${file}`);
    }
    return normalizedContent(content);
  } finally {
    fs.closeSync(descriptor);
  }
}

function computeSidecarSourceHashForInputs(repoRoot, sourceInputs, options = {}) {
  assertCanonicalSidecarSourceInputs(sourceInputs);
  const limits = boundedLimits(options.limits);
  const canonicalRepoRoot = fs.realpathSync.native(path.resolve(repoRoot));
  const state = { directories: [], files: [] };
  for (const input of sourceInputs) {
    const target = resolveDeclaredInput(canonicalRepoRoot, input);
    const relativeTarget = path.relative(canonicalRepoRoot, target);
    if (
      relativeTarget.length === 0 ||
      path.isAbsolute(relativeTarget) ||
      relativeTarget.split(path.sep).includes('..')
    ) {
      throw new Error(`sidecar source input escapes the repository: ${input}`);
    }
    collectFiles(canonicalRepoRoot, target, state, limits);
  }
  state.files.sort((left, right) => {
    const leftRelative = path.relative(canonicalRepoRoot, left.path);
    const rightRelative = path.relative(canonicalRepoRoot, right.path);
    return leftRelative < rightRelative ? -1 : leftRelative > rightRelative ? 1 : 0;
  });
  if (state.files.length === 0) throw new Error('no sidecar source inputs were found');

  const hash = crypto.createHash('sha256');
  let totalBytes = 0;
  for (const entry of state.files) {
    const file = entry.path;
    const relative = path.relative(canonicalRepoRoot, file).split(path.sep).join('/');
    let content;
    if (entry.stat.isSymbolicLink()) {
      const before = fs.lstatSync(file, { bigint: true });
      const linkTarget = fs.readlinkSync(file);
      const after = fs.lstatSync(file, { bigint: true });
      if (!stableIdentityMatches(entry.stat, before) || !stableIdentityMatches(before, after)) {
        throw new Error(`sidecar source input changed while hashing: ${relative}`);
      }
      content = Buffer.from(`symlink:${linkTarget}`, 'utf8');
    } else {
      content = readBoundedRegularFile(file, entry.stat, limits);
    }
    if (content.length > limits.maxFileBytes) {
      throw new Error(`sidecar source input exceeds the per-file byte limit: ${relative}`);
    }
    totalBytes += content.length;
    if (totalBytes > limits.maxTotalBytes) {
      throw new Error(`sidecar source inputs exceed the aggregate byte limit`);
    }
    hash.update(relative);
    hash.update('\0');
    hash.update(String(content.length));
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  for (const directory of state.directories) {
    const after = fs.lstatSync(directory.path, { bigint: true });
    if (!stableIdentityMatches(directory.stat, after)) {
      throw new Error(
        `sidecar source directory changed while hashing: ${relativeFromRoot(
          canonicalRepoRoot,
          directory.path
        )}`
      );
    }
  }
  return { sourceHash: hash.digest('hex'), inputCount: state.files.length };
}

module.exports = {
  REQUIRED_SIDECAR_SOURCE_INPUTS,
  REQUIRED_SIDECAR_SOURCE_INPUT_KINDS,
  SIDECAR_SOURCE_HASH_LIMITS,
  assertCanonicalSidecarSourceInputs,
  assertRequiredSidecarSourceInputs,
  computeSidecarSourceHashForInputs,
};
