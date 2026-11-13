// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyIndependentFile, copyIndependentFileSync } from './copy-independent-file';

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

describe.each([
  ['async import', copyIndependentFile],
  [
    'sync upload journal',
    async (source: string, destination: string) => copyIndependentFileSync(source, destination),
  ],
] as const)('independent copies: %s', (_name, copy) => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'independent-import-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('copies real large bytes into a distinct inode and keeps later edits independent', async () => {
    const source = join(root, 'large source.bin');
    const destination = join(root, 'large destination.bin');
    const bytes = Buffer.alloc(2 * 1024 * 1024, 73);
    await writeFile(source, bytes);
    await copy(source, destination);
    expect(digest(await readFile(destination))).toBe(digest(bytes));
    expect((await stat(source)).ino).not.toBe((await stat(destination)).ino);
    await writeFile(destination, 'local edit');
    expect(digest(await readFile(source))).toBe(digest(bytes));
    await writeFile(source, 'source edit');
    expect(await readFile(destination, 'utf8')).toBe('local edit');
  });

  it('preserves an existing destination and cleans its private staging directory', async () => {
    const source = join(root, 'source.bin');
    const destination = join(root, 'destination.bin');
    await writeFile(source, Buffer.alloc(2 * 1024 * 1024, 73));
    await writeFile(destination, 'existing project data');
    await expect(copy(source, destination)).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(await readFile(destination, 'utf8')).toBe('existing project data');
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(root)).sort()).toEqual(['destination.bin', 'source.bin']);
  });

  it('rejects a symbolic-link source without following it', async () => {
    const source = join(root, 'source.bin');
    await writeFile(source, 'private source');
    await symlink(source, join(root, 'link.bin'));
    await expect(copy(join(root, 'link.bin'), join(root, 'copy.bin'))).rejects.toThrow(
      'IMPORT_COPY_SOURCE_NOT_REGULAR'
    );
  });
});
