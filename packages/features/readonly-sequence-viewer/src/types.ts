export type FeatureDirection = 'forward' | 'reverse' | 'none';

export interface FeatureQualifiers {
  gene?: string[];
  product?: string[];
  note?: string[];
  label?: string[];
  translation?: string[];
  [key: string]: string[] | undefined;
}

export interface PlasmidFeature {
  sourceId?: string;
  canonicalIdentity?: string;
  type: string;
  start: number;
  end: number;
  direction: FeatureDirection;
  qualifiers: FeatureQualifiers;

  displayName: string;
  color: string;

  outlineOnly?: boolean;

  segments?: Array<{ start: number; end: number }>;

  exons?: ReadonlyArray<{ start: number; end: number }>;
  cds?: ReadonlyArray<{ start: number; end: number }>;

  transcriptId?: string;
  compositeKind?: 'transcript' | 'compound-cds' | 'disrupted-locus' | 'compound-feature';
}

export interface OligoMismatch {
  position: number;

  oligoBase: string;

  templateBase: string;
}

export interface Primer {
  id: string;
  sourcePrimerId?: string;
  name: string;
  start: number;
  end: number;
  direction: 'forward' | 'reverse';
  bases: string;

  modificationMarkers?: Array<{ label: string; token: string }>;
  tm: number;
  gc: number;

  mismatches: OligoMismatch[];

  hasExplicitSequence: boolean;

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

  isDraft?: boolean;

  isCandidate?: boolean;
}

export interface ParsedPlasmid {
  name: string;
  length: number;
  circular: boolean;
  sequence: string;
  strandOverrides?: import('@waypoint/sequence-utils').SequenceStrandOverride[];
  features: PlasmidFeature[];
  primers: Primer[];
  definition?: string;
  accession?: string;
  organism?: string;

  geneticCode?: import('@waypoint/sequence-utils').GeneticCodeSpec;
  geneticCodeBasis?: import('@waypoint/sequence-utils').RecordGeneticCodeBasis;
  nucleicAcid?: import('@waypoint/sequence-utils').NucleicAcid;

  sequenceWindow?: { startBp: number; bases: string };
}

export interface FeatureLocation {
  start: number;
  end: number;
  complement: boolean;

  segments?: Array<{ start: number; end: number }>;
}

export { FEATURE_COLORS, getFeatureColor } from '@waypoint/sequence-utils';

export interface PlasmidMapOptions {
  width: number;
  height: number;
  padding: number;
  backboneRadius: number;
  backboneWidth: number;
  featureWidth: number;
  tickLength: number;
  tickInterval: number;
  showLabels: boolean;
  showTicks: boolean;
  fontSize: number;
  fontFamily: string;
}

export const DEFAULT_MAP_OPTIONS: PlasmidMapOptions = {
  width: 600,
  height: 600,
  padding: 80,
  backboneRadius: 200,
  backboneWidth: 3,
  featureWidth: 25,
  tickLength: 8,
  tickInterval: 500,
  showLabels: true,
  showTicks: true,
  fontSize: 11,
  fontFamily: "'Inter', 'Helvetica', sans-serif",
};

export type ReadonlyGenBankInput =
  | { kind: 'bytes'; bytes: Uint8Array }
  | { kind: 'parsed'; plasmid: ParsedPlasmid };

declare const readonlyRenderablePlasmidBrand: unique symbol;

export type ReadonlyRenderablePlasmid = ParsedPlasmid & {
  readonly [readonlyRenderablePlasmidBrand]: true;
};

export type ReadonlyGenBankLoadErrorCode =
  | 'INVALID_ENCODING'
  | 'UNSUPPORTED_FORMAT'
  | 'INVALID_GENBANK';

export interface ReadonlyGenBankLoadError {
  code: ReadonlyGenBankLoadErrorCode;
  message: string;
}

export type ReadonlyGenBankLoadResult =
  | { ok: true; plasmid: ReadonlyRenderablePlasmid }
  | { ok: false; error: ReadonlyGenBankLoadError };

export interface ReadonlySequenceInput {
  kind: 'bytes';
  bytes: Uint8Array;
  filename: string;
}

export type ReadonlySequenceLoadErrorCode =
  | 'INVALID_ENCODING'
  | 'UNSUPPORTED_FORMAT'
  | 'INVALID_SEQUENCE';

export interface ReadonlySequenceLoadError {
  code: ReadonlySequenceLoadErrorCode;
  message: string;
}

export type ReadonlySequenceLoadResult =
  | { ok: true; plasmid: ReadonlyRenderablePlasmid }
  | { ok: false; error: ReadonlySequenceLoadError };
