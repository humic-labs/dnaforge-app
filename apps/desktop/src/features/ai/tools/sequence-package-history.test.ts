import { describe, expect, it, vi } from 'vitest';
import {
  listManagedGenBankAnnotations,
  parseGenBankFull,
  serializeSequenceForInPlaceSave,
} from '@waypoint/sequence-utils';
import type { SequencePackageHistoryIndex } from '../../../db/sequence-package-history-io';
import type {
  SequencePackageEvidenceRun,
  SequencePackageRevision,
} from '../../../db/sequence-package';
import {
  createApplySequencePackageRestoreTool as originalCreateApplySequencePackageRestoreTool,
  createGetSequencePackageHistoryTool as originalCreateGetSequencePackageHistoryTool,
  createPreviewSequencePackageRestoreTool as originalCreatePreviewSequencePackageRestoreTool,
  createReadSequencePackageHistoryItemTool as originalCreateReadSequencePackageHistoryItemTool,
  createReadSequencePackageEvidenceRunTool as originalCreateReadSequencePackageEvidenceRunTool,
  type SequencePackageHistoryToolDependencies,
} from './sequence-package-history';
import { checkedSequenceToolFactory } from '../../../test-utils/sequence-output-test-helper';
import {
  getSequencePackageHistoryOutputSchema,
  readSequencePackageHistoryItemOutputSchema,
  readSequencePackageEvidenceRunOutputSchema,
  previewSequencePackageRestoreOutputSchema,
  applySequencePackageRestoreOutputSchema,
} from './sequence-output-schemas';
const createGetSequencePackageHistoryTool = checkedSequenceToolFactory(
  originalCreateGetSequencePackageHistoryTool,
  getSequencePackageHistoryOutputSchema
);
const createReadSequencePackageHistoryItemTool = checkedSequenceToolFactory(
  originalCreateReadSequencePackageHistoryItemTool,
  readSequencePackageHistoryItemOutputSchema
);
const createReadSequencePackageEvidenceRunTool = checkedSequenceToolFactory(
  originalCreateReadSequencePackageEvidenceRunTool,
  readSequencePackageEvidenceRunOutputSchema
);
const createPreviewSequencePackageRestoreTool = checkedSequenceToolFactory(
  originalCreatePreviewSequencePackageRestoreTool,
  previewSequencePackageRestoreOutputSchema
);
const createApplySequencePackageRestoreTool = checkedSequenceToolFactory(
  originalCreateApplySequencePackageRestoreTool,
  applySequencePackageRestoreOutputSchema
);

const oldRevision = {
  id: 'revision-old',
  parentId: null,
  operationId: 'operation-old',
  kind: 'metadata-update',
  createdAt: '2026-09-01T00:00:00.000Z',
  productSnapshot: { path: 'contents/old.gb', sha256: `sha256:${'a'.repeat(64)}` },
  state: {
    name: 'Earlier name',
    product: { file: 'product.gb', topology: 'linear' },
    entity: {
      fields: { label: 'Earlier value' },
      schema: { fields: [{ key: 'label', label: 'Label' }] },
      domainStatus: 'active',
      relationships: [],
    },
    acceptedAssembly: null,
  },
} as unknown as SequencePackageRevision;

const currentRevision = {
  ...oldRevision,
  id: 'revision-current',
  parentId: oldRevision.id,
  operationId: 'operation-current',
  createdAt: '2026-09-02T00:00:00.000Z',
  state: {
    ...oldRevision.state,
    name: 'Current name',
    entity: { ...oldRevision.state.entity, fields: { label: 'Current value' } },
  },
} as SequencePackageRevision;

const index = {
  packageRoot: '/workspace/example-package',
  markerPath: '/workspace/example-package/.forge/plasmid.json',
  productPath: '/workspace/example-package/product.gb',
  currentProductStatus: 'verified',
  legacyCurrentHasNoSnapshot: false,
  document: {
    id: 'package-one',
    name: 'Current name',
    product: { file: 'product.gb', topology: 'linear' },
    userAttachments: {},
    entity: currentRevision.state.entity,
    versionHistory: {
      headId: currentRevision.id,
      revisions: [oldRevision, currentRevision],
    },
  },
} as unknown as SequencePackageHistoryIndex;

function dependencies(): SequencePackageHistoryToolDependencies {
  return {
    resolveIndex: vi.fn(async () => ({ index, workspaceRoot: '/workspace' })),
    readRevision: vi.fn(async () => ({
      status: 'unavailable',
      revision: oldRevision,
      reason: 'Snapshot file is missing.',
    })),
    readEvidence: vi.fn(async () => {
      throw new Error('No evidence in this test package.');
    }),
    previewRestore: vi.fn(async () => ({
      previewFingerprint: `sha256:${'b'.repeat(64)}`,
      currentHeadId: currentRevision.id,
      currentMarkerSha256: `sha256:${'c'.repeat(64)}`,
      currentProductSha256: `sha256:${'d'.repeat(64)}`,
      selectedSources: {
        'field:label': { revisionId: oldRevision.id, valueSha256: `sha256:${'e'.repeat(64)}` },
      },
      changedItems: ['field:label'],
      blockers: [],
      warnings: [],
    })),
  };
}

const toolOptions = { toolCallId: 'test-call', messages: [] };

describe('sequence package History agent tools', () => {
  it('discovers and reads verified package evidence without exposing local paths', async () => {
    const run: SequencePackageEvidenceRun = {
      id: 'run-one',
      sessionId: 'session-one',
      createdAt: '2026-09-03T00:00:00Z',
      status: 'completed',
      reference: {
        artifact: {
          path: 'contents/evidence/run-one/reference.gb',
          sha256: `sha256:${'a'.repeat(64)}`,
        },
        sequenceRevision: 'reference-one',
        topology: 'linear',
        checkpointId: 'revision-old',
      },
      queries: [
        {
          id: 'query-one',
          label: 'Read one',
          artifact: {
            path: 'contents/evidence/run-one/query-0.ab1',
            sha256: `sha256:${'b'.repeat(64)}`,
          },
        },
      ],
      result: { path: 'contents/evidence/run-one/result.json', sha256: `sha256:${'c'.repeat(64)}` },
    };
    const withEvidence = {
      ...index,
      document: { ...index.document, evidenceRuns: [run] },
    } as SequencePackageHistoryIndex;
    const deps = dependencies();
    deps.resolveIndex = vi.fn(async () => ({ index: withEvidence, workspaceRoot: '/workspace' }));
    deps.readEvidence = vi.fn(async () => ({
      status: 'available' as const,
      run,
      result: {},
      states: [
        {
          tracks: [
            {
              queryId: 'query-one',
              status: 'pass',
              userStatus: 'variants',
              mutations: [{ id: 'mutation-one' }],
            },
          ],
        },
      ],
    }));
    const discovered = await createGetSequencePackageHistoryTool([], deps).execute!(
      { documentId: 'package-one' },
      toolOptions
    );
    expect(discovered).toMatchObject({
      ok: true,
      evidenceRuns: [{ runId: 'run-one', checkpointId: 'revision-old' }],
    });
    const inspected = await createReadSequencePackageEvidenceRunTool([], deps).execute!(
      { documentId: 'package-one', runId: 'run-one', queryId: 'query-one' },
      toolOptions
    );
    expect(inspected).toMatchObject({
      ok: true,
      artifactStatus: 'verified',
      latestReview: [
        {
          queryId: 'query-one',
          userStatus: 'variants',
          mutationCount: 1,
        },
      ],
    });
    expect(JSON.stringify(inspected)).not.toContain('/workspace/');
  });
  it('discovers bounded stable items and revisions without exposing private package paths', async () => {
    const deps = dependencies();
    const result = await createGetSequencePackageHistoryTool([], deps).execute!(
      { documentId: 'package-one', revisionLimit: 1 },
      toolOptions
    );

    expect(result).toMatchObject({
      ok: true,
      documentId: 'package-one',
      currentHeadId: 'revision-current',
      revisions: [{ revisionId: 'revision-current' }],
      items: expect.arrayContaining([
        expect.objectContaining({ itemId: 'field:label', label: 'Label' }),
      ]),
    });
    expect(JSON.stringify(result)).not.toContain('/workspace/');
  });

  it('reads a metadata-only historical item even when its product snapshot is unavailable', async () => {
    const deps = dependencies();
    const result = await createReadSequencePackageHistoryItemTool([], deps).execute!(
      { documentId: 'package-one', revisionId: 'revision-old', itemId: 'field:label' },
      toolOptions
    );

    expect(result).toMatchObject({
      ok: true,
      documentId: 'package-one',
      revisionId: 'revision-old',
      itemId: 'field:label',
      present: true,
      value: 'Earlier value',
    });
    expect(deps.readRevision).not.toHaveBeenCalled();
  });

  it('reads one historical annotation from verified product bytes, not its label-only manifest', async () => {
    const annotationId = '550e8400-e29b-41d4-a716-446655440000';
    const content = serializeSequenceForInPlaceSave(
      {
        id: 'package-one',
        name: 'Example',
        sequence: 'AACC',
        length: 4,
        circular: false,
        annotations: [
          {
            name: 'Recorded feature',
            type: 'misc_feature',
            start: 1,
            end: 2,
            direction: 1,
            qualifiers: { dnaforge_ann_id: [annotationId], note: ['Verified qualifier'] },
          },
        ],
      },
      'product.gb'
    );
    expect(listManagedGenBankAnnotations(content)).toMatchObject([{ id: annotationId }]);
    expect(parseGenBankFull(content).annotations[0].qualifiers?.dnaforge_ann_id).toContain(
      annotationId
    );
    expect(globalThis.crypto.subtle).toBeDefined();
    const withAnnotation = {
      ...index,
      document: {
        ...index.document,
        versionHistory: {
          ...index.document.versionHistory,
          revisions: [
            {
              ...oldRevision,
              state: {
                ...oldRevision.state,
                annotationItems: [{ id: annotationId, label: 'Recorded feature' }],
              },
            },
          ],
        },
      },
    } as SequencePackageHistoryIndex;
    const deps = dependencies();
    deps.resolveIndex = vi.fn(async () => ({ index: withAnnotation, workspaceRoot: '/workspace' }));
    deps.readRevision = vi.fn(async () => ({
      status: 'available' as const,
      revision: oldRevision,
      content,
    }));
    const result = await createReadSequencePackageHistoryItemTool([], deps).execute!(
      {
        documentId: 'package-one',
        revisionId: 'revision-old',
        itemId: `annotation:${annotationId}`,
      },
      toolOptions
    );
    expect(result, JSON.stringify(result)).toMatchObject({
      ok: true,
      present: true,
      value: {
        name: 'Recorded feature',
        qualifiers: { note: ['Verified qualifier'] },
      },
    });
    expect(result).toHaveProperty('valueSha256', expect.stringMatching(/^sha256:[a-f0-9]{64}$/));
  });

  it('previews exact selections through native authority without writing', async () => {
    const deps = dependencies();
    const selections = [{ itemId: 'field:label', revisionId: 'revision-old' }];
    const result = await createPreviewSequencePackageRestoreTool([], deps).execute!(
      { documentId: 'package-one', selections },
      toolOptions
    );

    expect(deps.previewRestore).toHaveBeenCalledWith({
      workspaceRoot: '/workspace',
      packageRoot: index.packageRoot,
      packageId: 'package-one',
      selections,
    });
    expect(result).toMatchObject({
      ok: true,
      previewFingerprint: `sha256:${'b'.repeat(64)}`,
      changedItems: ['field:label'],
      blockers: [],
    });
  });

  it('rejects physical paths as document identities before resolving any package', async () => {
    const deps = dependencies();
    const result = await createGetSequencePackageHistoryTool([], deps).execute!(
      { documentId: '/workspace/example-package' },
      toolOptions
    );

    expect(result).toMatchObject({ ok: false, stateChanged: false });
    expect(deps.resolveIndex).not.toHaveBeenCalled();
  });

  it('applies the reviewed request through one shared delivery adapter and returns no private bytes', async () => {
    const deps = dependencies();
    deps.applyRestore = vi.fn(async () => ({
      revisionId: 'revision-restored',
      alreadyPublished: false,
      markerContent: 'private marker bytes',
      snapshotPaths: ['/workspace/example-package/contents/restored.gb'],
      delivery: { registry: 'completed', git: 'committed' },
    }));
    const selections = [{ itemId: 'field:label', revisionId: 'revision-old' }];
    const result = await createApplySequencePackageRestoreTool([], deps).execute!(
      {
        documentId: 'package-one',
        selections,
        operationId: 'restore-operation-one',
        previewFingerprint: `sha256:${'b'.repeat(64)}`,
      },
      toolOptions
    );

    expect(deps.applyRestore).toHaveBeenCalledWith({
      workspaceRoot: '/workspace',
      packageRoot: index.packageRoot,
      packageId: 'package-one',
      selections,
      operationId: 'restore-operation-one',
      previewFingerprint: `sha256:${'b'.repeat(64)}`,
    });
    expect(result).toMatchObject({
      ok: true,
      revisionId: 'revision-restored',
      durableStage: 'package-revision-published',
      delivery: { registry: 'completed', git: 'committed' },
    });
    expect(JSON.stringify(result)).not.toContain('/workspace/');
    expect(JSON.stringify(result)).not.toContain('private marker bytes');
  });

  it('exposes published-but-failed or unverified Git delivery as partial effects', async () => {
    const deps = dependencies();
    const input = {
      documentId: 'package-one',
      selections: [{ itemId: 'name', revisionId: 'revision-old' }],
      operationId: 'restore-operation-one',
      previewFingerprint: `sha256:${'b'.repeat(64)}`,
    };
    deps.applyRestore = vi.fn(async () => ({
      revisionId: 'revision-restored',
      alreadyPublished: false,
      markerContent: 'private marker bytes',
      snapshotPaths: ['/workspace/private.gb'],
      delivery: { registry: 'completed', git: 'failed', gitError: '/workspace/private.gb failed' },
    }));
    const failed = await createApplySequencePackageRestoreTool([], deps).execute!(
      input,
      toolOptions
    );
    expect(failed).toMatchObject({
      ok: false,
      code: 'RESTORE_GIT_DELIVERY_FAILED',
      stateChanged: true,
      partialEffects: ['package-revision-published', 'registry-reconciled'],
      details: { revisionId: 'revision-restored', gitDelivery: 'failed' },
    });
    expect(JSON.stringify(failed)).not.toContain('/workspace/');

    deps.applyRestore = vi.fn(async () => ({
      revisionId: 'revision-restored',
      alreadyPublished: true,
      markerContent: 'private marker bytes',
      snapshotPaths: [],
      delivery: { registry: 'completed', git: 'unverified-replay' },
    }));
    const replay = await createApplySequencePackageRestoreTool([], deps).execute!(
      input,
      toolOptions
    );
    expect(replay).toMatchObject({
      ok: false,
      code: 'RESTORE_GIT_RECEIPT_UNVERIFIED',
      stateChanged: 'unknown',
      partialEffects: ['prior-package-revision-confirmed', 'registry-reconciled'],
    });
  });

  it('reports stale and dirty preflight refusals without claiming a write', async () => {
    const deps = dependencies();
    const input = {
      documentId: 'package-one',
      selections: [{ itemId: 'field:label', revisionId: 'revision-old' }],
      operationId: 'restore-operation-one',
      previewFingerprint: `sha256:${'b'.repeat(64)}`,
    };
    deps.applyRestore = vi.fn(async () => {
      throw new Error('Restore preview is stale. Preview the current package again.');
    });
    expect(
      await createApplySequencePackageRestoreTool([], deps).execute!(input, toolOptions)
    ).toMatchObject({ ok: false, code: 'RESTORE_STALE_PREVIEW', stateChanged: false });

    deps.applyRestore = vi.fn(async () => {
      throw new Error('Save or discard current sequence edits before Restore.');
    });
    expect(
      await createApplySequencePackageRestoreTool([], deps).execute!(input, toolOptions)
    ).toMatchObject({ ok: false, code: 'RESTORE_DIRTY_EDITOR', stateChanged: false });
  });

  it('does not falsely claim no effect after an unclassified delivery error', async () => {
    const deps = dependencies();
    deps.applyRestore = vi.fn(async () => {
      throw new Error('Delivery failed after publication.');
    });
    const result = await createApplySequencePackageRestoreTool([], deps).execute!(
      {
        documentId: 'package-one',
        selections: [{ itemId: 'field:label', revisionId: 'revision-old' }],
        operationId: 'restore-operation-one',
        previewFingerprint: `sha256:${'b'.repeat(64)}`,
      },
      toolOptions
    );
    expect(result).toMatchObject({
      ok: false,
      code: 'RESTORE_OUTCOME_UNCONFIRMED',
      stateChanged: 'unknown',
    });
  });
});
