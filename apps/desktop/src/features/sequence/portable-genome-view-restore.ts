import {
  parseTrackAdmissionRequestV1,
  type AdmittedTrackSource,
  type PortableGenomeViewTrack,
  type TrackAdmissionRequestV1,
  type TrackAssetLocatorV1,
  type TrackSourceAddressV1,
} from '@waypoint/genome-data';

import { platform } from '../../platform';
import type {
  IndexedGenomeBamTrackState,
  IndexedGenomeDataTrackState,
  IndexedGenomeVariantSourceState,
} from '../../shared/indexed-genome';
import type { AlignmentReferenceIdentity } from './alignment-header-client';
import { durableAlignedReadAdmission } from './bam-track-persistence';
import { portableAdmittedContentFingerprint } from './portable-genome-view-adapter';
import {
  portableDataTrackState,
  resolvePortableHostedDataTracksForReference,
} from './portable-genome-view-roundtrip';
import { admitTrackSource } from './track-admission';
import { durableVariantSource } from './variant-source-state';
import type { VariantTrackRuntime } from './variant-track-admission';

export type PortableLocatorRole = 'source' | 'index' | 'reference';

export interface PortableMissingFile {
  readonly role: PortableLocatorRole;
  readonly path: string;
}

export type PortableTrackResolution =
  | Readonly<{ status: 'ready'; track: PortableGenomeViewTrack }>
  | Readonly<{
      status: 'relink-required';
      track: PortableGenomeViewTrack;
      missing: ReadonlyArray<PortableMissingFile>;
    }>
  | Readonly<{
      status: 'credential-required';
      track: PortableGenomeViewTrack;
      authRefs: ReadonlyArray<string>;
    }>
  | Readonly<{ status: 'unsupported'; track: PortableGenomeViewTrack; reason: string }>;

export interface PortableRestoreDeps {
  readonly exists: (path: string) => Promise<boolean>;
  readonly credentialConnected: (authRef: string) => Promise<boolean>;
}

export function defaultPortableRestoreDeps(): PortableRestoreDeps {
  return {
    exists: (path) => platform().fs.exists(path),
    credentialConnected: async (authRef) =>
      (await platform().genomeCredentials.status(authRef)).connected,
  };
}

export function portableRequestLocators(
  request: TrackAdmissionRequestV1
): ReadonlyArray<readonly [PortableLocatorRole, TrackSourceAddressV1 | TrackAssetLocatorV1]> {
  const entries: Array<readonly [PortableLocatorRole, TrackSourceAddressV1 | TrackAssetLocatorV1]> =
    [['source', request.source]];
  if (request.index) entries.push(['index', request.index]);
  if (request.reference) entries.push(['reference', request.reference]);
  return entries;
}

export function portableRequestAuthRefs(request: TrackAdmissionRequestV1): ReadonlyArray<string> {
  const refs = new Set<string>();
  for (const [, locator] of portableRequestLocators(request)) {
    if ('authRef' in locator && locator.authRef) refs.add(locator.authRef);
  }
  return [...refs];
}

export async function planPortableTrackRestore(
  tracks: ReadonlyArray<PortableGenomeViewTrack>,
  deps: PortableRestoreDeps = defaultPortableRestoreDeps()
): Promise<ReadonlyArray<PortableTrackResolution>> {
  return Promise.all(
    tracks.map(async (track): Promise<PortableTrackResolution> => {
      const source = track.source;
      if (source.kind === 'hosted-track') return { status: 'ready', track };
      if (source.kind === 'workspace-track') {
        return {
          status: 'unsupported',
          track,
          reason: 'Workspace track entities are not admitted by this opener yet.',
        };
      }
      const missing: PortableMissingFile[] = [];
      for (const [role, locator] of portableRequestLocators(source.request)) {
        if (locator.kind === 'local-file' && !(await deps.exists(locator.path))) {
          missing.push({ role, path: locator.path });
        }
      }
      if (missing.length > 0) return { status: 'relink-required', track, missing };
      const disconnected: string[] = [];
      for (const authRef of portableRequestAuthRefs(source.request)) {
        if (!(await deps.credentialConnected(authRef))) disconnected.push(authRef);
      }
      if (disconnected.length > 0) {
        return { status: 'credential-required', track, authRefs: disconnected };
      }
      return { status: 'ready', track };
    })
  );
}

export function relinkPortableTrack(
  track: PortableGenomeViewTrack,
  replacements: Partial<Record<PortableLocatorRole, string>>
): PortableGenomeViewTrack {
  if (track.source.kind !== 'admitted-source') return track;
  const request = track.source.request;
  const relinked = parseTrackAdmissionRequestV1({
    ...request,
    ...(replacements.source && request.source.kind === 'local-file'
      ? { source: { kind: 'local-file', path: replacements.source } }
      : {}),
    ...(replacements.index && request.index?.kind === 'local-file'
      ? { index: { kind: 'local-file', path: replacements.index } }
      : {}),
    ...(replacements.reference && request.reference?.kind === 'local-file'
      ? { reference: { kind: 'local-file', path: replacements.reference } }
      : {}),
  });
  return { ...track, source: { ...track.source, request: relinked } };
}

export type PortableTrackOutcomeStatus = 'restored' | 'relinked' | 'changed' | 'skipped' | 'failed';

export interface PortableTrackOutcome {
  readonly trackId: string;
  readonly label: string;
  readonly status: PortableTrackOutcomeStatus;
  readonly message?: string;
}

export interface AdmitPortableTracksInput {
  readonly tracks: ReadonlyArray<PortableGenomeViewTrack>;
  readonly relinkedTrackIds?: ReadonlySet<string>;
  readonly skippedTrackIds?: ReadonlySet<string>;
  readonly acceptChangedData: boolean;
  readonly assemblyId: string;
  readonly assemblyDisplayName: string;
  readonly assemblyReferences: ReadonlyArray<AlignmentReferenceIdentity>;
  readonly signal?: AbortSignal;
  readonly admit?: typeof admitTrackSource;
  readonly resolveHosted?: typeof resolvePortableHostedDataTracksForReference;
  readonly onProgress?: (label: string) => void;
}

export interface AdmitPortableTracksResult {
  readonly dataTracks: ReadonlyArray<IndexedGenomeDataTrackState>;
  readonly bamTracks: ReadonlyArray<IndexedGenomeBamTrackState>;
  readonly variantSource?: IndexedGenomeVariantSourceState;
  readonly outcomes: ReadonlyArray<PortableTrackOutcome>;
}

export async function admitPortableTracks(
  input: AdmitPortableTracksInput
): Promise<AdmitPortableTracksResult> {
  const admit = input.admit ?? admitTrackSource;
  const resolveHosted = input.resolveHosted ?? resolvePortableHostedDataTracksForReference;
  const dataTracks: IndexedGenomeDataTrackState[] = [];
  const bamTracks: IndexedGenomeBamTrackState[] = [];
  let variantSource: IndexedGenomeVariantSourceState | undefined;
  const outcomes: PortableTrackOutcome[] = [];

  for (const track of input.tracks) {
    if (input.signal?.aborted) throw new Error('Opening this view was cancelled.');
    const skipped = input.skippedTrackIds?.has(track.trackId) ?? false;
    if (skipped) {
      outcomes.push({ trackId: track.trackId, label: track.label, status: 'skipped' });
      continue;
    }
    input.onProgress?.(`Restoring ${track.label}…`);
    try {
      if (track.source.kind === 'hosted-track') {
        const [restored] = await resolveHosted({
          tracks: [track],
          assemblyId: input.assemblyId,
          assemblyReferences: input.assemblyReferences,
        });
        if (!restored) throw new Error(`Hosted track ${track.label} did not resolve.`);
        dataTracks.push(restored);
        outcomes.push({ trackId: track.trackId, label: track.label, status: 'restored' });
        continue;
      }
      if (track.source.kind !== 'admitted-source') {
        throw new Error('Workspace track entities are not admitted by this opener yet.');
      }
      let variantRuntime: VariantTrackRuntime | null = null;
      const admitted = await admit({
        request: track.source.request,
        assemblyId: input.assemblyId,
        assemblyDisplayName: input.assemblyDisplayName,
        assemblyReferences: input.assemblyReferences,
        signal: input.signal,
        ...(track.source.request.source.kind === 'local-file'
          ? { localAuthorityContext: 'workspace-grounded' as const }
          : {}),
        onVariantRuntime: ({ runtime }) => {
          variantRuntime = runtime;
        },
      });
      let preparedVariantSource: IndexedGenomeVariantSourceState | undefined;
      if (track.presentation.kind === 'variants') {
        if (variantSource) throw new Error('A view restores at most one mutation source.');
        const runtime = variantRuntime as VariantTrackRuntime | null;
        if (!runtime) throw new Error('Variant admission returned no query runtime.');
        preparedVariantSource = durableVariantSource(admitted, runtime);
      }
      const contentFingerprint = await portableAdmittedContentFingerprint(
        admitted,
        preparedVariantSource
          ? {
              sizeBytes: preparedVariantSource.sourceSizeBytes,
              ...(preparedVariantSource.sourceMtimeNs
                ? { mtimeNs: preparedVariantSource.sourceMtimeNs }
                : {}),
            }
          : undefined
      );
      const changed = contentFingerprint !== track.source.contentFingerprint;
      if (changed && !input.acceptChangedData) {
        outcomes.push({
          trackId: track.trackId,
          label: track.label,
          status: 'skipped',
          message: `${track.label} changed since this view was saved and was not restored.`,
        });
        continue;
      }
      switch (track.presentation.kind) {
        case 'aligned-reads':
          bamTracks.push(portableBamTrackState(track, admitted));
          break;
        case 'variants':
          variantSource = preparedVariantSource;
          break;
        default:
          dataTracks.push(portableDataTrackState(track, admitted));
      }
      outcomes.push({
        trackId: track.trackId,
        label: track.label,
        status: changed
          ? 'changed'
          : input.relinkedTrackIds?.has(track.trackId)
            ? 'relinked'
            : 'restored',
        ...(changed
          ? { message: `${track.label} restored with data that changed since it was saved.` }
          : {}),
      });
    } catch (error) {
      if (input.signal?.aborted) throw error;
      outcomes.push({
        trackId: track.trackId,
        label: track.label,
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { dataTracks, bamTracks, ...(variantSource ? { variantSource } : {}), outcomes };
}

function portableBamTrackState(
  track: PortableGenomeViewTrack,
  admitted: AdmittedTrackSource
): IndexedGenomeBamTrackState {
  if (admitted.readerKind !== 'bam' || admitted.scientificKind !== 'reads') {
    throw new Error(`${track.label} did not admit as an aligned-read source.`);
  }
  const durable = durableAlignedReadAdmission(admitted);
  const bamPath =
    durable?.bamPath ?? (admitted.input?.kind === 'path' ? admitted.input.path : null);
  const indexPath =
    durable?.indexPath ?? (admitted.index?.kind === 'path' ? admitted.index.path : null);
  const referencePath =
    durable?.referencePath ??
    (admitted.reference?.kind === 'path' ? admitted.reference.path : undefined);
  if (!bamPath || !indexPath) {
    throw new Error(`${track.label} has no durable alignment and index locations.`);
  }
  const presentation = track.presentation.kind === 'aligned-reads' ? track.presentation : null;
  return {
    trackId: track.trackId,
    label: track.label,
    order: track.order,
    source: {
      bamPath,
      indexPath,
      ...(referencePath ? { referencePath } : {}),
      ...(admitted.alignedReadGeneration ? { generation: admitted.alignedReadGeneration } : {}),
    },
    admittedSource: admitted,
    visible: track.visible,
    coverageCutoffDepth: presentation?.coverageCutoffDepth ?? 0,
  };
}

export function summarizePortableTrackOutcomes(
  outcomes: ReadonlyArray<PortableTrackOutcome>
): string {
  const count = (status: PortableTrackOutcomeStatus) =>
    outcomes.filter((outcome) => outcome.status === status).length;
  const parts: string[] = [];
  const restored = count('restored') + count('relinked') + count('changed');
  parts.push(`${restored} of ${outcomes.length} tracks restored`);
  if (count('relinked') > 0) parts.push(`${count('relinked')} relinked`);
  if (count('changed') > 0) parts.push(`${count('changed')} with changed data`);
  if (count('skipped') > 0) parts.push(`${count('skipped')} skipped`);
  if (count('failed') > 0) parts.push(`${count('failed')} failed`);
  return `${parts.join(', ')}.`;
}
