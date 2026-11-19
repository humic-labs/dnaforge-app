import { sidecarFetch } from '../../services/sidecar-session';
import {
  buildCoverageCorridorFloorGpuAtlas,
  CoverageCorridorFloorContractError,
  coverageCorridorFloorSegments,
  decodeAuthenticatedCoverageCorridorFloorPayload,
  type AuthenticatedCoverageCorridorFloorPayload,
  type LoadCoverageCorridorFloorOptions,
  type PreparedCoverageCorridorFloor,
  type VerifiedCoverageCorridorFloor,
} from './coverage-corridor-floor-payload';

export * from './coverage-corridor-floor-payload';

const COVERAGE_CORRIDOR_FLOOR_NOT_READY_STATUS = 425;
const COVERAGE_CORRIDOR_FLOOR_INITIAL_RETRY_MS = 100;
const COVERAGE_CORRIDOR_FLOOR_MAX_RETRY_MS = 2_000;

export async function loadPreparedCoverageCorridorFloor(
  options: LoadCoverageCorridorFloorOptions
): Promise<PreparedCoverageCorridorFloor | null> {
  const floor = await loadCoverageCorridorFloor(options);
  return floor == null
    ? null
    : {
        floor,
        atlas: buildCoverageCorridorFloorGpuAtlas(floor),
      };
}

export async function loadCoverageCorridorFloor(
  options: LoadCoverageCorridorFloorOptions
): Promise<VerifiedCoverageCorridorFloor | null> {
  const payload = await fetchAuthenticatedCoverageCorridorFloorPayload(options);
  return decodeAuthenticatedCoverageCorridorFloorPayload(options, payload);
}

export async function fetchAuthenticatedCoverageCorridorFloorPayload(
  options: LoadCoverageCorridorFloorOptions
): Promise<AuthenticatedCoverageCorridorFloorPayload> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const segments = coverageCorridorFloorSegments(options.assembly);
  const url = `${options.baseUrl.replace(/\/+$/, '')}/tiles/coverage-corridor-floor`;
  const request: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    signal: options.signal,
    body: JSON.stringify({
      bamPath: options.source.bamPath,
      ...(options.source.indexPath ? { indexPath: options.source.indexPath } : {}),
      ...(options.source.referencePath ? { referencePath: options.source.referencePath } : {}),
      ...(options.source.generation ? { sourceGeneration: options.source.generation } : {}),
      segments,
    }),
  };
  let retryDelayMs = COVERAGE_CORRIDOR_FLOOR_INITIAL_RETRY_MS;
  let response = await sidecarFetch(url, request, fetchImpl);
  while (response.status === COVERAGE_CORRIDOR_FLOOR_NOT_READY_STATUS) {
    await abortableCoverageCorridorDelay(retryDelayMs, options.signal);
    retryDelayMs = Math.min(COVERAGE_CORRIDOR_FLOOR_MAX_RETRY_MS, retryDelayMs * 2);
    response = await sidecarFetch(url, request, fetchImpl);
  }
  if (!response.ok) {
    throw new CoverageCorridorFloorContractError(
      `coverage corridor floor request failed with HTTP ${response.status}`
    );
  }
  return {
    bytes: await response.arrayBuffer(),
    contractHeader: response.headers.get('X-Waypoint-Coverage-Contract'),
    sourceHeader: response.headers.get('X-Waypoint-Coverage-Source'),
  };
}

function abortableCoverageCorridorDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
