import { userMessageWithValues, userMessageValue } from '@waypoint/user-messages';
import { isDesktopRuntime } from '../../utils/environment';
import { sequenceLegacyBaselineFingerprint } from '../../shared/sequence-document';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';
import { useToastStore } from '../../stores/toast-store';
import { useCanvasStore } from '../canvas/public/store';
import { useSequenceStore, type RecoveredDraftContent } from './store';
import { deleteIndexedDbEntryIfUnchanged } from '../../shared/indexed-db-compare-delete';

const DB_NAME = 'dnaforge-unsaved-recovery';
const STORE_NAME = 'sequence-drafts';
const DB_VERSION = 1;
const ENTRY_VERSION = 1;

const WRITE_DELAY_MS = 1000;

const MAX_ENTRY_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const MAX_JOURNALED_BASES = 20_000_000;

export const UNSAVED_SEQUENCE_SESSION_ID = globalThis.crypto.randomUUID();
const SESSION_ID = UNSAVED_SEQUENCE_SESSION_ID;

export interface UnsavedSequenceEntry {
  documentId: string;
  version: number;
  sessionId: string;
  savedAt: number;
  name: string;

  baseline: string;
  content: RecoveredDraftContent;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB unavailable'));
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'documentId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Recovery database failed'));
    request.onblocked = () => reject(new Error('Recovery database is blocked'));
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
    transaction.onerror = () => reject(transaction.error ?? new Error('Recovery database failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Recovery write aborted'));
  });
}

export function readUnsavedSequenceEntry(
  documentId: string
): Promise<UnsavedSequenceEntry | undefined> {
  return run('readonly', (store) => store.get(documentId) as IDBRequest<UnsavedSequenceEntry>);
}

export async function writeUnsavedSequenceEntry(entry: UnsavedSequenceEntry): Promise<void> {
  await run('readwrite', (store) => store.put(entry));
}

export async function deleteAllUnsavedSequenceEntries(): Promise<void> {
  await run('readwrite', (store) => store.clear());
}

export function readAllUnsavedSequenceEntries(): Promise<UnsavedSequenceEntry[]> {
  return run('readonly', (store) => store.getAll() as IDBRequest<UnsavedSequenceEntry[]>);
}

export async function deleteUnsavedSequenceEntry(documentId: string): Promise<void> {
  await run('readwrite', (store) => store.delete(documentId));
}
export async function deleteUnsavedSequenceEntryIfUnchanged(
  documentId: string,
  serialized: string
): Promise<boolean> {
  return deleteIndexedDbEntryIfUnchanged(await openDb(), STORE_NAME, documentId, serialized);
}

export const baselineFingerprint = sequenceLegacyBaselineFingerprint;

function entryFor(documentId: string): UnsavedSequenceEntry | null {
  const state = useSequenceStore.getState();
  const draft = state.drafts[documentId];
  const saved = state.savedSequences[documentId];
  if (!draft || !saved || state.dirtyPaths[documentId] !== true) return null;
  if (draft.sequence.length > MAX_JOURNALED_BASES) return null;
  return {
    documentId,
    version: ENTRY_VERSION,
    sessionId: SESSION_ID,
    savedAt: Date.now(),
    name: displayName(documentId, saved),
    baseline: baselineFingerprint(saved),
    content: {
      sequence: draft.sequence,
      annotations: draft.annotations,
      insertedRanges: draft.insertedRanges,
      deletedRanges: draft.deletedRanges,
      substitutedRanges: draft.substitutedRanges,
      pendingPrimerBindings: draft.pendingPrimerBindings,
      draftLineageId: state.draftLineages[documentId]?.id,
    },
  };
}

function displayName(documentId: string, saved: AnnotatedSequence): string {
  for (const panel of Object.values(useCanvasStore.getState().panels)) {
    const tab = panel.tabs.find((candidate) => candidate.entityId === documentId);
    if (tab?.label) return tab.label;
  }
  return saved.name || 'A sequence';
}

function logFailure(action: string) {
  return (error: unknown) => console.warn(`[UnsavedSequenceRecovery] ${action} failed:`, error);
}

export function startUnsavedSequenceRecovery(): () => void {
  if (isDesktopRuntime()) return () => {};
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const offered = new Set<string>();

  const schedule = (documentId: string) => {
    clearTimeout(timers.get(documentId));
    timers.set(
      documentId,
      setTimeout(() => {
        timers.delete(documentId);
        const entry = entryFor(documentId);
        if (entry) void writeUnsavedSequenceEntry(entry).catch(logFailure('write'));
      }, WRITE_DELAY_MS)
    );
  };

  const forget = (documentId: string) => {
    clearTimeout(timers.get(documentId));
    timers.delete(documentId);
    void deleteUnsavedSequenceEntry(documentId).catch(logFailure('delete'));
  };

  const unsubscribe = useSequenceStore.subscribe((state, prev) => {
    if (state.drafts !== prev.drafts || state.dirtyPaths !== prev.dirtyPaths) {
      for (const documentId of Object.keys(state.dirtyPaths)) {
        if (
          state.drafts[documentId] !== prev.drafts[documentId] ||
          prev.dirtyPaths[documentId] !== true
        ) {
          schedule(documentId);
        }
      }

      for (const documentId of Object.keys(prev.dirtyPaths)) {
        if (state.dirtyPaths[documentId] !== true) forget(documentId);
      }
    }
    if (state.savedSequences !== prev.savedSequences) {
      for (const documentId of Object.keys(state.savedSequences)) {
        if (prev.savedSequences[documentId] || offered.has(documentId)) continue;
        offered.add(documentId);
        void offerRecovery(documentId).catch(logFailure('read'));
      }
    }
  });

  return () => {
    unsubscribe();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };
}

async function offerRecovery(documentId: string): Promise<void> {
  const entry = await readUnsavedSequenceEntry(documentId);
  if (!entry || entry.sessionId === SESSION_ID) return;
  if (entry.version !== ENTRY_VERSION || Date.now() - entry.savedAt > MAX_ENTRY_AGE_MS) {
    await deleteUnsavedSequenceEntry(documentId);
    return;
  }
  const state = useSequenceStore.getState();
  const saved = state.savedSequences[documentId];

  if (!saved || state.dirtyPaths[documentId] === true) return;

  const toast = useToastStore.getState();
  if (baselineFingerprint(saved) !== entry.baseline) {
    await deleteUnsavedSequenceEntry(documentId);
    toast.addRichToast({
      definition: 'unsaved-sequence-recovery-outdated',
      message: userMessageWithValues(
        'notice.unsaved-changes-to-value-from-a-window-that-closed-unexpectedly-can-t-',
        { value0: userMessageValue(entry.name) }
      ),
    });
    return;
  }

  toast.addRichToast({
    definition: 'unsaved-sequence-recovery-available',
    message: userMessageWithValues(
      'notice.value-has-unsaved-changes-from-a-window-that-closed-unexpectedly',
      { value0: userMessageValue(entry.name) }
    ),
    actions: [
      {
        label: 'Restore',
        onClick: () => {
          const restored = useSequenceStore
            .getState()
            .restoreRecoveredDraft(documentId, entry.content);
          if (!restored) void deleteUnsavedSequenceEntry(documentId);
        },
      },
      {
        label: 'Discard',
        onClick: () => deleteUnsavedSequenceEntry(documentId),
      },
    ],
  });
}
