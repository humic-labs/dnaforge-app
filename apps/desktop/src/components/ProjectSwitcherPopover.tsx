import { usePresentationListener } from '../presentation/PresentationSurface';
import { Button } from './ui';
import { INTERACTION_CLASS } from '@waypoint/ui-components';
import { dispatchWorkspaceFileRelocated } from '../features/workspace/relocate-registry-file';
import { getWorkspaceProjectControl } from '../features/workspace-loader/workspace-project-control';
import {
  type UserMessage,
  toUserMessage,
  userMessage,
  userMessageWithValues,
  userMessageValue,
} from '@waypoint/user-messages';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  listWorkspaceLibrary,
  restoreWorkspace,
  restoreFromTrash,
  trashDaysRemaining,
  type WorkspaceLibraryEntry,
} from '../features/workspace-loader/workspace-library';
import {
  formatWorkspaceRelativeTime,
  workspaceLocationDisplayName,
} from '../features/workspace-loader/workspace-projects';
import { platform } from '../platform';
import { useToastStore } from '../stores/toast-store';
import { confirmDialog } from './confirm-dialog-store';
import { FolderOpenIcon, PlusIcon, ProjectRootIcon, XIcon } from './icons';

interface ProjectSwitcherPopoverProps {
  x: number;
  y: number;
  openRepoPaths: string[];
  onClose: () => void;
  onOpenProject: (workspace: WorkspaceLibraryEntry) => void;
  onImportProject: () => void;

  onCreateProject?: (name: string) => Promise<boolean>;
}

export function ProjectSwitcherPopover({
  x,
  y,
  openRepoPaths,
  onClose,
  onOpenProject,
  onImportProject,
  onCreateProject,
}: ProjectSwitcherPopoverProps) {
  const presentationEvents = usePresentationListener();

  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<WorkspaceLibraryEntry[]>([]);
  const [archived, setArchived] = useState<WorkspaceLibraryEntry[]>([]);
  const [trashed, setTrashed] = useState<WorkspaceLibraryEntry[]>([]);
  const [query, setQuery] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<'unavailable' | 'permission_refused' | null>(null);
  const loadRequest = useRef(0);
  const alive = useRef(true);
  const [newProjectName, setNewProjectName] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [locating, setLocating] = useState<string | null>(null);
  const [recoveryError, setRecoveryError] = useState<UserMessage | null>(null);

  const refresh = useCallback(async () => {
    if (!alive.current) return;
    const request = ++loadRequest.current;
    setLoading(true);
    try {
      const library = await listWorkspaceLibrary();
      if (request !== loadRequest.current || !alive.current) return;
      setActive(library.active);
      setArchived(library.archived);
      setTrashed(library.trashed);
      setLoaded(true);
      setLoadError(null);
    } catch (error) {
      if (request !== loadRequest.current || !alive.current) return;

      const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
      setLoadError(
        code === 'EACCES' || code === 'EPERM' || code === 'PERMISSION_DENIED'
          ? 'permission_refused'
          : 'unavailable'
      );
      useToastStore
        .getState()
        .addToast(userMessage('notice.could-not-load-your-projects-try-again'), {
          definition: 'project-switcher-popover-failed-to-load-your-projects',
        });
    } finally {
      if (request === loadRequest.current && alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => {
      alive.current = false;
      loadRequest.current += 1;
    };
  }, [refresh]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClickOutside);
    presentationEvents.add(document, 'keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      presentationEvents.remove(document, 'keydown', handleKeyDown);
    };
  }, [onClose, presentationEvents]);

  const filteredActive = useMemo(() => filterProjects(active, query), [active, query]);
  const filteredArchived = useMemo(() => filterProjects(archived, query), [archived, query]);
  const filteredTrashed = useMemo(() => filterProjects(trashed, query), [trashed, query]);

  const createProject = useCallback(async () => {
    const name = newProjectName?.trim();
    if (!onCreateProject || !name || creating) return;
    setCreating(true);
    try {
      if (await onCreateProject(name)) onClose();
    } finally {
      setCreating(false);
    }
  }, [creating, newProjectName, onClose, onCreateProject]);

  const openProject = useCallback(
    (workspace: WorkspaceLibraryEntry) => {
      onOpenProject(workspace);
      onClose();
    },
    [onClose, onOpenProject]
  );

  const locate = useCallback(
    async (workspace: WorkspaceLibraryEntry) => {
      if (locating) return;
      setLocating(workspace.repoPath);
      setRecoveryError(null);
      let linked = false;
      try {
        const selectedPath = await platform().dialog.open({
          directory: true,
          title: 'Locate project folder',
        });
        if (typeof selectedPath !== 'string') return;
        const result = await platform().workspace.relinkRoot({
          repoPath: workspace.repoPath,
          selectedPath,
        });
        if (result.status === 'rejected') {
          setRecoveryError(
            userMessage(
              (
                {
                  'identity-unavailable': 'project.relink.identity-unavailable',
                  'source-present': 'project.relink.source-present',
                  'invalid-target': 'project.relink.invalid-target',
                  'identity-mismatch': 'project.relink.identity-mismatch',
                  'compute-dependency': 'project.relink.compute-dependency',
                  'pending-sync-delivery': 'project.relink.pending-sync-delivery',
                  'path-conflict': 'project.relink.path-conflict',
                  'unbound-file-document': 'project.relink.unbound-file-document',
                  'scientific-document': 'project.relink.scientific-document',
                  'unsaved-document': 'project.relink.unsaved-document',
                } as const
              )[result.reason]
            )
          );
          return;
        }
        linked = true;
        dispatchWorkspaceFileRelocated({ oldPath: workspace.repoPath, newPath: result.repoPath });
        await getWorkspaceProjectControl()?.unmount(workspace.repoPath);
        await getWorkspaceProjectControl()?.refresh();
        await refresh();
      } catch {
        setRecoveryError(
          userMessage(linked ? 'project.relink.linked-refresh' : 'project.relink.failed')
        );
      } finally {
        setLocating(null);
      }
    },
    [locating, refresh]
  );

  const restore = useCallback(
    async (workspace: WorkspaceLibraryEntry): Promise<boolean> => {
      try {
        const changed = await restoreWorkspace(workspace.repoUuid ?? workspace);
        if (changed === 0) {
          useToastStore.getState().addToast(
            userMessageWithValues('notice.couldn-t-restore-value-its-project-record-is-missing', {
              value0: userMessageValue(workspace.name),
            }),
            {
              definition:
                'project-switcher-popover-couldn-t-restore-example-its-project-record-is-missing',
            }
          );
          return false;
        }
      } catch (err) {
        useToastStore.getState().addToast(toUserMessage(err, 'operation.failed'), {
          definition: 'project-switcher-popover-couldn-t-restore-example',
        });
        return false;
      }
      await refresh();
      return true;
    },
    [refresh]
  );

  const restoreAndOpen = useCallback(
    async (workspace: WorkspaceLibraryEntry) => {
      if (await restore(workspace)) openProject(workspace);
    },
    [openProject, restore]
  );

  const restoreFromTrashAndOpen = useCallback(
    async (workspace: WorkspaceLibraryEntry) => {
      try {
        const changed = await restoreFromTrash(workspace.repoUuid ?? workspace);
        if (changed === 0) {
          useToastStore.getState().addToast(
            userMessageWithValues('notice.couldn-t-restore-value-it-may-already-be-purged', {
              value0: userMessageValue(workspace.name),
            }),
            {
              definition:
                'project-switcher-popover-couldn-t-restore-example-it-may-already-be-purged',
            }
          );
          return;
        }
      } catch (err) {
        useToastStore.getState().addToast(toUserMessage(err, 'operation.failed'), {
          definition: 'project-switcher-popover-couldn-t-restore-example',
        });
        return;
      }
      await refresh();
      openProject(workspace);
    },
    [openProject, refresh]
  );

  const purgeFromTrash = useCallback(
    async (workspace: WorkspaceLibraryEntry) => {
      if (!workspace.repoUuid) return;
      if (
        !(await confirmDialog({
          title: userMessage('dialog.delete-permanently'),
          message: userMessageWithValues(
            'dialog.permanently-delete-value-the-original-project-and-projects-with-retain',
            { value0: userMessageValue(workspace.name) }
          ),
          confirmLabel: userMessage('dialog.delete-permanently'),
          tone: 'danger',
        }))
      ) {
        return;
      }
      try {
        const { purged } = await platform().workspace.purgeTrashed({
          repoUuid: workspace.repoUuid,
        });
        if (!purged) {
          useToastStore.getState().addToast(
            userMessageWithValues('notice.value-was-already-removed', {
              value0: userMessageValue(workspace.name),
            }),
            {
              definition: 'project-switcher-popover-example-was-already-removed',
            }
          );
        }
      } catch (err) {
        useToastStore.getState().addToast(toUserMessage(err, 'operation.failed'), {
          definition: 'project-switcher-popover-couldn-t-delete-example',
        });
        return;
      }
      await refresh();
    },
    [refresh]
  );

  return (
    <div
      ref={ref}
      data-testid="project-switcher-popover"
      aria-busy={loading}
      className="fixed z-50 w-[340px] overflow-hidden rounded-md border border-border bg-bg-subtle shadow-lg"
      style={{ left: x, top: y }}
    >
      {}
      <div className="flex items-center gap-2 border-b border-border p-1 pr-3">
        <button
          type="button"
          data-testid="project-switcher-trigger-row"
          aria-label="Close project switcher"
          onClick={onClose}
          className={`${INTERACTION_CLASS} inline-flex h-7 flex-shrink-0 items-center rounded bg-bg-muted px-2 text-xs font-medium text-fg`}
        >
          Manage projects
        </button>
        <input
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Search projects"
          data-testid="project-switcher-search"
          className="h-7 min-w-0 flex-1 rounded border border-border bg-bg px-2 text-xs text-fg outline-none focus:border-accent"
        />
      </div>

      <div className="border-b border-border px-3 py-2">
        {newProjectName === null ? (
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              data-testid="project-switcher-new-project"
              disabled={!onCreateProject}
              onClick={() => setNewProjectName('')}
              className={ACTION_BUTTON_CLASS}
            >
              <PlusIcon className="h-4 w-4" />
              <span>New project</span>
            </button>
            <button
              type="button"
              data-testid="project-switcher-import"
              onClick={() => {
                onImportProject();
                onClose();
              }}
              className={ACTION_BUTTON_CLASS}
            >
              <FolderOpenIcon className="h-4 w-4" />
              <span>Import project…</span>
            </button>
          </div>
        ) : (
          <form
            className="flex items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              void createProject();
            }}
          >
            <input
              autoFocus
              value={newProjectName}
              onChange={(event) => setNewProjectName(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation();
                  setNewProjectName(null);
                }
              }}
              placeholder="Project name"
              aria-label="New project name"
              data-testid="project-switcher-new-project-name"
              disabled={creating}
              className="h-8 min-w-0 flex-1 rounded border border-border bg-bg px-2 text-xs text-fg outline-none focus:border-accent"
            />
            <button
              type="submit"
              data-testid="project-switcher-new-project-create"
              disabled={creating || !newProjectName.trim()}
              className="h-8 flex-shrink-0 rounded bg-accent px-2.5 text-xs font-medium text-white hover:bg-accent/90 disabled:cursor-default disabled:opacity-50"
            >
              {creating ? 'Creating…' : 'Create'}
            </button>
            <button
              type="button"
              aria-label="Cancel new project"
              onClick={() => setNewProjectName(null)}
              disabled={creating}
              className={`${INTERACTION_CLASS} inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded text-fg-muted`}
            >
              <XIcon className="h-3.5 w-3.5" />
            </button>
          </form>
        )}
      </div>

      <div className="max-h-[calc(100vh-200px)] overflow-y-auto pb-1">
        {loadError && (
          <div role="alert" className="px-3 py-2 text-xs text-fg-muted">
            {loadError === 'permission_refused'
              ? 'Project access was refused. Check permissions and retry.'
              : 'Could not load your projects.'}{' '}
            {loaded ? 'Showing the last loaded projects.' : 'Try again.'}
          </div>
        )}
        {loading && (
          <div role="status" className="px-3 py-2 text-xs text-fg-muted">
            Loading...
          </div>
        )}
        <button
          type="button"
          disabled={loading}
          onClick={() => void refresh()}
          className="mx-3 my-1 text-xs text-accent disabled:opacity-50"
        >
          {loadError ? 'Retry projects' : 'Refresh projects'}
        </button>
        {recoveryError && (
          <p role="alert" className="px-3 py-2 text-xs text-error">
            {recoveryError}
          </p>
        )}
        {loaded && (
          <>
            <SectionHeading label="Current" count={active.length} />
            <div data-testid="project-switcher-current">
              {filteredActive.length === 0 ? (
                <EmptyRow text={query ? 'No matching projects' : 'No current projects'} />
              ) : (
                filteredActive.map((workspace) => (
                  <ProjectRow
                    key={workspace.repoPath}
                    workspace={workspace}
                    onLocate={
                      workspace.rootState === 'missing' && workspace.repoUuid
                        ? () => void locate(workspace)
                        : undefined
                    }
                    locating={locating !== null}
                    open={openRepoPaths.includes(workspace.repoPath)}
                    onClick={() => openProject(workspace)}
                  />
                ))
              )}
            </div>

            <SectionHeading label="Archived" count={archived.length} />
            <div data-testid="project-switcher-archived">
              {filteredArchived.length === 0 ? (
                <EmptyRow text={query ? 'No matching projects' : 'No archived projects'} />
              ) : (
                filteredArchived.map((workspace) => (
                  <ProjectRow
                    key={workspace.repoPath}
                    workspace={workspace}
                    onLocate={
                      workspace.rootState === 'missing' && workspace.repoUuid
                        ? () => void locate(workspace)
                        : undefined
                    }
                    locating={locating !== null}
                    open={false}
                    archived
                    onClick={() => void restoreAndOpen(workspace)}
                    onRestore={() => void restore(workspace)}
                  />
                ))
              )}
            </div>

            <SectionHeading label="Trash" count={trashed.length} />
            <div data-testid="project-switcher-trashed">
              {trashed.length > 0 ? (
                <p className="px-3 py-2 text-xs text-fg-muted">
                  The original project and projects with retained records or history are kept. Other
                  projects may be deleted after 30 days.
                </p>
              ) : null}
              {filteredTrashed.length === 0 ? (
                <EmptyRow text={query ? 'No matching projects' : 'Trash is empty'} />
              ) : (
                filteredTrashed.map((workspace) => (
                  <ProjectRow
                    key={workspace.repoPath}
                    workspace={workspace}
                    onLocate={
                      workspace.rootState === 'missing' && workspace.repoUuid
                        ? () => void locate(workspace)
                        : undefined
                    }
                    locating={locating !== null}
                    open={false}
                    trashedDaysRemaining={trashDaysRemaining(workspace.trashedAt)}
                    onClick={() => void restoreFromTrashAndOpen(workspace)}
                    onRestore={() => void restoreFromTrashAndOpen(workspace)}
                    onPurge={workspace.repoUuid ? () => void purgeFromTrash(workspace) : undefined}
                  />
                ))
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const ACTION_BUTTON_CLASS = `${INTERACTION_CLASS} inline-flex h-8 items-center justify-center gap-1.5 rounded border border-border bg-bg px-2 text-xs font-medium text-fg`;

function SectionHeading({ label, count }: { label: string; count: number }) {
  return (
    <div className="mt-1 flex min-h-7 items-center border-t border-border px-3 pt-1 text-xs font-medium uppercase tracking-wide text-fg-muted first:mt-0 first:border-t-0">
      {label} ({count})
    </div>
  );
}

function EmptyRow({ text }: { text: string }) {
  return <div className="px-3 pb-2 text-xs text-fg-subtle">{text}</div>;
}

function ProjectRow({
  workspace,
  open,
  archived,
  trashedDaysRemaining,
  onClick,
  onRestore,
  onPurge,
  onLocate,
  locating,
}: {
  workspace: WorkspaceLibraryEntry;
  open: boolean;
  archived?: boolean;

  trashedDaysRemaining?: number;
  onClick: () => void;

  onRestore?: () => void;

  onPurge?: () => void;
  onLocate?: () => void;
  locating?: boolean;
}) {
  const isTrashed = typeof trashedDaysRemaining === 'number';
  const subtitle =
    workspace.rootState === 'missing'
      ? workspace.repoUuid
        ? 'Missing folder'
        : 'Missing folder — no retained identity to verify a replacement'
      : workspace.rootState === 'unavailable'
        ? 'Folder unavailable — check access, then refresh'
        : isTrashed
          ? !workspace.repoUuid
            ? 'files kept in their original folder'
            : trashedDaysRemaining === 0
              ? 'deletion check today'
              : `deletion check in ${trashedDaysRemaining} day${trashedDaysRemaining === 1 ? '' : 's'}`
          : archived
            ? 'archived'
            : formatWorkspaceRelativeTime(workspace.lastOpenedAt);
  return (
    <div
      className={`${INTERACTION_CLASS} group flex items-center`}
      data-testid={`project-switcher-row-wrap-${workspace.repoUuid ?? workspace.repoPath}`}
    >
      <button
        type="button"
        data-testid={`project-switcher-row-${workspace.repoUuid ?? workspace.repoPath}`}
        onClick={onClick}
        disabled={Boolean(workspace.rootState)}
        className="flex min-h-[52px] min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-left"
        title={workspace.originPath ?? workspace.repoPath}
      >
        <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-sm border border-border bg-bg text-accent">
          <ProjectRootIcon className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-fg">{workspace.name}</span>
          <span
            className={`mt-0.5 block truncate text-[11px] ${isTrashed ? 'text-error' : 'text-fg-muted'}`}
          >
            {subtitle}
            {workspace.originPath
              ? ` - ${workspaceLocationDisplayName(workspace.originPath, workspace.name)}`
              : ''}
          </span>
        </span>
        {open && (
          <span className="rounded-sm border border-accent/40 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent">
            Open
          </span>
        )}
      </button>
      {onLocate && (
        <div className="mr-3">
          <Button onClick={onLocate} disabled={locating}>
            Locate folder
          </Button>
        </div>
      )}
      {(onRestore || onPurge) && (
        <div className="flex flex-shrink-0 items-center gap-1.5 pl-1 pr-3">
          {onRestore && (
            <button
              type="button"
              data-testid={`project-switcher-restore-${workspace.repoUuid ?? workspace.repoPath}`}
              onClick={onRestore}
              disabled={Boolean(workspace.rootState)}
              className={`${INTERACTION_CLASS} rounded border border-border px-2 py-0.5 text-[11px] font-medium text-fg`}
            >
              Restore
            </button>
          )}
          {onPurge && (
            <button
              type="button"
              data-testid={`project-switcher-purge-${workspace.repoUuid}`}
              onClick={onPurge}
              className="rounded border border-error/40 px-2 py-0.5 text-[11px] font-medium text-error hover:bg-error/10"
            >
              Delete now
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function filterProjects(projects: WorkspaceLibraryEntry[], query: string): WorkspaceLibraryEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return projects;
  return projects.filter((workspace) =>
    [workspace.name, workspace.originPath, workspace.repoPath]
      .filter(Boolean)
      .some((value) => value!.toLowerCase().includes(needle))
  );
}
