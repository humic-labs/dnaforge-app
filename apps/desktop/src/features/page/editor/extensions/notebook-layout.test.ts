import { afterEach, describe, expect, it } from 'vitest';
import { Editor, Node, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { NotebookColumn, NotebookColumns, getNotebookLayout } from './notebook-layout';
import {
  parseNotebookMarkdown,
  serializeNotebookMarkdown,
} from '../../../../db/notebook-markdown-codec';

const editors: Editor[] = [];
const paragraph = (text: string): JSONContent => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
});

function makeEditor(content: JSONContent = { type: 'doc', content: [paragraph('Method')] }) {
  const editor = new Editor({
    extensions: [
      StarterKit.configure({ trailingNode: false }),
      NotebookColumns,
      NotebookColumn,
      Node.create({
        name: 'embed',
        group: 'block',
        atom: true,
        addAttributes: () => ({ type: { default: 'image' }, refId: { default: 'image-1' } }),
        renderHTML: () => ['figure', { 'data-embed': '' }],
        parseHTML: () => [{ tag: 'figure[data-embed]' }],
      }),
    ],
    content,
  });
  editors.push(editor);
  return editor;
}

function selectText(editor: Editor, text: string) {
  let position: number | undefined;
  editor.state.doc.descendants((node, pos) => {
    if (node.isText && node.text === text) position = pos;
  });
  if (position === undefined) throw new Error(`Missing text: ${text}`);
  editor.commands.setTextSelection(position);
}

const threeColumns = (): JSONContent => ({
  type: 'doc',
  content: [
    {
      type: 'notebookColumns',
      attrs: { layout: 'three-columns' },
      content: ['Method', 'Observation', 'Conclusion'].map((text) => ({
        type: 'notebookColumn',
        content: [paragraph(text)],
      })),
    },
  ],
});

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy());
});

describe('notebook layout commands', () => {
  it('wraps the selected blocks without changing marks, lists, embeds, or surrounding text', () => {
    const editor = makeEditor({
      type: 'doc',
      content: [
        paragraph('Introduction'),
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Method', marks: [{ type: 'bold' }] }],
        },
        { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph('Sample A')] }] },
        { type: 'embed', attrs: { type: 'image', refId: 'gel-image' } },
        paragraph('Results'),
        paragraph('Conclusion'),
      ],
    });
    const before = editor.state.doc;
    const from = before.child(0).nodeSize;
    const to = before.content.size - before.lastChild!.nodeSize;
    editor.commands.setTextSelection({ from: from + 1, to: to - 1 });

    expect(editor.commands.setNotebookLayout('two-columns')).toBe(true);
    const layout = editor.state.doc.child(1);
    expect(layout.type.name).toBe('notebookColumns');
    expect(layout.childCount).toBe(2);
    expect(layout.child(0).content.eq(before.slice(from, to).content)).toBe(true);
    expect(editor.state.doc.firstChild!.eq(before.firstChild!)).toBe(true);
    expect(editor.state.doc.lastChild!.eq(before.lastChild!)).toBe(true);
    expect(getNotebookLayout(editor.state)).toBe('two-columns');
  });

  it('changes proportions within an existing layout without nesting or moving its content', () => {
    const editor = makeEditor();
    editor.commands.setNotebookLayout('two-columns');
    const before = editor.state.doc.firstChild!;
    expect(editor.commands.setNotebookLayout('wide-left')).toBe(true);
    const after = editor.state.doc.firstChild!;
    expect(after.attrs.layout).toBe('wide-left');
    expect(after.content.eq(before.content)).toBe(true);
    expect(editor.view.dom.querySelectorAll('[data-type="notebookColumns"]')).toHaveLength(1);
  });

  it('merges a removed column into the last remaining column in reading order', () => {
    const editor = makeEditor(threeColumns());
    selectText(editor, 'Conclusion');
    expect(editor.commands.setNotebookLayout('wide-right')).toBe(true);
    const layout = editor.state.doc.firstChild!;
    expect(layout.childCount).toBe(2);
    expect(layout.child(0).textContent).toBe('Method');
    expect(layout.child(1).textContent).toBe('ObservationConclusion');
    expect(editor.state.selection.$from.parent.textContent).toBe('Conclusion');
    expect(getNotebookLayout(editor.state)).toBe('wide-right');
  });

  it('returns every column to ordinary blocks and restores the layout with undo and redo', () => {
    const editor = makeEditor(threeColumns());
    selectText(editor, 'Observation');
    const original = editor.state.doc;
    expect(editor.commands.setNotebookLayout('single-column')).toBe(true);
    expect(editor.state.doc.content.childCount).toBe(3);
    expect(editor.state.doc.content.content.map((node) => node.textContent)).toEqual([
      'Method',
      'Observation',
      'Conclusion',
    ]);
    expect(getNotebookLayout(editor.state)).toBe('single-column');
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.eq(original)).toBe(true);
    expect(editor.commands.redo()).toBe(true);
    expect(editor.state.doc.textContent).toBe('MethodObservationConclusion');
  });

  it('keeps can checks side-effect free and rejects layouts spanning unrelated sections', () => {
    const editor = makeEditor(threeColumns());
    const before = editor.state.doc;
    selectText(editor, 'Method');
    expect(editor.can().setNotebookLayout('two-columns')).toBe(true);
    expect(editor.state.doc.eq(before)).toBe(true);
    editor.commands.insertContentAt(editor.state.doc.content.size, paragraph('Outside'));
    editor.commands.setTextSelection({ from: 3, to: editor.state.doc.content.size - 1 });
    expect(editor.commands.setNotebookLayout('two-columns')).toBe(false);
    expect(editor.view.dom.querySelectorAll('[data-type="notebookColumns"]')).toHaveLength(1);
  });

  it('leaves an editable paragraph after a new layout and supports a keyboard exit', () => {
    const editor = makeEditor();
    editor.commands.setNotebookLayout('two-columns');
    expect(editor.state.doc.lastChild!.type.name).toBe('paragraph');
    expect(editor.commands.exitNotebookLayout()).toBe(true);
    expect(getNotebookLayout(editor.state)).toBe('single-column');
    editor.commands.insertContent('Next section');
    expect(editor.state.doc.lastChild!.textContent).toBe('Next section');
    expect(editor.state.doc.firstChild!.textContent).toBe('Method');
  });

  it('preserves layout and column boundaries through HTML copy and paste', () => {
    const editor = makeEditor(threeColumns());
    const copied = makeEditor();
    copied.commands.setContent(editor.getHTML());
    expect(copied.getJSON()).toEqual(editor.getJSON());
    expect(copied.view.dom.querySelectorAll('[data-type="notebookColumn"]')).toHaveLength(3);
  });

  it('round-trips exact layout content through canonical notebook Markdown', () => {
    const editor = makeEditor(threeColumns());
    selectText(editor, 'Method');
    editor.commands.toggleBold();
    const content = editor.getJSON();
    const serialized = serializeNotebookMarkdown({
      identity: { id: 'layout-notebook', title: 'Experiment', formatVersion: 2 },
      content,
    });
    expect(serialized.markdown).toContain('Method');
    expect(serialized.markdown).toContain('Observation');
    expect(serialized.markdown).toContain('Conclusion');
    expect(serialized.markdown).not.toContain('unsupported:');
    const restored = parseNotebookMarkdown({
      markdown: serialized.markdown,
      payloads: new Map(
        serialized.payloads.map((payload) => [payload.relativePath, payload.content])
      ),
      expected: { id: 'layout-notebook', formatVersion: 2 },
    });
    expect(restored.content).toEqual(content);
    const reopened = makeEditor(restored.content);
    expect(reopened.getJSON()).toEqual(editor.getJSON());
  });
});
