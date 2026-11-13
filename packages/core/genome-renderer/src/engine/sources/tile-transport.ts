export type TileRouteKind =
  | 'coverage'
  | 'coverage-assembly'
  | 'alignment'
  | 'annotation'
  | 'sequence';

export type TileFetchPurpose =
  | 'critical-handoff'
  | 'current'
  | 'pan-lead'
  | 'adjacent-finer'
  | 'coarser'
  | 'unknown';

export interface TileTransportPriority {
  purpose: TileFetchPurpose;
  epoch: number;
  core: boolean;
  marginDistanceTiles: number;
}

export interface TileTransportRequest {
  readonly kind: TileRouteKind;
  readonly level: number;
  readonly tileIndex: number;
  readonly body: Record<string, unknown>;
  readonly priority?: TileTransportPriority;
  readonly deadlineAtMs?: number;
}

export class TileTransportDeadlineError extends Error {
  constructor() {
    super('Tile request deadline elapsed before dispatch.');
    this.name = 'TileTransportDeadlineError';
  }
}

export interface TileTransportResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly body: unknown;
}

export type TileTransport = (
  req: TileTransportRequest,
  signal: AbortSignal
) => Promise<TileTransportResponse>;

export function tileRoutePath(req: TileTransportRequest): string {
  if (req.kind === 'coverage-assembly') {
    return `/tiles/coverage-assembly/${req.level}/${req.tileIndex}`;
  }
  return `/tiles/${req.kind}/${req.level}/${req.tileIndex}`;
}

export interface HttpTileTransportOptions {
  readonly baseUrl: string;
  readonly sessionToken?: string;
  readonly fetchImpl?: typeof fetch;
}

export const SIDECAR_SESSION_HEADER = 'X-DNAForge-Session';

export function httpTileTransport(opts: HttpTileTransportOptions): TileTransport {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, '');
  return async (req, signal) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (opts.sessionToken) headers[SIDECAR_SESSION_HEADER] = opts.sessionToken;
    const res = await fetchImpl(`${base}${tileRoutePath(req)}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(req.body),
      signal,
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { ok: res.ok, status: res.status, body };
  };
}
