import { createCanvasFrustrationDetector } from './canvas-frustration';
import {
  PixiLinearRenderer,
  setupInteraction,
  perfTime as ptime,
  recordWebGLSelectionDebug,
} from '@waypoint/genome-renderer';
import type {
  Genome,
  FeatureHitPayload,
  BackboneBoundaryHandleHitPayload,
  BackbonePartHitPayload,
  BackbonePartReorderPreview,
  InteractionHandle,
  PixiStadiumRenderer,
  PileupColumnHitPayload,
  PrimerHandleHitPayload,
  RenderState,
  ReadHitPayload,
  WebGLHitTarget,
} from '@waypoint/genome-renderer';
import type { UsePixiMapOptions } from './types';
import { PrimerOverlay } from '../renderers/pixi/overlays/primer-overlay';
import { resolveWebGLShiftClickRange } from './webgl-shift-selection';
import { recenterViewportRangeOnCamera } from './webgl-viewport-range';

type MutableRef<T> = { current: T };

type LocalPointer = {
  x: number;
  y: number;
  rect: { left: number; top: number; width: number; height: number };
  scaleX: number;
  scaleY: number;
};

function canvasLocalPoint(
  canvasEl: HTMLCanvasElement,
  state: RenderState,
  pageX: number,
  pageY: number
): LocalPointer {
  const rect = canvasEl.getBoundingClientRect();
  const scaleX = rect.width > 0 ? state.width / rect.width : 1;
  const scaleY = rect.height > 0 ? state.height / rect.height : 1;
  return {
    x: (pageX - rect.left) * scaleX,
    y: (pageY - rect.top) * scaleY,
    rect: {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    },
    scaleX,
    scaleY,
  };
}

export function attachPixiInteractionAdapter(params: {
  canvasEl: HTMLCanvasElement;
  stateRef: MutableRef<RenderState>;
  optionsRef: MutableRef<UsePixiMapOptions>;
  renderer: PixiStadiumRenderer | PixiLinearRenderer;
  activeGenome: Genome;
  circular: boolean;
  invalidateRender?: () => void;
}): InteractionHandle {
  const { canvasEl, stateRef, optionsRef, renderer, activeGenome, circular, invalidateRender } =
    params;
  const interaction = setupInteraction(canvasEl, stateRef.current);
  const detectFrustration = createCanvasFrustrationDetector();
  const onClick = (event: MouseEvent) => {
    if (event.button !== 0 || !optionsRef.current.onUiFrustration) return;
    const frustration = detectFrustration(
      interaction.hitTestFn?.(event.clientX, event.clientY) ?? null,
      performance.now()
    );
    if (frustration) optionsRef.current.onUiFrustration?.(frustration);
  };
  canvasEl.addEventListener('click', onClick);
  const cleanup = interaction.cleanup;
  interaction.cleanup = () => {
    canvasEl.removeEventListener('click', onClick);
    cleanup();
  };
  let pendingZoomAnchorBp: number | null = null;
  interaction.genomeLength = activeGenome.length;
  interaction.genomeCircular = circular;
  interaction.resolveShiftClickRange = resolveWebGLShiftClickRange;

  interaction.screenToBp = (sx, sy, s) => {
    const local = canvasLocalPoint(canvasEl, stateRef.current, sx, sy);
    const bp = renderer.screenToBp(local.x, local.y, s);
    recordWebGLSelectionDebug('adapter.screenToBp', {
      page: { x: sx, y: sy },
      local: { x: local.x, y: local.y },
      rect: local.rect,
      scale: { x: local.scaleX, y: local.scaleY },
      canvas: {
        widthAttr: canvasEl.width,
        heightAttr: canvasEl.height,
        clientWidth: canvasEl.clientWidth,
        clientHeight: canvasEl.clientHeight,
      },
      state: {
        width: s.width,
        height: s.height,
        zoom: s.zoom,
        viewOffset: s.viewOffset,
        morph: s.morph,
        highlightRange: s.highlightRange,
      },
      circular: optionsRef.current.circular,
      resultBp: bp,
    });
    return bp;
  };
  if ('screenToBoundaryBp' in renderer) {
    interaction.screenToBoundaryBp = (sx, sy, s) => {
      const local = canvasLocalPoint(canvasEl, stateRef.current, sx, sy);
      return renderer.screenToBoundaryBp(local.x, local.y, s);
    };
  }
  if ('screenToPrimerBoundaryBp' in renderer) {
    interaction.screenToPrimerBoundaryBp = (primerHandle, sx, sy, s) => {
      const local = canvasLocalPoint(canvasEl, stateRef.current, sx, sy);
      return renderer.screenToPrimerBoundaryBp(local.x, local.y, s, primerHandle.id);
    };
  }

  const hitTestPileupAtLocal = (local: LocalPointer): WebGLHitTarget | null => {
    const hitTestReadEvent = (
      renderer as {
        hitTestReadEvent?: (x: number, y: number) => ReadHitPayload | null;
      }
    ).hitTestReadEvent;
    const readHit = hitTestReadEvent?.call(renderer, local.x, local.y) ?? null;
    const hitTestPileupColumn = (
      renderer as {
        hitTestPileupColumn?: (x: number, y: number) => PileupColumnHitPayload | null;
      }
    ).hitTestPileupColumn;
    const columnHit = hitTestPileupColumn?.call(renderer, local.x, local.y) ?? null;
    if (readHit) {
      return {
        kind: 'read',
        payload: columnHit ? { ...readHit, column: columnHit } : readHit,
      };
    }
    if (columnHit) return { kind: 'pileup-column', payload: columnHit };
    return null;
  };

  interaction.hitTestPileupFn = (sx, sy) =>
    hitTestPileupAtLocal(canvasLocalPoint(canvasEl, stateRef.current, sx, sy));

  interaction.hitTestPrimerFn = (sx, sy) => {
    const local = canvasLocalPoint(canvasEl, stateRef.current, sx, sy);
    const path = renderer.getCurrentPathMapper();
    if (!path) return null;
    const hit = renderer
      .getOverlayRegistry()
      ?.get('primers')
      ?.hitTest(local.x, local.y, path, stateRef.current);
    return hit?.kind === 'feature' ? hit : null;
  };

  interaction.hitTestFn = (sx, sy) => {
    const local = canvasLocalPoint(canvasEl, stateRef.current, sx, sy);
    const registry = renderer.getOverlayRegistry();
    const path = renderer.getCurrentPathMapper();
    const primerHandleHit =
      registry && path
        ? registry.get('primers')?.hitTest(local.x, local.y, path, stateRef.current)
        : null;
    if (primerHandleHit?.kind === 'primer-handle') return primerHandleHit;
    const hitTestBackboneBoundaryHandle = (
      renderer as {
        hitTestBackboneBoundaryHandle?: (x: number, y: number) => WebGLHitTarget | null;
      }
    ).hitTestBackboneBoundaryHandle;
    const backboneBoundaryHandleHit =
      hitTestBackboneBoundaryHandle?.call(renderer, local.x, local.y) ?? null;
    if (backboneBoundaryHandleHit) return backboneBoundaryHandleHit;
    const hitTestBackbonePart = (
      renderer as {
        hitTestBackbonePart?: (x: number, y: number) => WebGLHitTarget | null;
      }
    ).hitTestBackbonePart;
    const backbonePartHit = hitTestBackbonePart?.call(renderer, local.x, local.y) ?? null;
    if (backbonePartHit) return backbonePartHit;
    const pileupHit = hitTestPileupAtLocal(local);
    if (pileupHit) return pileupHit;

    const hitTestCodon = (
      renderer as {
        hitTestCodon?: (
          x: number,
          y: number
        ) => {
          start: number;
          end: number;
          featureId: number;
          featureStart: number;
          featureEnd: number;
          strand: 1 | -1;
        } | null;
      }
    ).hitTestCodon;
    const codonHit = hitTestCodon?.call(renderer, local.x, local.y) ?? null;
    if (codonHit) return { kind: 'codon', payload: codonHit };

    const hitTestOrf = (
      renderer as {
        hitTestOrf?: (
          x: number,
          y: number
        ) => {
          start: number;
          end: number;
          strand: '+' | '-';
          frame: number;
          length: number;
        } | null;
      }
    ).hitTestOrf;
    const orfHit = hitTestOrf?.call(renderer, local.x, local.y) ?? null;
    if (orfHit) return { kind: 'orf', payload: orfHit };

    const hitTestCutSite = (
      renderer as {
        hitTestCutSite?: (x: number, y: number) => WebGLHitTarget | null;
      }
    ).hitTestCutSite;
    const cutSiteHit = hitTestCutSite?.call(renderer, local.x, local.y) ?? null;
    if (cutSiteHit) return cutSiteHit;

    if (!registry || !path) return null;
    return registry.hitTestAll(local.x, local.y, path, stateRef.current);
  };

  interaction.hitTestHoverFeatureFn = (sx, sy) => {
    const local = canvasLocalPoint(canvasEl, stateRef.current, sx, sy);
    const hitTestIntron = (
      renderer as {
        hitTestIntron?: (x: number, y: number) => FeatureHitPayload | null;
      }
    ).hitTestIntron;
    return hitTestIntron?.call(renderer, local.x, local.y) ?? null;
  };

  interaction.hitTestSelectionHandle = (sx, sy, s) => {
    const local = canvasLocalPoint(canvasEl, stateRef.current, sx, sy);
    const hitTestSelectionHandle = (
      renderer as {
        hitTestSelectionHandle?: (
          x: number,
          y: number,
          state: RenderState
        ) => 'start' | 'end' | null;
      }
    ).hitTestSelectionHandle;
    return hitTestSelectionHandle?.call(renderer, local.x, local.y, s) ?? null;
  };

  interaction.hitTestNucleotideText = (sx, sy, s) => {
    const local = canvasLocalPoint(canvasEl, stateRef.current, sx, sy);
    const hitTestNucleotideText = (
      renderer as {
        hitTestNucleotideText?: (x: number, y: number, state: RenderState) => boolean;
      }
    ).hitTestNucleotideText;
    return hitTestNucleotideText?.call(renderer, local.x, local.y, s) ?? false;
  };

  interaction.shouldZoomToCursor = (sx, sy, s) => {
    const hitTestZoomAnchor = (
      renderer as {
        hitTestZoomAnchor?: (x: number, y: number, state: RenderState) => boolean;
      }
    ).hitTestZoomAnchor;
    if (!hitTestZoomAnchor) return true;
    const local = canvasLocalPoint(canvasEl, stateRef.current, sx, sy);
    return hitTestZoomAnchor.call(renderer, local.x, local.y, s);
  };

  interaction.shouldShowPositionGuide = (sx, sy, s) => {
    const hitTestPositionGuideSurface = (
      renderer as {
        hitTestPositionGuideSurface?: (x: number, y: number, state: RenderState) => boolean;
      }
    ).hitTestPositionGuideSurface;
    if (!hitTestPositionGuideSurface) return true;
    const local = canvasLocalPoint(canvasEl, stateRef.current, sx, sy);
    return hitTestPositionGuideSurface.call(renderer, local.x, local.y, s);
  };

  interaction.getMinZoom = (s) => {
    const getMinZoom = (
      renderer as {
        getMinZoom?: (state: RenderState) => number;
      }
    ).getMinZoom;
    return getMinZoom?.call(renderer, s) ?? 0.5;
  };

  interaction.getMaxZoom = (s) => {
    const getMaxZoom = (
      renderer as {
        getMaxZoom?: (state: RenderState) => number;
      }
    ).getMaxZoom;
    return getMaxZoom?.call(renderer, s) ?? Number.POSITIVE_INFINITY;
  };

  interaction.onCameraChange = (reason) => {
    const getViewCenterBp = (
      renderer as {
        getViewCenterBp?: (state: RenderState) => number;
      }
    ).getViewCenterBp;
    const centerBp =
      getViewCenterBp?.call(renderer, stateRef.current) ??
      renderer.screenToBp(
        stateRef.current.width / 2,
        stateRef.current.height / 2,
        stateRef.current
      );
    if (reason === 'scroll' && optionsRef.current.syncViewportRangeOnCameraScroll) {
      const nextViewportRange = recenterViewportRangeOnCamera({
        currentRange: stateRef.current.viewportRange,
        centerBp,
        genomeLength: interaction.genomeLength,
        circular: interaction.genomeCircular,
      });
      if (nextViewportRange) stateRef.current.viewportRange = nextViewportRange;
    }
    const visibleBp = interaction.genomeLength / stateRef.current.zoom;
    const viewportRange = {
      start: Math.max(0, centerBp - visibleBp / 2),
      end: Math.min(interaction.genomeLength, centerBp + visibleBp / 2),
    };
    optionsRef.current.onCameraChange?.(centerBp, reason, stateRef.current.zoom, viewportRange, {
      zoomAnchorBp: reason === 'zoom' ? pendingZoomAnchorBp : null,
    });
    pendingZoomAnchorBp = null;
  };

  let lastHoveredFeatureId: number | null = null;
  interaction.onHoverFeature = (feat, sx, sy) => {
    const local = canvasLocalPoint(canvasEl, stateRef.current, sx, sy);
    const latest = optionsRef.current;
    const nextId = feat?.id ?? null;
    if (nextId !== lastHoveredFeatureId) {
      lastHoveredFeatureId = nextId;
      latest.onFeatureHover?.(nextId);
    }
    const position = feat ? renderer.screenToBp(local.x, local.y, stateRef.current) : null;
    latest.onHoverChange?.(feat ? { ...feat, position, screenX: local.x, screenY: local.y } : null);
  };
  interaction.onCodonHover = (codon) => {
    optionsRef.current.onCodonHover?.(codon);
  };
  interaction.onReadHover = (read) => {
    optionsRef.current.onReadHoverChange?.(read);
  };
  interaction.onReadClick = (read) => {
    optionsRef.current.onReadClick?.(read);
  };
  interaction.onPileupColumnHover = (column) => {
    optionsRef.current.onPileupColumnHoverChange?.(column);
  };
  interaction.onPositionClick = (bp: number) => {
    optionsRef.current.onPositionClick?.(bp);
  };
  interaction.onPositionDoubleClick = (bp: number) => {
    optionsRef.current.onPositionDoubleClick?.(bp);
  };
  interaction.onFeatureClick = (feat) => {
    optionsRef.current.onFeatureClick?.(feat?.id ?? null);
    optionsRef.current.onFeatureHitClick?.(feat);
  };
  interaction.onFeatureRangeCommit = (feat) => {
    optionsRef.current.onFeatureRangeCommit?.(feat.id);
    optionsRef.current.onFeatureRangeHitCommit?.(feat);
  };
  interaction.onOrfClick = (orf) => {
    optionsRef.current.onOrfClick?.(orf);
  };
  interaction.onOrfRangeCommit = (orf) => {
    optionsRef.current.onOrfRangeCommit?.(orf);
  };
  interaction.onContextMenu = (event, context) => {
    const id = context.hitResult?.kind === 'feature' ? context.hitResult.payload.id : null;
    const orf = context.hitResult?.kind === 'orf' ? context.hitResult.payload : null;
    optionsRef.current.onContextMenu?.(event, {
      position: context.position,
      featureId: typeof id === 'number' ? id : null,
      orf,
      hitResult: context.hitResult,
      highlightRange: context.highlightRange,
    });
  };
  interaction.onSelectionChange = (lo, hi) => {
    optionsRef.current.onSelectionChange?.(lo, hi);
  };
  interaction.onSelectionPreview = (lo, hi) => {
    optionsRef.current.onSelectionPreview?.(lo, hi);
  };
  interaction.onSelectionStart = (mode) => {
    optionsRef.current.onSelectionStart?.(mode);
  };
  interaction.onPrimerHandleDragPreview = (
    primerHandle: PrimerHandleHitPayload,
    boundaryBp: number
  ) => {
    const projectPreview = optionsRef.current.onPrimerHandleDragPreview;
    const preview = projectPreview?.(primerHandle, boundaryBp) ?? null;
    if (projectPreview && !preview) return;
    const primerOverlay = renderer.getOverlayRegistry().get('primers');
    if (
      primerOverlay instanceof PrimerOverlay &&
      primerOverlay.setPbsEndpointPreview(primerHandle.id, preview ?? boundaryBp)
    ) {
      invalidateRender?.();
    }
  };
  interaction.onPrimerHandleDragCommit = (
    primerHandle: PrimerHandleHitPayload,
    boundaryBp: number
  ) => {
    const primerOverlay = renderer.getOverlayRegistry().get('primers');
    if (
      primerOverlay instanceof PrimerOverlay &&
      primerOverlay.clearPbsEndpointPreview(primerHandle.id)
    ) {
      invalidateRender?.();
    }
    optionsRef.current.onPrimerHandleDragCommit?.(primerHandle, boundaryBp);
  };
  interaction.onBackboneBoundaryHandleDragPreview = (
    boundaryHandle: BackboneBoundaryHandleHitPayload,
    boundaryBp: number
  ) => {
    const setPreview = (
      renderer as {
        setBackboneBoundaryHandlePreview?: (
          handle: BackboneBoundaryHandleHitPayload,
          boundaryBp: number,
          state: RenderState
        ) => boolean;
      }
    ).setBackboneBoundaryHandlePreview;
    if (setPreview?.call(renderer, boundaryHandle, boundaryBp, stateRef.current)) {
      invalidateRender?.();
    }
    optionsRef.current.onBackboneBoundaryHandleDragPreview?.(boundaryHandle, boundaryBp);
  };
  interaction.onBackboneBoundaryHandleDragCommit = (
    boundaryHandle: BackboneBoundaryHandleHitPayload,
    boundaryBp: number
  ) => {
    optionsRef.current.onBackboneBoundaryHandleDragCommit?.(boundaryHandle, boundaryBp);
    (
      renderer as {
        clearBackboneBoundaryHandlePreview?: () => void;
      }
    ).clearBackboneBoundaryHandlePreview?.call(renderer);
    invalidateRender?.();
  };
  interaction.onBackbonePartSelect = (part: BackbonePartHitPayload) => {
    optionsRef.current.onBackbonePartSelect?.(part);
  };
  interaction.onBackbonePartHover = (part: BackbonePartHitPayload | null) => {
    const setHoveredPart = (
      renderer as {
        setHoveredBackbonePart?: (regionId: string | null) => boolean;
      }
    ).setHoveredBackbonePart;
    if (setHoveredPart?.call(renderer, part?.regionId ?? null)) invalidateRender?.();
  };
  interaction.canDragBackbonePart = () =>
    Boolean(
      optionsRef.current.onBackbonePartDragPreview && optionsRef.current.onBackbonePartDragCommit
    );
  interaction.onBackbonePartDragPreview = (part: BackbonePartHitPayload, boundaryBp: number) => {
    const projectPreview = optionsRef.current.onBackbonePartDragPreview;
    const preview = projectPreview?.(part, boundaryBp) ?? null;
    if (projectPreview && !preview) {
      (
        renderer as {
          clearBackbonePartInsertionPreview?: () => void;
        }
      ).clearBackbonePartInsertionPreview?.call(renderer);
      invalidateRender?.();
      return;
    }
    const setPreview = (
      renderer as {
        setBackbonePartInsertionPreview?: (
          part: BackbonePartHitPayload,
          boundaryBp: number,
          preview: BackbonePartReorderPreview | null
        ) => boolean;
      }
    ).setBackbonePartInsertionPreview;
    if (setPreview?.call(renderer, part, boundaryBp, preview)) invalidateRender?.();
  };
  interaction.onBackbonePartDragCommit = (part: BackbonePartHitPayload, boundaryBp: number) => {
    optionsRef.current.onBackbonePartDragCommit?.(part, boundaryBp);
    (
      renderer as {
        clearBackbonePartInsertionPreview?: () => void;
      }
    ).clearBackbonePartInsertionPreview?.call(renderer);
    invalidateRender?.();
  };
  if ('adjustViewOffsetForZoom' in renderer) {
    interaction.onBeforeZoom = (oldZ, newZ, cursorX, cursorY) =>
      ptime(`${circular ? 'stadium' : 'linear'}.adjustViewOffsetForZoom`, () => {
        const local = canvasLocalPoint(canvasEl, stateRef.current, cursorX, cursorY);
        const anchorBp = renderer.screenToBp(local.x, local.y, stateRef.current);
        pendingZoomAnchorBp = Number.isFinite(anchorBp)
          ? Math.max(0, Math.min(interaction.genomeLength, anchorBp))
          : null;
        (
          renderer as {
            adjustViewOffsetForZoom: (
              oldZoom: number,
              newZoom: number,
              state: RenderState,
              cursorX?: number,
              cursorY?: number
            ) => void;
          }
        ).adjustViewOffsetForZoom(oldZ, newZ, stateRef.current, local.x, local.y);
      });
  }

  let testCameraChangeBridge: ((reason: 'scroll' | 'zoom') => void) | null = null;
  type WebGLCameraTestWindow = Window & {
    __webglExposeForTests?: boolean;
    __webglFireCameraChange?: (reason: 'scroll' | 'zoom') => void;
  };
  const testWindow = typeof window === 'undefined' ? null : (window as WebGLCameraTestWindow);
  if (testWindow?.__webglExposeForTests) {
    testCameraChangeBridge = (reason: 'scroll' | 'zoom') => {
      interaction.onCameraChange?.(reason);
    };
    testWindow.__webglFireCameraChange = testCameraChangeBridge;
  }

  const cleanupInteraction = interaction.cleanup.bind(interaction);
  interaction.cleanup = () => {
    if (testWindow && testCameraChangeBridge) {
      if (testWindow.__webglFireCameraChange === testCameraChangeBridge) {
        delete testWindow.__webglFireCameraChange;
      }
    }
    cleanupInteraction();
  };

  return interaction;
}
