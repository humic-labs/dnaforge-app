import type { JSONContent } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { Mapping } from '@tiptap/pm/transform';
import type { Node as ProseMirrorNode, Slice } from '@tiptap/pm/model';
import {
  mapNotebookReferenceNodes,
  normalizeNotebookReferenceOccurrences,
} from '../../notebook-reference-occurrences';

function referenceIds(content: JSONContent): string[] {
  const ids: string[] = [];
  mapNotebookReferenceNodes(content, (node) => {
    if (typeof node.attrs?.occurrenceId === 'string') ids.push(node.attrs.occurrenceId);
    return node;
  });
  return ids.sort();
}

function sliceIds(slice: Slice): string[] {
  return referenceIds({ type: 'doc', content: slice.content.toJSON() ?? [] });
}

function ownsReferences(node: ProseMirrorNode): boolean {
  return (
    node.type.name === 'mention' || (node.type.name === 'embed' && node.attrs.type === 'table')
  );
}

export function notebookReferenceClipboardPlugin(): Plugin {
  let cutIds: string[] | null = null;
  let copy = false;
  return new Plugin({
    props: {
      handleDOMEvents: {
        cut(view) {
          cutIds = sliceIds(view.state.selection.content());
          return false;
        },
      },
      handlePaste(view, _event, slice) {
        const pastedIds = sliceIds(slice);
        const currentIds = new Set(referenceIds(view.state.doc.toJSON()));
        const retainedCut =
          cutIds !== null &&
          pastedIds.length > 0 &&
          pastedIds.length === cutIds.length &&
          pastedIds.every((id, index) => id === cutIds![index] && !currentIds.has(id));
        copy = !retainedCut;
        cutIds = null;
        return false;
      },
      handleDrop(_view, _event, _slice, moved) {
        copy = !moved;
        return false;
      },
    },
    appendTransaction(transactions, oldState, state) {
      if (
        !transactions.some(
          (transaction) =>
            transaction.docChanged && ['paste', 'drop'].includes(transaction.getMeta('uiEvent'))
        )
      )
        return null;
      const shouldCopy = copy;
      copy = false;
      if (!shouldCopy) return null;
      const mapping = new Mapping();
      for (const transaction of transactions) mapping.appendMapping(transaction.mapping);
      const retained = new Set<number>();
      oldState.doc.descendants((node, position) => {
        if (!ownsReferences(node)) return true;
        const mapped = mapping.mapResult(position, 1);
        if (!mapped.deleted && state.doc.nodeAt(mapped.pos)?.eq(node)) retained.add(mapped.pos);
        return false;
      });
      const transaction = state.tr;
      state.doc.descendants((node, position) => {
        if (!ownsReferences(node)) return true;
        if (retained.has(position)) return false;
        const original = node.toJSON();
        const normalized = normalizeNotebookReferenceOccurrences(original, {
          documentId: 'clipboard',
          reassign: true,
        });
        if (normalized !== original)
          transaction.setNodeMarkup(position, undefined, normalized.attrs, node.marks);
        return false;
      });
      return transaction.docChanged ? transaction : null;
    },
  });
}
