import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseNotebookPackageMetadata } from '../../db/notebook-package';
import {
  notebookPayloadPathsFromMarkdown,
  parseNotebookMarkdown,
} from '../../db/notebook-markdown-codec';
import { createTestDb } from '../__tests__/test-db';
import { ensureSchema } from '../schema';
import {
  isValidationReportV2,
  type MigrationRun,
  type ProjectionReceipt,
} from '../../shared/benchling-migration';
import { buildSyntheticNativeExportZip } from './__fixtures__/native-export-zip-fixture';
import { ContentArchive } from './content-archive';
import { collectionDestinationId } from './collection-projection';
import {
  createThrottledWorkProgressPublisher,
  readUnlockedNativeDestinations,
  recoverLinkedItemsFromLocalExports,
  runLocalExportAttempt,
  type LinkedItemRecoveryExecutorDeps,
} from './linked-item-recovery-executor';
import { executeLocalBundleMigration, type LocalBundleExecutorDeps } from './local-bundle-executor';
import { intakeLocalBenchlingExportBundle } from './local-export-bundle';
import { MigrationStore, RecoveredSourceObjectContentConflictError } from './store';
import { finalizeUnlockedMigrationRecovery, unlockMigrationWorkspace } from './staging-workspace';

const ORGANIZATION_BASE_URL = 'https://benchling.com/exampleuser';
const TARGET_A = 'seq_RECOVERA';
const TARGET_B = 'seq_RECOVERB';
const UNRELATED = 'seq_UNRELATED';
const TARGET_A_URL = `${ORGANIZATION_BASE_URL}/f/lib_RECOVERY-recovery-folder/${TARGET_A}-recovered-dna-a/edit`;
const TARGET_B_URL = `${ORGANIZATION_BASE_URL}/f/lib_RECOVERY-recovery-folder/${TARGET_B}-recovered-dna-b/edit`;

describe('offline linked-item recovery executor', () => {
  let root: string;
  let workspacePath: string;
  let archive: ContentArchive;
  let store: MigrationStore;
  let nextNow: () => string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'linked-item-recovery-integration-'));
    workspacePath = join(root, 'workspace');
    archive = new ContentArchive(join(workspacePath, '.dnaforge', 'migration', 'archive'));
    store = new MigrationStore(createTestDb(), true);
    nextNow = monotonicClock('2026-08-13T20:00:00.000Z');
  });

  afterEach(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('throttles intermediate renderer updates but always publishes phase boundaries', () => {
    let nowMs = 0;
    const updates: Array<{ kind: string; completed: number; total: number }> = [];
    const publish = createThrottledWorkProgressPublisher(
      (work) => updates.push({ ...work }),
      () => nowMs
    );

    publish({ kind: 'validate_saved_objects', completed: 0, total: 1_000 });
    for (let completed = 1; completed <= 999; completed += 1) {
      nowMs += 1;
      publish({ kind: 'validate_saved_objects', completed, total: 1_000 });
    }
    nowMs += 1;
    publish({ kind: 'validate_saved_objects', completed: 1_000, total: 1_000 });
    publish({ kind: 'validate_saved_objects', completed: 1_000, total: 1_000 });
    publish({ kind: 'validate_objects', completed: 0, total: 18_025 });
    publish({ kind: 'finalize_workspace', completed: 0, total: 0 });

    expect(updates).toEqual([
      { kind: 'validate_saved_objects', completed: 0, total: 1_000 },
      { kind: 'validate_saved_objects', completed: 250, total: 1_000 },
      { kind: 'validate_saved_objects', completed: 500, total: 1_000 },
      { kind: 'validate_saved_objects', completed: 750, total: 1_000 },
      { kind: 'validate_saved_objects', completed: 1_000, total: 1_000 },
      { kind: 'validate_objects', completed: 0, total: 18_025 },
      { kind: 'finalize_workspace', completed: 0, total: 0 },
    ]);
  });

  it('publishes measured copy bytes and validated object counts without persisting transient work', async () => {
    const original = await prepareReadyOriginalZip();
    const zip = await writeNativeZip('progress.zip', [
      { path: `Recovered DNA A (${TARGET_A}).gb`, bytes: dnaGenBank(TARGET_A, 'acgtacgt') },
    ]);
    const updates: MigrationRun[] = [];

    const completed = await recoverLinkedItemsFromLocalExports(original.run, [zip], {
      ...recoveryDeps(),
      progressNow: () => '2026-08-13T20:30:00.000Z',
      onRunUpdated: (run) => updates.push(structuredClone(run)),
      renderValidator: async (input) => {
        input.onProgress?.({ completed: 0, total: input.selectedSourceObjectIds.length });
        input.onProgress?.({
          completed: input.selectedSourceObjectIds.length,
          total: input.selectedSourceObjectIds.length,
        });
        return passingRenderValidator(input);
      },
    });

    const copyProgress = updates
      .map((run) => run.linkedItemRecovery)
      .find(
        (progress) =>
          progress?.work?.kind === 'copy_bytes' &&
          progress.work.completed === progress.work.total &&
          progress.work.total > 0
      );
    expect(copyProgress?.work).toMatchObject({ kind: 'copy_bytes' });
    expect(copyProgress?.startedAt).toBe('2026-08-13T20:30:00.000Z');
    expect(
      updates.filter(
        (run) =>
          run.linkedItemRecovery?.work?.kind === 'write_objects' &&
          run.linkedItemRecovery.work.completed === run.linkedItemRecovery.work.total &&
          run.linkedItemRecovery.work.total > 0
      )
    ).toHaveLength(2);
    expect(
      updates
        .map((run) => run.linkedItemRecovery?.work)
        .find(
          (work) =>
            work?.kind === 'validate_saved_objects' &&
            work.completed === work.total &&
            work.total > 0
        )
    ).toBeDefined();
    expect(
      updates
        .map((run) => run.linkedItemRecovery?.work)
        .find(
          (work) =>
            work?.kind === 'validate_objects' && work.completed === work.total && work.total > 0
        )
    ).toBeDefined();
    expect(completed.linkedItemRecovery?.work).toBeUndefined();
    expect(store.getRun()?.linkedItemRecovery?.work).toBeUndefined();
  });

  it('imports every supported entity across recovery ZIP batches, dedupes them, and repairs planned links', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const original = await prepareReadyOriginalZip();
    const originalNotebookReceipt = receiptFor(original.receipts, 'etr_RECOVERY');
    const originalDocument = await readProjectionDocument(originalNotebookReceipt);
    expect(JSON.stringify(originalDocument)).toContain('unresolved-entry-reference');
    expect(original.resolutions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ targetSourceId: TARGET_A, classification: 'unresolved' }),
        expect.objectContaining({ targetSourceId: TARGET_B, classification: 'unresolved' }),
      ])
    );

    const zipA = await writeNativeZip('recovered-a.zip', [
      { path: `Recovered DNA A (${TARGET_A}).gb`, bytes: dnaGenBank(TARGET_A, 'acgtacgt') },
    ]);
    const duplicateZipA = await writeBytes('duplicate-a.zip', await readFile(zipA));
    const unrelatedZip = await writeNativeZip('unrelated.zip', [
      {
        path: `Unrelated DNA (${UNRELATED}).gb`,
        bytes: dnaGenBank(UNRELATED, 'ttttaaaa'),
      },
    ]);
    let firstRun: MigrationRun;
    try {
      firstRun = await recoverLinkedItemsFromLocalExports(
        original.run,
        [zipA, duplicateZipA, unrelatedZip],
        recoveryDeps()
      );
    } catch (error) {
      throw new Error(
        `Recovery failed: ${String(error)}\n${JSON.stringify(store.getValidationReport(original.run.id)?.issues, null, 2)}`
      );
    }

    expect(firstRun).toMatchObject({
      state: 'ready_to_unlock',
      linkedItemRecovery: {
        state: 'completed',
        selectedFileCount: 3,
        processedFileCount: 3,
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      store
        .listSourceObjects(original.run.id)
        .map((item) => item.id)
        .sort()
    ).toEqual(['etr_RECOVERY', TARGET_A, UNRELATED]);
    expect(store.listLinkedItemRecoveryArtifacts(original.run.id)).toHaveLength(2);
    expect(store.listLinkedItemRecoveryCaptures(original.run.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceStableId: TARGET_A }),
        expect.objectContaining({ sourceStableId: UNRELATED }),
      ])
    );
    const firstAttempt = store.listLinkedItemRecoveryAttempts(original.run.id)[0];
    expect(firstAttempt).toMatchObject({
      state: 'completed',
      selectedFileCount: 3,
      processedFileCount: 3,
      recoveredUniqueObjectCount: 2,
      repairedRelationshipCount: 1,
    });
    expect(new Set(firstAttempt.artifactIds).size).toBe(2);
    expect(resolutionClassByTarget(original.run.id)).toEqual(
      new Map([
        [TARGET_A, 'exact'],
        [TARGET_B, 'unresolved'],
      ])
    );

    const firstNotebookReceipt = receiptFor(
      store.listProjectionReceipts(original.run.id),
      'etr_RECOVERY'
    );
    expectStableDestination(firstNotebookReceipt, originalNotebookReceipt);
    expect(firstNotebookReceipt.id).not.toBe(originalNotebookReceipt.id);
    const firstDocument = await readProjectionDocument(firstNotebookReceipt);
    const firstDocumentJson = JSON.stringify(firstDocument);
    expect(firstDocument).toMatchObject({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'mention',
              attrs: {
                entityType: 'native-catalog',
                entityId: receiptFor(store.listProjectionReceipts(original.run.id), TARGET_A)
                  .destinationObjectId,
                label: 'Recovered DNA A',
              },
            },
          ],
        },
        { type: 'embed', attrs: { type: 'source-artifact' } },
      ],
    });
    expect(firstDocumentJson).toContain('unresolved-entry-reference');

    const firstReport = store.getValidationReport(original.run.id);
    expect(firstReport && isValidationReportV2(firstReport) ? firstReport : null).toMatchObject({
      passed: true,
      providerActivity: { networkRequests: 0, cacheHits: 0, countsAreExact: true },
      linkedItemRecovery: {
        evidence: {
          uniqueTargetCount: 2,
          recoveredUniqueObjectCount: 1,
          remainingUniqueObjectCount: 1,
          repairedRelationshipCount: 1,
          remainingRelationshipCount: 1,
          attempts: [
            expect.objectContaining({
              selectedFileCount: 3,
              acceptedFileCount: 2,
              duplicateFileCount: 1,
              rejectedFileCount: 0,
              recoveredTargetCount: 1,
              repairedRelationshipCount: 1,
              outcome: 'partial',
            }),
          ],
        },
      },
    });
    assertZeroProviderState(original.run.id);

    const zipB = await writeNativeZip('recovered-b.zip', [
      { path: `Recovered DNA A (${TARGET_A}).gb`, bytes: dnaGenBank(TARGET_A, 'acgtacgt') },
      { path: `Recovered DNA B (${TARGET_B}).gb`, bytes: dnaGenBank(TARGET_B, 'ggggcccc') },
      {
        path: `Unrelated DNA (${UNRELATED}).gb`,
        bytes: dnaGenBank(UNRELATED, 'ttttaaaa'),
      },
    ]);
    const duplicateZipB = await writeBytes('duplicate-b.zip', await readFile(zipB));
    const secondRun = await recoverLinkedItemsFromLocalExports(
      firstRun,
      [duplicateZipA, zipB, duplicateZipB],
      recoveryDeps()
    );

    expect(secondRun.linkedItemRecovery).toMatchObject({
      state: 'completed',
      selectedFileCount: 3,
      processedFileCount: 3,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      store
        .listSourceObjects(original.run.id)
        .map((item) => item.id)
        .sort()
    ).toEqual(['etr_RECOVERY', TARGET_A, TARGET_B, UNRELATED]);
    expect(store.listLinkedItemRecoveryCaptures(original.run.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceStableId: TARGET_A, attemptId: firstAttempt.id }),
        expect.objectContaining({ sourceStableId: UNRELATED, attemptId: firstAttempt.id }),
        expect.objectContaining({ sourceStableId: TARGET_B }),
      ])
    );
    expect(
      store
        .listLinkedItemRecoveryCaptures(original.run.id)
        .filter((capture) => capture.sourceStableId === TARGET_A)
    ).toHaveLength(1);
    expect(resolutionClassByTarget(original.run.id)).toEqual(
      new Map([
        [TARGET_A, 'exact'],
        [TARGET_B, 'exact'],
      ])
    );

    const secondNotebookReceipt = receiptFor(
      store.listProjectionReceipts(original.run.id),
      'etr_RECOVERY'
    );
    expectStableDestination(secondNotebookReceipt, originalNotebookReceipt);
    expect(secondNotebookReceipt.id).not.toBe(firstNotebookReceipt.id);
    const notebookHistory = store
      .listProjectionReceiptHistory(original.run.id)
      .filter((entry) => entry.receipt.sourceObjectId === 'etr_RECOVERY');
    expect(notebookHistory).toHaveLength(3);
    expect(notebookHistory.map((entry) => entry.supersedesReceiptId)).toEqual([
      null,
      originalNotebookReceipt.id,
      firstNotebookReceipt.id,
    ]);
    const secondDocument = await readProjectionDocument(secondNotebookReceipt);
    expect(secondDocument).toMatchObject({
      type: 'doc',
      content: [TARGET_A, TARGET_B].map((target, index) => ({
        type: 'paragraph',
        content: [
          {
            type: 'mention',
            attrs: {
              entityType: 'native-catalog',
              entityId: receiptFor(store.listProjectionReceipts(original.run.id), target)
                .destinationObjectId,
              label: index === 0 ? 'Recovered DNA A' : 'Recovered DNA B',
            },
          },
        ],
      })),
    });
    expect(JSON.stringify(secondDocument)).not.toContain('unresolved-entry-reference');

    const secondReport = store.getValidationReport(original.run.id);
    expect(secondReport && isValidationReportV2(secondReport) ? secondReport : null).toMatchObject({
      passed: true,
      providerActivity: { networkRequests: 0, cacheHits: 0, countsAreExact: true },
      linkedItemRecovery: {
        evidence: {
          uniqueTargetCount: 2,
          recoveredUniqueObjectCount: 2,
          remainingUniqueObjectCount: 0,
          repairedRelationshipCount: 2,
          remainingRelationshipCount: 0,
          attempts: [
            expect.objectContaining({ outcome: 'partial', recoveredTargetCount: 1 }),
            expect.objectContaining({
              selectedFileCount: 3,
              acceptedFileCount: 1,
              duplicateFileCount: 2,
              rejectedFileCount: 0,
              recoveredTargetCount: 1,
              repairedRelationshipCount: 2,
              outcome: 'completed',
            }),
          ],
        },
      },
    });
    assertZeroProviderState(original.run.id);

    const globalDb = createTestDb();
    ensureSchema(globalDb, ':memory:');
    const unlocked = await unlockMigrationWorkspace({
      workspacePath,
      globalDb,
      now: nextNow,
      openStore: () => nonClosingStore(store),
      finalizationDeps: {
        resolveHeadCommit: async () => 'a'.repeat(40),
        commitAllIfDirty: async () => 'b'.repeat(40),
        openTransactionDb: (db) => ({ db, close: () => undefined }),
      },
    });
    expect(unlocked.workspaceDbId).toBeGreaterThan(0);
    expect(existsSync(join(workspacePath, '.forge/catalog.json'))).toBe(true);
    expect(
      existsSync(join(workspacePath, '.dnaforge/migration/destination-link-index.v1.json'))
    ).toBe(false);
    expect(existsSync(join(workspacePath, '.dnaforge/migration/collection-projection.json'))).toBe(
      false
    );
    expect(existsSync(join(workspacePath, 'Benchling Imports/Collections'))).toBe(false);
    expect(
      globalDb
        .prepare(
          `SELECT type, COUNT(*) AS count
           FROM catalog_entities
           WHERE workspace_id = ?
           GROUP BY type
           ORDER BY type`
        )
        .all(unlocked.workspaceDbId)
    ).toEqual([
      { type: 'folder', count: 2 },
      { type: 'notebook', count: 1 },
      { type: 'sequence', count: 3 },
    ]);
    expect(
      globalDb
        .prepare(
          `SELECT COUNT(*) AS count
           FROM catalog_entity_links links
           JOIN catalog_entities source ON source.id = links.source_entity_id
           JOIN catalog_entities target ON target.id = links.target_entity_id
           WHERE source.workspace_id = ? AND source.type = 'notebook' AND target.type = 'sequence'`
        )
        .get(unlocked.workspaceDbId)
    ).toEqual({ count: 2 });
    globalDb.close();
  });

  it('uses the recovery plan organization when another tenant makes global inference ambiguous', async () => {
    const original = await prepareReadyOriginalZip();
    const notebook = store
      .listSourceObjects(original.run.id)
      .find((sourceObject) => sourceObject.id === 'etr_RECOVERY');
    const template = notebook?.relationships[0];
    if (!notebook || !template) throw new Error('Expected the recovery notebook relationship.');
    store.putSourceObject(original.run.id, {
      ...notebook,
      relationships: [
        ...notebook.relationships,
        {
          ...template,
          id: 'rel_OTHER_TENANT',
          targetSourceId: 'seq_OTHER_TENANT',
          targetUrl:
            'https://benchling.com/another-lab/f/lib_OTHER-other/seq_OTHER_TENANT-external/edit',
          evidence: [
            { kind: 'stable_id', value: 'seq_OTHER_TENANT' },
            {
              kind: 'url',
              value:
                'https://benchling.com/another-lab/f/lib_OTHER-other/seq_OTHER_TENANT-external/edit',
            },
          ],
        },
      ],
    });
    const zipA = await writeNativeZip('recovered-with-external-tenant.zip', [
      { path: `Recovered DNA A (${TARGET_A}).gb`, bytes: dnaGenBank(TARGET_A, 'acgtacgt') },
    ]);

    await recoverLinkedItemsFromLocalExports(original.run, [zipA], recoveryDeps());

    const resolutions = store.listRelationshipResolutions(original.run.id);
    expect(resolutions.find((resolution) => resolution.targetSourceId === TARGET_A)).toMatchObject({
      classification: 'exact',
    });
    expect(
      resolutions.find((resolution) => resolution.relationshipId === 'rel_OTHER_TENANT')
    ).toMatchObject({ classification: 'external' });
    const report = store.getValidationReport(original.run.id);
    expect(report && isValidationReportV2(report) ? report : null).toMatchObject({
      passed: true,
      linkedItemRecovery: {
        evidence: {
          recoveredUniqueObjectCount: 1,
          repairedRelationshipCount: 1,
        },
      },
    });
  });

  it('fails closed when distinct ZIPs contain different scientific content for the same planned stable ID', async () => {
    const original = await prepareReadyOriginalZip();
    const originalReceipt = receiptFor(original.receipts, 'etr_RECOVERY');
    const firstZip = await writeNativeZip('same-id-first.zip', [
      { path: `Recovered DNA A (${TARGET_A}).gb`, bytes: dnaGenBank(TARGET_A, 'acgtacgt') },
    ]);
    const divergentZip = await writeNativeZip('same-id-divergent.zip', [
      { path: `Recovered DNA A (${TARGET_A}).gb`, bytes: dnaGenBank(TARGET_A, 'ttttgggg') },
    ]);

    await expect(
      recoverLinkedItemsFromLocalExports(original.run, [firstZip, divergentZip], recoveryDeps())
    ).rejects.toBeInstanceOf(RecoveredSourceObjectContentConflictError);

    expect(store.listLinkedItemRecoveryArtifacts(original.run.id)).toHaveLength(2);
    expect(store.listLinkedItemRecoveryCaptures(original.run.id)).toEqual([
      expect.objectContaining({ sourceStableId: TARGET_A }),
    ]);
    expect(store.listLinkedItemRecoveryAttempts(original.run.id)).toEqual([
      expect.objectContaining({
        state: 'failed',
        resumeState: 'parsing',
        selectedFileCount: 2,
        processedFileCount: 2,
        safeFailure: expect.objectContaining({ code: 'decode_failed', retryable: true }),
      }),
    ]);
    expect(store.getRun()).toMatchObject({
      state: 'ready_to_unlock',
      linkedItemRecovery: { state: 'failed' },
    });
    expect(resolutionClassByTarget(original.run.id)).toEqual(
      new Map([
        [TARGET_A, 'unresolved'],
        [TARGET_B, 'unresolved'],
      ])
    );
    expect(receiptFor(store.listProjectionReceipts(original.run.id), 'etr_RECOVERY')).toEqual(
      originalReceipt
    );
    expect(store.getValidationReport(original.run.id)).toEqual(original.report);
    assertZeroProviderState(original.run.id);
  });

  it('adds a missing dependency after unlock without replacing an edited notebook', async () => {
    const original = await prepareReadyOriginalZip();
    const zipA = await writeNativeZip('before-unlock-a.zip', [
      { path: `Recovered DNA A (${TARGET_A}).gb`, bytes: dnaGenBank(TARGET_A, 'acgtacgt') },
    ]);
    await recoverLinkedItemsFromLocalExports(original.run, [zipA], recoveryDeps());

    const globalDb = createTestDb();
    ensureSchema(globalDb, ':memory:');
    await unlockMigrationWorkspace({
      workspacePath,
      globalDb,
      now: nextNow,
      openStore: () => nonClosingStore(store),
      finalizationDeps: testFinalizationDeps(globalDb),
    });
    const notebook = globalDb
      .prepare("SELECT id FROM catalog_entities WHERE type = 'notebook'")
      .get() as { id: string };
    const editedContent = JSON.stringify({
      type: 'doc',
      content: [{ type: 'paragraph', text: 'Edited after the original migration' }],
    });
    globalDb.prepare('UPDATE pages SET content = ? WHERE id = ?').run(editedContent, notebook.id);
    const notebookReceipt = receiptFor(
      store.listProjectionReceipts(original.run.id),
      'etr_RECOVERY'
    );
    const notebookPackageBefore = await readFile(
      join(workspacePath, notebookReceipt.destinationPath)
    );
    const trackedFiles = await snapshotBenchlingImportFiles();
    const preservedDestinations = await readUnlockedNativeDestinations(
      workspacePath,
      async () => trackedFiles
    );
    expect(preservedDestinations).toContainEqual({
      path: notebookReceipt.destinationPath,
      kind: 'file',
    });
    expect(preservedDestinations.every((destination) => destination.kind === 'file')).toBe(true);

    const zipB = await writeNativeZip('after-unlock-b.zip', [
      { path: `Recovered DNA B (${TARGET_B}).gb`, bytes: dnaGenBank(TARGET_B, 'ggggcccc') },
    ]);
    const finalizeUnlockedRecovery: NonNullable<
      LinkedItemRecoveryExecutorDeps['finalizeUnlockedRecovery']
    > = vi.fn((run, report, sourceObjects, receipts, resolutions, actionId) =>
      finalizeUnlockedMigrationRecovery({
        run,
        report,
        store,
        globalDb,
        now: nextNow,
        finalizationDeps: testFinalizationDeps(globalDb),
        sourceObjects,
        projectionReceipts: receipts,
        relationshipResolutions: resolutions,
        actionId,
      })
    );
    const recovered = await recoverLinkedItemsFromLocalExports(store.getRun()!, [zipB], {
      ...recoveryDeps(),
      listFilesAtHead: async () => trackedFiles,
      finalizeUnlockedRecovery,
    });

    expect(recovered.state).toBe('unlocked');
    expect(globalDb.prepare('SELECT content FROM pages WHERE id = ?').get(notebook.id)).toEqual({
      content: editedContent,
    });
    expect(await readFile(join(workspacePath, notebookReceipt.destinationPath))).toEqual(
      notebookPackageBefore
    );
    expect(
      globalDb.prepare('SELECT type, COUNT(*) AS count FROM catalog_entities GROUP BY type').all()
    ).toEqual(
      expect.arrayContaining([
        { type: 'folder', count: 2 },
        { type: 'notebook', count: 1 },
        { type: 'sequence', count: 2 },
      ])
    );
    expect(
      globalDb
        .prepare(
          `SELECT source.name AS folderName, target.name AS targetName
           FROM catalog_entity_links links
           JOIN catalog_entities source ON source.id = links.source_entity_id
           JOIN catalog_entities target ON target.id = links.target_entity_id
           WHERE source.type = 'folder'
             AND target.name = 'Recovered DNA B'
             AND links.relation = 'contains'`
        )
        .get()
    ).toEqual({ folderName: 'Selected Root', targetName: 'Recovered DNA B' });
    const manifest = JSON.parse(
      await readFile(join(workspacePath, '.forge/catalog.json'), 'utf8')
    ) as {
      entities: Array<{ name: string }>;
      links: Array<{ sourceId: string; relation: string; targetId: string }>;
    };
    expect(manifest.entities.map((entity) => entity.name)).toContain('Recovered DNA B');
    expect(manifest.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: collectionDestinationId('lib_RECOVERY'),
          relation: 'contains',
          targetId: receiptFor(store.listProjectionReceipts(original.run.id), TARGET_B)
            .destinationObjectId,
        }),
      ])
    );

    const updatedTrackedFiles = await snapshotBenchlingImportFiles();
    const persistPassedReport = vi.fn(async () => undefined);
    const duplicate = await runLocalExportAttempt(
      recovered,
      [zipB],
      {
        ...recoveryDeps(),
        listFilesAtHead: async () => updatedTrackedFiles,
        finalizeUnlockedRecovery,
        persistPassedReport,
      },
      'workspace_append'
    );
    expect(duplicate).toMatchObject({
      state: 'unlocked',
      linkedItemRecovery: { state: 'completed', recoveredUniqueObjectCount: 0 },
    });
    expect(store.listLinkedItemRecoveryAttempts(original.run.id).at(-1)?.fileResults).toEqual([
      expect.objectContaining({ outcome: 'duplicate' }),
    ]);
    expect(finalizeUnlockedRecovery).toHaveBeenCalledOnce();
    expect(persistPassedReport).not.toHaveBeenCalled();
    globalDb.close();
  });

  it('rejects an untracked foreign file beside a preserved unlocked destination', async () => {
    const original = await prepareReadyOriginalZip();
    const zipA = await writeNativeZip('foreign-check-a.zip', [
      { path: `Recovered DNA A (${TARGET_A}).gb`, bytes: dnaGenBank(TARGET_A, 'acgtacgt') },
    ]);
    await recoverLinkedItemsFromLocalExports(original.run, [zipA], recoveryDeps());

    const globalDb = createTestDb();
    ensureSchema(globalDb, ':memory:');
    await unlockMigrationWorkspace({
      workspacePath,
      globalDb,
      now: nextNow,
      openStore: () => nonClosingStore(store),
      finalizationDeps: testFinalizationDeps(globalDb),
    });
    const recoveredA = receiptFor(store.listProjectionReceipts(original.run.id), TARGET_A);
    const trackedFiles = await snapshotBenchlingImportFiles();
    await writeFile(join(workspacePath, dirname(recoveredA.destinationPath), 'foreign.txt'), 'no');

    const zipB = await writeNativeZip('foreign-check-b.zip', [
      { path: `Recovered DNA B (${TARGET_B}).gb`, bytes: dnaGenBank(TARGET_B, 'ggggcccc') },
    ]);
    await expect(
      recoverLinkedItemsFromLocalExports(store.getRun()!, [zipB], {
        ...recoveryDeps(),
        listFilesAtHead: async () => trackedFiles,
      })
    ).rejects.toMatchObject({ code: 'linked_item_recovery_validation_failed' });

    globalDb.close();
  });

  it('revalidates artifacts staged by a failed attempt when the same ZIP is retried', async () => {
    const original = await prepareReadyOriginalZip();
    const globalDb = createTestDb();
    ensureSchema(globalDb, ':memory:');
    await unlockMigrationWorkspace({
      workspacePath,
      globalDb,
      now: nextNow,
      openStore: () => nonClosingStore(store),
      finalizationDeps: testFinalizationDeps(globalDb),
    });
    const trackedFiles = await snapshotBenchlingImportFiles();
    const zipA = await writeNativeZip('retry-after-validation-failure.zip', [
      { path: `Recovered DNA A (${TARGET_A}).gb`, bytes: dnaGenBank(TARGET_A, 'acgtacgt') },
    ]);

    await expect(
      recoverLinkedItemsFromLocalExports(store.getRun()!, [zipA], {
        ...recoveryDeps(),
        listFilesAtHead: async () => trackedFiles,
        renderValidator: async ({ selectedSourceObjectIds }) =>
          selectedSourceObjectIds.map((sourceObjectId) => ({ sourceObjectId, passed: false })),
      })
    ).rejects.toMatchObject({ code: 'linked_item_recovery_validation_failed' });
    expect(store.listLinkedItemRecoveryAttempts(original.run.id).at(-1)).toMatchObject({
      state: 'failed',
    });
    expect(store.listLinkedItemRecoveryCaptures(original.run.id)).toEqual([
      expect.objectContaining({ sourceStableId: TARGET_A }),
    ]);

    const finalizeUnlockedRecovery: NonNullable<
      LinkedItemRecoveryExecutorDeps['finalizeUnlockedRecovery']
    > = vi.fn((run, report, sourceObjects, receipts, resolutions, actionId) =>
      finalizeUnlockedMigrationRecovery({
        run,
        report,
        store,
        globalDb,
        now: nextNow,
        finalizationDeps: testFinalizationDeps(globalDb),
        sourceObjects,
        projectionReceipts: receipts,
        relationshipResolutions: resolutions,
        actionId,
      })
    );
    const recovered = await recoverLinkedItemsFromLocalExports(store.getRun()!, [zipA], {
      ...recoveryDeps(),
      listFilesAtHead: async () => trackedFiles,
      finalizeUnlockedRecovery,
    });

    expect(recovered).toMatchObject({
      state: 'unlocked',
      linkedItemRecovery: { state: 'completed' },
    });
    expect(store.listProjectionReceipts(original.run.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ sourceObjectId: TARGET_A })])
    );
    await runLocalExportAttempt(
      recovered,
      [zipA],
      {
        ...recoveryDeps(),
        listFilesAtHead: async () => snapshotBenchlingImportFiles(),
        finalizeUnlockedRecovery,
      },
      'workspace_append'
    );
    expect(finalizeUnlockedRecovery).toHaveBeenCalledOnce();
    globalDb.close();
  });

  it.each(['linked_item_recovery', 'workspace_append'] as const)(
    '%s preserves the validated original when every file is malformed, then permits a clean retry',
    async (mode) => {
      const original = await prepareReadyOriginalZip();
      const originalReceipt = receiptFor(original.receipts, 'etr_RECOVERY');
      const malformedOne = await writeBytes('bad-one.zip', Buffer.from('PK but not a ZIP'));
      const malformedTwo = await writeBytes('bad-two.zip', Buffer.from([0, 1, 2, 3, 4]));

      const noOpRun = await runLocalExportAttempt(
        original.run,
        [malformedOne, malformedTwo],
        recoveryDeps(),
        mode
      );

      expect(noOpRun).toMatchObject({
        state: 'ready_to_unlock',
        linkedItemRecovery: {
          state: 'completed',
          selectedFileCount: 2,
          processedFileCount: 2,
          recoveredUniqueObjectCount: 0,
          repairedRelationshipCount: 0,
        },
      });
      expect(store.getActiveLinkedItemRecoveryAttempt(original.run.id)).toBeNull();
      expect(store.listLinkedItemRecoveryAttempts(original.run.id)).toEqual([
        expect.objectContaining({
          state: 'completed',
          selectedFileCount: 2,
          processedFileCount: 2,
          recoveredUniqueObjectCount: 0,
          repairedRelationshipCount: 0,
          safeFailure: null,
        }),
      ]);
      expect(store.listLinkedItemRecoveryArtifacts(original.run.id)).toEqual([]);
      expect(store.listLinkedItemRecoveryCaptures(original.run.id)).toEqual([]);
      expect(store.listSourceObjects(original.run.id).map((item) => item.id)).toEqual([
        'etr_RECOVERY',
      ]);
      expect(receiptFor(store.listProjectionReceipts(original.run.id), 'etr_RECOVERY')).toEqual(
        originalReceipt
      );
      expect(store.getValidationReport(original.run.id)).toMatchObject({
        passed: true,
        providerActivity: { networkRequests: 0 },
        linkedItemRecovery: {
          evidence: {
            recoveredUniqueObjectCount: 0,
            remainingUniqueObjectCount: 2,
            attempts: [
              expect.objectContaining({
                selectedFileCount: 2,
                acceptedFileCount: 0,
                duplicateFileCount: 0,
                rejectedFileCount: 2,
                recoveredTargetCount: 0,
                repairedRelationshipCount: 0,
                outcome: 'failed',
              }),
            ],
          },
        },
      });
      assertZeroProviderState(original.run.id);

      const failedReceipt = store
        .listMigrationTelemetryTerminalReceipts(original.run.id)
        .find((receipt) => receipt.identity.operation === mode);
      expect(failedReceipt).toMatchObject({
        outcome: 'failed',
        usableResult: false,
        primaryIssueCode: 'unsafe_archive',
        counts: { importedObject: 0, blockingIssue: 2 },
        issues: expect.arrayContaining([
          expect.objectContaining({ code: 'unsafe_archive', blocking: true, count: 2 }),
        ]),
      });
      expect(JSON.stringify(failedReceipt)).not.toContain('bad-one.zip');
      expect(JSON.stringify(failedReceipt)).not.toContain(root);

      const valid = await writeNativeZip('valid-after-malformed.zip', [
        { path: `Recovered DNA A (${TARGET_A}).gb`, bytes: dnaGenBank(TARGET_A, 'acgtacgt') },
      ]);
      const retried = await runLocalExportAttempt(store.getRun()!, [valid], recoveryDeps(), mode);
      expect(retried.linkedItemRecovery?.state).toBe('completed');
      expect(store.listLinkedItemRecoveryCaptures(original.run.id)).toEqual([
        expect.objectContaining({ sourceStableId: TARGET_A }),
      ]);
      expect(store.listMigrationTelemetryTerminalReceipts(original.run.id)).toEqual(
        expect.arrayContaining([
          failedReceipt,
          expect.objectContaining({
            identity: expect.objectContaining({ operation: mode }),
            outcome: 'succeeded',
            usableResult: true,
          }),
        ])
      );
      assertZeroProviderState(original.run.id);
    }
  );

  it.each(['linked_item_recovery', 'workspace_append'] as const)(
    '%s records partial acceptance with a bounded rejection issue and preserves imported value',
    async (mode) => {
      const original = await prepareReadyOriginalZip();
      const valid = await writeNativeZip('partial-valid.zip', [
        { path: `Recovered DNA A (${TARGET_A}).gb`, bytes: dnaGenBank(TARGET_A, 'acgtacgt') },
      ]);
      const malformed = await writeBytes('partial-invalid.zip', Buffer.from('not a ZIP'));
      await runLocalExportAttempt(original.run, [valid, malformed], recoveryDeps(), mode);
      const receipt = store
        .listMigrationTelemetryTerminalReceipts(original.run.id)
        .find((candidate) => candidate.identity.operation === mode);
      expect(receipt).toMatchObject({
        outcome: 'needs_action',
        usableResult: true,
        primaryIssueCode: 'unsafe_archive',
        counts: { importedObject: 1, blockingIssue: 1 },
        issues: expect.arrayContaining([
          expect.objectContaining({ code: 'unsafe_archive', blocking: true, count: 1 }),
        ]),
      });
      expect(store.listLinkedItemRecoveryCaptures(original.run.id)).toEqual([
        expect.objectContaining({ sourceStableId: TARGET_A }),
      ]);
      assertZeroProviderState(original.run.id);
    }
  );

  async function prepareReadyOriginalZip() {
    const sourcePath = await writeNativeZip('original-export.zip', [
      {
        path: 'Selected Root/Recovery Notebook (etr_RECOVERY).html',
        bytes: originalNotebookHtml(),
      },
    ]);
    const artifact = await intakeLocalBenchlingExportBundle({ workspacePath, sourcePath });
    if (artifact.format !== 'zip') throw new Error('Expected a ZIP artifact.');
    const run: MigrationRun = {
      version: 1,
      id: 'run-linked-item-recovery',
      workspaceId: 'workspace-linked-item-recovery',
      workspacePath,
      displayName: 'Offline linked-item recovery',
      scope: {
        version: 1,
        kind: 'folder',
        acquisition: 'local_bundle',
        folder: {
          id: 'lib_SELECTED_ROOT',
          url: `${ORGANIZATION_BASE_URL}/f_/lib_SELECTED_ROOT-selected-root`,
          objectType: 'folder',
        },
        includeChildren: false,
        includeArchived: false,
      },
      binding: null,
      state: 'scope_planning',
      resumeState: null,
      attempt: 0,
      converterVersions: {},
      createdAt: nextNow(),
      updatedAt: nextNow(),
      startedAt: nextNow(),
      unlockedAt: null,
      lastError: null,
      localExportArtifact: {
        schema: artifact.schema,
        format: artifact.format,
        logicalFilename: artifact.logicalFilename,
        sha256: artifact.sha256,
        sizeBytes: artifact.sizeBytes,
        immutableLocalPath: artifact.immutableLocalPath,
        capturedAt: nextNow(),
        archive: artifact.archive,
        resources: [],
      },
    };
    store.saveRun(run);
    const result = await executeLocalBundleMigration(run, localBundleDeps());
    expect(result.run.state).toBe('ready_to_unlock');
    expect(result.report.passed).toBe(true);
    if (!isValidationReportV2(result.report)) {
      throw new Error('Expected a v2 local ZIP validation report.');
    }
    expect(result.report.providerActivity).toMatchObject({
      networkRequests: 0,
      cacheHits: 0,
      countsAreExact: true,
    });
    expect(result.resolutions).toHaveLength(2);
    return result;
  }

  function localBundleDeps(): LocalBundleExecutorDeps {
    return {
      store,
      archive,
      now: nextNow,
      renderValidator: passingRenderValidator,
      persistPassedReport: async () => undefined,
    };
  }

  function recoveryDeps(): LinkedItemRecoveryExecutorDeps {
    return {
      store,
      archive,
      now: nextNow,
      renderValidator: passingRenderValidator,
      persistPassedReport: async () => undefined,
    };
  }

  function testFinalizationDeps(globalDb: ReturnType<typeof createTestDb>) {
    return {
      resolveHeadCommit: async () => 'a'.repeat(40),
      commitAllIfDirty: async () => 'b'.repeat(40),
      openTransactionDb: () => ({ db: globalDb, close: () => undefined }),
    };
  }

  function nonClosingStore(target: MigrationStore): MigrationStore {
    return new Proxy(target, {
      get(storeTarget, property, receiver) {
        if (property === 'close') return () => undefined;
        const value = Reflect.get(storeTarget, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(storeTarget) : value;
      },
    });
  }

  async function passingRenderValidator(input: {
    selectedSourceObjectIds: readonly string[];
  }): Promise<Array<{ sourceObjectId: string; passed: boolean }>> {
    return input.selectedSourceObjectIds.map((sourceObjectId) => ({
      sourceObjectId,
      passed: true,
    }));
  }

  async function writeNativeZip(
    filename: string,
    entries: Parameters<typeof buildSyntheticNativeExportZip>[0]
  ): Promise<string> {
    const fixture = buildSyntheticNativeExportZip(entries);
    return writeBytes(filename, Buffer.from(fixture.bytes));
  }

  async function writeBytes(filename: string, bytes: Uint8Array): Promise<string> {
    const path = join(root, 'selected-exports', filename);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    return path;
  }

  async function snapshotBenchlingImportFiles(): Promise<string[]> {
    const files: string[] = [];
    const walk = async (absoluteDirectory: string, relativeDirectory: string): Promise<void> => {
      for (const entry of await readdir(absoluteDirectory, { withFileTypes: true })) {
        const absolutePath = join(absoluteDirectory, entry.name);
        const relativePath = `${relativeDirectory}/${entry.name}`;
        if (entry.isDirectory()) await walk(absolutePath, relativePath);
        else if (entry.isFile()) files.push(relativePath);
      }
    };
    await walk(join(workspacePath, 'Benchling Imports'), 'Benchling Imports');
    return files.sort();
  }

  async function readProjectionDocument(receipt: ProjectionReceipt): Promise<unknown> {
    const metadataPath = join(workspacePath, receipt.destinationPath);
    const packageRoot = dirname(dirname(metadataPath));
    const metadata = parseNotebookPackageMetadata(await readFile(metadataPath, 'utf8'));
    const markdown = await readFile(join(packageRoot, metadata.authority.path), 'utf8');
    const payloads = new Map<string, string>();
    for (const relativePath of notebookPayloadPathsFromMarkdown(markdown)) {
      payloads.set(relativePath, await readFile(join(packageRoot, relativePath), 'utf8'));
    }
    return parseNotebookMarkdown({
      markdown,
      payloads,
      expected: { id: metadata.id, formatVersion: metadata.formatVersion },
    }).content;
  }

  function resolutionClassByTarget(runId: string): Map<string, string> {
    return new Map(
      store
        .listRelationshipResolutions(runId)
        .map((resolution) => [resolution.targetSourceId ?? '', resolution.classification])
    );
  }

  function assertZeroProviderState(runId: string): void {
    expect(store.listRequestLedgerEntries(runId)).toEqual([]);
    expect(store.listProviderActivityEvidence(runId)).toEqual([]);
    expect(store.listProviderCommandJournal(runId)).toEqual([]);
    expect(store.listProviderTaskEvidence(runId)).toEqual([]);
    expect(store.listExportJobs(runId)).toEqual([]);
    expect(store.listExportCaptures(runId)).toEqual([]);
  }
});

function receiptFor(
  receipts: readonly ProjectionReceipt[],
  sourceObjectId: string
): ProjectionReceipt {
  const matches = receipts.filter((receipt) => receipt.sourceObjectId === sourceObjectId);
  if (matches.length !== 1) {
    throw new Error(
      `Expected one projection receipt for ${sourceObjectId}; got ${matches.length}.`
    );
  }
  return matches[0];
}

function expectStableDestination(next: ProjectionReceipt, original: ProjectionReceipt): void {
  expect(next.destinationObjectId).toBe(original.destinationObjectId);
  expect(next.destinationPath).toBe(original.destinationPath);
}

function originalNotebookHtml(): string {
  const card = (url: string, name: string) => `<div
    class="note-entry"
    data-test-component="NoteDropTarget"
    data-test-element="noteLinkedFilePreview"
  ><a href="${url}"><div class="note-itemName" data-test-element="previewItemName">${name}</div></a></div>`;
  return `<!doctype html><html><body><h1>Recovery Notebook</h1>
    ${card(TARGET_A_URL, 'Recovered DNA A')}
    ${card(TARGET_B_URL, 'Recovered DNA B')}
  </body></html>`;
}

function dnaGenBank(sourceId: string, bases: string): string {
  return [
    `LOCUS       ${sourceId}       ${bases.length} bp    DNA     linear`,
    `DEFINITION  ${sourceId}.`,
    'FEATURES             Location/Qualifiers',
    'ORIGIN',
    `        1 ${bases}`,
    '//',
    '',
  ].join('\n');
}

function monotonicClock(start: string): () => string {
  let value = Date.parse(start);
  return () => {
    value += 1_000;
    return new Date(value).toISOString();
  };
}
