/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { safeFocus, safeScrollIntoView, scrollIntoNearestScrollContainer } from './safeFocus';

function mockRect(el: Element, rect: Partial<DOMRect>) {
  el.getBoundingClientRect = () =>
    ({
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      x: 0,
      y: 0,
      toJSON() {},
      ...rect,
    }) as DOMRect;
}

function mockScrollBox(
  el: HTMLElement,
  { scrollHeight, clientHeight, top }: { scrollHeight: number; clientHeight: number; top: number }
) {
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
  el.style.overflowY = 'auto';
  mockRect(el, { top, height: clientHeight, bottom: top + clientHeight });
}

describe('safeFocus', () => {
  it('calls focus on a connected element', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const spy = vi.spyOn(el, 'focus');

    const result = safeFocus(el);

    expect(result).toBe(true);
    expect(spy).toHaveBeenCalledOnce();
    document.body.removeChild(el);
  });

  it('does NOT call focus on a detached element', () => {
    const el = document.createElement('div');
    const spy = vi.spyOn(el, 'focus');

    const result = safeFocus(el);

    expect(result).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('handles null gracefully', () => {
    expect(safeFocus(null)).toBe(false);
  });

  it('handles undefined gracefully', () => {
    expect(safeFocus(undefined)).toBe(false);
  });

  it('passes FocusOptions through', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const spy = vi.spyOn(el, 'focus');

    safeFocus(el, { preventScroll: true });

    expect(spy).toHaveBeenCalledWith({ preventScroll: true });
    document.body.removeChild(el);
  });

  it('returns false after element is removed from DOM', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    expect(safeFocus(el)).toBe(true);

    document.body.removeChild(el);
    expect(safeFocus(el)).toBe(false);
  });
});

describe('safeScrollIntoView', () => {
  it('calls scrollIntoView on a connected element', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    el.scrollIntoView = vi.fn();

    const result = safeScrollIntoView(el, { block: 'nearest' });

    expect(result).toBe(true);
    expect(el.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    document.body.removeChild(el);
  });

  it('does NOT call scrollIntoView on a detached element', () => {
    const el = document.createElement('div');
    el.scrollIntoView = vi.fn();

    const result = safeScrollIntoView(el);

    expect(result).toBe(false);
    expect(el.scrollIntoView).not.toHaveBeenCalled();
  });

  it('handles null gracefully', () => {
    expect(safeScrollIntoView(null)).toBe(false);
  });

  it('returns false when scrollIntoView is unavailable in the test DOM', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const originalScrollIntoView = el.scrollIntoView;
    el.scrollIntoView = undefined as unknown as typeof el.scrollIntoView;

    expect(safeScrollIntoView(el)).toBe(false);

    el.scrollIntoView = originalScrollIntoView;
    document.body.removeChild(el);
  });
});

describe('scrollIntoNearestScrollContainer', () => {
  it('handles null/undefined/detached gracefully', () => {
    expect(scrollIntoNearestScrollContainer(null)).toBe(false);
    expect(scrollIntoNearestScrollContainer(undefined)).toBe(false);
    const detached = document.createElement('div');
    expect(scrollIntoNearestScrollContainer(detached)).toBe(false);
  });

  it('is a no-op when no ancestor is actually overflowing', () => {
    const container = document.createElement('div');
    const target = document.createElement('div');
    container.appendChild(target);
    document.body.appendChild(container);
    mockScrollBox(container, { scrollHeight: 200, clientHeight: 200, top: 0 });

    expect(scrollIntoNearestScrollContainer(target)).toBe(false);
    expect(container.scrollTop).toBe(0);
    document.body.removeChild(container);
  });

  it('never calls the native Element.prototype.scrollIntoView ', () => {
    const container = document.createElement('div');
    const target = document.createElement('div');
    container.appendChild(target);
    document.body.appendChild(container);
    mockScrollBox(container, { scrollHeight: 1000, clientHeight: 200, top: 0 });
    mockRect(target, { top: 900, height: 20, bottom: 920 });
    const spy = vi.fn();
    target.scrollIntoView = spy;

    scrollIntoNearestScrollContainer(target, { block: 'center' });

    expect(spy).not.toHaveBeenCalled();
    document.body.removeChild(container);
  });

  it('scrolls the NEAREST bounded container — not the window — to bring an out-of-view target into view ("nearest")', () => {
    const container = document.createElement('div');
    const target = document.createElement('div');
    container.appendChild(target);
    document.body.appendChild(container);
    mockScrollBox(container, { scrollHeight: 1000, clientHeight: 200, top: 0 });
    container.scrollTop = 0;
    mockRect(target, { top: 900, height: 20, bottom: 920 });

    const result = scrollIntoNearestScrollContainer(target, { block: 'nearest' });

    expect(result).toBe(true);
    expect(container.scrollTop).toBe(920 - 200);
  });

  it('is a no-op ("nearest") when the target is already fully visible', () => {
    const container = document.createElement('div');
    const target = document.createElement('div');
    container.appendChild(target);
    document.body.appendChild(container);
    mockScrollBox(container, { scrollHeight: 1000, clientHeight: 200, top: 0 });
    container.scrollTop = 50;
    mockRect(target, { top: 70, height: 20, bottom: 90 });

    const result = scrollIntoNearestScrollContainer(target, { block: 'nearest' });

    expect(result).toBe(true);
    expect(container.scrollTop).toBe(50);
  });

  it('centers the target within the container when block:"center" is requested', () => {
    const container = document.createElement('div');
    const target = document.createElement('div');
    container.appendChild(target);
    document.body.appendChild(container);
    mockScrollBox(container, { scrollHeight: 1000, clientHeight: 200, top: 0 });
    container.scrollTop = 0;
    mockRect(target, { top: 500, height: 20, bottom: 520 });

    scrollIntoNearestScrollContainer(target, { block: 'center' });

    expect(container.scrollTop).toBe(410);
  });

  it('clamps to [0, scrollHeight - clientHeight] — never past either edge', () => {
    const container = document.createElement('div');
    const target = document.createElement('div');
    container.appendChild(target);
    document.body.appendChild(container);
    mockScrollBox(container, { scrollHeight: 300, clientHeight: 200, top: 0 });
    container.scrollTop = 50;
    mockRect(target, { top: 5, height: 10, bottom: 15 });

    scrollIntoNearestScrollContainer(target, { block: 'center' });

    expect(container.scrollTop).toBe(0);
  });

  it('skips a closer ancestor that is styled overflow-auto but not actually overflowing, and uses the next real scroll box', () => {
    const outerScrollable = document.createElement('div');
    const innerNonOverflowing = document.createElement('div');
    const target = document.createElement('div');
    innerNonOverflowing.appendChild(target);
    outerScrollable.appendChild(innerNonOverflowing);
    document.body.appendChild(outerScrollable);

    mockScrollBox(innerNonOverflowing, { scrollHeight: 100, clientHeight: 100, top: 0 });
    mockScrollBox(outerScrollable, { scrollHeight: 1000, clientHeight: 300, top: 0 });
    mockRect(target, { top: 900, height: 20, bottom: 920 });

    const result = scrollIntoNearestScrollContainer(target, { block: 'nearest' });

    expect(result).toBe(true);
    expect(innerNonOverflowing.scrollTop).toBe(0);
    expect(outerScrollable.scrollTop).toBe(920 - 300);
  });
});
