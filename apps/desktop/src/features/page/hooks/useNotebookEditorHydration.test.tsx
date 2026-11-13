// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Editor, Node, type JSONContent } from '@tiptap/core';
import { getBaseExtensions } from '../editor/extensions';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { EditorContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor } from '@tiptap/react';
import { useNotebookEditorHydration } from './useNotebookEditorHydration';

const empty: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] };
const saved: JSONContent = { type: 'doc', content: [{ type: 'savedView' }] };
const savedView = Node.create({
  name: 'savedView',
  group: 'block',
  atom: true,
  parseHTML: () => [{ tag: 'saved-view' }],
  renderHTML: () => ['saved-view'],
  addNodeView: () =>
    ReactNodeViewRenderer(() => (
      <NodeViewWrapper data-testid="rendered-saved-view">Saved view loaded</NodeViewWrapper>
    )),
});

function Notebook({
  content,
  allowed = true,
  updated,
}: {
  content: JSONContent;
  allowed?: boolean;
  updated: () => void;
}) {
  const editor = useEditor({
    extensions: [Document, Paragraph, Text, savedView],
    content: empty,
    onUpdate: updated,
  });
  useNotebookEditorHydration({
    editor,
    content,
    blocked: false,
    canApply: () => allowed,
    onHydrated: () => {},
  });
  return (
    <>
      <EditorContent editor={editor} />
      <button onClick={() => editor?.commands.insertContent('Local edit')}>Edit</button>
    </>
  );
}

describe('notebook hydration with real React node views', () => {
  it('mounts an asynchronously arriving saved block without nested React flushes or a synthetic edit', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const updated = vi.fn();
    try {
      const { rerender } = render(<Notebook content={empty} updated={updated} />);
      await screen.findByRole('button', { name: 'Edit' });
      rerender(<Notebook content={saved} updated={updated} />);
      await screen.findByTestId('rendered-saved-view');
      expect(
        errors.mock.calls.filter((args) => /flushSync.*lifecycle/.test(String(args[0])))
      ).toHaveLength(0);
      expect(updated).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it('keeps local edits when the latest ownership check rejects hydration', async () => {
    const updated = vi.fn();
    const { rerender } = render(<Notebook content={empty} updated={updated} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    rerender(<Notebook content={saved} allowed={false} updated={updated} />);
    await waitFor(() => expect(screen.queryByTestId('rendered-saved-view')).toBeNull());
    expect(screen.getByText('Local edit')).toBeVisible();
  });
});

it('keeps a saved document ending in a heading clean through selection-only transactions', () => {
  const updated = vi.fn();
  const editor = new Editor({
    extensions: getBaseExtensions(),
    content: {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 1 },
          content: [{ type: 'text', text: 'Saved heading' }],
        },
      ],
    },
    onUpdate: updated,
  });
  try {
    expect(editor.state.doc.childCount).toBe(1);
    editor.commands.setTextSelection(2);
    expect(editor.state.doc.childCount).toBe(1);
    expect(updated).not.toHaveBeenCalled();
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    editor.commands.splitBlock();
    expect(editor.state.doc.lastChild?.type.name).toBe('paragraph');
    expect(updated).toHaveBeenCalledTimes(1);
  } finally {
    editor.destroy();
  }
});
