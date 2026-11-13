import { userMessage } from '@waypoint/user-messages';
import { lazy, Suspense, useSyncExternalStore } from 'react';
import { BrowserWorkspaceReadPanel } from './BrowserWorkspaceReadPanel';
import { HostedShareDialog } from './HostedShareDialog';
import { HostedSyncStatus } from './HostedSyncStatus';
import { requestHostedKeepWork, useHostedCapability, useHostedDemoSession } from './capabilities';
import { hostedDurableSync, hostedWorkspaceSessionController } from './controller';

import { HostedKeepWorkButton } from './HostedKeepWork';

const HostedHistoryPanel = lazy(() =>
  import('./HostedHistoryPanel').then((module) => ({ default: module.HostedHistoryPanel }))
);

export interface HostedBrowserReadTarget {
  readonly workspaceId: string;
  readonly displayName: string;
}

export interface HostedShareTarget {
  readonly workspaceId: string;
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly workspaceName: string;
}

export function HostedShareButton({
  target,
  onOpen,
}: {
  readonly target: HostedShareTarget | null;
  readonly onOpen: () => void;
}) {
  useSyncExternalStore(
    hostedDurableSync.subscribe,
    hostedDurableSync.getRevision,
    hostedDurableSync.getRevision
  );
  const access = useHostedCapability('share-links');
  const pending = target
    ? (hostedDurableSync.getStatus(target.workspaceId)?.pendingCount ?? 0) > 0
    : false;
  if (access.kind === 'sign-up') {
    return (
      <button
        type="button"
        className="hosted-text-button"
        data-testid="hosted-share-open"
        title={access.label}
        onClick={() => requestHostedKeepWork(access.label)}
      >
        Share
      </button>
    );
  }
  return (
    <button
      type="button"
      className="hosted-text-button"
      data-testid="hosted-share-open"
      disabled={!target || pending}
      title={
        pending
          ? 'Sync your saved changes before sharing this project'
          : target
            ? 'Publish a pinned, read-only link'
            : 'Open a saved sequence before sharing'
      }
      onClick={onOpen}
    >
      Share
    </button>
  );
}

export function HostedWorkspaceChrome({
  fileInputRef,
  historyOpen,
  onHistoryToggle,
  onImport,
  onSignOut,
  onHistoryClose,
  onRestored,
  status,
  browserReadOpen,
  browserReadTarget,
  versionId,
  onBrowserReadClose,
  shareOpen,
  shareTarget,
  onShareClose,
  onShareCreated,
}: {
  readonly fileInputRef: { current: HTMLInputElement | null };
  readonly historyOpen: boolean;
  readonly onHistoryToggle: () => void;
  readonly onImport: (files: readonly File[]) => void | Promise<void>;
  readonly onSignOut: () => void | Promise<void>;
  readonly onHistoryClose: () => void;
  readonly onRestored: (message: string) => void;
  readonly status: string | null;
  readonly browserReadOpen: boolean;
  readonly browserReadTarget: HostedBrowserReadTarget | null;
  readonly versionId: string | null;
  readonly onBrowserReadClose: () => void;
  readonly shareOpen: boolean;
  readonly shareTarget: HostedShareTarget | null;
  readonly onShareClose: () => void;
  readonly onShareCreated: (message: string) => void;
}) {
  useSyncExternalStore(
    hostedDurableSync.subscribe,
    hostedDurableSync.getRevision,
    hostedDurableSync.getRevision
  );
  const shareBlocked =
    shareTarget && (hostedDurableSync.getStatus(shareTarget.workspaceId)?.pendingCount ?? 0) > 0
      ? userMessage('sharing.syncRequired')
      : undefined;
  const demo = useHostedDemoSession();
  const session = useSyncExternalStore(
    hostedWorkspaceSessionController.subscribe,
    hostedWorkspaceSessionController.getState,
    hostedWorkspaceSessionController.getState
  );
  return (
    <>
      <input
        ref={(node) => {
          fileInputRef.current = node;
        }}
        data-testid="hosted-file-input"
        className="hosted-hidden-input"
        type="file"
        multiple
        accept=".gb,.gbk,.gbff,.genbank,text/plain,*/*"
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          if (files.length > 0) void onImport(files);
        }}
      />
      <button
        type="button"
        className="hosted-history-toggle"
        data-testid="hosted-history-toggle"
        aria-expanded={historyOpen}
        onClick={onHistoryToggle}
      >
        History
      </button>
      {demo ? null : (
        <button type="button" className="hosted-text-button" onClick={() => void onSignOut()}>
          Sign out
        </button>
      )}
      <Suspense fallback={null}>
        <HostedHistoryPanel open={historyOpen} onClose={onHistoryClose} onRestored={onRestored} />
      </Suspense>
      <HostedSyncStatus />
      <div className="hosted-demo-keep-work">
        <HostedKeepWorkButton />
      </div>
      {status ? (
        <div className="hosted-status" data-testid="hosted-status" role="status">
          {status}
        </div>
      ) : null}
      {browserReadOpen ? (
        <BrowserWorkspaceReadPanel
          target={browserReadTarget}
          versionId={versionId}
          onClose={onBrowserReadClose}
        />
      ) : null}
      {shareOpen && shareTarget ? (
        <HostedShareDialog
          {...shareTarget}
          expectedAccountId={session.principal?.id}
          blockedReason={shareBlocked}
          onClose={onShareClose}
          onCreated={onShareCreated}
        />
      ) : null}
    </>
  );
}
