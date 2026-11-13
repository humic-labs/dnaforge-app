import { toUserMessage, userMessage } from '@waypoint/user-messages';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { hostedWorkspaceSessionController } from './controller';
import { HostedWorkspaceApiError } from './api';
import { emitHostedFileChanged } from './events';
import { hostedAbsolutePath } from './paths';
import { HostedRecoveryPanel } from './HostedRecoveryPanel';

export function HostedHistoryPanel({
  open,
  onClose,
  onRestored,
}: {
  open: boolean;
  onClose: () => void;
  onRestored?: (message: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const session = useSyncExternalStore(
    hostedWorkspaceSessionController.subscribe,
    hostedWorkspaceSessionController.getState,
    hostedWorkspaceSessionController.getState
  );
  const snapshot = session.snapshot;

  useEffect(() => {
    if (!open) return;
    void hostedWorkspaceSessionController.loadHistory().catch((cause: unknown) => {
      setError(toUserMessage(cause, 'failure.could-not-load-revision-history'));
    });
  }, [open]);

  const restoreRevision = useCallback(
    async (revisionId: string, revisionNumber: number) => {
      setError(null);
      setBusy(true);
      try {
        const accepted = await hostedWorkspaceSessionController.restoreRevision(revisionId);
        setError(null);
        onRestored?.(`Restored revision ${revisionNumber} as revision ${accepted.revisionNumber}.`);
        for (const file of accepted.files) {
          emitHostedFileChanged(hostedAbsolutePath(accepted.workspaceId, file.path));
        }
        await hostedWorkspaceSessionController.loadHistory();
      } catch (cause) {
        if (cause instanceof HostedWorkspaceApiError && cause.code === 'SYNC_CONFLICT') {
          setError(
            userMessage('failure.this-project-changed-in-another-session-reload-before-restoring')
          );
        } else {
          setError(toUserMessage(cause, 'failure.restore-failed'));
        }
      } finally {
        setBusy(false);
      }
    },
    [onRestored]
  );

  if (!open) return null;

  return (
    <aside className="hosted-history" data-testid="hosted-history">
      <div className="hosted-history-heading">
        <div>
          <strong>Revision history</strong>
        </div>
        <button type="button" aria-label="Close history" onClick={onClose}>
          ×
        </button>
      </div>
      {error ? (
        <p className="hosted-history-empty">{toUserMessage(error, 'operation.failed')}</p>
      ) : null}
      {session.phase === 'loading-history' ? (
        <p className="hosted-history-empty">Loading immutable revisions…</p>
      ) : session.history.length === 0 ? (
        <p className="hosted-history-empty">No historical revisions are available.</p>
      ) : (
        <ol className="hosted-history-list">
          {session.history.map((revision) => {
            const current = revision.revisionId === snapshot?.revisionId;
            return (
              <li key={revision.revisionId} data-version-id={revision.revisionId}>
                <div>
                  <strong>Revision {revision.revisionNumber}</strong>
                  <span>
                    {revision.fileCount} {revision.fileCount === 1 ? 'file' : 'files'}
                  </span>
                </div>
                <button
                  type="button"
                  data-testid="hosted-restore-revision"
                  disabled={current || busy}
                  onClick={() => void restoreRevision(revision.revisionId, revision.revisionNumber)}
                >
                  {current ? 'Current' : 'Restore'}
                </button>
              </li>
            );
          })}
        </ol>
      )}
      {session.principal?.id && session.activeWorkspaceId ? (
        <HostedRecoveryPanel
          accountId={session.principal.id}
          workspaceId={session.activeWorkspaceId}
        />
      ) : null}
    </aside>
  );
}
