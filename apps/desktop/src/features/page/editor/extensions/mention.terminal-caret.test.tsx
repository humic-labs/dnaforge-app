// @vitest-environment jsdom
import { Editor, type AnyExtension, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, expect, it, vi } from 'vitest';
import { MentionExtension } from './mention';
import { NotebookMentionNode } from './notebook-mention-model';

let editor: Editor | null = null;
const mention: JSONContent = {
  type: 'mention',
  attrs: { entityType: 'page', entityId: 'page-1', label: 'Reference' },
};
const text = (value: string): JSONContent => ({ type: 'text', text: value });
const paragraph = (...content: JSONContent[]): JSONContent => ({ type: 'paragraph', content });

afterEach(() => {
  editor?.destroy();
  editor = null;
});

function mount(
  content: JSONContent[],
  selection: number | { from: number; to: number },
  extension: AnyExtension = MentionExtension
) {
  editor = new Editor({
    extensions: [StarterKit.configure({ trailingNode: false }), extension],
    content: { type: 'doc', content },
  });
  editor.commands.setTextSelection(selection);
  return editor;
}

function keydown(key: string) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  return Boolean(editor!.view.someProp('handleKeyDown', (handler) => handler(editor!.view, event)));
}

it.each([
  ['bare terminal mention', paragraph(mention), 2],
  ['text followed by terminal mention', paragraph(text('x'), mention), 3],
] as const)('consumes ArrowRight without a transaction at a %s', (_name, content, position) => {
  const ed = mount([content], position);
  const before = ed.state;
  const transaction = vi.fn();
  ed.on('transaction', transaction);

  expect(keydown('ArrowRight')).toBe(true);
  expect(transaction).not.toHaveBeenCalled();
  expect(ed.state).toBe(before);
});

it.each([
  ['ordinary text end', [paragraph(text('x'))], 2],
  ['mention followed by another paragraph', [paragraph(mention), paragraph(text('x'))], 2],
  ['position before the mention', [paragraph(text('x'), mention)], 2],
  ['nonempty selection', [paragraph(mention)], { from: 1, to: 2 }],
] as const)('leaves ArrowRight unhandled for %s', (_name, content, selection) => {
  mount([...content], selection);
  expect(keydown('ArrowRight')).toBe(false);
});

it('keeps the chip in the notebook while the shared model retains normal deletion', () => {
  const parent = mount([paragraph(text('x'), mention)], 3, NotebookMentionNode);
  expect(keydown('Backspace')).toBe(true);
  const parentDocument = parent.getJSON();
  expect(parentDocument.content).toEqual([paragraph(text('x'))]);
  parent.destroy();
  editor = null;

  const ed = mount([paragraph(text('x'), mention)], 3);
  const original = ed.getJSON();
  expect(keydown('Backspace')).toBe(true);
  expect(ed.getJSON()).toEqual(original);
  expect(ed.state.selection.from).toBe(3);
});
