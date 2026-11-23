import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { DOMSerializer } from '@tiptap/pm/model';
import { closeHistory } from '@tiptap/pm/history';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotebookMentionNode } from '../../../../shared/notebook-model/extensions/notebook-mention-model';
import { extractNotebookReferenceOccurrences } from '../../../../shared/notebook-reference-occurrences';
import { createMentionInsertCommand } from './mention-insert';

const originalId = '10000000-0000-4000-8000-000000000001';
let editor: Editor;
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  editor = new Editor({
    extensions: [StarterKit, NotebookMentionNode],
    content: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'A' },
            {
              type: 'mention',
              attrs: {
                id: 'repo-b::target',
                entityId: 'repo-b::target',
                entityType: 'sequence',
                label: 'Target',
                occurrenceId: originalId,
              },
            },
            { type: 'text', text: 'B' },
          ],
        },
      ],
    },
  });
});
afterEach(() => editor.destroy());
function rows() {
  return extractNotebookReferenceOccurrences(editor.getJSON());
}
function clipboardHtml() {
  editor.commands.setTextSelection({ from: 2, to: 3 });
  const slice = editor.state.selection.content();
  const host = document.createElement('div');
  host.append(DOMSerializer.fromSchema(editor.schema).serializeFragment(slice.content));
  return { slice, html: host.innerHTML };
}

describe('mention occurrence editing transactions', () => {
  it('replaces the entire query atomically without inserting document whitespace', () => {
    editor.commands.setContent('<p>Before @Target after</p>');
    editor.view.dispatch(closeHistory(editor.state.tr));
    const before = editor.getJSON();
    const changes: unknown[] = [];
    editor.on('transaction', ({ transaction }) => {
      if (transaction.docChanged) changes.push(transaction);
    });
    createMentionInsertCommand({
      editor,
      range: { from: 8, to: 15 },
      props: {
        entityType: 'sequence',
        entityId: 'repo-b::target',
        label: 'Target',
        projectId: 'repo-b',
        path: 'target.gb',
      },
    });
    expect(changes).toHaveLength(1);
    expect(editor.getText()).toBe('Before Target after');
    expect(rows()).toHaveLength(1);
    expect(rows()[0].occurrenceId).not.toBe('repo-b::target');
    editor.commands.undo();
    expect(editor.getJSON()).toEqual(before);
    editor.commands.redo();
    expect(rows()).toHaveLength(1);
  });

  it('gives an HTML-pasted copy a new ID even when it is pasted before the original', () => {
    const { html } = clipboardHtml();
    editor.commands.setTextSelection(1);
    expect(editor.view.pasteHTML(html, new Event('paste') as ClipboardEvent)).toBe(true);
    const inserted = rows();
    expect(inserted).toHaveLength(2);
    expect(inserted[1].occurrenceId).toBe(originalId);
    expect(inserted[0].occurrenceId).not.toBe(originalId);
    expect(inserted.map((row) => row.targetEntityId)).toEqual(['repo-b::target', 'repo-b::target']);
    editor.commands.undo();
    expect(rows().map((row) => row.occurrenceId)).toEqual([originalId]);
    editor.commands.redo();
    expect(rows()).toEqual(inserted);
  });

  it('preserves identity for a cut-and-paste move inside the same editor', () => {
    const { html } = clipboardHtml();
    editor.view.someProp('handleDOMEvents', (handlers) => {
      handlers.cut?.(editor.view, new Event('cut'));
      return false;
    });
    editor.commands.deleteSelection();
    editor.commands.setTextSelection(1);
    expect(editor.view.pasteHTML(html, new Event('paste') as ClipboardEvent)).toBe(true);
    expect(rows().map((row) => row.occurrenceId)).toEqual([originalId]);
    expect(editor.getText()).toBe('TargetAB');
  });

  it.each([true, false])('uses the editor drag ownership signal for moved=%s', (moved) => {
    const { slice } = clipboardHtml();
    const original = editor.state.doc.nodeAt(2)!;
    editor.view.someProp('handleDrop', (handler) => {
      handler(editor.view, new Event('drop') as DragEvent, slice, moved);
      return false;
    });
    const transaction = editor.state.tr;
    if (moved) transaction.delete(2, 3);
    transaction.insert(1, original).setMeta('uiEvent', 'drop');
    editor.view.dispatch(transaction);
    if (moved) expect(rows().map((row) => row.occurrenceId)).toEqual([originalId]);
    else {
      expect(rows()).toHaveLength(2);
      expect(rows()[1].occurrenceId).toBe(originalId);
      expect(rows()[0].occurrenceId).not.toBe(originalId);
    }
  });
});
