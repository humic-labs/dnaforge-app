import { usePresentationListener } from '../../../presentation/PresentationSurface';
import { supportsWheelMomentum } from '@waypoint/platform/wheel-motion';
import { type UserMessage } from '@waypoint/user-messages';
import type { SharedSequenceColumnNavigation } from './alignment-mutation-navigation';
('use client');

import { trackRendererEvent } from '@/lib/analytics';
import {
  useRef,
  useCallback,
  useMemo,
  useState,
  useEffect,
  useLayoutEffect,
  useSyncExternalStore,
  memo,
} from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { flushSync } from 'react-dom';
import type { SelectionRange } from '../selection-state';
import { useWorkspaceViewerEditMode } from './useWorkspaceViewerEditMode';
import {
  SequenceViewer,
  useORFs,
  useSequenceSearch,
  DEFAULT_EDITOR_CONFIG,
  type PrimerDisplay,
  type MutationMarker,
  type CoordinateSpace,
  type WorkspaceEditorHandle,
  type AnnotationStateIdentity,
  type EditorPasteFragment,
  type SequenceEditorSession,
  useEditorSessionState,
  deriveSequenceLodLevel,
  isInAlignmentMode,
  projectSequenceSelectionFromInput,
  annotationIdentityFromSearchMatch,
  annotationIdentityEqual,
  INITIAL_PORTAL_WIDTH_STABILITY,
  samplePortalReattachWidth,
  type PortalWidthStability,
} from '@waypoint/workspace-editor';
import type { SequenceViewMode } from './SequenceViewerModeToggle';
import { matchesAppShortcut } from '../../../keyboard/shortcutRegistry';
import { MAX_SEQUENCE_ZOOM, MIN_SEQUENCE_ZOOM } from './SequencePaneControls';
import {
  SequenceViewer1DWithTracks,
  useSequenceHasSangerTrace,
} from '../tracks/SequenceTracksView';
import { WebGLMap } from '@waypoint/plasmid-viewer';
import { useSequenceDataLayers } from '../data-layers/useSequenceDataLayers';
import { SharedSequenceReadViewer } from './SharedSequenceReadViewer';
import { bindSangerReadViewProjection } from '../sanger-read-lifecycle-telemetry';
import type { SharedAlignmentLane } from './shared-sequence-read-model';
import type { SequenceComparisonInput } from './sequence-comparison-input';
import type { WebGLMapHandle, BackboneSegment } from '@waypoint/plasmid-viewer';
import type { BackbonePartHitPayload, BackbonePartReorderPreview } from '@waypoint/genome-renderer';
import { WorkspaceViewerContextMenu } from './WorkspaceViewerContextMenu';
import {
  WorkspaceViewerEditModeBar,
  WorkspaceViewerFindOverlay,
  optionalEnzymeDrawer,
} from './WorkspaceViewerChrome';
import { WorkspaceViewerMapPane, workspaceViewerMapMorphToCircle } from './WorkspaceViewerMapPane';
import { debugLog } from '../../../utils/debug-log';

import {
  cutSiteRecognitionSelection,
  nucleicAcidOf,
  resolveSequenceGeneticCode,
  type AnnotatedSequence,
  type Annotation,
  type ColoredCutSite,
} from '@waypoint/sequence-utils';
import type { ParsedPlasmid } from '@waypoint/plasmid-viewer';
import { TAB_PORTAL_HOST_ATTACHED_EVENT } from '../../../shared/tab-portal-contract';
import { SequenceToolbarSidebar } from './SequenceToolbarSidebar';
import { SequenceSurfaceLayout } from './SequenceSurfaceLayout';
import { resolveMapRenderShape } from './map-render-shape';
import {
  clampSideMapPaneWidth,
  defaultSideMapPaneWidth,
  usableSideSplitWidth,
} from './side-map-pane-width';
import { clampWebglMapZoom, resolveWebglMapZoomBounds } from './SequenceMapPaneControls';
import { RestrictionEnzymeDrawerPanel } from './RestrictionEnzymeDrawerPanel';
import { useSequenceMinimapSizing } from './useSequenceMinimapSizing';
import { suggestedStackedMapPaneHeight } from './stacked-map-pane-height';
import { useSequenceScrollNavigation } from './useSequenceScrollNavigation';
import { useSequenceClipboardActions, type CopySelection } from './useSequenceClipboardActions';
import { useTranslationDialogStore } from '../translation-dialog-store';
import { useSequenceContextMenuState } from './useSequenceContextMenuState';
import type { ActiveOverlaySnapshot } from '../../ai/public/selection-descriptor/active-overlays';
import { useWorkspaceViewerAskAi } from './useWorkspaceViewerAskAi';
import { useSequenceCutSitesView } from './useSequenceCutSitesView';
import { useSequenceSelectionState } from './useSequenceSelectionState';
import {
  useWebglMapKeyboardNavigation,
  type WebglMapCursorNavigation,
} from './useWebglMapKeyboardNavigation';
import { useSequenceViewTransformActions } from './useSequenceViewTransformActions';
import { useSequenceViewportSync } from './useSequenceViewportSync';
import { useSequenceViewerConfig } from './useSequenceViewerConfig';
import { useVirtualDigestView } from './useVirtualDigestView';
import {
  useWebglMapInteractions,
  type WebglMapCrossoverBoundaryCommit,
  type WebglMapCrossoverEditRange,
  type WebglPrimerPbsLengthCommit,
  type WebglPrimerPbsLengthPreview,
} from './useWebglMapInteractions';
import { useWebglCameraZoomState } from './useWebglCameraZoomState';
import { resolveSequenceMapWebGLGeometry } from './sequence-map-webgl-geometry';
import {
  annotationsWithCdsExtensionPreview,
  cdsExtensionIdentityKey,
  cdsWithoutExtensionPreview,
  committedBoundsForExtensionPreview,
  committedQualifiersForExtensionPreview,
} from '@waypoint/workspace-editor';
import {
  resolvePaneResizeDisplaySize,
  resolveSequencePaneHeightDuringMapResize,
} from './pane-resize-display-size';
import {
  resolveCircularBufferHeightHighWater,
  resolveSequencePaneViewportHeight,
} from './pane-resize-scroll-freeze';
import {
  SequenceCrossSurfaceProviders,
  useSequenceCrossSurfaceState,
} from './sequence-cross-surface';
import type { AnnotationDraft, ViewerConfig } from '../types';
import { buildOrfDraft } from '../build-orf-draft';
import { observeSequenceSearch } from '../sequence-search-telemetry';
import { observeOrfDetection } from '../orf-detection-observation';
import { ORFDetectionNotice } from './ORFDetectionNotice';
import { useTabViewState } from '../../canvas/public/hooks/useTabViewState';
import { useSequenceEditModeStore } from '../../../stores/sequence-edit-mode-store';
import { useEmptySequenceEntryStore } from '../empty-sequence-entry-store';
import { useWorkspaceViewerFindCommands } from './useWorkspaceViewerFindCommands';
import { withAnnotationDisplayColorsForMinimap, withPrimerDisplaysForMinimap } from '../adapters';
import {
  navigationCenterBpFromRangeOrPosition,
  resolveMapOnlyNucleotideZoom,
  resolveMapOnlyRangeFitZoom,
} from './sequence-viewport-state';
import { useSequenceViewState } from '../view-state/useSequenceViewState';
import {
  effectiveSequenceMapShape,
  isMapSurfaceVisible,
  isSequenceSurfaceVisible,
  mapLayoutForPlacement,
  type SequenceMapPlacement,
  type SequenceMapShape,
  type SequenceRendererVisibility,
  type SequenceViewSurface,
} from '../view-state/sequence-view-state';
import { useProjectedSequenceView } from '../view-state/useProjectedSequenceView';
import {
  projectPrimerRangeToSource,
  projectPrimerRangeToView,
} from '../view-state/sequence-view-projection';
import { useWebGLPerformancePreference } from '../webgl-performance-preference';
import { WorkspaceViewerSequenceSurface } from './WorkspaceViewerSequenceSurface';
import {
  SequenceAnnotationCatalogHover,
  SequenceAnnotationTracksControl,
  useSequenceMapAnnotationCatalog,
} from '../annotation-catalog';
import {
  sequenceMutationsForCoordinateSpace,
  sequenceReverseComplementVisible,
  sequenceScannedCutSites,
  sequenceSearchOverlayProps,
  sequenceShowCutSites,
  unlessFlag,
  whenFlag,
  workspaceViewerMapSurfaceOrders,
} from './workspace-viewer-sequence-surface';
import { workspaceViewerEntityKeys } from './workspace-viewer-entity-keys';
import {
  workspaceViewerActualWebGLMapVisible,
  workspaceViewerAskAiDisabled,
  workspaceViewerCanEditSequence,
  workspaceViewerLiveAnnotations,
  workspaceViewerLiveSequence,
  workspaceViewerDrawerSurfaceOpen,
  workspaceViewerEmptySequenceEntryVisible,
  workspaceViewerFallbackName,
  workspaceViewerHighlightRange,
  workspaceViewerMapCollapseHold,
  workspaceViewerMaybeFrozenCenter,
  workspaceViewerOrLocal,
  workspaceViewerRenderMapSurfaceVisible,
  workspaceViewerRequestedSideMapPaneWidth,
  workspaceViewerSequenceEditable,
  workspaceViewerSurfaceFlags,
  workspaceViewerViewportIndicatorVisible,
} from './workspace-viewer-surface-flags';
import {
  workspaceViewerLayoutFlags,
  workspaceViewerMinimapContainerStyle,
  workspaceViewerMinimapType,
  workspaceViewerSequenceContainerStyle,
  workspaceViewerSequenceViewportHeightHint,
  workspaceViewerSurfaceLayoutStyle,
} from './workspace-viewer-layout-styles';

type AutoAnnotateStatus = 'idle' | 'loading' | 'success' | 'error';
const EMPTY_COLORED_CUT_SITES: ColoredCutSite[] = [];

interface WorkspaceViewerProps {
  entityId?: string;
  readOnly?: boolean;
  editingPending?: boolean;
  savePending?: boolean;
  sequence: AnnotatedSequence;
  dataLayerSourceSequence?: AnnotatedSequence;
  plasmid: ParsedPlasmid;
  circular: boolean;
  initialEditMode?: boolean;
  onEditModeChange?: (active: boolean) => void;
  onCopy?: (selection: CopySelection) => void;
  resolvePasteFragment?: (
    clipboardText: string
  ) => EditorPasteFragment | null | Promise<EditorPasteFragment | null>;
  onSelectionChange?: (range: { start: number; end: number; wraps?: boolean } | null) => void;
  onPaste?: (cursorPosition: number | null) => void;
  pasteTargetLabel?: string;
  mapPasteHint?: string;
  onCursorChange?: (position: number | null) => void;
  onMapPositionClick?: (position: number) => void;
  mapEditCursorPosition?: number;
  mapEditCursorBlinking?: boolean;
  onMapPrimerPbsLengthPreview?: WebglPrimerPbsLengthPreview;
  onMapPrimerPbsLengthCommit?: WebglPrimerPbsLengthCommit;
  mapCrossoverEditRange?: WebglMapCrossoverEditRange | null;
  onMapCrossoverBoundaryCommit?: WebglMapCrossoverBoundaryCommit;
  mapSelectedPartRegionId?: string | null;
  onMapPartSelect?: (part: BackbonePartHitPayload) => void;
  onMapPartReorderPreview?: (
    part: BackbonePartHitPayload,
    targetBp: number
  ) => BackbonePartReorderPreview | null;
  onMapPartReorderCommit?: (part: BackbonePartHitPayload, targetBp: number) => void;
  onMapPartReverseComplement?: (part: BackbonePartHitPayload) => void;
  onMapKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onMapCursorNavigate?: (navigation: WebglMapCursorNavigation) => void;
  onSelectionStateChange?: (state: import('../selection-state').SelectionState) => void;
  children?: React.ReactNode;
  backboneSegments?: BackboneSegment[];
  junctionIndicators?: Array<{
    position: number;
    leftColor?: string;
    rightColor?: string;
  }>;
  primers?: PrimerDisplay[];
  scrollToPosition?: number | null;
  sequenceNavigationRequestId?: number | string | null;
  onScrollComplete?: () => void;
  highlightRange?: { start: number; end: number; wraps?: boolean } | null;
  onHighlightComplete?: () => void;
  belowMinimap?: React.ReactNode;
  hideMinimap?: boolean;
  alternateMinimapContent?: React.ReactNode;
  onGGLabelClick?: (junctionIndex: number) => void;
  onOpenAlignments?: () => void;
  isAlignmentPanelOpen?: boolean;
  onOpenMetadata?: () => void;
  isMetadataOpen?: boolean;
  onOpenGitHistory?: () => void;
  historyLabel?: string;
  isGitHistoryOpen?: boolean;
  onOpenPrimers?: () => void;
  isPrimersPanelOpen?: boolean;
  onOpenStructure?: () => void;
  isStructureDrawerOpen?: boolean;
  isStructureAvailable?: boolean;
  onViewStructure?: (cds: Annotation) => void;
  onCreateAminoAcidSequence?: (cds: Annotation) => void;
  onAskAI?: (payload: {
    range: { start: number; end: number };
    wraps?: boolean;
    overlays?: ActiveOverlaySnapshot;
    inferredWindow?: boolean;
    seedText?: string;
    anchor?: { x: number; y: number };
  }) => void;
  onCreatePrimer?: (
    range: { start: number; end: number; sequence: string },
    direction: 'forward' | 'reverse'
  ) => void;
  onEditPrimer?: (primer: import('@waypoint/workspace-editor').PrimerDisplay) => void;
  onEditPrimerBinding?: (primer: import('@waypoint/workspace-editor').PrimerDisplay) => void;
  onCopyPrimerBases?: (primer: import('@waypoint/workspace-editor').PrimerDisplay) => void;
  onDetachPrimer?: (primer: import('@waypoint/workspace-editor').PrimerDisplay) => void;
  onAttachPrimers?: () => void;
  mutations?: MutationMarker[];
  onMutationClick?: (mutation: MutationMarker) => void;
  coordinateSpace?: CoordinateSpace;

  comparisonMode?: boolean;
  comparison?: SequenceComparisonInput;
  trackOwnerId?: string;

  columnNavigation?: SharedSequenceColumnNavigation;

  alignmentLanes?: ReadonlyArray<SharedAlignmentLane>;
  onAutoAnnotateClick?: () => void;
  autoAnnotateStatus?: AutoAnnotateStatus;
  isReviewMode?: boolean;
  hasReviewSession?: boolean;
  internalCutSiteMarkers?: ColoredCutSite[];
  surface?: SequenceViewSurface;
  drawerSlot?: React.ReactNode;
  adaptiveDrawerWidth?: number;
  isAnyDrawerOpen?: boolean;
  isAnnotationDrawerOpen?: boolean;
  isRestrictionEnzymeDrawerOpen?: boolean;
  onRestrictionEnzymeDrawerOpenChange?: (open: boolean) => void;
  restrictionEnzymeDrawerWidth?: number;
  onRestrictionEnzymeDrawerWidthChange?: (width: number) => void;
  onEditAnnotation?: (annotation: Annotation) => void;
  onCommitCdsExtension?: (commit: { original: Annotation; updated: Annotation }) => void;
  onOpenCdsExtensionDraft?: (action: {
    original: Annotation;
    direction: 'five-prime' | 'three-prime';
    kind: 'extend' | 'undo';
  }) => void;
  onActivateAnnotation?: (annotation: AnnotationStateIdentity) => void;
  onSelectedAnnotationChange?: (annotation: AnnotationStateIdentity | null) => void;
  onDeleteAnnotation?: (annotation: Annotation) => void;
  onAddAnnotation?: (range: { start: number; end: number }) => void;
  onAddAnnotationDraft?: (draft: AnnotationDraft) => void;
  candidateOrf?: { start: number; end: number; strand: '+' | '-' } | null;
  forcedSelectedAnnotation?: {
    type: string;
    name: string;
    start: number;
    end: number;
    direction: number;
  } | null;
  rulerDecorations?: import('@waypoint/workspace-editor').RulerDecoration[];
  changedAnnotationNames?: Set<string>;
  hideReverseComplement?: boolean;
  diffResult?: import('../diff/sequence-diff').DiffResult | null;
  editorSession?: SequenceEditorSession;
  onEditCommit?: () => Promise<boolean | void> | boolean | void;
  onEditDiscard?: () => AnnotatedSequence | null;
}

const MemoSequenceToolbarSidebar = memo(SequenceToolbarSidebar);

const DEFAULT_RESTRICTION_ENZYME_DRAWER_WIDTH = 350;
const MIN_RESTRICTION_ENZYME_DRAWER_WIDTH = 250;
const MAX_RESTRICTION_ENZYME_DRAWER_WIDTH = 800;
const MIN_VERTICAL_SEQUENCE_PANE_HEIGHT = 96;
type SequenceMapPaneResizeAxis = 'horizontal' | 'vertical';

function clampRestrictionEnzymeDrawerWidth(width: number): number {
  return Math.max(
    MIN_RESTRICTION_ENZYME_DRAWER_WIDTH,
    Math.min(MAX_RESTRICTION_ENZYME_DRAWER_WIDTH, width)
  );
}

function subscribeOrfDocumentVisibility(onChange: () => void) {
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}

function orfDocumentIsVisible() {
  return document.visibilityState !== 'hidden';
}

function WorkspaceViewerInternal({
  entityId,
  readOnly = false,
  editingPending = false,
  savePending = false,
  sequence: sourceSequence,
  dataLayerSourceSequence,
  plasmid: sourcePlasmid,
  circular,
  initialEditMode = false,
  onEditModeChange,
  onCopy,
  resolvePasteFragment,
  onSelectionChange,
  onPaste,
  pasteTargetLabel,
  mapPasteHint,
  onCursorChange,
  onMapPositionClick,
  mapEditCursorPosition: sourceMapEditCursorPosition,
  mapEditCursorBlinking = false,
  onMapPrimerPbsLengthPreview,
  onMapPrimerPbsLengthCommit,
  mapCrossoverEditRange,
  onMapCrossoverBoundaryCommit,
  mapSelectedPartRegionId,
  onMapPartSelect,
  onMapPartReorderPreview,
  onMapPartReorderCommit,
  onMapPartReverseComplement,
  onMapKeyDown,
  onMapCursorNavigate,
  onSelectionStateChange,
  children,
  backboneSegments: sourceBackboneSegments,
  junctionIndicators,
  primers: sourcePrimers,
  scrollToPosition: sourceScrollToPositionProp,
  sequenceNavigationRequestId,
  onScrollComplete,
  highlightRange: sourceHighlightRangeProp,
  onHighlightComplete,
  belowMinimap,
  hideMinimap = false,
  alternateMinimapContent,
  onGGLabelClick,
  onOpenAlignments,
  isAlignmentPanelOpen,
  onOpenMetadata,
  isMetadataOpen,
  onOpenGitHistory,
  historyLabel,
  isGitHistoryOpen,
  onOpenPrimers,
  isPrimersPanelOpen,
  onOpenStructure,
  isStructureDrawerOpen,
  isStructureAvailable,
  onCreatePrimer: _onCreatePrimer,
  onEditPrimer: _onEditPrimer,
  onEditPrimerBinding: _onEditPrimerBinding,
  onCopyPrimerBases: _onCopyPrimerBases,
  onDetachPrimer: _onDetachPrimer,
  onAttachPrimers,
  mutations: sourceMutations,
  onMutationClick,
  coordinateSpace,
  comparisonMode = false,
  comparison,
  trackOwnerId,
  columnNavigation,
  alignmentLanes,
  onAutoAnnotateClick,
  autoAnnotateStatus,
  isReviewMode: _isReviewMode = false,
  hasReviewSession = false,
  internalCutSiteMarkers: sourceInternalCutSiteMarkers,
  surface = 'sequence',
  drawerSlot,
  adaptiveDrawerWidth,
  isAnyDrawerOpen = false,
  isAnnotationDrawerOpen = false,
  isRestrictionEnzymeDrawerOpen,
  onRestrictionEnzymeDrawerOpenChange,
  restrictionEnzymeDrawerWidth,
  onRestrictionEnzymeDrawerWidthChange,
  onEditAnnotation: onEditAnnotationProp,
  onCommitCdsExtension,
  onOpenCdsExtensionDraft,
  onActivateAnnotation,
  onSelectedAnnotationChange,
  onDeleteAnnotation: onDeleteAnnotationProp,
  onAddAnnotation: onAddAnnotationProp,
  onViewStructure,
  onCreateAminoAcidSequence,
  onAskAI: onAskAIProp,
  onAddAnnotationDraft: onAddAnnotationDraftProp,
  candidateOrf: sourceCandidateOrf,
  forcedSelectedAnnotation: sourceForcedSelectedAnnotation,
  rulerDecorations: sourceRulerDecorations,
  changedAnnotationNames,
  hideReverseComplement,
  diffResult: _diffResult,
  editorSession,
  onEditCommit: onEditCommitProp,
  onEditDiscard,
}: WorkspaceViewerProps) {
  const presentationEvents = usePresentationListener();

  const [pendingComparisonMenu, setPendingComparisonMenu] = useState<{
    x: number;
    y: number;
    position: number | null;
    range: { start: number; end: number } | null;
  } | null>(null);
  useEffect(() => {
    setPendingComparisonMenu(null);
  }, [comparison?.id]);
  const workspaceRenderStartedAt = performance.now();
  useEffect(() => {
    debugLog('[WorkspaceViewer] MOUNTED for sequence:', sourceSequence.id);
    return () => {
      debugLog('[WorkspaceViewer] UNMOUNTING for sequence:', sourceSequence.id);
    };
  }, []);

  useEffect(() => {
    debugLog('[WorkspaceViewer] coordinateSpace changed:', {
      mode: coordinateSpace?.mode,
      hasGappedSequence: !!coordinateSpace?.gappedSequence,
      timestamp: new Date().toISOString(),
    });
  }, [coordinateSpace]);

  const minimapRef = useRef<WebGLMapHandle | null>(null);
  const focusedPaneRef = useRef<'sequence' | 'map' | null>(null);
  const [webglRendererReadyEpoch, setWebglRendererReadyEpoch] = useState(0);
  const handleWebglRendererReady = useCallback(() => {
    setWebglRendererReadyEpoch((epoch) => epoch + 1);
  }, []);
  const surfaceLayoutRef = useRef<HTMLDivElement>(null);
  const minimapContainerRef = useRef<HTMLDivElement>(null);
  const [minimapWidth, setMinimapWidth] = useState(800);
  const [minimapContainerHeight, setMinimapContainerHeight] = useState(0);
  const [surfaceLayoutWidth, setSurfaceLayoutWidth] = useState<number | null>(null);
  const [surfaceLayoutHeight, setSurfaceLayoutHeight] = useState(0);
  const [sideMapPaneWidthDraft, setSideMapPaneWidthDraft] = useState<number | null>(null);
  const [sequenceLayoutViewportHeight, setSequenceLayoutViewportHeight] = useState(0);
  const mapPaneResizePreviewActiveRef = useRef(false);
  const [mapPaneResizePreviewActive, setMapPaneResizePreviewActive] = useState(false);
  const circularBufferHeightFreezeRef = useRef(0);

  useEffect(() => {
    const el = surfaceLayoutRef.current;
    if (!el) return;
    let lastWidth: number | null = null;
    let lastHeight = 0;
    const updateSize = (width: number, height: number) => {
      if (lastWidth === null || Math.abs(width - lastWidth) > 1) {
        lastWidth = width;
        setSurfaceLayoutWidth(width);
      }
      if (Math.abs(height - lastHeight) > 1) {
        lastHeight = height;
        setSurfaceLayoutHeight(height);
      }
    };
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        updateSize(entry.contentRect.width, entry.contentRect.height);
      }
    });
    ro.observe(el);
    updateSize(el.clientWidth, el.clientHeight);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = minimapContainerRef.current;
    if (!el) return;
    let lastWidth = 0;
    let lastHeight = 0;
    let reattachWidthSettling = false;
    let reattachWidthStability: PortalWidthStability = INITIAL_PORTAL_WIDTH_STABILITY;
    let settleRafId: number | null = null;
    const updateSize = (width: number, height: number) => {
      if (mapPaneResizePreviewActiveRef.current) return;
      if (!reattachWidthSettling && Math.abs(width - lastWidth) > 1) {
        lastWidth = width;
        setMinimapWidth(width);
      }
      if (Math.abs(height - lastHeight) > 1) {
        lastHeight = height;
        setMinimapContainerHeight(height);
      }
    };
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        updateSize(entry.contentRect.width, entry.contentRect.height);
      }
    });
    ro.observe(el);
    updateSize(el.clientWidth, el.clientHeight);

    const onPortalHostAttached = () => {
      const node = minimapContainerRef.current;
      if (node !== el || !el.isConnected) return;
      reattachWidthSettling = true;
      reattachWidthStability = INITIAL_PORTAL_WIDTH_STABILITY;
      if (settleRafId !== null) cancelAnimationFrame(settleRafId);
      const step = () => {
        if (minimapContainerRef.current !== el || !el.isConnected) {
          settleRafId = null;
          return;
        }
        const result = samplePortalReattachWidth(reattachWidthStability, el.clientWidth);
        reattachWidthStability = result.state;
        updateSize(el.clientWidth, el.clientHeight);
        if (!result.settled) {
          settleRafId = requestAnimationFrame(step);
          return;
        }
        reattachWidthSettling = false;
        settleRafId = null;
        updateSize(el.clientWidth, el.clientHeight);
      };
      settleRafId = requestAnimationFrame(step);
    };
    window.addEventListener(TAB_PORTAL_HOST_ATTACHED_EVENT, onPortalHostAttached);

    return () => {
      if (settleRafId !== null) cancelAnimationFrame(settleRafId);
      reattachWidthSettling = false;
      reattachWidthStability = INITIAL_PORTAL_WIDTH_STABILITY;
      ro.disconnect();
      window.removeEventListener(TAB_PORTAL_HOST_ATTACHED_EVENT, onPortalHostAttached);
    };
  }, []);

  const drawerSurfaceOpen = workspaceViewerDrawerSurfaceOpen(
    drawerSlot,
    isRestrictionEnzymeDrawerOpen
  );
  useLayoutEffect(() => {
    if (mapPaneResizePreviewActiveRef.current) {
      mapPaneResizePreviewActiveRef.current = false;
    }
    setMapPaneResizePreviewActive((active) => (active ? false : active));
    const layout = surfaceLayoutRef.current;
    const pane = minimapContainerRef.current;
    if (layout) {
      const width = layout.clientWidth;
      const height = layout.clientHeight;
      setSurfaceLayoutWidth(width);
      if (height > 0) setSurfaceLayoutHeight(height);
    }
    if (pane) {
      const width = pane.clientWidth;
      const height = pane.clientHeight;
      if (width > 0) setMinimapWidth(width);
      if (height > 0) setMinimapContainerHeight(height);
    }
  }, [drawerSurfaceOpen]);

  const { tabStateKey } = workspaceViewerEntityKeys(entityId, undefined, undefined);
  const [viewState, setViewState] = useTabViewState(tabStateKey);
  const [seqView, patchSeqView] = useSequenceViewState(tabStateKey, { circular, surface });
  const [liveZoom, setLiveZoom] = useState<{ key: string; value: number } | null>(null);
  const [canvasMinZoom, setCanvasMinZoom] = useState(MIN_SEQUENCE_ZOOM);
  const zoomLevel = liveZoom?.key === tabStateKey ? liveZoom.value : seqView.zoom;
  const liveSeqView = useMemo(
    () => (zoomLevel === seqView.zoom ? seqView : { ...seqView, zoom: zoomLevel }),
    [seqView, zoomLevel]
  );
  const emptySequenceEntryCue = useEmptySequenceEntryStore((state) => state.cue);
  const [isEditMode, setIsEditMode, editingActive] = useWorkspaceViewerEditMode(
    tabStateKey,
    initialEditMode,
    readOnly,
    editingPending,
    savePending
  );
  useEffect(() => {
    setSideMapPaneWidthDraft(null);
  }, [entityId, sourceSequence.id, seqView.mapPaneWidth]);
  const projectedView = useProjectedSequenceView({
    sourceSequence,
    sourcePlasmid,
    circular,
    coordinateSpace,
    seqView: comparisonMode ? { orientation: 'forward', originOffset: 0 } : seqView,
    sourcePrimers,
    sourceBackboneSegments,
    sourceScrollToPosition: sourceScrollToPositionProp,
    sourceHighlightRange: sourceHighlightRangeProp,
    sourceInternalCutSiteMarkers,
    sourceMutations,
    sourceRulerDecorations,
    sourceCandidateOrf,
    sourceForcedSelectedAnnotation,
  });
  const initialStackedMapPaneHeight = useMemo(
    () =>
      suggestedStackedMapPaneHeight({
        viewportHeight: surfaceLayoutHeight,
        sequenceLength: sourcePlasmid.length,
        circular: sourcePlasmid.circular,
        features: sourcePlasmid.features,
        primers: sourcePlasmid.primers.length,
      }),
    [surfaceLayoutHeight, sourcePlasmid]
  );

  const {
    projection: sequenceViewProjection,
    isTransformed: isSequenceViewTransformed,
    sourceSequenceLength,
    sequence,
    plasmid,
    primers,
    scrollToPosition: scrollToPositionProp,
    highlightRange: highlightRangeProp,
    backboneSegments,
    internalCutSiteMarkers,
    mutations,
    rulerDecorations,
    candidateOrf,
    forcedSelectedAnnotation,
    toSource: sequenceViewToSource,
    copyOrientation: sequenceViewCopyOrientation,
    originOffsetForViewPosition,
  } = projectedView;
  const mapEditCursorPosition =
    sourceMapEditCursorPosition === undefined
      ? undefined
      : (projectedView.toView.position(sourceMapEditCursorPosition) ?? undefined);
  const zoomScale = Math.max(MIN_SEQUENCE_ZOOM, Math.min(MAX_SEQUENCE_ZOOM, zoomLevel)) / 100;
  const scaledViewerMetrics = {
    charWidth: DEFAULT_EDITOR_CONFIG.charWidth * zoomScale,
    fontSize: DEFAULT_EDITOR_CONFIG.fontSize * zoomScale,
    rowHeight: DEFAULT_EDITOR_CONFIG.rowHeight * zoomScale,
  };
  const viewerLodLevel = deriveSequenceLodLevel(scaledViewerMetrics);
  const isDetailLod = viewerLodLevel === 'detail';
  const isOverviewLod = viewerLodLevel === 'density';
  const [aaColorScheme, setAAColorScheme] = useState('rasmol');
  const [localIsEnzymePanelOpen, setLocalIsEnzymePanelOpen] = useState(false);
  const [localRestrictionEnzymeDrawerWidth, setLocalRestrictionEnzymeDrawerWidth] = useState(
    DEFAULT_RESTRICTION_ENZYME_DRAWER_WIDTH
  );
  const isEnzymePanelControlled = isRestrictionEnzymeDrawerOpen !== undefined;
  const isEnzymePanelOpen = workspaceViewerOrLocal(
    isRestrictionEnzymeDrawerOpen,
    localIsEnzymePanelOpen
  );
  const setEnzymePanelOpen = useCallback(
    (open: boolean) => {
      if (isEnzymePanelControlled) {
        onRestrictionEnzymeDrawerOpenChange?.(open);
      } else {
        setLocalIsEnzymePanelOpen(open);
      }
    },
    [isEnzymePanelControlled, onRestrictionEnzymeDrawerOpenChange]
  );
  const visibleRestrictionEnzymeDrawerWidth = workspaceViewerOrLocal(
    restrictionEnzymeDrawerWidth,
    localRestrictionEnzymeDrawerWidth
  );
  const handleRestrictionEnzymeDrawerWidthChange = useCallback(
    (width: number) => {
      const clamped = clampRestrictionEnzymeDrawerWidth(width);
      if (onRestrictionEnzymeDrawerWidthChange) {
        onRestrictionEnzymeDrawerWidthChange(clamped);
      } else {
        setLocalRestrictionEnzymeDrawerWidth(clamped);
      }
    },
    [onRestrictionEnzymeDrawerWidthChange]
  );
  const hasSangerTrace = useSequenceHasSangerTrace(sourceSequence);
  const sharedReadViewerActive =
    !isEditMode &&
    ((surface === 'sequence' && hasSangerTrace) ||
      coordinateSpace?.mode === 'gapped' ||
      Boolean(comparison));
  const sequenceViewMode: SequenceViewMode = sharedReadViewerActive ? 'tracks' : seqView.canvasMode;
  const minimumSequencePaneHeight = sharedReadViewerActive
    ? 280
    : MIN_VERTICAL_SEQUENCE_PANE_HEIGHT;
  const effectiveMapShape = effectiveSequenceMapShape(seqView, { circular });
  const {
    emptySequenceEditing,
    sequenceSurfaceVisible,
    mapSurfaceVisible,
    mapOnlyVisible,
    mapPlacedBeforeSequence,
    mapTopologyCircular,
    isFeatureOrDetailLod,
  } = workspaceViewerSurfaceFlags({
    isEditMode,
    sourceSequenceLength: sequence.length,
    sequenceSurfaceVisibleFromView: comparisonMode || isSequenceSurfaceVisible(seqView),
    mapVisibleFromView: !comparisonMode && isMapSurfaceVisible(seqView),
    rendererVisibility: seqView.rendererVisibility,
    mapPlacement: seqView.mapPlacement,
    circular,
    effectiveMapShape,
    viewerLodLevel,
  });
  const previousMapSurfaceVisibleRef = useRef(mapSurfaceVisible);
  const [, forceMapCollapseReleaseFrame] = useState(0);
  const holdMapCollapseForThisRender = workspaceViewerMapCollapseHold(
    previousMapSurfaceVisibleRef.current,
    mapSurfaceVisible,
    sequenceSurfaceVisible
  );
  const renderMapSurfaceVisible = workspaceViewerRenderMapSurfaceVisible(
    mapSurfaceVisible,
    holdMapCollapseForThisRender
  );
  const previousEffectiveMapShapeRef = useRef(effectiveMapShape);
  const {
    sequenceViewportScopeKey,
    residueSelectionReferenceId,
    commandEntityId,
    cutSitesScopeKey,
  } = workspaceViewerEntityKeys(entityId, sequence.id, plasmid.name);
  const activeMapLayout = mapLayoutForPlacement(seqView.mapPlacement);
  const mapPlacement = seqView.mapPlacement;
  const {
    webglCameraZoom,
    webglCameraZoomBounds,
    webglCameraZoomSource,
    commitWebglCameraZoomState,
    scheduleWebglCameraZoomStateSync,
    updateWebglCameraZoomBounds,
  } = useWebglCameraZoomState({
    minimapRef,
    persistedZoom: seqView.webglZoom ?? undefined,
    viewportScopeKey: sequenceViewportScopeKey,
    rendererReadyEpoch: webglRendererReadyEpoch,
  });

  useLayoutEffect(() => {
    previousMapSurfaceVisibleRef.current = mapSurfaceVisible;
    if (holdMapCollapseForThisRender) {
      const frameId = requestAnimationFrame(() =>
        forceMapCollapseReleaseFrame((frame) => frame + 1)
      );
      return () => cancelAnimationFrame(frameId);
    }
    return undefined;
  }, [holdMapCollapseForThisRender, mapSurfaceVisible]);

  useLayoutEffect(() => {
    if (!mapOnlyVisible || !renderMapSurfaceVisible) return;
    const el = minimapContainerRef.current;
    if (!el) return;
    const width = el.clientWidth;
    const height = el.clientHeight;
    if (width > 0 && Math.abs(width - minimapWidth) > 1) {
      setMinimapWidth(width);
    }
    if (height > 0 && Math.abs(height - minimapContainerHeight) > 1) {
      setMinimapContainerHeight(height);
    }
  }, [mapOnlyVisible, minimapContainerHeight, minimapWidth, renderMapSurfaceVisible]);

  const sequenceViewModeRef = useRef(sequenceViewMode);
  sequenceViewModeRef.current = sequenceViewMode;
  const isEditModeRef = useRef(false);
  const setSequenceViewMode = useCallback(
    (next: SequenceViewMode) => {
      patchSeqView({ canvasMode: next });
    },
    [patchSeqView]
  );
  const setRendererVisibility = useCallback(
    (next: SequenceRendererVisibility) => {
      patchSeqView({ rendererVisibility: next });
    },
    [patchSeqView]
  );
  const setMapPlacement = useCallback(
    (next: SequenceMapPlacement) => {
      if (next !== mapPlacement) circularBufferHeightFreezeRef.current = 0;
      patchSeqView({ mapPlacement: next, mapLayout: mapLayoutForPlacement(next) });
    },
    [mapPlacement, patchSeqView]
  );
  const setMapShape = useCallback(
    (next: SequenceMapShape) => {
      patchSeqView({ mapShape: next });
    },
    [patchSeqView]
  );

  const [hoveredEnzymeName, setHoveredEnzymeName] = useState<string | null>(null);
  const [hoveredPositionInfo, setHoveredPositionInfo] = useState<{
    enzymeName: string;
    position: number;
    recognitionStart: number;
    recognitionEnd: number;
  } | null>(null);

  const {
    minMinimapHeight: MIN_MINIMAP_PANE,
    minMinimapGeometryHeight: MIN_MINIMAP_GEOMETRY,
    maxMinimapHeight: MAX_MINIMAP,
    minimapHeight,
    minimapGeometryHeight,
    effectiveMorphToCircle,
    sequenceContainerRef,
    minimapRawSizingRef,
    morphToCircleRef,
    handleMorphToCircleChangeRef,
    handleMorphToCircleChange,
    handleMinimapGeometryHeightChange,
    handleMinimapPaneHeightChange,
    setMinimapHeights,
  } = useSequenceMinimapSizing({
    sequenceViewportScopeKey,
    seqView: {
      minimapHeight: seqView.minimapHeight,
      minimapGeometryHeight: seqView.minimapGeometryHeight,
      webglMorph: seqView.webglMorph,
    },
    patchSeqView,
    defaultMinimapHeight: initialStackedMapPaneHeight,
    defaultMinimapGeometryHeight: activeMapLayout === 'vertical' ? 280 : 420,
    maxPaneHeight:
      sharedReadViewerActive &&
      sequenceSurfaceVisible &&
      renderMapSurfaceVisible &&
      activeMapLayout === 'vertical' &&
      surfaceLayoutHeight > 0
        ? surfaceLayoutHeight - minimumSequencePaneHeight - 4
        : undefined,
  });

  const isWebglSyncLocked = seqView.scrollSynced;
  const webglPerformancePreference = useWebGLPerformancePreference();

  const sequenceViewerRef = useRef<WorkspaceEditorHandle | null>(null);
  const {
    selection,
    selectionSource: comparisonSelectionSource,
    setSelectionSource: setComparisonSelectionSource,
    viewCursor,
    highlightedRange,
    selectedAnnotation,
    setSelectedAnnotation,
    setViewCursor,
    setHighlightedRange,
    clearSequenceSelection,
    handleSequenceHighlightedRangeChange,
    handleSequenceHighlightedRangePreview,
    selectionPreviewStore,
  } = useSequenceSelectionState({
    entityId,
    selectionSourceIdentity: comparison?.id,
    sequenceViewToSource,
    minimapRef,
    onSelectionChange,
    onCursorChange,
    onSelectionStateChange,
  });
  useEffect(() => {
    if (columnNavigation?.selection) {
      setHighlightedRange(columnNavigation.biologicalSelection ?? null);
      setViewCursor(null);
      setSelectedAnnotation(null);
    }
  }, [columnNavigation, setHighlightedRange, setViewCursor, setSelectedAnnotation]);
  const comparisonMolecule = comparison?.[comparisonSelectionSource];
  const comparisonAnnotations = useMemo(
    () => [...(comparison?.sourceAnnotations?.[comparisonSelectionSource] ?? [])],
    [comparison?.sourceAnnotations, comparisonSelectionSource]
  );

  const handleWebglMapKeyDown = useWebglMapKeyboardNavigation({
    sequenceLength: sequence.length,
    circular,
    selection,
    editCursorPosition: mapEditCursorPosition,
    onEditKeyDown: onMapKeyDown,
    onCursorNavigate: (navigation) => {
      const position = sequenceViewToSource.position(navigation.position);
      if (position !== null) onMapCursorNavigate?.({ ...navigation, position });
    },
    setViewCursor,
    setHighlightedRange,
  });

  const cancelWebglCameraRestoreRef = useRef<(() => void) | null>(null);

  const navigateMapToPosition = useCallback(
    (position: number, range: { start: number; end: number; wraps?: boolean } | null) => {
      cancelWebglCameraRestoreRef.current?.();
      if (!mapSurfaceVisible) return;
      const centerBp = navigationCenterBpFromRangeOrPosition({ position, range }, sequence.length);
      if (centerBp == null) return;
      const zoomBounds = resolveWebglMapZoomBounds(minimapRef.current?.getCameraZoomBounds?.());
      const navigationZoom =
        resolveMapOnlyRangeFitZoom({
          mapVisible: mapSurfaceVisible,
          sequenceVisible: sequenceSurfaceVisible,
          sequenceLength: sequence.length,
          range,
          zoomBounds,
        }) ??
        resolveMapOnlyNucleotideZoom({
          mapVisible: mapSurfaceVisible,
          sequenceVisible: sequenceSurfaceVisible,
          zoomBounds,
        });
      if (navigationZoom != null) {
        const zoom = clampWebglMapZoom(navigationZoom, zoomBounds);
        commitWebglCameraZoomState(zoom);
        minimapRef.current?.setZoom?.(zoom);
        patchSeqView({ webglZoom: zoom, webglCenterBp: centerBp }, { debounce: true });
      }
      minimapRef.current?.setViewCenter?.(centerBp - 1);
    },
    [
      commitWebglCameraZoomState,
      mapSurfaceVisible,
      patchSeqView,
      sequence.length,
      sequenceSurfaceVisible,
    ]
  );

  const {
    scrollToPosition,
    scrollCommandId,
    scrollCommandRequestId,
    scrollAnimate,
    scrollPresentation,
    scrollToPositionWithTimeout,
    scrollToPositionWithTimeoutRef,
    onScrollToPositionComplete,
    scrollActiveSequenceViewerToBiologicalPosition,
    lastSequenceNavigationRef,
  } = useSequenceScrollNavigation({
    sequenceViewModeRef,
    sequenceViewerRef,
    sequenceAnnotations: sequence.annotations,
    sequenceSurfaceVisible,
    scrollToPositionProp,
    sequenceNavigationRequestId,
    highlightRangeProp,
    onScrollComplete,
    onHighlightComplete,
    navigateMapToPosition,
    setHighlightedRange,
    setViewCursor,
    setSelectedAnnotation,
  });

  const {
    handleWebglMapFeatureSelect,
    handleWebglMapSelectionChange,
    handleWebglMapSelectionPreview,
    handleWebglMapSelectionStart,
    handleWebglMapPositionClick,
    handleWebglMapPositionDoubleClick,
    handleWebglMapPrimerClick,
    handleWebglMapPrimerPbsEndpointPreview,
    handleWebglMapPrimerPbsEndpointCommit,
    handleWebglMapCrossoverBoundaryCommit,
  } = useWebglMapInteractions({
    sequenceViewerRef,
    onSelectionPreview: selectionPreviewStore.set,
    clearSelection: clearSequenceSelection,
    setHighlightedRange,
    setViewCursor,
    setSelectedAnnotation,
    scrollToBiologicalPosition: scrollActiveSequenceViewerToBiologicalPosition,
    genomeLength: plasmid.length,
    circular,
    onPositionClick: (position) => {
      const sourcePosition = sequenceViewToSource.position(position);
      if (sourcePosition !== null) onMapPositionClick?.(sourcePosition);
    },
    onPrimerPbsLengthPreview: onMapPrimerPbsLengthPreview
      ? (primer, length) => {
          const preview = onMapPrimerPbsLengthPreview(
            projectPrimerRangeToSource(primer, sequenceViewProjection),
            length
          );
          return preview ? projectPrimerRangeToView(preview, sequenceViewProjection) : null;
        }
      : undefined,
    onPrimerPbsLengthCommit: onMapPrimerPbsLengthCommit
      ? (primer, length) => {
          const committed = onMapPrimerPbsLengthCommit(
            projectPrimerRangeToSource(primer, sequenceViewProjection),
            length
          );
          return committed ? projectPrimerRangeToView(committed, sequenceViewProjection) : null;
        }
      : undefined,
    onMapCrossoverBoundaryCommit,
  });

  useEffect(() => {
    debugLog('[WorkspaceViewer] scrollToPosition state:', scrollToPosition);
  }, [scrollToPosition]);

  const {
    contextMenu,
    effectiveCDS,
    effectiveStructureFeature,
    previewCDS,
    handleContextMenu,
    handleWebglMapContextMenu,
    handlePreviewCDS,
    handleContextMenuClose,
  } = useSequenceContextMenuState({
    annotations: comparison ? comparisonAnnotations : sequence.annotations,
    sequenceLength: comparisonMolecule?.length ?? sequence.length,
    primers: comparison ? [] : primers,
    highlightedRange,
    setHighlightedRange,
    setViewCursor,
    setSelectedAnnotation,
  });
  useEffect(() => {
    if (!pendingComparisonMenu) return;
    handleContextMenu(
      { clientX: pendingComparisonMenu.x, clientY: pendingComparisonMenu.y, preventDefault() {} },
      pendingComparisonMenu.range,
      { isOnNucleotideRow: true, position: pendingComparisonMenu.position, annotation: null }
    );
    setPendingComparisonMenu(null);
  }, [pendingComparisonMenu, handleContextMenu]);

  const setSequenceEditModeActive = useSequenceEditModeStore((s) => s.setActive);
  const editRequest = useSequenceEditModeStore((s) => s.editRequest);
  const consumeEditRequest = useSequenceEditModeStore((s) => s.consumeEditRequest);
  useEffect(() => {
    isEditModeRef.current = isEditMode;
  }, [isEditMode]);
  useEffect(() => {
    setSequenceEditModeActive(isEditMode);
    return () => setSequenceEditModeActive(false);
  }, [isEditMode, setSequenceEditModeActive]);
  useEffect(() => {
    onEditModeChange?.(isEditMode);
    return () => onEditModeChange?.(false);
  }, [isEditMode, onEditModeChange]);

  useLayoutEffect(() => {
    if (!sequenceSurfaceVisible || sequenceViewMode !== '2d') {
      setSequenceLayoutViewportHeight(0);
      return;
    }

    const sequencePane = sequenceContainerRef.current;
    const column = sequencePane?.parentElement;
    if (!sequencePane || !column) return;

    let frameId: number | null = null;
    let lastHeight = 0;
    const measure = () => {
      if (mapPaneResizePreviewActiveRef.current) return;
      const sequenceRect = sequencePane.getBoundingClientRect();
      const columnRect = column.getBoundingClientRect();
      const paneHeight = resolveSequencePaneViewportHeight({
        sequencePaneHeight: sequenceRect.height,
      });
      const columnSpanHeight = Math.max(0, Math.round(columnRect.bottom - sequenceRect.top));
      if (columnSpanHeight > 0) {
        circularBufferHeightFreezeRef.current = resolveCircularBufferHeightHighWater({
          liveHeight: columnSpanHeight,
          highWater: circularBufferHeightFreezeRef.current,
        });
      }
      if (Math.abs(paneHeight - lastHeight) <= 1) return;
      lastHeight = paneHeight;
      setSequenceLayoutViewportHeight(paneHeight);
    };
    const scheduleMeasure = () => {
      if (frameId !== null) return;
      frameId = requestAnimationFrame(() => {
        frameId = null;
        measure();
      });
    };

    const resizeObserver = new ResizeObserver(scheduleMeasure);
    resizeObserver.observe(column);
    resizeObserver.observe(sequencePane);
    measure();
    window.addEventListener('resize', scheduleMeasure);

    return () => {
      if (frameId !== null) cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      window.removeEventListener('resize', scheduleMeasure);
    };
  }, [sequenceViewMode, sequenceSurfaceVisible, isEditMode]);

  const prevSequenceViewModeRef = useRef(sequenceViewMode);
  const frozenCenterForToggleRef = useRef<number | null>(null);
  useEffect(() => {
    if (prevSequenceViewModeRef.current === sequenceViewMode) return;
    prevSequenceViewModeRef.current = sequenceViewMode;

    if (sequenceViewMode === 'tracks' && isEditModeRef.current) {
      patchSeqView({ canvasMode: '2d' });
      return;
    }

    const center = frozenCenterForToggleRef.current;
    frozenCenterForToggleRef.current = null;
    if (center != null) {
      setTimeout(() => {
        scrollToPositionWithTimeoutRef.current?.(center, undefined, {
          animate: false,
          completion: 'viewer',
        });
      }, 0);
    }
  }, [sequenceViewMode, patchSeqView]);
  const [editInitialCursor, setEditInitialCursor] = useState<number | undefined>(undefined);
  const [editInitialSelection, setEditInitialSelection] = useState<{
    start: number;
    end: number;
    wraps?: boolean;
  } | null>(null);
  const canEditSequence =
    !editingPending && workspaceViewerCanEditSequence(readOnly, editorSession, onEditCommitProp);
  const ownerDraft = useEditorSessionState(unlessFlag(readOnly, editorSession));
  const liveSequence = workspaceViewerLiveSequence(isEditMode, ownerDraft, sequence.sequence);
  const liveAnnotations = workspaceViewerLiveAnnotations(
    isEditMode,
    ownerDraft,
    sequence.annotations
  );
  const emptySequenceEntryVisible = workspaceViewerEmptySequenceEntryVisible(
    emptySequenceEditing,
    liveSequence
  );

  const enterEditMode = useCallback(
    (cursor?: number) => {
      if (!canEditSequence) return;
      setEditInitialCursor(cursor);
      setEditInitialSelection(highlightedRange);
      setSequenceViewMode('2d');
      setIsEditMode(true);
    },
    [canEditSequence, highlightedRange, setSequenceViewMode]
  );

  useEffect(() => {
    if (!editRequest || editRequest.entityId !== entityId) return;
    enterEditMode();
    consumeEditRequest(editRequest.requestId);
  }, [consumeEditRequest, editRequest, enterEditMode, entityId]);

  const handleEditCommit = useCallback(async () => {
    if (readOnly) {
      setIsEditMode(false);
      return;
    }
    const savedSequenceWillBeEmpty = sourceSequence.sequence.length === 0;
    const saved = await onEditCommitProp?.();
    if (saved === false) return;
    if (savedSequenceWillBeEmpty) {
      setSequenceViewMode('2d');
      setIsEditMode(true);
      return;
    }
    setIsEditMode(false);
  }, [onEditCommitProp, readOnly, setSequenceViewMode, sourceSequence.sequence]);

  const handleEditDiscard = useCallback(() => {
    onEditDiscard?.();
    setIsEditMode(false);
  }, [onEditDiscard]);

  const documentGeneticCodeResolution = useMemo(
    () => resolveSequenceGeneticCode(sourceSequence),
    [sourceSequence]
  );
  const documentGeneticCode = documentGeneticCodeResolution.code;
  const search = useSequenceSearch({
    sequence: liveSequence,
    annotations: liveAnnotations,
    sequenceGeneticCode: documentGeneticCode,
    geneticCodeBasis: documentGeneticCodeResolution.basis,
    nucleicAcid: nucleicAcidOf(sourceSequence),
    circular,
    onSearchStart: observeSequenceSearch,
  });
  const searchErrorMessage: UserMessage | null = search.errorMessage;
  const selectionProjection = useMemo(
    () =>
      projectSequenceSelectionFromInput({
        localCursor: viewCursor,
        localRange: highlightedRange,
        localSelectedAnnotation: forcedSelectedAnnotation ?? selectedAnnotation,
        activeSearchRange: search.activeHighlightRange,
        activeSearchMatch: search.activeHighlightRange
          ? (search.matches[search.activeIndex] ?? null)
          : null,
      }),
    [
      viewCursor,
      highlightedRange,
      forcedSelectedAnnotation?.type,
      forcedSelectedAnnotation?.name,
      forcedSelectedAnnotation?.start,
      forcedSelectedAnnotation?.end,
      forcedSelectedAnnotation?.direction,
      selectedAnnotation?.type,
      selectedAnnotation?.name,
      selectedAnnotation?.start,
      selectedAnnotation?.end,
      selectedAnnotation?.direction,
      search.activeHighlightRange,
      search.matches,
      search.activeIndex,
    ]
  );
  const activeVisibleHighlightRange = selectionProjection.canvas.highlightedRange;
  const selectedAnnotationForCanvas = selectionProjection.canvas.selectedAnnotation;
  const selectedAnnotationForOneD = selectionProjection.oneD.selectedAnnotation;
  const selectedAnnotationForMinimap = selectionProjection.minimap.selectedAnnotation;
  const selectedAnnotationIds1D = useMemo(
    () =>
      selectionProjection.oneD.selectedAnnotationId
        ? new Set([selectionProjection.oneD.selectedAnnotationId])
        : undefined,
    [selectionProjection.oneD.selectedAnnotationId]
  );
  const handleSelectedAnnotationChange = useCallback(
    (annotation: AnnotationStateIdentity | null) => {
      search.releaseActiveHighlight();
      setSelectedAnnotation((prev) =>
        annotationIdentityEqual(prev, annotation) ? prev : annotation
      );
      if (annotation) onActivateAnnotation?.(sequenceViewToSource.annotationIdentity(annotation));
    },
    [search, onActivateAnnotation, sequenceViewToSource]
  );

  useEffect(() => {
    onSelectedAnnotationChange?.(
      selectedAnnotation ? sequenceViewToSource.annotationIdentity(selectedAnnotation) : null
    );
  }, [selectedAnnotation, onSelectedAnnotationChange, sequenceViewToSource]);

  const isGapped = coordinateSpace?.mode === 'gapped';
  const inAlignmentMode = isInAlignmentMode(coordinateSpace);
  const { viewerCommandIsActive, sequenceCommandIsActive, sequenceScope } =
    useWorkspaceViewerFindCommands({
      surface,
      commandEntityId,
      isGapped,
      search,
    });

  const cancelFindNavigationRef = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    return () => {
      cancelFindNavigationRef.current?.();
      cancelFindNavigationRef.current = null;
    };
  }, [
    search.query,
    search.mode,
    search.isOpen,
    liveSequence,
    liveAnnotations,
    circular,
    sequenceViewMode,
    sequenceSurfaceVisible,
  ]);

  const navigateViewportToPosition = useCallback(
    (request: NonNullable<typeof search.navigationRequest>) => {
      cancelFindNavigationRef.current?.();
      cancelFindNavigationRef.current = null;
      if (sequenceSurfaceVisible) {
        const presentationMode = sequenceViewModeRef.current;
        const surface = presentationMode === 'tracks' ? 'sequence_tracks' : 'sequence_canvas';
        const observation = sharedReadViewerActive ? undefined : request.observe();
        const cancelScroll = scrollToPositionWithTimeout(request.position, undefined, {
          presentationMode,
          onPresented: observation ? () => observation.presented(surface) : undefined,
        });
        cancelFindNavigationRef.current = () => {
          cancelScroll();
          observation?.cancel();
        };
      }
      navigateMapToPosition(request.position, request.range);
    },
    [
      scrollToPositionWithTimeout,
      navigateMapToPosition,
      sharedReadViewerActive,
      sequenceSurfaceVisible,
    ]
  );

  const dispatchedFindNavigationRef = useRef(search.navigationRequest);
  useEffect(() => {
    const request = search.navigationRequest;
    if (
      !request ||
      request === dispatchedFindNavigationRef.current ||
      (!sequenceSurfaceVisible && !mapSurfaceVisible)
    )
      return;
    dispatchedFindNavigationRef.current = request;
    navigateViewportToPosition(request);
  }, [
    search.navigationRequest,
    sequenceSurfaceVisible,
    mapSurfaceVisible,
    navigateViewportToPosition,
  ]);

  useEffect(() => {
    if (!comparison || !search.isOpen) return;
    setComparisonSelectionSource('after');
    setHighlightedRange(null);
    handleContextMenuClose();
  }, [comparison?.id, search.isOpen, setHighlightedRange, handleContextMenuClose]);
  const handleSearchActivateMatch = useCallback(
    (idx: number) => {
      search.goToMatch(idx);
      const match = search.matches[idx] ?? null;
      const annotation = annotationIdentityFromSearchMatch(match);
      if (annotation) {
        setHighlightedRange(null);
        setViewCursor(null);
        handleSelectedAnnotationChange(annotation);
      } else {
        search.releaseActiveHighlight();
      }
    },
    [search, handleSelectedAnnotationChange, setHighlightedRange, setViewCursor]
  );

  const collapseDigestPanel = useCallback(() => {
    setViewState({ digestPanelExpanded: false });
  }, [setViewState]);
  const consumeCutSiteDisplayRequest = useCallback(
    (id: string) => {
      if (viewState?.cutSiteDisplayRequest?.id === id) {
        setViewState({ cutSiteDisplayRequest: null });
      }
    },
    [viewState?.cutSiteDisplayRequest?.id, setViewState]
  );
  const {
    cutSitesState,
    cutSitesActions,
    webglCutSites,
    twoDInternalCutSites,
    twoDCutSites,
    handleCutSiteDoubleClick,
  } = useSequenceCutSitesView({
    sequenceText: sequence.sequence,
    circular,
    scopeKey: cutSitesScopeKey,
    displayRequest: viewState?.cutSiteDisplayRequest,
    onDisplayRequestApplied: consumeCutSiteDisplayRequest,
    catalogSummaryEnabled: isEnzymePanelOpen,
    isFeatureOrDetailLod,
    internalCutSiteMarkers,
    isDigestPanelExpanded: viewState?.digestPanelExpanded === true,
    collapseDigestPanel,
    setEnzymePanelOpen,
    setHoveredEnzymeName,
  });
  const enzymeColorSyncRefs = useRef({ cutSitesState, webglCutSites, cutSitesActions });
  enzymeColorSyncRefs.current = { cutSitesState, webglCutSites, cutSitesActions };
  useEffect(() => {
    if (!entityId) return;
    const w = window as Window & {
      __test?: {
        enzymeColorSync?: Record<
          string,
          {
            getAvailableEnzymeCount: () => number;
            activate: (names: string[]) => number;
            getReport: () => {
              scanPhase: string;
              twoD: Record<string, string | undefined>;
              webgl: Record<string, string | undefined>;
            };
          }
        >;
      };
    };
    if (!w.__test) return;
    if (!w.__test.enzymeColorSync) w.__test.enzymeColorSync = {};

    const activeColorByEnzyme = (
      sites: ReadonlyArray<{
        enzyme?: { name?: string };
        color?: string;
        isPreview?: boolean;
        isInternalCutSite?: boolean;
      }>
    ): Record<string, string | undefined> => {
      const map: Record<string, string | undefined> = {};
      for (const s of sites) {
        if (s.isPreview || s.isInternalCutSite) continue;
        const name = s.enzyme?.name;
        if (name && !(name in map)) map[name] = s.color;
      }
      return map;
    };

    w.__test.enzymeColorSync[entityId] = {
      getAvailableEnzymeCount: () =>
        enzymeColorSyncRefs.current.cutSitesState.availableEnzymes.length,
      activate: (names: string[]) => {
        const { cutSitesState: cs, cutSitesActions: actions } = enzymeColorSyncRefs.current;
        let added = 0;
        for (const name of names) {
          const enzyme = cs.availableEnzymes.find((e) => e.name === name);
          if (enzyme) {
            actions.addEnzyme(enzyme);
            added += 1;
          }
        }
        return added;
      },
      getReport: () => {
        const { cutSitesState: cs, webglCutSites: webgl } = enzymeColorSyncRefs.current;
        return {
          scanPhase: cs.scanPhase,
          twoD: activeColorByEnzyme(cs.cutSites),
          webgl: activeColorByEnzyme(webgl),
        };
      },
    };

    return () => {
      delete w.__test?.enzymeColorSync?.[entityId];
    };
  }, [entityId]);
  const {
    viewerConfig,
    editorConfig,
    handleConfigChange: persistConfigChange,
  } = useSequenceViewerConfig({
    seqView: liveSeqView,
    patchSeqView,
    cutSitesVisible: cutSitesState.isVisible,
    toggleCutSitesVisibility: cutSitesActions.toggleVisibility,
    viewerLodLevel,
    isDetailLod,
    isOverviewLod,
    hideReverseComplement,
    aaColorScheme,
    scaledViewerMetrics,
  });
  const handleConfigChange = useCallback(
    (next: ViewerConfig) => {
      setLiveZoom(null);
      persistConfigChange(next);
    },
    [persistConfigChange]
  );
  const handleZoomLevelChange = useCallback(
    (next: number) => {
      setLiveZoom((current) =>
        current?.key === tabStateKey && current.value === next
          ? current
          : { key: tabStateKey, value: next }
      );
      patchSeqView({ zoom: next }, { debounce: true, debounceMs: 300 });
    },
    [patchSeqView, tabStateKey]
  );
  useEffect(() => {
    if (liveZoom?.key === tabStateKey && seqView.zoom === liveZoom.value) setLiveZoom(null);
  }, [liveZoom, seqView.zoom, tabStateKey]);
  const actualWebGLMapVisible = workspaceViewerActualWebGLMapVisible(
    renderMapSurfaceVisible,
    hideMinimap
  );
  const mapCameraZoomVisible = actualWebGLMapVisible;
  const genomicMarkup = useSequenceDataLayers({
    documentId: entityId,
    sequence: sourceSequence,
    dataLayerSourceSequence,
    selection: seqView.dataLayerSelection,
    onSelectionChange: (selection) => patchSeqView({ dataLayerSelection: selection }),
    signalsSupported: !sharedReadViewerActive && !isSequenceViewTransformed && !mapTopologyCircular,
    enabled: surface === 'sequence' && !sharedReadViewerActive,
  });
  const annotationCatalog = useSequenceMapAnnotationCatalog({
    entityId: tabStateKey,
    document: sourceSequence,
    viewTransformed: isSequenceViewTransformed,
    mapRef: minimapRef,
    rendererReadyEpoch: webglRendererReadyEpoch,
    mapCircular: mapTopologyCircular,
    layout: seqView.annotationCatalogLayout,
    supplementalTracks: genomicMarkup.tracks,
  });
  const mapTracksOwnerId =
    annotationCatalog?.ownerTabId ??
    (genomicMarkup.trackControls.rows.length > 0 || genomicMarkup.trackControls.errors.length > 0
      ? genomicMarkup.ownerTabId
      : undefined);

  useEffect(() => {
    const previousShape = previousEffectiveMapShapeRef.current;
    previousEffectiveMapShapeRef.current = effectiveMapShape;
    if (
      !actualWebGLMapVisible ||
      !circular ||
      previousShape === effectiveMapShape ||
      effectiveMapShape !== 'linear'
    ) {
      return undefined;
    }

    const centerBp = Math.max(0, Math.floor((sequence.length - 1) / 2));
    const centerBio = centerBp + 1;
    patchSeqView({ webglCenterBp: centerBio });

    let canceled = false;
    let rafId = 0;
    let attempts = 0;
    const centerLinearRenderer = () => {
      if (canceled) return;
      minimapRef.current?.setViewCenter?.(centerBp);
      attempts += 1;
      if (attempts < 8) rafId = requestAnimationFrame(centerLinearRenderer);
    };
    rafId = requestAnimationFrame(centerLinearRenderer);

    return () => {
      canceled = true;
      cancelAnimationFrame(rafId);
    };
  }, [actualWebGLMapVisible, circular, effectiveMapShape, patchSeqView, sequence.length]);

  const orfDocumentVisible = useSyncExternalStore(
    subscribeOrfDocumentVisibility,
    orfDocumentIsVisible,
    () => false
  );
  const orfState = useORFs(sequence.sequence, documentGeneticCode, {
    observeDetection: observeOrfDetection,
    observationVisible:
      orfDocumentVisible &&
      viewerCommandIsActive &&
      ((sequenceSurfaceVisible && !sharedReadViewerActive) || actualWebGLMapVisible),
  });

  const visibleORFs = whenFlag(orfState.isVisible, orfState.detectedORFs);
  const webglORFs = whenFlag(orfState.isVisible, orfState.detectedORFs);

  const handleDigestFragmentSelect = useCallback(
    (range: SelectionRange, scrollTarget: number) => {
      setHighlightedRange(range);
      scrollToPositionWithTimeout(scrollTarget);
    },
    [scrollToPositionWithTimeout, setHighlightedRange]
  );

  const {
    activeVirtualDigestEnzyme,
    activeVirtualDigestEnzymeNames,
    activeVirtualDigestLabel,
    expandedSection,
    virtualDigestResult,
    virtualDigestError,
    hoveredDigestFragment,
    mergedBackboneSegments,
    digestFocusRange,
    handleVirtualDigest,
    handleClearVirtualDigest,
    handleDigestFragmentHover,
    handleDigestFragmentClick,
    handleEnzymesCollapsedChange,
    handleDigestCollapsedChange,
  } = useVirtualDigestView({
    ownerKey: tabStateKey,
    sourceIdentity: workspaceViewerFallbackName(plasmid.name, 'unknown'),
    viewState,
    setViewState,
    cutSitesState,
    sequence,
    backboneSegments,
    selectedRange: highlightedRange,
    onFragmentSelect: handleDigestFragmentSelect,
  });
  const handleAssemblyScaffoldSelect = useCallback(
    (regionId: string) => {
      const segment = mergedBackboneSegments?.find(
        (candidate) => candidate.regionId === regionId && candidate.scaffold
      );
      if (!segment) return;
      onMapPartSelect?.({
        regionId,
        rangeStart: segment.start,
        rangeEnd: segment.end,
        isScaffold: true,
      });
    },
    [mergedBackboneSegments, onMapPartSelect]
  );

  const {
    lastViewportCenterRef,
    syncViewportTarget,
    handleWebglMapCameraChange: handleWebglMapCameraChangeFromSync,
    handleViewportChange,
    cancelWebglCameraRestore,
  } = useSequenceViewportSync({
    sequenceLength: sequence.sequence.length,
    sequenceViewportScopeKey,
    circular,
    coordinateSpace,
    seqView: {
      centerBp: seqView.centerBp,
      webglZoom: seqView.webglZoom,
      webglCenterBp: seqView.webglCenterBp,
    },
    patchSeqView,
    minimapRef,
    webglEnabled: actualWebGLMapVisible,
    webglRendererReadyEpoch,
    isWebglSyncLocked,
    scrollToPositionWithTimeoutRef,
    scrollActiveSequenceViewerToBiologicalPosition,
    morphToCircleRef,
    handleMorphToCircleChangeRef,
    minimapRawSizingRef,
    setMinimapHeights,
    lastSequenceNavigationRef,
    paneLayout: {
      rendererVisibility: seqView.rendererVisibility,
      mapPlacement: seqView.mapPlacement,
    },
    focusedPaneRef,
  });
  cancelWebglCameraRestoreRef.current = cancelWebglCameraRestore;

  const handlePaneInteractionCapture = useCallback(
    (event: { target: EventTarget | null; type: string }) => {
      if (!(event.target instanceof Element)) return;
      const pane = event.target.closest<HTMLElement>('[data-sequence-map-surface]')?.dataset
        .sequenceMapSurface;
      if (pane !== 'sequence' && pane !== 'map') return;
      focusedPaneRef.current = pane;
      if (event.type !== 'focus') cancelWebglCameraRestore();
    },
    [cancelWebglCameraRestore]
  );

  const handleWebglMapCameraChange = useCallback(
    (centerBp: number, reason: 'scroll' | 'zoom', zoom: number) => {
      if (reason === 'zoom' || webglCameraZoomSource.getSnapshot() !== zoom)
        scheduleWebglCameraZoomStateSync(zoom);
      handleWebglMapCameraChangeFromSync(centerBp, reason, zoom);
    },
    [handleWebglMapCameraChangeFromSync, scheduleWebglCameraZoomStateSync, webglCameraZoomSource]
  );

  const handleMapZoomChange = useCallback(
    (nextZoom: number) => {
      cancelWebglCameraRestore();
      const bounds = updateWebglCameraZoomBounds();
      const zoom = clampWebglMapZoom(nextZoom, bounds);
      commitWebglCameraZoomState(zoom);
      const map = minimapRef.current;
      map?.setZoom?.(zoom);
      patchSeqView({ webglZoom: zoom }, { debounce: true });
      const centerBp = map?.getCameraCenter?.();
      if (centerBp != null) handleWebglMapCameraChange(centerBp, 'zoom', zoom);
    },
    [
      cancelWebglCameraRestore,
      commitWebglCameraZoomState,
      handleWebglMapCameraChange,
      patchSeqView,
      updateWebglCameraZoomBounds,
    ]
  );

  const handleSequenceZoomChange = useCallback(
    (nextZoom: number) => {
      const minimum = sequenceViewMode === '2d' ? canvasMinZoom : MIN_SEQUENCE_ZOOM;
      const clamped = Math.max(minimum, Math.min(MAX_SEQUENCE_ZOOM, nextZoom));
      if (sequenceViewerRef.current?.zoomTo?.(clamped)) return;
      handleZoomLevelChange(clamped);
    },
    [canvasMinZoom, handleZoomLevelChange, sequenceViewMode]
  );

  frozenCenterForToggleRef.current = workspaceViewerMaybeFrozenCenter(
    prevSequenceViewModeRef.current,
    sequenceViewMode,
    lastViewportCenterRef.current,
    frozenCenterForToggleRef.current
  );

  const handleEnzymePanelToggle = useCallback(() => {
    setEnzymePanelOpen(!isEnzymePanelOpen);
  }, [isEnzymePanelOpen, setEnzymePanelOpen]);

  const displayPlasmid = useMemo(
    () => withAnnotationDisplayColorsForMinimap(plasmid, viewerConfig.annotationColorMode),
    [plasmid, viewerConfig.annotationColorMode]
  );
  const webglPlasmid = useMemo(
    () => withPrimerDisplaysForMinimap(displayPlasmid, primers),
    [displayPlasmid, primers]
  );

  const {
    stores: crossSurfaceStores,
    residueLinkRangeForWebGL,
    externalHoveredFeatureId,
    syncWebGLTarget,
    handleWebGLCodonHover,
    handleWebGLFeatureHover,
  } = useSequenceCrossSurfaceState({
    entityId,
    webglPlasmid,
    minimapRef,
    webglEnabled: actualWebGLMapVisible,
  });

  const activeCdsExtensionArrow = useSyncExternalStore(
    crossSurfaceStores.cdsExtensionHoverStore.subscribe,
    crossSurfaceStores.cdsExtensionHoverStore.getSnapshot
  );
  const annotationsWithPreview = useMemo(
    () =>
      annotationsWithCdsExtensionPreview(
        sequence.annotations,
        activeCdsExtensionArrow,
        sequence.sequence,
        circular
      ),
    [sequence.annotations, sequence.sequence, activeCdsExtensionArrow, circular]
  );
  const sequenceWithExtensionPreview = useMemo(
    () =>
      annotationsWithPreview === sequence.annotations
        ? sequence
        : { ...sequence, annotations: annotationsWithPreview as Annotation[] },
    [sequence, annotationsWithPreview]
  );
  bindSangerReadViewProjection(sourceSequence, sequenceWithExtensionPreview);
  useEffect(() => {
    const store = crossSurfaceStores.cdsExtensionHoverStore;
    const drain = () => {
      const requested = store.takeDraftRequest();
      if (!requested || !onOpenCdsExtensionDraft) return;
      const shown = sequence.annotations.find(
        (a) => cdsExtensionIdentityKey(a) === requested.cdsKey
      );
      if (!shown) return;
      const parent = cdsWithoutExtensionPreview(shown) ?? shown;
      store.clear();
      onOpenCdsExtensionDraft({
        original: sequenceViewToSource.annotation(parent),
        direction: requested.direction,
        kind: requested.kind,
      });
    };
    drain();
    return store.subscribe(drain);
  }, [
    crossSurfaceStores.cdsExtensionHoverStore,
    onOpenCdsExtensionDraft,
    sequence.annotations,
    sequence.sequence,
    sequenceViewToSource,
  ]);

  const handleCommitCdsExtension = useCallback(
    (preview: Annotation) => {
      if (!onCommitCdsExtension) return;
      const bounds = committedBoundsForExtensionPreview(preview);
      if (!bounds) return;
      const parentKey = cdsExtensionIdentityKey(preview);
      const parent = sequence.annotations.find((a) => cdsExtensionIdentityKey(a) === parentKey);
      if (!parent) return;
      onCommitCdsExtension({
        original: sequenceViewToSource.annotation(parent),
        updated: sequenceViewToSource.annotation({
          ...parent,
          start: bounds.next.start,
          end: bounds.next.end,
          qualifiers: committedQualifiersForExtensionPreview(preview),
        }),
      });
      crossSurfaceStores.cdsExtensionHoverStore.clear();
    },
    [
      onCommitCdsExtension,
      sequence.annotations,
      sequenceViewToSource,
      crossSurfaceStores.cdsExtensionHoverStore,
    ]
  );

  const setMinimapHandle = useCallback(
    (handle: WebGLMapHandle | null) => {
      minimapRef.current = handle;
      syncViewportTarget(handle);
      syncWebGLTarget(handle);
    },
    [syncViewportTarget, syncWebGLTarget]
  );

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    if (typeof window === 'undefined') return;
    const w = window as Window & {
      __workspaceViewerPrimerDebug?: Record<string, unknown>;
    };
    w.__workspaceViewerPrimerDebug ??= {};
    w.__workspaceViewerPrimerDebug[entityId ?? plasmid.name ?? 'unknown'] = {
      propPrimerCount: primers?.length ?? 0,
      plasmidPrimerCount: plasmid.primers.length,
      webglPrimerCount: webglPlasmid.primers.length,
      showPrimers: viewerConfig.showPrimers,
      webglMapVisible: actualWebGLMapVisible,
    };
  }, [
    actualWebGLMapVisible,
    entityId,
    plasmid.primers.length,
    primers?.length,
    viewerConfig.showPrimers,
    webglPlasmid.primers.length,
  ]);

  const pendingViewportRestoreRef = useRef<number | null>(null);
  const pendingDrawerWidthRestoreRef = useRef<{ centerBp: number; width: number } | null>(null);
  const annotationDrawerWasOpenRef = useRef(isAnnotationDrawerOpen);
  const preserveViewportCenter = useCallback(
    (mutate: () => void) => {
      const centerBp = coordinateSpace ? null : lastViewportCenterRef.current;
      pendingViewportRestoreRef.current = centerBp;
      pendingDrawerWidthRestoreRef.current =
        centerBp != null && !isAnyDrawerOpen && sequenceViewMode === '2d'
          ? { centerBp, width: sequenceContainerRef.current?.clientWidth ?? 0 }
          : null;
      mutate();
    },
    [
      coordinateSpace,
      isAnyDrawerOpen,
      lastViewportCenterRef,
      sequenceContainerRef,
      sequenceViewMode,
    ]
  );
  useLayoutEffect(() => {
    const restoreBp = pendingViewportRestoreRef.current;
    if (restoreBp == null) return;
    pendingViewportRestoreRef.current = null;
    scrollActiveSequenceViewerToBiologicalPosition(restoreBp);
  }, [sequence.annotations, scrollActiveSequenceViewerToBiologicalPosition]);
  useLayoutEffect(() => {
    const wasOpen = annotationDrawerWasOpenRef.current;
    annotationDrawerWasOpenRef.current = isAnnotationDrawerOpen;
    if (!isAnnotationDrawerOpen) {
      if (wasOpen) pendingDrawerWidthRestoreRef.current = null;
      return;
    }
    const pending = pendingDrawerWidthRestoreRef.current;
    if (!pending) return;
    const pane = sequenceContainerRef.current;
    if (!pane || pending.width <= 0) {
      pendingDrawerWidthRestoreRef.current = null;
      return;
    }

    let observer: ResizeObserver | null = null;
    const restoreOnWidthChange = () => {
      if (pendingDrawerWidthRestoreRef.current !== pending) return;
      if (Math.abs(pane.clientWidth - pending.width) <= 1) return;
      pendingDrawerWidthRestoreRef.current = null;
      observer?.disconnect();
      scrollActiveSequenceViewerToBiologicalPosition(pending.centerBp);
    };
    observer = new ResizeObserver(restoreOnWidthChange);
    observer.observe(pane);
    restoreOnWidthChange();
    return () => observer?.disconnect();
  }, [
    isAnnotationDrawerOpen,
    scrollActiveSequenceViewerToBiologicalPosition,
    sequenceContainerRef,
  ]);

  const handleAddAnnotation = useCallback(
    (range: { start: number; end: number }) => {
      preserveViewportCenter(() => onAddAnnotationProp?.(range));
    },
    [onAddAnnotationProp, preserveViewportCenter]
  );

  const handleEditAnnotation = useCallback(
    (annotation: Annotation) => {
      onEditAnnotationProp?.(sequenceViewToSource.annotation(annotation));
    },
    [onEditAnnotationProp, sequenceViewToSource]
  );

  const handleDeleteAnnotation = useCallback(
    (annotation: Annotation) => {
      onDeleteAnnotationProp?.(sequenceViewToSource.annotation(annotation));
    },
    [onDeleteAnnotationProp, sequenceViewToSource]
  );

  const handleSaveORFAsAnnotation = useCallback(
    (orf: { start: number; end: number; strand: '+' | '-'; frame: number; length: number }) => {
      const draft = buildOrfDraft(orf, sequence);
      if (!draft) return;
      const sourceDraft = sequenceViewToSource.annotationDraft(draft);
      preserveViewportCenter(() => {
        if (onAddAnnotationDraftProp) {
          onAddAnnotationDraftProp(sourceDraft);
        } else {
          onAddAnnotationProp?.({ start: sourceDraft.start, end: sourceDraft.end });
        }
      });
    },
    [
      onAddAnnotationDraftProp,
      onAddAnnotationProp,
      preserveViewportCenter,
      sequence,
      sequenceViewToSource,
    ]
  );

  const scaffoldRanges = useMemo(
    () => backboneSegments?.filter((segment) => segment.scaffold),
    [backboneSegments]
  );
  const toolbarSelectionPreview = useMemo(
    () =>
      isEditMode
        ? undefined
        : {
            store: selectionPreviewStore,
            highlightedRange,
            sequenceText: sequence.sequence,
            scaffoldRanges,
          },
    [isEditMode, selectionPreviewStore, highlightedRange, sequence.sequence, scaffoldRanges]
  );
  const {
    selectionLength,
    annotationBoundarySelection,
    askAiBoundarySelection,
    selectionTm,
    selectionTmReadout,
    getSelectedSequenceText,
    getSelectedReverseComplementText,
    handleCopySequence,
    handleCopyReverseComplement,
    handleCopyCDSTranslation,
    handleInvertSelection,
  } = useSequenceClipboardActions({
    keyboardActive: viewerCommandIsActive,
    scaffoldRanges: comparison ? undefined : scaffoldRanges,
    highlightedRange: workspaceViewerHighlightRange(isEditMode, highlightedRange),
    sequenceText: comparisonMolecule?.sequence ?? sequence.sequence,
    sequenceLength: comparisonMolecule?.length ?? sequence.length,
    sequenceViewToSource: comparison
      ? {
          selection: (range) => range,
          selectionAsRange: (range) => ({
            start: range.start,
            end: range.end + 1,
            wraps: range.wraps,
          }),
        }
      : sequenceViewToSource,
    sequenceViewCopyOrientation: comparison
      ? (reverseRequested) => (reverseRequested ? 'reverse-complement' : 'forward')
      : sequenceViewCopyOrientation,
    onCopy,
    effectiveCDS,
    sequenceGeneticCode: comparisonMolecule?.geneticCode ?? documentGeneticCode,
    geneticCodeBasis: comparisonMolecule ? undefined : documentGeneticCodeResolution.basis,
    sequenceNucleicAcid: nucleicAcidOf(sequence),

    setHighlightedRange,
  });

  const openTranslationDialog = useTranslationDialogStore((s) => s.open);
  const selectionGeneticCode = comparisonMolecule?.geneticCode ?? documentGeneticCode;
  const handleCopyTranslation = useCallback(() => {
    const selectedSequenceText = getSelectedSequenceText();
    if (!selectedSequenceText) return;
    openTranslationDialog({
      sequence: selectedSequenceText,
      label: `${selectionLength} bp selected`,
      geneticCode: selectionGeneticCode,
    });
  }, [selectionGeneticCode, getSelectedSequenceText, openTranslationDialog, selectionLength]);

  const { handleReindexHere, handleFlipOrientation, handleResetSequenceView } =
    useSequenceViewTransformActions({
      circular,
      contextPosition: contextMenu.position,
      sourceSequenceLength,
      orientation: sequenceViewProjection.orientation,
      originOffsetForViewPosition,
      patchSeqView,
      minimapRef,
      scrollToPositionWithTimeoutRef,
      setViewCursor,
      setHighlightedRange,
      setSelectedAnnotation,
    });

  const {
    mapPaneVisible,
    horizontalSequenceMapLayout,
    mapFillsAvailableSpace,
    minimapRenderHeight,
    showResizeHandle,
    showSideResizeHandle,
  } = workspaceViewerLayoutFlags({
    hideMinimap,
    renderMapSurfaceVisible,
    sequenceSurfaceVisible,
    mapOnlyVisible,
    activeMapLayout,
    minimapContainerHeight,
    minimapHeight,
    minMinimapPane: MIN_MINIMAP_PANE,
  });
  const { sequenceSurfaceOrder, mapSurfaceOrder } =
    workspaceViewerMapSurfaceOrders(mapPlacedBeforeSequence);
  const {
    controlMode: mapShapeControlMode,
    morphToCircle: mapRenderMorphToCircle,
    geometryHeight: mapRenderShapeGeometryHeight,
  } = resolveMapRenderShape({
    mapFillsAvailableSpace,
    continuousShapeControl: surface === 'assembly',
    mapShape: effectiveMapShape,
    persistedMorphToCircle: effectiveMorphToCircle,
    persistedGeometryHeight: minimapGeometryHeight,
    filledGeometryHeight: MAX_MINIMAP,
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !viewerCommandIsActive) return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      if (target instanceof Element && target.closest('[role="treeitem"]')) return;
      const root = surfaceLayoutRef.current;
      if (!root || root.getClientRects().length === 0) return;

      if (matchesAppShortcut(event, 'sequence.invert')) {
        if (!circular || !highlightedRange) return;
        event.preventDefault();
        handleInvertSelection();
        return;
      }
      if (matchesAppShortcut(event, 'sequence.linear-circular')) {
        event.preventDefault();
        setMapShape(effectiveMapShape === 'circular' ? 'linear' : 'circular');
        return;
      }
      if (matchesAppShortcut(event, 'sequence.copy-translation')) {
        event.preventDefault();
        handleCopyTranslation();
        return;
      }
      if (matchesAppShortcut(event, 'sequence.reverse-complement')) {
        event.preventDefault();
        handleCopyReverseComplement();
        return;
      }
      if (matchesAppShortcut(event, 'sequence.add-annotation')) {
        if (!highlightedRange) return;
        event.preventDefault();
        handleAddAnnotation(highlightedRange);
        return;
      }
      if (
        matchesAppShortcut(event, 'sequence.next-feature') ||
        matchesAppShortcut(event, 'sequence.previous-feature')
      ) {
        const annotations = [...sequence.annotations].sort((a, b) => a.start - b.start);
        if (annotations.length === 0) return;
        const cursor = viewCursor ?? highlightedRange?.start ?? 0;
        const forward = matchesAppShortcut(event, 'sequence.next-feature');
        const next = forward
          ? (annotations.find((annotation) => annotation.start > cursor) ?? annotations[0])
          : ([...annotations].reverse().find((annotation) => annotation.start < cursor) ??
            annotations[annotations.length - 1]);
        if (!next) return;
        event.preventDefault();
        setHighlightedRange({ start: next.start, end: next.end });
        scrollActiveSequenceViewerToBiologicalPosition(next.start);
      }
    };
    presentationEvents.add(window, 'keydown', onKeyDown);
    return () => presentationEvents.remove(window, 'keydown', onKeyDown);
  }, [
    circular,
    effectiveMapShape,
    handleAddAnnotation,
    handleCopyReverseComplement,
    handleCopyTranslation,
    handleInvertSelection,
    highlightedRange,
    scrollActiveSequenceViewerToBiologicalPosition,
    sequence.annotations,
    viewerCommandIsActive,
    surfaceLayoutRef,
    setHighlightedRange,
    setMapShape,
    viewCursor,
    ,
    presentationEvents,
  ]);
  const webglMapGeometry = resolveSequenceMapWebGLGeometry({
    mapShape: effectiveMapShape,
    renderHeight: minimapRenderHeight,
    shapeGeometryHeight: mapRenderShapeGeometryHeight,
    morphToCircle: mapRenderMorphToCircle,
    minHeight: MIN_MINIMAP_GEOMETRY,
  });
  const sideSplitWidth = usableSideSplitWidth(surfaceLayoutWidth, showSideResizeHandle);
  const sideMapPaneWidth = clampSideMapPaneWidth(
    workspaceViewerRequestedSideMapPaneWidth(
      sideMapPaneWidthDraft,
      seqView.mapPaneWidth,
      defaultSideMapPaneWidth(sideSplitWidth)
    ),
    sideSplitWidth
  );
  const handleMapPaneResizeStart = useCallback(
    (event: React.MouseEvent<HTMLDivElement>, axis: SequenceMapPaneResizeAxis) => {
      event.preventDefault();
      event.stopPropagation();

      const layout = surfaceLayoutRef.current;
      const pane = minimapContainerRef.current;
      if (!layout || !pane) return;

      const layoutRect = layout.getBoundingClientRect();
      const paneRect = pane.getBoundingClientRect();
      const resizeHandleRect = event.currentTarget.getBoundingClientRect();
      const webglRoot =
        pane.firstElementChild instanceof HTMLElement ? pane.firstElementChild : null;
      const webglCanvas = webglRoot?.querySelector<HTMLCanvasElement>('canvas') ?? null;
      const originalBodyCursor = document.body.style.cursor;
      const originalPaneOverflow = pane.style.overflow;
      const originalPaneWillChange = pane.style.willChange;
      const originalWebglRootWillChange = webglRoot?.style.willChange ?? '';
      const originalWebglRootPointerEvents = webglRoot?.style.pointerEvents ?? '';
      const originalWebglRootResizePreview =
        webglRoot?.getAttribute('data-webgl-resize-preview') ?? null;
      const originalWebglCanvasWidth = webglCanvas?.style.width ?? '';
      const originalWebglCanvasHeight = webglCanvas?.style.height ?? '';
      const startPointer = axis === 'horizontal' ? event.clientX : event.clientY;
      const startWidth =
        axis === 'horizontal'
          ? sideMapPaneWidth
          : paneRect.width || minimapWidth || layoutRect.width;
      const startHeight =
        axis === 'vertical'
          ? minimapHeight
          : paneRect.height || minimapRenderHeight || layoutRect.height;
      const fixedWidth = Math.max(1, paneRect.width || minimapWidth || layoutRect.width);
      const fixedHeight = Math.max(1, paneRect.height || minimapRenderHeight || layoutRect.height);
      const maxVerticalMapHeight = Math.max(
        MIN_MINIMAP_PANE,
        layoutRect.height - resizeHandleRect.height - minimumSequencePaneHeight
      );
      let latestSize = {
        width: axis === 'horizontal' ? startWidth : fixedWidth,
        height: axis === 'vertical' ? startHeight : fixedHeight,
      };
      let pendingSize = latestSize;
      let frameId: number | null = null;

      document.body.style.cursor = axis === 'horizontal' ? 'ew-resize' : 'ns-resize';
      mapPaneResizePreviewActiveRef.current = true;
      const sequenceScrollForFreeze = sequenceContainerRef.current?.querySelector(
        '[data-testid="sequence-scroll-container"]'
      ) as HTMLElement | null;
      const freezeClientHeight =
        sequenceScrollForFreeze && sequenceScrollForFreeze.clientHeight > 0
          ? sequenceScrollForFreeze.clientHeight
          : sequenceLayoutViewportHeight > 0
            ? sequenceLayoutViewportHeight
            : Math.max(
                minimumSequencePaneHeight,
                layoutRect.height - startHeight - resizeHandleRect.height
              );
      circularBufferHeightFreezeRef.current = resolveCircularBufferHeightHighWater({
        liveHeight: freezeClientHeight,
        highWater: circularBufferHeightFreezeRef.current,
      });
      flushSync(() => {
        setMapPaneResizePreviewActive(true);
      });
      webglRoot?.setAttribute('data-webgl-resize-preview', 'true');
      pane.style.overflow = 'hidden';
      pane.style.willChange = axis === 'horizontal' ? 'width' : 'height';
      if (webglRoot) {
        webglRoot.style.willChange = 'width, height';
        webglRoot.style.pointerEvents = 'none';
      }

      const setWebglDisplaySize = (size: { width: number; height: number }) => {
        const resizedGeometry = resolveSequenceMapWebGLGeometry({
          mapShape: effectiveMapShape,
          renderHeight: size.height,
          shapeGeometryHeight: mapRenderShapeGeometryHeight,
          morphToCircle: mapRenderMorphToCircle,
          minHeight: MIN_MINIMAP_PANE,
        });
        const display = resolvePaneResizeDisplaySize({
          liveWidth: size.width,
          liveHeight: resizedGeometry.renderHeight,
          geometryHeight: resizedGeometry.geometryHeight,
          morph: resizedGeometry.morphToCircle,
        });
        (minimapRef.current as WebGLMapHandle | null)?.setDisplaySize?.(display);
      };

      const applySize = (size: { width: number; height: number }) => {
        latestSize = size;
        if (axis === 'horizontal') {
          pane.style.flex = `0 0 ${size.width}px`;
          pane.style.width = `${size.width}px`;
          pane.style.height = `${size.height}px`;
        } else {
          pane.style.flex = `0 0 ${size.height}px`;
          pane.style.width = `${size.width}px`;
          pane.style.height = `${size.height}px`;
        }
        if (webglRoot) {
          webglRoot.style.width = `${size.width}px`;
          webglRoot.style.height = `${size.height}px`;
        }
        setWebglDisplaySize(size);
      };

      const scheduleSize = (size: { width: number; height: number }) => {
        pendingSize = size;
        if (frameId !== null) return;
        frameId = requestAnimationFrame(() => {
          frameId = null;
          applySize(pendingSize);
        });
      };

      const handleMouseMove = (moveEvent: MouseEvent) => {
        moveEvent.preventDefault();
        if (axis === 'horizontal') {
          const deltaX = moveEvent.clientX - startPointer;
          const nextWidth = mapPlacement === 'left' ? startWidth + deltaX : startWidth - deltaX;
          scheduleSize({
            width: clampSideMapPaneWidth(nextWidth, usableSideSplitWidth(layoutRect.width, true)),
            height: fixedHeight,
          });
          return;
        }

        const deltaY = moveEvent.clientY - startPointer;
        const nextHeight = mapPlacement === 'top' ? startHeight + deltaY : startHeight - deltaY;
        scheduleSize({
          width: fixedWidth,
          height: Math.max(MIN_MINIMAP_PANE, Math.min(maxVerticalMapHeight, nextHeight)),
        });
      };

      const handleMouseUp = () => {
        if (frameId !== null) {
          cancelAnimationFrame(frameId);
          frameId = null;
          applySize(pendingSize);
        }
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        document.body.style.cursor = originalBodyCursor;

        const settledSequenceHeight =
          axis === 'vertical'
            ? resolveSequencePaneHeightDuringMapResize({
                layoutHeight: layoutRect.height,
                mapHeight: latestSize.height,
                handleHeight: resizeHandleRect.height,
                minSequenceHeight: minimumSequencePaneHeight,
              })
            : null;

        flushSync(() => {
          setMinimapWidth(latestSize.width);
          setMinimapContainerHeight(latestSize.height);
          if (axis === 'horizontal') {
            setSideMapPaneWidthDraft(latestSize.width);
            patchSeqView({ mapPaneWidth: latestSize.width }, { debounce: true });
          } else {
            handleMinimapPaneHeightChange(latestSize.height);
            if (settledSequenceHeight != null) {
              setSequenceLayoutViewportHeight(settledSequenceHeight);
              circularBufferHeightFreezeRef.current = resolveCircularBufferHeightHighWater({
                liveHeight: settledSequenceHeight,
                highWater: circularBufferHeightFreezeRef.current,
              });
            }
          }
          setMapPaneResizePreviewActive(false);
        });

        pane.style.overflow = originalPaneOverflow;
        pane.style.willChange = originalPaneWillChange;
        if (webglRoot) {
          webglRoot.style.willChange = originalWebglRootWillChange;
          webglRoot.style.pointerEvents = originalWebglRootPointerEvents;
        }
        if (webglCanvas) {
          webglCanvas.style.width = originalWebglCanvasWidth;
          webglCanvas.style.height = originalWebglCanvasHeight;
        }
        setWebglDisplaySize(latestSize);
        if (webglRoot) {
          if (originalWebglRootResizePreview === null) {
            webglRoot.removeAttribute('data-webgl-resize-preview');
          } else {
            webglRoot.setAttribute('data-webgl-resize-preview', originalWebglRootResizePreview);
          }
        }
        mapPaneResizePreviewActiveRef.current = false;
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [
      effectiveMorphToCircle,
      effectiveMapShape,
      handleMinimapPaneHeightChange,
      mapRenderMorphToCircle,
      mapRenderShapeGeometryHeight,
      mapPlacement,
      minimapGeometryHeight,
      minimapHeight,
      minimapRenderHeight,
      minimapWidth,
      patchSeqView,
      sideMapPaneWidth,
      sequenceLayoutViewportHeight,
      MIN_MINIMAP_GEOMETRY,
      MIN_MINIMAP_PANE,
      minimumSequencePaneHeight,
    ]
  );
  const handleVerticalMapResizeStart = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => handleMapPaneResizeStart(event, 'vertical'),
    [handleMapPaneResizeStart]
  );
  const handleSideResizeStart = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => handleMapPaneResizeStart(event, 'horizontal'),
    [handleMapPaneResizeStart]
  );
  const minimapType = workspaceViewerMinimapType(renderMapSurfaceVisible, hideMinimap);
  const surfaceLayoutStyle = workspaceViewerSurfaceLayoutStyle(horizontalSequenceMapLayout);
  const sequenceContainerStyle = workspaceViewerSequenceContainerStyle({
    sequenceSurfaceOrder,
    sequenceSurfaceVisible,
    horizontalSequenceMapLayout,
  });
  const sequenceViewportHeightHint = workspaceViewerSequenceViewportHeightHint({
    mapPaneResizePreviewActive,
    mapSurfaceVisible,
    sequenceSurfaceVisible,
    sequenceLayoutViewportHeight,
  });
  const circularBufferViewportHeight = (() => {
    if (!sequenceSurfaceVisible) return undefined;
    const basisHeight = Math.max(
      sequenceLayoutViewportHeight,
      circularBufferHeightFreezeRef.current,
      mapPlacement === 'bottom' ? surfaceLayoutHeight : 0
    );
    if (basisHeight <= 0) return undefined;
    return resolveCircularBufferHeightHighWater({
      liveHeight: basisHeight,
      highWater: circularBufferHeightFreezeRef.current,
    });
  })();
  const initialSequenceContainerWidth = horizontalSequenceMapLayout
    ? Math.max(0, (sideSplitWidth ?? 0) - sideMapPaneWidth)
    : (surfaceLayoutWidth ?? 0);
  const minimapContainerStyle = workspaceViewerMinimapContainerStyle({
    mapPaneVisible,
    mapOnlyVisible,
    horizontalSequenceMapLayout,
    mapSurfaceOrder,
    mapPlacement,
    sideMapPaneWidth,
    minimapHeight,
    minMinimapPane: MIN_MINIMAP_PANE,
  });

  const { buildAskAiOverlaysSnapshot } = useWorkspaceViewerAskAi({
    isSequenceViewTransformed,
    cutSitesVisible: cutSitesState.isVisible,
    cutSites: cutSitesState.cutSites,
    orfsVisible: orfState.isVisible,
    orfs: visibleORFs,
    primersVisible: viewerConfig.showPrimers,
    primers: sourcePrimers,
    askAiBoundarySelection,
    viewCursor,
    sourcePositionFromView: sequenceViewToSource.position,
    sequenceLength: sequence.length,
    isCircular: circular,
    isEditMode,
    disabled: workspaceViewerAskAiDisabled({
      isGapped,
      inAlignmentMode,
      onAskAI: onAskAIProp,
      sequenceCommandIsActive,
    }),
    onAskAI: onAskAIProp,
  });

  const zoomPerf = (
    window as Window & {
      __zoomPerf?: { workspaceRenders?: Array<{ t: number; durMs: number }> };
    }
  ).__zoomPerf;
  if (zoomPerf) {
    (zoomPerf.workspaceRenders ??= []).push({
      t: performance.now(),
      durMs: performance.now() - workspaceRenderStartedAt,
    });
    if (zoomPerf.workspaceRenders.length > 400) zoomPerf.workspaceRenders.shift();
  }

  return (
    <SequenceCrossSurfaceProviders stores={crossSurfaceStores}>
      <SequenceSurfaceLayout
        adaptiveDrawerWidth={adaptiveDrawerWidth}
        rootEventHandlers={sequenceScope.eventHandlers}
        mainContent={
          <>
            <WorkspaceViewerEditModeBar
              isEditMode={isEditMode}
              onDiscard={handleEditDiscard}
              onCommit={handleEditCommit}
              discardDisabled={!editingActive}
              commitDisabled={!editingActive}
            />

            <ORFDetectionNotice detection={orfState} />

            <div
              ref={surfaceLayoutRef}
              data-testid="sequence-map-surface-layout"
              onPointerDownCapture={handlePaneInteractionCapture}
              onFocusCapture={handlePaneInteractionCapture}
              onWheelCapture={handlePaneInteractionCapture}
              data-layout-orientation={activeMapLayout}
              data-map-placement={mapPlacement}
              data-empty-sequence-entry={String(emptySequenceEntryVisible)}
              style={surfaceLayoutStyle}
            >
              {}
              <div
                data-testid="sequence-viewer-container"
                data-sequence-wheel-zoom-scope=""
                data-sequence-view-mode={sequenceViewMode}
                data-sequence-map-surface="sequence"
                style={sequenceContainerStyle}
                ref={sequenceContainerRef}
              >
                <WorkspaceViewerSequenceSurface
                  sequenceSurfaceVisible={sequenceSurfaceVisible}
                  sequenceViewMode={sequenceViewMode}
                  emptySequenceEntryVisible={emptySequenceEntryVisible}
                  emptySequenceEntryCue={emptySequenceEntryCue}
                  emptyCueRowHeight={scaledViewerMetrics.rowHeight}
                  zoom={viewerConfig.zoomLevel}
                  minZoom={sequenceViewMode === '2d' ? canvasMinZoom : MIN_SEQUENCE_ZOOM}
                  onModeChange={setSequenceViewMode}
                  showModeToggle={surface === 'assembly' && !comparisonMode}
                  tracksLabel={
                    comparison
                      ? 'DNA comparison'
                      : coordinateSpace?.mode === 'gapped'
                        ? 'Alignment'
                        : 'Sanger traces'
                  }
                  onZoomChange={handleSequenceZoomChange}
                  tracks={
                    sharedReadViewerActive ? (
                      <SharedSequenceReadViewer
                        sequence={sequenceWithExtensionPreview}
                        plasmid={webglPlasmid}
                        coordinateSpace={coordinateSpace}
                        alignmentLanes={alignmentLanes}
                        comparison={comparison}
                        selectedAnnotation={
                          comparison ? selectedAnnotation : selectedAnnotationForMinimap
                        }
                        onSelectedAnnotationChange={handleSelectedAnnotationChange}
                        onSelectionClear={clearSequenceSelection}
                        onSequenceContextMenu={handleContextMenu}
                        changedAnnotationNames={changedAnnotationNames}
                        hideReverseComplement={hideReverseComplement}
                        trackOwnerId={trackOwnerId}
                        selectionSource={comparisonSelectionSource}
                        onSelectionSourceChange={setComparisonSelectionSource}
                        onComparisonContextMenu={(event, source, range, position) => {
                          setComparisonSelectionSource(source);
                          setPendingComparisonMenu({
                            x: event.clientX,
                            y: event.clientY,
                            position,
                            range,
                          });
                        }}
                        selection={activeVisibleHighlightRange}
                        onSelectionChange={(range) => {
                          search.releaseActiveHighlight();
                          handleSequenceHighlightedRangeChange(range);
                        }}
                        onViewportChange={handleViewportChange}
                        scrollToPosition={scrollToPosition}
                        columnNavigation={columnNavigation}
                        scrollCommandId={scrollCommandId}
                        scrollCommandRequestId={scrollCommandRequestId}
                        onScrollToPositionComplete={onScrollToPositionComplete}
                        zoomPercent={viewerConfig.zoomLevel}
                        aaColorScheme={aaColorScheme}
                        showTranslation={viewerConfig.showTranslation}
                        showResidueNumbers={viewerConfig.showResidueNumbers}
                        onZoomChange={handleSequenceZoomChange}
                      />
                    ) : (
                      <SequenceViewer1DWithTracks
                        sequence={sequenceWithExtensionPreview}
                        orfs={visibleORFs}
                        onOrfsPresented={
                          sequenceSurfaceVisible && !sharedReadViewerActive
                            ? orfState.onOrfsPresented
                            : undefined
                        }
                        candidateOrf={candidateOrf}
                        aaColorScheme={aaColorScheme}
                        annotationColorMode={viewerConfig.annotationColorMode}
                        showReverseComplement={sequenceReverseComplementVisible(
                          hideReverseComplement,
                          viewerConfig.showReverseComplement
                        )}
                        tracksMode={sequenceViewMode === 'tracks'}
                        selection={activeVisibleHighlightRange}
                        onSelectionChange={(sel) => {
                          search.releaseActiveHighlight();
                          handleSequenceHighlightedRangeChange(sel);
                        }}
                        viewCursor={viewCursor}
                        onViewCursorChange={setViewCursor}
                        onViewportChange={handleViewportChange}
                        zoomPercent={viewerConfig.zoomLevel}
                        scrollToPosition={scrollToPosition}
                        scrollCommandId={scrollCommandId}
                        scrollAnimate={scrollAnimate}
                        onScrollToPositionComplete={onScrollToPositionComplete}
                        scrollPresentation={
                          sequenceViewMode === 'tracks' ? scrollPresentation : null
                        }
                        selectedAnnotationIds={selectedAnnotationIds1D}
                        selectedAnnotation={selectedAnnotationForOneD}
                        onSelectedAnnotationChange={handleSelectedAnnotationChange}
                        cutSitesState={cutSitesState}
                        internalCutSites={workspaceViewerOrLocal(
                          internalCutSiteMarkers,
                          EMPTY_COLORED_CUT_SITES
                        )}
                        hoveredEnzymeName={hoveredEnzymeName}
                        hoveredPositionInfo={hoveredPositionInfo}
                        onCutSiteDoubleClick={handleCutSiteDoubleClick}
                        primers={primers}
                        showPrimers={viewerConfig.showPrimers}
                        {...sequenceSearchOverlayProps(search)}
                        coordinateSpace={coordinateSpace}
                        mutations={sequenceMutationsForCoordinateSpace(coordinateSpace, mutations)}
                        rulerDecorations={rulerDecorations}
                        onContextMenu={handleContextMenu}
                        residueSelectionReferenceId={residueSelectionReferenceId}
                      />
                    )
                  }
                  canvas2d={
                    <SequenceViewer
                      ref={sequenceViewerRef}
                      keyboardActive={viewerCommandIsActive}
                      browserWheelGestureOwnership={supportsWheelMomentum()}
                      sequence={sequenceWithExtensionPreview}
                      orfs={visibleORFs}
                      onOrfsPresented={
                        sequenceSurfaceVisible && !sharedReadViewerActive
                          ? orfState.onOrfsPresented
                          : undefined
                      }
                      candidateOrf={candidateOrf}
                      forcedSelectedAnnotation={forcedSelectedAnnotation}
                      selectedAnnotation={selectedAnnotationForCanvas}
                      onSelectedAnnotationChange={handleSelectedAnnotationChange}
                      config={editorConfig}
                      zoomLevel={viewerConfig.zoomLevel}
                      onZoomLevelChange={handleZoomLevelChange}
                      onMinZoomChange={setCanvasMinZoom}
                      circularBufferViewportHeight={circularBufferViewportHeight}
                      initialContainerWidth={initialSequenceContainerWidth}
                      viewportHeightHint={sequenceViewportHeightHint}
                      freezeViewportHeight={mapPaneResizePreviewActive}
                      editable={workspaceViewerSequenceEditable(readOnly, editingActive)}
                      initialCursor={editInitialCursor}
                      selection={whenFlag(isEditMode, editInitialSelection)}
                      onCommit={handleEditCommit}
                      onDiscard={handleEditDiscard}
                      editorSession={unlessFlag(readOnly, editorSession)}
                      resolvePasteFragment={resolvePasteFragment}
                      onCopyDraftSelection={(selection) =>
                        onCopy?.({
                          start: selection.start,
                          end: selection.end,
                          wraps: selection.wraps,
                          sequence: selection.sequence,
                          orientation: 'forward',
                          sourceSequence: selection.sourceSequence,
                          sourceAnnotations: selection.sourceAnnotations,
                        })
                      }
                      showMinimap={true}
                      viewCursor={viewCursor}
                      onViewCursorChange={setViewCursor}
                      highlightedRange={activeVisibleHighlightRange}
                      onHighlightedRangeChange={(range) => {
                        search.releaseActiveHighlight();
                        handleSequenceHighlightedRangeChange(range);
                      }}
                      onHighlightedRangePreview={handleSequenceHighlightedRangePreview}
                      onViewportChange={handleViewportChange}
                      onContextMenu={handleContextMenu}
                      cutSites={twoDCutSites}
                      scannedCutSites={sequenceScannedCutSites(
                        isFeatureOrDetailLod,
                        cutSitesState.isVisible,
                        cutSitesState.scannedCutSites
                      )}
                      showCutSites={sequenceShowCutSites(
                        isFeatureOrDetailLod,
                        cutSitesState.isVisible,
                        twoDInternalCutSites.length
                      )}
                      hoveredEnzymeName={hoveredEnzymeName}
                      hoveredPositionInfo={hoveredPositionInfo}
                      onCutSiteDoubleClick={handleCutSiteDoubleClick}
                      scrollToPosition={scrollToPosition}
                      scrollCommandId={scrollCommandId}
                      scrollAnimate={scrollAnimate}
                      onScrollToPositionComplete={onScrollToPositionComplete}
                      scrollPresentation={sequenceViewMode === '2d' ? scrollPresentation : null}
                      rulerSegments={mergedBackboneSegments}
                      selectedAssemblyScaffoldRegionId={mapSelectedPartRegionId}
                      onAssemblyScaffoldSelect={handleAssemblyScaffoldSelect}
                      junctionIndicators={junctionIndicators}
                      primers={primers}
                      onGGLabelClick={onGGLabelClick}
                      coordinateSpace={coordinateSpace}
                      mutations={sequenceMutationsForCoordinateSpace(coordinateSpace, mutations)}
                      onMutationClick={onMutationClick}
                      rulerDecorations={rulerDecorations}
                      changedAnnotationNames={changedAnnotationNames}
                      {...sequenceSearchOverlayProps(search)}
                      previewCDS={previewCDS}
                      residueSelectionReferenceId={residueSelectionReferenceId}
                      style={{ height: '100%', width: '100%', border: 'none', borderRadius: 0 }}
                    />
                  }
                />

                <WorkspaceViewerContextMenu
                  contextMenu={contextMenu}
                  onClose={handleContextMenuClose}
                  selectionLength={selectionLength}
                  sequenceLength={comparisonMolecule?.length ?? sequence.length}
                  sequenceBases={comparisonMolecule?.sequence ?? sequence.sequence}
                  sequenceGeneticCode={comparisonMolecule?.geneticCode ?? documentGeneticCode}
                  geneticCodeBasis={
                    comparisonMolecule ? undefined : documentGeneticCodeResolution.basis
                  }
                  circular={circular}
                  readOnly={readOnly}
                  isSequenceViewTransformed={isSequenceViewTransformed}
                  canEditSequence={canEditSequence}
                  inAlignmentMode={inAlignmentMode}
                  isGapped={isGapped}
                  sequenceCommandIsActive={sequenceCommandIsActive}
                  coordinateSpace={coordinateSpace}
                  viewCursor={viewCursor}
                  highlightedRange={highlightedRange}
                  annotationBoundarySelection={annotationBoundarySelection}
                  askAiBoundarySelection={askAiBoundarySelection}
                  effectiveCDS={effectiveCDS}
                  effectiveStructureFeature={effectiveStructureFeature}
                  sequenceViewToSource={sequenceViewToSource}
                  onCopySequence={handleCopySequence}
                  onCopyReverseComplement={handleCopyReverseComplement}
                  onCopyTranslation={handleCopyTranslation}
                  onCopyCDSTranslation={handleCopyCDSTranslation}
                  onCreateAminoAcidSequence={onCreateAminoAcidSequence}
                  onPaste={
                    onPaste
                      ? (position) => onPaste(sequenceViewToSource.position(position))
                      : undefined
                  }
                  pasteTargetLabel={pasteTargetLabel}
                  onEnterEditMode={enterEditMode}
                  onAddAnnotation={handleAddAnnotation}
                  onEditAnnotation={handleEditAnnotation}
                  onDeleteAnnotation={handleDeleteAnnotation}
                  onCommitCdsExtension={onCommitCdsExtension ? handleCommitCdsExtension : undefined}
                  onSaveORFAsAnnotation={handleSaveORFAsAnnotation}
                  onEditPrimer={_onEditPrimer}
                  onEditPrimerBinding={_onEditPrimerBinding}
                  onCopyPrimerBases={_onCopyPrimerBases}
                  onDetachPrimer={_onDetachPrimer}
                  onReverseComplementAssemblyPart={onMapPartReverseComplement}
                  onAttachPrimers={onAttachPrimers}
                  onCreatePrimer={_onCreatePrimer}
                  getSelectedSequenceText={getSelectedSequenceText}
                  getSelectedReverseComplementText={getSelectedReverseComplementText}
                  onInvertSelection={handleInvertSelection}
                  onReindexHere={handleReindexHere}
                  onFlipOrientation={handleFlipOrientation}
                  onResetSequenceView={handleResetSequenceView}
                  onPreviewCDS={handlePreviewCDS}
                  onViewStructure={onViewStructure}
                  onAskAI={onAskAIProp}
                  buildAskAiOverlaysSnapshot={buildAskAiOverlaysSnapshot}
                />

                {}
                {children}
              </div>

              <WorkspaceViewerMapPane
                showResizeHandle={showResizeHandle}
                showSideResizeHandle={showSideResizeHandle}
                onVerticalResizeStart={handleVerticalMapResizeStart}
                onSideResizeStart={handleSideResizeStart}
                minimapContainerRef={minimapContainerRef}
                minimapContainerStyle={minimapContainerStyle}
                title={mapPasteHint}
                minimapType={minimapType}
                circular={circular}
                effectiveMapShape={effectiveMapShape}
                webglMapGeometry={webglMapGeometry}
                hideMinimap={hideMinimap}
                alternateMinimapContent={alternateMinimapContent}
                renderMapSurfaceVisible={renderMapSurfaceVisible}
                actualWebGLMapVisible={actualWebGLMapVisible}
                mapCameraZoomVisible={mapCameraZoomVisible}
                mapShapeControlMode={mapShapeControlMode}
                minMinimapGeometry={MIN_MINIMAP_GEOMETRY}
                maxMinimap={MAX_MINIMAP}
                minimapGeometryHeight={minimapGeometryHeight}
                mapRenderMorphToCircle={mapRenderMorphToCircle}
                webglCameraZoom={webglCameraZoom}
                webglCameraZoomBounds={webglCameraZoomBounds}
                webglCameraZoomSource={webglCameraZoomSource}
                isWebglSyncLocked={isWebglSyncLocked}
                lastViewportCenterRef={lastViewportCenterRef}
                minimapRef={minimapRef}
                patchSeqView={patchSeqView}
                onMapShapeChange={setMapShape}
                onMorphToCircleChange={handleMorphToCircleChange}
                onGeometryHeightChange={handleMinimapGeometryHeightChange}
                onMapZoomChange={handleMapZoomChange}
                mapControls={
                  mapTracksOwnerId ? (
                    <SequenceAnnotationTracksControl
                      ownerTabId={mapTracksOwnerId}
                      mapCircular={mapTopologyCircular}
                      dataLayers={genomicMarkup.trackControls}
                    />
                  ) : undefined
                }
                mapOverlay={
                  annotationCatalog ? (
                    <SequenceAnnotationCatalogHover
                      ownerTabId={annotationCatalog.ownerTabId}
                      mapRef={minimapRef}
                    />
                  ) : undefined
                }
                webglMap={
                  <WebGLMap
                    changedAnnotationNames={changedAnnotationNames}
                    annotationColorsByIdentity={genomicMarkup.annotationColorsByIdentity}
                    missingAnnotationColor={genomicMarkup.missingColor}
                    ref={setMinimapHandle}
                    plasmid={webglPlasmid}
                    width={minimapWidth}
                    height={webglMapGeometry.renderHeight}
                    geometryHeight={webglMapGeometry.geometryHeight}
                    circular={mapTopologyCircular}
                    morphToCircle={workspaceViewerMapMorphToCircle(
                      mapTopologyCircular,
                      webglMapGeometry.morphToCircle
                    )}
                    selectionStart={selectionProjection.minimap.selectionStart}
                    selectionEnd={selectionProjection.minimap.selectionEnd}
                    cursorPosition={mapEditCursorPosition ?? viewCursor}
                    cursorBlinking={mapEditCursorBlinking}
                    orfs={webglORFs}
                    onOrfsPresented={actualWebGLMapVisible ? orfState.onOrfsPresented : undefined}
                    candidateOrf={candidateOrf}
                    backboneSegments={mergedBackboneSegments}
                    selectedBackbonePartRegionId={mapSelectedPartRegionId}
                    crossoverHandleRange={mapCrossoverEditRange}
                    digestFocusRange={digestFocusRange}
                    cutSites={webglCutSites}
                    showFeatures={viewerConfig.showAnnotations}
                    showPrimers={viewerConfig.showPrimers}
                    showResidueNumbers={viewerConfig.showResidueNumbers}
                    performancePreference={webglPerformancePreference}
                    onUiFrustration={(event) => trackRendererEvent('ui_frustration', event)}
                    onFeatureSelect={handleWebglMapFeatureSelect}
                    onFeatureHover={handleWebGLFeatureHover}
                    externalHoveredFeatureId={externalHoveredFeatureId}
                    externalResidueLinkRange={residueLinkRangeForWebGL}
                    selectedAnnotation={selectedAnnotationForMinimap}
                    onSelectedAnnotationChange={handleSelectedAnnotationChange}
                    onCodonHover={handleWebGLCodonHover}
                    onPrimerClick={handleWebglMapPrimerClick}
                    onPrimerPbsEndpointPreview={handleWebglMapPrimerPbsEndpointPreview}
                    onPrimerPbsEndpointCommit={handleWebglMapPrimerPbsEndpointCommit}
                    onCrossoverBoundaryCommit={handleWebglMapCrossoverBoundaryCommit}
                    onBackbonePartSelect={onMapPartSelect}
                    onBackbonePartReorderPreview={onMapPartReorderPreview}
                    onBackbonePartReorderCommit={onMapPartReorderCommit}
                    onMapKeyDown={onMapKeyDown ? handleWebglMapKeyDown : undefined}
                    onSelectionChange={handleWebglMapSelectionChange}
                    onSelectionPreview={handleWebglMapSelectionPreview}
                    onSelectionStart={handleWebglMapSelectionStart}
                    onPositionClick={handleWebglMapPositionClick}
                    onPositionDoubleClick={handleWebglMapPositionDoubleClick}
                    onCameraChange={handleWebglMapCameraChange}
                    onRendererReady={handleWebglRendererReady}
                    syncViewportRangeOnCameraScroll={isWebglSyncLocked}
                    viewportIndicatorVisible={workspaceViewerViewportIndicatorVisible(
                      sequenceSurfaceVisible,
                      actualWebGLMapVisible
                    )}
                    onContextMenu={handleWebglMapContextMenu}
                  />
                }
              />

              {}
              <WorkspaceViewerFindOverlay
                isOpen={search.isOpen}
                isGapped={isGapped}
                query={search.query}
                mode={search.mode}
                matchCount={search.matchCount}
                activeIndex={search.activeIndex}
                isActiveReverse={search.isActiveReverse}
                isError={search.isError}
                errorMessage={searchErrorMessage}
                matches={search.matches}
                onQueryChange={search.setQuery}
                onModeChange={search.setMode}
                onNext={search.next}
                onPrev={search.prev}
                onClose={search.close}
                onActivateMatch={handleSearchActivateMatch}
              />
            </div>

            {}
            {belowMinimap}
          </>
        }
        drawerSlot={drawerSlot}
        restrictionDrawer={optionalEnzymeDrawer(
          isEnzymePanelOpen,
          <RestrictionEnzymeDrawerPanel
            width={visibleRestrictionEnzymeDrawerWidth}
            onWidthChange={handleRestrictionEnzymeDrawerWidthChange}
            cutSitesState={cutSitesState}
            cutSitesActions={cutSitesActions}
            sequenceString={sequence.sequence}
            sequenceName={workspaceViewerFallbackName(plasmid.name, 'Sequence')}
            sourceSequenceId={workspaceViewerFallbackName(plasmid.name, 'unknown')}
            sourceAnnotations={sequence.annotations}
            sourceIsCircular={sequence.circular === true}
            activeVirtualDigestEnzyme={activeVirtualDigestEnzyme}
            activeVirtualDigestEnzymes={activeVirtualDigestEnzymeNames}
            activeVirtualDigestLabel={activeVirtualDigestLabel}
            expandedSection={expandedSection}
            virtualDigestResult={virtualDigestResult}
            virtualDigestError={virtualDigestError}
            hoveredDigestFragment={hoveredDigestFragment}
            onClose={() => setEnzymePanelOpen(false)}
            onPositionClick={(position, recognitionStart, recognitionEnd) => {
              setHighlightedRange(
                cutSiteRecognitionSelection({ recognitionStart, recognitionEnd }, sequence.length)
              );
              scrollToPositionWithTimeout(position + 1);
            }}
            onVirtualDigest={handleVirtualDigest}
            onClearVirtualDigest={handleClearVirtualDigest}
            onDigestFragmentHover={handleDigestFragmentHover}
            onDigestFragmentClick={handleDigestFragmentClick}
            onEnzymesCollapsedChange={handleEnzymesCollapsedChange}
            onDigestCollapsedChange={handleDigestCollapsedChange}
            onEnzymeHover={setHoveredEnzymeName}
            onPositionHover={setHoveredPositionInfo}
          />
        )}
        toolbar={
          <MemoSequenceToolbarSidebar
            config={viewerConfig}
            onConfigChange={handleConfigChange}
            sequenceLength={sourceSequence.length}
            selectionLength={selectionLength}
            selectionTm={selectionTm}
            selectionTmReadout={selectionTmReadout}
            selectionPreview={toolbarSelectionPreview}
            isEnzymePanelOpen={isEnzymePanelOpen}
            onEnzymePanelToggle={handleEnzymePanelToggle}
            onOpenAlignments={onOpenAlignments}
            isAlignmentPanelOpen={isAlignmentPanelOpen}
            onOpenMetadata={onOpenMetadata}
            isMetadataOpen={isMetadataOpen}
            onOpenGitHistory={onOpenGitHistory}
            historyLabel={historyLabel}
            isGitHistoryOpen={isGitHistoryOpen}
            onOpenPrimers={onOpenPrimers}
            isPrimersPanelOpen={isPrimersPanelOpen}
            onOpenStructure={onOpenStructure}
            isStructureDrawerOpen={isStructureDrawerOpen}
            isStructureAvailable={isStructureAvailable}
            onAutoAnnotateClick={onAutoAnnotateClick}
            isAnnotationsDrawerOpen={autoAnnotateStatus === 'success'}
            hasReviewSession={hasReviewSession}
            isORFVisible={orfState.isVisible}
            onORFToggle={orfState.toggleVisibility}
            aaColorScheme={aaColorScheme}
            onAAColorSchemeChange={setAAColorScheme}
            rendererVisibility={comparisonMode ? 'sequence' : seqView.rendererVisibility}
            onRendererVisibilityChange={comparisonMode ? undefined : setRendererVisibility}
            mapPlacement={mapPlacement}
            onMapPlacementChange={setMapPlacement}
          />
        }
      />
    </SequenceCrossSurfaceProviders>
  );
}

export const WorkspaceViewer = memo(WorkspaceViewerInternal);
