const MAX_IN_FLIGHT_AUTO_LOADS = 32;
const MAX_COMPLETED_AUTO_LOADS = 64;

type AutoLoadStatus = 'started' | 'joined' | 'completed' | 'capacity';

interface AutoLoadRegistry<T> {
  readonly inFlight: Map<string, Promise<T>>;
  readonly stats: AutoLoadStats;
  readonly capacityWaiters: Map<string, Set<() => void>>;
}

interface AutoLoadStats {
  started: number;
  settled: number;
  joined: number;
  refused: number;
  peakInFlight: number;
}

function createAutoLoadStats(): AutoLoadStats {
  return { started: 0, settled: 0, joined: 0, refused: 0, peakInFlight: 0 };
}

const enrichmentRegistry: AutoLoadRegistry<void> = {
  inFlight: new Map(),
  stats: createAutoLoadStats(),
  capacityWaiters: new Map(),
};
const sidecarRegistry: AutoLoadRegistry<boolean> = {
  inFlight: new Map(),
  stats: createAutoLoadStats(),
  capacityWaiters: new Map(),
};
const completedSidecarLoads = new Map<string, true>();

export interface AlignmentAutoLoadLifecycleSnapshot {
  readonly enrichmentInFlight: number;
  readonly enrichmentStarted: number;
  readonly enrichmentSettled: number;
  readonly enrichmentJoined: number;
  readonly enrichmentRefused: number;
  readonly enrichmentPeakInFlight: number;
  readonly sidecarInFlight: number;
  readonly sidecarStarted: number;
  readonly sidecarSettled: number;
  readonly sidecarJoined: number;
  readonly sidecarRefused: number;
  readonly sidecarPeakInFlight: number;
  readonly sidecarCompleted: number;
  readonly capacitySubscribers: number;
  readonly capacityWaitingKeys: number;
  readonly maxInFlight: number;
  readonly maxCompleted: number;
}

function rememberCompleted(cache: Map<string, true>, key: string): void {
  cache.delete(key);
  cache.set(key, true);
  while (cache.size > MAX_COMPLETED_AUTO_LOADS) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) return;
    cache.delete(oldestKey);
  }
}

function notifyNextCapacityWaiter(registry: AutoLoadRegistry<unknown>): void {
  const next = registry.capacityWaiters.entries().next().value;
  if (!next) return;
  const [key, subscribers] = next;
  registry.capacityWaiters.delete(key);
  for (const subscriber of subscribers) subscriber();
}

function startAutoLoad<T>(input: {
  readonly registry: AutoLoadRegistry<T>;
  readonly completed?: Map<string, true>;
  readonly key: string;
  readonly run: () => Promise<T>;
  readonly rememberResult?: (result: T) => boolean;
  readonly onResolved?: (result: T) => void;
  readonly onRejected: (error: unknown) => void;
}): AutoLoadStatus {
  if (input.completed?.has(input.key)) return 'completed';
  if (input.registry.inFlight.has(input.key)) {
    input.registry.stats.joined += 1;
    return 'joined';
  }
  if (input.registry.inFlight.size >= MAX_IN_FLIGHT_AUTO_LOADS) {
    input.registry.stats.refused += 1;
    return 'capacity';
  }

  const completion = Promise.resolve().then(input.run);
  input.registry.inFlight.set(input.key, completion);
  input.registry.stats.started += 1;
  input.registry.stats.peakInFlight = Math.max(
    input.registry.stats.peakInFlight,
    input.registry.inFlight.size
  );
  void completion
    .then((result) => {
      if (input.completed && input.rememberResult?.(result)) {
        rememberCompleted(input.completed, input.key);
      }
      input.onResolved?.(result);
    })
    .catch(input.onRejected)
    .finally(() => {
      if (input.registry.inFlight.get(input.key) === completion) {
        input.registry.inFlight.delete(input.key);
        input.registry.stats.settled += 1;
        notifyNextCapacityWaiter(input.registry);
      }
    });
  return 'started';
}

export function startAlignmentEnrichmentAutoLoad(input: {
  readonly key: string;
  readonly run: () => Promise<void>;
  readonly onRejected: (error: unknown) => void;
}): AutoLoadStatus {
  return startAutoLoad({
    registry: enrichmentRegistry,
    key: input.key,
    run: input.run,
    onRejected: input.onRejected,
  });
}

export function startAlignmentSidecarAutoLoad(input: {
  readonly key: string;
  readonly run: () => Promise<boolean>;
  readonly onLoaded: () => void;
  readonly onRejected: (error: unknown) => void;
}): AutoLoadStatus {
  return startAutoLoad({
    registry: sidecarRegistry,
    completed: completedSidecarLoads,
    key: input.key,
    run: input.run,
    rememberResult: (loaded) => loaded,
    onResolved: (loaded) => {
      if (loaded) input.onLoaded();
    },
    onRejected: input.onRejected,
  });
}

export function markAlignmentSidecarAutoLoadCompleted(documentId: string): void {
  rememberCompleted(completedSidecarLoads, documentId);
}

export function getAlignmentAutoLoadLifecycleSnapshot(): AlignmentAutoLoadLifecycleSnapshot {
  const capacityWaitingKeys =
    enrichmentRegistry.capacityWaiters.size + sidecarRegistry.capacityWaiters.size;
  const capacitySubscribers = [
    ...enrichmentRegistry.capacityWaiters.values(),
    ...sidecarRegistry.capacityWaiters.values(),
  ].reduce((total, subscribers) => total + subscribers.size, 0);
  return {
    enrichmentInFlight: enrichmentRegistry.inFlight.size,
    enrichmentStarted: enrichmentRegistry.stats.started,
    enrichmentSettled: enrichmentRegistry.stats.settled,
    enrichmentJoined: enrichmentRegistry.stats.joined,
    enrichmentRefused: enrichmentRegistry.stats.refused,
    enrichmentPeakInFlight: enrichmentRegistry.stats.peakInFlight,
    sidecarInFlight: sidecarRegistry.inFlight.size,
    sidecarStarted: sidecarRegistry.stats.started,
    sidecarSettled: sidecarRegistry.stats.settled,
    sidecarJoined: sidecarRegistry.stats.joined,
    sidecarRefused: sidecarRegistry.stats.refused,
    sidecarPeakInFlight: sidecarRegistry.stats.peakInFlight,
    sidecarCompleted: completedSidecarLoads.size,
    capacitySubscribers,
    capacityWaitingKeys,
    maxInFlight: MAX_IN_FLIGHT_AUTO_LOADS,
    maxCompleted: MAX_COMPLETED_AUTO_LOADS,
  };
}

export function subscribeAlignmentAutoLoadCapacity(
  kind: 'enrichment' | 'sidecar',
  key: string,
  subscriber: () => void
): () => void {
  const registry = kind === 'enrichment' ? enrichmentRegistry : sidecarRegistry;
  const subscribers = registry.capacityWaiters.get(key) ?? new Set<() => void>();
  subscribers.add(subscriber);
  registry.capacityWaiters.set(key, subscribers);
  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size === 0) registry.capacityWaiters.delete(key);
  };
}

export function resetAlignmentAutoLoadRegistryForTests(): void {
  enrichmentRegistry.inFlight.clear();
  Object.assign(enrichmentRegistry.stats, createAutoLoadStats());
  enrichmentRegistry.capacityWaiters.clear();
  sidecarRegistry.inFlight.clear();
  Object.assign(sidecarRegistry.stats, createAutoLoadStats());
  sidecarRegistry.capacityWaiters.clear();
  completedSidecarLoads.clear();
}
