import { useLayoutEffect, type RefObject } from 'react';
import {
  TAB_PORTAL_HOST_ATTACHED_EVENT,
  TAB_PORTAL_HOST_DETACHING_EVENT,
} from '../../../shared/tab-portal-contract';

interface ChatViewport {
  scrollTop: number;
  scrollLeft: number;
  atBottom: boolean;
  anchor: HTMLElement | null;
  anchorTop: number;
}

export function useChatPortalScrollAnchor(
  surfaceRef: RefObject<HTMLElement>,
  conversationId: string
): void {
  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    const host = surface?.closest<HTMLElement>('[id^="tab-content-"]');
    if (!surface || !host) return;
    let captured: ChatViewport | null = null;

    const capture = () => {
      const scroll = surface.querySelector<HTMLElement>('[data-chat-scroll="transcript"]');
      if (!scroll || !host.isConnected) return;
      const rect = scroll.getBoundingClientRect();
      const focused = document.activeElement?.closest<HTMLElement>('[data-chat-scroll-anchor]');
      const anchor =
        focused && scroll.contains(focused)
          ? focused
          : (Array.from(scroll.querySelectorAll<HTMLElement>('[data-chat-scroll-anchor]')).find(
              (element) => {
                const box = element.getBoundingClientRect();
                return box.bottom > rect.top && box.top < rect.bottom;
              }
            ) ?? null);
      captured = {
        scrollTop: scroll.scrollTop,
        scrollLeft: scroll.scrollLeft,
        atBottom: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 1,
        anchor,
        anchorTop: anchor ? anchor.getBoundingClientRect().top - rect.top : 0,
      };
    };

    const restore = () => {
      const previous = captured;
      captured = null;
      const scroll = surface.querySelector<HTMLElement>('[data-chat-scroll="transcript"]');
      if (!previous || !scroll) return;
      if (previous.atBottom) {
        scroll.scrollTop = scroll.scrollHeight;
      } else if (previous.anchor && scroll.contains(previous.anchor)) {
        const anchorTop =
          previous.anchor.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
        scroll.scrollTop += anchorTop - previous.anchorTop;
      } else {
        scroll.scrollTop = previous.scrollTop;
      }
      scroll.scrollLeft = previous.scrollLeft;
    };

    host.addEventListener(TAB_PORTAL_HOST_DETACHING_EVENT, capture);
    host.addEventListener(TAB_PORTAL_HOST_ATTACHED_EVENT, restore);
    return () => {
      host.removeEventListener(TAB_PORTAL_HOST_DETACHING_EVENT, capture);
      host.removeEventListener(TAB_PORTAL_HOST_ATTACHED_EVENT, restore);
    };
  }, [surfaceRef, conversationId]);
}
