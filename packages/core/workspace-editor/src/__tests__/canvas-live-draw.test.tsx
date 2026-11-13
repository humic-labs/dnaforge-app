// @vitest-environment jsdom

import { useLayoutEffect } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useCanvasWorkerDraw } from '../hooks/useCanvasWorkerDraw';
import { DEFAULT_EDITOR_CONFIG } from '../types';
import {
  installRecordingCanvas,
  uninstallRecordingCanvas,
} from '../testing/recording-canvas-context';
import { renderSequence } from '../canvas-renderer';
import { computeSequenceLayoutImpl } from '../useSequenceLayout';
import { calculateLinePositions } from '../line-positions';
import type { MainToWorkerMessage, WorkerRenderMessage } from '../canvas-worker-protocol';

const presentation = vi.hoisted(() => ({ capture: vi.fn(), present: vi.fn() }));
const worker = vi.hoisted(() => ({
  current: null as { onmessage: ((event: MessageEvent) => void) | null } | null,
  posts: [] as MainToWorkerMessage[],
}));
vi.mock('../canvas-render-worker?worker&inline', () => ({
  default: class RecordedWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    terminate = vi.fn();
    constructor() {
      worker.current = this;
    }
    postMessage(message: MainToWorkerMessage) {
      worker.posts.push(
        'viewportLinePositions' in message && message.viewportLinePositions
          ? {
              ...message,
              viewportLinePositions: message.viewportLinePositions.map((position) => ({
                ...position,
              })),
            }
          : message
      );
    }
  },
}));

vi.mock('../canvas-renderer', () => ({
  renderSequence: vi.fn(() => ({
    renderedPrimers: [],
    renderedGGLabels: [],
    renderedCutSites: [],
    renderedCdsExtensionArrows: [],
    lineCodonUpdates: new Map(),
  })),
}));
vi.mock('../rendering/webgl-drawing-context', () => {
  const contexts = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>();
  return {
    getSequenceWebGLContext: (canvas: HTMLCanvasElement) => {
      let context = contexts.get(canvas);
      if (!context) {
        context = Object.assign(canvas.getContext('2d')!, {
          beginFrame: () => true,
          endFrame: () => undefined,
          setPresentationShiftBounds: () => undefined,
          capturePresentationScene: presentation.capture,
          presentRows: presentation.present,
        });
        contexts.set(canvas, context);
      }
      return context;
    },
  };
});

let nextFrameId: number;
let frames: Map<number, FrameRequestCallback>;
beforeEach(() => {
  worker.current = null;
  worker.posts.length = 0;
  installRecordingCanvas();
  vi.mocked(renderSequence).mockClear();
  let retained = false;
  presentation.capture.mockReset().mockImplementation(() => {
    retained = true;
  });
  presentation.present.mockReset().mockImplementation(() => retained);
  nextFrameId = 0;
  frames = new Map();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++nextFrameId;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  uninstallRecordingCanvas();
  vi.unstubAllGlobals();
});
async function paintFrame() {
  const ready = [...frames];
  for (const [id, callback] of ready) {
    if (frames.delete(id)) act(() => callback(performance.now()));
    await Promise.resolve();
  }
}
function setup() {
  const ref = <T,>(current: T) => ({ current });
  const canvas = document.createElement('canvas'),
    overlay = document.createElement('canvas');
  document.body.append(canvas, overlay);
  const params: Parameters<typeof useCanvasWorkerDraw>[0] = {
    canvasRef: ref(canvas),
    selectionCanvasRef: ref(overlay),
    remountTransferredCanvas: vi.fn(),
    viewportRef: ref({ scrollTop: 0, height: 100 }),
    drawFnRef: ref(null),
    drawRafRef: ref(null),
    canvasDimensionsRef: ref({ width: 0, height: 0 }),
    canvasRectRef: ref(null),
    drawSelectionAndCursorRef: ref(vi.fn()),
    hoverCursorRef: ref(null),
    isSelectingRef: ref(false),
    liveSelectionRef: ref(null),
    selectionRef: ref(null),
    cursorRef: ref(undefined),
    cursorVisibleRef: ref(false),
    insertedRangesRef: ref([]),
    deletedRangesRef: ref([]),
    highlightedRangeRef: ref(null),
    renderedPrimersRef: ref([]),
    renderedGGLabelsRef: ref([]),
    renderedCutSitesRef: ref([]),
    renderedCdsExtensionArrowsRef: ref([]),
    lineCodonsCacheRef: ref(new Map()),
    mutationCacheRef: ref({ mutations: [], map: new Map() }),
    alignmentCodonsCacheRef: ref({ alignedRef: '', alignedQuery: '', codonsMap: new Map() }),
    layout: { lines: [], totalWidth: 400, totalHeight: 600 },
    config: DEFAULT_EDITOR_CONFIG,
    precomputedLinePositions: [],
    fullSequence: 'N'.repeat(100),
    sequenceLength: 100,
    cutSites: [],
    scannedCutSites: [],
    primers: [],
    mutations: [],
    insertedRanges: [],
    deletedRanges: [],
    showCutSites: false,
    hoveredCodon: null,
    viewCursorRef: ref(null),
    hoveredCutSite: null,
    hoveredGGProductLabel: null,
    hoveredEnzymeName: null,
    isDark: false,
    scrollDrawRef: ref(null),
  };
  return params;
}
it('paints every live zoom commit before presentation, with the latest geometry', async () => {
  const params = setup();
  let zoom = 1;
  const commitNextZoom = () => {
    rerender(++zoom);
    if (zoom < 6) requestAnimationFrame(commitNextZoom);
  };

  requestAnimationFrame(commitNextZoom);
  const hook = renderHook(
    (width: number) =>
      useCanvasWorkerDraw({
        ...params,
        config: { ...DEFAULT_EDITOR_CONFIG, charWidth: width },
        layout: { ...params.layout, totalHeight: 600 + width },
      }),
    { initialProps: zoom }
  );
  const rerender = hook.rerender;
  for (let count = 0; count < 5; count++) {
    await paintFrame();
    expect(renderSequence, 'zoom must paint while input is still arriving').toHaveBeenCalledTimes(
      count + 1
    );
    expect(vi.mocked(renderSequence).mock.lastCall?.[1].config.charWidth).toBe(zoom);
  }
  hook.unmount();
  await paintFrame();
  expect(renderSequence).toHaveBeenCalledTimes(5);
  expect(params.drawFnRef.current).toBeNull();
});
it('a queued paint draws the latest layout and viewport after multiple input updates', async () => {
  const params = setup();
  const hook = renderHook(
    (width: number) =>
      useCanvasWorkerDraw({
        ...params,
        config: { ...DEFAULT_EDITOR_CONFIG, charWidth: width },
      }),
    { initialProps: 8 }
  );
  hook.rerender(7);
  hook.rerender(6);
  params.viewportRef.current.scrollTop = 125;
  await paintFrame();
  expect(renderSequence).toHaveBeenCalledTimes(1);
  const painted = vi.mocked(renderSequence).mock.lastCall?.[1];
  expect(painted?.config.charWidth).toBe(6);
  expect(painted?.viewport?.scrollTop).toBe(125);
});
it('paints a restored boundary anchor when only the blank end space changes', async () => {
  const params = setup();
  const hook = renderHook(
    (scrollEndHeadroom: number) => useCanvasWorkerDraw({ ...params, scrollEndHeadroom }),
    { initialProps: 0 }
  );
  await paintFrame();
  vi.mocked(renderSequence).mockClear();
  hook.rerender(72);

  params.viewportRef.current.scrollTop = 72;
  await Promise.resolve();
  expect(renderSequence).toHaveBeenCalledTimes(1);
  expect(vi.mocked(renderSequence).mock.lastCall?.[1].viewport?.scrollTop).toBe(72);
});

it('starts a tiny row movement after a stationary paint, then reuses its retained GPU scene', async () => {
  const params = setup();
  const config = { ...DEFAULT_EDITOR_CONFIG, charsPerLine: 50 };
  const scene = computeSequenceLayoutImpl(
    {
      id: 'stationary',
      name: 'stationary',
      sequence: 'ACGT'.repeat(100),
      length: 400,
      circular: false,
      annotations: [],
    },
    config,
    0,
    0
  );
  const positions = scene.lines.map((line) => calculateLinePositions(line, config, [], 400));
  const onPresented = vi.fn();
  const hook = renderHook(
    (offset: number) =>
      useCanvasWorkerDraw({
        ...params,
        config,
        layout: scene,
        precomputedLinePositions: positions,
        presentedLayout:
          offset === 0
            ? scene
            : {
                ...scene,
                lines: scene.lines.map((row, i) => (i === 0 ? { ...row, xOffset: offset } : row)),
              },
        onPaintLayoutPresented: onPresented,
      }),
    { initialProps: 0 }
  );
  await paintFrame();
  expect(renderSequence).toHaveBeenCalledTimes(1);
  expect(presentation.capture).not.toHaveBeenCalled();
  onPresented.mockClear();

  hook.rerender(0.3);
  await Promise.resolve();
  expect(renderSequence).toHaveBeenCalledTimes(2);
  expect(presentation.capture).toHaveBeenCalledTimes(1);
  expect(onPresented.mock.lastCall?.[1].lines[0].xOffset).toBe(0.3);

  hook.rerender(0.6);
  await Promise.resolve();
  expect(renderSequence).toHaveBeenCalledTimes(2);
  expect(onPresented.mock.lastCall?.[1].lines[0].xOffset).toBe(0.6);
});

it('reprojects screen-centered CDS labels during every offset-only release frame', async () => {
  const params = setup();
  const sequence = 'ACGT'.repeat(100);
  const config = {
    ...DEFAULT_EDITOR_CONFIG,
    charsPerLine: 50,
    linearWrapPhase: true,
    cdsDetailProgress: 1,
    showTranslation: true,
  };
  const scene = computeSequenceLayoutImpl(
    {
      id: 'cds-release',
      name: 'cds-release',
      sequence,
      length: sequence.length,
      circular: false,
      annotations: [{ name: 'wrapped', type: 'CDS', start: 1, end: 300, direction: 1 }],
    },
    config,
    0,
    0
  );
  const positions = scene.lines.map((line) =>
    calculateLinePositions(line, config, [], sequence.length)
  );
  expect(scene.lines[0].classifiedCDSs).not.toHaveLength(0);
  const onPresented = vi.fn();
  const hook = renderHook(
    (offset: number) =>
      useCanvasWorkerDraw({
        ...params,
        config,
        fullSequence: sequence,
        sequenceLength: sequence.length,
        layout: scene,
        precomputedLinePositions: positions,
        presentedLayout: {
          ...scene,
          lines: scene.lines.map((row, i) => (i === 0 ? { ...row, xOffset: offset } : row)),
        },
        onPaintLayoutPresented: onPresented,
      }),
    { initialProps: 8 }
  );
  await paintFrame();
  for (const offset of [6, 4, 2, 0]) {
    vi.mocked(renderSequence).mockClear();
    hook.rerender(offset);
    await Promise.resolve();
    expect(
      renderSequence,
      'translating old label pixels would shift the screen center'
    ).toHaveBeenCalledOnce();
    const painted = vi.mocked(renderSequence).mock.lastCall?.[1];
    expect(painted?.layout.lines[0].xOffset ?? 0).toBe(offset);
    expect(painted?.linePositions[0].line.xOffset ?? 0).toBe(offset);
    expect(onPresented.mock.lastCall?.[1].lines[0].xOffset).toBe(offset);
  }
});

it('submits a complete worker scene only after the parent corrects the candidate viewport', async () => {
  const params = setup();
  const sequence = 'ACGT'.repeat(50_000);
  const initialConfig = { ...DEFAULT_EDITOR_CONFIG, charsPerLine: 1000 };
  const candidateConfig = { ...initialConfig, charsPerLine: 999, charWidth: 7.99 };
  const document = {
    id: 'worker-rewrap',
    name: 'worker-rewrap',
    sequence,
    length: sequence.length,
    circular: false,
    annotations: [{ name: 'cds', type: 'CDS', start: 9001, end: 17000, direction: 1 as const }],
  };
  const initial = computeSequenceLayoutImpl(document, initialConfig, 0, 0);
  const completeCandidate = computeSequenceLayoutImpl(document, candidateConfig, 0, 0);
  const candidate = { ...completeCandidate, lines: completeCandidate.lines.slice(10, 17) };
  params.fullSequence = sequence;
  params.sequenceLength = sequence.length;
  params.viewportRef.current = { scrollTop: initial.lines[40].y, height: 100 };
  const correctedViewport = { scrollTop: candidate.lines[1].y, height: 100 };
  const onPresented = vi.fn();
  const beforeParentCorrection: MainToWorkerMessage[] = [];
  vi.stubGlobal('OffscreenCanvas', class OffscreenCanvas {});
  Object.defineProperty(params.canvasRef.current, 'transferControlToOffscreen', {
    value: () => ({}),
  });

  const hook = renderHook(
    (rewrap: boolean) => {
      const layout = rewrap ? candidate : initial;
      const config = rewrap ? candidateConfig : initialConfig;
      useCanvasWorkerDraw({
        ...params,
        layout,
        config,
        precomputedLinePositions: layout.lines.map((line) =>
          calculateLinePositions(line, config, [], sequence.length)
        ),

        highlightedRange: rewrap ? { start: 10000, end: 10100 } : null,
        onPaintLayoutPresented: onPresented,
      });
      useLayoutEffect(() => {
        if (!rewrap) return;
        beforeParentCorrection.push(...worker.posts);
        params.viewportRef.current = correctedViewport;
        params.scrollDrawRef.current?.(correctedViewport.scrollTop, correctedViewport.height, true);
      }, [rewrap]);
    },
    { initialProps: false }
  );
  const reply = (data: Record<string, unknown>) =>
    worker.current?.onmessage?.({ data } as MessageEvent);
  await act(async () => {
    reply({ type: 'pong' });
    reply({ type: 'ready' });
  });
  const renders = () =>
    worker.posts.filter((message): message is WorkerRenderMessage => message.type === 'render');
  expect(renders()).toHaveLength(1);
  const first = renders()[0];
  const acknowledge = (message: WorkerRenderMessage) =>
    reply({
      type: 'render-complete',
      renderVersion: message.renderVersion,
      presentationVersion: message.presentationVersion,
      scrollTop: message.params.viewport!.scrollTop,
      height: message.params.viewport!.height,
      result: {
        renderedPrimers: [],
        renderedGGLabels: [],
        renderedCutSites: [],
        lineCodonUpdates: new Map(),
      },
    });
  act(() => acknowledge(first));
  expect(onPresented).toHaveBeenCalledOnce();
  worker.posts.length = 0;
  onPresented.mockClear();

  hook.rerender(true);
  await act(async () => {});
  expect(
    beforeParentCorrection,
    'neither render nor viewport may escape before the parent fixes the camera'
  ).toEqual([]);
  expect(renders()).toHaveLength(1);
  const submitted = renders()[0];
  expect(submitted.renderVersion).toBe(first.renderVersion! + 1);
  expect(submitted.params.config).toBe(candidateConfig);
  expect(submitted.params.viewport).toEqual(correctedViewport);
  expect(submitted.viewportLinePositions!.length).toBeGreaterThan(0);
  const expectedVisibleRows = completeCandidate.lines
    .filter(
      (line) =>
        line.y < correctedViewport.scrollTop + correctedViewport.height &&
        completeCandidate.lines[line.lineIndex + 1]?.y > correctedViewport.scrollTop
    )
    .map((line) => line.lineIndex);
  expect(expectedVisibleRows.length).toBeGreaterThan(0);
  const submittedIndices = submitted.viewportLinePositions!.map(({ line }) => line.lineIndex);
  expect(submittedIndices).toEqual(expect.arrayContaining(expectedVisibleRows));
  expect(
    onPresented,
    'posting must not manufacture a worker acknowledgement'
  ).not.toHaveBeenCalled();
  act(() => acknowledge(submitted));
  expect(onPresented).toHaveBeenCalledOnce();
  expect(onPresented.mock.lastCall?.[0]).toBe(candidate);
});
