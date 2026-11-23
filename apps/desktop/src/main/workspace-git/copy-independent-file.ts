import { execFile, execFileSync } from 'node:child_process';
import {
  constants,
  copyFileSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  chmodSync,
} from 'node:fs';
import { chmod, copyFile, link, lstat, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { claimRegularFileNoClobber } from './exclusive-file-claim';

const execute = promisify(execFile);

export function copyStableFileSync(sourcePath: string, destinationPath: string): void {
  const before = lstatSync(sourcePath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error('IMPORT_COPY_SOURCE_NOT_REGULAR');
  }
  const staging = mkdtempSync(join(dirname(destinationPath), '.dnaforge-leased-copy-'));
  try {
    const clonedPath = join(staging, 'copy');
    if (process.platform === 'darwin' && before.size >= 1024 * 1024) {
      execFileSync('/bin/cp', ['-c', sourcePath, clonedPath], {
        windowsHide: true,
        maxBuffer: 64 * 1024,
      });
    } else {
      copyFileSync(sourcePath, clonedPath, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    }
    const after = lstatSync(sourcePath);
    const cloned = lstatSync(clonedPath);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      !cloned.isFile() ||
      cloned.isSymbolicLink() ||
      cloned.size !== before.size ||
      (cloned.dev === before.dev && cloned.ino === before.ino)
    ) {
      throw new Error('IMPORT_COPY_SOURCE_CHANGED');
    }
    chmodSync(clonedPath, 0o600);
    linkSync(clonedPath, destinationPath);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export async function copyStableFile(sourcePath: string, destinationPath: string): Promise<void> {
  const before = await lstat(sourcePath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error('IMPORT_COPY_SOURCE_NOT_REGULAR');
  }
  const staging = await mkdtemp(join(dirname(destinationPath), '.dnaforge-leased-copy-'));
  try {
    const clonedPath = join(staging, 'copy');
    if (process.platform === 'darwin' && before.size >= 1024 * 1024) {
      await execute('/bin/cp', ['-c', sourcePath, clonedPath], {
        windowsHide: true,
        maxBuffer: 64 * 1024,
      });
    } else {
      await copyFile(sourcePath, clonedPath, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    }
    const after = await lstat(sourcePath);
    const cloned = await lstat(clonedPath);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      !cloned.isFile() ||
      cloned.isSymbolicLink() ||
      cloned.size !== before.size ||
      (cloned.dev === before.dev && cloned.ino === before.ino)
    ) {
      throw new Error('IMPORT_COPY_SOURCE_CHANGED');
    }
    await chmod(clonedPath, 0o600);
    await link(clonedPath, destinationPath);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export function copyIndependentFileSync(sourcePath: string, destinationPath: string): void {
  const source = lstatSync(sourcePath);
  if (!source.isFile()) throw new Error('IMPORT_COPY_SOURCE_NOT_REGULAR');
  if (process.platform !== 'darwin' || source.size < 1024 * 1024) {
    copyFileSync(sourcePath, destinationPath, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    return;
  }
  const staging = mkdtempSync(join(dirname(destinationPath), '.dnaforge-import-copy-'));
  try {
    const pinnedPath = join(staging, 'source');
    try {
      linkSync(sourcePath, pinnedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      copyFileSync(sourcePath, pinnedPath, constants.COPYFILE_EXCL);
    }
    const pinned = lstatSync(pinnedPath);
    const before = lstatSync(sourcePath);
    if (
      source.dev !== before.dev ||
      source.ino !== before.ino ||
      source.size !== before.size ||
      source.mtimeMs !== before.mtimeMs
    ) {
      throw new Error('IMPORT_COPY_SOURCE_CHANGED');
    }
    const clonedPath = join(staging, 'copy');
    execFileSync('/bin/cp', ['-c', pinnedPath, clonedPath], {
      windowsHide: true,
      maxBuffer: 64 * 1024,
    });
    const after = lstatSync(pinnedPath);
    const cloned = lstatSync(clonedPath);
    if (
      !pinned.isFile() ||
      after.dev !== pinned.dev ||
      after.ino !== pinned.ino ||
      after.size !== pinned.size ||
      after.mtimeMs !== pinned.mtimeMs ||
      !cloned.isFile() ||
      cloned.size !== pinned.size ||
      (cloned.dev === pinned.dev && cloned.ino === pinned.ino)
    ) {
      throw new Error('IMPORT_COPY_SOURCE_CHANGED');
    }
    chmodSync(clonedPath, 0o600);
    linkSync(clonedPath, destinationPath);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export async function copyIndependentFile(
  sourcePath: string,
  destinationPath: string
): Promise<void> {
  const source = await lstat(sourcePath);
  if (!source.isFile()) throw new Error('IMPORT_COPY_SOURCE_NOT_REGULAR');
  if (process.platform !== 'darwin' || source.size < 1024 * 1024) {
    await copyFile(
      sourcePath,
      destinationPath,
      constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE
    );
    return;
  }

  const staging = await mkdtemp(join(dirname(destinationPath), '.dnaforge-import-copy-'));
  try {
    const pinnedPath = join(staging, 'source');
    const pinned = await claimRegularFileNoClobber(sourcePath, pinnedPath);
    const before = await lstat(pinnedPath);
    if (pinned.method === 'link' && (before.dev !== source.dev || before.ino !== source.ino)) {
      throw new Error('IMPORT_COPY_SOURCE_CHANGED');
    }
    const clonedPath = join(staging, 'copy');
    await execute('/bin/cp', ['-c', pinnedPath, clonedPath], {
      windowsHide: true,
      maxBuffer: 64 * 1024,
    });
    const [after, cloned] = await Promise.all([lstat(pinnedPath), lstat(clonedPath)]);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      !cloned.isFile() ||
      cloned.size !== before.size ||
      (cloned.dev === before.dev && cloned.ino === before.ino)
    ) {
      throw new Error('IMPORT_COPY_SOURCE_CHANGED');
    }
    await claimRegularFileNoClobber(clonedPath, destinationPath);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
