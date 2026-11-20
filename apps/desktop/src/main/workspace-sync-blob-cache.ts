import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { TextDecoder } from 'node:util';
import { decodeBundleFileContent, type WorkspaceSyncFile } from '@waypoint/share-bundle';
import { syncDirectory } from './fs-durability';
import { copyStableFileSync } from './workspace-git/copy-independent-file';
import { claimRegularFileNoClobber } from './workspace-git/exclusive-file-claim';

export interface WorkspaceSyncBlobIdentity {
  sha256: string;
  sizeBytes: number;
}
interface CacheOptions {
  cacheRoot?: string;
  signal?: AbortSignal;
}
const CHUNK_BYTES = 256 * 1024;

export class SourceDigestChangedError extends Error {}

export async function workspaceSyncBlobCacheRoot(): Promise<string> {
  const { app } = await import('electron');
  return join(app.getPath('userData'), 'workspace-sync', 'blobs');
}

export async function workspaceSyncBlobPath(sha256: string, cacheRoot?: string): Promise<string> {
  if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new Error('Invalid workspace sync blob digest.');
  return join(cacheRoot ?? (await workspaceSyncBlobCacheRoot()), sha256.slice(0, 2), sha256);
}

function sameFile(
  a: Stats,
  b: Pick<Stats, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs'>
): boolean {
  return (
    a.isFile() &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}

function checkAbort(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset);
    if (bytesWritten === 0) throw new Error('Workspace sync disk write made no progress.');
    offset += bytesWritten;
  }
}

async function* readHandle(handle: FileHandle, signal?: AbortSignal): AsyncGenerator<Buffer> {
  const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
  let offset = 0;
  for (;;) {
    checkAbort(signal);
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
    if (bytesRead === 0) break;
    yield chunk.subarray(0, bytesRead);
    offset += bytesRead;
  }
}

async function openRegular(path: string): Promise<FileHandle> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink())
    throw new Error('Workspace sync requires a regular file.');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  if (!sameFile(await handle.stat(), before)) {
    await handle.close();
    throw new Error('Workspace sync file changed before capture.');
  }
  return handle;
}

async function publishCacheFile(
  temp: string,
  identity: WorkspaceSyncBlobIdentity,
  options: CacheOptions
): Promise<void> {
  const path = await workspaceSyncBlobPath(identity.sha256, options.cacheRoot);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(temp, 0o400);
  try {
    await rename(temp, path);
  } catch (error) {
    if (!REPLACE_REFUSED_CODES.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
    const cached = await cachedBlobState(identity, options);
    if (cached === 'missing') throw error;
    if (cached === 'valid') {
      await chmod(temp, 0o600);
      return;
    }
    await chmod(path, 0o600);
    await rm(path, { force: true });
    await rename(temp, path);
  }
  await syncDirectory(dirname(path));
  await syncDirectory(dirname(dirname(path)));
  await syncDirectory(dirname(dirname(dirname(path))));
}

const REPLACE_REFUSED_CODES = new Set(['EPERM', 'EACCES', 'EEXIST', 'EBUSY']);

async function cachedBlobState(
  identity: WorkspaceSyncBlobIdentity,
  options: CacheOptions
): Promise<'missing' | 'valid' | 'damaged'> {
  try {
    await verifyWorkspaceSyncBlob(identity, options);
    return 'valid';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'damaged';
  }
}

export async function captureWorkspaceSyncBlob(
  source: string,
  options: CacheOptions & {
    maxBytes: number;
    utf8?: boolean;
    expectedIdentity?: Pick<Stats, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs'>;
    expectedSha256?: string;
  }
): Promise<WorkspaceSyncBlobIdentity> {
  const root = options.cacheRoot ?? (await workspaceSyncBlobCacheRoot());
  await mkdir(root, { recursive: true, mode: 0o700 });
  const temp = join(root, `.capture-${randomUUID()}`);
  const sourceHandle = await openRegular(source);
  let output: FileHandle | undefined;
  try {
    const before = await sourceHandle.stat();
    if (
      before.size > options.maxBytes ||
      (options.expectedIdentity && !sameFile(before, options.expectedIdentity))
    ) {
      throw new Error('Workspace sync file exceeds admission or changed before capture.');
    }
    checkAbort(options.signal);
    if (!sameFile(await lstat(source), before)) {
      throw new Error('Workspace sync source changed before capture.');
    }
    copyStableFileSync(source, temp);
    output = await open(temp, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
    const copied = await output.stat();
    if (
      !copied.isFile() ||
      copied.size !== before.size ||
      (copied.dev === before.dev && copied.ino === before.ino)
    ) {
      throw new Error('Workspace sync capture requires independent regular bytes.');
    }
    const hash = createHash('sha256');
    const decoder = options.utf8 ? new TextDecoder('utf-8', { fatal: true }) : undefined;
    let sizeBytes = 0;
    for await (const chunk of readHandle(output, options.signal)) {
      sizeBytes += chunk.length;
      if (sizeBytes > options.maxBytes || sizeBytes > before.size)
        throw new Error('Workspace sync file grew during capture.');
      decoder?.decode(chunk, { stream: true });
      hash.update(chunk);
    }
    decoder?.decode();
    if (
      sizeBytes !== before.size ||
      !sameFile(await sourceHandle.stat(), before) ||
      !sameFile(await lstat(source), before) ||
      !sameFile(await output.stat(), copied)
    ) {
      throw new Error('Workspace sync file changed during capture.');
    }
    const identity = { sha256: hash.digest('hex'), sizeBytes };
    if (options.expectedSha256 && identity.sha256 !== options.expectedSha256)
      throw new SourceDigestChangedError(
        'The saved file changed since it was verified. Reload it before saving.'
      );
    await output.sync();
    await output.close();
    output = undefined;
    checkAbort(options.signal);
    await publishCacheFile(temp, identity, { ...options, cacheRoot: root });
    return identity;
  } finally {
    await sourceHandle.close();
    await output?.close();
    await rm(temp, { force: true });
  }
}

export async function receiveWorkspaceSyncBlob(
  chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  identity: WorkspaceSyncBlobIdentity,
  options: CacheOptions = {}
): Promise<void> {
  const root = options.cacheRoot ?? (await workspaceSyncBlobCacheRoot());
  await workspaceSyncBlobPath(identity.sha256, root);
  if (!Number.isSafeInteger(identity.sizeBytes) || identity.sizeBytes < 0)
    throw new Error('Invalid workspace sync blob size.');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const temp = join(root, `.download-${randomUUID()}`);
  const output = await open(temp, 'wx', 0o600);
  let closed = false;
  try {
    const hash = createHash('sha256');
    let sizeBytes = 0;
    for await (const chunk of chunks) {
      checkAbort(options.signal);
      sizeBytes += chunk.byteLength;
      if (sizeBytes > identity.sizeBytes)
        throw new Error('Workspace sync download exceeds its declared size.');
      hash.update(chunk);
      await writeAll(output, chunk);
    }
    if (sizeBytes !== identity.sizeBytes || hash.digest('hex') !== identity.sha256) {
      throw new Error('Workspace sync download size or digest does not match its manifest.');
    }
    await output.sync();
    await output.close();
    closed = true;
    checkAbort(options.signal);
    await publishCacheFile(temp, identity, { ...options, cacheRoot: root });
  } finally {
    if (!closed) await output.close();
    await rm(temp, { force: true });
  }
}

export async function verifyWorkspaceSyncBlob(
  identity: WorkspaceSyncBlobIdentity,
  options: CacheOptions = {}
): Promise<void> {
  const handle = await openRegular(await workspaceSyncBlobPath(identity.sha256, options.cacheRoot));
  try {
    const before = await handle.stat();
    if (before.size !== identity.sizeBytes)
      throw new Error('Workspace sync cached blob size does not match.');
    const hash = createHash('sha256');
    for await (const chunk of readHandle(handle, options.signal)) hash.update(chunk);
    if (hash.digest('hex') !== identity.sha256 || !sameFile(await handle.stat(), before)) {
      throw new Error('Workspace sync cached blob digest does not match.');
    }
  } finally {
    await handle.close();
  }
}

export async function readVerifiedWorkspaceSyncFile(file: WorkspaceSyncFile): Promise<Uint8Array> {
  let bytes: Uint8Array;
  if (file.encoding === 'blob') {
    const handle = await openRegular(await workspaceSyncBlobPath(file.sha256));
    try {
      const before = await handle.stat();
      if (before.size !== file.sizeBytes) throw new Error('Workspace sync blob size differs.');
      bytes = Buffer.alloc(file.sizeBytes);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
        if (!bytesRead) throw new Error('Workspace sync blob ended early.');
        offset += bytesRead;
      }
      if (!sameFile(await handle.stat(), before)) throw new Error('Workspace sync blob changed.');
    } finally {
      await handle.close();
    }
  } else {
    bytes = decodeBundleFileContent(file);
  }
  if (
    bytes.byteLength !== file.sizeBytes ||
    createHash('sha256').update(bytes).digest('hex') !== file.sha256
  ) {
    throw new Error('Workspace sync bytes differ from frozen content.');
  }
  return bytes;
}

export async function hashWorkspaceSyncFileOnDisk(
  path: string
): Promise<WorkspaceSyncBlobIdentity> {
  const handle = await openRegular(path);
  try {
    const before = await handle.stat();
    const hash = createHash('sha256');
    let sizeBytes = 0;
    for await (const chunk of readHandle(handle)) {
      hash.update(chunk);
      sizeBytes += chunk.length;
    }
    if (sizeBytes !== before.size || !sameFile(await handle.stat(), before))
      throw new Error('Workspace sync file changed during verification.');
    return { sha256: hash.digest('hex'), sizeBytes };
  } finally {
    await handle.close();
  }
}

export async function materializeWorkspaceSyncFile(
  file: Pick<WorkspaceSyncFile, 'sha256' | 'sizeBytes' | 'content' | 'encoding'>,
  target: string,
  options: CacheOptions = {}
): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  if (file.encoding !== 'blob') {
    const bytes = decodeBundleFileContent(file);
    const output = await open(target, 'wx', 0o600);
    try {
      await writeAll(output, bytes);
      await output.sync();
    } finally {
      await output.close();
    }
    return;
  }
  const cachePath = await workspaceSyncBlobPath(file.sha256, options.cacheRoot);
  const source = await openRegular(cachePath);
  const temp = `${target}.sync-${randomUUID()}`;
  let output: FileHandle | undefined;
  try {
    const before = await source.stat();
    if (before.size !== file.sizeBytes)
      throw new Error('Workspace sync cached blob size does not match.');
    checkAbort(options.signal);
    copyStableFileSync(cachePath, temp);
    output = await open(temp, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
    const copied = await output.stat();
    if (
      !copied.isFile() ||
      copied.size !== file.sizeBytes ||
      (copied.dev === before.dev && copied.ino === before.ino)
    ) {
      throw new Error('Workspace sync requires an independent regular replica file.');
    }
    const hash = createHash('sha256');
    let sizeBytes = 0;
    for await (const chunk of readHandle(output, options.signal)) {
      sizeBytes += chunk.length;
      if (sizeBytes > file.sizeBytes)
        throw new Error('Workspace sync cached blob grew during restore.');
      hash.update(chunk);
    }
    if (
      sizeBytes !== file.sizeBytes ||
      hash.digest('hex') !== file.sha256 ||
      !sameFile(await source.stat(), before) ||
      !sameFile(await output.stat(), copied)
    ) {
      throw new Error('Workspace sync cached blob digest does not match.');
    }
    await output.sync();
    await output.close();
    output = undefined;
    checkAbort(options.signal);
    await claimRegularFileNoClobber(temp, target);
  } finally {
    await source.close();
    await output?.close();
    await rm(temp, { force: true });
  }
}
