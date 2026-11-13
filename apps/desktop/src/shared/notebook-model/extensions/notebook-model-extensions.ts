import {
  entityNavigationSchemes,
  isEntityNavigationUrl,
  parseEntityNavigationUrl,
} from '../../entity-navigation';
import {
  readNotebookElementAttribute,
  readNotebookElementStyle,
} from './notebook-element-attributes';
import { nativeEntityReferenceIdFromHref } from '../../native-entity-reference';
import { decodeInlineReferenceUrl } from '../../inline-reference-codec';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { TableKit } from '@tiptap/extension-table';
import { Extension, Mark } from '@tiptap/core';
import { RawMarkdownNode } from './raw-markdown';
import { NotebookColumn, NotebookColumns } from './notebook-layout';
const isSavedMolecularViewHref = (url: string) => {
  const parsed = decodeInlineReferenceUrl(url);
  return (
    parsed.ok &&
    (parsed.declaration.kind === 'existing-reference' ||
      parsed.declaration.kind === 'molecular-document')
  );
};
export { RawMarkdownNode } from './raw-markdown';
const IndentExtension = Extension.create({
  name: 'indent',
  addGlobalAttributes() {
    return [
      {
        types: ['paragraph'],
        attributes: {
          indent: {
            default: 0,
            parseHTML: (element) =>
              parseInt(readNotebookElementAttribute(element, 'data-indent') || '0', 10),
            renderHTML: (attributes) => {
              if (!attributes.indent) return {};
              return {
                'data-indent': attributes.indent,
                style: `margin-left: ${attributes.indent * 1.5}em`,
              };
            },
          },
        },
      },
    ];
  },
  addKeyboardShortcuts() {
    return {
      Backspace: () => {
        const { state } = this.editor;
        const { $from, empty } = state.selection;
        const node = $from.parent;
        const parentOffset = $from.parentOffset;
        if (!empty || parentOffset !== 0) {
          return false;
        }
        if (node.type.name === 'paragraph' && node.attrs.indent > 0) {
          this.editor.commands.updateAttributes('paragraph', {
            indent: node.attrs.indent - 1,
          });
          return true;
        }
        if ($from.depth >= 2) {
          const parent = $from.node($from.depth - 1);
          if (parent.type.name === 'listItem' || parent.type.name === 'taskItem') {
            let listDepth = 0;
            for (let d = $from.depth - 1; d >= 0; d--) {
              const n = $from.node(d);
              if (['bulletList', 'orderedList', 'taskList'].includes(n.type.name)) {
                listDepth++;
              }
            }
            let liftCount = 0;
            const maxLifts = 10;
            while (liftCount < maxLifts) {
              const currentState = this.editor.state;
              const { $from: $current } = currentState.selection;
              let inListItem = false;
              let listItemType = '';
              for (let d = $current.depth - 1; d >= 0; d--) {
                const n = $current.node(d);
                if (n.type.name === 'listItem' || n.type.name === 'taskItem') {
                  inListItem = true;
                  listItemType = n.type.name;
                  break;
                }
              }
              if (!inListItem) {
                break;
              }
              const success = this.editor.commands.liftListItem(listItemType);
              if (!success) break;
              liftCount++;
            }
            if (listDepth > 0) {
              const { $from: $final } = this.editor.state.selection;
              if ($final.parent.type.name === 'paragraph') {
                this.editor.commands.updateAttributes('paragraph', { indent: listDepth });
              }
            }
            return true;
          }
        }
        return false;
      },
      Tab: () => {
        const { state, view } = this.editor;
        const { $from } = state.selection;
        const node = $from.parent;
        if ($from.depth >= 2) {
          const parentNode = $from.node($from.depth - 1);
          if (parentNode?.type.name === 'listItem') {
            this.editor.commands.sinkListItem('listItem');
            return true;
          }
          if (parentNode?.type.name === 'taskItem') {
            this.editor.commands.sinkListItem('taskItem');
            return true;
          }
        }
        if (node.type.name === 'paragraph') {
          const currentIndent = node.attrs.indent || 0;
          if (currentIndent < 8) {
            const tr = state.tr.setNodeMarkup($from.before(), undefined, {
              ...node.attrs,
              indent: currentIndent + 1,
            });
            view.dispatch(tr);
          }
          return true;
        }
        return true;
      },
      'Shift-Tab': () => {
        const { state, view } = this.editor;
        const { $from } = state.selection;
        const node = $from.parent;
        if (node.type.name === 'paragraph' && node.attrs.indent > 0) {
          const tr = state.tr.setNodeMarkup($from.before(), undefined, {
            ...node.attrs,
            indent: node.attrs.indent - 1,
          });
          view.dispatch(tr);
          return true;
        }
        if ($from.depth >= 2) {
          const parentNode = $from.node($from.depth - 1);
          if (parentNode?.type.name === 'listItem') {
            this.editor.commands.liftListItem('listItem');
            return true;
          }
          if (parentNode?.type.name === 'taskItem') {
            this.editor.commands.liftListItem('taskItem');
            return true;
          }
        }
        return true;
      },
    };
  },
});
const ORDERED_LIST_STYLE_BY_TYPE = Object.freeze({
  '1': 'decimal',
  a: 'lower-alpha',
  A: 'upper-alpha',
  i: 'lower-roman',
  I: 'upper-roman',
} as const);
const OrderedListPresentationExtension = Extension.create({
  name: 'orderedListPresentation',
  addGlobalAttributes() {
    return [
      {
        types: ['orderedList'],
        attributes: {
          type: {
            default: null,
            parseHTML: (element) => readNotebookElementAttribute(element, 'type'),
            renderHTML: (attributes) => {
              const type = attributes.type;
              const listStyleType =
                typeof type === 'string' &&
                Object.prototype.hasOwnProperty.call(ORDERED_LIST_STYLE_BY_TYPE, type)
                  ? ORDERED_LIST_STYLE_BY_TYPE[type as keyof typeof ORDERED_LIST_STYLE_BY_TYPE]
                  : undefined;
              return listStyleType ? { style: `list-style-type: ${listStyleType}` } : {};
            },
          },
        },
      },
      {
        types: ['orderedList', 'bulletList', 'taskList'],
        attributes: {
          indent: {
            default: null,
            parseHTML: (element) => {
              const raw = readNotebookElementAttribute(element, 'data-indent');
              const value = raw === null ? Number.NaN : Number.parseInt(raw, 10);
              return Number.isFinite(value) && value > 0 ? value : null;
            },
            renderHTML: (attributes) => {
              const indent = attributes.indent;
              if (typeof indent !== 'number' || indent <= 0) return {};
              return {
                'data-indent': String(indent),
                style: `margin-left: ${Math.min(indent, 6) * 1.5}em`,
              };
            },
          },
        },
      },
    ];
  },
});
export const HIGHLIGHT_COLORS = Object.freeze([
  { name: 'Yellow', value: '#FDE68A' },
  { name: 'Green', value: '#BBF7D0' },
  { name: 'Blue', value: '#BFDBFE' },
  { name: 'Pink', value: '#FBCFE8' },
  { name: 'Orange', value: '#FED7AA' },
] as const);
export const DEFAULT_HIGHLIGHT_COLOR = HIGHLIGHT_COLORS[0].value;
export const TEXT_COLORS = Object.freeze([
  { name: 'Red', value: '#D10E0E' },
  { name: 'Orange', value: '#E14516' },
  { name: 'Green', value: '#0DAF49' },
  { name: 'Blue', value: '#1155CC' },
  { name: 'Purple', value: '#97599A' },
] as const);
export const DEFAULT_TEXT_COLOR = TEXT_COLORS[0].value;
declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    highlight: {
      setHighlight: (attributes?: { color?: string }) => ReturnType;
      toggleHighlight: (attributes?: { color?: string }) => ReturnType;
      unsetHighlight: () => ReturnType;
    };
    textColor: {
      setTextColor: (color: string) => ReturnType;
      unsetTextColor: () => ReturnType;
    };
    subscript: {
      toggleSubscript: () => ReturnType;
    };
    superscript: {
      toggleSuperscript: () => ReturnType;
    };
  }
}
const HighlightMark = Mark.create({
  name: 'highlight',
  addCommands() {
    return {
      setHighlight:
        (attributes) =>
        ({ commands }) =>
          commands.setMark(this.name, { color: DEFAULT_HIGHLIGHT_COLOR, ...attributes }),
      toggleHighlight:
        (attributes) =>
        ({ commands }) =>
          commands.toggleMark(this.name, { color: DEFAULT_HIGHLIGHT_COLOR, ...attributes }),
      unsetHighlight:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },
  addKeyboardShortcuts() {
    return {
      'Mod-Shift-h': () => this.editor.commands.toggleHighlight(),
    };
  },
  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (element) =>
          readNotebookElementAttribute(element, 'data-color') ||
          readNotebookElementStyle(element, 'backgroundColor') ||
          null,
        renderHTML: (attributes) => {
          const color = attributes.color;
          if (typeof color !== 'string' || !color) return {};
          return { 'data-color': color, style: `background-color: ${color}` };
        },
      },
    };
  },
  parseHTML() {
    return [
      { tag: 'mark' },
      {
        tag: 'span[style]',
        getAttrs: (element) => (readNotebookElementStyle(element, 'backgroundColor') ? {} : false),
      },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return ['mark', HTMLAttributes, 0];
  },
});
const TextColorMark = Mark.create({
  name: 'textColor',
  addCommands() {
    return {
      setTextColor:
        (color) =>
        ({ commands }) =>
          commands.setMark(this.name, { color }),
      unsetTextColor:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },
  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (element) =>
          readNotebookElementAttribute(element, 'data-text-color') ||
          readNotebookElementStyle(element, 'color') ||
          null,
        renderHTML: (attributes) => {
          const color = attributes.color;
          if (typeof color !== 'string' || !color) return {};
          return { 'data-text-color': color, style: `color: ${color}` };
        },
      },
    };
  },
  parseHTML() {
    return [
      { tag: 'span[data-text-color]' },
      {
        tag: 'span[style]',
        getAttrs: (element) => (readNotebookElementStyle(element, 'color') ? {} : false),
      },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', HTMLAttributes, 0];
  },
});
const SubscriptMark = Mark.create({
  name: 'subscript',
  excludes: 'superscript',
  addCommands() {
    return {
      toggleSubscript:
        () =>
        ({ commands }) =>
          commands.toggleMark(this.name),
    };
  },
  addKeyboardShortcuts() {
    return { 'Mod-Shift-,': () => this.editor.commands.toggleSubscript() };
  },
  parseHTML() {
    return [
      { tag: 'sub' },
      {
        style: 'vertical-align',
        getAttrs: (value) => (value === 'sub' ? {} : false),
      },
    ];
  },
  renderHTML() {
    return ['sub', 0];
  },
});
const SuperscriptMark = Mark.create({
  name: 'superscript',
  excludes: 'subscript',
  addCommands() {
    return {
      toggleSuperscript:
        () =>
        ({ commands }) =>
          commands.toggleMark(this.name),
    };
  },
  addKeyboardShortcuts() {
    return { 'Mod-.': () => this.editor.commands.toggleSuperscript() };
  },
  parseHTML() {
    return [
      { tag: 'sup' },
      {
        style: 'vertical-align',
        getAttrs: (value) => (value === 'super' ? {} : false),
      },
    ];
  },
  renderHTML() {
    return ['sup', 0];
  },
});
const ProtocolStepPresentationExtension = Extension.create({
  name: 'protocolStepPresentation',
  addGlobalAttributes() {
    return [
      {
        types: ['listItem'],
        attributes: {
          checked: {
            default: null,
            keepOnSplit: false,
            parseHTML: (element) => {
              const value = readNotebookElementAttribute(element, 'data-checked');
              return value === null ? null : value === 'true';
            },
            renderHTML: (attributes) => {
              if (typeof attributes.checked !== 'boolean') return {};
              return {
                'data-checked': String(attributes.checked),
                class: 'protocol-step',
              };
            },
          },
        },
      },
    ];
  },
});
export function getNotebookBaseExtensions(nativeHistory = false) {
  return [
    StarterKit.configure({
      trailingNode: false,
      ...(nativeHistory ? { undoRedo: false } : {}),
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      bulletList: {
        keepMarks: true,
        keepAttributes: false,
      },
      orderedList: {
        keepMarks: true,
        keepAttributes: false,
      },
    }),
    RawMarkdownNode,
    TableKit.configure({
      table: { HTMLAttributes: { class: 'w-full table-fixed border-collapse my-4' } },
      tableCell: {
        HTMLAttributes: { class: 'border border-border px-3 py-2 align-top break-words' },
      },
      tableHeader: {
        HTMLAttributes: {
          class: 'border border-border px-3 py-2 text-left font-semibold break-words',
        },
      },
    }),
    NotebookColumns,
    NotebookColumn,
    OrderedListPresentationExtension,
    ProtocolStepPresentationExtension,
    HighlightMark,
    TextColorMark,
    SubscriptMark,
    SuperscriptMark,
    Underline,
    Link.extend({
      inclusive: false,
      addAttributes() {
        return {
          ...this.parent?.(),
          providerStableId: {
            default: null,
            parseHTML: (element) =>
              readNotebookElementAttribute(element, 'data-provider-stable-id'),
            renderHTML: (attributes) =>
              attributes.providerStableId
                ? { 'data-provider-stable-id': attributes.providerStableId }
                : {},
          },
          providerObjectClass: {
            default: null,
            parseHTML: (element) =>
              readNotebookElementAttribute(element, 'data-provider-object-class'),
            renderHTML: (attributes) =>
              attributes.providerObjectClass
                ? { 'data-provider-object-class': attributes.providerObjectClass }
                : {},
          },
        };
      },
    }).configure({
      openOnClick: true,
      protocols: ['entity', 'dnaforge-chat', ...entityNavigationSchemes],
      isAllowedUri: (url, { defaultValidate }) =>
        isEntityNavigationUrl(url)
          ? parseEntityNavigationUrl(url) !== null
          : url.toLowerCase().startsWith('entity:')
            ? nativeEntityReferenceIdFromHref(url) !== null
            : url.toLowerCase().startsWith('dnaforge-chat:')
              ? isSavedMolecularViewHref(url)
              : defaultValidate(url),
      HTMLAttributes: {
        class: 'text-accent hover:underline cursor-pointer',
        target: '_blank',
        rel: 'noopener noreferrer',
      },
    }),
    TaskList,
    TaskItem.configure({
      nested: true,
    }),
    IndentExtension,
  ];
}
