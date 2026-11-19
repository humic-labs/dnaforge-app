import { sangerRead } from '../test/sanger-read-fixture';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { decodeSequenceDocument } from '@waypoint/sequence-utils';
import { parseSequencePackageDocument } from '../db/sequence-package';
import { MOLECULAR_VIEW_MAX_COORDINATE_BYTES } from '../shared/molecular-view';
import { createTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { readFileBoundedFromHandle } from './ipc/bounded-file-read';
import { collectManagedCatalogHeadIndex } from './workspace-git/head-index';
import {
  importSourceDocumentPackage,
  prepareSourceDocumentPackage,
  readProjectSourceDocumentPackage,
  readProjectSourceDocumentPresentation,
  readSourceDocumentPresentation,
} from './source-document-package-store';

vi.mock('electron', () => ({ app: { getVersion: () => '1.0.0' }, dialog: {} }));
vi.mock('./molecular-catalog/inventory-worker', async () => ({
  inventoryCoordinatesInWorker: (await import('./molecular-catalog/coordinate-inventory'))
    .parseCoordinateInventory,
}));

let temp: string;
let store: string;
let db: ReturnType<typeof createTestDb>;
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), 'source-package-test-'));
  store = join(temp, 'cache');
  db = createTestDb();
  ensureSchema(db, ':memory:');
});
afterEach(async () => {
  db.close();
  await rm(temp, { recursive: true, force: true });
});

const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

it('reopens ordered mixed FASTA records after the source is deleted and rejects a corrupted package', async () => {
  const original = '>dup DNA\r\naCgT\r\n>dup protein\r\nMPEPTIDE*\r\n';
  const sourcePath = join(temp, 'collection.fa');
  await writeFile(sourcePath, original);
  const read = vi.fn(readFileBoundedFromHandle);
  const descriptor = await prepareSourceDocumentPackage(
    store,
    { familyId: 'fasta', sourcePath },
    read
  );
  expect(read).toHaveBeenCalledTimes(1);
  expect(descriptor.presentation).toBe('fasta-collection');
  await unlink(sourcePath);
  expect(await readSourceDocumentPresentation(store, descriptor.packageId)).toEqual({
    familyId: 'fasta',
    sourceSha256: digest(original),
    records: [
      { name: 'dup', description: 'DNA', sequence: 'aCgT', length: 4 },
      { name: 'dup', description: 'protein', sequence: 'MPEPTIDE*', length: 9 },
    ],
  });
  await writeFile(join(descriptor.packageRoot, 'records.json'), '[]');
  await expect(readSourceDocumentPresentation(store, descriptor.packageId)).rejects.toThrow(
    'changed'
  );
});

it('preserves independent editable products across projects, reuses an edited install, and indexes its native records', async () => {
  const sourcePath = join(temp, 'records.fna');
  await writeFile(
    sourcePath,
    '>a first\n' + 'ACGT'.repeat(32) + '\n>b second\n' + 'TGCA'.repeat(32) + '\n'
  );
  const deps = { db, managedRootDir: join(temp, 'projects') };
  const captured = await prepareSourceDocumentPackage(store, { familyId: 'fasta', sourcePath });
  await unlink(sourcePath);
  const first = await importSourceDocumentPackage(store, captured.packageId, null, deps);
  const second = await importSourceDocumentPackage(store, captured.packageId, null, deps);
  expect(first.descriptor.packageId).not.toBe(second.descriptor.packageId);
  const ids = new Set<string>();
  for (const project of [first, second]) {
    const { descriptor } = await readProjectSourceDocumentPackage(
      project.workspaceRoot,
      project.destPath
    );
    expect(descriptor.productPaths).toHaveLength(2);
    for (const path of descriptor.productPaths) {
      ids.add(
        parseSequencePackageDocument(
          await readFile(join(dirname(path), '.forge/plasmid.json'), 'utf8')
        ).id
      );
    }
  }
  expect(ids.size).toBe(4);
  const original = await readFile(first.destPath, 'utf8');
  await writeFile(first.destPath, original.replace('ORIGIN', 'COMMENT     locally edited\nORIGIN'));
  expect(await readFile(first.destPath, 'utf8')).not.toBe(original);
  expect(await readFile(second.destPath, 'utf8')).toBe(original);
  const provenance = await readFile(first.descriptor.originalPath);
  await rm(store, { recursive: true });
  await writeFile(sourcePath, provenance);
  expect(
    (await prepareSourceDocumentPackage(store, { familyId: 'fasta', sourcePath })).packageId
  ).toBe(captured.packageId);
  await unlink(sourcePath);
  const again = await importSourceDocumentPackage(
    store,
    captured.packageId,
    first.workspaceRoot,
    deps
  );
  expect(again.destPath).toBe(first.destPath);
  expect(await readFile(first.destPath, 'utf8')).toContain('locally edited');
  const files = (
    await collectManagedCatalogHeadIndex(first.workspaceRoot, [], { healWorkingTree: false })
  ).files.map((f) => f.relPath);
  expect(files.filter((x) => x.endsWith('/.forge/plasmid.json'))).toHaveLength(2);
  expect(files).not.toContain(
    relative(first.workspaceRoot, first.descriptor.originalPath).split('\\').join('/')
  );
  await expect(
    readProjectSourceDocumentPresentation(first.workspaceRoot, first.destPath, {
      expectedPackageId: second.descriptor.packageId,
    })
  ).rejects.toThrow('no longer matches');
}, 30_000);

it('retains coordinates above the molecular-document limit as a project-owned coordinate asset', async () => {
  const sample = await readFile(
    join(process.cwd(), '../../test-fixtures/structure-complexes/rcsb/1FS0.cif')
  );
  const original = Buffer.concat([
    sample,
    Buffer.from('\n#' + 'x'.repeat(MOLECULAR_VIEW_MAX_COORDINATE_BYTES) + '\n'),
  ]);
  const sourcePath = join(temp, 'large.cif');
  await writeFile(sourcePath, original);
  const captured = await prepareSourceDocumentPackage(store, { familyId: 'structure', sourcePath });
  expect(captured.presentation).toBe('coordinate-asset');
  await unlink(sourcePath);
  const before = await readSourceDocumentPresentation(store, captured.packageId);
  expect(
    before.familyId === 'structure' &&
      'coordinateAsset' in before &&
      digest(before.coordinateAsset.bytes)
  ).toBe(digest(original));
  const project = await importSourceDocumentPackage(store, captured.packageId, null, {
    db,
    managedRootDir: join(temp, 'projects'),
  });
  await rm(store, { recursive: true });
  const after = await readProjectSourceDocumentPresentation(
    project.workspaceRoot,
    project.destPath,
    { expectedPackageId: project.descriptor.packageId, expectedSourceSha256: captured.sha256 }
  );
  expect(
    after.familyId === 'structure' &&
      'coordinateAsset' in after &&
      digest(after.coordinateAsset.bytes)
  ).toBe(digest(original));
}, 30_000);

it('publishes no package for invalid coordinates or malformed traces', async () => {
  for (const [familyId, name] of [
    ['structure', 'model.pdb'],
    ['chromatogram', 'trace.ab1'],
  ] as const) {
    const sourcePath = join(temp, name);
    await writeFile(sourcePath, 'invalid file');
    await expect(prepareSourceDocumentPackage(store, { familyId, sourcePath })).rejects.toThrow();
    expect(await readdir(store)).toEqual([]);
  }
});

it('reopens an installed chromatogram with the captured base calls, quality and original sample bytes', async () => {
  const original = sangerRead();
  const sourcePath = join(temp, 'experiment.abi');
  await writeFile(sourcePath, original);
  const captured = await prepareSourceDocumentPackage(store, {
    familyId: 'chromatogram',
    sourcePath,
  });
  await writeFile(sourcePath, 'another file');
  const project = await importSourceDocumentPackage(store, captured.packageId, null, {
    db,
    managedRootDir: join(temp, 'projects'),
  });
  await rm(store, { recursive: true });
  const after = await readProjectSourceDocumentPresentation(
    project.workspaceRoot,
    project.destPath
  );
  if (after.familyId !== 'chromatogram') throw Error('Expected an ABIF trace');
  expect(digest(after.bytes)).toBe(digest(original));
  const { sequence } = decodeSequenceDocument(after.bytes, { format: 'ab1', path: sourcePath });
  expect(sequence.sequence).toBe('AC');
  expect(sequence.quality).toEqual([27, 39]);
});
