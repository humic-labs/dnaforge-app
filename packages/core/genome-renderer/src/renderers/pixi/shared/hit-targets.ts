export interface FeatureHitPayload {
  id: number;
  start: number;
  end: number;

  canonicalIdentity?: string;
  displayName?: string;
  type?: string;
  transcriptId?: string | null;
  sourceId?: string | null;
  lane?: number;
  direction?: 'forward' | 'reverse' | 'none';
}

export interface CodonHitPayload {
  codingSource?: 'reference' | 'query';
  mutation?: import('../../../biology/translation').CodonMutationInfo;
  start: number;
  end: number;
  featureId?: number;
  featureStart?: number;
  featureEnd?: number;
  strand?: 1 | -1;
}

export interface CutSiteHitPayload {
  id: string;
  enzymeName: string;
  position: number;
  recognitionStart: number;
  recognitionEnd: number;
  cutPositionTop: number;
  cutPositionBottom: number;
}

export interface OrfHitPayload {
  start: number;
  end: number;
  strand: '+' | '-';
  frame: number;
  length: number;
}

export interface PrimerHandleHitPayload {
  id: number;
  primerId: string;
  start: number;
  end: number;
  direction: 'forward' | 'reverse';
  overhangLength: number;

  anchorBp: number;
}

export interface BackboneBoundaryHandleHitPayload {
  regionId: string;
  side: 'upstream' | 'downstream';
  rangeStart: number;
  rangeEnd: number;

  boundaryBp: number;
}

export interface BackbonePartHitPayload {
  regionId: string;
  rangeStart: number;
  rangeEnd: number;
  isScaffold?: boolean;
  scaffold?: import('@waypoint/sequence-utils').AssemblyScaffold;
}

export interface BackbonePartReorderPreview {
  ranges: ReadonlyArray<{
    regionId: string;
    rangeStart: number;
    rangeEnd: number;
  }>;
}

export interface PileupColumnHitPayload {
  globalPosition: number;
  chrom: string;

  position: number;
  kind: 'sub' | 'ins' | 'del';
  length: number;
  refBase?: string;
  readBase?: string;
  coveringReadCount: number;
  supportingReadCount: number;
  weightedDepth: number;
  weightedSupport: number;
  weightedFraction: number;
  screenX: number;
  screenY: number;
}

export interface ReadHitPayload {
  trackId: string;

  sourceGenerationKey: string;
  presentationOwnerKey?: string;
  readId: string;
  chrom: string;

  referenceStart: number;

  referenceBlockStart?: number;
  start: number;
  end: number;
  flag?: number;
  strand: '+' | '-';
  mapq: number;
  pair?: {
    paired: true;
    properPair?: boolean;
    readNumber?: 1 | 2;
    mateUnmapped?: boolean;
    mateReverse?: boolean;
    mateStart?: number;
    templateLength?: number;
  };
  event?: {
    pos: number;
    kind: 'sub' | 'ins' | 'del';
    length?: number;
    refBase?: string;
    readBase?: string;
    baseQ?: number;
  };

  bodyRect: { left: number; top: number; width: number; height: number };

  hitRect?: { left: number; top: number; width: number; height: number };

  trackRect?: { left: number; top: number; width: number; height: number };

  column?: PileupColumnHitPayload;

  screenX: number;
  screenY: number;
}

export function readHitIdentityKey(
  read: Pick<
    ReadHitPayload,
    | 'trackId'
    | 'sourceGenerationKey'
    | 'presentationOwnerKey'
    | 'readId'
    | 'chrom'
    | 'referenceStart'
    | 'flag'
    | 'pair'
  >
): string {
  return [
    read.trackId,
    read.sourceGenerationKey,
    read.presentationOwnerKey ?? read.sourceGenerationKey,
    read.readId,
    read.chrom,
    read.referenceStart,
    read.flag ?? '',
    read.pair?.readNumber ?? '',
  ].join('\x00');
}

export type WebGLHitTarget =
  | { kind: 'feature'; payload: FeatureHitPayload }
  | { kind: 'primer-handle'; payload: PrimerHandleHitPayload }
  | { kind: 'backbone-boundary-handle'; payload: BackboneBoundaryHandleHitPayload }
  | { kind: 'backbone-part'; payload: BackbonePartHitPayload }
  | { kind: 'codon'; payload: CodonHitPayload }
  | { kind: 'cut-site'; payload: CutSiteHitPayload }
  | { kind: 'orf'; payload: OrfHitPayload }
  | { kind: 'pileup-column'; payload: PileupColumnHitPayload }
  | { kind: 'read'; payload: ReadHitPayload };

export function featureHitPayload(hit: WebGLHitTarget | null): FeatureHitPayload | null {
  return hit?.kind === 'feature' ? hit.payload : null;
}

export function primerHandleHitPayload(hit: WebGLHitTarget | null): PrimerHandleHitPayload | null {
  return hit?.kind === 'primer-handle' ? hit.payload : null;
}

export function backboneBoundaryHandleHitPayload(
  hit: WebGLHitTarget | null
): BackboneBoundaryHandleHitPayload | null {
  return hit?.kind === 'backbone-boundary-handle' ? hit.payload : null;
}

export function backbonePartHitPayload(hit: WebGLHitTarget | null): BackbonePartHitPayload | null {
  return hit?.kind === 'backbone-part' ? hit.payload : null;
}

export function codonHitPayload(hit: WebGLHitTarget | null): CodonHitPayload | null {
  return hit?.kind === 'codon' ? hit.payload : null;
}

export function cutSiteHitPayload(hit: WebGLHitTarget | null): CutSiteHitPayload | null {
  return hit?.kind === 'cut-site' ? hit.payload : null;
}

export function orfHitPayload(hit: WebGLHitTarget | null): OrfHitPayload | null {
  return hit?.kind === 'orf' ? hit.payload : null;
}

export function readHitPayload(hit: WebGLHitTarget | null): ReadHitPayload | null {
  return hit?.kind === 'read' ? hit.payload : null;
}

export function pileupColumnHitPayload(hit: WebGLHitTarget | null): PileupColumnHitPayload | null {
  return hit?.kind === 'pileup-column' ? hit.payload : null;
}
