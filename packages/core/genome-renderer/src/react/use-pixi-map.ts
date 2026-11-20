import {
  comparisonPlot,
  resolveComparisonCamera,
  zoomComparisonCamera,
} from '../comparison-projection';
import {
  assertContactProjection,
  contactPlotRect,
  resolveContactCamera,
  zoomContactCamera,
} from '../contact-projection';
import type { PixiPresentedFrame } from './types';

import { useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import { Application } from 'pixi.js';
import {
  PixiStadiumRenderer,
  PixiLinearRenderer,
  IndexedPixiLinearRenderer,
  perfLog as plog,
  perfMark as pmark,
  perfTimeAsync as ptimeAsync,
  genomeFeatures,
  recordWebGLTrace,
  registerWebGLInstance,
  unregisterWebGLInstance,
  webglThemeForMode,
  applySelectionAction,
} from '@waypoint/genome-renderer';
import type {
  AnnotationFlatPresentationSnapshot,
  AnnotationResidentPagePublication,
  Feature,
  InteractionHandle,
  Genome,
  RenderState,
  WebGLFatalFrameCircuitSnapshot,
  WebGLPostPresentWorkDropReason,
} from '@waypoint/genome-renderer';
import type { CutSite, Primer } from '@waypoint/genome-renderer';
import {
  INITIAL_PORTAL_WIDTH_STABILITY,
  samplePortalReattachWidth,
  type PortalWidthStability,
} from './portal-reattach-width-stability';
import type { PixiMapHandle, UsePixiMapOptions } from './types';

type PixiMapRenderer = {
  setCutSites?: (sites: CutSite[]) => void;
  setPrimers?: (primers: readonly Primer[]) => void;
  setSequenceWindow?: (window?: { startBp: number; bases: string }) => void;
  setAnnotationsVisible?: (visible: boolean) => void;
};

function asPixiMapRenderer(renderer: unknown): PixiMapRenderer | null {
  return renderer as PixiMapRenderer | null;
}
export type {
  HiddenMapIdlePolicy,
  HoverFeatureInfo,
  PixiMapHandle,
  SelectedCodonInfo,
  UsePixiMapOptions,
} from './types';
import { clearPixiCanvas, resizePixiCanvas } from './pixi-canvas';
import { applyPixiTheme, currentWebGLThemeMode, installWebGLThemeObserver } from './pixi-theme';
import {
  clearWebGLTestHooks,
  exposeWebGLTestHooks,
  updateWebGLTestHookGenome,
} from './webgl-test-hooks';
import { attachPixiInteractionAdapter } from './interaction-adapter';
import { startWebGLRenderLoop, type WebGLRenderLoop } from './webgl-render-loop';
import {
  annotationFlatPresentationSnapshotMatchesGenome,
  annotationResidentPagePublicationMatchesGenome,
  applyMatchingAnnotationFlatPresentationSnapshot,
  ingestMatchingAnnotationResidentPages,
  invalidateAnnotationHoverAfterSnapshotApply,
} from './annotation-presentation-lifecycle';
import { pixiInitOptionsForPerformanceMode } from './webgl-performance-profile';
import { hiddenMapRetention } from './hidden-map-retention';
import { createDisposableCallbackAuthority } from './disposable-callback-authority';
import {
  acquireRetainedPixiApplication,
  destroyPixiApplication,
  isPixiApplicationDestroyed,
  registerPixiApplication,
  releaseUninitializedPixiApplication,
  retainPixiApplication,
  type PixiApplicationProfile,
} from './pixi-application-retention';

const TAB_PORTAL_HOST_ATTACHED_EVENT = 'waypoint:tab-portal-host-attached';

function cloneAnnotationSearchFocusFeature(feature: Feature | null | undefined): Feature | null {
  if (!feature) return null;
  return {
    ...feature,
    segments: feature.segments?.map((span) => ({ ...span })),
    exons: feature.exons?.map((span) => ({ ...span })),
    cds: feature.cds?.map((span) => ({ ...span })),
    qualifiers: feature.qualifiers ? { ...feature.qualifiers } : undefined,
  };
}

function armCompiledBroadSurfaceRequirementBeforeGenomeLoad(
  renderer: PixiStadiumRenderer | PixiLinearRenderer,
  options: UsePixiMapOptions,
  genome: Genome
): void {
  const requirement = options.compiledBroadSurfaceRequirement;
  if (!requirement) return;
  if (
    options.circular ||
    !requirement.identityKey.trim() ||
    requirement.genomeLengthBp !== genome.length ||
    !(renderer instanceof IndexedPixiLinearRenderer)
  ) {
    throw new Error('compiled broad surface requirement does not match the linear genome');
  }
  if (!renderer.requireCompiledBroadSurface(requirement)) {
    throw new Error('compiled broad surface requirement was rejected before genome load');
  }
  recordWebGLTrace('compiled-broad-surface-requirement-armed-before-genome-load', {
    identityKey: requirement.identityKey,
    genomeLengthBp: requirement.genomeLengthBp,
    broadCorridorFinestSpanBp: requirement.broadCorridorFinestSpanBp,
  });
}

export function createWebGLInstanceId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `pixi-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

type PixiMapImplOptions = UsePixiMapOptions & {
  rendererKind: 'stadium' | 'sequence' | 'indexed';
};

export type UseIndexedPixiMapOptions = Omit<UsePixiMapOptions, 'circular'>;

export function usePixiMap(options: UsePixiMapOptions): {
  containerRef: React.RefObject<HTMLDivElement>;
  handle: PixiMapHandle;
} {
  return usePixiMapImpl({
    ...options,
    circular: options.contactProjection || options.comparisonProjection ? false : options.circular,
    rendererKind:
      options.circular && !options.contactProjection && !options.comparisonProjection
        ? 'stadium'
        : 'sequence',
  });
}

export function useIndexedPixiMap(options: UseIndexedPixiMapOptions): {
  containerRef: React.RefObject<HTMLDivElement>;
  handle: PixiMapHandle;
} {
  return usePixiMapImpl({
    ...options,
    circular: false,
    rendererKind: 'indexed',
  });
}

function isContainerActuallyVisible(container: HTMLElement | null): boolean {
  if (!container?.isConnected) return false;
  const rect = container.getBoundingClientRect();
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom >= 0 &&
    rect.right >= 0 &&
    rect.top <= window.innerHeight &&
    rect.left <= window.innerWidth
  );
}

function usePixiMapImpl(options: PixiMapImplOptions): {
  containerRef: React.RefObject<HTMLDivElement>;
  handle: PixiMapHandle;
} {
  const containerRef = useRef<HTMLDivElement>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const appRef = useRef<Application | null>(null);
  const rendererRef = useRef<PixiStadiumRenderer | PixiLinearRenderer | null>(null);
  const appliedAnnotationPublicationsRef = useRef<{
    renderer: unknown;
    genome: Genome;
    flat: AnnotationFlatPresentationSnapshot | undefined;
    resident: AnnotationResidentPagePublication | undefined;
  } | null>(null);
  const stateRef = useRef<RenderState>({
    contactProjection: options.contactProjection,
    comparisonProjection: options.comparisonProjection,
    comparisonCamera: null,
    hoveredComparison: null,
    selectedComparison: null,
    contactCamera: null,
    hoveredContact: null,
    selectedContact: null,
    performanceMode: options.performanceMode ?? 'default',
    morph: options.morph ?? 0,
    viewOffset: 0,
    zoom: 1,
    width: options.width,
    height: options.height,
    geometryHeight: options.geometryHeight ?? options.height,
    centerStadiumOverview: options.centerStadiumOverview,
    themeMode: options.themeMode ?? currentWebGLThemeMode(),
    selectedIds: new Set(options.selectedFeatureIds ?? []),
    selectedCanonicalIdentities: new Set(options.selectedFeatureCanonicalIdentities ?? []),
    annotationSearchFocus: options.annotationSearchFocus
      ? { ...options.annotationSearchFocus }
      : null,
    annotationSearchFocusFeature: cloneAnnotationSearchFocusFeature(
      options.annotationSearchFocusFeature
    ),
    annotationChangeDecorations: options.annotationChangeDecorations,
    sequencePresentation: options.sequencePresentation,
    hoveredId: options.hoveredFeatureId ?? null,
    viewportRange: null,
    viewportIndicatorVisible: options.viewportIndicatorVisible ?? false,
    highlightRange: options.highlightRange ?? null,
    digestFocusRange: options.digestFocusRange ?? null,
    residueLinkRange: options.residueLinkRange ?? null,
    hoveredCodon: options.hoveredCodon ?? null,
    selectedCodons: options.selectedCodons ?? [],
    cursorPosition: options.cursorPosition ?? null,
    cursorBlinking: options.cursorBlinking ?? false,
    hoverPosition: null,
    hoveredOrf: null,
    selectedOrf: null,
    showResidueNumbers: options.showResidueNumbers ?? false,
    hoveredCutSiteId: null,
    perfPanelVisible: false,
    backboneSegments: options.backboneSegments,
    backboneBoundaryHandles: options.backboneBoundaryHandles,
  });
  const rafRef = useRef<number | null>(null);
  const genomeRef = useRef<Genome | null>(null);
  const presentedGenomeRef = useRef<Genome | null>(null);
  const interactionRef = useRef<InteractionHandle | null>(null);

  const visibleRef = useRef(true);
  const renderLoopRef = useRef<WebGLRenderLoop | null>(null);
  const renderRevisionRef = useRef(0);

  const presentedFrameListenersRef = useRef(new Set<(receipt: PixiPresentedFrame) => void>());
  useEffect(
    () => () => {
      presentedFrameListenersRef.current.clear();
      const liveOptions = optionsRef.current;
      optionsRef.current = {
        genome: null,
        circular: liveOptions.circular,
        width: 0,
        height: 0,
        rendererKind: liveOptions.rendererKind,
      };
      stateRef.current.annotationSearchFocusFeature = null;
      stateRef.current.selectedIds.clear();
      stateRef.current.selectedCanonicalIdentities?.clear();
    },
    []
  );

  const postPresentWorkRef = useRef(new Set<(deadlineMs: number) => void>());

  const criticalPostPresentWorkRef = useRef(new Set<(deadlineMs: number) => void>());
  const invalidateRender = useCallback(() => {
    renderRevisionRef.current += 1;

    renderLoopRef.current?.wake();
  }, []);

  const frameCountRef = useRef(0);
  const lastFrameTRef = useRef(0);
  const fatalFrameCircuitRef = useRef<WebGLFatalFrameCircuitSnapshot | null>(null);
  const frameCircuitIsOpen = useCallback(() => fatalFrameCircuitRef.current !== null, []);

  const resumeTickRef = useRef<(() => void) | null>(null);
  const requestInitRef = useRef<(() => void) | null>(null);
  const genomeReloadInFlightRef = useRef<Promise<void> | null>(null);
  const genomeReloadRequestedRef = useRef(false);
  const rendererReadyEpochRef = useRef(0);
  const rendererGenomeCommitEpochRef = useRef(0);

  const pendingViewCenterBpRef = useRef<number | null>(null);

  const getViewCenter = useCallback((): number | null => {
    const current = stateRef.current;
    if (current.comparisonProjection) {
      const camera = resolveComparisonCamera(
        current.comparisonProjection,
        current.comparisonCamera
      );
      return (camera.startColumn + camera.endColumn) / 2;
    }
    if (current.contactProjection) {
      const camera = resolveContactCamera(current.contactProjection, current.contactCamera);
      return (camera.xStart + camera.xEnd) / 2;
    }
    const renderer = rendererRef.current as
      | {
          getViewCenterBp?: (state: RenderState) => number;
          screenToBp?: (x: number, y: number, state: RenderState) => number;
        }
      | null
      | undefined;
    const state = stateRef.current;
    if (!renderer || !state) return null;
    const center =
      renderer.getViewCenterBp?.(state) ??
      renderer.screenToBp?.(state.width / 2, state.height / 2, state);
    return typeof center === 'number' && Number.isFinite(center) ? center : null;
  }, []);

  const mutateDisplayGeometryPreservingCenter = useCallback(
    <T>(mutate: () => T): T => {
      const renderer = rendererRef.current as
        | {
            setViewCenterBp?: (bp: number, state: RenderState) => void;
          }
        | null
        | undefined;
      const centerBpBeforeMutation = getViewCenter();
      const result = mutate();
      if (
        centerBpBeforeMutation !== null &&
        rendererRef.current === renderer &&
        renderer?.setViewCenterBp
      ) {
        renderer.setViewCenterBp(centerBpBeforeMutation, stateRef.current);
      }
      return result;
    },
    [getViewCenter]
  );

  const annotationPublicationMatchesGenome = useCallback(
    (current: UsePixiMapOptions, genome: Genome) => {
      const flat = current.annotationPresentationSnapshot;
      const resident = current.annotationResidentPagePublication;
      return (
        (flat === undefined || annotationFlatPresentationSnapshotMatchesGenome(flat, genome)) &&
        (resident === undefined || annotationResidentPagePublicationMatchesGenome(resident, genome))
      );
    },
    []
  );

  const applyAnnotationPublication = useCallback(
    (
      renderer: unknown,
      genome: Genome,
      flatSnapshot = optionsRef.current.annotationPresentationSnapshot,
      residentPages = optionsRef.current.annotationResidentPagePublication
    ) => {
      if (frameCircuitIsOpen()) return null;
      const previous = appliedAnnotationPublicationsRef.current;
      const sameTarget =
        previous !== null && previous.renderer === renderer && previous.genome === genome;
      const shouldApplyFlat =
        flatSnapshot !== undefined && (!sameTarget || previous?.flat !== flatSnapshot);
      const shouldApplyResident =
        residentPages !== undefined && (!sameTarget || previous?.resident !== residentPages);

      const flatResult = shouldApplyFlat
        ? applyMatchingAnnotationFlatPresentationSnapshot(renderer, genome, flatSnapshot)
        : null;
      invalidateAnnotationHoverAfterSnapshotApply(
        flatResult,
        stateRef.current,
        optionsRef.current.onFeatureHover,
        optionsRef.current.onHoverChange
      );
      const residentResult = shouldApplyResident
        ? ingestMatchingAnnotationResidentPages(renderer, genome, residentPages)
        : null;
      invalidateAnnotationHoverAfterSnapshotApply(
        residentResult,
        stateRef.current,
        optionsRef.current.onFeatureHover,
        optionsRef.current.onHoverChange
      );

      if (flatResult?.status === 'applied' || residentResult?.status === 'applied') {
        interactionRef.current?.invalidateHoverHitTest();
      }
      const next: NonNullable<typeof appliedAnnotationPublicationsRef.current> =
        sameTarget && previous
          ? { ...previous }
          : { renderer, genome, flat: undefined, resident: undefined };
      if (flatResult?.status !== 'rejected' && shouldApplyFlat) next.flat = flatSnapshot;
      if (residentResult?.status !== 'rejected' && shouldApplyResident) {
        next.resident = residentPages;
      }
      appliedAnnotationPublicationsRef.current = next;
      const result = residentResult ?? flatResult;
      if (result) invalidateRender();
      return result;
    },
    [frameCircuitIsOpen, invalidateRender]
  );

  useEffect(() => {
    if (options.themeMode !== undefined) return;
    return installWebGLThemeObserver({ stateRef, appRef });
  }, [options.themeMode]);

  useEffect(() => {
    const mode = options.themeMode;
    if (mode === undefined || frameCircuitIsOpen()) return;
    const previousMode = stateRef.current.themeMode;
    stateRef.current.themeMode = mode;
    if (appRef.current) applyPixiTheme(appRef.current, mode);
    if (previousMode !== mode) {
      recordWebGLTrace('theme-mode-change', { mode, authority: 'react' });
    }
    invalidateRender();
  }, [frameCircuitIsOpen, invalidateRender, options.themeMode]);

  useEffect(() => {
    if (stateRef.current.annotationRolePalette === options.annotationRolePalette) return;
    stateRef.current.annotationRolePalette = options.annotationRolePalette;
    if (!frameCircuitIsOpen()) invalidateRender();
  }, [frameCircuitIsOpen, invalidateRender, options.annotationRolePalette]);

  const selectedFeatureIdsKey =
    options.selectedFeatureIds === undefined
      ? null
      : Array.from(options.selectedFeatureIds)
          .sort((a, b) => a - b)
          .join(',');
  const selectedFeatureCanonicalIdentitiesKey =
    options.selectedFeatureCanonicalIdentities === undefined
      ? null
      : Array.from(options.selectedFeatureCanonicalIdentities).sort().join('\u0000');

  useEffect(() => {
    if (frameCircuitIsOpen()) return;
    stateRef.current.performanceMode = options.performanceMode ?? 'default';
    invalidateRender();
  }, [frameCircuitIsOpen, invalidateRender, options.performanceMode]);

  useLayoutEffect(() => {
    if (frameCircuitIsOpen()) return;
    const state = stateRef.current;
    const revealed =
      options.surfaceVisible &&
      !visibleRef.current &&
      isContainerActuallyVisible(containerRef.current);
    if (revealed) visibleRef.current = true;
    const geometryHeight = options.geometryHeight ?? options.height;
    const morph = options.morph ?? 0;
    const geometryChanged =
      state.width !== Math.round(options.width) ||
      state.height !== Math.round(options.height) ||
      state.geometryHeight !== geometryHeight ||
      state.morph !== morph ||
      state.centerStadiumOverview !== options.centerStadiumOverview;
    pmark('sync-display-props', {
      w: options.width,
      h: options.height,
      gh: geometryHeight,
      morph,
    });
    const backingChanged = mutateDisplayGeometryPreservingCenter(() => {
      state.centerStadiumOverview = options.centerStadiumOverview;
      state.geometryHeight = geometryHeight;
      state.morph = morph;
      const app = appRef.current;
      if (app && options.width > 0 && options.height > 0) {
        const size = resizePixiCanvas(
          app,
          options.width,
          options.height,
          'display-props',
          undefined,
          options.reserveCanvasSpace
        );
        state.width = size.width;
        state.height = size.height;
        return size.backingChanged;
      }
      state.width = options.width;
      state.height = options.height;
      return false;
    });
    if (backingChanged || geometryChanged || revealed) {
      invalidateRender();
      renderLoopRef.current?.renderNow();
    }
  }, [
    frameCircuitIsOpen,
    invalidateRender,
    mutateDisplayGeometryPreservingCenter,
    options.width,
    options.height,
    options.geometryHeight,
    options.centerStadiumOverview,
    options.reserveCanvasSpace,
    options.surfaceVisible,
    options.morph,
  ]);

  useEffect(() => {
    pmark('sync-highlightRange-prop', { value: options.highlightRange });
    if (options.highlightRange !== undefined) {
      applySelectionAction(stateRef.current, {
        type: 'set-external-highlight',
        range: options.highlightRange,
      });
      invalidateRender();
    }
  }, [invalidateRender, options.highlightRange]);

  useEffect(() => {
    stateRef.current.digestFocusRange = options.digestFocusRange ?? null;
    invalidateRender();
  }, [invalidateRender, options.digestFocusRange]);

  useEffect(() => {
    if (options.residueLinkRange === undefined) return;
    applySelectionAction(stateRef.current, {
      type: 'set-residue-link-range',
      range: options.residueLinkRange,
    });
    invalidateRender();
  }, [invalidateRender, options.residueLinkRange]);

  useEffect(() => {
    if (options.hoveredCodon === undefined) return;
    stateRef.current.hoveredCodon = options.hoveredCodon
      ? {
          start: options.hoveredCodon.start,
          end: options.hoveredCodon.end,
          strand: options.hoveredCodon.strand,
        }
      : null;
    invalidateRender();
  }, [invalidateRender, options.hoveredCodon]);

  useEffect(() => {
    if (options.selectedCodons === undefined) return;
    stateRef.current.selectedCodons = options.selectedCodons;
    invalidateRender();
  }, [invalidateRender, options.selectedCodons]);

  useEffect(() => {
    applySelectionAction(stateRef.current, {
      type: 'set-external-cursor',
      bp: options.cursorPosition ?? null,
    });
    stateRef.current.cursorBlinking = options.cursorBlinking ?? false;
    invalidateRender();
  }, [invalidateRender, options.cursorBlinking, options.cursorPosition]);

  useEffect(() => {
    stateRef.current.viewportIndicatorVisible = options.viewportIndicatorVisible ?? false;
    invalidateRender();
  }, [invalidateRender, options.viewportIndicatorVisible]);

  useLayoutEffect(() => {
    stateRef.current.annotationChangeDecorations = options.annotationChangeDecorations;
    stateRef.current.sequencePresentation = options.sequencePresentation;
    invalidateRender();
  }, [invalidateRender, options.annotationChangeDecorations, options.sequencePresentation]);

  useLayoutEffect(() => {
    const state = stateRef.current;
    const projection = options.comparisonProjection;
    if (state.comparisonProjection?.id !== projection?.id) {
      state.hoveredComparison = null;
      state.selectedComparison = null;
      state.comparisonCamera = null;
    }
    state.comparisonProjection = projection;
    if (projection)
      state.comparisonCamera = resolveComparisonCamera(projection, state.comparisonCamera);
    interactionRef.current?.cancelGesture?.();
    interactionRef.current?.cancelMotion();
    invalidateRender();
  }, [invalidateRender, options.comparisonProjection]);

  useLayoutEffect(() => {
    const projection = options.contactProjection;
    if (projection) assertContactProjection(projection);
    const state = stateRef.current;
    if (state.contactProjection?.id !== projection?.id) {
      state.hoveredContact = null;
      state.selectedContact = null;
      state.contactCamera = null;
    }
    state.contactProjection = projection;
    interactionRef.current?.cancelGesture?.();
    if (projection) state.contactCamera = resolveContactCamera(projection, state.contactCamera);
    interactionRef.current?.cancelMotion();
    invalidateRender();
  }, [invalidateRender, options.contactProjection]);

  useEffect(() => {
    stateRef.current.showResidueNumbers = options.showResidueNumbers ?? false;
    invalidateRender();
  }, [invalidateRender, options.showResidueNumbers]);

  useEffect(() => {
    if (options.externalHoveredFeatureId === undefined) return;
    applySelectionAction(stateRef.current, {
      type: 'set-external-hover',
      featureId: options.externalHoveredFeatureId,
    });
    invalidateRender();
  }, [invalidateRender, options.externalHoveredFeatureId]);

  useEffect(() => {
    if (options.selectedFeatureIds === undefined) return;
    const selectedIds = stateRef.current.selectedIds;
    selectedIds.clear();
    for (const id of options.selectedFeatureIds) selectedIds.add(id);
    if (selectedIds.size > 0) {
      stateRef.current.selectedOrf = null;
      stateRef.current.cursorPosition = null;
    }
    invalidateRender();
  }, [invalidateRender, options.selectedFeatureIds, selectedFeatureIdsKey]);

  useEffect(() => {
    if (options.selectedFeatureCanonicalIdentities === undefined) return;
    const selected =
      stateRef.current.selectedCanonicalIdentities ??
      (stateRef.current.selectedCanonicalIdentities = new Set<string>());
    selected.clear();
    for (const identity of options.selectedFeatureCanonicalIdentities) selected.add(identity);
    invalidateRender();
  }, [
    invalidateRender,
    options.selectedFeatureCanonicalIdentities,
    selectedFeatureCanonicalIdentitiesKey,
  ]);

  useEffect(() => {
    stateRef.current.annotationSearchFocus = options.annotationSearchFocus
      ? { ...options.annotationSearchFocus }
      : null;
    invalidateRender();
  }, [invalidateRender, options.annotationSearchFocus]);

  useEffect(() => {
    stateRef.current.annotationSearchFocusFeature = cloneAnnotationSearchFocusFeature(
      options.annotationSearchFocusFeature
    );
    invalidateRender();
  }, [
    invalidateRender,
    options.annotationSearchFocusFeature,
    options.annotationSearchFocusFeature?.annotationTrackId,
    options.annotationSearchFocusFeature?.type,
    options.annotationSearchFocusFeature?.canonicalIdentity,
    options.annotationSearchFocusFeature?.start,
    options.annotationSearchFocusFeature?.end,
  ]);

  useEffect(() => {
    stateRef.current.backboneSegments = options.backboneSegments;
    recordWebGLTrace('backbone-segments-sync', {
      count: options.backboneSegments?.length ?? 0,
    });
    const interaction = interactionRef.current;
    if (!interaction) {
      invalidateRender();
      return;
    }
    const reconcileStationaryPointer = () => {
      presentedFrameListenersRef.current.delete(reconcileStationaryPointer);
      if (interactionRef.current !== interaction) return;
      interaction.invalidateHoverHitTest();
      invalidateRender();
    };
    presentedFrameListenersRef.current.add(reconcileStationaryPointer);
    invalidateRender();
    return () => {
      presentedFrameListenersRef.current.delete(reconcileStationaryPointer);
    };
  }, [invalidateRender, options.backboneSegments]);

  useEffect(() => {
    stateRef.current.backboneBoundaryHandles = options.backboneBoundaryHandles;
    invalidateRender();
  }, [invalidateRender, options.backboneBoundaryHandles]);

  useEffect(() => {
    if (options.cutSites === undefined || !rendererRef.current) return;
    const r = asPixiMapRenderer(rendererRef.current);
    if (r?.setCutSites) {
      pmark('sync-cutSites-prop', { count: options.cutSites.length });
      r.setCutSites(options.cutSites);
      recordWebGLTrace('cut-sites-sync', { count: options.cutSites.length });
      invalidateRender();
    }
  }, [invalidateRender, options.cutSites]);

  useEffect(() => {
    if (options.primers === undefined || !rendererRef.current) return;
    const r = asPixiMapRenderer(rendererRef.current);
    if (r?.setPrimers) {
      r.setPrimers(options.primers);
      recordWebGLTrace('primers-sync', { count: options.primers.length });
      invalidateRender();
    }
  }, [invalidateRender, options.primers]);

  useEffect(() => {
    optionsRef.current = options;
    const container = containerRef.current;
    if (!container || !options.genome) return;

    const instanceId = createWebGLInstanceId();
    plog('webgl.mount', { instance: instanceId, seqLen: options.genome.length });

    const registeredPostPresentDrops = new Map<
      (deadlineMs: number) => void,
      (reason: WebGLPostPresentWorkDropReason) => void
    >();
    const dropRegisteredPostPresentWork = (reason: WebGLPostPresentWorkDropReason): void => {
      for (const [queuedWork, onDropped] of registeredPostPresentDrops) {
        criticalPostPresentWorkRef.current.delete(queuedWork);
        try {
          onDropped(reason);
        } catch {}
      }
      registeredPostPresentDrops.clear();
    };

    registerWebGLInstance({
      instanceId,
      createdAt: performance.now(),
      containerRef,
      appRef,
      rendererRef,
      stateRef,
      visibleRef,
      genomeRef,
      frameCountRef,
      lastFrameTRef,
      fatalFrameCircuitRef,
      schedulePostPresentWork: (work, onDropped) => {
        const queuedWork = (deadlineMs: number): void => {
          if (!registeredPostPresentDrops.delete(queuedWork)) return;
          work(deadlineMs);
        };
        registeredPostPresentDrops.set(queuedWork, onDropped);
        criticalPostPresentWorkRef.current.add(queuedWork);
        invalidateRender();
      },
    });

    let destroyed = false;
    let app: Application | null = null;
    let appProfile: PixiApplicationProfile | null = null;
    type PixiInitLifecycle = 'idle' | 'initializing' | 'ready' | 'failed';
    let initLifecycle: PixiInitLifecycle = 'idle';
    let initAttempt = 0;
    let initRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingRenderer: PixiStadiumRenderer | PixiLinearRenderer | null = null;
    const INIT_RETRY_DELAYS_MS = [0, 100] as const;
    let removeContextListeners: (() => void) | null = null;
    recordWebGLTrace('mount', {
      instance: instanceId,
      seqLen: options.genome.length,
      circular: options.circular,
    });

    let hideTimer: ReturnType<typeof setTimeout> | null = null;
    const hiddenMapIdlePolicy = options.hiddenMapIdlePolicy ?? 'short-timeout';

    const IDLE_RELEASE_MS = hiddenMapIdlePolicy === 'bounded-lru' ? 60_000 : 3_000;
    const idleReleaseReason = hiddenMapIdlePolicy === 'bounded-lru' ? 'idle-release' : 'idle-hide';

    const reusesPixiApplications = hiddenMapIdlePolicy !== 'short-timeout';

    let portalResizeSettling = false;
    let portalResizeStability: PortalWidthStability = INITIAL_PORTAL_WIDTH_STABILITY;
    let portalSettleRafId: number | null = null;

    const isCurrentPixiApp = (target: Application) => {
      return app === target && !isPixiApplicationDestroyed(target);
    };

    const teardownPixi = (reason: string) => {
      hiddenMapRetention.release(instanceId);
      const appToDestroy = app;
      const profileToRetain = appProfile;
      const rendererToDestroy = rendererRef.current;
      plog('pixi.teardown', { instance: instanceId, reason });
      recordWebGLTrace('teardown', { instance: instanceId, reason });
      removeContextListeners?.();
      removeContextListeners = null;
      renderLoopRef.current?.stop();
      renderLoopRef.current = null;
      dropRegisteredPostPresentWork('teardown');
      criticalPostPresentWorkRef.current.clear();
      postPresentWorkRef.current.clear();
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      try {
        interactionRef.current?.cleanup();
      } catch {}
      interactionRef.current = null;
      if (rendererToDestroy) clearWebGLTestHooks(rendererToDestroy);
      let rendererTeardownComplete = rendererToDestroy !== null && pendingRenderer === null;
      try {
        rendererToDestroy?.destroy?.();
      } catch {
        rendererTeardownComplete = false;
      }
      rendererRef.current = null;
      appliedAnnotationPublicationsRef.current = null;
      try {
        pendingRenderer?.destroy?.();
      } catch {
        rendererTeardownComplete = false;
      }
      pendingRenderer = null;
      const retainedForReopen =
        reason === 'unmount' &&
        reusesPixiApplications &&
        rendererTeardownComplete &&
        appToDestroy !== null &&
        profileToRetain !== null &&
        retainPixiApplication(appToDestroy, profileToRetain);
      if (!retainedForReopen) destroyPixiApplication(appToDestroy);
      if (app === appToDestroy) app = null;
      if (appRef.current === appToDestroy) appRef.current = null;
      appProfile = null;
      genomeRef.current = null;
      presentedGenomeRef.current = null;
      initLifecycle = destroyed ? 'failed' : 'idle';

      while (container.firstChild) container.removeChild(container.firstChild);
    };

    const measureContainerSize = () => {
      const current = optionsRef.current;
      const rect = container.getBoundingClientRect();
      const width = rect.width || container.clientWidth || current.width;
      const hostHeight = rect.height || container.clientHeight || current.height;
      const height = current.capCanvasToProvidedHeight
        ? Math.min(hostHeight, current.height)
        : hostHeight;
      return {
        width: Math.round(width),
        height: Math.round(height),
      };
    };

    const hasUsableSize = () => {
      const size = measureContainerSize();
      return container.isConnected && size.width > 0 && size.height > 0;
    };

    const resizePreviewActive = () =>
      container.closest('[data-webgl-resize-preview="true"]') !== null;

    const resumeLiveApp = (reason: string) => {
      if (
        frameCircuitIsOpen() ||
        initLifecycle !== 'ready' ||
        !app ||
        appRef.current !== app ||
        destroyed ||
        !container.isConnected
      ) {
        return false;
      }
      if (resizePreviewActive()) {
        recordWebGLTrace('portal-resume-deferred-resize-preview', { instance: instanceId, reason });
        return false;
      }
      const size = measureContainerSize();
      if (size.width <= 0 || size.height <= 0) {
        recordWebGLTrace('portal-resume-deferred-size', { instance: instanceId, reason });
        return false;
      }

      const wasVisible = visibleRef.current;
      if (
        reason === 'container-resize-observer' &&
        wasVisible &&
        stateRef.current.width === size.width &&
        stateRef.current.height === size.height
      ) {
        return true;
      }
      const current = optionsRef.current;
      const liveApp = app;
      const appliedSize = mutateDisplayGeometryPreservingCenter(() => {
        const nextSize = resizePixiCanvas(
          liveApp,
          size.width,
          size.height,
          reason,
          undefined,
          current.reserveCanvasSpace
        );
        stateRef.current.width = nextSize.width;
        stateRef.current.height = nextSize.height;
        stateRef.current.geometryHeight = current.geometryHeight ?? nextSize.height;
        stateRef.current.morph = current.morph ?? 0;
        return nextSize;
      });
      visibleRef.current = true;

      if (hideTimer !== null) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
      hiddenMapRetention.release(instanceId);

      recordWebGLTrace(
        'portal-resume',
        {
          instance: instanceId,
          reason,
          width: appliedSize.width,
          height: appliedSize.height,
        },
        { snapshot: true }
      );
      if (!wasVisible || reason === 'tab-portal-host-settled') renderLoopRef.current?.resume();
      renderLoopRef.current?.renderNow();
      return true;
    };

    const requestInit = () => {
      if (
        frameCircuitIsOpen() ||
        destroyed ||
        initLifecycle === 'initializing' ||
        initLifecycle === 'ready' ||
        (initLifecycle === 'failed' && initAttempt > INIT_RETRY_DELAYS_MS.length)
      ) {
        return;
      }
      const current = optionsRef.current;
      if (!current.genome) return;
      if (!annotationPublicationMatchesGenome(current, current.genome)) {
        const publicationSourceIdentity =
          current.annotationResidentPagePublication?.sourceIdentity ??
          current.annotationPresentationSnapshot?.sourceIdentity ??
          'mixed-authority';
        recordWebGLTrace('init-deferred-annotation-source-pair', {
          instance: instanceId,
          genomeSourceIdentity: current.genome.sourceIdentity ?? current.genome.name,
          snapshotSourceIdentity: publicationSourceIdentity,
        });
        return;
      }
      if (!hasUsableSize()) {
        plog('pixi-init-deferred-size', { instance: instanceId });
        recordWebGLTrace('init-deferred-size', { instance: instanceId });
        return;
      }
      const featureCount = genomeFeatures(current.genome).length;
      pmark('pixi-init-start', {
        featureCount,
        circular: current.circular,
      });
      recordWebGLTrace('init-request', {
        instance: instanceId,
        featureCount,
        circular: current.circular,
      });
      initLifecycle = 'initializing';
      const attempt = ++initAttempt;
      void initPixi()
        .then(() => {
          if (destroyed) return;
          if (appRef.current && rendererRef.current) {
            initLifecycle = 'ready';
            initAttempt = 0;
            return;
          }

          if (initLifecycle === 'initializing') initLifecycle = 'idle';
        })
        .catch((error: unknown) => {
          if (destroyed) return;
          const message = error instanceof Error ? error.message : String(error);
          recordWebGLTrace('init-failed', {
            instance: instanceId,
            attempt,
            message,
          });
          teardownPixi('init-failed');
          initLifecycle = 'failed';
          const retryDelay = INIT_RETRY_DELAYS_MS[attempt - 1];
          if (retryDelay === undefined || !visibleRef.current || !optionsRef.current.genome) return;
          initRetryTimer = setTimeout(() => {
            initRetryTimer = null;
            if (destroyed || initLifecycle !== 'failed') return;
            initLifecycle = 'idle';
            requestInit();
          }, retryDelay);
        });
    };
    requestInitRef.current = requestInit;

    const intersectionCallbackAuthority = createDisposableCallbackAuthority<
      Parameters<IntersectionObserverCallback>
    >((entries) => {
      const entry = entries[0];
      const nowVisible = entry.isIntersecting || isContainerActuallyVisible(container);
      const wasVisible = visibleRef.current;
      visibleRef.current = nowVisible;
      if (nowVisible && !wasVisible) {
        plog('visibility-resume', { instance: instanceId });
        recordWebGLTrace('visibility-resume', { instance: instanceId, hasApp: !!app });
      }
      if (!nowVisible && wasVisible) {
        interactionRef.current?.cancelMotion();
        plog('visibility-pause', { instance: instanceId });
        recordWebGLTrace('visibility-pause', { instance: instanceId, hasApp: !!app });
      }

      if (nowVisible) {
        if (hideTimer !== null) {
          clearTimeout(hideTimer);
          hideTimer = null;
        }
        hiddenMapRetention.release(instanceId);
        if (initLifecycle !== 'ready' && !destroyed) {
          requestInit();
        } else if (app && initLifecycle === 'ready') {
          resumeTickRef.current?.();
        }
      } else {
        if (app && hiddenMapIdlePolicy !== 'host-retained') {
          if (hiddenMapIdlePolicy === 'bounded-lru') {
            hiddenMapRetention.retain(instanceId, (reason) => {
              if (hideTimer !== null) {
                clearTimeout(hideTimer);
                hideTimer = null;
              }
              if (
                !destroyed &&
                !visibleRef.current &&
                !isContainerActuallyVisible(container) &&
                !frameCircuitIsOpen()
              ) {
                teardownPixi(reason);
              }
            });
          }
          if (hideTimer === null) {
            hideTimer = setTimeout(() => {
              hideTimer = null;
              if (
                !destroyed &&
                !visibleRef.current &&
                !isContainerActuallyVisible(container) &&
                !frameCircuitIsOpen()
              ) {
                teardownPixi(idleReleaseReason);
              }
            }, IDLE_RELEASE_MS);
          }
        }
      }
    });
    const io = new IntersectionObserver(intersectionCallbackAuthority.callback, {
      threshold: 0,
    });
    visibleRef.current = false;

    const resizeCallbackAuthority = createDisposableCallbackAuthority<
      Parameters<ResizeObserverCallback>
    >(([entry] = []) => {
      if (portalResizeSettling) return;
      if (entry && (entry.contentRect.width <= 0 || entry.contentRect.height <= 0)) return;
      if (app && initLifecycle === 'ready') {
        resumeLiveApp('container-resize-observer');
      } else if (visibleRef.current && !destroyed) {
        requestInit();
      }
    });
    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(resizeCallbackAuthority.callback)
        : null;
    ro?.observe(container);
    io.observe(container);

    const handlePortalHostAttached = () => {
      if (destroyed || !container.isConnected) return;

      visibleRef.current = true;
      if (hideTimer !== null) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
      hiddenMapRetention.release(instanceId);

      if (app && initLifecycle === 'ready') {
        renderLoopRef.current?.renderNow();
        renderLoopRef.current?.resume();
      } else {
        requestInit();
      }

      portalResizeSettling = true;
      portalResizeStability = INITIAL_PORTAL_WIDTH_STABILITY;
      if (portalSettleRafId !== null) cancelAnimationFrame(portalSettleRafId);
      const sampleSettledWidth = () => {
        if (destroyed || !container.isConnected) {
          portalSettleRafId = null;
          return;
        }
        const size = measureContainerSize();
        const result = samplePortalReattachWidth(
          portalResizeStability,
          size.height > 0 ? size.width : 0
        );
        portalResizeStability = result.state;
        if (!result.settled) {
          portalSettleRafId = requestAnimationFrame(sampleSettledWidth);
          return;
        }
        portalResizeSettling = false;
        portalSettleRafId = null;
        if (!resumeLiveApp('tab-portal-host-settled')) {
          requestInit();
        }
      };
      portalSettleRafId = requestAnimationFrame(sampleSettledWidth);
    };
    window.addEventListener(TAB_PORTAL_HOST_ATTACHED_EVENT, handlePortalHostAttached);

    let dprQuery: MediaQueryList | null = null;
    const handleDevicePixelRatioChange = () => {
      armDevicePixelRatioWatch();
      const liveApp = app;
      if (!liveApp || isPixiApplicationDestroyed(liveApp)) return;
      const size = measureContainerSize();
      if (size.width <= 0 || size.height <= 0) return;
      mutateDisplayGeometryPreservingCenter(() =>
        resizePixiCanvas(
          liveApp,
          size.width,
          size.height,
          'device-pixel-ratio-change',
          undefined,
          optionsRef.current.reserveCanvasSpace
        )
      );
      renderLoopRef.current?.renderNow();
    };
    function armDevicePixelRatioWatch(): void {
      if (typeof window.matchMedia !== 'function') return;
      dprQuery?.removeEventListener?.('change', handleDevicePixelRatioChange);
      dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      dprQuery.addEventListener?.('change', handleDevicePixelRatioChange);
    }
    armDevicePixelRatioWatch();

    const initPixi = async () => {
      const current = optionsRef.current;
      if (!current.genome) return;
      const measuredSize = measureContainerSize();
      const initWidth = Math.max(1, measuredSize.width);
      const initHeight = Math.max(1, measuredSize.height);
      stateRef.current.width = initWidth;
      stateRef.current.height = initHeight;
      stateRef.current.geometryHeight = current.geometryHeight ?? initHeight;
      stateRef.current.performanceMode = current.performanceMode ?? 'default';
      stateRef.current.morph = current.morph ?? 0;
      stateRef.current.themeMode = current.themeMode ?? currentWebGLThemeMode();
      stateRef.current.backboneSegments = current.backboneSegments;
      stateRef.current.backboneBoundaryHandles = current.backboneBoundaryHandles;
      stateRef.current.digestFocusRange = current.digestFocusRange ?? null;
      stateRef.current.annotationSearchFocus = current.annotationSearchFocus
        ? { ...current.annotationSearchFocus }
        : null;
      stateRef.current.annotationSearchFocusFeature = cloneAnnotationSearchFocusFeature(
        current.annotationSearchFocusFeature
      );
      applySelectionAction(stateRef.current, {
        type: 'set-external-highlight',
        range: current.highlightRange ?? null,
      });
      applySelectionAction(stateRef.current, {
        type: 'set-external-cursor',
        bp: current.cursorPosition ?? null,
      });

      plog('pixi.initPixi.enter', { instance: instanceId });
      recordWebGLTrace('init-enter', {
        instance: instanceId,
        initWidth,
        initHeight,
        circular: current.circular,
      });

      const preserveDrawingBufferForTests =
        typeof window !== 'undefined' &&
        (window as { __webglExposeForTests?: boolean }).__webglExposeForTests === true &&
        (window as { __webglPreserveDrawingBufferForTests?: boolean })
          .__webglPreserveDrawingBufferForTests !== false;
      const pixiPerformanceOptions = pixiInitOptionsForPerformanceMode(
        stateRef.current.performanceMode ?? 'default'
      );
      const requestedProfile: PixiApplicationProfile = {
        antialias: current.antialias ?? pixiPerformanceOptions.antialias,
        resolution: current.resolution ?? pixiPerformanceOptions.resolution,
        preserveDrawingBuffer: preserveDrawingBufferForTests,
      };
      const retainedPixiApp = reusesPixiApplications
        ? acquireRetainedPixiApplication(requestedProfile)
        : null;
      const pixiApp = retainedPixiApp ?? new Application();
      const reusedPixiApp = retainedPixiApp !== null;
      if (!reusedPixiApp) registerPixiApplication(pixiApp);
      app = pixiApp;
      appProfile = requestedProfile;
      if (!reusedPixiApp) {
        try {
          await ptimeAsync('pixi.app.init', () =>
            pixiApp.init({
              preference: ['webgl'],
              width: initWidth,
              height: initHeight,
              backgroundColor: webglThemeForMode(stateRef.current.themeMode).background,
              powerPreference: 'high-performance',
              antialias: requestedProfile.antialias,
              resolution: requestedProfile.resolution,
              autoDensity: true,
              preserveDrawingBuffer: requestedProfile.preserveDrawingBuffer,

              eventFeatures: { wheel: false },
            })
          );
        } catch (error) {
          if (pixiApp.renderer) destroyPixiApplication(pixiApp);
          else releaseUninitializedPixiApplication(pixiApp);
          if (app === pixiApp) app = null;
          if (appRef.current === pixiApp) appRef.current = null;
          appProfile = null;
          throw error;
        }
      }

      if (destroyed || !isCurrentPixiApp(pixiApp)) {
        destroyPixiApplication(pixiApp);
        if (app === pixiApp) app = null;
        appProfile = null;
        return;
      }

      if (!pixiApp.stage) {
        throw new Error('Pixi application initialized without a stage');
      }

      pixiApp.ticker.stop();

      const latestSize = optionsRef.current;
      const latestMeasuredSize = measureContainerSize();
      const appliedSize = resizePixiCanvas(
        pixiApp,
        latestMeasuredSize.width || latestSize.width || initWidth,
        latestMeasuredSize.height || latestSize.height || initHeight,
        'post-init-latest-props',
        undefined,
        latestSize.reserveCanvasSpace
      );
      stateRef.current.width = appliedSize.width;
      stateRef.current.height = appliedSize.height;
      stateRef.current.geometryHeight = latestSize.geometryHeight ?? appliedSize.height;
      stateRef.current.morph = latestSize.morph ?? 0;

      applyPixiTheme(pixiApp, stateRef.current.themeMode ?? 'light');
      clearPixiCanvas(pixiApp);
      container.appendChild(pixiApp.canvas as HTMLCanvasElement);
      if (reusedPixiApp) {
        try {
          Reflect.apply(pixiApp.renderer.events.setTargetElement, pixiApp.renderer.events, [
            pixiApp.canvas,
          ]);
        } catch (error) {
          destroyPixiApplication(pixiApp);
          if (app === pixiApp) app = null;
          appProfile = null;
          throw error;
        }
      }
      appRef.current = pixiApp;
      recordWebGLTrace('app-ready', {
        instance: instanceId,
        canvasWidth: (pixiApp.canvas as HTMLCanvasElement).width,
        canvasHeight: (pixiApp.canvas as HTMLCanvasElement).height,
        performanceMode: stateRef.current.performanceMode ?? 'default',
        reusedPixiApplication: reusedPixiApp,
      });

      const rendererOptions = optionsRef.current;
      if (!rendererOptions.genome) return;
      const renderer =
        rendererOptions.rendererKind === 'stadium'
          ? new PixiStadiumRenderer()
          : rendererOptions.rendererKind === 'indexed'
            ? new IndexedPixiLinearRenderer()
            : new PixiLinearRenderer();
      pendingRenderer = renderer;

      armCompiledBroadSurfaceRequirementBeforeGenomeLoad(
        renderer,
        rendererOptions,
        rendererOptions.genome
      );

      await ptimeAsync('pixi.renderer.init', () =>
        renderer.init(pixiApp, rendererOptions.genome!, () => stateRef.current)
      );
      if (destroyed || !isCurrentPixiApp(pixiApp)) {
        try {
          renderer.destroy?.();
        } catch {}
        destroyPixiApplication(pixiApp);
        if (app === pixiApp) app = null;
        return;
      }

      let activeGenome = rendererOptions.genome;
      let activeFlatSnapshot = rendererOptions.annotationPresentationSnapshot;
      let activeResidentPages = rendererOptions.annotationResidentPagePublication;

      for (;;) {
        const latest = optionsRef.current;
        if (!latest.genome) return;
        if (!annotationPublicationMatchesGenome(latest, latest.genome)) {
          try {
            renderer.destroy?.();
          } catch {}
          destroyPixiApplication(pixiApp);
          if (app === pixiApp) app = null;
          if (appRef.current === pixiApp) appRef.current = null;
          while (container.firstChild) container.removeChild(container.firstChild);
          return;
        }
        if (latest.genome !== activeGenome) {
          const targetGenome = latest.genome;
          presentedGenomeRef.current = null;
          armCompiledBroadSurfaceRequirementBeforeGenomeLoad(renderer, latest, targetGenome);
          await ptimeAsync('pixi.renderer.load-latest-genome', () =>
            renderer.loadGenome(targetGenome)
          );
          if (destroyed || !isCurrentPixiApp(pixiApp)) {
            try {
              renderer.destroy?.();
            } catch {}
            destroyPixiApplication(pixiApp);
            if (app === pixiApp) app = null;
            return;
          }
          activeGenome = targetGenome;
          activeFlatSnapshot = latest.annotationPresentationSnapshot;
          activeResidentPages = latest.annotationResidentPagePublication;
          continue;
        }
        activeFlatSnapshot = latest.annotationPresentationSnapshot;
        activeResidentPages = latest.annotationResidentPagePublication;
        break;
      }

      applyAnnotationPublication(renderer, activeGenome, activeFlatSnapshot, activeResidentPages);
      genomeRef.current = activeGenome;
      presentedGenomeRef.current = activeGenome;
      rendererRef.current = renderer;
      pendingRenderer = null;
      const pendingViewCenterBp = pendingViewCenterBpRef.current;
      if (pendingViewCenterBp !== null) {
        renderer.setViewCenterBp?.(pendingViewCenterBp, stateRef.current);
        pendingViewCenterBpRef.current = null;
      }
      const rendererGenomeCommitEpoch = ++rendererGenomeCommitEpochRef.current;
      optionsRef.current.onRendererGenomeCommit?.(rendererGenomeCommitEpoch);
      const rendererReadyEpoch = ++rendererReadyEpochRef.current;
      optionsRef.current.onRendererReady?.(rendererReadyEpoch);

      recordWebGLTrace('renderer-ready', {
        instance: instanceId,
        rendererReadyEpoch,
        rendererGenomeCommitEpoch,
        renderer: rendererOptions.rendererKind,
        genomeLength: activeGenome.length,
        featureCount: genomeFeatures(activeGenome).length,
        primerCount: activeGenome.primers?.length ?? 0,
      });

      const latestCutSitesAfterInit = optionsRef.current.cutSites;
      if (latestCutSitesAfterInit !== undefined) {
        asPixiMapRenderer(renderer)?.setCutSites?.(latestCutSitesAfterInit);
      }
      const latestPrimersAfterInit = optionsRef.current.primers;
      if (latestPrimersAfterInit !== undefined) {
        asPixiMapRenderer(renderer)?.setPrimers?.(latestPrimersAfterInit);
      }

      const latestSequenceWindowAfterInit = optionsRef.current.sequenceWindow;
      const afterInit = asPixiMapRenderer(renderer);
      afterInit?.setSequenceWindow?.(latestSequenceWindowAfterInit);
      afterInit?.setAnnotationsVisible?.(optionsRef.current.annotationsVisible ?? true);

      const canvasEl = pixiApp.canvas as HTMLCanvasElement;
      const handleContextLost = (event: Event) => {
        recordWebGLTrace('webgl-context-lost', {
          instance: instanceId,
          cancelable: event.cancelable,
        });
      };
      const handleContextRestored = () => {
        recordWebGLTrace('webgl-context-restored', { instance: instanceId });
      };
      canvasEl.addEventListener('webglcontextlost', handleContextLost);
      canvasEl.addEventListener('webglcontextrestored', handleContextRestored);
      removeContextListeners = () => {
        canvasEl.removeEventListener('webglcontextlost', handleContextLost);
        canvasEl.removeEventListener('webglcontextrestored', handleContextRestored);
      };
      const interaction = attachPixiInteractionAdapter({
        canvasEl,
        stateRef,
        optionsRef,
        renderer,
        activeGenome,
        circular: rendererOptions.circular,
        invalidateRender,
      });
      interactionRef.current = interaction;

      const overlayRegistry = (
        renderer as {
          getOverlayRegistry?: () => { setFrameRequester?: (fn: () => void) => void } | null;
        }
      ).getOverlayRegistry?.();
      overlayRegistry?.setFrameRequester?.(invalidateRender);
      renderLoopRef.current = startWebGLRenderLoop({
        instanceId,
        minimumFrameIntervalMs: () => optionsRef.current.minimumFrameIntervalMs ?? 0,
        app: pixiApp,
        renderer,
        interaction,
        stateRef,
        renderRevisionRef,
        visibleRef,
        rafRef,
        frameCountRef,
        lastFrameTRef,
        presentedFrameListenersRef,
        getPresentedGenome: () => presentedGenomeRef.current,
        criticalPostPresentWorkRef,
        postPresentWorkRef,
        isDestroyed: () => destroyed,
        onFatalFrameError: (failure) => {
          fatalFrameCircuitRef.current ??= Object.freeze({
            status: 'open',
            instance: failure.instance,
            phase: failure.phase,
            name: failure.name,
            message: failure.message,
            stack: failure.stack,
            consecutiveFrameErrors: failure.consecutiveFrameErrors,
            frameCount: failure.frameCount,
            renderRevision: failure.renderRevision,
            zoom: failure.zoom,
            viewOffset: failure.viewOffset,
            width: failure.width,
            height: failure.height,
            openedAt: performance.now(),
          });

          try {
            interactionRef.current?.cleanup();
          } catch {}
          interactionRef.current = null;
          dropRegisteredPostPresentWork('fatal-frame-circuit');
          criticalPostPresentWorkRef.current.clear();
          postPresentWorkRef.current.clear();
          genomeReloadRequestedRef.current = false;
          recordWebGLTrace(
            'frame-circuit-preserved-last-good',
            {
              instance: instanceId,
              phase: failure.phase,
              name: failure.name,
              message: failure.message,
              frameCount: failure.frameCount,
              renderRevision: failure.renderRevision,
            },
            { snapshot: true }
          );
        },
      });
      resumeTickRef.current = renderLoopRef.current.resume;

      exposeWebGLTestHooks({
        renderer,
        state: stateRef.current,
        genome: activeGenome,
        renderNow: renderLoopRef.current.renderNow,
        requestRender: invalidateRender,
        product: rendererOptions.rendererKind === 'indexed' ? 'indexed' : 'sequence',
      });
    };

    return () => {
      destroyed = true;
      recordWebGLTrace('unmount', { instance: instanceId });
      window.removeEventListener(TAB_PORTAL_HOST_ATTACHED_EVENT, handlePortalHostAttached);
      dprQuery?.removeEventListener?.('change', handleDevicePixelRatioChange);
      intersectionCallbackAuthority.dispose();
      resizeCallbackAuthority.dispose();
      io.disconnect();
      ro?.disconnect();
      if (portalSettleRafId !== null) {
        cancelAnimationFrame(portalSettleRafId);
        portalSettleRafId = null;
      }
      portalResizeSettling = false;
      portalResizeStability = INITIAL_PORTAL_WIDTH_STABILITY;
      if (hideTimer !== null) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
      if (initRetryTimer !== null) {
        clearTimeout(initRetryTimer);
        initRetryTimer = null;
      }

      teardownPixi('unmount');
      unregisterWebGLInstance(instanceId);
      resumeTickRef.current = null;
      if (requestInitRef.current === requestInit) requestInitRef.current = null;
      pendingViewCenterBpRef.current = null;
    };
  }, [
    !!options.genome,
    mutateDisplayGeometryPreservingCenter,
    options.circular,
    options.hiddenMapIdlePolicy,
    options.performanceMode,
    options.antialias,
    options.resolution,
  ]);

  useEffect(() => {
    if (frameCircuitIsOpen()) return;
    if (!rendererRef.current) return;
    const renderer = asPixiMapRenderer(rendererRef.current);
    renderer?.setSequenceWindow?.(options.sequenceWindow);
    invalidateRender();
  }, [frameCircuitIsOpen, invalidateRender, options.sequenceWindow]);

  useEffect(() => {
    if (frameCircuitIsOpen()) return;
    if (!rendererRef.current) return;
    const renderer = asPixiMapRenderer(rendererRef.current);
    renderer?.setAnnotationsVisible?.(options.annotationsVisible ?? true);
    invalidateRender();
  }, [frameCircuitIsOpen, invalidateRender, options.annotationsVisible]);

  useEffect(() => {
    if (frameCircuitIsOpen()) return;
    const renderer = rendererRef.current;
    const genome = genomeRef.current;
    if (!renderer || !genome) {
      const currentGenome = optionsRef.current.genome;
      if (currentGenome && annotationPublicationMatchesGenome(optionsRef.current, currentGenome)) {
        requestInitRef.current?.();
      }
      return;
    }
    if (options.circular) return;
    applyAnnotationPublication(renderer, genome);
  }, [
    annotationPublicationMatchesGenome,
    applyAnnotationPublication,
    frameCircuitIsOpen,
    options.annotationPresentationSnapshot,
    options.annotationResidentPagePublication,
    options.circular,
  ]);

  const reconcileRendererGenome = useCallback(() => {
    if (frameCircuitIsOpen()) {
      genomeReloadRequestedRef.current = false;
      return;
    }
    genomeReloadRequestedRef.current = true;
    if (genomeReloadInFlightRef.current) return;
    const run = async () => {
      while (genomeReloadRequestedRef.current) {
        if (frameCircuitIsOpen()) {
          genomeReloadRequestedRef.current = false;
          return;
        }
        genomeReloadRequestedRef.current = false;
        for (;;) {
          if (frameCircuitIsOpen()) return;
          const renderer = rendererRef.current as
            | (PixiLinearRenderer & {
                loadGenome: (g: Genome) => Promise<void> | void;
                setCutSites?: (s: CutSite[]) => void;
                setPrimers?: (primers: readonly Primer[]) => void;
                setSequenceWindow?: (window?: { startBp: number; bases: string }) => void;
              })
            | null;
          const loadedGenome = genomeRef.current;
          const latest = optionsRef.current;
          if (!renderer || !loadedGenome || !latest.genome) return;
          if (latest.genome === loadedGenome) {
            applyAnnotationPublication(
              renderer,
              loadedGenome,
              latest.annotationPresentationSnapshot,
              latest.annotationResidentPagePublication
            );
            break;
          }
          const targetGenome = latest.genome;
          const targetFlatSnapshot = latest.annotationPresentationSnapshot;
          const targetResidentPages = latest.annotationResidentPagePublication;
          if (!annotationPublicationMatchesGenome(latest, targetGenome)) {
            return;
          }
          recordWebGLTrace('genome-reload-start', {
            name: targetGenome.name ?? 'unknown',
            length: targetGenome.length,
            featureCount: genomeFeatures(targetGenome).length,
            primerCount: targetGenome.primers?.length ?? 0,
          });
          presentedGenomeRef.current = null;
          armCompiledBroadSurfaceRequirementBeforeGenomeLoad(renderer, latest, targetGenome);
          const loadResult = renderer.loadGenome(targetGenome);
          if (loadResult && typeof (loadResult as Promise<void>).then === 'function') {
            await loadResult;
          }
          if (frameCircuitIsOpen() || rendererRef.current !== renderer) return;
          genomeRef.current = targetGenome;

          applyAnnotationPublication(
            renderer,
            targetGenome,
            targetFlatSnapshot,
            targetResidentPages
          );
          presentedGenomeRef.current = targetGenome;
          const rendererGenomeCommitEpoch = ++rendererGenomeCommitEpochRef.current;
          optionsRef.current.onRendererGenomeCommit?.(rendererGenomeCommitEpoch);
          if (interactionRef.current) {
            interactionRef.current.genomeLength = targetGenome.length;
            interactionRef.current.genomeCircular = latest.circular;
          }
          const latestCutSites = optionsRef.current.cutSites;
          if (latestCutSites !== undefined) renderer.setCutSites?.(latestCutSites);

          const latestPrimers = optionsRef.current.primers;
          if (latestPrimers !== undefined) renderer.setPrimers?.(latestPrimers);
          renderer.setSequenceWindow?.(optionsRef.current.sequenceWindow);
          invalidateRender();
          recordWebGLTrace('genome-reload-complete', {
            name: targetGenome.name ?? 'unknown',
            length: targetGenome.length,
            featureCount: genomeFeatures(targetGenome).length,
            primerCount: targetGenome.primers?.length ?? 0,
            cutSiteCount: latestCutSites?.length ?? null,
            rendererGenomeCommitEpoch,
          });
          updateWebGLTestHookGenome(renderer, targetGenome);
        }
      }
    };
    const inFlight = run().finally(() => {
      if (genomeReloadInFlightRef.current === inFlight) {
        genomeReloadInFlightRef.current = null;
      }
    });
    genomeReloadInFlightRef.current = inFlight;
  }, [
    annotationPublicationMatchesGenome,
    applyAnnotationPublication,
    frameCircuitIsOpen,
    invalidateRender,
  ]);

  useEffect(() => {
    reconcileRendererGenome();
  }, [
    options.genome,
    options.annotationPresentationSnapshot,
    options.annotationResidentPagePublication,
    reconcileRendererGenome,
  ]);

  const getViewportRange = useCallback((): { start: number; end: number } | null => {
    const state = stateRef.current;
    if (state.comparisonProjection) {
      const camera = resolveComparisonCamera(state.comparisonProjection, state.comparisonCamera);
      return { start: camera.startColumn, end: camera.endColumn };
    }
    if (state.contactProjection) {
      const camera = resolveContactCamera(state.contactProjection, state.contactCamera);
      return { start: camera.xStart, end: camera.xEnd };
    }
    const center = getViewCenter();
    const genomeLength = genomeRef.current?.length;
    const zoom = stateRef.current.zoom;
    if (
      center == null ||
      typeof genomeLength !== 'number' ||
      genomeLength <= 0 ||
      !Number.isFinite(zoom) ||
      zoom <= 0
    ) {
      return null;
    }
    const visibleBp = genomeLength / zoom;
    return {
      start: Math.max(0, center - visibleBp / 2),
      end: Math.min(genomeLength, center + visibleBp / 2),
    };
  }, [getViewCenter]);

  const handle = useMemo<PixiMapHandle>(
    () => ({
      getComparisonCamera: () => {
        const state = stateRef.current;
        return state.comparisonProjection
          ? resolveComparisonCamera(state.comparisonProjection, state.comparisonCamera)
          : null;
      },
      setComparisonCamera: (camera) => {
        const state = stateRef.current;
        if (!state.comparisonProjection) return null;
        interactionRef.current?.cancelGesture?.();
        interactionRef.current?.cancelMotion();
        state.comparisonCamera = resolveComparisonCamera(state.comparisonProjection, camera);
        optionsRef.current.onComparisonCameraChange?.(state.comparisonCamera, 'scroll');
        invalidateRender();
        return { ...state.comparisonCamera };
      },
      getContactCamera: () => {
        const state = stateRef.current;
        return state.contactProjection
          ? resolveContactCamera(state.contactProjection, state.contactCamera)
          : null;
      },
      setContactCamera: (camera) => {
        const state = stateRef.current;
        if (!state.contactProjection) return null;
        interactionRef.current?.cancelGesture?.();
        interactionRef.current?.cancelMotion();
        state.contactCamera = resolveContactCamera(state.contactProjection, camera);
        optionsRef.current.onContactCameraChange?.(state.contactCamera, 'scroll');
        invalidateRender();
        return { ...state.contactCamera };
      },
      getState: () => stateRef.current,
      requestRender: () => {
        invalidateRender();
      },
      subscribeToPresentedFrames: (listener: (receipt: PixiPresentedFrame) => void) => {
        presentedFrameListenersRef.current.add(listener);
        return () => presentedFrameListenersRef.current.delete(listener);
      },
      schedulePostPresentWork: (work: (deadlineMs: number) => void) => {
        postPresentWorkRef.current.add(work);
        invalidateRender();
      },
      getViewCenter,
      getViewportRange,
      getZoomBounds: () => {
        const comparison = stateRef.current.comparisonProjection;
        if (comparison) return { min: 1, max: comparison.layout.columnLength };
        const projection = stateRef.current.contactProjection;
        if (projection)
          return {
            min: 1,
            max: Math.min(projection.xReference.length, projection.yReference.length),
          };
        const renderer = rendererRef.current as
          | {
              getMinZoom?: (state: RenderState) => number;
              getMaxZoom?: (state: RenderState) => number;
            }
          | null
          | undefined;
        const state = stateRef.current;
        const rawMin = renderer?.getMinZoom?.(state);
        const rawMax = renderer?.getMaxZoom?.(state);
        const min = Number.isFinite(rawMin) ? Math.max(0.01, Number(rawMin)) : 0.5;
        const max = Number.isFinite(rawMax) ? Math.max(0.01, Number(rawMax)) : 5000;
        return max < min ? { min: max, max: min } : { min, max };
      },
      getCameraCenter: () => {
        const current = stateRef.current;
        if (current.comparisonProjection) {
          const camera = resolveComparisonCamera(
            current.comparisonProjection,
            current.comparisonCamera
          );
          return (camera.startColumn + camera.endColumn) / 2;
        }
        if (current.contactProjection) {
          const camera = resolveContactCamera(current.contactProjection, current.contactCamera);
          return (camera.xStart + camera.xEnd) / 2;
        }
        const renderer = rendererRef.current as
          | {
              getViewCenterBp?: (state: RenderState) => number;
              screenToBp?: (x: number, y: number, state: RenderState) => number;
            }
          | null
          | undefined;
        const state = stateRef.current;
        if (!renderer || !state) return null;
        const centerBp =
          renderer.getViewCenterBp?.(state) ??
          renderer.screenToBp?.(state.width / 2, state.height / 2, state);
        return Number.isFinite(centerBp) ? (centerBp as number) : null;
      },
      setDisplaySize: (size: {
        width: number;
        height: number;
        geometryHeight?: number;
        morph?: number;
        backingWidth?: number;
        backingHeight?: number;
        cssWidth?: number;
        cssHeight?: number;
        immediate?: boolean;
      }) => {
        if (frameCircuitIsOpen()) return;
        const s = stateRef.current;
        const app = appRef.current;

        const backingChanged = mutateDisplayGeometryPreservingCenter(() => {
          let changed = false;
          if (app && size.width > 0 && size.height > 0) {
            changed = resizePixiCanvas(
              app,
              size.backingWidth ?? size.width,
              size.backingHeight ?? size.height,
              'imperative-display-size',
              {
                width: size.cssWidth ?? size.width,
                height: size.cssHeight ?? size.height,
              },
              optionsRef.current.reserveCanvasSpace
            ).backingChanged;
            s.width = size.width;
            s.height = size.height;
          } else {
            s.width = size.width;
            s.height = size.height;
          }
          s.geometryHeight = size.geometryHeight ?? size.height;
          s.morph = size.morph ?? s.morph;
          return changed;
        });
        invalidateRender();

        if (backingChanged || size.immediate !== false) renderLoopRef.current?.renderNow();
      },
      setZoom: (zoom: number) => {
        if (frameCircuitIsOpen()) return;
        const state = stateRef.current;
        if (state.comparisonProjection) {
          interactionRef.current?.cancelGesture?.();
          const projection = state.comparisonProjection;
          const camera = resolveComparisonCamera(projection, state.comparisonCamera);
          const currentZoom =
            projection.layout.columnLength / (camera.endColumn - camera.startColumn);
          const plot = comparisonPlot(state.width, state.height);
          state.comparisonCamera = zoomComparisonCamera(
            projection,
            camera,
            zoom / currentZoom,
            plot.x + plot.width / 2,
            plot
          );
          optionsRef.current.onComparisonCameraChange?.(state.comparisonCamera, 'zoom');
          invalidateRender();
          return;
        }
        if (state.contactProjection) {
          interactionRef.current?.cancelGesture?.();
          const projection = state.contactProjection;
          const camera = resolveContactCamera(projection, state.contactCamera);
          const currentZoom = projection.xReference.length / (camera.xEnd - camera.xStart);
          const plot = contactPlotRect(state.width, state.height);
          state.contactCamera = zoomContactCamera(
            projection,
            camera,
            zoom / currentZoom,
            plot.x + plot.width / 2,
            plot.y + plot.height / 2,
            plot
          );
          optionsRef.current.onContactCameraChange?.(state.contactCamera, 'zoom');
          invalidateRender();
          return;
        }
        if (stateRef.current.zoom !== zoom) interactionRef.current?.cancelMotion();
        stateRef.current.zoom = zoom;
        invalidateRender();
      },
      setViewport: (startBp: number, endBp: number) => {
        if (frameCircuitIsOpen()) return;
        stateRef.current.viewportRange = [startBp, endBp];
        recordWebGLTrace('viewport-sync', { startBp, endBp });
        invalidateRender();
      },
      setCameraViewport: (startBp: number, endBp: number) => {
        if (frameCircuitIsOpen()) return null;
        const state = stateRef.current;
        if (state.comparisonProjection) {
          if (!Number.isFinite(startBp) || !Number.isFinite(endBp) || endBp <= startBp) return null;
          interactionRef.current?.cancelGesture?.();
          state.comparisonCamera = resolveComparisonCamera(state.comparisonProjection, {
            projectionId: state.comparisonProjection.id,
            startColumn: startBp,
            endColumn: endBp,
          });
          optionsRef.current.onComparisonCameraChange?.(state.comparisonCamera, 'zoom');
          invalidateRender();
          return {
            start: state.comparisonCamera.startColumn,
            end: state.comparisonCamera.endColumn,
          };
        }
        if (state.contactProjection) {
          if (!Number.isFinite(startBp) || !Number.isFinite(endBp) || endBp <= startBp) return null;
          interactionRef.current?.cancelGesture?.();
          state.contactCamera = resolveContactCamera(state.contactProjection, {
            ...resolveContactCamera(state.contactProjection, state.contactCamera),
            xStart: startBp,
            xEnd: endBp,
          });
          optionsRef.current.onContactCameraChange?.(state.contactCamera, 'zoom');
          invalidateRender();
          return { start: state.contactCamera.xStart, end: state.contactCamera.xEnd };
        }
        let committedRange: { start: number; end: number } | null = null;
        stateRef.current.viewportRange = [startBp, endBp];
        const visibleBp = endBp - startBp;
        const renderer = rendererRef.current as
          | {
              genome?: { length?: number };
              setViewCenterBp?: (bp: number, state: RenderState) => void;
            }
          | null
          | undefined;
        const genomeLength = renderer?.genome?.length;
        if (
          typeof genomeLength === 'number' &&
          genomeLength > 0 &&
          visibleBp > 0 &&
          Number.isFinite(visibleBp) &&
          typeof renderer?.setViewCenterBp === 'function' &&
          stateRef.current.width > 0
        ) {
          const zoom = genomeLength / visibleBp;
          const centerBp = (startBp + endBp) / 2;
          const currentCenter = getViewCenter();

          if (
            stateRef.current.zoom !== zoom ||
            currentCenter === null ||
            Math.abs(currentCenter - centerBp) > 1e-7
          )
            interactionRef.current?.cancelMotion();
          stateRef.current.zoom = zoom;
          renderer.setViewCenterBp(centerBp, stateRef.current);
          committedRange = getViewportRange();
          if (committedRange) {
            optionsRef.current.onCameraChange?.(
              getViewCenter() ?? centerBp,
              'zoom',
              stateRef.current.zoom,
              committedRange
            );
          }
        }
        recordWebGLTrace('camera-viewport-sync', { startBp, endBp });
        invalidateRender();
        return committedRange;
      },
      setViewCenter: (centerBp: number) => {
        if (frameCircuitIsOpen()) return;
        const state = stateRef.current;
        if (state.comparisonProjection) {
          if (!Number.isFinite(centerBp)) return;
          interactionRef.current?.cancelGesture?.();
          const camera = resolveComparisonCamera(
            state.comparisonProjection,
            state.comparisonCamera
          );
          const span = camera.endColumn - camera.startColumn;
          state.comparisonCamera = resolveComparisonCamera(state.comparisonProjection, {
            projectionId: state.comparisonProjection.id,
            startColumn: centerBp - span / 2,
            endColumn: centerBp + span / 2,
          });
          optionsRef.current.onComparisonCameraChange?.(state.comparisonCamera, 'scroll');
          invalidateRender();
          return;
        }
        if (state.contactProjection) {
          if (!Number.isFinite(centerBp)) return;
          interactionRef.current?.cancelGesture?.();
          const camera = resolveContactCamera(state.contactProjection, state.contactCamera);
          const span = camera.xEnd - camera.xStart;
          state.contactCamera = resolveContactCamera(state.contactProjection, {
            ...camera,
            xStart: centerBp - span / 2,
            xEnd: centerBp + span / 2,
          });
          optionsRef.current.onContactCameraChange?.(state.contactCamera, 'scroll');
          invalidateRender();
          return;
        }
        const currentCenter = getViewCenter();
        if (currentCenter === null || Math.abs(currentCenter - centerBp) > 1e-7)
          interactionRef.current?.cancelMotion();
        const renderer = rendererRef.current as
          | {
              setViewCenterBp?: (bp: number, state: RenderState) => void;
            }
          | null
          | undefined;
        if (renderer?.setViewCenterBp) {
          renderer.setViewCenterBp(centerBp, stateRef.current);
          pendingViewCenterBpRef.current = null;
        } else {
          pendingViewCenterBpRef.current = centerBp;
        }

        optionsRef.current.onCameraChange?.(
          getViewCenter() ?? centerBp,
          'zoom',
          stateRef.current.zoom,
          getViewportRange() ?? { start: centerBp, end: centerBp + 1 }
        );
        recordWebGLTrace('camera-center-sync', { centerBp });
        invalidateRender();
      },
      setResidueLinkRange: (range: [number, number] | null) => {
        applySelectionAction(stateRef.current, {
          type: 'set-residue-link-range',
          range,
        });
        recordWebGLTrace('residue-link-range-sync', { range: stateRef.current.residueLinkRange });
        invalidateRender();
      },
      setHoveredCodon: (codon: { start: number; end: number; strand: 1 | -1 } | null) => {
        stateRef.current.hoveredCodon = codon
          ? { start: codon.start, end: codon.end, strand: codon.strand }
          : null;
        recordWebGLTrace('codon-hover-sync', { codon: stateRef.current.hoveredCodon });
        invalidateRender();
      },
      setSelectedCodons: (
        codons: ReadonlyArray<{ start: number; end: number; strand: 1 | -1 }>
      ) => {
        stateRef.current.selectedCodons = codons;
        recordWebGLTrace('codon-selection-sync', { count: codons.length });
        invalidateRender();
      },

      getLinearRenderer: () => {
        const r = rendererRef.current;
        if (!r) return null;
        if (optionsRef.current.circular) return null;
        return r as PixiLinearRenderer;
      },
    }),
    [
      frameCircuitIsOpen,
      getViewCenter,
      getViewportRange,
      invalidateRender,
      mutateDisplayGeometryPreservingCenter,
    ]
  );

  return { containerRef, handle };
}
