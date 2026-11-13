import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CANCELLED_VIEWER_LOAD_ERROR,
  MOLSTAR_VIEWER_GENERIC_LOADING_ERROR,
  STRUCTURE_FIRST_PAINT_HARD_CEILING_MS,
  STRUCTURE_FIRST_PAINT_TIMEOUT_MESSAGE,
  STRUCTURE_LOAD_HARD_CEILING_MS,
  STRUCTURE_LOAD_HARD_TIMEOUT_MESSAGE,
  STRUCTURE_LOAD_TIMEOUT_MS,
  createMolstarLoadingIndicator,
  createViewerContainer,
  formatMolstarLoadingErrorText,
  structureLoadSizeBucket,
} from './createViewer';
import { initializePlugin } from './pluginConfig';
import { registerMolecularRenderProfileVisuals } from './nucleotidePresentation';
import { loadStructure } from './structureBuilder';
import { requestRendererHostStructure } from './rendererHostActivation';
import { yieldToMain } from './yieldToMain';

const sentryMocks = vi.hoisted(() => {
  const span = {
    addEvent: vi.fn(),
    setAttributes: vi.fn(),
    setStatus: vi.fn(),
    end: vi.fn(),
  };
  return {
    captureMessage: vi.fn(),
    startInactiveSpan: vi.fn(() => span),
    span,
  };
});

vi.mock('../../../../../lib/sentry', () => ({
  Sentry: {
    captureMessage: sentryMocks.captureMessage,
    startInactiveSpan: sentryMocks.startInactiveSpan,
  },
}));

vi.mock('./pluginConfig', () => ({
  initializePlugin: vi.fn(),
  setPluginSpin: vi.fn(),
}));

vi.mock('./structureBuilder', () => ({
  loadStructure: vi.fn(),
}));

vi.mock('./nucleotidePresentation', () => ({
  registerMolecularRenderProfileVisuals: vi.fn(),
}));

vi.mock('./yieldToMain', () => ({
  yieldToMain: vi.fn().mockResolvedValue(undefined),
}));

function createReadyPlugin(): Awaited<ReturnType<typeof initializePlugin>> {
  return {
    canvas3d: {
      handleResize: vi.fn(),
      requestDraw: vi.fn(),
      commit: vi.fn(),
      animate: vi.fn(),
    },
    managers: {
      structure: {
        hierarchy: {
          current: {
            structures: [{ components: [{ representations: [{ cell: {} }] }] }],
          },
        },
      },
    },
  } as unknown as Awaited<ReturnType<typeof initializePlugin>>;
}

function installPaintedWebglProbe(): void {
  let sample = 0;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawingBufferWidth: 640,
    drawingBufferHeight: 480,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    readPixels: vi.fn(
      (
        _x: number,
        _y: number,
        _width: number,
        _height: number,
        _format: number,
        _type: number,
        pixels: Uint8Array
      ) => {
        pixels.set(sample++ % 2 === 0 ? [3, 58, 145, 255] : [0, 0, 0, 0]);
      }
    ),
  } as unknown as WebGLRenderingContext);
}

describe('createViewerContainer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.mocked(registerMolecularRenderProfileVisuals).mockReset();
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get: () => 640,
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get: () => 480,
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    delete (window as typeof window & { __structureLoadTelemetry?: unknown })
      .__structureLoadTelemetry;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('classifies coordinate payload size into stable telemetry buckets', () => {
    expect(structureLoadSizeBucket(undefined)).toBe('unknown');
    expect(structureLoadSizeBucket('x'.repeat(256 * 1024))).toBe('tiny');
    expect(structureLoadSizeBucket('x'.repeat(256 * 1024 + 1))).toBe('small');
    expect(structureLoadSizeBucket(new Uint8Array(5 * 1024 * 1024))).toBe('medium');
    expect(structureLoadSizeBucket(new Uint8Array(20 * 1024 * 1024))).toBe('large');
    expect(structureLoadSizeBucket(new Uint8Array(20 * 1024 * 1024 + 1))).toBe('very-large');
  });

  it('loads stable native coordinates for private fresh authoring without claiming a scientific first paint', async () => {
    const plugin = createReadyPlugin();
    plugin.managers.structure.hierarchy.current.structures = [];
    vi.mocked(initializePlugin).mockResolvedValue(plugin);
    vi.mocked(loadStructure).mockImplementation(async () => {
      plugin.managers.structure.hierarchy.current.structures = [{ components: [] } as never];
    });
    const cached = await createViewerContainer({
      structureKey: 'fresh-coordinates',
      structureData: 'data_test',
      coordinatesOnly: true,
      coordinateOnlyInitialLoad: true,
    });
    await vi.runAllTimersAsync();
    expect(cached.error).toBeNull();
    expect(cached.isLoading).toBe(false);
    expect(
      (
        window as typeof window & {
          __structureLoadTelemetry?: Array<{ event: string; firstPaintResolution?: string }>;
        }
      ).__structureLoadTelemetry?.at(-1)
    ).toMatchObject({ event: 'finished' });
    expect(
      (
        window as typeof window & {
          __structureLoadTelemetry?: Array<{ firstPaintResolution?: string }>;
        }
      ).__structureLoadTelemetry?.at(-1)?.firstPaintResolution
    ).toBeUndefined();
  });

  it('uses an animated loading indicator so large previews do not look frozen', () => {
    const loading = createMolstarLoadingIndicator();

    expect(loading).toHaveAttribute('role', 'status');
    expect(loading.querySelector('[data-testid="molstar-loading-spinner"]')).toBeTruthy();
    expect(loading.querySelector('[data-testid="molstar-loading-progress"]')).toBeTruthy();
    expect(loading).toHaveTextContent('Preparing 3D structure...');
    expect(loading).toHaveTextContent('Fetching, parsing, and drawing the preview.');
    expect(document.getElementById('waypoint-molstar-loading-styles')).toBeTruthy();
  });

  it('formats raw MolStar diagnostics as generic loading overlay text', () => {
    const rawDiagnostic =
      '[MolstarViewer:before-reveal] Structure render plan expected a detail chain. {"targetId":"g-g-25-asm_1-g","expression":"structure-query.generator.atom-groups"}';

    expect(formatMolstarLoadingErrorText(rawDiagnostic)).toBe(MOLSTAR_VIEWER_GENERIC_LOADING_ERROR);
    expect(formatMolstarLoadingErrorText('Structure load timeout after 30000ms')).toBe(
      MOLSTAR_VIEWER_GENERIC_LOADING_ERROR
    );
  });

  it('treats the soft 30s boundary as non-fatal and keeps waiting for a still-running load', async () => {
    const onError = vi.fn();
    const onSlowLoad = vi.fn();
    const onComplete = vi.fn();
    let resolveLoad: (() => void) | undefined;
    installPaintedWebglProbe();
    vi.mocked(initializePlugin).mockResolvedValue(createReadyPlugin());
    vi.mocked(loadStructure).mockReturnValue(
      new Promise<void>((resolve) => {
        resolveLoad = () => resolve();
      })
    );

    const cached = await createViewerContainer({
      structureKey: 'provider:AF:P03817:F1:V6',
      uniprotId: 'P03817',
      onError,
      onSlowLoad,
      onComplete,
    });

    await vi.advanceTimersByTimeAsync(STRUCTURE_LOAD_TIMEOUT_MS + 1);

    expect(cached.isLoading).toBe(true);
    expect(cached.error).toBeNull();
    expect(onError).not.toHaveBeenCalled();
    expect(onSlowLoad).toHaveBeenCalledTimes(1);
    expect(sentryMocks.captureMessage).toHaveBeenCalledWith(
      'structure.viewer.load.slow',
      expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({ current_leg: 'loadStructure' }),
      })
    );
    expect(
      cached.container.querySelector('[data-testid="molstar-loading-title"]')
    ).toHaveTextContent('Rendering large structure');

    resolveLoad?.();
    await vi.runAllTimersAsync();

    expect(cached.isLoading).toBe(false);
    expect(cached.error).toBeNull();
    expect(onError).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalled();
  });

  it('rejects at the hard ceiling when Molstar load never settles', async () => {
    const onError = vi.fn();
    const onSlowLoad = vi.fn();
    const onComplete = vi.fn();
    vi.mocked(initializePlugin).mockResolvedValue(
      {} as Awaited<ReturnType<typeof initializePlugin>>
    );
    vi.mocked(loadStructure).mockReturnValue(new Promise(() => undefined));

    const cached = await createViewerContainer({
      structureKey: 'provider:AF:P03817:F1:V6',
      uniprotId: 'P03817',
      onError,
      onSlowLoad,
      onComplete,
    });

    await vi.advanceTimersByTimeAsync(STRUCTURE_LOAD_TIMEOUT_MS + 1);
    expect(onSlowLoad).toHaveBeenCalled();
    expect(cached.isLoading).toBe(true);
    expect(onError).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(STRUCTURE_LOAD_HARD_CEILING_MS - STRUCTURE_LOAD_TIMEOUT_MS);

    expect(cached.isLoading).toBe(false);
    expect(cached.error).toBe(STRUCTURE_LOAD_HARD_TIMEOUT_MESSAGE);
    expect(onError).toHaveBeenCalledWith(STRUCTURE_LOAD_HARD_TIMEOUT_MESSAGE);
    expect(onComplete).toHaveBeenCalled();
  });

  it('keeps a slow first paint non-fatal past 5s but fails into recovery at 10s', async () => {
    const onError = vi.fn();
    const onSlowLoad = vi.fn();
    const onComplete = vi.fn();
    const plugin = {
      canvas3d: {
        handleResize: vi.fn(),
        requestDraw: vi.fn(),
        commit: vi.fn(),
        animate: vi.fn(),
      },
    } as unknown as Awaited<ReturnType<typeof initializePlugin>>;
    vi.mocked(initializePlugin).mockResolvedValue(plugin);
    vi.mocked(loadStructure).mockResolvedValue(undefined);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);

    const cached = await createViewerContainer({
      structureKey: 'provider:AF:P03817:F1:V6',
      uniprotId: 'P03817',
      onError,
      onSlowLoad,
      onComplete,
    });

    await vi.advanceTimersByTimeAsync(6_000);
    expect(cached.isLoading).toBe(true);
    expect(cached.error).toBeNull();
    expect(onError).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(STRUCTURE_FIRST_PAINT_HARD_CEILING_MS - 6_000 + 100);
    expect(cached.isLoading).toBe(false);
    expect(cached.error).toBe(STRUCTURE_FIRST_PAINT_TIMEOUT_MESSAGE);
    expect(onError).toHaveBeenCalledWith(STRUCTURE_FIRST_PAINT_TIMEOUT_MESSAGE);
    expect(onComplete).toHaveBeenCalled();
  });

  it('fails closed when Molstar never exposes a canvas3d renderer', async () => {
    const onError = vi.fn();
    const onComplete = vi.fn();
    vi.mocked(initializePlugin).mockResolvedValue({
      managers: {
        structure: {
          hierarchy: {
            current: {
              structures: [{ components: [{ representations: [{ cell: {} }] }] }],
            },
          },
        },
      },
    } as unknown as Awaited<ReturnType<typeof initializePlugin>>);
    vi.mocked(loadStructure).mockResolvedValue(undefined);

    const cached = await createViewerContainer({
      structureKey: 'provider:AF:missing-renderer:F1:V6',
      uniprotId: 'missing-renderer',
      onError,
      onComplete,
    });

    await vi.runAllTimersAsync();

    expect(cached.isLoading).toBe(false);
    expect(cached.error).toBe(STRUCTURE_FIRST_PAINT_TIMEOUT_MESSAGE);
    expect(onError).toHaveBeenCalledWith(STRUCTURE_FIRST_PAINT_TIMEOUT_MESSAGE);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('accepts a sparse but genuinely painted structure frame instead of polling for five minutes', async () => {
    const onError = vi.fn();
    const onComplete = vi.fn();
    const plugin = {
      canvas3d: {
        handleResize: vi.fn(),
        requestDraw: vi.fn(),
        commit: vi.fn(),
        animate: vi.fn(),
      },
      managers: {
        structure: {
          hierarchy: {
            current: {
              structures: [{ components: [{ representations: [{ cell: {} }] }] }],
            },
          },
        },
      },
    } as unknown as Awaited<ReturnType<typeof initializePlugin>>;
    let sampledPixel = 0;
    const readPixels = vi.fn(
      (
        _x: number,
        _y: number,
        _width: number,
        _height: number,
        _format: number,
        _type: number,
        pixels: Uint8Array
      ) => {
        const indexInProbe = sampledPixel++ % (15 * 15);
        if (indexInProbe === 112 || indexInProbe === 113) {
          pixels.set([3, 58, 145, 255]);
        } else {
          pixels.set([0, 0, 0, 0]);
        }
      }
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawingBufferWidth: 950,
      drawingBufferHeight: 2942,
      RGBA: 0x1908,
      UNSIGNED_BYTE: 0x1401,
      readPixels,
    } as unknown as WebGLRenderingContext);
    vi.mocked(initializePlugin).mockResolvedValue(plugin);
    vi.mocked(loadStructure).mockResolvedValue(undefined);

    const cached = await createViewerContainer({
      structureKey: 'provider:AF:A0A941CZQ6:F1:V6',
      uniprotId: 'A0A941CZQ6',
      onError,
      onComplete,
    });

    await vi.advanceTimersByTimeAsync(500);

    expect(cached.isLoading).toBe(false);
    expect(cached.error).toBeNull();
    expect(cached.container.querySelector('canvas')?.style.visibility).toBe('visible');
    expect(onError).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(sentryMocks.startInactiveSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'structure.viewer.load',
        op: 'ui.load',
        attributes: {
          'structure.source_kind': 'alphafold',
          'structure.size_bucket': 'unknown',
        },
      })
    );
    expect(sentryMocks.span.setAttributes).toHaveBeenCalledWith(
      expect.objectContaining({
        'structure.outcome': 'ready',
        'structure.first_paint.resolution': 'sampled-pixels',
        'structure.first_paint.non_white_samples': 2,
      })
    );
    expect(sentryMocks.span.setStatus).toHaveBeenCalledWith({ code: 1, message: 'ok' });
    expect(sentryMocks.span.end).toHaveBeenCalledTimes(1);
    expect(
      (
        window as typeof window & {
          __structureLoadTelemetry?: Array<{ event: string; firstPaintResolution?: string }>;
        }
      ).__structureLoadTelemetry?.at(-1)
    ).toMatchObject({ event: 'finished', firstPaintResolution: 'sampled-pixels' });
  });

  it('accepts Molstar native draw readiness when the pixel grid misses rendered content', async () => {
    const onError = vi.fn();
    const onComplete = vi.fn();
    let drawListener: (() => void) | undefined;
    const plugin = {
      canvas3d: {
        handleResize: vi.fn(),
        requestDraw: vi.fn(),
        commit: vi.fn(),
        animate: vi.fn(() => drawListener?.()),
        didDraw: {
          subscribe: vi.fn((listener: () => void) => {
            drawListener = listener;
            listener();
            return { unsubscribe: vi.fn() };
          }),
        },
        reprCount: { value: 1 },
      },
      managers: {
        structure: {
          hierarchy: {
            current: {
              structures: [{ components: [{ representations: [{ cell: {} }] }] }],
            },
          },
        },
      },
    } as unknown as Awaited<ReturnType<typeof initializePlugin>>;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawingBufferWidth: 950,
      drawingBufferHeight: 2942,
      RGBA: 0x1908,
      UNSIGNED_BYTE: 0x1401,
      readPixels: vi.fn(
        (
          _x: number,
          _y: number,
          _width: number,
          _height: number,
          _format: number,
          _type: number,
          pixels: Uint8Array
        ) => pixels.set([0, 0, 0, 0])
      ),
    } as unknown as WebGLRenderingContext);
    vi.mocked(initializePlugin).mockResolvedValue(plugin);
    vi.mocked(loadStructure).mockResolvedValue(undefined);

    const cached = await createViewerContainer({
      structureKey: 'provider:AF:sampler-miss:F1:V6',
      uniprotId: 'sampler-miss',
      onError,
      onComplete,
    });

    await vi.advanceTimersByTimeAsync(500);

    expect(cached.isLoading).toBe(false);
    expect(cached.error).toBeNull();
    expect(cached.container.querySelector('canvas')?.style.visibility).toBe('visible');
    expect(onError).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(
      (
        window as typeof window & {
          __structureLoadTelemetry?: Array<{ event: string; firstPaintResolution?: string }>;
        }
      ).__structureLoadTelemetry?.at(-1)
    ).toMatchObject({ event: 'finished', firstPaintResolution: 'molstar-draw-signal' });
  });

  it('runs the before-reveal hook after structure load and before exposing the canvas', async () => {
    const events: string[] = [];
    installPaintedWebglProbe();
    const plugin = createReadyPlugin();
    vi.mocked(initializePlugin).mockResolvedValue(plugin);
    vi.mocked(registerMolecularRenderProfileVisuals).mockImplementation((registeredPlugin) => {
      expect(registeredPlugin).toBe(plugin);
      events.push('register-representations');
    });
    vi.mocked(loadStructure).mockImplementation(async () => {
      events.push('load-structure');
    });

    const cached = await createViewerContainer({
      structureKey: 'provider:RCSB:1FS0:ENTRY',
      pdbId: '1FS0',
      onBeforeReveal: async (loadedPlugin) => {
        expect(loadedPlugin).toBe(plugin);
        events.push(`before-reveal:${cached.container.querySelector('canvas')?.style.visibility}`);
      },
      onLoad: () => events.push('on-load'),
      onComplete: () => events.push('on-complete'),
    });

    await vi.runAllTimersAsync();

    expect(events).toEqual([
      'register-representations',
      'load-structure',
      'before-reveal:hidden',
      'on-load',
      'on-complete',
    ]);
    expect(yieldToMain).toHaveBeenCalledTimes(3);
    expect(cached.container.querySelector('canvas')?.style.visibility).toBe('visible');
  });

  it('does not overwrite a newer pane target when initial construction finishes', async () => {
    installPaintedWebglProbe();
    vi.mocked(initializePlugin).mockResolvedValue(createReadyPlugin());
    let resolveLoad!: () => void;
    vi.mocked(loadStructure).mockReturnValue(
      new Promise<void>((resolve) => {
        resolveLoad = resolve;
      })
    );

    const cached = await createViewerContainer({
      structureKey: 'structure:A',
      pdbId: '1AAA',
    });
    expect(cached.rendererHostActivation?.requestedStructureKey).toBe('structure:A');

    requestRendererHostStructure(cached.rendererHostActivation!, 'structure:B');
    resolveLoad();
    await vi.runAllTimersAsync();

    expect(cached.isInitializing).toBe(false);
    expect(cached.loadedStructureKey).toBe('structure:A');
    expect(cached.rendererHostActivation).toMatchObject({
      loadedStructureKey: 'structure:A',
      requestedStructureKey: 'structure:B',
    });
  });

  it('treats a cancelled before-reveal hook as an internal cache eviction signal, not a user-facing load error', async () => {
    const onError = vi.fn();
    const onLoad = vi.fn();
    const onComplete = vi.fn();
    vi.mocked(initializePlugin).mockResolvedValue(
      {} as Awaited<ReturnType<typeof initializePlugin>>
    );
    vi.mocked(loadStructure).mockResolvedValue(undefined);

    const cached = await createViewerContainer({
      structureKey: 'provider:RCSB:1FS0:ENTRY',
      pdbId: '1FS0',
      onBeforeReveal: () => ({ status: 'cancelled' }),
      onError,
      onLoad,
      onComplete,
    });

    await vi.runAllTimersAsync();

    expect(cached.isLoading).toBe(false);
    expect(cached.error).toBe(CANCELLED_VIEWER_LOAD_ERROR);
    expect(cached.container.querySelector('canvas')?.style.visibility).toBe('hidden');
    expect(onError).not.toHaveBeenCalled();
    expect(onLoad).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalled();
  });

  it('does not render raw before-reveal diagnostics into the loading overlay', async () => {
    const rawDiagnostic =
      '[MolstarViewer:before-reveal] Structure render plan expected detail chains. {"targetId":"g-g-25-asm_1-g","selection":{"chainIds":["G"]}}';
    const onError = vi.fn();
    const onComplete = vi.fn();
    vi.mocked(initializePlugin).mockResolvedValue(
      {} as Awaited<ReturnType<typeof initializePlugin>>
    );
    vi.mocked(loadStructure).mockResolvedValue(undefined);

    const cached = await createViewerContainer({
      structureKey: 'provider:RCSB:3OAA:ENTRY',
      pdbId: '3OAA',
      onBeforeReveal: () => {
        throw new Error(rawDiagnostic);
      },
      onError,
      onComplete,
    });

    await vi.runAllTimersAsync();

    expect(cached.error).toBe(rawDiagnostic);
    expect(cached.container.querySelector('.molstar-loading')).toHaveTextContent(
      MOLSTAR_VIEWER_GENERIC_LOADING_ERROR
    );
    expect(cached.container.querySelector('.molstar-loading')).not.toHaveTextContent('targetId');
    expect(onError).toHaveBeenCalledWith(rawDiagnostic);
    expect(onComplete).toHaveBeenCalled();
  });
});
