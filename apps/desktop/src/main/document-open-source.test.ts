import { mkdtemp, realpath, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocumentOpenSource } from './document-open-source';

vi.mock('./ipc/path-allowlist', () => ({
  assertSafePath: vi.fn(async (path: string) => {
    try {
      return await realpath(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return path;
    }
  }),
}));

describe('document check source capture', () => {
  let root: string;
  let path: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'document-check-')));
    path = join(root, 'sample.csv');
    await writeFile(path, 'name,value\noriginal,3\n');
  });
  afterEach(() => rm(root, { force: true, recursive: true }));

  function capture() {
    return createDocumentOpenSource({} as Database.Database, root, path, root);
  }

  it('reads an observed file and detects an equal-size atomic replacement with an old timestamp', async () => {
    const first = capture();
    expect(await first.forPath(path).readText(path)).toContain('original');
    const initialRevision = await first.verifyCurrent();
    const replacement = join(root, 'replacement');
    await writeFile(replacement, 'name,value\nreplaced,4\n');
    const observed = await first.observeFile(path);
    await utimes(
      replacement,
      Number(observed.stat!.atimeMs) / 1000,
      Number(observed.stat!.mtimeMs) / 1000
    );
    await rename(replacement, path);
    await expect(first.verifyCurrent()).rejects.toMatchObject({ code: 'changed' });
    const fresh = capture();
    expect(await fresh.forPath(path).readText(path)).toContain('replaced');
    expect(await fresh.verifyCurrent()).not.toBe(initialRevision);
  });

  it('observes absence so that restoring a required file invalidates the result', async () => {
    const pending = capture();
    const source = pending.forPath(path);
    const sibling = join(root, 'missing.csv');
    await expect(source.readText(sibling)).rejects.toMatchObject({ code: 'missing-asset' });
    expect(pending.paths()).toContain(sibling);
    await writeFile(sibling, 'name,value\na,3\n');
    await expect(pending.verifyCurrent()).rejects.toMatchObject({ code: 'changed' });
  });

  it('rejects a source that resolves outside the project and does not return its path to watch', async () => {
    const pending = capture();
    const link = join(root, 'outside.csv');
    await symlink(tmpdir(), link);
    await expect(pending.forPath(path).readBytes(link)).rejects.toMatchObject({
      code: 'permission',
    });
    expect(pending.paths()).not.toContain(link);
  });

  it('invalidates a document when its accepted revision changes without a disk edit', async () => {
    const pending = capture();
    const source = pending.forPath(path);
    await source.observe(path);
    let commit = 'record-1';
    await source.observeRevision('accepted', () => commit);
    await pending.verifyCurrent();
    commit = 'record-2';
    await expect(pending.verifyCurrent()).rejects.toMatchObject({ code: 'changed' });
  });
});
