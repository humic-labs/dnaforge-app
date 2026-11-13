import { readNotebookElementAttribute } from './notebook-element-attributes';
import { Node, mergeAttributes } from '@tiptap/core';

export const RawMarkdownNode = Node.create({
  name: 'rawMarkdown',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      source: {
        default: '',
        parseHTML: (element) => readNotebookElementAttribute(element, 'data-raw-markdown') ?? '',
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'pre[data-dnaforge-raw-markdown]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const source = typeof node.attrs.source === 'string' ? node.attrs.source : '';
    return [
      'pre',
      mergeAttributes(HTMLAttributes, {
        'data-dnaforge-raw-markdown': '',
        class: 'dnaforge-raw-markdown',
        contenteditable: 'false',
        title: 'Preserved Markdown syntax that DNAForge does not edit',
      }),
      ['code', {}, source],
    ];
  },
});
