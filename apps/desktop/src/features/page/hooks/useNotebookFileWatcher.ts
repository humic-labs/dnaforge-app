import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { JSONContent } from '@tiptap/core';

import { contentFingerprint } from '../../../db/entity-substrate/adapter';
import { notebookPackagePaths } from '../../../db/notebook-package';
import { readCanonicalNotebookPackage } from '../../../db/notebook-package-migration';
import { getCurrentCatalogFileForEntity } from '../../../db/workspace-catalog';
import { platform } from '../../../platform';
import { withWorkspaceArtifactOpen } from '../../../services/workspace-artifact-open';
import {
  getReferenceGeneration,
  startReferenceInvalidationListeners,
  subscribeToReferenceGeneration,
} from '../entity-ref/reference-generation';
import { usePageStore } from '../store';
import { withNotebookAuthorityOperation } from '../notebook-authority-queue';
import { trackRendererEvent } from '../../../lib/analytics';
import { notebookReloadResultProperties } from './notebook-reload-result';
import { isExternalConflictError } from '../notebook-external-conflict';
import type { NOTEBOOK_RELOAD_STAGES } from '../../../shared/desktop-failure-telemetry';

interface NotebookWatchTarget {
  packageRoot: string;
  markdownPath: string;
}

interface UseNotebookFileWatcherInput {
  pageId: string;
  workspaceRoot: string | null;
  isDirty: boolean;
  onReload?: (content: JSONContent) => void;
  onKeepLocal?: (expectedCanonicalFingerprint: string) => Promise<void>;
}

export type NotebookSyncState = 'current' | 'conflict' | 'reload-unavailable';

function notebookConflictState(current: NotebookSyncState): NotebookSyncState {
  return current === 'reload-unavailable' ? current : 'conflict';
}

export interface NotebookFileWatcherResult {
  state: NotebookSyncState;
  showExternalChangeToast: boolean;
  showExternalReloadError: boolean;
  acceptExternalChange: () => void;
  retryExternalReload: () => void;
  dismissExternalChange: () => void;
  expectedCanonicalFingerprint: () => string | undefined;
  recordOwnSave: (committedFingerprint: string | undefined) => void;
  recordLocalEdit: () => void;
  reportSaveConflict: () => Promise<void>;
}

async function resolveWatchTarget(pageId: string): Promise<NotebookWatchTarget | null> {
  const binding = await getCurrentCatalogFileForEntity(pageId);
  if (!binding || binding.file_kind !== 'waypoint-notebook') return null;

  if (binding.path.toLowerCase().endsWith('.wpnote.json')) {
    return { packageRoot: binding.path, markdownPath: binding.path };
  }
  return {
    packageRoot: binding.path,
    markdownPath: notebookPackagePaths(binding.path).markdownPath,
  };
}

export function useNotebookFileWatcher({
  pageId,
  workspaceRoot,
  isDirty,
  onReload,
  onKeepLocal,
}: UseNotebookFileWatcherInput): NotebookFileWatcherResult {
  const [state, setState] = useState<NotebookSyncState>('current');
  const reloadFailureOperationRef = useRef<string>();
  const [watchAttempt, setWatchAttempt] = useState(0);
  const watchReady = useRef(false);
  const targetRef = useRef<NotebookWatchTarget | null>(null);
  const baselineFingerprintRef = useRef<string>();
  const conflictFingerprintRef = useRef<string>();
  const isDirtyRef = useRef(isDirty);
  const onReloadRef = useRef(onReload);
  const onKeepLocalRef = useRef(onKeepLocal);
  const workspaceRootRef = useRef(workspaceRoot);
  const generationRef = useRef(0);
  const localEditGenerationRef = useRef(0);
  const reloadQueueRef = useRef<Promise<void>>(Promise.resolve());
  const catalogGeneration = useSyncExternalStore(
    subscribeToReferenceGeneration,
    getReferenceGeneration
  );
  isDirtyRef.current = isDirty;
  onReloadRef.current = onReload;
  onKeepLocalRef.current = onKeepLocal;
  workspaceRootRef.current = workspaceRoot;

  useEffect(() => startReferenceInvalidationListeners(), []);

  const reportReloadFailure = useCallback(
    (error: unknown, stage: (typeof NOTEBOOK_RELOAD_STAGES)[number]) => {
      const operationId = crypto.randomUUID();
      reloadFailureOperationRef.current = operationId;
      setState('reload-unavailable');
      trackRendererEvent(
        'notebook_external_reload_result',
        notebookReloadResultProperties('failed', { error, stage, operationId })
      );
    },
    []
  );

  const readFingerprint = useCallback(async (): Promise<string | undefined> => {
    const target = targetRef.current;
    if (!target) return undefined;
    return contentFingerprint(await platform().fs.readTextFile(target.markdownPath));
  }, []);

  const performReloadFromDisk = useCallback(
    async (request: {
      generation: number;
      editGeneration: number;
      discardLocalEdits: boolean;
      failureOperationId: string | undefined;
    }): Promise<void> =>
      withNotebookAuthorityOperation(pageId, async () => {
        const canReload = (fingerprint?: string): boolean => {
          if (
            request.generation !== generationRef.current ||
            request.failureOperationId !== reloadFailureOperationRef.current
          )
            return false;
          if (
            request.editGeneration !== localEditGenerationRef.current ||
            (!request.discardLocalEdits && isDirtyRef.current)
          ) {
            if (fingerprint && fingerprint !== baselineFingerprintRef.current) {
              conflictFingerprintRef.current = fingerprint;
              setState(notebookConflictState);
            }
            return false;
          }
          return true;
        };
        if (!canReload()) return;
        const target = targetRef.current;
        const owningRoot = workspaceRootRef.current;
        if (!target || !owningRoot) return;
        await withWorkspaceArtifactOpen({
          path: target.packageRoot,
          workspaceRoot: owningRoot,
          notebookConflictResolution: request.discardLocalEdits ? 'use-file' : undefined,
          consume: async (resolved, mutationToken) => {
            if (!canReload(resolved.authorityFingerprint)) return;
            if (!('content' in resolved.artifact)) {
              throw new Error(`Notebook artifact has no content: ${target.packageRoot}`);
            }
            const content = resolved.artifact.content as JSONContent;
            await usePageStore.getState().upsertPageFromArtifact({
              id: resolved.entity.id,
              title: resolved.artifact.title,
              content,
              workspaceRoot: owningRoot,
              authorityFingerprint: resolved.authorityFingerprint,
              mutationToken,
            });

            if (!canReload(resolved.authorityFingerprint)) return;
            baselineFingerprintRef.current = resolved.authorityFingerprint;
            conflictFingerprintRef.current = undefined;
            setState('current');
            if (request.failureOperationId) {
              trackRendererEvent(
                'notebook_external_reload_result',
                notebookReloadResultProperties('recovered', {
                  stage: 'reload',
                  operationId: request.failureOperationId,
                })
              );
            }
            reloadFailureOperationRef.current = undefined;
            usePageStore.getState().setDirty(pageId, false);
            onReloadRef.current?.(content);
          },
        });
      }),
    [pageId]
  );

  const reloadFromDisk = useCallback(
    (discardLocalEdits = false): Promise<void> => {
      const request = {
        generation: generationRef.current,
        editGeneration: localEditGenerationRef.current,
        discardLocalEdits,
        failureOperationId: reloadFailureOperationRef.current,
      };
      const queued = reloadQueueRef.current
        .catch(() => {})
        .then(() => performReloadFromDisk(request));
      reloadQueueRef.current = queued;
      return queued;
    },
    [performReloadFromDisk]
  );

  const inspectDiskChange = useCallback(
    async (retry = false): Promise<void> => {
      const generation = generationRef.current;
      const nextFingerprint = await readFingerprint();
      if (
        generation !== generationRef.current ||
        !nextFingerprint ||
        (!retry && nextFingerprint === baselineFingerprintRef.current)
      )
        return;
      if (isDirtyRef.current) {
        const target = targetRef.current;
        if (target && target.packageRoot !== target.markdownPath) {
          await readCanonicalNotebookPackage(platform().fs, target.packageRoot);
        }
        if (generation !== generationRef.current) return;
        conflictFingerprintRef.current = nextFingerprint;
        setState(retry ? 'conflict' : notebookConflictState);
        return;
      }
      await reloadFromDisk();
    },
    [readFingerprint, reloadFromDisk]
  );

  useEffect(() => {
    const generation = ++generationRef.current;
    let disposed = false;
    let watchedPath: string | null = null;
    let watchRegistration: Promise<void> | undefined;
    const isCurrent = () => !disposed && generation === generationRef.current;

    const onPageHide = (event: PageTransitionEvent) => {
      if (!event.persisted) dispose();
    };
    const notifyFailure = (error: unknown, stage: 'watch' | 'reload' | 'external-change') => {
      if (!isCurrent()) return;
      if (isExternalConflictError(error)) {
        void readFingerprint().then((fingerprint) => {
          if (!isCurrent()) return;
          conflictFingerprintRef.current = fingerprint;
          setState(notebookConflictState);
        });
        return;
      }
      console.warn(`[useNotebookFileWatcher] Notebook ${stage} failed:`, error);
      reportReloadFailure(error, stage);
    };
    void (async () => {
      const target = await resolveWatchTarget(pageId);
      if (!isCurrent() || !target) return;
      targetRef.current = target;
      watchedPath = target.markdownPath;
      watchRegistration = platform().fs.watchFile(watchedPath);
      await watchRegistration;
      if (!isCurrent()) return;
      watchReady.current = true;
      const fingerprint = await readFingerprint();
      if (!isCurrent()) return;
      baselineFingerprintRef.current = fingerprint;
      if (!isDirtyRef.current) await reloadFromDisk();
      else if (reloadFailureOperationRef.current) await inspectDiskChange(true);
    })().catch((error) => notifyFailure(error, watchReady.current ? 'reload' : 'watch'));

    const unsubscribe = platform().on('file-changed', (...args: unknown[]) => {
      const changedPath = args[0];
      if (!isCurrent() || typeof changedPath !== 'string' || changedPath !== watchedPath) return;
      void inspectDiskChange().catch((error) => notifyFailure(error, 'external-change'));
    });

    function dispose() {
      if (disposed) return;
      disposed = true;
      generationRef.current++;
      watchReady.current = false;
      targetRef.current = null;
      baselineFingerprintRef.current = undefined;
      conflictFingerprintRef.current = undefined;
      const path = watchedPath;
      if (path && watchRegistration)
        void watchRegistration.then(() => platform().fs.unwatchFile(path)).catch(() => {});
      unsubscribe();
      window.removeEventListener('pagehide', onPageHide);
    }
    window.addEventListener('pagehide', onPageHide);
    return dispose;
  }, [
    watchAttempt,
    catalogGeneration,
    inspectDiskChange,
    pageId,
    readFingerprint,
    reloadFromDisk,
    reportReloadFailure,
    workspaceRoot,
  ]);

  const acceptExternalChange = useCallback(() => {
    const generation = generationRef.current;
    void reloadFromDisk(true).catch((error) => {
      if (generation !== generationRef.current) return;
      console.warn('[useNotebookFileWatcher] Could not reload notebook Markdown:', error);
      reportReloadFailure(error, 'reload');
    });
  }, [reloadFromDisk, reportReloadFailure]);

  const retryExternalReload = useCallback(() => {
    if (!watchReady.current) {
      setWatchAttempt((attempt) => attempt + 1);
      return;
    }
    const generation = generationRef.current;
    void inspectDiskChange(true).catch((error) => {
      if (generation !== generationRef.current) return;
      console.warn('[useNotebookFileWatcher] Could not retry notebook Markdown:', error);
      reportReloadFailure(error, 'reload');
    });
  }, [inspectDiskChange, reportReloadFailure]);

  const recordOwnSave = useCallback((committedFingerprint: string | undefined) => {
    baselineFingerprintRef.current = committedFingerprint;
    conflictFingerprintRef.current = undefined;
    setState('current');
  }, []);

  const recordLocalEdit = useCallback(() => {
    localEditGenerationRef.current += 1;
    isDirtyRef.current = true;
  }, []);

  const reportSaveConflict = useCallback(async () => {
    const generation = generationRef.current;
    const fingerprint = await readFingerprint();
    if (generation !== generationRef.current) return;
    conflictFingerprintRef.current = fingerprint;
    setState(notebookConflictState);
  }, [readFingerprint]);

  const dismissExternalChange = useCallback(() => {
    const fingerprint = conflictFingerprintRef.current;
    const keepLocal = onKeepLocalRef.current;
    if (!fingerprint) {
      if (!keepLocal) setState('current');
      return;
    }
    const generation = generationRef.current;
    const recoveryOperationId = reloadFailureOperationRef.current;
    const acknowledge = () => {
      if (
        generation !== generationRef.current ||
        conflictFingerprintRef.current !== fingerprint ||
        recoveryOperationId !== reloadFailureOperationRef.current
      )
        return false;
      baselineFingerprintRef.current = fingerprint;
      conflictFingerprintRef.current = undefined;
      setState('current');
      return true;
    };
    if (!keepLocal) {
      acknowledge();
      return;
    }
    void (async () => {
      try {
        await keepLocal(fingerprint);
        if (!acknowledge() || !recoveryOperationId) return;
        trackRendererEvent(
          'notebook_external_reload_result',
          notebookReloadResultProperties('recovered', {
            stage: 'keep-local',
            operationId: recoveryOperationId,
          })
        );
        reloadFailureOperationRef.current = undefined;
      } catch (error) {
        if (generation !== generationRef.current) return;
        console.warn('[useNotebookFileWatcher] Could not keep notebook edits:', error);
        await reportSaveConflict().catch((reloadError) => {
          if (generation === generationRef.current) reportReloadFailure(reloadError, 'keep-local');
        });
      }
    })();
  }, [reportSaveConflict, reportReloadFailure]);

  return {
    state,
    showExternalChangeToast: state === 'conflict',
    showExternalReloadError: state === 'reload-unavailable',
    acceptExternalChange,
    retryExternalReload,
    dismissExternalChange,
    expectedCanonicalFingerprint: () => baselineFingerprintRef.current,
    recordOwnSave,
    recordLocalEdit,
    reportSaveConflict: async () => {
      try {
        await reportSaveConflict();
      } catch (error) {
        if (!isExternalConflictError(error)) throw error;
      }
    },
  };
}
