const alphaMissenseCache = new Map<string, Map<number, number>>();
const ALPHA_MISSENSE_CACHE_MAX_ENTRIES = 16;
const ALPHA_MISSENSE_CACHE_MAX_RESIDUES = 50_000;
const ALPHA_MISSENSE_PENDING_MAX_ENTRIES = 16;
const ALPHA_MISSENSE_CAPACITY_MAX_WAITERS = 64;
const ALPHA_MISSENSE_FETCH_TIMEOUT_MS = 15_000;
const ALPHA_MISSENSE_RESPONSE_MAX_BYTES = 48 * 1024 * 1024;
let alphaMissenseCachedResidues = 0;

interface AlphaMissensePendingEntry {
  readonly controller: AbortController;
  readonly promise: Promise<Map<number, number> | null>;
  readonly waiters: Set<symbol>;
}

interface FetchAlphaMissenseDataOptions {
  signal?: AbortSignal;
}

type AlphaMissenseCapacityWaiter = (capacityAvailable: boolean) => void;

const alphaMissensePending = new Map<string, AlphaMissensePendingEntry>();
const alphaMissenseCapacityWaiters = new Set<AlphaMissenseCapacityWaiter>();

function readCachedAlphaMissense(id: string): Map<number, number> | undefined {
  const cached = alphaMissenseCache.get(id);
  if (!cached) return undefined;
  alphaMissenseCache.delete(id);
  alphaMissenseCache.set(id, cached);
  return cached;
}

function cacheAlphaMissense(id: string, scores: Map<number, number>): void {
  const replaced = alphaMissenseCache.get(id);
  if (replaced) alphaMissenseCachedResidues -= replaced.size;
  if (scores.size > ALPHA_MISSENSE_CACHE_MAX_RESIDUES) {
    alphaMissenseCache.delete(id);
    return;
  }
  alphaMissenseCache.set(id, scores);
  alphaMissenseCachedResidues += scores.size;
  while (
    alphaMissenseCache.size > ALPHA_MISSENSE_CACHE_MAX_ENTRIES ||
    alphaMissenseCachedResidues > ALPHA_MISSENSE_CACHE_MAX_RESIDUES
  ) {
    const oldestId = alphaMissenseCache.keys().next().value;
    if (oldestId === undefined) break;
    alphaMissenseCachedResidues -= alphaMissenseCache.get(oldestId)?.size ?? 0;
    alphaMissenseCache.delete(oldestId);
  }
}

interface PositionScoreAccumulator {
  sum: number;
  count: number;
}

function consumeAlphaMissenseCsvLine(
  line: string,
  positionScores: Map<number, PositionScoreAccumulator>
): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  const parts = trimmed.split(',');
  if (parts.length < 2) return;
  const match = parts[0]?.match(/[A-Z](\d+)[A-Z]/);
  const score = Number.parseFloat(parts[1] ?? '');
  if (!match || !Number.isFinite(score)) return;
  const position = Number.parseInt(match[1] ?? '', 10);
  const existing = positionScores.get(position);
  if (existing) {
    existing.sum += score;
    existing.count += 1;
    return;
  }
  if (positionScores.size >= ALPHA_MISSENSE_CACHE_MAX_RESIDUES) {
    throw new Error('AlphaMissense response contains too many residue positions.');
  }
  positionScores.set(position, { sum: score, count: 1 });
}

async function parseAlphaMissenseResponse(
  response: Response,
  signal: AbortSignal
): Promise<Map<number, number>> {
  const declaredBytes = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredBytes) && declaredBytes > ALPHA_MISSENSE_RESPONSE_MAX_BYTES) {
    const error = new Error('AlphaMissense response exceeds the byte limit.');
    await response.body?.cancel(error).catch(() => undefined);
    throw error;
  }

  const positionScores = new Map<number, PositionScoreAccumulator>();
  let headerPending = true;
  let buffered = '';
  let receivedBytes = 0;
  const consumeBufferedLines = (flush: boolean): void => {
    let newline = buffered.indexOf('\n');
    while (newline >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (headerPending) headerPending = false;
      else consumeAlphaMissenseCsvLine(line, positionScores);
      newline = buffered.indexOf('\n');
    }
    if (!flush || buffered.length === 0) return;
    if (headerPending) headerPending = false;
    else consumeAlphaMissenseCsvLine(buffered, positionScores);
    buffered = '';
  };

  if (!response.body) {
    throw new Error('AlphaMissense response did not provide a bounded byte stream.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > ALPHA_MISSENSE_RESPONSE_MAX_BYTES) {
        throw new Error('AlphaMissense response exceeds the byte limit.');
      }
      buffered += decoder.decode(value, { stream: true });
      consumeBufferedLines(false);
    }
    buffered += decoder.decode();
    consumeBufferedLines(true);
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  return new Map(
    [...positionScores].map(([position, accumulator]) => [
      position,
      accumulator.sum / accumulator.count,
    ])
  );
}

export async function fetchAlphaMissenseData(
  uniprotId: string,
  options: FetchAlphaMissenseDataOptions = {}
): Promise<Map<number, number> | null> {
  const id = uniprotId.toUpperCase();

  const cached = readCachedAlphaMissense(id);
  if (cached) return cached;
  if (options.signal?.aborted) return null;

  const pending = alphaMissensePending.get(id);
  if (pending) {
    return waitForAlphaMissenseData(id, pending, options.signal);
  }

  while (alphaMissensePending.size >= ALPHA_MISSENSE_PENDING_MAX_ENTRIES) {
    const capacity = await waitForAlphaMissenseCapacity(options.signal);
    if (capacity === 'aborted') return null;
    if (capacity === 'overloaded') {
      throw new Error('AlphaMissense request capacity queue is full.');
    }
  }

  const admittedCached = readCachedAlphaMissense(id);
  if (admittedCached) return admittedCached;
  const admittedPending = alphaMissensePending.get(id);
  if (admittedPending) return waitForAlphaMissenseData(id, admittedPending, options.signal);
  if (options.signal?.aborted) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ALPHA_MISSENSE_FETCH_TIMEOUT_MS);
  const fetchPromise = (async (): Promise<Map<number, number> | null> => {
    try {
      const url = `https://alphafold.ebi.ac.uk/files/AF-${id}-F1-aa-substitutions.csv`;
      const response = await fetch(url, { signal: controller.signal });

      if (!response.ok) {
        console.warn(`AlphaMissense data not available for ${id}`);
        return null;
      }

      const avgScores = await parseAlphaMissenseResponse(response, controller.signal);

      cacheAlphaMissense(id, avgScores);
      return avgScores;
    } catch (error) {
      if (!controller.signal.aborted) {
        console.error(`Failed to fetch AlphaMissense data for ${id}:`, error);
      }
      return null;
    }
  })();

  const entry = { controller, promise: fetchPromise, waiters: new Set<symbol>() };
  alphaMissensePending.set(id, entry);
  void fetchPromise.finally(() => {
    clearTimeout(timeout);
    if (alphaMissensePending.get(id) === entry) {
      alphaMissensePending.delete(id);
      wakeAlphaMissenseCapacityWaiter();
    }
  });
  return waitForAlphaMissenseData(id, entry, options.signal);
}

function waitForAlphaMissenseCapacity(
  signal: AbortSignal | undefined
): Promise<'available' | 'aborted' | 'overloaded'> {
  if (alphaMissensePending.size < ALPHA_MISSENSE_PENDING_MAX_ENTRIES) {
    return Promise.resolve('available');
  }
  if (signal?.aborted) return Promise.resolve('aborted');
  if (alphaMissenseCapacityWaiters.size >= ALPHA_MISSENSE_CAPACITY_MAX_WAITERS) {
    return Promise.resolve('overloaded');
  }
  return new Promise((resolve) => {
    let settled = false;
    const wake: AlphaMissenseCapacityWaiter = (capacityAvailable) => {
      if (settled) return;
      settled = true;
      alphaMissenseCapacityWaiters.delete(wake);
      signal?.removeEventListener('abort', onAbort);
      resolve(capacityAvailable ? 'available' : 'aborted');
    };
    const onAbort = () => wake(false);
    alphaMissenseCapacityWaiters.add(wake);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function wakeAlphaMissenseCapacityWaiter(): void {
  alphaMissenseCapacityWaiters.values().next().value?.(true);
}

async function waitForAlphaMissenseData(
  id: string,
  entry: AlphaMissensePendingEntry,
  signal: AbortSignal | undefined
): Promise<Map<number, number> | null> {
  if (signal?.aborted) return null;
  const waiter = Symbol('alphamissense-waiter');
  entry.waiters.add(waiter);
  let onAbort: (() => void) | null = null;
  try {
    if (!signal) return await entry.promise;
    const aborted = new Promise<null>((resolve) => {
      onAbort = () => resolve(null);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    return await Promise.race([entry.promise, aborted]);
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    entry.waiters.delete(waiter);
    if (
      entry.waiters.size === 0 &&
      alphaMissensePending.get(id) === entry &&
      !entry.controller.signal.aborted
    ) {
      entry.controller.abort();
    }
  }
}
