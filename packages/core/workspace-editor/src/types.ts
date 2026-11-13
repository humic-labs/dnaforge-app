import type { SequenceEditorSession, Selection, EditorPasteFragment } from './editor-state-types';
export type {
  EditorState,
  EditorAction,
  HistoryEntry,
  InsertedRange,
  DeletedRange,
  SubstitutedRange,
  EditorPastePrimerBinding,
  EditorPendingPrimerBinding,
  SequenceEditorSession,
  Selection,
  EditorPasteFragment,
} from './editor-state-types';
import type { OrfPresentation } from './orfs/orf-observation';
import { SEQUENCE_FONT_FAMILY, SEQUENCE_LABEL_FONT_FAMILY } from '@waypoint/platform';

import type {
  AnnotatedSequence,
  Annotation,
  AnnotationColorMode,
  AssemblyScaffold,
  ColoredCutSite,
  ORF,
} from '@waypoint/sequence-utils';
import type { AnnotationStateIdentity } from './annotation-render-state';
export type SequenceLodLevel = 'detail' | 'feature' | 'density';

export type CoordinateSpaceMode = 'biological' | 'gapped';

export interface CoordinateSpace {
  mode: CoordinateSpaceMode;

  gappedSequence?: string;

  alignedQuery?: string;
}

export type MutationType = 'substitution' | 'insertion' | 'deletion';

export interface MutationMarker {
  column: number;

  endColumn?: number;

  type: MutationType;

  refBase: string;

  queryBase: string;

  refPosition?: number;

  classification?: {
    inCds: boolean;
    type?: 'synonymous' | 'missense' | 'nonsense' | 'frameshift';
  };
}

export interface BpHighlight {
  start: number;
  end: number;
  color: string;
  alpha?: number;
}

export const CHANGE_COLORS = {
  insertion: {
    bg: 'hsla(152, 55%, 42%, 0.35)',
    accent: 'hsl(152, 55%, 42%)',
  },
  substitution: {
    bg: 'hsla(42, 85%, 52%, 0.35)',
    accent: 'hsl(42, 85%, 52%)',
  },
  deletion: {
    bg: 'hsla(0, 72%, 55%, 0.35)',
    accent: 'hsl(0, 72%, 55%)',
  },
  match: '#F5F5F5',
} as const;

export const MUTATION_COLORS = {
  substitution: CHANGE_COLORS.substitution.accent,
  insertion: CHANGE_COLORS.insertion.accent,
  deletion: CHANGE_COLORS.deletion.accent,
  match: CHANGE_COLORS.match,
} as const;

export interface OligoMismatch {
  position: number;

  oligoBase: string;

  templateBase: string;
}

export interface PrimerDisplay {
  id: string;

  sourcePrimerId?: string;

  name: string;

  start: number;

  end: number;

  direction: 'forward' | 'reverse';

  bases: string;

  modificationMarkers?: PrimerModificationDisplay[];

  tm: number;

  gc: number;

  mismatches?: OligoMismatch[];

  overhangLength?: number;

  pbsColor?: string;

  overhangColor?: string;

  cutPositionInOverhang?: number;

  enzymeName?: string;

  suppressCutSiteRendering?: boolean;

  recognitionStart?: number;

  recognitionEnd?: number;

  scarAbsolutePosition?: number;

  cognate4bpLength?: number;

  synthetic4bpSpacerLength?: number;

  spacerLength?: number;

  junctionIndex?: number;

  isScarMarkerOnly?: boolean;

  isInternalCutSite?: boolean;

  isDraft?: boolean;

  isCandidate?: boolean;
}

export interface PrimerModificationDisplay {
  token: string;
  label: string;
  placement: 'five-prime' | 'internal' | 'three-prime';
  behavior: 'terminal-attachment' | 'between-bases' | 'modified-base' | 'linkage';
  anchor:
    | { kind: 'terminus'; end: 'five-prime' | 'three-prime' }
    | { kind: 'between-bases'; offset: number }
    | { kind: 'base'; index: number };
}

export type RenderedPrimerSegmentRole =
  | 'pbs'
  | 'tail'
  | 'spacer'
  | 'enzyme-site'
  | 'scar'
  | 'whole';

export interface RenderedPrimerSegment {
  primer: PrimerDisplay;
  primerId: string;
  sourcePrimerId?: string;
  direction: 'forward' | 'reverse';
  role: RenderedPrimerSegmentRole;
  start: number;
  end: number;
  primerBaseStart: number;
  primerBaseEnd: number;
  x: number;
  y: number;
  width: number;
  height: number;
  lane: number;
  cycleOffset: number;
}

export interface RenderedGGProductLabel {
  primer: PrimerDisplay;

  labelBounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };

  scarStart: number;

  scarEnd: number;

  lineIndex: number;
}

export interface WorkspaceEditorConfig {
  charsPerLine: number;

  wrapCapacity?: number;

  wrapPreviewTargetCpr?: number;

  wrapTrackForecast?: boolean;

  previewDetailTracks?: {
    progress: number;
    showTranslation: boolean;
    showReverseComplement: boolean;
    showResidueNumbers: boolean;
  };

  cdsDetailProgress?: number;

  cdsZoomPresentation?: import('@waypoint/platform').CdsZoomPresentation;

  showNucleotideLetters?: boolean;

  linearWrapPhase?: boolean;
  pinLinearOrigin?: boolean;

  predictedTopBp?: number;

  wrapAnchorBp?: number;

  wrapAnchorViewportX?: number;
  wrapAnchorCapacityBias?: number;

  wrapForecastDirection?: -1 | 1;

  rowBackgroundOffset?: number;

  charWidth: number;

  rowHeight: number;

  marginLeft: number;

  fontFamily: string;

  labelFontFamily: string;

  fontSize: number;

  rulerInterval: number;

  showTranslation: boolean;

  showAnnotations: boolean;

  showReverseComplement: boolean;

  showPrimers: boolean;

  translationMode?: never;

  colorPalette: string;

  annotationColorMode: AnnotationColorMode;

  aaColorScheme: string;

  showResidueNumbers?: boolean;

  lodLevel?: SequenceLodLevel;

  overviewLod?: boolean;
}

export const DEFAULT_EDITOR_CONFIG: WorkspaceEditorConfig = {
  charsPerLine: 0,
  charWidth: 8,
  rowHeight: 20,
  marginLeft: 4,
  fontFamily: SEQUENCE_FONT_FAMILY,
  labelFontFamily: SEQUENCE_LABEL_FONT_FAMILY,
  fontSize: 11,
  rulerInterval: 10,
  showTranslation: true,
  showAnnotations: true,
  showReverseComplement: true,
  showPrimers: true,

  colorPalette: 'default',
  annotationColorMode: 'auto-type',
  aaColorScheme: 'none',
  lodLevel: 'detail',
  overviewLod: false,
};

export interface AnnotationWithLane extends Annotation {
  lane: number;
}

export interface ExonPillBound {
  x: number;

  w: number;
  y?: number;
  h?: number;

  rangeStart: number;

  rangeEnd: number;
}

export interface ClassifiedCDS extends Annotation {
  _interactionOutlineContours?: { x: number; y: number }[][];

  id?: string;

  cdsType: 'full' | 'partial';

  translationLane: number;

  _exonPillBounds?: ExonPillBound[];
  _cdsPillBounds?: { x: number; w: number; y?: number; h?: number }[];

  _cdsLineBounds?: { x: number; w: number; y: number; h: number }[];
  _intronPillBounds?: ExonPillBound[];

  _compactLane?: number;

  _detailAnnotationHeight?: number;
  _compactName?: string;
  _paintedPresentation?: {
    progress: number;
    bandProgress: number;
    chevronProgress: number;
    colorAlpha: number;

    detailStyle?: 'indexed-bands' | 'replacement-band';
    labelY: number;
    labelHeight: number;
    barY: number;
    barHeight: number;
    barCenterY: number;
    aaY: number;
    aaHeight: number;
    intronY: number;
    residueAlpha: number;
    color: string;
    barAlpha: number;
  };
}

export interface ORFWithLane extends ORF {
  lane: number;
}

export interface Layout2DRow {
  lineIndex: number;

  startPos: number;

  endPos: number;

  sequence: string;

  complementSequence: string;

  y: number;

  xOffset?: number;

  heightScale?: number;
  naturalHeight?: number;

  stripeInsetPx?: number;

  stripeTopOffsetPx?: number;

  trackMorph?: import('./predictive-wrap-layout').RowMorphBands;
  hasMutationTrack?: boolean;

  annotations: AnnotationWithLane[];

  annotationLaneCount: number;

  isWrapLine?: boolean;

  isTopBuffer?: boolean;

  isBottomBuffer?: boolean;

  isOriginLine?: boolean;

  originPosition?: number;

  preOriginLength?: number;

  classifiedCDSs?: ClassifiedCDS[];

  translationLaneCount: number;

  forwardOrfs?: ORFWithLane[];

  forwardPrimerLaneCount?: number;
  reversePrimerLaneCount?: number;

  forwardOrfLaneCount?: number;

  reverseOrfs?: ORFWithLane[];

  reverseOrfLaneCount?: number;
}

export interface SequenceLayoutSummary {
  cpr: number;

  seqLength: number;

  isCircular: boolean;

  topBp: number;

  topBufferCount: number;

  realRowCount: number;

  bottomBufferCount: number;

  totalRows: number;

  avgRowHeight: number;

  topPaddingPx: number;

  rowGapPx: number;

  rowHeights: Int32Array | Float64Array;

  rowYOffsets: Int32Array | Float64Array;
}

export interface LayoutSnapshot2D {
  viewportOriginOffset?: number;

  lines: Layout2DRow[];

  totalHeight: number;

  totalWidth: number;

  sequenceLength?: number;

  isCircular?: boolean;

  circularOffset?: number;

  bpOffset?: number;

  firstRealRowIndex?: number;

  firstBottomBufferIndex?: number;

  realRowsStartY?: number;

  bottomBufferStartY?: number;

  summary?: SequenceLayoutSummary;
}

export interface SequenceViewportPresentation {
  readonly sequence: string;
  readonly scene: LayoutSnapshot2D;
  readonly presented: LayoutSnapshot2D;
  readonly config: WorkspaceEditorConfig;
  readonly viewport: {
    readonly scrollTop: number;
    readonly height: number;
    readonly domScrollTop: number;
    readonly scrollLeft: number;
    readonly width: number;
    readonly visibleHeight: number;
    readonly canvasWidth: number;
    readonly canvasHeight: number;
    readonly visible: boolean;
  };
}

export type SequenceLine = Layout2DRow;

export interface LinePositions {
  line: Layout2DRow;
  annotationY: number;
  translationY: number;
  translationLaneCount: number;
  sequenceY: number;
  complementY: number;

  mutationTrackY: number;

  hasMutationTrack: boolean;
  rulerY: number;
  forwardPrimerY: number;
  reversePrimerY: number;
  lineEndY: number;
  hasPrimers: boolean;
  hasForwardPrimers: boolean;
  hasReversePrimers: boolean;
  absoluteLineY: number;

  forwardOrfY: number;

  reverseOrfY: number;

  forwardOrfLaneCount: number;

  reverseOrfLaneCount: number;
}

export type SequenceLayout = LayoutSnapshot2D;

export interface ViewportRange {
  start: number;

  end: number;

  centerColumn?: number;

  wraps?: boolean;
}

export type ViewportChangeSource = 'scroll' | 'layout' | 'zoom';

export interface SequenceScrollPresentation {
  readonly position: number;
  readonly presented: () => void;
}

export interface ScrollToBiologicalPositionOptions {
  animate?: boolean;

  continuousCircular?: boolean;
}

export interface WorkspaceEditorHandle {
  zoomTo?: (zoomLevel: number) => boolean;

  commit: () => void;

  discard: () => void;

  hasPendingChanges: () => boolean;

  previewHighlight: (range: Selection | null) => void;

  scrollToBiologicalPosition: (
    position: number,
    options?: ScrollToBiologicalPositionOptions
  ) => void;
}

export interface WorkspaceEditorProps {
  nativeWheelGestureOwnership?: boolean;

  sequence: AnnotatedSequence;

  config?: Partial<WorkspaceEditorConfig>;

  zoomLevel?: number;

  onZoomLevelChange?: (next: number) => void;

  onMinZoomChange?: (minimum: number) => void;

  circularBufferViewportHeight?: number;

  initialContainerWidth?: number;

  viewportHeightHint?: number;

  freezeViewportHeight?: boolean;

  coordinateSpace?: CoordinateSpace;

  selection?: Selection | null;

  onSelectionChange?: (selection: Selection | null) => void;

  onPositionClick?: (position: number) => void;

  onAnnotationClick?: (annotation: Annotation) => void;

  editable?: boolean;
  keyboardActive?: boolean;
  onSequenceChange?: (newSequence: string) => void;

  onAnnotationsChange?: (annotations: Annotation[]) => void;

  resolvePasteFragment?: (
    clipboardText: string
  ) => EditorPasteFragment | null | Promise<EditorPasteFragment | null>;

  onCopyDraftSelection?: (selection: {
    start: number;
    end: number;
    wraps?: boolean;
    sequence: string;
    sourceSequence: string;
    sourceAnnotations: Annotation[];
  }) => void | Promise<void>;

  onCursorChange?: (position: number) => void;

  onRequestEdit?: (position: number) => void;

  initialCursor?: number;

  onCommit?: () => void;

  onDiscard?: () => void;

  editorSession?: SequenceEditorSession;

  onPendingChangesChange?: (hasPending: boolean) => void;

  className?: string;

  style?: React.CSSProperties;

  cutSites?: ColoredCutSite[];

  scannedCutSites?: ColoredCutSite[];

  showCutSites?: boolean;

  onCutSiteClick?: (cutSite: ColoredCutSite) => void;

  onCutSiteDoubleClick?: (cutSite: ColoredCutSite) => void;

  onGGLabelClick?: (junctionIndex: number) => void;

  hoveredEnzymeName?: string | null;

  hoveredPositionInfo?: {
    enzymeName: string;
    position: number;
    recognitionStart: number;
    recognitionEnd: number;
  } | null;

  scrollToPosition?: number | null;

  scrollCommandId?: number | null;

  scrollAnimate?: boolean;

  onScrollToPositionComplete?: () => void;

  scrollPresentation?: SequenceScrollPresentation | null;

  onContextMenu?: (
    event: React.MouseEvent,
    selection: Selection | null,
    contextInfo: {
      isOnNucleotideRow: boolean;
      position: number | null;

      annotation: Annotation | null;

      translatedCDS?: Annotation | null;

      orf?: ORF | null;
    }
  ) => void;

  showMinimap?: boolean;

  onViewportChange?: (range: ViewportRange, source?: ViewportChangeSource) => void;

  primers?: PrimerDisplay[];

  viewCursor?: number | null;

  onViewCursorChange?: (position: number | null) => void;

  highlightedRange?: Selection | null;

  onHighlightedRangeChange?: (range: Selection | null) => void;

  onHighlightedRangePreview?: (range: Selection | null) => void;

  rulerSegments?: RulerSegment[];

  selectedAssemblyScaffoldRegionId?: string | null;

  onAssemblyScaffoldSelect?: (regionId: string) => void;

  junctionIndicators?: JunctionIndicator[];

  mutations?: MutationMarker[];

  onMutationClick?: (mutation: MutationMarker) => void;

  orfs?: ORF[];
  onOrfsPresented?: OrfPresentation['presented'];

  candidateOrf?: { start: number; end: number; strand: '+' | '-' } | null;

  forcedSelectedAnnotation?: {
    type: string;
    name: string;
    start: number;
    end: number;
    direction: number;
  } | null;

  selectedAnnotation?: AnnotationStateIdentity | null;

  onSelectedAnnotationChange?: (annotation: AnnotationStateIdentity | null) => void;

  rulerDecorations?: RulerDecoration[];

  changedAnnotationNames?: Set<string>;

  searchMatches?: import('@waypoint/sequence-utils').SearchMatch[];

  activeSearchIndex?: number;

  previewCDS?: import('@waypoint/sequence-utils').Annotation | null;

  bpHighlights?: ReadonlyArray<BpHighlight>;

  onHoveredCodonChange?: (codon: { start: number; end: number; strand: 1 | -1 } | null) => void;

  residueSelectionReferenceId?: string | null;
}

export interface JunctionIndicator {
  position: number;

  leftColor?: string;

  rightColor?: string;
}

export interface RulerSegment {
  start: number;

  end: number;

  color: string;

  label?: string;

  rulerStrokeWidth?: number;

  alpha?: number;

  scaffold?: AssemblyScaffold;

  regionId?: string;
}

export interface RulerDecoration {
  start: number;

  end: number;

  color: string;

  layer: string;

  style: 'solid' | 'strikethrough' | 'caret';

  metadata?: Record<string, unknown>;
}

export type { AnnotatedSequence, Annotation, AnnotationColorMode } from '@waypoint/sequence-utils';
