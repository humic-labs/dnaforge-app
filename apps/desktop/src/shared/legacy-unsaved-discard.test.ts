import { describe, expect, it, vi } from 'vitest';
import { createLegacyUnsavedDiscard, legacyUnsavedDiscardScope } from './legacy-unsaved-discard';

function harness() {
  let roots = ['/admitted'];
  const drafts = new Map<string, unknown>(),
    sequences = new Map<string, unknown>();
  const remove = vi.fn(async (store: Map<string, unknown>, key: string, serialized: string) => {
    if (JSON.stringify(store.get(key)) !== serialized) return false;
    store.delete(key);
    return true;
  });
  const resolveDocument = vi.fn(async (id: string, kind: 'sequence' | 'notebook') => ({
    workspaceRoot: '/admitted',
    path: `/admitted/${id}`,
    kind,
  }));
  const canDiscardFile = vi.fn(async () => true);
  const service = createLegacyUnsavedDiscard({
    currentRoots: () => roots,
    draftSessionId: 'current-draft',
    sequenceSessionId: 'current-sequence',
    readDraft: async (key) => drafts.get(key),
    readSequence: async (key) => sequences.get(key),
    deleteDraftIfUnchanged: (key, value) => remove(drafts, key, value),
    deleteSequenceIfUnchanged: (key, value) => remove(sequences, key, value),
    flushDrafts: vi.fn(async () => {}),
    canDiscardFile,
    resolveDocument,
  });
  const scope = legacyUnsavedDiscardScope(
    {
      hasDirtyWork: true,
      details: 'changes',
      dirtyFilePaths: ['/admitted/current.txt', '/outside/current.txt'],
      dirtySequenceDocumentIds: ['current-sequence', 'pending-migration-sequence'],
      dirtyPageIds: ['current-page'],
      dirtyTabIds: ['current-primer', 'unmounted-protein'],
    },
    roots
  );
  return {
    service,
    scope,
    drafts,
    sequences,
    remove,
    resolveDocument,
    canDiscardFile,
    unmount: () => {
      roots = [];
    },
  };
}
describe('exact legacy recovery cleanup', () => {
  it('preserves a current-session file copy while its native migration or recovery is pending', async () => {
    const h = harness(),
      key = 'text:/admitted/current.txt';
    h.drafts.set(key, { key, sessionId: 'current-draft', payload: 'not acknowledged natively' });
    h.canDiscardFile.mockResolvedValue(false);
    const snapshot = await h.service.capture(h.scope);
    expect(snapshot.copies).toEqual([]);
    await h.service.discard(snapshot);
    expect(h.drafts.has(key)).toBe(true);
    expect(h.remove).not.toHaveBeenCalled();
  });
  it('discards current admitted exact copies while preserving unrelated, earlier-session and pending-migration copies', async () => {
    const h = harness();
    h.drafts.set('text:/admitted/current.txt', {
      key: 'text:/admitted/current.txt',
      sessionId: 'current-draft',
      payload: 'current',
    });
    h.drafts.set('table:/admitted/current.txt', {
      key: 'table:/admitted/current.txt',
      sessionId: 'earlier-draft',
      payload: 'pending migration',
    });
    h.drafts.set('text:/admitted/unlisted.txt', {
      key: 'text:/admitted/unlisted.txt',
      sessionId: 'current-draft',
      payload: 'unlisted',
    });
    h.drafts.set('text:/outside/current.txt', {
      key: 'text:/outside/current.txt',
      sessionId: 'current-draft',
      payload: 'other project',
    });
    h.drafts.set('page:current-page', {
      key: 'page:current-page',
      sessionId: 'current-draft',
      payload: { type: 'doc' },
    });
    h.drafts.set('new:current-primer', {
      key: 'new:current-primer',
      sessionId: 'current-draft',
      payload: { artifactDocument: { workspaceRoot: '/admitted', persistence: 'draft' } },
    });
    h.drafts.set('new:unmounted-protein', {
      key: 'new:unmounted-protein',
      sessionId: 'current-draft',
      payload: { artifactDocument: { workspaceRoot: '/unmounted', persistence: 'draft' } },
    });
    h.sequences.set('current-sequence', {
      documentId: 'current-sequence',
      sessionId: 'current-sequence',
      content: 'ACGT',
    });
    h.sequences.set('pending-migration-sequence', {
      documentId: 'pending-migration-sequence',
      sessionId: 'earlier-sequence',
      content: 'saved nowhere else',
    });
    const snapshot = await h.service.capture(h.scope);
    expect(snapshot.copies.map((copy) => copy.key).sort()).toEqual([
      'current-sequence',
      'new:current-primer',
      'page:current-page',
      'text:/admitted/current.txt',
    ]);
    expect(h.resolveDocument).not.toHaveBeenCalledWith(
      'pending-migration-sequence',
      expect.anything()
    );
    await h.service.discard(snapshot);
    expect([...h.drafts.keys()].sort()).toEqual([
      'new:unmounted-protein',
      'table:/admitted/current.txt',
      'text:/admitted/unlisted.txt',
      'text:/outside/current.txt',
    ]);
    expect([...h.sequences.keys()]).toEqual(['pending-migration-sequence']);
  });
  it('refuses a newer write after capture without deleting it', async () => {
    const h = harness(),
      key = 'text:/admitted/current.txt';
    h.drafts.set(key, { key, sessionId: 'current-draft', payload: 'captured' });
    const snapshot = await h.service.capture(h.scope);
    h.drafts.set(key, { key, sessionId: 'current-draft', payload: 'newer' });
    await expect(h.service.discard(snapshot)).rejects.toThrow('could not be discarded');
    expect(h.drafts.get(key)).toMatchObject({ payload: 'newer' });
    expect(h.remove).not.toHaveBeenCalled();
  });
  it('preserves captured copies when their project is unmounted before cleanup', async () => {
    const h = harness(),
      key = 'text:/admitted/current.txt';
    h.drafts.set(key, { key, sessionId: 'current-draft', payload: 'current' });
    const snapshot = await h.service.capture(h.scope);
    h.unmount();
    await expect(h.service.discard(snapshot)).rejects.toThrow('could not be discarded');
    expect(h.drafts.has(key)).toBe(true);
    expect(h.remove).not.toHaveBeenCalled();
  });
  it('surfaces a rejected cleanup instead of acknowledging global success', async () => {
    const h = harness(),
      key = 'text:/admitted/current.txt';
    h.drafts.set(key, { key, sessionId: 'current-draft', payload: 'current' });
    const snapshot = await h.service.capture(h.scope);
    h.remove.mockRejectedValueOnce(new Error('IndexedDB transaction failed.'));
    await expect(h.service.discard(snapshot)).rejects.toThrow('could not be discarded');
    expect(h.drafts.has(key)).toBe(true);
  });
});
