// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedSequenceDocumentRef } from '../../../shared/managed-sequence-document';
import { useSequencePackageHistory } from './useSequencePackageHistory';
const ports = vi.hoisted(() => ({ readIndex: vi.fn(), readRevision: vi.fn(), fs: {} }));
vi.mock('../../../platform', () => ({ platform: () => ({ fs: ports.fs }) }));
vi.mock('../../../db/sequence-package-history-io', () => ({
  readSequencePackageHistoryIndex: ports.readIndex,
  readSequencePackageRevision: ports.readRevision,
}));
vi.mock('../../../services/read-scientific-namespace', () => ({
  readScientificNamespace: async () => null,
}));
vi.mock('../../../shared/parse-sequence-file', () => ({
  parseSequenceFileAsDocument: () => ({ sequence: { sequence: 'AAAA', name: 'Package A' } }),
}));
const documentA: ManagedSequenceDocumentRef = {
  kind: 'managed-sequence',
  packageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  packageRoot: '/project/a.sequence',
};
const indexA = {
  document: { id: documentA.packageId, versionHistory: { revisions: [{ id: 'revision-a' }] } },
  productPath: '/project/a.sequence/product.gb',
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
describe('package history selection lifecycle', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    ports.readIndex.mockResolvedValue(indexA);
    ports.readRevision.mockResolvedValue({
      status: 'available',
      content: 'A',
      revision: { id: 'revision-a', parentId: null },
    });
  });
  it('retains an already selected revision when selected again', async () => {
    const { result } = renderHook(() => useSequencePackageHistory(documentA, '/project'));
    await waitFor(() => expect(result.current.index).toBe(indexA));
    act(() => result.current.selectRevision('revision-a'));
    await waitFor(() => expect(result.current.selectedSequence?.sequence).toBe('AAAA'));
    act(() => result.current.selectRevision('revision-a'));
    expect(result.current.selectedRevisionId).toBe('revision-a');
    expect(result.current.selectedSequence?.sequence).toBe('AAAA');
  });
  it('retires a pending revision immediately when selection is cleared', async () => {
    const read = deferred<unknown>();
    ports.readRevision.mockReturnValue(read.promise);
    const { result } = renderHook(() => useSequencePackageHistory(documentA, '/project'));
    await waitFor(() => expect(result.current.index).toBe(indexA));
    act(() => result.current.selectRevision('revision-a'));
    await waitFor(() => expect(ports.readRevision).toHaveBeenCalledOnce());
    act(() => result.current.selectRevision(null));
    await act(async () => {
      read.resolve({
        status: 'available',
        content: 'A',
        revision: { id: 'revision-a', parentId: null },
      });
    });
    expect(result.current.selectedSequence).toBeNull();
    expect(result.current.selectedRevisionId).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });
  it('does not restore a parent comparison after selection is cleared', async () => {
    const parent = deferred<unknown>();
    ports.readRevision
      .mockResolvedValueOnce({
        status: 'available',
        content: 'A',
        revision: { id: 'revision-a', parentId: 'parent-a' },
      })
      .mockReturnValueOnce(parent.promise);
    const { result } = renderHook(() => useSequencePackageHistory(documentA, '/project'));
    await waitFor(() => expect(result.current.index).toBe(indexA));
    act(() => result.current.selectRevision('revision-a'));
    await waitFor(() => expect(result.current.selectedParentStatus).toBe('loading'));
    act(() => result.current.selectRevision(null));
    await act(async () => {
      parent.resolve({
        status: 'available',
        content: 'P',
        revision: { id: 'parent-a', parentId: null },
      });
    });
    expect(result.current.selectedParentSequence).toBeNull();
    expect(result.current.selectedParentStatus).toBe('none');
  });
  it('reports unavailable revision and finishes loading without a comparison', async () => {
    ports.readRevision.mockResolvedValue({
      status: 'unavailable',
      reason: 'Snapshot missing',
      revision: { id: 'revision-a', parentId: null },
    });
    const { result } = renderHook(() => useSequencePackageHistory(documentA, '/project'));
    await waitFor(() => expect(result.current.index).toBe(indexA));
    act(() => result.current.selectRevision('revision-a'));
    await waitFor(() => expect(result.current.error).toBe('Snapshot missing'));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.selectedSequence).toBeNull();
  });
});
