import type { Editor } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { ReactRenderer } from '@tiptap/react';
import { exitSuggestion } from '@tiptap/suggestion';
import { NotebookPickerMenu, type NotebookPickerPage } from '../components/NotebookPickerMenu';
import type { MentionMenuRef } from '../components/MentionMenu';
import { filterCommands } from '../lib/commands';
import {
  entityLinkSuggestionKey,
  slashSuggestionKey,
  entityPickerNavigation,
  navigateInlinePicker,
  handleInlinePickerBackspace,
  INLINE_PICKER_NAVIGATION_META,
  type InlinePickerParent,
  type EntityPickerPage,
} from './inline-picker-navigation';
import { createInlinePickerPopup, type InlinePickerPopup } from './inline-picker-popup';
import { createMentionInsertCommand } from './mention-insert';
import type { MentionOptions } from './mention-types';
import type { SlashCommandsOptions } from './slash-commands';

const pageKey = new PluginKey<EntityPickerPage | null>('notebookPickerPage');

function activeSuggestion(state: EditorState) {
  for (const key of [entityLinkSuggestionKey, slashSuggestionKey]) {
    const suggestion = key.getState(state);
    if (suggestion?.active) return { key, ...suggestion };
  }
  return null;
}

export function notebookPickerPlugin(editor: Editor) {
  let menu: ReactRenderer<MentionMenuRef, { page: NotebookPickerPage }> | null = null;
  let popup: InlinePickerPopup | null = null;
  const close = () => {
    popup?.destroy();
    menu?.destroy();
    popup = null;
    menu = null;
  };
  return new Plugin<EntityPickerPage | null>({
    key: pageKey,
    state: {
      init: () => null,
      apply(tr, page, previous) {
        const next = tr.getMeta(INLINE_PICKER_NAVIGATION_META) as InlinePickerParent | undefined;
        if (next) return next.kind === 'entity' ? next : null;
        return entityLinkSuggestionKey.getState(previous)?.active ? page : null;
      },
    },
    props: {
      handleKeyDown(view, event) {
        if (event.isComposing || event.keyCode === 229) return false;
        const active = activeSuggestion(view.state);
        if (!active) return false;
        if (event.key === 'Escape' || event.key === 'Tab') {
          exitSuggestion(view, active.key);
          return event.key === 'Escape';
        }
        const parent =
          active.key === entityLinkSuggestionKey ? pageKey.getState(view.state)?.parent : null;
        if (handleInlinePickerBackspace(editor, event, active.range, parent ?? null)) return true;
        return menu?.ref?.onKeyDown({ event }) ?? false;
      },
    },
    view: () => ({
      update(view, previous) {
        const active = activeSuggestion(view.state);
        if (!active) {
          close();
          return;
        }
        const page = pageKey.getState(view.state);
        const prior = activeSuggestion(previous);
        if (
          menu &&
          prior?.key === active.key &&
          prior.query === active.query &&
          prior.range.from === active.range.from &&
          prior.range.to === active.range.to &&
          page === pageKey.getState(previous)
        )
          return;
        const query = active.query ?? '';
        const range = active.range;
        let target: NotebookPickerPage;
        if (active.key === entityLinkSuggestionKey) {
          const options = editor.extensionManager.extensions.find((ext) => ext.name === 'mention')
            ?.options as MentionOptions;
          target = {
            kind: 'entity',
            props: {
              ...entityPickerNavigation(
                { kind: 'entity', category: null, parent: null, ...page, query },
                (next) => navigateInlinePicker(editor, range, next)
              ),
              workspaceRoot: options.referenceWorkspaceRoot?.() ?? null,
              command: (props) => createMentionInsertCommand({ editor, range, props }),
            },
          };
        } else {
          const options = editor.extensionManager.extensions.find(
            (ext) => ext.name === 'slashCommands'
          )?.options as SlashCommandsOptions;
          const commands = options.commands.filter(
            (command) => !['sequence', 'primer', 'page'].includes(command.flowName ?? '')
          );
          target = {
            kind: 'slash',
            props: {
              query,
              items: filterCommands(commands, query),
              command: (command) => {
                if (command.category === 'entity') {
                  editor
                    .chain()
                    .focus()
                    .openEntityLinkPicker(command.entityCategory ?? null, range, {
                      kind: 'slash',
                      query,
                    })
                    .run();
                  return;
                }
                editor.chain().focus().deleteRange(range).run();
                if (command.flowName) options.onFlowCommand?.(command);
                else command.action?.(editor);
              },
            },
          };
        }
        if (menu) {
          menu.updateProps({ page: target });
          popup?.update();
        } else {
          menu = new ReactRenderer(NotebookPickerMenu, { editor, props: { page: target } });
          popup = createInlinePickerPopup({
            editor,
            content: menu.element,
            getSuggestionKey: () => activeSuggestion(editor.state)?.key ?? active.key,
            onDismiss: () => {
              const current = activeSuggestion(editor.state);
              if (current) exitSuggestion(editor.view, current.key);
            },
          });
        }
      },
      destroy: close,
    }),
  });
}
