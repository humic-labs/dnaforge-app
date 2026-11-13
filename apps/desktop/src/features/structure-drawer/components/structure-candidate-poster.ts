import type { StructureCandidate } from '../types/structure-drawer';
import { getSidecarBaseUrl, resolveSidecarBaseUrl } from '../../../services/sidecar-session';
import { sidecarFetch } from '../../../services/sidecar-session';

export interface StructureCandidatePosterAsset {
  primaryUrl: string;
  fallbackUrl?: string;
  primarySourceUrl: string;
  fallbackSourceUrl?: string;
  providerLabel: string;
}

export interface StructureCandidatePosterLease {
  objectUrl: string;
  release: () => void;
}

type PosterBlobWaiterKind = 'consumer' | 'prefetch';

interface PosterBlobPendingEntry {
  readonly sourceUrl: string;
  readonly startedFor: PosterBlobWaiterKind;
  readonly controller: AbortController;
  readonly promise: Promise<Blob | null>;
  readonly waiters: Map<symbol, PosterBlobWaiterKind>;
}

type PosterBlobCapacityOutcome = 'available' | 'aborted' | 'overloaded' | 'reset';
type PosterBlobCapacityWaiter = (outcome: PosterBlobCapacityOutcome) => void;

const posterBlobCache = new Map<string, Blob>();
const posterBlobPending = new Map<string, PosterBlobPendingEntry>();
const posterBlobCapacityWaiters = new Set<PosterBlobCapacityWaiter>();
const POSTER_BLOB_CACHE_MAX_ENTRIES = 32;
const POSTER_BLOB_PENDING_MAX_ENTRIES = 32;
const POSTER_BLOB_CAPACITY_MAX_WAITERS = 64;
const POSTER_FETCH_TIMEOUT_MS = 15_000;
const ALPHAFOLD_POSTER_RENDER_VERSION = 'cartoon-plddt-v3';

export class StructureCandidatePosterCapacityError extends Error {
  constructor() {
    super('Structure poster request capacity queue is full.');
    this.name = 'StructureCandidatePosterCapacityError';
  }
}

export function isStructureCandidatePosterCapacityError(error: unknown): boolean {
  return (
    error instanceof StructureCandidatePosterCapacityError ||
    (error instanceof Error && error.name === 'StructureCandidatePosterCapacityError')
  );
}

export function structureCandidatePosterAsset(
  candidate: StructureCandidate | null | undefined,
  runtimeSidecarBaseUrl?: string
): StructureCandidatePosterAsset | null {
  if (!candidate) return null;

  const sidecarBaseUrl =
    runtimeSidecarBaseUrl ?? getSidecarBaseUrl('structure-drawer/poster-preview');
  if (candidate.structure.kind === 'pdb') {
    const pdbId = candidate.structure.pdbId.trim().toLowerCase();
    if (!pdbId) return null;
    const rawAssemblyId =
      candidate.structure.assemblyId ?? candidate.provenance.structureIdentity?.assemblyId ?? '1';
    const assemblyId = /^\d+$/.test(rawAssemblyId) ? rawAssemblyId : '1';
    const primaryPosterKind = `assembly-${assemblyId}`;
    const fallbackPosterKind = 'model-1';
    const sidecarBase = `${sidecarBaseUrl}/external/structure/poster/pdb/${encodeURIComponent(
      pdbId
    )}`;

    return {
      primaryUrl: `${sidecarBase}/${primaryPosterKind}`,
      fallbackUrl: `${sidecarBase}/${fallbackPosterKind}`,
      primarySourceUrl: `https://cdn.rcsb.org/images/structures/${pdbId}_${primaryPosterKind}.jpeg`,
      fallbackSourceUrl: `https://cdn.rcsb.org/images/structures/${pdbId}_${fallbackPosterKind}.jpeg`,
      providerLabel: 'RCSB PDB',
    };
  }

  if (candidate.structure.kind === 'uniprot') {
    const accession =
      candidate.structure.accession.trim().toUpperCase() ||
      candidate.metadata.uniprotAccession?.trim().toUpperCase() ||
      candidate.provenance.structureIdentity?.accession?.trim().toUpperCase();
    if (!accession || !/^[0-9A-Z]+$/.test(accession)) return null;
    const fragment = normalizeAlphaFoldFragment(
      candidate.structure.fragment ?? candidate.provenance.structureIdentity?.fragment
    );
    const posterVersion = normalizeAlphaFoldPosterVersion(
      candidate.structure.version ??
        candidate.provenance.structureIdentity?.version ??
        versionFromAlphaFoldModelId(
          candidate.structure.modelId ?? candidate.provenance.structureIdentity?.modelId
        )
    );
    const sidecarBase = `${sidecarBaseUrl}/external/structure/poster/alphafold/${encodeURIComponent(
      accession
    )}/${encodeURIComponent(fragment)}`;
    const sourceVersion = posterVersion === 'latest' ? null : posterVersion.replace(/^v/i, '');

    return {
      primaryUrl: `${sidecarBase}/${posterVersion}?render=${ALPHAFOLD_POSTER_RENDER_VERSION}`,
      primarySourceUrl: sourceVersion
        ? `https://alphafold.ebi.ac.uk/files/AF-${accession}-${fragment}-model_v${sourceVersion}.cif`
        : `https://alphafold.ebi.ac.uk/entry/${accession}`,
      providerLabel: 'AlphaFold DB',
    };
  }

  return null;
}

export async function resolveStructureCandidatePosterBaseUrl(): Promise<string> {
  return resolveSidecarBaseUrl('structure-drawer/poster-preview');
}

export function structureCandidatePosterPrefetchUrls(
  candidates: readonly StructureCandidate[],
  runtimeSidecarBaseUrl?: string
): string[] {
  const urls: string[] = [];
  for (const candidate of candidates) {
    const asset = structureCandidatePosterAsset(candidate, runtimeSidecarBaseUrl);
    if (!asset) continue;
    urls.push(asset.primaryUrl);
    if (asset.fallbackUrl) urls.push(asset.fallbackUrl);
  }
  return [...new Set(urls)];
}

export async function loadStructureCandidatePosterObjectUrl(
  asset: StructureCandidatePosterAsset,
  signal?: AbortSignal
): Promise<StructureCandidatePosterLease | null> {
  const primary = await loadPosterBlob(asset.primaryUrl, signal, 'consumer');
  if (signal?.aborted) return null;
  const blob =
    primary ??
    (asset.fallbackUrl ? await loadPosterBlob(asset.fallbackUrl, signal, 'consumer') : null);
  if (!blob || signal?.aborted) return null;
  return createPosterObjectUrlLease(blob);
}

export function prefetchStructureCandidatePosters(candidates: readonly StructureCandidate[]): void {
  void resolveStructureCandidatePosterBaseUrl()
    .then((sidecarBaseUrl) => {
      for (const url of structureCandidatePosterPrefetchUrls(candidates, sidecarBaseUrl)) {
        void loadPosterBlob(url, undefined, 'prefetch').catch(() => null);
      }
    })
    .catch(() => null);
}

export function _resetStructureCandidatePosterCacheForTesting(): void {
  for (const entry of posterBlobPending.values()) entry.controller.abort();
  for (const wake of [...posterBlobCapacityWaiters]) wake('reset');
  posterBlobCache.clear();
  posterBlobPending.clear();
}

function cachePosterBlob(sourceUrl: string, blob: Blob): void {
  posterBlobCache.set(sourceUrl, blob);
  while (posterBlobCache.size > POSTER_BLOB_CACHE_MAX_ENTRIES) {
    const oldestSourceUrl = posterBlobCache.keys().next().value;
    if (oldestSourceUrl === undefined) break;
    posterBlobCache.delete(oldestSourceUrl);
  }
}

function revokePosterObjectUrl(objectUrl: string): void {
  if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(objectUrl);
}

function createPosterObjectUrlLease(blob: Blob): StructureCandidatePosterLease {
  const objectUrl = URL.createObjectURL(blob);
  let released = false;
  return {
    objectUrl,
    release: () => {
      if (released) return;
      released = true;
      revokePosterObjectUrl(objectUrl);
    },
  };
}

async function loadPosterBlob(
  url: string,
  signal: AbortSignal | undefined,
  waiterKind: PosterBlobWaiterKind
): Promise<Blob | null> {
  const cached = posterBlobCache.get(url);
  if (cached) {
    posterBlobCache.delete(url);
    posterBlobCache.set(url, cached);
    return cached;
  }
  if (signal?.aborted) return null;
  const pending =
    posterBlobPending.get(url) ?? (await startPosterBlobFetch(url, signal, waiterKind));
  if (!pending) return null;
  return waitForPosterBlob(pending, signal, waiterKind);
}

async function startPosterBlobFetch(
  url: string,
  signal: AbortSignal | undefined,
  waiterKind: PosterBlobWaiterKind
): Promise<PosterBlobPendingEntry | null> {
  while (posterBlobPending.size >= POSTER_BLOB_PENDING_MAX_ENTRIES) {
    if (waiterKind === 'prefetch') return null;
    const evictable = [...posterBlobPending].find(
      ([, entry]) =>
        entry.startedFor === 'prefetch' &&
        [...entry.waiters.values()].every((kind) => kind === 'prefetch')
    );
    if (evictable) {
      evictable[1].controller.abort();
      await evictable[1].promise;
      continue;
    }
    const capacity = await waitForPosterBlobCapacity(signal);
    if (capacity === 'overloaded') throw new StructureCandidatePosterCapacityError();
    if (capacity !== 'available') return null;
  }

  const existing = posterBlobPending.get(url);
  if (existing) return existing;
  const cached = posterBlobCache.get(url);
  if (cached) {
    posterBlobCache.delete(url);
    posterBlobCache.set(url, cached);
    return resolvedPosterBlobEntry(url, cached);
  }
  if (signal?.aborted) return null;

  const controller = new AbortController();
  const waiters = new Map<symbol, PosterBlobWaiterKind>();
  const timeout = setTimeout(() => controller.abort(), POSTER_FETCH_TIMEOUT_MS);
  const promise = sidecarFetch(url, { signal: controller.signal })
    .then(async (response) => {
      if (!response.ok) return null;
      const blob = await response.blob();
      if (!blob.type.startsWith('image/')) return null;
      cachePosterBlob(url, blob);
      return blob;
    })
    .catch(() => null)
    .finally(() => {
      clearTimeout(timeout);
      releasePendingPosterBlob(url, entry);
    });
  const entry = { sourceUrl: url, startedFor: waiterKind, controller, promise, waiters };
  posterBlobPending.set(url, entry);
  return entry;
}

function resolvedPosterBlobEntry(sourceUrl: string, blob: Blob): PosterBlobPendingEntry {
  return {
    sourceUrl,
    startedFor: 'consumer',
    controller: new AbortController(),
    promise: Promise.resolve(blob),
    waiters: new Map(),
  };
}

function releasePendingPosterBlob(sourceUrl: string, entry: PosterBlobPendingEntry): void {
  if (posterBlobPending.get(sourceUrl) !== entry) return;
  posterBlobPending.delete(sourceUrl);
  wakePosterBlobCapacityWaiter();
}

function wakePosterBlobCapacityWaiter(): void {
  const wake = posterBlobCapacityWaiters.values().next().value;
  wake?.('available');
}

function waitForPosterBlobCapacity(
  signal: AbortSignal | undefined
): Promise<PosterBlobCapacityOutcome> {
  if (posterBlobPending.size < POSTER_BLOB_PENDING_MAX_ENTRIES) {
    return Promise.resolve('available');
  }
  if (signal?.aborted) return Promise.resolve('aborted');
  if (posterBlobCapacityWaiters.size >= POSTER_BLOB_CAPACITY_MAX_WAITERS) {
    return Promise.resolve('overloaded');
  }
  return new Promise<PosterBlobCapacityOutcome>((resolve) => {
    let settled = false;
    const wake: PosterBlobCapacityWaiter = (outcome) => {
      if (settled) return;
      settled = true;
      posterBlobCapacityWaiters.delete(wake);
      signal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const onAbort = () => wake('aborted');
    posterBlobCapacityWaiters.add(wake);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function waitForPosterBlob(
  entry: PosterBlobPendingEntry,
  signal: AbortSignal | undefined,
  waiterKind: PosterBlobWaiterKind
): Promise<Blob | null> {
  const waiter = Symbol('structure-poster-waiter');
  entry.waiters.set(waiter, waiterKind);
  let onAbort: (() => void) | undefined;
  try {
    if (!signal) return await entry.promise;
    const aborted = new Promise<null>((resolve) => {
      onAbort = () => resolve(null);
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
    return await Promise.race([entry.promise, aborted]);
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    entry.waiters.delete(waiter);
    if (
      entry.waiters.size === 0 &&
      posterBlobPending.get(entry.sourceUrl) === entry &&
      !entry.controller.signal.aborted
    ) {
      entry.controller.abort();
    }
  }
}

function normalizeAlphaFoldFragment(value: string | undefined): string {
  const normalized = value?.trim().toUpperCase() ?? '';
  return /^F[1-9][0-9]*$/.test(normalized) ? normalized : 'F1';
}

function normalizeAlphaFoldPosterVersion(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase() ?? '';
  const match = /^v?([1-9][0-9]*)$/.exec(normalized);
  return match ? `v${match[1]}` : 'latest';
}

function versionFromAlphaFoldModelId(value: string | undefined): string | undefined {
  const match = /-model_v([1-9][0-9]*)$/i.exec(value?.trim() ?? '');
  return match ? `v${match[1]}` : undefined;
}
