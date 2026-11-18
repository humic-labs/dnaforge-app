import {
  withUserMessage,
  renderUserMessage,
  type UserMessageKey,
  type UserMessage,
  toUserMessage,
  userMessageWithValues,
  userMessageValue,
  userMessage,
} from '@waypoint/user-messages';
import { useEffect, useRef, useState } from 'react';
import { platform } from '../../platform';
import {
  deriveWorkspaceSyncStatus,
  type WorkspaceSyncStatus,
} from '../../shared/cloud-sync-status';
import type {
  WorkspaceSyncAccessListing,
  WorkspaceSyncActionError,
  WorkspaceSyncActionOk,
  WorkspaceSyncGrantRole,
  WorkspaceSyncMergeChoice,
  WorkspaceSyncMergeConflictView,
  WorkspaceSyncOrganizationSummary,
  WorkspaceSyncOwnerChoice,
  WorkspaceSyncProjectSummary,
  WorkspaceSyncUploadPreviewOk,
} from '../../shared/workspace-sync-ipc';
import { defaultOwnerChoice } from './SharedProjectOwnerPicker';
import { useSequenceEditModeStore } from '../../stores/sequence-edit-mode-store';
import { useToastStore } from '../../stores/toast-store';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { resolveActiveImportRoot } from '../workspace-loader/public/resolve-import-root';
import { confirmDialog } from '../../components/confirm-dialog-store';
import {
  CLOUD_BACKUP_SCOPE_DETAIL,
  describeWorkspaceSyncDisplay,
  type WorkspaceSyncDisplay,
} from './workspace-sync-display';
import {
  SHARE_SNAPSHOT_CONFIRM_MESSAGE,
  SHARE_SNAPSHOT_CONFIRM_TITLE,
  SHARE_SNAPSHOT_EDIT_MODE_BLOCKED,
  formatShareSnapshotCopyFailure,
  formatShareSnapshotSuccess,
} from './share-snapshot';
import { formatCloudSurfaceError } from './cloud-surface-error';

type SyncWorkspaceRow = { repo_uuid: string | null };
type OpenedSyncWorkspaceRow = { path: string; name: string };
export type SyncAction =
  | 'enable'
  | 'force'
  | 'share'
  | 'delete'
  | 'resolve-keep-local'
  | 'resolve-use-remote'
  | 'people'
  | 'reconcile'
  | 'resolve-merge'
  | 'recover'
  | 'selection';
export type ConflictResolution = 'keep_local' | 'use_remote';

function localOnlySyncStatus(): WorkspaceSyncStatus {
  return deriveWorkspaceSyncStatus({
    workspaceUuid: null,
    isManagedWorkspace: false,
    syncEnabled: false,
    remoteWorkspaceId: null,
    currentLocalHeadSha: null,
    latestAckedLocalHeadSha: null,
  });
}

export interface CloudWorkspaceControllerInput {
  menuOpen: boolean;

  signedIn: boolean;

  cloudSyncEnabled: boolean;

  onProjectOpened: () => void;
}

export interface CloudWorkspaceController {
  syncStatus: WorkspaceSyncStatus | null;
  syncWorkspaceUuid: string | null;
  syncDisplay: WorkspaceSyncDisplay;
  syncBusy: SyncAction | null;
  uploadPreview: WorkspaceSyncUploadPreviewOk | null;
  uploadPreviewError: string | null;
  syncedProjects: WorkspaceSyncProjectSummary[];
  syncedProjectsLoading: boolean;
  syncedProjectsError: string | null;
  openingRemoteWorkspaceId: string | null;

  commandInFlight: boolean;
  runAutoSyncAction: (action: SyncAction) => Promise<void>;
  runConflictResolution: (resolution: ConflictResolution) => Promise<void>;
  openSyncedProject: (project: WorkspaceSyncProjectSummary) => Promise<void>;
  recoverScientificDrafts: () => Promise<void>;
  saveSelectionRules: (rules: string) => Promise<void>;
  approveSelection: () => Promise<void>;

  organizations: WorkspaceSyncOrganizationSummary[];
  ownerChoice: WorkspaceSyncOwnerChoice;
  setOwnerChoice: (choice: WorkspaceSyncOwnerChoice) => void;
  access: WorkspaceSyncAccessListing | null;
  accessLoading: boolean;
  accessError: string | null;
  refreshAccess: () => Promise<void>;
  inviteCollaborator: (email: string, role: WorkspaceSyncGrantRole) => Promise<void>;
  changeAccess: (accountId: string, role: WorkspaceSyncGrantRole | null) => Promise<void>;
  setOrgAudience: (orgId: string, role: WorkspaceSyncGrantRole | null) => Promise<void>;
  revokeInvite: (inviteId: string) => Promise<void>;
  resendInvite: (inviteId: string) => Promise<void>;
  mergeConflict: WorkspaceSyncMergeConflictView | null;
  runReconcile: () => Promise<void>;
  resolveMergeConflict: (choices: Record<string, WorkspaceSyncMergeChoice>) => Promise<void>;
}

export function useCloudWorkspaceController(
  input: CloudWorkspaceControllerInput
): CloudWorkspaceController {
  const { menuOpen, signedIn, cloudSyncEnabled, onProjectOpened } = input;
  const folders = useWorkspaceStore((s) => s.folders);
  const selectedPath = useWorkspaceStore((s) => s.selectedPath);
  const addFolder = useWorkspaceStore((s) => s.addFolder);
  const revealPath = useWorkspaceStore((s) => s.revealPath);
  const addToast = useToastStore((s) => s.addToast);

  const [syncBusy, setSyncBusy] = useState<SyncAction | null>(null);
  const [syncWorkspaceUuid, setSyncWorkspaceUuid] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<WorkspaceSyncStatus | null>(null);
  const [syncedProjects, setSyncedProjects] = useState<WorkspaceSyncProjectSummary[]>([]);
  const [syncedProjectsLoading, setSyncedProjectsLoading] = useState(false);
  const [syncedProjectsError, setSyncedProjectsError] = useState<UserMessage | null>(null);
  const [openingRemoteWorkspaceId, setOpeningRemoteWorkspaceId] = useState<string | null>(null);
  const [uploadPreview, setUploadPreview] = useState<WorkspaceSyncUploadPreviewOk | null>(null);
  const [uploadPreviewError, setUploadPreviewError] = useState<UserMessage | null>(null);
  const [statusUnavailable, setStatusUnavailable] = useState(false);
  const [organizations, setOrganizations] = useState<WorkspaceSyncOrganizationSummary[]>([]);
  const [ownerChoice, setOwnerChoice] = useState<WorkspaceSyncOwnerChoice>({ kind: 'personal' });
  const organizationsLoadedRef = useRef(false);
  const [access, setAccess] = useState<WorkspaceSyncAccessListing | null>(null);
  const [accessLoading, setAccessLoading] = useState(false);
  const [accessError, setAccessError] = useState<UserMessage | null>(null);
  const [mergeConflict, setMergeConflict] = useState<WorkspaceSyncMergeConflictView | null>(null);

  const currentWorkspaceUuidRef = useRef<string | null>(null);
  const commandInFlightRef = useRef<symbol | null>(null);
  function applySyncWorkspaceUuid(next: string | null): void {
    if (currentWorkspaceUuidRef.current !== next) {
      commandInFlightRef.current = null;
      setSyncBusy(null);
      setOpeningRemoteWorkspaceId(null);
    }
    currentWorkspaceUuidRef.current = next;
    setSyncWorkspaceUuid(next);
  }

  function beginCommand(): symbol | null {
    if (commandInFlightRef.current !== null) return null;
    const command = Symbol('cloud-command');
    commandInFlightRef.current = command;
    return command;
  }

  function isCurrentCommand(command: symbol): boolean {
    return commandInFlightRef.current === command;
  }

  function finishCommand(command: symbol): void {
    if (!isCurrentCommand(command)) return;
    commandInFlightRef.current = null;
    setSyncBusy(null);
    setOpeningRemoteWorkspaceId(null);
  }

  const active = menuOpen && signedIn && cloudSyncEnabled;

  const workspaceRootPath = resolveActiveImportRoot({ folders, selectedPath });
  const syncDisplay = describeWorkspaceSyncDisplay({
    signedIn,
    status: syncStatus,
    statusUnavailable,
  });

  const commandInFlight = syncBusy !== null || openingRemoteWorkspaceId !== null;

  function reportWorkspaceOpened(workspaceName: string, warnings?: readonly UserMessage[]): void {
    if (!warnings || warnings.length === 0) {
      addToast(
        userMessageWithValues('notice.opened-value', { value0: userMessageValue(workspaceName) }),
        {
          definition: 'use-cloud-workspace-controller-opened-example',
        }
      );
      return;
    }
    for (const warning of warnings)
      addToast(
        toUserMessage(warning, 'notice.the-cloud-project-is-open-but-an-item-needs-attention'),
        { definition: 'cloud-project-warning' }
      );
  }

  useEffect(() => {
    if (active) return;
    commandInFlightRef.current = null;
    setSyncBusy(null);
    setOpeningRemoteWorkspaceId(null);
    setStatusUnavailable(false);
  }, [active]);

  useEffect(() => {
    if (!active || !workspaceRootPath) {
      applySyncWorkspaceUuid(null);
      setSyncStatus(null);
      return;
    }

    let cancelled = false;
    applySyncWorkspaceUuid(null);
    setSyncStatus(localOnlySyncStatus());
    setStatusUnavailable(false);

    void platform()
      .db.select<SyncWorkspaceRow[]>(
        `SELECT repo_uuid
         FROM workspaces
         WHERE path = ?
           AND repo_uuid IS NOT NULL
         LIMIT 1`,
        [workspaceRootPath]
      )
      .then((rows) => {
        if (cancelled) return;
        const repoUuid =
          rows.find((row) => typeof row.repo_uuid === 'string' && row.repo_uuid.length > 0)
            ?.repo_uuid ?? null;
        applySyncWorkspaceUuid(repoUuid);
        if (!repoUuid) setSyncStatus(localOnlySyncStatus());
      })
      .catch((err) => {
        if (cancelled) return;
        applySyncWorkspaceUuid(null);
        setSyncStatus(null);
        setStatusUnavailable(true);
        addToast(
          renderUserMessage(formatCloudSurfaceError(err, 'notice.could-not-load-sync-status')),
          {
            definition: 'use-cloud-workspace-controller-could-not-load-sync-status',
          }
        );
      });

    return () => {
      cancelled = true;
    };
  }, [active, addToast, workspaceRootPath]);

  useEffect(() => {
    if (!active || !syncWorkspaceUuid) return;

    let cancelled = false;
    const bridge = platform().cloudSync;
    const unsubscribe = bridge.subscribeStatus(syncWorkspaceUuid, (event) => {
      if (!cancelled && event.workspaceUuid === syncWorkspaceUuid) {
        setSyncStatus(event.status);
        setStatusUnavailable(false);
      }
    });

    void bridge
      .getStatus(syncWorkspaceUuid)
      .then((status) => {
        if (!cancelled) {
          setSyncStatus(status);
          setStatusUnavailable(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setStatusUnavailable(true);
          addToast(
            renderUserMessage(formatCloudSurfaceError(err, 'notice.could-not-load-sync-status')),
            {
              definition: 'use-cloud-workspace-controller-could-not-load-sync-status',
            }
          );
        }
      });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [active, addToast, syncWorkspaceUuid]);

  useEffect(() => {
    if (!active || !syncWorkspaceUuid) {
      setUploadPreview(null);
      setUploadPreviewError(null);
      return;
    }

    let cancelled = false;
    setUploadPreview(null);
    setUploadPreviewError(null);
    void platform()
      .cloudSync.previewUpload(syncWorkspaceUuid, { owner: ownerChoice })
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          setUploadPreview(null);
          setUploadPreviewError(toUserMessage(result, 'account.failed'));
          return;
        }
        setUploadPreview(result);
        setUploadPreviewError(null);
      })
      .catch((err) => {
        if (!cancelled) {
          setUploadPreview(null);
          setUploadPreviewError(
            renderUserMessage(
              formatCloudSurfaceError(err, 'failure.could-not-preview-cloud-backup-contents')
            )
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [active, syncWorkspaceUuid, ownerChoice]);

  useEffect(() => {
    if (!active) {
      setSyncedProjects([]);
      setSyncedProjectsError(null);
      setSyncedProjectsLoading(false);
      return;
    }

    let cancelled = false;
    setSyncedProjectsLoading(true);
    setSyncedProjectsError(null);

    void platform()
      .cloudSync.listSyncedProjects()
      .then((projects) => {
        if (!cancelled) setSyncedProjects(projects);
      })
      .catch((err) => {
        if (!cancelled) {
          setSyncedProjects([]);
          setSyncedProjectsError(
            renderUserMessage(formatCloudSurfaceError(err, 'failure.could-not-load-cloud-projects'))
          );
        }
      })
      .finally(() => {
        if (!cancelled) setSyncedProjectsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [active]);

  useEffect(() => {
    if (!active) {
      setOrganizations([]);
      organizationsLoadedRef.current = false;
      return;
    }
    let cancelled = false;
    void platform()
      .cloudSync.listOrganizations()
      .then((result) => {
        if (cancelled) return;
        const list = result.ok ? result.organizations : [];
        setOrganizations(list);
        setOwnerChoice(defaultOwnerChoice(list));
        organizationsLoadedRef.current = true;
      })
      .catch(() => {
        if (!cancelled) {
          setOrganizations([]);
          organizationsLoadedRef.current = true;
        }
      });
    return () => {
      cancelled = true;
    };
  }, [active]);

  const remoteBound = Boolean(
    syncStatus &&
    syncStatus.workspaceUuid &&
    !syncStatus.blockers.includes('missing_remote_binding')
  );
  const conflictPending = syncStatus?.syncAxis === 'conflict';

  useEffect(() => {
    if (!active || !syncWorkspaceUuid || !remoteBound) {
      setAccess(null);
      setAccessError(null);
      setAccessLoading(false);
      setMergeConflict(null);
      return;
    }
    let cancelled = false;
    setAccessLoading(true);
    void platform()
      .cloudSync.listAccess(syncWorkspaceUuid)
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setAccess(result.listing);
          setAccessError(null);
        } else {
          setAccess(null);
          setAccessError(toUserMessage(result, 'account.failed'));
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setAccess(null);
          setAccessError(
            renderUserMessage(formatCloudSurfaceError(err, 'failure.could-not-load-who-has-access'))
          );
        }
      })
      .finally(() => {
        if (!cancelled) setAccessLoading(false);
      });
    void platform()
      .cloudSync.getMergeConflict(syncWorkspaceUuid)
      .then((result) => {
        if (!cancelled) setMergeConflict(result.ok ? result.conflict : null);
      })
      .catch(() => {
        if (!cancelled) setMergeConflict(null);
      });
    return () => {
      cancelled = true;
    };
  }, [active, syncWorkspaceUuid, remoteBound, conflictPending]);

  async function refreshAccess(command?: symbol): Promise<void> {
    if (!syncWorkspaceUuid || (command !== undefined && !isCurrentCommand(command))) return;
    setAccessLoading(true);
    try {
      const result = await platform().cloudSync.listAccess(syncWorkspaceUuid);
      if (
        syncWorkspaceUuid !== currentWorkspaceUuidRef.current ||
        (command !== undefined && !isCurrentCommand(command))
      )
        return;
      if (result.ok) {
        setAccess(result.listing);
        setAccessError(null);
      } else {
        setAccessError(toUserMessage(result, 'account.failed'));
      }
    } catch (err) {
      if (command !== undefined && !isCurrentCommand(command)) return;
      setAccessError(
        renderUserMessage(formatCloudSurfaceError(err, 'failure.could-not-load-who-has-access'))
      );
    } finally {
      if (command === undefined || isCurrentCommand(command)) setAccessLoading(false);
    }
  }

  async function runPeopleCommand<T extends WorkspaceSyncActionOk>(
    failureKey: UserMessageKey,
    operation: () => Promise<T | WorkspaceSyncActionError>,
    successMessage: (result: T) => UserMessage
  ): Promise<void> {
    if (!syncWorkspaceUuid) return;
    if (commandInFlightRef.current) return;
    const command = beginCommand();
    if (command === null) return;
    try {
      setSyncBusy('people');
      const result = await operation();
      if (!isCurrentCommand(command)) return;
      if (!result.ok) {
        reportSyncActionFailure(result);
        return;
      }
      addToast(renderUserMessage(successMessage(result)), { definition: 'cloud-action-completed' });
      await refreshAccess(command);
    } catch (err) {
      if (!isCurrentCommand(command)) return;
      addToast(renderUserMessage(formatCloudSurfaceError(err, failureKey)), {
        definition: 'cloud-action-failed',
      });
    } finally {
      finishCommand(command);
    }
  }

  async function inviteCollaborator(email: string, role: WorkspaceSyncGrantRole): Promise<void> {
    const uuid = syncWorkspaceUuid;
    if (!uuid) return;
    await runPeopleCommand(
      'sharing.invitationUnconfirmed',
      () => platform().cloudSync.inviteCollaborator(uuid, { email, role }),
      (result) => {
        if (result.emailSent)
          return userMessageWithValues('sharing.people.invitation-sent-to-value0', {
            value0: userMessageValue(email),
          });
        if (result.emailDeliveryStatus === 'pending' || result.emailDeliveryStatus === 'retrying') {
          return userMessageWithValues(
            'sharing.people.invitation-saved-for-value0-email-delivery-is-queued-and-will-retry-automatically',
            { value0: userMessageValue(email) }
          );
        }
        if (result.emailDeliveryStatus === 'uncertain') {
          return userMessageWithValues(
            'sharing.people.invitation-saved-for-value0-email-delivery-could-not-be-confirmed-you-can-share-the-invitation-link',
            { value0: userMessageValue(email) }
          );
        }
        const url = result.acceptUrl;
        if (url && navigator.clipboard?.writeText) {
          void navigator.clipboard.writeText(url).catch(() => undefined);
          return userMessageWithValues(
            'sharing.people.invitation-saved-for-value0-email-could-not-be-sent-so-the-invite-link-was-copied-for-you-to-share',
            { value0: userMessageValue(email) }
          );
        }
        return userMessageWithValues(
          'sharing.people.invitation-saved-for-value0-but-the-email-could-not-be-sent',
          { value0: userMessageValue(email) }
        );
      }
    );
  }

  async function changeAccess(
    accountId: string,
    role: WorkspaceSyncGrantRole | null
  ): Promise<void> {
    const uuid = syncWorkspaceUuid;
    if (!uuid) return;
    if (role === null) {
      const confirmed = await confirmDialog({
        title: userMessage('dialog.remove-access'),
        message: userMessage(
          'dialog.they-will-no-longer-be-able-to-open-or-change-this-project-through-dna'
        ),
        confirmLabel: userMessage('dialog.remove-access-other'),
        cancelLabel: userMessage('dialog.cancel'),
      });
      if (!confirmed) return;
    }
    await runPeopleCommand(
      'sharing.accessUnconfirmed',
      () => platform().cloudSync.setAccess(uuid, { subject: { kind: 'account', accountId }, role }),
      (result) =>
        result.status === 'revoked'
          ? userMessage('sharing.people.access-removed')
          : result.status === 'unchanged'
            ? userMessage('sharing.people.access-unchanged')
            : userMessage('sharing.people.access-updated')
    );
  }

  async function setOrgAudience(orgId: string, role: WorkspaceSyncGrantRole | null): Promise<void> {
    const uuid = syncWorkspaceUuid;
    if (!uuid) return;
    await runPeopleCommand(
      'sharing.accessUnconfirmed',
      () => platform().cloudSync.setAccess(uuid, { subject: { kind: 'org', orgId }, role }),
      (result) =>
        result.status === 'revoked'
          ? userMessage(
              'sharing.people.organization-wide-access-removed-people-with-their-own-invitation-keep-access'
            )
          : result.status === 'unchanged'
            ? userMessage('sharing.people.organization-wide-access-unchanged')
            : userMessage('sharing.people.everyone-in-the-organization-can-now-open-this-project')
    );
  }

  async function revokeInvite(inviteId: string): Promise<void> {
    const uuid = syncWorkspaceUuid;
    if (!uuid) return;
    await runPeopleCommand(
      'sharing.revokeUnconfirmed',
      () => platform().cloudSync.revokeInvite(uuid, inviteId),
      () => userMessage('sharing.people.invitation-revoked')
    );
  }

  async function resendInvite(inviteId: string): Promise<void> {
    const uuid = syncWorkspaceUuid;
    if (!uuid) return;
    await runPeopleCommand(
      'sharing.resendUnconfirmed',
      () => platform().cloudSync.resendInvite(uuid, inviteId),
      (result) =>
        result.emailSent
          ? userMessageWithValues('sharing.people.invitation-resent-to-value0', {
              value0: userMessageValue(result.email),
            })
          : result.emailDeliveryStatus === 'pending' || result.emailDeliveryStatus === 'retrying'
            ? userMessageWithValues(
                'sharing.people.a-fresh-invitation-was-created-for-value0-email-delivery-is-queued-and-will-retry-automatically',
                { value0: userMessageValue(result.email) }
              )
            : result.emailDeliveryStatus === 'uncertain'
              ? userMessage(
                  'sharing.people.a-fresh-invitation-was-created-email-delivery-could-not-be-confirmed-you-can-share-the-invitation-li'
                )
              : userMessage(
                  'sharing.people.a-fresh-invitation-was-created-but-the-email-could-not-be-sent'
                )
    );
  }

  async function runReconcile(): Promise<void> {
    const uuid = syncWorkspaceUuid;
    if (!uuid) return;
    if (commandInFlightRef.current) return;
    const command = beginCommand();
    if (command === null) return;
    try {
      setSyncBusy('reconcile');
      const result = await platform().cloudSync.reconcile(uuid);
      if (!isCurrentCommand(command)) return;
      if (!result.ok) {
        reportSyncActionFailure(result);
        return;
      }
      if (result.outcome === 'conflicts') {
        setMergeConflict(result.conflict);
        addToast(userMessage('notice.some-items-need-your-decision-before-they-can-sync'), {
          definition:
            'use-cloud-workspace-controller-some-items-need-your-decision-before-they-can-sync',
        });
      } else if (result.outcome === 'merged') {
        setMergeConflict(null);
        addToast(
          userMessageWithValues('notice.combined-changes-from-value-with-yours-syncing-now', {
            value0: userMessageValue(result.remoteAuthor ?? 'a collaborator'),
          }),
          {
            definition:
              'use-cloud-workspace-controller-combined-changes-from-example-with-yours-syncing-now',
          }
        );
      } else {
        setMergeConflict(null);
        addToast(userMessage('notice.nothing-new-to-combine-syncing-now'), {
          definition: 'use-cloud-workspace-controller-nothing-new-to-combine-syncing-now',
        });
      }
      await refreshSyncStatus(uuid, command);
    } catch (err) {
      if (!isCurrentCommand(command)) return;
      addToast(
        renderUserMessage(formatCloudSurfaceError(err, 'notice.could-not-combine-changes')),
        {
          definition: 'use-cloud-workspace-controller-could-not-combine-changes',
        }
      );
    } finally {
      finishCommand(command);
    }
  }

  async function resolveMergeConflict(
    choices: Record<string, WorkspaceSyncMergeChoice>
  ): Promise<void> {
    const uuid = syncWorkspaceUuid;
    const conflict = mergeConflict;
    if (!uuid || !conflict) return;
    if (commandInFlightRef.current) return;
    const command = beginCommand();
    if (command === null) return;
    try {
      setSyncBusy('resolve-merge');
      const result = await platform().cloudSync.resolveMergeConflict(uuid, {
        conflictId: conflict.conflictId,
        choices,
      });
      if (!isCurrentCommand(command)) return;
      if (!result.ok) {
        reportSyncActionFailure(result);
        return;
      }
      if (result.outcome === 'conflicts') {
        setMergeConflict(result.conflict);
        addToast(
          userMessage(
            'notice.a-newer-shared-version-arrived-while-you-were-choosing-a-few-items-sti'
          ),
          {
            definition:
              'use-cloud-workspace-controller-a-newer-shared-version-arrived-while-you-were-choosing-a-few-items-still-need',
          }
        );
      } else {
        setMergeConflict(null);
        addToast(userMessage('notice.your-choices-were-applied-syncing-now'), {
          definition: 'use-cloud-workspace-controller-your-choices-were-applied-syncing-now',
        });
      }
      await refreshSyncStatus(uuid, command);
    } catch (err) {
      if (!isCurrentCommand(command)) return;
      addToast(
        renderUserMessage(formatCloudSurfaceError(err, 'notice.could-not-apply-your-choices')),
        {
          definition: 'use-cloud-workspace-controller-could-not-apply-your-choices',
        }
      );
    } finally {
      finishCommand(command);
    }
  }

  async function refreshSyncStatus(workspaceUuid: string, command: symbol): Promise<void> {
    if (!isCurrentCommand(command)) return;
    const status = await platform().cloudSync.getStatus(workspaceUuid);

    // flow awaits a user confirmation dialog, and a background reconcile/import

    if (!isCurrentCommand(command) || workspaceUuid !== currentWorkspaceUuidRef.current) return;
    setSyncStatus(status);
  }

  async function updateSelection(
    kind: 'save-rules' | 'approve',
    rootGitignore?: string
  ): Promise<void> {
    const workspaceUuid = syncWorkspaceUuid;
    const selection = uploadPreview?.selection;
    if (!workspaceUuid || !selection) return;
    const command = beginCommand();
    if (command === null) return;
    setSyncBusy('selection');
    try {
      const request =
        kind === 'save-rules'
          ? ({
              kind,
              expectedRevision: selection.revision,
              rootGitignore: rootGitignore ?? '',
            } as const)
          : ({ kind, expectedRevision: selection.revision } as const);
      const result = await platform().cloudSync.updateSelection(workspaceUuid, request, {
        owner: ownerChoice,
      });
      if (!isCurrentCommand(command)) return;
      if (!result.ok) {
        setUploadPreviewError(toUserMessage(result, 'account.failed'));
        const refreshed = await platform().cloudSync.previewUpload(workspaceUuid, {
          owner: ownerChoice,
        });
        if (isCurrentCommand(command) && refreshed.ok) setUploadPreview(refreshed);
        return;
      }
      setUploadPreview(result);
      setUploadPreviewError(null);
      if (
        kind === 'approve' &&
        syncStatus &&
        syncStatus.syncAxis !== 'local_only' &&
        !syncStatus.blockers.includes('sync_disabled')
      ) {
        await refreshSyncStatus(workspaceUuid, command);
        const refreshed = await platform().cloudSync.previewUpload(workspaceUuid, {
          owner: ownerChoice,
        });
        if (isCurrentCommand(command) && refreshed.ok) setUploadPreview(refreshed);
      }
    } catch (error) {
      if (isCurrentCommand(command))
        setUploadPreviewError(
          renderUserMessage(formatCloudSurfaceError(error, 'notice.sync-action-failed'))
        );
    } finally {
      finishCommand(command);
    }
  }

  async function runAutoSyncAction(action: SyncAction): Promise<void> {
    if (!syncWorkspaceUuid) return;
    if (commandInFlightRef.current) return;
    if (
      action === 'enable' &&
      !window.confirm(`Enable cloud backup for this project?\n\n${CLOUD_BACKUP_SCOPE_DETAIL}`)
    ) {
      return;
    }
    if (
      action === 'delete' &&
      !window.confirm(
        'Remove the cloud copy for this project? Local files stay on this device, share links stop working, and cloud backup will pause.'
      )
    ) {
      return;
    }

    const command = beginCommand();
    if (command === null) return;
    try {
      setSyncBusy(action);

      if (action === 'delete') {
        const result = await platform().cloudSync.deleteCloudCopy(syncWorkspaceUuid);
        if (!isCurrentCommand(command)) return;
        if (!result.ok) {
          reportSyncActionFailure(result);
          return;
        }
        addToast(userMessage('notice.cloud-copy-removed-this-project-is-now-local-only'), {
          definition:
            'use-cloud-workspace-controller-cloud-copy-removed-this-project-is-now-local-only',
        });
        await refreshSyncStatus(syncWorkspaceUuid, command);
        return;
      }

      if (action === 'share') {
        if (useSequenceEditModeStore.getState().active) {
          addToast(toUserMessage(SHARE_SNAPSHOT_EDIT_MODE_BLOCKED), {
            definition: 'share-snapshot-edit-blocked',
          });
          return;
        }
        const confirmed = await confirmDialog({
          title: toUserMessage(SHARE_SNAPSHOT_CONFIRM_TITLE, 'operation.failedTitle'),
          message: toUserMessage(SHARE_SNAPSHOT_CONFIRM_MESSAGE, 'operation.confirm'),
          confirmLabel: userMessage('dialog.back-up-copy-link'),
          cancelLabel: userMessage('dialog.cancel'),
        });
        if (!confirmed || !isCurrentCommand(command)) return;
        const result = await platform().cloudSync.copyShareLink(syncWorkspaceUuid);
        if (!isCurrentCommand(command)) return;
        if (!result.ok) {
          reportSyncActionFailure(result);
          return;
        }

        let copied = false;
        try {
          await platform().clipboard.writeText(result.url);
          copied = true;
        } catch {
          copied = false;
        }
        if (!isCurrentCommand(command)) return;
        addToast(
          copied
            ? toUserMessage(
                formatShareSnapshotSuccess({
                  versionNumber: result.versionNumber,
                  url: result.url,
                })
              )
            : toUserMessage(
                formatShareSnapshotCopyFailure({
                  versionNumber: result.versionNumber,
                  url: result.url,
                })
              ),
          { definition: 'cloud-share-result', variant: copied ? 'success' : 'warning' }
        );
        await refreshSyncStatus(syncWorkspaceUuid, command);
        return;
      }

      let orgs = organizations;
      let choice = ownerChoice;
      if (action === 'enable' && !organizationsLoadedRef.current) {
        const listed = await platform().cloudSync.listOrganizations();
        if (!isCurrentCommand(command)) return;
        orgs = listed.ok ? listed.organizations : [];
        setOrganizations(orgs);
        choice = defaultOwnerChoice(orgs);
        setOwnerChoice(choice);
        organizationsLoadedRef.current = true;
      }
      const owner = choice;
      const result =
        action === 'enable'
          ? await platform().cloudSync.setEnabled(syncWorkspaceUuid, true, {
              owner,
              selectionRevision: uploadPreview?.selection?.revision,
            })
          : await platform().cloudSync.forceSync(syncWorkspaceUuid);
      if (!isCurrentCommand(command)) return;
      if (!result.ok) {
        reportSyncActionFailure(result);
        return;
      }
      addToast(
        action === 'enable'
          ? owner.kind === 'org'
            ? userMessage('notice.sync-enabled-this-project-is-managed-by-your-organization')
            : userMessage('notice.sync-enabled')
          : userMessage('notice.sync-requested'),
        { definition: 'use-cloud-workspace-controller-sync-requested' }
      );
      await refreshSyncStatus(syncWorkspaceUuid, command);
      const refreshed = await platform().cloudSync.previewUpload(syncWorkspaceUuid, { owner });
      if (isCurrentCommand(command) && refreshed.ok) setUploadPreview(refreshed);
    } catch (err) {
      if (!isCurrentCommand(command)) return;
      addToast(renderUserMessage(formatCloudSurfaceError(err, 'notice.sync-action-failed')), {
        definition: 'use-cloud-workspace-controller-sync-action-failed',
      });
    } finally {
      finishCommand(command);
    }
  }

  async function runConflictResolution(resolution: ConflictResolution): Promise<void> {
    if (!syncWorkspaceUuid) return;
    if (commandInFlightRef.current) return;
    if (
      resolution === 'keep_local' &&
      !window.confirm('Upload local changes as the new cloud version?')
    ) {
      return;
    }

    let serverResolved = false;
    const command = beginCommand();
    if (command === null) return;
    try {
      setSyncBusy(resolution === 'keep_local' ? 'resolve-keep-local' : 'resolve-use-remote');
      const result = await platform().cloudSync.resolveConflict(syncWorkspaceUuid, resolution);
      if (!isCurrentCommand(command)) return;
      if (!result.ok) {
        reportSyncActionFailure(result);
        return;
      }
      serverResolved = true;

      if (resolution === 'use_remote' && result.workspaceUuid) {
        const rows = await platform().db.select<OpenedSyncWorkspaceRow[]>(
          `SELECT path, name
           FROM workspaces
           WHERE repo_uuid = ?
           LIMIT 1`,
          [result.workspaceUuid]
        );
        if (!isCurrentCommand(command)) return;
        const workspace = rows.find(
          (row) => typeof row.path === 'string' && typeof row.name === 'string'
        );
        if (!workspace) {
          throw withUserMessage(
            new Error('Cloud project opened but the local project record was not found.'),
            'validation.compatible.19'
          );
        }
        addFolder(workspace.path, workspace.name);
        revealPath(workspace.path);
        reportWorkspaceOpened(workspace.name, result.warnings);
        onProjectOpened();
        return;
      }

      addToast(userMessage('notice.local-changes-queued-for-backup'), {
        definition: 'use-cloud-workspace-controller-local-changes-queued-for-backup',
      });
      await refreshSyncStatus(syncWorkspaceUuid, command);
    } catch (err) {
      if (!isCurrentCommand(command)) return;
      addToast(
        renderUserMessage(formatCloudSurfaceError(err, 'notice.conflict-resolution-failed')),
        {
          definition: 'use-cloud-workspace-controller-conflict-resolution-failed',
        }
      );
      if (serverResolved) {
        await refreshSyncStatus(syncWorkspaceUuid, command).catch(() => undefined);
      }
    } finally {
      finishCommand(command);
    }
  }

  async function openSyncedProject(project: WorkspaceSyncProjectSummary): Promise<void> {
    if (commandInFlightRef.current) return;
    const command = beginCommand();
    if (command === null) return;
    try {
      setOpeningRemoteWorkspaceId(project.remoteWorkspaceId);
      const result = await platform().cloudSync.openSyncedProject(project.remoteWorkspaceId);
      if (!isCurrentCommand(command)) return;
      if (!result.ok) {
        reportSyncActionFailure(result);
        return;
      }
      const rows = await platform().db.select<OpenedSyncWorkspaceRow[]>(
        `SELECT path, name
         FROM workspaces
         WHERE repo_uuid = ?
         LIMIT 1`,
        [result.workspaceUuid]
      );
      if (!isCurrentCommand(command)) return;
      const workspace = rows.find(
        (row) => typeof row.path === 'string' && typeof row.name === 'string'
      );
      if (!workspace) {
        throw withUserMessage(
          new Error('Cloud project opened but the local project record was not found.'),
          'validation.compatible.19'
        );
      }
      addFolder(workspace.path, workspace.name);
      revealPath(workspace.path);
      reportWorkspaceOpened(workspace.name, result.warnings);
      onProjectOpened();
    } catch (err) {
      if (!isCurrentCommand(command)) return;
      addToast(
        renderUserMessage(formatCloudSurfaceError(err, 'notice.could-not-open-cloud-project')),
        {
          definition: 'use-cloud-workspace-controller-could-not-open-cloud-project',
        }
      );
    } finally {
      finishCommand(command);
    }
  }

  async function recoverScientificDrafts(): Promise<void> {
    const uuid = syncWorkspaceUuid;
    const candidate = syncStatus?.recoveryCandidate;
    if (
      !uuid ||
      candidate?.representation !== 'scientific_manifest_v1' ||
      commandInFlightRef.current
    )
      return;
    const confirmed = await confirmDialog({
      title: userMessage('dialog.recover-saved-history-and-drafts'),
      message: userMessage(
        'dialog.create-a-separate-recovery-profile-with-the-accepted-scientific-histor'
      ),
      confirmLabel: userMessage('dialog.recover'),
    });
    if (!confirmed || uuid !== currentWorkspaceUuidRef.current) return;
    const command = beginCommand();
    if (command === null) return;
    try {
      setSyncBusy('recover');
      const result = await platform().cloudSync.recoverScientificDrafts(
        uuid,
        candidate.candidateId
      );
      if (!isCurrentCommand(command)) return;
      if (!result.ok) {
        reportSyncActionFailure(result);
        return;
      }
      addToast(
        userMessageWithValues(
          'notice.recovered-accepted-history-in-a-separate-profile-at-value-opening-inst',
          {
            value0: userMessageValue(result.profilePath),
            value1: userMessageValue(result.changedDraftFiles),
            value2: userMessageValue(result.draftsPath),
            value3: userMessageValue(
              result.coverage === 'incomplete'
                ? ' This capture omitted some files; see the recovery report.'
                : ''
            ),
          }
        ),
        { definition: 'scientific-cloud-recovery-complete' }
      );
    } catch (error) {
      if (!isCurrentCommand(command)) return;
      addToast(
        renderUserMessage(
          formatCloudSurfaceError(error, 'notice.could-not-recover-scientific-history')
        ),
        {
          definition: 'scientific-cloud-recovery-failed',
        }
      );
    } finally {
      finishCommand(command);
    }
  }

  function reportSyncActionFailure(result: WorkspaceSyncActionError): void {
    const message: UserMessage =
      result.code === 'NOT_IMPLEMENTED'
        ? userMessage('failure.cloud-backup-action-is-not-available-yet')
        : formatCloudSurfaceError(result, 'notice.the-cloud-operation-failed');
    addToast(message, {
      definition: 'cloud-backup-result',
      variant: result.code === 'NOT_IMPLEMENTED' ? 'info' : 'error',
    });
  }

  return {
    syncStatus,
    syncWorkspaceUuid,
    syncDisplay,
    syncBusy,
    uploadPreview,
    uploadPreviewError,
    syncedProjects,
    syncedProjectsLoading,
    syncedProjectsError,
    openingRemoteWorkspaceId,
    commandInFlight,
    runAutoSyncAction,
    runConflictResolution,
    openSyncedProject,
    recoverScientificDrafts,
    saveSelectionRules: (rules) => updateSelection('save-rules', rules),
    approveSelection: () => updateSelection('approve'),
    organizations,
    ownerChoice,
    setOwnerChoice,
    access,
    accessLoading,
    accessError,
    refreshAccess,
    inviteCollaborator,
    changeAccess,
    setOrgAudience,
    revokeInvite,
    resendInvite,
    mergeConflict,
    runReconcile,
    resolveMergeConflict,
  };
}

type ActiveSyncWorkspaceRow = { repo_uuid: string | null };

export function useActiveWorkspaceSyncStatus(enabled: boolean): WorkspaceSyncStatus | null {
  const folders = useWorkspaceStore((s) => s.folders);
  const selectedPath = useWorkspaceStore((s) => s.selectedPath);
  const rootPath = resolveActiveImportRoot({ folders, selectedPath });
  const [workspaceUuid, setWorkspaceUuid] = useState<string | null>(null);
  const [status, setStatus] = useState<WorkspaceSyncStatus | null>(null);

  useEffect(() => {
    if (!enabled || !rootPath) {
      setWorkspaceUuid(null);
      setStatus(null);
      return;
    }
    let cancelled = false;
    void platform()
      .db.select<ActiveSyncWorkspaceRow[]>(
        `SELECT repo_uuid FROM workspaces WHERE path = ? AND repo_uuid IS NOT NULL LIMIT 1`,
        [rootPath]
      )
      .then((rows) => {
        if (cancelled) return;
        setWorkspaceUuid(rows.find((row) => row.repo_uuid)?.repo_uuid ?? null);
      })
      .catch(() => {
        if (!cancelled) setWorkspaceUuid(null);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, rootPath]);

  useEffect(() => {
    if (!enabled || !workspaceUuid) {
      setStatus(null);
      return;
    }
    let cancelled = false;
    const bridge = platform().cloudSync;
    const unsubscribe = bridge.subscribeStatus(workspaceUuid, (event) => {
      if (!cancelled && event.workspaceUuid === workspaceUuid) setStatus(event.status);
    });
    void bridge
      .getStatus(workspaceUuid)
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [enabled, workspaceUuid]);

  return status;
}
