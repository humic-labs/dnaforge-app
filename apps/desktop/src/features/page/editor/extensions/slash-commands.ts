import { presentationSurfaceFor } from '../../../../presentation/browser-input';
import { Extension } from '@tiptap/core';
import Suggestion, { type SuggestionProps } from '@tiptap/suggestion';
import { ReactRenderer } from '@tiptap/react';
import tippy, { type Instance as TippyInstance } from 'tippy.js';
import type { ComponentType } from 'react';
import {
  SlashCommandMenu,
  type SlashCommandMenuProps,
  type SlashCommandMenuRef,
} from '../components/SlashCommandMenu';
import { builtInCommands, filterCommands, type SlashCommand } from '../lib/commands';

export type { SlashCommand };

export interface SlashCommandsOptions {
  commands: SlashCommand[];
  onFlowCommand: ((command: SlashCommand) => void) | null;
}

export const SlashCommandsExtension = Extension.create<SlashCommandsOptions>({
  name: 'slashCommands',

  addOptions() {
    return {
      commands: builtInCommands,
      onFlowCommand: null,
    };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        char: '/',
        allowSpaces: false,
        startOfLine: false,

        allow: ({ editor, range }) => {
          const $from = editor.state.doc.resolve(range.from);
          const isInCodeBlock = $from.parent.type.name === 'codeBlock';
          const isInInlineCode = editor.isActive('code');
          return !isInCodeBlock && !isInInlineCode;
        },

        command: ({ editor, range, props }) => {
          const command = props as SlashCommand;

          editor.chain().focus().deleteRange(range).run();

          if (command.flowName) {
            if (this.options.onFlowCommand) {
              this.options.onFlowCommand(command);
            } else {
              console.log('[SlashCommands] Flow command not yet implemented:', command.flowName);
            }
            return;
          }

          command.action?.(editor);
        },

        items: ({ query }) => {
          return filterCommands(this.options.commands, query);
        },

        render: () => {
          let component: ReactRenderer<SlashCommandMenuRef> | null = null;
          let popup: TippyInstance[] | null = null;

          return {
            onStart: (props: SuggestionProps) => {
              component = new ReactRenderer(
                SlashCommandMenu as ComponentType<SlashCommandMenuProps>,
                {
                  props: {
                    items: props.items,
                    presentationParentId: presentationSurfaceFor(props.editor.view.dom),
                    command: (command: SlashCommand) => props.command(command),
                  },
                  editor: props.editor,
                }
              );

              if (!props.clientRect) return;

              const currentComponent = component;
              let currentPopup: TippyInstance | null = null;
              const onWindowBlur = () => {
                currentComponent.ref?.close?.('window-blur');
                currentPopup?.hide();
              };
              popup = tippy('body', {
                getReferenceClientRect: props.clientRect as () => DOMRect,
                appendTo: () => document.body,
                content: component.element,
                showOnCreate: true,
                interactive: true,
                trigger: 'manual',
                placement: 'bottom-start',
                onCreate: (instance) => {
                  currentPopup = instance;
                  window.addEventListener('blur', onWindowBlur);
                },
                onDestroy: () => window.removeEventListener('blur', onWindowBlur),
                onHidden: () => currentComponent.ref?.close?.('outside-pointer'),
                popperOptions: {
                  modifiers: [
                    {
                      name: 'flip',
                      options: {
                        fallbackPlacements: ['top-start'],
                      },
                    },
                  ],
                },
              });
            },

            onUpdate: (props: SuggestionProps) => {
              component?.updateProps({
                items: props.items,
                presentationParentId: presentationSurfaceFor(props.editor.view.dom),
                command: (command: SlashCommand) => props.command(command),
              });

              if (!props.clientRect || !popup?.[0]) return;

              popup[0].setProps({
                getReferenceClientRect: props.clientRect as () => DOMRect,
              });
            },

            onKeyDown: (props: { event: KeyboardEvent }) => {
              if (props.event.key === 'Escape') {
                component?.ref?.close?.('escape');
                popup?.[0]?.hide();
                return true;
              }
              return component?.ref?.onKeyDown(props) ?? false;
            },

            onExit: () => {
              const exitingPopup = popup;
              const exitingComponent = component;
              popup = null;
              component = null;
              exitingComponent?.ref?.close?.('unmount');
              exitingPopup?.[0]?.hide();
              setTimeout(() => {
                exitingPopup?.[0]?.destroy();
                exitingComponent?.destroy();
              }, 150);
            },
          };
        },
      }),
    ];
  },
});
