import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  getNotebookLayout,
  NOTEBOOK_LAYOUTS,
  NotebookColumn,
  NotebookColumns,
} from '../editor/extensions/notebook-layout';
import { NotebookLayoutControl } from './NotebookLayoutControl';
import { FormattingToolbar } from './FormattingToolbar';

const editors: Editor[] = [];

function createEditor(content = '<p>Incubate for 30 minutes.</p>') {
  const editor = new Editor({
    extensions: [StarterKit.configure({ trailingNode: false }), NotebookColumns, NotebookColumn],
    content,
  });
  editors.push(editor);
  return editor;
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 100,
    y: 100,
    top: 100,
    bottom: 128,
    left: 100,
    right: 140,
    width: 40,
    height: 28,
    toJSON: () => ({}),
  });
});

afterEach(() => {
  cleanup();
  editors.splice(0).forEach((editor) => editor.destroy());
  vi.restoreAllMocks();
});

function openLayout() {
  const trigger = screen.getByRole('button', { name: 'Notebook layout', exact: true });
  fireEvent.mouseDown(trigger);
  fireEvent.click(trigger);
  return trigger;
}

function chooseLayout(name: string) {
  openLayout();
  fireEvent.click(screen.getByRole('menuitemradio', { name, exact: true }));
}

describe('notebook layout menu', () => {
  it('opens and moves actual row focus with the keyboard before committing a layout', async () => {
    const editor = createEditor();
    render(<NotebookLayoutControl editor={editor} />);
    const trigger = screen.getByRole('button', { name: 'Notebook layout', exact: true });
    act(() => trigger.focus());
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    await act(async () => {});
    const one = screen.getByRole('menuitemradio', { name: 'One column' });
    const two = screen.getByRole('menuitemradio', { name: 'Two columns' });
    const three = screen.getByRole('menuitemradio', { name: 'Three columns' });
    expect(one).toHaveFocus();
    fireEvent.keyDown(one, { key: 'ArrowDown' });
    expect(two).toHaveFocus();
    expect(one).toHaveAttribute('aria-checked', 'true');
    expect(two).toHaveAttribute('aria-checked', 'false');
    fireEvent.keyDown(two, { key: 'End' });
    expect(three).toHaveFocus();
    fireEvent.keyDown(three, { key: 'Home' });
    expect(one).toHaveFocus();
    fireEvent.keyDown(one, { key: 'ArrowDown' });
    fireEvent.keyDown(two, { key: 'Enter' });
    expect(getNotebookLayout(editor.state)).toBe('two-columns');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('uses an icon-only menu button with one checked layout', () => {
    const editor = createEditor();
    render(<NotebookLayoutControl editor={editor} />);
    const trigger = openLayout();
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger).not.toHaveTextContent('Layout');
    expect(trigger.querySelector('svg')).not.toBeNull();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    const options = screen.getAllByRole('menuitemradio');
    expect(options.map((option) => option.textContent)).toEqual([
      'One column',
      ...NOTEBOOK_LAYOUTS.map((layout) => layout.label),
    ]);
    expect(screen.getByRole('menuitemradio', { name: 'One column' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(options.filter((option) => option.getAttribute('aria-checked') === 'true')).toHaveLength(
      1
    );
  });

  it('formats the actual editor selection and tracks changes, cursor movement, and undo', () => {
    const editor = createEditor();
    render(<NotebookLayoutControl editor={editor} />);
    expect(getNotebookLayout(editor.state)).toBe('single-column');

    chooseLayout('Two columns');
    expect(editor.state.doc.firstChild!.childCount).toBe(2);
    expect(editor.state.doc.firstChild!.textContent).toBe('Incubate for 30 minutes.');
    expect(getNotebookLayout(editor.state)).toBe('two-columns');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    chooseLayout('Three columns');
    expect(editor.state.doc.firstChild!.childCount).toBe(3);
    expect(getNotebookLayout(editor.state)).toBe('three-columns');

    act(() => {
      editor.commands.undo();
    });
    openLayout();
    expect(screen.getByRole('menuitemradio', { name: 'Two columns' })).toHaveAttribute(
      'aria-checked',
      'true'
    );

    act(() => {
      editor.commands.exitNotebookLayout();
    });
    expect(screen.getByRole('menuitemradio', { name: 'One column' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  it('disables layout editing when the notebook becomes read-only', () => {
    const editor = createEditor();
    render(<NotebookLayoutControl editor={editor} />);
    const selector = screen.getByRole('button', { name: 'Notebook layout', exact: true });
    act(() => {
      editor.setEditable(false);
    });
    expect(selector).toBeDisabled();
    fireEvent.click(selector);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('returns all columns to a single section through the same visible control', () => {
    const editor = createEditor();
    render(<NotebookLayoutControl editor={editor} />);
    chooseLayout('Wider left');
    chooseLayout('One column');
    expect(editor.state.doc.firstChild!.type.name).toBe('paragraph');
    expect(editor.state.doc.textContent).toBe('Incubate for 30 minutes.');
    expect(getNotebookLayout(editor.state)).toBe('single-column');
  });

  it('preserves a text selection while opening and applies one undoable change to that section', () => {
    const editor = createEditor('<p>First section.</p><p>Second target.</p>');
    let target = 0;
    editor.state.doc.descendants((node, position) => {
      if (node.type.name === 'paragraph' && node.textContent === 'Second target.') {
        target = position + 1;
      }
    });
    editor.commands.setTextSelection({ from: target, to: target + 6 });
    const original = editor.getJSON();
    const selected = editor.state.selection.toJSON();
    render(<NotebookLayoutControl editor={editor} />);
    openLayout();
    expect(editor.state.selection.toJSON()).toEqual(selected);
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Two columns' }));
    expect(editor.state.doc.child(0).textContent).toBe('First section.');
    expect(editor.state.doc.child(0).type.name).toBe('paragraph');
    expect(editor.state.doc.child(1).type.name).toBe('notebookColumns');
    expect(editor.state.doc.child(1).textContent).toBe('Second target.');
    expect(
      editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to)
    ).toBe('Second');
    act(() => {
      editor.commands.undo();
    });
    expect(editor.getJSON()).toEqual(original);
    expect(editor.state.selection.toJSON()).toEqual(selected);
  });

  it('places the layout button after the other formatting controls', () => {
    const editor = createEditor();
    const { container } = render(<FormattingToolbar editor={editor} />);
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.at(-1)).toBe(
      screen.getByRole('button', { name: 'Notebook layout', exact: true })
    );
  });
});
