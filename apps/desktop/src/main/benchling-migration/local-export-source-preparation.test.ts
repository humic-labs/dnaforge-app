import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';

import { prepareLocalBenchlingExportSource } from './local-export-source-preparation';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true })));
});

describe('prepareLocalBenchlingExportSource', () => {
  it('passes an original ZIP through unchanged', async () => {
    const root = await temporaryRoot();
    const sourcePath = join(root, 'Benchling export.zip');
    await writeFile(sourcePath, 'zip fixture');

    await expect(
      prepareLocalBenchlingExportSource({ sourcePath, stagingRootDir: join(root, 'staging') })
    ).resolves.toEqual({
      archivePath: sourcePath,
      sourceDisplayName: 'Benchling export.zip',
      managed: false,
    });
  });

  it('streams an unzipped export folder into an importable ZIP without adding a wrapper folder', async () => {
    const root = await temporaryRoot();
    const sourcePath = join(root, 'Benchling export');
    await mkdir(join(sourcePath, 'nested'), { recursive: true });
    await writeFile(join(sourcePath, 'index.html'), '<html>export</html>');
    await writeFile(join(sourcePath, 'nested', 'sequence.gb'), 'LOCUS sequence');

    const prepared = await prepareLocalBenchlingExportSource({
      sourcePath,
      stagingRootDir: join(root, 'staging'),
    });

    expect(prepared.managed).toBe(true);
    expect(prepared.sourceDisplayName).toBe('Benchling export');
    const files = unzipSync(new Uint8Array(await readFile(prepared.archivePath)));
    expect(Object.keys(files)).toEqual(['index.html', 'nested/sequence.gb']);
    expect(strFromU8(files['index.html'])).toBe('<html>export</html>');
    expect(strFromU8(files['nested/sequence.gb'])).toBe('LOCUS sequence');
  });

  it('rejects aliases inside the selected folder', async () => {
    const root = await temporaryRoot();
    const sourcePath = join(root, 'Benchling export');
    await mkdir(sourcePath);
    await writeFile(join(root, 'outside.html'), '<html>outside</html>');
    await symlink(join(root, 'outside.html'), join(sourcePath, 'linked.html'));

    await expect(
      prepareLocalBenchlingExportSource({ sourcePath, stagingRootDir: join(root, 'staging') })
    ).rejects.toThrow('contains an alias');
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'benchling-export-source-'));
  temporaryRoots.push(root);
  return root;
}
