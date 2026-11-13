import type { CanvasFrustration } from './canvas-frustration';
import type { AnnotationRolePaletteOverridesV1 } from '../annotation-role-palette';
import type {
  Primer,
  AnnotationFlatPresentationSnapshot,
  AnnotationSearchFocus,
  AnnotationResidentPagePublication,
  BackboneBoundaryHandle,
  BackboneBoundaryHandleHitPayload,
  BackbonePartHitPayload,
  BackbonePartReorderPreview,
  BackboneSegment,
  CompiledBroadSurfaceRequirementV1,
  CutSite,
  Feature,
  Genome,
  PixiLinearRenderer,
  PileupColumnHitPayload,
  PrimerHandleDragPreview,
  PrimerHandleHitPayload,
  ReadHitPayload,
  RenderState,
  FeatureHitPayload,
  WebGLHitTarget,
  WebGLThemeMode,
} from '@waypoint/genome-renderer';
export type { PrimerHandleDragPreview } from '@waypoint/genome-renderer';
import type { WebGLPerformanceMode, WebGLPerformancePreference } from './webgl-performance-profile';

export interface WebGLViewportRange {
  start: number;
  end: number;
  wraps?: boolean;
}

export interface WebGLMapHandle {
  setViewport: (range: WebGLViewportRange) => void;
  getViewCenter?: () => number | null;
  getViewportRange?: () => { start: number; end: number } | null;
  setViewCenter?: (centerBp: number) => void;
  setZoom?: (zoom: number) => void;
  getCameraZoom?: () => number | null;
  getCameraZoomBounds?: () => { min: number; max: number } | null;
  subscribeToCameraZoomBounds?: (
    listener: (bounds: { min: number; max: number }) => void
  ) => () => void;
  getCameraCenter?: () => number | null;
  setSelection: (startPos: number | null, endPos: number | null, wraps?: boolean) => void;
  setDisplaySize?: (size: {
    width: number;
    height: number;
    geometryHeight?: number;
    morph?: number;
    backingWidth?: number;
    backingHeight?: number;
    cssWidth?: number;
    cssHeight?: number;
    immediate?: boolean;
  }) => void;
  setResidueLinkRange?: (range: [number, number] | null) => void;
  setHoveredCodon?: (codon: { start: number; end: number; strand: 1 | -1 } | null) => void;
  setSelectedCodons?: (
    codons: ReadonlyArray<{ start: number; end: number; strand: 1 | -1 }>
  ) => void;

  getLinearRenderer?: () => PixiLinearRenderer | null;

  requestRender?: () => void;
}

export interface HoverFeatureInfo extends FeatureHitPayload {
  position?: number | null;
  screenX: number;
  screenY: number;
}

export interface HoveredCodonInfo {
  codingSource?: 'reference' | 'query';
  mutation?: import('../biology/translation').CodonMutationInfo;
  start: number;
  end: number;
  strand: 1 | -1;
}

export interface SelectedCodonInfo {
  start: number;
  end: number;
  strand: 1 | -1;
}

export type HiddenMapIdlePolicy = 'short-timeout' | 'bounded-lru' | 'host-retained';

export interface UsePixiMapOptions {
  onUiFrustration?: (event: CanvasFrustration) => void;
  genome: Genome | null;

  annotationChangeDecorations?: RenderState['annotationChangeDecorations'];
  sequencePresentation?: RenderState['sequencePresentation'];

  hiddenMapIdlePolicy?: HiddenMapIdlePolicy;

  themeMode?: WebGLThemeMode;

  annotationRolePalette?: AnnotationRolePaletteOverridesV1;

  compiledBroadSurfaceRequirement?: Readonly<
    CompiledBroadSurfaceRequirementV1 & { identityKey: string }
  >;

  annotationPresentationSnapshot?: AnnotationFlatPresentationSnapshot;

  annotationResidentPagePublication?: AnnotationResidentPagePublication;

  sequenceWindow?: { startBp: number; bases: string };

  annotationsVisible?: boolean;
  performanceMode?: WebGLPerformanceMode;
  performancePreference?: WebGLPerformancePreference;

  antialias?: boolean;

  resolution?: number;

  minimumFrameIntervalMs?: number;

  capCanvasToProvidedHeight?: boolean;
  circular: boolean;
  width: number;
  height: number;
  geometryHeight?: number;
  morph?: number;
  selectionStart?: number | null;
  selectionEnd?: number | null;
  hoveredFeatureId?: number | null;

  externalHoveredFeatureId?: number | null;
  selectedFeatureIds?: Set<number>;

  selectedFeatureCanonicalIdentities?: Set<string>;

  annotationSearchFocus?: AnnotationSearchFocus | null;

  annotationSearchFocusFeature?: Feature | null;
  backboneSegments?: BackboneSegment[];

  backboneBoundaryHandles?: BackboneBoundaryHandle[];
  highlightRange?: [number, number] | null;

  viewportIndicatorVisible?: boolean;

  digestFocusRange?: [number, number] | null;

  residueLinkRange?: [number, number] | null;

  hoveredCodon?: HoveredCodonInfo | null;

  selectedCodons?: ReadonlyArray<SelectedCodonInfo>;
  cursorPosition?: number | null;

  cursorBlinking?: boolean;

  showResidueNumbers?: boolean;

  cutSites?: CutSite[];

  primers?: readonly Primer[];
  onFeatureClick?: (featureId: number | null) => void;

  onFeatureHitClick?: (feature: FeatureHitPayload | null) => void;
  onFeatureRangeCommit?: (featureId: number) => void;
  onFeatureRangeHitCommit?: (feature: FeatureHitPayload) => void;
  onOrfClick?: (
    orf: { start: number; end: number; strand: '+' | '-'; frame: number; length: number } | null
  ) => void;
  onOrfRangeCommit?: (orf: {
    start: number;
    end: number;
    strand: '+' | '-';
    frame: number;
    length: number;
  }) => void;
  onFeatureHover?: (featureId: number | null) => void;

  onCodonHover?: (codon: HoveredCodonInfo | null) => void;

  onHoverChange?: (hover: HoverFeatureInfo | null) => void;

  onReadHoverChange?: (hover: ReadHitPayload | null) => void;

  onReadClick?: (read: ReadHitPayload | null) => void;

  onPileupColumnHoverChange?: (hover: PileupColumnHitPayload | null) => void;
  onSelectionChange?: (start: number, end: number) => void;
  onSelectionPreview?: (start: number, end: number) => void;

  onSelectionStart?: (mode: 'new' | 'start' | 'end') => void;
  onPrimerHandleDragPreview?: (
    handle: PrimerHandleHitPayload,
    boundaryBp: number
  ) => PrimerHandleDragPreview | null;
  onPrimerHandleDragCommit?: (handle: PrimerHandleHitPayload, boundaryBp: number) => void;
  onBackboneBoundaryHandleDragPreview?: (
    handle: BackboneBoundaryHandleHitPayload,
    boundaryBp: number
  ) => void;
  onBackboneBoundaryHandleDragCommit?: (
    handle: BackboneBoundaryHandleHitPayload,
    boundaryBp: number
  ) => void;
  onBackbonePartSelect?: (part: BackbonePartHitPayload) => void;
  onBackbonePartDragPreview?: (
    part: BackbonePartHitPayload,
    boundaryBp: number
  ) => BackbonePartReorderPreview | null;
  onBackbonePartDragCommit?: (part: BackbonePartHitPayload, boundaryBp: number) => void;
  onPositionClick?: (bp: number) => void;
  onPositionDoubleClick?: (bp: number) => void;

  onCameraChange?: (
    centerBp: number,
    reason: 'scroll' | 'zoom',
    zoom: number,
    viewportRange: Readonly<{ start: number; end: number }>,
    intent?: Readonly<{ zoomAnchorBp: number | null }>
  ) => void;

  onRendererReady?: (epoch: number) => void;

  onRendererGenomeCommit?: (epoch: number) => void;

  syncViewportRangeOnCameraScroll?: boolean;
  onContextMenu?: (
    event: MouseEvent,
    context: {
      position: number | null;
      featureId: number | null;
      orf: { start: number; end: number; strand: '+' | '-'; frame: number; length: number } | null;
      hitResult: WebGLHitTarget | null;
      highlightRange: [number, number] | null;
    }
  ) => void;
}

export interface PixiPresentedFrame {
  frameEpoch: number;
  presentedAtMs: number;
  content?: Readonly<{ genome: Genome; orfsDrawn: boolean }>;
}

export interface PixiMapHandle {
  getState: () => RenderState | null;

  requestRender: () => void;

  subscribeToPresentedFrames: (listener: (receipt: PixiPresentedFrame) => void) => () => void;

  schedulePostPresentWork: (work: (deadlineMs: number) => void) => void;
  getViewCenter: () => number | null;
  getViewportRange: () => { start: number; end: number } | null;
  getZoomBounds: () => { min: number; max: number } | null;
  getCameraCenter: () => number | null;
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
  }) => void;
  setZoom: (zoom: number) => void;

  setViewport: (startBp: number, endBp: number) => void;

  setCameraViewport: (startBp: number, endBp: number) => { start: number; end: number } | null;
  setViewCenter: (centerBp: number) => void;
  setResidueLinkRange: (range: [number, number] | null) => void;
  setHoveredCodon: (codon: { start: number; end: number; strand: 1 | -1 } | null) => void;
  setSelectedCodons: (codons: ReadonlyArray<SelectedCodonInfo>) => void;

  getLinearRenderer: () => PixiLinearRenderer | null;
}
