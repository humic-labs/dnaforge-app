import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useRef } from 'react';
import { useMolstarVisibilityPause } from './useMolstarVisibilityPause';

type ObserverCb = IntersectionObserverCallback;

describe('useMolstarVisibilityPause', () => {
  let observe: ReturnType<typeof vi.fn>;
  let disconnect: ReturnType<typeof vi.fn>;
  let lastCb: ObserverCb | null;
  let pause: ReturnType<typeof vi.fn>;
  let resume: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    observe = vi.fn();
    disconnect = vi.fn();
    lastCb = null;
    pause = vi.fn();
    resume = vi.fn();

    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: ObserverCb) {
          lastCb = cb;
        }
        observe = observe;
        disconnect = disconnect;
        unobserve = vi.fn();
        takeRecords = () => [];
        root = null;
        rootMargin = '';
        thresholds = [];
      }
    );

    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      overflowY: 'auto',
      overflow: 'auto',
    } as CSSStyleDeclaration);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('pauses canvas3d when scrolled out of the notebook pane and resumes on re-entry', () => {
    const wrapper = document.createElement('div');
    const scroll = document.createElement('div');
    scroll.appendChild(wrapper);
    document.body.appendChild(scroll);

    const plugin = { canvas3d: { pause, resume } };
    const { unmount } = renderHook(() => {
      const wrapperRef = useRef<HTMLElement | null>(wrapper);
      useMolstarVisibilityPause({
        wrapperRef,
        viewerReady: true,
        getPlugin: () => plugin,
      });
    });

    expect(observe).toHaveBeenCalledWith(wrapper);
    expect(lastCb).toBeTruthy();

    lastCb?.([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver);
    expect(pause).toHaveBeenCalledWith(true);

    lastCb?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    expect(resume).toHaveBeenCalled();

    unmount();
    expect(disconnect).toHaveBeenCalled();
  });

  it('ignores a queued observer callback after its visibility owner was retired', () => {
    const wrapper = document.createElement('div');
    document.body.appendChild(wrapper);
    const plugin = { canvas3d: { pause, resume } };
    const { unmount } = renderHook(() => {
      const wrapperRef = useRef<HTMLElement | null>(wrapper);
      useMolstarVisibilityPause({ wrapperRef, viewerReady: true, getPlugin: () => plugin });
    });
    const queuedCallback = lastCb;
    unmount();
    pause.mockClear();
    resume.mockClear();
    queuedCallback?.(
      [{ isIntersecting: false } as IntersectionObserverEntry],
      {} as IntersectionObserver
    );
    expect(pause).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it('does not observe until viewerReady', () => {
    const wrapper = document.createElement('div');
    document.body.appendChild(wrapper);

    renderHook(() => {
      const wrapperRef = useRef<HTMLElement | null>(wrapper);
      useMolstarVisibilityPause({
        wrapperRef,
        viewerReady: false,
        getPlugin: () => ({ canvas3d: { pause, resume } }),
      });
    });

    expect(observe).not.toHaveBeenCalled();
  });

  it('pauses canvas3d while the notebook scrollport is receiving wheel input', () => {
    vi.useFakeTimers();
    const wrapper = document.createElement('div');
    const scroll = document.createElement('div');
    scroll.appendChild(wrapper);
    document.body.appendChild(scroll);

    const plugin = { canvas3d: { pause, resume } };
    renderHook(() => {
      const wrapperRef = useRef<HTMLElement | null>(wrapper);
      useMolstarVisibilityPause({
        wrapperRef,
        viewerReady: true,
        getPlugin: () => plugin,
        pauseWhileScrolling: true,
      });
    });

    lastCb?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    pause.mockClear();
    resume.mockClear();

    scroll.dispatchEvent(new Event('wheel'));
    expect(pause).toHaveBeenCalledWith(true);

    vi.advanceTimersByTime(120);
    expect(resume).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('does not pause an interactive viewer when its own zoom wheel bubbles through the scrollport', () => {
    const wrapper = document.createElement('div');
    const scroll = document.createElement('div');
    scroll.appendChild(wrapper);
    document.body.appendChild(scroll);

    const plugin = { canvas3d: { pause, resume } };
    renderHook(() => {
      const wrapperRef = useRef<HTMLElement | null>(wrapper);
      useMolstarVisibilityPause({
        wrapperRef,
        viewerReady: true,
        getPlugin: () => plugin,
      });
    });

    lastCb?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    pause.mockClear();
    resume.mockClear();

    wrapper.dispatchEvent(new Event('wheel', { bubbles: true }));

    expect(pause).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });
});
