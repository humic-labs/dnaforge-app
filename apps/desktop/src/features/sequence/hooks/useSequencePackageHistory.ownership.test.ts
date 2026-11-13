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
describe('package history selection ownership', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    ports.readIndex.mockResolvedValue(indexA);
    ports.readRevision.mockResolvedValue({
      status: 'available',
      content: 'A',
      revision: { id: 'revision-a', parentId: null },
    });
  });
  it.each(['different package', 'no package', 'no workspace'] as const)(
    'clears completed selection immediately for %s',
    async (change) => {
      const pending = deferred<unknown>();
      const { result, rerender } = renderHook(
        ({ document, root }) => useSequencePackageHistory(document, root),
        {
          initialProps: {
            document: documentA as ManagedSequenceDocumentRef | undefined,
            root: '/project' as string | null,
          },
        }
      );
      await waitFor(() => expect(result.current.index).toBe(indexA));
      act(() => result.current.selectRevision('revision-a'));
      await waitFor(() => expect(result.current.selectedSequence?.sequence).toBe('AAAA'));
      ports.readIndex.mockReturnValue(pending.promise);
      rerender({
        document:
          change === 'no package'
            ? undefined
            : change === 'different package'
              ? {
                  ...documentA,
                  packageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                  packageRoot: '/project/b.sequence',
                }
              : documentA,
        root: change === 'no workspace' ? null : '/project',
      });
      expect(result.current.selectedRevisionId).toBeNull();
      expect(result.current.selectedSequence).toBeNull();
      expect(result.current.selectedParentSequence).toBeNull();
      expect(result.current.selectedParentStatus).toBe('none');
    }
  );
});
