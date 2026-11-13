import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';

const { persistSequenceDocument, completeSequenceDocumentSave } = vi.hoisted(() => ({
  persistSequenceDocument: vi.fn(),
  completeSequenceDocumentSave: vi.fn(async () => ({ status: 'committed', repositoryRoot: '/p' })),
}));
vi.mock('./persist-sequence-document', () => ({ persistSequenceDocument }));
vi.mock('./complete-sequence-document-save', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./complete-sequence-document-save')>()),
  completeSequenceDocumentSave,
}));

import { useSequenceStore } from './store';
import {
  registerSequenceSave,
  resetSequenceSaveRegistryForTests,
  saveAllDirtySequences,
} from './save-all-sequences';

function edit(documentId: string): void {
  const doc: AnnotatedSequence = {
    id: documentId,
    name: documentId,
    length: 4,
    sequence: 'ACGT',
    annotations: [],
    metadata: {},
    circular: false,
  };
  useSequenceStore.getState().setSequence(documentId, doc);
  useSequenceStore.getState().dispatchEdit(documentId, { type: 'INSERT', text: 'A' });
}

describe('saveAllDirtySequences ', () => {
  beforeEach(() => {
    resetSequenceSaveRegistryForTests();
    useSequenceStore.getState().clearAll();
    completeSequenceDocumentSave.mockClear();
    persistSequenceDocument.mockReset().mockImplementation(async ({ document, onPersisted }) => {
      useSequenceStore.getState().markClean(document.documentId);
      await onPersisted?.();
      return {
        ok: true,
        outcome: 'saved',
        attempts: 1,
        wrote: true,
        writtenRevision: useSequenceStore.getState().savedVersions[document.documentId],
      };
    });
  });

  it('saves a document whose tab is no longer mounted, from its last known path', async () => {
    edit('doc-unmounted');
    const unregister = registerSequenceSave('doc-unmounted', '/p/a.gb', false, vi.fn());
    unregister();

    expect(await saveAllDirtySequences()).toEqual({ saved: 1, failed: [] });
    expect(persistSequenceDocument).toHaveBeenCalledWith(
      expect.objectContaining({ document: { documentId: 'doc-unmounted', sourcePath: '/p/a.gb' } })
    );
    expect(completeSequenceDocumentSave).toHaveBeenCalledWith(
      { documentId: 'doc-unmounted', sourcePath: '/p/a.gb' },
      'Save a.gb',
      undefined
    );
  });

  it('keeps the accepted publication receipt when saving an unmounted scientific document', async () => {
    edit('doc-scientific');
    registerSequenceSave('doc-scientific', '/p/scientific.gb', false, vi.fn())();
    const publication = { kind: 'accepted-object' as const, repositoryRoot: '/p' };
    persistSequenceDocument.mockImplementationOnce(async ({ document, onPersisted }) => {
      useSequenceStore.getState().markClean(document.documentId);
      await onPersisted(publication);
      return { ok: true, outcome: 'saved', attempts: 1, wrote: true };
    });
    expect(await saveAllDirtySequences()).toEqual({ saved: 1, failed: [] });
    expect(completeSequenceDocumentSave).toHaveBeenCalledExactlyOnceWith(
      { documentId: 'doc-scientific', sourcePath: '/p/scientific.gb' },
      'Save scientific.gb',
      publication
    );
  });

  it('uses the mounted tab save when there is one, and reports what stayed unsaved', async () => {
    edit('doc-mounted');
    edit('doc-unknown');
    const mountedSave = vi.fn(async () => {
      useSequenceStore.getState().markClean('doc-mounted');
      return true;
    });
    registerSequenceSave('doc-mounted', '/p/b.gb', false, mountedSave);

    expect(await saveAllDirtySequences()).toEqual({ saved: 1, failed: ['doc-unknown'] });
    expect(mountedSave).toHaveBeenCalledOnce();
    expect(persistSequenceDocument).not.toHaveBeenCalled();
  });
});
