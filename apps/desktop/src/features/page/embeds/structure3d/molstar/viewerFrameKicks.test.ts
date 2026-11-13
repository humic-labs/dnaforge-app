// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import {
  resizeMolstarViewer,
  restartMolstarPaneAnimationLoop,
  scheduleMolstarFrameKicks,
} from './viewerFrameKicks';

it('synchronizes native canvas dimensions before the viewport and draws synchronously without restarting controls', () => {
  const steps: string[] = [];
  const animate = vi.fn();
  const tick = vi.fn(() => {
    steps.push('draw');
  });
  resizeMolstarViewer({
    handleResize: () => {
      steps.push('canvas');
    },
    canvas3d: {
      handleResize: () => {
        steps.push('viewport');
      },
      requestDraw: () => {
        steps.push('request');
      },
      tick,
      animate,
    },
  });
  expect(steps).toEqual(['canvas', 'viewport', 'request', 'draw']);
  expect(tick).toHaveBeenCalledWith(expect.any(Number), { isSynchronous: true });
  expect(animate).not.toHaveBeenCalled();
});

describe('scheduleMolstarFrameKicks', () => {
  it('restarts the pane-owned loop after activating a different structure', () => {
    const stop = vi.fn();
    const start = vi.fn();
    restartMolstarPaneAnimationLoop({ animationLoop: { stop, start } });
    expect(stop).toHaveBeenCalledWith({ noDraw: true });
    expect(start).toHaveBeenCalledWith({ immediate: true });
    expect(stop.mock.invocationCallOrder[0]).toBeLessThan(start.mock.invocationCallOrder[0]);
  });
  it('uses a short kick ladder for visibility-resume (scroll edge), not the 3.5s reveal storm', () => {
    vi.useFakeTimers();
    const handleResize = vi.fn();
    const requestDraw = vi.fn();
    const commit = vi.fn();
    const animate = vi.fn();
    const plugin = {
      canvas3d: { handleResize, requestDraw, commit, animate },
    };
    const setTimeoutSpy = vi.fn((cb: () => void, delay: number) =>
      setTimeout(cb, delay)
    ) as unknown as typeof setTimeout;

    scheduleMolstarFrameKicks(plugin, {
      mode: 'visibility-resume',
      setTimeout: setTimeoutSpy,
      requestAnimationFrame: (cb) => {
        cb(0);
        return 1;
      },
    });

    const delays = setTimeoutSpy.mock.calls.map((call) => call[1]);
    expect(delays).toEqual([50, 150]);
    expect(handleResize).toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('keeps the full reveal ladder by default', () => {
    const setTimeoutSpy = vi.fn((cb: () => void, delay: number) =>
      setTimeout(cb, delay)
    ) as unknown as typeof setTimeout;

    scheduleMolstarFrameKicks(
      {
        canvas3d: {
          handleResize: vi.fn(),
          requestDraw: vi.fn(),
          commit: vi.fn(),
          animate: vi.fn(),
        },
      },
      {
        setTimeout: setTimeoutSpy,
        requestAnimationFrame: () => 1,
      }
    );

    const delays = setTimeoutSpy.mock.calls.map((call) => call[1]);
    expect(delays).toEqual([50, 150, 350, 750, 1250, 2000, 3500]);
  });
});
