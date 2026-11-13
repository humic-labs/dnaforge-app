import type { UcscCatalogSnapshot } from './ucsc-track-client';

const DB_NAME = 'dnaforge-ucsc-catalog';
const STORE_NAME = 'hosted-catalogs';
const DB_VERSION = 1;
const SNAPSHOT_VERSION = 1;
const MAX_SNAPSHOT_AGE_MS = 30 * 24 * 60 * 60 * 1000;

interface StoredSnapshot {
  readonly key: string;
  readonly version: number;
  readonly savedAt: number;
  readonly snapshot: UcscCatalogSnapshot;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function keyFor(genome: string): string {
  return `ucsc-native\u0000${genome}`;
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB unavailable'));
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Catalog snapshot database failed'));
    request.onblocked = () => reject(new Error('Catalog snapshot database is blocked'));
  });
  const tracked = pending.catch((error: unknown) => {
    if (dbPromise === tracked) dbPromise = null;
    throw error;
  });
  dbPromise = tracked;
  return tracked;
}

export async function readHostedUcscCatalogSnapshot(
  genome: string
): Promise<{ snapshot: UcscCatalogSnapshot; savedAt: number } | null> {
  const db = await openDb();
  const entry = await new Promise<StoredSnapshot | undefined>((resolve, reject) => {
    const request = db
      .transaction(STORE_NAME, 'readonly')
      .objectStore(STORE_NAME)
      .get(keyFor(genome));
    request.onsuccess = () => resolve(request.result as StoredSnapshot | undefined);
    request.onerror = () => reject(request.error ?? new Error('Catalog snapshot read failed'));
  });
  if (
    !entry ||
    entry.version !== SNAPSHOT_VERSION ||
    entry.key !== keyFor(genome) ||
    entry.snapshot?.genome !== genome ||
    entry.snapshot.hubUrl !== undefined ||
    !Array.isArray(entry.snapshot.tracks) ||
    !Number.isFinite(entry.savedAt) ||
    entry.savedAt > Date.now() ||
    Date.now() - entry.savedAt > MAX_SNAPSHOT_AGE_MS
  ) {
    return null;
  }
  return { snapshot: entry.snapshot, savedAt: entry.savedAt };
}

export async function writeHostedUcscCatalogSnapshot(
  snapshot: UcscCatalogSnapshot,
  savedAt = Date.now()
): Promise<void> {
  if (snapshot.hubUrl !== undefined) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put({
      key: keyFor(snapshot.genome),
      version: SNAPSHOT_VERSION,
      savedAt,
      snapshot,
    } satisfies StoredSnapshot);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('Catalog snapshot write failed'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('Catalog snapshot write aborted'));
  });
}

export function resetHostedUcscCatalogSnapshotDbForTests(): void {
  void dbPromise?.then((db) => db.close()).catch(() => undefined);
  dbPromise = null;
}
