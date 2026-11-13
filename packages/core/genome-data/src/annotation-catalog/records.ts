export const FEATURE_KINDS = ['promoter', 'terminator', 'transcription_unit', 'tss'] as const;
export type FeatureKind = (typeof FEATURE_KINDS)[number];

export const FEATURE_KIND_LABELS: Readonly<Record<FeatureKind, string>> = {
  promoter: 'Promoters',
  terminator: 'Terminators',
  transcription_unit: 'Transcription units',
  tss: 'Transcription start sites',
};

export type Strand = '+' | '-';

export interface PointLocation {
  readonly shape: 'point';
  readonly bp: number;
}

export interface RegionLocation {
  readonly shape: 'region';
  readonly start: number;
  readonly end: number;
}

export type FeatureLocation = PointLocation | RegionLocation;

export interface FeatureSpan {
  readonly start: number;
  readonly end: number;
}

interface RecordBase {
  readonly id: string;
  readonly strand: Strand;
  readonly name: string | null;
  readonly score: number | null;
  readonly conditions: readonly string[];
}

export interface PromoterBox extends FeatureSpan {
  readonly element: 'minus10' | 'minus35';
}

export interface PromoterRecord extends RecordBase {
  readonly kind: 'promoter';
  readonly location: FeatureLocation;
  readonly transcriptionStartBp: number | null;
  readonly boxes: readonly PromoterBox[];
  readonly sigmaFactor: string | null;
}

export type TerminationMechanism = 'intrinsic' | 'rho-dependent' | 'unclassified';

export interface TerminatorPart extends FeatureSpan {
  readonly element: 'stem' | 'loop' | 'u-tract';
}

export interface TerminatorRecord extends RecordBase {
  readonly kind: 'terminator';
  readonly location: FeatureLocation;
  readonly mechanism: TerminationMechanism;
  readonly parts: readonly TerminatorPart[];
  readonly terminationBp: number | null;
  readonly peakBp: number | null;
}

export interface TranscriptionStartSiteRecord extends RecordBase {
  readonly kind: 'tss';
  readonly location: PointLocation;
  readonly classification: string | null;
}

export type UnitEndEvidence = 'measured' | 'gene-derived';

export interface TranscriptionUnitRecord extends RecordBase {
  readonly kind: 'transcription_unit';
  readonly location: RegionLocation;
  readonly endEvidence: UnitEndEvidence | null;
  readonly genes: readonly string[];
  readonly geneLocusTags: readonly string[];
}

export type CatalogRecord =
  | PromoterRecord
  | TerminatorRecord
  | TranscriptionStartSiteRecord
  | TranscriptionUnitRecord;

export type RecordOfKind<K extends FeatureKind> = Extract<CatalogRecord, { kind: K }>;

export function isFeatureKind(value: string): value is FeatureKind {
  return (FEATURE_KINDS as readonly string[]).includes(value);
}

export function locationSpan(location: FeatureLocation): FeatureSpan {
  switch (location.shape) {
    case 'point':
      return { start: location.bp, end: location.bp + 1 };
    case 'region':
      return { start: location.start, end: location.end };
    default: {
      const _exhaustive: never = location;
      return _exhaustive;
    }
  }
}

export function recordSpan(record: CatalogRecord): FeatureSpan {
  return locationSpan(record.location);
}

export function recordAnchorBp(record: CatalogRecord): number {
  const { start, end } = recordSpan(record);
  switch (record.kind) {
    case 'tss':
      return start;
    case 'promoter':
      return record.transcriptionStartBp ?? (record.strand === '+' ? end - 1 : start);
    case 'terminator':
      return record.terminationBp ?? record.peakBp ?? (record.strand === '+' ? end - 1 : start);
    case 'transcription_unit':
      return record.strand === '+' ? start : end - 1;
    default: {
      const _exhaustive: never = record;
      return _exhaustive;
    }
  }
}
