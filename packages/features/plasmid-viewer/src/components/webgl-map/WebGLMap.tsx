import { reportOrfPaint, type OrfPresentation } from '@waypoint/workspace-editor/orf-observation';

import React, {
  useMemo,
  useState,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  forwardRef,
  memo,
  useImperativeHandle,
} from 'react';
import type { ParsedPlasmid } from '../../types';
import { cdsRegionHoverLine } from '@waypoint/workspace-editor/codon-hover-tooltip-lines';
import type { WebGLMapHandle } from './types';
import type {
  BackboneBoundaryHandleRange,
  BackboneSegment as MapBackboneSegment,
} from '../map-types';
import { convertPlasmid, cssColorToHex, primerRenderId } from './plasmid-to-genome';
import {
  useHiddenMapIdlePolicy,
  usePixiMap,
  type HoverFeatureInfo,
  type UsePixiMapOptions,
} from './use-pixi-map';
import {
  resolveWebGLPerformanceMode,
  type WebGLPerformanceMode,
  type WebGLPerformancePreference,
} from './webgl-performance-profile';
import { commitWebGLFeatureRange, focusWebGLFeature } from './webgl-feature-selection';
import { selectionWrapsOrigin } from './webgl-annotation-selection';
import {
  genomeFeatures,
  perfLog as plog,
  perfMark as pmark,
  recordWebGLSelectionDebug,
  resolveAnnotationDataColors,
} from '@waypoint/genome-renderer';
import type {
  AnnotationChangeDecoration,
  BackboneBoundaryHandle,
  BackboneBoundaryHandleHitPayload,
  BackbonePartHitPayload,
  BackbonePartReorderPreview,
  BackboneSegment as GenomeBackboneSegment,
  CutSite,
} from '@waypoint/genome-renderer';
import type {
  CutSiteHitPayload,
  PrimerHandleHitPayload,
  WebGLHitTarget,
} from '@waypoint/genome-renderer';
import type { GenomeOrf, GenomeOrfIdentity } from '@waypoint/genome-renderer';
import {
  annotationIdentityFromFeature,
  featureMatchesAnnotation,
  type WebGLAnnotationSelectionIdentity,
} from './webgl-annotation-selection';

export interface WebGLMapProps {
  plasmid: ParsedPlasmid;

  changedAnnotationNames?: ReadonlySet<string>;
  annotationColorsByIdentity?: ReadonlyMap<string, string>;
  missingAnnotationColor?: string;
  height?: number;

  geometryHeight?: number;
  centerStadiumOverview?: boolean;
  reserveCanvasSpace?: UsePixiMapOptions['reserveCanvasSpace'];
  surfaceVisible?: boolean;
  width?: number;
  circular?: boolean;
  morphToCircle?: number;

  selectionStart?: number | null;
  selectionEnd?: number | null;
  cursorPosition?: number | null;

  cursorBlinking?: boolean;
  orfs?: GenomeOrf[];
  onOrfsPresented?: OrfPresentation['presented'];
  candidateOrf?: GenomeOrfIdentity | null;

  backboneSegments?: MapBackboneSegment[];

  selectedBackbonePartRegionId?: string | null;

  crossoverHandleRange?: BackboneBoundaryHandleRange | null;

  digestFocusRange?: { start: number; end: number; wraps?: boolean } | null;

  externalHoveredFeatureId?: number | null;

  externalResidueLinkRange?: [number, number] | null;

  externalHoveredCodon?: { start: number; end: number; strand: 1 | -1 } | null;

  externalSelectedCodons?: ReadonlyArray<{ start: number; end: number; strand: 1 | -1 }>;

  onFeatureSelect?: (feature: { start: number; end: number } | null) => void;

  onFeatureHover?: (featureId: number | null) => void;
  onCodonHover?: (codon: { start: number; end: number; strand: 1 | -1 } | null) => void;
  onPrimerClick?: (primer: ParsedPlasmid['primers'][0]) => void;

  onPrimerPbsEndpointPreview?: (
    primer: ParsedPlasmid['primers'][0],
    targetBp: number
  ) => Pick<
    ParsedPlasmid['primers'][0],
    'start' | 'end' | 'direction' | 'bases' | 'tm' | 'gc'
  > | null;

  onPrimerPbsEndpointCommit?: (primer: ParsedPlasmid['primers'][0], targetBp: number) => void;

  onCrossoverBoundaryCommit?: (handle: BackboneBoundaryHandleHitPayload, targetBp: number) => void;
  onBackbonePartSelect?: (part: BackbonePartHitPayload) => void;
  onBackbonePartReorderPreview?: (
    part: BackbonePartHitPayload,
    targetBp: number
  ) => BackbonePartReorderPreview | null;
  onBackbonePartReorderCommit?: (part: BackbonePartHitPayload, targetBp: number) => void;

  onMapKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
  onSelectionChange?: (start: number, end: number, wraps: boolean) => void;
  onSelectionPreview?: (start: number, end: number, wraps: boolean) => void;
  onSelectionStart?: (mode: 'new' | 'start' | 'end') => void;
  onUiFrustration?: (event: { component: string; action: 'click' }) => void;
  onPositionClick?: (position: number) => void;
  onPositionDoubleClick?: (position: number) => void;
  onCameraChange?: (
    centerBp: number,
    reason: 'scroll' | 'zoom',
    zoom: number,
    viewportRange: Readonly<{ start: number; end: number }>,
    intent?: Readonly<{ zoomAnchorBp: number | null }>
  ) => void;

  onRendererReady?: () => void;
  syncViewportRangeOnCameraScroll?: boolean;
  viewportIndicatorVisible?: boolean;
  selectedAnnotation?: WebGLAnnotationSelectionIdentity | null;
  onSelectedAnnotationChange?: (annotation: WebGLAnnotationSelectionIdentity | null) => void;
  onContextMenu?: (
    event: MouseEvent,
    context: {
      position: number | null;
      featureIndex: number | null;
      orf: GenomeOrf | null;
      primer: ParsedPlasmid['primers'][0] | null;
      hitResult?: WebGLHitTarget | null;
      highlightRange?: [number, number] | null;
      cutSite?: CutSiteHitPayload | null;
    }
  ) => void;

  cutSites?: CutSite[];

  sequenceWindow?: { startBp: number; bases: string };

  showFeatures?: boolean;
  showPrimers?: boolean;

  showResidueNumbers?: boolean;
  performancePreference?: WebGLPerformancePreference;

  performanceMode?: WebGLPerformanceMode;
  className?: string;
  style?: React.CSSProperties;
}

export const WebGLMap = memo(
  forwardRef<WebGLMapHandle, WebGLMapProps>(function WebGLMap(props, ref) {
    const {
      plasmid,
      changedAnnotationNames,
      annotationColorsByIdentity,
      missingAnnotationColor,
      height = 200,
      geometryHeight,
      centerStadiumOverview,
      reserveCanvasSpace,
      surfaceVisible,
      width = 800,
      circular = true,
      morphToCircle = 0,
      selectionStart,
      selectionEnd,
      cursorPosition,
      cursorBlinking = false,
      orfs,
      onOrfsPresented,
      candidateOrf,
      backboneSegments,
      selectedBackbonePartRegionId,
      crossoverHandleRange,
      digestFocusRange,
      className,
      style,
      onFeatureSelect,
      onFeatureHover,
      externalHoveredFeatureId,
      externalResidueLinkRange,
      externalHoveredCodon,
      externalSelectedCodons,
      onCodonHover,
      onSelectionChange,
      onSelectionPreview,
      onSelectionStart,
      onUiFrustration,
      onPositionClick,
      onPositionDoubleClick,
      onCameraChange,
      onRendererReady,
      syncViewportRangeOnCameraScroll,
      viewportIndicatorVisible,
      selectedAnnotation,
      onSelectedAnnotationChange,
      onContextMenu,
      cutSites,
      sequenceWindow,
      onPrimerClick,
      onPrimerPbsEndpointPreview,
      onPrimerPbsEndpointCommit,
      onCrossoverBoundaryCommit,
      onBackbonePartSelect,
      onBackbonePartReorderPreview,
      onBackbonePartReorderCommit,
      onMapKeyDown,
      showFeatures = true,
      showPrimers = true,
      showResidueNumbers = false,
      performancePreference = 'auto',
      performanceMode: explicitPerformanceMode,
    } = props;

    const editablePrimerPbsEndpoints = !!onPrimerPbsEndpointCommit;
    const genome = useMemo(() => {
      const converted = convertPlasmid(plasmid, {
        showFeatures,
        showPrimers,
        orfs,
        candidateOrf,
        editablePrimerPbsEndpoints,
      });
      if (!annotationColorsByIdentity) return converted;
      const colors = resolveAnnotationDataColors(
        genomeFeatures(converted),
        annotationColorsByIdentity,
        missingAnnotationColor
      );
      return {
        ...converted,
        features: genomeFeatures(converted).map((feature) =>
          colors.has(feature.id) ? { ...feature, color: colors.get(feature.id)! } : feature
        ),
      };
    }, [
      plasmid,
      showFeatures,
      showPrimers,
      orfs,
      candidateOrf,
      editablePrimerPbsEndpoints,
      annotationColorsByIdentity,
      missingAnnotationColor,
    ]);
    const performanceMode = useMemo(
      () => resolveWebGLPerformanceMode(genome, explicitPerformanceMode ?? performancePreference),
      [explicitPerformanceMode, genome, performancePreference]
    );
    const webglBackboneSegments = useMemo<GenomeBackboneSegment[] | undefined>(() => {
      return backboneSegments?.map((segment) => ({
        start: segment.start,
        end: segment.end,
        color: cssColorToHex(segment.color),
        label: segment.label,
        strokeWidth: segment.strokeWidth,
        alpha: segment.alpha,
        themeStableColor: segment.themeStableColor,
        labelPosition: segment.labelPosition,
        regionId: segment.regionId,
        scaffold: segment.scaffold,
        selected: !!segment.regionId && segment.regionId === selectedBackbonePartRegionId,
      }));
    }, [backboneSegments, selectedBackbonePartRegionId]);

    const backboneBoundaryHandles = useMemo<BackboneBoundaryHandle[] | undefined>(() => {
      if (!crossoverHandleRange) return undefined;
      const segmentColor =
        webglBackboneSegments?.find(
          (segment) =>
            segment.start === crossoverHandleRange.start && segment.end === crossoverHandleRange.end
        )?.color ?? 0x2563eb;
      return crossoverHandleRange.editableSides.map((side) => ({
        regionId: crossoverHandleRange.regionId,
        side,
        rangeStart: crossoverHandleRange.start,
        rangeEnd: crossoverHandleRange.end,
        boundaryBp: side === 'upstream' ? crossoverHandleRange.start : crossoverHandleRange.end,
        color: segmentColor,
      }));
    }, [crossoverHandleRange, webglBackboneSegments]);

    const features = useMemo(() => genomeFeatures(genome), [genome]);
    const annotationChangeDecorations = useMemo(() => {
      if (!changedAnnotationNames?.size) return undefined;
      const decorations = new Map<number, AnnotationChangeDecoration>();
      for (const feature of features) {
        if (changedAnnotationNames.has(feature.displayName))
          decorations.set(feature.id, { kind: 'modified' });
      }
      return decorations.size ? decorations : undefined;
    }, [changedAnnotationNames, features]);
    const featureById = useMemo(() => new Map(features.map((f) => [f.id, f])), [features]);
    const selectedFeatureIds = useMemo(() => {
      const ids = new Set<number>();
      if (!selectedAnnotation) return ids;
      for (const feature of features) {
        if (featureMatchesAnnotation(feature, selectedAnnotation)) ids.add(feature.id);
      }
      return ids;
    }, [
      features,
      selectedAnnotation?.type,
      selectedAnnotation?.name,
      selectedAnnotation?.start,
      selectedAnnotation?.end,
      selectedAnnotation?.direction,
    ]);
    const primerByRenderId = useMemo(
      () => new Map(plasmid.primers.map((p, i) => [primerRenderId(i), p])),
      [plasmid.primers]
    );

    const highlightRange = useMemo<[number, number] | null>(() => {
      if (selectionStart != null && selectionEnd != null) {
        return [selectionStart, selectionEnd];
      }
      return null;
    }, [selectionStart, selectionEnd]);

    const webglDigestFocusRange = useMemo<[number, number] | null>(() => {
      if (!digestFocusRange) return null;
      return [digestFocusRange.start, digestFocusRange.end];
    }, [digestFocusRange?.start, digestFocusRange?.end]);

    const renderCountRef = useRef(0);
    renderCountRef.current += 1;
    if (typeof window !== 'undefined') {
      (window as Window & { __webglMapRenderCount?: number }).__webglMapRenderCount =
        renderCountRef.current;
    }
    plog('WebGLMap-render', { n: renderCountRef.current });

    const [hover, setHover] = useState<HoverFeatureInfo | null>(null);
    const latestHoverRef = useRef<HoverFeatureInfo | null>(null);
    const tooltipRef = useRef<HTMLDivElement>(null);
    const hoverRegionLine = useCallback(
      (h: HoverFeatureInfo | null) => {
        const feature = h ? featureById.get(h.id) : null;
        if (!feature) return null;
        return cdsRegionHoverLine(
          {
            type: feature.type,
            start: feature.start + 1,
            end: feature.end,
            direction:
              feature.direction === 'reverse' ? -1 : feature.direction === 'forward' ? 1 : 0,
            segments: feature.segments,
          },
          h?.position ?? null,
          genome.length
        );
      },
      [featureById, genome.length]
    );
    const handleHoverChange = useCallback(
      (h: HoverFeatureInfo | null) => {
        const previous = latestHoverRef.current;
        const prevId = previous?.id ?? null;
        const nextId = h?.id ?? null;
        latestHoverRef.current = h;
        if (h && tooltipRef.current) {
          positionFeatureTooltip(tooltipRef.current, h.screenX, h.screenY, width, height);
        }
        if (prevId === nextId && hoverRegionLine(previous) === hoverRegionLine(h)) return;
        pmark('WebGLMap.setHover', { from: prevId, to: nextId });
        setHover(h);

        if (prevId !== nextId) onFeatureHover?.(nextId);
      },
      [onFeatureHover, hoverRegionLine, width, height]
    );

    const commitFeatureRange = useCallback(
      (featureId: number | null) => {
        pmark('WebGLMap.commitFeatureRange', {
          id: featureId,
          hasParentHandler: !!onFeatureSelect,
        });
        const t0 = performance.now();
        const selectedFeature = featureId == null ? null : featureById.get(featureId);
        if (selectedFeature) {
          onSelectedAnnotationChange?.(annotationIdentityFromFeature(selectedFeature));
        }
        commitWebGLFeatureRange({
          featureId,
          featureById,
          primerByRenderId,
          genomeLength: genome.length,
          onFeatureSelect,
          onPrimerClick,
        });
        const dt = performance.now() - t0;
        if (dt > 1) plog('parent-onFeatureSelect', { tookMs: +dt.toFixed(1) });
      },
      [
        featureById,
        genome.length,
        onFeatureSelect,
        onPrimerClick,
        onSelectedAnnotationChange,
        primerByRenderId,
      ]
    );

    const handleFeatureClick = useCallback(
      (featureId: number | null) => {
        if (featureId == null) {
          pmark('WebGLMap.handleFeatureClick', {
            id: null,
            hasParentHandler: !!onFeatureSelect,
          });
          onSelectedAnnotationChange?.(null);
          onFeatureSelect?.(null);
          return;
        }
        pmark('WebGLMap.handleFeatureClick', {
          id: featureId,
          hasParentHandler: !!onFeatureSelect,
        });
        const selectedFeature = featureById.get(featureId);
        onSelectedAnnotationChange?.(
          selectedFeature ? annotationIdentityFromFeature(selectedFeature) : null
        );
        focusWebGLFeature({
          featureId,
          featureById,
          primerByRenderId,
          genomeLength: genome.length,
          onFeatureSelect,
          onPrimerClick,
        });
      },
      [
        featureById,
        genome.length,
        onFeatureSelect,
        onPrimerClick,
        onSelectedAnnotationChange,
        primerByRenderId,
      ]
    );

    const handlePrimerPbsEndpointCommit = useCallback(
      (handle: PrimerHandleHitPayload, targetBp: number) => {
        const primer = primerByRenderId.get(handle.id);
        if (!primer) return;
        onPrimerPbsEndpointCommit?.(primer, targetBp);
      },
      [onPrimerPbsEndpointCommit, primerByRenderId]
    );

    const handlePrimerPbsEndpointPreview = useCallback(
      (handle: PrimerHandleHitPayload, targetBp: number) => {
        const primer = primerByRenderId.get(handle.id);
        if (!primer) return null;
        if (!onPrimerPbsEndpointPreview) {
          return {
            boundaryBp: targetBp,
            bases: primer.bases,
            tm: primer.tm,
            gc: primer.gc,
          };
        }
        const projectedPrimer = onPrimerPbsEndpointPreview(primer, targetBp);
        if (!projectedPrimer) return null;
        return {
          boundaryBp:
            projectedPrimer.direction === 'forward' ? projectedPrimer.end : projectedPrimer.start,
          bases: projectedPrimer.bases,
          tm: projectedPrimer.tm,
          gc: projectedPrimer.gc,
        };
      },
      [onPrimerPbsEndpointPreview, primerByRenderId]
    );

    const handleSelectionChange = useCallback(
      (startBp: number, endBp: number) => {
        pmark('WebGLMap.handleSelectionChange', {
          start: startBp,
          end: endBp,
          hasParentHandler: !!onSelectionChange,
        });
        if (onSelectionChange) {
          const wraps = selectionWrapsOrigin(startBp, endBp);
          recordWebGLSelectionDebug('WebGLMap.onSelectionChange', {
            start: startBp,
            end: endBp,
            wraps,
            circular,
            propHighlightRange: highlightRange,
          });
          const t0 = performance.now();
          onSelectionChange(startBp, endBp, wraps);
          const dt = performance.now() - t0;
          if (dt > 1) plog('parent-onSelectionChange', { tookMs: +dt.toFixed(1) });
        }
      },
      [circular, highlightRange, onSelectionChange]
    );

    const handleSelectionPreview = useCallback(
      (startBp: number, endBp: number) => {
        if (!onSelectionPreview) return;
        onSelectionPreview(startBp, endBp, selectionWrapsOrigin(startBp, endBp));
      },
      [circular, onSelectionPreview]
    );

    const handleOrfRangeCommit = useCallback(
      (orf: GenomeOrf) => {
        handleSelectionChange(orf.start, orf.end);
      },
      [handleSelectionChange]
    );

    const handleContextMenu = useCallback(
      (
        event: MouseEvent,
        context: {
          position: number | null;
          featureId: number | null;
          orf: GenomeOrf | null;
          hitResult: WebGLHitTarget | null;
          highlightRange: [number, number] | null;
        }
      ) => {
        if (!onContextMenu) return;
        const primer =
          context.featureId != null ? (primerByRenderId.get(context.featureId) ?? null) : null;
        const featureIndex = context.featureId != null && !primer ? context.featureId : null;
        const cutSite = context.hitResult?.kind === 'cut-site' ? context.hitResult.payload : null;
        onContextMenu(event, {
          position: context.position,
          featureIndex,
          orf: context.orf,
          primer,
          hitResult: context.hitResult,
          highlightRange: context.highlightRange,
          cutSite,
        });
      },
      [onContextMenu, primerByRenderId]
    );

    const hiddenMapIdlePolicy = useHiddenMapIdlePolicy('bounded-lru');
    const [rendererReadyEpoch, setRendererReadyEpoch] = useState(0);
    const handleRendererReady = useCallback(() => {
      setRendererReadyEpoch((epoch) => epoch + 1);
      onRendererReady?.();
    }, [onRendererReady]);

    const { containerRef, handle } = usePixiMap({
      genome,
      annotationChangeDecorations,
      hiddenMapIdlePolicy,
      sequenceWindow,
      performanceMode,
      performancePreference,
      circular,
      width,
      height,
      geometryHeight,
      centerStadiumOverview,
      reserveCanvasSpace,
      surfaceVisible,
      morph: morphToCircle,
      highlightRange,
      digestFocusRange: webglDigestFocusRange,
      cursorPosition: cursorPosition ?? null,
      cursorBlinking,
      showResidueNumbers,
      selectedFeatureIds,
      backboneSegments: webglBackboneSegments,
      backboneBoundaryHandles,
      externalHoveredFeatureId,
      residueLinkRange: externalResidueLinkRange,
      hoveredCodon: externalHoveredCodon,
      selectedCodons: externalSelectedCodons,
      cutSites,
      onHoverChange: handleHoverChange,
      onCodonHover,
      onFeatureClick: handleFeatureClick,
      onFeatureRangeCommit: commitFeatureRange,
      onOrfRangeCommit: handleOrfRangeCommit,
      onSelectionChange: handleSelectionChange,
      onSelectionPreview: handleSelectionPreview,
      onSelectionStart,
      onPrimerHandleDragPreview: handlePrimerPbsEndpointPreview,
      onPrimerHandleDragCommit: handlePrimerPbsEndpointCommit,
      onBackboneBoundaryHandleDragCommit: onCrossoverBoundaryCommit,
      onBackbonePartSelect,
      onBackbonePartDragPreview: onBackbonePartReorderPreview,
      onBackbonePartDragCommit: onBackbonePartReorderCommit,
      onUiFrustration,
      onPositionClick,
      onPositionDoubleClick,
      onCameraChange,
      onRendererReady: handleRendererReady,
      syncViewportRangeOnCameraScroll,
      viewportIndicatorVisible,
      onContextMenu: handleContextMenu,
    });

    useEffect(() => {
      const renderer = handle.getLinearRenderer();
      if (!renderer) return;
      renderer.setTrackHitHandler((hit) => {
        if (hit.kind === 'select-bp-range') {
          const state = handle.getState();
          if (state) state.highlightRange = [hit.startBp, hit.endBp - 1];
          handleSelectionChange(hit.startBp, hit.endBp - 1);
          handle.requestRender();
        } else if (hit.kind === 'jump-to-bp') handle.setViewCenter(hit.bp);
        else if (hit.kind === 'frame-bp-range') handle.setCameraViewport(hit.startBp, hit.endBp);
      });
      return () => renderer.setTrackHitHandler(null);
    }, [handle, rendererReadyEpoch, handleSelectionChange]);

    const { subscribeToPresentedFrames, requestRender } = handle;
    useEffect(() => {
      if (!onOrfsPresented) return;
      const unsubscribe = subscribeToPresentedFrames((receipt) => {
        const content = receipt.content;
        if (!content || content.genome !== genome) return;
        reportOrfPaint(onOrfsPresented, !orfs?.length, content.orfsDrawn, 'plasmid_map');
      });
      requestRender();
      return unsubscribe;
    }, [subscribeToPresentedFrames, requestRender, genome, onOrfsPresented, orfs]);

    const hoveredFeature = useMemo(() => {
      if (!hover) return null;
      const feature = featureById.get(hover.id);
      if (feature) return feature;
      const primer = primerByRenderId.get(hover.id);
      if (!primer) return null;
      return {
        id: hover.id,
        type: 'primer',
        start: primer.start,
        end: primer.end,
        direction: primer.direction,
        displayName: primer.name,
        modificationMarkers: primer.modificationMarkers,
        color: 0xd97706,
        lane: 0,
      };
    }, [hover, featureById, primerByRenderId]);

    useEffect(() => {
      if (typeof window === 'undefined') return;
      const w = window as Window & {
        __webglExposeForTests?: boolean;
        __webglCommitFeatureRangeForTest?: (featureId: number | null) => void;
        __webglFireHoverFeatureForTest?: (
          featureId: number | null,
          screenX?: number,
          screenY?: number
        ) => void;
      };
      if (!w.__webglExposeForTests) return;
      w.__webglCommitFeatureRangeForTest = (featureId) => {
        commitFeatureRange(featureId);
      };
      w.__webglFireHoverFeatureForTest = (featureId, screenX = 0, screenY = 0) => {
        if (featureId == null) {
          handleHoverChange(null);
          return;
        }
        const feature = featureById.get(featureId);
        if (!feature) return;
        handleHoverChange({
          id: feature.id,
          start: feature.start,
          end: feature.end,
          screenX,
          screenY,
        });
      };
      return () => {
        delete w.__webglCommitFeatureRangeForTest;
        delete w.__webglFireHoverFeatureForTest;
      };
    }, [commitFeatureRange, handleHoverChange, featureById]);

    useImperativeHandle(
      ref,
      () => ({
        setViewport: (range) => {
          handle.setViewport(range.start, range.end);
        },
        getViewCenter: () => handle.getViewCenter(),
        getViewportRange: () => handle.getViewportRange(),
        setViewCenter: (centerBp: number) => {
          handle.setViewCenter(centerBp);
        },
        setZoom: (zoom: number) => {
          handle.setZoom(zoom);
        },
        getCameraZoom: () => handle.getState()?.zoom ?? null,
        getCameraZoomBounds: () => handle.getZoomBounds(),
        subscribeToCameraZoomBounds: (listener: (bounds: { min: number; max: number }) => void) => {
          let previousGeometry: readonly unknown[] | null = null;
          let previousBounds: { min: number; max: number } | null = null;
          return handle.subscribeToPresentedFrames((receipt) => {
            const state = handle.getState();
            if (!state) return;
            const geometry = [
              receipt.content?.genome,
              receipt.content?.orfsDrawn,
              state.width,
              state.height,
              state.geometryHeight,
              state.morph,
              state.performanceMode,
            ];
            const previous = previousGeometry;
            if (previous && geometry.every((value, index) => value === previous[index])) return;
            previousGeometry = geometry;
            const bounds = handle.getZoomBounds();
            if (
              !bounds ||
              (previousBounds?.min === bounds.min && previousBounds.max === bounds.max)
            )
              return;
            previousBounds = bounds;
            listener(bounds);
          });
        },
        getCameraCenter: () => handle.getCameraCenter(),
        setResidueLinkRange: (range) => {
          handle.setResidueLinkRange(range);
        },
        setSelection: (startPos: number | null, endPos: number | null, _wraps?: boolean) => {
          const s = handle.getState();
          if (s) {
            s.highlightRange = startPos != null && endPos != null ? [startPos, endPos] : null;
            if (s.highlightRange) s.cursorPosition = null;
          }
        },
        setDisplaySize: (size) => {
          handle.setDisplaySize(size);
        },
        setHoveredCodon: (codon) => {
          handle.setHoveredCodon(codon);
        },
        setSelectedCodons: (codons) => {
          handle.setSelectedCodons(codons);
        },
        getLinearRenderer: () => handle.getLinearRenderer(),
        requestRender: () => handle.requestRender(),
      }),
      [handle]
    );

    return (
      <div
        tabIndex={onMapKeyDown ? 0 : undefined}
        onKeyDown={onMapKeyDown}
        onPointerDownCapture={(event) => {
          if (onMapKeyDown) event.currentTarget.focus({ preventScroll: true });
        }}
        className={className}
        style={{
          width,
          height,
          overflow: 'hidden',
          position: 'relative',
          ...style,
        }}
        data-webgl-performance-mode={performanceMode}
        data-webgl-performance-preference={performancePreference}
        data-webgl-keyboard-editable={onMapKeyDown ? 'true' : undefined}
      >
        <div
          ref={containerRef}
          data-testid="webgl-render-host"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
        />
        {hover && hoveredFeature && (
          <FeatureTooltip
            tooltipRef={tooltipRef}
            regionLine={hoverRegionLine(hover)}
            displayName={hoveredFeature.displayName}
            type={hoveredFeature.type}
            start={hoveredFeature.start}
            end={hoveredFeature.end}
            direction={hoveredFeature.direction}
            modificationMarkers={
              'modificationMarkers' in hoveredFeature
                ? hoveredFeature.modificationMarkers
                : undefined
            }
            screenX={latestHoverRef.current?.screenX ?? hover.screenX}
            screenY={latestHoverRef.current?.screenY ?? hover.screenY}
            containerWidth={width}
            containerHeight={height}
          />
        )}
      </div>
    );
  })
);

const TOOLTIP_STYLE: React.CSSProperties = {
  position: 'absolute',
  backgroundColor: 'hsl(var(--color-bg-subtle))',
  color: 'hsl(var(--color-fg))',
  border: '1px solid hsl(var(--color-border))',
  padding: '6px 10px',
  borderRadius: '4px',
  fontSize: '11px',
  pointerEvents: 'none',
  zIndex: 100,
  boxShadow: '0 2px 8px rgba(0, 0, 0, 0.12)',
  maxWidth: 180,
};

const TOOLTIP_SUBTEXT: React.CSSProperties = {
  color: 'hsl(var(--color-fg-subtle))',
  fontSize: '10px',
};

interface FeatureTooltipProps {
  tooltipRef: React.RefObject<HTMLDivElement>;
  regionLine: string | null;
  displayName: string;
  type: string;
  start: number;
  end: number;
  direction: 'forward' | 'reverse' | 'none';
  modificationMarkers?: ParsedPlasmid['primers'][0]['modificationMarkers'];
  screenX: number;
  screenY: number;
  containerWidth: number;
  containerHeight: number;
}

function positionFeatureTooltip(
  tooltip: HTMLDivElement,
  screenX: number,
  screenY: number,
  containerWidth: number,
  containerHeight: number
): void {
  const { width, height } = tooltip.getBoundingClientRect();
  tooltip.style.left = `${
    screenX + 12 + width > containerWidth - 4 ? Math.max(4, screenX - 12 - width) : screenX + 12
  }px`;
  tooltip.style.top = `${
    screenY + 12 + height > containerHeight - 4 ? Math.max(4, screenY - 12 - height) : screenY + 12
  }px`;
}

function FeatureTooltip(props: FeatureTooltipProps) {
  useLayoutEffect(() => {
    const tooltip = props.tooltipRef.current;
    if (tooltip) {
      positionFeatureTooltip(
        tooltip,
        props.screenX,
        props.screenY,
        props.containerWidth,
        props.containerHeight
      );
    }
  }, [props]);
  return (
    <div
      ref={props.tooltipRef}
      data-testid="webgl-feature-tooltip"
      style={{ ...TOOLTIP_STYLE, left: props.screenX + 12, top: props.screenY + 12 }}
    >
      <div
        style={{
          fontWeight: 600,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {props.displayName}
      </div>
      <div style={TOOLTIP_SUBTEXT}>
        {props.type} • {props.start}..{props.end} bp
      </div>
      {props.regionLine && <div style={TOOLTIP_SUBTEXT}>{props.regionLine}</div>}
      {props.direction !== 'none' && (
        <div style={TOOLTIP_SUBTEXT}>
          {props.direction === 'forward' ? '→ Forward' : '← Reverse'}
        </div>
      )}
      {props.modificationMarkers?.map((marker, index) => (
        <div key={index} style={{ ...TOOLTIP_SUBTEXT, overflowWrap: 'anywhere' }}>
          {marker.label} {marker.token}
        </div>
      ))}
    </div>
  );
}
