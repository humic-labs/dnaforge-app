import {
  legacyUnsavedDiscardScope,
  type LegacyUnsavedDiscardSnapshot,
} from '../../shared/legacy-unsaved-discard';
import type { DirtyWorkState } from '../../shared/dirty-work-state';
import { workspaceMutationRootIdentity } from '../workspace-sync-mutation-lease';
import type { UnsavedWorkSaver } from '../quit-consent';
import type {
  NativeDirtySettlementRequest,
  NativeDirtySettlementResult,
} from '../../shared/native-dirty-documents';

export interface NativeDocumentQuitWindow {
  isDestroyed(): boolean;
  webContents: { executeJavaScript(script: string): Promise<unknown> };
}

type NativeDocumentQuitSaver<Window extends NativeDocumentQuitWindow> = Omit<
  UnsavedWorkSaver,
  'saveAll' | 'discardRecoveryCopies'
> & {
  saveAll(window: Window | null): Promise<void>;
  discardRecoveryCopies(window: Window | null): Promise<void>;
};

async function runLegacyRecoveryCommand<T>(
  target: NativeDocumentQuitWindow,
  script: string
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      target.webContents.executeJavaScript(script) as Promise<T>,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('The editing client did not confirm recovery cleanup.')),
          2000
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function createNativeDocumentQuitSaver<Window extends NativeDocumentQuitWindow>(deps: {
  getMainWindow(): Window | null;
  isRendererAvailable(): boolean;
  getDirtyState(): DirtyWorkState;
  readCurrentDirtyState(): Promise<DirtyWorkState>;
  requestSaveAll(window: Window, timeoutMs: number): Promise<void>;
  nativeDocuments: {
    workspaces: { readableRoots(): readonly string[] };
    settleDirtyDocuments(
      request: NativeDirtySettlementRequest
    ): Promise<NativeDirtySettlementResult>;
  };
}): NativeDocumentQuitSaver<Window> {
  return {
    canSave: () => {
      const window = deps.getMainWindow();
      return window && !window.isDestroyed()
        ? deps.isRendererAvailable()
        : Boolean(deps.getDirtyState().dirtyFilePaths?.length);
    },
    saveAll: async (win) => {
      const target = win ?? deps.getMainWindow();
      if (target && !target.isDestroyed() && deps.isRendererAvailable()) {
        await deps.requestSaveAll(target, 60_000);
        return;
      }
      const result = await deps.nativeDocuments.settleDirtyDocuments({ action: 'save' });
      if (result.failures.length || result.remaining.length)
        throw new Error(
          result.failures.map((item) => item.error).join(' ') ||
            'Some native drafts remain unsaved.'
        );
    },
    readDirty: deps.readCurrentDirtyState,
    discardRecoveryCopies: async (win) => {
      const target = win ?? deps.getMainWindow();
      let legacySnapshot: LegacyUnsavedDiscardSnapshot | undefined;
      if (target && !target.isDestroyed() && deps.isRendererAvailable()) {
        const scope = legacyUnsavedDiscardScope(
          await deps.readCurrentDirtyState(),
          deps.nativeDocuments.workspaces.readableRoots()
        );
        legacySnapshot = await runLegacyRecoveryCommand<LegacyUnsavedDiscardSnapshot>(
          target,
          `(() => { if (typeof window.__dnaforgeCaptureUnsavedCopies !== 'function') throw new Error('The recovery capture client is unavailable.'); return window.__dnaforgeCaptureUnsavedCopies(${JSON.stringify(scope)}); })()`
        );
        if (legacySnapshot?.version !== 1 || !Array.isArray(legacySnapshot.copies))
          throw new Error('The editing client did not return an exact recovery snapshot.');
      }
      const result = await deps.nativeDocuments.settleDirtyDocuments({ action: 'discard' });
      if (result.failures.length || result.remaining.length)
        throw new Error(
          result.failures.map((item) => item.error).join(' ') ||
            'Some native drafts remain retained.'
        );
      if (!target || target.isDestroyed() || !legacySnapshot) return;
      const admitted = new Set(
        deps.nativeDocuments.workspaces.readableRoots().map(workspaceMutationRootIdentity)
      );
      for (const copy of legacySnapshot.copies)
        if (
          typeof copy.workspaceRoot !== 'string' ||
          !admitted.has(workspaceMutationRootIdentity(copy.workspaceRoot))
        )
          throw new Error('A recovery project is no longer admitted. Its legacy copies were kept.');
      await runLegacyRecoveryCommand<void>(
        target,
        `(() => { if (typeof window.__dnaforgeDiscardUnsavedCopies !== 'function') throw new Error('The recovery cleanup client is unavailable.'); return window.__dnaforgeDiscardUnsavedCopies(${JSON.stringify(legacySnapshot)}); })()`
      );
    },
  };
}
