import { readNotebookElementAttribute } from './notebook-element-attributes';
import { Node, mergeAttributes } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { isHistoryTransaction } from '@tiptap/pm/history';
import { Plugin } from '@tiptap/pm/state';
export interface EmbedNodeOptions {
  HTMLAttributes: Record<string, unknown>;
}
declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    embed: {
      insertEmbed: (attrs: {
        type: string;
        version?: number;
        refId: string;
        data?: Record<string, unknown>;
      }) => ReturnType;
    };
  }
}
export const NotebookEmbedNode = Node.create<EmbedNodeOptions>({
  name: 'embed',
  group: 'block',
  atom: true,
  draggable: true,
  addOptions() {
    return {
      HTMLAttributes: {},
    };
  },
  addAttributes() {
    return {
      type: {
        default: null,
        parseHTML: (element) => readNotebookElementAttribute(element, 'data-embed-type'),
        renderHTML: (attributes) => ({
          'data-embed-type': attributes.type,
        }),
      },
      version: {
        default: 1,
        parseHTML: (element) => {
          const version = Number(readNotebookElementAttribute(element, 'data-embed-version') ?? 1);
          return Number.isSafeInteger(version) && version > 0 ? version : 1;
        },
        renderHTML: (attributes) => ({
          'data-embed-version': attributes.version,
        }),
      },
      refId: {
        default: null,
        parseHTML: (element) => readNotebookElementAttribute(element, 'data-ref-id'),
        renderHTML: (attributes) => ({
          'data-ref-id': attributes.refId,
        }),
      },
      data: {
        default: {},
        parseHTML: (element) => {
          const dataAttr = readNotebookElementAttribute(element, 'data-embed-data');
          if (dataAttr) {
            try {
              return JSON.parse(dataAttr);
            } catch {
              return {};
            }
          }
          return {};
        },
        renderHTML: (attributes) => ({
          'data-embed-data': JSON.stringify(attributes.data || {}),
        }),
      },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'div[data-embed]',
      },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        'data-embed': '',
      }),
    ];
  },
  addProseMirrorPlugins() {
    const nodeName = this.name;
    return [
      new Plugin({
        appendTransaction(transactions, oldState, state) {
          if (
            !transactions.some((transaction) => {
              const origin = transaction.getMeta('appendedTransaction') || transaction;
              return (
                origin.docChanged &&
                !origin.getMeta('preventUpdate') &&
                !isHistoryTransaction(origin)
              );
            })
          )
            return null;
          const previous = new Set<ProseMirrorNode>();
          oldState.doc.descendants((node) => {
            if (node.type.name === nodeName) previous.add(node);
          });
          const transaction = state.tr;
          state.doc.descendants((node, position) => {
            if (
              node.type.name !== nodeName ||
              node.attrs.type !== 'structure3d' ||
              previous.has(node)
            )
              return;
            const data = node.attrs.data;
            if (!data || typeof data !== 'object' || Array.isArray(data) || data.id) return;
            transaction.setNodeMarkup(position, undefined, {
              ...node.attrs,
              data: { ...data, id: `structure-${crypto.randomUUID()}` },
            });
          });
          return transaction.docChanged ? transaction : null;
        },
      }),
    ];
  },
  addCommands() {
    return {
      insertEmbed:
        (attrs) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: {
              type: attrs.type,
              version: attrs.version ?? 1,
              refId: attrs.refId,
              data: attrs.data || {},
            },
          });
        },
    };
  },
});
