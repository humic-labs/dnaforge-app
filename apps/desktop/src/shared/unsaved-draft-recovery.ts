import { userMessageWithValues, userMessageValue } from '@waypoint/user-messages';
import { useCallback, useEffect, useRef } from 'react';
import { useToastStore } from '../stores/toast-store';
import { saveDocumentTargetId, type SaveDocumentTarget } from './save-document-events';
import { deleteIndexedDbEntryIfUnchanged } from './indexed-db-compare-delete';

const DB_NAME = 'dnaforge-unsaved-drafts';
const STORE_NAME = 'drafts';
const DB_VERSION = 1;
const ENTRY_VERSION = 1;

const WRITE_DELAY_MS = 300;
const MAX_ENTRY_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export const UNSAVED_DRAFT_SESSION_ID = globalThis.crypto.randomUUID();
const SESSION_ID = UNSAVED_DRAFT_SESSION_ID;
const pendingDraftWrites = new Map<string, () => Promise<void>>();
export async function flushPendingUnsavedDraftWrites(keys: readonly string[]): Promise<void> {
  const results = await Promise.allSettled(
    [...new Set(keys)].map((key) => pendingDraftWrites.get(key)?.())
  );
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  );
  if (failures.length)
    throw Object.assign(new Error('Some pending recovery writes could not be settled.'), {
      name: 'AggregateError',
      errors: failures,
    });
}

interface DraftEntry<T> {
  key: string;
  version: number;
  sessionId: string;
  savedAt: number;
  name: string;
  baseline: string;
  payload: T;
}

let dbPromise: Promise<IDBDatabase> | null = null;

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
    request.onerror = () => reject(request.error ?? new Error('Draft database failed'));
    request.onblocked = () => reject(new Error('Draft database is blocked'));
  });
  const tracked = pending.catch((error: unknown) => {
    if (dbPromise === tracked) dbPromise = null;
    throw error;
  });
  dbPromise = tracked;
  return tracked;
}

async function run<T>(
  mode: IDBTransactionMode,
  operate: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode);
    const request = operate(transaction.objectStore(STORE_NAME));
    let result: T;
    request.onsuccess = () => {
      result = request.result;
    };
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error ?? new Error('Draft database failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Draft write aborted'));
  });
}

export function readUnsavedDraft<T>(key: string): Promise<DraftEntry<T> | undefined> {
  return run('readonly', (store) => store.get(key) as IDBRequest<DraftEntry<T>>);
}

async function writeUnsavedDraft<T>(entry: DraftEntry<T>): Promise<void> {
  await run('readwrite', (store) => store.put(entry));
}

export async function deleteUnsavedDraft(key: string): Promise<void> {
  await run('readwrite', (store) => store.delete(key));
}
export async function deleteUnsavedDraftIfUnchanged(
  key: string,
  serialized: string
): Promise<boolean> {
  return deleteIndexedDbEntryIfUnchanged(await openDb(), STORE_NAME, key, serialized);
}

export async function deleteAllUnsavedDrafts(): Promise<void> {
  await run('readwrite', (store) => store.clear());
}

export async function readAllUnsavedDrafts(): Promise<Array<DraftEntry<unknown>>> {
  return run('readonly', (store) => store.getAll() as IDBRequest<Array<DraftEntry<unknown>>>);
}

export const NEW_DOCUMENT_BASELINE = 'new';

export interface NewDraftPayload {
  tabType: 'protein' | 'primer';
  label: string;
  artifactDocument: import('../features/canvas/types').ArtifactDocumentContext;
  fields: Record<string, string>;
}

export async function offerUnsavedNewDrafts(
  reopen: (draft: NewDraftPayload) => void
): Promise<void> {
  const entries = await readAllUnsavedDrafts();
  for (const entry of entries) {
    if (!entry.key.startsWith('new:') || entry.sessionId === SESSION_ID) continue;
    if (entry.version !== ENTRY_VERSION || Date.now() - entry.savedAt > MAX_ENTRY_AGE_MS) {
      await deleteUnsavedDraftIfUnchanged(entry.key, JSON.stringify(entry));
      continue;
    }
    const draft = entry.payload as NewDraftPayload;
    useToastStore.getState().addRichToast({
      definition: 'unsaved-new-draft-recovery-available',
      message: userMessageWithValues(
        'notice.unsaved-new-value-value-from-a-window-that-closed-unexpectedly',
        { value0: userMessageValue(draft.tabType), value1: userMessageValue(draft.label) }
      ),
      actions: [
        {
          label: 'Reopen',
          onClick: () => {
            reopen(draft);
            return deleteUnsavedDraftIfUnchanged(entry.key, JSON.stringify(entry));
          },
        },
        {
          label: 'Discard',
          onClick: () => deleteUnsavedDraftIfUnchanged(entry.key, JSON.stringify(entry)),
        },
      ],
    });
  }
}

export function fingerprintText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length}:${(hash >>> 0).toString(16)}`;
}

function logFailure(action: string) {
  return (error: unknown) => console.warn(`[UnsavedDraftRecovery] ${action} failed:`, error);
}

export interface UnsavedDraftRecoveryOptions<T> {
  key: string | null;

  name: string;

  baseline: string | null;
  dirty: boolean;

  payload?: T;

  onRestore: (payload: T) => void;

  discardTarget?: SaveDocumentTarget;
}

export function useUnsavedDraftRecovery<T>({
  key,
  name,
  baseline,
  dirty,
  payload,
  onRestore,
  discardTarget,
}: UnsavedDraftRecoveryOptions<T>): {
  completePublishedDraft: () => Promise<boolean>;
  recordDraft: (payload: T) => void;
  flushDraft: (snapshot: { baseline: string; payload: T } | null) => Promise<void>;
} {
  const onRestoreRef = useRef(onRestore);
  onRestoreRef.current = onRestore;
  const dirtyRef = useRef(dirty);
  const dirtyDocumentKey = useRef<string | null>(null);
  const offerOwner = useRef<{ phase: 'reading' | 'offered' | 'completed' | 'retired' } | null>(
    null
  );
  const offerScope = useRef({ key, baseline });
  offerScope.current = { key, baseline };
  dirtyRef.current = dirty;

  useEffect(() => {
    if (!key || baseline === null) return;
    const owner: NonNullable<typeof offerOwner.current> = { phase: 'reading' };
    offerOwner.current = owner;
    const current = () =>
      offerOwner.current === owner &&
      owner.phase !== 'retired' &&
      offerScope.current.key === key &&
      offerScope.current.baseline === baseline;
    void (async () => {
      const entry = await readUnsavedDraft<T>(key);
      if (!current() || !entry || entry.sessionId === SESSION_ID || dirtyRef.current) return;
      if (entry.version !== ENTRY_VERSION || Date.now() - entry.savedAt > MAX_ENTRY_AGE_MS) {
        await deleteUnsavedDraftIfUnchanged(key, JSON.stringify(entry));
        return;
      }
      const toast = useToastStore.getState();
      if (entry.baseline !== baseline) {
        await deleteUnsavedDraftIfUnchanged(key, JSON.stringify(entry));
        if (!current()) return;
        owner.phase = 'completed';
        toast.addRichToast({
          definition: 'unsaved-draft-recovery-outdated',
          message: userMessageWithValues(
            'notice.unsaved-changes-to-value-from-a-window-that-closed-unexpectedly-can-t-',
            { value0: userMessageValue(entry.name) }
          ),
        });
        return;
      }
      owner.phase = 'offered';
      toast.addRichToast({
        definition: 'unsaved-draft-recovery-available',
        message: userMessageWithValues(
          'notice.value-has-unsaved-changes-from-a-window-that-closed-unexpectedly',
          { value0: userMessageValue(entry.name) }
        ),
        actions: [
          {
            label: 'Restore',
            onClick: () => {
              if (!current() || owner.phase !== 'offered' || dirtyRef.current) return;
              owner.phase = 'completed';
              onRestoreRef.current(entry.payload);
            },
          },
          {
            label: 'Discard',
            onClick: async () => {
              if (!current() || owner.phase !== 'offered' || dirtyRef.current) return;
              owner.phase = 'completed';
              await deleteUnsavedDraftIfUnchanged(key, JSON.stringify(entry));
            },
          },
        ],
      });
    })().catch(logFailure('read'));
    return () => {
      owner.phase = 'retired';
      if (offerOwner.current === owner) offerOwner.current = null;
    };
  }, [baseline, key]);

  const writeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingWriteRef = useRef<{ key: string; flush: () => Promise<void> } | null>(null);
  const cancelPendingWrite = useCallback(() => {
    clearTimeout(writeTimerRef.current);
    const pending = pendingWriteRef.current;
    if (pending && pendingDraftWrites.get(pending.key) === pending.flush)
      pendingDraftWrites.delete(pending.key);
    pendingWriteRef.current = null;
  }, []);
  const flushDraft = useCallback(
    async (snapshot: { baseline: string; payload: T } | null) => {
      cancelPendingWrite();
      if (!key) return;
      if (snapshot === null) {
        await deleteUnsavedDraft(key).catch(logFailure('delete'));
        return;
      }
      await writeUnsavedDraft<T>({
        key,
        version: ENTRY_VERSION,
        sessionId: SESSION_ID,
        savedAt: Date.now(),
        name,
        ...snapshot,
      }).catch(logFailure('write'));
    },
    [key, name, cancelPendingWrite]
  );
  const contextRef = useRef({ key, name, baseline, payload });
  contextRef.current = { key, name, baseline, payload };

  const scheduleWrite = (draft: T) => {
    cancelPendingWrite();
    const context = contextRef.current;
    if (!context.key || context.baseline === null) return;
    const key = context.key;
    let writing: Promise<void> | undefined;
    const flush = () => {
      if (writing) return writing;
      clearTimeout(writeTimerRef.current);
      writing = writeUnsavedDraft<T>({
        key,
        version: ENTRY_VERSION,
        sessionId: SESSION_ID,
        savedAt: Date.now(),
        name: context.name,
        baseline: context.baseline!,
        payload: draft,
      }).finally(() => {
        if (pendingDraftWrites.get(key) === flush) pendingDraftWrites.delete(key);
        if (pendingWriteRef.current?.flush === flush) pendingWriteRef.current = null;
      });
      return writing;
    };
    pendingDraftWrites.set(key, flush);
    pendingWriteRef.current = { key, flush };
    writeTimerRef.current = setTimeout(() => {
      void flush().catch(logFailure('write'));
    }, WRITE_DELAY_MS);
  };
  const scheduleWriteRef = useRef(scheduleWrite);
  scheduleWriteRef.current = scheduleWrite;

  useEffect(() => {
    dirtyRef.current = dirty;
    if (!key || baseline === null) return;
    if (!dirty) {
      cancelPendingWrite();
      if (dirtyDocumentKey.current === key)
        void deleteUnsavedDraft(key).catch(logFailure('delete'));
      dirtyDocumentKey.current = null;
      return;
    }
    dirtyDocumentKey.current = key;
    if (payload !== undefined) scheduleWriteRef.current(payload);
  }, [baseline, dirty, key, payload, cancelPendingWrite]);

  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancelPendingWrite();
    };
  }, [cancelPendingWrite]);

  const discardId = discardTarget ? saveDocumentTargetId(discardTarget) : null;
  const discardKind = discardTarget?.kind;
  useEffect(() => {
    if (!key || !discardId) return;
    const handler = (event: WindowEventMap['document-discarded']) => {
      if (event.detail.kind === discardKind && saveDocumentTargetId(event.detail) === discardId) {
        cancelPendingWrite();
        void deleteUnsavedDraft(key).catch(logFailure('delete'));
      }
    };
    window.addEventListener('document-discarded', handler);
    return () => window.removeEventListener('document-discarded', handler);
  }, [discardId, discardKind, key, cancelPendingWrite]);

  const recordDraft = useRef((draft: T) => {
    dirtyDocumentKey.current = contextRef.current.key;
    scheduleWriteRef.current(draft);
  }).current;
  const completePublishedDraft = async (): Promise<boolean> => {
    if (!key || payload === undefined) return false;
    const published = JSON.stringify(payload);
    const stillCurrent = () =>
      mounted.current &&
      contextRef.current.key === key &&
      JSON.stringify(contextRef.current.payload) === published;
    if (!stillCurrent()) return false;
    try {
      await flushPendingUnsavedDraftWrites([key]);
      const entry = await readUnsavedDraft<T>(key);
      if (
        entry?.sessionId === SESSION_ID &&
        entry.baseline === baseline &&
        JSON.stringify(entry.payload) === published &&
        stillCurrent()
      )
        await deleteUnsavedDraftIfUnchanged(key, JSON.stringify(entry));
    } catch (error) {
      logFailure('retire published draft')(error);
    }
    return stillCurrent();
  };
  return { recordDraft, flushDraft, completePublishedDraft };
}
