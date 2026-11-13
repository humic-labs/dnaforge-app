import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockReadTextFile, mockWriteTextFile, mockExists, mockOn, mockComputeReferenceHash } =
  vi.hoisted(() => ({
    mockReadTextFile: vi.fn(),
    mockWriteTextFile: vi.fn().mockResolvedValue(undefined),
    mockExists: vi.fn(),
    mockOn: vi.fn(() => vi.fn()),
    mockComputeReferenceHash: vi.fn(),
  }));

vi.mock('../../../platform', () => ({
  platform: () => ({
    fs: {
      readTextFile: mockReadTextFile,
      writeTextFile: mockWriteTextFile,
      exists: mockExists,
      watchFile: vi.fn().mockResolvedValue(undefined),
      unwatchFile: vi.fn().mockResolvedValue(undefined),
    },
    on: mockOn,
  }),
}));

vi.mock('../utils/hash', () => ({
  computeReferenceHash: mockComputeReferenceHash,
}));

vi.mock('@waypoint/sequence-utils', () => ({
  classifyMutation: vi.fn(),
}));

vi.mock('../../../utils/debug-log', () => ({
  debugLog: vi.fn(),
  debugWarn: vi.fn(),
}));

const mockReadSequenceFile = vi.hoisted(() => vi.fn());

vi.mock('../utils/alignment-api', () => ({
  callAlignmentApi: vi.fn(),
  readSequenceFile: mockReadSequenceFile,
  readReferenceAnnotations: vi.fn(),
  readReferenceForMutations: vi.fn().mockResolvedValue({ annotations: [], geneticCode: 1 }),
}));

import { useVerificationStore } from '../store';
import { detectPerSessionStaleness } from '../store/staleness';
import type { VerificationSession } from '../types';

it('does not transfer a result to a later assembly checkpoint with identical DNA', () => {
  const session = {
    id: 'tested-session',
    tracks: [
      {
        testedReference: {
          fileSha256: 'sha256:same-file',
          sequenceRevision: 'same-sequence',
          topology: 'circular',
          checkpointId: 'accepted-one',
        },
      },
    ],
  } as VerificationSession;
  expect(
    detectPerSessionStaleness([session], false, 4, {
      sequenceRevision: 'same-sequence',
      topology: 'circular',
      checkpointId: 'accepted-two',
    })
  ).toEqual(new Set(['tested-session']));
});

it('retains an unchanged tested reference through GenBank-only edits but not changed bases', () => {
  const session = {
    id: 'tested-session',
    tracks: [
      {
        testedReference: {
          fileSha256: 'sha256:original-file',
          sequenceRevision: 'same-sequence',
          topology: 'circular',
          checkpointId: 'accepted-one',
        },
      },
    ],
  } as VerificationSession;
  const current = {
    fileSha256: 'sha256:original-file',
    sequenceRevision: 'same-sequence',
    topology: 'circular' as const,
    checkpointId: 'accepted-one',
  };
  expect(detectPerSessionStaleness([session], true, 4, current)).toEqual(new Set());
  expect(
    detectPerSessionStaleness([session], true, 4, {
      ...current,
      fileSha256: 'sha256:edited-annotations',
    })
  ).toEqual(new Set());
  expect(
    detectPerSessionStaleness([session], true, 4, {
      ...current,
      sequenceRevision: 'edited-bases',
    })
  ).toEqual(new Set(['tested-session']));
});

describe('staleness detection', () => {
  beforeEach(() => {
    useVerificationStore.setState({
      verificationState: {},
      sessionViewPreferences: {},
      staleReferences: {},
      referenceFileChecksums: {},
    });
    vi.clearAllMocks();
    useVerificationStore.getState().registerReferenceSource('sequence-ref', '/path/to/ref.gb');
  });

  it('does not require a source path when a saved document has no alignment evidence', async () => {
    await expect(
      useVerificationStore.getState().checkStaleness('new-document-without-alignments')
    ).resolves.toBeUndefined();
    expect(mockComputeReferenceHash).not.toHaveBeenCalled();
  });

  it('still refuses a missing source when there is stored alignment evidence to check', async () => {
    const documentId = 'missing-alignment-source';
    useVerificationStore.setState({ referenceFileChecksums: { [documentId]: 'sha256:stored' } });
    await expect(useVerificationStore.getState().checkStaleness(documentId)).rejects.toThrow(
      `Sequence document source is unavailable: ${documentId}`
    );
    expect(mockComputeReferenceHash).not.toHaveBeenCalled();
  });

  it('marks reference as NOT stale when checksums match', async () => {
    const referencePath = 'sequence-ref';
    const checksum = 'sha256:abc123';
    mockExists.mockResolvedValue(true);
    mockReadTextFile.mockResolvedValue(
      JSON.stringify({
        type: 'alignment-history',
        version: '2.0',
        reference: { name: 'ref', checksum },
        savedAt: '2026-01-01T00:00:00Z',
        activeSessionId: null,
        sessions: [],
        viewPreferences: {},
      })
    );
    mockComputeReferenceHash.mockResolvedValue(checksum);

    await useVerificationStore.getState().loadSidecar(referencePath);
    expect(useVerificationStore.getState().staleReferences[referencePath]).toBe(false);
  });

  it('marks reference as stale when checksums differ', async () => {
    const referencePath = 'sequence-ref';
    mockExists.mockResolvedValue(true);
    mockReadTextFile.mockResolvedValue(
      JSON.stringify({
        type: 'alignment-history',
        version: '2.0',
        reference: { name: 'ref', checksum: 'sha256:old-hash' },
        savedAt: '2026-01-01T00:00:00Z',
        activeSessionId: null,
        sessions: [],
        viewPreferences: {},
      })
    );
    mockComputeReferenceHash.mockResolvedValue('sha256:new-hash');

    await useVerificationStore.getState().loadSidecar(referencePath);
    expect(useVerificationStore.getState().staleReferences[referencePath]).toBe(true);
  });

  it('marks reference as stale when sidecar has no checksum', async () => {
    const referencePath = 'sequence-ref';
    mockExists.mockResolvedValue(true);
    mockReadTextFile.mockResolvedValue(
      JSON.stringify({
        type: 'alignment-history',
        version: '2.0',
        reference: { name: 'ref', checksum: '' },
        savedAt: '2026-01-01T00:00:00Z',
        activeSessionId: null,
        sessions: [],
        viewPreferences: {},
      })
    );
    mockComputeReferenceHash.mockResolvedValue('sha256:some-hash');

    await useVerificationStore.getState().loadSidecar(referencePath);
    expect(useVerificationStore.getState().staleReferences[referencePath]).toBe(true);
  });

  it('handles missing reference file gracefully', async () => {
    const referencePath = 'sequence-ref';
    useVerificationStore.getState().registerReferenceSource(referencePath, '/path/to/deleted.gb');
    mockExists.mockResolvedValue(true);
    mockReadTextFile.mockResolvedValue(
      JSON.stringify({
        type: 'alignment-history',
        version: '2.0',
        reference: { name: 'ref', checksum: 'sha256:abc' },
        savedAt: '2026-01-01T00:00:00Z',
        activeSessionId: null,
        sessions: [],
        viewPreferences: {},
      })
    );
    mockComputeReferenceHash.mockResolvedValue(null);

    await useVerificationStore.getState().loadSidecar(referencePath);
    expect(useVerificationStore.getState().staleReferences[referencePath]).toBe(true);
  });

  it('checkStaleness updates stale flag independently', async () => {
    const referencePath = 'sequence-ref';
    useVerificationStore.setState({
      referenceFileChecksums: { [referencePath]: 'sha256:old-hash' },
    });
    mockComputeReferenceHash.mockResolvedValue('sha256:new-hash');

    await useVerificationStore.getState().checkStaleness(referencePath);
    expect(useVerificationStore.getState().staleReferences[referencePath]).toBe(true);
  });

  it('checkStaleness clears stale flag when hash matches', async () => {
    const referencePath = 'sequence-ref';
    const hash = 'sha256:same';
    useVerificationStore.setState({
      referenceFileChecksums: { [referencePath]: hash },
      staleReferences: { [referencePath]: true },
    });
    mockComputeReferenceHash.mockResolvedValue(hash);

    await useVerificationStore.getState().checkStaleness(referencePath);
    expect(useVerificationStore.getState().staleReferences[referencePath]).toBe(false);
  });

  it('checkStaleness does nothing when no stored checksum exists', async () => {
    const referencePath = 'sequence-ref';
    useVerificationStore.setState({
      referenceFileChecksums: {},
      staleReferences: {},
    });

    await useVerificationStore.getState().checkStaleness(referencePath);
    expect(useVerificationStore.getState().staleReferences[referencePath]).toBeUndefined();
  });

  it('saveSidecar is blocked when reference is stale (prevents silent corruption)', async () => {
    const referencePath = 'sequence-ref';

    const store = useVerificationStore.getState();
    store.createSession(referencePath, {
      name: 'Test Session',
      mode: 'one-per-clone',
      queryPaths: [],
    });

    useVerificationStore.setState({
      staleReferences: { [referencePath]: true },
    });

    mockComputeReferenceHash.mockResolvedValue('sha256:new-checksum');
    mockWriteTextFile.mockResolvedValue(undefined);

    await useVerificationStore.getState().saveSidecar(referencePath);

    expect(useVerificationStore.getState().referenceFileChecksums[referencePath]).toBeUndefined();
    expect(mockWriteTextFile).not.toHaveBeenCalled();
  });

  it('saveSidecar with force=true bypasses stale guard', async () => {
    const referencePath = 'sequence-ref';
    const checksum = 'sha256:new-checksum';

    const store = useVerificationStore.getState();
    store.createSession(referencePath, {
      name: 'Test Session',
      mode: 'one-per-clone',
      queryPaths: [],
    });

    useVerificationStore.setState({
      staleReferences: { [referencePath]: true },
    });

    mockComputeReferenceHash.mockResolvedValue(checksum);
    mockWriteTextFile.mockResolvedValue(undefined);

    await useVerificationStore.getState().saveSidecar(referencePath, { force: true });

    expect(useVerificationStore.getState().referenceFileChecksums[referencePath]).toBe(checksum);
    expect(mockWriteTextFile).toHaveBeenCalled();
  });

  it('staleReferences and referenceFileChecksums are NOT persisted', () => {
    const persistApi = useVerificationStore.persist;
    const options = persistApi?.getOptions?.();

    if (options?.partialize) {
      useVerificationStore.setState({
        staleReferences: { 'sequence-ref': true },
        referenceFileChecksums: { 'sequence-ref': 'sha256:abc' },
      });

      const fullState = useVerificationStore.getState();
      const partialized = options.partialize(fullState);

      expect(partialized).not.toHaveProperty('staleReferences');
      expect(partialized).not.toHaveProperty('referenceFileChecksums');
    }
  });
});

describe('loadSidecar per-session staleness', () => {
  beforeEach(() => {
    useVerificationStore.setState({
      verificationState: {},
      sessionViewPreferences: {},
      staleReferences: {},
      staleSessionIds: {},
      referenceFileChecksums: {},
    });
    vi.clearAllMocks();
  });

  function buildMixedSidecar(opts: {
    refChecksum: string;
    fresh: { sessionId: string; nonGap: number };
    stale: { sessionId: string; nonGap: number };
  }): string {
    const mkAlignedRef = (n: number) => 'A'.repeat(n) + '-'.repeat(2);
    const mkTrack = (id: string, nonGap: number) => ({
      id,
      queryPath: `/path/to/${id}.fasta`,
      label: id,
      alignment: {
        alignedReference: mkAlignedRef(nonGap),
        alignedQuery: mkAlignedRef(nonGap),
        identity: 99,
        coverageStart: 0,
        coverageEnd: nonGap,
        algorithm: 'MAFFT' as const,
      },
      mutations: [],
      status: 'verified' as const,
      alignedAt: '2026-04-01T00:00:00Z',
    });
    return JSON.stringify({
      type: 'alignment-history',
      version: '2.0',
      reference: { name: 'ref', checksum: opts.refChecksum },
      savedAt: '2026-04-25T00:00:00Z',
      activeSessionId: opts.stale.sessionId,
      sessions: [
        {
          id: opts.fresh.sessionId,
          name: 'fresh session',
          createdAt: '2026-04-01T00:00:00Z',
          mode: 'one-per-clone' as const,
          tracks: [mkTrack('track-fresh', opts.fresh.nonGap)],
        },
        {
          id: opts.stale.sessionId,
          name: 'stale session',
          createdAt: '2026-03-01T00:00:00Z',
          mode: 'one-per-clone' as const,
          tracks: [mkTrack('track-stale', opts.stale.nonGap)],
        },
      ],
      viewPreferences: {},
    });
  }

  it('flags the stale session and reference when one session has wrong non-gap count', async () => {
    const referencePath = 'sequence-ref';
    const checksum = 'sha256:current-file-hash';
    mockExists.mockResolvedValue(true);
    mockReadTextFile.mockResolvedValue(
      buildMixedSidecar({
        refChecksum: checksum,
        fresh: { sessionId: 'sess-fresh', nonGap: 100 },
        stale: { sessionId: 'sess-stale', nonGap: 105 },
      })
    );
    mockComputeReferenceHash.mockResolvedValue(checksum);
    mockReadSequenceFile.mockResolvedValue('A'.repeat(100));

    await useVerificationStore.getState().loadSidecar(referencePath);

    const state = useVerificationStore.getState();
    expect(state.staleReferences[referencePath]).toBe(true);
    expect(state.staleSessionIds[referencePath]).toEqual(['sess-stale']);
    expect(state.staleSessionIds[referencePath]).not.toContain('sess-fresh');
  });

  it('clears staleness only when ALL sessions match current sequence', async () => {
    const referencePath = 'sequence-ref';
    const checksum = 'sha256:current-file-hash';
    mockExists.mockResolvedValue(true);
    mockReadTextFile.mockResolvedValue(
      buildMixedSidecar({
        refChecksum: checksum,
        fresh: { sessionId: 'sess-a', nonGap: 100 },
        stale: { sessionId: 'sess-b', nonGap: 100 },
      })
    );
    mockComputeReferenceHash.mockResolvedValue(checksum);
    mockReadSequenceFile.mockResolvedValue('A'.repeat(100));

    await useVerificationStore.getState().loadSidecar(referencePath);

    const state = useVerificationStore.getState();
    expect(state.staleReferences[referencePath]).toBe(false);
    expect(state.staleSessionIds[referencePath]).toEqual([]);
  });

  it('flags ALL sessions stale when the file checksum mismatches (regardless of per-session content)', async () => {
    const referencePath = 'sequence-ref';
    mockExists.mockResolvedValue(true);
    mockReadTextFile.mockResolvedValue(
      buildMixedSidecar({
        refChecksum: 'sha256:old-file',
        fresh: { sessionId: 'sess-a', nonGap: 100 },
        stale: { sessionId: 'sess-b', nonGap: 100 },
      })
    );
    mockComputeReferenceHash.mockResolvedValue('sha256:new-file');
    mockReadSequenceFile.mockResolvedValue('A'.repeat(100));

    await useVerificationStore.getState().loadSidecar(referencePath);

    const state = useVerificationStore.getState();
    expect(state.staleReferences[referencePath]).toBe(true);
    expect(state.staleSessionIds[referencePath]).toEqual(
      expect.arrayContaining(['sess-a', 'sess-b'])
    );
  });

  it('does NOT silently pass when the FIRST session is fresh but a later one is stale (the bug)', async () => {
    const referencePath = 'sequence-ref';
    const checksum = 'sha256:current-file-hash';
    mockExists.mockResolvedValue(true);
    mockReadTextFile.mockResolvedValue(
      buildMixedSidecar({
        refChecksum: checksum,
        fresh: { sessionId: 'sess-fresh', nonGap: 100 },
        stale: { sessionId: 'sess-stale', nonGap: 95 },
      })
    );
    mockComputeReferenceHash.mockResolvedValue(checksum);
    mockReadSequenceFile.mockResolvedValue('A'.repeat(100));

    await useVerificationStore.getState().loadSidecar(referencePath);

    const state = useVerificationStore.getState();
    expect(state.staleReferences[referencePath]).toBe(true);
    expect(state.staleSessionIds[referencePath]).toEqual(['sess-stale']);
  });

  it('retains historical curation even when its session is no longer eligible', async () => {
    const referencePath = 'sequence-ref';
    const checksum = 'sha256:current-file-hash';
    mockExists.mockResolvedValue(true);
    const sidecar = JSON.parse(
      buildMixedSidecar({
        refChecksum: checksum,
        fresh: { sessionId: 'sess-fresh', nonGap: 100 },
        stale: { sessionId: 'sess-stale', nonGap: 95 },
      })
    );
    sidecar.sessions[0].tracks[0].checkedMutations = ['mut-1', 'mut-2'];
    sidecar.sessions[1].tracks[0].checkedMutations = ['mut-3'];
    mockReadTextFile.mockResolvedValue(JSON.stringify(sidecar));
    mockComputeReferenceHash.mockResolvedValue(checksum);
    mockReadSequenceFile.mockResolvedValue('A'.repeat(100));

    await useVerificationStore.getState().loadSidecar(referencePath);

    const refState = useVerificationStore.getState().verificationState[referencePath];
    const fresh = refState.sessions.find((s) => s.id === 'sess-fresh');
    const stale = refState.sessions.find((s) => s.id === 'sess-stale');

    expect(fresh?.tracks[0].checkedMutations).toEqual(['mut-1', 'mut-2']);
    expect(stale?.tracks[0].checkedMutations).toEqual(['mut-3']);
  });
});
