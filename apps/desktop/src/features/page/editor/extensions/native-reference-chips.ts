import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import type { Node } from '@tiptap/pm/model';

import {
  normalizeNotebookReferences,
  notebookReferenceFromHref,
} from '../../../../shared/notebook-reference-normalization';

export const NativeReferenceChips = Extension.create({
  name: 'nativeReferenceChips',
  onCreate() {
    this.editor.view.dispatch(this.editor.state.tr.setMeta('normalizeNotebookReferences', true));
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction(transactions, _old, state) {
          if (
            !state.schema.nodes.mention ||
            !transactions.some(
              (transaction) =>
                transaction.docChanged || transaction.getMeta('normalizeNotebookReferences')
            )
          )
            return null;
          const replacements: Array<{ from: number; to: number; node: Node }> = [];
          state.doc.descendants((node, position) => {
            if (!node.isTextblock || node.type.spec.code) return !node.type.spec.code;
            let run: { href: string; from: number; to: number; nodes: Node[] } | null = null;
            const finish = () => {
              if (!run) return;
              const normalized = normalizeNotebookReferences({
                type: 'paragraph',
                content: run.nodes.map((child) => child.toJSON()),
              });
              replacements.push({
                from: run.from,
                to: run.to,
                node: state.schema.nodeFromJSON(normalized.content![0]),
              });
              run = null;
            };
            node.forEach((child, offset) => {
              const href =
                child.isText && !child.marks.some((mark) => mark.type.name === 'code')
                  ? child.marks.find((mark) => mark.type.name === 'link')?.attrs.href
                  : null;
              if (typeof href !== 'string' || !notebookReferenceFromHref(href, '')) {
                finish();
                return;
              }
              if (run?.href !== href) {
                finish();
                run = { href, from: position + 1 + offset, to: position + 1 + offset, nodes: [] };
              }
              run!.nodes.push(child);
              run!.to += child.nodeSize;
            });
            finish();
            return false;
          });
          if (!replacements.length) return null;
          const transaction = state.tr;
          for (const { from, to, node } of replacements.reverse())
            transaction.replaceWith(from, to, node);
          return transaction;
        },
      }),
    ];
  },
});
