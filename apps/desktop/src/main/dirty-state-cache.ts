import { handleGroup } from '../shared/ipc-contract';
import { appDirtyStateContract } from '../shared/ipc/app-dirty-state.contract';
import type { DirtyWorkItem, DirtyWorkState } from '../shared/dirty-work-state';
import type { NativeDirtyDocument } from '../shared/native-document-drafts';
import { mergeDirtyWorkState } from '../shared/dirty-work-summary';

export type DirtyState = DirtyWorkState;

let cached: DirtyState = { hasDirtyWork: false, details: '' };
let nativeDocuments: NativeDirtyDocument[] = [];
let nativeInventoryFailure: string | undefined;
let nativeFlushFailure: string | undefined;
let nativeRefreshTail: Promise<void> = Promise.resolve();
let onDirtyStateChanged: (() => void) | undefined;
interface NativeDirtyStateProvider {
  listDirty(): Promise<NativeDirtyDocument[]>;
  subscribe(listener: () => void): () => void;
  flush?(): Promise<void>;
}
let nativeProvider: NativeDirtyStateProvider | undefined;

export function registerNativeDirtyStateProvider(provider: NativeDirtyStateProvider): {
  refresh(): Promise<void>;
  dispose(): void;
} {
  if (nativeProvider && nativeProvider !== provider)
    throw new Error('The native dirty-document provider is already registered.');
  nativeProvider = provider;
  nativeDocuments = [];
  nativeInventoryFailure = 'Native drafts have not yet been inspected.';
  let queued = false;
  const unsubscribe = provider.subscribe(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (nativeProvider === provider) void refreshNativeDirtyState(provider);
    });
  });
  return {
    refresh: () => refreshNativeDirtyState(provider),
    dispose: () => {
      unsubscribe();
      if (nativeProvider === provider) {
        nativeProvider = undefined;
        nativeDocuments = [];
        nativeInventoryFailure = undefined;
        nativeFlushFailure = undefined;
      }
    },
  };
}

function refreshNativeDirtyState(provider: NativeDirtyStateProvider): Promise<void> {
  const run = nativeRefreshTail.then(async () => {
    if (nativeProvider !== provider) return;
    try {
      const documents = await provider.listDirty();
      if (nativeProvider !== provider) return;
      nativeDocuments = documents.map((item) => structuredClone(item));
      nativeInventoryFailure = undefined;
    } catch (error) {
      if (nativeProvider !== provider) return;
      nativeInventoryFailure = error instanceof Error ? error.message : String(error);
    }
    onDirtyStateChanged?.();
  });
  nativeRefreshTail = run.catch(() => {});
  return run;
}

export async function readCurrentDirtyState(): Promise<DirtyState> {
  const provider = nativeProvider;
  if (provider) {
    try {
      await provider.flush?.();
      if (nativeProvider === provider) nativeFlushFailure = undefined;
    } catch (error) {
      if (nativeProvider === provider)
        nativeFlushFailure = error instanceof Error ? error.message : String(error);
    }
    if (nativeProvider === provider) await refreshNativeDirtyState(provider);
  }
  return getDirtyState();
}

export function getDirtyState(): DirtyState {
  const current = nativeProvider
    ? mergeDirtyWorkState(cached, nativeDocuments, nativeInventoryFailure ?? nativeFlushFailure)
    : cached;
  return {
    ...current,
    ...(current.dirtyPageIds ? { dirtyPageIds: [...current.dirtyPageIds] } : {}),
    ...(current.dirtySequenceDocumentIds
      ? { dirtySequenceDocumentIds: [...current.dirtySequenceDocumentIds] }
      : {}),
    ...(current.dirtyTabIds ? { dirtyTabIds: [...current.dirtyTabIds] } : {}),
    ...(current.dirtyFilePaths ? { dirtyFilePaths: [...current.dirtyFilePaths] } : {}),
    ...(current.dirtyItems ? { dirtyItems: current.dirtyItems.map((item) => ({ ...item })) } : {}),
  };
}

export function setDirtyState(state: DirtyState): void {
  const dirtyPageIds = cleanStringList(state.dirtyPageIds);
  const dirtySequenceDocumentIds = cleanStringList(state.dirtySequenceDocumentIds);
  const dirtyTabIds = cleanStringList(state.dirtyTabIds);
  const dirtyFilePaths = cleanStringList(state.dirtyFilePaths);
  cached = {
    hasDirtyWork: Boolean(state.hasDirtyWork),
    details: String(state.details ?? ''),
    ...(dirtyPageIds.length > 0 ? { dirtyPageIds } : {}),
    ...(dirtySequenceDocumentIds.length > 0 ? { dirtySequenceDocumentIds } : {}),
    ...(dirtyTabIds.length > 0 ? { dirtyTabIds } : {}),
    ...(dirtyFilePaths.length > 0 ? { dirtyFilePaths } : {}),
    ...(state.dirtyItems ? { dirtyItems: cleanDirtyItems(state.dirtyItems) } : {}),
  };
}

let disposeDirtyStateHandler: (() => void) | null = null;

export function registerDirtyStateHandler(onChanged?: () => void): void {
  onDirtyStateChanged = onChanged;
  disposeDirtyStateHandler?.();
  disposeDirtyStateHandler = handleGroup(appDirtyStateContract, {
    reportDirtyState: (_event, state: unknown) => {
      if (!state || typeof state !== 'object') return;
      const s = state as Record<string, unknown>;
      setDirtyState({
        hasDirtyWork: Boolean(s.hasDirtyWork),
        details: typeof s.details === 'string' ? s.details : '',
        dirtyPageIds: stringListFromUnknown(s.dirtyPageIds),
        dirtySequenceDocumentIds: stringListFromUnknown(s.dirtySequenceDocumentIds),
        dirtyTabIds: stringListFromUnknown(s.dirtyTabIds),
        dirtyFilePaths: stringListFromUnknown(s.dirtyFilePaths),
        ...(Array.isArray(s.dirtyItems) ? { dirtyItems: cleanDirtyItems(s.dirtyItems) } : {}),
      });
      onChanged?.();
    },
  });
}

function cleanDirtyItems(value: readonly unknown[]): DirtyWorkItem[] {
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const current = item as Record<string, unknown>;
    if (typeof current.kind !== 'string' || typeof current.id !== 'string' || !current.id.trim())
      return [];
    return [
      {
        kind: current.kind,
        id: current.id,
        ...(typeof current.nativeDocumentId === 'string'
          ? { nativeDocumentId: current.nativeDocumentId }
          : {}),
        ...(typeof current.filePath === 'string' ? { filePath: current.filePath } : {}),
      },
    ];
  });
}

function stringListFromUnknown(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function cleanStringList(value: readonly string[] | undefined): string[] {
  return [...new Set((value ?? []).map((item) => item.trim()).filter(Boolean))];
}
