import type { Editor } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { closeHistory } from '@tiptap/pm/history';
import type { MentionAttrs } from '../components/MentionMenu';
import { mentionAttributes } from './mention-insert';

type ReferenceEditState = { phase: 'editing' | 'removed'; position: number } | null;
const editKey = new PluginKey<ReferenceEditState>('editNotebookReference');

export function removedReferencePosition(state: EditorState): number | undefined {
  const edit = editKey.getState(state);
  return edit?.phase === 'removed' ? edit.position : undefined;
}

export function beginReferenceEdit(editor: Editor): boolean {
  const { selection, tr } = editor.state;
  if (!editor.isEditable || !(selection instanceof TextSelection) || !selection.empty) return false;
  const node = selection.$from.nodeBefore;
  if (node?.type.name !== 'mention') return false;
  editor.view.dispatch(
    tr.setMeta(editKey, { phase: 'editing', position: selection.from - node.nodeSize })
  );
  return true;
}

export function finishReferenceEdit(
  editor: Editor,
  position: number | undefined,
  refocus: boolean,
  choice?: MentionAttrs | 'delete'
): void {
  if (editor.isDestroyed || position == null) return;
  const editing = editKey.getState(editor.state);
  if (editing?.phase !== 'editing' || editing.position !== position) return;
  const { doc, tr } = editor.state;
  const original = doc.nodeAt(position);
  if (original?.type.name !== 'mention') return;
  if (choice === 'delete') {
    closeHistory(tr).delete(position, position + original.nodeSize);
  } else if (
    choice &&
    (choice.entityId !== original.attrs.entityId ||
      (choice.projectId && choice.projectId !== original.attrs.projectId))
  ) {
    const attrs = mentionAttributes(choice, original.attrs.occurrenceId ?? undefined);
    closeHistory(tr).setNodeMarkup(position, undefined, attrs, original.marks);
  }
  tr.setMeta(editKey, choice === 'delete' ? { phase: 'removed', position } : null);
  if (refocus)
    tr.setSelection(
      TextSelection.create(tr.doc, choice === 'delete' ? position : position + original.nodeSize)
    );
  editor.view.dispatch(tr);
  if (refocus) editor.view.focus();
}

export function isEditingReference(decorations: readonly Decoration[]): boolean {
  return decorations.some((decoration) => decoration.spec.referenceEdit === true);
}

export function referenceEditPlugin(): Plugin {
  return new Plugin<ReferenceEditState>({
    key: editKey,
    state: {
      init: () => null,
      apply(tr, edit, previous) {
        const requested = tr.getMeta(editKey);
        if (requested !== undefined) return requested;
        if (!edit) return null;
        const pos = edit.position;
        if (edit.phase === 'removed') {
          const start = tr.mapping.map(pos, -1);
          const { $from, empty } = tr.selection;
          if (!empty || start < $from.start() || start > $from.pos) return null;
          const typed = tr.doc.textBetween(start, $from.pos, '\n', '\uFFFC');
          if ($from.pos === start && tr.docChanged) return null;
          if (typed && !/^[@/][^\n\uFFFC]*$/u.test(typed)) return null;
          return { phase: 'removed', position: start };
        }
        const mapped = tr.mapping.mapResult(pos, 1);
        if (mapped.deleted || tr.doc.nodeAt(mapped.pos) !== previous.doc.nodeAt(pos)) return null;
        if (tr.selectionSet && (!tr.selection.empty || tr.selection.from !== mapped.pos + 1))
          return null;
        return { phase: 'editing', position: mapped.pos };
      },
    },
    props: {
      decorations(state) {
        const edit = editKey.getState(state);
        return edit?.phase !== 'editing'
          ? null
          : DecorationSet.create(state.doc, [
              Decoration.node(edit.position, edit.position + 1, {}, { referenceEdit: true }),
            ]);
      },
    },
  });
}
