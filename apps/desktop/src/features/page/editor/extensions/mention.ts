import { NotebookMentionNode } from './notebook-mention-model';
import { ReactRenderer, ReactNodeViewRenderer } from '@tiptap/react';

import { MentionChip } from '../components/MentionChip';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import tippy, { type Instance as TippyInstance } from 'tippy.js';
import type { Editor } from '@tiptap/core';
import type { ComponentType } from 'react';
import {
  MentionMenu,
  type MentionMenuRef,
  type MentionAttrs,
  type MentionMenuProps,
} from '../components/MentionMenu';
import { createMentionInsertCommand } from './mention-insert';
import type { MentionOpenIntent, MentionOptions } from './mention-types';
export type { MentionOpenIntent, MentionOptions, MentionReferenceRecord } from './mention-types';
import { PagePreview } from '../../embeds/page/Preview';
import { groupSearchResults, searchEntities, type EntityGroup } from '../lib/search';

export type { MentionAttrs };

const mentionHoverPluginKey = new PluginKey('mentionHover');

const latestMentionSearch = new WeakMap<object, Promise<EntityGroup[]>>();
const detachedEditor = {};

async function searchMentionGroups(
  query: string,
  owningRoot: string | null,
  editor: Editor | undefined
): Promise<EntityGroup[]> {
  const key = editor ?? detachedEditor;
  const search = searchEntities(query, owningRoot).then((results) =>
    groupSearchResults(results, query)
  );
  latestMentionSearch.set(key, search);
  const groups = await search;
  const latest = latestMentionSearch.get(key);
  return latest && latest !== search ? latest : groups;
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
        char: '@',
        allowSpaces: true,

        items: async ({ query, editor }: { query: string; editor?: Editor }) => {
          const owningRoot =
            (
              editor?.extensionManager.extensions.find((e) => e.name === 'mention')?.options as
                | MentionOptions
                | undefined
            )?.referenceWorkspaceRoot?.() ?? null;
          return searchMentionGroups(query, owningRoot, editor);
        },

        render: () => {
          let component: ReactRenderer<MentionMenuRef> | null = null;
          let popup: TippyInstance[] | null = null;

          return {
            onStart: (props: {
              items: EntityGroup[];
              query: string;
              command: (attrs: MentionAttrs) => void;
              clientRect?: (() => DOMRect | null) | null;
              editor: unknown;
            }) => {
              component = new ReactRenderer(MentionMenu as ComponentType<MentionMenuProps>, {
                props: {
                  items: props.items,
                  query: props.query,
                  command: props.command,
                },
                editor: props.editor as Editor,
              });

              if (!props.clientRect) return;

              popup = tippy('body', {
                getReferenceClientRect: props.clientRect as () => DOMRect,
                appendTo: () => document.body,
                content: component.element,
                showOnCreate: true,
                interactive: true,
                trigger: 'manual',
                placement: 'bottom-start',
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

            onUpdate: (props: {
              items: EntityGroup[];
              query: string;
              command: (attrs: MentionAttrs) => void;
              clientRect?: (() => DOMRect | null) | null;
            }) => {
              component?.updateProps({
                items: props.items,
                query: props.query,
                command: props.command,
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
              popup?.[0]?.destroy();
              component?.destroy();
            },
          };
        },

        command: createMentionInsertCommand,
      },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(MentionChip, { as: 'span' });
  },

  addProseMirrorPlugins() {
    const parentPlugins = this.parent?.() || [];

    const onEntityOpen = this.options.onMentionClick ?? undefined;

    return [...parentPlugins, createMentionHoverPlugin(onEntityOpen)];
  },
});
