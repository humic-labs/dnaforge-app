import { INTERACTION_CLASS } from '@waypoint/ui-components';
import { toUserMessage } from '@waypoint/user-messages';

import { useState, useCallback, useEffect, useRef } from 'react';
import { Button, TextField } from './ui';
import { notifyGitStatusChanged } from '../hooks/useGitStatus';
import { useFolderGitState } from '../hooks/useFolderGitState';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { soleWritableProjectRoot } from '../shared/project-root-selection';
import { findContainingPathBoundary } from '../shared/path-boundary';
import type { GitFileStatus } from '../features/workspace/git';
import { platform } from '../platform';
import {
  executeProjectHistory,
  inspectProjectHistory,
} from '../features/workspace/public/project-history';
import type { ProjectHistoryInspection, ProjectHistoryOperation } from '../shared/project-history';

function GitBranchIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function statusColor(status: GitFileStatus): string {
  switch (status) {
    case 'modified':
      return 'text-yellow-400';
    case 'added':
    case 'untracked':
      return 'text-green-400';
    case 'deleted':
      return 'text-red-400';
    case 'renamed':
      return 'text-blue-400';
    default:
      return 'text-fg-muted';
  }
}

function statusLabel(status: GitFileStatus): string {
  switch (status) {
    case 'modified':
      return 'M';
    case 'added':
      return 'A';
    case 'untracked':
      return 'U';
    case 'deleted':
      return 'D';
    case 'renamed':
      return 'R';
    default:
      return '?';
  }
}

export function SourceControlPanel() {
  const { folders, selectedPath } = useWorkspaceStore();
  const writableProjects = folders.filter((folder) => !folder.pinned);
  const workspacePath =
    (selectedPath ? findContainingPathBoundary(writableProjects, selectedPath)?.path : null) ??
    soleWritableProjectRoot(folders)?.path ??
    null;
  const { state: folderGitState, refresh: refreshFolderGitState } =
    useFolderGitState(workspacePath);
  const [history, setHistory] = useState<ProjectHistoryInspection | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [isCommitting, setIsCommitting] = useState(false);
  const [commitResult, setCommitResult] = useState<string | null>(null);
  const [isInitializing, setIsInitializing] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const currentRoot = useRef(workspacePath);
  const refreshGeneration = useRef(0);
  currentRoot.current = workspacePath;

  const refresh = useCallback(async () => {
    if (!workspacePath) return;
    const generation = ++refreshGeneration.current;
    try {
      const next = await inspectProjectHistory(workspacePath);
      if (currentRoot.current === workspacePath && generation === refreshGeneration.current) {
        setHistory(next);
        setLoadError(null);
      }
    } catch (error) {
      if (currentRoot.current === workspacePath && generation === refreshGeneration.current)
        setLoadError(toUserMessage(error, 'operation.failed'));
    } finally {
      if (currentRoot.current === workspacePath && generation === refreshGeneration.current)
        setLoading(false);
    }
  }, [workspacePath]);

  useEffect(() => {
    currentRoot.current = workspacePath;
    setHistory(null);
    setLoading(true);
    setLoadError(null);
    setCommitResult(null);
    setCommitMessage('');
    setIsCommitting(false);
    setIsInitializing(false);
    setInitError(null);
    void refresh();
    const unsubscribe = platform().shell.onProjectHistoryChanged?.((root) => {
      if (root === workspacePath) void refresh();
    });
    return () => {
      currentRoot.current = null;
      unsubscribe?.();
    };
  }, [workspacePath, refresh]);

  const runOperation = useCallback(
    async (operation: ProjectHistoryOperation, success: string) => {
      if (!workspacePath) return;
      setIsCommitting(true);
      setCommitResult(null);
      try {
        const result = await executeProjectHistory(workspacePath, operation);
        if (currentRoot.current !== workspacePath) return;
        if (result.status === 'failed') {
          setCommitResult(
            result.commitOid
              ? `Committed ${result.commitOid.slice(0, 8)}; ${result.error}`
              : `${result.stateChanged ? 'Project state changed; ' : 'Failed: '}${result.error}`
          );
        } else {
          setCommitResult(
            result.warnings.length ? `${success}. ${result.warnings.join(' ')}` : success
          );
          if (operation.kind === 'commit' || operation.kind === 'save-all') setCommitMessage('');
        }
        await refresh();
        notifyGitStatusChanged(workspacePath);
        await refreshFolderGitState();
      } catch (error) {
        if (currentRoot.current === workspacePath)
          setCommitResult(toUserMessage(error, 'project.operationUnconfirmed'));
      } finally {
        if (currentRoot.current === workspacePath) setIsCommitting(false);
      }
    },
    [workspacePath, refresh, refreshFolderGitState]
  );

  const handleInitRepo = useCallback(async () => {
    if (!history) return;
    setIsInitializing(true);
    setInitError(null);
    try {
      await runOperation(
        { kind: 'initialize', expectedRevision: history.revision },
        'Repository initialized'
      );
    } catch (error) {
      setInitError(toUserMessage(error, 'operation.failed'));
    } finally {
      setIsInitializing(false);
    }
  }, [history, runOperation]);

  const isTracked = history?.tracked ?? false;
  const changedFiles = (history?.entries ?? []).map((entry) => [entry.path, entry.status] as const);
  const stagedFiles = new Set(
    (history?.entries ?? []).filter((entry) => entry.staged).map((entry) => entry.path)
  );
  const toggleStaged = useCallback(
    (path: string) => {
      if (!history) return;
      const entry = history.entries.find((entry) => entry.path === path);
      if (!entry) return;
      void runOperation(
        {
          kind: entry.staged ? 'unstage' : 'stage',
          expectedRevision: history.revision,
          paths: [path],
        },
        entry.staged ? 'File unstaged' : 'File staged'
      );
    },
    [history, runOperation]
  );
  const stageAll = useCallback(() => {
    if (!history?.entries.length) return;
    void runOperation(
      {
        kind: 'stage',
        expectedRevision: history.revision,
        paths: history.entries.map((entry) => entry.path),
      },
      'Files staged'
    );
  }, [history, runOperation]);
  const unstageAll = useCallback(() => {
    const paths = history?.entries.filter((entry) => entry.staged).map((entry) => entry.path) ?? [];
    if (!history || !paths.length) return;
    void runOperation(
      { kind: 'unstage', expectedRevision: history.revision, paths },
      'Files unstaged'
    );
  }, [history, runOperation]);
  const handleCommit = useCallback(async () => {
    const paths = history?.entries.filter((entry) => entry.staged).map((entry) => entry.path) ?? [];
    if (!history || !paths.length || !commitMessage.trim()) return;
    await runOperation(
      { kind: 'commit', expectedRevision: history.revision, paths, message: commitMessage.trim() },
      'Committed successfully'
    );
  }, [history, commitMessage, runOperation]);
  const handleSaveAll = useCallback(async () => {
    if (!history?.entries.length) return;
    await runOperation(
      { kind: 'save-all', expectedRevision: history.revision },
      'All changes saved'
    );
  }, [history, runOperation]);

  if (!workspacePath) {
    return (
      <div className="h-full flex flex-col" data-testid="source-control-panel">
        <div className="p-4 border-b border-border">
          <h2 className="text-lg font-semibold text-fg">Source Control</h2>
        </div>
        <div className="flex-1 flex items-center justify-center p-4">
          <p className="text-sm text-fg-muted text-center">
            {writableProjects.length > 1
              ? 'Choose a project to view source control'
              : 'No project open'}
          </p>
        </div>
      </div>
    );
  }

  if (loading && !history) {
    return (
      <div className="p-4 text-sm text-fg-muted" data-testid="source-control-panel">
        Loading project history…
      </div>
    );
  }
  if (loadError && !history) {
    return (
      <div className="p-4 space-y-2" data-testid="source-control-panel">
        <p className="text-sm text-error">{toUserMessage(loadError, 'operation.failed')}</p>
        <Button onClick={() => void refresh()}>Refresh</Button>
      </div>
    );
  }

  if (!isTracked) {
    const isNoGit = folderGitState === 'no-git';
    const isLoading = folderGitState === 'loading';
    return (
      <div className="h-full flex flex-col" data-testid="source-control-panel">
        <div className="p-4 border-b border-border">
          <h2 className="text-lg font-semibold text-fg">Source Control</h2>
          <p className="text-xs text-fg-muted mt-1">
            {isNoGit ? 'Git not installed' : 'Not a git repository'}
          </p>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6 text-center">
          {isLoading ? null : isNoGit ? (
            <>
              <p className="text-sm text-fg-muted max-w-xs">
                Install git to enable version control for this project.
              </p>
              <a
                href="https://git-scm.com/downloads"
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-accent hover:text-accent-hover underline"
              >
                Download git
              </a>
            </>
          ) : (
            <>
              <p className="text-sm text-fg-muted max-w-xs">
                This project isn&apos;t under version control. Initialize a git repository to track
                changes over time.
              </p>
              <Button
                variant="primary"
                type="button"
                onClick={handleInitRepo}
                disabled={isInitializing || isCommitting}
              >
                {isInitializing ? 'Initializing…' : 'Initialize Repository'}
              </Button>
              {(initError || commitResult) && (
                <p className="text-xs text-error max-w-xs">
                  {initError != null
                    ? toUserMessage(initError, 'operation.failed')
                    : toUserMessage(commitResult, 'operation.failed')}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col" data-testid="source-control-panel">
      <div className="p-4 border-b border-border">
        <div className="flex items-center gap-2 mb-3">
          <GitBranchIcon className="w-5 h-5 text-fg-muted" />
          <h2 className="text-lg font-semibold text-fg">Source Control</h2>
        </div>

        <div className="space-y-2">
          <TextField
            type="text"
            value={commitMessage}
            onChange={(e) => setCommitMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleCommit();
              }
            }}
            placeholder="Commit message..."
            disabled={isCommitting}
            data-testid="commit-message-input"
          />

          <div className="flex gap-2">
            <div className="grid flex-1">
              <Button
                variant="primary"
                onClick={handleCommit}
                disabled={isCommitting || !commitMessage.trim() || stagedFiles.size === 0}
                data-testid="commit-button"
              >
                <span className="inline-flex items-center justify-center gap-1.5">
                  <CheckIcon className="w-3.5 h-3.5" />
                  Commit ({stagedFiles.size})
                </span>
              </Button>
            </div>
            <Button
              onClick={handleSaveAll}
              disabled={isCommitting || changedFiles.length === 0}
              data-testid="save-all-button"
            >
              Save All
            </Button>
          </div>
        </div>

        {loadError && (
          <p className="mt-2 text-xs text-error">{toUserMessage(loadError, 'operation.failed')}</p>
        )}
        {commitResult && (
          <div
            className={`mt-2 text-xs ${
              commitResult.startsWith('Failed') ? 'text-red-400' : 'text-green-400'
            }`}
          >
            {commitResult}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {changedFiles.length === 0 ? (
          <div className="p-4 text-center text-fg-muted text-sm">No changes detected</div>
        ) : (
          <>
            <div className="px-4 py-2 flex items-center justify-between border-b border-border">
              <span className="text-xs font-medium text-fg-subtle uppercase tracking-wide">
                Changes ({changedFiles.length})
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={stageAll}
                  disabled={isCommitting}
                  className={`${INTERACTION_CLASS} text-xs text-fg-muted transition-colors`}
                  title="Stage all"
                >
                  + All
                </button>
                <button
                  onClick={unstageAll}
                  disabled={isCommitting}
                  className={`${INTERACTION_CLASS} text-xs text-fg-muted transition-colors`}
                  title="Unstage all"
                >
                  - All
                </button>
              </div>
            </div>

            {changedFiles.map(([path, status]) => {
              const fileName = path.split('/').pop() ?? path;
              const isStaged = stagedFiles.has(path);

              return (
                <button
                  key={path}
                  onClick={() => toggleStaged(path)}
                  disabled={isCommitting}
                  data-testid="source-control-entry"
                  data-entry-path={path}
                  aria-pressed={isStaged}
                  className={`${INTERACTION_CLASS} w-full flex items-center gap-2 px-4 py-1.5 text-left ${
                    isStaged ? 'bg-accent/5' : ''
                  }`}
                  title={path}
                >
                  <span
                    className={`flex-shrink-0 w-3.5 h-3.5 rounded border flex items-center justify-center ${
                      isStaged ? 'border-accent bg-accent' : 'border-border-hover'
                    }`}
                  >
                    {isStaged && <CheckIcon className="w-2.5 h-2.5 text-accent-fg" />}
                  </span>

                  <span className="flex-1 text-sm text-fg truncate">{fileName}</span>

                  {path !== fileName && (
                    <span className="text-xs text-fg-subtle truncate max-w-[120px]">
                      {path.slice(0, -(fileName.length + 1))}
                    </span>
                  )}

                  <span
                    className={`flex-shrink-0 text-xs font-mono font-bold ${statusColor(status)}`}
                  >
                    {statusLabel(status)}
                  </span>
                </button>
              );
            })}
          </>
        )}
      </div>

      <div className="px-4 py-2 border-t border-border">
        <button
          onClick={() => void refresh()}
          disabled={isCommitting}
          className={`${INTERACTION_CLASS} text-xs text-fg-muted transition-colors disabled:opacity-50`}
        >
          Refresh
        </button>
      </div>
    </div>
  );
}
