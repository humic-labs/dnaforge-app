// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useZoomController } from '../use-zoom-controller';
import { MAX_ZOOM } from '../zoom-math';
import {
  BASE,
  CONTAINER_RECT,
  CONTAINER_WIDTH,
  DEFAULT_SEQ_LENGTH,
  buildLayoutAt,
  mockContainer,
} from '../testing/zoom-fixtures';

const CLEARED_TRANSFORM = 'translate3d(0, 0, 0)';

function setup(
  circular: boolean,
  options: { deferCommitsUntilSettle?: boolean; zoomLevel?: number } = {}
) {
  const initialZoom = options.zoomLevel ?? 100;
  const { config, layout } = buildLayoutAt(initialZoom, { circular });
  const container = mockContainer();
  const zoomTarget = document.createElement('div');
  const commits: Array<{ zoomLevel: number; topBp: number }> = [];
  const gestureStates: boolean[] = [];
  const { result, rerender } = renderHook(
    (owner: { zoomLevel: number; topBp: number }) =>
      useZoomController({
        zoomLevel: owner.zoomLevel,
        topBp: owner.topBp,
        circularOffset: 0,
        setZoomState: (next) => commits.push(next),
        seqLength: DEFAULT_SEQ_LENGTH,
        isCircular: circular,
        baseConfig: BASE,
        containerWidth: CONTAINER_WIDTH,
        containerRef: { current: container },
        zoomTargetRef: { current: zoomTarget },
        layout,
        config,
        deferCommitsUntilSettle: options.deferCommitsUntilSettle ?? false,
        onGestureStateChange: (zooming) => gestureStates.push(zooming),
      }),
    { initialProps: { zoomLevel: initialZoom, topBp: 0 } }
  );
  return { result, rerender, zoomTarget, commits, gestureStates, container };
}

function wheelZoomOut(harness: ReturnType<typeof setup>) {
  act(() => {
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
}

async function zoomOutOnce(circular: boolean, options: { deferCommitsUntilSettle?: boolean } = {}) {
  const harness = setup(circular, options);
  wheelZoomOut(harness);
  expect(harness.zoomTarget.style.transform, 'the wheel must start a preview').toContain('scale(');
  await vi.waitFor(() => expect(harness.commits).toHaveLength(1), { timeout: 3_000 });
  return harness;
}

describe('useZoomController — the gesture must finish after a commit ', () => {
  it('clears the preview on a linear document, which reports topBp 0', async () => {
    const { rerender, zoomTarget, commits, gestureStates } = await zoomOutOnce(false);

    expect(commits[0].topBp, 'a linear commit must anchor on the topBp the viewer reports').toBe(0);

    act(() => rerender({ zoomLevel: commits[0].zoomLevel, topBp: 0 }));

    await vi.waitFor(() => expect(zoomTarget.style.transform).toBe(CLEARED_TRANSFORM), {
      timeout: 3_000,
    });
    await vi.waitFor(() => expect(gestureStates.at(-1)).toBe(false), { timeout: 3_000 });
  });

  it('keeps committing when a linear document holds its commits until settle', async () => {
    const harness = await zoomOutOnce(false, { deferCommitsUntilSettle: true });
    const { rerender, zoomTarget, commits } = harness;

    expect(commits[0].topBp, 'a linear settle commit must anchor on topBp 0').toBe(0);

    act(() => rerender({ zoomLevel: commits[0].zoomLevel, topBp: 0 }));
    await vi.waitFor(() => expect(zoomTarget.style.transform).toBe(CLEARED_TRANSFORM), {
      timeout: 3_000,
    });

    wheelZoomOut(harness);
    await vi.waitFor(() => expect(commits).toHaveLength(2), { timeout: 3_000 });
  });

  it('clears the preview on a circular document, which adopts the solved offset', async () => {
    const { rerender, zoomTarget, commits, gestureStates } = await zoomOutOnce(true);

    act(() => rerender({ zoomLevel: commits[0].zoomLevel, topBp: commits[0].topBp }));

    await vi.waitFor(() => expect(zoomTarget.style.transform).toBe(CLEARED_TRANSFORM), {
      timeout: 3_000,
    });
    await vi.waitFor(() => expect(gestureStates.at(-1)).toBe(false), { timeout: 3_000 });
  });
});

describe('useZoomController — the gesture must not wedge or bank delta ', () => {
  it('finishes an applied zoom when presentation frames arrive after the layout deadline', async () => {
    const { rerender, commits, zoomTarget } = await zoomOutOnce(true);
    const frames: FrameRequestCallback[] = [];
    const paint = vi
      .spyOn(globalThis, 'requestAnimationFrame')
      .mockImplementation((callback) => frames.push(callback));
    const timing = (
      window as Window & {
        __zoomPerf?: { anchorAbandons?: unknown[]; anchorSettles?: unknown[] };
      }
    ).__zoomPerf!;
    const abandoned = timing.anchorAbandons?.length ?? 0;
    const settled = timing.anchorSettles?.length ?? 0;
    try {
      act(() => rerender(commits[0]));
      expect(zoomTarget.style.transform).toBe(CLEARED_TRANSFORM);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(timing.anchorAbandons?.length ?? 0).toBe(abandoned);
      for (let frame = 0; frame < 2; frame++) {
        const callbacks = frames.splice(0);
        expect(callbacks.length).toBeGreaterThan(0);
        act(() => callbacks.forEach((callback) => callback(performance.now())));
      }
      expect(timing.anchorSettles?.length ?? 0).toBe(settled + 1);
    } finally {
      paint.mockRestore();
    }
  });

  it('abandons an anchor the owner never reports, instead of waiting forever', async () => {
    const { rerender, zoomTarget, commits, gestureStates } = await zoomOutOnce(true);

    act(() => rerender({ zoomLevel: commits[0].zoomLevel, topBp: commits[0].topBp + 999 }));

    await vi.waitFor(() => expect(zoomTarget.style.transform).toBe(CLEARED_TRANSFORM), {
      timeout: 5_000,
    });
    await vi.waitFor(() => expect(gestureStates.at(-1)).toBe(false), { timeout: 5_000 });
    const abandons = (window as unknown as { __zoomPerf?: { anchorAbandons?: unknown[] } })
      .__zoomPerf?.anchorAbandons;
    expect(abandons?.length ?? 0).toBeGreaterThan(0);
  });

  it('banks no delta when a gesture zooms in at the ceiling', async () => {
    const harness = setup(false, { zoomLevel: MAX_ZOOM });

    act(() => {
      harness.result.current.onWheel(
        new WheelEvent('wheel', {
          deltaY: -240,
          ctrlKey: true,
          clientX: CONTAINER_RECT.left + 420,
          clientY: CONTAINER_RECT.top + 70,
          cancelable: true,
        })
      );
    });

    expect(harness.zoomTarget.style.transform).not.toContain('scale(');
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(harness.commits, 'a gesture at the ceiling must not commit').toHaveLength(0);
  });
});
