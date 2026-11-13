import { useRef } from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  TAB_PORTAL_HOST_ATTACHED_EVENT,
  TAB_PORTAL_HOST_DETACHING_EVENT,
} from '../../../shared/tab-portal-contract';
import { useChatPortalScrollAnchor } from './useChatPortalScrollAnchor';

function Surface({ conversationId = 'chat-a' }: { conversationId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useChatPortalScrollAnchor(ref, conversationId);
  return (
    <div ref={ref}>
      <div data-chat-scroll="transcript">
        <div data-chat-scroll-anchor="first">An earlier message</div>
        <div data-chat-scroll-anchor="preview">
          <button>Open the saved view</button>
        </div>
      </div>
    </div>
  );
}

function setup() {
  const host = document.createElement('div');
  host.id = 'tab-content-chat-test';
  document.body.appendChild(host);
  const result = render(<Surface />, { container: host });
  const scroll = host.querySelector<HTMLElement>('[data-chat-scroll]')!;
  const first = host.querySelector<HTMLElement>('[data-chat-scroll-anchor="first"]')!;
  const preview = host.querySelector<HTMLElement>('[data-chat-scroll-anchor="preview"]')!;
  let reflow = 0;
  let scrollTop = 0;
  Object.defineProperties(scroll, {
    clientHeight: { configurable: true, value: 500 },
    scrollHeight: { configurable: true, value: 2000 },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.max(0, Math.min(value, scroll.scrollHeight - scroll.clientHeight));
      },
    },
  });
  scroll.getBoundingClientRect = () => ({ top: 100, bottom: 600 }) as DOMRect;
  first.getBoundingClientRect = () =>
    ({ top: 500 + reflow - scroll.scrollTop, bottom: 650 + reflow - scroll.scrollTop }) as DOMRect;
  preview.getBoundingClientRect = () =>
    ({ top: 700 + reflow - scroll.scrollTop, bottom: 1000 + reflow - scroll.scrollTop }) as DOMRect;
  scroll.scrollTop = 400;
  scroll.scrollLeft = 12;
  const detach = () =>
    act(() => {
      host.dispatchEvent(new Event(TAB_PORTAL_HOST_DETACHING_EVENT));
    });
  const attach = () =>
    act(() => {
      host.dispatchEvent(new Event(TAB_PORTAL_HOST_ATTACHED_EVENT));
    });
  return {
    ...result,
    host,
    scroll,
    first,
    preview,
    detach,
    attach,
    reflow: (offset: number) => {
      reflow = offset;
    },
  };
}

describe('chat portal viewport ownership', () => {
  it('keeps the focused preview at its viewport offset after width reflow', () => {
    const s = setup();
    s.preview.querySelector('button')!.focus();
    s.detach();
    s.scroll.scrollTop = 0;
    s.reflow(180);
    s.attach();
    expect(s.scroll.scrollTop).toBe(580);
    expect(s.preview.getBoundingClientRect().top).toBe(300);
    expect(s.scroll.scrollLeft).toBe(12);
  });

  it('preserves the first visible message when focus is outside the transcript', () => {
    const s = setup();
    s.detach();
    s.scroll.scrollTop = 0;
    s.reflow(90);
    s.attach();
    expect(s.scroll.scrollTop).toBe(490);
    expect(s.first.getBoundingClientRect().top).toBe(100);
  });

  it('keeps a bottom-pinned transcript at the bottom when content grows', () => {
    const s = setup();
    s.scroll.scrollTop = 1500;
    s.detach();
    s.scroll.scrollTop = 0;
    Object.defineProperty(s.scroll, 'scrollHeight', { configurable: true, value: 2400 });
    s.attach();
    expect(s.scroll.scrollTop).toBe(1900);
  });

  it('uses the previous offset if the captured message is removed', () => {
    const s = setup();
    s.detach();
    s.first.remove();
    s.scroll.scrollTop = 0;
    s.attach();
    expect(s.scroll.scrollTop).toBe(400);
  });

  it("does not reuse another conversation's viewport or react to another host", () => {
    const s = setup();
    s.detach();
    s.rerender(<Surface conversationId="chat-b" />);
    s.scroll.scrollTop = 70;
    s.attach();
    expect(s.scroll.scrollTop).toBe(70);
    fireEvent(document.createElement('div'), new Event(TAB_PORTAL_HOST_DETACHING_EVENT));
    s.attach();
    expect(s.scroll.scrollTop).toBe(70);
  });
});
