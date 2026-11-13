import { toUserMessage } from '@waypoint/user-messages';
import { useState, useSyncExternalStore } from 'react';
import { hostedDurableSync, hostedWorkspaceSessionController } from './controller';
import { HostedConflictPanel } from './HostedConflictPanel';

export function HostedSyncStatus() {
  const session = useSyncExternalStore(
    hostedWorkspaceSessionController.subscribe,
    hostedWorkspaceSessionController.getState
  );
  useSyncExternalStore(hostedDurableSync.subscribe, hostedDurableSync.getRevision);
  const [error, setError] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const workspaceId = session.activeWorkspaceId;
  const status = workspaceId ? hostedDurableSync.getStatus(workspaceId) : undefined;
  if (!status || !workspaceId) return null;
  return (
    <>
      <div
        className={`hosted-sync-status hosted-sync-${status.state}`}
        role="status"
        data-testid="hosted-sync-status"
        data-state={status.state}
        data-pending-count={status.pendingCount}
        data-unbacked-count={status.unbackedCount}
      >
        <span>{toUserMessage(status.message, 'operation.failed')}</span>
        {status.pendingCount > 0 ? (
          <span data-testid="hosted-recovery-status">
            {status.recovery && Date.parse(status.recovery.expiresAt) > Date.now()
              ? `Earlier saved capture retained until ${new Date(status.recovery.expiresAt).toLocaleString()}.`
              : 'Not yet backed up remotely.'}
            {status.recovery && status.unbackedCount > 0
              ? ' Newer pending edits remain on this device only.'
              : null}
          </span>
        ) : null}
        {status.state === 'saved-locally' || status.state === 'blocked' ? (
          <button
            type="button"
            className="hosted-text-button"
            onClick={() => {
              setError(null);
              void hostedDurableSync
                .retry(workspaceId)
                .catch((cause: unknown) => setError(toUserMessage(cause, 'failure.retry-failed')));
            }}
          >
            Retry sync
          </button>
        ) : null}
        {error ? <span role="alert">{toUserMessage(error, 'operation.failed')}</span> : null}
        {status.state === 'conflict' ? (
          <button
            type="button"
            className="hosted-text-button"
            data-testid="hosted-sync-review"
            onClick={() => setReviewOpen(true)}
          >
            Review versions
          </button>
        ) : null}
      </div>
      {reviewOpen ? (
        <HostedConflictPanel
          key={`${session.principal?.id}:${workspaceId}`}
          workspaceId={workspaceId}
          onClose={() => setReviewOpen(false)}
        />
      ) : null}
    </>
  );
}
