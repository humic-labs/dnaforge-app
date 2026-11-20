import { NotebookMentionNode } from './notebook-mention-model';
import { ReactRenderer, ReactNodeViewRenderer } from '@tiptap/react';

import { ReferenceNodeView } from '../components/ReferenceNodeView';
import { beginReferenceEdit, isEditingReference, referenceEditPlugin } from './reference-edit';
import { Plugin, PluginKey, Selection, TextSelection, type Transaction } from '@tiptap/pm/state';
import { notebookPickerPlugin } from './notebook-picker-plugin';
import tippy, { type Instance as TippyInstance } from 'tippy.js';
import type { Editor, Range } from '@tiptap/core';
import { type MentionAttrs } from '../components/MentionMenu';
import { createMentionInsertCommand } from './mention-insert';
import type { MentionOpenIntent, MentionOptions } from './mention-types';
export type { MentionOpenIntent, MentionOptions, MentionReferenceRecord } from './mention-types';
import { PagePreview } from '../../embeds/page/Preview';
import type { EntityLinkCategory } from '../lib/search';
import {
  entityLinkSuggestionKey,
  INLINE_PICKER_NAVIGATION_META,
  inlinePickerQueryDecoration,
  matchInlinePickerQuery,
  allowInlinePickerStart,
  applyInlinePickerNavigation,
  type InlinePickerParent,
} from './inline-picker-navigation';

export type { MentionAttrs };

const mentionHoverPluginKey = new PluginKey('mentionHover');

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    entityLinkPicker: {
      openEntityLinkPicker: (
        category?: EntityLinkCategory | null,
        range?: Range,
        parent?: InlinePickerParent | null
      ) => ReturnType;
    };
  }
}

export function mentionOpenIntentFromElement(mention: Element | null): MentionOpenIntent | null {
  const entityId = mention?.getAttribute('data-entity-id') ?? null;
  const path = mention?.getAttribute('data-path') ?? null;

  const objectUuid = mention?.getAttribute('data-object-uuid') ?? null;
  const contentHash = mention?.getAttribute('data-content-hash') ?? null;
  const projectId = mention?.getAttribute('data-project-id') ?? null;
  if (!entityId && !path && !objectUuid && !contentHash) return null;

  return {
    entityType:
      (mention?.getAttribute('data-entity-type') as MentionOpenIntent['entityType']) ?? 'page',
    entityId,
    label: mention?.getAttribute('data-label') ?? '',
    path,
    contentHash,
    objectUuid,
    ...(projectId ? { projectId } : {}),
  };
}

function createMentionHoverPlugin(onEntityOpen?: (intent: MentionOpenIntent) => void): Plugin {
  let hoverTimeout: ReturnType<typeof setTimeout> | null = null;
  let currentTooltip: TippyInstance | null = null;
  let currentRenderer: ReactRenderer | null = null;

  function cleanup() {
    if (hoverTimeout) {
      clearTimeout(hoverTimeout);
      hoverTimeout = null;
    }
    if (currentTooltip) {
      currentTooltip.destroy();
      currentTooltip = null;
    }
    if (currentRenderer) {
      currentRenderer.destroy();
      currentRenderer = null;
    }
  }

  return new Plugin({
    key: mentionHoverPluginKey,

    props: {
      handleDOMEvents: {
        mouseover: (view, event) => {
          const target = event.target as HTMLElement;
          const mention = target.closest('.mention') as HTMLElement | null;

          if (!mention) {
            cleanup();
            return false;
          }

          const entityType = mention.getAttribute('data-entity-type');
          const entityId = mention.getAttribute('data-entity-id');

          if (entityType !== 'page' || !entityId) {
            cleanup();
            return false;
          }

          if (currentTooltip && mention === currentTooltip.reference) {
            return false;
          }

          cleanup();

          hoverTimeout = setTimeout(() => {
            currentRenderer = new ReactRenderer(PagePreview, {
              props: { pageId: entityId },
              editor: view as unknown as Editor,
            });

            currentTooltip = tippy(mention, {
              content: currentRenderer.element,
              showOnCreate: true,
              interactive: true,
              trigger: 'manual',
              placement: 'bottom-start',
              appendTo: () => document.body,
              onHidden: () => {
                cleanup();
              },
              popperOptions: {
                modifiers: [
                  {
                    name: 'flip',
                    options: {
                      fallbackPlacements: ['top-start', 'bottom-end', 'top-end'],
                    },
                  },
                ],
              },
            });
          }, 300);

          return false;
        },

        mouseout: (view, event) => {
          const relatedTarget = event.relatedTarget as HTMLElement | null;

          if (relatedTarget) {
            const isInMention = relatedTarget.closest('.mention');
            const isInTooltip = relatedTarget.closest('.tippy-box');
            if (isInMention || isInTooltip) {
              return false;
            }
          }

          cleanup();
          return false;
        },

        click: (view, event) => {
          const target = event.target as HTMLElement;
          const mention = target.closest('.mention');

          if (mention?.hasAttribute('data-node-view-wrapper')) return false;

          const intent = mentionOpenIntentFromElement(mention);

          if (intent && onEntityOpen) {
            event.preventDefault();
            cleanup();
            onEntityOpen(intent);
            return true;
          }

          return false;
        },
      },
    },

    destroy() {
      cleanup();
    },
  });
}

export const MentionExtension = NotebookMentionNode.extend<MentionOptions>({
  name: 'mention',

  addCommands() {
    return {
      ...this.parent?.(),
      openEntityLinkPicker:
        (category = null, range, parent = null) =>
        ({ tr, dispatch }) => {
          if (dispatch) {
            applyInlinePickerNavigation(tr, range ?? tr.selection, {
              kind: 'entity',
              query: '',
              category,
              parent,
            });
          }
          return true;
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      ...this.parent?.(),
      Backspace: () => beginReferenceEdit(this.editor),
      ArrowRight: () => {
        const { doc, selection } = this.editor.state;
        return (
          selection instanceof TextSelection &&
          selection.empty &&
          selection.$head.nodeBefore?.type.name === this.name &&
          selection.eq(Selection.atEnd(doc))
        );
      },
    };
  },

  addOptions() {
    return {
      ...this.parent?.(),
      onMentionClick: null,
      onCreatePage: null,
      referenceWorkspaceRoot: null,
      referenceNotebookPageId: null,
      resolveReferenceRecord: null,
      HTMLAttributes: {
        class: 'mention',
      },
      suggestion: {
        pluginKey: entityLinkSuggestionKey,
        char: '@',
        allowSpaces: true,
        findSuggestionMatch: matchInlinePickerQuery,
        allow: ({
          editor,
          state,
          range,
        }: {
          editor: Editor;
          state: Editor['state'];
          range: Range;
        }) => {
          const query = state.doc.textBetween(range.from + 1, range.to, '', '');
          return allowInlinePickerStart(editor, state, range) && (!query || Boolean(query.trim()));
        },
        shouldResetDismissed: ({ transaction }: { transaction: Transaction }) =>
          Boolean(transaction.getMeta(INLINE_PICKER_NAVIGATION_META)),

        items: () => [],

        render: () => ({}),
        command: createMentionInsertCommand,
      },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(ReferenceNodeView, {
      as: 'span',
      className: 'wp-inline-reference-boundary',
      update: ({ oldNode, newNode, oldDecorations, newDecorations, updateProps }) => {
        if (
          oldNode !== newNode ||
          isEditingReference(oldDecorations) !== isEditingReference(newDecorations)
        )
          updateProps();
        return true;
      },
    });
  },

  addProseMirrorPlugins() {
    const parentPlugins = this.parent?.() || [];

    const onEntityOpen = this.options.onMentionClick ?? undefined;

    return [
      ...parentPlugins,
      notebookPickerPlugin(this.editor),
      referenceEditPlugin(),
      inlinePickerQueryDecoration(entityLinkSuggestionKey),
      createMentionHoverPlugin(onEntityOpen),
    ];
  },
});
