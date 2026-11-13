/** @vitest-environment jsdom */
import { act, renderHook } from '@testing-library/react';
import { installNativeWheelSource } from '../../../platform/src/wheel-input.test-helper';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computeNextZoomFromDelta,
  useZoomController,
  captureZoomAnchorRowPlacement,
  zoomAnchorContentY,
} from '../use-zoom-controller';
import { offsetLayoutViewport } from '../linear-scroll-headroom';
import {
  BASE,
  buildLayoutAt,
  CONTAINER_RECT,
  CONTAINER_WIDTH,
  mockContainer,
} from '../testing/zoom-fixtures';
import { computeLineTrackPositions } from '../line-track-layout';
import { computeSequenceLayoutImpl } from '../useSequenceLayout';

describe('live zoom owns height-only commits between input packets', () => {
  let callbacks: Map<number, FrameRequestCallback>;
  let id: number;
  let disposeNativeSource: () => void;
  beforeEach(() => {
    disposeNativeSource = installNativeWheelSource(document);
    callbacks = new Map();
    id = 0;
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callbacks.set(++id, callback);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (key: number) => callbacks.delete(key));
  });
  afterEach(() => {
    disposeNativeSource();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  function frame() {
    const pending = [...callbacks.values()];
    callbacks.clear();
    act(() => pending.forEach((callback) => callback(performance.now())));
  }
  it('requests layout headroom instead of clipping a first-row anchor to scrollTop zero', () => {
    const initial = buildLayoutAt(100, { circular: false, seqLen: 20000 });
    initial.seq.annotations = [];
    initial.layout = computeSequenceLayoutImpl(initial.seq, initial.config);
    const row = initial.layout.lines[0];
    const y =
      computeLineTrackPositions(row, initial.config).sequenceY + initial.config.rowHeight / 2;
    const container = Object.assign(mockContainer(0), { ownerDocument: document });
    const commits: Array<{ zoomLevel: number; topBp: number }> = [];
    const offsets: number[] = [];
    const harness = renderHook(
      (owner: { zoomLevel: number; topBp: number; built: typeof initial }) =>
        useZoomController({
          zoomLevel: owner.zoomLevel,
          topBp: owner.topBp,
          circularOffset: 0,
          seqLength: 20000,
          isCircular: false,
          continuous: true,
          baseConfig: BASE,
          containerWidth: CONTAINER_WIDTH,
          containerRef: { current: container },
          zoomTargetRef: { current: document.createElement('div') },
          config: owner.built.config,
          layout: owner.built.layout,
          setZoomState: (next) => commits.push(next),
          onScrollBoundaryOffset: (offset: number) => offsets.push(offset),
        }),
      { initialProps: { zoomLevel: 100, topBp: 0, built: initial } }
    );
    act(() =>
      harness.result.current.onWheel(
        new WheelEvent('wheel', {
          deltaY: 180,
          ctrlKey: true,
          clientX: CONTAINER_RECT.left + BASE.marginLeft + 10 * BASE.baseCharWidth,
          clientY: CONTAINER_RECT.top + y,
          cancelable: true,
        })
      )
    );
    frame();
    const next = commits[0];
    const built = buildLayoutAt(next.zoomLevel, { circular: false, seqLen: 20000 });
    built.seq.annotations = [];
    const config = { ...built.config, linearWrapPhase: true };
    built.config = config;
    built.layout = computeSequenceLayoutImpl(built.seq, config, 0, 0, [], false, [], next.topBp);
    act(() => harness.rerender({ ...next, built }));
    expect(offsets.length).toBeGreaterThan(0);
    expect(offsets[0]).toBeGreaterThan(0);
    expect(container.scrollTop).toBe(0);
    const placement = captureZoomAnchorRowPlacement(10, y, initial.layout, initial.config);
    built.layout = offsetLayoutViewport(built.layout, offsets[0]);
    act(() => harness.rerender({ ...next, built: { ...built } }));
    expect(zoomAnchorContentY(10, placement, built.layout, config)).toBeCloseTo(y);
    expect(offsets.length).toBe(1);
    expect(container.scrollTop).toBe(0);
    harness.unmount();
  });
  it('extends a rounded bottom scroll boundary before restoring the exact nucleotide point', () => {
    const initial = buildLayoutAt(100, { circular: false, seqLen: 20000 });
    const row = initial.layout.lines[initial.layout.lines.length - 1];
    const bp = row.startPos + 1;
    const y =
      computeLineTrackPositions(row, initial.config).sequenceY + initial.config.rowHeight / 2;
    const container = Object.assign(mockContainer(y - 80), {
      ownerDocument: document,
      scrollHeight: initial.layout.totalHeight + 400,
      clientHeight: 400,
    });
    const commits: Array<{ zoomLevel: number; topBp: number }> = [];
    const requested: Array<{ space: number; edge: string | undefined }> = [];
    const harness = renderHook(
      (owner: { zoomLevel: number; topBp: number; built: typeof initial; headroom: number }) =>
        useZoomController({
          zoomLevel: owner.zoomLevel,
          topBp: owner.topBp,
          circularOffset: 0,
          seqLength: 20000,
          isCircular: false,
          continuous: true,
          baseConfig: BASE,
          containerWidth: CONTAINER_WIDTH,
          containerRef: { current: container },
          zoomTargetRef: { current: document.createElement('div') },
          config: owner.built.config,
          layout: owner.built.layout,
          setZoomState: (next) => commits.push(next),
          scrollEndHeadroom: owner.headroom,
          onScrollBoundaryOffset: (space, edge) => requested.push({ space, edge }),
        }),
      { initialProps: { zoomLevel: 100, topBp: 0, built: initial, headroom: 0 } }
    );
    const placement = captureZoomAnchorRowPlacement(bp, y, initial.layout, initial.config);
    act(() =>
      harness.result.current.onWheel(
        new WheelEvent('wheel', {
          deltaY: 0.5,
          ctrlKey: true,
          clientX: CONTAINER_RECT.left + BASE.marginLeft + 1.2 * BASE.baseCharWidth,
          clientY: CONTAINER_RECT.top + 80,
          cancelable: true,
        })
      )
    );
    frame();
    const next = commits[0];
    const built = buildLayoutAt(next.zoomLevel, { circular: false, seqLen: 20000 });
    built.config = { ...built.config, linearWrapPhase: true };
    built.layout = computeSequenceLayoutImpl(
      built.seq,
      built.config,
      0,
      0,
      [],
      false,
      [],
      next.topBp
    );
    const desiredScroll = zoomAnchorContentY(bp, placement, built.layout, built.config)! - 80;
    container.scrollHeight = desiredScroll + container.clientHeight - 1.75;
    const before = container.scrollTop;
    act(() => harness.rerender({ ...next, built, headroom: 0 }));
    expect(requested).toEqual([{ space: 3, edge: 'end' }]);
    expect(container.scrollTop).toBe(before);
    container.scrollHeight += requested[0].space;
    act(() => harness.rerender({ ...next, built, headroom: requested[0].space }));
    expect(container.scrollTop).toBeCloseTo(desiredScroll, 8);
    expect(requested).toHaveLength(1);
    harness.unmount();
  });
  it('commits each large precision packet immediately without queued intermediate zoom targets', () => {
    const initial = buildLayoutAt(100, { circular: true, seqLen: 20000, virtualRowCount: 20 });
    const row = initial.layout.lines[24];
    const container = Object.assign(
      mockContainer(
        computeLineTrackPositions(row, initial.config).sequenceY +
          initial.config.rowHeight / 2 -
          320
      ),
      { ownerDocument: document }
    );
    const commits: Array<{ zoomLevel: number; topBp: number }> = [];
    const harness = renderHook(
      (owner: { zoomLevel: number; topBp: number; built: typeof initial }) =>
        useZoomController({
          zoomLevel: owner.zoomLevel,
          topBp: owner.topBp,
          circularOffset: 0,
          seqLength: 20000,
          isCircular: true,
          continuous: true,
          zoomSensitivityPxPerPoint: 10,
          baseConfig: BASE,
          containerWidth: CONTAINER_WIDTH,
          containerRef: { current: container },
          zoomTargetRef: { current: document.createElement('div') },
          config: owner.built.config,
          layout: owner.built.layout,
          setZoomState: (next) => commits.push(next),
        }),
      { initialProps: { zoomLevel: 100, topBp: 0, built: initial } }
    );
    const wheel = (deltaY: number) =>
      act(() =>
        harness.result.current.onWheel(
          new WheelEvent('wheel', {
            deltaY,
            ctrlKey: true,
            clientX: CONTAINER_RECT.left + 431,
            clientY: CONTAINER_RECT.top + 320,
            cancelable: true,
          })
        )
      );
    const applyFrame = () => {
      frame();
      const next = commits[commits.length - 1];
      if (next)
        act(() =>
          harness.rerender({
            ...next,
            built: buildLayoutAt(next.zoomLevel, {
              circular: true,
              seqLen: 20000,
              virtualRowCount: 20,
              bpOffset: next.topBp,
            }),
          })
        );
    };
    wheel(180);
    applyFrame();
    expect(commits[0].zoomLevel, 'the first frame accepts the entire packet').toBe(
      computeNextZoomFromDelta(100, 180, 10, 25, 100, Infinity)
    );
    expect(commits).toHaveLength(1);
    for (let i = 0; i < 20; i++) applyFrame();
    expect(commits[commits.length - 1].zoomLevel).toBe(
      computeNextZoomFromDelta(100, 180, 10, 25, 100, Infinity)
    );
    expect(commits, 'quiet frames cannot advance an old zoom target').toHaveLength(1);
    wheel(-180);
    for (let i = 0; i < 20; i++) applyFrame();
    expect(Math.abs(commits[commits.length - 1].zoomLevel - 100)).toBeLessThanOrEqual(
      100 * Number.EPSILON
    );
    expect(commits).toHaveLength(2);
    harness.unmount();
  });
  it('keeps the committed screen point after two quiet frames, until navigation takes ownership', () => {
    const initial = buildLayoutAt(100, { circular: true, seqLen: 20000, virtualRowCount: 20 });
    const row = initial.layout.lines[24];
    const contentY =
      computeLineTrackPositions(row, initial.config).sequenceY + initial.config.rowHeight / 2;
    const container = Object.assign(mockContainer(contentY - 320), { ownerDocument: document });
    const states: boolean[] = [];
    const commits: Array<{ zoomLevel: number; topBp: number }> = [];
    const harness = renderHook(
      (owner: { zoomLevel: number; topBp: number; built: typeof initial }) =>
        useZoomController({
          zoomLevel: owner.zoomLevel,
          topBp: owner.topBp,
          circularOffset: 0,
          seqLength: 20000,
          isCircular: true,
          continuous: true,
          baseConfig: BASE,
          containerWidth: CONTAINER_WIDTH,
          containerRef: { current: container },
          zoomTargetRef: { current: document.createElement('div') },
          config: owner.built.config,
          layout: owner.built.layout,
          setZoomState: (next) => commits.push(next),
          onGestureStateChange: (active) => states.push(active),
        }),
      { initialProps: { zoomLevel: 100, topBp: 0, built: initial } }
    );
    act(() =>
      harness.result.current.onWheel(
        new WheelEvent('wheel', {
          deltaY: 0.5,
          ctrlKey: true,
          clientX: CONTAINER_RECT.left + 431,
          clientY: CONTAINER_RECT.top + 320,
          cancelable: true,
        })
      )
    );
    frame();
    expect(commits).toHaveLength(1);
    const next = commits[0];
    const built = buildLayoutAt(next.zoomLevel, {
      circular: true,
      seqLen: 20000,
      virtualRowCount: 20,
      bpOffset: next.topBp,
    });
    act(() => harness.rerender({ ...next, built }));
    frame();
    frame();
    expect(states).toEqual([true]);
    const before = container.scrollTop;
    const moveLayout = (delta: number) => ({
      ...built,
      layout: {
        ...built.layout,
        totalHeight: built.layout.totalHeight + delta,
        lines: built.layout.lines.map((row) => ({ ...row, y: row.y + delta })),
        summary: {
          ...built.layout.summary!,
          rowYOffsets: Float64Array.from(built.layout.summary!.rowYOffsets, (y) => y + delta),
        },
      },
    });
    act(() => harness.rerender({ ...next, built: moveLayout(41) }));
    expect(
      container.scrollTop,
      'lane morphs retain the same screen point between wheel packets'
    ).toBeCloseTo(before + 41, 8);
    act(() => harness.result.current.cancelGesture());
    container.scrollTop += 500;
    const navigated = container.scrollTop;
    act(() => harness.rerender({ ...next, built: moveLayout(82) }));
    expect(container.scrollTop, 'a cancelled zoom cannot reclaim a navigated viewport').toBe(
      navigated
    );
    harness.unmount();
  });
  it('ends input ownership while presentation-only layouts keep arriving', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const initial = buildLayoutAt(100, { circular: true, seqLen: 20000, virtualRowCount: 20 });
    const row = initial.layout.lines[24];
    const container = Object.assign(
      mockContainer(
        computeLineTrackPositions(row, initial.config).sequenceY +
          initial.config.rowHeight / 2 -
          320
      ),
      { ownerDocument: document }
    );
    const commits: Array<{ zoomLevel: number; topBp: number }> = [];
    const states: boolean[] = [];
    const harness = renderHook(
      (owner: { zoomLevel: number; topBp: number; built: typeof initial }) =>
        useZoomController({
          zoomLevel: owner.zoomLevel,
          topBp: owner.topBp,
          circularOffset: 0,
          seqLength: 20000,
          isCircular: true,
          continuous: true,
          requestFrame: () => {},
          baseConfig: BASE,
          containerWidth: CONTAINER_WIDTH,
          containerRef: { current: container },
          zoomTargetRef: { current: document.createElement('div') },
          config: owner.built.config,
          layout: owner.built.layout,
          setZoomState: (next) => commits.push(next),
          onGestureStateChange: (active) => states.push(active),
        }),
      { initialProps: { zoomLevel: 100, topBp: 0, built: initial } }
    );
    act(() => {
      harness.result.current.onWheel(
        new WheelEvent('wheel', {
          deltaY: 5,
          ctrlKey: true,
          clientX: CONTAINER_RECT.left + 431,
          clientY: CONTAINER_RECT.top + 320,
          cancelable: true,
        })
      );
      harness.result.current.flushFrame(now);
    });
    const next = commits[0];
    const built = buildLayoutAt(next.zoomLevel, {
      circular: true,
      seqLen: 20000,
      virtualRowCount: 20,
      bpOffset: next.topBp,
    });
    for (let pose = 0; pose < 25; pose++) {
      act(() => harness.rerender({ ...next, built: { ...built, layout: { ...built.layout } } }));
      frame();
      now += 16;
      act(() => vi.advanceTimersByTime(16));
    }
    expect(states).toEqual([true, false]);
    expect(harness.result.current.isZooming()).toBe(false);
    expect(harness.result.current.hasPendingCommit()).toBe(false);
    expect(commits).toHaveLength(1);
    harness.unmount();
  });
});
