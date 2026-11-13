import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  HostedReferenceCatalogEntryV1,
  ReferenceAssetThemeModeV1,
} from '../../shared/reference-assets-ipc';
import {
  HOSTED_REFERENCE_CACHE_HEALTH_CONTRACT_V1,
  HostedReferenceCacheReconciler,
  hostedReferenceCacheHealthPathV1,
  parseHostedReferenceCacheHealthV1,
} from './hosted-reference-cache-reconciler';

const roots: string[] = [];

function hostedEntry(
  id: string,
  cacheStatus: HostedReferenceCatalogEntryV1['cacheStatus'],
  cacheStatusReason?: HostedReferenceCatalogEntryV1['cacheStatusReason']
): HostedReferenceCatalogEntryV1 {
  return {
    id,
    name: id,
    organism: 'Test organism',
    assembly: `${id}-assembly`,
    description: `${id} reference`,
    cacheStatus,
    ...(cacheStatusReason ? { cacheStatusReason } : {}),
    lengthBp: 1_000,
    contigCount: 1,
    downloadBytes: 2_000,
    provider: 'Test provider',
    datasetVersion: `${id}-dataset-v2`,
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'hosted-cache-reconciler-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('HostedReferenceCacheReconciler', () => {
  it('repairs only references with a local footprint and publishes versioned ready receipts', async () => {
    const cacheRoot = await temporaryRoot();
    const entries = new Map<string, HostedReferenceCatalogEntryV1>([
      ['absent', hostedEntry('absent', 'not-cached')],
      ['stale', hostedEntry('stale', 'stale', 'local-files-invalid')],
      ['partial', hostedEntry('partial', 'not-cached', 'prepared-files-incomplete')],
    ]);
    const installs: Array<readonly [string, ReferenceAssetThemeModeV1]> = [];
    const progress: string[] = [];
    const reconciler = new HostedReferenceCacheReconciler({
      cacheRoot,
      versionsByCatalogId: new Map([
        ['absent', { datasetVersion: 'absent-dataset-v2', cacheVersion: 'absent-cache-v4' }],
        ['stale', { datasetVersion: 'stale-dataset-v2', cacheVersion: 'stale-cache-v4' }],
        ['partial', { datasetVersion: 'partial-dataset-v2', cacheVersion: 'partial-cache-v4' }],
      ]),
      listHosted: async () => [...entries.values()],
      hasLocalFootprint: async (catalogId) => catalogId !== 'absent',
      installHosted: async ({ catalogId, themeMode, onProgress }) => {
        installs.push([catalogId, themeMode]);
        onProgress({ phase: 'verifying-publication', label: `Verifying ${catalogId}` });
        if (catalogId === 'stale' || themeMode === 'dark') {
          entries.set(catalogId, hostedEntry(catalogId, 'cached'));
        }
        return {
          id: catalogId,
          name: catalogId,
          organism: 'Test organism',
          description: `${catalogId} reference`,
          assetCacheKey: catalogId,
          members: [],
        };
      },
      onProgress: (event) => progress.push(`${event.catalogId}:${event.phase}`),
      createOperationId: (catalogId) => `reconcile-${catalogId}`,
      nowMs: () => 2_000,
    });

    await expect(reconciler.runNow()).resolves.toMatchObject({
      checked: 3,
      repaired: 2,
      ready: 2,
      failed: 0,
      skippedAbsent: 1,
    });
    expect(installs).toEqual([
      ['stale', 'light'],
      ['partial', 'light'],
      ['partial', 'dark'],
    ]);
    expect(progress).toContain('stale:cache-reconcile-ready');
    expect(progress).toContain('partial:cache-reconcile-ready');
    expect(progress.some((event) => event.startsWith('absent:'))).toBe(false);

    for (const id of ['stale', 'partial']) {
      const receipt = parseHostedReferenceCacheHealthV1(
        JSON.parse(await readFile(hostedReferenceCacheHealthPathV1(cacheRoot, id), 'utf8'))
      );
      expect(receipt).toMatchObject({
        contract: HOSTED_REFERENCE_CACHE_HEALTH_CONTRACT_V1,
        catalogId: id,
        datasetVersion: `${id}-dataset-v2`,
        cacheVersion: `${id}-cache-v4`,
        status: 'ready',
        checkedAtMs: 2_000,
        repairAttempt: 0,
      });
    }
    await expect(
      readFile(hostedReferenceCacheHealthPathV1(cacheRoot, 'absent'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('persists retry backoff across a new reconciler instance and then self-heals', async () => {
    const cacheRoot = await temporaryRoot();
    let now = 10_000;
    let entry = hostedEntry('stale', 'stale', 'local-files-invalid');
    let attempts = 0;
    const common = {
      cacheRoot,
      versionsByCatalogId: new Map([
        ['stale', { datasetVersion: 'stale-dataset-v2', cacheVersion: 'stale-cache-v4' }],
      ]),
      listHosted: async () => [entry],
      hasLocalFootprint: async () => true,
      nowMs: () => now,
      retryBaseDelayMs: 1_000,
      retryMaxDelayMs: 8_000,
    } as const;
    const first = new HostedReferenceCacheReconciler({
      ...common,
      installHosted: async () => {
        attempts += 1;
        throw new Error('temporary transport failure');
      },
    });

    await expect(first.runNow()).resolves.toMatchObject({ failed: 1, ready: 0 });
    const failedReceipt = parseHostedReferenceCacheHealthV1(
      JSON.parse(await readFile(hostedReferenceCacheHealthPathV1(cacheRoot, 'stale'), 'utf8'))
    );
    expect(failedReceipt).toMatchObject({
      status: 'retry-scheduled',
      repairAttempt: 1,
      nextRetryAtMs: 11_000,
    });

    const restarted = new HostedReferenceCacheReconciler({
      ...common,
      installHosted: async ({ catalogId }) => {
        attempts += 1;
        entry = hostedEntry(catalogId, 'cached');
        return {
          id: catalogId,
          name: catalogId,
          organism: 'Test organism',
          description: 'Reference',
          assetCacheKey: catalogId,
          members: [],
        };
      },
    });
    await expect(restarted.runNow()).resolves.toMatchObject({ deferredByBackoff: 1 });
    expect(attempts).toBe(1);

    now = 11_000;
    await expect(restarted.runNow()).resolves.toMatchObject({ repaired: 1, ready: 1 });
    expect(attempts).toBe(2);
    const readyReceipt = parseHostedReferenceCacheHealthV1(
      JSON.parse(await readFile(hostedReferenceCacheHealthPathV1(cacheRoot, 'stale'), 'utf8'))
    );
    expect(readyReceipt).toMatchObject({ status: 'ready', repairAttempt: 0 });
    expect(readyReceipt).not.toHaveProperty('nextRetryAtMs');
  });

  it('starts the first audit in the background and stops its recurring timer', async () => {
    vi.useFakeTimers();
    const cacheRoot = await temporaryRoot();
    const listHosted = vi.fn(async () => []);
    const reconciler = new HostedReferenceCacheReconciler({
      cacheRoot,
      versionsByCatalogId: new Map(),
      listHosted,
      hasLocalFootprint: async () => false,
      installHosted: vi.fn(),
      auditIntervalMs: 60_000,
    });

    reconciler.start();
    expect(listHosted).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(listHosted).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);

    reconciler.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
