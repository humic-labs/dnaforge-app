import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseGenBankFull } from '@waypoint/sequence-utils';
import type {
  OperationSnapshot,
  PairwiseSessionAlignmentRequest,
  PairwiseSessionAlignmentResult,
} from '@waypoint/api-client';
const classifyMutationCalls: unknown[][] = [];
vi.mock('@waypoint/sequence-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@waypoint/sequence-utils')>();
  return {
    ...actual,
    classifyMutation: (...args: Parameters<typeof actual.classifyMutation>) => {
      classifyMutationCalls.push(args);
      return actual.classifyMutation(...args);
    },
  };
});

import { useVerificationStore } from '../store';
import type { VerificationTrack } from '../types';
import REFERENCE_GENBANK from './__fixtures__/staleness-detection/reference.gb?raw';
import QUERY_VARIANT_GENBANK from './__fixtures__/staleness-detection/reference-with-substitutions.gb?raw';

const mockReadTextFile = vi.fn();
const mockWriteTextFile = vi.fn();
const mockReadFile = vi.fn();
const mockMkdir = vi.fn();
const mockExists = vi.fn().mockResolvedValue(false);
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
      readTextFile: mockReadTextFile,
      writeTextFile: mockWriteTextFile,
      readFile: mockReadFile,
      mkdir: mockMkdir,
      exists: mockExists,
    },
    path: {
      appDataDir: vi.fn().mockResolvedValue('/tmp/test-appdata'),
    },
  }),
}));

const mockCallAlignmentApi = vi.fn();
const mockReadSequenceFile = vi.fn();
const mockAfterQueryId = vi.fn();
const mockReadReferenceAnnotations = vi.fn().mockResolvedValue([]);
const mockReadReferenceForMutations = vi.fn(async (...args: unknown[]) => ({
  annotations: await mockReadReferenceAnnotations(...args),
  geneticCode: 1,
}));
vi.mock('../utils/alignment-api', () => ({
  callAlignmentApi: (...args: unknown[]) => mockCallAlignmentApi(...args),
  readSequenceFile: (...args: unknown[]) => mockReadSequenceFile(...args),
  readReferenceAnnotations: (...args: unknown[]) => mockReadReferenceAnnotations(...args),
  readReferenceForMutations: (...args: unknown[]) => mockReadReferenceForMutations(...args),
}));

const mockComputeReferenceHash = vi.fn();
vi.mock('../utils/hash', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/hash')>();
  return {
    ...actual,
    computePairwiseQueryId: async (sessionId: string, queryPath: string) => {
      const id = await actual.computePairwiseQueryId(sessionId, queryPath);
      await mockAfterQueryId(sessionId, queryPath);
      return id;
    },
    computeReferenceHash: (...args: unknown[]) => mockComputeReferenceHash(...args),
  };
});

const operationInputs = new Map<string, PairwiseSessionAlignmentRequest>();
let operationCounter = 0;

async function scientificRevision(prefix: string, sequence: string): Promise<string> {
  const normalized = sequence.replace(/\s/g, '').toUpperCase();
  const bytes = new TextEncoder().encode(JSON.stringify(normalized));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `${prefix}:sha256:${hex}`;
}

const sequenceFiles = new Map<string, string>();

function mockAlignmentRunReads(
  referencePath: string,
  reference: string,
  queries: Record<string, string>
): void {
  sequenceFiles.set(referencePath, reference);
  for (const [path, sequence] of Object.entries(queries)) sequenceFiles.set(path, sequence);
  mockReadSequenceFile.mockImplementation(async (path: string) => {
    const sequence = sequenceFiles.get(path);
    if (sequence === undefined) throw new Error(`unexpected readSequenceFile path: ${path}`);
    return sequence;
  });
}

vi.mock('../pairwise-session-operation-client', () => ({
  pairwiseSessionOperationIdentity: (operation: OperationSnapshot) => ({
    id: operation.id,
    inputRevision: operation.subject.input_revision,
  }),
  startPairwiseSessionAlignmentOperation: vi.fn(
    async (
      _documentId: string,
      _sessionId: string,
      input: PairwiseSessionAlignmentRequest
    ): Promise<OperationSnapshot> => {
      operationCounter += 1;
      const id = `pairwise-operation-${operationCounter}`;
      operationInputs.set(id, input);
      return {
        actor_id: 'local-human',
        actor_kind: 'human',
        cancellation_availability: 'available',
        cancellation_mode: 'cooperative',
        channel: 'desktop_ui',
        created_at: operationCounter,
        id,
        kind: 'pairwise-session-alignment',
        kind_contract_version: 1,
        owner_instance_id: 'owner-1',
        state: 'running',
        subject: {
          scope_id: 'workspace-a',
          subject_id: await (
            await import('../utils/hash')
          ).computePairwiseSessionSubjectId(_documentId, _sessionId),
          input_revision: `pairwise-session-alignment-v1:sha256:${operationCounter
            .toString(16)
            .padStart(64, '0')}`,
        },
        updated_at: operationCounter,
        version: 1,
      };
    }
  ),
  waitForPairwiseSessionAlignmentResult: vi.fn(
    async (identity: {
      id: string;
      inputRevision: string;
    }): Promise<PairwiseSessionAlignmentResult> => {
      const input = operationInputs.get(identity.id);
      if (!input) throw new Error(`missing managed test input: ${identity.id}`);
      const results = await Promise.all(
        input.queries.map(async (query) => {
          const alignment = await mockCallAlignmentApi(query.sequence, input.referenceSequence);
          return {
            queryId: query.id,
            queryRevision: await scientificRevision('pairwise-query-v1', query.sequence),
            alignment: {
              matches: 0,
              mismatches: 0,
              gaps: 0,
              query_length: query.sequence.length,
              reference_length: input.referenceSequence.length,
              mutations: [],
              ...alignment,
            },
          };
        })
      );
      return {
        inputRevision: identity.inputRevision,
        referenceRevision: await scientificRevision(
          'pairwise-reference-v1',
          input.referenceSequence
        ),
        results,
      };
    }
  ),
  stopPairwiseSessionAlignmentOperation: vi.fn(),
  PairwiseSessionOperationError: class PairwiseSessionOperationError extends Error {
    operationState = 'failed';
  },
}));

const REAL_REFERENCE_SEQUENCE = parseGenBankFull(REFERENCE_GENBANK).sequence.toUpperCase();
const REAL_QUERY_VARIANT_SEQUENCE = parseGenBankFull(QUERY_VARIANT_GENBANK).sequence.toUpperCase();

beforeEach(() => {
  mockAfterQueryId.mockReset();
  mockCallAlignmentApi.mockReset();
  sequenceFiles.clear();
});

function firstReferenceSubstitution() {
  for (let index = 0; index < REAL_REFERENCE_SEQUENCE.length; index++) {
    const referenceBase = REAL_REFERENCE_SEQUENCE[index];
    const alternateBase = REAL_QUERY_VARIANT_SEQUENCE[index];
    if (referenceBase !== alternateBase) {
      return {
        id: `puc19-substitution-${index + 1}`,
        position: index + 1,
        type: 'substitution' as const,
        referenceBase,
        alternateBase,
        length: 1,
      };
    }
  }

  throw new Error('pUC substitution fixture must contain at least one substitution');
}

describe('re-run alignment integration', () => {
  const referencePath = 'sequence-ref';
  const referenceSourcePath = '/test/ref.gb';
  const queryPath = '/test/query.fasta';

  beforeEach(() => {
    vi.clearAllMocks();
    mockReadSequenceFile.mockReset();
    mockComputeReferenceHash.mockReset().mockResolvedValue('sha256:stable-reference');
    operationInputs.clear();
    operationCounter = 0;
    useVerificationStore.setState(useVerificationStore.getInitialState());
    useVerificationStore.getState().registerReferenceSource(referencePath, referenceSourcePath);
  });

  it('re-run reads updated sequence and updates track in-place', async () => {
    const originalRef = 'ATCGATCGATCGATCGATCG';
    const querySeq = 'ATCGATCG';

    mockAlignmentRunReads(referenceSourcePath, originalRef, { [queryPath]: querySeq });

    mockCallAlignmentApi.mockResolvedValueOnce({
      aligned_reference: 'atcgatcgatcgatcgatcg',
      aligned_query: '--------atcgatcg----',
      identity: 40.0,
      mutations: [],
      alignment_length: 20,
    });

    const store = useVerificationStore.getState();
    const sessionId = store.createSession(referencePath, {
      name: 'Test',
      mode: 'one-per-clone',
      queryPaths: [queryPath],
    });

    await store.runSessionAlignments(referencePath, sessionId, [queryPath]);

    const session1 = useVerificationStore.getState().getActiveSession(referencePath);
    expect(session1?.tracks).toHaveLength(1);
    const track1 = session1!.tracks[0];
    expect(track1.alignment.alignedReference).toBe('atcgatcgatcgatcgatcg');
    const track1NonGap = track1.alignment.alignedReference.replace(/-/g, '').length;
    expect(track1NonGap).toBe(20);
    const originalTrackId = track1.id;

    console.log(`[RERUN-TEST] Initial: trackId=${originalTrackId}, ref non-gap=${track1NonGap}`);

    const editedRef = originalRef.slice(0, 10) + 'AAAAA' + originalRef.slice(10);
    expect(editedRef.length).toBe(25);

    mockAlignmentRunReads(referenceSourcePath, editedRef, { [queryPath]: querySeq });

    mockCallAlignmentApi.mockResolvedValueOnce({
      aligned_reference: 'atcgatcgataaaaacgatcgatcg',
      aligned_query: '--------atcgatcg---------',
      identity: 32.0,
      mutations: [],
      alignment_length: 26,
    });

    await useVerificationStore
      .getState()
      .runSessionAlignments(referencePath, sessionId, [queryPath]);

    const session2 = useVerificationStore.getState().getActiveSession(referencePath);
    expect(session2?.tracks).toHaveLength(1);
    const track2 = session2!.tracks[0];

    expect(track2.id).toBe(originalTrackId);
    console.log(
      `[RERUN-TEST] After re-run: trackId=${track2.id}, same=${track2.id === originalTrackId}`
    );

    const track2NonGap = track2.alignment.alignedReference.replace(/-/g, '').length;
    console.log(
      `[RERUN-TEST] After re-run: ref non-gap=${track2NonGap}, identity=${track2.alignment.identity}`
    );

    expect(track2NonGap).toBe(25);
    expect(track2.alignment.identity).toBe(32.0);
    expect(track2.alignment.alignedReference).toBe('atcgatcgataaaaacgatcgatcg');

    expect(mockCallAlignmentApi).toHaveBeenCalledTimes(2);
    const secondCall = mockCallAlignmentApi.mock.calls[1];
    expect(secondCall[1]).toBe(editedRef);
    expect(secondCall[1].length).toBe(25);

    console.log(`[RERUN-TEST] API received ref length: ${secondCall[1].length} (expected 25)`);
    console.log('[RERUN-TEST] PASS — re-run correctly uses updated reference');
  });

  it.each(['/test/q1.fa', '/test/q2.fa'])(
    're-run does not duplicate tracks when %s reads first',
    async (firstQueryPath) => {
      let firstIdFinished!: () => void;
      const firstIdWasResolved = new Promise<void>((resolve) => {
        firstIdFinished = resolve;
      });
      const idResolutionOrder: string[] = [];
      mockAfterQueryId.mockImplementation(async (_sessionId: string, queryPath: string) => {
        if (queryPath !== firstQueryPath) await firstIdWasResolved;
        idResolutionOrder.push(queryPath);
        if (queryPath === firstQueryPath) firstIdFinished();
      });
      const refSeq = 'ATCGATCGATCGATCGATCG';
      const q1 = 'ATCGATCGATCG';
      const q2 = 'GATCGATCGATC';

      mockAlignmentRunReads(referenceSourcePath, refSeq, { '/test/q1.fa': q1, '/test/q2.fa': q2 });

      mockCallAlignmentApi
        .mockResolvedValueOnce({
          aligned_reference: refSeq,
          aligned_query: q1 + '--------',
          identity: 60,
          mutations: [],
          alignment_length: 20,
        })
        .mockResolvedValueOnce({
          aligned_reference: refSeq,
          aligned_query: '--------' + q2,
          identity: 60,
          mutations: [],
          alignment_length: 20,
        });

      const store = useVerificationStore.getState();
      const sessionId = store.createSession(referencePath, {
        name: 'Multi',
        mode: 'one-per-clone',
        queryPaths: ['/test/q1.fa', '/test/q2.fa'],
      });

      await store.runSessionAlignments(referencePath, sessionId, ['/test/q1.fa', '/test/q2.fa']);
      const s1 = useVerificationStore.getState().getActiveSession(referencePath);
      expect(s1?.tracks).toHaveLength(2);
      expect(s1?.tracks.map((track) => [track.queryPath, track.alignment.alignedQuery])).toEqual([
        ['/test/q1.fa', q1 + '--------'],
        ['/test/q2.fa', '--------' + q2],
      ]);
      expect(useVerificationStore.getState().staleReferences[referencePath]).toBe(false);
      expect(mockCallAlignmentApi).toHaveBeenNthCalledWith(1, q1, refSeq);
      expect(mockCallAlignmentApi).toHaveBeenNthCalledWith(2, q2, refSeq);
      expect(idResolutionOrder.slice(0, 2)).toEqual(
        firstQueryPath === '/test/q1.fa'
          ? ['/test/q1.fa', '/test/q2.fa']
          : ['/test/q2.fa', '/test/q1.fa']
      );
      const ids1 = s1!.tracks.map((t) => t.id);

      mockAlignmentRunReads(referenceSourcePath, refSeq, { '/test/q1.fa': q1, '/test/q2.fa': q2 });

      mockCallAlignmentApi
        .mockResolvedValueOnce({
          aligned_reference: refSeq,
          aligned_query: q1 + '--------',
          identity: 61,
          mutations: [],
          alignment_length: 20,
        })
        .mockResolvedValueOnce({
          aligned_reference: refSeq,
          aligned_query: '--------' + q2,
          identity: 61,
          mutations: [],
          alignment_length: 20,
        });

      await useVerificationStore
        .getState()
        .runSessionAlignments(referencePath, sessionId, ['/test/q1.fa', '/test/q2.fa']);
      const s2 = useVerificationStore.getState().getActiveSession(referencePath);

      expect(s2?.tracks).toHaveLength(2);
      expect(s2!.tracks.map((t) => t.id)).toEqual(ids1);
      expect(s2!.tracks.map((track) => track.alignment.identity)).toEqual([61, 61]);
      expect(s2!.tracks.map((track) => [track.queryPath, track.alignment.alignedQuery])).toEqual([
        ['/test/q1.fa', q1 + '--------'],
        ['/test/q2.fa', '--------' + q2],
      ]);
      expect(useVerificationStore.getState().staleReferences[referencePath]).toBe(false);
      expect(mockCallAlignmentApi).toHaveBeenCalledTimes(4);
      expect(mockCallAlignmentApi).toHaveBeenNthCalledWith(3, q1, refSeq);
      expect(mockCallAlignmentApi).toHaveBeenNthCalledWith(4, q2, refSeq);

      console.log('[RERUN-TEST] No duplicates — PASS');
    }
  );

  it('refuses to apply an unversioned legacy result to the sequence', async () => {
    const sessionId = 'session-apply';
    const trackId = 'track-apply';
    const mutation = firstReferenceSubstitution();
    mockReadTextFile.mockResolvedValue(REFERENCE_GENBANK);
    mockComputeReferenceHash.mockResolvedValue('sha256:fresh-should-not-be-used');

    useVerificationStore.setState({
      verificationState: {
        [referencePath]: {
          documentId: referencePath,
          activeSessionId: sessionId,
          sessions: [
            {
              id: sessionId,
              name: 'Apply Session',
              createdAt: new Date().toISOString(),
              mode: 'one-per-clone',
              tracks: [
                {
                  id: trackId,
                  queryPath,
                  label: 'query',
                  alignment: {
                    alignedReference: REAL_REFERENCE_SEQUENCE,
                    alignedQuery: REAL_QUERY_VARIANT_SEQUENCE,
                    identity: 96,
                    coverageStart: 1,
                    coverageEnd: REAL_REFERENCE_SEQUENCE.length,
                    algorithm: 'minimap2',
                  },
                  mutations: [mutation],
                  status: 'variants',
                  alignedAt: new Date().toISOString(),
                  checkedMutations: [mutation.id],
                },
              ],
            },
          ],
        },
      },
      staleReferences: { [referencePath]: false },
      staleSessionIds: { [referencePath]: [] },
      referenceFileChecksums: { [referencePath]: 'sha256:old' },
    });

    await expect(
      useVerificationStore.getState().applyCheckedMutations(referencePath, sessionId, trackId)
    ).rejects.toThrow(/version-owned sequencing result/);

    const state = useVerificationStore.getState();
    const track = state.verificationState[referencePath].sessions[0].tracks[0];
    expect(track.checkedMutations).toEqual([mutation.id]);
    expect(state.staleReferences[referencePath]).toBe(false);
    expect(state.staleSessionIds[referencePath]).toEqual([]);
    expect(mockWriteTextFile).not.toHaveBeenCalled();
    expect(mockComputeReferenceHash).not.toHaveBeenCalled();
  });
});

describe('alignment lifecycle — load → align → edit → re-run → reopen', () => {
  const referencePath = 'sequence-lifecycle-ref';
  const referenceSourcePath = '/test/lifecycle/ref.gb';
  const queryPath = '/test/lifecycle/query.fasta';
  let writtenSidecar: string | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    mockReadSequenceFile.mockReset();
    mockComputeReferenceHash.mockReset();
    operationInputs.clear();
    operationCounter = 0;
    useVerificationStore.setState(useVerificationStore.getInitialState());
    useVerificationStore.getState().registerReferenceSource(referencePath, referenceSourcePath);
    writtenSidecar = null;
    mockWriteTextFile.mockImplementation(async (_path: string, content: string) => {
      writtenSidecar = content;
    });
    mockReadTextFile.mockImplementation(async () => {
      if (writtenSidecar == null) throw new Error('no sidecar yet');
      return writtenSidecar;
    });
    mockExists.mockImplementation(async () => writtenSidecar !== null);
  });

  it('staleness flag survives the close→reopen cycle correctly: stale before re-run, fresh after re-run + reopen', async () => {
    const originalRef = 'ATCGATCGATCGATCGATCG';
    const editedRef = originalRef + 'AAAAA';
    const querySeq = 'ATCGATCG';
    const oldHash = 'sha256:original-file-hash';
    const newHash = 'sha256:edited-file-hash';

    mockAlignmentRunReads(referenceSourcePath, originalRef, { [queryPath]: querySeq });
    mockCallAlignmentApi.mockResolvedValueOnce({
      aligned_reference: originalRef.toLowerCase(),
      aligned_query: querySeq.toLowerCase() + '------------',
      identity: 40,
      mutations: [],
      alignment_length: 20,
    });
    mockComputeReferenceHash.mockResolvedValue(oldHash);

    const sessionId = useVerificationStore.getState().createSession(referencePath, {
      name: 'Test',
      mode: 'one-per-clone',
      queryPaths: [queryPath],
    });
    await useVerificationStore
      .getState()
      .runSessionAlignments(referencePath, sessionId, [queryPath]);

    expect(useVerificationStore.getState().staleReferences[referencePath]).toBeFalsy();
    expect(writtenSidecar).not.toBeNull();

    useVerificationStore.setState(useVerificationStore.getInitialState());
    useVerificationStore.getState().registerReferenceSource(referencePath, referenceSourcePath);
    expect(useVerificationStore.getState().verificationState[referencePath]).toBeUndefined();

    mockComputeReferenceHash.mockResolvedValue(newHash);
    sequenceFiles.set(referenceSourcePath, editedRef);

    const loaded = await useVerificationStore.getState().loadSidecar(referencePath);
    expect(loaded).toBe(true);

    expect(useVerificationStore.getState().staleReferences[referencePath]).toBe(true);
    expect(useVerificationStore.getState().staleSessionIds[referencePath]).toContain(sessionId);

    mockAlignmentRunReads(referenceSourcePath, editedRef, { [queryPath]: querySeq });
    mockCallAlignmentApi.mockResolvedValueOnce({
      aligned_reference: editedRef.toLowerCase(),
      aligned_query: querySeq.toLowerCase() + '-----------------',
      identity: 32,
      mutations: [],
      alignment_length: 25,
    });
    mockComputeReferenceHash.mockResolvedValue(newHash);

    await useVerificationStore
      .getState()
      .runSessionAlignments(referencePath, sessionId, [queryPath]);

    expect(useVerificationStore.getState().staleReferences[referencePath]).toBe(false);
    expect(useVerificationStore.getState().staleSessionIds[referencePath]).toEqual([]);

    useVerificationStore.setState(useVerificationStore.getInitialState());
    useVerificationStore.getState().registerReferenceSource(referencePath, referenceSourcePath);
    mockComputeReferenceHash.mockResolvedValue(newHash);
    sequenceFiles.set(referenceSourcePath, editedRef);

    await useVerificationStore.getState().loadSidecar(referencePath);
    expect(useVerificationStore.getState().staleReferences[referencePath]).toBe(false);
    expect(useVerificationStore.getState().staleSessionIds[referencePath]).toEqual([]);

    const refState = useVerificationStore.getState().verificationState[referencePath];
    expect(refState.sessions).toHaveLength(1);
    const track = refState.sessions[0].tracks[0];
    const nonGap = track.alignment.alignedReference.replace(/-/g, '').length;
    expect(nonGap).toBe(editedRef.length);
  });

  it('regression: re-running ONE session out of multiple leaves the OTHER session correctly flagged on reopen', async () => {
    const originalRef = 'ATCGATCGATCGATCGATCG';
    const editedRef = originalRef + 'AAAAA';
    const querySeq = 'ATCGATCG';
    const oldHash = 'sha256:original';
    const newHash = 'sha256:edited';

    mockAlignmentRunReads(referenceSourcePath, originalRef, { [queryPath]: querySeq });
    mockCallAlignmentApi.mockResolvedValueOnce({
      aligned_reference: originalRef.toLowerCase(),
      aligned_query: querySeq.toLowerCase() + '------------',
      identity: 40,
      mutations: [],
      alignment_length: 20,
    });
    mockComputeReferenceHash.mockResolvedValue(oldHash);
    const sess1Id = useVerificationStore.getState().createSession(referencePath, {
      name: 'session1',
      mode: 'one-per-clone',
      queryPaths: [queryPath],
    });
    await useVerificationStore.getState().runSessionAlignments(referencePath, sess1Id, [queryPath]);

    mockAlignmentRunReads(referenceSourcePath, originalRef, { [queryPath]: querySeq });
    mockCallAlignmentApi.mockResolvedValueOnce({
      aligned_reference: originalRef.toLowerCase(),
      aligned_query: querySeq.toLowerCase() + '------------',
      identity: 41,
      mutations: [],
      alignment_length: 20,
    });
    mockComputeReferenceHash.mockResolvedValue(oldHash);
    const sess2Id = useVerificationStore.getState().createSession(referencePath, {
      name: 'session2 (active)',
      mode: 'one-per-clone',
      queryPaths: [queryPath],
    });
    await useVerificationStore.getState().runSessionAlignments(referencePath, sess2Id, [queryPath]);
    useVerificationStore.getState().setActiveSession(referencePath, sess2Id);

    mockAlignmentRunReads(referenceSourcePath, editedRef, { [queryPath]: querySeq });
    mockCallAlignmentApi.mockResolvedValueOnce({
      aligned_reference: editedRef.toLowerCase(),
      aligned_query: querySeq.toLowerCase() + '-----------------',
      identity: 32,
      mutations: [],
      alignment_length: 25,
    });
    mockComputeReferenceHash.mockResolvedValue(newHash);

    useVerificationStore.setState({
      staleReferences: { [referencePath]: true },
      staleSessionIds: { [referencePath]: [sess1Id, sess2Id] },
    });

    await useVerificationStore.getState().runSessionAlignments(referencePath, sess1Id, [queryPath]);

    expect(useVerificationStore.getState().staleSessionIds[referencePath]).toContain(sess2Id);
    expect(useVerificationStore.getState().staleReferences[referencePath]).toBe(true);

    const parsed = JSON.parse(writtenSidecar ?? '{}');
    const sidecarSess1 = parsed.sessions?.find((s: { id: string }) => s.id === sess1Id);
    const sidecarSess2 = parsed.sessions?.find((s: { id: string }) => s.id === sess2Id);
    const s1NonGap = (sidecarSess1?.tracks?.[0]?.alignment?.alignedReference ?? '')
      .split('')
      .filter((c: string) => c !== '-').length;
    const s2NonGap = (sidecarSess2?.tracks?.[0]?.alignment?.alignedReference ?? '')
      .split('')
      .filter((c: string) => c !== '-').length;
    expect(s1NonGap).toBe(editedRef.length);
    expect(s2NonGap).toBe(originalRef.length);

    useVerificationStore.setState(useVerificationStore.getInitialState());
    useVerificationStore.getState().registerReferenceSource(referencePath, referenceSourcePath);
    mockComputeReferenceHash.mockResolvedValue(newHash);
    sequenceFiles.set(referenceSourcePath, editedRef);
    await useVerificationStore.getState().loadSidecar(referencePath);

    const reloaded = useVerificationStore.getState();
    expect(reloaded.staleReferences[referencePath]).toBe(true);
    expect(reloaded.staleSessionIds[referencePath]).toContain(sess2Id);
    expect(reloaded.staleSessionIds[referencePath]).not.toContain(sess1Id);
  });

  it('resolves sidecar-relative query filenames against the reference directory on re-run', async () => {
    const referenceDir = '/Users/lab/samples/alignments/clone-verification';
    const localReference = `${referenceDir}/reference.gb`;
    const localDocumentId = 'sequence-local-reference';
    const relativeQuery = 'clone-1-verified.fasta';
    const absoluteQuery = `${referenceDir}/clone-1-verified.fasta`;
    const originalRef = 'ATCGATCGATCGATCGATCG';
    const querySeq = 'ATCGATCG';

    mockReadSequenceFile.mockImplementation(async (path: string) => {
      if (path === localReference) return originalRef;
      if (path === absoluteQuery) return querySeq;
      throw new Error(`unexpected readSequenceFile path: ${path}`);
    });
    mockCallAlignmentApi.mockResolvedValueOnce({
      aligned_reference: originalRef.toLowerCase(),
      aligned_query: `${querySeq.toLowerCase()}------------`,
      identity: 40,
      mutations: [],
      alignment_length: 20,
    });
    mockComputeReferenceHash.mockResolvedValue('sha256:rel-query');

    useVerificationStore.getState().registerReferenceSource(localDocumentId, localReference);
    const sessionId = useVerificationStore.getState().createSession(localDocumentId, {
      name: 'shipped-demo',
      mode: 'one-per-clone',
      queryPaths: [relativeQuery],
    });
    await useVerificationStore
      .getState()
      .runSessionAlignments(localDocumentId, sessionId, [relativeQuery]);

    expect(mockReadSequenceFile).toHaveBeenCalledWith(absoluteQuery);
    const session = useVerificationStore.getState().getActiveSession(localDocumentId);
    expect(session?.tracks).toHaveLength(1);
    expect(session?.tracks[0].failedToRealign).toBeUndefined();
    expect(session?.tracks[0].queryPath).toBe(relativeQuery);
  });
});

describe("the record's genetic code reaches the mutation classifier", () => {
  const referencePath = 'sequence-genetic-code-wiring';
  const referenceSourcePath = '/test/genetic-code-wiring.gb';
  const queryPath = '/test/genetic-code-wiring-query.fasta';

  beforeEach(() => {
    vi.clearAllMocks();
    mockReadSequenceFile.mockReset();
    mockComputeReferenceHash.mockReset().mockResolvedValue('sha256:stable-reference');
    useVerificationStore.setState({
      referenceSourcePaths: { [referencePath]: referenceSourcePath },
    });
  });

  it('passes the code the reference declares, not the standard one', async () => {
    classifyMutationCalls.length = 0;
    const reference = 'ATGAAATGAAAATAG';
    mockAlignmentRunReads(referenceSourcePath, reference, { [queryPath]: reference });
    const referenceMetadata = {
      annotations: [
        {
          name: 'gene',
          type: 'CDS',
          start: 1,
          end: 15,
          direction: 1,
          color: '',
        },
      ],
      geneticCode: 3,
    };
    mockReadReferenceForMutations
      .mockResolvedValueOnce(referenceMetadata)
      .mockResolvedValueOnce(referenceMetadata);
    mockCallAlignmentApi.mockResolvedValueOnce({
      aligned_reference: reference.toLowerCase(),
      aligned_query: reference.toLowerCase().slice(0, 6) + 'c' + reference.toLowerCase().slice(7),
      identity: 93.3,
      mutations: [{ type: 'substitution', position: 7, ref_base: 'T', query_base: 'C', length: 1 }],
      alignment_length: reference.length,
    });

    const store = useVerificationStore.getState();
    const sessionId = store.createSession(referencePath, {
      name: 'Genetic code wiring',
      mode: 'one-per-clone',
      queryPaths: [queryPath],
    });
    await store.runSessionAlignments(referencePath, sessionId, [queryPath]);

    expect(classifyMutationCalls.length).toBeGreaterThan(0);
    expect(new Set(classifyMutationCalls.map((args) => args[4]))).toEqual(new Set([3]));
  });
});
