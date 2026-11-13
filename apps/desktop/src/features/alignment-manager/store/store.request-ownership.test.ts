// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useVerificationStore } from './store';
const { readAlignmentHistory } = vi.hoisted(() => ({ readAlignmentHistory: vi.fn() }));
vi.mock('./verification-autosave', () => ({
  startVerificationAutosave: vi.fn(),
  markLoadedVerificationState: vi.fn(),
}));
vi.mock('../utils/alignment-history-persist', () => ({
  readAlignmentHistory,
  writeAlignmentHistory: vi.fn(),
  publishManagedAlignmentHistory: vi.fn(),
}));
vi.mock('../utils/hash', () => ({
  computeReferenceHash: async () => 'reference-hash',
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
function sidecar(id: string) {
  return JSON.stringify({
    type: 'alignment-history',
    version: '3.0',
    reference: { name: 'reference', checksum: 'reference-hash', documentId: 'document-a' },
    savedAt: '2026-11-01T00:00:00Z',
    activeSessionId: id,
    sessions: [
      { id, name: id, createdAt: '2026-10-31T00:00:00Z', mode: 'one-per-clone', tracks: [] },
    ],
    viewPreferences: {},
  });
}
describe('alignment load ownership', () => {
  beforeEach(() => {
    readAlignmentHistory.mockReset();
    useVerificationStore.setState({
      verificationState: {},
      referenceSourcePaths: {},
      sessionViewPreferences: {},
    });
    useVerificationStore.getState().registerReferenceSource('document-a', '/project/reference.gb');
  });
  it('preserves the session created while saved history is loading', async () => {
    const read = deferred<string>();
    readAlignmentHistory.mockReturnValueOnce(read.promise);
    const pending = useVerificationStore.getState().loadSidecar('document-a');
    const id = useVerificationStore.getState().createSession('document-a', {
      name: 'New user session',
      mode: 'one-per-clone',
      queryPaths: [],
    });
    read.resolve(sidecar('disk-session'));
    expect(await pending).toBe(false);
    expect(
      useVerificationStore.getState().getVerificationState('document-a')?.activeSessionId
    ).toBe(id);
  });
  it('keeps the newest overlapping load', async () => {
    const read = deferred<string>();
    readAlignmentHistory.mockReturnValueOnce(read.promise).mockResolvedValueOnce(sidecar('newest'));
    const pending = useVerificationStore.getState().loadSidecar('document-a');
    expect(await useVerificationStore.getState().loadSidecar('document-a')).toBe(true);
    read.resolve(sidecar('old'));
    expect(await pending).toBe(false);
    expect(
      useVerificationStore.getState().getVerificationState('document-a')?.activeSessionId
    ).toBe('newest');
  });
  it('retires a load when the reference source changes', async () => {
    const read = deferred<string>();
    readAlignmentHistory.mockReturnValueOnce(read.promise);
    const pending = useVerificationStore.getState().loadSidecar('document-a');
    useVerificationStore.getState().registerReferenceSource('document-a', '/project/other.gb');
    read.resolve(sidecar('old'));
    expect(await pending).toBe(false);
    expect(useVerificationStore.getState().getVerificationState('document-a')).toBeUndefined();
  });
});
