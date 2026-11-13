import type { IndexedGenomeBamTrackState } from '../../shared/indexed-genome';
import {
  REMOTE_ALIGNMENT_LOCATOR_V1,
  type RemoteAlignmentMaterializationV1,
  type RemoteAlignmentLocatorV1,
  type RemoteGenomicsRuntimeStatusV1,
} from '../../shared/remote-genomics-ipc';
import {
  isCurrentAdmittedTrackSource,
  isAlignedReadReferenceGeneration,
  sameAdmittedTrackSourceIdentity,
  type AdmittedTrackSource,
} from '@waypoint/genome-data';
import {
  alignedReadSourceGenerationsEqual,
  isAlignedReadSourceGeneration,
} from '../../shared/aligned-read-source-generation';
import type { Lane } from './lane-contract-store';
import type { RemotePileupConnectionState } from './pileup-source';
import { buildReadPileupDataset } from './read-pileup-import';
import { remoteSshErrorMessage } from '../../shared/remote-ssh-error-message';

interface BamTrackAssemblyIdentity {
  readonly assemblyId: string;
  readonly assemblyDisplayName: string;
}

export function remoteReconnectFailureMessage(target: string, error: unknown): string {
  const message = remoteSshErrorMessage(error);
  if (/permission denied/iu.test(message))
    return `${message} Check ${target}'s SSH authentication and retry.`;
  return message;
}

export function canonicalRemoteReadIdentity(endpointId: string, alignmentPath: string): string {
  const path = alignmentPath.toLowerCase().endsWith('.cram')
    ? `${alignmentPath.slice(0, -'.cram'.length)}.bam`
    : alignmentPath;
  return `ssh://${endpointId}${path}`;
}

export function dedupePersistedBamTracks(
  tracks: readonly IndexedGenomeBamTrackState[]
): IndexedGenomeBamTrackState[] {
  const seen = new Set<string>();
  const unique: IndexedGenomeBamTrackState[] = [];
  for (const track of tracks) {
    const remote = track.source.remote;
    const key = remote
      ? canonicalRemoteReadIdentity(remote.endpointId, remote.alignmentPath)
      : `local\u0000${track.trackId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(track);
  }
  return unique;
}

export function savedRemoteAlignmentMatchesRuntime(
  saved: { readonly alignmentPath: string; readonly indexPath: string },
  served: { readonly alignmentPath: string; readonly indexPath: string }
): boolean {
  if (saved.alignmentPath === served.alignmentPath && saved.indexPath === served.indexPath) {
    return true;
  }
  if (!saved.alignmentPath.toLowerCase().endsWith('.bam')) return false;
  const cramPath = `${saved.alignmentPath.slice(0, -4)}.cram`;
  return served.alignmentPath === cramPath && served.indexPath.toLowerCase().endsWith('.crai');
}

export function remoteRuntimeStatusMatchesLocator(
  locator: RemoteAlignmentLocatorV1,
  status: RemoteGenomicsRuntimeStatusV1
): boolean {
  return (
    status.alignmentPath !== null &&
    (locator.endpointId === status.endpointId || locator.target === status.target) &&
    savedRemoteAlignmentMatchesRuntime(locator, {
      alignmentPath: status.alignmentPath,
      indexPath: status.indexPath ?? '',
    }) &&
    (locator.signalPath ?? null) === status.signalPath
  );
}

export function remotePileupConnectionFromStatus(
  status: RemoteGenomicsRuntimeStatusV1
): RemotePileupConnectionState {
  return {
    sourceId: status.sourceId,
    state: status.state,
    attempt: status.attempt,
    transportGeneration: status.transportGeneration,
    lastFailure: status.lastFailure,
    updatedAt: status.updatedAt,
  };
}

export function laneFromIndexedGenomeBamTrack(
  persisted: IndexedGenomeBamTrackState,
  assembly: BamTrackAssemblyIdentity,
  remoteMaterialization?: RemoteAlignmentMaterializationV1
): Lane {
  requirePersistedBamTrack(persisted);
  const remote = persisted.source.remote;
  if (remoteMaterialization && !remote) {
    throw new Error('A remote runtime was provided for a local aligned-read track.');
  }
  if (
    remoteMaterialization &&
    remote &&
    (remoteMaterialization.locator.target !== remote.target ||
      !savedRemoteAlignmentMatchesRuntime(remote, remoteMaterialization.locator))
  ) {
    throw new Error('The remote runtime does not match the saved aligned-read source.');
  }
  const effectiveRemote = remoteMaterialization?.locator ?? remote;
  const bamPath = remoteMaterialization?.bamUrl ?? persisted.source.bamPath;
  const indexPath = remoteMaterialization?.indexPath ?? persisted.source.indexPath;
  const base = buildReadPileupDataset({
    assemblyId: assembly.assemblyId,
    assemblyDisplayName: assembly.assemblyDisplayName,
    bamPath,
    indexPath,
    referencePath: effectiveRemote ? undefined : persisted.source.referencePath,
    generation: effectiveRemote ? undefined : persisted.source.generation,
    ...(effectiveRemote
      ? {
          sourceIdentity: canonicalRemoteReadIdentity(
            effectiveRemote.endpointId,
            effectiveRemote.alignmentPath
          ),
          label: persisted.label.replace(`${assembly.assemblyDisplayName}: `, ''),
          remote: {
            locator: effectiveRemote,
            ...(remoteMaterialization
              ? {
                  sessionId: remoteMaterialization.sessionId,
                  generation: remoteMaterialization.generation,
                  ...(remoteMaterialization.tileBaseUrl
                    ? { tileBaseUrl: remoteMaterialization.tileBaseUrl }
                    : {}),
                  connection: remoteMaterialization.runtimeStatus
                    ? remotePileupConnectionFromStatus(remoteMaterialization.runtimeStatus)
                    : {
                        state: 'online' as const,
                        attempt: 0,
                        transportGeneration: 1,
                        lastFailure: null,
                        updatedAt: Date.now(),
                      },
                }
              : {
                  connection: {
                    state: 'connecting' as const,
                    attempt: 0,
                    transportGeneration: 0,
                    lastFailure: null,
                    updatedAt: Date.now(),
                  },
                }),
          },
        }
      : {}),
  });
  return {
    assemblyId: assembly.assemblyId,
    order: persistedTrackOrder(persisted.order),
    visible: persisted.visible,
    ...(persisted.admittedSource ? { source: persisted.admittedSource } : {}),
    dataset: {
      ...base,
      trackId: persisted.trackId,
      label: persisted.label,
      color: persisted.color ?? base.color,
      trackPx: persisted.trackPx ?? base.trackPx,
      laneHeightPx: persisted.laneHeightPx ?? base.laneHeightPx,
      maxLanes: persisted.maxLanes ?? base.maxLanes,
      coverageCutoffDepth: normalizeCoverageCutoffDepth(persisted.coverageCutoffDepth),
    },
  };
}

export function laneFromUnreadablePersistedBamTrack(
  persisted: IndexedGenomeBamTrackState,
  assembly: BamTrackAssemblyIdentity,
  message: string
): Lane | null {
  const remote = persisted.source?.remote;
  const alignmentPath = remote?.alignmentPath ?? persisted.source?.bamPath;
  const indexPath = remote?.indexPath ?? persisted.source?.indexPath;
  if (
    typeof alignmentPath !== 'string' ||
    typeof indexPath !== 'string' ||
    !alignmentPath.startsWith('/') ||
    !indexPath.startsWith('/') ||
    typeof persisted.trackId !== 'string' ||
    persisted.trackId.length === 0
  ) {
    return null;
  }
  const endpointId = remote?.endpointId ?? '';
  const target = remote?.target ?? '';
  const base = buildReadPileupDataset({
    assemblyId: assembly.assemblyId,
    assemblyDisplayName: assembly.assemblyDisplayName,
    bamPath: alignmentPath,
    indexPath,
    sourceIdentity: canonicalRemoteReadIdentity(endpointId || target || 'saved', alignmentPath),
    label: persisted.label.replace(`${assembly.assemblyDisplayName}: `, ''),
    ...(remote
      ? {
          remote: {
            locator: {
              contract: REMOTE_ALIGNMENT_LOCATOR_V1,
              endpointId,
              target,
              alignmentPath,
              indexPath,
              ...(remote.signalPath ? { signalPath: remote.signalPath } : {}),
            },
          },
        }
      : {}),
  });
  return {
    assemblyId: assembly.assemblyId,
    order: persistedTrackOrder(persisted.order),
    visible: persisted.visible,
    dataset: {
      ...base,
      trackId: persisted.trackId,
      label: persisted.label,
      color: persisted.color ?? base.color,
      trackPx: persisted.trackPx ?? base.trackPx,
      laneHeightPx: persisted.laneHeightPx ?? base.laneHeightPx,
      maxLanes: persisted.maxLanes ?? base.maxLanes,
      coverageCutoffDepth: normalizeCoverageCutoffDepth(persisted.coverageCutoffDepth),
      source: {
        ...base.source!,
        admissionError: `${message} Repair opens this saved file again.`,
      },
    },
  };
}

export function indexedGenomeBamTrackFromLane(lane: Lane): IndexedGenomeBamTrackState | null {
  const { dataset } = lane;
  const remote = dataset.source?.remote?.locator;
  const runtimeBamPath = dataset.source?.bamPath;
  const runtimeIndexPath = dataset.source?.indexPath;
  const runtimeReferencePath = dataset.source?.referencePath;
  const durableAdmission = durableAlignedReadAdmission(lane.source);
  const bamPath = durableAdmission?.bamPath ?? runtimeBamPath;
  const indexPath = durableAdmission?.indexPath ?? runtimeIndexPath;
  const referencePath = durableAdmission?.referencePath ?? runtimeReferencePath;
  const htsget = durableAdmission?.kind === 'htsget';
  if (
    dataset.kind !== 'pileup' ||
    typeof runtimeBamPath !== 'string' ||
    !isAlignmentPath(runtimeBamPath) ||
    (!htsget && (typeof runtimeIndexPath !== 'string' || runtimeIndexPath.trim().length === 0)) ||
    typeof bamPath !== 'string' ||
    !(remote ? isAlignmentPath(remote.alignmentPath) : isAlignmentPath(bamPath)) ||
    typeof indexPath !== 'string' ||
    indexPath.trim().length === 0 ||
    (!remote &&
      isCramPath(bamPath) &&
      (typeof referencePath !== 'string' || referencePath.trim().length === 0))
  ) {
    return null;
  }
  const descriptor: IndexedGenomeBamTrackState = {
    trackId: dataset.trackId,
    label: dataset.label,
    order: lane.order,
    source: {
      bamPath: remote?.alignmentPath ?? bamPath,
      indexPath: remote?.indexPath ?? indexPath,
      ...(!remote && referencePath ? { referencePath } : {}),
      ...(!remote && !durableAdmission && dataset.source?.generation
        ? { generation: dataset.source.generation }
        : {}),
      ...(remote ? { remote } : {}),
    },
    ...(lane.source ? { admittedSource: lane.source } : {}),
    visible: lane.visible,
    color: dataset.color,
    trackPx: dataset.trackPx,
    laneHeightPx: dataset.laneHeightPx ?? 3,
    maxLanes: dataset.maxLanes ?? 80,
    coverageCutoffDepth: normalizeCoverageCutoffDepth(dataset.coverageCutoffDepth),
  };
  try {
    requirePersistedBamTrack(descriptor);
  } catch {
    return null;
  }
  return descriptor;
}

export function mergeLiveIndexedGenomeBamTracks(
  previous: readonly IndexedGenomeBamTrackState[],
  live: readonly IndexedGenomeBamTrackState[],
  unavailableTrackIds: ReadonlySet<string>
): IndexedGenomeBamTrackState[] {
  const liveById = new Map(live.map((track) => [track.trackId, track]));
  const merged: IndexedGenomeBamTrackState[] = [];
  for (const track of previous) {
    const current = liveById.get(track.trackId);
    if (current) {
      merged.push(current);
      liveById.delete(track.trackId);
    } else if (unavailableTrackIds.has(track.trackId)) {
      merged.push(track);
    }
  }
  merged.push(...liveById.values());
  return merged.sort(
    (left, right) => persistedTrackOrder(left.order) - persistedTrackOrder(right.order)
  );
}

export function indexedGenomeBamTracksEqual(
  left: readonly IndexedGenomeBamTrackState[],
  right: readonly IndexedGenomeBamTrackState[]
): boolean {
  return (
    left.length === right.length &&
    left.every((track, index) => {
      const peer = right[index];
      return (
        peer != null &&
        track.trackId === peer.trackId &&
        track.label === peer.label &&
        track.order === peer.order &&
        track.source.bamPath === peer.source.bamPath &&
        track.source.indexPath === peer.source.indexPath &&
        track.source.referencePath === peer.source.referencePath &&
        remoteLocatorsEqual(track.source.remote, peer.source.remote) &&
        alignedReadSourceGenerationsEqual(track.source.generation, peer.source.generation) &&
        optionalAdmittedSourcesEqual(track.admittedSource, peer.admittedSource) &&
        track.visible === peer.visible &&
        normalizedBamColor(track.color) === normalizedBamColor(peer.color) &&
        normalizedBamTrackPx(track.trackPx) === normalizedBamTrackPx(peer.trackPx) &&
        normalizedBamLaneHeightPx(track.laneHeightPx) ===
          normalizedBamLaneHeightPx(peer.laneHeightPx) &&
        normalizedBamMaxLanes(track.maxLanes) === normalizedBamMaxLanes(peer.maxLanes) &&
        track.coverageCutoffDepth === peer.coverageCutoffDepth
      );
    })
  );
}

export function requirePersistedBamTrack(
  value: IndexedGenomeBamTrackState
): asserts value is IndexedGenomeBamTrackState {
  if (!value || typeof value !== 'object') throw new Error('Invalid persisted aligned-read track.');
  if (typeof value.trackId !== 'string' || value.trackId.trim().length === 0) {
    throw new Error('Persisted aligned-read track has no track identity.');
  }
  if (typeof value.label !== 'string' || value.label.trim().length === 0) {
    throw new Error(`Persisted aligned-read track ${value.trackId} has no label.`);
  }
  if (
    !value.source ||
    typeof value.source.bamPath !== 'string' ||
    !isAlignmentPath(value.source.bamPath)
  ) {
    throw new Error(
      `Persisted aligned-read track ${value.label} has no valid BAM/CRAM source path.`
    );
  }
  if (value.source.remote !== undefined) {
    const remote = value.source.remote;
    if (
      remote.contract !== REMOTE_ALIGNMENT_LOCATOR_V1 ||
      typeof remote.endpointId !== 'string' ||
      remote.endpointId.trim().length === 0 ||
      typeof remote.target !== 'string' ||
      remote.target.trim().length === 0 ||
      remote.alignmentPath !== value.source.bamPath ||
      remote.indexPath !== value.source.indexPath ||
      !remote.alignmentPath.startsWith('/') ||
      !remote.indexPath.startsWith('/') ||
      (remote.tileServerReceiptPath !== undefined &&
        (typeof remote.tileServerReceiptPath !== 'string' ||
          !remote.tileServerReceiptPath.startsWith('/') ||
          remote.tileServerReceiptPath.includes('\0'))) ||
      !remoteAlignmentAndIndexMatch(remote.alignmentPath, remote.indexPath)
    ) {
      throw new Error(`Persisted aligned-read track ${value.label} has an invalid remote source.`);
    }
  }
  if (typeof value.source.indexPath !== 'string' || value.source.indexPath.trim().length === 0) {
    throw new Error(`Persisted aligned-read track ${value.label} has no index source path.`);
  }
  if (
    !value.source.remote &&
    isCramPath(value.source.bamPath) &&
    (typeof value.source.referencePath !== 'string' ||
      value.source.referencePath.trim().length === 0)
  ) {
    throw new Error(`Persisted CRAM track ${value.label} has no reference FASTA source path.`);
  }
  if (
    value.source.generation !== undefined &&
    !isAlignedReadSourceGeneration(value.source.generation)
  ) {
    throw new Error(`Persisted aligned-read track ${value.label} has invalid source generation.`);
  }
  if (value.admittedSource !== undefined) {
    requireAlignedReadAdmission(value, value.admittedSource);
  }
  if (typeof value.visible !== 'boolean') {
    throw new Error(`Persisted aligned-read track ${value.label} has invalid visibility state.`);
  }
  if (
    value.order !== undefined &&
    (!Number.isSafeInteger(value.order) || (value.order ?? -1) < 0)
  ) {
    throw new Error(`Persisted aligned-read track ${value.label} has an invalid order.`);
  }
  if (
    typeof value.coverageCutoffDepth !== 'number' ||
    !Number.isFinite(value.coverageCutoffDepth) ||
    value.coverageCutoffDepth < 0
  ) {
    throw new Error(`Persisted aligned-read track ${value.label} has an invalid coverage cutoff.`);
  }
  if (
    value.color !== undefined &&
    (!Number.isInteger(value.color) || value.color < 0 || value.color > 0xff_ffff)
  ) {
    throw new Error(`Persisted aligned-read track ${value.label} has an invalid color.`);
  }
  for (const [field, candidate] of [
    ['track height', value.trackPx],
    ['row height', value.laneHeightPx],
  ] as const) {
    if (candidate !== undefined && (!Number.isFinite(candidate) || candidate <= 0)) {
      throw new Error(`Persisted aligned-read track ${value.label} has an invalid ${field}.`);
    }
  }
  if (
    value.maxLanes !== undefined &&
    (!Number.isSafeInteger(value.maxLanes) || value.maxLanes <= 0)
  ) {
    throw new Error(`Persisted aligned-read track ${value.label} has an invalid row limit.`);
  }
}

function requireAlignedReadAdmission(
  track: IndexedGenomeBamTrackState,
  source: AdmittedTrackSource
): void {
  if (!isCurrentAdmittedTrackSource(source)) {
    throw new Error(
      `Persisted aligned-read track ${track.label} has an invalid admission receipt.`
    );
  }
  const format = isCramPath(track.source.bamPath) ? 'cram' : 'bam';
  const local = source.input?.kind === 'path' && source.index?.kind === 'path';
  const remote = source.input?.kind === 'url' && source.index?.kind === 'url';
  const htsget = source.request?.source.kind === 'htsget';
  if (
    source.readerKind !== 'bam' ||
    source.scientificKind !== 'reads' ||
    source.formatId !== format ||
    (!local && !remote && !htsget) ||
    (local &&
      (source.input?.kind !== 'path' ||
        source.input.path !== track.source.bamPath ||
        source.index?.kind !== 'path' ||
        source.index.path !== track.source.indexPath)) ||
    (remote &&
      (source.input?.kind !== 'url' ||
        source.input.url !== track.source.bamPath ||
        source.index?.kind !== 'url' ||
        source.index.url !== track.source.indexPath)) ||
    (htsget &&
      (source.request?.source.kind !== 'htsget' ||
        source.request.source.dataClass !== 'reads' ||
        source.uri !== `htsget:${htsgetIdentity(source)}` ||
        track.source.bamPath !==
          `htsget-source://${htsgetIdentity(source)}/source.${source.formatId}` ||
        track.source.indexPath !==
          `htsget-source://${htsgetIdentity(source)}/managed.${
            source.formatId === 'cram' ? 'crai' : 'bai'
          }`)) ||
    (track.source.referencePath
      ? source.reference?.kind !== 'path' || source.reference.path !== track.source.referencePath
      : source.reference !== undefined) ||
    (local &&
      !alignedReadSourceGenerationsEqual(source.alignedReadGeneration, track.source.generation)) ||
    (remote &&
      (track.source.generation !== undefined ||
        source.alignedReadGeneration !== undefined ||
        source.expectedValidators?.contentLength === undefined ||
        source.indexExpectedValidators?.contentLength === undefined ||
        (format === 'cram'
          ? !isAlignedReadReferenceGeneration(source.alignedReadReferenceGeneration) ||
            source.alignedReadReferenceGeneration.reference.canonicalPath !==
              track.source.referencePath
          : source.alignedReadReferenceGeneration !== undefined))) ||
    (htsget &&
      (track.source.generation !== undefined ||
        source.alignedReadGeneration !== undefined ||
        source.expectedValidators !== undefined ||
        source.indexExpectedValidators !== undefined ||
        (format === 'cram'
          ? !isAlignedReadReferenceGeneration(source.alignedReadReferenceGeneration) ||
            source.alignedReadReferenceGeneration.reference.canonicalPath !==
              track.source.referencePath
          : source.alignedReadReferenceGeneration !== undefined)))
  ) {
    throw new Error(
      `Persisted aligned-read track ${track.label} admission does not match its runtime source.`
    );
  }
}

export function durableAlignedReadAdmission(source: AdmittedTrackSource | undefined):
  | {
      readonly kind: 'http' | 'htsget';
      readonly bamPath: string;
      readonly indexPath: string;
      readonly referencePath?: string;
    }
  | undefined {
  if (source?.readerKind !== 'bam') {
    return undefined;
  }
  if (source.request?.source.kind === 'htsget') {
    const identity = htsgetIdentity(source);
    if (!identity || (source.formatId !== 'bam' && source.formatId !== 'cram')) return undefined;
    return {
      kind: 'htsget',
      bamPath: `htsget-source://${identity}/source.${source.formatId}`,
      indexPath: `htsget-source://${identity}/managed.${
        source.formatId === 'cram' ? 'crai' : 'bai'
      }`,
      ...(source.reference?.kind === 'path' ? { referencePath: source.reference.path } : {}),
    };
  }
  if (source.input?.kind !== 'url' || source.index?.kind !== 'url') return undefined;
  return {
    kind: 'http',
    bamPath: source.input.url,
    indexPath: source.index.url,
    ...(source.reference?.kind === 'path' ? { referencePath: source.reference.path } : {}),
  };
}

function htsgetIdentity(source: AdmittedTrackSource): string {
  return source.uri.startsWith('htsget:') && /^[0-9a-f]{64}$/u.test(source.uri.slice(7))
    ? source.uri.slice(7)
    : '';
}

function optionalAdmittedSourcesEqual(
  left: AdmittedTrackSource | undefined,
  right: AdmittedTrackSource | undefined
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return sameAdmittedTrackSourceIdentity(left, right);
}

function normalizeCoverageCutoffDepth(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function persistedTrackOrder(value: number | undefined): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function normalizedBamColor(value: number | undefined): number {
  return value ?? 0x4a90d9;
}

function normalizedBamTrackPx(value: number | undefined): number {
  return value ?? 276;
}

function normalizedBamLaneHeightPx(value: number | undefined): number {
  return value ?? 3;
}

function normalizedBamMaxLanes(value: number | undefined): number {
  return value ?? 80;
}

function remoteLocatorsEqual(
  left: IndexedGenomeBamTrackState['source']['remote'],
  right: IndexedGenomeBamTrackState['source']['remote']
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.contract === right.contract &&
    left.endpointId === right.endpointId &&
    left.target === right.target &&
    left.alignmentPath === right.alignmentPath &&
    left.indexPath === right.indexPath &&
    left.signalPath === right.signalPath &&
    left.tileServerReceiptPath === right.tileServerReceiptPath
  );
}

function remoteAlignmentAndIndexMatch(alignmentPath: string, indexPath: string): boolean {
  const alignment = alignmentPath.toLowerCase();
  const index = indexPath.toLowerCase();
  if (alignment.endsWith('.cram')) return index.endsWith('.crai') || index.endsWith('.csi');
  if (alignment.endsWith('.bam')) return index.endsWith('.bai') || index.endsWith('.csi');
  return false;
}

function isAlignmentPath(path: string): boolean {
  return /\.(?:bam|cram)$/.test(path.split(/[?#]/, 1)[0]?.toLowerCase() ?? '');
}

function isCramPath(path: string): boolean {
  return Boolean(path.split(/[?#]/, 1)[0]?.toLowerCase().endsWith('.cram'));
}
