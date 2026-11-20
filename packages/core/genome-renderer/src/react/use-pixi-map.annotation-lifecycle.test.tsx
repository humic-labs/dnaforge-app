// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AnnotationFlatPresentationSnapshot,
  AnnotationResidentPagePublication,
  Genome,
} from '@waypoint/genome-renderer';
import { IndexedPixiLinearRenderer, PixiLinearRenderer } from '@waypoint/genome-renderer';
import {
  useIndexedPixiMap,
  usePixiMap,
  type PixiMapHandle,
  type UsePixiMapOptions,
} from './use-pixi-map';
import type { WebGLFatalFrameError } from './webgl-render-loop';
import { disposeRetainedPixiApplications } from './pixi-application-retention';

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const lifecycle = vi.hoisted(() => ({
  instances: [] as Array<{
    loadedGenome: Genome | null;
    currentSnapshot: AnnotationFlatPresentationSnapshot | AnnotationResidentPagePublication | null;
    destroyed: boolean;
  }>,
  events: [] as string[],
  appInitGate: null as Deferred | null,
  appInitPartialFailureGate: null as Deferred | null,
  initGate: null as Deferred | null,
  appInitFailures: 0,
  appInitPreferences: [] as unknown[],
  rendererInitFailures: 0,
  appDestroyCount: 0,
  canvasConnectedAtClear: [] as boolean[],
  eventTargetDetachCount: 0,
  globalResourceReleaseCount: 0,
  measurementCacheClearCount: 0,
  applications: [] as Array<{
    canvas: HTMLCanvasElement;
    stage: { children: object[]; destroyed: boolean } | null;
  }>,
  interactionCleanupCount: 0,
  interactionMotionCancelCount: 0,
  hoverHitTestInvalidationCount: 0,
  intersectionCallbacks: [] as Array<(entries: Array<{ isIntersecting: boolean }>) => void>,
  geometryDependentCamera: false,
  resizeCallbacks: [] as Array<(entries?: Pick<ResizeObserverEntry, 'contentRect'>[]) => void>,
  resizeCalls: [] as Array<{ width: number; height: number; reason: string }>,
  loadGates: new Map<string, Deferred[]>(),
  mutateBeforeLoadAwait: false,
  getPresentedGenome: vi.fn<() => Genome | null>(() => null),
  fatalFrame: null as ((failure: WebGLFatalFrameError) => void) | null,
  intersections: [] as Array<(isIntersecting: boolean) => void>,
  animationFrames: [] as FrameRequestCallback[],
  appliedThemeModes: [] as Array<'light' | 'dark'>,
  themeObserverInstallCount: 0,
  renderRevisionRef: null as { current: number } | null,
  renderNowCount: 0,
  presentedFrameListenersRef: null as {
    current: Set<(receipt: { frameEpoch: number; presentedAtMs: number }) => void>;
  } | null,
  resumeCount: 0,
}));

const webglTestHooks = vi.hoisted(() => ({
  clear: vi.fn(),
  expose: vi.fn(),
  updateGenome: vi.fn(),
}));

vi.mock('pixi.js', () => ({
  CanvasTextMetrics: {
    clearMeasurementCache: vi.fn(() => {
      lifecycle.measurementCacheClearCount += 1;
    }),
  },
  GlobalResourceRegistry: {
    release: vi.fn(() => {
      lifecycle.globalResourceReleaseCount += 1;
    }),
  },
  Application: class MockApplication {
    canvas = document.createElement('canvas');
    stage: { children: object[]; destroyed: boolean } | null = null;
    ticker = { stop: vi.fn() };
    renderer: ReturnType<typeof this.createRenderer> | null = this.createRenderer();
    private createRenderer() {
      return {
        resize: vi.fn(),
        resolution: 1,
        events: {
          setTargetElement: vi.fn((target: HTMLCanvasElement | null) => {
            if (target === null) lifecycle.eventTargetDetachCount += 1;
          }),
        },
      };
    }
    constructor() {
      lifecycle.applications.push(this);
    }
    async init(options: { preference?: unknown }) {
      lifecycle.appInitPreferences.push(options.preference);
      if (lifecycle.appInitFailures > 0) {
        lifecycle.appInitFailures -= 1;
        throw new Error('injected Pixi init failure');
      }
      const gate = lifecycle.appInitGate;
      if (gate) {
        this.renderer = null;
        await gate.promise;
        this.renderer = this.createRenderer();
      }
      const partialFailureGate = lifecycle.appInitPartialFailureGate;
      if (partialFailureGate) {
        this.renderer = null;
        try {
          await partialFailureGate.promise;
        } catch (error) {
          this.renderer = this.createRenderer();
          throw error;
        }
      }
      this.stage = { children: [], destroyed: false };
    }
    destroy() {
      lifecycle.appDestroyCount += 1;
      this.stage = null;
      this.renderer = null;
    }
  },
}));

vi.mock('@waypoint/genome-renderer', () => {
  class MockLinearRenderer {
    loadedGenome: Genome | null = null;
    currentSnapshot: AnnotationFlatPresentationSnapshot | AnnotationResidentPagePublication | null =
      null;
    destroyed = false;

    constructor() {
      lifecycle.instances.push(this);
    }

    get genome() {
      return this.loadedGenome;
    }

    requireCompiledBroadSurface(requirement: { genomeLengthBp: number }) {
      lifecycle.events.push(`require-broad:${requirement.genomeLengthBp}`);
      return true;
    }

    async init(_app: unknown, genome: Genome) {
      lifecycle.events.push(`init-start:${genome.sourceIdentity ?? genome.name}`);
      this.loadedGenome = genome;
      if (lifecycle.rendererInitFailures > 0) {
        lifecycle.rendererInitFailures -= 1;
        throw new Error('injected renderer init failure');
      }
      const gate = lifecycle.initGate;
      if (gate) await gate.promise;
      lifecycle.events.push(`init-complete:${genome.sourceIdentity ?? genome.name}`);
    }

    async loadGenome(genome: Genome) {
      const source = genome.sourceIdentity ?? genome.name;
      lifecycle.events.push(`load-start:${source}`);
      if (lifecycle.mutateBeforeLoadAwait) this.loadedGenome = genome;
      const gate = lifecycle.loadGates.get(source)?.shift();
      if (gate) await gate.promise;
      this.loadedGenome = genome;
      this.currentSnapshot = null;
      lifecycle.events.push(`load-complete:${source}`);
    }

    setAnnotationFlatPresentationSnapshot(snapshot: AnnotationFlatPresentationSnapshot) {
      const loadedSource = this.loadedGenome?.sourceIdentity ?? this.loadedGenome?.name;
      if (loadedSource !== snapshot.sourceIdentity) {
        lifecycle.events.push(`snapshot-rejected:${snapshot.sourceIdentity}`);
        return { status: 'rejected' as const, reason: 'source-mismatch' as const };
      }
      if (this.currentSnapshot === snapshot) {
        lifecycle.events.push(`snapshot-noop:${snapshot.sourceIdentity}:${snapshot.generation}`);
        return { status: 'noop' as const, generation: snapshot.generation };
      }
      this.currentSnapshot = snapshot;
      lifecycle.events.push(`snapshot:${snapshot.sourceIdentity}:${snapshot.generation}`);
      return {
        status: 'applied' as const,
        generation: snapshot.generation,
        invalidatedHover: true as const,
      };
    }

    ingestAnnotationResidentPages(publication: AnnotationResidentPagePublication) {
      const loadedSource = this.loadedGenome?.sourceIdentity ?? this.loadedGenome?.name;
      if (loadedSource !== publication.sourceIdentity) {
        lifecycle.events.push(`pages-rejected:${publication.sourceIdentity}`);
        return { status: 'rejected' as const, reason: 'source-mismatch' as const };
      }
      if (this.currentSnapshot === publication) {
        lifecycle.events.push(`pages-noop:${publication.sourceIdentity}:${publication.generation}`);
        return { status: 'noop' as const, generation: publication.generation };
      }
      this.currentSnapshot = publication;
      lifecycle.events.push(`pages:${publication.sourceIdentity}:${publication.generation}`);
      return {
        status: 'applied' as const,
        generation: publication.generation,
        invalidatedHover: true as const,
      };
    }

    setCutSites() {}
    setSequenceWindow() {}
    setAnnotationsVisible() {}
    getViewCenterBp(state: {
      viewOffset: number;
      width: number;
      height: number;
      geometryHeight?: number;
      morph?: number;
    }) {
      const geometryOffset = lifecycle.geometryDependentCamera
        ? state.width +
          state.height +
          (state.geometryHeight ?? state.height) +
          (state.morph ?? 0) * 1000
        : 0;
      return state.viewOffset * (this.loadedGenome?.length ?? 1) + geometryOffset;
    }

    setViewCenterBp(
      bp: number,
      state: {
        viewOffset: number;
        width: number;
        height: number;
        geometryHeight?: number;
        morph?: number;
      }
    ) {
      lifecycle.events.push(`camera-center:${bp}`);
      const geometryOffset = lifecycle.geometryDependentCamera
        ? state.width +
          state.height +
          (state.geometryHeight ?? state.height) +
          (state.morph ?? 0) * 1000
        : 0;
      state.viewOffset = (bp - geometryOffset) / (this.loadedGenome?.length ?? 1);
    }
    destroy() {
      this.destroyed = true;
    }
  }

  class MockIndexedLinearRenderer extends MockLinearRenderer {}

  return {
    PixiLinearRenderer: MockLinearRenderer,
    IndexedPixiLinearRenderer: MockIndexedLinearRenderer,
    PixiStadiumRenderer: MockLinearRenderer,
    perfLog: vi.fn(),
    perfMark: vi.fn(),
    perfTimeAsync: async (_label: string, work: () => unknown) => await work(),
    genomeFeatures: (genome: Genome) => genome.features ?? [],
    recordWebGLTrace: vi.fn(),
    registerWebGLInstance: vi.fn(),
    unregisterWebGLInstance: vi.fn(),
    webglThemeForMode: () => ({ background: 0xffffff }),
    applySelectionAction: vi.fn(),
  };
});

vi.mock('./pixi-canvas', () => ({
  clearPixiCanvas: (app: { canvas: HTMLCanvasElement }) => {
    lifecycle.canvasConnectedAtClear.push(app.canvas.isConnected);
  },
  resizePixiCanvas: (
    app: { canvas?: HTMLCanvasElement },
    width: number,
    height: number,
    reason: string
  ) => {
    lifecycle.resizeCalls.push({ width, height, reason });
    const backingChanged = app.canvas?.width !== width || app.canvas?.height !== height;
    if (app.canvas) {
      app.canvas.width = width;
      app.canvas.height = height;
    }
    return { width, height, backingChanged };
  },
}));
vi.mock('./pixi-theme', () => ({
  applyPixiTheme: (_app: unknown, mode: 'light' | 'dark') => {
    lifecycle.appliedThemeModes.push(mode);
  },
  currentWebGLThemeMode: () => 'light',
  installWebGLThemeObserver: () => {
    lifecycle.themeObserverInstallCount += 1;
    return () => undefined;
  },
}));
vi.mock('./webgl-test-hooks', () => ({
  clearWebGLTestHooks: webglTestHooks.clear,
  exposeWebGLTestHooks: webglTestHooks.expose,
  updateWebGLTestHookGenome: webglTestHooks.updateGenome,
}));
vi.mock('./interaction-adapter', () => ({
  attachPixiInteractionAdapter: () => ({
    cancelMotion: () => {
      lifecycle.interactionMotionCancelCount += 1;
    },
    cleanup: () => {
      lifecycle.interactionCleanupCount += 1;
    },
    invalidateHoverHitTest: () => {
      lifecycle.hoverHitTestInvalidationCount += 1;
    },
  }),
}));
vi.mock('./webgl-render-loop', () => ({
  startWebGLRenderLoop: (input: {
    getPresentedGenome?: () => Genome | null;
    onFatalFrameError: (failure: WebGLFatalFrameError) => void;
    renderRevisionRef: { current: number };
    presentedFrameListenersRef: {
      current: Set<(receipt: { frameEpoch: number; presentedAtMs: number }) => void>;
    };
  }) => {
    lifecycle.events.push('render-loop-start');
    lifecycle.getPresentedGenome.mockImplementation(input.getPresentedGenome ?? (() => null));
    lifecycle.fatalFrame = input.onFatalFrameError;
    lifecycle.renderRevisionRef = input.renderRevisionRef;
    lifecycle.presentedFrameListenersRef = input.presentedFrameListenersRef;
    return {
      wake: vi.fn(),
      stop: vi.fn(),
      resume: vi.fn(() => {
        lifecycle.resumeCount += 1;
      }),
      renderNow: vi.fn(() => {
        lifecycle.renderNowCount += 1;
      }),
    };
  },
}));

function genome(sourceIdentity: string): Genome {
  return {
    name: sourceIdentity,
    sourceIdentity,
    length: 1_000_000,
    circular: false,
  };
}

function snapshot(sourceIdentity: string, generation = 0): AnnotationFlatPresentationSnapshot {
  return {
    contract: 'annotation-presentation-snapshot.v1',
    sourceIdentity,
    genomeLengthBp: 1_000_000,
    policyKey: 'mRNA:canonical:12',
    generation,
    features: [],
    requestedLayerTypes: ['mRNA'],
    layout: { maxAnnotationLane: 11, maxCdsLane: -1 },
    exactCoverage: [],
  };
}

function residentPages(sourceIdentity: string, generation = 0): AnnotationResidentPagePublication {
  return {
    contract: 'annotation-resident-page-publication.v1',
    sourceIdentity,
    genomeLengthBp: 1_000_000,
    policyKey: 'mRNA:source-pages',
    generation,
    requestedLayerTypes: ['mRNA'],
    exactCoverage: [],
    pages: [],
  };
}

let latestHandle: PixiMapHandle | null = null;

function Harness(
  props: Pick<
    UsePixiMapOptions,
    | 'genome'
    | 'hiddenMapIdlePolicy'
    | 'compiledBroadSurfaceRequirement'
    | 'annotationPresentationSnapshot'
    | 'annotationResidentPagePublication'
    | 'themeMode'
    | 'onRendererReady'
    | 'onRendererGenomeCommit'
    | 'onCameraChange'
    | 'geometryHeight'
    | 'morph'
    | 'backboneSegments'
    | 'performanceMode'
    | 'surfaceVisible'
  > &
    Partial<Pick<UsePixiMapOptions, 'width' | 'height'>> & { indexed?: boolean }
) {
  const hook = props.indexed ? useIndexedPixiMap : usePixiMap;
  const { containerRef, handle } = hook({
    genome: props.genome,
    surfaceVisible: props.surfaceVisible,
    hiddenMapIdlePolicy: props.hiddenMapIdlePolicy,
    compiledBroadSurfaceRequirement: props.compiledBroadSurfaceRequirement,
    annotationPresentationSnapshot: props.annotationPresentationSnapshot,
    annotationResidentPagePublication: props.annotationResidentPagePublication,
    themeMode: props.themeMode,
    circular: false,
    width: props.width ?? 800,
    height: props.height ?? 500,
    geometryHeight: props.geometryHeight,
    morph: props.morph,
    backboneSegments: props.backboneSegments,
    performanceMode: props.performanceMode,
    onRendererReady: props.onRendererReady,
    onRendererGenomeCommit: props.onRendererGenomeCommit,
    onCameraChange: props.onCameraChange,
  });
  latestHandle = handle;
  return <div ref={containerRef} />;
}

describe('usePixiMap annotation/source lifecycle', () => {
  afterEach(() => {
    cleanup();
    disposeRetainedPixiApplications();
  });

  beforeEach(() => {
    lifecycle.instances.length = 0;
    lifecycle.events.length = 0;
    lifecycle.appInitGate = null;
    lifecycle.appInitPartialFailureGate = null;
    lifecycle.initGate = null;
    lifecycle.appInitFailures = 0;
    lifecycle.appInitPreferences.length = 0;
    lifecycle.rendererInitFailures = 0;
    lifecycle.appDestroyCount = 0;
    lifecycle.eventTargetDetachCount = 0;
    lifecycle.globalResourceReleaseCount = 0;
    lifecycle.measurementCacheClearCount = 0;
    lifecycle.applications.length = 0;
    lifecycle.canvasConnectedAtClear.length = 0;
    lifecycle.resizeCalls.length = 0;
    lifecycle.interactionCleanupCount = 0;
    lifecycle.interactionMotionCancelCount = 0;
    lifecycle.hoverHitTestInvalidationCount = 0;
    lifecycle.intersectionCallbacks.length = 0;
    lifecycle.geometryDependentCamera = false;
    lifecycle.resizeCallbacks.length = 0;
    lifecycle.resizeCalls.length = 0;
    lifecycle.loadGates.clear();
    lifecycle.mutateBeforeLoadAwait = false;
    lifecycle.getPresentedGenome.mockReset().mockReturnValue(null);
    lifecycle.fatalFrame = null;
    lifecycle.intersections.length = 0;
    lifecycle.animationFrames.length = 0;
    lifecycle.appliedThemeModes.length = 0;
    lifecycle.themeObserverInstallCount = 0;
    lifecycle.renderRevisionRef = null;
    lifecycle.renderNowCount = 0;
    lifecycle.presentedFrameListenersRef = null;
    lifecycle.resumeCount = 0;
    webglTestHooks.clear.mockClear();
    webglTestHooks.expose.mockClear();
    webglTestHooks.updateGenome.mockClear();
    latestHandle = null;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(private callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
          lifecycle.intersections.push((isIntersecting) => this.callback([{ isIntersecting }]));
          lifecycle.intersectionCallbacks.push(callback);
        }
        observe() {
          queueMicrotask(() => this.callback([{ isIntersecting: true }]));
        }
        disconnect() {}
      }
    );
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: (entries?: Pick<ResizeObserverEntry, 'contentRect'>[]) => void) {
          lifecycle.resizeCallbacks.push(callback);
        }
        observe() {}
        disconnect() {}
      }
    );
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        lifecycle.animationFrames.push(callback);
        return lifecycle.animationFrames.length;
      })
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  it('constructs IndexedPixiLinearRenderer when annotationHost is indexed', async () => {
    render(<Harness genome={genome('indexed')} indexed />);
    await waitFor(() => expect(latestHandle?.getLinearRenderer()).not.toBeNull());
    expect(latestHandle?.getLinearRenderer()).toBeInstanceOf(IndexedPixiLinearRenderer);
  });

  it('constructs PixiLinearRenderer when annotationHost is omitted', async () => {
    render(<Harness genome={genome('sequence')} />);
    await waitFor(() => expect(latestHandle?.getLinearRenderer()).not.toBeNull());
    expect(latestHandle?.getLinearRenderer()).toBeInstanceOf(PixiLinearRenderer);
    expect(latestHandle?.getLinearRenderer()).not.toBeInstanceOf(IndexedPixiLinearRenderer);
  });

  it.each([false, true])(
    'requests only the supported WebGL backend for indexed=%s',
    async (indexed) => {
      render(<Harness genome={genome('backend')} indexed={indexed} />);
      await waitFor(() => expect(latestHandle?.getLinearRenderer()).not.toBeNull());
      expect(lifecycle.appInitPreferences).toEqual([['webgl']]);
    }
  );

  it('reinitializes from the live genome after the performance mode changes', async () => {
    const source = genome('performance-mode-source');
    const view = render(<Harness genome={source} performanceMode="default" />);

    await waitFor(() => expect(lifecycle.instances).toHaveLength(1));
    await waitFor(() => expect(lifecycle.instances[0]?.loadedGenome).toBe(source));

    view.rerender(<Harness genome={source} performanceMode="stability" />);

    await waitFor(() => expect(lifecycle.instances).toHaveLength(2));
    await waitFor(() => expect(lifecycle.instances[1]?.loadedGenome).toBe(source));
    expect(lifecycle.instances[0]?.destroyed).toBe(true);
  });

  it('keeps component-lifetime presented-frame subscribers across renderer reinitialization', async () => {
    const source = genome('persistent-frame-subscriber');
    const listener = vi.fn();
    const view = render(<Harness genome={source} performanceMode="default" />);

    await waitFor(() => expect(lifecycle.instances).toHaveLength(1));
    act(() => {
      latestHandle?.subscribeToPresentedFrames(listener);
    });
    const state = latestHandle?.getState();
    state?.selectedIds.add(31);
    state?.selectedCanonicalIdentities?.add('canonical-TX31');
    expect(lifecycle.presentedFrameListenersRef?.current.has(listener)).toBe(true);

    view.rerender(<Harness genome={source} performanceMode="stability" />);

    await waitFor(() => expect(lifecycle.instances).toHaveLength(2));
    expect(lifecycle.presentedFrameListenersRef?.current.has(listener)).toBe(true);
    expect(state?.selectedIds.has(31)).toBe(true);
    expect(state?.selectedCanonicalIdentities?.has('canonical-TX31')).toBe(true);

    view.unmount();
    expect(lifecycle.presentedFrameListenersRef?.current.size).toBe(0);
    expect(state?.selectedIds.size).toBe(0);
    expect(state?.selectedCanonicalIdentities?.size).toBe(0);
  });

  it('resumes the retained render loop when a hidden map becomes visible', async () => {
    render(<Harness genome={genome('visibility-resume')} />);
    await waitFor(() => expect(latestHandle?.getLinearRenderer()).not.toBeNull());
    const baselineResumeCount = lifecycle.resumeCount;

    act(() => {
      lifecycle.intersections[0]?.(false);
      lifecycle.intersections[0]?.(true);
    });

    expect(lifecycle.resumeCount).toBe(baselineResumeCount + 1);
  });

  it('component visibility keeps only the three most-recently-hidden Pixi apps alive', async () => {
    render(
      <>
        <Harness genome={genome('A')} hiddenMapIdlePolicy="bounded-lru" />
        <Harness genome={genome('B')} hiddenMapIdlePolicy="bounded-lru" />
        <Harness genome={genome('C')} hiddenMapIdlePolicy="bounded-lru" />
        <Harness genome={genome('D')} hiddenMapIdlePolicy="bounded-lru" />
      </>
    );

    await waitFor(() => expect(lifecycle.instances).toHaveLength(4));
    await waitFor(() =>
      expect(lifecycle.events.filter((event) => event.startsWith('init-complete:'))).toHaveLength(4)
    );

    act(() => {
      for (const setIntersecting of lifecycle.intersections) {
        setIntersecting(false);
      }
    });

    expect(lifecycle.appDestroyCount).toBe(1);
    expect(lifecycle.instances.map((instance) => instance.destroyed)).toEqual([
      true,
      false,
      false,
      false,
    ]);
  });

  it('does not evict the oldest retained app after its portal is reattached', async () => {
    const hosts = ['A', 'B', 'C', 'D'].map(() => {
      const host = document.createElement('div');
      document.body.appendChild(host);
      return host;
    });
    ['A', 'B', 'C', 'D'].forEach((sourceIdentity, index) => {
      render(<Harness genome={genome(sourceIdentity)} hiddenMapIdlePolicy="bounded-lru" />, {
        container: hosts[index],
      });
    });

    await waitFor(() => expect(lifecycle.instances).toHaveLength(4));
    await waitFor(() =>
      expect(lifecycle.events.filter((event) => event.startsWith('init-complete:'))).toHaveLength(4)
    );

    act(() => {
      for (let index = 0; index < 3; index += 1) {
        hosts[index].remove();
        lifecycle.intersections[index]?.(false);
      }
    });
    expect(lifecycle.instances.map((instance) => instance.destroyed)).toEqual([
      false,
      false,
      false,
      false,
    ]);

    act(() => {
      document.body.appendChild(hosts[0]);
      window.dispatchEvent(new CustomEvent('waypoint:tab-portal-host-attached'));
      hosts[3].remove();
      lifecycle.intersections[3]?.(false);
    });

    expect(lifecycle.instances.map((instance) => instance.destroyed)).toEqual([
      false,
      false,
      false,
      false,
    ]);

    act(() => {
      const frames = lifecycle.animationFrames.splice(0);
      frames.forEach((frame) => frame(performance.now()));
    });
    expect(lifecycle.instances).toHaveLength(4);
    expect(lifecycle.instances[0]?.destroyed).toBe(false);
  });

  it('does not resize through a three-frame portal reattach width transient', async () => {
    const view = render(<Harness genome={genome('A')} hiddenMapIdlePolicy="bounded-lru" />);
    await waitFor(() => expect(latestHandle?.getLinearRenderer()).not.toBeNull());

    const host = view.container.firstElementChild as HTMLDivElement;
    let measuredWidth = 279;
    vi.spyOn(host, 'getBoundingClientRect').mockImplementation(() => ({
      x: 0,
      y: 0,
      width: measuredWidth,
      height: 689,
      top: 0,
      right: measuredWidth,
      bottom: 689,
      left: 0,
      toJSON: () => ({}),
    }));
    lifecycle.resizeCalls.length = 0;

    act(() => {
      window.dispatchEvent(new CustomEvent('waypoint:tab-portal-host-attached'));
    });

    for (const width of [279, 519, 519, 519, 279, 279, 279, 279]) {
      act(() => {
        measuredWidth = width;
        const frame = lifecycle.animationFrames.shift();
        if (!frame) throw new Error(`missing settle frame for width ${width}`);
        frame(performance.now());
        lifecycle.resizeCallbacks[0]?.();
      });
    }

    expect(lifecycle.resizeCalls.filter((call) => call.width === 519)).toEqual([]);
  });

  it('applies matching content before an immediate renderer becomes observable', async () => {
    const sourceA = genome('A');
    const snapshotA = snapshot('A');
    render(<Harness genome={sourceA} annotationPresentationSnapshot={snapshotA} />);

    await waitFor(() => expect(latestHandle?.getLinearRenderer()).not.toBeNull());
    const renderer = lifecycle.instances[0];
    expect(renderer.loadedGenome).toBe(sourceA);
    expect(renderer.currentSnapshot).toBe(snapshotA);
    expect(lifecycle.events.indexOf('snapshot:A:0')).toBeGreaterThan(
      lifecycle.events.indexOf('init-complete:A')
    );
  });

  it('mounts and commits coordinate content when both annotation sidecars are absent', async () => {
    const readyEpochs: number[] = [];
    const contentEpochs: number[] = [];
    const sourceA = genome('A');

    render(
      <Harness
        genome={sourceA}
        onRendererReady={(epoch) => readyEpochs.push(epoch)}
        onRendererGenomeCommit={(epoch) => contentEpochs.push(epoch)}
      />
    );

    await waitFor(() => expect(latestHandle?.getLinearRenderer()).not.toBeNull());
    expect(lifecycle.instances).toHaveLength(1);
    expect(lifecycle.instances[0]?.loadedGenome).toBe(sourceA);
    expect(lifecycle.instances[0]?.currentSnapshot).toBeNull();
    expect(contentEpochs).toEqual([1]);
    expect(readyEpochs).toEqual([1]);
  });

  it('applies an explicit React theme and invalidates without remounting or loading the genome', async () => {
    const sourceA = genome('A');
    const view = render(<Harness genome={sourceA} themeMode="light" />);

    await waitFor(() => expect(latestHandle?.getLinearRenderer()).not.toBeNull());
    const renderer = lifecycle.instances[0];
    const application = lifecycle.applications[0];
    const revisionBefore = lifecycle.renderRevisionRef?.current ?? -1;

    view.rerender(<Harness genome={sourceA} themeMode="dark" />);

    await waitFor(() => expect(latestHandle?.getState()?.themeMode).toBe('dark'));
    expect(lifecycle.appliedThemeModes.at(-1)).toBe('dark');
    expect(lifecycle.renderRevisionRef?.current).toBeGreaterThan(revisionBefore);
    expect(lifecycle.themeObserverInstallCount).toBe(0);
    expect(lifecycle.instances).toEqual([renderer]);
    expect(lifecycle.applications).toEqual([application]);
    expect(lifecycle.events.some((event) => event.startsWith('load-start:'))).toBe(false);
  });

  it('reconciles a stationary hover only after changed backbone geometry is presented', async () => {
    const source = genome('assembly');
    const initialSegments = [
      { regionId: 'part-a', start: 0, end: 400, color: 0x3b82f6 },
      { regionId: 'part-b', start: 400, end: 1_000, color: 0x22c55e },
    ];
    const reorderedSegments = [
      { regionId: 'part-b', start: 0, end: 600, color: 0x22c55e },
      { regionId: 'part-a', start: 600, end: 1_000, color: 0x3b82f6 },
    ];
    const view = render(<Harness genome={source} backboneSegments={initialSegments} />);

    await waitFor(() => expect(latestHandle?.getLinearRenderer()).not.toBeNull());
    lifecycle.hoverHitTestInvalidationCount = 0;
    lifecycle.presentedFrameListenersRef?.current.clear();
    const revisionBefore = lifecycle.renderRevisionRef?.current ?? -1;

    view.rerender(<Harness genome={source} backboneSegments={reorderedSegments} />);

    await waitFor(() =>
      expect(latestHandle?.getState()?.backboneSegments ?? null).toBe(reorderedSegments)
    );
    expect(lifecycle.hoverHitTestInvalidationCount).toBe(0);
    expect(lifecycle.presentedFrameListenersRef?.current.size).toBe(1);

    act(() => {
      for (const listener of Array.from(lifecycle.presentedFrameListenersRef?.current ?? [])) {
        listener({ frameEpoch: 2, presentedAtMs: performance.now() });
      }
    });

    expect(lifecycle.hoverHitTestInvalidationCount).toBe(1);
    expect(lifecycle.presentedFrameListenersRef?.current.size).toBe(0);
    expect(lifecycle.renderRevisionRef?.current).toBeGreaterThan(revisionBefore);
  });

  it('retires the exact exposed renderer before unmount teardown completes', async () => {
    const view = render(<Harness genome={genome('A')} />);
    await waitFor(() => expect(latestHandle?.getLinearRenderer()).not.toBeNull());
    const renderer = lifecycle.instances[0];
    expect(webglTestHooks.expose).toHaveBeenCalledWith(expect.objectContaining({ renderer }));

    view.unmount();

    expect(webglTestHooks.clear).toHaveBeenCalledOnce();
    expect(webglTestHooks.clear).toHaveBeenCalledWith(renderer);
  });

  it('detaches Pixi document listeners before destroying an application', async () => {
    const view = render(<Harness genome={genome('A')} />);
    await waitFor(() => expect(latestHandle?.getLinearRenderer()).not.toBeNull());

    view.unmount();

    expect(lifecycle.eventTargetDetachCount).toBe(1);
    expect(lifecycle.appDestroyCount).toBe(1);
  });

  it('reuses one empty-stage Pixi application while rebuilding scientific renderer state', async () => {
    const first = render(<Harness genome={genome('A')} hiddenMapIdlePolicy="bounded-lru" />);
    await waitFor(() => expect(latestHandle?.getLinearRenderer()).not.toBeNull());
    const application = lifecycle.applications[0];
    const firstRenderer = lifecycle.instances[0];

    first.unmount();

    expect(firstRenderer?.destroyed).toBe(true);
    expect(lifecycle.appDestroyCount).toBe(0);
    expect(lifecycle.measurementCacheClearCount).toBe(1);

    const second = render(<Harness genome={genome('B')} hiddenMapIdlePolicy="bounded-lru" />);
    await waitFor(() => expect(lifecycle.instances).toHaveLength(2));
    await waitFor(() => expect(latestHandle?.getLinearRenderer()).not.toBeNull());

    expect(lifecycle.applications).toEqual([application]);
    expect(lifecycle.instances[1]).not.toBe(firstRenderer);
    expect(lifecycle.instances[1]?.loadedGenome?.sourceIdentity).toBe('B');
    expect(lifecycle.appDestroyCount).toBe(0);

    second.unmount();
    expect(lifecycle.measurementCacheClearCount).toBe(2);
  });

  it('clears each canvas to the theme background before attaching it ', async () => {
    const first = render(<Harness genome={genome('A')} hiddenMapIdlePolicy="bounded-lru" />);
    await waitFor(() => expect(latestHandle?.getLinearRenderer()).not.toBeNull());
    first.unmount();
    render(<Harness genome={genome('B')} hiddenMapIdlePolicy="bounded-lru" />);
    await waitFor(() => expect(lifecycle.instances).toHaveLength(2));

    expect(lifecycle.applications).toHaveLength(1);
    expect(lifecycle.canvasConnectedAtClear).toEqual([false, false]);
  });

  it('destroys rather than pools an application whose renderer leaves a stage owner', async () => {
    const view = render(<Harness genome={genome('A')} hiddenMapIdlePolicy="bounded-lru" />);
    await waitFor(() => expect(latestHandle?.getLinearRenderer()).not.toBeNull());
    lifecycle.applications[0]?.stage?.children.push({});

    view.unmount();

    expect(lifecycle.appDestroyCount).toBe(1);
  });

  it('releases global Pixi pools only after the last application is destroyed', async () => {
    const first = render(<Harness genome={genome('A')} />);
    const second = render(<Harness genome={genome('B')} />);
    await waitFor(() => expect(lifecycle.applications).toHaveLength(2));
    await waitFor(() => expect(lifecycle.instances).toHaveLength(2));

    first.unmount();
    expect(lifecycle.globalResourceReleaseCount).toBe(0);

    second.unmount();
    expect(lifecycle.globalResourceReleaseCount).toBe(1);
  });

  it('retries teardown after an application finishes initializing behind an unmount', async () => {
    const appInitGate = deferred();
    lifecycle.appInitGate = appInitGate;
    const view = render(<Harness genome={genome('A')} />);
    await waitFor(() => expect(lifecycle.applications).toHaveLength(1));

    view.unmount();
    expect(lifecycle.eventTargetDetachCount).toBe(0);

    await act(async () => {
      appInitGate.resolve();
      await appInitGate.promise;
    });
    await waitFor(() => expect(lifecycle.appDestroyCount).toBe(1));

    expect(lifecycle.eventTargetDetachCount).toBe(1);
  });

  it('tears down a partial renderer when initialization rejects behind an unmount', async () => {
    const failureGate = deferred();
    lifecycle.appInitPartialFailureGate = failureGate;
    const view = render(<Harness genome={genome('A')} />);
    await waitFor(() => expect(lifecycle.applications).toHaveLength(1));

    view.unmount();
    expect(lifecycle.appDestroyCount).toBe(0);

    await act(async () => {
      failureGate.reject(new Error('injected partial Pixi initialization failure'));
      await Promise.resolve();
    });
    await waitFor(() => expect(lifecycle.appDestroyCount).toBe(1));

    expect(lifecycle.eventTargetDetachCount).toBe(1);
    expect(lifecycle.globalResourceReleaseCount).toBe(1);
  });

  it('keeps shared viewport metadata independent from zoom and camera state', async () => {
    const onCameraChange = vi.fn();
    render(<Harness genome={genome('A')} onCameraChange={onCameraChange} />);

    await waitFor(() => expect(latestHandle?.getLinearRenderer()).not.toBeNull());
    const state = latestHandle?.getState();
    expect(state).not.toBeNull();

    act(() => {
      latestHandle?.setZoom(2);
      if (state) state.viewOffset = 0.25;
      latestHandle?.setViewport(100_000, 200_000);
    });

    expect(state?.viewportRange).toEqual([100_000, 200_000]);
    expect(state?.zoom).toBe(2);
    expect(state?.viewOffset).toBe(0.25);
    expect(onCameraChange).not.toHaveBeenCalled();
    expect(lifecycle.events.some((event) => event.startsWith('camera-center:'))).toBe(false);
  });

  it('moves the camera only through the explicit indexed-viewer viewport API', async () => {
    const onCameraChange = vi.fn();
    render(<Harness genome={genome('A')} onCameraChange={onCameraChange} />);

    await waitFor(() => expect(latestHandle?.getLinearRenderer()).not.toBeNull());

    act(() => latestHandle?.setCameraViewport(100_000, 200_000));

    const state = latestHandle?.getState();
    expect(state?.viewportRange).toEqual([100_000, 200_000]);
    expect(state?.zoom).toBe(10);
    expect(state?.viewOffset).toBe(0.15);
    expect(lifecycle.events).toContain('camera-center:150000');
    expect(onCameraChange).toHaveBeenCalledOnce();
    expect(onCameraChange).toHaveBeenCalledWith(150_000, 'zoom', 10, {
      start: 100_000,
      end: 200_000,
    });
  });

  it('replaces a moving camera even when shared viewport metadata already matches', async () => {
    render(<Harness genome={genome('A')} />);
    await waitFor(() => expect(latestHandle?.getLinearRenderer()).not.toBeNull());
    act(() => latestHandle?.setViewport(100_000, 200_000));
    const state = latestHandle!.getState()!;
    state.zoom = 2;
    state.viewOffset = 0.25;
    const before = lifecycle.interactionMotionCancelCount;

    act(() => latestHandle?.setCameraViewport(100_000, 200_000));
    expect(lifecycle.interactionMotionCancelCount).toBe(before + 1);
    expect(state.zoom).toBe(10);
    expect(state.viewOffset).toBe(0.15);

    act(() => latestHandle?.setCameraViewport(100_000, 200_000));
    expect(lifecycle.interactionMotionCancelCount).toBe(before + 1);
  });

  it('publishes the committed camera readback when it differs from requested bounds', async () => {
    const onCameraChange = vi.fn();
    render(<Harness genome={genome('A')} onCameraChange={onCameraChange} />);
    await waitFor(() => expect(latestHandle?.getLinearRenderer()).not.toBeNull());
    const renderer = latestHandle!.getLinearRenderer()!;
    const committedCenter = 150_000.00000003;
    vi.spyOn(renderer, 'getViewCenterBp').mockReturnValue(committedCenter);

    let committed;
    act(() => {
      committed = latestHandle?.setCameraViewport(100_000, 200_000);
    });

    const actualRange = latestHandle!.getViewportRange();
    expect(actualRange).toEqual({
      start: committedCenter - 50_000,
      end: committedCenter + 50_000,
    });
    expect(actualRange).not.toEqual({ start: 100_000, end: 200_000 });
    expect(committed).toEqual(actualRange);
    expect(onCameraChange).toHaveBeenCalledOnce();
    expect(onCameraChange).toHaveBeenCalledWith(committedCenter, 'zoom', 10, actualRange);
  });

  it('reports imperative center synchronization as a programmatic camera change', async () => {
    const onCameraChange = vi.fn();
    render(<Harness genome={genome('A')} onCameraChange={onCameraChange} />);

    await waitFor(() => expect(latestHandle?.getLinearRenderer()).not.toBeNull());

    act(() => latestHandle?.setViewCenter(250_000));

    expect(lifecycle.events).toContain('camera-center:250000');
    expect(onCameraChange).toHaveBeenCalledOnce();
    expect(onCameraChange).toHaveBeenCalledWith(250_000, 'zoom', 1, {
      start: 0,
      end: 750_000,
    });
  });

  it('applies the latest center command after deferred renderer initialization', async () => {
    const initGate = deferred();
    lifecycle.initGate = initGate;
    render(<Harness genome={genome('A')} />);

    await waitFor(() => expect(lifecycle.events).toContain('init-start:A'));

    act(() => {
      latestHandle?.setViewCenter(100_000);
      latestHandle?.setViewCenter(250_000);
    });
    expect(lifecycle.events).not.toContain('camera-center:100000');
    expect(lifecycle.events).not.toContain('camera-center:250000');

    await act(async () => {
      initGate.resolve();
      await initGate.promise;
    });

    await waitFor(() => expect(latestHandle?.getLinearRenderer()).not.toBeNull());
    expect(lifecycle.events).not.toContain('camera-center:100000');
    expect(lifecycle.events).toContain('camera-center:250000');
    expect(latestHandle?.getState()?.viewOffset).toBe(0.25);
  });

  it('preserves the biological camera center while display geometry settles', async () => {
    lifecycle.geometryDependentCamera = true;
    render(<Harness genome={genome('A')} />);

    await waitFor(() => expect(latestHandle?.getLinearRenderer()).not.toBeNull());
    act(() => latestHandle?.setViewCenter(250_000));
    expect(latestHandle?.getCameraCenter()).toBe(250_000);

    act(() =>
      latestHandle?.setDisplaySize({
        width: 1_200,
        height: 600,
        geometryHeight: 540,
        morph: 0.5,
      })
    );

    expect(latestHandle?.getCameraCenter()).toBe(250_000);
    expect(lifecycle.events.filter((event) => event === 'camera-center:250000')).toHaveLength(2);
  });

  it('preserves the biological camera center across display-prop geometry reconciliation', async () => {
    lifecycle.geometryDependentCamera = true;
    const source = genome('A');
    const view = render(
      <Harness genome={source} width={800} height={500} geometryHeight={500} morph={0} />
    );

    await waitFor(() => expect(latestHandle?.getLinearRenderer()).not.toBeNull());
    act(() => latestHandle?.setViewCenter(250_000));
    expect(latestHandle?.getCameraCenter()).toBe(250_000);

    view.rerender(
      <Harness genome={source} width={1_200} height={600} geometryHeight={540} morph={0.5} />
    );

    expect(latestHandle?.getCameraCenter()).toBe(250_000);
    expect(lifecycle.events.filter((event) => event === 'camera-center:250000')).toHaveLength(2);
  });

  it('repaints synchronously when display props reallocate the canvas backing', async () => {
    const source = genome('A');
    const view = render(<Harness genome={source} width={800} height={500} />);

    await waitFor(() => expect(latestHandle?.getLinearRenderer()).not.toBeNull());
    const renderNowCountBeforeResize = lifecycle.renderNowCount;

    view.rerender(<Harness genome={source} width={1_200} height={600} />);

    expect(lifecycle.resizeCalls.at(-1)).toEqual({
      width: 1_200,
      height: 600,
      reason: 'display-props',
    });
    expect(lifecycle.renderNowCount).toBe(renderNowCountBeforeResize + 1);
  });

  it('draws a visible resize once when props and the container observer report the same size', async () => {
    const source = genome('A');
    const view = render(<Harness genome={source} width={800} height={500} />);
    await waitFor(() => expect(latestHandle?.getLinearRenderer()).not.toBeNull());

    view.rerender(<Harness genome={source} width={1_200} height={600} />);
    const drawn = lifecycle.renderNowCount;
    const resumed = lifecycle.resumeCount;
    act(() => lifecycle.resizeCallbacks[0]?.());

    expect(lifecycle.renderNowCount).toBe(drawn);
    expect(lifecycle.resumeCount).toBe(resumed);
  });

  it('repaints a map shape change before paint when the canvas dimensions stay the same', async () => {
    const source = genome('A');
    const view = render(<Harness genome={source} width={800} height={500} morph={0} />);
    await waitFor(() => expect(latestHandle?.getLinearRenderer()).not.toBeNull());
    const drawn = lifecycle.renderNowCount;

    view.rerender(<Harness genome={source} width={800} height={500} morph={1} />);

    expect(lifecycle.renderNowCount).toBe(drawn + 1);
  });

  it('keeps the attached map handle when only the pane dimensions change', async () => {
    const source = genome('A');
    const view = render(<Harness genome={source} width={800} height={500} />);
    await waitFor(() => expect(latestHandle?.getLinearRenderer()).not.toBeNull());
    const attached = latestHandle;

    view.rerender(<Harness genome={source} width={1_200} height={600} />);

    expect(latestHandle).toBe(attached);
  });

  it('leaves an occluded map idle when its host reports a zero-sized resize', async () => {
    render(<Harness genome={genome('A')} />);
    await waitFor(() => expect(latestHandle?.getLinearRenderer()).not.toBeNull());
    act(() => lifecycle.intersections[0]?.(false));
    const drawn = lifecycle.renderNowCount;
    const resumed = lifecycle.resumeCount;

    act(() => lifecycle.resizeCallbacks[0]?.([{ contentRect: new DOMRectReadOnly(0, 0, 0, 0) }]));

    expect(lifecycle.renderNowCount).toBe(drawn);
    expect(lifecycle.resumeCount).toBe(resumed);
  });

  it('paints a retained map on reveal before the intersection observer runs again', async () => {
    const source = genome('A');
    const view = render(<Harness genome={source} surfaceVisible={false} />);
    await waitFor(() => expect(latestHandle?.getLinearRenderer()).not.toBeNull());
    act(() => lifecycle.intersections[0]?.(false));
    const host = view.container.firstElementChild as HTMLElement;
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 500));
    const drawn = lifecycle.renderNowCount;

    view.rerender(<Harness genome={source} surfaceVisible />);

    expect(lifecycle.renderNowCount).toBe(drawn + 1);
  });

  it('preserves the biological camera center across live container resume geometry', async () => {
    lifecycle.geometryDependentCamera = true;
    const source = genome('A');
    const view = render(
      <Harness genome={source} width={800} height={500} geometryHeight={500} morph={0} />
    );

    await waitFor(() => expect(latestHandle?.getLinearRenderer()).not.toBeNull());
    act(() => latestHandle?.setViewCenter(250_000));
    expect(latestHandle?.getCameraCenter()).toBe(250_000);

    const host = view.container.firstElementChild as HTMLDivElement;
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      width: 1_200,
      height: 600,
      top: 0,
      right: 1_200,
      bottom: 600,
      left: 0,
      toJSON: () => ({}),
    });
    act(() => lifecycle.resizeCallbacks[0]?.());

    expect(latestHandle?.getCameraCenter()).toBe(250_000);
    expect(lifecycle.events.filter((event) => event === 'camera-center:250000')).toHaveLength(2);
  });

  it('arms broad ownership before renderer init or first render without any annotation sidecar', async () => {
    const sourceA = genome('A');
    render(
      <Harness
        genome={sourceA}
        indexed
        compiledBroadSurfaceRequirement={{
          identityKey: 'indexed-full-assembly:A',
          genomeLengthBp: sourceA.length,
          broadCorridorFinestSpanBp: 16_000_000,
        }}
      />
    );

    await waitFor(() => expect(latestHandle?.getLinearRenderer()).not.toBeNull());
    const requirementIndex = lifecycle.events.indexOf(`require-broad:${sourceA.length}`);
    expect(requirementIndex).toBeGreaterThanOrEqual(0);
    expect(requirementIndex).toBeLessThan(lifecycle.events.indexOf('init-start:A'));
    expect(requirementIndex).toBeLessThan(lifecycle.events.indexOf('render-loop-start'));
    expect(lifecycle.events.some((event) => event.startsWith('snapshot:'))).toBe(false);
    expect(lifecycle.events.some((event) => event.startsWith('pages:'))).toBe(false);
  });

  it('rejects an explicitly mismatched sidecar but recovers when a matching sidecar commits', async () => {
    const sourceA = genome('A');
    const view = render(
      <Harness genome={sourceA} annotationPresentationSnapshot={snapshot('B')} />
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(lifecycle.instances).toHaveLength(0);
    expect(latestHandle?.getLinearRenderer()).toBeNull();

    view.rerender(<Harness genome={sourceA} annotationPresentationSnapshot={snapshot('A')} />);
    await waitFor(() => expect(latestHandle?.getLinearRenderer()).not.toBeNull());
    expect(lifecycle.instances).toHaveLength(1);
    expect(lifecycle.instances[0]?.currentSnapshot).toMatchObject({ sourceIdentity: 'A' });
  });

  it('advances content but not concrete-renderer identity after same-renderer loadGenome', async () => {
    const readyEpochs: number[] = [];
    const contentEpochs: number[] = [];
    const sourceA = genome('A');
    const sourceB = genome('B');
    const view = render(
      <Harness
        genome={sourceA}
        onRendererReady={(epoch) => readyEpochs.push(epoch)}
        onRendererGenomeCommit={(epoch) => contentEpochs.push(epoch)}
      />
    );

    await waitFor(() => expect(contentEpochs).toEqual([1]));
    const renderer = lifecycle.instances[0];
    view.rerender(
      <Harness
        genome={sourceB}
        onRendererReady={(epoch) => readyEpochs.push(epoch)}
        onRendererGenomeCommit={(epoch) => contentEpochs.push(epoch)}
      />
    );

    await waitFor(() => expect(contentEpochs).toEqual([1, 2]));
    expect(lifecycle.instances).toHaveLength(1);
    expect(lifecycle.instances[0]).toBe(renderer);
    expect(renderer?.loadedGenome).toBe(sourceB);
    expect(readyEpochs).toEqual([1]);
  });

  it('withholds presented content identity while B mutates the renderer and C supersedes it', async () => {
    const sourceA = genome('A');
    const sourceB = genome('B');
    const sourceC = genome('C');
    const loadB = deferred();
    const loadC = deferred();
    lifecycle.mutateBeforeLoadAwait = true;
    lifecycle.loadGates.set('B', [loadB]);
    lifecycle.loadGates.set('C', [loadC]);
    const view = render(<Harness genome={sourceA} />);
    await waitFor(() => expect(lifecycle.getPresentedGenome()).toBe(sourceA));
    view.rerender(<Harness genome={sourceB} />);
    await waitFor(() => expect(lifecycle.instances[0]?.loadedGenome).toBe(sourceB));
    expect(lifecycle.getPresentedGenome()).toBeNull();
    view.rerender(<Harness genome={sourceC} />);
    await act(async () => loadB.resolve());
    await waitFor(() => expect(lifecycle.instances[0]?.loadedGenome).toBe(sourceC));
    expect(lifecycle.getPresentedGenome()).toBeNull();
    await act(async () => loadC.resolve());
    await waitFor(() => expect(lifecycle.getPresentedGenome()).toBe(sourceC));
    expect(lifecycle.events.filter((event) => event.startsWith('load-start:'))).toEqual([
      'load-start:B',
      'load-start:C',
    ]);
  });

  it('ingests resident pages through the page API before exposing the renderer', async () => {
    const sourceA = genome('A');
    const publicationA = residentPages('A');
    render(<Harness genome={sourceA} annotationResidentPagePublication={publicationA} />);

    await waitFor(() => expect(latestHandle?.getLinearRenderer()).not.toBeNull());
    const renderer = lifecycle.instances[0];
    expect(renderer.loadedGenome).toBe(sourceA);
    expect(renderer.currentSnapshot).toBe(publicationA);
    expect(lifecycle.events).toContain('pages:A:0');
    expect(lifecycle.events).not.toContain('snapshot:A:0');
  });

  it('invalidates stationary-pointer hit testing when annotation authority advances', async () => {
    const sourceA = genome('A');
    const view = render(
      <Harness genome={sourceA} annotationResidentPagePublication={residentPages('A', 0)} />
    );

    await waitFor(() => expect(latestHandle?.getLinearRenderer()).not.toBeNull());
    expect(lifecycle.hoverHitTestInvalidationCount).toBe(0);

    view.rerender(
      <Harness genome={sourceA} annotationResidentPagePublication={residentPages('A', 1)} />
    );

    await waitFor(() => expect(lifecycle.events).toContain('pages:A:1'));
    expect(lifecycle.events.filter((event) => event === 'pages:A:1')).toHaveLength(1);
    expect(lifecycle.events).not.toContain('pages-noop:A:1');
    expect(lifecycle.hoverHitTestInvalidationCount).toBe(1);
  });

  it('applies a flat compatibility envelope before layout-free resident pages', async () => {
    const sourceA = genome('A');
    render(
      <Harness
        genome={sourceA}
        annotationPresentationSnapshot={snapshot('A')}
        annotationResidentPagePublication={residentPages('A')}
      />
    );

    await waitFor(() => expect(latestHandle?.getLinearRenderer()).not.toBeNull());
    expect(lifecycle.events).toContain('snapshot:A:0');
    expect(lifecycle.events).toContain('pages:A:0');
    expect(lifecycle.events.indexOf('snapshot:A:0')).toBeLessThan(
      lifecycle.events.indexOf('pages:A:0')
    );
  });

  it('tears down a rejected Pixi initialization and recovers without a remount', async () => {
    lifecycle.appInitFailures = 1;
    const source = genome('A');
    const currentSnapshot = snapshot('A');

    render(<Harness genome={source} annotationPresentationSnapshot={currentSnapshot} />);

    await waitFor(() => expect(latestHandle?.getLinearRenderer()).not.toBeNull());
    expect(lifecycle.appDestroyCount).toBe(1);
    expect(lifecycle.instances).toHaveLength(1);
    expect(lifecycle.instances[0]?.loadedGenome).toBe(source);
    expect(lifecycle.instances[0]?.currentSnapshot).toBe(currentSnapshot);
  });

  it('destroys a rejected renderer and retries against a fresh Pixi application', async () => {
    lifecycle.rendererInitFailures = 1;
    const source = genome('A');
    const currentSnapshot = snapshot('A');

    render(<Harness genome={source} annotationPresentationSnapshot={currentSnapshot} />);

    await waitFor(() => expect(latestHandle?.getLinearRenderer()).not.toBeNull());
    expect(lifecycle.instances).toHaveLength(2);
    expect(lifecycle.instances[0]?.destroyed).toBe(true);
    expect(lifecycle.instances[1]?.destroyed).toBe(false);
    expect(lifecycle.instances[1]?.loadedGenome).toBe(source);
    expect(lifecycle.instances[1]?.currentSnapshot).toBe(currentSnapshot);
    expect(lifecycle.appDestroyCount).toBe(1);
  });

  it('keeps the initialization retry budget terminal across external init triggers', async () => {
    lifecycle.appInitFailures = 10;
    render(<Harness genome={genome('A')} annotationPresentationSnapshot={snapshot('A')} />);

    await waitFor(() => expect(lifecycle.applications).toHaveLength(3), { timeout: 1_000 });
    expect(lifecycle.instances).toHaveLength(0);
    expect(lifecycle.appDestroyCount).toBe(3);

    act(() => {
      lifecycle.resizeCallbacks.forEach((callback) => callback());
      lifecycle.intersectionCallbacks[0]?.([{ isIntersecting: false }]);
      lifecycle.intersectionCallbacks[0]?.([{ isIntersecting: true }]);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(lifecycle.applications).toHaveLength(3);
    expect(lifecycle.instances).toHaveLength(0);
    expect(lifecycle.appDestroyCount).toBe(3);
  });

  it('fails closed on the last good canvas after a fatal frame instead of rebuilding forever', async () => {
    const source = genome('A');
    const currentSnapshot = snapshot('A');
    const readyEpochs: number[] = [];
    const onCameraChange = vi.fn();
    const view = render(
      <Harness
        genome={source}
        annotationPresentationSnapshot={currentSnapshot}
        onRendererReady={(epoch) => readyEpochs.push(epoch)}
        onCameraChange={onCameraChange}
      />
    );

    await waitFor(() => expect(readyEpochs).toEqual([1]));
    expect(lifecycle.instances).toHaveLength(1);
    expect(lifecycle.fatalFrame).toBeTypeOf('function');
    expect(lifecycle.applications).toHaveLength(1);
    const renderer = lifecycle.instances[0];
    const canvas = view.container.querySelector('canvas');
    expect(canvas).not.toBeNull();
    const canvasWidth = canvas!.width;
    const canvasHeight = canvas!.height;
    const resizeCount = lifecycle.resizeCalls.length;

    const fatalFrame: WebGLFatalFrameError = {
      instance: 'fatal-frame-fixture',
      phase: 'render',
      name: 'Error',
      message: 'injected deterministic frame failure',
      stack: 'fixture-stack',
      consecutiveFrameErrors: 3,
      frameCount: 11,
      renderRevision: 7,
      zoom: 12,
      viewOffset: 0.25,
      width: 800,
      height: 500,
    };
    act(() => lifecycle.fatalFrame?.(fatalFrame));
    act(() => lifecycle.fatalFrame?.(fatalFrame));

    view.rerender(
      <Harness
        genome={genome('B')}
        annotationPresentationSnapshot={snapshot('B')}
        onRendererReady={(epoch) => readyEpochs.push(epoch)}
        onCameraChange={onCameraChange}
        width={1_200}
        height={700}
      />
    );
    act(() => {
      lifecycle.resizeCallbacks.forEach((callback) => callback());
      latestHandle?.setDisplaySize({ width: 1_300, height: 720 });
      latestHandle?.setCameraViewport(100_000, 200_000);
      latestHandle?.setViewCenter(250_000);
    });

    vi.useFakeTimers();
    try {
      act(() => lifecycle.intersectionCallbacks[0]?.([{ isIntersecting: false }]));
      act(() => vi.advanceTimersByTime(3_001));
      act(() => lifecycle.intersectionCallbacks[0]?.([{ isIntersecting: true }]));
    } finally {
      vi.useRealTimers();
    }

    expect(readyEpochs).toEqual([1]);
    expect(lifecycle.instances).toHaveLength(1);
    expect(lifecycle.applications).toHaveLength(1);
    expect(renderer?.destroyed).toBe(false);
    expect(renderer?.loadedGenome).toBe(source);
    expect(renderer?.currentSnapshot).toBe(currentSnapshot);
    expect(lifecycle.appDestroyCount).toBe(0);
    expect(lifecycle.interactionCleanupCount).toBe(1);
    expect(lifecycle.resizeCalls).toHaveLength(resizeCount);
    expect(view.container.querySelector('canvas')).toBe(canvas);
    expect(canvas).toMatchObject({ width: canvasWidth, height: canvasHeight });
    expect(lifecycle.events).not.toContain('load-start:B');
    expect(lifecycle.events).not.toContain('snapshot:B:0');
    expect(onCameraChange).not.toHaveBeenCalled();
  });

  it('serially reconciles deferred A→B→C and exposes only C with C content', async () => {
    const initGate = deferred();
    const loadB = deferred();
    const loadC = deferred();
    lifecycle.initGate = initGate;
    lifecycle.loadGates.set('B', [loadB]);
    lifecycle.loadGates.set('C', [loadC]);
    const sourceA = genome('A');
    const sourceB = genome('B');
    const sourceC = genome('C');
    const view = render(
      <Harness genome={sourceA} annotationPresentationSnapshot={snapshot('A')} />
    );
    await waitFor(() => expect(lifecycle.events).toContain('init-start:A'));
    expect(latestHandle?.getLinearRenderer()).toBeNull();

    view.rerender(<Harness genome={sourceB} annotationPresentationSnapshot={snapshot('B')} />);
    await act(async () => initGate.resolve());
    await waitFor(() => expect(lifecycle.events).toContain('load-start:B'));
    expect(latestHandle?.getLinearRenderer()).toBeNull();

    const snapshotC = snapshot('C');
    view.rerender(<Harness genome={sourceC} annotationPresentationSnapshot={snapshotC} />);
    await act(async () => loadB.resolve());
    await waitFor(() => expect(lifecycle.events).toContain('load-start:C'));
    expect(latestHandle?.getLinearRenderer()).toBeNull();

    await act(async () => loadC.resolve());
    await waitFor(() => expect(latestHandle?.getLinearRenderer()).not.toBeNull());
    const renderer = lifecycle.instances[0];
    expect(renderer.loadedGenome).toBe(sourceC);
    expect(renderer.currentSnapshot).toBe(snapshotC);
    expect(lifecycle.events).not.toContain('snapshot:B:0');
  });

  it('applies a newer snapshot that arrives while its source shell is loading', async () => {
    const sourceA = genome('A');
    const sourceB = genome('B');
    const snapshotA = snapshot('A');
    const snapshotB0 = snapshot('B', 0);
    const snapshotB1 = snapshot('B', 1);
    const loadB = deferred();
    lifecycle.loadGates.set('B', [loadB]);
    const view = render(<Harness genome={sourceA} annotationPresentationSnapshot={snapshotA} />);
    await waitFor(() => expect(latestHandle?.getLinearRenderer()).not.toBeNull());

    view.rerender(<Harness genome={sourceB} annotationPresentationSnapshot={snapshotB0} />);
    await waitFor(() => expect(lifecycle.events).toContain('load-start:B'));
    view.rerender(<Harness genome={sourceB} annotationPresentationSnapshot={snapshotB1} />);
    await act(async () => loadB.resolve());

    await waitFor(() => expect(lifecycle.instances[0]?.currentSnapshot).toBe(snapshotB1));
    expect(lifecycle.events).toContain('snapshot:B:0');
    expect(lifecycle.events).toContain('snapshot:B:1');
  });

  it('retains the previous complete source when a new shell has only an old-source snapshot', async () => {
    const sourceA = genome('A');
    const sourceB = genome('B');
    const snapshotA = snapshot('A');
    const view = render(<Harness genome={sourceA} annotationPresentationSnapshot={snapshotA} />);
    await waitFor(() => expect(latestHandle?.getLinearRenderer()).not.toBeNull());

    view.rerender(<Harness genome={sourceB} annotationPresentationSnapshot={snapshotA} />);
    await act(async () => undefined);
    expect(lifecycle.events).not.toContain('load-start:B');
    expect(lifecycle.instances[0]?.loadedGenome).toBe(sourceA);
    expect(lifecycle.instances[0]?.currentSnapshot).toBe(snapshotA);

    const snapshotB = snapshot('B');
    view.rerender(<Harness genome={sourceB} annotationPresentationSnapshot={snapshotB} />);
    await waitFor(() => expect(lifecycle.instances[0]?.loadedGenome).toBe(sourceB));
    expect(lifecycle.instances[0]?.currentSnapshot).toBe(snapshotB);
  });
});
