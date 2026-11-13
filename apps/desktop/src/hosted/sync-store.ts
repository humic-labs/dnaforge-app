import type {
  WorkspaceSessionFileWrite,
  WorkspaceSessionIndex,
  WorkspaceSessionSnapshot,
} from '@waypoint/domain-services';

export interface HostedPendingWrite extends WorkspaceSessionFileWrite {
  readonly contentSha256: string;
}

export type HostedRetryReason = 'offline' | 'server-retrying' | 'connection-unavailable';

export interface HostedPendingOperation {
  readonly id: string;
  readonly createdAt: string;
  readonly base: WorkspaceSessionSnapshot;
  readonly writes: readonly HostedPendingWrite[];
  readonly removePaths: readonly string[];
  readonly state: 'queued' | 'sending' | 'conflict' | 'blocked';
  readonly error?: string;
  readonly retryReason?: HostedRetryReason;
  readonly recoveryIntentId?: string;
  readonly recovery?: {
    readonly id: string;
    readonly expiresAt: string;
    readonly coverage: 'captured-bytes' | 'incomplete';
  };
}

export interface HostedSyncRecord {
  readonly accountId: string;
  readonly workspaceId: string;
  readonly accepted: WorkspaceSessionSnapshot;
  readonly operations: readonly HostedPendingOperation[];
  readonly acknowledgements?: Readonly<Record<string, WorkspaceSessionSnapshot>>;
  readonly supersessions?: Readonly<Record<string, string>>;
}

export class HostedSyncStore {
  private database: Promise<IDBDatabase> | null = null;

  constructor(
    private readonly name = 'dnaforge-hosted-sync-v1',
    private readonly factory: IDBFactory | undefined = globalThis.indexedDB
  ) {}

  private open(): Promise<IDBDatabase> {
    if (!this.factory)
      return Promise.reject(
        new Error('Durable browser storage is unavailable. This draft has not been saved.')
      );
    this.database ??= new Promise((resolve, reject) => {
      const request = this.factory!.open(this.name, 1);
      request.onupgradeneeded = () => {
        for (const store of ['metadata', 'workspaces', 'bytes'])
          request.result.createObjectStore(store);
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          this.database = null;
        };
        resolve(db);
      };
      request.onerror = () => {
        this.database = null;
        reject(request.error);
      };
      request.onblocked = () =>
        reject(new Error('Browser storage upgrade is blocked by another DNAForge tab.'));
    });
    return this.database;
  }

  private async read<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(store, 'readonly');
      const request = transaction.objectStore(store).get(key);
      request.onsuccess = () => resolve(request.result as T | undefined);
      request.onerror = () => reject(request.error);
    });
  }

  private async put(
    store: string,
    key: IDBValidKey,
    value: unknown,
    canWrite?: () => boolean
  ): Promise<void> {
    const db = await this.open();
    if (canWrite && !canWrite())
      throw new Error('The account changed before browser storage could save its selection.');
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(store, 'readwrite', { durability: 'strict' });
      transaction.objectStore(store).put(value, key);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () =>
        reject(transaction.error ?? new Error('Browser storage write was interrupted.'));
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async saveIndex(index: WorkspaceSessionIndex, canWrite?: () => boolean): Promise<void> {
    if (!index.principal) throw new Error('Hosted index has no account identity.');
    await this.put('metadata', 'index', index, canWrite);
  }

  loadIndex(): Promise<WorkspaceSessionIndex | undefined> {
    return this.read('metadata', 'index');
  }

  async clearAccount(): Promise<void> {
    await this.put('metadata', 'index', null);
  }

  load(accountId: string, workspaceId: string): Promise<HostedSyncRecord | undefined> {
    return this.read('workspaces', [accountId, workspaceId]);
  }

  async update(
    accountId: string,
    workspaceId: string,
    update: (current: HostedSyncRecord | undefined) => HostedSyncRecord
  ): Promise<HostedSyncRecord> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('workspaces', 'readwrite', { durability: 'strict' });
      const store = transaction.objectStore('workspaces');
      const request = store.get([accountId, workspaceId]);
      let result: HostedSyncRecord;
      let failure: unknown;
      request.onsuccess = () => {
        try {
          result = update(request.result as HostedSyncRecord | undefined);
          if (result.accountId !== accountId || result.workspaceId !== workspaceId)
            throw new Error('Browser queue ownership mismatch.');
          store.put(result, [accountId, workspaceId]);
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      };
      transaction.oncomplete = () => resolve(result!);
      transaction.onabort = () =>
        reject(failure ?? transaction.error ?? new Error('Browser save was interrupted.'));
      transaction.onerror = () => reject(transaction.error);
    });
  }

  readBytes(
    accountId: string,
    workspaceId: string,
    revision: string,
    path: string
  ): Promise<Uint8Array | undefined> {
    return this.read('bytes', [accountId, workspaceId, revision, path]);
  }

  saveBytes(
    accountId: string,
    workspaceId: string,
    revision: string,
    path: string,
    bytes: Uint8Array
  ): Promise<void> {
    return this.put('bytes', [accountId, workspaceId, revision, path], bytes);
  }

  async listPending(accountId: string): Promise<HostedSyncRecord[]> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const request = db.transaction('workspaces', 'readonly').objectStore('workspaces').getAll();
      request.onsuccess = () =>
        resolve(
          (request.result as HostedSyncRecord[]).filter(
            (record) => record.accountId === accountId && record.operations.length > 0
          )
        );
      request.onerror = () => reject(request.error);
    });
  }

  async close(): Promise<void> {
    (await this.database)?.close();
    this.database = null;
  }
}
