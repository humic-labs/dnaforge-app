// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useVerificationStore } from './store';
const { readAlignmentHistory, writeAlignmentHistory, computeReferenceHash } = vi.hoisted(() => ({
  readAlignmentHistory: vi.fn(),
  writeAlignmentHistory: vi.fn(),
  computeReferenceHash: vi.fn(),
}));
vi.mock('./verification-autosave', () => ({
  startVerificationAutosave: vi.fn(),
  markLoadedVerificationState: vi.fn(),
}));
vi.mock('../utils/alignment-history-persist', () => ({
  readAlignmentHistory,
  writeAlignmentHistory,
  publishManagedAlignmentHistory: vi.fn(),
}));
vi.mock('../utils/hash', () => ({
  computeReferenceHash,
  computePairwiseReferenceRevision: async () => 'sequence-revision',
}));
vi.mock('../utils/stage-alignment-query', () => ({
  findSequencePackageRootForReference: async () => null,
}));
vi.mock('../utils/alignment-api', () => ({
  readSequenceFile: async () => 'AAAA',
  readReferenceForMutations: async () => ({ circular: false }),
}));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
describe('alignment save ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    writeAlignmentHistory.mockResolvedValue('/project/reference.waypoint.json');
    computeReferenceHash.mockResolvedValue('reference-hash');
    useVerificationStore.setState({
      verificationState: {},
      referenceSourcePaths: {},
      sessionViewPreferences: {},
      staleReferences: {},
      referenceFileChecksums: {},
    });
    useVerificationStore.getState().registerReferenceSource('document-a', '/project/reference.gb');
  });

  it('keeps the newest sessions on disk when an earlier save is delayed while hashing', async () => {
    useVerificationStore
      .getState()
      .createSession('document-a', {
        name: 'First session',
        mode: 'one-per-clone',
        queryPaths: [],
      });
    const hash = deferred<string>();
    computeReferenceHash.mockReturnValueOnce(hash.promise);
    const first = useVerificationStore.getState().saveSidecar('document-a');
    await vi.waitFor(() => expect(computeReferenceHash).toHaveBeenCalledTimes(1));
    useVerificationStore
      .getState()
      .createSession('document-a', {
        name: 'Second session',
        mode: 'one-per-clone',
        queryPaths: [],
      });
    const second = useVerificationStore.getState().saveSidecar('document-a');
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    hash.resolve('reference-hash');
    await Promise.all([first, second]);
    const last = writeAlignmentHistory.mock.calls.at(-1);
    expect(last?.[0]).toBe('/project/reference.gb');
    expect(
      JSON.parse(last?.[1] ?? '{}').sessions.map((session: { name: string }) => session.name)
    ).toEqual(['First session', 'Second session']);
  });
});
