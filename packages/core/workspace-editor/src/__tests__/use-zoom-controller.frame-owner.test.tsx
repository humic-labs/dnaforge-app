/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installNativeWheelSource } from '../../../platform/src/wheel-input.test-helper';
import { act, renderHook } from '@testing-library/react';
import { useZoomController } from '../use-zoom-controller';
import {
  BASE,
  CONTAINER_RECT,
  CONTAINER_WIDTH,
  DEFAULT_SEQ_LENGTH,
  buildLayoutAt,
  mockContainer,
} from '../testing/zoom-fixtures';

let disposeNativeSource: () => void;
beforeEach(() => {
  disposeNativeSource = installNativeWheelSource(document);
});
afterEach(() => {
  disposeNativeSource();
  vi.restoreAllMocks();
});

function setup(zoomLevel = 100, browserWheelGestureOwnership = false) {
  const requestFrame = vi.fn();
  const transactions: Array<{ kind: 'forecast' | 'commit'; zoom: number }> = [];
  const animationFrame = vi.spyOn(globalThis, 'requestAnimationFrame');
  const container = Object.assign(mockContainer(), {
    ownerDocument: document,
    clientWidth: CONTAINER_WIDTH,
    clientHeight: CONTAINER_RECT.height,
  });
  const hook = renderHook(
    ({ zoomLevel }) => {
      const { config, layout } = buildLayoutAt(zoomLevel, { circular: true });
      return useZoomController({
        continuous: true,
        browserWheelGestureOwnership,
        requestFrame,
        zoomLevel,
        topBp: 0,
        circularOffset: 0,
        setZoomState: (next) => transactions.push({ kind: 'commit', zoom: next.zoomLevel }),
        onPreviewZoomTarget: (zoom) => transactions.push({ kind: 'forecast', zoom }),
        seqLength: DEFAULT_SEQ_LENGTH,
        isCircular: true,
        baseConfig: BASE,
        containerWidth: CONTAINER_WIDTH,
        containerRef: { current: container },
        zoomTargetRef: { current: document.createElement('div') },
        layout,
        config,
      });
    },
    { initialProps: { zoomLevel } }
  );
  return { ...hook, requestFrame, transactions, animationFrame };
}

describe('continuous zoom shares the viewer frame owner', () => {
  it.each(['metaKey', 'ctrlKey'] as const)(
    'commits the first coarse %s pose while the next display callback is pending',
    (modifier) => {
      vi.spyOn(performance, 'now').mockReturnValue(0);
      const harness = setup(40, true);
      act(() =>
        harness.result.current.onWheel(
          new WheelEvent('wheel', {
            deltaY: -1,
            deltaMode: 1,
            [modifier]: true,
            clientX: CONTAINER_RECT.left + 420,
            clientY: CONTAINER_RECT.top + 70,
            cancelable: true,
          })
        )
      );
      const firstPose = harness.transactions.find(({ kind }) => kind === 'commit');
      expect(firstPose, 'a coarse tick responds before a future display callback').toBeDefined();
      expect(firstPose!.zoom).toBeGreaterThan(40);
      expect(firstPose!.zoom).toBeLessThan(40 * 2 ** (16 / 240));
      expect(harness.transactions.map(({ kind }) => kind)).toEqual(['forecast', 'commit']);
      expect(harness.result.current.hasPendingCommit()).toBe(true);
      expect(harness.animationFrame).not.toHaveBeenCalled();
      harness.unmount();
    }
  );

  it.each(['metaKey', 'ctrlKey'] as const)(
    'submits every coarse %s zoom step through its presentation owner',
    (modifier) => {
      let now = 0;
      vi.spyOn(performance, 'now').mockImplementation(() => now);
      const harness = setup(40, true);
      act(() =>
        harness.result.current.onWheel(
          new WheelEvent('wheel', {
            deltaY: -1,
            deltaMode: 1,
            [modifier]: true,
            clientX: CONTAINER_RECT.left + 420,
            clientY: CONTAINER_RECT.top + 70,
            cancelable: true,
          })
        )
      );
      const destination = 40 * 2 ** (16 / 240);
      const initial = harness.transactions.find(({ kind }) => kind === 'commit')!;
      act(() => harness.rerender({ zoomLevel: initial.zoom }));
      const poses: number[] = [initial.zoom];
      for (now = 16; now <= 208; now += 16) {
        act(() => {
          harness.result.current.flushFrame(now);
        });
        const commit = harness.transactions.filter((t) => t.kind === 'commit').at(-1);
        if (commit) {
          poses.push(commit.zoom);
          act(() => harness.rerender({ zoomLevel: commit.zoom }));
        }
      }
      expect(poses[0]).toBeGreaterThan(40);
      expect(poses[0]).toBeLessThan(destination);
      expect(new Set(poses.filter((zoom) => zoom < destination - 1e-8)).size).toBeGreaterThan(3);
      expect(poses.at(-1)).toBeCloseTo(destination, 10);
      expect(harness.result.current.hasPendingCommit()).toBe(false);
      expect(harness.animationFrame).not.toHaveBeenCalled();
      harness.unmount();
    }
  );

  it('accepts the first small same-direction scroll when native gesture ownership is available', () => {
    const harness = setup(0.2, true);
    const zoom = new WheelEvent('wheel', { deltaY: 8, ctrlKey: true, cancelable: true });
    const scroll = new WheelEvent('wheel', { deltaY: 8, cancelable: true });
    act(() => {
      harness.result.current.onWheel(zoom);
      harness.result.current.onWheel(scroll);
    });
    expect(zoom.defaultPrevented).toBe(true);
    expect(scroll.defaultPrevented).toBe(false);
    expect(harness.result.current.isZooming()).toBe(false);
    expect(harness.result.current.hasPendingCommit()).toBe(false);
    harness.unmount();
  });

  it('retains the browser momentum fallback when native phases are unavailable', () => {
    const harness = setup(0.2);
    const zoom = new WheelEvent('wheel', { deltaY: 8, ctrlKey: true, cancelable: true });
    const tail = new WheelEvent('wheel', { deltaY: 8, cancelable: true });
    act(() => {
      harness.result.current.onWheel(zoom);
      harness.result.current.onWheel(tail);
    });
    expect(tail.defaultPrevented).toBe(true);
    harness.unmount();
  });

  it('consumes zoom overflow at the minimum without reopening a settled transaction', () => {
    const harness = setup(0.2);
    const overflow = new WheelEvent('wheel', {
      deltaY: 8,
      ctrlKey: true,
      clientX: CONTAINER_RECT.left + 420,
      clientY: CONTAINER_RECT.top + 70,
      cancelable: true,
    });
    act(() => harness.result.current.onWheel(overflow));
    expect(overflow.defaultPrevented).toBe(true);
    expect(harness.result.current.isZooming()).toBe(false);
    expect(harness.result.current.hasPendingCommit()).toBe(false);
    expect(harness.requestFrame).not.toHaveBeenCalled();
    expect(harness.transactions).toEqual([]);
    harness.unmount();
  });

  it('coalesces wheel packets without publishing an old-zoom forecast scene', () => {
    const harness = setup();
    expect(harness.animationFrame).not.toHaveBeenCalled();
    act(() => {
      for (let packet = 0; packet < 2; packet += 1)
        harness.result.current.onWheel(
          new WheelEvent('wheel', {
            deltaY: 120,
            ctrlKey: true,
            clientX: CONTAINER_RECT.left + 420,
            clientY: CONTAINER_RECT.top + 70,
            cancelable: true,
          })
        );
    });
    expect(harness.requestFrame).toHaveBeenCalledTimes(2);
    expect(harness.transactions).toEqual([]);
    expect(harness.result.current.hasPendingCommit()).toBe(true);
    act(() => expect(harness.result.current.flushFrame(performance.now())).toBe(true));
    expect(harness.transactions.map(({ kind }) => kind)).toEqual(['forecast', 'commit']);
    expect(harness.transactions[0].zoom).toBeCloseTo(50, 10);
    expect(harness.transactions[1].zoom).toBe(harness.transactions[0].zoom);
    expect(harness.result.current.hasPendingCommit()).toBe(false);
    act(() => expect(harness.result.current.flushFrame(performance.now() + 16)).toBe(false));
    expect(harness.transactions).toHaveLength(2);
    harness.unmount();
  });

  it('accepts the latest control target through the same callback with no queued tail', () => {
    const harness = setup();
    act(() => {
      expect(harness.result.current.zoomTo(70)).toBe(true);
      expect(harness.result.current.zoomTo(40)).toBe(true);
    });
    expect(harness.transactions).toEqual([]);
    expect(harness.requestFrame).toHaveBeenCalledTimes(2);
    act(() => expect(harness.result.current.flushFrame(performance.now())).toBe(true));
    expect(harness.transactions).toEqual([
      { kind: 'forecast', zoom: 40 },
      { kind: 'commit', zoom: 40 },
    ]);
    expect(harness.result.current.hasPendingCommit()).toBe(false);
    harness.unmount();
  });
});
