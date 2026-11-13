import {
  maxReadAlignmentLevel,
  TileTransportDeadlineError,
  type TileTransport,
} from '@waypoint/genome-renderer';

export interface TileTransportQueueSnapshot {
  readonly requiredReadPolicyEnabled: boolean;
  readonly currentReadLevel: number | null;
  readonly active: ReadonlyArray<{
    kind: Parameters<TileTransport>[0]['kind'];
    level: number;
    epoch: number | null;
    purpose: string | null;
    core: boolean;
    marginDistanceTiles: number | null;
    ageMs: number;
    deadlineRemainingMs: number | null;
  }>;
  readonly queued: TileTransportQueueSnapshot['active'];
  readonly started: number;
  readonly settled: number;
  readonly activeAborts: number;
}

type LimitedTileTransport = TileTransport & { debugSnapshot: () => TileTransportQueueSnapshot };

export function limitConcurrency(
  transport: TileTransport,
  limit: number,
  options: {
    canAbortActive?: (request: Parameters<TileTransport>[0]) => boolean;
    currentReadAlignmentLevel?: () => number | null | undefined;
  } = {}
): LimitedTileTransport {
  let active = 0;
  const activeRequests: Array<Parameters<TileTransport>[0]> = [];
  const activeSpeculativeEpochs: number[] = [];
  const requestStartedAt = new WeakMap<Parameters<TileTransport>[0], number>();
  const requestQueuedAt = new WeakMap<Parameters<TileTransport>[0], number>();
  let started = 0;
  let settled = 0;
  let activeAborts = 0;
  let nextOrder = 0;
  let pumpScheduled = false;
  const speculativeLimit = speculativeActiveLimit(limit);
  const newerEpochSpeculativeLimit = newerEpochSpeculativeActiveLimit(limit);
  const queue: Array<{
    req: Parameters<TileTransport>[0];
    signal: AbortSignal;
    resolve: (value: Awaited<ReturnType<TileTransport>>) => void;
    reject: (reason?: unknown) => void;
    onAbort: () => void;
    order: number;
  }> = [];
  const abortError = (): Error => {
    const e = new Error('aborted');
    e.name = 'AbortError';
    return e;
  };
  const pump = (): void => {
    while (active < limit && queue.length > 0) {
      const next = takeNextQueuedTile(
        queue,
        (item) =>
          canStartQueuedTile(
            item.req,
            activeSpeculativeEpochs,
            speculativeLimit,
            newerEpochSpeculativeLimit
          ) &&
          !alignmentWaitsForRequiredReads(
            item.req,
            options.currentReadAlignmentLevel?.(),
            activeRequests,
            queue
          )
      );
      if (!next) break;
      next.signal.removeEventListener('abort', next.onAbort);
      if (next.signal.aborted) {
        next.reject(abortError());
        continue;
      }
      if (next.req.deadlineAtMs !== undefined && Date.now() >= next.req.deadlineAtMs) {
        next.reject(new TileTransportDeadlineError());
        continue;
      }
      const speculative = tileRequestIsSpeculative(next.req);
      const speculativeEpoch = next.req.priority?.epoch ?? 0;
      active += 1;
      started += 1;
      requestStartedAt.set(next.req, Date.now());
      activeRequests.push(next.req);
      if (speculative) activeSpeculativeEpochs.push(speculativeEpoch);
      const rawController = new AbortController();
      const onActiveAbort = (): void => {
        activeAborts += 1;
        rawController.abort(next.signal.reason);
      };
      if (options.canAbortActive?.(next.req)) {
        next.signal.addEventListener('abort', onActiveAbort, { once: true });
        if (next.signal.aborted) onActiveAbort();
      }
      transport(next.req, rawController.signal)
        .then(
          (value) => {
            if (next.signal.aborted) next.reject(abortError());
            else next.resolve(value);
          },
          (reason) => {
            if (next.signal.aborted) next.reject(abortError());
            else next.reject(reason);
          }
        )
        .finally(() => {
          next.signal.removeEventListener('abort', onActiveAbort);
          active -= 1;
          settled += 1;
          activeRequests.splice(activeRequests.indexOf(next.req), 1);
          if (speculative) {
            const index = activeSpeculativeEpochs.indexOf(speculativeEpoch);
            if (index >= 0) activeSpeculativeEpochs.splice(index, 1);
          }
          pump();
        });
    }
  };
  const schedulePump = (): void => {
    if (pumpScheduled) return;
    pumpScheduled = true;
    queueMicrotask(() => {
      pumpScheduled = false;
      pump();
    });
  };
  const limited: TileTransport = (req, signal) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      const queued = {
        req,
        signal,
        resolve,
        reject,
        order: nextOrder++,
        onAbort: (): void => {
          const index = queue.indexOf(queued);
          if (index >= 0) queue.splice(index, 1);
          reject(abortError());
          schedulePump();
        },
      };
      signal.addEventListener('abort', queued.onAbort, { once: true });
      requestQueuedAt.set(req, Date.now());
      queue.push(queued);
      schedulePump();
    });
  return Object.assign(limited, {
    debugSnapshot: (): TileTransportQueueSnapshot => {
      const now = Date.now();
      const describe = (req: Parameters<TileTransport>[0], at: number | undefined) => ({
        kind: req.kind,
        level: req.level,
        epoch: req.priority?.epoch ?? null,
        purpose: req.priority?.purpose ?? null,
        core: req.priority?.core === true,
        marginDistanceTiles: req.priority?.marginDistanceTiles ?? null,
        ageMs: at == null ? 0 : Math.max(0, now - at),
        deadlineRemainingMs: req.deadlineAtMs == null ? null : req.deadlineAtMs - now,
      });
      return {
        requiredReadPolicyEnabled: options.currentReadAlignmentLevel != null,
        currentReadLevel: options.currentReadAlignmentLevel?.() ?? null,
        active: activeRequests.slice(0, 32).map((req) => describe(req, requestStartedAt.get(req))),
        queued: queue.slice(0, 32).map(({ req }) => describe(req, requestQueuedAt.get(req))),
        started,
        settled,
        activeAborts,
      };
    },
  });
}

type QueuedTileTransportRequest = {
  req: Parameters<TileTransport>[0];
  order: number;
};

function alignmentWaitsForRequiredReads(
  req: Parameters<TileTransport>[0],
  currentLevel: number | null | undefined,
  activeRequests: ReadonlyArray<Parameters<TileTransport>[0]>,
  queue: ReadonlyArray<QueuedTileTransportRequest>
): boolean {
  if (req.kind !== 'alignment' || currentLevel == null || currentLevel > maxReadAlignmentLevel()) {
    return false;
  }
  const required = (candidate: Parameters<TileTransport>[0]): boolean =>
    candidate.kind === 'alignment' &&
    candidate.level === currentLevel &&
    candidate.priority?.purpose === 'current' &&
    (candidate.priority.core || candidate.priority.marginDistanceTiles === 1);
  if (required(req)) return false;
  const bamPath = req.body.bamPath;
  const epoch = req.priority?.epoch;
  if (typeof bamPath !== 'string' || epoch == null) return false;
  const blocks = (candidate: Parameters<TileTransport>[0]): boolean =>
    required(candidate) &&
    candidate.body.bamPath === bamPath &&
    candidate.priority?.epoch === epoch;
  return activeRequests.some(blocks) || queue.some(({ req: candidate }) => blocks(candidate));
}

function takeNextQueuedTile<T extends QueuedTileTransportRequest>(
  queue: T[],
  canStart: (item: T) => boolean
): T | undefined {
  let bestIndex = -1;
  for (let i = 0; i < queue.length; i++) {
    if (!canStart(queue[i]!)) continue;
    if (bestIndex < 0 || compareQueuedTileRequest(queue[i]!, queue[bestIndex]!) < 0) {
      bestIndex = i;
    }
  }
  if (bestIndex < 0) return undefined;
  return queue.splice(bestIndex, 1)[0];
}

function canStartQueuedTile(
  req: Parameters<TileTransport>[0],
  activeSpeculativeEpochs: ReadonlyArray<number>,
  speculativeLimit: number,
  newerEpochSpeculativeLimit: number
): boolean {
  if (!tileRequestIsSpeculative(req)) return true;
  if (activeSpeculativeEpochs.length < speculativeLimit) return true;
  const reqEpoch = req.priority?.epoch ?? 0;
  const oldestActiveSpeculativeEpoch = Math.min(...activeSpeculativeEpochs);
  return (
    reqEpoch > oldestActiveSpeculativeEpoch &&
    activeSpeculativeEpochs.length < newerEpochSpeculativeLimit
  );
}

function tileRequestIsSpeculative(req: Parameters<TileTransport>[0]): boolean {
  const priority = req.priority;
  if (priority?.purpose === 'current' && priority.core === true) return false;
  if (
    req.kind === 'alignment' &&
    req.level <= maxReadAlignmentLevel() &&
    priority?.purpose === 'current' &&
    priority.marginDistanceTiles === 1
  ) {
    return false;
  }
  if (priority?.purpose === 'pan-lead' && priority.core === true) return false;
  return true;
}

function speculativeActiveLimit(limit: number): number {
  return Math.max(1, Math.floor(Math.max(1, limit) / 4));
}

function newerEpochSpeculativeActiveLimit(limit: number): number {
  return Math.max(speculativeActiveLimit(limit), Math.floor(Math.max(1, limit) * 0.75));
}

function compareQueuedTileRequest(
  a: QueuedTileTransportRequest,
  b: QueuedTileTransportRequest
): number {
  const aPriority = tileTransportPriority(a.req);
  const bPriority = tileTransportPriority(b.req);
  return (
    bPriority.epoch - aPriority.epoch ||
    aPriority.coreRank - bPriority.coreRank ||
    aPriority.purposeRank - bPriority.purposeRank ||
    aPriority.marginDistanceTiles - bPriority.marginDistanceTiles ||
    aPriority.routeRank - bPriority.routeRank ||
    a.order - b.order
  );
}

function tileTransportPriority(req: Parameters<TileTransport>[0]): {
  routeRank: number;
  purposeRank: number;
  epoch: number;
  coreRank: number;
  marginDistanceTiles: number;
} {
  const priority = req.priority;
  const common = {
    purposeRank: priority ? tilePurposePriority(priority.purpose) : 1_000,
    epoch: priority?.epoch ?? 0,
    coreRank: priority?.core === true ? 0 : 1,
    marginDistanceTiles: priority?.marginDistanceTiles ?? 0,
  };
  if (req.kind === 'alignment' && priority?.purpose === 'current' && priority.core === true) {
    return { routeRank: -10_000 + req.level, ...common };
  }
  if (req.kind === 'alignment' && priority?.purpose === 'pan-lead' && priority.core === true) {
    return { routeRank: -5_000 + req.level, ...common };
  }
  if (req.kind === 'coverage' || req.kind === 'coverage-assembly') {
    return { routeRank: 0, ...common };
  }
  if (req.kind === 'alignment') return { routeRank: 10_000 + req.level, ...common };
  if (req.kind === 'sequence') return { routeRank: 20_000 + req.level, ...common };
  return { routeRank: 30_000 + req.level, ...common };
}

function tilePurposePriority(
  purpose: NonNullable<Parameters<TileTransport>[0]['priority']>['purpose']
): number {
  if (purpose === 'current') return 0;
  if (purpose === 'pan-lead') return 1;
  if (purpose === 'adjacent-finer') return 2;
  if (purpose === 'critical-handoff') return 3;
  if (purpose === 'coarser') return 4;
  return 5;
}
