import { readNotebookElementAttribute } from './notebook-element-attributes';
import { Node, mergeAttributes } from '@tiptap/core';
import { Fragment, type Node as DocumentNode } from '@tiptap/pm/model';
import { closeHistory } from '@tiptap/pm/history';
import { NodeSelection, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';

export const NOTEBOOK_LAYOUTS = [
  { id: 'two-columns', label: 'Two columns', columns: 2 },
  { id: 'wide-left', label: 'Wider left', columns: 2 },
  { id: 'wide-right', label: 'Wider right', columns: 2 },
  { id: 'three-columns', label: 'Three columns', columns: 3 },
] as const;

export type NotebookLayout = (typeof NOTEBOOK_LAYOUTS)[number]['id'];
export type NotebookLayoutChoice = NotebookLayout | 'single-column';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    notebookLayout: {
      setNotebookLayout: (layout: NotebookLayoutChoice) => ReturnType;
      exitNotebookLayout: () => ReturnType;
    };
  }
}

function layoutPreset(value: unknown) {
  return NOTEBOOK_LAYOUTS.find((preset) => preset.id === value);
}

function selectedLayout(state: EditorState): { node: DocumentNode; pos: number } | null {
  const { selection } = state;
  if (selection instanceof NodeSelection && selection.node.type.name === 'notebookColumns') {
    return { node: selection.node, pos: selection.from };
  }
  for (let depth = selection.$from.depth; depth > 0; depth--) {
    const node = selection.$from.node(depth);
    if (node.type.name === 'notebookColumns') {
      const pos = selection.$from.before(depth);
      return selection.to <= pos + node.nodeSize ? { node, pos } : null;
    }
  }
  return null;
}

export function getNotebookLayout(state: EditorState): NotebookLayoutChoice {
  const selected = selectedLayout(state);
  return selected
    ? (layoutPreset(selected.node.attrs.layout)?.id ?? 'two-columns')
    : 'single-column';
}

function columnContentPosition(
  position: number,
  layout: { node: DocumentNode; pos: number },
  columns: DocumentNode[] | null
): number {
  let oldStart = layout.pos + 2;
  let flatOffset = 0;
  for (let index = 0; index < layout.node.childCount; index++) {
    const column = layout.node.child(index);
    if (position <= oldStart + column.content.size || index === layout.node.childCount - 1) {
      const offset = Math.max(0, Math.min(column.content.size, position - oldStart));
      if (!columns) return layout.pos + flatOffset + offset;
      const destination = Math.min(index, columns.length - 1);
      const start =
        layout.pos +
        2 +
        columns.slice(0, destination).reduce((sum, node) => sum + node.nodeSize, 0);
      let mergedOffset = 0;
      for (let merged = destination; merged < index; merged++) {
        mergedOffset += layout.node.child(merged).content.size;
      }
      return start + mergedOffset + offset;
    }
    oldStart += column.nodeSize;
    flatOffset += column.content.size;
  }
  return layout.pos;
}

function restoreTextSelection(tr: Transaction, anchor: number, head: number) {
  const resolve = (position: number) =>
    tr.doc.resolve(Math.max(0, Math.min(tr.doc.content.size, position)));
  tr.setSelection(TextSelection.between(resolve(anchor), resolve(head)));
}

export const NotebookColumn = Node.create({
  name: 'notebookColumn',
  content: 'block+',
  isolating: true,
  parseHTML: () => [{ tag: 'div[data-type="notebookColumn"]' }],
  renderHTML: ({ HTMLAttributes }) => [
    'div',
    mergeAttributes(HTMLAttributes, { 'data-type': 'notebookColumn' }),
    0,
  ],
});

export const NotebookColumns = Node.create({
  name: 'notebookColumns',
  group: 'block',
  content: 'notebookColumn{2,3}',
  defining: true,
  isolating: true,

  addAttributes() {
    return {
      layout: {
        default: 'two-columns',
        parseHTML: (element) =>
          layoutPreset(readNotebookElementAttribute(element, 'data-layout'))?.id ?? 'two-columns',
        renderHTML: (attrs) => ({ 'data-layout': layoutPreset(attrs.layout)?.id ?? 'two-columns' }),
      },
    };
  },

  parseHTML: () => [{ tag: 'div[data-type="notebookColumns"]' }],
  renderHTML: ({ HTMLAttributes }) => [
    'div',
    mergeAttributes(HTMLAttributes, { 'data-type': 'notebookColumns' }),
    0,
  ],

  addCommands() {
    return {
      setNotebookLayout:
        (choice) =>
        ({ state, tr, dispatch }) => {
          const preset = layoutPreset(choice);
          if (!preset && choice !== 'single-column') return false;
          const selected = selectedLayout(state);

          if (selected) {
            if (!dispatch) return true;
            if (
              preset &&
              preset.id === selected.node.attrs.layout &&
              preset.columns === selected.node.childCount
            )
              return true;
            closeHistory(tr);
            const { anchor, head } = state.selection;
            if (choice === 'single-column') {
              const blocks: DocumentNode[] = [];
              selected.node.forEach((column) => column.forEach((block) => blocks.push(block)));
              tr.replaceWith(
                selected.pos,
                selected.pos + selected.node.nodeSize,
                Fragment.fromArray(blocks)
              );
              restoreTextSelection(
                tr,
                columnContentPosition(anchor, selected, null),
                columnContentPosition(head, selected, null)
              );
            } else if (preset) {
              if (preset.columns === selected.node.childCount) {
                tr.setNodeMarkup(selected.pos, undefined, {
                  ...selected.node.attrs,
                  layout: preset.id,
                });
              } else {
                const columns: DocumentNode[] = [];
                selected.node.forEach((column, _offset, index) => {
                  if (index < preset.columns) columns.push(column);
                  else {
                    const last = columns[columns.length - 1];
                    columns[columns.length - 1] = last.copy(last.content.append(column.content));
                  }
                });
                while (columns.length < preset.columns) {
                  columns.push(
                    state.schema.nodes.notebookColumn.create(
                      null,
                      state.schema.nodes.paragraph.create()
                    )
                  );
                }
                const replacement = selected.node.type.create(
                  { ...selected.node.attrs, layout: preset.id },
                  columns
                );
                tr.replaceWith(selected.pos, selected.pos + selected.node.nodeSize, replacement);
                restoreTextSelection(
                  tr,
                  columnContentPosition(anchor, selected, columns),
                  columnContentPosition(head, selected, columns)
                );
              }
            }
            tr.scrollIntoView();
            return true;
          }

          if (!preset) return false;
          const { $from, $to, anchor, head } = state.selection;
          const from = $from.depth ? $from.before(1) : $from.pos;
          const to = $to.depth ? $to.after(1) : $to.pos;
          let containsLayout = false;
          state.doc.nodesBetween(from, to, (node) => {
            if (node.type.name === 'notebookColumns') containsLayout = true;
          });
          if (containsLayout) return false;
          if (!dispatch) return true;
          closeHistory(tr);
          const selectedContent = state.doc.slice(from, to).content;
          const paragraph = state.schema.nodes.paragraph.create();
          const columns = Array.from({ length: preset.columns }, (_unused, index) =>
            state.schema.nodes.notebookColumn.create(
              null,
              index === 0 && selectedContent.size ? selectedContent : paragraph
            )
          );
          const layout = this.type.create({ layout: preset.id }, columns);
          tr.replaceWith(from, to, layout);
          if (to === state.doc.content.size) tr.insert(from + layout.nodeSize, paragraph);
          restoreTextSelection(tr, anchor + 2, head + 2);
          tr.scrollIntoView();
          return true;
        },

      exitNotebookLayout:
        () =>
        ({ state, tr, dispatch }) => {
          const selected = selectedLayout(state);
          if (!selected) return false;
          if (!dispatch) return true;
          const end = selected.pos + selected.node.nodeSize;
          if (!tr.doc.nodeAt(end)?.isTextblock)
            tr.insert(end, state.schema.nodes.paragraph.create());
          tr.setSelection(TextSelection.near(tr.doc.resolve(end + 1))).scrollIntoView();
          return true;
        },
    };
  },

  addKeyboardShortcuts() {
    return { 'Mod-Enter': () => this.editor.commands.exitNotebookLayout() };
  },
});
