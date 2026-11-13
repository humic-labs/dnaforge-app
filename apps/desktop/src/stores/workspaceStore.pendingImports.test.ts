import { describe, it, expect, beforeEach } from 'vitest';
import { useWorkspaceStore, type PendingImport } from './workspaceStore';

const base: PendingImport = {
  id: 'imp-1',
  originPath: '/Users/me/lab',
  displayName: 'lab',
  kind: 'folder',
  status: 'scanning',
};

describe('workspaceStore pendingImports ', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ pendingImports: [] });
  });

  it('starts and finishes a pending import', () => {
    const store = useWorkspaceStore.getState();
    store.startPendingImport(base);
    expect(useWorkspaceStore.getState().pendingImports).toHaveLength(1);
    store.finishPendingImport('imp-1');
    expect(useWorkspaceStore.getState().pendingImports).toHaveLength(0);
  });

  it('ignores a duplicate start for the same id', () => {
    const store = useWorkspaceStore.getState();
    store.startPendingImport(base);
    store.startPendingImport({ ...base, displayName: 'changed' });
    const pending = useWorkspaceStore.getState().pendingImports;
    expect(pending).toHaveLength(1);
    expect(pending[0].displayName).toBe('lab');
  });

  it('updates progress fields', () => {
    const store = useWorkspaceStore.getState();
    store.startPendingImport(base);
    store.updatePendingImport('imp-1', {
      status: 'copying',
      filesCopied: 5,
      totalFiles: 10,
      bytesCopied: 500,
      totalBytes: 1000,
    });
    const entry = useWorkspaceStore.getState().pendingImports[0];
    expect(entry.status).toBe('copying');
    expect(entry.filesCopied).toBe(5);
    expect(entry.totalFiles).toBe(10);
  });

  it('short-circuits an identical update (no new array reference)', () => {
    const store = useWorkspaceStore.getState();
    store.startPendingImport({ ...base, status: 'copying', filesCopied: 3, totalFiles: 10 });
    const before = useWorkspaceStore.getState().pendingImports;
    store.updatePendingImport('imp-1', { filesCopied: 3, totalFiles: 10 });
    expect(useWorkspaceStore.getState().pendingImports).toBe(before);
  });

  it('produces a new array reference on a real change', () => {
    const store = useWorkspaceStore.getState();
    store.startPendingImport({ ...base, status: 'copying', filesCopied: 3 });
    const before = useWorkspaceStore.getState().pendingImports;
    store.updatePendingImport('imp-1', { filesCopied: 4 });
    expect(useWorkspaceStore.getState().pendingImports).not.toBe(before);
    expect(useWorkspaceStore.getState().pendingImports[0].filesCopied).toBe(4);
  });

  it('finish + update for an unknown id are no-ops', () => {
    const store = useWorkspaceStore.getState();
    store.startPendingImport(base);
    const before = useWorkspaceStore.getState().pendingImports;
    store.updatePendingImport('nope', { status: 'copying' });
    store.finishPendingImport('nope');
    expect(useWorkspaceStore.getState().pendingImports).toBe(before);
  });
});
