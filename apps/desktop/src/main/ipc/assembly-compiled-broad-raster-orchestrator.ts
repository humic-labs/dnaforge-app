import { realpath } from 'node:fs/promises';

import type { PartitionedTranscriptSceneBinaryManifestV4 } from '@waypoint/genome-renderer/pure';

import type {
  AssemblyAnnotationSceneReadRequest,
  AssemblyCompiledBroadRasterArtifactRequestV1,
} from '../../shared/indexed-genome';
import { buildAssemblyCompiledBroadRasterSurfaceManifestV1 } from '../../shared/indexed-genome';
import type {
  AssemblyCompiledBroadRasterWorkerJobV1,
  AssemblyCompiledBroadRasterWorkerResultV1,
} from './assembly-compiled-broad-raster-worker-job';

const DEFAULT_WORKER_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_RETRY_BASE_DELAY_MS = 2_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;
const MAX_KNOWN_SCENE_JOBS = 16;
const MAX_WORKER_ATTEMPTS_PER_SCENE = 4;

export interface AssemblyCompiledBroadRasterSceneHitV1 {
  readonly request: AssemblyAnnotationSceneReadRequest;
  readonly sourceFingerprint: string;
  readonly scenePath: string;
  readonly sceneManifest: PartitionedTranscriptSceneBinaryManifestV4;
  readonly payloadSha256: string;
}

export interface AssemblyCompiledBroadRasterOrchestratorDepsV1 {
  readonly assertSafePath: (path: string) => Promise<void>;
  readonly realpathImpl?: typeof realpath;
  readonly buildSurfaceManifest?: typeof buildAssemblyCompiledBroadRasterSurfaceManifestV1;
  readonly prepareInWorker?: (
    job: AssemblyCompiledBroadRasterWorkerJobV1,
    options?: { signal?: AbortSignal }
  ) => Promise<AssemblyCompiledBroadRasterWorkerResultV1>;
  readonly now?: () => number;
  readonly workerTimeoutMs?: number;
  readonly retryBaseDelayMs?: number;
  readonly retryMaxDelayMs?: number;
  readonly reportFailure?: (error: Error, hit: AssemblyCompiledBroadRasterSceneHitV1) => void;
}

export interface AssemblyCompiledBroadRasterPreparationSnapshotV1 {
  readonly status: 'unknown' | 'initializing' | 'running' | 'succeeded' | 'failed';
  readonly attemptCount: number;
  readonly expectedSurfaceManifestFingerprint: string | null;
  readonly nextRetryAtMs: number | null;
}

export type AssemblyCompiledBroadRasterRepairRequestOutcomeV1 =
  | Readonly<{ status: 'repairing'; retryAfterMs: number }>
  | Readonly<{ status: 'unavailable'; reason: 'repair-not-known' | 'repair-exhausted' }>;

interface KnownPreparation {
  readonly key: string;
  readonly hit: AssemblyCompiledBroadRasterSceneHitV1;
  readonly identity: string;
  status: Exclude<AssemblyCompiledBroadRasterPreparationSnapshotV1['status'], 'unknown'>;
  attemptCount: number;
  expectedSurfaceManifestFingerprint: string | null;
  nextRetryAtMs: number;
  repairRequested: boolean;
  lastResult: AssemblyCompiledBroadRasterWorkerResultV1 | null;
  lastError: Error | null;
  readonly waiters: Set<{
    resolve: (result: AssemblyCompiledBroadRasterWorkerResultV1) => void;
    reject: (error: Error) => void;
  }>;
}

async function prepareWithDefaultWorker(
  job: AssemblyCompiledBroadRasterWorkerJobV1,
  options?: { signal?: AbortSignal }
): Promise<AssemblyCompiledBroadRasterWorkerResultV1> {
  const { prepareAssemblyCompiledBroadRasterInDedicatedWorkerV1 } =
    await import('./assembly-compiled-broad-raster-worker-factory');
  return prepareAssemblyCompiledBroadRasterInDedicatedWorkerV1(job, options);
}

export class AssemblyCompiledBroadRasterPreparationOrchestratorV1 {
  private readonly known = new Map<string, KnownPreparation>();
  private readonly deps: AssemblyCompiledBroadRasterOrchestratorDepsV1;
  private readonly pending: KnownPreparation[] = [];
  private active: KnownPreparation | null = null;

  constructor(deps: AssemblyCompiledBroadRasterOrchestratorDepsV1) {
    this.deps = deps;
  }

  scheduleSceneHit(hit: AssemblyCompiledBroadRasterSceneHitV1): void {
    this.registerSceneHit(hit);
  }

  ensureSceneHit(
    hit: AssemblyCompiledBroadRasterSceneHitV1
  ): Promise<AssemblyCompiledBroadRasterWorkerResultV1> {
    const entry = this.registerSceneHit(hit);
    if (!entry) {
      return Promise.reject(new Error('Compiled broad raster preparation queue is at capacity.'));
    }
    if (entry.status === 'succeeded' && entry.lastResult) {
      return Promise.resolve(entry.lastResult);
    }
    if (entry.status === 'failed' && entry.lastError && this.now() < entry.nextRetryAtMs) {
      return Promise.reject(entry.lastError);
    }
    return new Promise((resolve, reject) => {
      entry.waiters.add({ resolve, reject });
    });
  }

  private registerSceneHit(hit: AssemblyCompiledBroadRasterSceneHitV1): KnownPreparation | null {
    const key = requestKey(hit.request);
    const identity = sceneHitIdentity(hit);
    const incumbent = this.known.get(key);
    if (incumbent?.identity === identity) {
      if (incumbent.status === 'failed' && this.now() >= incumbent.nextRetryAtMs) {
        this.start(incumbent);
      }
      return incumbent;
    }
    if (!incumbent) {
      this.prune(true);
      if (this.known.size >= MAX_KNOWN_SCENE_JOBS) {
        const error = new Error('Compiled broad raster preparation queue is at capacity.');
        this.deps.reportFailure?.(error, hit);
        return null;
      }
    } else {
      this.rejectWaiters(
        incumbent,
        new Error('Compiled broad raster preparation was superseded by a new scene revision.')
      );
    }
    const entry: KnownPreparation = {
      key,
      hit,
      identity,
      status: 'initializing',
      attemptCount: 0,
      expectedSurfaceManifestFingerprint: null,
      nextRetryAtMs: 0,
      repairRequested: false,
      lastResult: null,
      lastError: null,
      waiters: new Set(),
    };
    this.known.set(key, entry);
    this.prune();
    this.start(entry);
    return entry;
  }

  retryKnownMissingManifest(input: AssemblyCompiledBroadRasterArtifactRequestV1): void {
    const entry = this.known.get(requestKey(input.scene));
    if (
      !entry ||
      entry.status === 'initializing' ||
      entry.status === 'running' ||
      (entry.expectedSurfaceManifestFingerprint !== null &&
        entry.expectedSurfaceManifestFingerprint !== input.surfaceManifestFingerprint) ||
      this.now() < entry.nextRetryAtMs
    ) {
      return;
    }
    this.start(entry);
  }

  repairKnownCorruptArtifact(
    input: AssemblyCompiledBroadRasterArtifactRequestV1
  ): AssemblyCompiledBroadRasterRepairRequestOutcomeV1 {
    const entry = this.known.get(requestKey(input.scene));
    if (
      !entry ||
      (entry.expectedSurfaceManifestFingerprint !== null &&
        entry.expectedSurfaceManifestFingerprint !== input.surfaceManifestFingerprint)
    ) {
      return { status: 'unavailable', reason: 'repair-not-known' };
    }
    if (
      entry.attemptCount >= MAX_WORKER_ATTEMPTS_PER_SCENE &&
      entry.status !== 'initializing' &&
      entry.status !== 'running'
    ) {
      return { status: 'unavailable', reason: 'repair-exhausted' };
    }
    entry.repairRequested = true;
    if (entry.status === 'initializing' || entry.status === 'running') {
      return { status: 'repairing', retryAfterMs: 250 };
    }
    if (entry.status === 'succeeded') entry.nextRetryAtMs = 0;
    if (this.now() >= entry.nextRetryAtMs) this.start(entry);
    return {
      status: 'repairing',
      retryAfterMs: Math.max(100, entry.nextRetryAtMs - this.now()),
    };
  }

  snapshot(
    request: AssemblyAnnotationSceneReadRequest
  ): AssemblyCompiledBroadRasterPreparationSnapshotV1 {
    const entry = this.known.get(requestKey(request));
    if (!entry) {
      return {
        status: 'unknown',
        attemptCount: 0,
        expectedSurfaceManifestFingerprint: null,
        nextRetryAtMs: null,
      };
    }
    return {
      status: entry.status,
      attemptCount: entry.attemptCount,
      expectedSurfaceManifestFingerprint: entry.expectedSurfaceManifestFingerprint,
      nextRetryAtMs: entry.nextRetryAtMs || null,
    };
  }

  private start(entry: KnownPreparation): void {
    if (
      this.known.get(entry.key) !== entry ||
      entry.attemptCount >= MAX_WORKER_ATTEMPTS_PER_SCENE ||
      this.active === entry ||
      this.pending.includes(entry)
    ) {
      return;
    }
    entry.status = 'initializing';
    this.pending.push(entry);
    this.drain();
  }

  private drain(): void {
    if (this.active) return;
    let entry: KnownPreparation | undefined;
    while ((entry = this.pending.shift())) {
      if (
        this.known.get(entry.key) === entry &&
        entry.attemptCount < MAX_WORKER_ATTEMPTS_PER_SCENE
      ) {
        break;
      }
      entry = undefined;
    }
    if (!entry) return;
    this.active = entry;
    entry.attemptCount += 1;
    entry.status = 'initializing';
    void this.initializeAndRun(entry)
      .then((result) => {
        if (this.known.get(entry.key) !== entry) return;
        entry.lastResult = result;
        entry.lastError = null;
        this.resolveWaiters(entry, result);
      })
      .catch((error: unknown) => {
        if (this.known.get(entry.key) !== entry) return;
        const normalized = error instanceof Error ? error : new Error(String(error));
        entry.status = 'failed';
        entry.lastError = normalized;
        entry.nextRetryAtMs = this.now() + this.retryDelay(entry.attemptCount);
        this.deps.reportFailure?.(normalized, entry.hit);
        this.rejectWaiters(entry, normalized);
      })
      .finally(() => {
        if (this.active === entry) this.active = null;
        if (
          this.known.get(entry.key) === entry &&
          entry.status === 'succeeded' &&
          entry.repairRequested
        ) {
          entry.nextRetryAtMs = 0;
          this.start(entry);
        }
        this.drain();
      });
  }

  private async initializeAndRun(
    entry: KnownPreparation
  ): Promise<AssemblyCompiledBroadRasterWorkerResultV1> {
    const buildSurfaceManifest =
      this.deps.buildSurfaceManifest ?? buildAssemblyCompiledBroadRasterSurfaceManifestV1;
    const surfaceManifest = await buildSurfaceManifest({
      sceneManifest: entry.hit.sceneManifest,
      artifact: entry.hit.request.artifact,
    });
    if (this.known.get(entry.key) !== entry) {
      throw new Error('Compiled broad raster preparation was superseded before initialization.');
    }
    entry.expectedSurfaceManifestFingerprint = surfaceManifest.manifestFingerprint;

    await this.deps.assertSafePath(entry.hit.scenePath);
    const authorizedSceneRealPath = await (this.deps.realpathImpl ?? realpath)(entry.hit.scenePath);
    if (this.known.get(entry.key) !== entry) {
      throw new Error('Compiled broad raster preparation was superseded before worker launch.');
    }

    entry.status = 'running';
    const forceRebuildExistingArtifact = entry.repairRequested;
    const controller = new AbortController();
    const prepareInWorker = this.deps.prepareInWorker ?? prepareWithDefaultWorker;
    const timeoutMs = this.deps.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        const error = new Error(`Compiled broad raster preparation exceeded ${timeoutMs} ms.`);
        error.name = 'TimeoutError';
        controller.abort();
        reject(error);
      }, timeoutMs);
      if (typeof timeout === 'object' && timeout && 'unref' in timeout) timeout.unref();
    });
    try {
      const result = await Promise.race([
        prepareInWorker(
          {
            request: entry.hit.request,
            sourceFingerprint: entry.hit.sourceFingerprint,
            scenePath: entry.hit.scenePath,
            authorizedSceneRealPath,
            sceneManifest: entry.hit.sceneManifest,
            expectedPayloadSha256: entry.hit.payloadSha256,
            expectedSurfaceManifestFingerprint: surfaceManifest.manifestFingerprint,
            forceRebuildExistingArtifact,
          },
          { signal: controller.signal }
        ),
        timedOut,
      ]);
      if (this.known.get(entry.key) !== entry) {
        throw new Error('Compiled broad raster preparation was superseded before publication.');
      }
      if (forceRebuildExistingArtifact) entry.repairRequested = false;
      entry.status = 'succeeded';
      entry.nextRetryAtMs = this.now() + this.retryDelay(entry.attemptCount);
      return result;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private resolveWaiters(
    entry: KnownPreparation,
    result: AssemblyCompiledBroadRasterWorkerResultV1
  ): void {
    const waiters = [...entry.waiters];
    entry.waiters.clear();
    for (const waiter of waiters) waiter.resolve(result);
  }

  private rejectWaiters(entry: KnownPreparation, error: Error): void {
    const waiters = [...entry.waiters];
    entry.waiters.clear();
    for (const waiter of waiters) waiter.reject(error);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private retryDelay(attemptCount: number): number {
    const base = this.deps.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    const max = this.deps.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
    return Math.min(max, base * 2 ** Math.max(0, attemptCount - 1));
  }

  private prune(reserveSlot = false): void {
    const targetSize = reserveSlot ? MAX_KNOWN_SCENE_JOBS - 1 : MAX_KNOWN_SCENE_JOBS;
    if (this.known.size <= targetSize) return;
    for (const [key, entry] of this.known) {
      if (this.known.size <= targetSize) break;
      if (entry.status === 'running' || entry.status === 'initializing') continue;
      this.known.delete(key);
    }
  }
}

function requestKey(request: AssemblyAnnotationSceneReadRequest): string {
  return JSON.stringify({
    workspaceRoot: request.workspaceRoot,
    assemblyId: request.assemblyId,
    chromosomes: request.chromosomes,
    scope: request.scope,
    datasetContract: request.datasetContract,
    artifact: request.artifact,
  });
}

function sceneHitIdentity(hit: AssemblyCompiledBroadRasterSceneHitV1): string {
  return [
    hit.sourceFingerprint,
    hit.payloadSha256,
    hit.sceneManifest.integrity.contractSha256,
    hit.scenePath,
  ].join('\u0000');
}
