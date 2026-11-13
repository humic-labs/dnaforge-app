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
import { embedRegistry } from '../../embeds/registry';

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
          let executedFlowName: string | null = null;

          return {
            onStart: (props: SuggestionProps) => {
              executedFlowName = null;

              component = new ReactRenderer(
                SlashCommandMenu as ComponentType<SlashCommandMenuProps>,
                {
                  props: {
                    items: props.items,
                    command: (commandProps: Record<string, unknown>) => {
                      const cmd = commandProps as unknown as SlashCommand;
                      console.log(
                        '[SlashCommands] command callback - cmd:',
                        cmd.name,
                        'flowName:',
                        cmd.flowName
                      );
                      if (cmd.flowName) {
                        executedFlowName = cmd.flowName;
                        console.log('[SlashCommands] Set executedFlowName to:', executedFlowName);
                      }
                      props.command(commandProps);
                    },
                  },
                  editor: props.editor,
                }
              );

              if (!props.clientRect) return;

              const editor = this.editor;
              popup = tippy('body', {
                getReferenceClientRect: props.clientRect as () => DOMRect,
                appendTo: () => document.body,
                content: component.element,
                showOnCreate: true,
                interactive: true,
                trigger: 'manual',
                placement: 'bottom-start',
                onHidden: () => {
                  const shouldSkipRefocus =
                    executedFlowName &&
                    (embedRegistry.capturesEditorFocus(executedFlowName) ||
                      (embedRegistry.getPicker(executedFlowName)?.stages.length ?? 0) > 0);
                  console.log(
                    `[SlashCommands] onHidden: flowName=${executedFlowName}, capturesEditorFocus=${shouldSkipRefocus}`
                  );
                  if (shouldSkipRefocus) {
                    console.log(`[SlashCommands] Skipping refocus - embed captures focus`);
                    return;
                  }
                  editor.chain().focus().run();
                },
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
                command: (commandProps: Record<string, unknown>) => {
                  const cmd = commandProps as unknown as SlashCommand;
                  console.log(
                    '[SlashCommands] onUpdate command callback - cmd:',
                    cmd.name,
                    'flowName:',
                    cmd.flowName
                  );
                  if (cmd.flowName) {
                    executedFlowName = cmd.flowName;
                    console.log(
                      '[SlashCommands] onUpdate Set executedFlowName to:',
                      executedFlowName
                    );
                  }
                  props.command(commandProps);
                },
              });

              if (!props.clientRect || !popup?.[0]) return;

              popup[0].setProps({
                getReferenceClientRect: props.clientRect as () => DOMRect,
              });
            },

            onKeyDown: (props: { event: KeyboardEvent }) => {
              if (props.event.key === 'Escape') {
                popup?.[0]?.hide();
                return true;
              }
              return component?.ref?.onKeyDown(props) ?? false;
            },

            onExit: () => {
              popup?.[0]?.hide();
              setTimeout(() => {
                popup?.[0]?.destroy();
                component?.destroy();
              }, 150);
            },
          };
        },
      }),
    ];
  },
});
