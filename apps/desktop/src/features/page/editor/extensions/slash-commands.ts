import { Extension } from '@tiptap/core';
import Suggestion from '@tiptap/suggestion';
import { builtInCommands, type SlashCommand } from '../lib/commands';
import { notebookPickerPlugin } from './notebook-picker-plugin';
import {
  INLINE_PICKER_NAVIGATION_META,
  inlinePickerQueryDecoration,
  matchInlinePickerQuery,
  allowInlinePickerStart,
  slashSuggestionKey,
} from './inline-picker-navigation';
export { entityLinkSlashCommands } from '../lib/entity-link-commands';

export type { SlashCommand };

export interface SlashCommandsOptions {
  commands: SlashCommand[];
  onFlowCommand: ((command: SlashCommand) => void) | null;
}

export const SlashCommandsExtension = Extension.create<SlashCommandsOptions>({
  name: 'slashCommands',
  addOptions() {
    return { commands: builtInCommands, onFlowCommand: null };
  },
  addProseMirrorPlugins() {
    const suggestion = Suggestion({
      editor: this.editor,
      pluginKey: slashSuggestionKey,
      char: '/',
      allowSpaces: true,
      findSuggestionMatch: matchInlinePickerQuery,
      startOfLine: false,
      shouldResetDismissed: ({ transaction }) =>
        Boolean(transaction.getMeta(INLINE_PICKER_NAVIGATION_META)),
      allow: ({ editor, state, range }) => {
        const from = state.doc.resolve(range.from);
        const query = state.doc.textBetween(range.from + 1, range.to, '', '');
        return (
          allowInlinePickerStart(editor, state, range) &&
          from.parent.type.name !== 'codeBlock' &&
          !editor.isActive('code') &&
          (!query || Boolean(query.trim()))
        );
      },
      render: () => ({}),
    });
    const hasMention = this.editor.extensionManager.extensions.some(
      (extension) => extension.name === 'mention'
    );
    return [
      suggestion,
      inlinePickerQueryDecoration(slashSuggestionKey),
      ...(hasMention ? [] : [notebookPickerPlugin(this.editor)]),
    ];
  },
});
