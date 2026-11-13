import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ContentArchive } from './content-archive';

describe('ContentArchive interrupted-manifest cleanup', () => {
  let root: string | null = null;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = null;
  });

  it('removes only unpublished UUID-named manifest temp files', async () => {
    root = await mkdtemp(join(tmpdir(), 'content-archive-cleanup-'));
    const manifestDirectory = join(root, 'manifests');
    await mkdir(manifestDirectory, { recursive: true });
    const temporary = '.supplemental-abc.12345678-1234-1234-1234-123456789abc.tmp';
    await writeFile(join(manifestDirectory, temporary), 'partial');
    await writeFile(join(manifestDirectory, 'supplemental-abc.json'), '{}');
    await writeFile(join(manifestDirectory, '.operator-note.tmp'), 'keep');

    await expect(new ContentArchive(root).cleanupTemporaryManifests()).resolves.toBe(1);
    await expect(readdir(manifestDirectory)).resolves.toEqual([
      '.operator-note.tmp',
      'supplemental-abc.json',
    ]);
  });
});
