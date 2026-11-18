import { toUserMessage, userMessage } from '@waypoint/user-messages';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { platform } from '../../platform';
import { useAuthStore } from '../../stores/auth-store';
import { useSequenceEditModeStore } from '../../stores/sequence-edit-mode-store';
import { useToastStore } from '../../stores/toast-store';
import { confirmDialog } from '../../components/confirm-dialog-store';
import { OpenExternalIcon } from '../../components/icons';
import { Tooltip } from '../../shared/components/Tooltip';
import type { WorkspaceSyncCopyShareLinkOk } from '../../shared/workspace-sync-ipc';
import { copyPublishedShareLink } from '../../lib/copy-published-share-link';
import {
  SHARE_SNAPSHOT_CONFIRM_MESSAGE,
  SHARE_SNAPSHOT_CONFIRM_TITLE,
  SHARE_SNAPSHOT_EDIT_MODE_BLOCKED,
  SHARE_SNAPSHOT_SIGN_IN_REQUIRED,
  formatShareSnapshotSuccess,
} from './share-snapshot';

const ACTION_CLASS =
  'inline-flex h-6 w-6 items-center justify-center rounded-sm text-fg-muted transition-colors wp-interactive disabled:pointer-events-none disabled:opacity-40';

type SyncWorkspaceRow = { repo_uuid: string | null };
type SnapshotContext = { accountId: string; workspaceRootPath: string; workspaceUuid: string };

export function ShareSnapshotControl({ workspaceRootPath }: { workspaceRootPath: string | null }) {
  const authState = useAuthStore((s) => s.state);
  const signedIn = authState.status === 'signed-in';
  const signedInAccountId = signedIn ? authState.session.accountId : null;
  const editModeActive = useSequenceEditModeStore((s) => s.active);
  const addToast = useToastStore((s) => s.addToast);
  const lookupContext = useMemo(
    () => ({ accountId: signedInAccountId, workspaceRootPath }),
    [signedInAccountId, workspaceRootPath]
  );
  const currentLookup = useRef(lookupContext);
  currentLookup.current = lookupContext;
  const [workspaceBinding, setWorkspaceBinding] = useState<{
    context: typeof lookupContext;
    workspaceUuid: string;
  } | null>(null);
  const workspaceUuid =
    workspaceBinding?.context === lookupContext ? workspaceBinding.workspaceUuid : null;
  const context = useMemo<SnapshotContext | null>(() => {
    if (!signedInAccountId || !workspaceRootPath || !workspaceUuid || editModeActive) return null;
    return { accountId: signedInAccountId, workspaceRootPath, workspaceUuid };
  }, [signedInAccountId, workspaceRootPath, workspaceUuid, editModeActive]);
  const currentContext = useRef(context);
  currentContext.current = context;
  const pendingContext = useRef<SnapshotContext | null>(null);
  const [busyContext, setBusyContext] = useState<SnapshotContext | null>(null);
  const [published, setPublished] = useState<{
    context: SnapshotContext;
    result: WorkspaceSyncCopyShareLinkOk;
  } | null>(null);
  const retained = published && published.context === context ? published.result : null;
  const busy = context !== null && busyContext === context;

  useEffect(() => {
    currentContext.current = context;
    setPublished((value) => (value?.context === context ? value : null));
    return () => {
      if (currentContext.current === context) currentContext.current = null;
    };
  }, [context]);

  useEffect(() => {
    if (!lookupContext.workspaceRootPath || !lookupContext.accountId) {
      setWorkspaceBinding(null);
      return;
    }
    let cancelled = false;
    void platform()
      .db.select<SyncWorkspaceRow[]>(
        `SELECT repo_uuid
         FROM workspaces
         WHERE path = ?
           AND repo_uuid IS NOT NULL
         LIMIT 1`,
        [lookupContext.workspaceRootPath]
      )
      .then((rows) => {
        if (cancelled || currentLookup.current !== lookupContext) return;
        const uuid =
          rows.find((row) => typeof row.repo_uuid === 'string' && row.repo_uuid.length > 0)
            ?.repo_uuid ?? null;
        setWorkspaceBinding(uuid ? { context: lookupContext, workspaceUuid: uuid } : null);
      })
      .catch(() => {
        if (!cancelled && currentLookup.current === lookupContext) setWorkspaceBinding(null);
      });
    return () => {
      cancelled = true;
    };
  }, [lookupContext]);

  const disabledReason = !signedIn
    ? SHARE_SNAPSHOT_SIGN_IN_REQUIRED
    : editModeActive
      ? SHARE_SNAPSHOT_EDIT_MODE_BLOCKED
      : !workspaceUuid
        ? 'Open a managed project with cloud backup to share a snapshot.'
        : null;

  const onShare = useCallback(async () => {
    if (disabledReason) {
      addToast(toUserMessage(disabledReason, 'account.failed'), {
        definition: 'share-snapshot-disabled',
      });
      return;
    }
    if (!context || pendingContext.current === context) return;
    const activeContext = context;
    const isCurrent = () => currentContext.current === activeContext;
    pendingContext.current = activeContext;
    setBusyContext(activeContext);

    try {
      let result = retained;
      if (!result) {
        const confirmed = await confirmDialog({
          title: toUserMessage(SHARE_SNAPSHOT_CONFIRM_TITLE, 'operation.failedTitle'),
          message: toUserMessage(SHARE_SNAPSHOT_CONFIRM_MESSAGE, 'operation.confirm'),
          confirmLabel: userMessage('dialog.back-up-copy-link'),
          cancelLabel: userMessage('dialog.cancel'),
        });
        if (!confirmed || !isCurrent()) return;
        const publication = await platform().cloudSync.copyShareLink(activeContext.workspaceUuid);
        if (!isCurrent()) return;
        if (!publication.ok) {
          addToast(toUserMessage(publication, 'operation.failed'), {
            definition: 'share-snapshot-failed',
          });
          return;
        }
        result = publication;
        setPublished({ context: activeContext, result });
      }
      const copied = await copyPublishedShareLink({
        publication: result,
        isCurrent,
        writeText: (text) => platform().clipboard.writeText(text),
      });
      if (!isCurrent() || copied.kind === 'retired') return;
      if (copied.kind === 'copy-failed') {
        addToast(
          userMessage('notice.snapshot-published-but-copy-failed-use-copy-snapshot-link-to-retry'),
          {
            definition: 'share-snapshot-failed',
          }
        );
        return;
      }
      setPublished(null);
      addToast(
        toUserMessage(
          formatShareSnapshotSuccess({
            versionNumber: result.versionNumber,
            url: result.url,
          })
        ),
        { definition: 'share-snapshot-control-on-share' }
      );
    } catch (err) {
      if (!isCurrent()) return;
      addToast(toUserMessage(err, 'failure.could-not-share-snapshot'), {
        definition: 'share-snapshot-control-could-not-share-snapshot',
      });
    } finally {
      if (pendingContext.current === activeContext) pendingContext.current = null;
      if (isCurrent()) setBusyContext(null);
    }
  }, [addToast, disabledReason, context, retained]);

  if (!workspaceRootPath) return null;

  const label = busy
    ? retained
      ? 'Copying snapshot link…'
      : 'Sharing snapshot…'
    : retained
      ? 'Copy snapshot link'
      : 'Share snapshot';
  const title = disabledReason ?? label;

  return (
    <Tooltip content={toUserMessage(title, 'account.failed')} side="bottom">
      <button
        type="button"
        aria-label={label}
        title={toUserMessage(title, 'account.failed')}
        disabled={Boolean(disabledReason) || busy}
        data-testid="share-snapshot-button"
        data-share-disabled-reason={disabledReason ?? undefined}
        onClick={() => void onShare()}
        className={ACTION_CLASS}
      >
        <OpenExternalIcon className="h-4 w-4" />
      </button>
    </Tooltip>
  );
}
