import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });

vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(() => tmpdir()), getVersion: vi.fn(() => '1.0.0') },
}));
vi.mock('../analytics', () => ({ trackEvent: vi.fn() }));

import { createTestDb } from '../__tests__/test-db';
import { ensureSchema } from '../schema';
import { notebookPackagePaths } from '../../db/notebook-package';
import type { ImportDecision } from '../../shared/benchling-import-decision';
import {
  NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA,
  parseNativeWorkspaceManifest,
} from '../../shared/native-workspace-manifest';
import { seedLimsBuiltinsInDb, updateLimsEntityInsideTx } from '../lims-engine-core';
import { upsertProviderBinding } from '../catalog-provider-bindings';
import { assertNativeActionCatalogIntegrity } from './native-action-integrity';
import { readBenchlingMigrationActionJournal } from './action-journal';
import * as actionJournal from './action-journal';
import * as nativeManifestWriter from '../native-workspace-manifest';
import * as validation from './validation';
import { readLimsAuditExportRowsFromWorkspace } from '../lims-git-export';
import { isValidationReportV2, type MigrationRun } from '../../shared/benchling-migration';
import { buildSyntheticNativeExportZip } from './__fixtures__/native-export-zip-fixture';
import { SYNTHETIC_STRAIN_TEXT } from './__fixtures__/native-record-fixtures';
import { ContentArchive } from './content-archive';
import { nativeFolderPathMap, readCollectionProjection } from './collection-projection-writer';
import {
  readUnlockedNativeDestinations,
  type LinkedItemRecoveryExecutorDeps,
} from './linked-item-recovery-executor';
import { executeLocalBundleMigration, type LocalBundleExecutorDeps } from './local-bundle-executor';
import { intakeLocalBenchlingExportBundle } from './local-export-bundle';
import { scientificSourceObjectSha256 } from './linked-item-recovery-decoder';
import {
  acquireEligibleMigrationWorkspace,
  adoptWorkspaceHistory,
} from './adopt-workspace-history';
import { dnaBasesScientificFingerprint } from './native-exact-match';
import { MigrationStore } from './store';
import { finalizeUnlockedMigrationRecovery, unlockMigrationWorkspace } from './staging-workspace';
import { appendBenchlingExportsToWorkspace } from './workspace-append-executor';

const ORGANIZATION_BASE_URL = 'https://benchling.com/exampleuser';
type ImportDecisionResolver = NonNullable<LinkedItemRecoveryExecutorDeps['resolveImportDecision']>;
const NOTEBOOK_ID = 'etr_APPENDNB';
const TARGET_A = 'seq_APPENDA';
const TARGET_B = 'seq_APPENDB';
const UNRELATED = 'seq_APPENDUNREL';
const TARGET_A_URL = `${ORGANIZATION_BASE_URL}/f/lib_SELECTED_ROOT-selected-root/${TARGET_A}-appended-dna-a/edit`;
const TARGET_B_URL = `${ORGANIZATION_BASE_URL}/f/lib_SELECTED_ROOT-selected-root/${TARGET_B}-appended-dna-b/edit`;

const performanceBudgetIt = process.env.BENCHLING_PERF_GATE === '1' ? it : it.skip;

describe('additive Benchling workspace append', () => {
  let root: string;
  let workspacePath: string;
  let archive: ContentArchive;
  let store: MigrationStore;
  let nextNow: () => string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'workspace-append-integration-'));
    workspacePath = join(root, 'workspace');
    archive = new ContentArchive(join(workspacePath, '.dnaforge', 'migration', 'archive'));
    store = new MigrationStore(createTestDb(), true);
    nextNow = monotonicClock('2026-08-20T20:00:00.000Z');
  });

  afterEach(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('records a file-local render failure and preserves that file on a verified retry', async () => {
    const workspace = await prepareUnlockedWorkspace([
      {
        path: 'Selected Root/Existing (seq_APPENDEXISTING).gb',
        bytes: dnaGenBank('seq_APPENDEXISTING', 'ccccgggg'),
      },
    ]);
    const badPath = 'DNA/Bad sequence (seq_APPENDBAD).gb';
    const goodPath = 'DNA/Good sequence (seq_APPENDGOOD).gb';
    const badBytes = dnaGenBank('seq_APPENDBAD', 'acgtacgt');
    const zip = await writeNativeZip('best-effort-append.zip', [
      { path: badPath, bytes: badBytes },
      { path: goodPath, bytes: dnaGenBank('seq_APPENDGOOD', 'ttttaaaa') },
    ]);
    const renderValidator: LinkedItemRecoveryExecutorDeps['renderValidator'] = async ({
      selectedSourceObjectIds,
      receipts,
    }) =>
      selectedSourceObjectIds.map((sourceObjectId) => ({
        sourceObjectId,
        passed:
          sourceObjectId !== 'seq_APPENDBAD' ||
          receipts.some(
            (receipt) =>
              receipt.sourceObjectId === sourceObjectId && receipt.projection === 'fallback'
          ),
        ...(sourceObjectId === 'seq_APPENDBAD' &&
        !receipts.some(
          (receipt) =>
            receipt.sourceObjectId === sourceObjectId && receipt.projection === 'fallback'
        )
          ? { message: 'This sequence failed render validation.' }
          : {}),
      }));
    try {
      await expect(
        appendBenchlingExportsToWorkspace(workspace.run, [zip], {
          ...appendDeps(workspace),
          renderValidator,
        })
      ).rejects.toMatchObject({ code: 'linked_item_recovery_validation_failed' });
      const failed = store.listLinkedItemRecoveryAttempts(workspace.run.id).at(-1);
      expect(failed?.safeFailure?.bestEffortFallbackSources).toEqual([
        { zipSha256: expect.stringMatching(/^sha256:/u), entryPaths: [badPath] },
      ]);
      if (!failed?.safeFailure?.bestEffortFallbackSources) throw new Error('Missing fallback.');
      const completed = await appendBenchlingExportsToWorkspace(store.getRun()!, [zip], {
        ...appendDeps(workspace),
        renderValidator,
        bestEffortFallback: {
          priorAttemptId: failed.id,
          sources: failed.safeFailure.bestEffortFallbackSources,
        },
      });
      expect(completed.state).toBe('unlocked');
      const receipts = store.listProjectionReceipts(workspace.run.id);
      expect(receipts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sourceObjectId: 'seq_APPENDBAD', projection: 'fallback' }),
          expect.objectContaining({ sourceObjectId: 'seq_APPENDGOOD', projection: 'native' }),
        ])
      );
      const preserved = receipts.find((receipt) => receipt.sourceObjectId === 'seq_APPENDBAD');
      if (!preserved) throw new Error('Preserved file receipt is missing.');
      expect(await readFile(join(workspacePath, preserved.destinationPath), 'utf8')).toBe(badBytes);
      expect(store.getValidationReport(workspace.run.id)?.passed).toBe(true);
    } finally {
      workspace.globalDb.close();
    }
  });

  it.each(['unrelated', 'same ZIP retry', 'changed ZIP retry'] as const)(
    'does not install an abandoned capture during a %s append',
    async (selection) => {
      const workspace = await prepareEmptyNativeWorkspace();
      try {
        const reports = vi.spyOn(validation, 'generateValidationReport');
        const firstZip = await writeNativeZip('captured-a.zip', [
          { path: `DNA A (${TARGET_A}).gb`, bytes: dnaGenBank(TARGET_A, 'acgtacgt') },
        ]);
        const conflictingZip = await writeNativeZip('conflicting-a.zip', [
          { path: `DNA A (${TARGET_A}).gb`, bytes: dnaGenBank(TARGET_A, 'ggggcccc') },
        ]);
        await expect(
          appendBenchlingExportsToWorkspace(
            workspace.run,
            [firstZip, conflictingZip],
            appendDeps(workspace)
          )
        ).rejects.toMatchObject({ name: 'RecoveredSourceObjectContentConflictError' });
        const failed = store.listLinkedItemRecoveryAttempts(workspace.run.id).at(-1);
        if (!failed) throw new Error('Expected the failed two-ZIP attempt.');
        expect(failed).toMatchObject({ state: 'failed', resumeState: 'parsing' });
        const captures = store.listLinkedItemRecoveryCaptures(workspace.run.id, failed.id);
        expect(captures).toEqual([expect.objectContaining({ sourceStableId: TARGET_A })]);
        expect(store.listProjectionReceipts(workspace.run.id)).toEqual([]);
        expect(bindingEntityIds(workspace.globalDb, TARGET_A)).toEqual([]);
        expect(await readBenchlingMigrationActionJournal(workspacePath, failed.id)).toBeNull();

        const unrelatedZip = await writeNativeZip('selected-b.zip', [
          { path: `DNA B (${TARGET_B}).gb`, bytes: dnaGenBank(TARGET_B, 'ttttaaaa') },
        ]);
        const selectedZip =
          selection === 'unrelated'
            ? unrelatedZip
            : selection === 'same ZIP retry'
              ? firstZip
              : conflictingZip;
        const selectedId = selection === 'unrelated' ? TARGET_B : TARGET_A;
        const decide: ImportDecisionResolver = vi.fn(async () => {
          throw new Error('A never-installed source must not require a version decision.');
        });
        const current = store.getRun();
        if (!current) throw new Error('Expected the native migration history.');
        await appendBenchlingExportsToWorkspace(
          current,
          [selectedZip],
          appendDeps(workspace, decide)
        );
        expect(decide).not.toHaveBeenCalled();
        expect(countEntities(workspace.globalDb, 'sequence')).toBe(1);
        expect(bindingEntityIds(workspace.globalDb, selectedId)).toHaveLength(1);
        expect(
          store.listProjectionReceipts(workspace.run.id).map((receipt) => receipt.sourceObjectId)
        ).toEqual([selectedId]);
        const completed = store.listLinkedItemRecoveryAttempts(workspace.run.id).at(-1);
        if (!completed) throw new Error('Expected the later selected import.');
        expect(completed.state).toBe('completed');
        const journal = await readBenchlingMigrationActionJournal(workspacePath, completed.id);
        expect(journal?.allocations.map((allocation) => allocation.sourceObjectId)).toEqual([
          selectedId,
        ]);
        expect(store.listLinkedItemRecoveryCaptures(workspace.run.id, failed.id)).toEqual(captures);
        if (selection === 'unrelated') {
          expect(bindingEntityIds(workspace.globalDb, TARGET_A)).toEqual([]);
          const reportInput = reports.mock.calls.at(-1)?.[0];
          if (!reportInput) throw new Error('Expected real append validation input.');
          expect(reportInput.snapshot).toEqual(store.getSourceSnapshot(workspace.run.id));
          expect(reportInput.uninstalledSupplementalSourceIds).toEqual(new Set([TARGET_A]));
          expect(validation.generateValidationReport(reportInput).passed).toBe(true);
          for (const sourceId of [TARGET_B, 'seq_NOTCAPTURED'])
            expect(() =>
              validation.generateValidationReport({
                ...reportInput,
                uninstalledSupplementalSourceIds: new Set([sourceId]),
              })
            ).toThrow('Uninstalled supplemental source identity is invalid.');
          expect(() =>
            validation.generateValidationReport({
              ...reportInput,
              snapshot: { ...reportInput.snapshot, initialSourceObjectIds: [TARGET_A] },
            })
          ).toThrow('Uninstalled supplemental source identity is invalid.');
          const selectedReceipt = reportInput.receipts[0];
          if (!selectedReceipt) throw new Error('Expected the selected installed receipt.');
          expect(() =>
            validation.generateValidationReport({
              ...reportInput,
              receipts: [
                ...reportInput.receipts,
                { ...selectedReceipt, id: 'receipt-pending-conflict', sourceObjectId: TARGET_A },
              ],
            })
          ).toThrow('Uninstalled supplemental source identity is invalid.');
        }
        const receipt = store.listProjectionReceipts(workspace.run.id)[0];
        if (!receipt) throw new Error('Expected the selected source receipt.');
        const selectedBases =
          selection === 'unrelated'
            ? 'ttttaaaa'
            : selection === 'same ZIP retry'
              ? 'acgtacgt'
              : 'ggggcccc';
        expect(await readFile(join(workspacePath, receipt.destinationPath), 'utf8')).toContain(
          selectedBases.toUpperCase()
        );
      } finally {
        workspace.globalDb.close();
      }
    }
  );

  it('appends a notebook to an imported workspace and reuses the sequence already there', async () => {
    const original = await prepareUnlockedWorkspace([
      {
        path: `Selected Root/Appended DNA A (${TARGET_A}).gb`,
        bytes: dnaGenBank(TARGET_A, 'acgtacgt'),
      },
    ]);
    const sequenceCountBefore = countEntities(original.globalDb, 'sequence');
    expect(sequenceCountBefore).toBe(1);

    const notebookZip = await writeNativeZip('append-notebook.zip', [
      { path: `Appended Notebook (${NOTEBOOK_ID}).html`, bytes: notebookHtml() },
    ]);
    const appended = await appendBenchlingExportsToWorkspace(
      store.getRun()!,
      [notebookZip],
      appendDeps(original)
    );

    expect(appended.state).toBe('unlocked');
    expect(countEntities(original.globalDb, 'notebook')).toBe(1);
    expect(countEntities(original.globalDb, 'sequence')).toBe(sequenceCountBefore);
    expect(bindingEntityIds(original.globalDb, TARGET_A)).toHaveLength(1);
    original.globalDb.close();
  });

  it('preserves an appended root, child, and grandchild as one merged collection tree', async () => {
    const original = await prepareUnlockedWorkspace([
      { path: `Selected Root/Appended Notebook (${NOTEBOOK_ID}).html`, bytes: notebookHtml() },
    ]);
    const nestedZip = await writeNativeZip('append-nested-tree.zip', [
      {
        path: `Appended Root/Alpha/Appended DNA A (${TARGET_A}).gb`,
        bytes: dnaGenBank(TARGET_A, 'acgtacgt'),
      },
      {
        path: `Appended Root/Alpha/Grandchild/Appended DNA B (${TARGET_B}).gb`,
        bytes: dnaGenBank(TARGET_B, 'ttttaaaa'),
      },
      {
        path: `Appended Root/Beta/Appended DNA A (${TARGET_A}).gb`,
        bytes: dnaGenBank(TARGET_A, 'acgtacgt'),
      },
    ]);

    await expect(
      appendBenchlingExportsToWorkspace(store.getRun()!, [nestedZip], appendDeps(original))
    ).resolves.toMatchObject({ state: 'unlocked' });

    const projection = await readCollectionProjection(workspacePath);
    const collectionByTitle = new Map(
      projection.collections.map((collection) => [collection.title, collection])
    );
    expect([...collectionByTitle.keys()].sort()).toEqual([
      'Alpha',
      'Beta',
      'Grandchild',
      'Selected Root',
    ]);
    expect(collectionByTitle.get('Alpha')?.parentCollectionId).toBe(
      collectionByTitle.get('Selected Root')?.id
    );
    expect(collectionByTitle.get('Beta')?.parentCollectionId).toBe(
      collectionByTitle.get('Selected Root')?.id
    );
    expect(collectionByTitle.get('Grandchild')?.parentCollectionId).toBe(
      collectionByTitle.get('Alpha')?.id
    );
    const targetAMembership = projection.objectMemberships.find(
      (membership) => membership.sourceObjectId === TARGET_A
    );
    expect(targetAMembership?.destinationCollectionIds.sort()).toEqual(
      [collectionByTitle.get('Alpha')?.id, collectionByTitle.get('Beta')?.id].sort()
    );
    const nativePaths = [...nativeFolderPathMap(projection).values()].sort();
    expect(nativePaths).toContain('Benchling Imports/Folders/Selected Root/Alpha');
    expect(nativePaths).toContain('Benchling Imports/Folders/Selected Root/Alpha/Grandchild');
    expect(
      await readFile(
        join(workspacePath, 'Benchling Imports/Folders/Selected Root/Alpha/Grandchild/.gitkeep'),
        'utf8'
      )
    ).toBe('');
    expect(store.listWorkspaceAppendHierarchyCaptures(original.run.id)).toHaveLength(1);
    expect(countEntities(original.globalDb, 'sequence')).toBe(2);

    const overlappingTreeZip = await writeNativeZip('append-overlapping-tree.zip', [
      {
        path: `Appended Root/Alpha/Unrelated DNA (${UNRELATED}).gb`,
        bytes: dnaGenBank(UNRELATED, 'ggggcccc'),
      },
    ]);
    await appendBenchlingExportsToWorkspace(
      store.getRun()!,
      [overlappingTreeZip],
      appendDeps(original)
    );
    const mergedProjection = await readCollectionProjection(workspacePath);
    expect(
      mergedProjection.collections.filter((collection) => collection.title === 'Alpha')
    ).toHaveLength(1);
    expect(mergedProjection.collections).toHaveLength(4);
    expect(countEntities(original.globalDb, 'sequence')).toBe(3);
    expect(store.listWorkspaceAppendHierarchyCaptures(original.run.id)).toHaveLength(2);
    original.globalDb.close();
  });

  it.each(['sequence', 'notebook', 'notebook with removed references'] as const)(
    'replaces an adopted legacy package without mixing hash authorities: %s',
    async (variant) => {
      const kind = variant === 'sequence' ? 'sequence' : 'notebook';
      const original = await prepareUnlockedWorkspace([
        {
          path: `Selected Root/Appended DNA A (${TARGET_A}).gb`,
          bytes: dnaGenBank(TARGET_A, 'acgtacgt'),
        },
        {
          path: `Selected Root/Appended Notebook (${NOTEBOOK_ID}).html`,
          bytes:
            variant === 'notebook with removed references'
              ? notebookHtml()
              : '<html><body><p>Original legacy notebook</p></body></html>',
        },
      ]);
      const manifestPath = join(workspacePath, '.forge/catalog.json');
      const before = parseNativeWorkspaceManifest(await readFile(manifestPath, 'utf8'));
      if (variant === 'notebook with removed references') {
        const notebook = before.entities.find((entity) => entity.type === 'notebook');
        const sequence = before.entities.find((entity) => entity.type === 'sequence');
        if (!notebook || !sequence) throw new Error('Missing original linked entities');
        before.links.push({
          sourceId: notebook.id,
          targetId: sequence.id,
          relation: 'user_related_to',
          evidence: { kind: 'user_note' },
        });
        await writeFile(manifestPath, JSON.stringify(before));
        original.globalDb
          .prepare(
            `INSERT INTO catalog_entity_links
        (id, source_entity_id, relation, target_entity_id, confidence, evidence, created_at, updated_at)
        SELECT 'user-link', source.id, 'user_related_to', target.id, 'confirmed', '{"kind":"user_note"}', 1, 1
        FROM catalog_entities source, catalog_entities target WHERE source.type='notebook' AND target.type='sequence'`
          )
          .run();
      }
      expect(before.schema).not.toBe(NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA);
      expect(original.run.workspaceOrigin).toBeUndefined();
      if (!original.run.workspaceDbId) throw new Error('Missing workspace binding');
      const acquired = await acquireEligibleMigrationWorkspace(
        original.globalDb,
        original.run.workspaceDbId
      );
      try {
        const run = await adoptWorkspaceHistory({
          binding: acquired.binding,
          now: nextNow,
          openStore: () => nonClosingStore(store),
        });
        expect(run.workspaceOrigin?.kind).toBe('migration_created');
        const incoming = await writeNativeZip(
          'legacy-replacement.zip',
          kind === 'sequence'
            ? [
                {
                  path: `Selected Root/Appended DNA A (${TARGET_A}).gb`,
                  bytes: dnaGenBank(TARGET_A, 'ggggcccc'),
                },
              ]
            : [
                {
                  path: `Selected Root/Appended Notebook (${NOTEBOOK_ID}).html`,
                  bytes: '<html><body><p>Updated legacy notebook</p></body></html>',
                },
              ]
        );
        await appendBenchlingExportsToWorkspace(
          run,
          [incoming],
          appendDeps({ ...original, run }, async () => ({
            kind: 'provider_version_conflict',
            policy: 'use_incoming',
          }))
        );
        expect(store.listLinkedItemRecoveryAttempts(run.id).at(-1)?.state).toBe('completed');
        const after = parseNativeWorkspaceManifest(await readFile(manifestPath, 'utf8'));
        const oldEntity = before.entities.find((entity) => entity.type === kind);
        const newEntity = after.entities.find((entity) => entity.type === kind);
        expect(newEntity?.id).toBe(oldEntity?.id);
        if (variant === 'notebook with removed references') {
          expect(
            after.links.filter((link) => link.evidence?.kind === 'migration_relationship')
          ).toEqual([]);
          expect(after.links.filter((link) => link.relation === 'user_related_to')).toEqual(
            before.links.filter((link) => link.relation === 'user_related_to')
          );
          expect(
            original.globalDb
              .prepare(
                "SELECT id FROM catalog_entity_links WHERE json_extract(evidence, '$.kind')='migration_relationship'"
              )
              .all()
          ).toEqual([]);
          expect(
            original.globalDb
              .prepare("SELECT evidence FROM catalog_entity_links WHERE id='user-link'")
              .get()
          ).toEqual({ evidence: '{"kind":"user_note"}' });
        }
        if (kind === 'sequence') {
          const receipt = store
            .listProjectionReceipts(run.id)
            .find((entry) => entry.sourceObjectId === TARGET_A);
          if (!receipt) throw new Error('Missing sequence receipt');
          expect(await readFile(join(workspacePath, receipt.destinationPath), 'utf8')).toMatch(
            /ggggcccc/i
          );
          expect(JSON.stringify(newEntity?.lims)).toContain(
            dnaBasesScientificFingerprint('GGGGCCCC')
          );
          expect(
            JSON.stringify(
              original.globalDb
                .prepare("SELECT fields FROM lims_entity WHERE kind='dna_sequence'")
                .all()
            )
          ).toContain(dnaBasesScientificFingerprint('GGGGCCCC'));
        } else {
          const receipt = store
            .listProjectionReceipts(run.id)
            .find((entry) => entry.sourceObjectId === NOTEBOOK_ID);
          if (!receipt) throw new Error('Missing notebook receipt');
          const markdownPath = notebookPackagePaths(
            dirname(dirname(join(workspacePath, receipt.destinationPath)))
          ).markdownPath;
          expect(await readFile(markdownPath, 'utf8')).toContain('Updated legacy notebook');
          expect(
            JSON.stringify(original.globalDb.prepare('SELECT content FROM pages').all())
          ).toContain('Updated legacy notebook');
        }
      } finally {
        acquired.release();
        original.globalDb.close();
      }
    }
  );

  it('adds a proven nested membership without rewriting an existing native object', async () => {
    const original = await prepareUnlockedWorkspace([
      {
        path: `Selected Root/Appended DNA A (${TARGET_A}).gb`,
        bytes: dnaGenBank(TARGET_A, 'acgtacgt'),
      },
    ]);
    const bytesBefore = await readNativeObjectBytes();
    const scientificBefore = scientificSourceObjectSha256(
      store.listSourceObjects(original.run.id).find((object) => object.id === TARGET_A)!
    );
    const nestedZip = await writeNativeZip('append-existing-nested.zip', [
      {
        path: `Another Root/Alpha/Appended DNA A (${TARGET_A}).gb`,
        bytes: dnaGenBank(TARGET_A, 'acgtacgt'),
      },
    ]);

    await appendBenchlingExportsToWorkspace(store.getRun()!, [nestedZip], appendDeps(original));

    const sourceObject = store
      .listSourceObjects(original.run.id)
      .find((object) => object.id === TARGET_A)!;
    expect(sourceObject.memberships).toHaveLength(2);
    expect(scientificSourceObjectSha256(sourceObject)).toBe(scientificBefore);
    const projection = await readCollectionProjection(workspacePath);
    const membership = projection.objectMemberships.find(
      (candidate) => candidate.sourceObjectId === TARGET_A
    );
    expect(membership?.destinationCollectionIds).toHaveLength(2);
    const bytesAfter = await readNativeObjectBytes();
    for (const [path, bytes] of Object.entries(bytesBefore)) {
      expect(bytesAfter[path]).toBe(bytes);
    }
    expect(Object.keys(bytesAfter)).toEqual(Object.keys(bytesBefore));
    expect(countEntities(original.globalDb, 'sequence')).toBe(1);
    const attempt = store.listLinkedItemRecoveryAttempts(original.run.id).at(-1);
    expect(attempt).toMatchObject({
      corroboratedExistingObjectCount: 1,
      retainedExistingObjectCount: 0,
    });
    original.globalDb.close();
  });

  performanceBudgetIt(
    'imports 700 unique objects across 100 folders within the 10 second budget',
    { retry: 1, timeout: 30_000 },
    async () => {
      const original = await prepareUnlockedWorkspace([
        { path: `Selected Root/Appended Notebook (${NOTEBOOK_ID}).html`, bytes: notebookHtml() },
      ]);
      const entries = Array.from({ length: 700 }, (_, index) => {
        const sourceId = `seq_SCALE${String(index).padStart(4, '0')}`;
        const folder = `Folder ${String(index % 100).padStart(3, '0')}`;
        return {
          path: `Scale Root/${folder}/Scale DNA ${index} (${sourceId}).gb`,
          bytes: dnaGenBank(sourceId, index % 2 === 0 ? 'acgtacgt' : 'ttttaaaa'),
        };
      });
      const scaleZip = await writeNativeZip('append-scale-tree.zip', entries);

      const startedAt = performance.now();
      await appendBenchlingExportsToWorkspace(store.getRun()!, [scaleZip], appendDeps(original));
      const elapsedMs = performance.now() - startedAt;

      const projection = await readCollectionProjection(workspacePath);
      expect(store.listSourceObjects(original.run.id)).toHaveLength(701);
      expect(store.listProjectionReceipts(original.run.id)).toHaveLength(701);
      expect(projection.collections).toHaveLength(101);
      expect(projection.objectMemberships).toHaveLength(701);
      expect(store.listWorkspaceAppendHierarchyCaptures(original.run.id)).toEqual([
        expect.objectContaining({
          folders: expect.arrayContaining([
            expect.objectContaining({ archiveRelativePath: 'Folder 000' }),
          ]),
        }),
      ]);
      expect(store.listWorkspaceAppendHierarchyCaptures(original.run.id)[0].folders).toHaveLength(
        100
      );
      expect(
        store
          .getValidationReport(original.run.id)
          ?.issues.filter((issue) => issue.code === 'local_export_warning')
      ).toEqual([]);
      expect(elapsedMs).toBeLessThan(10_000);
      original.globalDb.close();
    }
  );

  it('resolves an edited notebook reference when the target arrives later, without touching the edit', async () => {
    const original = await prepareUnlockedWorkspace([
      { path: `Selected Root/Appended Notebook (${NOTEBOOK_ID}).html`, bytes: notebookHtml() },
    ]);
    const notebookRow = original.globalDb
      .prepare("SELECT id FROM catalog_entities WHERE type = 'notebook'")
      .get() as { id: string };
    const editedContent = JSON.stringify({
      type: 'doc',
      content: [{ type: 'paragraph', text: 'Edited by the scientist after import' }],
    });
    original.globalDb
      .prepare('UPDATE pages SET content = ? WHERE id = ?')
      .run(editedContent, notebookRow.id);
    const notebookPackageBefore = await readNotebookPackage(original);
    expect(bindingEntityIds(original.globalDb, TARGET_A)).toHaveLength(0);
    expect(referenceCounts(original.run.id)).toMatchObject({ resolved: 0, pending: 2 });

    const sequenceZip = await writeNativeZip('append-sequence.zip', [
      { path: `Appended DNA A (${TARGET_A}).gb`, bytes: dnaGenBank(TARGET_A, 'acgtacgt') },
    ]);
    await appendBenchlingExportsToWorkspace(store.getRun()!, [sequenceZip], appendDeps(original));

    expect(bindingEntityIds(original.globalDb, TARGET_A)).toHaveLength(1);
    expect(referenceCounts(original.run.id)).toMatchObject({ resolved: 1, pending: 1 });
    expect(
      original.globalDb.prepare('SELECT content FROM pages WHERE id = ?').get(notebookRow.id)
    ).toEqual({ content: editedContent });
    expect(await readNotebookPackage(original)).toEqual(notebookPackageBefore);
    original.globalDb.close();
  });

  it('is idempotent when the same export is appended twice', async () => {
    const original = await prepareUnlockedWorkspace([
      { path: `Selected Root/Appended Notebook (${NOTEBOOK_ID}).html`, bytes: notebookHtml() },
    ]);
    const sequenceZip = await writeNativeZip('append-twice.zip', [
      { path: `Appended DNA A (${TARGET_A}).gb`, bytes: dnaGenBank(TARGET_A, 'acgtacgt') },
    ]);
    await appendBenchlingExportsToWorkspace(store.getRun()!, [sequenceZip], appendDeps(original));

    const entitiesAfterFirst = entityFingerprint(original.globalDb);
    const bindingsAfterFirst = bindingFingerprint(original.globalDb);
    const linksAfterFirst = linkFingerprint(original.globalDb);
    const manifestAfterFirst = await readManifest();
    const collectionsAfterFirst = await readCollectionProjection(workspacePath);
    const hierarchyCapturesAfterFirst = store.listWorkspaceAppendHierarchyCaptures(original.run.id);

    await appendBenchlingExportsToWorkspace(store.getRun()!, [sequenceZip], appendDeps(original));

    expect(entityFingerprint(original.globalDb)).toEqual(entitiesAfterFirst);
    expect(bindingFingerprint(original.globalDb)).toEqual(bindingsAfterFirst);
    expect(linkFingerprint(original.globalDb)).toEqual(linksAfterFirst);
    expect(await readManifest()).toEqual(manifestAfterFirst);
    expect(await readCollectionProjection(workspacePath)).toEqual(collectionsAfterFirst);
    expect(store.listWorkspaceAppendHierarchyCaptures(original.run.id)).toEqual(
      hierarchyCapturesAfterFirst
    );
    original.globalDb.close();
  });

  it('completes a zero-base sequence in place when a later export supplies its bases', async () => {
    const stableId = 'seq_NEEDSSEQUENCE';
    const original = await prepareUnlockedWorkspace([
      {
        path: `Selected Root/Sequence awaiting bases (${stableId}).gb`,
        bytes: zeroBaseGenBank(stableId),
      },
    ]);
    const [entityId] = bindingEntityIds(original.globalDb, stableId);
    if (!entityId) throw new Error('The unresolved sequence has no provider binding.');

    expect(countEntities(original.globalDb, 'sequence')).toBe(1);
    expect(store.listNeedsSequenceProjectionSourceIds(original.run.id)).toEqual([stableId]);
    expect(
      original.globalDb
        .prepare('SELECT locator, storage_type AS storageType FROM catalog_entities WHERE id = ?')
        .get(entityId)
    ).toEqual({ locator: `entity://lims/${entityId}`, storageType: 'database' });
    const unresolvedLims = original.globalDb
      .prepare('SELECT fields, registration_status AS status FROM lims_entity WHERE id = ?')
      .get(entityId) as { fields: string; status: string };
    expect(unresolvedLims.status).toBe('unresolved');
    expect(JSON.parse(unresolvedLims.fields).sequence).toEqual({ mode: 'unresolved' });

    const fullZip = await writeNativeZip('complete-needs-sequence.zip', [
      {
        path: `Sequence awaiting bases (${stableId}).gb`,
        bytes: dnaGenBank(stableId, 'acgtacgt'),
      },
    ]);
    await appendBenchlingExportsToWorkspace(store.getRun()!, [fullZip], appendDeps(original));

    expect(countEntities(original.globalDb, 'sequence')).toBe(1);
    expect(bindingEntityIds(original.globalDb, stableId)).toEqual([entityId]);
    expect(
      store
        .listProjectionReceipts(original.run.id)
        .find((receipt) => receipt.sourceObjectId === stableId)
    ).toMatchObject({
      destinationObjectId: expect.any(String),
      nativeRepresentation: 'dna_sequence',
    });
    const completedCatalog = original.globalDb
      .prepare('SELECT locator, storage_type AS storageType FROM catalog_entities WHERE id = ?')
      .get(entityId) as { locator: string; storageType: string };
    expect(completedCatalog.storageType).toBe('file');
    expect(completedCatalog.locator).toMatch(/^file:\/\//u);
    const completedLims = original.globalDb
      .prepare('SELECT fields, registration_status AS status FROM lims_entity WHERE id = ?')
      .get(entityId) as { fields: string; status: string };
    expect(completedLims.status).toBe('registered');
    expect(JSON.parse(completedLims.fields).sequence).toMatchObject({
      mode: 'file',
      length: 8,
    });

    const entitiesAfterCompletion = entityFingerprint(original.globalDb);
    const bindingsAfterCompletion = bindingFingerprint(original.globalDb);
    const manifestAfterCompletion = await readManifest();
    await appendBenchlingExportsToWorkspace(store.getRun()!, [fullZip], appendDeps(original));
    expect(entityFingerprint(original.globalDb)).toEqual(entitiesAfterCompletion);
    expect(bindingFingerprint(original.globalDb)).toEqual(bindingsAfterCompletion);
    expect(await readManifest()).toEqual(manifestAfterCompletion);
    original.globalDb.close();
  });

  it('resumes exactly once after an interruption between archive intake and materialization', async () => {
    const original = await prepareUnlockedWorkspace([
      { path: `Selected Root/Appended Notebook (${NOTEBOOK_ID}).html`, bytes: notebookHtml() },
    ]);
    const sequenceZip = await writeNativeZip('append-crash.zip', [
      { path: `Appended DNA A (${TARGET_A}).gb`, bytes: dnaGenBank(TARGET_A, 'acgtacgt') },
    ]);

    const crashingDeps: LinkedItemRecoveryExecutorDeps = {
      ...appendDeps(original),
      store: failingCaptureStore(store),
    };
    await expect(
      appendBenchlingExportsToWorkspace(store.getRun()!, [sequenceZip], crashingDeps)
    ).rejects.toThrow(/simulated interruption/);
    const interrupted = store.listLinkedItemRecoveryAttempts(original.run.id).at(-1);
    expect(interrupted).toMatchObject({ mode: 'workspace_append', state: 'failed' });
    expect(interrupted?.resumeState).not.toBeNull();
    expect(store.listLinkedItemRecoveryArtifacts(original.run.id)).toHaveLength(1);
    expect(bindingEntityIds(original.globalDb, TARGET_A)).toHaveLength(0);
    expect(countEntities(original.globalDb, 'sequence')).toBe(0);

    await appendBenchlingExportsToWorkspace(store.getRun()!, [sequenceZip], appendDeps(original));

    expect(bindingEntityIds(original.globalDb, TARGET_A)).toHaveLength(1);
    expect(countEntities(original.globalDb, 'sequence')).toBe(1);
    expect(store.listLinkedItemRecoveryArtifacts(original.run.id)).toHaveLength(1);
    expect(store.listLinkedItemRecoveryCaptures(original.run.id)).toHaveLength(1);
    expect(store.listWorkspaceAppendHierarchyCaptures(original.run.id)).toHaveLength(1);
    original.globalDb.close();
  });

  it('treats the same object arriving from a second export as corroboration, not conflict', async () => {
    const original = await prepareUnlockedWorkspace([
      { path: `Selected Root/Appended Notebook (${NOTEBOOK_ID}).html`, bytes: notebookHtml() },
    ]);
    const firstZip = await writeNativeZip('corroborating-first.zip', [
      { path: `Appended DNA A (${TARGET_A}).gb`, bytes: dnaGenBank(TARGET_A, 'acgtacgt') },
    ]);
    const secondZip = await writeNativeZip('corroborating-second.zip', [
      { path: `Appended DNA A (${TARGET_A}).gb`, bytes: dnaGenBank(TARGET_A, 'acgtacgt') },
      { path: `Unrelated DNA (${UNRELATED}).gb`, bytes: dnaGenBank(UNRELATED, 'ttttaaaa') },
    ]);
    await appendBenchlingExportsToWorkspace(store.getRun()!, [firstZip], appendDeps(original));

    await expect(
      appendBenchlingExportsToWorkspace(store.getRun()!, [secondZip], appendDeps(original))
    ).resolves.toMatchObject({ state: 'unlocked' });

    expect(bindingEntityIds(original.globalDb, TARGET_A)).toHaveLength(1);
    expect(bindingEntityIds(original.globalDb, UNRELATED)).toHaveLength(1);
    const corroboratedAttempt = store.listLinkedItemRecoveryAttempts(store.getRun()!.id).at(-1);
    expect(corroboratedAttempt?.recoveredUniqueObjectCount).toBe(1);
    expect(corroboratedAttempt?.corroboratedExistingObjectCount).toBe(1);
    expect(corroboratedAttempt?.retainedExistingObjectCount).toBe(0);
    original.globalDb.close();
  });

  it('asks once, keeps every existing version, and still imports the rest', async () => {
    const original = await prepareUnlockedWorkspace([
      { path: `Selected Root/Appended Notebook (${NOTEBOOK_ID}).html`, bytes: notebookHtml() },
    ]);
    const firstZip = await writeNativeZip('append-conflict-first.zip', [
      { path: `Appended DNA A (${TARGET_A}).gb`, bytes: dnaGenBank(TARGET_A, 'acgtacgt') },
      { path: `Appended DNA B (${TARGET_B}).gb`, bytes: dnaGenBank(TARGET_B, 'aaaacccc') },
    ]);
    await appendBenchlingExportsToWorkspace(store.getRun()!, [firstZip], appendDeps(original));
    const bytesBefore = await readNativeObjectBytes();

    const overlappingZip = await writeNativeZip('append-conflict-second.zip', [
      { path: `Appended DNA A (${TARGET_A}).gb`, bytes: dnaGenBank(TARGET_A, 'ggggcccc') },
      { path: `Appended DNA B (${TARGET_B}).gb`, bytes: dnaGenBank(TARGET_B, 'ccccaaaa') },
      { path: `Unrelated DNA (${UNRELATED}).gb`, bytes: dnaGenBank(UNRELATED, 'ttttaaaa') },
    ]);
    const resolveImportDecision = vi.fn(
      async () => ({ kind: 'provider_version_conflict', policy: 'keep_existing' }) as const
    );

    await expect(
      appendBenchlingExportsToWorkspace(
        store.getRun()!,
        [overlappingZip],
        appendDeps(original, resolveImportDecision)
      )
    ).resolves.toMatchObject({ state: 'unlocked' });

    expect(resolveImportDecision).toHaveBeenCalledTimes(1);
    expect(resolveImportDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: original.run.id,
        attemptId: expect.any(String),
        pending: expect.objectContaining({
          kind: 'provider_version_conflict',
          conflicts: [expect.objectContaining({ stableId: TARGET_A })],
        }),
      })
    );

    const bytesAfter = await readNativeObjectBytes();
    for (const [path, bytes] of Object.entries(bytesBefore)) {
      expect(bytesAfter[path]).toBe(bytes);
    }
    const addedPaths = Object.keys(bytesAfter).filter((path) => !(path in bytesBefore));
    expect(addedPaths.length).toBeGreaterThan(0);
    for (const path of addedPaths) {
      expect(path).toContain('Unrelated_DNA');
    }
    expect(bindingEntityIds(original.globalDb, UNRELATED)).toHaveLength(1);
    expect(bindingEntityIds(original.globalDb, TARGET_A)).toHaveLength(1);

    const attempt = store.listLinkedItemRecoveryAttempts(store.getRun()!.id).at(-1);
    if (!attempt) throw new Error('Expected a completed append attempt.');
    expect(attempt?.state).toBe('completed');
    expect(attempt?.recoveredUniqueObjectCount).toBe(1);
    expect(attempt?.retainedExistingObjectCount).toBe(2);
    expect(attempt?.retainedExistingObjects).toEqual([
      { stableId: TARGET_A, name: expect.any(String) },
      { stableId: TARGET_B, name: expect.any(String) },
    ]);
    expect(attempt?.retainedExistingObjects[0]?.name).toBeTruthy();
    expect(attempt?.versionConflictResolution).toMatchObject({
      kind: 'resolved',
      policy: 'keep_existing',
      conflicts: [{ stableId: TARGET_A }, { stableId: TARGET_B }],
    });
    expect(store.listImportDecisions(original.run.id, attempt.id)).toEqual([
      { kind: 'provider_version_conflict', policy: 'keep_existing' },
    ]);
    original.globalDb.close();
  });

  it('asks once and uses every incoming version when the user chooses it', async () => {
    const original = await prepareUnlockedWorkspace([
      { path: `Selected Root/Appended Notebook (${NOTEBOOK_ID}).html`, bytes: notebookHtml() },
    ]);
    const firstZip = await writeNativeZip('append-incoming-first.zip', [
      { path: `Appended DNA A (${TARGET_A}).gb`, bytes: dnaGenBank(TARGET_A, 'acgtacgt') },
      { path: `Appended DNA B (${TARGET_B}).gb`, bytes: dnaGenBank(TARGET_B, 'aaaacccc') },
    ]);
    await appendBenchlingExportsToWorkspace(store.getRun()!, [firstZip], appendDeps(original));
    const fingerprintsBefore = sourceFingerprints(original.run.id);

    const overlappingZip = await writeNativeZip('append-incoming-second.zip', [
      { path: `Appended DNA A (${TARGET_A}).gb`, bytes: dnaGenBank(TARGET_A, 'ggggcccc') },
      { path: `Appended DNA B (${TARGET_B}).gb`, bytes: dnaGenBank(TARGET_B, 'ccccaaaa') },
    ]);
    const resolveImportDecision = vi.fn(
      async () => ({ kind: 'provider_version_conflict', policy: 'use_incoming' }) as const
    );

    await appendBenchlingExportsToWorkspace(
      store.getRun()!,
      [overlappingZip],
      appendDeps(original, resolveImportDecision)
    );

    expect(resolveImportDecision).toHaveBeenCalledTimes(1);
    const fingerprintsAfter = sourceFingerprints(original.run.id);
    expect(fingerprintsAfter.get(TARGET_A)).not.toBe(fingerprintsBefore.get(TARGET_A));
    expect(fingerprintsAfter.get(TARGET_B)).not.toBe(fingerprintsBefore.get(TARGET_B));
    const attempt = store.listLinkedItemRecoveryAttempts(original.run.id).at(-1);
    expect(attempt?.versionConflictResolution).toMatchObject({
      kind: 'resolved',
      policy: 'use_incoming',
      conflicts: [{ stableId: TARGET_A }, { stableId: TARGET_B }],
    });
    expect(attempt?.retainedExistingObjectCount).toBe(0);
    original.globalDb.close();
  });

  it('leaves existing notebook relationships untouched when an unrelated export is appended', async () => {
    const original = await prepareUnlockedWorkspace([
      { path: `Selected Root/Appended Notebook (${NOTEBOOK_ID}).html`, bytes: notebookHtml() },
    ]);
    const relationshipsBefore = relationshipFingerprint(original.run.id);
    const resolutionsBefore = resolutionFingerprint(original.run.id);

    const unrelatedZip = await writeNativeZip('append-unrelated.zip', [
      { path: `Unrelated DNA (${UNRELATED}).gb`, bytes: dnaGenBank(UNRELATED, 'ttttaaaa') },
    ]);
    await appendBenchlingExportsToWorkspace(store.getRun()!, [unrelatedZip], appendDeps(original));

    expect(bindingEntityIds(original.globalDb, UNRELATED)).toHaveLength(1);
    expect(relationshipFingerprint(original.run.id)).toEqual(relationshipsBefore);
    expect(resolutionFingerprint(original.run.id)).toEqual(resolutionsBefore);
    expect(bindingEntityIds(original.globalDb, TARGET_A)).toHaveLength(0);
    original.globalDb.close();
  });

  it.each([true, false])(
    'links one reviewed exact native match without changing its name or scientific content (other object: %s)',
    async (includeOtherObject) => {
      const workspace = await prepareEmptyNativeWorkspace();
      seedNativeSequence(workspace.globalDb, {
        entityId: 'ws1::native-exact-sequence',
        name: 'Existing local sequence',
        bases: 'AACCGG',
      });
      const incomingZip = await writeNativeZip('native-exact-link.zip', [
        {
          path: 'Designs/Benchling display name (seq_EXACT001).gb',
          bytes: dnaGenBank('seq_EXACT001', 'AACCGG'),
        },
        ...(includeOtherObject
          ? [
              {
                path: 'Designs/Unrelated DNA (seq_EXACTUNRELATED).gb',
                bytes: dnaGenBank('seq_EXACTUNRELATED', 'TTTTAAAA'),
              },
            ]
          : []),
      ]);
      const resolveImportDecision = vi.fn<ImportDecisionResolver>(async (input) => {
        if (input.pending.kind !== 'unbound_exact_match') {
          throw new Error(`Unexpected prompt ${input.pending.kind}.`);
        }
        return {
          kind: 'unbound_exact_match',
          sourceObjectId: input.pending.sourceObjectId,
          candidateEntityId: input.pending.candidateEntityId,
          expectedCandidateScientificSha256: input.pending.expectedCandidateScientificSha256,
          expectedBindingState: 'unbound',
          policy: 'link_existing',
        } as const;
      });

      await appendBenchlingExportsToWorkspace(
        workspace.run,
        [incomingZip],
        appendDeps(workspace, resolveImportDecision)
      );

      expect(resolveImportDecision).toHaveBeenCalledOnce();
      expect(
        workspace.globalDb
          .prepare(`SELECT name, fields FROM lims_entity WHERE id = 'ws1::native-exact-sequence'`)
          .get()
      ).toEqual({
        name: 'Existing local sequence',
        fields: JSON.stringify({
          sequence: { mode: 'inline', bases: 'AACCGG', topology: 'linear', length: 6 },
        }),
      });
      expect(bindingEntityIds(workspace.globalDb, 'seq_EXACT001')).toEqual([
        'ws1::native-exact-sequence',
      ]);
      expect(bindingEntityIds(workspace.globalDb, 'seq_EXACTUNRELATED')).toHaveLength(
        includeOtherObject ? 1 : 0
      );
      expect(countEntities(workspace.globalDb, 'sequence')).toBe(includeOtherObject ? 2 : 1);
      const manifest = parseNativeWorkspaceManifest(
        await readFile(join(workspacePath, '.forge/catalog.json'), 'utf8')
      );
      expect(
        manifest.entities.find((entity) => entity.id === 'native-exact-sequence')
      ).toMatchObject({
        name: 'Existing local sequence',
        sourceIdentities: [
          { provider: 'benchling', stableObjectId: 'seq_EXACT001', bindingKind: 'reviewed' },
        ],
        migrationSource: { historyRunId: workspace.run.id, sourceObjectId: 'seq_EXACT001' },
        lims: { fields: { sequence: { mode: 'inline', bases: 'AACCGG' } } },
      });
      expect(store.getRun()?.externalZipSource).toBeUndefined();
      expect(store.getValidationReport(workspace.run.id)).toMatchObject({
        nativeImport: {
          history: 'adopted_history_created',
          destinationChanges: { added: includeOtherObject ? 1 : 0, updated: 0, retained: 1 },
          providerVersions: null,
          exactNativeMatches: [
            { choice: 'link_existing', candidateEntityId: 'ws1::native-exact-sequence' },
          ],
          structuralDecisions: [],
          externalSources: [{ state: 'verified_at_import' }],
        },
      });
      await expect(
        readFile(join(workspacePath, 'Benchling Migration Report.md'))
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        readFile(join(workspacePath, '.dnaforge/migration/report.md'), 'utf8')
      ).resolves.toContain('Passed');
      expect(
        store
          .getSourceSnapshot(workspace.run.id)
          ?.parts.every((part) => part.kind === 'supplemental_local_export')
      ).toBe(true);
      workspace.globalDb.close();
    }
  );

  it('validates a native notebook at its package-root catalog binding', async () => {
    const workspace = await prepareEmptyNativeWorkspace();
    const zip = await writeNativeZip('native-notebook.zip', [
      {
        path: 'Notes/Notebook (etr_PACKAGECHECK).html',
        bytes: Buffer.from(
          '<html><body><h1>Notebook</h1><p>Native package content</p><img src="Notebook (etr_PACKAGECHECK) image.png" alt="Imported attachment"></body></html>'
        ),
      },
      {
        path: 'Notes/Notebook (etr_PACKAGECHECK) image.png',
        bytes: Buffer.from('synthetic-notebook-image-bytes'),
      },
    ]);
    try {
      await appendBenchlingExportsToWorkspace(workspace.run, [zip], appendDeps(workspace));
      const attempt = store.listLinkedItemRecoveryAttempts(workspace.run.id).at(-1);
      if (!attempt) throw new Error('Missing notebook action.');
      const journal = await readBenchlingMigrationActionJournal(workspacePath, attempt.id);
      if (!journal) throw new Error('Missing notebook journal.');
      const manifest = parseNativeWorkspaceManifest(
        await readFile(join(workspacePath, '.forge/catalog.json'), 'utf8')
      );
      const notebookPage = workspace.globalDb.prepare('SELECT content FROM pages').get() as {
        content: string;
      };
      expect(notebookPage.content).toContain('Native package content');
      const notebookContent = JSON.parse(notebookPage.content);
      expect(JSON.stringify(notebookContent)).toContain('assets/');
      expect(() =>
        assertNativeActionCatalogIntegrity({
          db: workspace.globalDb,
          workspacePath,
          journal,
          manifest,
        })
      ).not.toThrow();
    } finally {
      workspace.globalDb.close();
    }
  });

  it.each([
    'entity',
    'placement',
    'provider binding',
    'migration source',
    'LIMS projection',
  ] as const)(
    'rejects a completed catalog record whose %s disagrees with its portable manifest',
    async (fault) => {
      const workspace = await prepareEmptyNativeWorkspace();
      seedNativeSequence(workspace.globalDb, {
        entityId: 'ws1::integrity-native',
        name: 'Local DNA',
        bases: 'AACCGG',
      });
      const zip = await writeNativeZip('catalog-integrity.zip', [
        {
          path: 'DNA/Incoming (seq_CATALOGCHECK).gb',
          bytes: dnaGenBank('seq_CATALOGCHECK', 'AACCGG'),
        },
      ]);
      const decide: ImportDecisionResolver = async ({ pending }) => {
        if (pending.kind !== 'unbound_exact_match') throw new Error('Expected exact match.');
        return {
          kind: pending.kind,
          sourceObjectId: pending.sourceObjectId,
          candidateEntityId: pending.candidateEntityId,
          expectedCandidateScientificSha256: pending.expectedCandidateScientificSha256,
          expectedBindingState: 'unbound',
          policy: 'link_existing',
        };
      };
      await appendBenchlingExportsToWorkspace(workspace.run, [zip], appendDeps(workspace, decide));
      const attempt = store.listLinkedItemRecoveryAttempts(workspace.run.id).at(-1);
      if (!attempt) throw new Error('Missing import action.');
      const journal = await readBenchlingMigrationActionJournal(workspacePath, attempt.id);
      if (!journal) throw new Error('Missing journal.');
      const manifest = parseNativeWorkspaceManifest(
        await readFile(join(workspacePath, '.forge/catalog.json'), 'utf8')
      );
      const verify = () =>
        assertNativeActionCatalogIntegrity({
          db: workspace.globalDb,
          workspacePath,
          journal,
          manifest,
        });
      expect(verify).not.toThrow();
      switch (fault) {
        case 'entity':
          workspace.globalDb
            .prepare(`UPDATE catalog_entities SET name = 'Changed' WHERE id = ?`)
            .run('ws1::integrity-native');
          break;
        case 'placement':
          workspace.globalDb
            .prepare(
              `UPDATE catalog_workspace_placements SET display_name = 'Changed' WHERE entity_id = ?`
            )
            .run('ws1::integrity-native');
          break;
        case 'provider binding':
          workspace.globalDb
            .prepare(
              `UPDATE catalog_provider_bindings SET stable_object_id = 'seq_OTHER' WHERE entity_id = ?`
            )
            .run('ws1::integrity-native');
          break;
        case 'migration source':
          workspace.globalDb
            .prepare(`UPDATE catalog_entities SET metadata = '{}' WHERE id = ?`)
            .run('ws1::integrity-native');
          break;
        case 'LIMS projection':
          workspace.globalDb
            .prepare(`UPDATE lims_entity SET fields = '{}' WHERE id = ?`)
            .run('ws1::integrity-native');
          break;
      }
      expect(verify).toThrow(/disagrees/);
      workspace.globalDb.close();
    }
  );

  it.each([
    { comparison: 'equal', hasManifest: false },
    { comparison: 'changed', hasManifest: false },
    { comparison: 'equal', hasManifest: true },
    { comparison: 'changed', hasManifest: true },
  ])(
    'preserves an adopted provider-bound item ($comparison, manifest: $hasManifest)',
    async ({ comparison, hasManifest }) => {
      const workspace = await prepareEmptyNativeWorkspace();
      seedNativeSequence(workspace.globalDb, {
        entityId: 'ws1::prebound',
        name: 'My current name',
        bases: 'AACCGG',
      });
      upsertProviderBinding(workspace.globalDb, {
        reference: {
          provider: 'benchling',
          stableObjectId: 'seq_PREBOUND',
          objectClass: 'sequence',
          canonicalUrl: null,
          providerAccountHint: null,
        },
        entityId: 'ws1::prebound',
        bindingKind: 'reviewed',
        evidence: { source: 'manual' },
      });
      if (hasManifest) {
        await mkdir(join(workspacePath, '.forge'), { recursive: true });
        await writeFile(
          join(workspacePath, '.forge/catalog.json'),
          JSON.stringify({
            schema: NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA,
            entities: [
              {
                id: 'prebound',
                type: 'sequence',
                name: 'My current name',
                placement: {
                  kind: 'catalog-record',
                  parentRelativePath: 'Registry',
                  displayName: 'My current name',
                  catalogType: 'sequence',
                  presentationKind: 'sequence',
                },
                lims: {
                  kind: 'dna_sequence',
                  name: 'My current name',
                  fields: {
                    sequence: { mode: 'inline', bases: 'AACCGG', topology: 'linear', length: 6 },
                  },
                  registrationStatus: 'tracked',
                  domainStatus: null,
                  createdAt: 0,
                },
                sourceIdentities: [
                  {
                    provider: 'benchling',
                    stableObjectId: 'seq_PREBOUND',
                    objectClass: 'sequence',
                    bindingKind: 'reviewed',
                  },
                ],
              },
            ],
            links: [],
          })
        );
      }
      const zip = await writeNativeZip('prebound.zip', [
        {
          path: 'DNA/Incoming name (seq_PREBOUND).gb',
          bytes: dnaGenBank('seq_PREBOUND', comparison === 'equal' ? 'AACCGG' : 'CCGGTT'),
        },
        {
          path: 'DNA/Other (seq_PREBOUNDOTHER).gb',
          bytes: dnaGenBank('seq_PREBOUNDOTHER', 'GATTACA'),
        },
      ]);
      const decide = vi.fn<ImportDecisionResolver>(async ({ pending }) => {
        expect(pending.kind).toBe('provider_version_conflict');
        return { kind: 'provider_version_conflict', policy: 'keep_existing' };
      });
      await appendBenchlingExportsToWorkspace(workspace.run, [zip], appendDeps(workspace, decide));
      expect(decide).toHaveBeenCalledTimes(comparison === 'equal' ? 0 : 1);
      expect(
        workspace.globalDb
          .prepare('SELECT name, fields FROM lims_entity WHERE id = ?')
          .get('ws1::prebound')
      ).toEqual({
        name: 'My current name',
        fields: JSON.stringify({
          sequence: { mode: 'inline', bases: 'AACCGG', topology: 'linear', length: 6 },
        }),
      });
      const manifest = parseNativeWorkspaceManifest(
        await readFile(join(workspacePath, '.forge/catalog.json'), 'utf8')
      );
      expect(manifest.entities.find((entity) => entity.id === 'prebound')).toMatchObject({
        name: 'My current name',
        lims: { fields: { sequence: { bases: 'AACCGG' } } },
        sourceIdentities: [{ stableObjectId: 'seq_PREBOUND', bindingKind: 'reviewed' }],
        migrationSource: { historyRunId: workspace.run.id, sourceObjectId: 'seq_PREBOUND' },
      });
      expect(countEntities(workspace.globalDb, 'sequence')).toBe(2);
      workspace.globalDb.close();
    }
  );

  it.each(['Yeast/', ''])(
    'creates new catalog records under %s without treating pathless allocations as retained items',
    async (parent) => {
      const workspace = await prepareEmptyNativeWorkspace();
      const zip = await writeNativeZip('new-catalog-records.zip', [
        { path: `${parent}Strain (bfi_STRAINNEW).txt`, bytes: SYNTHETIC_STRAIN_TEXT },
        { path: `${parent}Empty DNA (seq_EMPTYNEW).gb`, bytes: zeroBaseGenBank('seq_EMPTYNEW') },
      ]);
      await appendBenchlingExportsToWorkspace(workspace.run, [zip], appendDeps(workspace));
      expect(bindingEntityIds(workspace.globalDb, 'bfi_STRAINNEW')).toHaveLength(1);
      expect(bindingEntityIds(workspace.globalDb, 'seq_EMPTYNEW')).toHaveLength(1);
      const manifest = parseNativeWorkspaceManifest(
        await readFile(join(workspacePath, '.forge/catalog.json'), 'utf8')
      );
      for (const id of ['bfi_STRAINNEW', 'seq_EMPTYNEW']) {
        expect(
          manifest.entities.find((entity) =>
            entity.sourceIdentities?.some((identity) => identity.stableObjectId === id)
          )
        ).toMatchObject({
          placement: { kind: 'catalog-record' },
        });
      }
      expect(store.getValidationReport(workspace.run.id)).toMatchObject({
        nativeImport: { destinationChanges: { added: 2, updated: 0, retained: 0 } },
      });
      workspace.globalDb.close();
    }
  );

  it('imports and replaces custom registry records through the native action coordinator', async () => {
    const workspace = await prepareEmptyNativeWorkspace();
    const decide = vi.fn<ImportDecisionResolver>(async () => ({
      kind: 'provider_version_conflict',
      policy: 'use_incoming',
    }));
    const zipFor = (amount: string, revision: string, required = false) =>
      writeNativeZip(`registry-${revision}-${amount || 'empty'}.zip`, [
        {
          path: 'records.schema.json',
          bytes: JSON.stringify({
            schema: 'benchling.registry-schema.v1',
            sourceSchemaId: 'reagent',
            sourceRevisionId: revision,
            name: 'reagent',
            displayName: 'Reagent',
            recordPaths: ['records.csv'],
            fields: [
              {
                sourceFieldId: 'amount',
                definition: { key: 'amount', label: 'Amount', type: 'number', required },
              },
              {
                sourceFieldId: 'parent',
                definition: { key: 'parent', label: 'Parent', type: 'record_relationship' },
              },
            ],
          }),
        },
        {
          path: 'records.csv',
          bytes: `id,name,registryid,amount,parent\nbfi_CUSTOMA,Reagent A,REAGENT-42,${amount},bfi_CUSTOMB\nbfi_CUSTOMB,Reagent B,REAGENT-43,3,\n`,
        },
      ]);
    try {
      const firstZip = await zipFor('12.5', 'r1');
      await appendBenchlingExportsToWorkspace(
        workspace.run,
        [firstZip],
        appendDeps(workspace, decide)
      );
      const ids = bindingEntityIds(workspace.globalDb, 'bfi_CUSTOMA');
      expect(ids).toHaveLength(1);
      const entityId = ids[0]!;
      const readRecord = () =>
        workspace.globalDb
          .prepare(
            'SELECT kind, fields, schema_id, schema_revision_id, registry_id, registration_status FROM lims_entity WHERE id = ?'
          )
          .get(entityId) as {
          kind: string;
          fields: string;
          schema_id: string;
          schema_revision_id: string;
          registry_id: string;
          registration_status: string;
        };
      const first = readRecord();
      expect(JSON.parse(first.fields)).toMatchObject({
        amount: 12.5,
        parent: { destinationEntityId: bindingEntityIds(workspace.globalDb, 'bfi_CUSTOMB')[0] },
      });
      await appendBenchlingExportsToWorkspace(
        store.getRun()!,
        [firstZip],
        appendDeps(workspace, decide)
      );
      expect(decide).not.toHaveBeenCalled();
      expect(readRecord()).toEqual(first);
      const secondZip = await zipFor('25', 'r1');
      await appendBenchlingExportsToWorkspace(
        store.getRun()!,
        [secondZip],
        appendDeps(workspace, decide)
      );
      expect(decide).toHaveBeenCalledOnce();
      expect(JSON.parse(readRecord().fields).amount).toBe(25);
      const thirdZip = await zipFor('', 'r2', true);
      await appendBenchlingExportsToWorkspace(
        store.getRun()!,
        [thirdZip],
        appendDeps(workspace, decide)
      );
      const after = readRecord();
      expect(after.kind).not.toBe(first.kind);
      expect(after.schema_revision_id).not.toBe(first.schema_revision_id);
      expect(after.schema_id).not.toBe(first.schema_id);
      expect(after.registry_id).toBe(first.registry_id);
      expect(after.registration_status).toBe('unresolved');
      expect(JSON.parse(after.fields)).not.toHaveProperty('amount');
      expect(countEntities(workspace.globalDb, 'record')).toBe(2);
      const manifest = parseNativeWorkspaceManifest(
        await readFile(join(workspacePath, '.forge/catalog.json'), 'utf8')
      );
      expect(
        manifest.entities.find((entity) =>
          entity.sourceIdentities?.some((identity) => identity.stableObjectId === 'bfi_CUSTOMA')
        )
      ).toMatchObject({
        metadata: { sourceRegistryId: 'REAGENT-42' },
        lims: {
          kind: after.kind,
          schemaRevisionId: after.schema_revision_id,
          registrationStatus: 'unresolved',
        },
      });
      expect(workspace.globalDb.pragma('foreign_key_check')).toEqual([]);
      store.close();
      store = new MigrationStore(createTestDb(), true);
      const adopted = await adoptWorkspaceHistory({
        binding: {
          workspaceDbId: 1,
          repoUuid: null,
          projectionScopeId: 'ws1',
          workspacePath,
          displayName: 'Reconstructed native destination',
          durability: { kind: 'local_filesystem' },
        },
        now: nextNow,
        openStore: () => nonClosingStore(store),
      });
      const currentBefore = readRecord();
      decide.mockClear();
      await appendBenchlingExportsToWorkspace(
        adopted,
        [thirdZip],
        appendDeps({ ...workspace, run: adopted }, decide)
      );
      expect(decide).not.toHaveBeenCalled();
      expect(readRecord()).toEqual(currentBefore);
      expect(countEntities(workspace.globalDb, 'record')).toBe(2);
      await appendBenchlingExportsToWorkspace(
        store.getRun()!,
        [await zipFor('', 'r3', true)],
        appendDeps(workspace, decide)
      );
      expect(decide).toHaveBeenCalled();
      expect(readRecord().schema_revision_id).not.toBe(currentBefore.schema_revision_id);
    } finally {
      workspace.globalDb.close();
    }
  });

  it.each([
    'ordinary',
    'null',
    'other-target',
    'tracked',
    'drifted',
    'shared-target',
    'interrupted-database',
    'interrupted-manifest',
  ] as const)(
    'repairs a missing typed registry relationship without losing $0 edits',
    async (mode) => {
      const workspace = await prepareEmptyNativeWorkspace();
      const zipFor = (suffix: string, rows: string) =>
        writeNativeZip(`registry-links-${suffix}.zip`, [
          {
            path: 'records.schema.json',
            bytes: JSON.stringify({
              schema: 'benchling.registry-schema.v1',
              sourceSchemaId: 'reagent-links',
              sourceRevisionId: 'r1',
              name: 'reagent',
              displayName: 'Reagent',
              recordPaths: ['records.csv'],
              fields: [
                {
                  sourceFieldId: 'amount',
                  definition: { key: 'amount', label: 'Amount', type: 'number' },
                },
                {
                  sourceFieldId: 'parent',
                  definition: {
                    key: 'parent',
                    label: 'Parent',
                    type: 'record_relationship',
                    required: true,
                  },
                },
                ...(mode === 'shared-target'
                  ? [
                      {
                        sourceFieldId: 'backup',
                        definition: { key: 'backup', label: 'Backup', type: 'record_relationship' },
                      },
                    ]
                  : []),
              ],
            }),
          },
          {
            path: 'records.csv',
            bytes: `id,name,amount,parent${mode === 'shared-target' ? ',backup' : ''}\n${rows}`,
          },
        ]);
      try {
        const firstZip = await zipFor(
          'a',
          `bfi_LINKAAA,Reagent A,12.5,bfi_LINKBBB${mode === 'shared-target' ? ',bfi_LINKBBB' : ''}\n${mode === 'other-target' ? 'bfi_LINKCCC,Reagent C,1,\n' : ''}`
        );
        await appendBenchlingExportsToWorkspace(workspace.run, [firstZip], appendDeps(workspace));
        const entityId = bindingEntityIds(workspace.globalDb, 'bfi_LINKAAA')[0]!;
        workspace.globalDb.transaction(() =>
          updateLimsEntityInsideTx(workspace.globalDb, {
            id: entityId,
            name: 'User-renamed reagent',
            fields: {
              amount: 99,
              ...(mode === 'null' || mode === 'shared-target' ? { parent: null } : {}),
              ...(mode === 'other-target'
                ? {
                    parent: {
                      sourceTargetId: 'bfi_LINKCCC',
                      destinationEntityId: bindingEntityIds(workspace.globalDb, 'bfi_LINKCCC')[0],
                      relationType: 'parent',
                      label: 'C',
                      resolution: 'exact',
                    },
                  }
                : {}),
            },
            ...(mode === 'tracked' || mode === 'drifted' ? { registrationStatus: mode } : {}),
          })
        )();
        const secondZip = await zipFor(
          'b',
          `bfi_LINKBBB,Reagent B,3,${mode === 'shared-target' ? ',' : ''}\n`
        );
        if (mode === 'interrupted-database' || mode === 'interrupted-manifest') {
          const advance = actionJournal.advancePersistedBenchlingMigrationAllocations;
          let markStopped!: () => void;
          const stopped = new Promise<void>((resolve) => {
            markStopped = resolve;
          });
          let release: () => void = () => undefined;
          const released = new Promise<void>((resolve) => {
            release = resolve;
          });
          const fault = vi
            .spyOn(actionJournal, 'advancePersistedBenchlingMigrationAllocations')
            .mockImplementation(async (args) => {
              const result = await advance(args);
              if (args.nextState === 'catalog_committed') {
                await new Promise((resolve) => setTimeout(resolve, 1_100));
                markStopped();
                await new Promise<never>((_resolve, reject) => {
                  release = () => reject(new Error('Stopped interrupted process'));
                });
              }
              return result;
            });
          const interrupted = appendBenchlingExportsToWorkspace(
            store.getRun()!,
            [secondZip],
            appendDeps(workspace)
          ).catch((error: unknown) => error);
          try {
            await Promise.race([
              stopped,
              interrupted.then((result) => {
                if (result instanceof Error) throw result;
                throw new Error('Append ended before the catalog commit checkpoint.');
              }),
            ]);
            fault.mockRestore();
            if (mode === 'interrupted-database')
              workspace.globalDb.transaction(() =>
                updateLimsEntityInsideTx(workspace.globalDb, {
                  id: entityId,
                  fields: { amount: 123 },
                })
              )();
            else {
              const manifest = parseNativeWorkspaceManifest(
                await readFile(join(workspacePath, '.forge/catalog.json'), 'utf8')
              );
              const record = manifest.entities.find((entry) =>
                entry.sourceIdentities?.some(
                  (identity) => identity.stableObjectId === 'bfi_LINKAAA'
                )
              );
              if (!record?.lims) throw new Error('Test repair source is missing.');
              record.lims.fields.amount = 123;
              await nativeManifestWriter.writeNativeWorkspaceManifestDocument({
                workspacePath,
                manifest,
              });
            }
            const before = await readFile(join(workspacePath, '.forge/catalog.json'), 'utf8');
            const rowBefore = workspace.globalDb
              .prepare('SELECT * FROM lims_entity WHERE id = ?')
              .get(entityId);
            await expect(
              appendBenchlingExportsToWorkspace(store.getRun()!, [], appendDeps(workspace))
            ).rejects.toThrow(/changed after.*commit/i);
            expect(await readFile(join(workspacePath, '.forge/catalog.json'), 'utf8')).toBe(before);
            expect(
              workspace.globalDb.prepare('SELECT * FROM lims_entity WHERE id = ?').get(entityId)
            ).toEqual(rowBefore);
          } finally {
            fault.mockRestore();
            release();
            await interrupted;
          }
          return;
        }
        await appendBenchlingExportsToWorkspace(
          store.getRun()!,
          [secondZip],
          appendDeps(workspace)
        );
        const row = workspace.globalDb
          .prepare('SELECT fields, registration_status FROM lims_entity WHERE id = ?')
          .get(entityId) as { fields: string; registration_status: string };
        const repaired = mode === 'ordinary' || mode === 'shared-target';
        expect(row.registration_status).toBe(
          mode === 'tracked' || mode === 'drifted'
            ? mode
            : mode === 'ordinary' || mode === 'other-target'
              ? 'registered'
              : 'unresolved'
        );
        expect(JSON.parse(row.fields)).toMatchObject({
          amount: 99,
          ...(mode === 'ordinary'
            ? {
                parent: {
                  destinationEntityId: bindingEntityIds(workspace.globalDb, 'bfi_LINKBBB')[0],
                },
              }
            : {}),
          ...(mode === 'null' || mode === 'shared-target' ? { parent: null } : {}),
          ...(mode === 'other-target'
            ? {
                parent: {
                  destinationEntityId: bindingEntityIds(workspace.globalDb, 'bfi_LINKCCC')[0],
                },
              }
            : {}),
          ...(mode === 'shared-target'
            ? {
                backup: {
                  destinationEntityId: bindingEntityIds(workspace.globalDb, 'bfi_LINKBBB')[0],
                },
              }
            : {}),
        });
        const targetId = bindingEntityIds(workspace.globalDb, 'bfi_LINKBBB')[0]!;
        expect(
          workspace.globalDb
            .prepare(
              'SELECT relation FROM catalog_entity_links WHERE source_entity_id = ? AND target_entity_id = ? ORDER BY relation'
            )
            .all(entityId, targetId)
        ).toEqual(repaired ? [{ relation: mode === 'shared-target' ? 'backup' : 'parent' }] : []);
        expect(
          workspace.globalDb
            .prepare(
              'SELECT to_entity_id FROM lims_link WHERE from_entity_id = ? AND to_entity_id = ? AND tombstone = 0'
            )
            .all(entityId, targetId)
        ).toEqual(repaired ? [{ to_entity_id: targetId }] : []);
        const manifest = parseNativeWorkspaceManifest(
          await readFile(join(workspacePath, '.forge/catalog.json'), 'utf8')
        );
        const first = manifest.entities.find((entity) =>
          entity.sourceIdentities?.some((identity) => identity.stableObjectId === 'bfi_LINKAAA')
        );
        const second = manifest.entities.find((entity) =>
          entity.sourceIdentities?.some((identity) => identity.stableObjectId === 'bfi_LINKBBB')
        );
        if (repaired) expect(first?.name).toBe('User-renamed reagent');
        if (repaired)
          expect(first?.lims).toMatchObject({
            name: 'User-renamed reagent',
            registrationStatus: row.registration_status,
            fields: {
              amount: 99,
              [mode === 'shared-target' ? 'backup' : 'parent']: { destinationEntityId: second?.id },
            },
          });
        const beforeRepeat = workspace.globalDb
          .prepare('SELECT * FROM lims_entity WHERE id = ?')
          .get(entityId);
        await appendBenchlingExportsToWorkspace(
          store.getRun()!,
          [secondZip],
          appendDeps(workspace)
        );
        expect(
          workspace.globalDb.prepare('SELECT * FROM lims_entity WHERE id = ?').get(entityId)
        ).toEqual(beforeRepeat);
      } finally {
        workspace.globalDb.close();
      }
    }
  );

  it.each(
    (
      ['before_catalog_checkpoint', 'after_catalog_checkpoint', 'after_manifest_write'] as const
    ).flatMap((boundary) =>
      (['none', 'database', 'manifest'] as const).map((laterEdit) => ({ boundary, laterEdit }))
    )
  )(
    'resumes custom record replacement after $boundary with $laterEdit later edit',
    async ({ boundary, laterEdit }) => {
      const workspace = await prepareEmptyNativeWorkspace();
      const zipFor = (amount: number) =>
        writeNativeZip(`record-crash-${amount}.zip`, [
          {
            path: 'records.schema.json',
            bytes: JSON.stringify({
              schema: 'benchling.registry-schema.v1',
              sourceSchemaId: 'reagent-crash',
              sourceRevisionId: 'r1',
              name: 'reagent',
              displayName: 'Reagent',
              recordPaths: ['records.csv'],
              fields: [
                {
                  sourceFieldId: 'amount',
                  definition: { key: 'amount', label: 'Amount', type: 'number' },
                },
              ],
            }),
          },
          { path: 'records.csv', bytes: `id,name,amount\nbfi_CRASHAA,Reagent A,${amount}\n` },
        ]);
      const decide: ImportDecisionResolver = async () => ({
        kind: 'provider_version_conflict',
        policy: 'use_incoming',
      });
      try {
        await appendBenchlingExportsToWorkspace(
          workspace.run,
          [await zipFor(1)],
          appendDeps(workspace, decide)
        );
        const incoming = await zipFor(2);
        const advance = actionJournal.advancePersistedBenchlingMigrationAllocations;
        const write = nativeManifestWriter.writeNativeWorkspaceManifestDocument;
        let failed = false;
        let releaseOldProcess: () => void = () => undefined;
        const suspend = () =>
          new Promise<never>((_resolve, reject) => {
            releaseOldProcess = () =>
              reject(new Error('Stopped interrupted process after recovery proof'));
            failed = true;
          });
        const fault =
          boundary === 'after_manifest_write'
            ? vi
                .spyOn(nativeManifestWriter, 'writeNativeWorkspaceManifestDocument')
                .mockImplementation(async (args) => {
                  const result = await write(args);
                  if (!failed) {
                    await suspend();
                  }
                  return result;
                })
            : vi
                .spyOn(actionJournal, 'advancePersistedBenchlingMigrationAllocations')
                .mockImplementation(async (args) => {
                  if (args.nextState === 'catalog_committed' && !failed) {
                    if (boundary === 'after_catalog_checkpoint') await advance(args);
                    return suspend();
                  }
                  return advance(args);
                });
        const interrupted = appendBenchlingExportsToWorkspace(
          store.getRun()!,
          [incoming],
          appendDeps(workspace, decide)
        ).catch((error: unknown) => error);
        await vi.waitFor(() => expect(failed).toBe(true), { timeout: 10_000, interval: 50 });
        fault.mockRestore();
        expect(failed).toBe(true);
        const entityId = bindingEntityIds(workspace.globalDb, 'bfi_CRASHAA')[0]!;
        if (laterEdit === 'database') {
          workspace.globalDb.transaction(() =>
            updateLimsEntityInsideTx(workspace.globalDb, {
              id: entityId,
              fields: { amount: 99 },
            })
          )();
        }
        if (laterEdit === 'manifest') {
          const manifest = parseNativeWorkspaceManifest(
            await readFile(join(workspacePath, '.forge/catalog.json'), 'utf8')
          );
          const entity = manifest.entities.find((entry) => entry.type === 'record');
          if (!entity?.lims) throw new Error('Test record has no portable fields.');
          entity.lims.fields.amount = 99;
          await write({ workspacePath, manifest });
        }
        const manifestBeforeResume = await readFile(
          join(workspacePath, '.forge/catalog.json'),
          'utf8'
        );
        const committedRow = workspace.globalDb
          .prepare('SELECT * FROM lims_entity WHERE id = ?')
          .get(entityId);
        const committedAudits = workspace.globalDb
          .prepare('SELECT id, hash FROM lims_audit ORDER BY event_seq')
          .all();
        try {
          const resume = appendBenchlingExportsToWorkspace(
            store.getRun()!,
            [],
            appendDeps(workspace, decide)
          );
          if (laterEdit === 'none') await resume;
          else await expect(resume).rejects.toThrow(/changed after.*commit/i);
        } finally {
          releaseOldProcess();
          await interrupted;
        }
        expect(
          workspace.globalDb.prepare('SELECT * FROM lims_entity WHERE id = ?').get(entityId)
        ).toEqual(committedRow);
        expect(
          workspace.globalDb.prepare('SELECT id, hash FROM lims_audit ORDER BY event_seq').all()
        ).toEqual(committedAudits);
        if (laterEdit !== 'none') {
          expect(await readFile(join(workspacePath, '.forge/catalog.json'), 'utf8')).toBe(
            manifestBeforeResume
          );
          return;
        }
        expect(
          readLimsAuditExportRowsFromWorkspace(workspacePath).map(({ id, hash }) => ({ id, hash }))
        ).toEqual(committedAudits);
        const manifest = parseNativeWorkspaceManifest(
          await readFile(join(workspacePath, '.forge/catalog.json'), 'utf8')
        );
        expect(
          manifest.entities.find((entity) => entity.type === 'record')?.lims?.fields.amount
        ).toBe(2);
        expect(store.listLinkedItemRecoveryAttempts(workspace.run.id).at(-1)?.state).toBe(
          'completed'
        );
      } finally {
        workspace.globalDb.close();
      }
    }
  );

  it.each([
    'none',
    'database-removed',
    'database-added',
    'manifest-removed',
    'manifest-added',
  ] as const)(
    'replaces only import-owned registry graph edges with $0 later edits',
    async (laterEdit) => {
      const workspace = await prepareEmptyNativeWorkspace();
      const zipFor = (target: string) =>
        writeNativeZip(`record-edges-${target}.zip`, [
          {
            path: 'records.schema.json',
            bytes: JSON.stringify({
              schema: 'benchling.registry-schema.v1',
              sourceSchemaId: 'edge-schema',
              sourceRevisionId: 'r1',
              name: 'record',
              displayName: 'Record',
              recordPaths: ['records.csv'],
              fields: [
                {
                  sourceFieldId: 'parent',
                  definition: { key: 'parent', label: 'Parent', type: 'record_relationship' },
                },
              ],
            }),
          },
          {
            path: 'records.csv',
            bytes: `id,name,parent\nbfi_EDGEAAA,A,${target}\nbfi_EDGEBBB,B,\nbfi_EDGECCC,C,\n`,
          },
        ]);
      try {
        const decide: ImportDecisionResolver = async () => ({
          kind: 'provider_version_conflict',
          policy: 'use_incoming',
        });
        await appendBenchlingExportsToWorkspace(
          workspace.run,
          [await zipFor('bfi_EDGEBBB')],
          appendDeps(workspace, decide)
        );
        const sourceId = bindingEntityIds(workspace.globalDb, 'bfi_EDGEAAA')[0]!;
        const previousTarget = bindingEntityIds(workspace.globalDb, 'bfi_EDGEBBB')[0]!;
        const nextTarget = bindingEntityIds(workspace.globalDb, 'bfi_EDGECCC')[0]!;
        workspace.globalDb
          .prepare(
            `INSERT INTO catalog_entity_links (id,source_entity_id,relation,target_entity_id,confidence,evidence,created_at,updated_at) VALUES ('user-edge',?,'user_note',?,'confirmed','{"source":"user"}',1,1)`
          )
          .run(sourceId, previousTarget);
        if (laterEdit !== 'none') {
          const advance = actionJournal.advancePersistedBenchlingMigrationAllocations;
          let markStopped!: () => void;
          const stopped = new Promise<void>((resolve) => {
            markStopped = resolve;
          });
          let release: () => void = () => undefined;
          const fault = vi
            .spyOn(actionJournal, 'advancePersistedBenchlingMigrationAllocations')
            .mockImplementation(async (args) => {
              const result = await advance(args);
              if (args.nextState === 'catalog_committed') {
                markStopped();
                await new Promise<never>((_resolve, reject) => {
                  release = () => reject(new Error('Stopped interrupted process'));
                });
              }
              return result;
            });
          const interrupted = appendBenchlingExportsToWorkspace(
            store.getRun()!,
            [await zipFor('bfi_EDGECCC')],
            appendDeps(workspace, decide)
          ).catch((error: unknown) => error);
          try {
            await Promise.race([
              stopped,
              interrupted.then((result) => {
                if (result instanceof Error) throw result;
                throw new Error('Append ended before the catalog commit checkpoint.');
              }),
            ]);
            fault.mockRestore();
            if (laterEdit === 'database-removed')
              workspace.globalDb
                .prepare(
                  'UPDATE lims_link SET tombstone = 0, payload = \'{"source":"later-user-restore"}\' WHERE from_entity_id = ? AND to_entity_id = ?'
                )
                .run(sourceId, previousTarget);
            if (laterEdit === 'database-added')
              workspace.globalDb
                .prepare(
                  'UPDATE catalog_entity_links SET evidence = \'{"source":"later-user-edit"}\' WHERE source_entity_id = ? AND target_entity_id = ?'
                )
                .run(sourceId, nextTarget);
            if (laterEdit.startsWith('manifest-')) {
              const manifest = parseNativeWorkspaceManifest(
                await readFile(join(workspacePath, '.forge/catalog.json'), 'utf8')
              );
              const previous = manifest.links.find((link) => link.relation === 'parent');
              if (!previous) throw new Error('Test relationship is missing.');
              if (laterEdit === 'manifest-removed')
                previous.evidence = { source: 'later-user-restore' };
              else
                manifest.links.push({
                  ...previous,
                  targetId: nextTarget.slice(nextTarget.indexOf('::') + 2),
                  evidence: { source: 'later-user-edit' },
                });
              await nativeManifestWriter.writeNativeWorkspaceManifestDocument({
                workspacePath,
                manifest,
              });
            }
            const before = await readFile(join(workspacePath, '.forge/catalog.json'), 'utf8');
            const graphBefore = {
              catalog: workspace.globalDb
                .prepare('SELECT * FROM catalog_entity_links ORDER BY id')
                .all(),
              lims: workspace.globalDb.prepare('SELECT * FROM lims_link ORDER BY id').all(),
            };
            await expect(
              appendBenchlingExportsToWorkspace(store.getRun()!, [], appendDeps(workspace, decide))
            ).rejects.toThrow(/changed after.*commit/i);
            expect(await readFile(join(workspacePath, '.forge/catalog.json'), 'utf8')).toBe(before);
            expect({
              catalog: workspace.globalDb
                .prepare('SELECT * FROM catalog_entity_links ORDER BY id')
                .all(),
              lims: workspace.globalDb.prepare('SELECT * FROM lims_link ORDER BY id').all(),
            }).toEqual(graphBefore);
          } finally {
            fault.mockRestore();
            release();
            await interrupted;
          }
          return;
        }
        await appendBenchlingExportsToWorkspace(
          store.getRun()!,
          [await zipFor('bfi_EDGECCC')],
          appendDeps(workspace, decide)
        );
        expect(
          workspace.globalDb
            .prepare(
              'SELECT relation, target_entity_id FROM catalog_entity_links WHERE source_entity_id = ? ORDER BY relation'
            )
            .all(sourceId)
        ).toEqual([
          { relation: 'parent', target_entity_id: nextTarget },
          { relation: 'user_note', target_entity_id: previousTarget },
        ]);
        expect(
          workspace.globalDb
            .prepare(
              'SELECT to_entity_id FROM lims_link WHERE from_entity_id = ? AND tombstone = 0'
            )
            .all(sourceId)
        ).toEqual([{ to_entity_id: nextTarget }]);
        const manifest = parseNativeWorkspaceManifest(
          await readFile(join(workspacePath, '.forge/catalog.json'), 'utf8')
        );
        const source = manifest.entities.find((entity) =>
          entity.sourceIdentities?.some((identity) => identity.stableObjectId === 'bfi_EDGEAAA')
        )!;
        const target = manifest.entities.find((entity) =>
          entity.sourceIdentities?.some((identity) => identity.stableObjectId === 'bfi_EDGECCC')
        )!;
        expect(manifest.links.filter((link) => link.sourceId === source.id)).toEqual([
          expect.objectContaining({ targetId: target.id, relation: 'parent' }),
        ]);
        expect(manifest.limsLinks?.filter((link) => link.fromEntityId === source.id)).toEqual([
          expect.objectContaining({ toEntityId: target.id }),
        ]);
      } finally {
        workspace.globalDb.close();
      }
    }
  );

  it('resumes a retained provider receipt saved before its action allocation', async () => {
    const workspace = await prepareEmptyNativeWorkspace();
    seedNativeSequence(workspace.globalDb, {
      entityId: 'ws1::receipt-restart',
      name: 'Retained local name',
      bases: 'AACCGG',
    });
    upsertProviderBinding(workspace.globalDb, {
      reference: {
        provider: 'benchling',
        stableObjectId: 'seq_RECEIPTRESTART',
        objectClass: 'sequence',
        canonicalUrl: null,
        providerAccountHint: null,
      },
      entityId: 'ws1::receipt-restart',
      bindingKind: 'reviewed',
      evidence: { source: 'manual' },
    });
    const zip = await writeNativeZip('receipt-restart.zip', [
      {
        path: 'Incoming (seq_RECEIPTRESTART).gb',
        bytes: dnaGenBank('seq_RECEIPTRESTART', 'AACCGG'),
      },
    ]);
    let releaseOldProcess: (error: Error) => void = () => undefined;
    const fault = vi.spyOn(actionJournal, 'reserveBenchlingMigrationAction').mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          releaseOldProcess = reject;
        })
    );
    const oldProcess = appendBenchlingExportsToWorkspace(
      workspace.run,
      [zip],
      appendDeps(workspace)
    ).catch((error: unknown) => error);
    await vi.waitFor(() => expect(fault).toHaveBeenCalledOnce());
    expect(store.listProjectionReceipts(workspace.run.id)).toHaveLength(1);
    fault.mockRestore();
    try {
      await appendBenchlingExportsToWorkspace(workspace.run, [], appendDeps(workspace));
    } finally {
      releaseOldProcess(new Error('Stopped original process after restart proof.'));
      await oldProcess;
    }
    expect(bindingEntityIds(workspace.globalDb, 'seq_RECEIPTRESTART')).toEqual([
      'ws1::receipt-restart',
    ]);
    expect(store.getValidationReport(workspace.run.id)).toMatchObject({
      nativeImport: { destinationChanges: { added: 0, updated: 0, retained: 1 } },
    });
    const manifest = parseNativeWorkspaceManifest(
      await readFile(join(workspacePath, '.forge/catalog.json'), 'utf8')
    );
    expect(manifest.entities.find((entity) => entity.id === 'receipt-restart')).toMatchObject({
      name: 'Retained local name',
      lims: { fields: { sequence: { bases: 'AACCGG' } } },
    });
    workspace.globalDb.close();
  });

  it('applies one durable incoming-version choice to native direct files', async () => {
    const workspace = await prepareEmptyNativeWorkspace();
    const first = await writeNativeZip('native-versions-before.zip', [
      { path: 'DNA/First (seq_VERSION1).gb', bytes: dnaGenBank('seq_VERSION1', 'AACCGG') },
      { path: 'DNA/Second (seq_VERSION2).gb', bytes: dnaGenBank('seq_VERSION2', 'TTTTAAAA') },
    ]);
    await appendBenchlingExportsToWorkspace(workspace.run, [first], appendDeps(workspace));
    const before = store.listProjectionReceipts(workspace.run.id);
    const second = await writeNativeZip('native-versions-after.zip', [
      { path: 'DNA/First (seq_VERSION1).gb', bytes: dnaGenBank('seq_VERSION1', 'CCGGTT') },
      { path: 'DNA/Second (seq_VERSION2).gb', bytes: dnaGenBank('seq_VERSION2', 'AAAACCCC') },
      { path: 'DNA/Third (seq_VERSION3).gb', bytes: dnaGenBank('seq_VERSION3', 'GATTACA') },
    ]);
    const resolveImportDecision = vi.fn<ImportDecisionResolver>(async ({ pending }) => {
      expect(pending.kind).toBe('provider_version_conflict');
      return { kind: 'provider_version_conflict', policy: 'use_incoming' };
    });
    await appendBenchlingExportsToWorkspace(
      workspace.run,
      [second],
      appendDeps(workspace, resolveImportDecision)
    );
    expect(resolveImportDecision).toHaveBeenCalledOnce();
    const after = store.listProjectionReceipts(workspace.run.id);
    expect(store.getValidationReport(workspace.run.id)).toMatchObject({
      nativeImport: {
        history: 'existing_history',
        destinationChanges: { added: 1, updated: 2, retained: 0 },
        providerVersions: { policy: 'use_incoming', affectedCount: 2 },
      },
    });
    for (const receipt of before) {
      expect(after.find((entry) => entry.sourceObjectId === receipt.sourceObjectId)).toMatchObject({
        destinationObjectId: receipt.destinationObjectId,
        destination: receipt.destination,
      });
    }
    expect(countEntities(workspace.globalDb, 'sequence')).toBe(3);
    expect(
      store.listLinkedItemRecoveryAttempts(workspace.run.id).at(-1)?.versionConflictResolution
    ).toMatchObject({
      kind: 'resolved',
      policy: 'use_incoming',
      conflicts: [{ stableId: 'seq_VERSION1' }, { stableId: 'seq_VERSION2' }],
    });
    workspace.globalDb.close();
  });

  it('imports a separate native copy without binding the exact existing item', async () => {
    const workspace = await prepareEmptyNativeWorkspace();
    seedNativeSequence(workspace.globalDb, {
      entityId: 'ws1::original-native',
      name: 'Original',
      bases: 'AACCGG',
    });
    const zip = await writeNativeZip('separate-copy.zip', [
      { path: 'DNA/Separate (seq_SEPARATE1).gb', bytes: dnaGenBank('seq_SEPARATE1', 'AACCGG') },
      { path: 'DNA/Other (seq_SEPARATE2).gb', bytes: dnaGenBank('seq_SEPARATE2', 'GATTACA') },
    ]);
    const resolveImportDecision = vi.fn<ImportDecisionResolver>(async ({ pending }) => {
      if (pending.kind !== 'unbound_exact_match') throw new Error('Expected an exact match.');
      return {
        kind: pending.kind,
        sourceObjectId: pending.sourceObjectId,
        candidateEntityId: pending.candidateEntityId,
        expectedCandidateScientificSha256: pending.expectedCandidateScientificSha256,
        expectedBindingState: 'unbound',
        policy: 'import_separate',
      };
    });
    await appendBenchlingExportsToWorkspace(
      workspace.run,
      [zip],
      appendDeps(workspace, resolveImportDecision)
    );
    expect(resolveImportDecision).toHaveBeenCalledOnce();
    expect(countEntities(workspace.globalDb, 'sequence')).toBe(3);
    expect(bindingEntityIds(workspace.globalDb, 'seq_SEPARATE1')).not.toContain(
      'ws1::original-native'
    );
    expect(bindingEntityIds(workspace.globalDb, 'seq_SEPARATE1')).toHaveLength(1);
    const receipt = store
      .listProjectionReceipts(workspace.run.id)
      .find((entry) => entry.sourceObjectId.includes('seq_SEPARATE1'));
    expect(receipt?.destination).toEqual({ kind: 'file', relativePath: 'DNA/Separate.gb' });
    workspace.globalDb.close();
  });

  it.each([false, true])(
    'replaces a linked database sequence using the reviewed prior scientific hash (concurrent edit: %s)',
    async (concurrentEdit) => {
      const workspace = await prepareEmptyNativeWorkspace();
      seedNativeSequence(workspace.globalDb, {
        entityId: 'ws1::database-sequence',
        name: 'Local DNA',
        bases: 'AACCGG',
      });
      const first = await writeNativeZip('database-before.zip', [
        { path: 'DNA/Incoming (seq_DATABASE1).gb', bytes: dnaGenBank('seq_DATABASE1', 'AACCGG') },
      ]);
      const linkChoice: NonNullable<
        LinkedItemRecoveryExecutorDeps['resolveImportDecision']
      > = async ({ pending }) => {
        if (pending.kind !== 'unbound_exact_match') throw new Error('Expected an exact match.');
        return {
          kind: pending.kind,
          sourceObjectId: pending.sourceObjectId,
          candidateEntityId: pending.candidateEntityId,
          expectedCandidateScientificSha256: pending.expectedCandidateScientificSha256,
          expectedBindingState: 'unbound',
          policy: 'link_existing',
        };
      };
      await appendBenchlingExportsToWorkspace(
        workspace.run,
        [first],
        appendDeps(workspace, linkChoice)
      );
      const second = await writeNativeZip('database-after.zip', [
        { path: 'DNA/Incoming (seq_DATABASE1).gb', bytes: dnaGenBank('seq_DATABASE1', 'CCGGTT') },
        { path: 'DNA/Other (seq_DATABASE2).gb', bytes: dnaGenBank('seq_DATABASE2', 'GATTACA') },
      ]);
      const incomingChoice = vi.fn<ImportDecisionResolver>(async ({ pending }) => {
        expect(pending.kind).toBe('provider_version_conflict');
        if (concurrentEdit)
          workspace.globalDb.prepare('UPDATE lims_entity SET fields = ? WHERE id = ?').run(
            JSON.stringify({
              sequence: { mode: 'inline', bases: 'GGGGAAAA', topology: 'linear', length: 8 },
            }),
            'ws1::database-sequence'
          );
        return { kind: 'provider_version_conflict', policy: 'use_incoming' };
      });
      const append = appendBenchlingExportsToWorkspace(
        workspace.run,
        [second],
        appendDeps(workspace, incomingChoice)
      );
      if (concurrentEdit)
        await expect(append).rejects.toThrow('Migration catalog transaction did not complete');
      else await append;
      expect(incomingChoice).toHaveBeenCalledOnce();
      const row = workspace.globalDb
        .prepare('SELECT fields FROM lims_entity WHERE id = ?')
        .get('ws1::database-sequence') as { fields: string };
      expect(JSON.parse(row.fields).sequence).toMatchObject({
        mode: 'inline',
        bases: concurrentEdit ? 'GGGGAAAA' : 'CCGGTT',
      });
      expect(bindingEntityIds(workspace.globalDb, 'seq_DATABASE1')).toEqual([
        'ws1::database-sequence',
      ]);
      expect(
        workspace.globalDb
          .prepare(
            "SELECT binding_kind FROM catalog_provider_bindings WHERE entity_id = 'ws1::database-sequence'"
          )
          .get()
      ).toEqual({ binding_kind: 'reviewed' });
      expect(countEntities(workspace.globalDb, 'sequence')).toBe(concurrentEdit ? 1 : 2);
      workspace.globalDb.close();
    }
  );

  it.each(['rename_incoming', 'replace_existing', 'cancel_import'] as const)(
    'applies the structural %s decision before visible installation',
    async (policy) => {
      const workspace = await prepareEmptyNativeWorkspace();
      await writeFile(join(workspacePath, 'DNA'), 'User file blocks the imported directory.');
      await writeFile(join(workspacePath, 'unrelated.txt'), 'Keep this exact text.');
      const zip = await writeNativeZip('structural-decision.zip', [
        { path: 'DNA/Incoming (seq_STRUCTURE1).gb', bytes: dnaGenBank('seq_STRUCTURE1', 'AACCGG') },
        { path: 'DNA/Sibling (seq_STRUCTURE3).gb', bytes: dnaGenBank('seq_STRUCTURE3', 'CCGGTT') },
        { path: 'Other (seq_STRUCTURE2).gb', bytes: dnaGenBank('seq_STRUCTURE2', 'GATTACA') },
      ]);
      const resolveImportDecision = vi.fn<ImportDecisionResolver>(async ({ pending }) => {
        if (pending.kind !== 'structural_path_conflict')
          throw new Error(`Unexpected decision ${pending.kind}.`);
        expect(pending.relativePath).toBe('DNA');
        return {
          kind: pending.kind,
          relativePath: pending.relativePath,
          expectedExistingState: pending.expectedExistingState,
          policy,
        };
      });
      const append = appendBenchlingExportsToWorkspace(
        workspace.run,
        [zip],
        appendDeps(workspace, resolveImportDecision)
      );
      if (policy === 'cancel_import') {
        await expect(append).rejects.toThrow('cancelled before it changed the workspace');
        expect(
          (await readdir(workspacePath)).filter((entry) => !entry.startsWith('.')).sort()
        ).toEqual(['DNA', 'unrelated.txt']);
        expect(countEntities(workspace.globalDb, 'sequence')).toBe(0);
      } else {
        await append;
        expect(countEntities(workspace.globalDb, 'sequence')).toBe(3);
        expect(bindingEntityIds(workspace.globalDb, 'seq_STRUCTURE2')).toHaveLength(1);
      }
      if (policy !== 'replace_existing')
        expect(await readFile(join(workspacePath, 'DNA'), 'utf8')).toBe(
          'User file blocks the imported directory.'
        );
      expect(await readFile(join(workspacePath, 'unrelated.txt'), 'utf8')).toBe(
        'Keep this exact text.'
      );
      expect(resolveImportDecision).toHaveBeenCalledOnce();
      workspace.globalDb.close();
    }
  );

  it('restores a displaced parent when later validation fails', async () => {
    const workspace = await prepareEmptyNativeWorkspace();
    await writeFile(join(workspacePath, 'DNA'), 'Original parent file.');
    const zip = await writeNativeZip('rollback-parent.zip', [
      { path: 'DNA/One (seq_ROLLBACK1).gb', bytes: dnaGenBank('seq_ROLLBACK1', 'AACCGG') },
      { path: 'DNA/Two (seq_ROLLBACK2).gb', bytes: dnaGenBank('seq_ROLLBACK2', 'CCGGTT') },
    ]);
    const decision: NonNullable<LinkedItemRecoveryExecutorDeps['resolveImportDecision']> = async ({
      pending,
    }) => {
      if (pending.kind !== 'structural_path_conflict')
        throw new Error('Expected a structural conflict.');
      return {
        kind: pending.kind,
        relativePath: pending.relativePath,
        expectedExistingState: pending.expectedExistingState,
        policy: 'replace_existing',
      };
    };
    await expect(
      appendBenchlingExportsToWorkspace(workspace.run, [zip], {
        ...appendDeps(workspace, decision),
        renderValidator: async () => {
          throw new Error('Injected validation interruption.');
        },
      })
    ).rejects.toThrow('Injected validation interruption');
    expect(await readFile(join(workspacePath, 'DNA'), 'utf8')).toBe('Original parent file.');
    expect(countEntities(workspace.globalDb, 'sequence')).toBe(0);
    workspace.globalDb.close();
  });

  it('treats an unrelated same-name file as a name collision without a version prompt', async () => {
    const workspace = await prepareEmptyNativeWorkspace();
    await mkdir(join(workspacePath, 'DNA'));
    await writeFile(join(workspacePath, 'DNA/Same.gb'), 'Unrelated user file.');
    const zip = await writeNativeZip('same-name.zip', [
      { path: 'DNA/Same (seq_SAMENAME1).gb', bytes: dnaGenBank('seq_SAMENAME1', 'AACCGG') },
    ]);
    const choice = vi.fn(async () => {
      throw new Error('Name collisions must not ask about science.');
    });
    await appendBenchlingExportsToWorkspace(workspace.run, [zip], appendDeps(workspace, choice));
    expect(choice).not.toHaveBeenCalled();
    expect(await readFile(join(workspacePath, 'DNA/Same.gb'), 'utf8')).toBe('Unrelated user file.');
    expect(store.listProjectionReceipts(workspace.run.id)[0]?.destination).toEqual({
      kind: 'file',
      relativePath: 'DNA/Same--seq_SAMENAME1.gb',
    });
    workspace.globalDb.close();
  });

  it('fails closed before writing when multiple native entities match the incoming science', async () => {
    const workspace = await prepareEmptyNativeWorkspace();
    seedNativeSequence(workspace.globalDb, {
      entityId: 'ws1::match-one',
      name: 'One',
      bases: 'AACCGG',
    });
    seedNativeSequence(workspace.globalDb, {
      entityId: 'ws1::match-two',
      name: 'Two',
      bases: 'AACCGG',
    });
    const zip = await writeNativeZip('ambiguous-match.zip', [
      { path: 'DNA/Incoming (seq_AMBIGUOUS1).gb', bytes: dnaGenBank('seq_AMBIGUOUS1', 'AACCGG') },
    ]);
    await expect(
      appendBenchlingExportsToWorkspace(workspace.run, [zip], appendDeps(workspace))
    ).rejects.toThrow('More than one unlinked workspace item');
    expect(bindingEntityIds(workspace.globalDb, 'seq_AMBIGUOUS1')).toEqual([]);
    expect((await readdir(workspacePath)).filter((entry) => !entry.startsWith('.'))).toEqual([]);
    workspace.globalDb.close();
  });

  it('resumes an exact-match prompt from durable evidence without choosing a second destination', async () => {
    const workspace = await prepareEmptyNativeWorkspace();
    seedNativeSequence(workspace.globalDb, {
      entityId: 'ws1::restart-native',
      name: 'Before restart',
      bases: 'AACCGG',
    });
    const zip = await writeNativeZip('restart-exact.zip', [
      { path: 'Incoming (seq_RESTART1).gb', bytes: dnaGenBank('seq_RESTART1', 'AACCGG') },
    ]);
    let releaseOldProcess: (error: Error) => void = () => undefined;
    const oldChoice = vi.fn(
      () =>
        new Promise<ImportDecision>((_resolve, reject) => {
          releaseOldProcess = reject;
        })
    );
    const oldProcess = appendBenchlingExportsToWorkspace(
      workspace.run,
      [zip],
      appendDeps(workspace, oldChoice)
    );
    const oldResult = oldProcess.catch((error: unknown) => error);
    await vi.waitFor(() => expect(oldChoice).toHaveBeenCalledOnce());
    const checkpoint = store.getActiveLinkedItemRecoveryAttempt(workspace.run.id);
    expect(checkpoint).toMatchObject({
      state: 'awaiting_conflict_resolution',
      pendingImportDecision: {
        kind: 'unbound_exact_match',
        candidateEntityId: 'ws1::restart-native',
      },
    });
    expect(bindingEntityIds(workspace.globalDb, 'seq_RESTART1')).toEqual([]);
    const resumedChoice = vi.fn<ImportDecisionResolver>(async ({ pending }) => {
      if (pending.kind !== 'unbound_exact_match')
        throw new Error('Expected the durable native-match prompt.');
      return {
        kind: pending.kind,
        sourceObjectId: pending.sourceObjectId,
        candidateEntityId: pending.candidateEntityId,
        expectedCandidateScientificSha256: pending.expectedCandidateScientificSha256,
        expectedBindingState: 'unbound',
        policy: 'link_existing',
      };
    });
    try {
      await appendBenchlingExportsToWorkspace(
        workspace.run,
        [],
        appendDeps(workspace, resumedChoice)
      );
      expect(resumedChoice).toHaveBeenCalledOnce();
      expect(bindingEntityIds(workspace.globalDb, 'seq_RESTART1')).toEqual(['ws1::restart-native']);
      expect(countEntities(workspace.globalDb, 'sequence')).toBe(1);
      expect(store.listLinkedItemRecoveryAttempts(workspace.run.id)).toHaveLength(1);
      expect(store.listImportDecisions(workspace.run.id, checkpoint!.id)).toHaveLength(1);
    } finally {
      releaseOldProcess(new Error('Stopped original process after restart proof.'));
      await oldResult;
      workspace.globalDb.close();
    }
  });

  type UnlockedWorkspace = {
    run: MigrationRun;
    globalDb: ReturnType<typeof createTestDb>;
    trackedFiles: string[];
  };

  async function prepareUnlockedWorkspace(
    entries: Parameters<typeof buildSyntheticNativeExportZip>[0]
  ): Promise<UnlockedWorkspace> {
    const sourcePath = await writeNativeZip('original-export.zip', entries);
    const artifact = await intakeLocalBenchlingExportBundle({ workspacePath, sourcePath });
    if (artifact.format !== 'zip') throw new Error('Expected a ZIP artifact.');
    const run: MigrationRun = {
      version: 1,
      id: 'run-workspace-append',
      workspaceId: 'workspace-workspace-append',
      workspacePath,
      displayName: 'Additive Benchling append',
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
    let result: Awaited<ReturnType<typeof executeLocalBundleMigration>>;
    try {
      result = await executeLocalBundleMigration(run, {
        store,
        archive,
        now: nextNow,
        renderValidator: passingRenderValidator,
        persistPassedReport: async () => undefined,
      } satisfies LocalBundleExecutorDeps);
    } catch (error) {
      throw new Error(
        `${String(error)}\n${JSON.stringify(store.getValidationReport(run.id)?.issues, null, 2)}`
      );
    }
    if (result.run.state !== 'ready_to_unlock') {
      throw new Error(`Original import did not reach ready_to_unlock: ${result.run.state}`);
    }
    if (!isValidationReportV2(result.report)) {
      throw new Error('Expected a v2 local ZIP validation report.');
    }

    const globalDb = createTestDb();
    ensureSchema(globalDb, ':memory:');
    await unlockMigrationWorkspace({
      workspacePath,
      globalDb,
      now: nextNow,
      openStore: () => nonClosingStore(store),
      finalizationDeps: testFinalizationDeps(globalDb),
    });
    const unlocked = store.getRun();
    if (unlocked?.state !== 'unlocked') {
      throw new Error(`Workspace did not unlock: ${unlocked?.state}`);
    }
    return { run: unlocked, globalDb, trackedFiles: await snapshotBenchlingImportFiles() };
  }

  async function prepareEmptyNativeWorkspace(): Promise<UnlockedWorkspace> {
    await mkdir(workspacePath, { recursive: true });
    const run = await adoptWorkspaceHistory({
      binding: {
        workspaceDbId: 1,
        repoUuid: null,
        projectionScopeId: 'ws1',
        workspacePath,
        displayName: 'Native destination',
        durability: { kind: 'local_filesystem' },
      },
      now: nextNow,
      openStore: () => nonClosingStore(store),
    });
    expect(store.getSourceSnapshot(run.id)).toBeNull();
    const globalDb = createTestDb();
    ensureSchema(globalDb, ':memory:');
    globalDb
      .prepare(
        `INSERT INTO workspaces
         (id, name, path, repo_uuid, created_at, last_opened_at)
       VALUES (1, 'Native destination', ?, NULL, 0, 0)`
      )
      .run(workspacePath);
    seedLimsBuiltinsInDb(globalDb);
    return { run, globalDb, trackedFiles: [] };
  }

  function appendDeps(
    workspace: UnlockedWorkspace,
    resolveImportDecision?: LinkedItemRecoveryExecutorDeps['resolveImportDecision']
  ): LinkedItemRecoveryExecutorDeps {
    return {
      store,
      archive,
      now: nextNow,
      renderValidator: passingRenderValidator,
      persistPassedReport: async () => undefined,
      listFilesAtHead: async () =>
        workspace.run.workspaceOrigin ? workspace.trackedFiles : snapshotBenchlingImportFiles(),
      destinationDb: workspace.globalDb,
      assertMutationLeaseHeld: () => undefined,
      finalizeUnlockedRecovery: (run, report, sourceObjects, receipts, resolutions, actionId) =>
        finalizeUnlockedMigrationRecovery({
          run,
          report,
          store,
          globalDb: workspace.globalDb,
          now: nextNow,
          finalizationDeps: testFinalizationDeps(workspace.globalDb),
          sourceObjects,
          projectionReceipts: receipts,
          relationshipResolutions: resolutions,
          actionId,
        }),
      ...(resolveImportDecision ? { resolveImportDecision } : {}),
    };
  }

  function sourceFingerprints(runId: string): Map<string, string> {
    return new Map(
      store
        .listSourceObjects(runId)
        .map((sourceObject) => [sourceObject.stableId, scientificSourceObjectSha256(sourceObject)])
    );
  }

  function referenceCounts(runId: string): Record<string, number> {
    const report = store.getValidationReport(runId);
    if (!report || !isValidationReportV2(report) || !report.providerReferences) {
      throw new Error('The run has no v2 report carrying reference outcomes.');
    }
    return report.providerReferences.counts;
  }

  function countEntities(db: ReturnType<typeof createTestDb>, type: string): number {
    return (
      db.prepare('SELECT COUNT(*) AS count FROM catalog_entities WHERE type = ?').get(type) as {
        count: number;
      }
    ).count;
  }

  function bindingEntityIds(db: ReturnType<typeof createTestDb>, stableObjectId: string): string[] {
    return (
      db
        .prepare(
          'SELECT entity_id FROM catalog_provider_bindings WHERE stable_object_id = ? ORDER BY entity_id'
        )
        .all(stableObjectId) as Array<{ entity_id: string }>
    ).map((row) => row.entity_id);
  }

  function entityFingerprint(db: ReturnType<typeof createTestDb>): unknown {
    return db.prepare('SELECT id, type, name FROM catalog_entities ORDER BY id').all();
  }

  function bindingFingerprint(db: ReturnType<typeof createTestDb>): unknown {
    return db
      .prepare(
        `SELECT id, provider, stable_object_id, object_class, entity_id, binding_kind
         FROM catalog_provider_bindings ORDER BY id`
      )
      .all();
  }

  function linkFingerprint(db: ReturnType<typeof createTestDb>): unknown {
    return db
      .prepare(
        'SELECT source_entity_id, relation, target_entity_id FROM catalog_entity_links ORDER BY source_entity_id, relation, target_entity_id'
      )
      .all();
  }

  function relationshipFingerprint(runId: string): unknown {
    return store
      .listSourceObjects(runId)
      .filter((sourceObject) => sourceObject.id === NOTEBOOK_ID)
      .flatMap((sourceObject) =>
        sourceObject.relationships.map((relationship) => ({
          id: relationship.id,
          targetSourceId: relationship.targetSourceId,
          relationType: relationship.relationType,
        }))
      )
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  function resolutionFingerprint(runId: string): unknown {
    return store
      .listRelationshipResolutions(runId)
      .map((resolution) => ({
        relationshipId: resolution.relationshipId,
        targetSourceId: resolution.targetSourceId,
        classification: resolution.classification,
      }))
      .sort((left, right) => left.relationshipId.localeCompare(right.relationshipId));
  }

  async function readNotebookPackage(workspace: UnlockedWorkspace): Promise<Buffer> {
    const destinations = await readUnlockedNativeDestinations(
      workspacePath,
      async () => workspace.trackedFiles
    );
    const notebook = destinations.find((destination) => destination.path.endsWith('.json'));
    if (!notebook) throw new Error('No notebook destination found in the unlocked workspace.');
    return readFile(join(workspacePath, notebook.path));
  }

  async function readManifest(): Promise<unknown> {
    return JSON.parse(await readFile(join(workspacePath, '.forge/catalog.json'), 'utf8'));
  }

  function testFinalizationDeps(globalDb: ReturnType<typeof createTestDb>) {
    return {
      resolveHeadCommit: async () => 'a'.repeat(40),
      commitAllIfDirty: async () => 'b'.repeat(40),
      openTransactionDb: () => ({ db: globalDb, close: () => undefined }),
    };
  }

  function seedNativeSequence(
    globalDb: ReturnType<typeof createTestDb>,
    input: Readonly<{ entityId: string; name: string; bases: string }>
  ): void {
    const scientificSha256 = dnaBasesScientificFingerprint(input.bases);
    if (!scientificSha256) throw new Error('Synthetic DNA did not produce a fingerprint.');
    globalDb
      .prepare(
        `INSERT INTO catalog_entities
         (id, type, name, locator, storage_type, status, workspace_id, metadata,
          created_at, updated_at)
       VALUES (?, 'sequence', ?, ?, 'database', 'active', 1, NULL, 0, 0)`
      )
      .run(input.entityId, input.name, `entity://lims/${input.entityId}`);
    globalDb
      .prepare(
        `INSERT INTO catalog_workspace_placements
         (entity_id, workspace_id, parent_relative_path, display_name,
          normalized_sibling_name, presentation_kind, status, created_at, updated_at)
       VALUES (?, 1, 'Registry', ?, ?, 'sequence', 'active', 0, 0)`
      )
      .run(input.entityId, input.name, input.name.toLowerCase());
    globalDb
      .prepare(
        `INSERT INTO lims_entity
         (id, kind, schema_id, schema_revision_id, name, fields, registration_status,
          workspace_id, tombstone, created_at, updated_at)
       SELECT ?, 'dna_sequence', id, current_revision_id, ?, ?, 'tracked', 1, 0, 0, 0
         FROM lims_schema WHERE kind = 'entity' AND name = 'dna_sequence'`
      )
      .run(
        input.entityId,
        input.name,
        JSON.stringify({
          sequence: {
            mode: 'inline',
            bases: input.bases,
            topology: 'linear',
            length: input.bases.length,
          },
        })
      );
  }

  function failingCaptureStore(target: MigrationStore): MigrationStore {
    let failed = false;
    return new Proxy(target, {
      get(storeTarget, property, receiver) {
        if (property === 'commitLinkedItemRecoveryCapture' && !failed) {
          failed = true;
          return () => {
            throw new Error('simulated interruption before materialization');
          };
        }
        const value = Reflect.get(storeTarget, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(storeTarget) : value;
      },
    });
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
    const path = join(root, 'selected-exports', filename);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.from(fixture.bytes));
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

  async function readAllBenchlingImportBytes(): Promise<Record<string, string>> {
    const entries: Record<string, string> = {};
    for (const relativePath of await snapshotBenchlingImportFiles()) {
      entries[relativePath] = (await readFile(join(workspacePath, relativePath))).toString(
        'base64'
      );
    }
    return entries;
  }

  async function readNativeObjectBytes(): Promise<Record<string, string>> {
    return Object.fromEntries(
      Object.entries(await readAllBenchlingImportBytes()).filter(
        ([path]) =>
          !path.startsWith('Benchling Imports/Collections/') &&
          !path.startsWith('Benchling Imports/Folders/')
      )
    );
  }
});

function notebookHtml(): string {
  const card = (url: string, name: string) => `<div
    class="note-entry"
    data-test-component="NoteDropTarget"
    data-test-element="noteLinkedFilePreview"
  ><a href="${url}"><div class="note-itemName" data-test-element="previewItemName">${name}</div></a></div>`;
  return `<!doctype html><html><body><h1>Appended Notebook</h1>
    ${card(TARGET_A_URL, 'Appended DNA A')}
    ${card(TARGET_B_URL, 'Appended DNA B')}
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

function zeroBaseGenBank(sourceId: string): string {
  return [
    `LOCUS       ${sourceId}       0 bp    DNA     linear`,
    `DEFINITION  ${sourceId}.`,
    'COMMENT     Sequence will arrive in a later export.',
    'ORIGIN',
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
