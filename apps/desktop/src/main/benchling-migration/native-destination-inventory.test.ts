import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { readUnlockedNativeDestinations } from './linked-item-recovery-executor';
import { verifyProjectionReceiptIntegrity } from './projection-writer';
import { MIGRATION_DESTINATION_LINK_INDEX_RELATIVE_PATH } from '../../shared/benchling-migration-destination-index';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('inventories v2 files and package contents without a Git repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-destination-inventory-'));
  roots.push(root);
  await mkdir(join(root, '.forge'));
  await mkdir(join(root, 'Notebook/.forge'), { recursive: true });
  await writeFile(join(root, 'DNA.gb'), 'DNA bytes');
  await writeFile(join(root, 'Notebook/.forge/notebook.json'), 'Notebook bytes');
  await writeFile(join(root, 'Notebook/image.png'), 'Image bytes');
  await writeFile(join(root, 'Unrelated.txt'), 'User bytes');
  await writeFile(
    join(root, '.forge/catalog.json'),
    JSON.stringify({
      schema: 'dnaforge.native-workspace-manifest.v2',
      entities: [
        {
          id: 'dna',
          type: 'sequence',
          name: 'DNA',
          placement: { kind: 'file', relativePath: 'DNA.gb', fileKind: 'genbank' },
        },
        {
          id: 'note',
          type: 'notebook',
          name: 'Notebook',
          placement: {
            kind: 'package',
            rootRelativePath: 'Notebook',
            primaryRelativePath: 'Notebook/.forge/notebook.json',
            fileKind: 'notebook',
          },
        },
      ],
      links: [],
    })
  );
  const gitFiles = vi.fn(async () => {
    throw new Error('No Git repository');
  });
  expect(await readUnlockedNativeDestinations(root, gitFiles)).toEqual([
    { path: 'DNA.gb', kind: 'file' },
    { path: 'Notebook/.forge/notebook.json', kind: 'file' },
    { path: 'Notebook/image.png', kind: 'file' },
  ]);
  expect(gitFiles).not.toHaveBeenCalled();
  await mkdir(join(root, '.dnaforge/migration'), { recursive: true });
  await writeFile(join(root, MIGRATION_DESTINATION_LINK_INDEX_RELATIVE_PATH), '{}');
  const integrity = await verifyProjectionReceiptIntegrity({
    workspacePath: root,
    receipts: [],
    preservedDestinationPaths: await readUnlockedNativeDestinations(root, gitFiles),
    destinationArtifacts: { collectionDocumentPaths: [] },
  });
  expect(integrity.failures).toEqual([]);
});
