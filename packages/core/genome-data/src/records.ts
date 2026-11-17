export interface AnnotationRecord {
  chrom: string;
  start: number;
  end: number;
  name?: string;
  color?: number;
  strand?: '+' | '-' | '.';
  extra?: Record<string, unknown>;
}

export interface TranscriptRecord {
  chrom: string;
  start: number;
  end: number;
  transcriptId: string;
  geneId?: string;
  geneName?: string;
  strand: '+' | '-';
  transcriptType?: string;
  exons: ReadonlyArray<{ start: number; end: number }>;
  cds: ReadonlyArray<{ start: number; end: number; phase?: 0 | 1 | 2 }>;
  color?: number;
  extra?: Readonly<Record<string, unknown>>;
}

export interface PeakRecord extends AnnotationRecord {
  summit?: number;
  score?: number;
  signalValue?: number;
  pValue?: number;
  qValue?: number;
}

export interface RepeatRecord extends AnnotationRecord {
  repeatClass?: string;
  repeatFamily?: string;
}

export interface QuantitativeBin {
  chrom: string;
  start: number;
  end: number;
  value: number;
}

export interface VariantRecord {
  readonly id: string;
  readonly recordId: string | null;
  readonly chrom: string;
  readonly start: number;
  readonly end: number;
  readonly position: number;
  readonly ref: string;
  readonly alts: ReadonlyArray<string>;
  readonly quality: number | null;
  readonly filters: ReadonlyArray<string>;
  readonly variantClass:
    | 'substitution'
    | 'insertion'
    | 'deletion'
    | 'replacement'
    | 'mixed'
    | 'structural';
  readonly genotypes: Readonly<Record<string, string>>;
}

export interface PileupMismatch {
  pos: number;
  kind: 'sub' | 'ins' | 'del';
  length?: number;
  refBase?: string;
  readBase?: string;
  baseQ?: number;
}

export interface PileupAlternateColumn {
  pos: number;
  kind: PileupMismatch['kind'];
  length: number;
  refBase?: string;
  readBase?: string;
  coveringReadCount: number;
  supportingReadCount: number;
  weightedDepth: number;
  weightedSupport: number;
  weightedFraction: number;
}

export interface PileupReadPair {
  paired: true;
  properPair?: boolean;
  readNumber?: 1 | 2;
  mateUnmapped?: boolean;
  mateReverse?: boolean;
  mateStart?: number;
  templateLength?: number;
}

export interface PileupRecord {
  chrom: string;
  start: number;
  end: number;
  alignmentStart?: number;
  readId: string;
  flag?: number;
  strand: '+' | '-';
  mapq: number;
  pair?: PileupReadPair;
  mismatches?: ReadonlyArray<PileupMismatch>;
}

export type CoverageRevision = string;

export interface CoverageSignal {
  coverageRevision?: CoverageRevision;
  startBp?: number;
  bins: ReadonlyArray<number>;
  binSize: number;
  maxDepth: number;
  depthPercentiles?: {
    p50: number;
    p90: number;
    p95: number;
    p99: number;
    max: number;
  };
  provenance?: {
    exact: boolean;
    method: string;
    source?: string;
    sourceLevel?: number;
    sourceBinSize?: number;
  };
}

export interface CoverageLodMetadata {
  role: 'current-lod' | 'resident-floor' | 'mixed-resident-fill';
  level: number;
  targetLevel: number;
  binSize: number;
  authority?:
    | 'native-target'
    | 'same-level-resident'
    | 'target-grid-derived-from-finer'
    | 'best-available-resident'
    | 'mixed-resident-fill';
  provenanceExact?: boolean;
  provenanceMethod?: string;
  provenanceSource?: string;
  sourceLevel?: number;
  sourceBinSize?: number;
  residentLevel?: number;
  residentBinSize?: number;
  currentCoveredFraction?: number;
}

export interface PileupReferenceInterval {
  readonly startBp: number;
  readonly endBp: number;
  readonly state: 'pending' | 'empty';
}

export interface PileupTrackData {
  records?: ReadonlyArray<PileupRecord>;
  coverage?: CoverageSignal;
  alternateColumns?: ReadonlyArray<PileupAlternateColumn>;
  coverageCutoffDepth?: number;
  coverageLod?: CoverageLodMetadata;
  coverageGpuAtlas?: CoverageGpuAtlas;
  coverageGpuAtlasPresentation?: 'active' | 'handoff-hold' | 'standby';
  dataAuthority: 'tile-engine' | 'static';
  readSource?: {
    truncated?: boolean;
    windowStartBp?: number;
    windowEndBp?: number;
    sourceGenerationKey?: string;
    presentationOwnerKey?: string;
  };
  referenceIntervals?: ReadonlyArray<PileupReferenceInterval>;
  experimentalReadHandoff?: {
    readonly kind: 'bigwig-height-morph-to-reads';
    readonly morphDurationMs: number;
    readonly readsLoading?: boolean;
    readonly histogramPendingIntervals?: ReadonlyArray<PileupReferenceInterval>;
    readonly loadingAnimation?: PileupHistogramLoadingAnimation;
  };
}

export type PileupHistogramLoadingAnimation =
  | 'diagonal-scan'
  | 'read-pulse-trains'
  | 'read-waterfall'
  | 'read-row-pack'
  | 'paired-read-shuttle'
  | 'coverage-wavefront'
  | 'coverage-scanner'
  | 'depth-breath'
  | 'locus-ripples'
  | 'base-spark-bursts'
  | 'quiet-current';

export interface CoverageGpuAtlasChromosome {
  readonly chrom: string;
  readonly globalStartBp: number;
  readonly globalEndBp: number;
  readonly baseBinCount: number;
  readonly rowStart: number;
  readonly rowCount: number;
}

export interface CoverageGpuAtlas {
  readonly contract: 'coverage-gpu-atlas.v1';
  readonly authorityKey: string;
  readonly sourceIdentity: string;
  readonly assemblyFingerprint: string;
  readonly statistic: string;
  readonly payloadRevision: string;
  readonly assemblyStartBp: 0;
  readonly assemblyEndBp: number;
  readonly baseBinSizeBp: number;
  readonly textureWidth: number;
  readonly textureHeight: number;
  readonly data: Float32Array;
  readonly depthPercentiles: Readonly<{
    p50: number;
    p90: number;
    p95: number;
    p99: number;
    max: number;
  }>;
  readonly chromosomes: ReadonlyArray<CoverageGpuAtlasChromosome>;
}
