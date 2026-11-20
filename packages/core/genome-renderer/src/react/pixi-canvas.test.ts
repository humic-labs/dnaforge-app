// @vitest-environment jsdom
import type { Application } from 'pixi.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resizePixiCanvas } from './pixi-canvas';

vi.mock('pixi.js', () => ({ Container: class {} }));

function makeApp(rendererWidth: number, rendererHeight: number, resolution = 1) {
  const canvas = document.createElement('canvas');
  const resize = vi.fn((w: number, h: number, r?: number) => {
    if (r !== undefined) app.renderer.resolution = r;
    app.renderer.width = w;
    app.renderer.height = h;
  });
  const app = {
    renderer: {
      width: rendererWidth,
      height: rendererHeight,
      resolution,
      resize,
      render: vi.fn(),
    },
    canvas,
  } as unknown as Application & {
    renderer: {
      width: number;
      height: number;
      resolution: number;
      resize: ReturnType<typeof vi.fn>;
      render: ReturnType<typeof vi.fn>;
    };
    canvas: HTMLCanvasElement;
  };
  return app;
}

describe('resizePixiCanvas — backing buffer reallocation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps the map at native scale throughout a 90-pixel pane drag without reallocating every pixel', () => {
    const app = makeApp(800, 500);
    Object.defineProperty(app.canvas.style, 'objectViewBox', { value: '', configurable: true });
    const css = vi.spyOn(app.canvas.style, 'setProperty');
    for (let width = 801; width <= 890; width++) {
      const logical = resizePixiCanvas(app, width, 500, 'pane-drag', undefined, true);
      expect(logical.width).toBe(width);
      expect(app.canvas.style.width).toBe(`${width}px`);
    }
    expect(app.renderer.resize).toHaveBeenCalledOnce();
    expect(app.renderer.width).toBe(896);
    expect(css).toHaveBeenLastCalledWith('object-view-box', 'inset(0 6px 0px 0)');
  });

  it('presents a side map in the existing document buffer on the first split', () => {
    const app = makeApp(896, 768);
    Object.defineProperty(app.canvas.style, 'objectViewBox', { value: '' });
    const result = resizePixiCanvas(app, 418, 686, 'side-by-side', undefined, {
      width: 842,
      height: 686,
    });
    expect(result).toEqual({ width: 418, height: 686, backingChanged: false });
    expect(app.renderer.resize).not.toHaveBeenCalled();
    expect(app.canvas.style.width).toBe('418px');
  });

  it('reallocates and reports backingChanged when the backing size differs', () => {
    const app = makeApp(800, 600);
    const result = resizePixiCanvas(app, 1024, 768, 'test');

    expect(app.renderer.resize).toHaveBeenCalledTimes(1);
    expect(app.renderer.resize).toHaveBeenCalledWith(1024, 768, window.devicePixelRatio || 1);
    expect(result).toMatchObject({ width: 1024, height: 768, backingChanged: true });
  });

  it('clears a reallocated buffer to the background so it never presents black ', () => {
    const app = makeApp(800, 600);
    resizePixiCanvas(app, 1024, 768, 'test');
    expect(app.renderer.render).toHaveBeenCalledTimes(1);
    expect(app.renderer.resize.mock.invocationCallOrder[0]).toBeLessThan(
      app.renderer.render.mock.invocationCallOrder[0]
    );

    vi.clearAllMocks();
    resizePixiCanvas(app, 1024, 768, 'test');
    expect(app.renderer.render).not.toHaveBeenCalled();
  });

  it('does NOT reallocate, and reports backingChanged=false, when the size is unchanged', () => {
    const app = makeApp(1024, 768);
    const result = resizePixiCanvas(app, 1024, 768, 'test');

    expect(app.renderer.resize).not.toHaveBeenCalled();
    expect(result.backingChanged).toBe(false);
  });

  it('treats sub-pixel jitter that rounds to the same integer as unchanged', () => {
    const app = makeApp(1024, 768);
    const result = resizePixiCanvas(app, 1024.4, 767.6, 'test');

    expect(app.renderer.resize).not.toHaveBeenCalled();
    expect(result.backingChanged).toBe(false);
  });

  it('clamps a degenerate zero/negative size to 1px rather than reallocating to nothing', () => {
    const app = makeApp(1024, 768);
    const result = resizePixiCanvas(app, 0, -5, 'test');

    expect(result).toMatchObject({ width: 1, height: 1, backingChanged: true });
    expect(app.renderer.resize).toHaveBeenCalledWith(1, 1, window.devicePixelRatio || 1);
  });
});

describe('resizePixiCanvas — the CSS box is independent of the backing buffer', () => {
  beforeEach(() => vi.clearAllMocks());

  it('defaults the CSS box to the backing size when no cssSize is given', () => {
    const app = makeApp(800, 600);
    resizePixiCanvas(app, 1024, 768, 'test');

    expect(app.canvas.style.width).toBe('1024px');
    expect(app.canvas.style.height).toBe('768px');
  });

  it('sizes the CSS box from cssSize while the backing stays pinned', () => {
    const app = makeApp(1024, 1404);
    resizePixiCanvas(app, 1024, 1404, 'preview', { width: 1024, height: 1404 });

    expect(app.renderer.resize).not.toHaveBeenCalled();
    expect(app.canvas.style.width).toBe('1024px');
    expect(app.canvas.style.height).toBe('1404px');
  });

  it('writes the CSS box on every call, even when the backing did not change', () => {
    const app = makeApp(1024, 768);
    app.canvas.style.width = 'stale';
    resizePixiCanvas(app, 1024, 768, 'test', { width: 512, height: 384 });

    expect(app.renderer.resize).not.toHaveBeenCalled();
    expect(app.canvas.style.width).toBe('512px');
    expect(app.canvas.style.height).toBe('384px');
  });

  it('never reads layout — a forced reflow here lands on a drag hot path', () => {
    const app = makeApp(800, 600);
    const spy = vi.spyOn(app.canvas, 'getBoundingClientRect');
    resizePixiCanvas(app, 1024, 768, 'test');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('resizePixiCanvas — backing-store density', () => {
  beforeEach(() => vi.clearAllMocks());

  it('settles on a 2x display instead of resizing forever', () => {
    const previousDpr = window.devicePixelRatio;
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
    try {
      const app = makeApp(800, 600, 1);
      const first = resizePixiCanvas(app, 800, 600, 'first');
      expect(first.backingChanged).toBe(true);

      for (let call = 0; call < 5; call++) {
        expect(resizePixiCanvas(app, 800, 600, 'steady').backingChanged).toBe(false);
      }
      expect(app.renderer.resize).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, 'devicePixelRatio', {
        value: previousDpr,
        configurable: true,
      });
    }
  });

  it('re-asserts the display density even when the size did not change', () => {
    const previousDpr = window.devicePixelRatio;
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
    try {
      const app = makeApp(800, 600, 1);
      const result = resizePixiCanvas(app, 800, 600, 'test');
      expect(result.backingChanged).toBe(true);
      expect(app.renderer.resize).toHaveBeenCalledWith(800, 600, 2);
      expect(app.renderer.resolution).toBe(2);
      expect(app.renderer.width).toBe(800);
      expect(app.canvas.style.width).toBe('800px');
    } finally {
      Object.defineProperty(window, 'devicePixelRatio', {
        value: previousDpr,
        configurable: true,
      });
    }
  });

  it('leaves a renderer that already matches the display alone', () => {
    const previousDpr = window.devicePixelRatio;
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
    try {
      const app = makeApp(800, 600, 2);
      const result = resizePixiCanvas(app, 800, 600, 'test');
      expect(result.backingChanged).toBe(false);
      expect(app.renderer.resize).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, 'devicePixelRatio', {
        value: previousDpr,
        configurable: true,
      });
    }
  });

  it('compares screen size, not backing pixels, so a stable map stops resizing', () => {
    const previousDpr = window.devicePixelRatio;
    Object.defineProperty(window, 'devicePixelRatio', { value: 3, configurable: true });
    try {
      const app = makeApp(640, 480, 3);
      expect(resizePixiCanvas(app, 640, 480, 'test').backingChanged).toBe(false);
    } finally {
      Object.defineProperty(window, 'devicePixelRatio', {
        value: previousDpr,
        configurable: true,
      });
    }
  });
});
