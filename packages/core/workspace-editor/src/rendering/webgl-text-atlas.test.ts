import { afterEach, expect, it, vi } from 'vitest';
import { WebGLTextAtlas } from './webgl-text-atlas';

afterEach(() => vi.unstubAllGlobals());

function setup(largeLetters = false) {
  const context = {
    font: '',
    textBaseline: 'alphabetic' as CanvasTextBaseline,
    measureText: vi.fn((text: string) => ({
      width: text.length === 1 && !largeLetters ? 10 : 1020,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: text.length === 1 && !largeLetters ? 10 : 1020,
      actualBoundingBoxAscent: text.length === 1 && !largeLetters ? 8 : 1022,
      actualBoundingBoxDescent: text.length === 1 && !largeLetters ? 2 : 0,
    })),
    save: vi.fn(),
    restore: vi.fn(),
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    fillText: vi.fn(),
    getImageData: vi.fn(() => ({ data: new Uint8Array(4) })),
  };
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      width = 1;
      height = 1;
      getContext() {
        return context;
      }
    }
  );
  const live = new Set<object>();
  let peakPages = 0;
  let bound: object;
  const events: Array<{ kind: string; texture?: object }> = [];
  const gl = {
    TEXTURE_2D: 1,
    TEXTURE_2D_ARRAY: 10,
    RGBA: 2,
    RGBA8: 11,
    UNSIGNED_BYTE: 3,
    TEXTURE_MIN_FILTER: 4,
    TEXTURE_MAG_FILTER: 5,
    LINEAR: 6,
    TEXTURE_WRAP_S: 7,
    TEXTURE_WRAP_T: 8,
    CLAMP_TO_EDGE: 9,
    createTexture: vi.fn(() => {
      const texture = {};
      live.add(texture);
      peakPages = Math.max(peakPages, live.size);
      return texture;
    }),
    bindTexture: vi.fn((_target: number, texture: object) => {
      bound = texture;
    }),
    texImage2D: vi.fn(),
    texImage3D: vi.fn((..._args: unknown[]) => {}),
    texParameteri: vi.fn(),
    texSubImage2D: vi.fn(() => {
      if (!live.has(bound)) throw Error('Upload into an evicted text texture');
      events.push({ kind: 'upload', texture: bound });
    }),
    texSubImage3D: vi.fn((..._args: unknown[]) => {
      if (!live.has(bound)) throw Error('Upload into a disposed text array');
      events.push({ kind: 'upload', texture: bound });
    }),
    deleteTexture: vi.fn((texture: object) => {
      events.push({ kind: 'delete', texture });
      live.delete(texture);
    }),
  };
  const flush = vi.fn(() => {
    events.push({ kind: 'flush' });
    atlas.uploadPending();
  });
  const atlas = new WebGLTextAtlas(gl as unknown as WebGL2RenderingContext, flush);
  const get = (text: string, font = '500 11px Inter') => atlas.get(text, font, 2, 'middle');
  return { atlas, context, gl, get, flush, events, live, peakPages: () => peakPages };
}

it('reuses native metrics only for the same text, font and baseline', () => {
  const { atlas, context } = setup();
  const identities = [
    ['1200', '11px Inter', 'alphabetic'],
    ['1201', '11px Inter', 'alphabetic'],
    ['1200', '12px Inter', 'alphabetic'],
    ['1200', '11px Inter', 'top'],
  ] as const;
  const measured = identities.map(([text, font, baseline]) => {
    const metrics = atlas.measure(text, font, baseline);
    expect(context.font).toBe(font);
    expect(context.textBaseline).toBe(baseline);
    return metrics;
  });
  expect(new Set(measured).size).toBe(identities.length);
  for (const [i, [text, font, baseline]] of identities.entries())
    expect(atlas.measure(text, font, baseline)).toBe(measured[i]);
  expect(atlas.measure('1200', '11px Inter')).toBe(measured[0]);
  expect(context.measureText).toHaveBeenCalledTimes(identities.length);
});

it('clears all metric identities only after a successful miss beyond the global limit', () => {
  const { atlas, context } = setup();
  const identities = [
    ['11px Inter', 'alphabetic'],
    ['12px Inter', 'alphabetic'],
    ['11px Inter', 'top'],
    ['12px Inter', 'top'],
  ] as const;
  const retained: TextMetrics[] = [];
  for (let i = 0; i < 8192; i++) {
    const [font, baseline] = identities[i % identities.length];
    const metrics = atlas.measure(String(i), font, baseline);
    if (i < identities.length) retained.push(metrics);
  }
  for (const [i, [font, baseline]] of identities.entries())
    expect(atlas.measure(String(i), font, baseline)).toBe(retained[i]);
  expect(context.measureText).toHaveBeenCalledTimes(8192);

  context.measureText.mockImplementationOnce(() => {
    throw new Error('Native measurement failed');
  });
  expect(() => atlas.measure('failed', '11px Inter')).toThrow('Native measurement failed');
  expect(atlas.measure('0', '11px Inter')).toBe(retained[0]);

  const replacement = atlas.measure('new', '11px Inter');
  expect(atlas.measure('new', '11px Inter')).toBe(replacement);
  for (const [i, [font, baseline]] of identities.entries())
    expect(atlas.measure(String(i), font, baseline)).not.toBe(retained[i]);
  expect(context.measureText).toHaveBeenCalledTimes(8198);
});

it('disposal clears metrics and resets their capacity for subsequent measurements', () => {
  const { atlas, context } = setup();
  const previous = atlas.measure('0', '11px Inter');
  for (let i = 1; i < 8191; i++) atlas.measure(String(i), '11px Inter');
  atlas.dispose();
  const first = atlas.measure('0', '11px Inter');
  const second = atlas.measure('1', '11px Inter');
  expect(first).not.toBe(previous);
  expect(atlas.measure('0', '11px Inter')).toBe(first);
  expect(atlas.measure('1', '11px Inter')).toBe(second);
  expect(context.measureText).toHaveBeenCalledTimes(8193);
});

it('peeks only exact resident tile-zero runs with their original unrounded metrics', () => {
  const { atlas, context, gl, flush } = setup();
  const font = '500 11px Inter';
  context.measureText.mockReturnValue({
    width: 10.125,
    actualBoundingBoxLeft: 0.125,
    actualBoundingBoxRight: 9.625,
    actualBoundingBoxAscent: 7.125,
    actualBoundingBoxDescent: 2.875,
  });
  expect(atlas.peekResidentText('A', font, 2, 'middle')).toBeUndefined();
  expect(context.measureText).not.toHaveBeenCalled();
  expect(gl.createTexture).not.toHaveBeenCalled();
  const metrics = atlas.measure('A', font, 'middle');
  const run = atlas.get('A', font, 2, 'middle');
  atlas.uploadPending();
  context.fillText.mockClear();
  const measurements = context.measureText.mock.calls.length;
  const uploads = gl.texSubImage3D.mock.calls.length;
  const resident = atlas.peekResidentText('A', font, 2, 'middle');
  expect(resident?.run).toBe(run);
  expect(resident?.metrics).toBe(metrics);
  expect(atlas.peekResidentText('A', '500 11.01px Inter', 2, 'middle')).toBeUndefined();
  expect(atlas.peekResidentText('A', font, 1, 'middle')).toBeUndefined();
  expect(atlas.peekResidentText('A', font, 2, 'alphabetic')).toBeUndefined();
  expect(atlas.peekResidentText('missing', font, 2, 'middle')).toBeUndefined();
  atlas.uploadPending();
  expect(context.measureText).toHaveBeenCalledTimes(measurements);
  expect(context.fillText).not.toHaveBeenCalled();
  expect(gl.texSubImage3D).toHaveBeenCalledTimes(uploads);
  atlas.get('B', font, 2, 'middle', 0, 0.25, 0.5);
  atlas.get('C', font, 2, 'middle', 1);
  const afterMisses = context.measureText.mock.calls.length;
  expect(atlas.peekResidentText('B', font, 2, 'middle')).toBeUndefined();
  expect(atlas.peekResidentText('C', font, 2, 'middle')).toBeUndefined();
  expect(context.measureText).toHaveBeenCalledTimes(afterMisses);
  expect(measurements).toBe(1);
  expect(flush).not.toHaveBeenCalled();
  atlas.dispose();
  expect(atlas.peekResidentText('A', font, 2, 'middle')).toBeUndefined();
});

it('does not retain metrics across capacity clearing or font disposal', () => {
  const { atlas, context, get } = setup();
  const font = '500 11px Inter';
  const run = get('A');
  const originalMetrics = atlas.peekResidentText('A', font, 2, 'middle')?.metrics;
  for (let i = 0; i < 8192; i++) atlas.measure(`measure-only-${i}`, font, 'middle');
  expect(atlas.peekResidentText('A', font, 2, 'middle')).toBeUndefined();
  const calls = context.measureText.mock.calls.length;
  expect(get('A')).toBe(run);
  expect(context.measureText).toHaveBeenCalledTimes(calls);
  expect(atlas.peekResidentText('A', font, 2, 'middle')).toBeUndefined();
  const freshMetrics = atlas.measure('A', font, 'middle');
  expect(freshMetrics).not.toBe(originalMetrics);
  expect(get('A')).toBe(run);
  expect(atlas.peekResidentText('A', font, 2, 'middle')?.metrics).toBe(freshMetrics);
  atlas.dispose();
  expect(atlas.peekResidentText('A', font, 2, 'middle')).toBeUndefined();
  expect(get('A')).not.toBe(run);
  expect(atlas.peekResidentText('A', font, 2, 'middle')?.metrics).not.toBe(freshMetrics);
  atlas.dispose();
});

it('all text pages share one four-layer texture without changing raster placement', () => {
  const { atlas, get, gl, flush, live } = setup(true);
  const runs = ['A', 'gene-0', 'T', 'ruler-123'].map((text) => get(text));
  expect(new Set(runs.map((run) => run.texture)).size).toBe(1);
  expect(runs.map((run) => run.layer)).toEqual([0, 1, 2, 3]);
  expect(gl.texImage3D).toHaveBeenCalledTimes(1);
  expect(gl.texImage3D.mock.calls[0].slice(3, 6)).toEqual([2048, 2048, 4]);
  expect(flush).not.toHaveBeenCalled();
  for (const run of runs) {
    expect({
      x: run.x,
      y: run.y,
      width: run.width,
      height: run.height,
      left: run.left,
      top: run.top,
      advance: run.advance,
    }).toEqual({ x: 4, y: 0, width: 2040, height: 2048, left: 0, top: -1023, advance: 1020 });
  }
  atlas.uploadPending();
  expect(new Set(gl.texSubImage3D.mock.calls.map((call) => call[4]))).toEqual(
    new Set([0, 1, 2, 3])
  );
  atlas.dispose();
  expect(gl.deleteTexture).toHaveBeenCalledTimes(1);
  expect(live.size).toBe(0);
});

it('flushes before reusing a layer and invalidates only its old runs', () => {
  const { atlas, get, gl, flush, live } = setup(true);
  const runs = ['gene-0', 'gene-1', 'gene-2', 'gene-3'].map((name) => get(name));
  const generation = atlas.generation;
  expect(atlas.peekResidentText('gene-0', '500 11px Inter', 2, 'middle')?.run).toBe(runs[0]);
  const replacement = get('gene-4');
  expect(flush).toHaveBeenCalledTimes(1);
  expect(replacement.layer).toBe(runs[0].layer);
  expect(replacement.texture).toBe(runs[0].texture);
  expect(atlas.generation).toBeGreaterThan(generation);
  expect(atlas.peekResidentText('gene-0', '500 11px Inter', 2, 'middle')).toBeUndefined();
  expect(atlas.peekResidentText('gene-1', '500 11px Inter', 2, 'middle')?.run).toBe(runs[1]);
  for (const index of [1, 2, 3]) expect(get(`gene-${index}`)).toBe(runs[index]);
  expect(get('gene-0')).not.toBe(runs[0]);
  expect(gl.createTexture).toHaveBeenCalledTimes(1);
  expect(gl.deleteTexture).not.toHaveBeenCalled();
  atlas.uploadPending();
  atlas.dispose();
  atlas.uploadPending();
  expect(live.size).toBe(0);
});

it('reuses raster runs only for the same text and all six raster settings', () => {
  const { atlas } = setup();
  const identities: Parameters<WebGLTextAtlas['get']>[] = [
    ['A', '11px Inter', 1, 'alphabetic', 0, 0, 0],
    ['B', '11px Inter', 1, 'alphabetic', 0, 0, 0],
    ['A', '12px Inter', 1, 'alphabetic', 0, 0, 0],
    ['A', '11px Inter', 2, 'alphabetic', 0, 0, 0],
    ['A', '11px Inter', 1, 'top', 0, 0, 0],
    ['A', '11px Inter', 1, 'alphabetic', 1, 0, 0],
    ['A', '11px Inter', 1, 'alphabetic', 0, 0.25, 0],
    ['A', '11px Inter', 1, 'alphabetic', 0, 0, 0.5],
    ['A|B', '11px "Inter|Custom"', 1, 'alphabetic', 0, 0, 0],
    ['A', '11px Inter', 1, 'alphabetic', 0, NaN, 0],
  ];
  const runs = identities.map((identity) => atlas.get(...identity));
  expect(new Set(runs).size).toBe(identities.length);
  for (const [index, identity] of identities.entries()) {
    expect(atlas.get(...identity)).toBe(runs[index]);
    expect(atlas.get(...identity)).toBe(runs[index]);
  }
  expect(atlas.get('A', '11px Inter', 1, 'alphabetic', -0, -0, -0)).toBe(runs[0]);
  expect(runs[6].left).toBe(-0.25);
  expect(runs[7].top).toBe(-10.5);
});

it('retains a replacement when its allocation evicts the last run with those raster settings', () => {
  const { atlas, get, flush } = setup(true);
  const fonts = ['11px Inter', '12px Inter', '13px Inter', '14px Inter'];
  const runs = fonts.map((font, index) => get(`gene-${index}`, font));
  expect(get('gene-0', fonts[0])).toBe(runs[0]);
  const generation = atlas.generation;
  const replacement = get('gene-4', fonts[0]);
  expect(flush).toHaveBeenCalledTimes(1);
  expect(atlas.generation).toBe(generation + 1);
  expect(replacement.layer).toBe(runs[0].layer);
  expect(get('gene-4', fonts[0])).toBe(replacement);
  for (const index of [1, 2, 3]) expect(get(`gene-${index}`, fonts[index])).toBe(runs[index]);
  expect(get('gene-4', fonts[0])).toBe(replacement);
  expect(get('gene-0', fonts[0])).not.toBe(runs[0]);
});

it('applies the global raster-run limit across settings and resets it on disposal', () => {
  const { atlas, context, flush } = setup();
  context.measureText.mockImplementation(() => ({
    width: 1,
    actualBoundingBoxLeft: 0,
    actualBoundingBoxRight: 1,
    actualBoundingBoxAscent: 1,
    actualBoundingBoxDescent: 0,
  }));
  const get = (index: number) =>
    atlas.get(String(index), index % 2 ? '11px Inter' : '12px Inter', 1, 'middle');
  const first = get(0);
  for (let i = 1; i < 4096; i++) get(i);
  atlas.beginFrame();
  expect(flush).not.toHaveBeenCalled();
  expect(get(0)).toBe(first);
  const generation = atlas.generation;
  get(4096);
  atlas.beginFrame();
  expect(flush).toHaveBeenCalledTimes(1);
  expect(atlas.generation).toBe(generation + 1);
  expect(get(0)).not.toBe(first);
  atlas.beginFrame();
  expect(flush).toHaveBeenCalledTimes(1);

  for (let i = 1; i < 4096; i++) get(i);
  const beforeDispose = get(0);
  atlas.dispose();
  expect(get(0)).not.toBe(beforeDispose);
  atlas.beginFrame();
  expect(flush).toHaveBeenCalledTimes(1);
});

it('keeps cached raster runs when a different native measurement fails', () => {
  const { atlas, context, get } = setup();
  const retained = get('A');
  context.measureText.mockImplementationOnce(() => {
    throw new Error('Native measurement failed');
  });
  expect(() => get('B', '12px Inter')).toThrow('Native measurement failed');
  expect(get('A')).toBe(retained);
  const recovered = get('B', '12px Inter');
  expect(get('B', '12px Inter')).toBe(recovered);
  atlas.dispose();
  expect(get('B', '12px Inter')).not.toBe(recovered);
});
