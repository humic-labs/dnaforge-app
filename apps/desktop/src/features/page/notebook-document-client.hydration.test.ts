import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { expect, it, vi } from 'vitest';
import { NativeNotebookDocumentClient } from './notebook-document-client';
import type { NotebookDocumentSnapshot } from '../../shared/notebook-document';

vi.mock('../../platform', () => ({ platform: () => ({ notebook: {} }) }));
vi.mock('../workspace/public/file-document-client', () => ({
  registerNativeDocumentClientFlush() {},
  waitForNativeFileDocumentReadiness: async () => {},
}));
vi.mock('../../shared/unsaved-draft-recovery', () => ({
  readAllUnsavedDrafts: async () => [],
  deleteUnsavedDraft: async () => {},
}));
vi.mock('../../stores/toast-store', () => ({
  useToastStore: { getState: () => ({ addRichToast() {} }) },
}));

it('attaching and projecting a clean native copy do not emit authored editor updates', () => {
  const changes: boolean[] = [];
  const editor = new Editor({
    extensions: [StarterKit],
    content: '<p>Retained source</p>',
    onUpdate: ({ transaction }) => changes.push(transaction.docChanged),
  });
  const client = new NativeNotebookDocumentClient('notebook');
  const snapshot: NotebookDocumentSnapshot = {
    documentId: 'notebook',
    pageId: 'notebook',
    path: '/project/Notebook',
    workspaceRoot: '/project',
    title: 'Notebook',
    revision: 'owner:0:notebook',
    persistedRevision: 'owner:0:notebook',
    canonicalFingerprint: 'saved-source',
    version: 0,
    ready: true,
    readOnly: false,
    dirty: false,
    saving: false,
    canUndo: false,
    canRedo: false,
    blockCount: 1,
    blocks: [],
    nextOffset: null,
    copy: { title: 'Notebook', content: editor.getJSON() },
  };
  try {
    const detach = client.attach(editor);
    expect(changes).toEqual([]);
    client.observe(snapshot);
    client.observe({ ...snapshot, readOnly: true });
    client.observe(snapshot);
    expect(changes).toEqual([]);
    expect(client.dirty).toBe(false);
    editor.commands.insertContent('Human edit');
    expect(changes).toEqual([true]);
    detach();
  } finally {
    editor.destroy();
  }
});
