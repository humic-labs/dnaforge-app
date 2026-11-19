import type { Editor } from '@tiptap/core';
import tippy, { type GetReferenceClientRect } from 'tippy.js';

import type { entityLinkSuggestionKey } from './inline-picker-navigation';

export interface InlinePickerPopup {
  update: () => void;
  destroy: () => void;
}

function lastQueryLine(fragments: NodeListOf<Element>): DOMRect | undefined {
  const rects = Array.from(fragments).flatMap((fragment) => {
    const lines = fragment.getClientRects();
    return lines.length ? Array.from(lines) : [fragment.getBoundingClientRect()];
  });
  const last = rects.at(-1);
  if (!last) return;
  const midline = (last.top + last.bottom) / 2;
  const line = rects.filter((rect) => rect.top <= midline && rect.bottom >= midline);
  const left = Math.min(...line.map((rect) => rect.left));
  const right = Math.max(...line.map((rect) => rect.right));
  const top = Math.min(...line.map((rect) => rect.top));
  const bottom = Math.max(...line.map((rect) => rect.bottom));
  return new DOMRect(left, top, right - left, bottom - top);
}

export function createInlinePickerPopup({
  editor,
  content,
  getSuggestionKey,
  anchor,
  onDismiss,
}: {
  editor: Editor;
  content: HTMLElement;

  onDismiss: () => void;
} & (
  | { getSuggestionKey: () => typeof entityLinkSuggestionKey; anchor?: never }
  | { anchor: HTMLElement; getSuggestionKey?: never }
)): InlinePickerPopup {
  const contextElement = editor.view.dom;
  let destroyed = false;
  let dismissQueued = false;
  const dismiss = () => {
    if (destroyed || dismissQueued) return;
    dismissQueued = true;
    queueMicrotask(() => {
      if (destroyed) return;
      if (editor.isDestroyed) popup.destroy();
      else onDismiss();
    });
  };
  const getReferenceClientRect: GetReferenceClientRect = Object.assign(
    () => {
      if (anchor?.isConnected) return anchor.getBoundingClientRect();
      const active =
        !editor.isDestroyed &&
        contextElement.isConnected &&
        getSuggestionKey?.().getState(editor.state);
      if (!active || !active.active) {
        dismiss();
        return new DOMRect();
      }
      const line = lastQueryLine(
        contextElement.querySelectorAll(`[data-entity-query="${active.decorationId}"]`)
      );
      if (line) return line;
      const { left, right, top, bottom } = editor.view.coordsAtPos(active.range.to, -1);
      return new DOMRect(left, top, right - left, bottom - top);
    },
    { contextElement }
  );
  const popup = tippy(contextElement, {
    getReferenceClientRect,
    appendTo: () => contextElement.ownerDocument.body,
    content,
    showOnCreate: true,
    interactive: true,
    trigger: 'manual',
    placement: 'bottom-start',
    offset: [0, 0],
    theme: 'notebook-picker',
    animation: false,
    arrow: false,
    maxWidth: 'none',
    aria: { content: null, expanded: false },
    onClickOutside: dismiss,
    onDestroy: () => {
      contextElement.removeAttribute('data-picker-above');
      destroyed = true;
    },
    popperOptions: {
      modifiers: [
        {
          name: 'joinInlineTab',
          enabled: true,
          phase: 'write',
          requires: ['popperOffsets'],
          fn: ({ state }) => {
            const offsets = state.modifiersData.popperOffsets;
            if (!offsets) return;
            const { reference, popper } = state.rects;
            const start = Math.max(0, Math.min(popper.width, reference.x - offsets.x));
            const end = Math.max(
              0,
              Math.min(popper.width, reference.x + reference.width - offsets.x)
            );
            const style = state.elements.popper.style;
            style.setProperty('--picker-join-start', `${start}px`);
            style.setProperty('--picker-join-end', `${end}px`);
            style.setProperty('--picker-left-radius', start < 1 ? '0px' : '6px');
            style.setProperty('--picker-right-radius', end > popper.width - 1 ? '0px' : '6px');
            contextElement.toggleAttribute('data-picker-above', state.placement.startsWith('top'));
          },
        },
        { name: 'flip', options: { fallbackPlacements: ['top-start'] } },
        {
          name: 'dismissClippedPicker',
          enabled: true,
          phase: 'afterWrite',
          requires: ['hide'],
          fn: ({ state }) => {
            if (state.modifiersData.hide?.isReferenceHidden) dismiss();
          },
        },
        {
          name: 'observePickerSize',
          enabled: true,
          phase: 'write',
          fn: () => {},
          effect: ({ state, instance }) => {
            if (typeof ResizeObserver !== 'function') return;
            let active = true;
            const observer = new ResizeObserver(() => {
              if (active) void instance.update();
            });
            const elements = new Set([
              contextElement,
              state.elements.popper,
              ...state.scrollParents.reference.filter(
                (element): element is Element => element instanceof Element
              ),
            ]);
            elements.forEach((element) => observer.observe(element));
            return () => {
              active = false;
              observer.disconnect();
            };
          },
        },
      ],
    },
  });

  return {
    update() {
      if (destroyed) return;
      void popup.popperInstance?.update();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      popup.destroy();
    },
  };
}
