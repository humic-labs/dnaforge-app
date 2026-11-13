import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { PairwiseSessionAlignmentResult } from '@waypoint/api-client';
import { EventEmitter } from 'node:events';
import { ipcMain } from 'electron';
import { getLimsRegistryPreviewInDb, queryLimsEntitiesInDb, registerLimsIpcHandlers } from './lims';
import { createTestDb, openFileTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { registerLimsEntityInsideTx, seedLimsBuiltinsInDb } from './lims-engine-core';
import {
  enrollOrgRegistryRecordInTx,
  orgRegistrySequencePackagePublicationDigest,
  readReadyOrgRegistryRecordMutations,
  readOrgRegistryRecordReview,
  readOrgRegistryRecordSyncStatus,
} from './org-registry-record-sync';
import { projectManagedSequenceRegistry } from '../shared/managed-sequence-registry-projection';
import { readSequenceProductSummary } from '../db/entity-substrate/sequence-product-summary-runtime';
import { MANAGED_SEQUENCE_DOCUMENT_FIELD } from '../shared/managed-sequence-document';
import { createRegisteredSequencePackagePublicationContext } from './sequence-package-registry-publication';
import * as packageFiles from './primer-artifact-files';
import { archiveLimsEntityInsideTx, revertLimsEntityInsideTx } from './lims-entity-lifecycle';
import type { PreparedOrganizationRegistryClaim } from '../shared/org-registry-sync';
import { readCheckedOrganizationRecordReview } from './org-registry-record-review';
import {
  replaceOrgRegistrySnapshot,
  enqueueOrgRegistryMutation,
  acknowledgeOrgRegistryMutation,
} from './org-registry-sync-cache';
import {
  publishReviewedSequencePackageResolution,
  resumeReviewedSequencePackageResolution,
  readPendingSequenceKeepSavedIdentity,
} from './sequence-package-record-resolution';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: () => '/tmp/dnaforge-test-app-data', getVersion: () => 'test' },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('./ipc/database', () => ({ getDb: () => publicationDb }));
vi.mock('./auth/session-store', () => ({
  getActiveStoredSession: async () => ({ accountId: REGISTERED_ACCOUNT }),
}));
let publicationDb: Database.Database;
beforeEach(() => {
  publicationDb = createTestDb();
  ensureSchema(publicationDb, ':memory:');
});
import { parseGenBankFull, serializeSequenceForInPlaceSave } from '@waypoint/sequence-utils';
import {
  buildSequencePackageDocument,
  fromPackageRelative,
  parseSequencePackageDocument,
  sequencePackagePaths,
  serializeSequencePackageDocument,
  type SequencePackageDocument,
} from '../db/sequence-package';
import { prepareSequencePackageRevision } from '../db/sequence-package-versioning';
import {
  sequenceAssemblyWorkingCopyMember,
  sequenceAssemblyWorkingCopyPath,
  withSequenceAssemblyWorkingCopy,
} from '../db/sequence-package-working-copy';
import {
  serializeWorkspaceTextFileAtomicWriteFailure,
  unwrapWorkspaceTextFileAtomicWriteResponse,
} from '../shared/workspace-file-atomic';
import { WorkspaceFilePreconditionError } from './primer-artifact-files';
import {
  applySequenceRestoreInMain,
  previewSequenceRestoreInMain,
  publishSequencePackageRevisionInMain,
  publishRegisteredSequenceLifecycleInMain,
  publishSequenceUserAttachmentMutationInMain,
  withRecoveredSequencePackageMutationInMain,
  recoverSequencePackageRevisionPublicationInMain,
  readCheckedManagedSequenceRegistrySnapshot,
} from './sequence-package-revision-publication';
import {
  acquireWorkspaceMutationShared,
  withWorkspaceMutation,
  workspaceMutationRootIdentity,
  workspaceMutationWaiterCountForTest,
} from './workspace-sync-mutation-lease';
import {
  withKnownRendererFilesystemMutation,
  withDeclaredRendererFilesystemMutation,
} from './ipc/workspace-mutation-authority';
import { workspaceMutationCapabilities } from './ipc/workspace-mutation-capability';
import {
  prepareSequenceEvidenceRunInMain,
  activateSequenceEvidenceRunInMain,
  completeSequenceEvidenceRunInMain,
  appendSequenceEvidenceStateInMain,
  publishSequenceAlignmentHistoryInMain,
} from './sequence-package-evidence-publication';
import { savedSequenceRequiredFiles } from './org-registry-saved-sequence-snapshot-contract';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  publicationDb.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function packageDirectory(): Promise<{ root: string; packageRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), 'sequence-package-publication-'));
  roots.push(root);
  const packageRoot = join(root, 'record.wpseq');
  await mkdir(packageRoot);
  return { root, packageRoot };
}

describe('sequence package publication authority', () => {
  it('restores a direct-edited version without falsely claiming its retained assembly produced those bases', async () => {
    const { root, packageRoot } = await packageDirectory();
    const productPath = join(packageRoot, 'record.gb');
    const content = (sequence: string) =>
      serializeSequenceForInPlaceSave(
        {
          id: 'record',
          name: 'Record',
          sequence,
          length: sequence.length,
          circular: false,
          annotations: [],
        },
        productPath
      );
    const original = content('AACC');
    const edited = content('AATC');
    const later = content('AAAC');
    const accepted = {
      artifacts: {
        productGenBankChecksum: `sha256:${createHash('sha256').update(original).digest('hex')}`,
      },
    };
    const base = buildSequencePackageDocument({
      id: 'record',
      name: 'Record',
      product: { file: 'record.gb', topology: 'linear' },
      assembly: { accepted },
    });
    const first = await prepareSequencePackageRevision({
      current: null,
      currentProductContent: null,
      next: base,
      nextProductContent: original,
      kind: 'assembly-finalization',
      operationId: 'first',
      revisionId: 'first',
    });
    const second = await prepareSequencePackageRevision({
      current: first.document,
      currentProductContent: original,
      next: first.document,
      nextProductContent: edited,
      kind: 'sequence-save',
      operationId: 'second',
      revisionId: 'second',
    });
    const third = await prepareSequencePackageRevision({
      current: second.document,
      currentProductContent: edited,
      next: second.document,
      nextProductContent: later,
      kind: 'sequence-save',
      operationId: 'third',
      revisionId: 'third',
    });
    const paths = sequencePackagePaths(packageRoot, { productFile: 'record.gb' });
    await mkdir(paths.metaDir, { recursive: true });
    await mkdir(paths.contentsDir, { recursive: true });
    for (const snapshot of [...first.snapshots, ...second.snapshots, ...third.snapshots]) {
      await writeFile(fromPackageRelative(snapshot.path, packageRoot), snapshot.content);
    }
    await writeFile(paths.productPath, later);
    await writeFile(paths.metaPath, serializeSequencePackageDocument(third.document));

    const request = {
      workspaceRoot: root,
      packageRoot,
      packageId: 'record',
      selections: [
        { itemId: 'product', revisionId: 'second' },
        { itemId: 'assembly', revisionId: 'second' },
      ],
    };
    const preview = await previewSequenceRestoreInMain(request);
    expect(preview.blockers).toEqual([]);
    expect(preview.warnings).toContain(
      'The selected saved assembly remains historical; it did not produce the composed sequence bytes.'
    );
    await applySequenceRestoreInMain({
      ...request,
      operationId: 'restore-edited',
      previewFingerprint: preview.previewFingerprint,
    });
    expect(await readFile(paths.productPath, 'utf8')).toBe(edited);
    const current = parseSequencePackageDocument(await readFile(paths.metaPath, 'utf8'));
    expect(current.assembly?.accepted).toEqual(accepted);
    expect(current.versionHistory.revisions.at(-1)?.sources).toMatchObject({
      product: { revisionId: 'second' },
      assembly: { revisionId: 'second' },
    });
  });

  it('restores intrinsic topology and genetic code independently from a saved product snapshot', async () => {
    const { root, packageRoot } = await packageDirectory();
    const productPath = join(packageRoot, 'record.gb');
    const firstContent = serializeSequenceForInPlaceSave(
      {
        id: 'record',
        name: 'record',
        sequence: 'AACC',
        length: 4,
        circular: false,
        annotations: [],
      },
      productPath
    );
    const secondContent = serializeSequenceForInPlaceSave(
      {
        id: 'record',
        name: 'record',
        sequence: 'AACC',
        length: 4,
        circular: true,
        chosenGeneticCode: 2,
        annotations: [],
      },
      productPath
    );
    const base = buildSequencePackageDocument({
      id: 'record',
      name: 'Record',
      product: { file: 'record.gb', topology: 'linear' },
    });
    const first = await prepareSequencePackageRevision({
      current: null,
      currentProductContent: null,
      next: base,
      nextProductContent: firstContent,
      kind: 'sequence-save',
      operationId: 'first',
      revisionId: 'first',
    });
    const second = await prepareSequencePackageRevision({
      current: first.document,
      currentProductContent: firstContent,
      next: { ...first.document, product: { ...first.document.product, topology: 'circular' } },
      nextProductContent: secondContent,
      kind: 'metadata-update',
      operationId: 'second',
      revisionId: 'second',
    });
    const paths = sequencePackagePaths(packageRoot, { productFile: 'record.gb' });
    await mkdir(paths.metaDir, { recursive: true });
    await mkdir(paths.contentsDir, { recursive: true });
    for (const snapshot of [...first.snapshots, ...second.snapshots]) {
      await writeFile(fromPackageRelative(snapshot.path, packageRoot), snapshot.content);
    }
    await writeFile(paths.productPath, secondContent);
    await writeFile(paths.metaPath, serializeSequencePackageDocument(second.document));
    const request = {
      workspaceRoot: root,
      packageRoot,
      packageId: 'record',
      selections: [
        { itemId: 'topology', revisionId: 'first' },
        { itemId: 'genetic-code', revisionId: 'first' },
      ],
    };
    const preview = await previewSequenceRestoreInMain(request);
    expect(preview.blockers).toEqual([]);
    expect(preview.changedItems).toEqual(['genetic-code', 'topology']);
    await applySequenceRestoreInMain({
      ...request,
      operationId: 'intrinsic-restore',
      previewFingerprint: preview.previewFingerprint,
    });
    const restored = parseGenBankFull(await readFile(paths.productPath, 'utf8'));
    expect(restored.circular).toBe(false);
    expect(restored.chosenGeneticCode).toBeUndefined();
    const marker = parseSequencePackageDocument(await readFile(paths.metaPath, 'utf8'));
    expect(marker.versionHistory.revisions.map((revision) => revision.id)).toEqual([
      'first',
      'second',
      'restore:intrinsic-restore',
    ]);
    expect(Object.keys(marker.versionHistory.revisions[2].sources ?? {})).toEqual([
      'genetic-code',
      'topology',
    ]);
    expect(
      parseGenBankFull(
        await readFile(
          fromPackageRelative(marker.versionHistory.revisions[1].productSnapshot.path, packageRoot),
          'utf8'
        )
      ).chosenGeneticCode
    ).toBe(2);
  });
  it('shares its lock with a recovered member mutation, including path aliases', async () => {
    const { root, packageRoot } = await packageDirectory();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const mutation = withRecoveredSequencePackageMutationInMain(root, packageRoot, async () => {
      entered();
      await gate;
    });
    await inside;

    let publicationSettled = false;
    const publication = publishSequencePackageRevisionInMain({
      workspaceRoot: root,
      packageRoot: join(packageRoot, '.'),
      packageId: 'record',
      nextDocument: {} as SequencePackageDocument,
      nextProductContent: '',
      kind: 'sequence-save',
      operationId: 'publication-after-member',
      revisionId: 'publication-after-member',
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
    await mutation;
    await expect(publication).rejects.toThrow();
    expect(publicationSettled).toBe(true);
  });

  it('does not invoke a member mutation when pending publication recovery fails', async () => {
    const { root, packageRoot } = await packageDirectory();
    await mkdir(join(packageRoot, '.forge'));
    await writeFile(
      join(packageRoot, '.forge', 'sequence-revision-publication.json'),
      '{"state":"pending"}'
    );
    let invoked = false;

    await expect(
      withRecoveredSequencePackageMutationInMain(root, packageRoot, async () => {
        invoked = true;
      })
    ).rejects.toMatchObject({
      name: 'SequencePackagePublicationRecoveryError',
      message: expect.stringContaining('journal identity is invalid'),
    });
    expect(invoked).toBe(false);
  });

  it('preserves marker CAS identity through the renderer IPC error envelope', () => {
    const response = serializeWorkspaceTextFileAtomicWriteFailure(
      new WorkspaceFilePreconditionError('marker changed')
    );
    expect(() => unwrapWorkspaceTextFileAtomicWriteResponse(response)).toThrow('marker changed');
    if (!response.ok) {
      expect(response.error.name).toBe('WorkspaceFilePreconditionError');
    }
  });

  it('invalidates a Restore preview when the owned assembly working-copy bytes change', async () => {
    const { root, packageRoot } = await packageDirectory();
    const productContent = 'saved reference bytes';
    const base = buildSequencePackageDocument({
      id: 'record',
      name: 'First',
      product: { file: 'record.gb' },
    });
    const first = await prepareSequencePackageRevision({
      current: null,
      currentProductContent: null,
      next: base,
      nextProductContent: productContent,
      kind: 'sequence-save',
      operationId: 'first',
      revisionId: 'first',
    });
    const second = await prepareSequencePackageRevision({
      current: first.document,
      currentProductContent: productContent,
      next: { ...first.document, name: 'Second' },
      nextProductContent: productContent,
      kind: 'metadata-update',
      operationId: 'second',
      revisionId: 'second',
    });
    const document = withSequenceAssemblyWorkingCopy(
      second.document,
      'draft-one',
      new Date().toISOString()
    );
    const paths = sequencePackagePaths(packageRoot, { productFile: document.product.file });
    await mkdir(paths.metaDir, { recursive: true });
    await mkdir(paths.contentsDir, { recursive: true });
    await writeFile(paths.metaPath, serializeSequencePackageDocument(document));
    await writeFile(paths.productPath, productContent);
    for (const snapshot of [...first.snapshots, ...second.snapshots]) {
      await writeFile(fromPackageRelative(snapshot.path, packageRoot), snapshot.content);
    }
    const member = sequenceAssemblyWorkingCopyMember(document);
    if (!member) throw new Error('Test package has no assembly working copy.');
    const copyPath = sequenceAssemblyWorkingCopyPath(packageRoot, member);
    await writeFile(copyPath, '{"generation":"one"}');
    const request = {
      workspaceRoot: root,
      packageRoot,
      packageId: document.id,
      selections: [{ itemId: 'name', revisionId: 'first' }],
    };
    const preview = await previewSequenceRestoreInMain(request);

    await writeFile(copyPath, '{"generation":"two"}');
    const freshPreview = await previewSequenceRestoreInMain(request);
    expect(freshPreview.previewFingerprint).not.toBe(preview.previewFingerprint);
    await expect(
      applySequenceRestoreInMain({
        ...request,
        operationId: 'restore-name',
        previewFingerprint: preview.previewFingerprint,
      })
    ).rejects.toThrow('Restore preview is stale');
  });

  it('restores one verified user attachment without removing other package artifacts', async () => {
    const { root, packageRoot } = await packageDirectory();
    const productContent = serializeSequenceForInPlaceSave(
      { id: 'record', name: 'Record', sequence: 'AACC', length: 4, annotations: [] },
      'record.gb'
    );
    const oldBytes = Buffer.from([0, 255, 1]);
    const newBytes = Buffer.from([0, 255, 2]);
    const digest = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const createdAt = '2026-09-30T00:00:00Z';
    const oldMember = {
      id: 'member-old',
      role: 'user',
      path: 'contents/old.bin',
      replaceable: false,
      createdAt,
    };
    const newMember = {
      id: 'member-new',
      role: 'user',
      path: 'contents/new.bin',
      replaceable: false,
      createdAt,
    };
    const first = await prepareSequencePackageRevision({
      current: null,
      currentProductContent: null,
      next: buildSequencePackageDocument({
        id: 'record',
        name: 'Record',
        product: { file: 'record.gb' },
        members: [oldMember],
        userAttachments: { attachment: { memberId: oldMember.id, sha256: digest(oldBytes) } },
      }),
      nextProductContent: productContent,
      kind: 'member-update',
      operationId: 'first',
      revisionId: 'first',
    });
    const second = await prepareSequencePackageRevision({
      current: first.document,
      currentProductContent: productContent,
      next: {
        ...first.document,
        members: [...first.document.members, newMember],
        userAttachments: { attachment: { memberId: newMember.id, sha256: digest(newBytes) } },
      },
      nextProductContent: productContent,
      kind: 'member-update',
      operationId: 'second',
      revisionId: 'second',
    });
    const paths = sequencePackagePaths(packageRoot, { productFile: 'record.gb' });
    await mkdir(paths.metaDir, { recursive: true });
    await mkdir(paths.contentsDir, { recursive: true });
    await writeFile(paths.productPath, productContent);
    await writeFile(fromPackageRelative(oldMember.path, packageRoot), oldBytes);
    await writeFile(fromPackageRelative(newMember.path, packageRoot), newBytes);
    for (const snapshot of [...first.snapshots, ...second.snapshots]) {
      await writeFile(fromPackageRelative(snapshot.path, packageRoot), snapshot.content);
    }
    await writeFile(paths.metaPath, serializeSequencePackageDocument(second.document));

    const request = {
      workspaceRoot: root,
      packageRoot,
      packageId: 'record',
      selections: [{ itemId: 'user-attachment:attachment', revisionId: 'first' }],
    };
    const preview = await previewSequenceRestoreInMain(request);
    expect(preview.blockers).toEqual([]);
    expect(preview.changedItems).toEqual(['user-attachment:attachment']);
    await applySequenceRestoreInMain({
      ...request,
      operationId: 'restore-attachment',
      previewFingerprint: preview.previewFingerprint,
    });
    const restored = parseSequencePackageDocument(await readFile(paths.metaPath, 'utf8'));
    expect(restored.userAttachments.attachment).toEqual({
      memberId: oldMember.id,
      sha256: digest(oldBytes),
    });
    expect(restored.members.map((member) => member.id)).toContain(newMember.id);
    expect(restored.versionHistory.revisions.at(-1)?.sources).toMatchObject({
      'user-attachment:attachment': { revisionId: 'first' },
    });
    expect(await readFile(fromPackageRelative(newMember.path, packageRoot))).toEqual(newBytes);

    const unattested = await prepareSequencePackageRevision({
      current: restored,
      currentProductContent: productContent,
      next: {
        ...restored,
        userAttachments: { attachment: { memberId: newMember.id, sha256: null } },
      },
      nextProductContent: productContent,
      kind: 'member-update',
      operationId: 'unattested',
      revisionId: 'unattested',
    });
    for (const snapshot of unattested.snapshots) {
      await writeFile(fromPackageRelative(snapshot.path, packageRoot), snapshot.content);
    }
    await writeFile(paths.metaPath, serializeSequencePackageDocument(unattested.document));
    expect((await previewSequenceRestoreInMain(request)).changedItems).toEqual([
      'user-attachment:attachment',
    ]);

    await writeFile(fromPackageRelative(oldMember.path, packageRoot), Buffer.from([7, 8, 9]));
    await expect(previewSequenceRestoreInMain(request)).rejects.toThrow(/attachment.*integrity/i);
  });

  it('publishes binary attach, replace and detach as durable versions with exact retry', async () => {
    const { root, packageRoot } = await packageDirectory();
    const productContent = serializeSequenceForInPlaceSave(
      { id: 'record', name: 'Record', sequence: 'AACC', length: 4, annotations: [] },
      'record.gb'
    );
    const first = await prepareSequencePackageRevision({
      current: null,
      currentProductContent: null,
      next: buildSequencePackageDocument({
        id: 'record',
        name: 'Record',
        product: { file: 'record.gb' },
      }),
      nextProductContent: productContent,
      kind: 'sequence-save',
      operationId: 'initial',
      revisionId: 'initial',
    });
    const paths = sequencePackagePaths(packageRoot, { productFile: 'record.gb' });
    await mkdir(paths.metaDir, { recursive: true });
    await mkdir(paths.contentsDir, { recursive: true });
    for (const snapshot of first.snapshots) {
      await writeFile(fromPackageRelative(snapshot.path, packageRoot), snapshot.content);
    }
    await writeFile(paths.productPath, productContent);
    await writeFile(paths.metaPath, serializeSequencePackageDocument(first.document));
    const inputFor = (
      operationId: string,
      mutation: Parameters<typeof publishSequenceUserAttachmentMutationInMain>[0]['mutation']
    ) => ({
      workspaceRoot: root,
      packageRoot,
      packageId: 'record',
      expectedMarkerSha256: `sha256:${createHash('sha256')
        .update(
          operationId === 'attach-one'
            ? serializeSequencePackageDocument(first.document)
            : readFileSyncMarker()
        )
        .digest('hex')}`,
      expectedProductSha256: `sha256:${createHash('sha256').update(productContent).digest('hex')}`,
      operationId,
      mutation,
    });
    let markerForNext = serializeSequencePackageDocument(first.document);
    const readFileSyncMarker = () => markerForNext;
    const bytesOne = new Uint8Array([0, 255, 1]);
    const firstInput = inputFor('attach-one', {
      kind: 'attach',
      attachmentId: 'trace',
      memberId: '11111111-1111-4111-8111-111111111111',
      fileName: 'read.ab1',
      content: bytesOne,
      createdAt: '2026-09-30T00:00:00Z',
    });
    const attached = await publishSequenceUserAttachmentMutationInMain(firstInput);
    expect(attached.alreadyPublished).toBe(false);
    markerForNext = await readFile(paths.metaPath, 'utf8');
    expect((await publishSequenceUserAttachmentMutationInMain(firstInput)).alreadyPublished).toBe(
      true
    );
    const currentOne = parseSequencePackageDocument(markerForNext);
    expect(currentOne.versionHistory.revisions.at(-1)?.kind).toBe('member-update');
    const oldMember = currentOne.members.find(
      (member) => member.id === currentOne.userAttachments.trace.memberId
    )!;
    expect(await readFile(fromPackageRelative(oldMember.path, packageRoot))).toEqual(
      Buffer.from(bytesOne)
    );
    const replaced = await publishSequenceUserAttachmentMutationInMain(
      inputFor('replace-one', {
        kind: 'replace',
        attachmentId: 'trace',
        memberId: '22222222-2222-4222-8222-222222222222',
        fileName: 'read.ab1',
        content: new Uint8Array([0, 255, 2]),
        createdAt: '2026-09-30T00:01:00Z',
      })
    );
    expect(replaced.alreadyPublished).toBe(false);
    markerForNext = await readFile(paths.metaPath, 'utf8');
    await publishSequenceUserAttachmentMutationInMain(
      inputFor('detach-one', {
        kind: 'detach',
        attachmentId: 'trace',
        createdAt: '2026-09-30T00:02:00Z',
      })
    );
    const detached = parseSequencePackageDocument(await readFile(paths.metaPath, 'utf8'));
    expect(detached.userAttachments).toEqual({});
    expect(detached.members).toContainEqual(oldMember);
    expect(await readFile(fromPackageRelative(oldMember.path, packageRoot))).toEqual(
      Buffer.from(bytesOne)
    );
    const preview = await previewSequenceRestoreInMain({
      workspaceRoot: root,
      packageRoot,
      packageId: 'record',
      selections: [{ itemId: 'user-attachment:trace', revisionId: 'attach-one' }],
    });
    expect(preview.blockers).toEqual([]);
    expect(preview.changedItems).toEqual(['user-attachment:trace']);
  });

  it('restores one historical annotation without replacing DNA or other GenBank bytes', async () => {
    const { root, packageRoot } = await packageDirectory();
    const annotationId = '550e8400-e29b-41d4-a716-446655440000';
    const content = (annotationName: string, bases = 'AACC') =>
      serializeSequenceForInPlaceSave(
        {
          id: 'record',
          name: 'Record',
          sequence: bases,
          length: bases.length,
          annotations: [
            {
              name: annotationName,
              type: 'misc_feature',
              start: 1,
              end: 2,
              direction: 1,
              qualifiers: { dnaforge_ann_id: [annotationId], note: [annotationName] },
            },
          ],
        },
        'record.gb'
      );
    const oldContent = content('Old feature');
    const newContent = content('New feature');
    const base = buildSequencePackageDocument({
      id: 'record',
      name: 'Record',
      product: { file: 'record.gb', topology: 'linear' },
    });
    const first = await prepareSequencePackageRevision({
      current: null,
      currentProductContent: null,
      next: base,
      nextProductContent: oldContent,
      kind: 'sequence-save',
      operationId: 'first',
      revisionId: 'first',
    });
    const second = await prepareSequencePackageRevision({
      current: first.document,
      currentProductContent: oldContent,
      next: first.document,
      nextProductContent: newContent,
      kind: 'sequence-save',
      operationId: 'second',
      revisionId: 'second',
    });
    const paths = sequencePackagePaths(packageRoot, { productFile: 'record.gb' });
    await mkdir(paths.metaDir, { recursive: true });
    await mkdir(paths.contentsDir, { recursive: true });
    for (const snapshot of [...first.snapshots, ...second.snapshots]) {
      await writeFile(fromPackageRelative(snapshot.path, packageRoot), snapshot.content);
    }
    await writeFile(paths.productPath, newContent);
    await writeFile(paths.metaPath, serializeSequencePackageDocument(second.document));
    const request = {
      workspaceRoot: root,
      packageRoot,
      packageId: 'record',
      selections: [{ itemId: `annotation:${annotationId}`, revisionId: 'first' }],
    };
    const preview = await previewSequenceRestoreInMain(request);
    expect(preview.blockers).toEqual([]);
    expect(preview.changedItems).toEqual([`annotation:${annotationId}`]);
    await applySequenceRestoreInMain({
      ...request,
      operationId: 'restore-annotation',
      previewFingerprint: preview.previewFingerprint,
    });
    const restored = await readFile(paths.productPath, 'utf8');
    expect(parseGenBankFull(restored).annotations[0].name).toBe('Old feature');
    expect(restored.split('FEATURES')[0]).toBe(newContent.split('FEATURES')[0]);
    expect(restored.split('ORIGIN')[1]).toBe(newContent.split('ORIGIN')[1]);
    const marker = parseSequencePackageDocument(await readFile(paths.metaPath, 'utf8'));
    expect(marker.versionHistory.revisions.at(-1)?.sources).toMatchObject({
      [`annotation:${annotationId}`]: { revisionId: 'first' },
    });
    expect(marker.versionHistory.revisions[0].productSnapshot.sha256).toBe(
      first.revision.productSnapshot.sha256
    );
  });
});

const REGISTERED_ACCOUNT = '10000000-0000-4000-8000-000000000041';
const REGISTERED_ORG = '20000000-0000-4000-8000-000000000041';
const REGISTERED_HOME = '30000000-0000-4000-8000-000000000041';
const REGISTERED_REMOTE = '40000000-0000-4000-8000-000000000041';
const REGISTERED_ID = '50000000-0000-4000-8000-000000000041';
const registeredHash = (value: string | Uint8Array) =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;

async function registeredPackage(
  options: {
    enrolled?: boolean;
    persistent?: boolean;
    projectionVersion?: 2 | 3;
    legacyAlignmentHistory?: string;
  } = {}
) {
  const { root, packageRoot } = await packageDirectory();
  const databasePath = join(root, 'registered-test.sqlite');
  if (options.persistent) {
    publicationDb.close();
    publicationDb = openFileTestDb(databasePath);
    ensureSchema(publicationDb, databasePath);
  }
  const db = publicationDb;
  const paths = sequencePackagePaths(packageRoot, { productFile: 'record.gb' });
  const product = (bases: string) =>
    serializeSequenceForInPlaceSave(
      {
        id: REGISTERED_ID,
        name: 'Registered',
        sequence: bases,
        length: bases.length,
        circular: false,
        annotations: [],
      },
      paths.productPath
    );
  const beforeProduct = product('AACC');
  const base = buildSequencePackageDocument({
    id: REGISTERED_ID,
    name: 'Registered',
    product: {
      file: 'record.gb',
      topology: 'linear',
      genBankChecksum: registeredHash(beforeProduct),
      sequenceChecksum: registeredHash('AACC'),
    },
  });
  if (options.legacyAlignmentHistory !== undefined)
    base.members.push({
      id: 'alignment:legacy',
      role: 'alignment',
      path: 'contents/legacy-alignment.json',
      replaceable: false,
      createdAt: '2026-01-01T00:00:00Z',
    });
  const initial = await prepareSequencePackageRevision({
    current: null,
    currentProductContent: null,
    next: base,
    nextProductContent: beforeProduct,
    kind: 'sequence-save',
    operationId: 'initial',
    revisionId: 'initial',
  });
  await mkdir(paths.metaDir, { recursive: true });
  await mkdir(paths.contentsDir, { recursive: true });
  if (options.legacyAlignmentHistory !== undefined)
    await writeFile(
      join(paths.contentsDir, 'legacy-alignment.json'),
      options.legacyAlignmentHistory
    );
  for (const snapshot of initial.snapshots)
    await writeFile(fromPackageRelative(snapshot.path, packageRoot), snapshot.content);
  const beforeMarker = serializeSequencePackageDocument(initial.document);
  await writeFile(paths.metaPath, beforeMarker);
  await writeFile(paths.productPath, beforeProduct);
  db.prepare('INSERT INTO workspaces(id,name,path,repo_uuid,created_at) VALUES(1,?,?,?,1)').run(
    'Existing home',
    root,
    REGISTERED_HOME
  );
  db.prepare(
    `INSERT INTO workspace_sync_bindings(workspace_id,workspace_uuid,owner_account_id,owner_org_id,remote_workspace_id,enabled,access_role,created_at,updated_at) VALUES(1,?,?,?,?,0,'editor',1,1)`
  ).run(REGISTERED_HOME, REGISTERED_ACCOUNT, REGISTERED_ORG, REGISTERED_REMOTE);
  seedLimsBuiltinsInDb(db);
  const projected = await projectManagedSequenceRegistry(
    initial.document,
    await readSequenceProductSummary(beforeProduct),
    options.projectionVersion
  );
  const entity = db.transaction(() =>
    registerLimsEntityInsideTx(db, {
      ...projected,
      fields: {
        ...projected.fields,
        [MANAGED_SEQUENCE_DOCUMENT_FIELD]: {
          kind: 'managed-sequence',
          packageId: REGISTERED_ID,
          packageRoot,
        },
      },
      workspaceId: 1,
      actor: 'workspace-reconcile',
    })
  )();
  db.prepare(
    `INSERT INTO catalog_entities(id,type,name,locator,storage_type,workspace_id,created_at,updated_at) VALUES(?,'sequence','Registered',?,'file',1,1,1)`
  ).run(REGISTERED_ID, packageRoot);
  db.prepare(
    `INSERT INTO catalog_entity_files(id,entity_id,workspace_id,path,file_kind,created_at,updated_at) VALUES('registered-file',?,1,?,'waypoint-sequence',1,1)`
  ).run(REGISTERED_ID, packageRoot);

  const claim = {
    mutationId: '80000000-0000-4000-8000-000000000041',
    sourceEntityId: REGISTERED_ID,
    sourceRegistryId: entity.registryId,
    sourceRevision: 'a'.repeat(64),
    homeProjectUuid: REGISTERED_HOME,
    homeWorkspaceId: REGISTERED_REMOTE,
    homeProjectName: 'Existing home',
    payload: {
      id: REGISTERED_ID,
      kind: entity.kind,
      name: entity.name,
      fields: projected.fields,
      registrationStatus: entity.registrationStatus,
      domainStatus: entity.domainStatus,
      homeWorkspaceId: REGISTERED_REMOTE,
      schemaId: '60000000-0000-4000-8000-000000000041',
      schemaRevisionId: '70000000-0000-4000-8000-000000000041',
    },
  } satisfies PreparedOrganizationRegistryClaim;
  const enroll = () =>
    db.transaction(() =>
      enrollOrgRegistryRecordInTx(db, {
        orgId: REGISTERED_ORG,
        accountId: REGISTERED_ACCOUNT,
        clientId: 'desktop:package-test',
        mutationId: '80000000-0000-4000-8000-000000000041',
        claim,
        now: 1,
      })
    )();
  if (options.enrolled !== false) enroll();
  let accountId: string | null = REGISTERED_ACCOUNT;
  const context = createRegisteredSequencePackagePublicationContext({
    db,
    runDatabase: <T>(work: () => T) => work(),
    getActiveAccountId: async () => accountId,
  });
  const publications = () =>
    db
      .prepare('SELECT * FROM org_registry_record_publications ORDER BY local_event_seq')
      .all() as Array<{
      mutation_id: string;
      operation_id: string;
      publication_authority: string;
      publication_sha256: string;
      payload_json: string;
      status: string;
      local_event_seq: number;
    }>;
  const auditCount = () =>
    (
      db.prepare('SELECT COUNT(*) AS n FROM lims_audit WHERE subject_id=?').get(REGISTERED_ID) as {
        n: number;
      }
    ).n;
  async function request(operationId: string, name: string, bases: string) {
    const marker = await readFile(paths.metaPath, 'utf8');
    const currentProduct = await readFile(paths.productPath, 'utf8');
    const current = parseSequencePackageDocument(marker);
    const nextProduct = product(bases);
    return {
      workspaceRoot: root,
      packageRoot,
      packageId: REGISTERED_ID,
      nextDocument: {
        ...current,
        name,
        product: {
          ...current.product,
          genBankChecksum: registeredHash(nextProduct),
          sequenceChecksum: registeredHash(bases),
        },
      },
      nextProductContent: nextProduct,
      kind: 'sequence-save' as const,
      operationId,
      revisionId: operationId,
      expectedMarkerSha256: registeredHash(marker),
      expectedProductSha256: registeredHash(currentProduct),
    };
  }
  return {
    db,
    root,
    packageRoot,
    paths,
    context,
    entity,
    claim,
    databasePath,
    beforeMarker,
    beforeProduct,
    request,
    publications,
    auditCount,
    enroll,
    setAccount: (value: string | null) => {
      accountId = value;
    },
  };
}

describe('registered package publication uses installed bytes and real SQLite audit', () => {
  it('publishes saved evidence preparation, completion and review without changing identity or DNA', async () => {
    const f = await registeredPackage();
    const { root: queryRoot } = await packageDirectory();
    const queryPath = join(queryRoot, 'evidence-query.fasta');
    await writeFile(queryPath, '>query\nAACC\n');
    const input = {
      workspaceRoot: f.root,
      packageRoot: f.packageRoot,
      packageId: REGISTERED_ID,
      sourcePath: f.paths.productPath,
      sessionId: 'registered-evidence-session',
      session: {
        name: 'Saved review',
        mode: 'one-per-clone' as const,
        createdAt: '2026-01-01T00:00:00Z',
      },
      runId: 'registered-evidence-run',
      queries: [{ id: 'query-one', label: 'Saved query', path: queryPath }],
    };
    await expect(prepareSequenceEvidenceRunInMain(input, f.context)).rejects.toThrow();
    await expect(
      prepareSequenceEvidenceRunInMain(input, f.context, async () => {
        throw new Error('Query read was not admitted.');
      })
    ).rejects.toThrow('not admitted');
    expect(await readFile(f.paths.metaPath, 'utf8')).toBe(f.beforeMarker);
    expect(f.publications()).toHaveLength(0);
    const prepared = await prepareSequenceEvidenceRunInMain(input, f.context, async (path) => {
      expect(path).toBe(queryPath);
      return path;
    });
    expect(f.publications()).toHaveLength(1);
    expect(await prepareSequenceEvidenceRunInMain(input, f.context)).toEqual(prepared);
    expect(f.publications()).toHaveLength(1);
    expect(await readFile(prepared.referenceReadPath, 'utf8')).toBe(f.beforeProduct);
    expect(await readFile(prepared.queryPaths['query-one'], 'utf8')).toBe('>query\nAACC\n');
    const output: PairwiseSessionAlignmentResult = {
      inputRevision: `pairwise-session-alignment-v1:sha256:${'a'.repeat(64)}`,
      referenceRevision: prepared.run.reference.sequenceRevision,
      results: [
        {
          queryId: 'query-one',
          queryRevision: `pairwise-query-v1:${registeredHash(JSON.stringify('AACC'))}`,
          alignment: {
            aligned_query: 'AACC',
            aligned_reference: 'AACC',
            identity: 100,
            mutations: [],
            alignment_length: 4,
            gaps: 0,
            matches: 4,
            mismatches: 0,
            query_length: 4,
            reference_length: 4,
          },
        },
      ],
    };
    const operation = {
      ...input,
      managedOperationId: 'registered-evidence-operation',
      inputRevision: output.inputRevision,
    };
    await activateSequenceEvidenceRunInMain(operation, f.context);
    await activateSequenceEvidenceRunInMain(operation, f.context);
    expect(f.publications()).toHaveLength(2);
    const completed = await completeSequenceEvidenceRunInMain(
      { ...operation, result: output },
      f.context
    );
    expect(
      await completeSequenceEvidenceRunInMain({ ...operation, result: output }, f.context)
    ).toEqual(completed);
    expect(JSON.parse(await readFile(completed.resultPath, 'utf8'))).toEqual(output);
    expect(f.publications()).toHaveLength(3);
    const review = {
      ...input,
      stateId: 'review-one',
      classifier: 'mutation-impact-v1' as const,
      session: { ...input.session, archived: false },
      tracks: [
        {
          queryId: 'query-one',
          label: 'Saved query',
          alignment: {
            alignedReference: 'AACC',
            alignedQuery: 'AACC',
            identity: 100,
            coverageStart: 0,
            coverageEnd: 4,
            algorithm: 'auto',
          },
          mutations: [],
          status: 'pass' as const,
          alignedAt: '2026-01-01T00:00:01Z',
        },
      ],
    };
    const reviewed = await appendSequenceEvidenceStateInMain(review, f.context);
    expect(await appendSequenceEvidenceStateInMain(review, f.context)).toEqual(reviewed);
    const markerBytes = await readFile(f.paths.metaPath, 'utf8');
    const marker = parseSequencePackageDocument(markerBytes);
    const publications = f.publications();
    expect(publications).toHaveLength(4);
    expect(new Set(publications.map((row) => row.mutation_id)).size).toBe(4);
    expect(marker.versionHistory.revisions).toHaveLength(5);
    expect(marker.evidenceRuns).toEqual([reviewed]);
    expect(marker.id).toBe(REGISTERED_ID);
    expect(marker.entity.relationships).toEqual(
      parseSequencePackageDocument(f.beforeMarker).entity.relationships
    );
    expect(await readFile(f.paths.productPath, 'utf8')).toBe(f.beforeProduct);
    expect(queryLimsEntitiesInDb(f.db, { id: REGISTERED_ID })[0]).toMatchObject({
      id: REGISTERED_ID,
      workspaceId: 1,
    });
    expect(
      JSON.parse(publications.at(-1)!.payload_json).fields._managedSequenceSnapshot.markerSha256
    ).toBe(registeredHash(markerBytes));
    for (const artifact of [
      reviewed.reference.artifact,
      ...reviewed.queries.map((query) => query.artifact),
      reviewed.result!,
      ...reviewed.states!.map((state) => state.artifact),
    ])
      expect(
        registeredHash(await readFile(fromPackageRelative(artifact.path, f.packageRoot)))
      ).toBe(artifact.sha256);
    f.setAccount('another-account');
    await expect(
      prepareSequenceEvidenceRunInMain({ ...input, runId: 'refused-run' }, f.context)
    ).rejects.toThrow();
    expect(await readFile(f.paths.metaPath, 'utf8')).toBe(markerBytes);
    expect(f.publications()).toEqual(publications);
  });

  it('refuses revoked alignment history publication before writing immutable bytes', async () => {
    const f = await registeredPackage();
    const marker = await readFile(f.paths.metaPath, 'utf8');
    await expect(
      publishSequenceAlignmentHistoryInMain(
        {
          workspaceRoot: f.root,
          packageRoot: f.packageRoot,
          packageId: REGISTERED_ID,
          content: JSON.stringify({ version: 1, sessions: [{ id: 'reviewed' }] }),
        },
        f.context,
        () => {
          throw new Error('Alignment history access revoked');
        }
      )
    ).rejects.toThrow('Alignment history access revoked');
    expect(await readFile(f.paths.metaPath, 'utf8')).toBe(marker);
    expect(await readFile(f.paths.productPath, 'utf8')).toBe(f.beforeProduct);
    expect(f.publications()).toEqual([]);
  });

  it('retains legacy and subsequent alignment history bytes with one publication per actual change', async () => {
    const legacy = JSON.stringify({
      version: 1,
      sessions: [{ id: 'one', name: 'Original' }],
      savedAt: 'before',
    });
    const f = await registeredPackage({ legacyAlignmentHistory: legacy });
    const value = { version: 1, sessions: [{ id: 'one', name: 'Reviewed' }], savedAt: 'after' };
    const input = {
      workspaceRoot: f.root,
      packageRoot: f.packageRoot,
      packageId: REGISTERED_ID,
      content: JSON.stringify(value),
    };
    const firstPath = await publishSequenceAlignmentHistoryInMain(input, f.context);
    expect(await readFile(firstPath, 'utf8')).toBe(input.content);
    expect(f.publications()).toHaveLength(1);
    expect(
      await publishSequenceAlignmentHistoryInMain(
        { ...input, content: JSON.stringify({ ...value, savedAt: 'later timestamp only' }) },
        f.context
      )
    ).toBe(firstPath);
    expect(f.publications()).toHaveLength(1);
    const secondContent = JSON.stringify({
      ...value,
      sessions: [{ id: 'one', name: 'Second review' }],
    });
    const secondPath = await publishSequenceAlignmentHistoryInMain(
      { ...input, content: secondContent },
      f.context
    );
    expect(secondPath).not.toBe(firstPath);
    expect(await readFile(secondPath, 'utf8')).toBe(secondContent);
    expect(await readFile(firstPath, 'utf8')).toBe(input.content);
    expect(await readFile(join(f.paths.contentsDir, 'legacy-alignment.json'), 'utf8')).toBe(legacy);
    const markerBytes = await readFile(f.paths.metaPath, 'utf8');
    const marker = parseSequencePackageDocument(markerBytes);
    expect(
      fromPackageRelative(
        marker.members.find((member) => member.role === 'alignment')!.path,
        f.packageRoot
      )
    ).toBe(secondPath);
    const required = savedSequenceRequiredFiles(marker);
    expect([...required.keys()]).not.toContain('contents/legacy-alignment.json');
    expect([...required.values()]).toContain(registeredHash(legacy).slice(7));
    for (const [path, digest] of required)
      expect(registeredHash(await readFile(fromPackageRelative(path, f.packageRoot)))).toBe(
        `sha256:${digest}`
      );
    expect(f.publications()).toHaveLength(2);
    expect(queryLimsEntitiesInDb(f.db, { id: REGISTERED_ID })[0]).toMatchObject({
      id: REGISTERED_ID,
      workspaceId: 1,
    });
    expect(await readFile(f.paths.productPath, 'utf8')).toBe(f.beforeProduct);
    await writeFile(secondPath, 'changed outside the publisher');
    await expect(
      publishSequenceAlignmentHistoryInMain({ ...input, content: secondContent }, f.context)
    ).rejects.toThrow('integrity');
    expect(await readFile(f.paths.metaPath, 'utf8')).toBe(markerBytes);
    expect(f.publications()).toHaveLength(2);
  });

  it('archives and restores a registered package through the actual Registry action and durable revision owner', async () => {
    const f = await registeredPackage();
    expect(getLimsRegistryPreviewInDb(f.db, { entityId: REGISTERED_ID })).toMatchObject({
      acceptedScientificOwner: false,
      savedLifecycleAuthority: 'sequence_package',
    });
    const sender = Object.assign(new EventEmitter(), { id: 334646, isDestroyed: () => false });
    vi.mocked(ipcMain.handle).mockClear();
    registerLimsIpcHandlers();
    const handlers = new Map(vi.mocked(ipcMain.handle).mock.calls);
    const invoke = (channel: string, request: unknown) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`Missing actual IPC handler ${channel}`);
      return Reflect.apply(handler, undefined, [{ sender }, request]);
    };
    const current = () =>
      queryLimsEntitiesInDb(f.db, { id: REGISTERED_ID, includeArchived: true })[0];
    const archive = {
      id: REGISTERED_ID,
      expectedEventSeq: f.entity.eventSeq!,
      operationId: randomUUID(),
    };
    await expect(invoke('lims:archiveEntity', archive)).resolves.toMatchObject({
      id: REGISTERED_ID,
      tombstone: true,
      workspaceId: 1,
    });
    const archived = current();
    expect(getLimsRegistryPreviewInDb(f.db, { entityId: REGISTERED_ID })).toMatchObject({
      summary: { archived: true },
      savedLifecycleAuthority: 'sequence_package',
    });
    expect(archived.archivedAt).toEqual(expect.any(Number));
    const archivedBytes = await readFile(f.paths.metaPath, 'utf8');
    const archivedMarker = parseSequencePackageDocument(archivedBytes);
    expect(archivedMarker.id).toBe(REGISTERED_ID);
    expect(archivedMarker.entity.lifecycle).toEqual({
      archived: true,
      archivedAt: archived.archivedAt,
    });
    expect(await readFile(f.paths.productPath, 'utf8')).toBe(f.beforeProduct);
    expect(f.publications()).toHaveLength(1);
    expect(JSON.parse(f.publications()[0].payload_json).archived).toBe(true);
    const archiveAuditCount = f.auditCount();
    await expect(invoke('lims:archiveEntity', archive)).resolves.toMatchObject(archived);
    expect(await readFile(f.paths.metaPath, 'utf8')).toBe(archivedBytes);
    expect(f.publications()).toHaveLength(1);
    expect(f.auditCount()).toBe(archiveAuditCount);
    const restore = {
      id: REGISTERED_ID,
      expectedEventSeq: archived.eventSeq!,
      operationId: randomUUID(),
    };
    await expect(invoke('lims:restoreEntity', restore)).resolves.toMatchObject({
      id: REGISTERED_ID,
      tombstone: false,
      archivedAt: null,
      workspaceId: 1,
    });
    const restored = current();
    const restoredBytes = await readFile(f.paths.metaPath, 'utf8');
    const restoredMarker = parseSequencePackageDocument(restoredBytes);
    expect(restoredMarker.entity.lifecycle).toEqual({ archived: false, archivedAt: null });
    expect(restoredMarker.versionHistory.revisions.length).toBe(
      archivedMarker.versionHistory.revisions.length + 1
    );
    expect(restoredMarker.versionHistory.revisions).toEqual(
      expect.arrayContaining(archivedMarker.versionHistory.revisions)
    );
    expect(await readFile(f.paths.productPath, 'utf8')).toBe(f.beforeProduct);
    expect(f.publications()).toHaveLength(2);
    expect(JSON.parse(f.publications()[1].payload_json).archived).toBe(false);
    const restoreAuditCount = f.auditCount();
    await expect(invoke('lims:restoreEntity', restore)).resolves.toMatchObject(restored);
    expect(await readFile(f.paths.metaPath, 'utf8')).toBe(restoredBytes);
    expect(f.publications()).toHaveLength(2);
    expect(f.auditCount()).toBe(restoreAuditCount);
  });
  it('reopens an installed archive after database failure and settles its exact lifecycle once under the original account', async () => {
    const f = await registeredPackage({ persistent: true });
    const request = {
      id: REGISTERED_ID,
      expectedEventSeq: f.entity.eventSeq!,
      operationId: randomUUID(),
    };
    const auditBefore = f.auditCount();
    f.db.exec(
      "CREATE TEMP TRIGGER fail_lifecycle_publication BEFORE INSERT ON org_registry_record_publications BEGIN SELECT RAISE(ABORT,'lifecycle settlement interrupted'); END"
    );
    await expect(
      publishRegisteredSequenceLifecycleInMain('archive', request, f.context)
    ).rejects.toThrow('lifecycle settlement interrupted');
    const installed = await readFile(f.paths.metaPath, 'utf8');
    expect(parseSequencePackageDocument(installed).entity.lifecycle?.archived).toBe(true);
    expect(f.publications()).toHaveLength(0);
    expect(f.auditCount()).toBe(auditBefore);
    publicationDb.close();
    publicationDb = openFileTestDb(f.databasePath);
    ensureSchema(publicationDb, f.databasePath);
    let accountId = '10000000-0000-4000-8000-000000000099';
    const context = createRegisteredSequencePackagePublicationContext({
      db: publicationDb,
      runDatabase: <T>(work: () => T) => work(),
      getActiveAccountId: async () => accountId,
    });
    await expect(
      publishRegisteredSequenceLifecycleInMain('archive', request, context)
    ).rejects.toThrow(/account/i);
    expect(await readFile(f.paths.metaPath, 'utf8')).toBe(installed);
    accountId = REGISTERED_ACCOUNT;
    const archived = await publishRegisteredSequenceLifecycleInMain('archive', request, context);
    expect(archived).toMatchObject({ id: REGISTERED_ID, tombstone: true, workspaceId: 1 });
    await expect(
      publishRegisteredSequenceLifecycleInMain('archive', request, context)
    ).resolves.toEqual(archived);
    expect(await readFile(f.paths.metaPath, 'utf8')).toBe(installed);
    expect(await readFile(f.paths.productPath, 'utf8')).toBe(f.beforeProduct);
    expect(
      publicationDb.prepare('SELECT * FROM org_registry_record_publications').all()
    ).toHaveLength(1);
    expect(
      publicationDb.prepare('SELECT * FROM lims_audit WHERE subject_id=?').all(REGISTERED_ID)
    ).toHaveLength(auditBefore + 2);
  });

  it('checks the current managed sequence adapter refresh without a database publication and refuses changed fields or lifecycle', async () => {
    const f = await registeredPackage();
    const save = await f.request('saved-before-reconcile', 'Saved name', 'AATC');
    await publishSequencePackageRevisionInMain(save, f.context);
    const checked = await readCheckedManagedSequenceRegistrySnapshot(f.context, {
      entityId: REGISTERED_ID,
      workspaceRoot: f.root,
      packageRoot: f.packageRoot,
    });
    const sender = Object.assign(new EventEmitter(), { id: 334645, isDestroyed: () => false });
    vi.mocked(ipcMain.handle).mockClear();
    registerLimsIpcHandlers();
    const handlers = new Map(vi.mocked(ipcMain.handle).mock.calls);
    async function invoke(channel: string, ...args: unknown[]) {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`Missing actual IPC handler ${channel}`);

      const result: unknown = Reflect.apply(handler, undefined, [{ sender }, ...args]);
      return result;
    }
    const update = (input: unknown, token: string) => invoke('lims:updateEntity', input, token);
    const release = await acquireWorkspaceMutationShared(f.root);
    const releaseSpy = vi.fn(release);
    const token = workspaceMutationCapabilities.issue(
      sender.id,
      workspaceMutationRootIdentity(f.root),
      releaseSpy
    );
    const input = {
      id: REGISTERED_ID,
      name: checked.entity.name,
      fields: checked.entity.fields,
      replaceFields: true,
      projectionSchema: {
        kind: checked.projection.kind,
        schemaRevisionId: checked.projection.schemaRevisionId,
        schemaSnapshot: checked.projection.schemaSnapshot,
      },
      registrationStatus: checked.entity.registrationStatus,
      domainStatus: checked.entity.domainStatus,
      workspaceId: checked.entity.workspaceId,
      actor: 'workspace-reconcile',
    };
    const before = {
      audit: f.auditCount(),
      publications: f.publications(),
      marker: await readFile(f.paths.metaPath, 'utf8'),
      product: await readFile(f.paths.productPath, 'utf8'),
    };
    try {
      await expect(update(input, token)).resolves.toEqual(checked.entity);
      await expect(update({ ...input, name: 'Unpublished change' }, token)).rejects.toThrow(
        /saved package|versioned Save|projection/i
      );
      await expect(
        update({ ...input, fields: { ...input.fields, privateField: 'Unpublished' } }, token)
      ).rejects.toThrow(/saved package|versioned Save|projection/i);
      for (const channel of ['lims:archiveEntity', 'lims:restoreEntity']) {
        await expect(
          invoke(
            channel,
            {
              id: REGISTERED_ID,
              expectedEventSeq: checked.entity.eventSeq,
              operationId: crypto.randomUUID(),
              actor: 'workspace-reconcile',
            },
            token
          )
        ).rejects.toThrow(/sequence package|versioned Save/i);
      }
      expect(releaseSpy).not.toHaveBeenCalled();
      expect({
        audit: f.auditCount(),
        publications: f.publications(),
        marker: await readFile(f.paths.metaPath, 'utf8'),
        product: await readFile(f.paths.productPath, 'utf8'),
      }).toEqual(before);
      await writeFile(f.paths.productPath, `${before.product}\nchanged outside the publisher`);
      await expect(update(input, token)).rejects.toThrow();
      expect(f.auditCount()).toBe(before.audit);
      expect(f.publications()).toEqual(before.publications);
    } finally {
      workspaceMutationCapabilities.release(token, sender.id);
    }
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    await expect(
      invoke('lims:revertEntity', {
        id: REGISTERED_ID,
        expectedEventSeq: checked.entity.eventSeq,
        operationId: crypto.randomUUID(),
      })
    ).rejects.toThrow(/sequence package|versioned Save/i);
  });

  it('keeps a version2 registration readable and binds its whole marker on the next actual Save', async () => {
    const f = await registeredPackage({ projectionVersion: 2 });
    expect(f.entity.fields._managedSequenceProjectionVersion).toBe(2);
    expect(f.entity.fields).not.toHaveProperty('_managedSequenceSnapshot');
    const saved = await f.request(
      'upgrade-whole-marker',
      'Saved with complete association',
      'AATC'
    );
    await publishSequencePackageRevisionInMain(saved, f.context);
    const marker = await readFile(f.paths.metaPath, 'utf8');
    const publications = f.publications();
    expect(publications).toHaveLength(1);
    expect(JSON.parse(publications[0].payload_json).fields).toMatchObject({
      _managedSequenceProjectionVersion: 3,
      _managedSequenceSnapshot: {
        version: 1,
        markerSha256: registeredHash(
          serializeSequencePackageDocument(parseSequencePackageDocument(marker))
        ),
      },
    });
    expect(
      f.db.prepare('SELECT id,workspace_id FROM lims_entity WHERE id=?').get(REGISTERED_ID)
    ).toEqual({
      id: REGISTERED_ID,
      workspace_id: 1,
    });
    expect(await readFile(f.paths.productPath, 'utf8')).toBe(saved.nextProductContent);
  });

  it('publishes two distinct saves and an old exact retry never republishes the newer package', async () => {
    const f = await registeredPackage();
    const first = await f.request('registered-one', 'First saved name', 'AATC');
    await publishSequencePackageRevisionInMain(first, f.context);
    const firstRows = f.publications();
    const firstMarker = await readFile(f.paths.metaPath, 'utf8');
    expect(firstRows).toHaveLength(1);
    expect(firstRows[0]).toMatchObject({
      operation_id: 'registered-one',
      publication_authority: 'sequence_package',
      status: 'ready',
    });
    expect(firstRows[0].publication_sha256).toBe(
      orgRegistrySequencePackagePublicationDigest({
        packageId: REGISTERED_ID,
        formatVersion: parseSequencePackageDocument(firstMarker).formatVersion,
        markerSha256: registeredHash(firstMarker).slice(7),
        productSha256: registeredHash(first.nextProductContent).slice(7),
      }).sha256
    );
    expect(JSON.parse(firstRows[0].payload_json)).toMatchObject({
      id: REGISTERED_ID,
      name: 'First saved name',
      archived: false,
    });
    expect(JSON.parse(firstRows[0].payload_json).fields).not.toHaveProperty(
      MANAGED_SEQUENCE_DOCUMENT_FIELD
    );
    const second = await f.request('registered-two', 'Second saved name', 'AATT');
    await publishSequencePackageRevisionInMain(second, f.context);
    const saved = await readFile(f.paths.metaPath, 'utf8');
    const count = f.auditCount();
    const rows = f.publications();
    expect(rows).toHaveLength(2);
    expect(rows[0].mutation_id).not.toBe(rows[1].mutation_id);
    expect((await publishSequencePackageRevisionInMain(first, f.context)).revisionId).toBe(
      'registered-one'
    );
    await recoverSequencePackageRevisionPublicationInMain(f.root, f.packageRoot, f.context);
    expect(f.publications()).toEqual(rows);
    expect(f.auditCount()).toBe(count);
    expect(await readFile(f.paths.metaPath, 'utf8')).toBe(saved);
    expect(await readFile(f.paths.productPath, 'utf8')).toBe(second.nextProductContent);
    expect(
      f.db.prepare('SELECT id,workspace_id FROM lims_entity WHERE id=?').get(REGISTERED_ID)
    ).toEqual({ id: REGISTERED_ID, workspace_id: 1 });
  });

  it('retains completed files across failed settlement and account changes, then exact recovery emits one event', async () => {
    const f = await registeredPackage();
    const input = await f.request('registered-interrupted', 'Saved before restart', 'AATC');
    let failSettlement = true;
    const interrupted = {
      ...f.context,
      getActiveAccountId: async () => {
        const marker = parseSequencePackageDocument(await readFile(f.paths.metaPath, 'utf8'));
        if (failSettlement && marker.name === 'Saved before restart')
          throw new Error('interrupted after pair installation');
        return REGISTERED_ACCOUNT;
      },
    };
    const beforeAudit = f.auditCount();
    await expect(publishSequencePackageRevisionInMain(input, interrupted)).rejects.toThrow(
      'interrupted after pair installation'
    );
    expect(await readFile(f.paths.productPath, 'utf8')).toBe(input.nextProductContent);
    expect(JSON.parse(await readFile(f.paths.revisionJournalPath, 'utf8'))).toMatchObject({
      state: 'complete',
      registeredPublication: { operationId: input.operationId },
    });
    expect(f.publications()).toEqual([]);
    expect(f.auditCount()).toBe(beforeAudit);
    f.setAccount('10000000-0000-4000-8000-000000000099');
    await expect(
      recoverSequencePackageRevisionPublicationInMain(f.root, f.packageRoot, f.context)
    ).rejects.toThrow(/account/i);
    expect(f.publications()).toEqual([]);
    failSettlement = false;
    f.setAccount(REGISTERED_ACCOUNT);
    await recoverSequencePackageRevisionPublicationInMain(f.root, f.packageRoot, f.context);
    expect(f.publications()).toHaveLength(1);
    expect(f.auditCount()).toBe(beforeAudit + 1);
    const receipt = f.publications()[0];
    await publishSequencePackageRevisionInMain(input, f.context);
    expect(f.publications()).toEqual([receipt]);
    expect(f.auditCount()).toBe(beforeAudit + 1);
  });

  it('aborts an interrupted invalid snapshot without making any organization mutation eligible', async () => {
    const f = await registeredPackage();
    const input = await f.request('registered-aborted', 'Aborted name', 'AATC');
    const original = packageFiles.writeWorkspaceTextFileAtomicInMain;
    const write = vi
      .spyOn(packageFiles, 'writeWorkspaceTextFileAtomicInMain')
      .mockImplementation(async (request, options) => {
        if (request.path === f.paths.metaPath && request.content.includes('Aborted name'))
          throw new Error('marker install interrupted');
        return original(request, options);
      });
    const beforeAudit = f.auditCount();
    await expect(publishSequencePackageRevisionInMain(input, f.context)).rejects.toThrow(
      'marker install interrupted'
    );
    write.mockRestore();
    const journal = JSON.parse(await readFile(f.paths.revisionJournalPath, 'utf8')) as {
      nextProductSnapshotPath: string;
    };
    await rm(fromPackageRelative(journal.nextProductSnapshotPath, f.packageRoot));
    await recoverSequencePackageRevisionPublicationInMain(f.root, f.packageRoot, f.context);
    expect(await readFile(f.paths.metaPath, 'utf8')).toBe(f.beforeMarker);
    expect(await readFile(f.paths.productPath, 'utf8')).toBe(f.beforeProduct);
    expect(JSON.parse(await readFile(f.paths.revisionJournalPath, 'utf8')).state).toBe('aborted');
    expect(f.publications()).toEqual([]);
    expect(f.auditCount()).toBe(beforeAudit);
  });

  it('refuses another account and unversioned writers before changing package bytes', async () => {
    const f = await registeredPackage();
    const input = await f.request('registered-denied', 'Denied name', 'AATC');
    f.setAccount(null);
    await expect(publishSequencePackageRevisionInMain(input, f.context)).rejects.toThrow(
      /account/i
    );
    expect(await readFile(f.paths.metaPath, 'utf8')).toBe(f.beforeMarker);
    expect(await readFile(f.paths.productPath, 'utf8')).toBe(f.beforeProduct);
    await expect(readFile(f.paths.revisionJournalPath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const bypass = vi.fn(async () => {
      await writeFile(f.paths.productPath, 'must not be written');
    });
    f.setAccount(REGISTERED_ACCOUNT);
    await expect(
      withRecoveredSequencePackageMutationInMain(f.root, f.packageRoot, bypass, f.context)
    ).rejects.toThrow(/versioned Save/i);
    expect(bypass).not.toHaveBeenCalled();
    const beforeAudit = f.auditCount();
    expect(() =>
      f.db.transaction(() => archiveLimsEntityInsideTx(f.db, { id: REGISTERED_ID }))()
    ).toThrow(/cannot yet be archived/i);
    expect(() =>
      f.db.transaction(() => revertLimsEntityInsideTx(f.db, { id: REGISTERED_ID }))()
    ).toThrow(/cannot yet be archived/i);
    expect(f.auditCount()).toBe(beforeAudit);
    expect(f.publications()).toEqual([]);
  });
});

describe('generic package writes and Claim share project admission', () => {
  it.each(['known', 'declared', 'parent'] as const)(
    'refuses a queued %s write after Claim enrolls, before changing any bytes',
    async (route) => {
      const f = await registeredPackage({ enrolled: false });
      const releaseClaim = await acquireWorkspaceMutationShared(f.root);
      const write = vi.fn(async () => writeFile(f.paths.productPath, 'untracked replacement'));
      const pending =
        route === 'declared'
          ? withDeclaredRendererFilesystemMutation({
              db: f.db,
              ownerId: 41,
              workspaceRoot: f.root,
              mutationPaths: [f.paths.productPath],
              operation: write,
            })
          : withKnownRendererFilesystemMutation({
              db: f.db,
              ownerId: 41,
              paths: [route === 'parent' ? f.root + '/..' : f.paths.productPath],
              operation: write,
            });

      const result = pending.then(
        () => null,
        (error: unknown) => error
      );
      try {
        expect(workspaceMutationWaiterCountForTest(f.root)).toBe(1);
        expect(write).not.toHaveBeenCalled();
        f.enroll();
      } finally {
        releaseClaim();
      }
      expect(await result).toEqual(
        expect.objectContaining({ message: expect.stringMatching(/versioned Save/i) })
      );
      expect(write).not.toHaveBeenCalled();
      expect(await readFile(f.paths.productPath, 'utf8')).toBe(f.beforeProduct);
      expect(await readFile(f.paths.metaPath, 'utf8')).toBe(f.beforeMarker);
      expect(f.publications()).toEqual([]);
    }
  );

  it('lets an earlier capability-owned write finish before Claim rechecks the bytes', async () => {
    const f = await registeredPackage({ enrolled: false });
    const releaseWriter = await acquireWorkspaceMutationShared(f.root);
    const token = workspaceMutationCapabilities.issue(
      41,
      workspaceMutationRootIdentity(f.root),
      releaseWriter
    );
    let claimEntered = false;
    const claim = withWorkspaceMutation(f.root, async () => {
      claimEntered = true;
      await readCheckedManagedSequenceRegistrySnapshot(f.context, {
        entityId: REGISTERED_ID,
        workspaceRoot: f.root,
        packageRoot: f.packageRoot,
      });
      f.enroll();
    });
    const result = claim.then(
      () => null,
      (error: unknown) => error
    );
    try {
      expect(workspaceMutationWaiterCountForTest(f.root)).toBe(1);
      await withKnownRendererFilesystemMutation({
        db: f.db,
        ownerId: 41,
        paths: [f.paths.productPath],
        mutationToken: token,
        operation: () => writeFile(f.paths.productPath, 'externally edited product'),
      });
      expect(claimEntered).toBe(false);
    } finally {
      workspaceMutationCapabilities.release(token, 41);
    }
    expect(await result).toBeInstanceOf(Error);
    expect(claimEntered).toBe(true);
    expect(await readFile(f.paths.productPath, 'utf8')).toBe('externally edited product');
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM org_registry_local_records').get()).toEqual({
      n: 0,
    });
    expect(f.publications()).toEqual([]);
  });

  it.each(['known', 'declared'] as const)(
    'refuses an enrolled package through an existing %s renderer capability',
    async (route) => {
      const f = await registeredPackage();
      const release = await acquireWorkspaceMutationShared(f.root);
      const token = workspaceMutationCapabilities.issue(
        41,
        workspaceMutationRootIdentity(f.root),
        release
      );
      const write = vi.fn(async () => writeFile(f.paths.productPath, 'untracked replacement'));
      try {
        const pending =
          route === 'known'
            ? withKnownRendererFilesystemMutation({
                db: f.db,
                ownerId: 41,
                paths: [f.paths.productPath],
                mutationToken: token,
                operation: write,
              })
            : withDeclaredRendererFilesystemMutation({
                db: f.db,
                ownerId: 41,
                workspaceRoot: f.root,
                mutationPaths: [f.paths.productPath],
                mutationToken: token,
                operation: write,
              });
        await expect(pending).rejects.toThrow(/versioned Save/i);
        expect(write).not.toHaveBeenCalled();
        expect(workspaceMutationWaiterCountForTest(f.root)).toBe(0);
      } finally {
        workspaceMutationCapabilities.release(token, 41);
      }
      expect(await readFile(f.paths.productPath, 'utf8')).toBe(f.beforeProduct);
      expect(f.publications()).toEqual([]);
    }
  );
});

describe('explicit filesystem capability refusal', () => {
  it.each(['known project', 'outside project'] as const)(
    'does not replace an invalid supplied token with new authority for a %s',
    async (target) => {
      const f = await registeredPackage({ enrolled: false });
      const write = vi.fn(async () => writeFile(f.paths.productPath, 'must not be written'));
      await expect(
        withKnownRendererFilesystemMutation({
          db: f.db,
          ownerId: 41,
          mutationToken: 'never-issued',
          paths: [target === 'known project' ? f.paths.productPath : f.root + '-outside'],
          operation: write,
        })
      ).rejects.toThrow('WORKSPACE_MUTATION_TOKEN_INVALID');
      expect(write).not.toHaveBeenCalled();
      expect(await readFile(f.paths.productPath, 'utf8')).toBe(f.beforeProduct);
      expect(workspaceMutationWaiterCountForTest(f.root)).toBe(0);
    }
  );
});

const resolutionScope = {
  orgId: REGISTERED_ORG,
  accountId: REGISTERED_ACCOUNT,
  clientId: 'desktop:package-test',
};
const resolutionGeneration = `home-v1:${'4'.repeat(64)}`;
async function preparePackageResolution(f: Awaited<ReturnType<typeof registeredPackage>>) {
  const mutationId = '80000000-0000-4000-8000-000000000041';
  const canonical = {
    ...f.claim.payload,
    id: REGISTERED_ID,
    orgId: REGISTERED_ORG,
    revision: 1,
    archivedAt: null,
  };
  const snapshot = (entity: Record<string, unknown>) => ({
    idSchemes: [],
    schemas: [],
    schemaRevisions: [],
    entities: [entity],
    entityRevisions: [],
    relationships: [],
    placements: [],
  });
  replaceOrgRegistrySnapshot(f.db, {
    ...resolutionScope,
    cursor: 1,
    accessGeneration: resolutionGeneration,
    now: 1,
    snapshot: snapshot(canonical),
  });
  enqueueOrgRegistryMutation(f.db, {
    ...resolutionScope,
    mutationId,
    operation: 'entity.create',
    payload: f.claim.payload,
    now: 1,
  });
  acknowledgeOrgRegistryMutation(f.db, {
    ...resolutionScope,
    mutationId,
    now: 2,
    receipt: {
      status: 'applied',
      eventSeq: 1,
      mutationId,
      accessGeneration: resolutionGeneration,
      entityId: REGISTERED_ID,
      homeWorkspaceId: REGISTERED_REMOTE,
      entity: canonical,
    },
  });
  replaceOrgRegistrySnapshot(f.db, {
    ...resolutionScope,
    cursor: 2,
    accessGeneration: resolutionGeneration,
    now: 3,
    snapshot: snapshot({ ...canonical, revision: 2, name: 'Organization name' }),
  });
  const checked = await readCheckedOrganizationRecordReview(
    f.db,
    { ...resolutionScope, entityId: REGISTERED_ID },
    async () => {
      if ((await f.context.getActiveAccountId()) !== REGISTERED_ACCOUNT)
        throw new Error('Account changed');
    }
  );
  const resolutionId = randomUUID();
  return {
    ...resolutionScope,
    entityId: REGISTERED_ID,
    resolutionId,
    operationId: `org-record-resolution:${resolutionId}`,
    choice: 'keep_saved' as const,
    sourceRevision: checked.displayed.sourceRevision,
    review: checked.review,
  };
}

describe('managed Keep saved retains approval before journal and settles exact original bytes', () => {
  it('reopens an approval with no journal, refuses a changed retry, then regrant settles the original pair and base exactly once', async () => {
    const f = await registeredPackage({ persistent: true });
    const request = await preparePackageResolution(f);
    const write = packageFiles.writeWorkspaceTextFileAtomicInMain;
    const blocker = vi
      .spyOn(packageFiles, 'writeWorkspaceTextFileAtomicInMain')
      .mockImplementation(async (input, options) => {
        if (input.path === f.paths.revisionJournalPath)
          throw new Error('Interrupted before sequence journal');
        return write(input, options);
      });
    await expect(
      publishReviewedSequencePackageResolution(f.context, {
        workspaceRoot: f.root,
        packageRoot: f.packageRoot,
        request,
        verifiedAccessGeneration: resolutionGeneration,
      })
    ).rejects.toThrow('Interrupted before sequence journal');
    expect(await readFile(f.paths.metaPath, 'utf8')).toBe(f.beforeMarker);
    expect(await readFile(f.paths.productPath, 'utf8')).toBe(f.beforeProduct);
    expect(
      f.db
        .prepare('SELECT status,publication_request_json FROM org_registry_record_resolutions')
        .get()
    ).toMatchObject({ status: 'prepared', publication_request_json: expect.any(String) });
    expect(f.publications()).toEqual([]);
    blocker.mockRestore();
    f.db.close();
    publicationDb = openFileTestDb(f.databasePath);
    const context = { ...f.context, db: publicationDb };
    const verified = { ...request, verifiedAccessGeneration: resolutionGeneration };
    expect(readPendingSequenceKeepSavedIdentity(publicationDb, verified)).toMatchObject({
      sourceRevision: request.sourceRevision,
    });
    await expect(
      resumeReviewedSequencePackageResolution(context, { ...verified, choice: 'use_remote' })
    ).rejects.toThrow(/choice/);
    await expect(
      resumeReviewedSequencePackageResolution(context, {
        ...verified,
        sourceRevision: '0'.repeat(64),
      })
    ).rejects.toThrow(/source/);
    f.setAccount('10000000-0000-4000-8000-000000000099');
    await expect(resumeReviewedSequencePackageResolution(context, verified)).rejects.toThrow(
      /account/
    );
    f.setAccount(REGISTERED_ACCOUNT);
    publicationDb.prepare("UPDATE org_registry_sync_state SET status='access_revoked'").run();
    await expect(resumeReviewedSequencePackageResolution(context, verified)).rejects.toThrow(
      /access/
    );
    const generation = `home-v1:${'9'.repeat(64)}`;
    replaceOrgRegistrySnapshot(publicationDb, {
      ...resolutionScope,
      cursor: 3,
      accessGeneration: generation,
      now: 5,
      snapshot: {
        idSchemes: [],
        schemas: [],
        schemaRevisions: [],
        entities: [{ ...request.review.canonical, revision: 3, name: 'Newer organization name' }],
        entityRevisions: [],
        relationships: [],
        placements: [],
      },
    });
    publicationDb.prepare("UPDATE workspace_sync_bindings SET access_role='viewer'").run();
    expect(
      readPendingSequenceKeepSavedIdentity(publicationDb, {
        ...verified,
        verifiedAccessGeneration: generation,
      })
    ).toMatchObject({ choice: 'keep_saved', sourceRevision: request.sourceRevision });
    await expect(
      resumeReviewedSequencePackageResolution(context, {
        ...verified,
        verifiedAccessGeneration: generation,
      })
    ).rejects.toThrow();
    publicationDb.prepare("UPDATE workspace_sync_bindings SET access_role='manager'").run();
    const resolved = await resumeReviewedSequencePackageResolution(context, {
      ...verified,
      verifiedAccessGeneration: generation,
    });
    expect(resolved).toMatchObject({
      replayed: true,
      entity: { id: REGISTERED_ID, name: f.entity.name, workspaceId: 1 },
    });
    expect(resolved!.entity.eventSeq).toBeGreaterThan(f.entity.eventSeq!);
    expect(await readFile(f.paths.metaPath, 'utf8')).toBe(f.beforeMarker);
    expect(await readFile(f.paths.productPath, 'utf8')).toBe(f.beforeProduct);
    expect(
      readReadyOrgRegistryRecordMutations(publicationDb, { ...resolutionScope, now: 6 })[0].payload
    ).toMatchObject({ expectedRevision: 2, name: f.entity.name });
    const later = await f.request('after-resolution', 'Later saved version', 'AATT');
    await publishSequencePackageRevisionInMain(later, context);
    const laterMarker = await readFile(f.paths.metaPath, 'utf8');
    await expect(
      resumeReviewedSequencePackageResolution(context, {
        ...verified,
        verifiedAccessGeneration: generation,
      })
    ).resolves.toEqual(resolved);
    expect(await readFile(f.paths.metaPath, 'utf8')).toBe(laterMarker);
    expect(await readFile(f.paths.productPath, 'utf8')).toBe(later.nextProductContent);
  });

  it('retains a completed pair journal before SQL settlement and requires the same approved retry', async () => {
    const f = await registeredPackage();
    const request = await preparePackageResolution(f);
    const interrupted = {
      ...f.context,
      getActiveAccountId: async () => {
        let state: string | undefined;
        try {
          state = JSON.parse(await readFile(f.paths.revisionJournalPath, 'utf8')).state;
        } catch {}
        if (state === 'complete') throw new Error('Interrupted after completed sequence journal');
        return REGISTERED_ACCOUNT;
      },
    };
    await expect(
      publishReviewedSequencePackageResolution(interrupted, {
        workspaceRoot: f.root,
        packageRoot: f.packageRoot,
        request,
        verifiedAccessGeneration: resolutionGeneration,
      })
    ).rejects.toThrow('Interrupted after completed sequence journal');
    expect(JSON.parse(await readFile(f.paths.revisionJournalPath, 'utf8'))).toMatchObject({
      state: 'complete',
      operationId: request.operationId,
    });
    expect(f.db.prepare('SELECT status FROM org_registry_record_resolutions').get()).toEqual({
      status: 'prepared',
    });
    expect(f.publications()).toEqual([]);
    await recoverSequencePackageRevisionPublicationInMain(f.root, f.packageRoot, f.context);
    expect(f.publications()).toEqual([]);
    const result = await resumeReviewedSequencePackageResolution(f.context, {
      ...request,
      verifiedAccessGeneration: resolutionGeneration,
    });
    expect(result).toMatchObject({ replayed: true });
    expect(f.publications()).toHaveLength(1);
    expect(f.publications()[0]).toMatchObject({
      operation_id: request.operationId,
      status: 'ready',
      publication_authority: 'sequence_package',
    });
    expect(await readFile(f.paths.metaPath, 'utf8')).toBe(f.beforeMarker);
    expect(await readFile(f.paths.productPath, 'utf8')).toBe(f.beforeProduct);
  });

  it('refuses changed raw marker or unavailable remote snapshot before approval and never reconstructs sequence bytes', async () => {
    const f = await registeredPackage();
    const request = await preparePackageResolution(f);
    const audit = f.auditCount();
    await expect(
      publishReviewedSequencePackageResolution(f.context, {
        workspaceRoot: f.root,
        packageRoot: f.packageRoot,
        request: { ...request, choice: 'use_remote' },
        verifiedAccessGeneration: resolutionGeneration,
      })
    ).rejects.toMatchObject({ code: 'SAVED_VERSION_UNAVAILABLE' });
    await writeFile(f.paths.metaPath, f.beforeMarker + '\n');
    await expect(
      publishReviewedSequencePackageResolution(f.context, {
        workspaceRoot: f.root,
        packageRoot: f.packageRoot,
        request,
        verifiedAccessGeneration: resolutionGeneration,
      })
    ).rejects.toMatchObject({ code: 'REVIEW_CHANGED' });
    expect(f.db.prepare('SELECT COUNT(*) FROM org_registry_record_resolutions').pluck().get()).toBe(
      0
    );
    expect(f.auditCount()).toBe(audit);
    expect(await readFile(f.paths.metaPath, 'utf8')).toBe(f.beforeMarker + '\n');
    expect(await readFile(f.paths.productPath, 'utf8')).toBe(f.beforeProduct);
  });
});

async function completeSequenceOrganizationChoice(
  f: Awaited<ReturnType<typeof registeredPackage>>,
  archived = false
) {
  await preparePackageResolution(f);
  const save = await f.request('organization-saved', 'Saved organization sequence', 'AATT');
  if (archived) save.nextDocument.entity.lifecycle = { archived: true, archivedAt: 1100 };
  const prepared = await prepareSequencePackageRevision({
    current: parseSequencePackageDocument(f.beforeMarker),
    currentProductContent: f.beforeProduct,
    next: save.nextDocument,
    nextProductContent: save.nextProductContent,
    kind: 'sequence-save',
    operationId: save.operationId,
    revisionId: save.revisionId,
  });
  const markerContent = serializeSequencePackageDocument(prepared.document);
  const projected = await projectManagedSequenceRegistry(
    prepared.document,
    await readSequenceProductSummary(save.nextProductContent)
  );
  const canonical = {
    ...f.claim.payload,
    name: projected.name,
    fields: projected.fields,
    orgId: REGISTERED_ORG,
    revision: 2,
    archivedAt: archived ? 2200 : null,
  };
  replaceOrgRegistrySnapshot(f.db, {
    ...resolutionScope,
    cursor: 2,
    accessGeneration: resolutionGeneration,
    now: 4,
    snapshot: {
      idSchemes: [],
      schemas: [],
      schemaRevisions: [],
      entities: [canonical],
      entityRevisions: [],
      relationships: [],
      placements: [],
    },
  });
  const checked = await readCheckedOrganizationRecordReview(
    f.db,
    { ...resolutionScope, entityId: REGISTERED_ID },
    async () => {}
  );
  const resolutionId = randomUUID();
  const request = {
    ...resolutionScope,
    entityId: REGISTERED_ID,
    resolutionId,
    operationId: `org-record-resolution:${resolutionId}`,
    choice: 'use_remote' as const,
    sourceRevision: checked.displayed.sourceRevision,
    review: checked.review,
  };
  const members = await Promise.all(
    prepared.document.members.map(async (member) => {
      const staged = prepared.snapshots.find((snapshot) => snapshot.path === member.path);
      const content = staged
        ? Buffer.from(staged.content)
        : await readFile(fromPackageRelative(member.path, f.packageRoot));
      return {
        path: member.path,
        contentSha256: registeredHash(content).slice(7),
        contentBase64: content.toString('base64'),
      };
    })
  );
  const organizationSnapshot = {
    schema: 'dnaforge.organization-saved-sequence.v1' as const,
    accountId: REGISTERED_ACCOUNT,
    orgId: REGISTERED_ORG,
    entityId: REGISTERED_ID,
    homeWorkspaceId: REGISTERED_REMOTE,
    schemaRevisionId: f.claim.payload.schemaRevisionId,
    organizationRevision: 2,
    projectVersionId: randomUUID(),
    projectVersionSha256: 'b'.repeat(64),
    markerRelativePath: 'saved-package/.forge/plasmid.json',
    markerContent,
    markerSha256: registeredHash(markerContent).slice(7),
    productContent: save.nextProductContent,
    productSha256: registeredHash(save.nextProductContent).slice(7),
    members,
  };
  return { request, organizationSnapshot, prepared };
}

describe('managed Use organization restores the complete approved saved package', () => {
  it('keeps exact saved archive state through Use organization, a later Keep saved and replay', async () => {
    const f = await registeredPackage();
    const choice = await completeSequenceOrganizationChoice(f, true);
    const result = await publishReviewedSequencePackageResolution(f.context, {
      workspaceRoot: f.root,
      packageRoot: f.packageRoot,
      ...choice,
      verifiedAccessGeneration: resolutionGeneration,
    });
    expect(result.entity).toMatchObject({
      id: REGISTERED_ID,
      workspaceId: 1,
      tombstone: true,
      archivedAt: 1100,
    });
    expect(await readFile(f.paths.metaPath, 'utf8')).toBe(
      choice.organizationSnapshot.markerContent
    );
    expect(f.publications()).toEqual([]);
    replaceOrgRegistrySnapshot(f.db, {
      ...resolutionScope,
      cursor: 3,
      accessGeneration: resolutionGeneration,
      now: 5,
      snapshot: {
        idSchemes: [],
        schemas: [],
        schemaRevisions: [],
        entityRevisions: [],
        relationships: [],
        placements: [],
        entities: [{ ...choice.request.review.canonical, revision: 3, archivedAt: null }],
      },
    });
    const checked = await readCheckedOrganizationRecordReview(
      f.db,
      { ...resolutionScope, entityId: REGISTERED_ID },
      async () => {}
    );
    expect(checked.displayed.local.archived).toBe(true);
    expect(checked.displayed.organization.archived).toBe(false);
    const resolutionId = randomUUID();
    const request = {
      ...resolutionScope,
      entityId: REGISTERED_ID,
      resolutionId,
      operationId: `org-record-resolution:${resolutionId}`,
      choice: 'keep_saved' as const,
      sourceRevision: checked.displayed.sourceRevision,
      review: checked.review,
    };
    const kept = await publishReviewedSequencePackageResolution(f.context, {
      workspaceRoot: f.root,
      packageRoot: f.packageRoot,
      request,
      verifiedAccessGeneration: resolutionGeneration,
    });
    expect(kept.entity).toMatchObject({
      id: REGISTERED_ID,
      workspaceId: 1,
      tombstone: true,
      archivedAt: 1100,
    });
    expect(await readFile(f.paths.metaPath, 'utf8')).toBe(
      choice.organizationSnapshot.markerContent
    );
    expect(await readFile(f.paths.productPath, 'utf8')).toBe(
      choice.organizationSnapshot.productContent
    );
    expect(f.publications()).toHaveLength(1);
    expect(JSON.parse(f.publications()[0].payload_json)).toMatchObject({
      id: REGISTERED_ID,
      archived: true,
    });
    const audit = f.auditCount();
    expect(
      await resumeReviewedSequencePackageResolution(f.context, {
        ...request,
        verifiedAccessGeneration: resolutionGeneration,
      })
    ).toEqual({ ...kept, replayed: true });
    expect(f.publications()).toHaveLength(1);
    expect(f.auditCount()).toBe(audit);
  });

  it('installs exact marker, product and immutable members with the same UUID/home and no outbound echo', async () => {
    const f = await registeredPackage();
    const choice = await completeSequenceOrganizationChoice(f);
    const beforeAudit = f.auditCount();
    const result = await publishReviewedSequencePackageResolution(f.context, {
      workspaceRoot: f.root,
      packageRoot: f.packageRoot,
      ...choice,
      verifiedAccessGeneration: resolutionGeneration,
    });
    expect(result).toMatchObject({
      replayed: false,
      entity: { id: REGISTERED_ID, workspaceId: 1, name: 'Saved organization sequence' },
    });
    expect(await readFile(f.paths.metaPath, 'utf8')).toBe(
      choice.organizationSnapshot.markerContent
    );
    expect(await readFile(f.paths.productPath, 'utf8')).toBe(
      choice.organizationSnapshot.productContent
    );
    for (const member of choice.organizationSnapshot.members)
      expect(await readFile(fromPackageRelative(member.path, f.packageRoot))).toEqual(
        Buffer.from(member.contentBase64, 'base64')
      );
    expect(f.publications()).toEqual([]);
    expect(readReadyOrgRegistryRecordMutations(f.db, { ...resolutionScope, now: 5 })).toEqual([]);
    expect(f.auditCount()).toBe(beforeAudit + 1);
    expect(
      readOrgRegistryRecordSyncStatus(f.db, { ...resolutionScope, entityId: REGISTERED_ID })
    ).toMatchObject({
      acknowledgedRevision: 1,
      baseRevision: 2,
      baseProvenance: 'reviewed_remote',
    });
    expect(
      readOrgRegistryRecordReview(f.db, { ...resolutionScope, entityId: REGISTERED_ID })?.base
    ).toMatchObject({ provenance: 'reviewed_remote', revision: 2 });
    expect(f.db.prepare('SELECT choice,status FROM org_registry_record_resolutions').get()).toEqual(
      { choice: 'use_remote', status: 'settled' }
    );
    expect(
      await resumeReviewedSequencePackageResolution(f.context, {
        ...choice.request,
        verifiedAccessGeneration: resolutionGeneration,
      })
    ).toEqual({ ...result, replayed: true });
    expect(f.auditCount()).toBe(beforeAudit + 1);
  });

  it('retains the exact approval before journal creation and retries without another download', async () => {
    const f = await registeredPackage({ persistent: true });
    const choice = await completeSequenceOrganizationChoice(f);
    const write = packageFiles.writeWorkspaceTextFileAtomicInMain;
    const blocker = vi
      .spyOn(packageFiles, 'writeWorkspaceTextFileAtomicInMain')
      .mockImplementation(async (input, options) => {
        if (input.path === f.paths.revisionJournalPath)
          throw new Error('Interrupted before approved remote journal');
        return write(input, options);
      });
    await expect(
      publishReviewedSequencePackageResolution(f.context, {
        workspaceRoot: f.root,
        packageRoot: f.packageRoot,
        ...choice,
        verifiedAccessGeneration: resolutionGeneration,
      })
    ).rejects.toThrow('Interrupted before approved remote journal');
    blocker.mockRestore();
    expect(await readFile(f.paths.metaPath, 'utf8')).toBe(f.beforeMarker);
    expect(await readFile(f.paths.productPath, 'utf8')).toBe(f.beforeProduct);
    f.db.close();
    publicationDb = openFileTestDb(f.databasePath);
    const context = { ...f.context, db: publicationDb };
    const verified = { ...choice.request, verifiedAccessGeneration: resolutionGeneration };
    expect(readPendingSequenceKeepSavedIdentity(publicationDb, verified)).toMatchObject({
      choice: 'use_remote',
    });
    expect(await resumeReviewedSequencePackageResolution(context, verified)).toMatchObject({
      replayed: true,
      entity: { id: REGISTERED_ID, name: 'Saved organization sequence' },
    });
    expect(await readFile(f.paths.metaPath, 'utf8')).toBe(
      choice.organizationSnapshot.markerContent
    );
    expect(
      publicationDb.prepare('SELECT COUNT(*) FROM org_registry_record_publications').pluck().get()
    ).toBe(0);
  });
});
