import type {
  ComparisonProjection,
  ComparisonCamera,
  ComparisonHit,
} from './comparison-projection';
import type { AnnotationRolePaletteOverridesV1 } from './annotation-role-palette';
import type { ContactCamera, ContactHit, ContactProjection } from './contact-projection';
export interface AnnotationChangeDecoration {
  readonly kind: 'added' | 'modified' | 'removed';

  readonly color?: number;

  readonly ranges?: ReadonlyArray<{ readonly start: number; readonly end: number }>;
}

export interface LinearSequencePresentation {
  readonly minSequencePixelsPerBp?: number;
  readonly maxSequencePixelsPerBp?: number;
  readonly cdsSizing?: 'canvas' | 'indexed' | 'cohesive';
  readonly aminoAcidColorScheme?: string;
  readonly showTranslation?: boolean;
  readonly cdsComparisonLayout?: 'rows' | 'shared' | 'diff';
  readonly codingFeatures?: ReadonlyMap<
    number,
    {
      readonly source: 'reference' | 'query';
      readonly codons: readonly import('./biology/translation').CodonInfo[];
      readonly introns: readonly import('./biology/translation').IntronInfo[];
    }
  >;
  readonly referenceCoding?: {
    readonly genome: Genome;
    readonly bioToColumn: (base: number) => number | null;
    readonly columnToBio: (column: number) => number | null;
  };
  readonly annotationColors?: ReadonlyMap<number, number>;
  readonly annotationDataColors?: import('./annotation-data-appearance').AnnotationDataColorsV1;
  readonly annotationUnchangedColor?: number;
  readonly showReverseComplement?: boolean;
  readonly alignedQuery?: string;
  readonly referenceRow?: 'forward' | 'secondary';
  readonly nucleotideChanges?: ReadonlyArray<{
    readonly start: number;
    readonly end: number;
    readonly kind: 'insertion' | 'deletion' | 'substitution';
    readonly color: number;
    readonly style?: import('@waypoint/sequence-utils/sequence-edit-markup').SequenceEditMarkupStyle;
  }>;

  readonly biologicalGenome?: Genome;
  readonly bioToColumn?: (zeroBasedBio: number) => number | null;
  readonly columnToBio?: (column: number) => number | null;
}

export interface Feature {
  codingGhostOnly?: boolean;
  codingSource?: 'reference' | 'query';
  codingSourceFeatureId?: number;
  id: number;
  type: string;

  annotationTrackId?: string;

  annotationTrackLane?: number;

  annotationTrackLaneCapacity?: number;

  start: number;
  end: number;
  direction: 'forward' | 'reverse' | 'none';
  displayName: string;
  color: number;

  outlineOnly?: boolean;
  lane: number;
  cdsLane?: number;

  segments?: Array<{ start: number; end: number }>;

  exons?: ReadonlyArray<{ start: number; end: number }>;
  cds?: ReadonlyArray<{ start: number; end: number }>;

  transcriptId?: string;

  compositeKind?: 'transcript' | 'compound-cds' | 'disrupted-locus' | 'compound-feature';

  sourceId?: string;

  sourceAnnotationAliases?: readonly string[];

  canonicalIdentity?: string;

  qualifiers?: Record<string, string | undefined>;

  qualifierValues?: Readonly<Record<string, readonly string[]>>;
}

export interface Primer {
  id: string;
  sourcePrimerId?: string;
  renderId: number;
  name: string;
  start: number;
  end: number;
  direction: 'forward' | 'reverse';
  color: number;
  bases: string;
  overhangLength?: number;

  editablePbsEndpoint?: boolean;
  pbsColor?: number;
  overhangColor?: number;
  spacerLength?: number;
  cutPositionInOverhang?: number;
  enzymeName?: string;
  suppressCutSiteRendering?: boolean;
  recognitionStart?: number;
  recognitionEnd?: number;
  scarAbsolutePosition?: number;
  cognate4bpLength?: number;
  synthetic4bpSpacerLength?: number;
  junctionIndex?: number;
  isScarMarkerOnly?: boolean;
  mismatches?: Array<{ position: number }>;

  isDraft?: boolean;

  isCandidate?: boolean;
}

export interface PrimerHandleDragPreview {
  boundaryBp: number;
  bases: string;
  tm: number;
  gc: number;
}

export interface BackboneSegment {
  start: number;

  end: number;
  color: number;
  label?: string;
  strokeWidth?: number;
  alpha?: number;

  themeStableColor?: boolean;
  labelPosition?: number;

  regionId?: string;

  scaffold?: import('@waypoint/sequence-utils').AssemblyScaffold;

  selected?: boolean;
}

export interface BackboneBoundaryHandle {
  regionId: string;
  side: 'upstream' | 'downstream';
  rangeStart: number;
  rangeEnd: number;

  boundaryBp: number;
  color: number;
}

export interface GenomeOrf {
  start: number;

  end: number;
  frame: number;
  strand: '+' | '-';
  length: number;
}

export interface GenomeOrfIdentity {
  start: number;
  end: number;
  strand: '+' | '-';
}

export interface SequenceWindow {
  startBp: number;

  bases: string;
}

export interface AnnotationSourcePlacementProvenanceV1 {
  readonly contract: 'validated-annotation-source-placement.v1';
  readonly sourceFingerprint: string;
  readonly placementFingerprint: string;
}

export interface Genome {
  name: string;

  formatRulerLabel?: (displayColumn: number, step: number) => string | null;

  sourceIdentity?: string;

  annotationSourcePlacementProvenance?: AnnotationSourcePlacementProvenanceV1;
  length: number;
  circular: boolean;

  annotationLayout?: {
    maxAnnotationLane: number;
    maxCdsLane: number;
  };

  annotationLayerTypes?: string[];

  annotationExactCoverage?: ReadonlyArray<{
    startBp: number;
    endBp: number;
  }>;

  features?: Feature[];
  primers?: Primer[];
  orfs?: GenomeOrf[];
  candidateOrf?: GenomeOrfIdentity | null;

  geneticCode?: import('@waypoint/sequence-utils').GeneticCodeSpec;
  geneticCodeBasis?: import('@waypoint/sequence-utils').RecordGeneticCodeBasis;
  nucleicAcid?: import('@waypoint/sequence-utils').NucleicAcid;

  sequence?: string;
  strandOverrides?: import('@waypoint/sequence-utils').SequenceStrandOverride[];

  sequenceAvailable?: boolean;

  sequenceWindow?: SequenceWindow;
}

export interface AnnotationPresentationSnapshot {
  readonly contract: 'annotation-presentation-snapshot.v1';

  readonly sourceIdentity: string;

  readonly genomeLengthBp: number;

  readonly policyKey: string;

  readonly generation: number;

  readonly features: ReadonlyArray<Feature>;

  readonly requestedLayerTypes: ReadonlyArray<string>;

  readonly layout: Readonly<{
    maxAnnotationLane: number;
    maxCdsLane: number;
  }>;

  readonly exactCoverage: ReadonlyArray<
    Readonly<{
      startBp: number;
      endBp: number;
    }>
  >;
}

export type AnnotationFlatPresentationSnapshot = AnnotationPresentationSnapshot;

interface AnnotationResidentPagePublicationFields {
  readonly sourceIdentity: string;
  readonly genomeLengthBp: number;
  readonly policyKey: string;
  readonly generation: number;

  readonly requestedLayerTypes: ReadonlyArray<string>;
  readonly exactCoverage: AnnotationPresentationSnapshot['exactCoverage'];
  readonly pages: ReadonlyArray<AnnotationPresentationPage>;
}

export interface AnnotationFullBodyResidentPagePublication extends AnnotationResidentPagePublicationFields {
  readonly contract: 'annotation-resident-page-publication.v1';
}

export interface AnnotationCodonCarrierPagePublication extends AnnotationResidentPagePublicationFields {
  readonly contract: 'annotation-codon-carrier-page-publication.v1';
}

export type AnnotationResidentPagePublication =
  | AnnotationFullBodyResidentPagePublication
  | AnnotationCodonCarrierPagePublication;

export interface AnnotationPresentationPage {
  readonly contract: 'annotation-presentation-page.v1';

  readonly pageKey: string;
  readonly chromosomeId: string;
  readonly trackId: string;

  readonly trackOrder: number;

  readonly laneCapacity: number;
  readonly ownerStartBp: number;
  readonly ownerEndBp: number;

  readonly maxFeatureEndBp: number;

  readonly contentRevision: string;

  readonly features: ReadonlyArray<Feature>;
}

export type AnnotationPresentationSnapshotRejectionReason =
  | 'no-genome'
  | 'source-mismatch'
  | 'length-mismatch'
  | 'invalid-contract'
  | 'stale-generation'
  | 'generation-collision';

export type AnnotationPresentationSnapshotApplyResult =
  | {
      readonly status: 'applied';
      readonly generation: number;

      readonly invalidatedHover: true;
    }
  | { readonly status: 'noop'; readonly generation: number }
  | {
      readonly status: 'rejected';
      readonly reason: AnnotationPresentationSnapshotRejectionReason;
    };

export type AnnotationResidentPagePublicationApplyResult =
  AnnotationPresentationSnapshotApplyResult;

export type GenomeTileRendererMode = 'tile-native-session-shell';
export type GenomeTileRendererTrackKind =
  | 'sequence'
  | 'annotation'
  | 'alignment'
  | 'variant'
  | 'signal';
export type GenomeTileRendererLengthState = 'length_unknown' | 'coordinate_ready';

export interface GenomeTileRendererViewport {
  chrom: string;
  startBp: number;
  endBp: number;
  widthPx: number;
  heightPx: number;
  pixelsPerBp: number;
  generation: number;
}

export interface GenomeTileRendererTrack<
  TrackState extends string = string,
  TrackUserState extends string = string,
  TrackKind extends string = GenomeTileRendererTrackKind,
> {
  id: string;
  kind: TrackKind;
  label: string;
  state: TrackState;
  userState: TrackUserState;
  message?: string;
}

export interface GenomeTileRendererSequencePayload {
  type: 'sequence';
  startBp: number;
  endBp: number;
  bases: string;
}

export interface GenomeTileRendererAnnotationGlyph {
  id: string;
  type: string;

  trackId?: string;

  trackLane?: number;

  trackLaneCapacity?: number;
  label: string;
  startBp: number;
  endBp: number;
  strand: '+' | '-' | '.';
  lane: number;
  color: number;

  exons?: ReadonlyArray<{ start: number; end: number }>;

  cds?: ReadonlyArray<{ start: number; end: number }>;
  transcriptId?: string;
  qualifiers?: Record<string, string | undefined>;
}

type GenomeTileRendererCompactAnnotationGlyphBase = [
  id: string,
  type: string,
  label: string,
  startBp: number,
  endBp: number,
  strand: '+' | '-' | '.',
  lane: number,
];

export type GenomeTileRendererCompactAnnotationGlyph =
  | GenomeTileRendererCompactAnnotationGlyphBase
  | [...GenomeTileRendererCompactAnnotationGlyphBase, trackId: string]
  | [...GenomeTileRendererCompactAnnotationGlyphBase, trackId: string, trackLane: number]
  | [
      ...GenomeTileRendererCompactAnnotationGlyphBase,
      trackId: string,
      trackLane: number,
      trackLaneCapacity: number,
    ];

export type GenomeTileRendererCompactAnnotationGlyphGeometry =
  | [id: string, exonRanges: number[]]
  | [id: string, exonRanges: number[], cdsRanges: number[]]
  | [id: string, exonRanges: number[], cdsRanges: number[], transcriptId: string];

export interface GenomeTileRendererAnnotationGlyphPayload {
  type: 'annotation-glyphs';
  featureModel: string;
  glyphs: GenomeTileRendererAnnotationGlyph[];
  compactGlyphs?: GenomeTileRendererCompactAnnotationGlyph[];
  compactGeometry?: GenomeTileRendererCompactAnnotationGlyphGeometry[];
  styleByType?: Record<string, { color: number }>;
  laneBounds?: {
    maxAnnotationLane: number;
    maxCdsLane: number;
  };
  droppedCount: number;
  typeFilteredCount: number;
}

export type GenomeTileRendererSlotPayload =
  | GenomeTileRendererSequencePayload
  | GenomeTileRendererAnnotationGlyphPayload;

export interface GenomeTileRendererSlot<
  TileState extends string = string,
  TileFidelity extends string = string,
  ValidationState extends string = string,
  CacheState extends string = string,
  TrackKind extends string = GenomeTileRendererTrackKind,
> {
  trackId: string;
  kind: TrackKind;
  chrom: string;
  startBp: number;
  endBp: number;
  generation: number;
  state: TileState;
  fidelity: TileFidelity;
  validationState: ValidationState;
  cacheState: CacheState;
  byteCount: number;
  recordCount: number;
  layerTypes?: string[];
  currentForViewport: boolean;

  laneEpoch?: string;
  payload?: GenomeTileRendererSlotPayload;
}

export interface GenomeTileRendererScene<
  TrackState extends string = string,
  TrackUserState extends string = string,
  TileState extends string = string,
  TileFidelity extends string = string,
  ValidationState extends string = string,
  CacheState extends string = string,
  TrackKind extends string = GenomeTileRendererTrackKind,
> {
  mode: GenomeTileRendererMode;
  sessionId: string;
  sourceId: string;
  sourceFingerprint: string;
  chrom: string;
  lengthState: GenomeTileRendererLengthState;
  length: number | null;
  coordinateReady: boolean;
  validationState: ValidationState;
  laneEpoch: string;
  viewport: GenomeTileRendererViewport | null;
  tracks: GenomeTileRendererTrack<TrackState, TrackUserState, TrackKind>[];
  tileSlots: GenomeTileRendererSlot<
    TileState,
    TileFidelity,
    ValidationState,
    CacheState,
    TrackKind
  >[];
}

const EMPTY_FEATURES: Feature[] = [];

export function genomeFeatures(genome: Genome): Feature[] {
  return genome.features ?? EMPTY_FEATURES;
}

export interface AnnotationSearchFocus {
  readonly trackId: string;
  readonly canonicalIdentity: string;

  readonly presentation?: 'temporary-additional-lane';
}

export interface RenderState {
  comparisonProjection?: ComparisonProjection | null;
  comparisonCamera?: ComparisonCamera | null;
  hoveredComparison?: ComparisonHit | null;
  selectedComparison?: ComparisonHit | null;
  contactProjection?: ContactProjection | null;
  contactCamera?: ContactCamera | null;
  hoveredContact?: ContactHit | null;
  selectedContact?: ContactHit | null;
  performanceMode?: 'default' | 'stability';
  morph: number;
  viewOffset: number;
  zoom: number;
  width: number;

  geometryHeight?: number;
  centerStadiumOverview?: boolean;
  height: number;
  themeMode?: 'light' | 'dark';

  annotationRolePalette?: AnnotationRolePaletteOverridesV1;
  selectedIds: Set<number>;

  selectedCanonicalIdentities?: Set<string>;

  annotationSearchFocus?: AnnotationSearchFocus | null;

  annotationSearchFocusFeature?: Feature | null;
  hoveredId: number | null;
  viewportRange?: [number, number] | null;
  viewportIndicatorVisible?: boolean;
  highlightRange: [number, number] | null;

  annotationChangeDecorations?: ReadonlyMap<number, AnnotationChangeDecoration>;
  sequencePresentation?: LinearSequencePresentation;

  proteinSearchHighlightRanges?: ReadonlyArray<readonly [number, number]> | null;

  digestFocusRange?: [number, number] | null;

  residueLinkRange?: [number, number] | null;
  cursorPosition: number | null;
  cursorBlinking?: boolean;
  hoverPosition?: number | null;
  hoveredCodon?: {
    codingSource?: 'reference' | 'query';
    start: number;
    end: number;
    strand: 1 | -1;
    mutation?: import('./biology/translation').CodonMutationInfo;
  } | null;
  selectedCodons?: ReadonlyArray<{ start: number; end: number; strand: 1 | -1 }>;

  showResidueNumbers?: boolean;
  hoveredOrf?: GenomeOrfIdentity | null;
  selectedOrf?: GenomeOrfIdentity | null;
  hoveredCutSiteId: string | null;
  perfPanelVisible: boolean;
  backboneSegments?: BackboneSegment[];
  backboneBoundaryHandles?: BackboneBoundaryHandle[];
}

export enum LODTier {
  Hidden = 0,
  Rect = 1,
  Arrow = 2,
  Detailed = 3,
  Sequence = 4,
}
