const DB_NAME = 'waypoint-structure-cache';
const DB_VERSION = 1;
const STORE_NAME = 'structures';

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface CachedStructure {
  kind?: 'structure';
  key: string;
  data: string;
  format: 'mmcif' | 'pdb';
  cachedAt: number;
}

interface CachedStructureAlias {
  kind: 'alias';
  key: string;
  targetKey: string;
  cachedAt: number;
}

type CachedStructureEntry = CachedStructure | CachedStructureAlias;

let dbPromise: Promise<IDBDatabase> | null = null;

export function _resetDBForTesting(): void {
  dbPromise = null;
}

export async function _clearAllForTesting(): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.clear();

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  } catch {}
}

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !window.indexedDB) {
      reject(new Error('IndexedDB not available'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      console.error('[structureDataCache] Failed to open database:', request.error);
      reject(request.error);
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        store.createIndex('cachedAt', 'cachedAt', { unique: false });
      }
    };
  });

  return dbPromise;
}

export async function getCachedStructure(
  key: string
): Promise<{ data: string; format: 'mmcif' | 'pdb' } | null> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(key);

      request.onerror = () => {
        console.error('[structureDataCache] Failed to get:', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        const cached = request.result as CachedStructureEntry | undefined;

        if (!cached) {
          resolve(null);
          return;
        }

        if (isExpired(cached)) {
          deleteStructure(key).catch(() => {});
          resolve(null);
          return;
        }

        if (isCachedStructureAlias(cached)) {
          if (cached.targetKey === key) {
            deleteStructure(key).catch(() => {});
            resolve(null);
            return;
          }
          getCachedStructure(cached.targetKey).then(resolve).catch(reject);
          return;
        }

        resolve({ data: cached.data, format: cached.format });
      };
    });
  } catch (err) {
    console.error('[structureDataCache] Error getting cached structure:', err);
    return null;
  }
}

export async function getCachedStructureAlias(key: string): Promise<string | null> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(key);

      request.onerror = () => {
        console.error('[structureDataCache] Failed to get alias:', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        const cached = request.result as CachedStructureEntry | undefined;
        if (!cached || !isCachedStructureAlias(cached)) {
          resolve(null);
          return;
        }
        if (isExpired(cached) || cached.targetKey === key) {
          deleteStructure(key).catch(() => {});
          resolve(null);
          return;
        }
        resolve(cached.targetKey);
      };
    });
  } catch (err) {
    console.error('[structureDataCache] Error getting cached alias:', err);
    return null;
  }
}

export async function cacheStructure(
  key: string,
  data: string,
  format: 'mmcif' | 'pdb'
): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);

      const entry: CachedStructure = {
        kind: 'structure',
        key,
        data,
        format,
        cachedAt: Date.now(),
      };

      const request = store.put(entry);

      request.onerror = () => {
        console.error('[structureDataCache] Failed to cache:', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        console.log(`[structureDataCache] Cached structure: ${key}`);
        resolve();
      };
    });
  } catch (err) {
    console.error('[structureDataCache] Error caching structure:', err);
  }
}

export async function cacheStructureAlias(key: string, targetKey: string): Promise<void> {
  if (key === targetKey) return;
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const entry: CachedStructureAlias = {
        kind: 'alias',
        key,
        targetKey,
        cachedAt: Date.now(),
      };
      const request = store.put(entry);

      request.onerror = () => {
        console.error('[structureDataCache] Failed to cache alias:', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        console.log(`[structureDataCache] Cached alias: ${key} -> ${targetKey}`);
        resolve();
      };
    });
  } catch (err) {
    console.error('[structureDataCache] Error caching alias:', err);
  }
}

function isCachedStructureAlias(entry: CachedStructureEntry): entry is CachedStructureAlias {
  return entry.kind === 'alias' || 'targetKey' in entry;
}

function isExpired(entry: CachedStructureEntry): boolean {
  return Date.now() - entry.cachedAt > CACHE_TTL_MS;
}

async function deleteStructure(key: string): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.delete(key);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  } catch (err) {
    console.error('[structureDataCache] Error deleting structure:', err);
  }
}

export async function clearExpiredStructures(): Promise<void> {
  try {
    const db = await openDB();
    const now = Date.now();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const index = store.index('cachedAt');
      const range = IDBKeyRange.upperBound(now - CACHE_TTL_MS);
      const request = index.openCursor(range);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        } else {
          resolve();
        }
      };
    });
  } catch (err) {
    console.error('[structureDataCache] Error clearing expired structures:', err);
  }
}

export async function getCachedKeys(): Promise<string[]> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAllKeys();

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        resolve(request.result as string[]);
      };
    });
  } catch (err) {
    console.error('[structureDataCache] Error getting keys:', err);
    return [];
  }
}

import { shouldEnableTestBridge } from '../../../../../lib/test-bridge-gate';

type StructureDataCacheWindow = Window & {
  __structureDataCache?: {
    getCachedKeys: typeof getCachedKeys;
    getCachedStructure: typeof getCachedStructure;
    clearExpiredStructures: typeof clearExpiredStructures;
  };
};

if (typeof window !== 'undefined' && shouldEnableTestBridge(import.meta.env)) {
  (window as StructureDataCacheWindow).__structureDataCache = {
    getCachedKeys,
    getCachedStructure,
    clearExpiredStructures,
  };
}
