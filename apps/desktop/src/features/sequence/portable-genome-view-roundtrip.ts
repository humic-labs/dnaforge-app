import { withUserMessage, userMessagePayload, userMessageValue } from '@waypoint/user-messages';
import {
  referenceViewCompatibility,
  savedReferenceContentIdentity,
} from './reference-view-compatibility';
import type {
  UcscCatalogLeaf,
  PortableGenomeViewReference,
  PortableGenomeViewTrack,
  PortableGenomeViewViewport,
} from '@waypoint/genome-data';

import type {
  IndexedGenomeDataTrackState,
  IndexedGenomeTabState,
} from '../../shared/indexed-genome';
import type { PreparedReferenceAssemblyEntryV1 } from '../../shared/reference-assets-ipc';
import { platform } from '../../platform';
import type { AlignmentReferenceIdentity } from './alignment-header-client';
import { assemblyReferencesFromIndexedGenome } from './attach-indexed-bigwig';
import { referenceSignature } from './bbi-reference-compatibility';
import {
  portableFingerprintFromIdentity,
  projectPortableGenomeView,
  type PortableGenomeViewLiveViewport,
  type PortableGenomeViewProjectionResult,
} from './portable-genome-view-adapter';
import { ucscTrackTargetForAssembly } from './ucsc-assembly-alias';
import { admitUcscCatalogTrackSource } from './ucsc-track-admission';
import { searchUcscTracks } from './ucsc-track-client';

const SOURCE_FINGERPRINT = /^[0-9a-f]{24}$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;

export interface PortableGenomeViewResolvedViewport {
  readonly scope: NonNullable<IndexedGenomeTabState['scope']>;
  readonly globalStart0: number;
  readonly globalEnd0: number;
}

export function resolvePortableGenomeViewViewport(
  viewport: PortableGenomeViewViewport,
  assembly: Readonly<{ chromosomes: ReadonlyArray<Readonly<{ chrom: string; length: number }>> }>
): PortableGenomeViewResolvedViewport {
  const totalLength = assembly.chromosomes.reduce((total, chromosome) => {
    if (!Number.isSafeInteger(chromosome.length) || chromosome.length <= 0) {
      throw new Error(`Hosted reference chromosome ${chromosome.chrom} has an invalid length.`);
    }
    return total + chromosome.length;
  }, 0);
  if (!Number.isSafeInteger(totalLength) || totalLength <= 0) {
    throw new Error('Hosted reference has no valid assembly coordinate range.');
  }
  if (viewport.kind === 'all') {
    return { scope: { kind: 'all' }, globalStart0: 0, globalEnd0: totalLength };
  }
  if (viewport.kind === 'assembly-range') {
    if (viewport.end0 > totalLength) {
      throw new Error('Saved assembly viewport is outside the current hosted reference.');
    }
    return {
      scope: { kind: 'all' },
      globalStart0: viewport.start0,
      globalEnd0: viewport.end0,
    };
  }
  let offset = 0;
  for (const chromosome of assembly.chromosomes) {
    if (chromosome.chrom !== viewport.chrom) {
      offset += chromosome.length;
      continue;
    }
    if (viewport.kind === 'chromosome') {
      return {
        scope: { kind: 'chromosome', chrom: chromosome.chrom },
        globalStart0: offset,
        globalEnd0: offset + chromosome.length,
      };
    }
    if (viewport.end0 > chromosome.length) {
      throw new Error(`Saved viewport is outside chromosome ${chromosome.chrom}.`);
    }
    return {
      scope: {
        kind: 'locus',
        chrom: chromosome.chrom,
        start: viewport.start0,
        end: viewport.end0,
      },
      globalStart0: offset + viewport.start0,
      globalEnd0: offset + viewport.end0,
    };
  }
  throw new Error(`Saved viewport names chromosome ${viewport.chrom}, which is not published.`);
}

export interface CreatePortableGenomeViewInput {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly indexedGenome: IndexedGenomeTabState;
  readonly liveViewport: PortableGenomeViewLiveViewport | null;
  readonly assemblyViewportRange?: Readonly<{ start0: number; end0: number }> | null;
  readonly annotation: Readonly<{
    policy: Readonly<{ isoformMode: 'canonical' | 'expanded'; laneLimit: number | null }>;
    visibilityByTrackId: Readonly<Record<string, boolean>>;
    orderedTrackIds: ReadonlyArray<string>;
  }>;
  readonly readTextFile?: (path: string) => Promise<string>;
}

export async function createPortableGenomeViewDocument(
  input: CreatePortableGenomeViewInput
): Promise<PortableGenomeViewProjectionResult> {
  return projectPortableGenomeView({
    id: input.id,
    name: input.name,
    provenance: {
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      createdBy: { kind: 'user' },
    },
    indexedGenome: input.indexedGenome,
    reference: await portableReferenceFromIndexedGenome(input.indexedGenome, input.readTextFile),
    liveViewport: input.liveViewport,
    assemblyViewportRange: input.assemblyViewportRange,
    annotation: input.annotation,
  });
}

export async function workspaceReferenceContentFingerprint(
  faiPaths: ReadonlyArray<string | undefined>,
  readTextFile: (path: string) => Promise<string> = (path) => platform().fs.readTextFile(path)
): Promise<string> {
  const unique = [...new Set(faiPaths.filter((path): path is string => Boolean(path)))];
  if (unique.length === 0) {
    throw new Error(
      'This reference has no prepared index tables, so it cannot be identified portably.'
    );
  }
  const tables = await Promise.all(unique.map((path) => readTextFile(path)));
  return portableFingerprintFromIdentity(
    `dnaforge.reference-index-tables.v1\n${tables.map((table) => table.trim()).join('\n')}`
  );
}

export async function portableReferenceFromIndexedGenome(
  indexedGenome: IndexedGenomeTabState,
  readTextFile?: (path: string) => Promise<string>
): Promise<PortableGenomeViewReference> {
  if (indexedGenome.assemblyPortableBundleFingerprint) {
    return portableHostedReferenceFromIndexedGenome(indexedGenome);
  }
  const assemblyId = indexedGenome.assembly?.assemblyId;
  if (!assemblyId) {
    throw new Error('This view has no reference assembly, so it cannot be saved portably.');
  }
  const references = assemblyReferencesFromIndexedGenome(indexedGenome);
  if (references.length === 0) {
    throw new Error('This reference has no chromosome table, so it cannot be saved portably.');
  }
  const [contentFingerprint, signature] = await Promise.all([
    workspaceReferenceContentFingerprint(
      (indexedGenome.assembly?.chromosomes ?? []).map((chromosome) => chromosome.manifest?.faiPath),
      readTextFile
    ),
    referenceSignature(references).then(portableFingerprintFromIdentity),
  ]);
  return {
    kind: 'workspace-reference',
    entityId: assemblyId,
    assemblyId,
    contentFingerprint,
    referenceSignature: signature,
  };
}

export function portableHostedReferenceFromIndexedGenome(
  indexedGenome: IndexedGenomeTabState
): PortableGenomeViewReference {
  const assemblyId = indexedGenome.assembly?.assemblyId;
  const bundleFingerprint = indexedGenome.assemblyPortableBundleFingerprint;
  if (!assemblyId || !bundleFingerprint || !SHA256_HEX.test(bundleFingerprint)) {
    throw new Error(
      'This view is not backed by an authenticated hosted reference bundle, so it cannot be saved portably yet.'
    );
  }
  const generation = portableReferenceGeneration(indexedGenome);
  if (!generation) {
    throw new Error(
      'This hosted reference has no admitted source and inventory fingerprints. Wait for the current view to finish opening, then save again.'
    );
  }
  return {
    kind: 'hosted-reference',
    ...indexedGenome.assemblyReferenceIdentity,
    catalogId: assemblyId,
    assemblyId,
    bundleFingerprint,
    sourceFingerprint: generation.sourceFingerprint,
    inventoryFingerprint: generation.inventoryFingerprint,
  };
}

export type PortableWorkspaceReference = Extract<
  PortableGenomeViewReference,
  { kind: 'workspace-reference' }
>;

export async function portableReferenceSignatureMatches(
  assemblyReferences: ReadonlyArray<AlignmentReferenceIdentity>,
  reference: PortableWorkspaceReference
): Promise<boolean> {
  if (assemblyReferences.length === 0) return false;
  const signature = await portableFingerprintFromIdentity(
    await referenceSignature(assemblyReferences)
  );
  return signature === reference.referenceSignature;
}

export class PortableReferenceMissingError extends Error {
  readonly code = 'PORTABLE_REFERENCE_MISSING';

  constructor(
    readonly reference: PortableWorkspaceReference,
    readonly candidates: ReadonlyArray<PreparedReferenceAssemblyEntryV1>
  ) {
    super(
      `This view was saved against reference ${reference.assemblyId}, which is not in this library.`
    );
    this.name = 'PortableReferenceMissingError';
  }
}

export async function assertReferenceSignatureMatchesPortableView(
  entryName: string,
  assemblyReferences: ReadonlyArray<AlignmentReferenceIdentity>,
  reference: PortableGenomeViewReference
): Promise<void> {
  if (reference.kind !== 'workspace-reference') {
    throw new Error('This saved view points to a hosted reference, not a library reference.');
  }
  if (assemblyReferences.length === 0) {
    throw new Error(`Reference ${entryName} has no chromosome table to verify this view against.`);
  }
  if (!(await portableReferenceSignatureMatches(assemblyReferences, reference))) {
    throw withUserMessage(
      new Error(
        `Reference ${entryName} has a different chromosome table than the one this view was saved against. DNAForge refused to open the view on a different assembly.`
      ),
      userMessagePayload('reference.chromosomeMismatch', { reference: userMessageValue(entryName) })
    );
  }
}

export function assertPreparedReferenceMatchesPortableView(
  entry: PreparedReferenceAssemblyEntryV1,
  reference: PortableGenomeViewReference
): Readonly<{ annotationsUpdated: boolean }> {
  if (reference.kind !== 'hosted-reference') {
    throw new Error(
      'This saved view points to a project reference. Relinkable project references are not admitted by the hosted-reference opener.'
    );
  }
  if (entry.id !== reference.catalogId || entry.id !== reference.assemblyId) {
    throw new Error(
      `Saved view reference ${reference.catalogId} resolved to unexpected hosted reference ${entry.id}.`
    );
  }
  const savedIdentity = savedReferenceContentIdentity(reference, entry.referenceVersionHistory);
  if (savedIdentity && entry.referenceIdentity) {
    const compatibility = referenceViewCompatibility(savedIdentity, entry.referenceIdentity);
    if (!compatibility.compatible) {
      throw withUserMessage(
        new Error(
          `Hosted reference ${entry.name} has changed since this view was saved. DNAForge refused to open the view against a different sequence.`
        ),
        'reference.sequenceChanged'
      );
    }
    if (
      !entry.portableView?.assetGenerationsByTheme ||
      Object.keys(entry.portableView.assetGenerationsByTheme).length === 0
    ) {
      throw new Error(
        `Hosted reference ${entry.name} does not expose the prepared source and annotation inventory required by this saved view.`
      );
    }
    return { annotationsUpdated: compatibility.annotationsUpdated };
  }
  if (entry.portableView?.bundleFingerprint !== reference.bundleFingerprint) {
    throw new Error(
      `Hosted reference ${entry.name} has changed since this view was saved. DNAForge refused to open the view against different reference bytes.`
    );
  }
  const generations = Object.values(entry.portableView.assetGenerationsByTheme ?? {});
  if (generations.length === 0) {
    throw new Error(
      `Hosted reference ${entry.name} does not expose the prepared source and annotation inventory required by this saved view.`
    );
  }
  if (
    !generations.some(
      (generation) =>
        generation.sourceFingerprint === reference.sourceFingerprint &&
        generation.inventoryFingerprint === reference.inventoryFingerprint
    )
  ) {
    throw new Error(
      `Hosted reference ${entry.name} no longer has the source and annotation inventory saved by this view.`
    );
  }
  return { annotationsUpdated: false };
}

interface ResolvePortableHostedTracksOptions {
  readonly search?: typeof searchUcscTracks;
  readonly admit?: typeof admitUcscCatalogTrackSource;
}

export async function resolvePortableHostedDataTracks(input: {
  readonly tracks: ReadonlyArray<PortableGenomeViewTrack>;
  readonly indexedGenome: IndexedGenomeTabState;
  readonly options?: ResolvePortableHostedTracksOptions;
}): Promise<ReadonlyArray<IndexedGenomeDataTrackState>> {
  const assemblyId = input.indexedGenome.assembly?.assemblyId ?? input.indexedGenome.chrom;
  const references = assemblyReferencesFromIndexedGenome(input.indexedGenome);
  return resolvePortableHostedDataTracksForReference({
    tracks: input.tracks,
    assemblyId,
    assemblyReferences: references,
    options: input.options,
  });
}

export async function resolvePortableHostedDataTracksForReference(input: {
  readonly tracks: ReadonlyArray<PortableGenomeViewTrack>;
  readonly assemblyId: string;
  readonly assemblyReferences: ReadonlyArray<AlignmentReferenceIdentity>;
  readonly options?: ResolvePortableHostedTracksOptions;
}): Promise<ReadonlyArray<IndexedGenomeDataTrackState>> {
  if (input.tracks.length === 0) return [];
  const { assemblyId, assemblyReferences: references } = input;
  if (references.length === 0) {
    throw new Error(`Reference ${assemblyId} has no chromosome identity for track restoration.`);
  }
  const ucscTarget = ucscTrackTargetForAssembly(assemblyId);
  const search = input.options?.search ?? searchUcscTracks;
  const admit = input.options?.admit ?? admitUcscCatalogTrackSource;
  const restored: IndexedGenomeDataTrackState[] = [];

  for (const track of input.tracks) {
    if (track.source.kind !== 'hosted-track') {
      throw new Error(
        `Track ${track.label} points to a project file. This opener will not guess a path or silently omit it; relink the source before opening this view.`
      );
    }
    if (track.source.provider !== 'ucsc' || !ucscTarget) {
      throw new Error(
        `Track ${track.label} uses unsupported hosted provider ${track.source.provider} for assembly ${assemblyId}.`
      );
    }
    if (track.source.assemblyId !== assemblyId) {
      throw new Error(
        `Track ${track.label} belongs to ${track.source.assemblyId}, not ${assemblyId}.`
      );
    }
    const results = await search({
      genome: ucscTarget.genomeId,
      query: track.source.catalogId,
      limit: 50,
      ...(ucscTarget.hubUrl ? { hubUrl: ucscTarget.hubUrl } : {}),
    });
    const catalogTrack = exactUcscTrack(results, track.source.catalogId);
    if (!catalogTrack) {
      throw new Error(
        `UCSC track ${track.source.catalogId} is no longer published for ${assemblyId}.`
      );
    }
    const admitted = await admit({
      assemblyId,
      assemblyReferences: references,
      ucscTarget,
      track: catalogTrack,
    });
    const [contentFingerprint, referenceSignature] = await Promise.all([
      portableFingerprintFromIdentity(admitted.fingerprint),
      portableFingerprintFromIdentity(admitted.referenceReceipt.referenceSignature),
    ]);
    if (
      contentFingerprint !== track.source.contentFingerprint ||
      referenceSignature !== track.source.referenceSignature
    ) {
      throw new Error(
        `UCSC track ${track.label} changed since this view was saved. DNAForge refused to attach different track data.`
      );
    }
    restored.push(portableDataTrackState(track, admitted));
  }
  return restored;
}

function portableReferenceGeneration(indexedGenome: IndexedGenomeTabState) {
  return [
    indexedGenome.assemblyAssetGeneration,
    indexedGenome.assemblyAssetGenerationsByTheme?.light,
    indexedGenome.assemblyAssetGenerationsByTheme?.dark,
  ].find(
    (generation) =>
      generation &&
      SOURCE_FINGERPRINT.test(generation.sourceFingerprint) &&
      SHA256_HEX.test(generation.inventoryFingerprint)
  );
}

function exactUcscTrack(
  candidates: ReadonlyArray<UcscCatalogLeaf>,
  trackName: string
): UcscCatalogLeaf | null {
  return candidates.find((candidate) => candidate.track === trackName) ?? null;
}

export function portableDataTrackState(
  track: PortableGenomeViewTrack,
  source: IndexedGenomeDataTrackState['source']
): IndexedGenomeDataTrackState {
  assertPortablePresentationMatchesSource(track, source);
  if (track.presentation.kind === 'annotation') {
    return {
      trackId: track.trackId,
      trackType: track.trackType,
      label: track.label,
      order: track.order,
      color: colorNumber(track.presentation.color),
      trackPx: track.presentation.trackHeightPx,
      laneHeightPx: track.presentation.laneHeightPx,
      maxLanes: track.presentation.maxLanes,
      visible: track.visible,
      source,
    };
  }
  if (track.presentation.kind === 'quantitative') {
    if (track.presentation.scale.kind === 'fixed') {
      throw new Error(
        `Track ${track.label} uses a fixed quantitative scale that this viewer cannot restore exactly.`
      );
    }
    return {
      trackId: track.trackId,
      trackType: track.trackType,
      label: track.label,
      order: track.order,
      color: colorNumber(track.presentation.color),
      trackPx: track.presentation.trackHeightPx,
      laneHeightPx: 8,
      maxLanes: 32,
      visible: track.visible,
      source,
    };
  }
  throw new Error(
    `Hosted UCSC track ${track.label} has unsupported ${track.presentation.kind} presentation.`
  );
}

function assertPortablePresentationMatchesSource(
  track: PortableGenomeViewTrack,
  source: IndexedGenomeDataTrackState['source']
): void {
  const expectedPresentation =
    source.scientificKind === 'quantitative'
      ? 'quantitative'
      : source.scientificKind === 'transcript' ||
          source.scientificKind === 'interval' ||
          source.scientificKind === 'peak' ||
          source.scientificKind === 'repeat'
        ? 'annotation'
        : null;
  if (expectedPresentation === null) {
    throw new Error(
      `Track ${track.label} has unsupported ${source.scientificKind} scientific data.`
    );
  }
  if (track.presentation.kind !== expectedPresentation) {
    throw new Error(
      `Track ${track.label} saved a ${track.presentation.kind} presentation, but its admitted source is ${source.scientificKind}. DNAForge refused to reinterpret the track.`
    );
  }
}

function colorNumber(color: string): number {
  return Number.parseInt(color.slice(1), 16);
}
