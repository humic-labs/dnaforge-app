import type { Editor } from '@tiptap/core';

export interface NotebookEditorControl {
  editor: Editor;
  save: () => Promise<boolean>;
}
const controls = new Map<string, Set<NotebookEditorControl>>();

export function registerNotebookEditorControl(pageId: string, control: NotebookEditorControl) {
  const set = controls.get(pageId) ?? new Set<NotebookEditorControl>();
  set.add(control);
  controls.set(pageId, set);
  return () => {
    set.delete(control);
    if (!set.size) controls.delete(pageId);
  };
}

export function getNotebookEditorControl(pageId: string): NotebookEditorControl | null {
  const set = [...(controls.get(pageId) ?? [])].filter((control) => !control.editor.isDestroyed);
  if (set.length > 1)
    throw new Error(
      'This notebook has multiple editing views. Close the extra view before an agent edits it.'
    );
  return set[0] ?? null;
}
