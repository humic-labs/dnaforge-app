import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { hashWorkspaceSyncFileOnDisk } from '../workspace-sync-blob-cache';
import { flushFile, syncDirectory } from '../fs-durability';

interface PhysicalIdentity {
  device: string;
  inode: string;
  modifiedNs: string;
  changedNs: string;
}

export type ComputeSourceEntry = {
  relativePath: string;
  mode: number;
  identity: PhysicalIdentity;
} & ({ kind: 'directory' } | { kind: 'file'; sha256: string; byteLength: number });

export interface ComputeSourceInventory {
  rootIdentity: PhysicalIdentity;
  rootMode: number;
  entries: ComputeSourceEntry[];
  treeSha256: string;
}

function identity(info: Awaited<ReturnType<typeof sourceStat>>): PhysicalIdentity {
  return {
    device: String(info.dev),
    inode: String(info.ino),
    modifiedNs: String(info.mtimeNs),
    changedNs: String(info.ctimeNs),
  };
}

function sourceStat(path: string) {
  return lstat(path, { bigint: true });
}

function samePhysical(left: PhysicalIdentity, right: PhysicalIdentity): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function portableEntries(entries: readonly ComputeSourceEntry[]) {
  return entries.map(({ identity: _physical, ...entry }) => entry);
}

function assertSegment(name: string): void {
  if (!name || name === '.' || name === '..' || /[\\/\0]/u.test(name))
    throw new Error('COMPUTE_SOURCE_PATH_UNSUPPORTED');
}

export async function inventoryComputeSource(root: string): Promise<ComputeSourceInventory> {
  const absoluteRoot = resolve(root);
  const initial = await sourceStat(absoluteRoot);
  if (!initial.isDirectory() || initial.isSymbolicLink())
    throw new Error('COMPUTE_SOURCE_ROOT_NOT_DIRECTORY');
  if ((await realpath(absoluteRoot)) !== absoluteRoot)
    throw new Error('COMPUTE_SOURCE_ROOT_ALIAS_UNSUPPORTED');
  const entries: ComputeSourceEntry[] = [];
  const walk = async (directory: string, prefix: string) => {
    const before = await sourceStat(directory);
    if (!before.isDirectory() || before.isSymbolicLink())
      throw new Error('COMPUTE_SOURCE_DIRECTORY_CHANGED');
    const children = (await readdir(directory)).sort();
    const names = new Set<string>();
    for (const name of children) {
      assertSegment(name);
      const comparison = name.normalize('NFC').toLowerCase();
      if (names.has(comparison)) throw new Error('COMPUTE_SOURCE_NAME_COLLISION');
      names.add(comparison);
      const path = join(directory, name);
      const relativePath = prefix ? `${prefix}/${name}` : name;
      const info = await sourceStat(path);
      const mode = Number(info.mode & 0o777n);
      if (info.isSymbolicLink()) throw new Error('COMPUTE_SOURCE_SYMLINK_UNSUPPORTED');
      if (info.isDirectory()) {
        entries.push({ kind: 'directory', relativePath, mode, identity: identity(info) });
        await walk(path, relativePath);
      } else if (info.isFile()) {
        if (info.nlink !== 1n) throw new Error('COMPUTE_SOURCE_HARD_LINK_UNSUPPORTED');
        const hashed = await hashWorkspaceSyncFileOnDisk(path);
        if (!samePhysical(identity(info), identity(await sourceStat(path))))
          throw new Error('COMPUTE_SOURCE_FILE_CHANGED');
        entries.push({
          kind: 'file',
          relativePath,
          mode,
          identity: identity(info),
          sha256: hashed.sha256,
          byteLength: hashed.sizeBytes,
        });
      } else throw new Error('COMPUTE_SOURCE_SPECIAL_FILE_UNSUPPORTED');
    }
    if (!samePhysical(identity(before), identity(await sourceStat(directory))))
      throw new Error('COMPUTE_SOURCE_DIRECTORY_CHANGED');
  };
  await walk(absoluteRoot, '');
  const current = await sourceStat(absoluteRoot);
  if (!samePhysical(identity(initial), identity(current)))
    throw new Error('COMPUTE_SOURCE_ROOT_CHANGED');
  return {
    rootIdentity: identity(initial),
    rootMode: Number(initial.mode & 0o777n),
    entries,
    treeSha256: createHash('sha256')
      .update(
        JSON.stringify({
          rootMode: Number(initial.mode & 0o777n),
          entries: portableEntries(entries),
        })
      )
      .digest('hex'),
  };
}

export async function assertComputeSourceUnchanged(
  sourceRoot: string,
  expected: ComputeSourceInventory
): Promise<void> {
  const current = await inventoryComputeSource(sourceRoot);
  if (
    current.treeSha256 !== expected.treeSha256 ||
    !samePhysical(current.rootIdentity, expected.rootIdentity) ||
    JSON.stringify(current.entries) !== JSON.stringify(expected.entries)
  )
    throw new Error('COMPUTE_SOURCE_CHANGED');
}

export async function retainComputeSource(input: {
  sourceRoot: string;
  retainedRoot: string;
  expected: ComputeSourceInventory;
}): Promise<void> {
  await assertComputeSourceUnchanged(input.sourceRoot, input.expected);
  const parent = await realpath(dirname(input.retainedRoot));
  if (join(parent, basename(input.retainedRoot)) !== resolve(input.retainedRoot))
    throw new Error('COMPUTE_RETAINED_PARENT_CHANGED');
  await mkdir(input.retainedRoot, { mode: 0o700 });
  await syncDirectory(parent);
  for (const entry of input.expected.entries) {
    const destination = join(input.retainedRoot, entry.relativePath);
    if (entry.kind === 'directory') await mkdir(destination, { mode: 0o700 });
    else {
      await copyFile(
        join(input.sourceRoot, entry.relativePath),
        destination,
        constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE
      );
      await chmod(destination, entry.mode);
      await flushFile(destination);
      const actual = await hashWorkspaceSyncFileOnDisk(destination);
      if (actual.sha256 !== entry.sha256 || actual.sizeBytes !== entry.byteLength)
        throw new Error('COMPUTE_RETAINED_FILE_MISMATCH');
      await syncDirectory(dirname(destination));
    }
  }
  for (const entry of [...input.expected.entries].reverse())
    if (entry.kind === 'directory') {
      await chmod(join(input.retainedRoot, entry.relativePath), entry.mode);
      await syncDirectory(join(input.retainedRoot, entry.relativePath));
    }
  await chmod(input.retainedRoot, input.expected.rootMode);
  const retained = await inventoryComputeSource(input.retainedRoot);
  if (retained.treeSha256 !== input.expected.treeSha256)
    throw new Error('COMPUTE_RETAINED_TREE_MISMATCH');
  await assertComputeSourceUnchanged(input.sourceRoot, input.expected);
  await syncDirectory(input.retainedRoot);
}
