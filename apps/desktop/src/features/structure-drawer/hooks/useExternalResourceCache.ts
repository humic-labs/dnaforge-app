import type { ResolverResult, StructureDrawerRequest } from '../types/structure-drawer';
import { getExternalResourceByExternalId } from '../api/sidecar-client';

const DB_NAME = 'waypoint-external-resource-cache';
const DB_VERSION = 1;
const STORE_NAME = 'resolver-results';
const CACHE_SCHEMA_VERSION = 2;

const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export interface ReconcileDependency {
  provider: string;
  externalId: string;
}

export interface ReconcileMetadata extends ReconcileDependency {
  versionIdentifier: string | null;
  etag: string | null;
}

type CacheKeyInput =
  | string
  | Pick<
      StructureDrawerRequest,
      | 'translation'
      | 'moleculeType'
      | 'proteinIdentity'
      | 'identityRequestKey'
      | 'hints'
      | 'entityId'
    >;

interface CachedExternalResourceEntry {
  schemaVersion?: number;
  key: string;
  result: ResolverResult;
  cachedAt: number;
  reconciles?: ReconcileMetadata[];
  reconcile?: ReconcileMetadata | null;
}

let dbPromise: Promise<IDBDatabase> | null = null;

export function _resetCacheForTesting(): void {
  dbPromise = null;
}

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !window.indexedDB) {
      reject(new Error('IndexedDB not available'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };
  });
  return dbPromise;
}

async function sha256Hex(input: string): Promise<string> {
  const buffer = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

export async function deriveCacheKey(input: CacheKeyInput): Promise<string> {
  if (typeof input === 'string') {
    return sha256Hex(input);
  }
  const proteinSequence = input.proteinIdentity?.sequence;
  if (proteinSequence) {
    if (input.translation !== proteinSequence.lookupSequence) {
      throw new Error(
        'Structure resolver cache key mismatch: request.translation does not match proteinIdentity.sequence.lookupSequence'
      );
    }
    const expectedIdentityKey = `protein-sequence:v2:${proteinSequence.digests.sha256}`;
    if (proteinSequence.identityKey !== expectedIdentityKey) {
      throw new Error(
        'Structure resolver cache key mismatch: proteinIdentity.sequence.identityKey is not derived from the canonical SHA-256 digest'
      );
    }
  }
  return sha256Hex(
    stableStringify({
      translation: input.translation,
      moleculeType: input.moleculeType ?? 'protein',
      proteinIdentityKey: proteinSequence?.identityKey ?? null,
      identityRequestKey: input.identityRequestKey ?? null,
      entityId: input.entityId ?? null,
      hints: input.hints ?? {},
    })
  );
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function deriveReconcileDependencies(result: ResolverResult): ReconcileDependency[] {
  const dependencies: ReconcileDependency[] = [];

  for (const candidate of result.candidates ?? []) {
    if (candidate.provider === 'pdb') {
      const providerIdentityKey =
        candidate.provenance.structureIdentity?.kind === 'rcsb'
          ? candidate.provenance.structureIdentity.providerIdentityKey
          : candidate.structure.kind === 'pdb'
            ? candidate.structure.providerIdentityKey
            : undefined;
      const pdbId =
        candidate.metadata.pdbId ??
        (candidate.structure.kind === 'pdb' ? candidate.structure.pdbId : undefined);
      if (pdbId && candidate.provenance.externalResourceId) {
        dependencies.push({
          provider: 'rcsb',
          externalId: providerIdentityKey ?? pdbId.toUpperCase(),
        });
      }
      continue;
    }
    if (candidate.provider === 'alphafold') {
      const accession =
        candidate.metadata.uniprotAccession ??
        (candidate.structure.kind === 'uniprot' ? candidate.structure.accession : undefined);
      if (accession && candidate.provenance.externalResourceId) {
        dependencies.push({ provider: 'alphafold', externalId: accession.toUpperCase() });
      }
    }
  }

  if (result.structure.kind === 'uniprot') {
    dependencies.push({
      provider: 'uniprot',
      externalId: result.structure.accession.toUpperCase(),
    });
  }

  return dedupeReconcileDependencies(dependencies);
}

export function deriveReconcileTuple(
  result: ResolverResult
): { provider: string; externalId: string } | null {
  const first = deriveReconcileDependencies(result)[0];
  return first ? { provider: first.provider, externalId: first.externalId } : null;
}

async function readEntry(key: string): Promise<CachedExternalResourceEntry | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(key);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      resolve((request.result as CachedExternalResourceEntry | undefined) ?? null);
    };
  });
}

async function writeEntry(entry: CachedExternalResourceEntry): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.put(entry);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

async function deleteEntry(key: string): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.delete(key);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

export async function getCachedExternalResourceResult(
  input: CacheKeyInput,
  signal: AbortSignal
): Promise<ResolverResult | null> {
  try {
    const key = await deriveCacheKey(input);
    const entry = await readEntry(key);
    if (!entry) return null;
    if (entry.schemaVersion !== CACHE_SCHEMA_VERSION) {
      await deleteEntry(key);
      return null;
    }

    if (Date.now() - entry.cachedAt > STALE_AFTER_MS) {
      await deleteEntry(key);
      return null;
    }

    const reconciles = normalizeReconciles(entry);
    if (reconciles.length === 0) return entry.result;

    for (const reconcile of reconciles) {
      const row = await getExternalResourceByExternalId(
        reconcile.provider,
        reconcile.externalId,
        signal
      );
      if (!row) {
        await deleteEntry(key);
        return null;
      }
      const versionDrift =
        row.versionIdentifier !== reconcile.versionIdentifier || row.etag !== reconcile.etag;
      if (versionDrift) {
        await deleteEntry(key);
        return null;
      }
    }
    return entry.result;
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    return null;
  }
}

export async function setCachedExternalResourceResult(
  input: CacheKeyInput,
  result: ResolverResult,
  signal: AbortSignal
): Promise<void> {
  try {
    const key = await deriveCacheKey(input);
    const dependencies = deriveReconcileDependencies(result);
    const reconciles: ReconcileMetadata[] = [];
    for (const dependency of dependencies) {
      const row = await getExternalResourceByExternalId(
        dependency.provider,
        dependency.externalId,
        signal
      );
      if (row) {
        reconciles.push({
          provider: row.provider,
          externalId: row.externalId,
          versionIdentifier: row.versionIdentifier,
          etag: row.etag,
        });
      }
    }
    const entry: CachedExternalResourceEntry = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      key,
      result,
      cachedAt: Date.now(),
      reconciles,
    };
    await writeEntry(entry);
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
  }
}

export async function clearExternalResourceCache(): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.clear();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  } catch {}
}

export async function getCachedExternalResourceKeys(): Promise<string[]> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.getAllKeys();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result as string[]);
    });
  } catch {
    return [];
  }
}

export async function invalidateCacheByExternalIds(
  matches: ReadonlyArray<{ provider: string; externalId: string }>
): Promise<number> {
  if (matches.length === 0) return 0;
  if (matches.length > 100) {
    matches = matches.slice(0, 100);
  }
  let evicted = 0;
  try {
    const db = await openDB();
    const targets = new Set(
      matches.map(({ provider, externalId }) => reconcileTargetKey(provider, externalId))
    );
    const entries: CachedExternalResourceEntry[] = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.getAll();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result as CachedExternalResourceEntry[]);
    });
    for (const entry of entries) {
      const hasMatch = normalizeReconciles(entry).some((reconcile) =>
        targets.has(reconcileTargetKey(reconcile.provider, reconcile.externalId))
      );
      if (hasMatch) {
        await deleteEntry(entry.key);
        evicted++;
      }
    }
  } catch {}
  return evicted;
}

function dedupeReconcileDependencies<T extends ReconcileDependency>(dependencies: T[]): T[] {
  const byKey = new Map<string, T>();
  for (const dependency of dependencies) {
    byKey.set(reconcileTargetKey(dependency.provider, dependency.externalId), dependency);
  }
  return [...byKey.values()];
}

function normalizeReconciles(entry: CachedExternalResourceEntry): ReconcileMetadata[] {
  if (Array.isArray(entry.reconciles)) {
    return entry.reconciles;
  }
  return entry.reconcile ? [entry.reconcile] : [];
}

function reconcileTargetKey(provider: string, externalId: string): string {
  return `${provider}\u0000${externalId.toUpperCase()}`;
}

import { shouldEnableTestBridge } from '../../../lib/test-bridge-gate';

type ExternalResourceCacheWindow = Window & {
  __externalResourceCacheKeys?: () => Promise<string[]>;
  __clearExternalResourceCache?: () => Promise<void>;
};

if (typeof window !== 'undefined' && shouldEnableTestBridge(import.meta.env)) {
  const testWindow = window as ExternalResourceCacheWindow;
  testWindow.__externalResourceCacheKeys = async () => {
    const keys = await getCachedExternalResourceKeys();
    console.log('[externalResourceCache] keys:', keys);
    return keys;
  };
  testWindow.__clearExternalResourceCache = async () => {
    await clearExternalResourceCache();
    console.log('[externalResourceCache] cleared');
  };
}
