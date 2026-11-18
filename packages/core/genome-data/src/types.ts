import type { GenericFilehandle } from 'generic-filehandle2';

export type ZoomLevel = number;

export interface IndexedGenomeManifest {
  chrom: string;
  fastaPath: string;
  faiPath: string;
  gziPath?: string | null;
  gffPath?: string | null;
  tbiPath?: string | null;
  length?: number;
  circular?: boolean;
  workspaceRootPaths?: string[];
}

export interface GenomeFeature {
  chrom: string;
  source: string;
  type: string;
  start: number;
  end: number;
  score: string | null;
  strand: '+' | '-' | '.';
  phase: string | null;
  attributes: Record<string, string[]>;
  sourceAnnotationAliases?: readonly string[];
  raw: string;
  fileOffset?: number;
}

export interface FeatureDetailsRequest {
  chrom: string;
  start: number;
  end: number;
  featureId?: string;
  maxWindowBp?: number;
}

export interface FeatureDetails {
  chrom: string;
  featureId?: string;
  feature: GenomeFeature | null;
  relatedFeatures: GenomeFeature[];
  sourceRecordCount: number;
  window: {
    start: number;
    end: number;
  };
  truncated: boolean;
}

export interface BpInterval {
  start: number;
  end: number;
}

export type CompositeFeatureKind =
  | 'transcript'
  | 'compound-cds'
  | 'disrupted-locus'
  | 'compound-feature';

export type CompositeJunctionRelation = 'gap' | 'adjacent' | 'overlap';

export type CompositeJunctionInterpretation =
  | 'intron'
  | 'ribosomal-slippage-plus-one'
  | 'ribosomal-slippage-minus-one'
  | 'trans-splicing'
  | 'artificial'
  | 'disruption'
  | 'adjacent'
  | 'unknown';

export interface CompositeFeatureJunction {
  afterPartIndex: number;
  gapBp: number;
  relation: CompositeJunctionRelation;
  interpretation: CompositeJunctionInterpretation;
  evidence: ReadonlyArray<string>;
}

export interface ResolvedTranscript extends GenomeFeature {
  exons: ReadonlyArray<BpInterval>;
  cds: ReadonlyArray<BpInterval>;
  translation?: string;
  transcriptId: string;
  geneId?: string;
  compositeKind?: CompositeFeatureKind;
  junctions?: ReadonlyArray<CompositeFeatureJunction>;
}

export interface ResolvedGene extends GenomeFeature {
  transcripts: ReadonlyArray<ResolvedTranscript>;
  geneId: string;
}

export type ResolvedAnnotation = ResolvedGene | ResolvedTranscript | GenomeFeature;

export function isResolvedTranscript(f: ResolvedAnnotation): f is ResolvedTranscript {
  return 'exons' in f && 'cds' in f && 'transcriptId' in f;
}

export function isResolvedGene(f: ResolvedAnnotation): f is ResolvedGene {
  return 'transcripts' in f && 'geneId' in f && !('exons' in f);
}

export interface SearchHit {
  chrom: string;
  start: number;
  end: number;
  strand: 'forward' | 'reverse';
  motif: string;
}

export interface SearchOpts {
  start?: number;
  end?: number;
  chunkSize?: number;
  maxResults?: number;
  reverseComplement?: boolean;
  caseSensitive?: boolean;
  validateIupacDna?: boolean;
  signal?: AbortSignal;
}

export interface GenomeDataRequestOptions {
  signal?: AbortSignal;
}

export interface GenomeDataSource {
  getSequence(
    chrom: string,
    start: number,
    end: number,
    options?: GenomeDataRequestOptions
  ): Promise<string>;
  getFeatures(
    chrom: string,
    start: number,
    end: number,
    zoomLevel: ZoomLevel,
    options?: GenomeDataRequestOptions
  ): Promise<GenomeFeature[]>;
  getFeatureDetails?(
    request: FeatureDetailsRequest,
    options?: GenomeDataRequestOptions
  ): Promise<FeatureDetails>;
  searchSequence(chrom: string, motif: string, opts?: SearchOpts): AsyncIterable<SearchHit>;
  getChromosomeLength(chrom: string): Promise<number>;
  close?(): Promise<void>;
}

export interface LocalIndexedGenomeDataSourceOptions {
  sequenceBlockSize?: number;
  featureBucketSize?: number;
  sequenceCacheEntries?: number;
  featureCacheEntries?: number;
  searchChunkSize?: number;
  defaultMaxSearchResults?: number;
  checkFileMtimeOnRead?: boolean;
}

export interface IndexedGenomeDataSourceOptions extends LocalIndexedGenomeDataSourceOptions {
  openFile?: (path: string) => GenericFilehandle;
  fingerprintFiles?: (paths: readonly string[]) => Promise<string>;
}
