import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { serializeSequenceForInPlaceSave } from '@waypoint/sequence-utils';
import {
  buildSequencePackageDocument,
  fromPackageRelative,
  parseSequencePackageDocument,
  sequencePackagePaths,
  serializeSequencePackageDocument,
  type SequencePackageRevisionKind,
} from '../db/sequence-package';
import {
  publishSequencePackageRevisionInMain,
  recoverSequencePackageRevisionPublicationInMain,
} from './sequence-package-revision-publication';
import { setSequenceSaveAfterProductForTest } from './sequence-save-publication-test-seam';
import { createTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { createRegisteredSequencePackagePublicationContext } from './sequence-package-registry-publication';

const roots: string[] = [];
const databases: ReturnType<typeof createTestDb>[] = [];
const sha = (content: string) => `sha256:${createHash('sha256').update(content).digest('hex')}`;

afterEach(async () => {
  setSequenceSaveAfterProductForTest(undefined);
  for (const db of databases.splice(0)) db.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function publication(kind: SequencePackageRevisionKind = 'sequence-save') {
  const db = createTestDb();
  databases.push(db);
  ensureSchema(db, ':memory:');
  const context = createRegisteredSequencePackagePublicationContext({
    db,
    runDatabase: <T>(work: () => T): T => work(),
    getActiveAccountId: async () => null,
  });
  const root = await mkdtemp(join(tmpdir(), 'sequence-save-interruption-'));
  roots.push(root);
  const packageRoot = join(root, 'record');
  const paths = sequencePackagePaths(packageRoot, { productFile: 'record.gb' });
  await mkdir(paths.metaDir, { recursive: true });
  const content = (name: string, bases: string) =>
    serializeSequenceForInPlaceSave(
      {
        id: 'record',
        name,
        sequence: bases,
        length: bases.length,
        circular: false,
        annotations: [],
      },
      paths.productPath
    );
  const beforeProduct = content('Before', 'AACC');
  const afterProduct =
    kind === 'sequence-save' ? content('Before', 'AATT') : content('After', 'AACC');
  const document = buildSequencePackageDocument({
    id: 'record',
    name: 'Before',
    product: { file: 'record.gb', topology: 'linear' },
  });
  const beforeMarker = serializeSequencePackageDocument(document);
  await writeFile(paths.metaPath, beforeMarker);
  await writeFile(paths.productPath, beforeProduct);
  const input = {
    workspaceRoot: root,
    packageRoot,
    packageId: document.id,
    nextDocument: kind === 'metadata-update' ? { ...document, name: 'After' } : document,
    nextProductContent: afterProduct,
    kind,
    operationId: 'interrupted-save',
    revisionId: 'interrupted-save',
    adoptedRevisionId: 'before-save',
    expectedMarkerSha256: sha(beforeMarker),
    expectedProductSha256: sha(beforeProduct),
  } satisfies Parameters<typeof publishSequencePackageRevisionInMain>[0];
  return { root, packageRoot, paths, input, context, beforeProduct, afterProduct, beforeMarker };
}

describe('sequence Save durable product interruption boundary', () => {
  it('publishes an unarmed sequence Save without holding its product or marker', async () => {
    const fixture = await publication();
    await publishSequencePackageRevisionInMain(fixture.input, fixture.context);
    expect(await readFile(fixture.paths.productPath, 'utf8')).toBe(fixture.afterProduct);
    expect(
      parseSequencePackageDocument(await readFile(fixture.paths.metaPath, 'utf8')).versionHistory
        .headId
    ).toBe('interrupted-save');
    expect(JSON.parse(await readFile(fixture.paths.revisionJournalPath, 'utf8')).state).toBe(
      'complete'
    );
  });

  it('holds the pending journal and exact product snapshots before publishing the marker', async () => {
    const fixture = await publication();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = () => {};
    const checkpoint = new Promise<void>((resolve) => {
      reached = resolve;
    });
    setSequenceSaveAfterProductForTest(async (context) => {
      expect(context).toEqual({
        workspaceRoot: fixture.root,
        packageRoot: fixture.packageRoot,
        packageId: 'record',
        operationId: 'interrupted-save',
      });
      reached();
      await held;
    });
    const pending = publishSequencePackageRevisionInMain(fixture.input, fixture.context);
    try {
      expect(
        await Promise.race([checkpoint.then(() => 'paused'), pending.then(() => 'completed')])
      ).toBe('paused');
      expect(await readFile(fixture.paths.productPath, 'utf8')).toBe(fixture.afterProduct);
      expect(await readFile(fixture.paths.metaPath, 'utf8')).toBe(fixture.beforeMarker);
      const journal = JSON.parse(await readFile(fixture.paths.revisionJournalPath, 'utf8'));
      expect(journal).toMatchObject({
        schema: 'waypoint.sequence-revision-publication.v1',
        state: 'pending',
        packageId: 'record',
        operationId: 'interrupted-save',
        beforeMarkerContent: fixture.beforeMarker,
        beforeProductSha256: sha(fixture.beforeProduct),
        afterProductSha256: sha(fixture.afterProduct),
      });
      expect(
        await readFile(
          fromPackageRelative(journal.beforeProductSnapshotPath, fixture.packageRoot),
          'utf8'
        )
      ).toBe(fixture.beforeProduct);
      expect(
        await readFile(
          fromPackageRelative(journal.nextProductSnapshotPath, fixture.packageRoot),
          'utf8'
        )
      ).toBe(fixture.afterProduct);
      release();
      await pending;
      expect(await readFile(fixture.paths.metaPath, 'utf8')).toBe(journal.nextMarkerContent);
      expect(JSON.parse(await readFile(fixture.paths.revisionJournalPath, 'utf8')).state).toBe(
        'complete'
      );
    } finally {
      release();
      await pending;
    }
  });

  it('retains the torn publication after interruption and recovers it twice without reentering the pause', async () => {
    const fixture = await publication();
    let hits = 0;
    const interrupted = new Error('Owned interruption after durable Save product');
    setSequenceSaveAfterProductForTest(async () => {
      hits += 1;
      throw interrupted;
    });
    await expect(publishSequencePackageRevisionInMain(fixture.input, fixture.context)).rejects.toBe(
      interrupted
    );
    expect(hits).toBe(1);
    expect(await readFile(fixture.paths.productPath, 'utf8')).toBe(fixture.afterProduct);
    expect(await readFile(fixture.paths.metaPath, 'utf8')).toBe(fixture.beforeMarker);
    const journal = JSON.parse(await readFile(fixture.paths.revisionJournalPath, 'utf8'));
    expect(journal.state).toBe('pending');
    await recoverSequencePackageRevisionPublicationInMain(
      fixture.root,
      fixture.packageRoot,
      fixture.context
    );
    const recoveredMarker = await readFile(fixture.paths.metaPath, 'utf8');
    const recoveredJournal = await readFile(fixture.paths.revisionJournalPath, 'utf8');
    expect(recoveredMarker).toBe(journal.nextMarkerContent);
    expect(parseSequencePackageDocument(recoveredMarker).versionHistory.headId).toBe(
      'interrupted-save'
    );
    expect(JSON.parse(recoveredJournal).state).toBe('complete');
    await recoverSequencePackageRevisionPublicationInMain(
      fixture.root,
      fixture.packageRoot,
      fixture.context
    );
    expect(await readFile(fixture.paths.productPath, 'utf8')).toBe(fixture.afterProduct);
    expect(await readFile(fixture.paths.metaPath, 'utf8')).toBe(recoveredMarker);
    expect(await readFile(fixture.paths.revisionJournalPath, 'utf8')).toBe(recoveredJournal);
    expect(hits).toBe(1);
  });

  it('leaves a changed metadata product outside the sequence Save pause', async () => {
    const fixture = await publication('metadata-update');
    setSequenceSaveAfterProductForTest(async () => {
      throw new Error('A metadata publication entered the sequence Save pause');
    });
    await publishSequencePackageRevisionInMain(fixture.input, fixture.context);
    expect(await readFile(fixture.paths.productPath, 'utf8')).toBe(fixture.afterProduct);
    expect(JSON.parse(await readFile(fixture.paths.revisionJournalPath, 'utf8')).state).toBe(
      'complete'
    );
  });
});
