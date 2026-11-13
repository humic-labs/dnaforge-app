import {
  usePresentationOverlay,
  PresentationScopeContext,
  usePresentationListener,
} from '../presentation/PresentationSurface';
import { useCallback, useEffect, useRef, useState } from 'react';

import { platform } from '../platform';
import type {
  LargeFileImportDialogRequest,
  LargeFileImportDialogResponse,
} from '../shared/large-file-import-dialog';
import type { ManagedWorkspaceLargeFilePolicy } from '../shared/workspace-git-types';
import { safeFocus } from '../shared/utils/safeFocus';
import { CloseIcon, ExclamationCircleIcon } from './icons';

const MAX_VISIBLE_FILES = 5;

export function LargeFileImportDialogHost() {
  const presentationOverlay = usePresentationOverlay('modal');
  const presentationEvents = usePresentationListener(presentationOverlay.scope);

  const [request, setRequest] = useState<LargeFileImportDialogRequest | null>(null);
  const requestRef = useRef<LargeFileImportDialogRequest | null>(null);
  const copyButtonRef = useRef<HTMLButtonElement>(null);

  const clearRequest = useCallback(() => {
    requestRef.current = null;
    setRequest(null);
  }, []);

  const respond = useCallback(
    (policy: ManagedWorkspaceLargeFilePolicy | 'cancel') => {
      const current = requestRef.current;
      if (!current) return;
      clearRequest();
      const response: LargeFileImportDialogResponse = {
        requestId: current.requestId,
        policy,
      };
      platform().largeFileImportDialog.respond(current.requestId, response);
    },
    [clearRequest]
  );

  useEffect(() => {
    const bridge = platform().largeFileImportDialog;
    const unsubscribeRequest = bridge.onRequest((incoming) => {
      const current = requestRef.current;
      if (current && current.requestId !== incoming.requestId) {
        bridge.respond(current.requestId, {
          requestId: current.requestId,
          policy: 'cancel',
        });
      }
      requestRef.current = incoming;
      setRequest(incoming);
    });
    const unsubscribeCancel = bridge.onCancel((requestId) => {
      if (requestRef.current?.requestId === requestId) clearRequest();
    });

    return () => {
      unsubscribeRequest();
      unsubscribeCancel();
      const current = requestRef.current;
      if (current) {
        bridge.respond(current.requestId, {
          requestId: current.requestId,
          policy: 'cancel',
        });
      }
      requestRef.current = null;
    };
  }, [clearRequest]);

  useEffect(() => {
    if (!request) return;
    safeFocus(copyButtonRef.current);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        respond('cancel');
      }
    };
    presentationEvents.add(window, 'keydown', onKeyDown);
    return () => presentationEvents.remove(window, 'keydown', onKeyDown);
  }, [request, respond, presentationEvents]);

  if (!request) return null;

  const countLabel =
    request.files.length === 1 ? '1 large file' : `${request.files.length} large files`;
  const hiddenFileCount = Math.max(0, request.files.length - MAX_VISIBLE_FILES);

  return (
    <div
      ref={presentationOverlay.bindRef(undefined, '0')}
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm"
      data-testid="large-file-import-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) respond('cancel');
      }}
    >
      <PresentationScopeContext.Provider value={presentationOverlay.scope}>
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="large-file-import-dialog-title"
          aria-describedby="large-file-import-dialog-description"
          data-testid="large-file-import-dialog"
          data-large-file-import-ui="dnaforge-v1"
          className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-bg shadow-2xl"
        >
          <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-5">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-warning/10 text-warning">
                <ExclamationCircleIcon className="h-5 w-5" />
              </span>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-warning">
                  Large file import
                </p>
                <h2
                  id="large-file-import-dialog-title"
                  className="mt-1 text-lg font-semibold text-fg"
                >
                  Choose how DNAForge stores these files
                </h2>
              </div>
            </div>
            <button
              type="button"
              aria-label="Close dialog"
              onClick={() => respond('cancel')}
              className="-mr-1 -mt-1 rounded-md p-1.5 text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <CloseIcon size={16} />
            </button>
          </div>

          <div className="space-y-5 px-6 py-5">
            <p
              id="large-file-import-dialog-description"
              className="text-sm leading-6 text-fg-muted"
            >
              This import contains {countLabel} larger than {formatBytes(request.thresholdBytes)}.
              Copying keeps the workspace self-contained. Keeping the files in place starts faster,
              but moving or renaming them later will break their links in DNAForge.
            </p>

            <div className="overflow-hidden rounded-lg border border-border bg-bg-subtle">
              {request.files.slice(0, MAX_VISIBLE_FILES).map((file) => (
                <div
                  key={`${file.relPath}:${file.sizeBytes}`}
                  className="flex items-center justify-between gap-4 border-b border-border px-4 py-3 last:border-b-0"
                >
                  <span
                    className="min-w-0 truncate text-sm font-medium text-fg"
                    title={file.relPath}
                  >
                    {file.relPath}
                  </span>
                  <span className="shrink-0 text-sm tabular-nums text-fg-muted">
                    {formatBytes(file.sizeBytes)}
                  </span>
                </div>
              ))}
              {hiddenFileCount > 0 ? (
                <div className="px-4 py-3 text-sm text-fg-muted">
                  And {hiddenFileCount} more {hiddenFileCount === 1 ? 'file' : 'files'}
                </div>
              ) : null}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border bg-bg-subtle px-6 py-4">
            <button
              type="button"
              data-testid="large-file-import-cancel"
              onClick={() => respond('cancel')}
              className="rounded-md border border-border bg-bg px-4 py-2 text-sm font-medium text-fg transition-colors hover:bg-bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="large-file-import-symlink"
              onClick={() => respond('symlink')}
              className="rounded-md border border-border bg-bg px-4 py-2 text-sm font-medium text-fg transition-colors hover:bg-bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              Keep files in place
            </button>
            <button
              ref={copyButtonRef}
              type="button"
              data-testid="large-file-import-copy"
              onClick={() => respond('copy')}
              className="rounded-md border border-accent bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
            >
              Copy into DNAForge
            </button>
          </div>
        </div>
      </PresentationScopeContext.Provider>
    </div>
  );
}

function formatBytes(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) return `${formatNumber(gib)} GB`;
  const mib = bytes / 1024 ** 2;
  if (mib >= 1) return `${formatNumber(mib)} MB`;
  const kib = bytes / 1024;
  if (kib >= 1) return `${formatNumber(kib)} KB`;
  return `${bytes} B`;
}

function formatNumber(value: number): string {
  return value >= 10 ? value.toFixed(0) : value.toFixed(1);
}
