import type {
  OperationSnapshot,
  PairwiseSessionAlignmentRequest,
  PairwiseSessionAlignmentResult,
} from '@waypoint/api-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const workflowEvents = vi.hoisted(
  () => [] as Array<{ event: string; properties: Record<string, unknown> }>
);
vi.mock('../../../lib/analytics', () => ({
  trackRendererEvent: (event: string, properties: Record<string, unknown>) => {
    workflowEvents.push({ event, properties });
    return true;
  },
  isAnalyticsIdentityIdentified: () => false,
  getMeaningfulActivityAuthority: () => ({
    actorKind: 'test',
    executionMode: 'interactive',
    impersonated: false,
  }),
  subscribeAnalyticsCaptureReady: () => () => undefined,
  getAnalyticsIdentifiedAccountId: () => null,
}));

const mockReadSequenceFile = vi.fn();
const mockReadReferenceAnnotations = vi.fn().mockResolvedValue([]);
const mockLegacyPairwiseAlignment = vi.fn();
const mockComputePairwiseReferenceRevision = vi.fn();
const mockComputeReferenceHash = vi.fn().mockResolvedValue('sha256:current-reference');
const mockWriteAlignmentHistory = vi.fn().mockResolvedValue('/tmp/reference.waypoint.json');
const mockReadAlignmentHistory = vi.fn().mockResolvedValue(null);
const mockPublishManagedHistory = vi.fn().mockResolvedValue(false);
const mockStageAlignmentQueryPaths = vi.fn();
const mockStartOperation = vi.fn();
const mockWaitForResult = vi.fn();
const mockStopOperation = vi.fn();
const mockFindPackageRoot = vi.fn();
const mockReadPackageMarker = vi.fn();
const mockPrepareEvidence = vi.fn();
const mockActivateEvidence = vi.fn().mockResolvedValue(undefined);
const mockCompleteEvidence = vi.fn().mockResolvedValue(undefined);
const mockAppendEvidence = vi.fn().mockResolvedValue(undefined);
const mockFailEvidence = vi.fn().mockResolvedValue(undefined);

vi.mock('../utils/resolve-alignment-query', async () => {
  const { resolveAlignmentQueryPath } = await import('../utils/alignment-query-path');
  return {
    resolveAlignmentQuery: async (input: { queryPath: string }, referencePath: string) =>
      resolveAlignmentQueryPath(input.queryPath, referencePath),
    fingerprintAlignmentQuery: async () => null,
  };
});

vi.mock('../../../platform', () => ({
  platform: () => ({
    fs: {
      readTextFile: (...args: unknown[]) => mockReadPackageMarker(...args),
      writeTextFile: vi.fn(),
      readFile: vi.fn(),
      mkdir: vi.fn(),
      exists: vi.fn().mockResolvedValue(false),
      prepareSequenceEvidenceRun: (...args: unknown[]) => mockPrepareEvidence(...args),
      activateSequenceEvidenceRun: (...args: unknown[]) => mockActivateEvidence(...args),
      completeSequenceEvidenceRun: (...args: unknown[]) => mockCompleteEvidence(...args),
      appendSequenceEvidenceState: (...args: unknown[]) => mockAppendEvidence(...args),
      failSequenceEvidenceRun: (...args: unknown[]) => mockFailEvidence(...args),
    },
    path: { appDataDir: vi.fn().mockResolvedValue('/tmp/test-appdata') },
  }),
}));

vi.mock('../utils/alignment-api', () => ({
  callAlignmentApi: (...args: unknown[]) => mockLegacyPairwiseAlignment(...args),
  readSequenceFile: (...args: unknown[]) => mockReadSequenceFile(...args),
  readReferenceAnnotations: (...args: unknown[]) => mockReadReferenceAnnotations(...args),
  readReferenceForMutations: async (...args: unknown[]) => ({
    annotations: await mockReadReferenceAnnotations(...args),
    geneticCode: 1,
  }),
}));

vi.mock('../utils/hash', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/hash')>()),
  computePairwiseQueryId: vi.fn().mockResolvedValue(`pairwise-query:${'e'.repeat(64)}`),
  computePairwiseReferenceRevision: (...args: unknown[]) =>
    mockComputePairwiseReferenceRevision(...args),
  computePairwiseQueryRevision: vi
    .fn()
    .mockResolvedValue(`pairwise-query-v1:sha256:${'d'.repeat(64)}`),
  computeReferenceHash: (...args: unknown[]) => mockComputeReferenceHash(...args),
}));

vi.mock('../utils/stage-alignment-query', () => ({
  stageAlignmentQueryPaths: (...args: unknown[]) => mockStageAlignmentQueryPaths(...args),
  findSequencePackageRootForReference: (...args: unknown[]) => mockFindPackageRoot(...args),
}));

vi.mock('../utils/alignment-history-persist', () => ({
  readAlignmentHistory: (...args: unknown[]) => mockReadAlignmentHistory(...args),
  writeAlignmentHistory: (...args: unknown[]) => mockWriteAlignmentHistory(...args),
  publishManagedAlignmentHistory: (...args: unknown[]) => mockPublishManagedHistory(...args),
}));

vi.mock('../pairwise-session-operation-client', () => ({
  pairwiseSessionOperationIdentity: (operation: OperationSnapshot) => ({
    id: operation.id,
    inputRevision: operation.subject.input_revision,
  }),
  startPairwiseSessionAlignmentOperation: (...args: unknown[]) => mockStartOperation(...args),
  waitForPairwiseSessionAlignmentResult: (...args: unknown[]) => mockWaitForResult(...args),
  stopPairwiseSessionAlignmentOperation: (...args: unknown[]) => mockStopOperation(...args),
  PairwiseSessionOperationError: class PairwiseSessionOperationError extends Error {
    constructor(
      readonly operationState: string,
      message: string
    ) {
      super(message);
    }
  },
}));

import { useVerificationStore } from '../store';
import { PairwiseSessionOperationError } from '../pairwise-session-operation-client';
import { computePairwiseSessionSubjectId } from '../utils/hash';
import {
  buildSequencePackageDocument,
  serializeSequencePackageDocument,
} from '../../../db/sequence-package';
import { prepareSequencePackageRevision } from '../../../db/sequence-package-versioning';

const DOCUMENT_ID = 'fixture:sequence:pairwise-session';
const REFERENCE_PATH = '/tmp/reference.gb';
const QUERY_PATH = '/tmp/query.fasta';
const STAGED_QUERY_PATH = '/tmp/package/contents/query.fasta';
const INPUT_REVISION = `pairwise-session-alignment-v1:sha256:${'a'.repeat(64)}`;

const SNAPSHOT: OperationSnapshot = {
  actor_id: 'local-human',
  actor_kind: 'human',
  cancellation_availability: 'available',
  cancellation_mode: 'cooperative',
  channel: 'desktop_ui',
  created_at: 1,
  id: '550e8400-e29b-41d4-a716-446655440360',
  kind: 'pairwise-session-alignment',
  kind_contract_version: 1,
  owner_instance_id: 'owner-1',
  state: 'running',
  subject: {
    scope_id: 'workspace-a',
    subject_id: `pairwise-session-alignment-subject-v1:sha256:${'b'.repeat(64)}`,
    input_revision: INPUT_REVISION,
  },
  updated_at: 1,
  version: 1,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function resultFor(queryId: string): PairwiseSessionAlignmentResult {
  return {
    inputRevision: INPUT_REVISION,
    referenceRevision: `pairwise-reference-v1:sha256:${'c'.repeat(64)}`,
    results: [
      {
        queryId,
        queryRevision: `pairwise-query-v1:sha256:${'d'.repeat(64)}`,
        alignment: {
          aligned_query: 'N'.repeat(20),
          aligned_reference: 'N'.repeat(20),
          identity: 100,
          matches: 20,
          mismatches: 0,
          gaps: 0,
          alignment_length: 20,
          query_length: 20,
          reference_length: 20,
          mutations: [],
        },
      },
    ],
  };
}

describe('Alignment Manager managed session operation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workflowEvents.length = 0;
    mockComputeReferenceHash.mockResolvedValue('sha256:current-reference');
    mockReadAlignmentHistory.mockReset().mockResolvedValue(null);
    useVerificationStore.setState(useVerificationStore.getInitialState());
    useVerificationStore.getState().registerReferenceSource(DOCUMENT_ID, REFERENCE_PATH);
    mockReadSequenceFile.mockImplementation(async (path: string) => {
      if (path === REFERENCE_PATH || path === QUERY_PATH) return 'N'.repeat(20);
      throw new Error(`unexpected sequence path: ${path}`);
    });
    mockComputePairwiseReferenceRevision.mockImplementation(async (sequence: string) =>
      sequence === 'N'.repeat(20)
        ? `pairwise-reference-v1:sha256:${'c'.repeat(64)}`
        : `pairwise-reference-v1:sha256:${'f'.repeat(64)}`
    );
    mockStageAlignmentQueryPaths.mockImplementation(
      async (_referencePath: string, queryPaths: string[]) => queryPaths
    );
    mockStartOperation.mockImplementation(async (documentId: string, sessionId: string) => ({
      ...SNAPSHOT,
      subject: {
        ...SNAPSHOT.subject,
        subject_id: await computePairwiseSessionSubjectId(documentId, sessionId),
      },
    }));
    mockFindPackageRoot.mockResolvedValue(null);
    mockReadPackageMarker.mockResolvedValue(undefined);
    mockPrepareEvidence.mockRejectedValue(new Error('Sequence evidence requires the desktop app.'));
    mockPublishManagedHistory.mockResolvedValue(false);
    mockStopOperation.mockResolvedValue({ ...SNAPSHOT, state: 'canceled' });
    mockLegacyPairwiseAlignment.mockReturnValue(new Promise(() => undefined));
  });

  it('restores the latest local clone choice instead of an older sidecar view', async () => {
    mockReadAlignmentHistory.mockResolvedValue(
      JSON.stringify({
        type: 'alignment-history',
        version: '3.0',
        reference: { name: 'reference', checksum: 'sha256:current-reference' },
        savedAt: new Date().toISOString(),
        activeSessionId: 'review',
        sessions: [
          {
            id: 'review',
            name: 'Review',
            createdAt: new Date().toISOString(),
            mode: 'one-per-clone',
            tracks: [],
          },
        ],
        viewPreferences: { review: { selectedTrackId: 'earlier-clone', viewMode: 'stacked' } },
      })
    );
    useVerificationStore
      .getState()
      .setSessionViewPreferences(DOCUMENT_ID, 'review', { selectedTrackId: 'latest-clone' });
    expect(await useVerificationStore.getState().loadSidecar(DOCUMENT_ID)).toBe(true);
    expect(
      useVerificationStore.getState().getSessionViewPreferences(DOCUMENT_ID, 'review')
    ).toMatchObject({ selectedTrackId: 'latest-clone', viewMode: 'stacked' });
  });

  it('persists prepared inputs and admits an agent job before its result arrives', async () => {
    const held = deferred<PairwiseSessionAlignmentResult>();
    mockWaitForResult.mockReturnValue(held.promise);
    const store = useVerificationStore.getState();
    const sessionId = store.createSession(DOCUMENT_ID, {
      name: 'Agent analysis',
      mode: 'one-per-clone',
      queryPaths: [QUERY_PATH],
    });
    const input = await store.prepareSessionAlignments(DOCUMENT_ID, sessionId, [QUERY_PATH]);
    expect(mockStartOperation).not.toHaveBeenCalled();
    const prepared = JSON.parse(mockWriteAlignmentHistory.mock.calls.at(-1)?.[1] as string);
    expect(prepared.sessions[0].alignmentPreparation[0]).toMatchObject({
      queryPath: QUERY_PATH,
      id: input.queries[0].id,
    });
    const operation = {
      ...SNAPSHOT,
      actor_kind: 'agent' as const,
      subject: {
        ...SNAPSHOT.subject,
        subject_id: await computePairwiseSessionSubjectId(DOCUMENT_ID, sessionId),
      },
    };
    const admitted = vi.fn();
    const run = store.adoptSessionAlignmentOperation(DOCUMENT_ID, sessionId, operation, admitted);
    await vi.waitFor(() => expect(admitted).toHaveBeenCalledOnce());
    const saved = JSON.parse(mockWriteAlignmentHistory.mock.calls.at(-1)?.[1] as string);
    expect(saved.sessions[0].alignmentOperation).toMatchObject({
      id: operation.id,
      status: 'active',
    });
    expect(saved.sessions[0].tracks).toEqual([]);
    held.resolve(resultFor(input.queries[0].id));
    await run;
    expect(
      useVerificationStore.getState().verificationState[DOCUMENT_ID].sessions[0].tracks
    ).toHaveLength(1);
  });

  it('refuses an admitted job for another reference or session', async () => {
    const store = useVerificationStore.getState();
    const sessionId = store.createSession(DOCUMENT_ID, {
      name: 'Wrong job',
      mode: 'one-per-clone',
      queryPaths: [QUERY_PATH],
    });
    await store.prepareSessionAlignments(DOCUMENT_ID, sessionId, [QUERY_PATH]);
    const admitted = vi.fn();
    await expect(
      store.adoptSessionAlignmentOperation(DOCUMENT_ID, sessionId, SNAPSHOT, admitted)
    ).rejects.toThrow('different reference or session');
    expect(admitted).not.toHaveBeenCalled();
    expect(
      useVerificationStore.getState().verificationState[DOCUMENT_ID].sessions[0].alignmentOperation
    ).toBeUndefined();
  });

  it('does not acknowledge admission when the analysis write fails', async () => {
    const store = useVerificationStore.getState();
    const sessionId = store.createSession(DOCUMENT_ID, {
      name: 'Failed save',
      mode: 'one-per-clone',
      queryPaths: [QUERY_PATH],
    });
    await store.prepareSessionAlignments(DOCUMENT_ID, sessionId, [QUERY_PATH]);
    mockWriteAlignmentHistory.mockRejectedValueOnce(new Error('Native analysis write failed'));
    const operation = {
      ...SNAPSHOT,
      subject: {
        ...SNAPSHOT.subject,
        subject_id: await computePairwiseSessionSubjectId(DOCUMENT_ID, sessionId),
      },
    };
    const admitted = vi.fn();
    await expect(
      store.adoptSessionAlignmentOperation(DOCUMENT_ID, sessionId, operation, admitted)
    ).rejects.toThrow('Native analysis write failed');
    expect(admitted).not.toHaveBeenCalled();
  });

  it('joins repeated starts and publishes one track for the retained result', async () => {
    const held = deferred<PairwiseSessionAlignmentResult>();
    mockWaitForResult.mockReturnValue(held.promise);
    const sessionId = useVerificationStore.getState().createSession(DOCUMENT_ID, {
      name: 'Managed session',
      mode: 'one-per-clone',
      queryPaths: [QUERY_PATH],
    });

    const first = useVerificationStore
      .getState()
      .runSessionAlignments(DOCUMENT_ID, sessionId, [QUERY_PATH]);
    const repeated = useVerificationStore
      .getState()
      .runSessionAlignments(DOCUMENT_ID, sessionId, [QUERY_PATH]);

    await vi.waitFor(() => expect(mockStartOperation).toHaveBeenCalledOnce());
    const firstInput = mockStartOperation.mock.calls[0]?.[2] as PairwiseSessionAlignmentRequest;
    expect(firstInput.queries[0]?.id).toMatch(/^pairwise-query:[0-9a-f]{64}$/);

    held.resolve(resultFor(firstInput.queries[0].id));
    await Promise.all([first, repeated]);

    const session = useVerificationStore
      .getState()
      .verificationState[DOCUMENT_ID]?.sessions.find((value) => value.id === sessionId);
    expect(session?.tracks).toHaveLength(1);
    expect(session?.tracks[0]?.id).toBe(firstInput.queries[0].id);
    expect(session?.alignmentOperation).toMatchObject({
      id: SNAPSHOT.id,
      inputRevision: INPUT_REVISION,
      status: 'succeeded',
    });
    expect(mockLegacyPairwiseAlignment).not.toHaveBeenCalled();
    const receipts = workflowEvents.filter((e) => e.event === 'workflow_action_observed');
    expect(receipts).toHaveLength(2);
    expect(receipts[0].properties).toMatchObject({
      workflow: 'alignment',
      workflow_action: 'compute',
      action_phase: 'start',
    });
    expect(receipts[1].properties).toMatchObject({
      action_id: receipts[0].properties.action_id,
      operation_id: SNAPSHOT.id,
      workflow_status: 'ready',
      outcome_kind: 'alignment_attached',
      result_count: 1,
      artifact_correlation_id: session?.alignmentOperation?.inputCorrelationId,
    });
    expect(receipts[1].properties.artifact_correlation_id).toMatch(/^[0-9a-f-]{36}$/);
    const transport = JSON.stringify(workflowEvents);
    for (const privateValue of [
      DOCUMENT_ID,
      REFERENCE_PATH,
      QUERY_PATH,
      INPUT_REVISION,
      'Managed session',
    ])
      expect(transport).not.toContain(privateValue);
  });

  it('records refused inputs separately without starting a native job', async () => {
    const sessionId = useVerificationStore.getState().createSession(DOCUMENT_ID, {
      name: 'Private refused',
      mode: 'one-per-clone',
      queryPaths: [QUERY_PATH],
    });
    mockReadSequenceFile.mockRejectedValueOnce(new Error('Private input is unavailable'));
    await expect(
      useVerificationStore.getState().runSessionAlignments(DOCUMENT_ID, sessionId, [QUERY_PATH])
    ).rejects.toThrow();
    expect(mockStartOperation).not.toHaveBeenCalled();
    expect(workflowEvents.map((e) => e.properties)).toMatchObject([
      { workflow: 'alignment', action_phase: 'start' },
      {
        workflow: 'alignment',
        action_phase: 'error',
        workflow_status: 'blocked',
        outcome_kind: 'validation_refused',
        error_class: 'alignment_inputs_refused',
      },
    ]);
    expect(JSON.stringify(workflowEvents)).not.toContain('Private');
  });

  it.each(['canceled', 'interrupted', 'failed'] as const)(
    'settles admitted %s once and keeps earlier evidence',
    async (state) => {
      const sessionId = useVerificationStore.getState().createSession(DOCUMENT_ID, {
        name: 'Private failure',
        mode: 'one-per-clone',
        queryPaths: [QUERY_PATH],
      });
      const queryId = `pairwise-query:${'e'.repeat(64)}`;
      mockWaitForResult.mockResolvedValueOnce(resultFor(queryId));
      await useVerificationStore
        .getState()
        .runSessionAlignments(DOCUMENT_ID, sessionId, [QUERY_PATH]);
      const previousTracks = structuredClone(
        useVerificationStore.getState().verificationState[DOCUMENT_ID].sessions[0].tracks
      );
      workflowEvents.length = 0;
      const nextId = '550e8400-e29b-41d4-a716-446655440361';
      mockStartOperation.mockImplementation(async (documentId: string, sessionId: string) => ({
        ...SNAPSHOT,
        id: nextId,
        subject: {
          ...SNAPSHOT.subject,
          subject_id: await computePairwiseSessionSubjectId(documentId, sessionId),
        },
      }));
      mockWaitForResult.mockRejectedValueOnce(
        new PairwiseSessionOperationError(state, 'Private failure at ' + QUERY_PATH)
      );
      await expect(
        useVerificationStore.getState().runSessionAlignments(DOCUMENT_ID, sessionId, [QUERY_PATH])
      ).rejects.toThrow();
      const receipts = workflowEvents.filter((e) => e.event === 'workflow_action_observed');
      expect(receipts).toHaveLength(2);
      expect(receipts[1].properties).toMatchObject({
        operation_id: nextId,
        action_id: receipts[0].properties.action_id,
        action_phase: state === 'canceled' ? 'cancel' : 'error',
        workflow_status:
          state === 'canceled' ? 'cancelled' : state === 'interrupted' ? 'stopped' : 'failed',
      });
      expect(JSON.stringify(receipts)).not.toContain(QUERY_PATH);
      const currentTracks =
        useVerificationStore.getState().verificationState[DOCUMENT_ID].sessions[0].tracks;
      expect(currentTracks).toHaveLength(1);
      expect(currentTracks[0].id).toBe(previousTracks[0].id);
      expect(currentTracks[0].alignment).toEqual(previousTracks[0].alignment);
      expect(currentTracks[0].alignedAt).toBe(previousTracks[0].alignedAt);
    }
  );

  it('keeps native status unknown when only observation fails', async () => {
    const sessionId = useVerificationStore.getState().createSession(DOCUMENT_ID, {
      name: 'Private observation',
      mode: 'one-per-clone',
      queryPaths: [QUERY_PATH],
    });
    mockWaitForResult.mockRejectedValueOnce(
      new Error('Private transport failure at ' + QUERY_PATH)
    );
    await expect(
      useVerificationStore.getState().runSessionAlignments(DOCUMENT_ID, sessionId, [QUERY_PATH])
    ).rejects.toThrow();
    expect(workflowEvents.at(-1)?.properties).toMatchObject({
      action_phase: 'error',
      operation_id: SNAPSHOT.id,
      workflow_status: 'needs_action',
      error_class: 'alignment_observation_failed',
    });
    expect(
      useVerificationStore.getState().verificationState[DOCUMENT_ID].sessions[0].alignmentOperation
        ?.status
    ).toBe('active');
    expect(JSON.stringify(workflowEvents)).not.toContain('Private');
  });

  it.each([false, true])(
    'uses hosted input admission and guarded attachment without native evidence writes (versioned=%s)',
    async (versioned) => {
      const root = '/hosted/22222222-2222-4222-8222-222222222222/vector';
      const referencePath = `${root}/reference.gb`;
      const queryPath = `${root}/contents/query.fasta`;
      useVerificationStore.getState().registerReferenceSource(DOCUMENT_ID, referencePath);
      mockFindPackageRoot.mockResolvedValue(root);
      mockReadPackageMarker.mockResolvedValue(
        JSON.stringify({
          schema: 'waypoint.sequence.v1',
          kind: 'sequence',
          formatVersion: 4,
          id: DOCUMENT_ID,
          name: 'reference',
          product: { file: 'reference.gb', topology: 'linear' },
          members: [],
        })
      );
      if (versioned) {
        const base = buildSequencePackageDocument({
          id: DOCUMENT_ID,
          name: 'reference',
          product: { file: 'reference.gb', topology: 'linear' },
        });
        const prepared = await prepareSequencePackageRevision({
          current: null,
          currentProductContent: null,
          next: base,
          nextProductContent:
            'LOCUS       reference 20 bp DNA linear\nORIGIN\n        1 nnnnnnnnnnnnnnnnnnnn\n//\n',
          kind: 'sequence-save',
          operationId: 'fixture-save',
          revisionId: 'checkpoint-for-hosted',
        });
        mockReadPackageMarker.mockResolvedValue(
          serializeSequencePackageDocument(prepared.document)
        );
      }
      mockReadSequenceFile.mockResolvedValue('N'.repeat(20));
      mockPublishManagedHistory.mockResolvedValue(true);
      mockWaitForResult.mockImplementation(async () => {
        const input = mockStartOperation.mock.calls[0][2] as PairwiseSessionAlignmentRequest;
        return resultFor(input.queries[0].id);
      });
      const sessionId = useVerificationStore.getState().createSession(DOCUMENT_ID, {
        name: 'Hosted admitted alignment',
        mode: 'one-per-clone',
        queryPaths: [queryPath],
      });
      await useVerificationStore
        .getState()
        .runSessionAlignments(DOCUMENT_ID, sessionId, [queryPath]);
      expect(mockPrepareEvidence).not.toHaveBeenCalled();
      const input = mockStartOperation.mock.calls[0][2] as PairwiseSessionAlignmentRequest;
      expect(mockStartOperation.mock.calls[0][3]).toEqual([
        { key: 'reference', path: referencePath },
        { key: `query:${input.queries[0].id}`, path: queryPath },
      ]);
      expect(mockPublishManagedHistory).toHaveBeenCalledOnce();
      const session = useVerificationStore.getState().verificationState[DOCUMENT_ID].sessions[0];
      expect(session.alignmentOperation).toMatchObject({ status: 'succeeded' });
      expect(session.alignmentOperation?.evidenceRunId).toBeUndefined();
      expect(session.tracks).toHaveLength(1);
      expect(session.tracks[0].testedReference?.fileSha256).toBe('sha256:current-reference');
      expect(session.tracks[0].testedReference?.checkpointId).toBe(
        versioned ? 'checkpoint-for-hosted' : null
      );
      expect(useVerificationStore.getState().staleSessionIds[DOCUMENT_ID]).not.toContain(sessionId);
      expect(mockLegacyPairwiseAlignment).not.toHaveBeenCalled();
    }
  );

  it('retains native frozen inputs and evidence identity alongside hosted attachment guards', async () => {
    const root = '/tmp/frozen-package';
    const frozenReference = `${root}/contents/evidence/frozen/reference.gb`;
    const frozenQuery = `${root}/contents/evidence/frozen/query.fasta`;
    const canonicalQuery = `${root}/contents/clone-1.fasta`;
    const queryId = `pairwise-query:${'e'.repeat(64)}`;
    mockFindPackageRoot.mockResolvedValue(root);
    mockReadPackageMarker.mockResolvedValue(
      JSON.stringify({
        schema: 'waypoint.sequence.v1',
        kind: 'sequence',
        formatVersion: 4,
        id: DOCUMENT_ID,
        name: 'reference',
        product: { file: 'reference.gb', topology: 'linear' },
        members: [],
      })
    );
    const digest = `sha256:${'a'.repeat(64)}`;
    mockComputeReferenceHash.mockResolvedValue(digest);
    mockPrepareEvidence.mockImplementation(async (request) => {
      const createdAt = new Date().toISOString();
      const run = {
        id: request.runId,
        sessionId: request.sessionId,
        createdAt,
        status: 'prepared' as const,
        reference: {
          artifact: { path: 'contents/evidence/frozen/reference.gb', sha256: digest },
          sequenceRevision: `pairwise-reference-v1:sha256:${'c'.repeat(64)}`,
          topology: 'linear' as const,
          checkpointId: null,
        },
        queries: [
          {
            id: queryId,
            label: 'Frozen query',
            artifact: {
              path: 'contents/evidence/frozen/query.fasta',
              sha256: `sha256:${'b'.repeat(64)}`,
            },
          },
        ],
      };
      mockReadPackageMarker.mockResolvedValue(
        serializeSequencePackageDocument(
          buildSequencePackageDocument({
            id: DOCUMENT_ID,
            name: 'reference',
            product: { file: 'reference.gb', topology: 'linear' },
            members: [run.reference.artifact, run.queries[0].artifact].map((artifact, index) => ({
              id: `frozen-${index}`,
              path: artifact.path,
              role: 'evidence-input',
              replaceable: false,
              createdAt,
            })),
            evidenceRuns: [run],
          })
        )
      );
      return {
        run,
        referenceReadPath: frozenReference,
        queryPaths: { [queryId]: frozenQuery },
        attachedQueryPaths: { [queryId]: canonicalQuery },
      };
    });
    mockReadSequenceFile.mockResolvedValue('N'.repeat(20));
    mockWaitForResult.mockResolvedValue(resultFor(queryId));
    const sessionId = useVerificationStore.getState().createSession(DOCUMENT_ID, {
      name: 'Native frozen alignment',
      mode: 'one-per-clone',
      queryPaths: [QUERY_PATH],
    });
    await useVerificationStore
      .getState()
      .runSessionAlignments(DOCUMENT_ID, sessionId, [QUERY_PATH]);
    expect(mockPrepareEvidence).toHaveBeenCalledOnce();
    expect(mockActivateEvidence).toHaveBeenCalledOnce();
    expect(mockCompleteEvidence).toHaveBeenCalledOnce();
    expect(mockAppendEvidence).toHaveBeenCalledOnce();
    expect(mockReadSequenceFile).toHaveBeenCalledWith(frozenReference);
    expect(mockReadSequenceFile).toHaveBeenCalledWith(frozenQuery);
    const session = useVerificationStore.getState().verificationState[DOCUMENT_ID].sessions[0];
    expect(session.tracks).toHaveLength(1);
    expect(session.tracks[0].evidenceRunId).toBe(mockPrepareEvidence.mock.calls[0][0].runId);
    expect(session.tracks[0]).toMatchObject({ id: queryId, queryPath: canonicalQuery });
    expect(session.alignmentOperation?.queries).toEqual([
      expect.objectContaining({ id: queryId, queryPath: canonicalQuery }),
    ]);
    expect(mockStartOperation.mock.calls[0][3]).toEqual([
      { key: 'reference', path: frozenReference },
      { key: `query:${queryId}`, path: frozenQuery },
    ]);
    expect(session.alignmentOperation?.status).toBe('succeeded');
    expect(mockFailEvidence).not.toHaveBeenCalled();
  });

  it('keeps completed results out of the viewer and ordinary saves until attachment is accepted', async () => {
    const held = deferred<PairwiseSessionAlignmentResult>();
    const publication = deferred<boolean>();
    mockWaitForResult.mockReturnValue(held.promise);
    mockPublishManagedHistory.mockReturnValue(publication.promise);
    const sessionId = useVerificationStore.getState().createSession(DOCUMENT_ID, {
      name: 'Guarded result',
      mode: 'one-per-clone',
      queryPaths: [QUERY_PATH],
    });
    const run = useVerificationStore
      .getState()
      .runSessionAlignments(DOCUMENT_ID, sessionId, [QUERY_PATH]);
    await vi.waitFor(() => expect(mockWaitForResult).toHaveBeenCalledOnce());
    const input = mockStartOperation.mock.calls[0][2] as PairwiseSessionAlignmentRequest;
    const ordinaryWrites = mockWriteAlignmentHistory.mock.calls.length;
    held.resolve(resultFor(input.queries[0].id));
    await vi.waitFor(() => expect(mockPublishManagedHistory).toHaveBeenCalledOnce());
    expect(
      useVerificationStore.getState().verificationState[DOCUMENT_ID].sessions[0].tracks
    ).toEqual([]);
    expect(mockWriteAlignmentHistory).toHaveBeenCalledTimes(ordinaryWrites);
    publication.reject(new Error('Newer inputs were saved in another browser.'));
    await run;
    const state = useVerificationStore.getState();
    expect(state.verificationState[DOCUMENT_ID].sessions[0].tracks).toEqual([]);
    expect(state.verificationState[DOCUMENT_ID].sessions[0].alignmentOperation).toMatchObject({
      status: 'succeeded',
      attachmentError: 'Newer inputs were saved in another browser.',
    });
    expect(state.staleReferences[DOCUMENT_ID]).toBe(true);
    expect(mockWriteAlignmentHistory).toHaveBeenCalledTimes(ordinaryWrites);
  });

  it('discards a queued hosted autosave after its result attachment is refused', async () => {
    const held = deferred<PairwiseSessionAlignmentResult>();
    const publication = deferred<boolean>();
    mockWaitForResult.mockReturnValue(held.promise);
    mockPublishManagedHistory.mockReturnValue(publication.promise);
    const source = '/hosted/22222222-2222-4222-8222-222222222222/reference.gb';
    useVerificationStore.setState({ referenceSourcePaths: { [DOCUMENT_ID]: source } });
    mockReadSequenceFile.mockResolvedValue('N'.repeat(20));
    const sessionId = useVerificationStore.getState().createSession(DOCUMENT_ID, {
      name: 'Refused attachment',
      mode: 'one-per-clone',
      queryPaths: [QUERY_PATH],
    });
    const run = useVerificationStore
      .getState()
      .runSessionAlignments(DOCUMENT_ID, sessionId, [QUERY_PATH]);
    await vi.waitFor(() => expect(mockWaitForResult).toHaveBeenCalledOnce());
    const input = mockStartOperation.mock.calls[0][2] as PairwiseSessionAlignmentRequest;
    held.resolve(resultFor(input.queries[0].id));
    await vi.waitFor(() => expect(mockPublishManagedHistory).toHaveBeenCalledOnce());
    const ordinaryWrites = mockWriteAlignmentHistory.mock.calls.length;
    const autosave = useVerificationStore
      .getState()
      .saveSidecar(DOCUMENT_ID, { onlyIfCurrent: true });
    publication.reject(new Error('Newer inputs were saved in another browser.'));
    await Promise.all([run, autosave]);
    expect(useVerificationStore.getState().staleReferences[DOCUMENT_ID]).toBe(true);
    expect(mockWriteAlignmentHistory).toHaveBeenCalledTimes(ordinaryWrites);
    expect(mockPublishManagedHistory).toHaveBeenCalledOnce();
  });

  it('deleting a held session sends Stop and blocks late publication', async () => {
    const held = deferred<PairwiseSessionAlignmentResult>();
    mockWaitForResult.mockReturnValue(held.promise);
    const sessionId = useVerificationStore.getState().createSession(DOCUMENT_ID, {
      name: 'Delete while running',
      mode: 'one-per-clone',
      queryPaths: [QUERY_PATH],
    });
    const run = useVerificationStore
      .getState()
      .runSessionAlignments(DOCUMENT_ID, sessionId, [QUERY_PATH]);

    await vi.waitFor(() => expect(mockWaitForResult).toHaveBeenCalledOnce());
    await useVerificationStore.getState().removeSession(DOCUMENT_ID, sessionId);

    expect(mockStopOperation).toHaveBeenCalledExactlyOnceWith(SNAPSHOT.id);
    const persistedDeletion = JSON.parse(
      mockWriteAlignmentHistory.mock.calls.at(-1)?.[1] as string
    );
    expect(persistedDeletion.sessions).toEqual([]);
    expect(persistedDeletion.activeSessionId).toBeNull();
    expect(
      useVerificationStore
        .getState()
        .verificationState[DOCUMENT_ID]?.sessions.some((value) => value.id === sessionId)
    ).toBe(false);

    const input = mockStartOperation.mock.calls[0]?.[2] as PairwiseSessionAlignmentRequest;
    held.resolve(resultFor(input.queries[0].id));
    await expect(run).resolves.toBeUndefined();
    expect(
      useVerificationStore
        .getState()
        .verificationState[DOCUMENT_ID]?.sessions.some((value) => value.id === sessionId)
    ).toBe(false);
  });

  it('does not let an autosave begun during attachment overwrite the accepted result with active empty tracks', async () => {
    const held = deferred<PairwiseSessionAlignmentResult>();
    const publication = deferred<boolean>();
    mockWaitForResult.mockReturnValue(held.promise);
    mockPublishManagedHistory.mockReturnValueOnce(publication.promise).mockResolvedValue(true);
    const source = '/hosted/22222222-2222-4222-8222-222222222222/reference.gb';
    useVerificationStore.setState({ referenceSourcePaths: { [DOCUMENT_ID]: source } });
    mockReadSequenceFile.mockResolvedValue('N'.repeat(20));
    const sessionId = useVerificationStore.getState().createSession(DOCUMENT_ID, {
      name: 'Delayed autosave',
      mode: 'one-per-clone',
      queryPaths: [QUERY_PATH],
    });
    const run = useVerificationStore
      .getState()
      .runSessionAlignments(DOCUMENT_ID, sessionId, [QUERY_PATH]);
    await vi.waitFor(() => expect(mockWaitForResult).toHaveBeenCalledOnce());
    const input = mockStartOperation.mock.calls[0][2] as PairwiseSessionAlignmentRequest;
    held.resolve(resultFor(input.queries[0].id));
    await vi.waitFor(() => expect(mockPublishManagedHistory).toHaveBeenCalledOnce());
    const ordinaryWrites = mockWriteAlignmentHistory.mock.calls.length;
    const autosave = useVerificationStore.getState().saveSidecar(DOCUMENT_ID);
    publication.resolve(true);
    await Promise.all([run, autosave]);
    for (const call of [
      ...mockPublishManagedHistory.mock.calls,
      ...mockWriteAlignmentHistory.mock.calls.slice(ordinaryWrites),
    ]) {
      expect(JSON.parse(call[1] as string).sessions[0]).toMatchObject({
        alignmentOperation: { status: 'succeeded' },
        tracks: [expect.any(Object)],
      });
    }
    expect(
      useVerificationStore.getState().verificationState[DOCUMENT_ID].sessions[0].tracks
    ).toHaveLength(1);
  });

  it('does not publish a retained result after the reference bytes change', async () => {
    const held = deferred<PairwiseSessionAlignmentResult>();
    let currentReference = 'N'.repeat(20);
    mockReadSequenceFile.mockImplementation(async (path: string) => {
      if (path === REFERENCE_PATH) return currentReference;
      if (path === QUERY_PATH) return 'N'.repeat(20);
      throw new Error(`unexpected sequence path: ${path}`);
    });
    mockWaitForResult.mockReturnValue(held.promise);
    const sessionId = useVerificationStore.getState().createSession(DOCUMENT_ID, {
      name: 'Reference changes while running',
      mode: 'one-per-clone',
      queryPaths: [QUERY_PATH],
    });
    const run = useVerificationStore
      .getState()
      .runSessionAlignments(DOCUMENT_ID, sessionId, [QUERY_PATH]);

    await vi.waitFor(() => expect(mockWaitForResult).toHaveBeenCalledOnce());
    currentReference = `${'N'.repeat(19)}A`;
    held.resolve(resultFor(`pairwise-query:${'e'.repeat(64)}`));
    await expect(run).resolves.toBeUndefined();

    const state = useVerificationStore.getState();
    const session = state.verificationState[DOCUMENT_ID]?.sessions[0];
    expect(session?.tracks).toEqual([]);
    expect(session?.alignmentOperation?.status).toBe('succeeded');
    expect(state.staleReferences[DOCUMENT_ID]).toBe(true);
    expect(state.staleSessionIds[DOCUMENT_ID]).toEqual([sessionId]);
    expect(workflowEvents.at(-1)?.properties).toMatchObject({
      action_phase: 'result',
      operation_id: SNAPSHOT.id,
      workflow_status: 'needs_action',
      outcome_kind: 'alignment_not_attached',
      result_count: 0,
    });
  });

  it('retains the staged query locator used to read and align a new track', async () => {
    const queryId = `pairwise-query:${'e'.repeat(64)}`;
    mockStageAlignmentQueryPaths.mockResolvedValue([STAGED_QUERY_PATH]);
    mockReadSequenceFile.mockImplementation(async (path: string) => {
      if (path === REFERENCE_PATH || path === STAGED_QUERY_PATH) return 'N'.repeat(20);
      throw new Error(`unexpected sequence path: ${path}`);
    });
    mockWaitForResult.mockResolvedValue(resultFor(queryId));
    const sessionId = useVerificationStore.getState().createSession(DOCUMENT_ID, {
      name: 'Staged query',
      mode: 'one-per-clone',
      queryPaths: [QUERY_PATH],
    });

    await useVerificationStore
      .getState()
      .runSessionAlignments(DOCUMENT_ID, sessionId, [QUERY_PATH]);

    const session = useVerificationStore.getState().verificationState[DOCUMENT_ID]?.sessions[0];
    expect(session?.tracks[0]?.queryPath).toBe(STAGED_QUERY_PATH);
    expect(session?.alignmentOperation?.queries[0]?.queryPath).toBe(STAGED_QUERY_PATH);
    expect(mockReadSequenceFile).not.toHaveBeenCalledWith(QUERY_PATH);
  });

  it('keeps an existing track ID while replacing a moved query locator for later reruns', async () => {
    const queryId = `pairwise-query:${'e'.repeat(64)}`;
    mockWaitForResult.mockResolvedValue(resultFor(queryId));
    const sessionId = useVerificationStore.getState().createSession(DOCUMENT_ID, {
      name: 'Existing query',
      mode: 'one-per-clone',
      queryPaths: [QUERY_PATH],
    });
    await useVerificationStore
      .getState()
      .runSessionAlignments(DOCUMENT_ID, sessionId, [QUERY_PATH]);
    mockStageAlignmentQueryPaths.mockResolvedValue([STAGED_QUERY_PATH]);
    mockReadSequenceFile.mockClear();
    mockReadSequenceFile.mockImplementation(async (path: string) => {
      if (path === REFERENCE_PATH || path === STAGED_QUERY_PATH) return 'N'.repeat(20);
      throw new Error(`old query was moved: ${path}`);
    });

    await useVerificationStore
      .getState()
      .runSessionAlignments(DOCUMENT_ID, sessionId, [QUERY_PATH]);
    const session = useVerificationStore.getState().verificationState[DOCUMENT_ID].sessions[0];
    expect(session.tracks).toHaveLength(1);
    expect(session.tracks[0].id).toBe(queryId);
    expect(session.tracks[0].queryPath).toBe(STAGED_QUERY_PATH);
    expect(session.alignmentOperation?.queries[0]?.queryPath).toBe(STAGED_QUERY_PATH);
    expect(mockReadSequenceFile).not.toHaveBeenCalledWith(QUERY_PATH);

    await useVerificationStore.getState().runSessionAlignments(
      DOCUMENT_ID,
      sessionId,
      session.tracks.map((track) => track.queryPath)
    );
    expect(mockStageAlignmentQueryPaths).toHaveBeenLastCalledWith(REFERENCE_PATH, [
      STAGED_QUERY_PATH,
    ]);
  });

  it('reattaches a persisted active operation without resubmitting work', async () => {
    const queryId = `pairwise-query:${'e'.repeat(64)}`;
    useVerificationStore.setState({
      verificationState: {
        [DOCUMENT_ID]: {
          documentId: DOCUMENT_ID,
          activeSessionId: 'persisted-session',
          sessions: [
            {
              id: 'persisted-session',
              name: 'Persisted active session',
              createdAt: '2026-09-16T00:00:00Z',
              mode: 'one-per-clone',
              tracks: [],
              alignmentOperation: {
                id: SNAPSHOT.id,
                inputRevision: INPUT_REVISION,
                status: 'active',
                queries: [{ id: queryId, queryPath: QUERY_PATH, label: 'query' }],
              },
            },
          ],
        },
      },
    });
    mockWaitForResult.mockResolvedValue(resultFor(queryId));

    await useVerificationStore
      .getState()
      .resumeSessionAlignmentOperation(DOCUMENT_ID, 'persisted-session');

    expect(mockStartOperation).not.toHaveBeenCalled();
    expect(mockWaitForResult).toHaveBeenCalledWith({
      id: SNAPSHOT.id,
      inputRevision: INPUT_REVISION,
    });
    const session = useVerificationStore
      .getState()
      .verificationState[DOCUMENT_ID]?.sessions.find((value) => value.id === 'persisted-session');
    expect(session?.tracks).toHaveLength(1);
    expect(session?.alignmentOperation?.status).toBe('succeeded');
  });
});
