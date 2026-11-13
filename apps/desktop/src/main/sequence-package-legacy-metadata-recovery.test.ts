import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildSequencePackageDocument,
  parseSequencePackageDocument,
  sequencePackagePaths,
  serializeSequencePackageDocument,
} from '../db/sequence-package';
import { SEQUENCE_PACKAGE_METADATA_TRANSACTION_NAME } from '../db/sequence-package-contract';
import { publishSequencePackageRevisionInMain } from './sequence-package-revision-publication';
import { recoverLegacySequenceMetadataTransactionInMain } from './sequence-package-legacy-metadata-recovery';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function pendingPackage() {
  const root = await mkdtemp(join(tmpdir(), 'legacy-sequence-metadata-'));
  roots.push(root);
  const packageRoot = join(root, 'record');
  const paths = sequencePackagePaths(packageRoot);
  await mkdir(paths.metaDir, { recursive: true });
  const before = buildSequencePackageDocument({
    id: 'record',
    name: 'Before',
    product: { file: 'record.gb', topology: 'linear' },
  });
  const target = {
    ...before,
    name: 'After',
    product: { ...before.product, topology: 'circular' as const },
  };
  const product = 'LOCUS       record 4 bp DNA linear\nORIGIN\n        1 nnnn\n//\n';
  const journalPath = join(paths.metaDir, SEQUENCE_PACKAGE_METADATA_TRANSACTION_NAME);
  await writeFile(paths.metaPath, serializeSequencePackageDocument(before));
  await writeFile(paths.productPath, product);
  await writeFile(
    journalPath,
    `${JSON.stringify({
      schema: 'waypoint.sequence-metadata-transaction.v1',
      state: 'pending',
      packageId: before.id,
      targetDocument: target,
      applyLocus: false,
      applyTopology: true,
    })}\n`
  );
  return { root, packageRoot, paths, journalPath, before, target, product };
}

describe('main-owned legacy metadata recovery', () => {
  it('rolls a pending product and marker forward together and becomes inert on retry', async () => {
    const fixture = await pendingPackage();
    await recoverLegacySequenceMetadataTransactionInMain(fixture.root, fixture.packageRoot);

    const product = await readFile(fixture.paths.productPath, 'utf8');
    expect(product).toContain('circular');
    expect(parseSequencePackageDocument(await readFile(fixture.paths.metaPath, 'utf8')).name).toBe(
      'After'
    );
    expect(JSON.parse(await readFile(fixture.journalPath, 'utf8')).state).toBe('complete');

    await recoverLegacySequenceMetadataTransactionInMain(fixture.root, fixture.packageRoot);
    expect(await readFile(fixture.paths.productPath, 'utf8')).toBe(product);
  });

  it('resumes after a crash with product already changed but marker still old', async () => {
    const fixture = await pendingPackage();
    await writeFile(fixture.paths.productPath, fixture.product.replace('linear', 'circular'));

    await recoverLegacySequenceMetadataTransactionInMain(fixture.root, fixture.packageRoot);
    expect(parseSequencePackageDocument(await readFile(fixture.paths.metaPath, 'utf8')).name).toBe(
      'After'
    );
    expect(JSON.parse(await readFile(fixture.journalPath, 'utf8')).state).toBe('complete');
  });

  it('refuses a new package publication while a legacy journal is pending', async () => {
    const fixture = await pendingPackage();
    await expect(
      publishSequencePackageRevisionInMain({
        workspaceRoot: fixture.root,
        packageRoot: fixture.packageRoot,
        packageId: fixture.before.id,
        nextDocument: fixture.target,
        nextProductContent: fixture.product,
        kind: 'metadata-update',
        operationId: 'new-metadata',
        revisionId: 'new-metadata',
        expectedMarkerSha256: '',
        expectedProductSha256: '',
      })
    ).rejects.toThrow('legacy metadata recovery');
    expect(parseSequencePackageDocument(await readFile(fixture.paths.metaPath, 'utf8')).name).toBe(
      'Before'
    );
  });

  it('keeps a newer publisher behind the lock while product and marker recovery is incomplete', async () => {
    const fixture = await pendingPackage();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reachedGap!: () => void;
    const gap = new Promise<void>((resolve) => {
      reachedGap = resolve;
    });
    const recovery = recoverLegacySequenceMetadataTransactionInMain(
      fixture.root,
      fixture.packageRoot,
      {
        afterProductWrite: async () => {
          reachedGap();
          await gate;
        },
      }
    );
    await gap;
    expect(await readFile(fixture.paths.productPath, 'utf8')).toContain('circular');
    expect(parseSequencePackageDocument(await readFile(fixture.paths.metaPath, 'utf8')).name).toBe(
      'Before'
    );

    let publicationSettled = false;
    const publication = publishSequencePackageRevisionInMain({
      workspaceRoot: fixture.root,
      packageRoot: fixture.packageRoot,
      packageId: fixture.before.id,
      nextDocument: fixture.target,
      nextProductContent: fixture.product,
      kind: 'metadata-update',
      operationId: 'concurrent-metadata',
      revisionId: 'concurrent-metadata',
      expectedMarkerSha256: '',
      expectedProductSha256: '',
    });
    void publication.then(
      () => {
        publicationSettled = true;
      },
      () => {
        publicationSettled = true;
      }
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(publicationSettled).toBe(false);
    } finally {
      release();
    }
    await recovery;
    await expect(publication).rejects.toThrow(
      'Sequence package changed after this edit was prepared'
    );
    expect(JSON.parse(await readFile(fixture.journalPath, 'utf8')).state).toBe('complete');
  });
});

import type Database from 'better-sqlite3';
import { createTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
vi.mock('./ipc/database', () => ({ getDb: () => registryPublicationDb }));
let registryPublicationDb: Database.Database;
beforeEach(() => {
  registryPublicationDb = createTestDb();
  ensureSchema(registryPublicationDb, ':memory:');
});
afterEach(() => {
  registryPublicationDb.close();
});
