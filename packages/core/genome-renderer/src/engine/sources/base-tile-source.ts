import type { AssemblySegment } from '../../assembly-layout';
import {
  abortError,
  type TileData,
  type TileFetchContext,
  type TileKey,
  type TileSource,
} from '../tile-source';
import type {
  TileRouteKind,
  TileTransport,
  TileTransportPriority,
  TileTransportResponse,
} from './tile-transport';
import { TileTransportDeadlineError } from './tile-transport';

export interface TileSourceShape {
  readonly id: string;
  readonly kind: TileRouteKind;
  readonly levelRange: readonly [number, number];
  readonly prefetch?: TileSource['prefetch'];
  buildBody(level: number, index: number, segments: AssemblySegment[]): Record<string, unknown>;
  countOf(payload: unknown): number;
  byteSizeOf(payload: unknown): number;
}

export interface BaseTileSourceOptions {
  readonly transport: TileTransport;
  readonly timeoutMs?: number;
}

export function errorReasonForStatus(res: TileTransportResponse): string {
  if (res.status === 404) {
    const detail = readDetail(res.body);
    return detail ?? 'not-found';
  }
  if (res.status === 425) {
    const detail = readDetail(res.body);
    return detail ?? 'not-ready';
  }
  if (res.status === 429) return 'queue-full';
  return `http-${res.status}`;
}

function readDetail(body: unknown): string | undefined {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    if (typeof b.detail === 'string') return b.detail;
    if (typeof b.error === 'string') return b.error;
  }
  return undefined;
}

const TIMEOUT = Symbol('tile-soft-timeout');
const RETRYABLE_NOT_READY_STATUS = 425;
const NOT_READY_RETRY_INITIAL_DELAY_MS = 250;
const NOT_READY_RETRY_MAX_DELAY_MS = 4_000;

export class BaseTileSource implements TileSource {
  readonly id: string;
  readonly levelRange: readonly [number, number];
  readonly prefetch?: TileSource['prefetch'];
  private readonly shape: TileSourceShape;
  private readonly transport: TileTransport;
  private readonly timeoutMs: number;

  constructor(shape: TileSourceShape, opts: BaseTileSourceOptions) {
    this.id = shape.id;
    this.levelRange = shape.levelRange;
    this.prefetch = shape.prefetch;
    this.shape = shape;
    this.transport = opts.transport;
    this.timeoutMs = opts.timeoutMs ?? 0;
  }

  async fetchTile(
    level: number,
    index: number,
    segments: AssemblySegment[],
    signal: AbortSignal,
    context?: TileFetchContext
  ): Promise<TileData> {
    const key: TileKey = { sourceId: this.id, level, index };
    if (signal.aborted) throw abortError();

    const body = this.shape.buildBody(level, index, segments);
    const raced = await this.callWithTimeout(
      { kind: this.shape.kind, level, tileIndex: index, body, priority: context?.priority },
      signal
    );

    if (signal.aborted) throw abortError();

    if (raced === TIMEOUT) {
      return errorTile(key, 'timeout');
    }

    if (!raced.ok) {
      return errorTile(key, errorReasonForStatus(raced));
    }

    return {
      key,
      state: 'ready',
      count: this.shape.countOf(raced.body),
      byteSize: this.shape.byteSizeOf(raced.body),
      payload: raced.body,
    };
  }

  private async callWithTimeout(
    req: {
      kind: TileRouteKind;
      level: number;
      tileIndex: number;
      body: Record<string, unknown>;
      priority?: TileTransportPriority;
    },
    signal: AbortSignal
  ): Promise<TileTransportResponse | typeof TIMEOUT> {
    const hasTimeout = this.timeoutMs > 0;
    const deadline = hasTimeout ? Date.now() + this.timeoutMs : Number.POSITIVE_INFINITY;
    let notReadyAttempt = 0;

    while (!signal.aborted) {
      const response = await this.callOnceWithDeadline(req, signal, deadline);
      if (response === TIMEOUT) return TIMEOUT;
      if (signal.aborted) throw abortError();
      if (response.status !== RETRYABLE_NOT_READY_STATUS) return response;

      const remaining = deadline - Date.now();
      if (hasTimeout && remaining <= 0) return TIMEOUT;
      const retryDelayMs = Math.min(
        NOT_READY_RETRY_MAX_DELAY_MS,
        NOT_READY_RETRY_INITIAL_DELAY_MS * 2 ** Math.min(notReadyAttempt, 4)
      );
      notReadyAttempt += 1;
      await abortableDelay(hasTimeout ? Math.min(retryDelayMs, remaining) : retryDelayMs, signal);
    }
    throw abortError();
  }

  private async callOnceWithDeadline(
    req: {
      kind: TileRouteKind;
      level: number;
      tileIndex: number;
      body: Record<string, unknown>;
      priority?: TileTransportPriority;
    },
    signal: AbortSignal,
    deadline: number
  ): Promise<TileTransportResponse | typeof TIMEOUT> {
    if (!Number.isFinite(deadline)) return this.transport(req, signal);
    const remaining = deadline - Date.now();
    if (remaining <= 0) return TIMEOUT;
    if (signal.aborted) throw abortError();
    const requestController = new AbortController();
    const onAbort = (): void => requestController.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(() => {
        resolve(TIMEOUT);
        requestController.abort();
      }, remaining);
    });
    try {
      const call = this.transport({ ...req, deadlineAtMs: deadline }, requestController.signal);
      return await Promise.race([call, timeout]);
    } catch (error) {
      if (error instanceof TileTransportDeadlineError) {
        requestController.abort();
        return TIMEOUT;
      }
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function errorTile(key: TileKey, errorReason: string): TileData {
  return { key, state: 'error', count: 0, byteSize: 0, errorReason };
}
