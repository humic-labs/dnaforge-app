import { createHash } from 'node:crypto';
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  captureWorkspaceSyncBlob,
  materializeWorkspaceSyncFile,
  receiveWorkspaceSyncBlob,
  workspaceSyncBlobPath,
} from './workspace-sync-blob-cache';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sync-blobs-'));
  roots.push(root);
  return { root, cacheRoot: join(root, 'cache') };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('durable workspace sync blob cache', () => {
  it('captures independent immutable bytes when a redundant streamed copy would fail', async () => {
    const { root, cacheRoot } = await fixture();
    const source = join(root, 'large.bin');
    const bytes = Buffer.alloc(2 * 1024 * 1024, 91);
    await writeFile(source, bytes);
    const before = await lstat(source);
    const probe = await open(join(root, 'probe'), 'wx');
    const prototype: FileHandle = Object.getPrototypeOf(probe);
    await probe.close();
    const write = vi
      .spyOn(prototype, 'write')
      .mockRejectedValue(
        Object.assign(new Error('Redundant capture write failed.'), { code: 'ENOSPC' })
      );
    const identity = await captureWorkspaceSyncBlob(source, { cacheRoot, maxBytes: bytes.length });
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
    const captured = await workspaceSyncBlobPath(identity.sha256, cacheRoot);
    expect(identity).toEqual({ sha256: digest(bytes), sizeBytes: bytes.length });
    expect((await lstat(captured)).ino).not.toBe(before.ino);
    expect(await lstat(source)).toMatchObject({
      ino: before.ino,
      ctimeMs: before.ctimeMs,
      mtimeMs: before.mtimeMs,
    });
    await writeFile(source, 'a later local edit');
    expect(digest(await readFile(captured))).toBe(digest(bytes));
  });
  it('restores a verified cached file when writing a second full byte copy would fail', async () => {
    const { root, cacheRoot } = await fixture();
    const bytes = Buffer.alloc(2 * 1024 * 1024, 73);
    const identity = { sha256: digest(bytes), sizeBytes: bytes.length };
    await receiveWorkspaceSyncBlob([bytes], identity, { cacheRoot });
    const cachePath = await workspaceSyncBlobPath(identity.sha256, cacheRoot);
    const before = await lstat(cachePath);
    const probe = await open(join(root, 'probe'), 'wx');
    const prototype: FileHandle = Object.getPrototypeOf(probe);
    await probe.close();
    const write = vi
      .spyOn(prototype, 'write')
      .mockRejectedValue(
        Object.assign(new Error('No room for a redundant streamed byte copy.'), { code: 'ENOSPC' })
      );
    const target = join(root, 'restored.bin');
    await materializeWorkspaceSyncFile({ ...identity, content: '', encoding: 'blob' }, target, {
      cacheRoot,
    });
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
    const restored = await lstat(target);
    expect(restored.ino).not.toBe(before.ino);
    expect(restored.mode & 0o777).toBe(0o600);
    expect(digest(await readFile(target))).toBe(identity.sha256);
    expect(await lstat(cachePath)).toMatchObject({
      ino: before.ino,
      size: before.size,
      mtimeMs: before.mtimeMs,
      ctimeMs: before.ctimeMs,
    });
    await writeFile(target, 'local edit');
    expect(digest(await readFile(cachePath))).toBe(identity.sha256);
  });

  it('preserves a destination created by another writer before materialization', async () => {
    const { root, cacheRoot } = await fixture();
    const bytes = Buffer.from('verified cloud content');
    const identity = { sha256: digest(bytes), sizeBytes: bytes.length };
    await receiveWorkspaceSyncBlob([bytes], identity, { cacheRoot });
    const target = join(root, 'local.bin');
    await writeFile(target, 'existing local content');
    await expect(
      materializeWorkspaceSyncFile({ ...identity, content: '', encoding: 'blob' }, target, {
        cacheRoot,
      })
    ).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(target, 'utf8')).toBe('existing local content');
    expect((await readdir(root)).some((name) => name.startsWith('local.bin.sync-'))).toBe(false);
  });

  it('captures and restores exact bytes without embedding them in a snapshot', async () => {
    const { root, cacheRoot } = await fixture();
    const bytes = Buffer.alloc(8 * 1024 * 1024, 65);
    const source = join(root, 'design.gb');
    await writeFile(source, bytes);
    const identity = await captureWorkspaceSyncBlob(source, {
      cacheRoot,
      maxBytes: bytes.length,
      utf8: true,
    });
    expect(identity).toEqual({ sha256: digest(bytes), sizeBytes: bytes.length });
    await writeFile(source, 'later edit');
    const target = join(root, 'restored.gb');
    await materializeWorkspaceSyncFile({ ...identity, content: '', encoding: 'blob' }, target, {
      cacheRoot,
    });
    expect(digest(await readFile(target))).toBe(digest(bytes));
  });

  it('never publishes truncated, oversized, or corrupt downloads', async () => {
    const { cacheRoot } = await fixture();
    const bytes = Buffer.from('verified bytes');
    const identity = { sha256: digest(bytes), sizeBytes: bytes.length };
    for (const invalid of [
      bytes.subarray(1),
      Buffer.concat([bytes, bytes]),
      Buffer.alloc(bytes.length),
    ]) {
      await expect(receiveWorkspaceSyncBlob([invalid], identity, { cacheRoot })).rejects.toThrow();
      await expect(
        readFile(await workspaceSyncBlobPath(identity.sha256, cacheRoot))
      ).rejects.toMatchObject({ code: 'ENOENT' });
    }
    await receiveWorkspaceSyncBlob([bytes.subarray(0, 3), bytes.subarray(3)], identity, {
      cacheRoot,
    });
    expect(await readFile(await workspaceSyncBlobPath(identity.sha256, cacheRoot))).toEqual(bytes);
  });

  it('rejects symlinks, growth beyond admission, and invalid UTF-8', async () => {
    const { root, cacheRoot } = await fixture();
    const source = join(root, 'source');
    await writeFile(source, Buffer.from([0xff]));
    await symlink(source, join(root, 'link'));
    await expect(
      captureWorkspaceSyncBlob(join(root, 'link'), { cacheRoot, maxBytes: 10 })
    ).rejects.toThrow();
    await expect(captureWorkspaceSyncBlob(source, { cacheRoot, maxBytes: 0 })).rejects.toThrow();
    await expect(
      captureWorkspaceSyncBlob(source, { cacheRoot, maxBytes: 10, utf8: true })
    ).rejects.toThrow();
  });

  it('detects corruption of durable bytes before restoring a replica', async () => {
    const { root, cacheRoot } = await fixture();
    const bytes = Buffer.from('verified bytes');
    const identity = { sha256: digest(bytes), sizeBytes: bytes.length };
    await receiveWorkspaceSyncBlob([bytes], identity, { cacheRoot });
    const { chmod } = await import('node:fs/promises');
    const path = await workspaceSyncBlobPath(identity.sha256, cacheRoot);
    await chmod(path, 0o600);
    await writeFile(path, Buffer.alloc(bytes.length));
    await expect(
      materializeWorkspaceSyncFile(
        { ...identity, content: '', encoding: 'blob' },
        join(root, 'replica.gb'),
        { cacheRoot }
      )
    ).rejects.toThrow(/digest/);
    expect((await readdir(root)).some((name) => name.startsWith('replica.gb.sync-'))).toBe(false);
    await expect(lstat(join(root, 'replica.gb'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not create a replica or staging files after cancellation', async () => {
    const { root, cacheRoot } = await fixture();
    const bytes = Buffer.from('verified bytes');
    const identity = { sha256: digest(bytes), sizeBytes: bytes.length };
    await receiveWorkspaceSyncBlob([bytes], identity, { cacheRoot });
    const controller = new AbortController();
    controller.abort(new Error('restore cancelled'));
    const target = join(root, 'cancelled.bin');
    await expect(
      materializeWorkspaceSyncFile({ ...identity, content: '', encoding: 'blob' }, target, {
        cacheRoot,
        signal: controller.signal,
      })
    ).rejects.toThrow('restore cancelled');
    await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(root)).some((name) => name.startsWith('cancelled.bin.sync-'))).toBe(
      false
    );
  });
});
