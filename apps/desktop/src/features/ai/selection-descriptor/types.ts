import type { ColoredCutSite, ORF } from '@waypoint/sequence-utils';
import type { PrimerDisplay } from '@waypoint/workspace-editor';
import type { ResidueLocation } from '../../page/public/embeds/structure3d/types';

export interface ActiveOverlaySnapshot {
  restrictionSites: { visible: boolean; sites: ColoredCutSite[] };
  orfs: { visible: boolean; items: ORF[] };
  primers: { visible: boolean; items: PrimerDisplay[] };
}

export type UntrustedTrust = 'untrusted-data';

export interface UntrustedText {
  value: string;
  trust: UntrustedTrust;
}

export type FileTextMap = Record<string, UntrustedText>;

export type SelectionDescriptorKind =
  | 'sequence_region'
  | 'annotation'
  | 'whole_entity'
  | 'structure';

export interface DescriptorLocator {
  documentId?: string;
  path?: string;
  refId?: string;
  resourceUri?: string;
}

export interface RawFallback {
  tool: 'get_selection_bases';
  refId?: string;
  start: number;
  end: number;
  wraps: boolean;
  capBp: number;
  capped: boolean;
  approxTokens: number;
  note: string;
}

export interface DescriptorFetch {
  tools: string[];
  rawFallback?: RawFallback;
}

export interface SelectionDescriptorEnvelope<M> {
  schemaVersion: 2;
  kind: SelectionDescriptorKind;
  label: string;
  locator: DescriptorLocator;
  coordinateSystem: '1-indexed-inclusive' | 'auth_seq_id-1-indexed-inclusive';
  sourceVersion: number;
  measured: M;
  fileText: FileTextMap;
  bases: 'not_included' | 'never';
  fetch: DescriptorFetch;
}

export type RegionStrand = '+' | '-' | 'unspecified' | 'ambiguous-multiple';

export type FeatureStrand = '+' | '-' | 'unspecified';

export type OverlapRelation =
  | 'selection-contains-feature'
  | 'feature-contains-selection'
  | 'partial-overlap';

export interface OverlappingFeature {
  type: string;
  start: number;
  end: number;
  strand: FeatureStrand;
  relation: OverlapRelation;
  name?: string;
  gene?: string;
  product?: string;
}

export interface OverlayLayer<T> {
  visible: boolean;
  items?: T[];
  overflow?: number;
}

export interface OverlappingCutSite {
  enzyme: string;
  recognitionSequence: string;
  start: number;
  end: number;
  strand: '+' | '-';
  cutPosition: number;
  relation: OverlapRelation;
}

export interface OverlappingOrf {
  start: number;
  end: number;
  strand: '+' | '-';
  frame: number;
  lengthBp: number;
  relation: OverlapRelation;
}

export interface OverlappingPrimer {
  name?: UntrustedText;
  start: number;
  end: number;
  strand: '+' | '-';
  relation: OverlapRelation;
}

export interface VisibleOverlaysSnapshot {
  restrictionSites: OverlayLayer<OverlappingCutSite>;
  orfs: OverlayLayer<OverlappingOrf>;
  primers: OverlayLayer<OverlappingPrimer>;
}

export interface ReadingFrameEntry {
  cds: string;
  strand: FeatureStrand;
  phase: 0 | 1 | 2 | 'unknown';
  startCodonAligned: boolean | 'unknown';
  lengthIsCodonMultiple: boolean | 'unknown';
  frameshiftIfDeleted: boolean | 'unknown';
  translTable: number | 'unknown';
  reason: string | null;
  codingBasesInSelection: number;
  intronicBasesInSelection: number;
}

export interface BoundaryFlags {
  spansFeatureBoundary: boolean;
  crossesStartCodon: boolean;
  crossesStopCodon: boolean;
  spansOrigin: boolean;
  crossesExonIntronBoundary: boolean;
  touchesSpliceSite: boolean;
}

export interface SelectionRegionResidue {
  chain: string;
  residueNumber: number;
  proteinResidue?: number;
}

export interface SelectionRegion {
  codingDnaMapped: boolean;
  start?: number;
  end?: number;
  wraps?: boolean;
  strand: FeatureStrand;
  reason?: string;
  residues: SelectionRegionResidue[];
}

export interface SequenceRegionMeasured {
  start: number;
  end: number;
  length: number;
  lengthIsCodonMultiple: boolean;
  lengthModThree: 0 | 1 | 2;
  wraps: boolean;
  topology: 'circular' | 'linear';
  parentLength: number;
  strand: RegionStrand;
  gcPercentWholeSelection: number | null;
  gcComputed: boolean;
  gcSpansHeterogeneous: boolean;
  gcNote: string;
  overlappingFeatures: OverlappingFeature[];
  featureHistogram: Record<string, number>;
  landmarks: string[];
  readingFrames: ReadingFrameEntry[];
  boundaryFlags: BoundaryFlags;
  restrictionSitesComputed: false;
  motifsComputed: false;
  visibleOverlays?: VisibleOverlaysSnapshot;

  disjoint?: boolean;
  regionCount?: number;
  regions?: SelectionRegion[];
}

export type SequenceRegionDescriptor = SelectionDescriptorEnvelope<SequenceRegionMeasured> & {
  kind: 'sequence_region';
  bases: 'not_included';
};

export interface SegmentSummary {
  count: number;
  first: Array<{ start: number; end: number }>;
  last: Array<{ start: number; end: number }>;
  totalCodingBp: number;
}

export interface NeighborFeature {
  type: string;
  name: string;
  distanceBp: number;
}

export interface AnnotationMeasured {
  featureType: string;
  start: number;
  end: number;
  strand: FeatureStrand;
  segments?: SegmentSummary;
  lengthBp: number;
  proteinLengthAa?: number;
  translationAvailable: boolean;
  neighbors: { upstream: NeighborFeature | null; downstream: NeighborFeature | null };
  translTable: number | 'unknown' | null;
}

export type AnnotationDescriptor = SelectionDescriptorEnvelope<AnnotationMeasured> & {
  kind: 'annotation';
  bases: 'not_included';
};

export interface WholeEntityMeasured {
  format: string;
  moleculeType: string;
  topology: 'circular' | 'linear';
  length: number;
  featureCount: number;
  featureHistogram: Record<string, number>;
  landmarks: string[];
  functionalGistIsInferred: boolean;
  metadataAvailable: { definition: boolean; organism: boolean; taxonId: boolean };
}

export type WholeEntityDescriptor = SelectionDescriptorEnvelope<WholeEntityMeasured> & {
  kind: 'whole_entity';
  bases: 'never';
};

export interface StructureResidueRegion {
  start: number;
  end: number;
}

export interface StructureResidueSelection {
  chain: string;
  compId?: string;
  baseChain?: string;
  labelAsymId?: string;
  authAsymId?: string;
  entityId?: string;
  operator?: string;
  regions: StructureResidueRegion[];
}

export interface StructureResidueIdentity {
  chain: string;
  authSeqId: number;
  labelCompId: string;
  oneLetterCode?: string;
  labelSeqId?: number;
  baseChain?: string;
  labelAsymId?: string;
  authAsymId?: string;
  entityId?: string;
  operator?: string;
}

export interface StructureResidueObject {
  chain: string;
  authSeqId: number;
  labelCompId: string | null;
  oneLetterCode: string | null;
  identityStatus: 'known' | 'unknown';
  labelSeqId?: number;
  baseChain?: string;
  labelAsymId?: string;
  authAsymId?: string;
  entityId?: string;
  operator?: string;
}

export interface StructureVisibleRepresentation {
  layerId: string;
  representation: string;
  target: string;
  colorMode: string;
}

export interface LinkedCodingDnaContext {
  documentId: string;
  regions: SelectionRegion[];
}

export interface StructureMeasured {
  structureRef: string;
  residueCount: number;
  regionCount: number;
  disjoint: boolean;
  selections: StructureResidueSelection[];
  residues: StructureResidueObject[];
  residueOmittedCount: number;
  residueIdentities: StructureResidueIdentity[];
  residueIdentityKnownCount: number;
  residueIdentityUnknownCount: number;
  residueIdentityOmittedCount: number;
  visibleRepresentations: StructureVisibleRepresentation[];
  linkedCodingDna?: LinkedCodingDnaContext;
  savedSelectionRef?: {
    selectionId: string;
    revisionId: string;
  };
}

export type StructureSelectionDescriptor = SelectionDescriptorEnvelope<StructureMeasured> & {
  kind: 'structure';
  bases: 'never';
};

export type SelectionDescriptor =
  | SequenceRegionDescriptor
  | AnnotationDescriptor
  | WholeEntityDescriptor
  | StructureSelectionDescriptor;

export interface SequenceDescriptorInput {
  kind: Exclude<SelectionDescriptorKind, 'structure'>;
  documentId: string;
  range?: { start: number; end: number; wraps?: boolean };
  activeOverlays?: ActiveOverlaySnapshot;
  regions?: SelectionRegion[];
}

export interface StructureDescriptorInput {
  kind: 'structure';
  path: string;
  label: string;
  residues: ReadonlyArray<ResidueLocation>;
  visibleRepresentations: StructureVisibleRepresentation[];
  linkedCodingDna?: LinkedCodingDnaContext;
  savedSelectionRef?: {
    selectionId: string;
    revisionId: string;
  };
}

export type DescriptorInput = SequenceDescriptorInput | StructureDescriptorInput;

export interface EmptySelectionMarker {
  kind: 'empty_selection';
  reason: string;
  hint: string;
}

export interface UnavailableMarker {
  kind: 'unavailable';
  reason: string;
}

export type DescriptorBuildResult = SelectionDescriptor | EmptySelectionMarker | UnavailableMarker;

export function isSelectionDescriptor(
  result: DescriptorBuildResult
): result is SelectionDescriptor {
  return (
    result.kind === 'sequence_region' ||
    result.kind === 'annotation' ||
    result.kind === 'whole_entity' ||
    result.kind === 'structure'
  );
}
