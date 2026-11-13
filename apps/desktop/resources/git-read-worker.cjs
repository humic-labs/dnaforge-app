const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { constants } = require('node:fs');
const { lstat, mkdir, open, opendir, readlink, realpath, writeFile } = require('node:fs/promises');
const { basename, dirname, isAbsolute, join, relative, resolve, sep } = require('node:path');

const MAX_INPUT_CODE_UNITS = 262144;
const MAX_LOOSE_OBJECT_ENTRIES = 1000000;
const MAX_LOOSE_REF_FILE_BYTES = 1024 * 1024;
const MAX_LOOSE_REF_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_REFTABLE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_REFTABLE_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_PRIMARY_INDEX_BYTES = 64 * 1024 * 1024;
const MAX_SHARED_INDEX_BYTES = 64 * 1024 * 1024;
const NULL_EXIT_CODE = 3;
let input = '';
let activeGit = null;
let requestStarted = false;
let requestFinished = false;

function killActiveGit(signal) {
  if (!activeGit || activeGit.exitCode !== null || activeGit.signalCode !== null) return;
  try {
    activeGit.kill(signal);
  } catch {}
}

function terminateOwnedTreeAfterOwnerLoss() {
  if (requestFinished) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-process.pid, 'SIGKILL');
      return;
    } catch {}
  }
  killActiveGit('SIGKILL');
  process.exit(1);
}

function normalizeComparable(path) {
  const resolved = resolve(path);
  const normalized =
    resolved.length > 1 && resolved.endsWith(sep) ? resolved.slice(0, -1) : resolved;
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function samePath(left, right) {
  return normalizeComparable(left) === normalizeComparable(right);
}

function isInsideBoundary(candidate, boundary) {
  const candidatePath = normalizeComparable(candidate);
  const boundaryPath = normalizeComparable(boundary);
  const remainder = relative(boundaryPath, candidatePath);
  return (
    remainder === '' ||
    (remainder !== '..' && !remainder.startsWith('..' + sep) && !isAbsolute(remainder))
  );
}

function isInsideAnyBoundary(candidate, boundaries) {
  return boundaries.some((boundary) => isInsideBoundary(candidate, boundary));
}

async function resolveCanonicalTarget(target) {
  let ancestor = resolve(target);
  const missingSegments = [];
  for (;;) {
    try {
      const canonicalAncestor = await realpath(ancestor);
      return {
        canonicalPath: resolve(canonicalAncestor, ...missingSegments),
        existingAncestor: canonicalAncestor,
      };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      missingSegments.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

async function readOptionalStableText(filePath, maxBytes, label) {
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  let pathnameBefore;
  try {
    pathnameBefore = await lstat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (
    pathnameBefore.isSymbolicLink() ||
    !pathnameBefore.isFile() ||
    pathnameBefore.size > maxBytes
  ) {
    throw new Error(label + ' is not a bounded non-symlink regular file.');
  }
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | noFollow);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.size > maxBytes ||
      before.dev !== pathnameBefore.dev ||
      before.ino !== pathnameBefore.ino ||
      before.size !== pathnameBefore.size
    ) {
      throw new Error(label + ' is not a bounded regular file.');
    }
    const bytes = await readBoundedHandleBytes(handle, before, maxBytes, label);
    const contents = bytes.toString('utf8');
    const after = await handle.stat();
    const pathnameAfter = await lstat(filePath);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      pathnameAfter.isSymbolicLink() ||
      before.dev !== pathnameAfter.dev ||
      before.ino !== pathnameAfter.ino ||
      before.size !== pathnameAfter.size ||
      before.mtimeMs !== pathnameAfter.mtimeMs
    ) {
      throw new Error(label + ' changed during validation.');
    }
    return {
      path: filePath,
      contents,
      dev: before.dev,
      ino: before.ino,
      size: before.size,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } finally {
    await handle.close();
  }
}

async function readBoundedHandleBytes(handle, metadata, maxBytes, label) {
  if (!metadata.isFile() || metadata.size > maxBytes) {
    throw new Error(label + ' is not a bounded regular file.');
  }
  const bytes = Buffer.allocUnsafe(metadata.size);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (bytesRead === 0) throw new Error(label + ' ended during its bounded read.');
    offset += bytesRead;
  }
  const overflow = Buffer.allocUnsafe(1);
  const overflowRead = await handle.read(overflow, 0, 1, metadata.size);
  if (overflowRead.bytesRead !== 0) {
    throw new Error(label + ' exceeded its byte limit during validation.');
  }
  return bytes;
}

async function readBoundedDirectoryEntries(directoryPath, maxEntries, label) {
  const entries = [];
  const directory = await opendir(directoryPath);
  for await (const entry of directory) {
    if (entries.length >= maxEntries) {
      throw new Error(label + ' exceeds its entry limit.');
    }
    entries.push(entry);
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  return entries;
}

async function collectBoundedDirectoryAuthority(
  directoryPath,
  canonicalRoots,
  label,
  {
    recursive = false,
    maxEntries = 100000,
    hashFiles = false,
    maxFileBytes = MAX_LOOSE_REF_FILE_BYTES,
    maxTotalBytes = MAX_LOOSE_REF_TOTAL_BYTES,
  } = {}
) {
  let directoryMetadata;
  try {
    directoryMetadata = await lstat(directoryPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
    throw new Error(label + ' must be a non-symlink directory.');
  }
  const canonicalDirectory = await realpath(directoryPath);
  if (!isInsideAnyBoundary(canonicalDirectory, canonicalRoots)) {
    throw new Error('Path access denied: ' + label + ' ' + canonicalDirectory);
  }

  const authority = [];
  let remainingBytes = maxTotalBytes;
  const pending = [{ lexicalPath: directoryPath, relativePath: '' }];
  while (pending.length > 0) {
    const current = pending.pop();
    const entries = await readBoundedDirectoryEntries(
      current.lexicalPath,
      maxEntries - authority.length,
      label
    );
    for (const entry of entries) {
      if (authority.length >= maxEntries) {
        throw new Error(label + ' exceeds its entry limit.');
      }
      const lexicalPath = join(current.lexicalPath, entry.name);
      const relativePath = current.relativePath
        ? join(current.relativePath, entry.name)
        : entry.name;
      const metadata = await lstat(lexicalPath);
      if (metadata.isSymbolicLink()) {
        throw new Error(label + ' may not contain symbolic links: ' + relativePath);
      }
      if (!metadata.isDirectory() && !metadata.isFile()) {
        throw new Error(label + ' contains an unsupported entry: ' + relativePath);
      }
      const canonicalEntry = await realpath(lexicalPath);
      if (!isInsideAnyBoundary(canonicalEntry, canonicalRoots)) {
        throw new Error('Path access denied: ' + label + ' ' + canonicalEntry);
      }
      const receiptPath = relativePath.split(sep).join('/');
      if (metadata.isFile() && hashFiles) {
        const receipt = await collectStableBinaryPathAuthority(
          lexicalPath,
          canonicalRoots,
          label + ' file ' + receiptPath,
          Math.min(maxFileBytes, remainingBytes)
        );
        authority.push({
          path: receiptPath,
          type: 'file',
          dev: receipt.dev,
          ino: receipt.ino,
          size: receipt.size,
          sha256: receipt.sha256,
        });
        remainingBytes -= receipt.size;
      } else {
        authority.push({
          path: receiptPath,
          type: 'directory',
          dev: metadata.dev,
          ino: metadata.ino,
          size: metadata.size,
          mtimeMs: metadata.mtimeMs,
        });
      }
      if (recursive && metadata.isDirectory()) {
        pending.push({ lexicalPath, relativePath });
      }
    }
  }
  return {
    path: canonicalDirectory,
    dev: directoryMetadata.dev,
    ino: directoryMetadata.ino,
    entries: authority,
  };
}

async function collectOptionalPathAuthority(filePath, canonicalRoots, label) {
  let metadata;
  try {
    metadata = await lstat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(label + ' must be a non-symlink regular file.');
  }
  const canonicalPath = await realpath(filePath);
  if (!isInsideAnyBoundary(canonicalPath, canonicalRoots)) {
    throw new Error('Path access denied: ' + label + ' ' + canonicalPath);
  }
  return {
    path: canonicalPath,
    dev: metadata.dev,
    ino: metadata.ino,
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
  };
}

async function collectOptionalStableBinaryPathAuthority(filePath, canonicalRoots, label, maxBytes) {
  try {
    await lstat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  return collectStableBinaryPathAuthority(filePath, canonicalRoots, label, maxBytes);
}

async function collectSharedIndexAuthority(gitDir, canonicalRoots) {
  const names = [];
  const directory = await opendir(gitDir);
  let scannedEntries = 0;
  for await (const entry of directory) {
    scannedEntries += 1;
    if (scannedEntries > 100000) {
      throw new Error('Git directory exceeds its entry limit.');
    }
    if (!/^sharedindex\.[0-9a-f]{40,64}$/.test(entry.name)) continue;
    if (names.length >= 128) {
      throw new Error('Git shared-index inventory exceeds its entry limit.');
    }
    names.push(entry.name);
  }
  names.sort((left, right) => left.localeCompare(right));
  const authority = [];
  let remainingBytes = MAX_SHARED_INDEX_BYTES;
  for (const name of names) {
    const receipt = await collectStableBinaryPathAuthority(
      join(gitDir, name),
      canonicalRoots,
      'Git shared index',
      remainingBytes
    );
    authority.push(receipt);
    remainingBytes -= receipt.size;
  }
  return authority;
}

function assertGitConfigHasNoIncludes(receipt, label) {
  if (!receipt) return;
  const lines = receipt.contents.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = index === 0 ? lines[index].replace(/^\uFEFF/u, '') : lines[index];
    if (/^[ \t]*\[[ \t]*include(?:if)?(?=[ \t.\]"])/iu.test(line)) {
      throw new Error(label + ' may not include another config file.');
    }
  }
}

async function collectRepositoryConfigAuthority(gitDir, commonDirectory, canonicalRoots, maxBytes) {
  const collect = async (filePath, label) => {
    const receipt = await readOptionalStableText(filePath, maxBytes, label);
    if (!receipt) return null;
    const canonicalPath = await realpath(filePath);
    if (!isInsideAnyBoundary(canonicalPath, canonicalRoots)) {
      throw new Error('Path access denied: ' + label + ' ' + canonicalPath);
    }
    assertGitConfigHasNoIncludes(receipt, label);
    return {
      path: canonicalPath,
      contents: receipt.contents,
      dev: receipt.dev,
      ino: receipt.ino,
      size: receipt.size,
      sha256: receipt.sha256,
    };
  };
  return {
    common: await collect(join(commonDirectory, 'config'), 'Git repository config'),
    worktree: await collect(join(gitDir, 'config.worktree'), 'Git worktree config'),
  };
}

async function collectHeadAuthority(gitDir, commonDirectory, canonicalRoots, maxBytes) {
  const headPath = join(gitDir, 'HEAD');
  let pathnameBefore;
  try {
    pathnameBefore = await lstat(headPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!pathnameBefore.isSymbolicLink()) {
    return readOptionalStableText(headPath, maxBytes, 'Git HEAD');
  }

  const linkTarget = await readlink(headPath);
  if (!linkTarget || linkTarget.includes('\0')) {
    throw new Error('Git HEAD symbolic link is invalid.');
  }
  const targetPath = isAbsolute(linkTarget) ? linkTarget : resolve(dirname(headPath), linkTarget);
  const canonicalTarget = await realpath(targetPath);
  const admittedRefRoots = [join(commonDirectory, 'refs'), join(gitDir, 'refs')];
  if (!isInsideAnyBoundary(canonicalTarget, admittedRefRoots)) {
    throw new Error('Path access denied: Git HEAD target ' + canonicalTarget);
  }
  const target = await readOptionalStableText(canonicalTarget, maxBytes, 'Git HEAD target');
  if (!target) throw new Error('Git HEAD symbolic link target is missing.');
  const pathnameAfter = await lstat(headPath);
  if (
    !pathnameAfter.isSymbolicLink() ||
    pathnameAfter.dev !== pathnameBefore.dev ||
    pathnameAfter.ino !== pathnameBefore.ino ||
    pathnameAfter.size !== pathnameBefore.size ||
    pathnameAfter.mtimeMs !== pathnameBefore.mtimeMs ||
    (await readlink(headPath)) !== linkTarget ||
    !samePath(await realpath(headPath), canonicalTarget)
  ) {
    throw new Error('Git HEAD symbolic link changed during validation.');
  }
  return {
    type: 'legacy-symlink',
    path: headPath,
    dev: pathnameBefore.dev,
    ino: pathnameBefore.ino,
    size: pathnameBefore.size,
    mtimeMs: pathnameBefore.mtimeMs,
    linkTarget,
    target,
  };
}

async function collectStableBinaryPathAuthority(filePath, canonicalRoots, label, maxBytes) {
  const pathnameBefore = await lstat(filePath);
  if (
    pathnameBefore.isSymbolicLink() ||
    !pathnameBefore.isFile() ||
    pathnameBefore.size > maxBytes
  ) {
    throw new Error(label + ' must be a bounded non-symlink regular file.');
  }
  const canonicalPath = await realpath(filePath);
  if (!isInsideAnyBoundary(canonicalPath, canonicalRoots)) {
    throw new Error('Path access denied: ' + label + ' ' + canonicalPath);
  }
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const handle = await open(filePath, constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.size > maxBytes ||
      before.dev !== pathnameBefore.dev ||
      before.ino !== pathnameBefore.ino ||
      before.size !== pathnameBefore.size
    ) {
      throw new Error(label + ' changed while opening.');
    }
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, before.size - offset),
        offset
      );
      if (bytesRead === 0) throw new Error(label + ' ended during validation.');
      digest.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat();
    const pathnameAfter = await lstat(filePath);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      pathnameAfter.isSymbolicLink() ||
      pathnameAfter.dev !== before.dev ||
      pathnameAfter.ino !== before.ino ||
      pathnameAfter.size !== before.size ||
      !samePath(await realpath(filePath), canonicalPath)
    ) {
      throw new Error(label + ' changed during validation.');
    }
    return {
      path: canonicalPath,
      dev: before.dev,
      ino: before.ino,
      size: before.size,
      sha256: digest.digest('hex'),
    };
  } finally {
    await handle.close();
  }
}

function parseSingleMetadataPath(receipt, label) {
  if (!receipt || receipt.contents.includes('\0')) {
    throw new Error(label + ' is invalid.');
  }
  const lines = receipt.contents.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length !== 1 || !lines[0]) throw new Error(label + ' is invalid.');
  return lines[0];
}

async function collectObjectAuthority(objectDirectory, canonicalRoots, maxBytes, seen) {
  const objectDirectoryLinkMetadata = await lstat(objectDirectory);
  if (objectDirectoryLinkMetadata.isSymbolicLink()) {
    throw new Error('Git object directory may not be a symbolic link.');
  }
  const canonicalObjectDirectory = await realpath(objectDirectory);
  if (!isInsideAnyBoundary(canonicalObjectDirectory, canonicalRoots)) {
    throw new Error('Path access denied: Git object directory ' + canonicalObjectDirectory);
  }
  const objectDirectoryMetadata = await lstat(canonicalObjectDirectory);
  if (!objectDirectoryMetadata.isDirectory()) {
    throw new Error('Git object directory is not a directory.');
  }
  const comparable = normalizeComparable(canonicalObjectDirectory);
  if (seen.has(comparable)) return [];
  if (seen.size >= 64) throw new Error('Git object alternate graph is too large.');
  seen.add(comparable);

  const alternates = await readOptionalStableText(
    join(canonicalObjectDirectory, 'info', 'alternates'),
    maxBytes,
    'Git object alternates'
  );
  const httpAlternates = await readOptionalStableText(
    join(canonicalObjectDirectory, 'info', 'http-alternates'),
    maxBytes,
    'Git HTTP object alternates'
  );
  if (httpAlternates && httpAlternates.contents.trim().length > 0) {
    throw new Error('Git HTTP object alternates are not allowed for renderer reads.');
  }
  const objectFanout = await collectBoundedDirectoryAuthority(
    canonicalObjectDirectory,
    canonicalRoots,
    'Git object store',
    { maxEntries: 1024 }
  );
  const looseObjects = await collectLooseObjectAuthority(canonicalObjectDirectory, canonicalRoots);
  const packDirectory = await collectBoundedDirectoryAuthority(
    join(canonicalObjectDirectory, 'pack'),
    canonicalRoots,
    'Git pack directory',
    { maxEntries: 10000 }
  );

  const nested = [];
  if (alternates) {
    for (const rawLine of alternates.contents.split(/\r?\n/)) {
      if (!rawLine) continue;
      if (rawLine.includes('\0')) throw new Error('Git object alternates are invalid.');
      const alternatePath = isAbsolute(rawLine)
        ? rawLine
        : resolve(canonicalObjectDirectory, rawLine);
      nested.push(...(await collectObjectAuthority(alternatePath, canonicalRoots, maxBytes, seen)));
    }
  }
  return [
    {
      objectDirectory: canonicalObjectDirectory,
      dev: objectDirectoryMetadata.dev,
      ino: objectDirectoryMetadata.ino,
      objectFanout,
      looseObjects,
      packDirectory,
      alternates,
      httpAlternates,
    },
    ...nested,
  ];
}

async function collectLooseObjectAuthority(objectDirectory, canonicalRoots) {
  const rootEntries = await readBoundedDirectoryEntries(objectDirectory, 1024, 'Git object store');
  const fanoutNames = rootEntries
    .filter((entry) => /^[0-9a-f]{2}$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const fanouts = [];
  let totalEntries = 0;

  for (const fanoutName of fanoutNames) {
    const fanoutPath = join(objectDirectory, fanoutName);
    const before = await lstat(fanoutPath);
    if (before.isSymbolicLink() || !before.isDirectory()) {
      throw new Error(
        'Git loose object store must use non-symlink fanout directories: ' + fanoutName
      );
    }
    const canonicalFanout = await realpath(fanoutPath);
    if (!isInsideAnyBoundary(canonicalFanout, canonicalRoots)) {
      throw new Error('Path access denied: Git loose object store ' + canonicalFanout);
    }

    const entries = await readBoundedDirectoryEntries(
      fanoutPath,
      MAX_LOOSE_OBJECT_ENTRIES - totalEntries,
      'Git loose object store'
    );
    const digest = createHash('sha256');
    for (const entry of entries) {
      totalEntries += 1;
      if (totalEntries > MAX_LOOSE_OBJECT_ENTRIES) {
        throw new Error('Git loose object store exceeds its entry limit.');
      }
      const lexicalPath = join(fanoutPath, entry.name);
      const metadata = await lstat(lexicalPath);
      if (metadata.isSymbolicLink()) {
        throw new Error(
          'Git loose object store may not contain symbolic links: ' + fanoutName + '/' + entry.name
        );
      }
      if (!metadata.isFile()) {
        throw new Error(
          'Git loose object store contains an unsupported entry: ' + fanoutName + '/' + entry.name
        );
      }
      digest.update(
        JSON.stringify([entry.name, metadata.dev, metadata.ino, metadata.size, metadata.mtimeMs]) +
          '\0'
      );
    }

    const after = await lstat(fanoutPath);
    if (
      after.isSymbolicLink() ||
      !after.isDirectory() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw new Error('Git loose object fanout changed during validation: ' + fanoutName);
    }
    fanouts.push({
      path: fanoutName,
      dev: before.dev,
      ino: before.ino,
      size: before.size,
      mtimeMs: before.mtimeMs,
      entryCount: entries.length,
      digest: digest.digest('hex'),
    });
  }

  return { entryCount: totalEntries, fanouts };
}

async function collectMetadataAuthority(gitDir, canonicalRoots, maxBytes) {
  const commondir = await readOptionalStableText(
    join(gitDir, 'commondir'),
    maxBytes,
    'Git common-dir pointer'
  );
  const commonDirectoryPointer = commondir
    ? parseSingleMetadataPath(commondir, 'Git common-dir pointer')
    : null;
  const commonDirectory = commonDirectoryPointer
    ? await realpath(
        isAbsolute(commonDirectoryPointer)
          ? commonDirectoryPointer
          : resolve(gitDir, commonDirectoryPointer)
      )
    : gitDir;
  if (!isInsideAnyBoundary(commonDirectory, canonicalRoots)) {
    throw new Error('Path access denied: Git common directory ' + commonDirectory);
  }
  const commonDirectoryMetadata = await lstat(commonDirectory);
  if (!commonDirectoryMetadata.isDirectory()) {
    throw new Error('Git common directory is not a directory.');
  }
  if (!samePath(commonDirectory, gitDir)) {
    const nestedCommondir = await readOptionalStableText(
      join(commonDirectory, 'commondir'),
      maxBytes,
      'Nested Git common-dir pointer'
    );
    if (nestedCommondir) throw new Error('Nested Git common-dir pointers are not allowed.');
  }
  const objectDirectories = await collectObjectAuthority(
    join(commonDirectory, 'objects'),
    canonicalRoots,
    maxBytes,
    new Set()
  );
  const refs = await collectBoundedDirectoryAuthority(
    join(commonDirectory, 'refs'),
    canonicalRoots,
    'Git refs directory',
    { recursive: true, hashFiles: true }
  );
  const perWorktreeRefs = samePath(commonDirectory, gitDir)
    ? []
    : await Promise.all(
        ['bisect', 'rewritten', 'worktree'].map(async (namespace) => ({
          namespace,
          authority: await collectBoundedDirectoryAuthority(
            join(gitDir, 'refs', namespace),
            canonicalRoots,
            'Git per-worktree refs/' + namespace,
            { recursive: true, hashFiles: true }
          ),
        }))
      );
  const reftable = await collectBoundedDirectoryAuthority(
    join(commonDirectory, 'reftable'),
    canonicalRoots,
    'Git reftable directory',
    {
      recursive: true,
      maxEntries: 10000,
      hashFiles: true,
      maxFileBytes: MAX_REFTABLE_FILE_BYTES,
      maxTotalBytes: MAX_REFTABLE_TOTAL_BYTES,
    }
  );
  const worktreeReftable = samePath(commonDirectory, gitDir)
    ? null
    : await collectBoundedDirectoryAuthority(
        join(gitDir, 'reftable'),
        canonicalRoots,
        'Git worktree reftable directory',
        {
          recursive: true,
          maxEntries: 10000,
          hashFiles: true,
          maxFileBytes: MAX_REFTABLE_FILE_BYTES,
          maxTotalBytes: MAX_REFTABLE_TOTAL_BYTES,
        }
      );
  const head = await collectHeadAuthority(gitDir, commonDirectory, canonicalRoots, maxBytes);
  const packedRefs = await readOptionalStableText(
    join(commonDirectory, 'packed-refs'),
    maxBytes,
    'Git packed refs'
  );
  const index = await collectOptionalStableBinaryPathAuthority(
    join(gitDir, 'index'),
    canonicalRoots,
    'Git index',
    MAX_PRIMARY_INDEX_BYTES
  );
  const sharedIndexes = await collectSharedIndexAuthority(gitDir, canonicalRoots);
  const repositoryConfigs = await collectRepositoryConfigAuthority(
    gitDir,
    commonDirectory,
    canonicalRoots,
    maxBytes
  );
  return {
    gitDir,
    commonDirectory,
    commonDirectoryDev: commonDirectoryMetadata.dev,
    commonDirectoryIno: commonDirectoryMetadata.ino,
    commondir,
    head,
    packedRefs,
    refs,
    perWorktreeRefs,
    reftable,
    worktreeReftable,
    index,
    sharedIndexes,
    repositoryConfigs,
    objectDirectories,
  };
}

async function assertMetadataAuthorityUnchanged(expected, canonicalRoots, maxBytes) {
  const current = await collectMetadataAuthority(expected.gitDir, canonicalRoots, maxBytes);
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    const changedFields = Object.keys(expected).filter(
      (field) => JSON.stringify(current[field]) !== JSON.stringify(expected[field])
    );
    throw new Error(
      'Git metadata authority changed during the read transaction: ' + changedFields.join(', ')
    );
  }
}

async function copyStableBinaryAuthority(
  sourcePath,
  destinationPath,
  expected,
  canonicalRoots,
  label,
  maxBytes
) {
  const pathnameBefore = await lstat(sourcePath);
  if (
    pathnameBefore.isSymbolicLink() ||
    !pathnameBefore.isFile() ||
    pathnameBefore.size > maxBytes
  ) {
    throw new Error(label + ' must remain a bounded non-symlink regular file.');
  }
  const canonicalSource = await realpath(sourcePath);
  if (
    !isInsideAnyBoundary(canonicalSource, canonicalRoots) ||
    !samePath(canonicalSource, expected.path)
  ) {
    throw new Error(label + ' changed before its snapshot copy.');
  }

  await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const source = await open(sourcePath, constants.O_RDONLY | noFollow);
  let destination;
  try {
    const before = await source.stat();
    if (
      !before.isFile() ||
      before.dev !== expected.dev ||
      before.ino !== expected.ino ||
      before.size !== expected.size ||
      before.size > maxBytes
    ) {
      throw new Error(label + ' changed before its snapshot copy.');
    }
    destination = await open(
      destinationPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600
    );
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let sourceOffset = 0;
    let destinationOffset = 0;
    while (sourceOffset < before.size) {
      const { bytesRead } = await source.read(
        buffer,
        0,
        Math.min(buffer.length, before.size - sourceOffset),
        sourceOffset
      );
      if (bytesRead === 0) throw new Error(label + ' ended during its snapshot copy.');
      digest.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const result = await destination.write(
          buffer,
          written,
          bytesRead - written,
          destinationOffset + written
        );
        if (result.bytesWritten === 0) {
          throw new Error(label + ' snapshot copy stopped before completion.');
        }
        written += result.bytesWritten;
      }
      sourceOffset += bytesRead;
      destinationOffset += bytesRead;
    }
    const overflow = Buffer.allocUnsafe(1);
    if ((await source.read(overflow, 0, 1, before.size)).bytesRead !== 0) {
      throw new Error(label + ' grew during its snapshot copy.');
    }
    const after = await source.stat();
    const pathnameAfter = await lstat(sourcePath);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      pathnameAfter.isSymbolicLink() ||
      pathnameAfter.dev !== before.dev ||
      pathnameAfter.ino !== before.ino ||
      pathnameAfter.size !== before.size ||
      !samePath(await realpath(sourcePath), canonicalSource) ||
      digest.digest('hex') !== expected.sha256
    ) {
      throw new Error(label + ' changed during its snapshot copy.');
    }
  } finally {
    await destination?.close();
    await source.close();
  }
}

async function copyHashedAuthorityTree(
  authority,
  destinationRoot,
  canonicalRoots,
  label,
  maxFileBytes
) {
  if (!authority) return;
  const rootMetadata = await lstat(authority.path);
  if (
    rootMetadata.isSymbolicLink() ||
    !rootMetadata.isDirectory() ||
    rootMetadata.dev !== authority.dev ||
    rootMetadata.ino !== authority.ino
  ) {
    throw new Error(label + ' changed before its snapshot copy.');
  }
  await mkdir(destinationRoot, { recursive: true, mode: 0o700 });
  for (const entry of authority.entries) {
    const relativeSegments = entry.path.split('/');
    const sourcePath = join(authority.path, ...relativeSegments);
    const destinationPath = join(destinationRoot, ...relativeSegments);
    if (entry.type === 'file') {
      await copyStableBinaryAuthority(
        sourcePath,
        destinationPath,
        { ...entry, path: await realpath(sourcePath) },
        canonicalRoots,
        label + ' file ' + entry.path,
        maxFileBytes
      );
      continue;
    }
    const metadata = await lstat(sourcePath);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      metadata.dev !== entry.dev ||
      metadata.ino !== entry.ino ||
      metadata.size !== entry.size ||
      metadata.mtimeMs !== entry.mtimeMs
    ) {
      throw new Error(label + ' directory changed before its snapshot copy: ' + entry.path);
    }
    await mkdir(destinationPath, { recursive: true, mode: 0o700 });
  }
  const rootAfter = await lstat(authority.path);
  if (
    rootAfter.isSymbolicLink() ||
    !rootAfter.isDirectory() ||
    rootAfter.dev !== authority.dev ||
    rootAfter.ino !== authority.ino
  ) {
    throw new Error(label + ' changed during its snapshot copy.');
  }
}

async function writeSnapshotText(filePath, contents) {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

async function createMetadataSnapshot(metadataAuthority, canonicalRoots, temporaryRoot) {
  const lexicalRoot = resolve(temporaryRoot);
  const rootMetadata = await lstat(lexicalRoot);
  if (
    rootMetadata.isSymbolicLink() ||
    !rootMetadata.isDirectory() ||
    !/^dnaforge-git-read-[A-Za-z0-9]+$/u.test(basename(lexicalRoot))
  ) {
    throw new Error('Git metadata snapshot root is invalid.');
  }
  const snapshotRoot = await realpath(temporaryRoot);
  if ((await readBoundedDirectoryEntries(snapshotRoot, 1, 'Git metadata snapshot root')).length) {
    throw new Error('Git metadata snapshot root must be empty.');
  }
  const linkedWorktree = !samePath(metadataAuthority.gitDir, metadataAuthority.commonDirectory);
  const commonDirectory = join(snapshotRoot, 'common');
  const gitDirectory = linkedWorktree ? join(snapshotRoot, 'worktree') : commonDirectory;
  await Promise.all([
    mkdir(commonDirectory, { recursive: true, mode: 0o700 }),
    mkdir(gitDirectory, { recursive: true, mode: 0o700 }),
  ]);

  await writeSnapshotText(
    join(commonDirectory, 'config'),
    metadataAuthority.repositoryConfigs.common?.contents ?? ''
  );
  if (metadataAuthority.repositoryConfigs.worktree) {
    await writeSnapshotText(
      join(gitDirectory, 'config.worktree'),
      metadataAuthority.repositoryConfigs.worktree.contents
    );
  }
  if (linkedWorktree) {
    await writeSnapshotText(join(gitDirectory, 'commondir'), '../common\n');
  }

  const headContents =
    metadataAuthority.head?.type === 'legacy-symlink'
      ? metadataAuthority.head.target.contents
      : metadataAuthority.head?.contents;
  if (headContents !== undefined) {
    await writeSnapshotText(join(gitDirectory, 'HEAD'), headContents);
  }
  if (metadataAuthority.packedRefs) {
    await writeSnapshotText(
      join(commonDirectory, 'packed-refs'),
      metadataAuthority.packedRefs.contents
    );
  }

  await copyHashedAuthorityTree(
    metadataAuthority.refs,
    join(commonDirectory, 'refs'),
    canonicalRoots,
    'Git refs directory',
    MAX_LOOSE_REF_FILE_BYTES
  );
  for (const perWorktree of metadataAuthority.perWorktreeRefs) {
    await copyHashedAuthorityTree(
      perWorktree.authority,
      join(gitDirectory, 'refs', perWorktree.namespace),
      canonicalRoots,
      'Git per-worktree refs/' + perWorktree.namespace,
      MAX_LOOSE_REF_FILE_BYTES
    );
  }
  await copyHashedAuthorityTree(
    metadataAuthority.reftable,
    join(commonDirectory, 'reftable'),
    canonicalRoots,
    'Git reftable directory',
    MAX_REFTABLE_FILE_BYTES
  );
  await copyHashedAuthorityTree(
    metadataAuthority.worktreeReftable,
    join(gitDirectory, 'reftable'),
    canonicalRoots,
    'Git worktree reftable directory',
    MAX_REFTABLE_FILE_BYTES
  );

  if (metadataAuthority.index) {
    await copyStableBinaryAuthority(
      metadataAuthority.index.path,
      join(gitDirectory, 'index'),
      metadataAuthority.index,
      canonicalRoots,
      'Git index',
      MAX_PRIMARY_INDEX_BYTES
    );
  }
  for (const sharedIndex of metadataAuthority.sharedIndexes) {
    await copyStableBinaryAuthority(
      sharedIndex.path,
      join(gitDirectory, basename(sharedIndex.path)),
      sharedIndex,
      canonicalRoots,
      'Git shared index',
      MAX_SHARED_INDEX_BYTES
    );
  }

  const objectDirectories = metadataAuthority.objectDirectories.map(
    (authority) => authority.objectDirectory
  );
  if (objectDirectories.length === 0) {
    throw new Error('Git metadata snapshot has no admitted object directory.');
  }
  for (const objectDirectory of objectDirectories) {
    if (/[\r\n\0]/u.test(objectDirectory)) {
      throw new Error('Git object directory cannot be represented in a snapshot.');
    }
  }
  const objectInfoDirectory = join(commonDirectory, 'objects', 'info');
  await mkdir(objectInfoDirectory, { recursive: true, mode: 0o700 });
  await writeSnapshotText(
    join(objectInfoDirectory, 'alternates'),
    objectDirectories.map((path) => path.split(sep).join('/')).join('\n') + '\n'
  );

  return { root: snapshotRoot, gitDirectory };
}

async function collectResolvedObjectAuthority(metadataAuthority, objectId, canonicalRoots) {
  const looseObjects = [];
  for (const objectDirectory of metadataAuthority.objectDirectories) {
    looseObjects.push(
      await collectOptionalPathAuthority(
        join(objectDirectory.objectDirectory, objectId.slice(0, 2), objectId.slice(2)),
        canonicalRoots,
        'Git loose object'
      )
    );
  }
  return looseObjects;
}

function stripGitPathTerminator(stdout, label) {
  if (!stdout.endsWith('\n')) throw new Error(label + ' did not return a path.');
  const withoutLf = stdout.slice(0, -1);
  const value = withoutLf.endsWith('\r') ? withoutLf.slice(0, -1) : withoutLf;
  if (!value || value.includes('\0')) throw new Error(label + ' returned an invalid path.');
  return value;
}

function spawnOwnedGit(request, args) {
  const gitArgs = [...request.gitArgumentPrefix, ...request.gitConfigArgs, ...args];
  const environment = {
    ...process.env,
    DNAFORGE_GIT_READ_HELPER_PID: String(process.pid),
  };
  return spawn(request.gitExecutable, gitArgs, {
    detached: false,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function runGitCaptured(request, args, maxBuffer) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawnOwnedGit(request, args);
    activeGit = child;
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let terminalError = null;

    const requestStop = (error) => {
      if (terminalError) return;
      terminalError = error;
      killActiveGit('SIGKILL');
    };
    child.stdout.on('data', (chunk) => {
      if (terminalError) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBuffer) {
        requestStop(new Error('Git read stdout exceeded its byte limit.'));
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (terminalError) return;
      stderrBytes += chunk.length;
      if (stderrBytes > maxBuffer) {
        requestStop(new Error('Git read stderr exceeded its byte limit.'));
        return;
      }
      stderrChunks.push(chunk);
    });
    child.once('error', requestStop);
    child.once('close', (code) => {
      activeGit = null;
      if (terminalError) {
        rejectPromise(terminalError);
        return;
      }
      resolvePromise({
        exitCode: typeof code === 'number' ? code : 128,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}

function runGitVerifiedBlobStdout(request, args, maxBuffer, expectedObjectId, expectedSize) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawnOwnedGit(request, args);
    activeGit = child;
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let terminalError = null;
    const objectDigest = createHash(expectedObjectId.length === 40 ? 'sha1' : 'sha256');
    objectDigest.update(Buffer.from('blob ' + String(expectedSize) + '\0', 'utf8'));

    const requestStop = (error) => {
      if (terminalError) return;
      terminalError = error;
      killActiveGit('SIGKILL');
    };
    child.stdout.on('data', (chunk) => {
      if (terminalError) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBuffer || stdoutBytes > expectedSize) {
        requestStop(new Error('Git read stdout exceeded its byte limit.'));
        return;
      }
      objectDigest.update(chunk);
      if (!process.stdout.write(chunk)) {
        child.stdout.pause();
        process.stdout.once('drain', () => child.stdout.resume());
      }
    });
    child.stderr.on('data', (chunk) => {
      if (terminalError) return;
      stderrBytes += chunk.length;
      if (stderrBytes > request.metadataMaxBuffer) {
        requestStop(new Error('Git read stderr exceeded its byte limit.'));
        return;
      }
      stderrChunks.push(chunk);
    });
    child.once('error', requestStop);
    child.once('close', (code) => {
      activeGit = null;
      if (terminalError) {
        rejectPromise(terminalError);
        return;
      }
      const exitCode = typeof code === 'number' ? code : 128;
      if (exitCode !== 0) {
        const detail = Buffer.concat(stderrChunks).toString('utf8').trim();
        rejectPromise(new Error(detail || 'Git object read failed.'));
        return;
      }
      if (stdoutBytes !== expectedSize) {
        rejectPromise(new Error('Git object size changed during its read.'));
        return;
      }
      if (objectDigest.digest('hex') !== expectedObjectId) {
        rejectPromise(new Error('Git object content did not match its resolved object id.'));
        return;
      }
      resolvePromise();
    });
  });
}

async function verifyGitAssociation(repoRoot, gitDir, anchoredCandidateDirectory, maxBytes) {
  const associationPath = relative(anchoredCandidateDirectory, join(repoRoot, '.git')) || '.git';
  const association = await lstat(associationPath);
  if (association.isDirectory() || association.isSymbolicLink()) {
    const associatedGitDir = await realpath(associationPath);
    if (!samePath(associatedGitDir, gitDir)) {
      throw new Error('Repository Git metadata changed during validation.');
    }
    return associationPath;
  }
  if (!association.isFile()) {
    throw new Error('Repository Git metadata has an unsupported file type.');
  }

  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const pathnameBefore = await lstat(associationPath);
  if (
    pathnameBefore.isSymbolicLink() ||
    !pathnameBefore.isFile() ||
    pathnameBefore.size > maxBytes
  ) {
    throw new Error('Repository Git metadata pointer is not a bounded regular file.');
  }
  const handle = await open(associationPath, constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.size > maxBytes ||
      before.dev !== pathnameBefore.dev ||
      before.ino !== pathnameBefore.ino ||
      before.size !== pathnameBefore.size
    ) {
      throw new Error('Repository Git metadata pointer changed while opening.');
    }
    const contents = (
      await readBoundedHandleBytes(handle, before, maxBytes, 'Repository Git metadata pointer')
    ).toString('utf8');
    const after = await handle.stat();
    const pathnameAfter = await lstat(associationPath);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      pathnameAfter.isSymbolicLink() ||
      pathnameAfter.dev !== before.dev ||
      pathnameAfter.ino !== before.ino ||
      pathnameAfter.size !== before.size ||
      pathnameAfter.mtimeMs !== before.mtimeMs
    ) {
      throw new Error('Repository Git metadata pointer changed during validation.');
    }
    const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(contents);
    if (!match) throw new Error('Repository Git metadata pointer is invalid.');
    const referencedPath = isAbsolute(match[1])
      ? match[1]
      : join(dirname(associationPath), match[1]);
    const associatedGitDir = await realpath(referencedPath);
    if (!samePath(associatedGitDir, gitDir)) {
      throw new Error('Repository Git metadata pointer changed during validation.');
    }
    return referencedPath;
  } finally {
    await handle.close();
  }
}

async function readGitHead(request) {
  const canonicalRoots = await Promise.all(
    request.allowedRoots.map(async (root) => (await resolveCanonicalTarget(root)).canonicalPath)
  );
  const candidate = await resolveCanonicalTarget(request.filePath);
  if (!isInsideAnyBoundary(candidate.canonicalPath, canonicalRoots)) {
    throw new Error('Path access denied: ' + candidate.canonicalPath);
  }

  const candidateDirectory = await resolveCanonicalTarget(dirname(candidate.canonicalPath));
  process.chdir(candidateDirectory.existingAncestor);
  const anchoredCandidateDirectory = await realpath('.');
  if (!samePath(anchoredCandidateDirectory, candidateDirectory.existingAncestor)) {
    throw new Error('Candidate path changed during validation.');
  }

  const rootResult = await runGitCaptured(
    request,
    ['rev-parse', '--path-format=absolute', '--show-toplevel'],
    request.metadataMaxBuffer
  );
  if (rootResult.exitCode !== 0) return null;
  const discoveredRoot = stripGitPathTerminator(rootResult.stdout, 'Git repository discovery');
  const repoRoot = await realpath(discoveredRoot);
  if (!isInsideAnyBoundary(repoRoot, canonicalRoots)) {
    throw new Error('Path access denied: ' + repoRoot);
  }
  if (
    !isInsideBoundary(candidate.canonicalPath, repoRoot) ||
    !isInsideBoundary(anchoredCandidateDirectory, repoRoot)
  ) {
    throw new Error('Candidate path is outside its discovered repository.');
  }

  const gitDirResult = await runGitCaptured(
    request,
    ['rev-parse', '--path-format=absolute', '--absolute-git-dir'],
    request.metadataMaxBuffer
  );
  if (gitDirResult.exitCode !== 0) return null;
  const discoveredGitDir = stripGitPathTerminator(gitDirResult.stdout, 'Git metadata discovery');
  const gitDir = await realpath(discoveredGitDir);
  if (!isInsideAnyBoundary(gitDir, canonicalRoots)) {
    throw new Error('Path access denied: ' + gitDir);
  }

  const gitDirAnchor = await verifyGitAssociation(
    repoRoot,
    gitDir,
    anchoredCandidateDirectory,
    request.metadataMaxBuffer
  );
  process.chdir(gitDirAnchor);
  const anchoredGitDir = await realpath('.');
  if (!samePath(anchoredGitDir, gitDir)) {
    throw new Error('Repository Git metadata changed before use.');
  }
  const metadataAuthority = await collectMetadataAuthority(
    gitDir,
    canonicalRoots,
    request.metadataMaxBuffer
  );

  const relativePath = relative(repoRoot, candidate.canonicalPath);
  if (
    !relativePath ||
    relativePath === '..' ||
    relativePath.startsWith('..' + sep) ||
    isAbsolute(relativePath)
  ) {
    return null;
  }
  const gitRelativePath = relativePath.split(sep).join('/');
  const metadataSnapshot = await createMetadataSnapshot(
    metadataAuthority,
    canonicalRoots,
    request.snapshotRoot
  );
  process.chdir(metadataSnapshot.gitDirectory);
  try {
    await assertMetadataAuthorityUnchanged(
      metadataAuthority,
      canonicalRoots,
      request.metadataMaxBuffer
    );
    const trackedResult = await runGitCaptured(
      request,
      ['--git-dir=.', 'ls-files', '--full-name', '-z', '--', gitRelativePath],
      request.metadataMaxBuffer
    );
    if (trackedResult.exitCode !== 0) return null;
    const trackedPaths = trackedResult.stdout.split('\0').filter((entry) => entry.length > 0);
    if (trackedPaths.length !== 1 || trackedPaths[0] !== gitRelativePath) return null;

    for (const objectSpec of ['HEAD:' + gitRelativePath, ':0:' + gitRelativePath]) {
      await assertMetadataAuthorityUnchanged(
        metadataAuthority,
        canonicalRoots,
        request.metadataMaxBuffer
      );
      const objectResult = await runGitCaptured(
        request,
        ['--git-dir=.', 'rev-parse', '--verify', '--quiet', objectSpec],
        request.metadataMaxBuffer
      );
      if (objectResult.exitCode !== 0) continue;
      const objectId = objectResult.stdout.trim();
      if (!/^[0-9a-f]{40,64}$/.test(objectId)) {
        throw new Error('Git object resolution returned an invalid object id.');
      }
      const resolvedObjectAuthority = await collectResolvedObjectAuthority(
        metadataAuthority,
        objectId,
        canonicalRoots
      );
      await assertMetadataAuthorityUnchanged(
        metadataAuthority,
        canonicalRoots,
        request.metadataMaxBuffer
      );
      const sizeResult = await runGitCaptured(
        request,
        ['--git-dir=.', 'cat-file', '-s', objectId],
        request.metadataMaxBuffer
      );
      if (sizeResult.exitCode !== 0 || !/^(?:0|[1-9][0-9]*)\n?$/.test(sizeResult.stdout)) {
        throw new Error('Git object size resolution failed.');
      }
      const objectSize = Number(sizeResult.stdout.trim());
      if (!Number.isSafeInteger(objectSize) || objectSize > request.contentMaxBuffer) {
        throw new Error('Git object exceeds its byte limit.');
      }
      await assertMetadataAuthorityUnchanged(
        metadataAuthority,
        canonicalRoots,
        request.metadataMaxBuffer
      );
      await runGitVerifiedBlobStdout(
        request,
        ['--git-dir=.', 'cat-file', 'blob', objectId],
        request.contentMaxBuffer,
        objectId,
        objectSize
      );
      await assertMetadataAuthorityUnchanged(
        metadataAuthority,
        canonicalRoots,
        request.metadataMaxBuffer
      );
      const resolvedObjectAuthorityAfterRead = await collectResolvedObjectAuthority(
        metadataAuthority,
        objectId,
        canonicalRoots
      );
      if (
        JSON.stringify(resolvedObjectAuthorityAfterRead) !== JSON.stringify(resolvedObjectAuthority)
      ) {
        throw new Error('Git resolved object authority changed during the read transaction.');
      }
      return undefined;
    }
    return null;
  } finally {
    process.chdir(dirname(metadataSnapshot.root));
  }
}

async function executeFramedRequest(payload) {
  try {
    const request = JSON.parse(payload);
    if (
      typeof request?.filePath !== 'string' ||
      !Array.isArray(request?.allowedRoots) ||
      request.allowedRoots.some((root) => typeof root !== 'string') ||
      typeof request?.gitExecutable !== 'string' ||
      !Array.isArray(request?.gitArgumentPrefix) ||
      request.gitArgumentPrefix.some((argument) => typeof argument !== 'string') ||
      !Array.isArray(request?.gitConfigArgs) ||
      request.gitConfigArgs.some((argument) => typeof argument !== 'string') ||
      !Number.isSafeInteger(request?.metadataMaxBuffer) ||
      !Number.isSafeInteger(request?.contentMaxBuffer) ||
      typeof request?.snapshotRoot !== 'string' ||
      request.snapshotRoot.length > MAX_INPUT_CODE_UNITS
    ) {
      throw new Error('Git read helper input is invalid.');
    }
    const content = await readGitHead(request);
    if (content === null) {
      process.exitCode = NULL_EXIT_CODE;
      return;
    }
    if (content !== undefined) process.stdout.write(content);
  } catch (error) {
    process.stderr.write(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    requestFinished = true;
    process.stdin.destroy();
    if (process.connected) process.disconnect();
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  if (requestStarted) {
    process.stderr.write('Git read helper received trailing input.');
    process.exit(2);
  }
  input += chunk;
  if (input.length > MAX_INPUT_CODE_UNITS) {
    process.stderr.write('Git read helper input is too large.');
    process.exit(2);
  }
  const terminator = input.indexOf('\n');
  if (terminator < 0) return;
  if (input.length !== terminator + 1) {
    process.stderr.write('Git read helper input frame is invalid.');
    process.exit(2);
  }
  const payload = input.slice(0, terminator);
  input = '';
  requestStarted = true;
  process.stdin.unref?.();
  void executeFramedRequest(payload);
});
process.stdin.on('end', () => {
  if (!requestStarted) {
    process.stderr.write('Git read helper owner disconnected before sending a request.');
    process.exit(2);
  }
  terminateOwnedTreeAfterOwnerLoss();
});
