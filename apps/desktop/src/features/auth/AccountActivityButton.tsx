import { ActionMenu, type ActionMenuEntry } from '../../components/ActionMenu';
import { INTERACTION_CLASS, MenuSeparator } from '@waypoint/ui-components';
import { useEffect, useRef, useState } from 'react';
import { useAuthStore } from '../../stores/auth-store';
import { CloudBackupModal } from './CloudBackupModal';
import {
  openAccountSettings,
  openCloudSurface,
  openOrganizationsSettings,
  subscribeCloudSurface,
  subscribeProjectSharing,
  subscribeSettingsEntry,
} from './cloud-surface-store';
import { rendererAvatarSrc } from '../../shared/renderer-avatar';
import { useDesktopSignInEnabled } from './useDesktopSignInEnabled';
import { useWorkspaceCloudSyncEnabled } from './useWorkspaceCloudSyncEnabled';
import { useCloudWorkspaceController } from './useCloudWorkspaceController';
import { CloudWorkspacePanel } from './CloudWorkspacePanel';
import { CloudProjectList } from './CloudProjectList';
import { SharedProjectPeoplePanel } from './SharedProjectPeoplePanel';

function ProfileIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20a8 8 0 0 1 16 0" />
    </svg>
  );
}

export function AccountActivityButton() {
  const enabled = useDesktopSignInEnabled();
  const cloudSyncEnabled = useWorkspaceCloudSyncEnabled();
  const state = useAuthStore((s) => s.state);
  const init = useAuthStore((s) => s.init);
  const startSignIn = useAuthStore((s) => s.startSignIn);
  const signOut = useAuthStore((s) => s.signOut);
  const [menuOpen, setMenuOpen] = useState(false);
  const [cloudModalOpen, setCloudModalOpen] = useState(false);
  const [projectSharingOpen, setProjectSharingOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const signedIn = state.status === 'signed-in';
  const session = state.status === 'signed-in' ? state.session : null;
  const busy =
    state.status === 'starting' ||
    state.status === 'awaiting-confirmation' ||
    state.status === 'exchanging';
  const identity = signedIn
    ? (session?.email ?? session?.displayName ?? 'Signed in')
    : 'Not signed in';
  const avatarUrl = rendererAvatarSrc(session?.avatarUrl);

  const cloud = useCloudWorkspaceController({
    menuOpen: cloudModalOpen || projectSharingOpen,
    signedIn,
    cloudSyncEnabled,
    onProjectOpened: () => {
      setCloudModalOpen(false);
      setProjectSharingOpen(false);
    },
  });
  const remoteBound = Boolean(
    cloud.syncStatus?.workspaceUuid && !cloud.syncStatus.blockers.includes('missing_remote_binding')
  );
  const showCloudSurface = signedIn && cloudSyncEnabled;

  useEffect(() => {
    init();
  }, [init]);

  useEffect(() => {
    return subscribeCloudSurface((open) => {
      setCloudModalOpen(open);
      if (open) setProjectSharingOpen(false);
    });
  }, []);

  useEffect(() => {
    return subscribeProjectSharing((open) => {
      setProjectSharingOpen(open);
      if (open) {
        setMenuOpen(false);
        setCloudModalOpen(false);
      }
    });
  }, []);

  useEffect(() => {
    return subscribeSettingsEntry(() => {
      setMenuOpen(false);
      setCloudModalOpen(false);
      setProjectSharingOpen(false);
    });
  }, []);

  const entries: ActionMenuEntry[] = [
    ...(showCloudSurface
      ? [
          {
            id: 'cloud',
            label: 'Cloud backup',
            testId: 'account-cloud-backup',
            onSelect: () => setCloudModalOpen(true),
          },
        ]
      : []),
    ...(signedIn
      ? [
          {
            id: 'organizations',
            label: 'Organizations',
            testId: 'account-manage-orgs',
            onSelect: openOrganizationsSettings,
          },
          { id: 'account-separator', separator: true as const },
          {
            id: 'settings',
            label: 'Account settings',
            title: 'Profile settings',
            testId: 'account-settings',
            onSelect: openAccountSettings,
          },
          { id: 'sign-out-separator', separator: true as const },
          {
            id: 'sign-out',
            label: 'Sign out',
            testId: 'account-sign-out',
            onSelect: () => {
              void signOut();
            },
          },
        ]
      : [
          {
            id: 'sign-in',
            label: busy ? 'Signing in…' : 'Sign in',
            disabled: busy,
            testId: 'account-sign-in',
            onSelect: () => {
              void startSignIn();
            },
          },
        ]),
  ];

  if (!enabled) return null;

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setMenuOpen(true);
          }
        }}
        title={signedIn ? identity : 'Account'}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        data-testid="account-button"
        data-account-state={signedIn ? 'signed-in' : busy ? 'busy' : 'signed-out'}
        className={`${INTERACTION_CLASS} relative flex h-12 w-12 items-center justify-center ${signedIn ? 'text-accent' : 'text-fg-muted'}`}
      >
        <div className="h-6 w-6 overflow-hidden rounded-full">
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt=""
              data-testid="account-button-avatar-img"
              className="h-full w-full object-cover"
            />
          ) : (
            <ProfileIcon className="h-full w-full" />
          )}
        </div>
        {signedIn && (
          <span className="absolute bottom-2.5 right-2.5 h-2 w-2 rounded-full bg-accent ring-2 ring-bg-subtle" />
        )}
      </button>

      <ActionMenu
        open={menuOpen}
        anchorRef={triggerRef}
        label="Account"
        testId="account-menu"
        onClose={() => setMenuOpen(false)}
        entries={entries}
        header={
          <>
            <div className="flex items-center gap-2.5 px-2 py-2">
              <div
                data-testid="account-avatar"
                className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-bg-muted text-fg-muted"
              >
                {avatarUrl ? (
                  <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <div className="h-5 w-5">
                    <ProfileIcon className="h-full w-full" />
                  </div>
                )}
              </div>
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-wide text-fg-muted">
                  {signedIn ? 'Signed in as' : 'Account'}
                </p>
                <p
                  className="truncate text-sm text-fg"
                  title={identity}
                  data-testid="account-email"
                >
                  {identity}
                </p>
              </div>
            </div>

            <MenuSeparator />
          </>
        }
      />

      <CloudBackupModal
        open={projectSharingOpen}
        onClose={() => setProjectSharingOpen(false)}
        title="This project"
        testId="project-sharing-modal"
      >
        {remoteBound ? (
          <SharedProjectPeoplePanel
            listing={cloud.access}
            loading={cloud.accessLoading}
            error={cloud.accessError}
            commandInFlight={cloud.commandInFlight}
            onInvite={(email, role) => void cloud.inviteCollaborator(email, role)}
            onChangeRole={(accountId, role) => void cloud.changeAccess(accountId, role)}
            onRemove={(accountId) => void cloud.changeAccess(accountId, null)}
            onSetOrgAudience={(orgId, role) => void cloud.setOrgAudience(orgId, role)}
            onRevokeInvite={(inviteId) => void cloud.revokeInvite(inviteId)}
            onResendInvite={(inviteId) => void cloud.resendInvite(inviteId)}
            onRefresh={() => void cloud.refreshAccess()}
          />
        ) : (
          <div className="space-y-3" data-testid="project-sharing-needs-backup">
            <p className="text-sm text-fg-muted">
              Back this project up to the cloud before you invite people to it.
            </p>
            <button
              type="button"
              data-testid="project-sharing-open-backup"
              className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-white hover:opacity-90"
              onClick={() => {
                setProjectSharingOpen(false);
                openCloudSurface();
              }}
            >
              Cloud backup
            </button>
          </div>
        )}
      </CloudBackupModal>

      <CloudBackupModal open={cloudModalOpen} onClose={() => setCloudModalOpen(false)}>
        <CloudWorkspacePanel
          syncStatus={cloud.syncStatus}
          syncWorkspaceUuid={cloud.syncWorkspaceUuid}
          syncDisplay={cloud.syncDisplay}
          syncBusy={cloud.syncBusy}
          commandInFlight={cloud.commandInFlight}
          uploadPreview={cloud.uploadPreview}
          uploadPreviewError={cloud.uploadPreviewError}
          onRunAction={(action) => void cloud.runAutoSyncAction(action)}
          onResolveConflict={(resolution) => void cloud.runConflictResolution(resolution)}
          onRecoverScientificDrafts={() => void cloud.recoverScientificDrafts()}
          onSaveSelectionRules={(rules) => void cloud.saveSelectionRules(rules)}
          onApproveSelection={() => void cloud.approveSelection()}
          organizations={cloud.organizations}
          ownerChoice={cloud.ownerChoice}
          onOwnerChoiceChange={cloud.setOwnerChoice}
          mergeConflict={cloud.mergeConflict}
          onReconcile={() => void cloud.runReconcile()}
          onResolveMerge={(choices) => void cloud.resolveMergeConflict(choices)}
        />
        <div className="mt-4">
          <CloudProjectList
            projects={cloud.syncedProjects}
            loading={cloud.syncedProjectsLoading}
            error={cloud.syncedProjectsError}
            commandInFlight={cloud.commandInFlight}
            onOpenProject={(project) => void cloud.openSyncedProject(project)}
          />
        </div>
      </CloudBackupModal>
    </div>
  );
}
