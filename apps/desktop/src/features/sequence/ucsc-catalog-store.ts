import type { UcscCatalogLeaf } from '@waypoint/genome-data';

import { fetchUcscCatalog, searchUcscTracks, type UcscCatalogSnapshot } from './ucsc-track-client';
import { searchUcscCatalogLocally, ucscCatalogSearchTerms } from './ucsc-catalog-search';
import {
  readHostedUcscCatalogSnapshot,
  writeHostedUcscCatalogSnapshot,
} from './ucsc-catalog-snapshot';

export interface UcscCatalogSearchResult {
  readonly tracks: ReadonlyArray<UcscCatalogLeaf>;
  readonly total: number;
  readonly catalogSize: number | null;
  readonly complete: boolean;
  readonly terms: ReadonlyArray<string>;
}

const FALLBACK_SEARCH_LIMIT = 200;
const REFRESH_AFTER_MS = 15 * 60 * 1000;
export const HOSTED_CATALOG_REFRESH_IDLE_MS = 30 * 1000;

const catalogs = new Map<string, Promise<UcscCatalogSnapshot>>();
const refreshListeners = new Map<string, Set<() => void>>();
const deferredRefreshes = new Map<
  string,
  {
    input: { genome: string; hubUrl?: string };
    options: { fetchImpl?: typeof fetch };
    generation: number;
    timer: ReturnType<typeof setTimeout> | null;
    controller: AbortController | null;
  }
>();
let cacheGeneration = 0;

function cacheKey(genome: string, hubUrl?: string): string {
  return `${genome}\u0000${hubUrl ?? ''}`;
}

export function clearUcscCatalogCache(): void {
  cacheGeneration += 1;
  catalogs.clear();
  for (const pending of deferredRefreshes.values()) {
    if (pending.timer !== null) clearTimeout(pending.timer);
    pending.controller?.abort();
  }
  deferredRefreshes.clear();
}

function scheduleDeferredRefresh(key: string): void {
  const pending = deferredRefreshes.get(key);
  if (!pending || pending.timer !== null || pending.controller || refreshListeners.get(key)?.size)
    return;
  pending.timer = setTimeout(() => {
    pending.timer = null;
    if (cacheGeneration !== pending.generation || refreshListeners.get(key)?.size) return;
    const controller = new AbortController();
    pending.controller = controller;
    void fetchAndRemember(
      key,
      pending.input,
      { ...pending.options, signal: controller.signal },
      true,
      pending.generation
    )
      .then(() => {
        if (deferredRefreshes.get(key) === pending) deferredRefreshes.delete(key);
      })
      .catch(() => {
        if (deferredRefreshes.get(key) !== pending) return;
        pending.controller = null;
        if (controller.signal.aborted) scheduleDeferredRefresh(key);
      });
  }, HOSTED_CATALOG_REFRESH_IDLE_MS);
}

export function subscribeUcscCatalog(
  input: { genome: string; hubUrl?: string },
  listener: () => void
): () => void {
  const key = cacheKey(input.genome, input.hubUrl);
  const listeners = refreshListeners.get(key) ?? new Set<() => void>();
  listeners.add(listener);
  refreshListeners.set(key, listeners);
  const pending = deferredRefreshes.get(key);
  if (pending?.timer !== null && pending?.timer !== undefined) {
    clearTimeout(pending.timer);
    pending.timer = null;
  }
  pending?.controller?.abort();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      refreshListeners.delete(key);
      scheduleDeferredRefresh(key);
    }
  };
}

async function fetchAndRemember(
  key: string,
  input: { genome: string; hubUrl?: string },
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal },
  backgroundRefresh: boolean,
  generation: number
): Promise<UcscCatalogSnapshot> {
  const snapshot = await fetchUcscCatalog(input, options);
  options.signal?.throwIfAborted();
  if (cacheGeneration !== generation) return snapshot;
  catalogs.set(key, Promise.resolve(snapshot));
  if (!input.hubUrl) void writeHostedUcscCatalogSnapshot(snapshot).catch(() => undefined);
  if (backgroundRefresh) {
    for (const listener of refreshListeners.get(key) ?? []) listener();
  }
  return snapshot;
}

export async function loadUcscCatalog(
  input: { genome: string; hubUrl?: string },
  options: { fetchImpl?: typeof fetch } = {}
): Promise<UcscCatalogSnapshot> {
  const key = cacheKey(input.genome, input.hubUrl);
  const cached = catalogs.get(key);
  if (cached) return cached;
  const generation = cacheGeneration;

  const pending = (async () => {
    if (!input.hubUrl) {
      const stored = await readHostedUcscCatalogSnapshot(input.genome).catch(() => null);
      if (stored) {
        if (Date.now() - stored.savedAt >= REFRESH_AFTER_MS) {
          deferredRefreshes.set(key, { input, options, generation, timer: null, controller: null });
          scheduleDeferredRefresh(key);
        }
        return stored.snapshot;
      }
    }
    return fetchAndRemember(key, input, options, false, generation);
  })().catch((error: unknown) => {
    if (catalogs.get(key) === pending) catalogs.delete(key);
    throw error;
  });
  catalogs.set(key, pending);
  return pending;
}

export async function searchUcscCatalog(
  input: { genome: string; query: string; hubUrl?: string },
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {}
): Promise<UcscCatalogSearchResult> {
  try {
    const snapshot = await loadUcscCatalog(
      { genome: input.genome, ...(input.hubUrl ? { hubUrl: input.hubUrl } : {}) },
      options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}
    );
    options.signal?.throwIfAborted();
    const matched = searchUcscCatalogLocally(snapshot.tracks, input.query);
    return {
      tracks: matched.tracks,
      total: matched.total,
      catalogSize: matched.catalogSize,
      complete: true,
      terms: matched.terms,
    };
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error;
    const tracks = await searchUcscTracks(
      {
        genome: input.genome,
        query: input.query,
        limit: FALLBACK_SEARCH_LIMIT,
        ...(input.hubUrl ? { hubUrl: input.hubUrl } : {}),
      },
      options
    );
    return {
      tracks,
      total: tracks.length,
      catalogSize: null,
      complete: false,
      terms: ucscCatalogSearchTerms(input.query),
    };
  }
}
