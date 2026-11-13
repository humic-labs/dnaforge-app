import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const renameRefusals = vi.hoisted(() => ({ always: false }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const { existsSync: exists } = await import('node:fs');
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (renameRefusals.always || exists(to)) {
        throw Object.assign(
          new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`),
          {
            code: 'EPERM',
          }
        );
      }
      return actual.rename(from, to);
    },
  };
});

const { captureWorkspaceSyncBlob, receiveWorkspaceSyncBlob, workspaceSyncBlobPath } =
  await import('./workspace-sync-blob-cache');

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sync-blobs-windows-'));
  roots.push(root);
  return { root, cacheRoot: join(root, 'cache') };
}
afterEach(async () => {
  renameRefusals.always = false;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function leftovers(cacheRoot: string): Promise<string[]> {
  return (await readdir(cacheRoot)).filter((name) => name.startsWith('.'));
}

describe('blob cache when the filesystem refuses to replace an existing file, as Windows does', () => {
  it('captures the same bytes twice by keeping the verified cached copy', async () => {
    const { root, cacheRoot } = await fixture();
    const source = join(root, 'model.bin');
    const bytes = Buffer.alloc(256 * 1024, 42);
    await writeFile(source, bytes);
    const first = await captureWorkspaceSyncBlob(source, { cacheRoot, maxBytes: bytes.length });
    const second = await captureWorkspaceSyncBlob(source, { cacheRoot, maxBytes: bytes.length });
    expect(second).toEqual(first);
    expect(digest(await readFile(await workspaceSyncBlobPath(first.sha256, cacheRoot)))).toBe(
      digest(bytes)
    );
    expect(await leftovers(cacheRoot)).toEqual([]);
  });

  it('receives bytes that are already cached without failing', async () => {
    const { cacheRoot } = await fixture();
    const bytes = Buffer.from('shared note contents');
    const identity = { sha256: digest(bytes), sizeBytes: bytes.length };
    await receiveWorkspaceSyncBlob([bytes], identity, { cacheRoot });
    await receiveWorkspaceSyncBlob([bytes], identity, { cacheRoot });
    expect(await readFile(await workspaceSyncBlobPath(identity.sha256, cacheRoot))).toEqual(bytes);
    expect(await leftovers(cacheRoot)).toEqual([]);
  });

  it('replaces a damaged read-only cache entry with the verified bytes', async () => {
    const { root, cacheRoot } = await fixture();
    const source = join(root, 'model.bin');
    const bytes = Buffer.alloc(64 * 1024, 7);
    await writeFile(source, bytes);
    const path = await workspaceSyncBlobPath(digest(bytes), cacheRoot);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'damaged bytes');
    await chmod(path, 0o400);
    const identity = await captureWorkspaceSyncBlob(source, { cacheRoot, maxBytes: bytes.length });
    expect(identity.sha256).toBe(digest(bytes));
    expect(await readFile(path)).toEqual(bytes);
    expect(await leftovers(cacheRoot)).toEqual([]);
  });

  it('still fails when the rename is refused and nothing usable is cached', async () => {
    const { root, cacheRoot } = await fixture();
    const source = join(root, 'note.txt');
    await writeFile(source, 'note');
    renameRefusals.always = true;
    await expect(captureWorkspaceSyncBlob(source, { cacheRoot, maxBytes: 64 })).rejects.toThrow(
      /EPERM/
    );
    expect(existsSync(await workspaceSyncBlobPath(digest(Buffer.from('note')), cacheRoot))).toBe(
      false
    );
    expect(await leftovers(cacheRoot)).toEqual([]);
  });
});
