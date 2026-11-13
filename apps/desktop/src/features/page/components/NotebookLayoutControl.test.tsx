import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NotebookColumn, NotebookColumns } from '../editor/extensions/notebook-layout';
import { NotebookLayoutControl } from './NotebookLayoutControl';

const editors: Editor[] = [];

function createEditor() {
  const editor = new Editor({
    extensions: [StarterKit.configure({ trailingNode: false }), NotebookColumns, NotebookColumn],
    content: '<p>Incubate for 30 minutes.</p>',
  });
  editors.push(editor);
  return editor;
}

afterEach(() => {
  cleanup();
  editors.splice(0).forEach((editor) => editor.destroy());
});

describe('notebook Layout selector', () => {
  it('formats the actual editor selection and tracks changes, cursor movement, and undo', () => {
    const editor = createEditor();
    render(<NotebookLayoutControl editor={editor} />);
    const selector = screen.getByRole('combobox', { name: 'Notebook layout' });
    expect(selector).toHaveValue('single-column');

    fireEvent.change(selector, { target: { value: 'two-columns' } });
    expect(editor.state.doc.firstChild!.childCount).toBe(2);
    expect(editor.state.doc.firstChild!.textContent).toBe('Incubate for 30 minutes.');
    expect(selector).toHaveValue('two-columns');

    fireEvent.change(selector, { target: { value: 'three-columns' } });
    expect(editor.state.doc.firstChild!.childCount).toBe(3);
    expect(selector).toHaveValue('three-columns');

    act(() => {
      editor.commands.undo();
    });
    expect(selector).toHaveValue('two-columns');

    act(() => {
      editor.commands.exitNotebookLayout();
    });
    expect(selector).toHaveValue('single-column');
  });

  it('disables layout editing when the notebook becomes read-only', () => {
    const editor = createEditor();
    render(<NotebookLayoutControl editor={editor} />);
    const selector = screen.getByRole('combobox', { name: 'Notebook layout' });
    act(() => {
      editor.setEditable(false);
    });
    expect(selector).toBeDisabled();
  });

  it('returns all columns to a single section through the same visible control', () => {
    const editor = createEditor();
    render(<NotebookLayoutControl editor={editor} />);
    const selector = screen.getByRole('combobox', { name: 'Notebook layout' });
    fireEvent.change(selector, { target: { value: 'wide-left' } });
    fireEvent.change(selector, { target: { value: 'single-column' } });
    expect(editor.state.doc.firstChild!.type.name).toBe('paragraph');
    expect(editor.state.doc.textContent).toBe('Incubate for 30 minutes.');
    expect(selector).toHaveValue('single-column');
  });
});
