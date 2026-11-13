import {
  migratePortableGenomeViewDocument,
  PORTABLE_GENOME_VIEW_SCHEMA,
  type AdmittedTrackSource,
  type PortableGenomeViewAnnotationState,
  type PortableGenomeViewDocument,
  type PortableGenomeViewProvenance,
  type PortableGenomeViewReference,
  type PortableGenomeViewTrack,
  type PortableGenomeViewTrackPresentation,
  type PortableGenomeViewTrackSourceRef,
  type PortableGenomeViewViewport,
} from '@waypoint/genome-data';

import type {
  IndexedGenomeBamTrackState,
  IndexedGenomeDataTrackState,
  IndexedGenomeInitialAnnotationMapperPolicy,
  IndexedGenomeScope,
  IndexedGenomeTabState,
  IndexedGenomeVariantSourceState,
} from '../../shared/indexed-genome';
import { bbiAdmissionContentIdentity } from './bbi-admission-content-identity';

export interface PortableGenomeViewLiveViewport {
  readonly chrom: string;
  readonly start0: number;
  readonly end0: number;
}

type ReferenceGenerationForProjection = Pick<
  NonNullable<IndexedGenomeTabState['assemblyAssetGeneration']>,
  'sourceFingerprint' | 'inventoryFingerprint'
>;

export type PortableGenomeViewProjectionState = Pick<
  IndexedGenomeTabState,
  | 'chrom'
  | 'scope'
  | 'dataTracks'
  | 'ucscTracks'
  | 'bamTracks'
  | 'signalReadPileupViews'
  | 'variantSource'
  | 'assemblyReferenceIdentity'
  | 'assemblyPortableBundleFingerprint'
> & {
  readonly assembly?: Pick<NonNullable<IndexedGenomeTabState['assembly']>, 'assemblyId'>;
  readonly assemblyAssetGeneration?: ReferenceGenerationForProjection;
  readonly assemblyAssetGenerationsByTheme?: Partial<
    Record<'light' | 'dark', ReferenceGenerationForProjection>
  >;
};

export interface PortableGenomeViewProjectionInput {
  readonly id: string;
  readonly name: string;
  readonly provenance: PortableGenomeViewProvenance;
  readonly indexedGenome: PortableGenomeViewProjectionState;
  readonly reference: PortableGenomeViewReference;
  readonly liveViewport?: PortableGenomeViewLiveViewport | null;
  readonly assemblyViewportRange?: Readonly<{ start0: number; end0: number }> | null;
  readonly annotation: Readonly<{
    policy: IndexedGenomeInitialAnnotationMapperPolicy;
    visibilityByTrackId: Readonly<Record<string, boolean>>;
    orderedTrackIds: ReadonlyArray<string>;
  }>;
  readonly trackSourceRefsByTrackId?: Readonly<Record<string, PortableGenomeViewTrackSourceRef>>;
  readonly variantPresentation?: Readonly<{
    visible?: boolean;
    filteredToPassing?: boolean;
    selectedSamples?: ReadonlyArray<string>;
  }>;
}

export type PortableGenomeViewProjectionIssueCode =
  | 'duplicate-track-id'
  | 'invalid-document'
  | 'reference-identity-conflict'
  | 'track-identity-conflict'
  | 'unsupported-composed-view'
  | 'unsupported-reference-source'
  | 'unsupported-track-presentation'
  | 'unsupported-track-source';

export interface PortableGenomeViewProjectionIssue {
  readonly code: PortableGenomeViewProjectionIssueCode;
  readonly message: string;
  readonly trackId?: string;
  readonly trackFamily?: 'data' | 'aligned-reads' | 'variants' | 'composition';
}

export type PortableGenomeViewProjectionResult =
  | Readonly<{ status: 'ready'; document: PortableGenomeViewDocument }>
  | Readonly<{ status: 'unsupported'; issues: ReadonlyArray<PortableGenomeViewProjectionIssue> }>;

export interface RestoredPortableGenomeViewState {
  readonly reference: PortableGenomeViewReference;
  readonly indexedGenomeView: Readonly<{
    scope: IndexedGenomeScope;
    indexedViewport: { start0: number; end0: number } | null;
    viewportTarget: PortableGenomeViewLiveViewport | null;
    viewport: PortableGenomeViewViewport;
  }>;
  readonly annotation: PortableGenomeViewAnnotationState;
  readonly tracks: ReadonlyArray<PortableGenomeViewTrack>;
}

interface TrackCandidate {
  readonly family: 'data' | 'aligned-reads' | 'variants';
  readonly insertionIndex: number;
  readonly requestedOrder: number | undefined;
  readonly trackId: string;
  readonly trackType: string;
  readonly label: string;
  readonly visible: boolean;
  readonly presentation: PortableGenomeViewTrackPresentation;
  readonly currentDataSource?: IndexedGenomeDataTrackState['source'];
  readonly admittedSource?: AdmittedTrackSource;
  readonly localVariantContent?: PortableLocalVariantContent;
}

export interface PortableLocalVariantContent {
  readonly sizeBytes: number;
  readonly mtimeNs?: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const SHA256_FINGERPRINT = /^sha256:([0-9a-f]{64})$/;

export async function projectPortableGenomeView(
  input: PortableGenomeViewProjectionInput
): Promise<PortableGenomeViewProjectionResult> {
  const issues: PortableGenomeViewProjectionIssue[] = [];
  const expectedAssemblyId = input.reference.assemblyId;
  validateReferenceIdentity(input.indexedGenome, input.reference, issues);
  for (const view of input.indexedGenome.signalReadPileupViews ?? []) {
    issues.push({
      code: 'unsupported-composed-view',
      message:
        `Signal-to-reads view ${view.label} cannot be represented by the current portable ` +
        'genome-view schema. Save it as a Track View or share its .dnaforge-tracks.json manifest.',
      trackId: view.trackId,
      trackFamily: 'composition',
    });
  }

  const candidates = currentTrackCandidates(input.indexedGenome, input.variantPresentation, issues);
  const duplicateTrackIds = duplicatedValues(candidates.map((candidate) => candidate.trackId));
  for (const trackId of duplicateTrackIds) {
    issues.push({
      code: 'duplicate-track-id',
      message: `Current indexed genome contains duplicate track ID ${trackId}.`,
      trackId,
    });
  }

  const orderedCandidates = [...candidates].sort(compareTrackCandidates);
  const tracks: PortableGenomeViewTrack[] = [];
  for (const [order, candidate] of orderedCandidates.entries()) {
    const pinnedSource = ownTrackSourceRef(input.trackSourceRefsByTrackId, candidate.trackId);
    const source =
      pinnedSource ??
      (await deriveHostedDataTrackSource(candidate)) ??
      (await deriveAdmittedTrackSource(candidate));
    if (!source) {
      issues.push({
        code: 'unsupported-track-source',
        message:
          `Track ${candidate.trackId} (${candidate.family}) has no portable source identity. ` +
          'Admit an ID plus SHA-256 content and reference fingerprints before saving the view.',
        trackId: candidate.trackId,
        trackFamily: candidate.family,
      });
      continue;
    }
    validateTrackIdentity(candidate, source, expectedAssemblyId, issues);
    tracks.push({
      trackId: candidate.trackId,
      trackType: candidate.trackType,
      label: candidate.label,
      order,
      visible: candidate.visible,
      source,
      presentation: candidate.presentation,
    });
  }

  if (issues.length > 0) return { status: 'unsupported', issues };

  const candidateDocument: PortableGenomeViewDocument = {
    schema: PORTABLE_GENOME_VIEW_SCHEMA,
    kind: 'indexed-genome-view',
    id: input.id,
    name: input.name,
    provenance: input.provenance,
    reference: input.reference,
    viewport: projectViewport(input.indexedGenome, input.liveViewport, input.assemblyViewportRange),
    annotation: {
      policy: { ...input.annotation.policy },
      visibilityByTrackId: { ...input.annotation.visibilityByTrackId },
      orderedTrackIds: [...input.annotation.orderedTrackIds],
    },
    tracks,
  };

  try {
    return { status: 'ready', document: migratePortableGenomeViewDocument(candidateDocument) };
  } catch (error) {
    return {
      status: 'unsupported',
      issues: [
        {
          code: 'invalid-document',
          message: error instanceof Error ? error.message : 'Portable genome view is invalid.',
        },
      ],
    };
  }
}

export function restorePortableGenomeView(document: unknown): RestoredPortableGenomeViewState {
  const validated = migratePortableGenomeViewDocument(document);
  const indexedGenomeView = restoreViewport(validated.viewport);
  return {
    reference: validated.reference,
    indexedGenomeView,
    annotation: validated.annotation,
    tracks: validated.tracks,
  };
}

export function portableVariantTrackId(source: IndexedGenomeVariantSourceState): string {
  return `variant:${source.sourceIdentity}`;
}

function currentTrackCandidates(
  indexedGenome: PortableGenomeViewProjectionState,
  variantPresentation: PortableGenomeViewProjectionInput['variantPresentation'],
  issues: PortableGenomeViewProjectionIssue[]
): TrackCandidate[] {
  const candidates: TrackCandidate[] = [];
  for (const dataTrack of indexedGenome.dataTracks ?? indexedGenome.ucscTracks ?? []) {
    const presentation = dataTrackPresentation(dataTrack);
    if (!presentation) {
      issues.push({
        code: 'unsupported-track-presentation',
        message: `Track ${dataTrack.trackId} has unsupported scientific kind ${dataTrack.source.scientificKind}.`,
        trackId: dataTrack.trackId,
        trackFamily: 'data',
      });
      continue;
    }
    candidates.push({
      family: 'data',
      insertionIndex: candidates.length,
      requestedOrder: dataTrack.order,
      trackId: dataTrack.trackId,
      trackType: dataTrack.trackType,
      label: dataTrack.label,
      visible: dataTrack.visible,
      presentation,
      currentDataSource: dataTrack.source,
      admittedSource: dataTrack.source,
    });
  }
  for (const bamTrack of indexedGenome.bamTracks ?? []) {
    candidates.push(bamTrackCandidate(bamTrack, candidates.length));
  }
  if (indexedGenome.variantSource) {
    const source = indexedGenome.variantSource;
    candidates.push({
      family: 'variants',
      insertionIndex: candidates.length,
      requestedOrder: undefined,
      trackId: portableVariantTrackId(source),
      trackType: source.format,
      label: source.label,
      visible: variantPresentation?.visible ?? true,
      presentation: {
        kind: 'variants',
        selectedSamples: [...(variantPresentation?.selectedSamples ?? source.samples)],
        filteredToPassing: variantPresentation?.filteredToPassing ?? false,
      },
      ...(source.admittedSource ? { admittedSource: source.admittedSource } : {}),
      localVariantContent: {
        sizeBytes: source.sourceSizeBytes,
        ...(source.sourceMtimeNs ? { mtimeNs: source.sourceMtimeNs } : {}),
      },
    });
  }
  return candidates;
}

function bamTrackCandidate(
  bamTrack: IndexedGenomeBamTrackState,
  insertionIndex: number
): TrackCandidate {
  return {
    family: 'aligned-reads',
    insertionIndex,
    requestedOrder: bamTrack.order,
    trackId: bamTrack.trackId,
    trackType: 'aligned-reads',
    label: bamTrack.label,
    visible: bamTrack.visible,
    presentation: {
      kind: 'aligned-reads',
      coverageCutoffDepth: bamTrack.coverageCutoffDepth,
    },
    ...(bamTrack.admittedSource ? { admittedSource: bamTrack.admittedSource } : {}),
  };
}

function dataTrackPresentation(
  track: IndexedGenomeDataTrackState
): PortableGenomeViewTrackPresentation | null {
  if (track.source.scientificKind === 'quantitative') {
    return {
      kind: 'quantitative',
      color: colorHex(track.color),
      trackHeightPx: track.trackPx,
      scale: { kind: 'auto' },
    };
  }
  if (track.source.scientificKind === 'reads') {
    return { kind: 'aligned-reads', coverageCutoffDepth: 0 };
  }
  if (track.source.scientificKind === 'variants') {
    return { kind: 'variants', selectedSamples: [], filteredToPassing: false };
  }
  if (
    track.source.scientificKind === 'transcript' ||
    track.source.scientificKind === 'interval' ||
    track.source.scientificKind === 'peak' ||
    track.source.scientificKind === 'repeat'
  ) {
    return {
      kind: 'annotation',
      color: colorHex(track.color),
      trackHeightPx: track.trackPx,
      laneHeightPx: track.laneHeightPx,
      maxLanes: track.maxLanes,
    };
  }
  return null;
}

async function deriveAdmittedTrackSource(
  candidate: TrackCandidate
): Promise<PortableGenomeViewTrackSourceRef | null> {
  const source = candidate.admittedSource;
  const request = source?.request;
  if (!source || !request) return null;
  if (request.source.kind === 'ucsc-track' && request.source.sourceKind === 'ucsc-native') {
    return null;
  }
  const [contentFingerprint, referenceSignature] = await Promise.all([
    portableAdmittedContentFingerprint(source, candidate.localVariantContent),
    portableFingerprintFromIdentity(source.referenceReceipt.referenceSignature),
  ]);
  return {
    kind: 'admitted-source',
    request,
    assemblyId: source.assemblyId,
    contentFingerprint,
    referenceSignature,
  };
}

export async function portableAdmittedContentFingerprint(
  source: AdmittedTrackSource,
  localVariantContent?: PortableLocalVariantContent
): Promise<string> {
  const local = source.request?.source.kind === 'local-file';
  if (local && source.alignedReadGeneration) {
    const { alignment, index } = source.alignedReadGeneration;
    return portableFingerprintFromIdentity(
      [
        'dnaforge:portable-local-reads:v1',
        source.formatId,
        alignment.size,
        alignment.mtimeNs,
        index.size,
        index.mtimeNs,
      ].join('\u0000')
    );
  }
  if (local && source.readerKind === 'variant' && localVariantContent) {
    return portableFingerprintFromIdentity(
      [
        'dnaforge:portable-local-variants:v1',
        source.formatId,
        localVariantContent.sizeBytes,
        localVariantContent.mtimeNs ?? '',
      ].join('\u0000')
    );
  }
  return portableFingerprintFromIdentity(bbiAdmissionContentIdentity(source));
}

async function deriveHostedDataTrackSource(
  candidate: TrackCandidate
): Promise<PortableGenomeViewTrackSourceRef | null> {
  const source = candidate.currentDataSource;
  if (!source?.provenance.provider) return null;
  if (source.provenance.provider === 'ucsc' && source.provenance.sourceKind === 'ucsc-hub') {
    return null;
  }
  const catalogId =
    source.provenance.provider === 'ucsc' ? source.provenance.track : source.provenance.catalogId;
  if (!catalogId) return null;
  const contentFingerprint = prefixedSha256(source.fingerprint);
  if (!contentFingerprint) return null;
  const referenceSignature = await portableFingerprintFromIdentity(
    source.referenceReceipt.referenceSignature
  );
  return {
    kind: 'hosted-track',
    provider: source.provenance.provider,
    catalogId,
    assemblyId: source.assemblyId,
    contentFingerprint,
    referenceSignature,
  };
}

export async function portableFingerprintFromIdentity(identity: string): Promise<string> {
  const existing = prefixedSha256(identity);
  if (existing) return existing;
  const bytes = new TextEncoder().encode(identity);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')}`;
}

function validateReferenceIdentity(
  indexedGenome: PortableGenomeViewProjectionState,
  reference: PortableGenomeViewReference,
  issues: PortableGenomeViewProjectionIssue[]
): void {
  if (indexedGenome.assembly && indexedGenome.assembly.assemblyId !== reference.assemblyId) {
    issues.push({
      code: 'reference-identity-conflict',
      message:
        `Current assembly ${indexedGenome.assembly.assemblyId} does not match portable reference ` +
        `${reference.assemblyId}.`,
    });
  }
  if (reference.kind !== 'hosted-reference') return;
  if (
    reference.sequenceIdentity &&
    reference.annotationIdentity &&
    indexedGenome.assemblyReferenceIdentity
  ) {
    if (reference.sequenceIdentity !== indexedGenome.assemblyReferenceIdentity.sequenceIdentity) {
      issues.push({
        code: 'reference-identity-conflict',
        message: 'Current hosted reference sequence does not match the saved sequence identity.',
      });
    }
    return;
  }
  if (!indexedGenome.assemblyPortableBundleFingerprint) {
    issues.push({
      code: 'unsupported-reference-source',
      message: 'Current hosted reference has no admitted portable bundle fingerprint.',
    });
  } else if (indexedGenome.assemblyPortableBundleFingerprint !== reference.bundleFingerprint) {
    issues.push({
      code: 'reference-identity-conflict',
      message: 'Current hosted reference bundle does not match the requested portable identity.',
    });
  }
  const generations = [
    indexedGenome.assemblyAssetGeneration,
    indexedGenome.assemblyAssetGenerationsByTheme?.light,
    indexedGenome.assemblyAssetGenerationsByTheme?.dark,
  ].filter((generation) => generation !== undefined);
  if (
    !generations.some(
      (generation) =>
        generation.sourceFingerprint === reference.sourceFingerprint &&
        generation.inventoryFingerprint === reference.inventoryFingerprint
    )
  ) {
    issues.push({
      code: 'unsupported-reference-source',
      message:
        'Current hosted reference has no admitted product generation matching the portable source and inventory fingerprints.',
    });
  }
}

function validateTrackIdentity(
  candidate: TrackCandidate,
  source: PortableGenomeViewTrackSourceRef,
  expectedAssemblyId: string,
  issues: PortableGenomeViewProjectionIssue[]
): void {
  if (source.assemblyId !== expectedAssemblyId) {
    issues.push({
      code: 'track-identity-conflict',
      message:
        `Track ${candidate.trackId} portable source belongs to assembly ${source.assemblyId}, ` +
        `not ${expectedAssemblyId}.`,
      trackId: candidate.trackId,
      trackFamily: candidate.family,
    });
  }
  const currentSource = candidate.currentDataSource;
  if (!currentSource) return;
  if (
    currentSource.assemblyId !== expectedAssemblyId ||
    currentSource.referenceReceipt.assemblyId !== expectedAssemblyId ||
    currentSource.referenceReceipt.status !== 'compatible'
  ) {
    issues.push({
      code: 'track-identity-conflict',
      message: `Track ${candidate.trackId} has no compatible admission receipt for ${expectedAssemblyId}.`,
      trackId: candidate.trackId,
      trackFamily: candidate.family,
    });
  }
  const currentFingerprint = prefixedSha256(currentSource.fingerprint);
  if (currentFingerprint && currentFingerprint !== source.contentFingerprint) {
    issues.push({
      code: 'track-identity-conflict',
      message: `Track ${candidate.trackId} content fingerprint conflicts with its current admission.`,
      trackId: candidate.trackId,
      trackFamily: candidate.family,
    });
  }
  const currentReferenceSignature = prefixedSha256(
    currentSource.referenceReceipt.referenceSignature
  );
  if (currentReferenceSignature && currentReferenceSignature !== source.referenceSignature) {
    issues.push({
      code: 'track-identity-conflict',
      message: `Track ${candidate.trackId} reference signature conflicts with its current admission.`,
      trackId: candidate.trackId,
      trackFamily: candidate.family,
    });
  }
}

function projectViewport(
  indexedGenome: PortableGenomeViewProjectionState,
  liveViewport: PortableGenomeViewLiveViewport | null | undefined,
  assemblyViewportRange: Readonly<{ start0: number; end0: number }> | null | undefined
): PortableGenomeViewViewport {
  if (liveViewport) {
    return {
      kind: 'locus',
      chrom: liveViewport.chrom,
      start0: liveViewport.start0,
      end0: liveViewport.end0,
    };
  }
  if (assemblyViewportRange) {
    return {
      kind: 'assembly-range',
      start0: assemblyViewportRange.start0,
      end0: assemblyViewportRange.end0,
    };
  }
  if (indexedGenome.scope?.kind === 'all') return { kind: 'all' };
  if (indexedGenome.scope?.kind === 'locus') {
    return {
      kind: 'locus',
      chrom: indexedGenome.scope.chrom,
      start0: indexedGenome.scope.start,
      end0: indexedGenome.scope.end,
    };
  }
  return {
    kind: 'chromosome',
    chrom:
      indexedGenome.scope?.kind === 'chromosome' ? indexedGenome.scope.chrom : indexedGenome.chrom,
  };
}

function restoreViewport(
  viewport: PortableGenomeViewViewport
): RestoredPortableGenomeViewState['indexedGenomeView'] {
  if (viewport.kind === 'all') {
    return {
      scope: { kind: 'all' },
      indexedViewport: null,
      viewportTarget: null,
      viewport,
    };
  }
  if (viewport.kind === 'chromosome') {
    return {
      scope: { kind: 'chromosome', chrom: viewport.chrom },
      indexedViewport: null,
      viewportTarget: null,
      viewport,
    };
  }
  if (viewport.kind === 'assembly-range') {
    return {
      scope: { kind: 'all' },
      indexedViewport: { start0: viewport.start0, end0: viewport.end0 },
      viewportTarget: null,
      viewport,
    };
  }
  return {
    scope: {
      kind: 'locus',
      chrom: viewport.chrom,
      start: viewport.start0,
      end: viewport.end0,
    },
    indexedViewport: { start0: viewport.start0, end0: viewport.end0 },
    viewportTarget: {
      chrom: viewport.chrom,
      start0: viewport.start0,
      end0: viewport.end0,
    },
    viewport,
  };
}

function compareTrackCandidates(left: TrackCandidate, right: TrackCandidate): number {
  const leftOrder = validRequestedOrder(left.requestedOrder);
  const rightOrder = validRequestedOrder(right.requestedOrder);
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  return left.insertionIndex - right.insertionIndex;
}

function validRequestedOrder(order: number | undefined): number {
  return typeof order === 'number' && Number.isSafeInteger(order) && order >= 0
    ? order
    : Number.MAX_SAFE_INTEGER;
}

function colorHex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

function prefixedSha256(value: string): string | null {
  const match = SHA256_FINGERPRINT.exec(value);
  if (match) return `sha256:${match[1]}`;
  return SHA256_HEX.test(value) ? `sha256:${value}` : null;
}

function duplicatedValues(values: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function ownTrackSourceRef(
  sourceRefs: PortableGenomeViewProjectionInput['trackSourceRefsByTrackId'],
  trackId: string
): PortableGenomeViewTrackSourceRef | undefined {
  return sourceRefs && Object.prototype.hasOwnProperty.call(sourceRefs, trackId)
    ? sourceRefs[trackId]
    : undefined;
}
