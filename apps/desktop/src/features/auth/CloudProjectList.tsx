import { toUserMessage } from '@waypoint/user-messages';
import type { WorkspaceSyncProjectSummary } from '../../shared/workspace-sync-ipc';

export interface CloudProjectListProps {
  projects: WorkspaceSyncProjectSummary[];
  loading: boolean;
  error: string | null;
  commandInFlight: boolean;
  onOpenProject: (project: WorkspaceSyncProjectSummary) => void;
}

function accessBadge(project: WorkspaceSyncProjectSummary): string {
  switch (project.accessRole) {
    case 'owner':
      return project.accessSource === 'org_admin' ? 'Administrator' : 'Owner';
    case 'manager':
      return 'Manager';
    case 'editor':
      return 'Editor';
    default:
      return 'Viewer';
  }
}

export function CloudProjectList({
  projects,
  loading,
  error,
  commandInFlight,
  onOpenProject,
}: CloudProjectListProps) {
  return (
    <div className="m-1">
      <div className="flex items-center justify-between px-1 py-1">
        <span className="text-[10px] uppercase tracking-wide text-fg-muted">Cloud projects</span>
      </div>
      {loading ? (
        <p className="px-1 py-1 text-xs text-fg-muted">Loading...</p>
      ) : error ? (
        <p className="px-1 py-1 text-xs text-error">{toUserMessage(error, 'account.failed')}</p>
      ) : projects.length === 0 ? (
        <p className="px-1 py-1 text-xs text-fg-muted">No cloud projects</p>
      ) : (
        <div className="space-y-1">
          {projects.map((project) => {
            const hasBackup = project.latestVersionId !== null;
            return (
              <button
                key={project.remoteWorkspaceId}
                type="button"
                role="menuitem"
                disabled={commandInFlight || !hasBackup}
                onClick={() => onOpenProject(project)}
                data-testid="account-open-synced-project"
                className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm text-fg-muted wp-interactive disabled:cursor-not-allowed disabled:opacity-50 "
              >
                <span className="min-w-0 truncate">
                  {project.displayName}
                  {project.accessSource !== 'owner' || project.ownerOrgId ? (
                    <span
                      data-testid="account-project-access-badge"
                      className="ml-1 text-[10px] text-fg-muted"
                      title={`${project.ownerDisplayName} · ${accessBadge(project)}`}
                    >
                      · {project.ownerOrgId ? project.ownerDisplayName : 'Shared with you'} ·{' '}
                      {accessBadge(project)}
                    </span>
                  ) : null}
                </span>
                <span className="shrink-0 text-[10px] text-fg-muted">
                  {!hasBackup
                    ? 'No backup yet'
                    : project.latestVersionNumber === null
                      ? 'Backup ready'
                      : `v${project.latestVersionNumber}`}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
