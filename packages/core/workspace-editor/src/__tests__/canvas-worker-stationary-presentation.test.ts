import { afterEach, expect, it, vi } from 'vitest';

const { drawing, render, posted } = vi.hoisted(() => ({
  drawing: {
    beginFrame: vi.fn(() => true),
    endFrame: vi.fn(),
    setTransform: vi.fn(),
    setPresentationShiftBounds: vi.fn(),
    capturePresentationScene: vi.fn(),
    presentRows: vi.fn(() => false),
    frameStats: { drawCalls: 1, vertices: 3 },
  },
  render: vi.fn(() => ({ lineCodonUpdates: new Map() })),
  posted: vi.fn(),
}));

vi.mock('../rendering/webgl-drawing-context', () => ({
  WebGLDrawingContext: vi.fn(function () {
    return drawing;
  }),
}));
vi.mock('../canvas-renderer', () => ({ renderSequence: render }));
vi.mock('../canvas-theme', () => ({ setCanvasTheme: vi.fn() }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it('paints and acknowledges a stationary pose when the worker has no retained texture', async () => {
  const frames: FrameRequestCallback[] = [];
  const receiver = { onmessage: null as ((event: MessageEvent) => void) | null };
  vi.stubGlobal('self', receiver);
  vi.stubGlobal('postMessage', posted);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.resetModules();
  await import('../canvas-render-worker');
  const send = (data: Record<string, unknown>) => receiver.onmessage?.({ data } as MessageEvent);
  const cds = {
    start: 11,
    end: 99,
    translationLane: 0,
    _cdsPillBounds: [{ x: 140, y: 210, w: 60, h: 14 }],
    _cdsLineBounds: [{ x: 80, y: 219.5, w: 300, h: 4.5 }],
    _interactionOutlineContours: [
      [
        { x: 80, y: 210 },
        { x: 380, y: 210 },
        { x: 380, y: 235 },
        { x: 80, y: 235 },
      ],
    ],
  };
  const viewportLinePositions = [
    {
      line: { lineIndex: 0, startPos: 0, endPos: 100, y: 200, classifiedCDSs: [cds] },
    },
  ];
  send({ type: 'init', canvas: { width: 400, height: 400 }, dpr: 1, theme: {} });
  send({
    type: 'render',
    renderVersion: 7,
    presentationVersion: 1,
    viewportLinePositions,
    canvasWidth: 400,
    canvasHeight: 400,
    params: {
      layout: { lines: [], totalHeight: 0 },
      config: {},
      fullSequence: 'A',
      viewport: { scrollTop: 0, height: 300 },
      canvasWidth: 400,
    },
  });
  frames.shift()?.(0);
  expect(render).toHaveBeenCalledTimes(1);
  expect(drawing.capturePresentationScene).not.toHaveBeenCalled();
  send({
    type: 'viewport',
    renderVersion: 7,
    presentationVersion: 1,
    scrollTop: 200,
    height: 250,
    viewportLinePositions,
  });
  frames.shift()?.(8);
  expect(render).toHaveBeenCalledTimes(2);
  posted.mockClear();

  send({ type: 'present-rows', renderVersion: 7, presentationVersion: 2, bands: [], dpr: 1 });
  expect(posted).not.toHaveBeenCalled();
  expect(frames, 'a pose without a retained texture still needs a real paint').toHaveLength(1);
  frames.shift()?.(16);
  expect(render).toHaveBeenCalledTimes(3);
  expect(render).toHaveBeenLastCalledWith(
    drawing,
    expect.objectContaining({ viewport: expect.objectContaining({ scrollTop: 200, height: 250 }) })
  );
  expect(posted).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'render-complete',
      renderVersion: 7,
      presentationVersion: 2,
      scrollTop: 200,
      height: 250,
      cdsPillBounds: [
        { lineIndex: 0, startPos: 0, endPos: 100, cds: [expect.objectContaining(cds)] },
      ],
    })
  );
});
