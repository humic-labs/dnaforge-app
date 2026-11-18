import { INTERACTION_CLASS } from '@waypoint/ui-components';
import { useEffect, useState } from 'react';
import type { GitLogEntry } from '../features/workspace/git';
import { gitWorkspaceLog } from '../features/workspace/git';
import type { WorkspaceProject } from '../features/workspace-loader/workspace-projects';
import {
  formatWorkspaceRelativeTime,
  workspaceLocationDisplayName,
} from '../features/workspace-loader/workspace-projects';
import { CloseIcon, FolderOpenIcon, HistoryIcon } from './icons';
import { ProjectHistoryTimeline } from './ProjectHistoryTimeline';
import { ShareSnapshotControl } from '../features/auth/ShareSnapshotControl';

interface ProjectHomeProps {
  project: WorkspaceProject;
  onClose: () => void;
  onArchiveProject: (repoPath: string) => void;
  onOpenRegistry: () => void;
  onOpenSwitcher: () => void;
  onRevealProject: (repoPath: string) => void;
}

export function ProjectHome({
  project,
  onClose,
  onArchiveProject,
  onOpenRegistry,
  onOpenSwitcher,
  onRevealProject,
}: ProjectHomeProps) {
  const [history, setHistory] = useState<GitLogEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setHistoryLoading(true);
    void gitWorkspaceLog(project.repoPath, 50)
      .then((entries) => {
        if (!cancelled) setHistory(entries);
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [project.repoPath]);

  return (
    <div
      data-testid="project-home"
      className="fixed inset-x-0 bottom-0 top-10 z-40 overflow-hidden border-t border-border bg-bg"
    >
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-lg font-semibold text-fg">{project.name}</h1>
              <span className="rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent">
                open
              </span>
            </div>
            <div className="mt-1 truncate text-xs text-fg-muted">
              {project.originPath
                ? `Imported from ${workspaceLocationDisplayName(project.originPath, project.name)}`
                : project.name}
            </div>
          </div>
          <div className="flex flex-shrink-0 items-center gap-2">
            <ShareSnapshotControl workspaceRootPath={project.repoPath} />
            <button
              type="button"
              data-testid="project-home-switch"
              onClick={onOpenSwitcher}
              className={`${INTERACTION_CLASS} rounded border border-border px-3 py-1.5 text-xs font-medium text-fg`}
            >
              Projects
            </button>
            <button
              type="button"
              data-testid="project-home-archive"
              onClick={() => onArchiveProject(project.repoPath)}
              className="rounded border border-error/40 px-3 py-1.5 text-xs font-medium text-error hover:bg-error/10"
            >
              Archive
            </button>
            <button
              type="button"
              data-testid="project-home-close"
              onClick={onClose}
              className={`${INTERACTION_CLASS} inline-flex h-7 w-7 items-center justify-center rounded text-fg-muted`}
              aria-label="Close project home"
            >
              <CloseIcon />
            </button>
          </div>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(280px,360px)_minmax(0,1fr)]">
          <aside className="overflow-y-auto border-r border-border bg-bg-subtle p-4">
            <section className="space-y-3">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
                Project
              </h2>
              <dl className="space-y-2 text-sm">
                <InfoRow
                  label="Last opened"
                  value={formatWorkspaceRelativeTime(project.lastOpenedAt)}
                />
                <InfoRow label="Managed project" value={project.name} />
                <InfoRow
                  label="Origin"
                  value={
                    project.originPath
                      ? workspaceLocationDisplayName(project.originPath, project.name)
                      : 'Unknown'
                  }
                />
              </dl>
              <button
                type="button"
                data-testid="project-home-reveal"
                onClick={() => onRevealProject(project.repoPath)}
                className={`${INTERACTION_CLASS} inline-flex items-center gap-2 rounded border border-border px-3 py-1.5 text-xs font-medium text-fg`}
              >
                <FolderOpenIcon className="h-4 w-4" />
                Reveal in Finder
              </button>
            </section>

            <section className="mt-6 space-y-3">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
                Registered Items
              </h2>
              <div className="rounded border border-border bg-bg px-3 py-2 text-xs text-fg-muted">
                No linked registry items
              </div>
              <button
                type="button"
                data-testid="project-home-open-registry"
                onClick={onOpenRegistry}
                className={`${INTERACTION_CLASS} rounded border border-border px-3 py-1.5 text-xs font-medium text-fg`}
              >
                Open registry
              </button>
            </section>
          </aside>

          <section className="min-w-0 overflow-y-auto p-4">
            <div className="mb-3 flex items-center gap-2">
              <HistoryIcon />
              <h2 className="text-sm font-semibold text-fg">Project History</h2>
            </div>
            <div className="overflow-hidden rounded border border-border bg-bg-subtle">
              <ProjectHistoryTimeline entries={history} loading={historyLoading} />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-fg-subtle">{label}</dt>
      <dd className="mt-0.5 break-words text-fg">{value}</dd>
    </div>
  );
}
