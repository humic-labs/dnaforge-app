// @vitest-environment node
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyStableFile } from './copy-independent-file';

describe('asynchronous stable file copy', () => {
  it('retains independent large bytes without mutating the source identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stable-copy-large-'));
    try {
      const source = join(root, 'source');
      const destination = join(root, 'destination');
      const bytes = Buffer.alloc(2 * 1024 * 1024, 91);
      await writeFile(source, bytes);
      const before = await lstat(source);
      await copyStableFile(source, destination);
      expect((await readFile(destination)).equals(bytes)).toBe(true);
      expect(await lstat(source)).toMatchObject({
        dev: before.dev,
        ino: before.ino,
        size: before.size,
        mtimeMs: before.mtimeMs,
        ctimeMs: before.ctimeMs,
      });
      const copied = await lstat(destination);
      expect(copied.ino).not.toBe(before.ino);
      await writeFile(source, Buffer.alloc(bytes.length, 37));
      expect((await readFile(destination)).equals(bytes)).toBe(true);
      expect((await readdir(root)).sort()).toEqual(['destination', 'source']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses an existing destination and removes its temporary copy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stable-copy-existing-'));
    try {
      const source = join(root, 'source');
      const destination = join(root, 'destination');
      await writeFile(source, 'source bytes');
      await writeFile(destination, 'existing bytes');
      await expect(copyStableFile(source, destination)).rejects.toMatchObject({
        code: 'EEXIST',
      });
      expect(await readFile(destination, 'utf8')).toBe('existing bytes');
      expect(await readFile(source, 'utf8')).toBe('source bytes');
      expect((await readdir(root)).sort()).toEqual(['destination', 'source']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
