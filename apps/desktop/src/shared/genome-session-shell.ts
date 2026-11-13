import { userStateForGenomeTrackState } from './indexed-genome';
import { isAnnotationBearingExtension } from '../features/sequence/indexed-genome-paths';
import type {
  GenomeDebugBudgets,
  GenomeDebugOpenTimings,
  GenomeDebugQueues,
  GenomeDebugRequestTrace,
  GenomeDebugSnapshot,
  GenomeOpenSource,
  GenomeSessionShell,
  GenomeTrackDescriptor,
  GenomeTrackTile,
  GenomeTileRequest,
  IndexedGenomeTabState,
} from './indexed-genome';

export interface GenomeSessionDebugDiagnostics {
  openAcceptedAt?: number;
  shellReturnedAt?: number;
  coordinateReadyAt?: number;
  readyAt?: number;
  errorAt?: number;
  pendingRequests?: number;
  workerCount?: number;
  budgets?: GenomeDebugBudgets;
  recentRequests?: GenomeDebugRequestTrace[];
}

export interface GenomeSourceStat {
  size: number;
  mtimeMs: number;
  ctimeMs?: number;
  ino?: number;
  dev?: number;
}

let nextSessionOrdinal = 1;

export function createGenomeSessionShell(input: {
  source: GenomeOpenSource;
  resolvedSourcePath: string;
  stat: GenomeSourceStat;
  now?: number;
}): GenomeSessionShell {
  const openedAt = input.now ?? Date.now();
  const chrom = input.source.chrom ?? inferChrom(input.source.sourcePath);
  const sourceFingerprint = provisionalFingerprint({
    resolvedSourcePath: input.resolvedSourcePath,
    stat: input.stat,
  });
  const sessionId = `genome-${openedAt.toString(36)}-${nextSessionOrdinal++}`;
  const intent = input.source.intent;
  const preparedReferenceReadOnly =
    intent?.kind === 'reference-assembly' || intent?.kind === 'internal-assembly-segment';
  const assemblyAssetGeneration =
    intent?.kind === 'reference-assembly' ||
    (intent?.kind === 'internal-assembly-segment' && intent.assetGeneration)
      ? intent.assetGeneration
      : undefined;

  return {
    sessionId,
    sourcePath: input.source.sourcePath,
    sourceFingerprint,
    chrom,
    sourceSizeBytes: input.stat.size,
    ...(preparedReferenceReadOnly ? { preparedReferenceReadOnly: true as const } : {}),
    ...(assemblyAssetGeneration ? { assemblyAssetGeneration } : {}),
    ...(intent?.kind === 'reference-assembly'
      ? {
          assemblyAnnotationProductsReadiness: intent.annotationProductsReadiness,
          assemblySearchReadiness:
            intent.searchReadiness === 'not-applicable'
              ? ('not-applicable' as const)
              : ('pending' as const),
        }
      : {}),
    openReady: false,
    coordinateReady: false,
    validationState: 'metadata_match',
    tracks: createInitialTracks({
      chrom,
      sourceExt: input.source.sourceExt ?? posixExtname(input.source.sourcePath),
      coordinateReady: false,
      annotationReady: false,
      annotationApplicable: annotationBearingSourceExtension(
        input.source.sourceExt ?? posixExtname(input.source.sourcePath)
      ),
    }),
    openedAt,
  };
}

export function createPlaceholderTrackTile(input: {
  session: GenomeSessionShell;
  requestId: string;
  request: GenomeTileRequest;
  track?: GenomeTrackDescriptor;
}): GenomeTrackTile {
  return {
    sessionId: input.session.sessionId,
    requestId: input.requestId,
    trackId: input.request.trackId,
    chrom: input.request.chrom,
    start: input.request.start,
    end: input.request.end,
    generation: input.request.generation,
    state: 'missing',
    fidelity: 'best_available',
    validationState: input.session.validationState,
    byteCount: 0,
    recordCount: 0,
    ...(input.request.laneEpoch !== undefined ? { laneEpoch: input.request.laneEpoch } : {}),
    message: placeholderMessageForTrackKind(input.track?.kind),
  };
}

function placeholderMessageForTrackKind(kind: GenomeTrackDescriptor['kind'] | undefined): string {
  switch (kind) {
    case 'sequence':
      return 'Sequence tiles use getSequenceWindow; track-tile path is a placeholder.';
    case 'annotation':
      return 'Annotation tile production requires a coordinate-ready manifest.';
    case 'alignment':
      return 'Alignment tile production is not yet implemented in this build.';
    case 'signal':
      return 'Signal tile production is not yet implemented in this build.';
    case 'variant':
      return 'Variant tile production is not yet implemented in this build.';
    default:
      return 'Tile API is registered; tile production is implemented in the next Phase 1 slice.';
  }
}

export function createDebugSnapshot(
  session: GenomeSessionShell,
  diagnostics: GenomeSessionDebugDiagnostics = {},
  options: { homeDir?: string } = {}
): GenomeDebugSnapshot {
  const open = createOpenTimings(session, diagnostics);
  const sourcePathRedacted = redactGenomePath(session.sourcePath, options.homeDir);
  return {
    sessionId: session.sessionId,
    sourceFingerprint: redactGenomePath(session.sourceFingerprint, options.homeDir),
    sourcePath: sourcePathRedacted,
    sourcePathRedacted,
    chrom: session.chrom,
    coordinateReady: session.coordinateReady,
    validationState: session.validationState,
    openedAt: session.openedAt,
    trackStates: session.tracks.map((track) => ({
      id: track.id,
      kind: track.kind,
      state: track.state,
      userState: track.userState,
    })),
    sourceIndexes: session.manifest
      ? {
          fastaPath: redactGenomePath(session.manifest.fastaPath, options.homeDir),
          faiPath: redactGenomePath(session.manifest.faiPath, options.homeDir),
          gffPath: session.manifest.gffPath
            ? redactGenomePath(session.manifest.gffPath, options.homeDir)
            : session.manifest.gffPath,
          tbiPath: session.manifest.tbiPath
            ? redactGenomePath(session.manifest.tbiPath, options.homeDir)
            : session.manifest.tbiPath,
        }
      : undefined,
    open,
    budgets: diagnostics.budgets ?? {
      maxSequenceWindowBases: 0,
      maxAnnotationViewportTileBases: 0,
      maxAnnotationViewportTileBytes: 0,
    },
    queues: createQueueSnapshot(diagnostics),
    recentRequests: (diagnostics.recentRequests ?? []).map((request) => ({
      ...request,
      tileKey: request.tileKey ? redactGenomePath(request.tileKey, options.homeDir) : undefined,
    })),
  };
}

export function redactGenomePath(value: string, homeDir?: string): string {
  if (!homeDir) return value;
  const normalizedHome = homeDir.replace(/\/+$/, '');
  if (!normalizedHome) return value;
  if (value === normalizedHome) return '~';
  return value.split(`${normalizedHome}/`).join('~/');
}

function createOpenTimings(
  session: GenomeSessionShell,
  diagnostics: GenomeSessionDebugDiagnostics
): GenomeDebugOpenTimings {
  const acceptedAt = diagnostics.openAcceptedAt ?? session.openedAt;
  const shellCreatedAt = session.openedAt;
  const status: GenomeDebugOpenTimings['status'] = diagnostics.errorAt
    ? 'error'
    : diagnostics.readyAt
      ? 'ready'
      : diagnostics.coordinateReadyAt || session.coordinateReady
        ? 'coordinate_ready'
        : 'source_accepted';
  return {
    acceptedAt,
    shellCreatedAt,
    shellReturnedAt: diagnostics.shellReturnedAt,
    coordinateReadyAt: diagnostics.coordinateReadyAt,
    readyAt: diagnostics.readyAt,
    errorAt: diagnostics.errorAt,
    elapsedToShellMs: Math.max(0, shellCreatedAt - acceptedAt),
    ...(diagnostics.coordinateReadyAt !== undefined
      ? { elapsedToCoordinateReadyMs: Math.max(0, diagnostics.coordinateReadyAt - acceptedAt) }
      : {}),
    ...(diagnostics.readyAt !== undefined
      ? { elapsedToReadyMs: Math.max(0, diagnostics.readyAt - acceptedAt) }
      : {}),
    status,
  };
}

function createQueueSnapshot(diagnostics: GenomeSessionDebugDiagnostics): GenomeDebugQueues {
  const recentRequests = diagnostics.recentRequests ?? [];
  return {
    pendingRequests: diagnostics.pendingRequests ?? 0,
    recentRequestCount: recentRequests.length,
    workerCount: diagnostics.workerCount ?? 0,
  };
}

export function updateGenomeSessionShellFromTabState(input: {
  session: GenomeSessionShell;
  tabState: IndexedGenomeTabState;
}): GenomeSessionShell {
  const manifest = input.tabState.manifest;
  const length = input.tabState.metadata?.length ?? manifest?.length;
  const coordinateReady = Boolean(manifest && typeof length === 'number' && length > 0);
  const chrom = input.tabState.chrom || manifest?.chrom || input.session.chrom;

  return {
    ...input.session,
    sourcePath: input.tabState.sourcePath,
    chrom,
    sourceSizeBytes: input.tabState.sourceSizeBytes ?? input.session.sourceSizeBytes,
    coordinateReady,
    ...(coordinateReady && typeof length === 'number' ? { length } : { length: undefined }),
    ...(manifest
      ? {
          manifest:
            typeof length === 'number'
              ? {
                  ...manifest,
                  length,
                }
              : manifest,
        }
      : { manifest: undefined }),
    validationState: coordinateReady ? 'strong_match' : input.session.validationState,
    tracks: createInitialTracks({
      chrom,
      sourceExt: input.tabState.sourceExt,
      coordinateReady,
      annotationReady: Boolean(manifest?.gffPath && manifest?.tbiPath),
      annotationApplicable: Boolean(manifest?.gffPath && manifest?.tbiPath),
    }),
  };
}

export function markGenomeSessionShellError(input: {
  session: GenomeSessionShell;
  message: string;
}): GenomeSessionShell {
  return {
    ...input.session,
    preparationError: input.message,
    tracks: input.session.tracks.map((track) => ({
      ...track,
      state: 'error',
      userState: 'Needs attention',
      message: input.message,
    })),
  };
}

export function markGenomeSessionTrackError(input: {
  session: GenomeSessionShell;
  kind: GenomeTrackDescriptor['kind'];
  message: string;
}): GenomeSessionShell {
  return {
    ...input.session,
    tracks: input.session.tracks.map((track) =>
      track.kind === input.kind
        ? {
            ...track,
            state: 'error',
            userState: 'Needs attention',
            message: input.message,
          }
        : track
    ),
  };
}

function createInitialTracks(input: {
  chrom: string;
  sourceExt: string;
  coordinateReady: boolean;
  annotationReady: boolean;
  annotationApplicable: boolean;
}): GenomeTrackDescriptor[] {
  const ext = input.sourceExt.toLowerCase().replace(/^\./, '');
  const annotationState = input.annotationReady
    ? 'ready'
    : ext === 'gb' || ext === 'gbff' || ext === 'genbank'
      ? 'building_cache'
      : 'index_required';
  const sequenceState = input.coordinateReady ? 'coordinate_ready' : 'metadata_pending';
  const sequenceTrack: GenomeTrackDescriptor = {
    id: `${input.chrom}:sequence`,
    kind: 'sequence',
    label: 'Sequence',
    state: sequenceState,
    userState: userStateForGenomeTrackState(sequenceState),
    message: input.coordinateReady
      ? 'Reference coordinates are available.'
      : 'Reference metadata is being resolved.',
  };
  if (!input.annotationApplicable) return [sequenceTrack];
  return [
    sequenceTrack,
    {
      id: `${input.chrom}:annotations`,
      kind: 'annotation',
      label: 'Annotations',
      state: annotationState,
      userState: userStateForGenomeTrackState(annotationState),
      message:
        annotationState === 'ready'
          ? 'Annotation index is available.'
          : 'Annotation index/cache is not ready yet.',
    },
  ];
}

function annotationBearingSourceExtension(sourceExt: string): boolean {
  const ext = sourceExt.toLowerCase().replace(/^\./, '').replace(/\.gz$/, '');
  return isAnnotationBearingExtension(ext);
}

function inferChrom(sourcePath: string): string {
  const name = posixBasename(sourcePath).replace(
    /\.(gbff|gb|genbank|fasta|fa|fna|gff3|gtf)(\.gz)?$/i,
    ''
  );
  return name || 'unknown';
}

function provisionalFingerprint(input: {
  resolvedSourcePath: string;
  stat: GenomeSourceStat;
}): string {
  return [
    'provisional',
    input.resolvedSourcePath,
    input.stat.size,
    Math.trunc(input.stat.mtimeMs),
    Math.trunc(input.stat.ctimeMs ?? 0),
    input.stat.dev ?? 'dev-unknown',
    input.stat.ino ?? 'ino-unknown',
  ].join(':');
}

function posixBasename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

function posixExtname(path: string): string {
  const name = posixBasename(path);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot);
}
