import type { Editor, Range } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { type SuggestionMatch, type Trigger } from '@tiptap/suggestion';
import { removedReferencePosition } from './reference-edit';
import type { EntityLinkCategory } from '../lib/search';

export type InlinePickerParent =
  | { kind: 'slash'; query: string }
  | {
      kind: 'entity';
      query: string;
      category: EntityLinkCategory | null;
      view?: 'home' | 'types' | 'all' | 'recent';
      parent: InlinePickerParent | null;
    };

export type EntityPickerPage = Extract<InlinePickerParent, { kind: 'entity' }>;

export function entityPickerNavigation(
  page: EntityPickerPage,
  navigate: (next: InlinePickerParent) => void
) {
  const open = (view: EntityPickerPage['view'], category: EntityLinkCategory | null = null) =>
    navigate({ kind: 'entity', query: '', category, view, parent: page });
  const parent = page.parent;
  return {
    query: page.query,
    activeCategory: page.category,
    recentView: page.view === 'recent',
    browseView: page.view === 'types',
    allView: page.view === 'all',
    onBack: parent ? () => navigate(parent) : undefined,
    onTypes: () => open('types'),
    onAll: () => open('all'),
    onRecent: () => open('recent'),
    onBrowse: (category: EntityLinkCategory) => open('all', category),
  };
}

interface InlineSuggestionState {
  decorationId: string | null;
  active: boolean;
  range: Range;
  query: string | null;
}

export const entityLinkSuggestionKey = new PluginKey<InlineSuggestionState>('entityLinkSuggestion');
export const slashSuggestionKey = new PluginKey<InlineSuggestionState>('slashCommandsSuggestion');
export const INLINE_PICKER_NAVIGATION_META = 'inlinePickerNavigation';

export function matchInlinePickerQuery({ char, $position }: Trigger): SuggestionMatch {
  const prefix = $position.parent.textBetween(0, $position.parentOffset, '\n', '\uFFFC');
  let embedded = -1;
  let start = -1;
  for (let i = prefix.length - 1; i >= 0; i--) {
    const character = prefix[i];
    if (character === '\uFFFC' || character === '\n') break;
    if (character !== '@' && character !== '/') continue;
    if (i > 0 && !/[\s\uFFFC]/u.test(prefix[i - 1])) {
      if (embedded < 0) embedded = i;
      continue;
    }
    start = i;
    break;
  }
  if (start < 0) start = embedded;
  if (prefix[start] !== char) return null;
  const text = prefix.slice(start);
  const query = text.slice(1);
  if (/^\s/u.test(query)) return null;
  return { range: { from: $position.pos - text.length, to: $position.pos }, text, query };
}

export function allowInlinePickerStart(
  editor: Editor,
  state: Editor['state'],
  range: Range
): boolean {
  const from = state.doc.resolve(range.from);
  return (
    !from.parentOffset ||
    /[\s\uFFFC]/u.test(
      from.parent.textBetween(from.parentOffset - 1, from.parentOffset, '', '\uFFFC')
    ) ||
    removedReferencePosition(editor.state) === range.from
  );
}

export function applyInlinePickerNavigation(
  transaction: Transaction,
  range: Range,
  next: InlinePickerParent
): void {
  replaceInlinePickerQuery(transaction, range, next.kind === 'entity' ? '@' : '/', next.query);
  transaction.setMeta(INLINE_PICKER_NAVIGATION_META, next);
}

export function navigateInlinePicker(editor: Editor, range: Range, next: InlinePickerParent): void {
  editor
    .chain()
    .focus()
    .command(({ tr, dispatch }) => {
      if (dispatch) applyInlinePickerNavigation(tr, range, next);
      return true;
    })
    .run();
}

export function navigateInlinePickerBack(
  editor: Editor,
  range: Range,
  parent: InlinePickerParent | null
): boolean {
  if (!parent) return false;
  navigateInlinePicker(editor, range, parent);
  return true;
}

export function handleInlinePickerBackspace(
  editor: Editor,
  event: KeyboardEvent,
  range: Range,
  parent: InlinePickerParent | null
): boolean {
  const { selection } = editor.state;
  if (
    event.key !== 'Backspace' ||
    range.to !== range.from + 1 ||
    !selection.empty ||
    selection.from !== range.to
  )
    return false;
  event.preventDefault();
  if (!navigateInlinePickerBack(editor, range, parent)) editor.commands.deleteRange(range);
  return true;
}

export function replaceInlinePickerQuery(
  transaction: Transaction,
  range: Range,
  prefix: '@' | '/',
  query: string
): Transaction {
  const text = prefix + query;
  if (transaction.doc.textBetween(range.from, range.to) !== text)
    transaction.insertText(text, range.from, range.to);
  transaction.setSelection(TextSelection.create(transaction.doc, range.from + text.length));
  return transaction;
}

export function inlinePickerQueryDecoration(key: PluginKey<InlineSuggestionState>): Plugin {
  return new Plugin({
    props: {
      decorations(state) {
        const suggestion = key.getState(state);
        if (!suggestion?.active) return null;
        const { from, to } = suggestion.range;
        const decorations: Decoration[] = [];
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (!node.isText) return;
          const start = Math.max(from, pos);
          const end = Math.min(to, pos + node.nodeSize);
          decorations.push(
            Decoration.inline(start, end, {
              'data-entity-query': suggestion.decorationId ?? '',
              class: 'wp-inline-query text-accent',
              ...(start === from && { 'data-tab-start': '' }),
              ...(end === to && { 'data-tab-end': '' }),
            })
          );
        });
        return DecorationSet.create(state.doc, decorations);
      },
    },
  });
}
