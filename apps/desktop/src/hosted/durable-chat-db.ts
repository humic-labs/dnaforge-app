import { createHostedMemoryDb, type HostedMemoryDbSnapshot } from './memory-db';

const CHAT_TABLES = new Set([
  'conversations',
  'messages',
  'chat_turns',
  'entity_references',
  'entity_reference_revisions',
  'message_references',
  'message_attachments',
]);

export function isHostedChatSql(sql: string): boolean {
  const table = /\b(?:FROM|INTO|UPDATE|TABLE(?:\s+IF\s+NOT\s+EXISTS)?)\s+["`]?([a-z_]+)/iu.exec(
    sql
  );
  return Boolean(table && CHAT_TABLES.has(table[1].toLowerCase()));
}

type MemoryDb = ReturnType<typeof createHostedMemoryDb>;
type ChatDb = Pick<
  MemoryDb,
  | 'execute'
  | 'select'
  | 'createChatTurnWithUserMessage'
  | 'commitChatTurnTerminalState'
  | 'createEntityReference'
  | 'updateEntityReference'
  | 'deleteEntityReference'
  | 'setEntityReferenceWorkspaceRootPathIfMissing'
  | 'recordEntityReferenceRevision'
> & {
  deleteConversation(id: string): Promise<void>;
  deleteMessage(id: string): Promise<void>;
};
interface StoredChat {
  version: 1;
  state: HostedMemoryDbSnapshot;
}

function assertConversationOwners(snapshot: HostedMemoryDbSnapshot): void {
  const tables = new Map(snapshot.tables);
  const conversations = new Set<unknown>((tables.get('conversations') ?? []).map((row) => row.id));
  for (const table of ['messages', 'chat_turns']) {
    for (const row of tables.get(table) ?? []) {
      if (!conversations.has(row.conversation_id)) {
        throw new Error('The conversation does not belong to the current account.');
      }
    }
  }
}

export function createHostedDurableChatDb(options: {
  getAccountId: () => string | null;
  factory?: IDBFactory | null;
  name?: string;
}): ChatDb {
  const factory = options.factory === undefined ? globalThis.indexedDB : options.factory;
  let opened: Promise<IDBDatabase> | null = null;

  function open(): Promise<IDBDatabase> {
    if (!factory) return Promise.reject(new Error('Durable browser chat storage is unavailable.'));
    opened ??= new Promise((resolve, reject) => {
      const request = factory.open(options.name ?? 'dnaforge-hosted-chat-v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('accounts');
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          opened = null;
        };
        resolve(db);
      };
      request.onerror = () => {
        opened = null;
        reject(request.error);
      };
      request.onblocked = () =>
        reject(new Error('Browser chat storage is blocked by another tab.'));
    });
    return opened;
  }

  async function run<T>(write: boolean, work: (db: MemoryDb) => Promise<T>): Promise<T> {
    const accountId = options.getAccountId();
    if (!accountId) {
      if (write) throw new Error('Sign in before saving a browser conversation.');
      return work(createHostedMemoryDb());
    }
    const assertAccount = () => {
      if (options.getAccountId() !== accountId)
        throw new Error('The account changed while accessing browser chat storage.');
    };
    const db = await open();
    assertAccount();
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction('accounts', write ? 'readwrite' : 'readonly', {
        durability: 'strict',
      });
      const store = transaction.objectStore('accounts');
      const request = store.get(accountId);
      let result: T;
      let failure: unknown;
      request.onsuccess = () => {
        void (async () => {
          assertAccount();
          const saved = request.result as StoredChat | undefined;
          if (
            saved &&
            (saved.version !== 1 ||
              !Array.isArray(saved.state?.tables) ||
              !Array.isArray(saved.state.autoincrement))
          ) {
            throw new Error('Saved browser chat storage has an unsupported format.');
          }
          const memory = createHostedMemoryDb(saved?.state);
          result = await work(memory);
          assertAccount();
          if (write) {
            const snapshot = memory.snapshot();
            assertConversationOwners(snapshot);
            store.put({ version: 1, state: snapshot } satisfies StoredChat, accountId);
          }
        })().catch((error: unknown) => {
          failure = error;
          transaction.abort();
        });
      };
      transaction.oncomplete = () => {
        try {
          assertAccount();
          resolve(result!);
        } catch (error) {
          reject(error);
        }
      };
      transaction.onabort = () =>
        reject(failure ?? transaction.error ?? new Error('Browser chat save was interrupted.'));
      transaction.onerror = () => reject(transaction.error);
    });
  }

  return {
    createEntityReference: (row) => run(true, (db) => db.createEntityReference(row)),
    updateEntityReference: (id, updates) =>
      run(true, (db) => db.updateEntityReference(id, updates)),
    deleteEntityReference: (id) => run(true, (db) => db.deleteEntityReference(id)),
    setEntityReferenceWorkspaceRootPathIfMissing: (id, root) =>
      run(true, (db) => db.setEntityReferenceWorkspaceRootPathIfMissing(id, root)),
    recordEntityReferenceRevision: (input) =>
      run(true, (db) => db.recordEntityReferenceRevision(input)),
    execute: (sql, params) => run(true, (db) => db.execute(sql, params)),
    select: <T>(sql: string, params?: Parameters<MemoryDb['execute']>[1]) =>
      run(false, (db) => db.select<T>(sql, params)),
    createChatTurnWithUserMessage: (input) =>
      run(true, (db) => db.createChatTurnWithUserMessage(input)),
    commitChatTurnTerminalState: (input) =>
      run(true, (db) => db.commitChatTurnTerminalState(input)),
    deleteMessage: (id) =>
      run(true, async (db) => {
        if (!id.trim()) throw new Error('Message id is required.');
        await db.execute('DELETE FROM message_references WHERE message_id = ?', [id]);
        await db.execute('DELETE FROM message_attachments WHERE message_id = ?', [id]);
        await db.execute('DELETE FROM messages WHERE id = ?', [id]);
      }),
    deleteConversation: (id) =>
      run(true, async (db) => {
        if (!id.trim()) throw new Error('Conversation id is required.');
        const messages = await db.select<Array<{ id: string }>>(
          'SELECT id FROM messages WHERE conversation_id = ?',
          [id]
        );
        for (const message of messages) {
          await db.execute('DELETE FROM message_references WHERE message_id = ?', [message.id]);
          await db.execute('DELETE FROM message_attachments WHERE message_id = ?', [message.id]);
        }
        await db.execute('DELETE FROM messages WHERE conversation_id = ?', [id]);
        await db.execute('DELETE FROM chat_turns WHERE conversation_id = ?', [id]);
        await db.execute('DELETE FROM conversations WHERE id = ?', [id]);
      }),
  };
}
