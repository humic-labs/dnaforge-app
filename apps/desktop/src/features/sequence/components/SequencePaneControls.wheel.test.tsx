import { act, fireEvent, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  dispatchNativeWheel,
  forwardWheelZoom,
  getNativeWheelInput,
  installNativeWheelSource,
  registerWheelZoomTarget,
  shouldAnimateWheel,
} from '@waypoint/platform/wheel-motion';
import { useZoomController } from '../../../../../../packages/core/workspace-editor/src/use-zoom-controller';
import {
  BASE,
  CONTAINER_RECT,
  CONTAINER_WIDTH,
  buildLayoutAt,
} from '../../../../../../packages/core/workspace-editor/src/testing/zoom-fixtures';
import { SequencePaneControls } from './SequencePaneControls';

let now = 0;
let disposeNativeSource: () => void;
beforeEach(() => {
  now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  disposeNativeSource = installNativeWheelSource(document);
});
afterEach(() => {
  disposeNativeSource();
  vi.restoreAllMocks();
});

function driveZoom(
  bar: boolean,
  deltaY: number,
  precise: boolean | null,
  deltaMode = 0,
  initialZoom = 40
) {
  now = 0;
  const onZoomChange = vi.fn();
  const view = render(
    <div data-sequence-wheel-zoom-scope="">
      <SequencePaneControls
        mode="2d"
        onModeChange={vi.fn()}
        zoom={initialZoom}
        onZoomChange={onZoomChange}
      />
    </div>
  );
  const scope = view.container.firstElementChild!;
  const viewport = document.createElement('div');
  viewport.setAttribute('data-sequence-wheel-zoom-viewport', '');
  scope.append(viewport);
  Object.defineProperties(viewport, {
    clientWidth: { value: CONTAINER_WIDTH },
    clientHeight: { value: CONTAINER_RECT.height },
    scrollHeight: { value: 100_000 },
  });
  viewport.scrollTop = 500;
  vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({
    ...CONTAINER_RECT,
    x: CONTAINER_RECT.left,
    y: CONTAINER_RECT.top,
    width: CONTAINER_WIDTH,
    right: CONTAINER_RECT.left + CONTAINER_WIDTH,
    bottom: CONTAINER_RECT.top + CONTAINER_RECT.height,
    toJSON: () => ({}),
  });
  const commits: number[] = [];
  let committedState = { zoomLevel: initialZoom, topBp: 0, circularOffset: 0 };
  const requestFrame = vi.fn();
  const hook = renderHook(
    ({ zoomLevel, topBp, circularOffset }) => {
      const { config, layout } = buildLayoutAt(zoomLevel, {
        circular: true,
        seqLen: 100_000,
        bpOffset: topBp,
      });
      return useZoomController({
        continuous: true,
        nativeWheelGestureOwnership: true,
        requestFrame,
        zoomLevel,
        topBp,
        circularOffset,
        setZoomState: (next) => {
          commits.push(next.zoomLevel);
          committedState = { ...committedState, ...next };
        },
        seqLength: 100_000,
        isCircular: true,
        baseConfig: BASE,
        containerWidth: CONTAINER_WIDTH,
        containerRef: { current: viewport },
        zoomTargetRef: { current: viewport },
        layout,
        config,
      });
    },
    { initialProps: committedState }
  );
  const received: WheelEvent[] = [];
  const onWheel = (event: WheelEvent) => {
    received.push(event);
    hook.result.current.onWheel(event);
  };
  const disposeTarget = registerWheelZoomTarget(viewport, onWheel);
  viewport.addEventListener('wheel', onWheel);
  const observed = vi.fn();
  window.addEventListener('wheel', observed, { capture: true });
  const target = bar ? view.getByTestId('sequence-pane-zoom-slider') : viewport;
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => target });
  const point = {
    x: CONTAINER_RECT.left + CONTAINER_WIDTH / 2,
    y: CONTAINER_RECT.top + CONTAINER_RECT.height / 2,
  };
  try {
    act(() => {
      if (precise !== null) {
        expect(
          dispatchNativeWheel(document, {
            ...point,
            deltaX: 0,
            deltaY,
            precise,
            phase: precise ? 1 : 0,
            momentumPhase: 0,
            ordinal: 7,
            metaKey: !bar,
          })
        ).toBe(true);
      } else {
        fireEvent.wheel(target, {
          deltaX: 3,
          deltaY,
          deltaMode,
          metaKey: !bar,
          clientX: point.x,
          clientY: point.y,
          cancelable: true,
        });
      }
    });
    expect(received, 'the existing viewer wheel controller owns the input once').toHaveLength(1);
    expect(observed, 'forwarding does not dispatch a duplicate wheel').toHaveBeenCalledOnce();
    expect((observed.mock.calls[0][0] as WheelEvent).defaultPrevented).toBe(true);
    expect(onZoomChange, 'wheel input does not use the slider command path').not.toHaveBeenCalled();
    if (precise === true) {
      expect(commits, 'precision packets coalesce until the display callback').toEqual([]);
    } else {
      expect(commits, 'an idle coarse packet publishes its first pose immediately').toHaveLength(1);
      expect((commits[0] - initialZoom) * Math.sign(-deltaY)).toBeGreaterThan(0);
      expect(hook.result.current.hasPendingCommit()).toBe(true);
      act(() => hook.rerender(committedState));
    }
    expect(requestFrame).toHaveBeenCalledOnce();
    const event = received[0];
    expect(event.deltaY).toBe(deltaY);
    expect(event.deltaMode).toBe(deltaMode);
    expect(event.deltaX).toBe(precise === null ? 3 : 0);
    expect([event.clientX, event.clientY]).toEqual([point.x, point.y]);
    expect(shouldAnimateWheel(event, document)).toBe(precise !== true);
    if (precise !== null)
      expect(getNativeWheelInput(event)).toEqual({
        precise,
        phase: precise ? 1 : 0,
        momentumPhase: 0,
        ordinal: 7,
      });
    for (now = 16; now <= 224; now += 16) {
      act(() => hook.result.current.flushFrame(now));
      if (commits.length) act(() => hook.rerender(committedState));
    }
    expect(hook.result.current.hasPendingCommit()).toBe(false);
    if (precise === true) expect(commits).toHaveLength(1);
    else expect(new Set(commits).size).toBeGreaterThan(3);
    expect(commits.at(-1)).not.toBe(initialZoom);
    expect(viewport.scrollTop).not.toBe(500);
    return { commits, scrollTop: viewport.scrollTop };
  } finally {
    window.removeEventListener('wheel', observed, { capture: true });
    viewport.removeEventListener('wheel', onWheel);
    disposeTarget();
    hook.unmount();
    view.unmount();
  }
}

it.each([
  { precise: true, deltaY: -4 },
  { precise: true, deltaY: 4 },
  { precise: false, deltaY: -40 },
  { precise: false, deltaY: 40 },
])('ordinary zoom-bar wheel matches native Command zoom: %j', ({ precise, deltaY }) => {
  const command = driveZoom(false, deltaY, precise);
  const bar = driveZoom(true, deltaY, precise);
  expect(bar).toEqual(command);
});

it.each([1, 2])('ordinary zoom-bar wheel preserves browser deltaMode %i', (deltaMode) => {
  expect(driveZoom(true, -0.1, null, deltaMode)).toEqual(driveZoom(false, -0.1, null, deltaMode));
});

it.each([false, true])(
  'bar and Command wheel reach the same 120% ceiling (precise=%s)',
  (precise) => {
    const command = driveZoom(false, -40, precise, 0, 110);
    const bar = driveZoom(true, -40, precise, 0, 110);
    expect(bar).toEqual(command);
    expect(bar.commits.at(-1)).toBeCloseTo(120, 10);
  }
);

it('target cleanup preserves its replacement and removes the retired wheel owner', () => {
  const target = document.createElement('div');
  vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 20, 600, 400));
  const oldOwner = vi.fn();
  const currentOwner = vi.fn();
  const disposeOld = registerWheelZoomTarget(target, oldOwner);
  const disposeCurrent = registerWheelZoomTarget(target, currentOwner);
  disposeOld();
  expect(forwardWheelZoom(new WheelEvent('wheel', { deltaY: 1, cancelable: true }), target)).toBe(
    true
  );
  expect(oldOwner).not.toHaveBeenCalled();
  expect(currentOwner).toHaveBeenCalledOnce();
  disposeCurrent();
  expect(target.hasAttribute('data-sequence-wheel-zoom-target')).toBe(false);
  const event = new WheelEvent('wheel', { deltaY: 1, cancelable: true });
  expect(forwardWheelZoom(event, target)).toBe(false);
  expect(event.defaultPrevented).toBe(false);
  expect(currentOwner).toHaveBeenCalledOnce();
});
