export function deleteIndexedDbEntryIfUnchanged(
  database: IDBDatabase,
  storeName: string,
  key: string,
  serialized: string
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName),
      read = store.get(key);
    let removed = false;
    read.onsuccess = () => {
      if (read.result === undefined) {
        removed = true;
        return;
      }
      if (JSON.stringify(read.result) !== serialized) return;
      store.delete(key);
      removed = true;
    };
    transaction.oncomplete = () => resolve(removed);
    transaction.onerror = () => reject(transaction.error ?? new Error('Recovery cleanup failed.'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('Recovery cleanup was aborted.'));
  });
}
