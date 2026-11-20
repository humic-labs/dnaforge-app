import type { ComponentProps } from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { WebGLMapHandle } from '@waypoint/plasmid-viewer';
import { getNativeWheelInput } from '@waypoint/platform/wheel-motion';
import {
  dispatchNativeWheel,
  installNativeWheelSource,
} from '../../../../../../packages/core/platform/src/wheel-input.test-helper';
import { setupInteraction } from '../../../../../../packages/core/genome-renderer/src/renderers/pixi/interaction';
import type { RenderState } from '../../../../../../packages/core/genome-renderer/src/types';
import { WorkspaceViewerMapPane } from './WorkspaceViewerMapPane';
import { useWebglCameraZoomState } from './useWebglCameraZoomState';
import { formatWebglMapZoom, webglMapZoomToSliderValue } from './SequenceMapPaneControls';

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

function createMapPane(liveFeedback = false) {
  let cameraFrame: ((zoom: number) => void) | undefined;
  let commitCameraZoom: ((zoom: number) => void) | undefined;
  let hostRenderCount = 0;
  let scopeKey = 'map-a';
  const props: ComponentProps<typeof WorkspaceViewerMapPane> = {
    showResizeHandle: false,
    showSideResizeHandle: false,
    onVerticalResizeStart: vi.fn(),
    onSideResizeStart: vi.fn(),
    minimapContainerRef: { current: null },
    minimapContainerStyle: {},
    minimapType: 'webgl',
    circular: false,
    effectiveMapShape: 'linear',
    webglMapGeometry: { renderHeight: 300, geometryHeight: 300, morphToCircle: 0 },
    hideMinimap: false,
    mountWebglMap: true,
    actualWebGLMapVisible: true,
    mapCameraZoomVisible: true,
    mapShapeControlMode: 'shape',
    minMinimapGeometry: 100,
    maxMinimap: 600,
    minimapGeometryHeight: 300,
    mapRenderMorphToCircle: 0,
    webglCameraZoom: 4,
    webglCameraZoomBounds: { min: 0.5, max: 5000 },
    isWebglSyncLocked: false,
    lastViewportCenterRef: { current: null },
    minimapRef: { current: null },
    patchSeqView: vi.fn(),
    onMapShapeChange: vi.fn(),
    onMorphToCircleChange: vi.fn(),
    onGeometryHeightChange: vi.fn(),
    onMapZoomChange: vi.fn((zoom: number) => commitCameraZoom?.(zoom)),
    webglMap: <canvas data-testid="map-canvas" />,
  };
  function FeedbackPane({ visible }: { visible: boolean }) {
    const camera = useWebglCameraZoomState({
      minimapRef: props.minimapRef,
      persistedZoom: 4,
      viewportScopeKey: scopeKey,
    });
    hostRenderCount++;
    cameraFrame = camera.scheduleWebglCameraZoomStateSync;
    commitCameraZoom = camera.commitWebglCameraZoomState;
    return (
      <WorkspaceViewerMapPane
        {...props}
        mapCameraZoomVisible={visible}
        webglCameraZoom={camera.webglCameraZoom}
        webglCameraZoomBounds={camera.webglCameraZoomBounds}
        webglCameraZoomSource={camera.webglCameraZoomSource}
      />
    );
  }
  const pane = (visible = true) => (
    <>
      <div data-sequence-wheel-zoom-scope="">
        <canvas data-testid="left-canvas" />
      </div>
      {liveFeedback ? (
        <FeedbackPane visible={visible} />
      ) : (
        <WorkspaceViewerMapPane {...props} mapCameraZoomVisible={visible} />
      )}
    </>
  );
  const view = render(pane());
  const canvas = view.getByTestId('map-canvas') as HTMLCanvasElement;
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(400, 100, 800, 300));
  Object.defineProperty(canvas, 'clientHeight', { value: 300 });
  const state: RenderState = {
    morph: 0,
    zoom: 4,
    viewOffset: 0.5,
    width: 800,
    height: 300,
    selectedIds: new Set(),
    hoveredId: null,
    highlightRange: null,
    cursorPosition: null,
    hoveredCutSiteId: null,
    perfPanelVisible: false,
  };
  const leftState: RenderState = { ...state, selectedIds: new Set() };
  const left = setupInteraction(view.getByTestId('left-canvas') as HTMLCanvasElement, leftState);
  const interaction = setupInteraction(canvas, state);
  interaction.genomeLength = 1000;
  interaction.genomeCircular = false;
  const anchors = vi.fn();
  interaction.onBeforeZoom = anchors;
  const poses: number[] = [];
  interaction.onCameraChange = (reason) => {
    expect(reason).toBe('zoom');
    poses.push(state.zoom);
    cameraFrame?.(state.zoom);
  };
  return {
    props,
    view,
    canvas,
    state,
    leftState,
    interaction,
    anchors,
    poses,
    hostRenderCount: () => hostRenderCount,
    cameraFrame: () => cameraFrame!,
    commitCameraZoom: (zoom: number) => commitCameraZoom?.(zoom),
    replaceScope: (nextScopeKey: string) => {
      scopeKey = nextScopeKey;
      view.rerender(pane());
    },
    show: (visible: boolean) => view.rerender(pane(visible)),
    flush: () => {
      interaction.flushInteraction();
      left.flushInteraction();
    },
    cleanup: () => {
      interaction.cleanup();
      left.cleanup();
      view.unmount();
    },
  };
}

function driveMapZoom(bar: boolean, deltaY: number, precise: boolean | null, deltaMode = 0) {
  now = 0;
  const map = createMapPane();
  const target = bar ? map.view.getByTestId('map-pane-zoom-slider') : map.canvas;
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => target });
  const observed = vi.fn();
  window.addEventListener('wheel', observed, { capture: true });
  try {
    if (precise !== null) {
      expect(
        dispatchNativeWheel(document, {
          x: bar ? 1190 : 800,
          y: bar ? 380 : 250,
          deltaX: 0,
          deltaY,
          precise,
          phase: precise ? 1 : 0,
          momentumPhase: 0,
          ordinal: 9,
          metaKey: !bar,
        }),
        'the map zoom bar belongs to the native wheel input region'
      ).toBe(true);
    } else {
      fireEvent.wheel(target, {
        deltaX: 0.02,
        deltaY,
        deltaMode,
        metaKey: !bar,
        clientX: bar ? 1190 : 800,
        clientY: bar ? 380 : 250,
        cancelable: true,
      });
    }
    expect(observed, 'forwarding does not dispatch a duplicate wheel').toHaveBeenCalledOnce();
    const event = observed.mock.calls[0][0] as WheelEvent;
    expect(event.defaultPrevented, 'the bar must not scroll an ancestor').toBe(true);
    expect(event.metaKey || event.ctrlKey).toBe(!bar);
    expect(event.deltaY).toBe(deltaY);
    expect(event.deltaMode).toBe(deltaMode);
    if (precise !== null)
      expect(getNativeWheelInput(event)).toEqual({
        precise,
        phase: precise ? 1 : 0,
        momentumPhase: 0,
        ordinal: 9,
      });
    expect(
      map.props.onMapZoomChange,
      'wheel input uses the camera wheel owner'
    ).not.toHaveBeenCalled();
    expect(map.state.zoom, 'input waits for the existing camera frame').toBe(4);
    for (now = 16; now <= 224; now += 16) map.flush();
    const normalized = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? 300 : 1);
    const logStep = Math.max(-Math.log(1.3), Math.min(Math.log(1.3), -normalized * 0.008));
    expect(map.state.zoom).toBeCloseTo(4 * Math.exp(logStep), 10);
    if (precise === true) expect(map.poses).toHaveLength(1);
    else expect(new Set(map.poses).size).toBeGreaterThan(3);
    for (const call of map.anchors.mock.calls) expect(call.slice(2)).toEqual([800, 250]);
    expect(map.state.viewOffset, 'the bar never enters the ordinary pan path').toBe(0.5);
    expect(map.leftState.zoom, 'the adjacent sequence pane is not the map wheel owner').toBe(4);
    expect(map.leftState.viewOffset).toBe(0.5);
    return { poses: map.poses, anchors: map.anchors.mock.calls };
  } finally {
    window.removeEventListener('wheel', observed, { capture: true });
    map.cleanup();
  }
}

it.each([
  { precise: true, deltaY: -4 },
  { precise: true, deltaY: 4 },
  { precise: false, deltaY: -40 },
  { precise: false, deltaY: 40 },
])('ordinary map zoom-bar wheel matches native Command zoom: %j', ({ precise, deltaY }) => {
  expect(driveMapZoom(true, deltaY, precise)).toEqual(driveMapZoom(false, deltaY, precise));
});

it.each([false, true])(
  'map thumb follows every %s precision camera frame before settling',
  (precise) => {
    const map = createMapPane(true);
    const slider = map.view.getByTestId('map-pane-zoom-slider');
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => slider,
    });
    const thumb = () =>
      Number(
        map.view
          .getByTestId('map-pane-zoom-slider')
          .style.getPropertyValue('--map-pane-zoom-slider-value')
      );
    const expectDisplayedZoom = (zoom: number) => {
      expect(thumb()).toBeCloseTo(
        webglMapZoomToSliderValue(zoom, map.props.webglCameraZoomBounds),
        12
      );
      expect(map.view.getByTestId('map-pane-zoom-display').textContent).toBe(
        formatWebglMapZoom(zoom, map.props.webglCameraZoomBounds)
      );
    };
    try {
      const initialThumb = thumb();
      const initialHostRenders = map.hostRenderCount();
      dispatchNativeWheel(document, {
        x: 1190,
        y: 380,
        deltaX: 0,
        deltaY: precise ? -4 : -40,
        precise,
        phase: precise ? 1 : 0,
        momentumPhase: 0,
        ordinal: 11,
      });
      for (now = 16; now <= 64; now += 16) {
        act(() => map.flush());
        expectDisplayedZoom(map.state.zoom);
      }
      expect(thumb()).toBeGreaterThan(initialThumb);
      expect(map.hostRenderCount(), 'camera frames update only the bar subtree').toBe(
        initialHostRenders
      );
      const currentThumb = thumb();
      map.show(true);
      expect(thumb(), 'the delayed parent zoom prop cannot overwrite the live pose').toBe(
        currentThumb
      );
      fireEvent.click(map.view.getByTestId('map-pane-zoom-display'));
      expectDisplayedZoom(1);
      act(() => map.commitCameraZoom(3));
      expectDisplayedZoom(3);
      map.show(false);
      act(() => map.commitCameraZoom(2));
      expect(map.view.queryByTestId('map-pane-zoom-slider')).toBeNull();
      map.show(true);
      const restored = map.view.getByTestId('map-pane-zoom-slider');
      expect(Number(restored.style.getPropertyValue('--map-pane-zoom-slider-value'))).toBeCloseTo(
        webglMapZoomToSliderValue(2, map.props.webglCameraZoomBounds),
        12
      );
      const retiredCameraFrame = map.cameraFrame();
      map.replaceScope('map-b');
      expectDisplayedZoom(4);
      act(() => retiredCameraFrame(99));
      expectDisplayedZoom(4);
      act(() => map.cameraFrame()(2.5));
      expectDisplayedZoom(2.5);
    } finally {
      map.cleanup();
    }
  }
);

it.each([
  { min: 0.5, max: 10 },
  { min: 0.5, max: 100 },
])('map thumb follows changed layout bounds with an unchanged camera zoom: %j', (nextBounds) => {
  const map = createMapPane(true);
  let bounds = { min: 0.5, max: 20 };
  map.props.minimapRef.current = {
    getCameraZoomBounds: () => bounds,
  } as WebGLMapHandle;
  const thumb = () =>
    Number(
      map.view
        .getByTestId('map-pane-zoom-slider')
        .style.getPropertyValue('--map-pane-zoom-slider-value')
    );
  try {
    act(() => {
      map.state.zoom = 8;
      map.commitCameraZoom(map.state.zoom);
    });
    expect(thumb()).toBeCloseTo(webglMapZoomToSliderValue(map.state.zoom, bounds), 12);
    bounds = nextBounds;
    act(() => map.interaction.onCameraChange?.('zoom'));
    expect(map.state.zoom).toBe(8);
    expect(thumb()).toBeCloseTo(webglMapZoomToSliderValue(map.state.zoom, bounds), 12);
    expect(map.view.getByTestId('map-pane-zoom-display').textContent).toBe(
      formatWebglMapZoom(map.state.zoom, bounds)
    );
  } finally {
    map.cleanup();
  }
});

it.each([1, 2])('ordinary map zoom-bar wheel preserves browser deltaMode %i', (deltaMode) => {
  expect(driveMapZoom(true, -0.1, null, deltaMode)).toEqual(
    driveMapZoom(false, -0.1, null, deltaMode)
  );
});

it('removing and restoring the map bar retires its listener and restores camera routing', () => {
  const map = createMapPane();
  try {
    const retired = map.view.getByTestId('map-pane-zoom-slider');
    map.show(false);
    fireEvent.wheel(retired, { deltaY: -4, cancelable: true });
    now = 16;
    map.flush();
    expect(map.state.zoom).toBe(4);
    map.show(true);
    fireEvent.wheel(map.view.getByTestId('map-pane-zoom-slider'), {
      deltaY: -4,
      cancelable: true,
    });
    now = 32;
    map.flush();
    expect(map.state.zoom).toBeCloseTo(4 * Math.exp(0.032), 10);
    expect(map.poses).toHaveLength(1);
    expect(map.props.onMapZoomChange).not.toHaveBeenCalled();
  } finally {
    map.cleanup();
  }
});
