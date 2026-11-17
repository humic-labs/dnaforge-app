import { comparisonColumnX, comparisonPlot, type ComparisonHit } from '@waypoint/genome-renderer';
import {
  comparisonCameraForTargetViewport,
  comparisonTargetViewport,
} from '../comparison-projection-navigation';
import type { ComparisonProjectionProps } from './comparison-projection-props';
import type { ContactProjectionProps } from './contact-projection-props';
import { contactCellRect, contactPlotRect, type ContactHit } from '@waypoint/genome-renderer';
import { usePresentationListener } from '../../../presentation/PresentationSurface';
import {
  toUserMessage,
  userMessage,
  renderUserMessage,
  type UserMessage,
} from '@waypoint/user-messages';
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import {
  useIndexedPixiMap,
  type HoverFeatureInfo,
  type PixiMapHandle,
  type UseIndexedPixiMapOptions,
} from '@waypoint/genome-renderer/react';
import {
  type AnnotationFlatPresentationSnapshot,
  type AnnotationResidentPagePublication,
  genomeFeatures,
  resolveAnnotationDataColors,
  IndexedPixiLinearRenderer,
  readHitIdentityKey,
  type Feature,
  type FeatureHitPayload,
  type Genome,
  type CodonMutationInfo,
  type ReadHitPayload,
  PILEUP_READ_QUALITY_STOPS,
  pileupReadQualityCss,
  pileupReadQualityGradientCss,
} from '@waypoint/genome-renderer';

import { cdsRegionHoverLine } from '@waypoint/workspace-editor/codon-hover-tooltip-lines';

import { CheckIcon, CopyIcon, XIcon } from '../../../components/icons/glyphs';
import { readAlignmentDetails, type AlignmentReadDetails } from '../alignment-read-client';
import { alignedReadSourceGenerationKey } from '../aligned-read-source-generation';
import type { PileupSource } from '../pileup-source';
import {
  EMPTY_INDEXED_SEQUENCE_OVERLAYS,
  type IndexedSequenceOverlays,
} from './indexed-sequence-overlays';
import {
  annotationIdentityFromFeature,
  annotationIdentityFromFeatureHit,
  featureMatchesAnnotation,
  type IndexedGenomeSelectedAnnotation,
} from './indexed-genome-selection';

export type { IndexedGenomeSelectedAnnotation } from './indexed-genome-selection';

export type IndexedGenomeContextMenuHandler = NonNullable<
  UseIndexedPixiMapOptions['onContextMenu']
>;
export type IndexedGenomeSelectionChangeHandler = NonNullable<
  UseIndexedPixiMapOptions['onSelectionChange']
>;

export interface IndexedGenomeTileNativeMapHandle {
  getComparisonCamera: PixiMapHandle['getComparisonCamera'];
  setComparisonCamera: PixiMapHandle['setComparisonCamera'];
  getComparisonSelection: () => ComparisonHit | null;
  getContactCamera: PixiMapHandle['getContactCamera'];
  setContactCamera: PixiMapHandle['setContactCamera'];
  getContactSelection: () => ContactHit | null;

  setViewport: (range: { start: number; end: number }) => { start: number; end: number } | null;

  requestRender: PixiMapHandle['requestRender'];

  subscribeToPresentedFrames: PixiMapHandle['subscribeToPresentedFrames'];
  subscribeToCurrentGenomeFrames: PixiMapHandle['subscribeToPresentedFrames'];

  schedulePostPresentWork: PixiMapHandle['schedulePostPresentWork'];
  getViewCenter: () => number | null;
  getViewportRange: () => { start: number; end: number } | null;
  setViewCenter: (centerBp: number) => void;
  setSelection: (startPos: number | null, endPos: number | null) => void;

  getSelection: () => readonly [number, number] | null;

  setProteinSearchHighlightRanges: (
    ranges: ReadonlyArray<readonly [number, number]> | null
  ) => void;
  setDisplaySize: PixiMapHandle['setDisplaySize'];

  getLinearRenderer: () => IndexedPixiLinearRenderer | null;

  setTrackStackEndReserve: (heightPx: number) => boolean;

  scrollTracksBy: (deltaY: number) => boolean;

  setTrackPresentationOrder: (orderedTrackIds: ReadonlyArray<string>) => boolean;
  setTrackPresentationDrag: (
    preview: import('@waypoint/genome-renderer').TrackPresentationDrag | null
  ) => boolean;
}

export interface IndexedGenomeTileNativeMapProps
  extends ContactProjectionProps, ComparisonProjectionProps {
  annotationColorsByIdentity?: ReadonlyMap<string, string>;
  missingAnnotationColor?: string;
  genome: Genome;

  themeMode: NonNullable<UseIndexedPixiMapOptions['themeMode']>;

  compiledBroadSurfaceRequirement?: UseIndexedPixiMapOptions['compiledBroadSurfaceRequirement'];

  annotationPresentationSnapshot?: AnnotationFlatPresentationSnapshot;

  annotationResidentPagePublication?: AnnotationResidentPagePublication;

  annotationSearchFocus?: UseIndexedPixiMapOptions['annotationSearchFocus'];

  annotationSearchFocusFeature?: UseIndexedPixiMapOptions['annotationSearchFocusFeature'];
  sequenceWindow?: { startBp: number; bases: string };
  annotationChangeDecorations?: UseIndexedPixiMapOptions['annotationChangeDecorations'];
  sequencePresentation?: UseIndexedPixiMapOptions['sequencePresentation'];
  showResidueNumbers?: UseIndexedPixiMapOptions['showResidueNumbers'];
  hoveredCodon?: UseIndexedPixiMapOptions['hoveredCodon'];
  selectedCodons?: UseIndexedPixiMapOptions['selectedCodons'];
  onCodonHover?: UseIndexedPixiMapOptions['onCodonHover'];
  backboneSegments?: UseIndexedPixiMapOptions['backboneSegments'];
  annotationsVisible?: boolean;
  height: number;

  allowSparseCanvasCrop?: boolean;
  hasQuantitativeTracks?: boolean;
  hasPileupTracks?: boolean;

  canvasLayoutKey?: string;
  geometryHeight?: number;
  width: number;
  selectedAnnotation?: IndexedGenomeSelectedAnnotation | null;

  readSourcesByTrackId?: ReadonlyMap<string, PileupSource>;

  referencePathsByChrom?: ReadonlyMap<string, string>;
  onSelectedAnnotationChange?: (annotation: IndexedGenomeSelectedAnnotation | null) => void;
  onContextMenu?: IndexedGenomeContextMenuHandler;
  onSelectionChange?: IndexedGenomeSelectionChangeHandler;

  onSelectionClear?: () => void;

  sequenceOverlays?: IndexedSequenceOverlays;
  onCameraChange?: (
    centerBp: number,
    reason: 'scroll' | 'zoom',
    zoom: number,
    viewportRange: Readonly<{ start: number; end: number }>,
    intent?: Readonly<{ zoomAnchorBp: number | null }>
  ) => void;

  onRendererReady?: (epoch: number) => void;

  onRendererGenomeCommit?: (epoch: number) => void;

  interactionEnabled?: boolean;
  syncViewportRangeOnCameraScroll?: boolean;
  className?: string;
  style?: CSSProperties;
}

type PinnedReadState =
  | { readonly kind: 'loading'; readonly hit: ReadHitPayload }
  | {
      readonly kind: 'loaded';
      readonly hit: ReadHitPayload;
      readonly details: AlignmentReadDetails;
    }
  | { readonly kind: 'error'; readonly hit: ReadHitPayload; readonly message: UserMessage };

export const IndexedGenomeTileNativeMap = memo(
  forwardRef<IndexedGenomeTileNativeMapHandle, IndexedGenomeTileNativeMapProps>(
    function IndexedGenomeTileNativeMap(props, ref) {
      const presentationEvents = usePresentationListener();

      const {
        comparisonProjection,
        comparisonCamera,
        onComparisonCameraChange,
        contactProjection,
        contactCamera,
        contactUnit,
        onContactCameraChange,
        genome,
        themeMode,
        compiledBroadSurfaceRequirement,
        annotationPresentationSnapshot,
        annotationResidentPagePublication,
        annotationSearchFocus,
        annotationSearchFocusFeature,
        sequenceWindow,
        annotationChangeDecorations,
        sequencePresentation,
        annotationColorsByIdentity,
        missingAnnotationColor,
        showResidueNumbers,
        hoveredCodon,
        selectedCodons,
        onCodonHover,
        backboneSegments,
        annotationsVisible,
        height,
        allowSparseCanvasCrop = true,
        hasQuantitativeTracks = false,
        hasPileupTracks = false,
        canvasLayoutKey,
        geometryHeight,
        width,
        selectedAnnotation,
        readSourcesByTrackId,
        referencePathsByChrom,
        onSelectedAnnotationChange,
        onContextMenu,
        onSelectionChange,
        onSelectionClear,
        sequenceOverlays = EMPTY_INDEXED_SEQUENCE_OVERLAYS,
        onCameraChange,
        onRendererReady,
        onRendererGenomeCommit,
        interactionEnabled = true,
        syncViewportRangeOnCameraScroll,
        className,
        style,
      } = props;

      const features = useMemo(() => {
        const sourceIdentity = genome.sourceIdentity ?? genome.name;
        if (
          annotationPresentationSnapshot?.sourceIdentity === sourceIdentity &&
          annotationPresentationSnapshot.genomeLengthBp === genome.length
        ) {
          return annotationPresentationSnapshot.features;
        }
        return genomeFeatures(genome);
      }, [annotationPresentationSnapshot, genome]);
      const featureById = useMemo(() => new Map(features.map((f) => [f.id, f])), [features]);
      const dataSequencePresentation = useMemo(
        () =>
          annotationColorsByIdentity
            ? {
                ...sequencePresentation,
                annotationColors: resolveAnnotationDataColors(
                  annotationResidentPagePublication?.pages.flatMap((page) => page.features) ??
                    features,
                  annotationColorsByIdentity,
                  missingAnnotationColor
                ),
                annotationUnchangedColor: missingAnnotationColor
                  ? Number.parseInt(missingAnnotationColor.slice(1), 16)
                  : undefined,
              }
            : sequencePresentation,
        [
          sequencePresentation,
          features,
          annotationResidentPagePublication,
          annotationColorsByIdentity,
          missingAnnotationColor,
        ]
      );
      const [canvasDrawingHeight, setCanvasDrawingHeight] = useState(height);
      const canvasContentHeightRef = useRef<number | null>(null);
      const genomeIdentity = genome.sourceIdentity ?? genome.name;
      useLayoutEffect(() => {
        canvasContentHeightRef.current = null;
        setCanvasDrawingHeight(height);
      }, [allowSparseCanvasCrop, canvasLayoutKey, genomeIdentity, genome.length]);
      useLayoutEffect(() => {
        const contentHeight = canvasContentHeightRef.current;
        setCanvasDrawingHeight(
          allowSparseCanvasCrop ? Math.max(1, Math.min(height, contentHeight ?? height)) : height
        );
      }, [allowSparseCanvasCrop, height]);
      const [sidecarSelection, setSidecarSelection] = useState<{
        rendererId: number;
        canonicalIdentity: string;
      } | null>(null);
      const selectedFeatureIds = useMemo(() => {
        const ids = new Set<number>();
        if (!selectedAnnotation) return ids;
        for (const feature of features) {
          if (featureMatchesAnnotation(feature, selectedAnnotation)) ids.add(feature.id);
        }
        if (
          ids.size === 0 &&
          !annotationPresentationSnapshot &&
          sidecarSelection &&
          selectedAnnotation.canonicalIdentity === sidecarSelection.canonicalIdentity
        ) {
          ids.add(sidecarSelection.rendererId);
        }
        return ids;
      }, [
        features,
        selectedAnnotation?.type,
        selectedAnnotation?.name,
        selectedAnnotation?.start,
        selectedAnnotation?.end,
        selectedAnnotation?.direction,
        selectedAnnotation?.canonicalIdentity,
        annotationPresentationSnapshot,
        sidecarSelection,
      ]);
      const selectedFeatureCanonicalIdentities = useMemo(
        () =>
          new Set(
            selectedAnnotation?.canonicalIdentity ? [selectedAnnotation.canonicalIdentity] : []
          ),
        [selectedAnnotation?.canonicalIdentity]
      );
      const highlightRange = useMemo<[number, number] | null>(() => null, []);

      const [hover, setHover] = useState<HoverFeatureInfo | null>(null);
      const [comparisonHover, setComparisonHover] = useState<ComparisonHit | null>(null);
      const [comparisonSelection, setComparisonSelection] = useState<ComparisonHit | null>(null);
      useEffect(() => {
        setComparisonHover(null);
        setComparisonSelection(null);
      }, [comparisonProjection?.id]);
      const [contactHover, setContactHover] = useState<ContactHit | null>(null);
      const [contactSelection, setContactSelection] = useState<ContactHit | null>(null);
      useEffect(() => {
        setContactHover(null);
        setContactSelection(null);
      }, [contactProjection?.id]);
      const [hoveredMutation, setHoveredMutation] = useState<CodonMutationInfo | undefined>();
      const handleCodonHover = useCallback<NonNullable<UseIndexedPixiMapOptions['onCodonHover']>>(
        (codon) => {
          setHoveredMutation(codon?.mutation);
          onCodonHover?.(codon);
        },
        [onCodonHover]
      );
      const [readHover, setReadHover] = useState<ReadHitPayload | null>(null);
      const [pinnedRead, setPinnedRead] = useState<PinnedReadState | null>(null);
      const readRequestRef = useRef<AbortController | null>(null);
      const lastReadClickRef = useRef<{ identity: string; at: number } | null>(null);
      const interactionEnabledRef = useRef(interactionEnabled);
      interactionEnabledRef.current = interactionEnabled;
      const latestHoverRef = useRef<HoverFeatureInfo | null>(null);
      const hoverRegionLine = useCallback(
        (nextHover: HoverFeatureInfo | null) => {
          const feature = nextHover ? featureById.get(nextHover.id) : null;

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
            nextHover?.position ?? null,
            genome.length
          );
        },
        [featureById, genome.length]
      );
      const handleHoverChange = useCallback(
        (nextHover: HoverFeatureInfo | null) => {
          const previous = latestHoverRef.current;
          const tooltipChanged =
            !sameHoverTooltipContent(previous, nextHover) ||
            hoverRegionLine(previous) !== hoverRegionLine(nextHover);
          latestHoverRef.current = nextHover;
          if (tooltipChanged) setHover(nextHover);
        },
        [hoverRegionLine]
      );
      const dismissPinnedRead = useCallback(() => {
        readRequestRef.current?.abort();
        readRequestRef.current = null;
        setPinnedRead(null);
      }, []);
      const handleReadClick = useCallback(
        (hit: ReadHitPayload | null) => {
          if (!hit) {
            lastReadClickRef.current = null;
            dismissPinnedRead();
            return;
          }
          const identity = readHitIdentityKey(hit);
          lastReadClickRef.current = { identity, at: performance.now() };
          readRequestRef.current?.abort();
          const source = readSourcesByTrackId?.get(hit.trackId);
          if (!source) {
            readRequestRef.current = null;
            setPinnedRead({
              kind: 'error',
              hit,
              message: userMessage('readDetails.sourceUnavailable'),
            });
            return;
          }
          const chromReference = referencePathsByChrom?.get(hit.chrom);
          const resolvedSource =
            chromReference && chromReference !== source.referencePath
              ? { ...source, referencePath: chromReference }
              : source;
          const controller = new AbortController();
          readRequestRef.current = controller;
          setPinnedRead({ kind: 'loading', hit });
          void readAlignmentDetails({
            source: resolvedSource,
            hit,
            signal: controller.signal,
          }).then(
            (details) => {
              if (readRequestRef.current !== controller) return;
              readRequestRef.current = null;
              setPinnedRead((current) =>
                current && readHitIdentityKey(current.hit) === identity
                  ? { kind: 'loaded', hit: current.hit, details }
                  : current
              );
            },
            (error: unknown) => {
              if (readRequestRef.current !== controller || controller.signal.aborted) return;
              readRequestRef.current = null;
              const message = toUserMessage(error, 'readDetails.failed');
              setPinnedRead((current) =>
                current && readHitIdentityKey(current.hit) === identity
                  ? { kind: 'error', hit: current.hit, message }
                  : current
              );
            }
          );
        },
        [dismissPinnedRead, readSourcesByTrackId, referencePathsByChrom]
      );

      const commitFeature = useCallback(
        (featureId: number | null) => {
          if (!interactionEnabledRef.current) return;
          onSelectionClear?.();
          if (featureId == null) {
            onSelectedAnnotationChange?.(null);
            return;
          }
          const selectedFeature = featureById.get(featureId);
          if (selectedFeature) {
            setSidecarSelection(null);
            onSelectedAnnotationChange?.(annotationIdentityFromFeature(selectedFeature));
          }
        },
        [featureById, onSelectedAnnotationChange, onSelectionClear]
      );

      const commitFeatureHit = useCallback(
        (feature: FeatureHitPayload | null) => {
          if (!interactionEnabledRef.current) return;
          onSelectionClear?.();
          if (!feature) {
            setSidecarSelection(null);
            onSelectedAnnotationChange?.(null);
            return;
          }
          const selected = annotationIdentityFromFeatureHit(feature);
          if (!selected?.canonicalIdentity) return;
          setSidecarSelection({
            rendererId: feature.id,
            canonicalIdentity: selected.canonicalIdentity,
          });
          onSelectedAnnotationChange?.(selected);
        },
        [onSelectedAnnotationChange, onSelectionClear]
      );

      const commitFeatureRange = useCallback(
        (featureId: number | null) => {
          if (!interactionEnabledRef.current) return;
          if (featureId == null) {
            onSelectedAnnotationChange?.(null);
            return;
          }
          const selectedFeature = featureById.get(featureId);
          if (selectedFeature) {
            setSidecarSelection(null);
            onSelectedAnnotationChange?.(annotationIdentityFromFeature(selectedFeature));
          }
        },
        [featureById, onSelectedAnnotationChange]
      );

      const commitFeatureHitRange = useCallback(
        (feature: FeatureHitPayload | null) => {
          if (!interactionEnabledRef.current) return;
          if (!feature) {
            setSidecarSelection(null);
            onSelectedAnnotationChange?.(null);
            return;
          }
          const selected = annotationIdentityFromFeatureHit(feature);
          if (selected?.canonicalIdentity) {
            setSidecarSelection({
              rendererId: feature.id,
              canonicalIdentity: selected.canonicalIdentity,
            });
            onSelectedAnnotationChange?.(selected);
          }
          onSelectionChange?.(feature.start, Math.max(feature.start, feature.end - 1));
        },
        [onSelectedAnnotationChange, onSelectionChange]
      );

      const pixelRatio = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
      const { containerRef, handle } = useIndexedPixiMap({
        comparisonProjection,
        onComparisonHover: setComparisonHover,
        onComparisonClick: setComparisonSelection,
        onComparisonCameraChange: interactionEnabled ? onComparisonCameraChange : undefined,
        contactProjection,
        onContactHover: setContactHover,
        onContactClick: setContactSelection,
        onContactCameraChange: interactionEnabled ? onContactCameraChange : undefined,
        genome,
        antialias: hasQuantitativeTracks,
        resolution: hasQuantitativeTracks ? pixelRatio : Math.min(1.5, pixelRatio),
        minimumFrameIntervalMs: hasQuantitativeTracks || hasPileupTracks ? 0 : 13,
        capCanvasToProvidedHeight: true,

        hiddenMapIdlePolicy: 'short-timeout',
        themeMode,
        compiledBroadSurfaceRequirement,
        annotationPresentationSnapshot,
        annotationResidentPagePublication,
        annotationSearchFocus,
        annotationSearchFocusFeature,
        sequenceWindow,
        annotationChangeDecorations,
        sequencePresentation: dataSequencePresentation,
        showResidueNumbers,
        hoveredCodon,
        selectedCodons,
        onCodonHover: handleCodonHover,
        backboneSegments,
        annotationsVisible,
        width,
        height: canvasDrawingHeight,
        geometryHeight: Math.min(geometryHeight ?? canvasDrawingHeight, canvasDrawingHeight),
        morph: 0,
        highlightRange,
        cursorPosition: null,
        selectedFeatureIds,
        selectedFeatureCanonicalIdentities,
        onHoverChange: handleHoverChange,
        onReadHoverChange: setReadHover,
        onReadClick: handleReadClick,
        onFeatureClick: commitFeature,
        onFeatureHitClick: commitFeatureHit,
        onFeatureRangeCommit: commitFeatureRange,
        onFeatureRangeHitCommit: commitFeatureHitRange,
        cutSites: sequenceOverlays.cutSites,
        primers: sequenceOverlays.primers,
        onOrfClick: onSelectionClear,
        onPositionClick: onSelectionClear,
        onContextMenu: interactionEnabled ? onContextMenu : undefined,
        onSelectionChange: interactionEnabled ? onSelectionChange : undefined,
        onCameraChange: interactionEnabled ? onCameraChange : undefined,
        onRendererReady,
        onRendererGenomeCommit,
        syncViewportRangeOnCameraScroll,
      });

      useLayoutEffect(() => {
        if (
          !comparisonProjection ||
          !comparisonCamera ||
          comparisonCamera.projectionId !== comparisonProjection.id
        )
          return;
        const current = handle.getComparisonCamera();
        if (JSON.stringify(current) !== JSON.stringify(comparisonCamera))
          handle.setComparisonCamera(comparisonCamera);
      }, [comparisonCamera, comparisonProjection, handle]);

      useLayoutEffect(() => {
        if (
          !contactProjection ||
          !contactCamera ||
          contactCamera.projectionId !== contactProjection.id
        )
          return;
        const current = handle.getContactCamera();
        if (JSON.stringify(current) !== JSON.stringify(contactCamera))
          handle.setContactCamera(contactCamera);
      }, [contactCamera, contactProjection, handle]);

      useEffect(
        () =>
          handle.subscribeToPresentedFrames(() => {
            const contentHeight =
              handle.getLinearRenderer()?.getLaneScreenSnapshot?.().canvasContentHeightPx ?? null;
            canvasContentHeightRef.current = contentHeight;
            const nextHeight = allowSparseCanvasCrop
              ? Math.max(1, Math.min(height, contentHeight ?? height))
              : height;
            setCanvasDrawingHeight((current) => (current === nextHeight ? current : nextHeight));
          }),
        [allowSparseCanvasCrop, handle, height]
      );

      const handleReadOverlayPointerUp = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>) => {
          if (contactProjection || comparisonProjection || event.button > 0) return;
          if (
            event.target instanceof Element &&
            event.target.closest('[data-testid="indexed-read-details"]')
          ) {
            return;
          }
          const container = containerRef.current;
          const canvas = container?.querySelector('canvas');
          const renderer = handle.getLinearRenderer();
          const state = handle.getState();
          if (!canvas || !renderer || !state) return;
          const rect = canvas.getBoundingClientRect();
          if (
            rect.width <= 0 ||
            rect.height <= 0 ||
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom
          ) {
            return;
          }
          const localX = (event.clientX - rect.left) * (state.width / rect.width);
          const localY = (event.clientY - rect.top) * (state.height / rect.height);
          const hoveredHit = readHover;
          const hoveredRect = hoveredHit?.hitRect ?? hoveredHit?.bodyRect;
          const hit =
            hoveredHit &&
            hoveredRect &&
            localX >= hoveredRect.left &&
            localX <= hoveredRect.left + hoveredRect.width &&
            localY >= hoveredRect.top &&
            localY <= hoveredRect.top + hoveredRect.height
              ? hoveredHit
              : renderer.hitTestReadEvent(localX, localY);
          if (!hit) return;
          const lastReadClick = lastReadClickRef.current;
          if (
            lastReadClick &&
            lastReadClick.identity === readHitIdentityKey(hit) &&
            performance.now() - lastReadClick.at < 250
          ) {
            return;
          }

          handleReadClick(hit);
        },
        [comparisonProjection, contactProjection, containerRef, handle, handleReadClick, readHover]
      );

      const pinnedReadIdentity = pinnedRead ? readHitIdentityKey(pinnedRead.hit) : null;
      const hoveredReadIdentity = readHover ? readHitIdentityKey(readHover) : null;
      useEffect(() => {
        if (!readHover || !readSourcesByTrackId) return;
        const source = readSourcesByTrackId.get(readHover.trackId);
        if (
          !source ||
          alignedReadSourceGenerationKey(source.generation) !== readHover.sourceGenerationKey
        ) {
          setReadHover(null);
        }
      }, [hoveredReadIdentity, readHover, readSourcesByTrackId]);

      useEffect(() => {
        if (!hoveredReadIdentity) return;
        return handle.subscribeToPresentedFrames(() => {
          const renderer = handle.getLinearRenderer();
          if (!renderer) return;
          setReadHover((current) => {
            if (!current || readHitIdentityKey(current) !== hoveredReadIdentity) return current;
            const located = renderer.locateRead(current);
            if (!located || !pointInsideRead(current.screenX, current.screenY, located))
              return null;
            return sameReadScreenGeometry(current, located)
              ? current
              : { ...located, screenX: current.screenX, screenY: current.screenY };
          });
        });
      }, [handle, hoveredReadIdentity]);

      useEffect(() => {
        if (!pinnedRead) return;
        const source = readSourcesByTrackId?.get(pinnedRead.hit.trackId);
        if (
          !source ||
          alignedReadSourceGenerationKey(source.generation) !== pinnedRead.hit.sourceGenerationKey
        ) {
          dismissPinnedRead();
          return;
        }
        const renderer = handle.getLinearRenderer();
        if (!renderer) return;
        const located = renderer.locateRead(pinnedRead.hit);
        if (!located) dismissPinnedRead();
      }, [dismissPinnedRead, handle, pinnedReadIdentity, readSourcesByTrackId]);

      useEffect(() => {
        if (!pinnedReadIdentity) return;
        return handle.subscribeToPresentedFrames(() => {
          const renderer = handle.getLinearRenderer();
          if (!renderer) return;
          setPinnedRead((current) => {
            if (!current || readHitIdentityKey(current.hit) !== pinnedReadIdentity) return current;
            const located = renderer.locateRead(current.hit);
            if (!located) {
              readRequestRef.current?.abort();
              readRequestRef.current = null;
              return null;
            }
            return sameReadScreenGeometry(current.hit, located)
              ? current
              : {
                  ...current,
                  hit: reanchorReadScreenPoint(current.hit, located),
                };
          });
        });
      }, [handle, pinnedReadIdentity]);

      useEffect(() => {
        if (!pinnedReadIdentity) return;
        const onKeyDown = (event: KeyboardEvent) => {
          if (event.key === 'Escape') dismissPinnedRead();
        };
        presentationEvents.add(window, 'keydown', onKeyDown);
        return () => presentationEvents.remove(window, 'keydown', onKeyDown);
      }, [dismissPinnedRead, pinnedReadIdentity, presentationEvents]);

      useEffect(() => () => readRequestRef.current?.abort(), []);

      useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        const handleOverlayWheel = (event: WheelEvent) => {
          const cameraScrollIntent = event.deltaX !== 0 || event.deltaY !== 0;
          if (!cameraScrollIntent || event.ctrlKey || event.metaKey) return;
          const canvas = container.querySelector('canvas');
          if (!canvas || event.target === canvas) return;
          event.preventDefault();
          canvas.dispatchEvent(
            new WheelEvent('wheel', {
              bubbles: true,
              cancelable: true,
              composed: true,
              clientX: event.clientX,
              clientY: event.clientY,
              screenX: event.screenX,
              screenY: event.screenY,
              deltaX: event.deltaX,
              deltaY: event.deltaY,
              deltaZ: event.deltaZ,
              deltaMode: event.deltaMode,
              altKey: event.altKey,
              ctrlKey: event.ctrlKey,
              metaKey: event.metaKey,
              shiftKey: event.shiftKey,
            })
          );
        };
        container.addEventListener('wheel', handleOverlayWheel, { capture: true, passive: false });
        return () => container.removeEventListener('wheel', handleOverlayWheel, { capture: true });
      }, [containerRef]);

      const hoveredFeature = useMemo(() => {
        if (!hover) return null;
        const resident = featureById.get(hover.id);
        if (resident) return resident;
        if (!hover.displayName || !hover.type || !hover.direction) return null;
        return {
          id: hover.id,
          type: hover.type,
          start: hover.start,
          end: hover.end,
          direction: hover.direction,
          displayName: hover.displayName,
          color: 0,
          lane: hover.lane ?? 0,
          transcriptId: hover.transcriptId ?? undefined,
          sourceId: hover.sourceId ?? undefined,
        } satisfies Feature;
      }, [featureById, hover]);
      const hoverPreviewRead =
        readHover && (!pinnedReadIdentity || hoveredReadIdentity !== pinnedReadIdentity)
          ? readHover
          : null;
      const pinnedReadCardHitbox = pinnedRead
        ? readDetailsCardHitbox(pinnedRead.hit, width, height)
        : null;
      const currentGenomeRef = useRef(genome);
      currentGenomeRef.current = genome;
      useImperativeHandle(
        ref,
        () => ({
          getComparisonCamera: () => handle.getComparisonCamera(),
          setComparisonCamera: (camera) => handle.setComparisonCamera(camera),
          getComparisonSelection: () => handle.getState()?.selectedComparison ?? null,
          getContactCamera: () => handle.getContactCamera(),
          setContactCamera: (camera) => handle.setContactCamera(camera),
          getContactSelection: () => handle.getState()?.selectedContact ?? null,
          requestRender: () => handle.requestRender(),
          subscribeToPresentedFrames: (listener) => handle.subscribeToPresentedFrames(listener),
          subscribeToCurrentGenomeFrames: (listener) =>
            handle.subscribeToPresentedFrames((receipt) => {
              if (receipt.content?.genome === currentGenomeRef.current) listener(receipt);
            }),
          schedulePostPresentWork: (work) => handle.schedulePostPresentWork(work),
          setViewport: (range) => {
            if (!interactionEnabledRef.current) return null;
            if (contactProjection) {
              const current = handle.getContactCamera();
              if (
                current &&
                Math.floor(current.xStart) === Math.floor(range.start) &&
                Math.ceil(current.xEnd) === Math.ceil(range.end)
              )
                return { start: current.xStart, end: current.xEnd };
            }
            if (comparisonProjection) {
              const current = handle.getComparisonCamera();
              const currentRange =
                current && comparisonTargetViewport(comparisonProjection, current);
              if (
                currentRange &&
                Math.abs(currentRange.start - range.start) < 1 &&
                Math.abs(currentRange.end - range.end) < 1
              )
                return currentRange;
              const camera = comparisonCameraForTargetViewport(comparisonProjection, range);
              if (!camera) return null;
              const committed = handle.setComparisonCamera(camera);
              return committed ? comparisonTargetViewport(comparisonProjection, committed) : null;
            }
            return handle.setCameraViewport(range.start, range.end);
          },
          getViewCenter: () => {
            if (!comparisonProjection) return handle.getViewCenter();
            const camera = handle.getComparisonCamera();
            if (!camera) return null;
            const range = comparisonTargetViewport(comparisonProjection, camera);
            return range ? (range.start + range.end) / 2 : null;
          },
          getViewportRange: () => {
            if (!comparisonProjection) return handle.getViewportRange();
            const camera = handle.getComparisonCamera();
            return camera ? comparisonTargetViewport(comparisonProjection, camera) : null;
          },
          setViewCenter: (centerBp: number) => {
            if (!interactionEnabledRef.current) return;
            if (comparisonProjection) {
              const current = handle.getComparisonCamera();
              const range = current && comparisonTargetViewport(comparisonProjection, current);
              const span = range ? range.end - range.start : 1;
              const camera = comparisonCameraForTargetViewport(comparisonProjection, {
                start: centerBp - span / 2,
                end: centerBp + span / 2,
              });
              if (camera) handle.setComparisonCamera(camera);
              return;
            }
            handle.setViewCenter(centerBp);
          },
          setSelection: (startPos: number | null, endPos: number | null) => {
            const state = handle.getState();
            if (!state || state.contactProjection || state.comparisonProjection) return;
            state.highlightRange = startPos != null && endPos != null ? [startPos, endPos] : null;
            if (state.highlightRange) state.cursorPosition = null;
            handle.requestRender();
          },
          getSelection: () => {
            if (handle.getState()?.contactProjection || handle.getState()?.comparisonProjection)
              return null;
            const range = handle.getState()?.highlightRange;
            return range ? ([range[0], range[1]] as const) : null;
          },
          setProteinSearchHighlightRanges: (ranges) => {
            const state = handle.getState();
            if (!state) return;
            state.proteinSearchHighlightRanges =
              ranges?.map(([start, end]) => [start, end] as const) ?? null;
            handle.requestRender();
          },
          setDisplaySize: (size) => {
            handle.setDisplaySize(size);
          },
          getLinearRenderer: () => {
            const renderer = handle.getLinearRenderer();
            return renderer instanceof IndexedPixiLinearRenderer ? renderer : null;
          },
          setTrackStackEndReserve: (heightPx: number) => {
            const renderer = handle.getLinearRenderer();
            if (!renderer) return false;
            if (renderer.setTrackStackEndReservePx(heightPx)) handle.requestRender();
            return true;
          },
          scrollTracksBy: (deltaY: number) => {
            const renderer = handle.getLinearRenderer();
            const owned = renderer?.canScrollTracksVertically() ?? false;
            if (renderer?.scrollTracksBy(deltaY)) handle.requestRender();
            return owned;
          },
          setTrackPresentationOrder: (orderedTrackIds) => {
            const renderer = handle.getLinearRenderer();
            if (!renderer?.setTrackPresentationOrder(orderedTrackIds)) return false;
            handle.requestRender();
            return true;
          },
          setTrackPresentationDrag: (preview) => {
            const renderer = handle.getLinearRenderer();
            if (!renderer?.setTrackPresentationDrag(preview)) return false;
            handle.requestRender();
            return true;
          },
        }),
        [comparisonProjection, handle]
      );

      return (
        <div
          ref={containerRef}
          className={['[&>canvas]:max-h-full', '[&>canvas]:max-w-full', className]
            .filter(Boolean)
            .join(' ')}
          data-testid="indexed-genome-webgl-map"
          data-renderer-mode="tile-native-pixi"
          data-projection={
            comparisonProjection
              ? 'aligned-comparison'
              : contactProjection
                ? 'contact-matrix'
                : 'linear'
          }
          data-feature-count={features.length}
          onPointerUp={handleReadOverlayPointerUp}
          style={{
            width,
            height,
            overflow: 'hidden',
            position: 'relative',
            pointerEvents: interactionEnabled ? 'auto' : 'none',
            ...style,

            maxWidth: '100%',
            maxHeight: '100%',
          }}
        >
          {comparisonProjection && (comparisonHover ?? comparisonSelection) && (
            <ComparisonTooltip
              projection={comparisonProjection}
              hit={(comparisonHover ?? comparisonSelection)!}
              camera={handle.getComparisonCamera()}
              width={width}
              height={height}
            />
          )}
          {contactProjection && (contactHover ?? contactSelection) && (
            <ContactTooltip
              projection={contactProjection}
              hit={(contactHover ?? contactSelection)!}
              camera={handle.getContactCamera()}
              unit={contactUnit ?? 'contacts'}
              width={width}
              height={height}
            />
          )}
          {!contactProjection && !comparisonProjection && hover && hoveredFeature && (
            <FeatureTooltip
              mutationLine={
                hoveredMutation
                  ? `Original: ${hoveredMutation.referenceAa ?? (hoveredMutation.referenceCodons.map((codon) => codon.aa).join(', ') || 'none')} · New: ${hoveredMutation.queryAa ?? '?'}`
                  : null
              }
              regionLine={hoverRegionLine(hover)}
              displayName={hoveredFeature.displayName}
              type={hoveredFeature.type}
              start={hoveredFeature.start}
              end={hoveredFeature.end}
              direction={hoveredFeature.direction}
              sourceId={hoveredFeature.sourceId ?? hoveredFeature.qualifiers?.ID ?? null}
              transcriptId={hoveredFeature.transcriptId ?? null}
              internalId={hoveredFeature.id}
              lane={hoveredFeature.lane}
              screenX={hover.screenX}
              screenY={hover.screenY}
              containerWidth={width}
              containerHeight={height}
            />
          )}
          {hoverPreviewRead && <ReadHoverHighlight hit={hoverPreviewRead} themeMode={themeMode} />}
          {pinnedRead && <ReadSelectionHighlight hit={pinnedRead.hit} themeMode={themeMode} />}
          {hoverPreviewRead && (
            <ReadTooltip
              hit={hoverPreviewRead}
              containerWidth={width}
              containerHeight={height}
              avoidRect={pinnedReadCardHitbox}
            />
          )}
          {pinnedRead && (
            <ReadDetailsCard
              state={pinnedRead}
              themeMode={themeMode}
              containerWidth={width}
              containerHeight={height}
              onClose={dismissPinnedRead}
            />
          )}
        </div>
      );
    }
  )
);

function comparisonLocusLabel(locus: ComparisonHit['target']): string {
  if (locus.kind === 'base') return `${locus.referenceId}:${(locus.position + 1).toLocaleString()}`;
  if (locus.kind === 'gap')
    return `${locus.referenceId} · ${locus.boundary === 0 ? 'gap before base 1' : `gap after base ${locus.boundary.toLocaleString()}`}`;
  const interval = locus.interval
    ? ` · ${(locus.interval.start + 1).toLocaleString()}–${locus.interval.end.toLocaleString()}`
    : '';
  return `${locus.referenceId} · ${locus.reason}${interval}`;
}

function ComparisonTooltip({
  projection,
  hit,
  camera,
  width,
  height,
}: {
  projection: NonNullable<ComparisonProjectionProps['comparisonProjection']>;
  hit: ComparisonHit;
  camera: ReturnType<PixiMapHandle['getComparisonCamera']>;
  width: number;
  height: number;
}) {
  if (!camera || hit.projectionId !== projection.id) return null;
  const plot = comparisonPlot(width, height);
  const x = comparisonColumnX(hit.column, camera, plot);
  const y =
    hit.side === 'target'
      ? plot.targetY
      : hit.side === 'query'
        ? plot.queryY
        : (plot.targetY + plot.queryY) / 2;
  return (
    <div
      data-testid="indexed-comparison-tooltip"
      style={{
        ...TOOLTIP_STYLE,
        left: Math.max(4, Math.min(width - 310, x + 12)),
        top: Math.max(4, Math.min(height - 90, y + 12)),
      }}
    >
      <div>{comparisonLocusLabel(hit.target)}</div>
      <div>{comparisonLocusLabel(hit.query)}</div>
      {hit.blockId && (
        <div>
          {hit.strand === '-' ? 'Reverse orientation' : 'Forward orientation'} · mapping quality{' '}
          {hit.mappingQuality}
        </div>
      )}
    </div>
  );
}

function ContactTooltip({
  projection,
  hit,
  camera,
  unit,
  width,
  height,
}: {
  projection: NonNullable<ContactProjectionProps['contactProjection']>;
  hit: ContactHit;
  camera: ReturnType<PixiMapHandle['getContactCamera']>;
  unit: string;
  width: number;
  height: number;
}) {
  if (!camera || hit.projectionId !== projection.id) return null;
  const cell = projection.cells.find((cell) => cell.id === hit.cellId);
  const rect = cell && contactCellRect(cell, camera, contactPlotRect(width, height));
  if (!rect) return null;
  return (
    <div
      data-testid="indexed-contact-tooltip"
      style={{
        ...TOOLTIP_STYLE,
        left: Math.max(4, Math.min(width - 244, rect.x + rect.width / 2 + 12)),
        top: Math.max(4, Math.min(height - 85, rect.y + rect.height / 2 + 12)),
      }}
    >
      <div style={{ fontWeight: 600 }}>
        {hit.value.toLocaleString()} {unit}
      </div>
      <div>
        X · {hit.x.chrom}:{(hit.x.start + 1).toLocaleString()}–{hit.x.end.toLocaleString()}
      </div>
      <div>
        Y · {hit.y.chrom}:{(hit.y.start + 1).toLocaleString()}–{hit.y.end.toLocaleString()}
      </div>
    </div>
  );
}

const TOOLTIP_STYLE: CSSProperties = {
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
  maxWidth: 240,
};

const READ_MARKUP_BASE_STYLE: CSSProperties = {
  position: 'absolute',
  pointerEvents: 'none',
  boxSizing: 'border-box',
};

const LIGHT_READ_HOVER_FILTER = 'brightness(0.82) saturate(2)';
const DARK_READ_HOVER_FILTER = 'brightness(1.18)';
const LIGHT_READ_SELECTION_FILTER = LIGHT_READ_HOVER_FILTER;
const DARK_READ_SELECTION_FILTER = 'brightness(1.1)';

function ReadHoverHighlight({
  hit,
  themeMode,
}: {
  hit: ReadHitPayload;
  themeMode: IndexedGenomeTileNativeMapProps['themeMode'];
}) {
  const hoverFilter = themeMode === 'dark' ? DARK_READ_HOVER_FILTER : LIGHT_READ_HOVER_FILTER;
  return (
    <div
      data-testid="indexed-read-hover-highlight"
      data-read-state="hovered"
      style={{
        ...READ_MARKUP_BASE_STYLE,
        zIndex: 92,
        borderRadius: 2,
        backgroundColor: 'transparent',
        backdropFilter: hoverFilter,
        WebkitBackdropFilter: hoverFilter,
        left: hit.bodyRect.left,
        top: hit.bodyRect.top,
        width: hit.bodyRect.width,
        height: hit.bodyRect.height,
      }}
    />
  );
}

function ReadSelectionHighlight({
  hit,
  themeMode,
}: {
  hit: ReadHitPayload;
  themeMode: IndexedGenomeTileNativeMapProps['themeMode'];
}) {
  const trackRect = hit.trackRect ?? hit.bodyRect;
  const selectionFilter =
    themeMode === 'dark' ? DARK_READ_SELECTION_FILTER : LIGHT_READ_SELECTION_FILTER;
  return (
    <div
      data-testid="indexed-read-selection-track-clip"
      style={{
        ...READ_MARKUP_BASE_STYLE,
        zIndex: 91,
        overflow: 'hidden',
        left: trackRect.left,
        top: trackRect.top,
        width: trackRect.width,
        height: trackRect.height,
      }}
    >
      <div
        data-testid="indexed-read-selection"
        data-read-state="selected"
        style={{
          ...READ_MARKUP_BASE_STYLE,
          zIndex: 91,
          borderRadius: 2,
          backgroundColor: 'transparent',
          backdropFilter: selectionFilter,
          WebkitBackdropFilter: selectionFilter,
          boxShadow: '0 0 0 9999px hsl(var(--color-bg) / 0.42)',
          left: hit.bodyRect.left - trackRect.left,
          top: hit.bodyRect.top - trackRect.top,
          width: hit.bodyRect.width,
          height: hit.bodyRect.height,
        }}
      />
    </div>
  );
}

function ReadTooltip(props: {
  hit: ReadHitPayload;
  containerWidth: number;
  containerHeight: number;
  avoidRect: FloatingRect | null;
}) {
  const width = 250;
  const height = props.hit.event ? 98 : 54;
  const position = cursorFloatingPosition({
    screenX: props.hit.screenX,
    screenY: props.hit.screenY,
    width,
    height,
    containerWidth: props.containerWidth,
    containerHeight: props.containerHeight,
    avoidRect: props.avoidRect,
  });
  if (!position) return null;
  return (
    <div
      data-testid="indexed-read-tooltip"
      style={{ ...TOOLTIP_STYLE, ...position, width, maxWidth: width, boxSizing: 'border-box' }}
    >
      <div style={{ fontWeight: 600 }}>{props.hit.readId}</div>
      <div style={TOOLTIP_SUBTEXT}>{readResidentSummary(props.hit)}</div>
      {props.hit.event && <ReadDifferenceDetails hit={props.hit} />}
    </div>
  );
}

function ReadDifferenceDetails({ hit }: { hit: ReadHitPayload }) {
  const event = hit.event;
  if (!event) return null;
  const referencePosition =
    (hit.referenceBlockStart ?? hit.referenceStart) + (event.pos - hit.start);
  const eventSummary =
    event.kind === 'sub'
      ? `${event.refBase ?? '—'} → ${event.readBase ?? '—'}`
      : `${Math.max(1, event.length ?? 1)} bp ${event.kind === 'del' ? 'deletion' : 'insertion'}`;
  return (
    <div data-testid="read-difference-tooltip" style={{ ...TOOLTIP_SUBTEXT, marginTop: 4 }}>
      <div>
        {hit.chrom}:{referencePosition + 1} • {eventSummary}
      </div>
      <div>
        BAM column: {hit.column ? `${hit.column.supportingReadCount} supporting` : 'resident'}
      </div>
    </div>
  );
}

function ReadDetailsCard(props: {
  state: PinnedReadState;
  themeMode: IndexedGenomeTileNativeMapProps['themeMode'];
  containerWidth: number;
  containerHeight: number;
  onClose: () => void;
}) {
  const hitbox = readDetailsCardHitbox(
    props.state.hit,
    props.containerWidth,
    props.containerHeight
  );
  return (
    <div
      data-testid="indexed-read-details"
      style={{
        ...TOOLTIP_STYLE,
        left: hitbox.left,
        top: hitbox.top,
        width: hitbox.width,
        maxWidth: hitbox.width,
        maxHeight: Math.max(120, props.containerHeight - 8),
        boxSizing: 'border-box',
        overflow: 'auto',
        pointerEvents: 'auto',
        padding: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'start', gap: 8 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{props.state.hit.readId}</div>
          <div style={TOOLTIP_SUBTEXT}>{readResidentSummary(props.state.hit)}</div>
        </div>
        <div
          data-testid="indexed-read-details-header-actions"
          style={{ display: 'flex', alignItems: 'center', gap: 2, flex: '0 0 auto' }}
        >
          {props.state.kind === 'loaded' && (
            <ReadDetailsCopyButton
              key={`${props.state.details.readId}:${props.state.details.start}:${props.state.details.flag}:${props.state.details.pair?.readNumber ?? ''}`}
              details={props.state.details}
            />
          )}
          <button
            type="button"
            aria-label="Close read details"
            title="Close"
            onClick={props.onClose}
            className="rounded text-fg-muted hover:bg-bg-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
            style={READ_DETAILS_ICON_BUTTON_STYLE}
          >
            <XIcon size={12} />
          </button>
        </div>
      </div>
      {props.state.kind === 'loading' && (
        <div style={{ ...TOOLTIP_SUBTEXT, marginTop: 8 }}>Loading read details…</div>
      )}
      {props.state.kind === 'error' && (
        <div role="status" style={{ color: 'hsl(var(--color-danger))', marginTop: 8 }}>
          {renderUserMessage(props.state.message)}
        </div>
      )}
      {props.state.kind === 'loaded' && (
        <LoadedReadDetails
          key={`${props.state.details.readId}:${props.state.details.start}:${props.state.details.flag}:${props.state.details.pair?.readNumber ?? ''}`}
          details={props.state.details}
          themeMode={props.themeMode}
        />
      )}
    </div>
  );
}

function LoadedReadDetails({
  details,
  themeMode,
}: {
  details: AlignmentReadDetails;
  themeMode: IndexedGenomeTileNativeMapProps['themeMode'];
}) {
  const tags = Object.entries(details.tags).sort(([left], [right]) => left.localeCompare(right));
  const hasCompleteQuality =
    details.seq.length > 0 && details.baseQualities?.length === details.seq.length;
  return (
    <div style={{ marginTop: 8, display: 'grid', gap: 5 }}>
      <div
        data-testid="indexed-read-metadata-grid"
        style={{
          display: 'grid',
          gridTemplateColumns: tags.length > 0 ? 'minmax(0, 1fr) minmax(0, 1fr)' : '1fr',
          alignItems: 'start',
          gap: 8,
        }}
      >
        <div data-testid="indexed-read-core-metadata" style={{ display: 'grid', gap: 2 }}>
          <div>
            <strong>CIGAR</strong> {details.cigar || '—'}
          </div>
          <div>
            <strong>FLAG</strong> {details.flag}
          </div>
          {details.pair?.paired && (
            <div>
              <strong>Pair</strong> {details.pair.readNumber ?? '—'}
              {details.pair.mateStart !== undefined && ` • mate ${details.pair.mateStart + 1}`}
            </div>
          )}
        </div>
        {tags.length > 0 && (
          <div data-testid="indexed-read-tag-metadata" style={{ minWidth: 0 }}>
            <strong>Tags</strong>
            <div style={{ ...TOOLTIP_ID_STYLE, marginTop: 2, overflowWrap: 'anywhere' }}>
              {tags.map(([key, value]) => (
                <div key={key}>
                  {key} {formatReadTag(value)}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      <div>
        <div
          data-testid="indexed-read-sequence-header"
          style={{ display: 'flex', alignItems: 'center', gap: 8 }}
        >
          <strong>Sequence</strong>
          {hasCompleteQuality && <PhredQualityLegend themeMode={themeMode} />}
        </div>
        <QualityColoredSequence
          sequence={details.seq}
          baseQualities={details.baseQualities}
          themeMode={themeMode}
        />
      </div>
    </div>
  );
}

const READ_DETAILS_ICON_BUTTON_STYLE: CSSProperties = {
  width: 20,
  height: 20,
  padding: 0,
  border: 0,
  background: 'transparent',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flex: '0 0 auto',
};

function ReadDetailsCopyButton({ details }: { details: AlignmentReadDetails }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  useEffect(() => {
    if (copyState !== 'copied') return;
    const timer = window.setTimeout(() => setCopyState('idle'), 1_500);
    return () => window.clearTimeout(timer);
  }, [copyState]);
  const copyDetails = useCallback(async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable.');
      await navigator.clipboard.writeText(formatReadDetailsForClipboard(details));
      setCopyState('copied');
    } catch {
      setCopyState('error');
    }
  }, [details]);
  const title =
    copyState === 'copied'
      ? 'Copied read details'
      : copyState === 'error'
        ? 'Could not copy read details'
        : 'Copy read details';

  return (
    <button
      type="button"
      aria-label="Copy all read details"
      title={title}
      data-copy-state={copyState}
      data-testid="indexed-read-copy-button"
      onClick={() => void copyDetails()}
      className={`rounded hover:bg-bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${
        copyState === 'error' ? 'text-error' : 'text-fg-muted hover:text-fg'
      }`}
      style={READ_DETAILS_ICON_BUTTON_STYLE}
    >
      {copyState === 'copied' ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
    </button>
  );
}

function QualityColoredSequence(props: {
  sequence: string;
  baseQualities?: ReadonlyArray<number>;
  themeMode: IndexedGenomeTileNativeMapProps['themeMode'];
}) {
  if (!props.sequence) {
    return <div style={TOOLTIP_ID_STYLE}>Not available</div>;
  }
  const hasCompleteQuality = props.baseQualities?.length === props.sequence.length;
  return (
    <div>
      <div
        data-testid="indexed-read-sequence"
        style={{ ...TOOLTIP_ID_STYLE, overflowWrap: 'anywhere', letterSpacing: '0.02em' }}
      >
        {Array.from(props.sequence).map((base, index) => {
          const phred = hasCompleteQuality ? props.baseQualities?.[index] : undefined;
          return (
            <span
              key={index}
              {...(phred === undefined
                ? {}
                : {
                    'data-testid': 'indexed-read-sequence-base',
                    'data-phred': String(phred),
                    title: `${base} • Phred Q${phred}`,
                    'aria-label': `${base}, Phred Q${phred}`,
                  })}
              style={{
                color:
                  phred === undefined ? undefined : pileupReadQualityCss(phred, props.themeMode),
                fontWeight: 650,
              }}
            >
              {base}
            </span>
          );
        })}
      </div>
      {!hasCompleteQuality && (
        <div style={{ ...TOOLTIP_SUBTEXT, marginTop: 3 }}>Base qualities not available</div>
      )}
    </div>
  );
}

function PhredQualityLegend({
  themeMode,
}: {
  themeMode: IndexedGenomeTileNativeMapProps['themeMode'];
}) {
  return (
    <div
      data-testid="indexed-read-phred-legend"
      aria-label="Phred base-quality color legend"
      title="Point at a sequence base for its exact Phred score"
      style={{
        ...TOOLTIP_SUBTEXT,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 4,
        minWidth: 0,
        flex: '0 0 auto',
        marginLeft: 'auto',
      }}
    >
      <span
        data-testid="indexed-read-phred-label"
        style={{ minWidth: 32, fontWeight: 600, textAlign: 'right', whiteSpace: 'nowrap' }}
      >
        Phred
      </span>
      <span
        data-testid="indexed-read-phred-scale"
        aria-hidden="true"
        style={{
          position: 'relative',
          width: 100,
          height: 12,
          flex: '0 0 100px',
        }}
      >
        <span
          data-testid="indexed-read-phred-ticks"
          style={{
            position: 'absolute',
            inset: '0 0 auto',
            display: 'grid',
            gridTemplateColumns: `repeat(${PILEUP_READ_QUALITY_STOPS.length}, minmax(0, 1fr))`,
            height: 7,
          }}
        >
          {PILEUP_READ_QUALITY_STOPS.map((stop, index) => (
            <span
              key={stop.score}
              data-testid="indexed-read-phred-tick"
              style={{
                textAlign:
                  index === 0
                    ? 'left'
                    : index === PILEUP_READ_QUALITY_STOPS.length - 1
                      ? 'right'
                      : 'center',
                color: 'hsl(var(--color-fg-subtle))',
                fontSize: 7,
                fontWeight: 500,
                lineHeight: '7px',
              }}
            >
              {stop.label}
            </span>
          ))}
        </span>
        <span
          data-testid="indexed-read-phred-gradient"
          style={{
            position: 'absolute',
            right: 0,
            bottom: 0,
            left: 0,
            height: 3,
            borderRadius: 999,
            backgroundImage: pileupReadQualityGradientCss(themeMode),
            boxShadow: 'inset 0 0 0 1px hsl(var(--color-fg) / 0.1)',
          }}
        />
      </span>
    </div>
  );
}

function formatReadDetailsForClipboard(details: AlignmentReadDetails): string {
  return JSON.stringify(
    {
      readId: details.readId,
      chrom: details.chrom,
      start: details.start,
      end: details.end,
      strand: details.strand,
      mapq: details.mapq,
      flag: details.flag,
      cigar: details.cigar,
      pair: details.pair ?? null,
      tags: Object.fromEntries(
        Object.entries(details.tags).sort(([left], [right]) => left.localeCompare(right))
      ),
      seq: details.seq,
      baseQualities: details.baseQualities ?? null,
    },
    null,
    2
  );
}

function readResidentSummary(hit: ReadHitPayload): string {
  const pair = hit.pair?.readNumber ? ` • read ${hit.pair.readNumber}` : '';
  const blockStart = hit.referenceBlockStart ?? hit.referenceStart;
  return `${hit.chrom}:${blockStart + 1}-${blockStart + (hit.end - hit.start)} • ${hit.strand} • MAPQ ${hit.mapq}${pair}`;
}

function formatReadTag(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

function cursorFloatingPosition(input: {
  screenX: number;
  screenY: number;
  width: number;
  height: number;
  containerWidth: number;
  containerHeight: number;
  avoidRect?: FloatingRect | null;
}): { left: number; top: number } | null {
  const gap = 12;
  const clamp = (position: { left: number; top: number }) => ({
    left: Math.max(4, Math.min(position.left, input.containerWidth - input.width - 4)),
    top: Math.max(4, Math.min(position.top, input.containerHeight - input.height - 4)),
  });
  const right = input.screenX + gap;
  const left = input.screenX - input.width - gap;
  const below = input.screenY + gap;
  const above = input.screenY - input.height - gap;
  const horizontal =
    right + input.width <= input.containerWidth - 4 ? [right, left] : [left, right];
  const vertical =
    below + input.height <= input.containerHeight - 4 ? [below, above] : [above, below];
  const candidates = horizontal.flatMap((candidateLeft) =>
    vertical.map((candidateTop) => clamp({ left: candidateLeft, top: candidateTop }))
  );
  if (!input.avoidRect) return candidates[0]!;
  const safeCandidate = candidates.find(
    (candidate) =>
      !floatingRectsOverlap(
        { ...candidate, width: input.width, height: input.height },
        input.avoidRect!
      )
  );
  return safeCandidate ?? null;
}

interface FloatingRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function readDetailsCardHitbox(
  hit: ReadHitPayload,
  containerWidth: number,
  containerHeight: number
): FloatingRect {
  const width = Math.min(340, Math.max(220, containerWidth - 8));
  const height = Math.min(280, Math.max(120, containerHeight - 8));
  return {
    ...(cursorFloatingPosition({
      screenX: hit.screenX,
      screenY: hit.screenY,
      width,
      height,
      containerWidth,
      containerHeight,
    }) ?? { left: 4, top: 4 }),
    width,
    height,
  };
}

function floatingRectsOverlap(left: FloatingRect, right: FloatingRect): boolean {
  return (
    left.left < right.left + right.width &&
    left.left + left.width > right.left &&
    left.top < right.top + right.height &&
    left.top + left.height > right.top
  );
}

function sameReadScreenRect(
  left: ReadHitPayload['bodyRect'] | undefined,
  right: ReadHitPayload['bodyRect'] | undefined
): boolean {
  if (!left || !right) return left === right;
  return (
    left.left === right.left &&
    left.top === right.top &&
    left.width === right.width &&
    left.height === right.height
  );
}

function sameReadScreenGeometry(left: ReadHitPayload, right: ReadHitPayload): boolean {
  return (
    sameReadScreenRect(left.bodyRect, right.bodyRect) &&
    sameReadScreenRect(left.hitRect, right.hitRect) &&
    sameReadScreenRect(left.trackRect, right.trackRect)
  );
}

function reanchorReadScreenPoint(
  previous: ReadHitPayload,
  located: ReadHitPayload
): ReadHitPayload {
  const projectCoordinate = (
    coordinate: number,
    previousStart: number,
    previousSize: number,
    locatedStart: number,
    locatedSize: number
  ) =>
    previousSize > 0
      ? locatedStart + ((coordinate - previousStart) / previousSize) * locatedSize
      : locatedStart + locatedSize / 2;
  return {
    ...located,
    screenX: projectCoordinate(
      previous.screenX,
      previous.bodyRect.left,
      previous.bodyRect.width,
      located.bodyRect.left,
      located.bodyRect.width
    ),
    screenY: projectCoordinate(
      previous.screenY,
      previous.bodyRect.top,
      previous.bodyRect.height,
      located.bodyRect.top,
      located.bodyRect.height
    ),
  };
}

function pointInsideRead(x: number, y: number, hit: ReadHitPayload): boolean {
  const bounds = hit.hitRect ?? hit.bodyRect;
  return (
    x >= bounds.left &&
    x < bounds.left + bounds.width &&
    y >= bounds.top &&
    y < bounds.top + bounds.height
  );
}

function sameHoverTooltipContent(
  left: HoverFeatureInfo | null,
  right: HoverFeatureInfo | null
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    (left.canonicalIdentity ?? left.id) === (right.canonicalIdentity ?? right.id) &&
    left.displayName === right.displayName &&
    left.type === right.type &&
    left.start === right.start &&
    left.end === right.end &&
    left.direction === right.direction &&
    left.sourceId === right.sourceId &&
    left.transcriptId === right.transcriptId &&
    left.lane === right.lane
  );
}

const TOOLTIP_SUBTEXT: CSSProperties = {
  color: 'hsl(var(--color-fg-subtle))',
  fontSize: '10px',
};

const TOOLTIP_ID_STYLE: CSSProperties = {
  color: 'hsl(var(--color-fg-subtle))',
  fontSize: '10px',
  fontFamily:
    'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  marginTop: 2,
};

function FeatureTooltip(props: {
  mutationLine?: string | null;
  regionLine: string | null;
  displayName: string;
  type: string;
  start: number;
  end: number;
  direction: Feature['direction'];
  sourceId: string | null;
  transcriptId: string | null;
  internalId: number;
  lane: number;
  screenX: number;
  screenY: number;
  containerWidth: number;
  containerHeight: number;
}) {
  const width = 240;

  const height = 80 + (props.regionLine ? 16 : 0) + (props.mutationLine ? 16 : 0);
  const cursorOffset = 12;
  let left = props.screenX + cursorOffset;
  let top = props.screenY + cursorOffset;
  if (left + width > props.containerWidth) left = props.screenX - width - cursorOffset;
  if (top + height > props.containerHeight) top = props.screenY - height - cursorOffset;
  left = Math.max(4, left);
  top = Math.max(4, top);

  return (
    <div data-testid="indexed-annotation-feature-tooltip" style={{ ...TOOLTIP_STYLE, left, top }}>
      <div style={{ fontWeight: 600 }}>{props.displayName}</div>
      <div style={TOOLTIP_SUBTEXT}>
        {props.type} • {props.start + 1}-{props.end}
        {props.direction !== 'none' && ` • ${props.direction}`}
        {' • '}lane {props.lane}
      </div>
      {props.regionLine && <div style={TOOLTIP_SUBTEXT}>{props.regionLine}</div>}
      {props.mutationLine && (
        <div data-testid="cds-mutation-hover-facts" style={TOOLTIP_SUBTEXT}>
          {props.mutationLine}
        </div>
      )}
      {props.sourceId !== null && (
        <div style={TOOLTIP_ID_STYLE}>
          <span style={{ opacity: 0.6 }}>id:</span> {props.sourceId}
        </div>
      )}
      {props.transcriptId !== null && props.transcriptId !== props.sourceId && (
        <div style={TOOLTIP_ID_STYLE}>
          <span style={{ opacity: 0.6 }}>tx:</span> {props.transcriptId}
        </div>
      )}
      <div style={TOOLTIP_ID_STYLE}>
        <span style={{ opacity: 0.6 }}>#</span>
        {props.internalId}
      </div>
    </div>
  );
}
