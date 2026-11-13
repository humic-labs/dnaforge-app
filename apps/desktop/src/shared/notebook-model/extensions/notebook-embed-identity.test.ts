// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { NotebookEmbedNode } from './notebook-embed-model';

let editor: Editor | undefined;

afterEach(() => editor?.destroy());

it('assigns new structure identities during edits while preserving hydrated placeholders', () => {
  editor = new Editor({ extensions: [StarterKit, NotebookEmbedNode] });
  const content = {
    type: 'doc',
    content: [
      { type: 'paragraph' },
      {
        type: 'embed',
        attrs: { type: 'structure3d', refId: 'legacy', data: { label: 'Existing' } },
      },
      { type: 'paragraph' },
    ],
  };
  editor.commands.setContent(content, { emitUpdate: false });
  const data = (refId: string) =>
    editor?.getJSON().content?.find((node) => node.attrs?.refId === refId)?.attrs?.data;
  expect(data('legacy')).toEqual({ label: 'Existing' });

  editor.commands.insertEmbed({
    type: 'structure3d',
    refId: 'created',
    data: { label: 'Created' },
  });
  expect(data('created')).toEqual({
    label: 'Created',
    id: expect.stringMatching(/^structure-/),
  });
  expect(data('legacy')).toEqual({ label: 'Existing' });
  const identity = data('created').id;
  editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  editor.commands.insertContent('Text');
  expect(data('created').id).toBe(identity);
  expect(data('legacy')).toEqual({ label: 'Existing' });
});

it('Undo restores a deleted legacy placeholder without creating a saved identity', () => {
  editor = new Editor({
    extensions: [StarterKit, NotebookEmbedNode],
    content: {
      type: 'doc',
      content: [
        { type: 'paragraph' },
        { type: 'embed', attrs: { type: 'structure3d', refId: 'legacy', data: {} } },
        { type: 'paragraph' },
      ],
    },
  });
  const original = editor.getJSON();
  let position = -1;
  editor.state.doc.descendants((node, offset) => {
    if (node.attrs.refId === 'legacy') position = offset;
  });
  expect(position).toBeGreaterThanOrEqual(0);
  editor.commands.setNodeSelection(position);
  editor.commands.deleteSelection();
  expect(editor.getJSON().content?.some((node) => node.type === 'embed')).toBe(false);
  expect(editor.commands.undo()).toBe(true);
  expect(editor.getJSON()).toEqual(original);
  expect(editor.commands.redo()).toBe(true);
  expect(editor.getJSON().content?.some((node) => node.type === 'embed')).toBe(false);
  expect(editor.commands.undo()).toBe(true);
  expect(editor.getJSON()).toEqual(original);
});
