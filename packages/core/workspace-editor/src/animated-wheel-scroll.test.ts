/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installAnimatedWheelScroll } from './animated-wheel-scroll';
import { dispatchNativeWheel, installNativeWheelSource } from '@waypoint/platform/wheel-motion';

let container: HTMLElement;
let dispose: () => void;
let scroll: ReturnType<typeof installAnimatedWheelScroll>;
let sync: ReturnType<typeof vi.fn>;
let now: number;
let callbacks: Map<number, FrameRequestCallback>;
let nextId: number;
beforeEach(() => {
  now = 0;
  nextId = 0;
  callbacks = new Map();
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    callbacks.set(++nextId, callback);
    return nextId;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    callbacks.delete(id);
  });
  container = document.createElement('div');
  container.setAttribute('data-sequence-wheel-zoom-viewport', 'true');
  document.body.append(container);
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: () => container,
  });
  Object.defineProperties(container, {
    scrollHeight: { value: 4000, configurable: true },
    clientHeight: { value: 600 },
  });
  container.scrollTop = 100;

  container.scrollTo = vi.fn();
  sync = vi.fn();
  scroll = installAnimatedWheelScroll(container, sync);
  dispose = scroll.dispose;
});
afterEach(() => {
  dispose();
  container.remove();
  vi.restoreAllMocks();
});
const wheel = (deltaY: number, options: WheelEventInit = {}) => {
  const event = new WheelEvent('wheel', { deltaY, cancelable: true, bubbles: true, ...options });
  container.dispatchEvent(event);
  return event;
};
const frame = (elapsed = 1000 / 60) => {
  now += elapsed;
  const due = [...callbacks.values()];
  callbacks.clear();
  due.forEach((callback) => callback(now));
};
const settle = () => {
  for (let i = 0; i < 20 && callbacks.size; i++) frame();
  expect(callbacks.size).toBe(0);
};
const nativeWheel = (deltaY: number, precise: boolean, ordinal: number, phase = 0) =>
  dispatchNativeWheel(document, {
    x: 10,
    y: 10,
    deltaX: 0,
    deltaY,
    precise,
    ordinal,
    phase,
    momentumPhase: 0,
  });

it('paints the first native mouse step before a future display callback', () => {
  nativeWheel(120, false, 1);
  expect(container.scrollTop).toBeGreaterThan(100);
  expect(container.scrollTop).toBeLessThan(220);
  expect(sync).toHaveBeenCalledOnce();
  expect(callbacks.size).toBe(1);
  settle();
  expect(container.scrollTop).toBe(220);
});

it('applies native precise distance on the first refresh without an easing tail', () => {
  nativeWheel(6, true, 1, 1);
  expect(sync).not.toHaveBeenCalled();
  frame();
  expect(container.scrollTop).toBe(106);
  expect(sync).toHaveBeenCalledOnce();
  expect(callbacks.size).toBe(0);
});
it('keeps precise distance when the next native packet starts a mouse animation', () => {
  nativeWheel(6, true, 1, 1);
  nativeWheel(0, true, 2, 8);
  nativeWheel(120, false, 3);
  frame();
  expect(container.scrollTop).toBeGreaterThan(106);
  expect(container.scrollTop).toBeLessThan(226);
  settle();
  expect(container.scrollTop).toBe(226);
});
it('a later native precise packet cancels unfinished mouse motion without losing its own distance', () => {
  nativeWheel(120, false, 1);
  frame();
  const displayed = container.scrollTop;
  nativeWheel(6, true, 2, 1);
  frame();
  expect(container.scrollTop).toBe(displayed + 6);
  expect(callbacks.size).toBe(0);
  frame();
  expect(container.scrollTop).toBe(displayed + 6);
});

it('subframe native precision packets share one scientific paint and retain every delta', () => {
  for (let packet = 0; packet < 12; packet++) nativeWheel(8, true, packet + 1, packet ? 4 : 1);
  nativeWheel(0, true, 13, 8);
  expect(callbacks.size).toBe(1);
  expect(sync).not.toHaveBeenCalled();
  frame();
  expect(container.scrollTop).toBe(196);
  expect(sync).toHaveBeenCalledOnce();
  expect(callbacks.size).toBe(0);
});

it('clamps precise packets in their original order before a subframe reversal', () => {
  container.scrollTop = 0;
  nativeWheel(-6, true, 1, 1);
  nativeWheel(6, true, 2, 4);
  frame();
  expect(container.scrollTop).toBe(6);
  expect(sync).toHaveBeenCalledOnce();
});
it('clamps a following mouse target from the queued precision position', () => {
  nativeWheel(6, true, 1, 1);
  nativeWheel(-120, false, 2);
  settle();
  expect(container.scrollTop).toBe(0);
});
it('retains queued precision across a deferred circular reanchor', () => {
  dispose();
  const reanchor = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
  scroll = installAnimatedWheelScroll(container, sync, reanchor);
  dispose = scroll.dispose;
  nativeWheel(6, true, 1, 1);
  frame();
  expect(sync).not.toHaveBeenCalled();
  expect(callbacks.size).toBe(1);
  container.scrollTop += 1000;
  frame();
  expect(container.scrollTop).toBe(1106);
  expect(sync).toHaveBeenCalledOnce();
  expect(callbacks.size).toBe(0);
});
it('browser precision uses the same circular reanchor and exact-distance frame owner', () => {
  dispose();
  const reanchor = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
  scroll = installAnimatedWheelScroll(container, sync, reanchor);
  dispose = scroll.dispose;
  const disposeNativeSource = installNativeWheelSource(document);
  try {
    expect(wheel(6).defaultPrevented).toBe(true);
    frame();
    expect(reanchor).toHaveBeenCalledWith(1);
    expect(sync).not.toHaveBeenCalled();
    container.scrollTop += 1000;
    frame();
    expect(container.scrollTop).toBe(1106);
    expect(sync).toHaveBeenCalledOnce();
    expect(callbacks.size).toBe(0);
  } finally {
    disposeNativeSource();
  }
});
it('explicit navigation cancels queued precision and a following mouse destination', () => {
  nativeWheel(6, true, 1, 1);
  nativeWheel(120, false, 2);
  scroll.cancel();
  container.scrollTop = 900;
  frame();
  expect(container.scrollTop).toBe(900);
  expect(sync).not.toHaveBeenCalled();
  expect(callbacks.size).toBe(0);
});

it('moves on the first refresh and paints that position in the same callback', () => {
  expect(wheel(180).defaultPrevented).toBe(true);
  frame();
  expect(container.scrollTop).toBeGreaterThan(100);
  expect(container.scrollTop).toBeLessThan(280);
  expect(sync).toHaveBeenLastCalledWith();
  expect(container.scrollTo).not.toHaveBeenCalled();
  settle();
  expect(container.scrollTop).toBe(280);
});
it('does not starve during sustained sub-frame input and retains reversals and all distance', () => {
  let actual = container.scrollTop;
  Object.defineProperty(container, 'scrollTop', {
    configurable: true,
    get: () => actual,
    set: (value: number) => {
      actual = Math.round(value * 2) / 2;
    },
  });
  const positions: number[] = [];
  for (const direction of [1, -1, 1]) {
    for (let packet = 0; packet < 90; packet++) {
      wheel(direction * 8);
      now += 4;
      if (packet % 4 === 3) {
        frame(0);
        positions.push(container.scrollTop);
      }
      expect(callbacks.size).toBe(1);
    }
    wheel(0);
  }
  expect(positions[20]).toBeGreaterThan(500);
  expect(positions[42]).toBeLessThan(positions[25]);
  settle();
  expect(container.scrollTop).toBe(820);
});
it('starts a one-pixel gesture within two refreshes without dead distance', () => {
  wheel(1);
  frame();
  expect(container.scrollTop).toBeGreaterThan(100);
  settle();
  expect(container.scrollTop).toBe(101);
});
it('accumulates fractional motion when the browser rounds DOM scroll positions', () => {
  let actual = 100;
  Object.defineProperty(container, 'scrollTop', {
    configurable: true,
    get: () => actual,
    set: (value: number) => {
      actual = Math.round(value * 2) / 2;
    },
  });
  wheel(1);
  frame(8.33);
  frame(8.33);
  expect(container.scrollTop).toBeGreaterThan(100);
  settle();
  expect(container.scrollTop).toBe(101);
});
it.each([{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }])(
  'surrenders pending motion to modified input %j',
  (options) => {
    wheel(120);
    frame();
    const stopped = container.scrollTop;
    wheel(120, options);
    frame();
    expect(container.scrollTop).toBe(stopped);
    expect(callbacks.size).toBe(0);
  }
);
it('does not turn consumed zoom-tail input into scroll', () => {
  const event = new WheelEvent('wheel', { deltaY: 80, cancelable: true });
  event.preventDefault();
  container.dispatchEvent(event);
  expect(callbacks.size).toBe(0);
});
it('pointer navigation cancels before the new position is written', () => {
  wheel(120);
  frame();
  window.dispatchEvent(new Event('pointerdown'));
  container.scrollTop = 900;
  wheel(40);
  settle();
  expect(container.scrollTop).toBe(940);
});
it('clamps without leaving debt that blocks a reverse gesture', () => {
  wheel(-1000);
  settle();
  expect(container.scrollTop).toBe(0);
  expect(wheel(-1000).defaultPrevented).toBe(false);
  wheel(8);
  settle();
  expect(container.scrollTop).toBe(8);
});
it('normalizes line and page inputs', () => {
  wheel(3, { deltaMode: 1 });
  wheel(1, { deltaMode: 2 });
  settle();
  expect(container.scrollTop).toBe(748);
});
it('preserves remaining distance across a circular viewport rebase', () => {
  wheel(120);
  frame();
  container.scrollTop += 1000;
  container.dispatchEvent(new Event('scroll'));
  settle();
  expect(container.scrollTop).toBe(1220);
});
