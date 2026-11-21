import { useEffect, useRef, useCallback, useState } from 'react';
import { platform } from '../../../platform';
import { getNativeSequenceDocumentClient } from '../sequence-document-client';
import { useSequenceStore } from '../store';
import {
  isBinarySequencePath,
  parseBinarySequenceFileAsAnnotated,
  parseTextSequenceFileAsAnnotated,
} from '../parse-sequence-file';
import { findWorkspaceRootForPath } from '../../../db/workspace-catalog';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { readStableWorkspaceGeneration } from '../../../services/workspace-sync-renderer-generation';
import { readSequenceText } from '../read-sequence-text';
import { isHostedBrowserRuntime } from '../../../utils/environment';
import { getSequenceDocumentMetadata, sequenceFormatFromFilename } from '@waypoint/sequence-utils';
import { beginSangerRead } from '../sanger-read-lifecycle-telemetry';

function isMissingWatchedFile(err: unknown): boolean {
  if (['ENOENT', 'DOCUMENT_NOT_FOUND'].includes((err as NodeJS.ErrnoException)?.code ?? ''))
    return true;
  const message = (err as Error)?.message ?? '';
  return message.includes('ENOENT') || message.includes('no such file');
}

interface UseFileWatcherOptions {
  filePath: string;

  documentId: string;

  isDirty: boolean;

  onReload?: () => void;
}

interface UseFileWatcherResult {
  showExternalChangeToast: boolean;

  acceptExternalChange: () => void;

  dismissExternalChange: () => void;

  suppressNextChange: () => void;

  reloadFromDisk: () => Promise<void>;
}

export function useFileWatcher({
  filePath,
  documentId,
  isDirty,
  onReload,
}: UseFileWatcherOptions): UseFileWatcherResult {
  const [showExternalChangeToast, setShowExternalChangeToast] = useState(false);
  const setSequence = useSequenceStore((s) => s.setSequence);

  const isDirtyRef = useRef(isDirty);
  isDirtyRef.current = isDirty;

  const onReloadRef = useRef(onReload);
  onReloadRef.current = onReload;
  const readGeneration = useRef(0);
  const readScope = useRef('');
  const activeRead = useRef<{
    observation: ReturnType<typeof beginSangerRead>;
  } | null>(null);
  readScope.current = JSON.stringify([documentId, filePath]);
  useEffect(() => {
    readGeneration.current += 1;
    return () => {
      readGeneration.current += 1;
      activeRead.current?.observation?.end('read_cancelled', 'closed');
      activeRead.current = null;
    };
  }, [documentId, filePath]);

  const SELF_WRITE_SUPPRESS_MS = 1200;
  const suppressUntilRef = useRef(0);

  const suppressNextChange = useCallback(() => {
    suppressUntilRef.current = Date.now() + SELF_WRITE_SUPPRESS_MS;
  }, []);

  const reloadFromDisk = useCallback(
    async (options: { discardUnchangedDraft?: boolean } = {}) => {
      const generation = readGeneration.current;
      const scope = JSON.stringify([documentId, filePath]);
      const request: NonNullable<typeof activeRead.current> = { observation: undefined };
      activeRead.current?.observation?.end('read_superseded', 'superseded');
      activeRead.current = request;
      const ownsRequest = () =>
        generation === readGeneration.current &&
        scope === readScope.current &&
        activeRead.current === request;
      const initial = useSequenceStore.getState();
      const initialVersion = initial.getVersion(documentId);
      const initialWorking = initial.sequences[documentId];
      const initialSaved = initial.savedSequences[documentId];
      let readHostedIdentity: (() => string | null) | null = null;
      let initialHostedIdentity: string | null = null;
      const ownsRead = (): boolean => {
        if (!ownsRequest()) return false;
        if (
          readHostedIdentity &&
          (!initialHostedIdentity || readHostedIdentity() !== initialHostedIdentity)
        )
          return false;
        const current = useSequenceStore.getState();
        if (
          current.getVersion(documentId) !== initialVersion ||
          current.sequences[documentId] !== initialWorking ||
          current.savedSequences[documentId] !== initialSaved
        ) {
          if (current.dirtyPaths[documentId]) setShowExternalChangeToast(true);
          return false;
        }
        if (
          !options.discardUnchangedDraft &&
          (current.dirtyPaths[documentId] || isDirtyRef.current)
        ) {
          setShowExternalChangeToast(true);
          return false;
        }
        return true;
      };
      try {
        const native = getNativeSequenceDocumentClient();
        if (native) {
          if (!ownsRead()) return;
          if (sequenceFormatFromFilename(filePath) === 'ab1')
            request.observation = beginSangerRead('native_reload');
          const discarded = options.discardUnchangedDraft
            ? await native.execute(
                documentId,
                { kind: 'discard' },
                { expectedVersion: initialVersion }
              )
            : null;
          if (
            !ownsRequest() ||
            getNativeSequenceDocumentClient() !== native ||
            (discarded && useSequenceStore.getState().getVersion(documentId) !== discarded.version)
          ) {
            request.observation?.end('read_superseded', 'superseded');
            return;
          }
          const accepted = await native.execute(documentId, { kind: 'reload' });
          if (!ownsRequest() || getNativeSequenceDocumentClient() !== native) {
            request.observation?.end('read_superseded', 'superseded');
            return;
          }
          const current = useSequenceStore.getState();
          const copy = accepted.copy;
          const sequence = current.sequences[documentId];
          if (!accepted.ready || !copy || !sequence) {
            request.observation?.end('read_failed', 'source_unavailable');
            return;
          }
          if (
            accepted.documentId !== documentId ||
            accepted.version !== copy.version ||
            accepted.savedVersion !== copy.savedVersion ||
            current.getVersion(documentId) !== accepted.version ||
            current.savedVersions[documentId] !== accepted.savedVersion ||
            current.draftLineages[documentId] !== copy.lineage
          ) {
            request.observation?.end('read_superseded', 'stale_revision');
            return;
          }
          request.observation?.revisionReady(
            getSequenceDocumentMetadata(sequence)?.format,
            sequence,
            () => {
              const latest = useSequenceStore.getState();
              return (
                getNativeSequenceDocumentClient() === native &&
                latest.getVersion(documentId) === accepted.version &&
                latest.savedVersions[documentId] === accepted.savedVersion &&
                latest.sequences[documentId] === sequence &&
                latest.draftLineages[documentId] === copy.lineage
              );
            }
          );
          setShowExternalChangeToast(false);
          onReloadRef.current?.();
          return;
        }
        if (isHostedBrowserRuntime()) {
          const [{ hostedDocumentIdentity }, { hostedWorkspaceSessionController }] =
            await Promise.all([
              import('../../../hosted/document-identity'),
              import('../../../hosted/controller'),
            ]);
          readHostedIdentity = () => {
            const state = hostedWorkspaceSessionController.getState();
            const identity = hostedDocumentIdentity(filePath);
            if (
              !state.principal?.id ||
              !identity ||
              state.activeWorkspaceId !== identity.workspaceId
            )
              return null;
            return JSON.stringify([state.principal.id, state.activeWorkspaceId, identity]);
          };
          initialHostedIdentity = readHostedIdentity();
        }
        if (!ownsRead()) return;
        const workspaceRoot = findWorkspaceRootForPath(
          useWorkspaceStore.getState().folders,
          filePath
        );
        const parsed = await readStableWorkspaceGeneration(workspaceRoot, async () => {
          if (isBinarySequencePath(filePath))
            return {
              ...parseBinarySequenceFileAsAnnotated(
                await platform().fs.readFile(filePath),
                filePath
              ),
              acceptedRevision: null,
            };
          const source = await readSequenceText(filePath, workspaceRoot);
          return {
            ...parseTextSequenceFileAsAnnotated(source.content, filePath),
            acceptedRevision: source.acceptedRevision,
          };
        });

        if (!ownsRead()) return;

        setSequence(documentId, parsed.sequence, parsed.acceptedRevision ?? undefined);
        setShowExternalChangeToast(false);
        console.log('[useFileWatcher] Reloaded from disk:', filePath);
        onReloadRef.current?.();
      } catch (err) {
        request.observation?.end('read_failed', 'source_unavailable');
        if (!ownsRead()) return;

        if (isMissingWatchedFile(err)) {
          console.log('[useFileWatcher] Reload skipped; file is gone:', filePath);
          return;
        }
        console.error('[useFileWatcher] Failed to reload:', err);
      }
    },
    [documentId, filePath, setSequence]
  );

  const handleFileChanged = useCallback(
    (changedPath: string) => {
      if (changedPath !== filePath) return;

      if (Date.now() < suppressUntilRef.current) {
        return;
      }

      if (isDirtyRef.current) {
        setShowExternalChangeToast(true);
      } else {
        reloadFromDisk();
      }
    },
    [filePath, reloadFromDisk]
  );

  const acceptExternalChange = useCallback(() => {
    setShowExternalChangeToast(false);
    void reloadFromDisk({ discardUnchangedDraft: true });
  }, [reloadFromDisk]);

  const dismissExternalChange = useCallback(() => {
    setShowExternalChangeToast(false);
  }, []);

  useEffect(() => {
    if (!filePath) return;

    platform()
      .fs.watchFile(filePath)
      .catch((err) => {
        console.warn('[useFileWatcher] Failed to start watching:', err);
      });

    const unsubscribe = platform().on('file-changed', (...args: unknown[]) => {
      const changedPath = args[0] as string;
      handleFileChanged(changedPath);
    });

    return () => {
      platform()
        .fs.unwatchFile(filePath)
        .catch(() => {});
      unsubscribe();
    };
  }, [filePath, handleFileChanged]);

  useEffect(() => {
    if (!filePath) return;
    let cancelled = false;
    let unsubscribe = () => {};
    void import('../../../utils/environment').then(async ({ isHostedBrowserRuntime }) => {
      if (cancelled || !isHostedBrowserRuntime()) return;
      const [{ hostedDocumentIdentity }, { hostedWorkspaceSessionController }] = await Promise.all([
        import('../../../hosted/document-identity'),
        import('../../../hosted/controller'),
      ]);
      if (cancelled) return;
      let last = '';
      const sync = (): void => {
        const identity = hostedDocumentIdentity(filePath);
        const next = identity ? `${identity.revisionId}:${identity.contentSha256}` : '';
        if (!next || next === last) return;
        const first = last === '';
        last = next;
        if (!first) handleFileChanged(filePath);
      };
      sync();
      unsubscribe = hostedWorkspaceSessionController.subscribe(sync);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [filePath, handleFileChanged]);

  return {
    showExternalChangeToast,
    acceptExternalChange,
    dismissExternalChange,
    suppressNextChange,
    reloadFromDisk,
  };
}
