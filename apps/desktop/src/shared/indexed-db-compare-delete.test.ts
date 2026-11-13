import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { deleteIndexedDbEntryIfUnchanged } from './indexed-db-compare-delete';

async function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(`compare-delete-${crypto.randomUUID()}`, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts', { keyPath: 'key' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function put(db: IDBDatabase, entry: unknown) {
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('drafts', 'readwrite');
    transaction.objectStore('drafts').put(entry);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}
async function keys(db: IDBDatabase) {
  return new Promise<IDBValidKey[]>((resolve, reject) => {
    const transaction = db.transaction('drafts', 'readonly'),
      request = transaction.objectStore('drafts').getAllKeys();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
describe('recovery store compare-and-delete', () => {
  it('removes only an exact captured entry and preserves another record', async () => {
    const db = await database(),
      entry = { key: 'captured', sessionId: 'current', payload: 'original' };
    try {
      await put(db, entry);
      await put(db, { key: 'unrelated', payload: 'preserve' });
      expect(
        await deleteIndexedDbEntryIfUnchanged(db, 'drafts', 'captured', JSON.stringify(entry))
      ).toBe(true);
      expect(await keys(db)).toEqual(['unrelated']);
    } finally {
      db.close();
    }
  });
  it('rejects a concurrently replaced entry inside the real store transaction', async () => {
    const db = await database(),
      entry = { key: 'captured', sessionId: 'current', payload: 'original' };
    try {
      await put(db, { ...entry, payload: 'newer' });
      expect(
        await deleteIndexedDbEntryIfUnchanged(db, 'drafts', 'captured', JSON.stringify(entry))
      ).toBe(false);
      expect(await keys(db)).toEqual(['captured']);
    } finally {
      db.close();
    }
  });
});
