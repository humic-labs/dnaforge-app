import type {
  GenomeDebugRequestKind,
  GenomeSessionShell,
  GenomeTileRequest,
  GenomeTrackDescriptor,
  GenomeTrackTile,
} from '../../shared/indexed-genome';

export class UnknownGenomeTrackError extends Error {
  readonly sessionId: string;
  readonly trackId: string;
  readonly knownTrackIds: string[];

  constructor(input: { sessionId: string; trackId: string; knownTrackIds: string[] }) {
    const known = input.knownTrackIds.length > 0 ? input.knownTrackIds.join(', ') : '<none>';
    super(
      `[genome] Unknown trackId ${input.trackId} for session ${input.sessionId}. Known tracks: ${known}.`
    );
    this.name = 'UnknownGenomeTrackError';
    this.sessionId = input.sessionId;
    this.trackId = input.trackId;
    this.knownTrackIds = input.knownTrackIds;
  }
}

export type GenomeTrackRouteKind = 'annotation' | 'sequence' | 'unsupported';

export interface GenomeTrackRoute {
  kind: GenomeTrackRouteKind;
  track: GenomeTrackDescriptor;
  traceKind: GenomeDebugRequestKind;
}

export function resolveGenomeTrackRoute(input: {
  session: GenomeSessionShell;
  request: GenomeTileRequest;
}): GenomeTrackRoute {
  const { session, request } = input;
  const track = session.tracks.find((candidate) => candidate.id === request.trackId);
  if (!track) {
    throw new UnknownGenomeTrackError({
      sessionId: session.sessionId,
      trackId: request.trackId,
      knownTrackIds: session.tracks.map((candidate) => candidate.id),
    });
  }
  switch (track.kind) {
    case 'annotation':
      return { kind: 'annotation', track, traceKind: 'annotation_tile' };
    case 'sequence':
      return { kind: 'sequence', track, traceKind: 'track_tile' };
    case 'alignment':
    case 'variant':
    case 'signal':
      return { kind: 'unsupported', track, traceKind: 'track_tile' };
  }
}

export function emptyAnnotationTileForSequenceOnlySession(input: {
  session: GenomeSessionShell;
  request: GenomeTileRequest;
  requestId: string;
}): GenomeTrackTile | null {
  const { session, request, requestId } = input;
  if (!request.trackId.endsWith(':annotations')) return null;
  if (session.tracks.some((track) => track.kind === 'annotation')) return null;
  if (session.manifest?.gffPath) return null;
  return {
    sessionId: session.sessionId,
    requestId,
    trackId: request.trackId,
    chrom: request.chrom,
    start: request.start,
    end: request.end,
    generation: request.generation,
    state: 'empty',
    fidelity: request.fidelity,
    validationState: 'metadata_match',
    byteCount: 0,
    recordCount: 0,
    sourceRecordCount: 0,
    layerTypes: [],
    featureModel: 'raw-gff3',
    cacheState: 'none',
    ...(request.laneEpoch !== undefined ? { laneEpoch: request.laneEpoch } : {}),
    features: [],
    message: 'This genome has no annotation index.',
  };
}
