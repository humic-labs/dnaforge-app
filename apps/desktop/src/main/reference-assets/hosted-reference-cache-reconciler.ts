import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type {
  HostedReferenceCatalogEntryV1,
  PreparedReferenceAssemblyEntryV1,
  ReferenceAssetHostedInstallProgressV1,
  ReferenceAssetPreparationProgressUpdateV1,
  ReferenceAssetThemeModeV1,
} from '../../shared/reference-assets-ipc';
import type { HostedReferenceCatalogDefinitionV1 } from './hosted-reference-catalog';
import { REFERENCE_PREPARATION_PIPELINE_REVISION } from './reference-preparation-manifest';

export const HOSTED_REFERENCE_CACHE_HEALTH_CONTRACT_V1 =
  'dnaforge.hosted-reference-cache-health.v1' as const;
const HOSTED_REFERENCE_CACHE_VERSION_CONTRACT_V1 =
  'dnaforge.hosted-reference-cache-version.v1' as const;
const HEALTH_DIRECTORY = '.hosted-reference-cache-health';
const SAFE_CATALOG_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DEFAULT_AUDIT_INTERVAL_MS = 30 * 60 * 1_000;
const DEFAULT_RETRY_BASE_DELAY_MS = 60_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 60 * 60 * 1_000;

export interface HostedReferenceCacheVersionV1 {
  readonly datasetVersion: string;
  readonly cacheVersion: string;
}

export interface HostedReferenceCacheHealthV1 extends HostedReferenceCacheVersionV1 {
  readonly contract: typeof HOSTED_REFERENCE_CACHE_HEALTH_CONTRACT_V1;
  readonly catalogId: string;
  readonly status: 'repairing' | 'ready' | 'retry-scheduled';
  readonly checkedAtMs: number;
  readonly repairAttempt: number;
  readonly nextRetryAtMs?: number;
  readonly error?: string;
}

export interface HostedReferenceCacheReconcileResult {
  readonly checked: number;
  readonly repaired: number;
  readonly ready: number;
  readonly failed: number;
  readonly skippedAbsent: number;
  readonly deferredByBackoff: number;
  readonly nextRetryAtMs?: number;
}

export interface HostedReferenceCacheReconcilerDeps {
  readonly cacheRoot: string;
  readonly versionsByCatalogId: ReadonlyMap<string, HostedReferenceCacheVersionV1>;
  readonly listHosted: () => Promise<ReadonlyArray<HostedReferenceCatalogEntryV1>>;
  readonly installHosted: (input: {
    readonly catalogId: string;
    readonly themeMode: ReferenceAssetThemeModeV1;
    readonly onProgress: (progress: ReferenceAssetPreparationProgressUpdateV1) => void;
  }) => Promise<PreparedReferenceAssemblyEntryV1>;
  readonly collectSupersededVersions?: () => Promise<unknown>;
  readonly hasLocalFootprint?: (catalogId: string) => Promise<boolean>;
  readonly onProgress?: (progress: ReferenceAssetHostedInstallProgressV1) => void;
  readonly createOperationId?: (catalogId: string) => string;
  readonly nowMs?: () => number;
  readonly auditIntervalMs?: number;
  readonly retryBaseDelayMs?: number;
  readonly retryMaxDelayMs?: number;
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export function hostedReferenceCacheVersionsV1(
  catalog: ReadonlyArray<HostedReferenceCatalogDefinitionV1>,
  sourceBuildFingerprint: string
): ReadonlyMap<string, HostedReferenceCacheVersionV1> {
  return new Map(
    catalog.map((definition) => [
      definition.id,
      {
        datasetVersion: definition.provenance.datasetVersion,
        cacheVersion: createHash('sha256')
          .update(
            JSON.stringify({
              contract: HOSTED_REFERENCE_CACHE_VERSION_CONTRACT_V1,
              definition,
              preparationPipelineRevision: REFERENCE_PREPARATION_PIPELINE_REVISION,
              sourceBuildFingerprint,
            })
          )
          .digest('hex'),
      },
    ])
  );
}

export function hostedReferenceCacheHealthPathV1(cacheRoot: string, catalogId: string): string {
  if (!SAFE_CATALOG_ID.test(catalogId)) throw new Error('Hosted reference catalog ID is invalid.');
  return join(resolve(cacheRoot), HEALTH_DIRECTORY, `${catalogId}.v1.json`);
}

export function parseHostedReferenceCacheHealthV1(value: unknown): HostedReferenceCacheHealthV1 {
  if (!value || typeof value !== 'object')
    throw new Error('Cache health receipt must be an object.');
  const receipt = value as Readonly<Record<string, unknown>>;
  if (receipt.contract !== HOSTED_REFERENCE_CACHE_HEALTH_CONTRACT_V1) {
    throw new Error('Cache health receipt contract is unsupported.');
  }
  if (typeof receipt.catalogId !== 'string' || !SAFE_CATALOG_ID.test(receipt.catalogId)) {
    throw new Error('Cache health receipt catalog ID is invalid.');
  }
  if (typeof receipt.datasetVersion !== 'string' || receipt.datasetVersion.length === 0) {
    throw new Error('Cache health receipt dataset version is invalid.');
  }
  if (typeof receipt.cacheVersion !== 'string' || receipt.cacheVersion.length === 0) {
    throw new Error('Cache health receipt cache version is invalid.');
  }
  if (!['repairing', 'ready', 'retry-scheduled'].includes(String(receipt.status))) {
    throw new Error('Cache health receipt status is invalid.');
  }
  if (!isNonNegativeSafeInteger(receipt.checkedAtMs)) {
    throw new Error('Cache health receipt check time is invalid.');
  }
  if (!isNonNegativeSafeInteger(receipt.repairAttempt)) {
    throw new Error('Cache health receipt repair attempt is invalid.');
  }
  if (receipt.nextRetryAtMs !== undefined && !isNonNegativeSafeInteger(receipt.nextRetryAtMs)) {
    throw new Error('Cache health receipt retry time is invalid.');
  }
  if (receipt.error !== undefined && typeof receipt.error !== 'string') {
    throw new Error('Cache health receipt error is invalid.');
  }
  return {
    contract: HOSTED_REFERENCE_CACHE_HEALTH_CONTRACT_V1,
    catalogId: receipt.catalogId,
    datasetVersion: receipt.datasetVersion,
    cacheVersion: receipt.cacheVersion,
    status: receipt.status as HostedReferenceCacheHealthV1['status'],
    checkedAtMs: receipt.checkedAtMs,
    repairAttempt: receipt.repairAttempt,
    ...(receipt.nextRetryAtMs === undefined ? {} : { nextRetryAtMs: receipt.nextRetryAtMs }),
    ...(receipt.error === undefined ? {} : { error: receipt.error }),
  };
}

export class HostedReferenceCacheReconciler {
  private readonly cacheRoot: string;
  private timer: unknown = null;
  private inFlight: Promise<HostedReferenceCacheReconcileResult> | null = null;
  private started = false;
  private stopped = false;

  constructor(private readonly deps: HostedReferenceCacheReconcilerDeps) {
    this.cacheRoot = resolve(deps.cacheRoot);
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      (this.deps.clearTimer ?? clearTimeout)(this.timer as never);
      this.timer = null;
    }
  }

  runNow(): Promise<HostedReferenceCacheReconcileResult> {
    if (this.inFlight) return this.inFlight;
    const run = this.reconcilePass();
    this.inFlight = run;
    const clear = (): void => {
      if (this.inFlight === run) this.inFlight = null;
    };
    void run.then(clear, clear);
    return run;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    const handle = (this.deps.setTimer ?? setTimeout)(() => {
      if (this.timer === handle) this.timer = null;
      void this.runNow().then(
        (result) => {
          const now = this.now();
          const interval = this.auditIntervalMs();
          const delay =
            result.nextRetryAtMs === undefined
              ? interval
              : Math.min(interval, Math.max(0, result.nextRetryAtMs - now));
          this.schedule(delay);
        },
        () => this.schedule(this.retryBaseDelayMs())
      );
    }, delayMs);
    this.timer = handle;
    if (handle && typeof handle === 'object' && 'unref' in handle) {
      const unref = (handle as { unref?: () => void }).unref;
      unref?.call(handle);
    }
  }

  private async reconcilePass(): Promise<HostedReferenceCacheReconcileResult> {
    let checked = 0;
    let repaired = 0;
    let ready = 0;
    let failed = 0;
    let skippedAbsent = 0;
    let deferredByBackoff = 0;
    let nextRetryAtMs: number | undefined;
    const initialEntries = await this.deps.listHosted();

    for (const initial of initialEntries) {
      checked += 1;
      const version = this.deps.versionsByCatalogId.get(initial.id);
      if (!version) {
        throw new Error(`Hosted cache version is unavailable for catalog ID ${initial.id}.`);
      }
      const hasFootprint =
        initial.cacheStatus === 'cached' ||
        initial.cacheStatusReason !== undefined ||
        (await (this.deps.hasLocalFootprint ?? this.defaultHasLocalFootprint)(initial.id));
      if (!hasFootprint) {
        skippedAbsent += 1;
        continue;
      }

      const previous = await this.readReceipt(initial.id);
      const now = this.now();
      if (initial.cacheStatus === 'cached') {
        await this.writeReceipt({
          contract: HOSTED_REFERENCE_CACHE_HEALTH_CONTRACT_V1,
          catalogId: initial.id,
          ...version,
          status: 'ready',
          checkedAtMs: now,
          repairAttempt: 0,
        });
        ready += 1;
        continue;
      }
      if (
        previous?.status === 'retry-scheduled' &&
        previous.datasetVersion === version.datasetVersion &&
        previous.cacheVersion === version.cacheVersion &&
        previous.nextRetryAtMs !== undefined &&
        previous.nextRetryAtMs > now
      ) {
        deferredByBackoff += 1;
        nextRetryAtMs = minimumDefined(nextRetryAtMs, previous.nextRetryAtMs);
        continue;
      }

      repaired += 1;
      const operationId =
        this.deps.createOperationId?.(initial.id) ?? `hosted-cache-${initial.id}-${randomUUID()}`;
      const repairAttempt =
        previous?.status === 'retry-scheduled' &&
        previous.datasetVersion === version.datasetVersion &&
        previous.cacheVersion === version.cacheVersion
          ? previous.repairAttempt + 1
          : 1;
      await this.writeReceipt({
        contract: HOSTED_REFERENCE_CACHE_HEALTH_CONTRACT_V1,
        catalogId: initial.id,
        ...version,
        status: 'repairing',
        checkedAtMs: now,
        repairAttempt,
      });
      this.publish(operationId, initial.id, {
        phase: 'cache-reconcile-checking',
        label: `Checking cached ${initial.name}`,
      });

      try {
        let current = initial;
        for (const themeMode of ['light', 'dark'] as const) {
          await this.deps.installHosted({
            catalogId: initial.id,
            themeMode,
            onProgress: (progress) => this.publish(operationId, initial.id, progress),
          });
          current = this.requireCatalogEntry(await this.deps.listHosted(), initial.id);
          if (current.cacheStatus === 'cached') break;
        }
        if (current.cacheStatus !== 'cached') {
          throw new Error(`Cached ${initial.name} is still incomplete after repair.`);
        }
        const completedAt = this.now();
        await this.writeReceipt({
          contract: HOSTED_REFERENCE_CACHE_HEALTH_CONTRACT_V1,
          catalogId: initial.id,
          ...version,
          status: 'ready',
          checkedAtMs: completedAt,
          repairAttempt: 0,
        });
        ready += 1;
        this.publish(operationId, initial.id, {
          phase: 'cache-reconcile-ready',
          label: `${initial.name} is available offline`,
          completed: 1,
          total: 1,
        });
      } catch (error) {
        failed += 1;
        const failedAt = this.now();
        const retryAt = failedAt + this.retryDelayMs(repairAttempt);
        nextRetryAtMs = minimumDefined(nextRetryAtMs, retryAt);
        const detail = boundedError(error);
        await this.writeReceipt({
          contract: HOSTED_REFERENCE_CACHE_HEALTH_CONTRACT_V1,
          catalogId: initial.id,
          ...version,
          status: 'retry-scheduled',
          checkedAtMs: failedAt,
          repairAttempt,
          nextRetryAtMs: retryAt,
          error: detail,
        });
        this.publish(operationId, initial.id, {
          phase: 'background-preparation-failed',
          label: `${initial.name} repair will retry automatically: ${detail}`,
        });
      }
    }

    await this.deps.collectSupersededVersions?.();
    return {
      checked,
      repaired,
      ready,
      failed,
      skippedAbsent,
      deferredByBackoff,
      ...(nextRetryAtMs === undefined ? {} : { nextRetryAtMs }),
    };
  }

  private publish(
    operationId: string,
    catalogId: string,
    progress: ReferenceAssetPreparationProgressUpdateV1
  ): void {
    this.deps.onProgress?.({ operationId, catalogId, ...progress });
  }

  private requireCatalogEntry(
    entries: ReadonlyArray<HostedReferenceCatalogEntryV1>,
    catalogId: string
  ): HostedReferenceCatalogEntryV1 {
    const entry = entries.find((candidate) => candidate.id === catalogId);
    if (!entry) throw new Error(`Hosted catalog entry disappeared during repair: ${catalogId}.`);
    return entry;
  }

  private readonly defaultHasLocalFootprint = async (catalogId: string): Promise<boolean> => {
    try {
      const status = await lstat(join(this.cacheRoot, catalogId));
      return status.isDirectory() && !status.isSymbolicLink();
    } catch (error) {
      if (isNodeErrorCode(error, 'ENOENT')) return false;
      throw error;
    }
  };

  private async readReceipt(catalogId: string): Promise<HostedReferenceCacheHealthV1 | null> {
    try {
      return parseHostedReferenceCacheHealthV1(
        JSON.parse(
          await readFile(hostedReferenceCacheHealthPathV1(this.cacheRoot, catalogId), 'utf8')
        )
      );
    } catch (error) {
      if (isNodeErrorCode(error, 'ENOENT') || error instanceof SyntaxError) return null;
      if (error instanceof Error && error.message.startsWith('Cache health receipt')) return null;
      throw error;
    }
  }

  private async writeReceipt(receipt: HostedReferenceCacheHealthV1): Promise<void> {
    const path = hostedReferenceCacheHealthPathV1(this.cacheRoot, receipt.catalogId);
    const directory = join(this.cacheRoot, HEALTH_DIRECTORY);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private now(): number {
    return this.deps.nowMs?.() ?? Date.now();
  }

  private auditIntervalMs(): number {
    return positiveDelay(this.deps.auditIntervalMs, DEFAULT_AUDIT_INTERVAL_MS);
  }

  private retryBaseDelayMs(): number {
    return positiveDelay(this.deps.retryBaseDelayMs, DEFAULT_RETRY_BASE_DELAY_MS);
  }

  private retryMaxDelayMs(): number {
    return positiveDelay(this.deps.retryMaxDelayMs, DEFAULT_RETRY_MAX_DELAY_MS);
  }

  private retryDelayMs(attempt: number): number {
    return Math.min(
      this.retryBaseDelayMs() * 2 ** Math.max(0, attempt - 1),
      this.retryMaxDelayMs()
    );
  }
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

function positiveDelay(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value !== undefined && value > 0 ? value : fallback;
}

function minimumDefined(current: number | undefined, candidate: number): number {
  return current === undefined ? candidate : Math.min(current, candidate);
}

function boundedError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return detail.replace(/\s+/gu, ' ').trim().slice(0, 1_000) || 'Unknown repair failure';
}
