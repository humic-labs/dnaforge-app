import { toUserMessage } from '@waypoint/user-messages';
import { observeProjectLifecyclePhase } from '../features/workspace-loader/workspace-telemetry';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { DragEvent, MouseEvent, KeyboardEvent } from 'react';

import { useFileBrowser, type FileEntry } from '../hooks/useFileBrowser';
import { useFolderGitState } from '../hooks/useFolderGitState';
import { useGitStatus } from '../hooks/useGitStatus';
import { useWorkspaceStore, type WorkspaceFolder } from '../stores/workspaceStore';
import type { TabType } from '../features/canvas/types';
import type { WorkspaceProject } from '../features/workspace-loader/workspace-projects';
import { openFileBrowserFile } from './open-file-browser-file';
import {
  findBrowserEntryById,
  findParentEntryId,
  flattenVisibleEntries,
  rangeBetweenEntryIds,
  sortBrowserEntries,
  withPendingArtifacts,
} from './fileBrowserTreeUtils';
import type {
  FileBrowserTreeEntry,
  FileSelectionIntent,
  PendingArtifactCreate,
  SelectionChangeHandler,
} from './fileBrowserTypes';
import { dispatchOpenNativeEntityReference } from '../features/page/editor/native-entity-links';
import {
  ChevronRotatableIcon,
  EllipsisIcon,
  FolderIcon,
  PlusIcon,
  ProjectRootIcon,
  SpinnerIcon,
} from './icons';
import { FileTreeItem } from './FileTreeItem';
import { Tooltip } from '../shared/components/Tooltip';
import { isPathInsideBoundary, pathRelativeToBoundary } from '../shared/path-boundary';
import { useShallow } from 'zustand/react/shallow';
import { hostedWorkspaceById } from '../hosted/workspace-roster';
import { parseHostedFsPath } from '../hosted/paths';
import { matchesAppShortcut } from '../keyboard/shortcutRegistry';
import { platform } from '../platform';
import { TrackViewLibraryEntries, useIsTrackViewLibrary } from './TrackViewLibraryEntries';

interface RootFolderProps {
  active?: boolean;
  folder: WorkspaceFolder;
  selectedEntryId: string | null;
  activeEntryId: string | null;
  selectedEntryIds: Set<string>;
  selectionAnchorEntryId: string | null;
  revealRequestId: number;
  revealTargetPath: string | null;
  revealTargetPaths?: readonly string[];
  renamingPath: string | null;
  onFileSelect: (path: string, tabType: TabType) => void;
  onSelectionChange: SelectionChangeHandler;
  onRootContextMenu: (e: MouseEvent, path: string) => void;
  onEntryContextMenu: (e: MouseEvent, entry: FileBrowserTreeEntry, workspaceRoot: string) => void;
  onRenameComplete: (oldPath: string, newName: string) => void;
  onRenameCancel: () => void;
  onStartRename?: (entry: FileEntry) => void;
  onOpenInNewPanel?: (path: string, tabType: TabType) => void;
  onFindInFolder?: (folderPath: string) => void;
  onDelete: (path: string) => void;
  pendingArtifacts: PendingArtifactCreate[];
  refreshToken: string;
  index?: number;
  draggable?: boolean;
  onDragStart?: (index: number) => void;
  onDragOver?: (e: DragEvent, index: number) => void;
  onDrop?: (e: DragEvent, index: number) => void;
  onDragEnd?: () => void;
  isDragOver?: boolean;
  project?: WorkspaceProject | null;
  onProjectMenu?: (e: MouseEvent<HTMLButtonElement>, project: WorkspaceProject) => void;
  onProjectCreateMenu?: (e: MouseEvent<HTMLButtonElement>, project: WorkspaceProject) => void;

  readOnly?: boolean;
  indexFailed?: boolean;
  onRetryIndex?: () => void;
}

const PinnedFolderMarker = () => (
  <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor" opacity={0.5}>
    <path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1-.707.707l-.71-.71-3.18 3.18a3.02 3.02 0 0 1-.149 2.908l-1.768 1.768a.5.5 0 0 1-.707 0L5.57 11.33l-3.54 3.54a.5.5 0 0 1-.708-.708l3.54-3.54L2.53 8.28a.5.5 0 0 1 0-.707l1.768-1.768a3.02 3.02 0 0 1 2.908-.149L10.384 2.48l-.71-.71a.5.5 0 0 1 .146-.853z" />
  </svg>
);

export function RootFolder({
  active = true,
  folder,
  selectedEntryId,
  activeEntryId,
  selectedEntryIds,
  selectionAnchorEntryId,
  revealRequestId,
  revealTargetPath,
  revealTargetPaths,
  renamingPath,
  onFileSelect,
  onSelectionChange,
  onRootContextMenu,
  onEntryContextMenu,
  onRenameComplete,
  onRenameCancel,
  onStartRename,
  onOpenInNewPanel,
  onFindInFolder,
  onDelete,
  pendingArtifacts,
  refreshToken,
  index,
  draggable: isDraggable = false,
  onDragOver,
  onDrop,
  onDragEnd,
  isDragOver,
  project,
  onProjectMenu,
  onProjectCreateMenu,
  readOnly = false,
  indexFailed = false,
  onRetryIndex,
}: RootFolderProps) {
  const isTrackViewLibrary = useIsTrackViewLibrary(folder.path);
  const rootElement = useRef<HTMLDivElement>(null);
  const {
    projectTreeReceipt,
    entries,
    loading,
    error,
    refresh,
    expandDirectory,
    expandPathChain,
    collapseDirectory,
    collapseOtherDirectories,
    expandedPaths,
    catalogEntriesByParent,
    partialError,
  } = useFileBrowser(folder.path, true);
  const refreshRef = useRef(refresh);

  const {
    expandedPaths: workspaceExpandedPaths,
    expandPath,
    collapsePath,
    collapseOthersRequest,
  } = useWorkspaceStore(
    useShallow((s) => ({
      expandedPaths: s.expandedPaths,
      expandPath: s.expandPath,
      collapsePath: s.collapsePath,
      collapseOthersRequest: s.collapseOthersRequest,
    }))
  );

  const lastCollapseOthersRequest = useRef(collapseOthersRequest);
  useEffect(() => {
    if (lastCollapseOthersRequest.current === collapseOthersRequest) return;
    lastCollapseOthersRequest.current = collapseOthersRequest;
    if (collapseOthersRequest) collapseOtherDirectories(collapseOthersRequest.path);
  }, [collapseOthersRequest, collapseOtherDirectories]);

  const { statusMap: gitStatusMap } = useGitStatus(folder.path);
  useFolderGitState(folder.path);

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  const didMountRef = useRef(false);
  const lastRevealRequestIdRef = useRef(0);
  const pendingRevealRef = useRef<{ requestId: number; paths: readonly string[] } | null>(null);
  const revealExpansionInFlight = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    void refreshRef.current();
  }, [refreshToken, folder.mountRequest]);

  useEffect(() => {
    if (revealRequestId > lastRevealRequestIdRef.current) {
      lastRevealRequestIdRef.current = revealRequestId;
      const paths = (
        revealTargetPaths?.length ? revealTargetPaths : revealTargetPath ? [revealTargetPath] : []
      ).filter((path) => isPathInsideBoundary(path, folder.path));
      pendingRevealRef.current = paths.length ? { requestId: revealRequestId, paths } : null;
      if (pendingRevealRef.current) {
        expandPath(folder.path);
      }
    }

    const pendingReveal = pendingRevealRef.current;
    if (!pendingReveal) return;
    if (pendingReveal.requestId !== revealRequestId) {
      pendingRevealRef.current = null;
      return;
    }

    const parentPathsSet = new Set<string>();
    for (const path of pendingReveal.paths) {
      if (pendingArtifacts.some((pending) => pending.path === path)) continue;
      const parts = pathRelativeToBoundary(path, folder.path)?.split('/') ?? [];
      let currentPath = folder.path;
      for (let i = 0; i < parts.length - 1; i++) {
        currentPath = `${currentPath}/${parts[i]}`;
        parentPathsSet.add(currentPath);
      }
    }
    const parentPaths = [...parentPathsSet].sort((a, b) => a.length - b.length);
    const allParentsExpanded = parentPaths.every((path) => expandedPaths.has(path));

    if (parentPaths.length > 0 && !allParentsExpanded && !revealExpansionInFlight.current) {
      revealExpansionInFlight.current = true;
      void expandPathChain(parentPaths).finally(() => {
        revealExpansionInFlight.current = false;
      });
    }
    if (allParentsExpanded) {
      pendingRevealRef.current = null;
    }
  }, [
    revealTargetPath,
    revealTargetPaths,
    folder.path,
    revealRequestId,
    entries,
    expandedPaths,
    expandPathChain,
    expandPath,
    pendingArtifacts,
  ]);

  const isExpanded = workspaceExpandedPaths.has(folder.path);
  useEffect(() => {
    if (!active || !isExpanded || loading || !projectTreeReceipt?.lifecycle) return;
    const frame = requestAnimationFrame(() => {
      if (!rootElement.current?.getClientRects().length || document.visibilityState === 'hidden')
        return;
      observeProjectLifecyclePhase(
        folder.path,
        projectTreeReceipt.lifecycle,
        projectTreeReceipt.phase
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [active, folder.path, isExpanded, loading, projectTreeReceipt]);
  const hostedIdentity = parseHostedFsPath(folder.path);
  const hostedWorkspace = hostedIdentity?.workspaceId
    ? hostedWorkspaceById(hostedIdentity.workspaceId)
    : undefined;

  const handleRootToggle = useCallback(() => {
    if (isExpanded) {
      collapsePath(folder.path);
    } else {
      expandPath(folder.path);
    }
  }, [isExpanded, folder.path, expandPath, collapsePath]);

  const handleToggle = useCallback(
    (path: string) => {
      if (expandedPaths.has(path)) {
        collapseDirectory(path);
      } else {
        expandDirectory(path);
      }
    },
    [expandedPaths, expandDirectory, collapseDirectory]
  );

  const visibleEntries = useMemo(
    () => withPendingArtifacts(entries, folder.path, pendingArtifacts),
    [entries, folder.path, pendingArtifacts]
  );
  const rootBrowserEntries = useMemo(
    () =>
      sortBrowserEntries([...visibleEntries, ...(catalogEntriesByParent.get(folder.path) ?? [])]),
    [catalogEntriesByParent, folder.path, visibleEntries]
  );

  useEffect(() => {
    const pendingParents = Array.from(
      new Set(
        pendingArtifacts
          .filter((pending) => isPathInsideBoundary(pending.parentPath, folder.path))
          .map((pending) => pending.parentPath)
      )
    );
    if (pendingParents.length === 0) return;

    expandPath(folder.path);
    const pathsToExpand = new Set<string>();
    for (const parentPath of pendingParents) {
      if (parentPath === folder.path) continue;
      const relativePath = pathRelativeToBoundary(parentPath, folder.path);
      if (relativePath == null) continue;
      const parts = relativePath.split('/').filter(Boolean);
      let currentPath = folder.path;
      for (const part of parts) {
        currentPath = `${currentPath}/${part}`;
        pathsToExpand.add(currentPath);
      }
    }
    if (pathsToExpand.size > 0) {
      void expandPathChain(Array.from(pathsToExpand));
    }
  }, [expandPath, expandPathChain, folder.path, pendingArtifacts]);

  const visibleFlatEntries = useMemo(
    () => flattenVisibleEntries(visibleEntries, expandedPaths, catalogEntriesByParent, folder.path),
    [catalogEntriesByParent, expandedPaths, folder.path, visibleEntries]
  );

  const visibleEntryIds = useMemo(
    () => visibleFlatEntries.map((entry) => entry.entryId),
    [visibleFlatEntries]
  );

  const selectionContextForEntryId = useCallback(
    (entryId: string) => {
      const entry = findBrowserEntryById(
        visibleEntries,
        entryId,
        catalogEntriesByParent,
        folder.path
      );
      if (!entry) return {};
      if (entry.kind === 'catalog') {
        return { activeTargetKind: 'catalog' as const, activeFilesystemPath: null };
      }
      return {
        activeTargetKind: entry.isDirectory ? ('folder' as const) : ('file' as const),
        activeFilesystemPath: entry.path,
      };
    },
    [catalogEntriesByParent, folder.path, visibleEntries]
  );

  const focusableEntryId = useMemo(() => {
    if (activeEntryId && visibleEntryIds.includes(activeEntryId)) return activeEntryId;
    if (selectedEntryId && visibleEntryIds.includes(selectedEntryId)) return selectedEntryId;
    return visibleEntryIds[0] ?? null;
  }, [activeEntryId, selectedEntryId, visibleEntryIds]);

  const handleSelect = useCallback(
    (entryId: string, intent: FileSelectionIntent = {}) => {
      if (visibleEntryIds.length === 0) return;
      if (!visibleEntryIds.includes(entryId)) return;

      if (intent.extend) {
        const anchor =
          selectionAnchorEntryId && visibleEntryIds.includes(selectionAnchorEntryId)
            ? selectionAnchorEntryId
            : selectedEntryId && visibleEntryIds.includes(selectedEntryId)
              ? selectedEntryId
              : entryId;
        onSelectionChange(
          new Set(rangeBetweenEntryIds(visibleEntryIds, anchor, entryId)),
          entryId,
          anchor,
          selectionContextForEntryId(entryId)
        );
        return;
      }

      if (intent.toggle) {
        const next = new Set(selectedEntryIds);
        if (next.has(entryId) && next.size > 1) {
          next.delete(entryId);
        } else {
          next.add(entryId);
        }
        onSelectionChange(next, entryId, entryId, selectionContextForEntryId(entryId));
        return;
      }

      onSelectionChange(new Set([entryId]), entryId, entryId, selectionContextForEntryId(entryId));
    },
    [
      onSelectionChange,
      selectedEntryId,
      selectedEntryIds,
      selectionAnchorEntryId,
      selectionContextForEntryId,
      visibleEntryIds,
    ]
  );

  const handleOpen = useCallback(
    (entry: FileBrowserTreeEntry) => {
      if (entry.kind === 'catalog') {
        dispatchOpenNativeEntityReference({
          entityId: entry.entityId,
          label: entry.name,
          owningRoot: folder.path,
        });
        return;
      }
      void openFileBrowserFile(entry, onFileSelect);
    },
    [folder.path, onFileSelect]
  );

  const handleKeyNavigate = useCallback(
    (entry: FileBrowserTreeEntry, e: KeyboardEvent) => {
      const take = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      const filePath = entry.kind === 'filesystem' ? entry.path : null;

      if (filePath && matchesAppShortcut(e, 'files.rename')) {
        if (!readOnly && filePath !== folder.path && onStartRename) {
          take();
          if (entry.kind === 'filesystem') onStartRename(entry);
        }
        return;
      }

      if (filePath && onFindInFolder && matchesAppShortcut(e, 'files.find-in-folder')) {
        take();
        const directory =
          entry.kind === 'filesystem' && entry.isDirectory
            ? entry.path
            : filePath.slice(0, Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')));
        onFindInFolder(directory || filePath);
        return;
      }

      if (filePath && matchesAppShortcut(e, 'files.copy-path')) {
        take();
        void navigator.clipboard.writeText(filePath);
        return;
      }

      if (filePath && matchesAppShortcut(e, 'files.copy-relative-path')) {
        const relativePath = pathRelativeToBoundary(folder.path, filePath);
        if (!relativePath) return;
        take();
        void navigator.clipboard.writeText(relativePath);
        return;
      }

      if (filePath && matchesAppShortcut(e, 'files.reveal')) {
        take();
        void platform()
          .shell.revealItemInDir(filePath)
          .catch((err) => {
            console.error('[RootFolder] Failed to reveal file:', err);
          });
        return;
      }

      if (
        entry.kind === 'filesystem' &&
        onOpenInNewPanel &&
        matchesAppShortcut(e, 'files.open-in-new-panel') &&
        !entry.isDirectory
      ) {
        take();
        void openFileBrowserFile(entry, onOpenInNewPanel);
        return;
      }

      if (e.altKey) return;

      const currentIndex = visibleEntryIds.indexOf(entry.entryId);
      if (currentIndex === -1) return;

      const selectByIndex = (index: number) => {
        const nextEntryId = visibleEntryIds[index];
        if (!nextEntryId) return;
        handleSelect(nextEntryId, { extend: e.shiftKey });
      };

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
        take();
        onSelectionChange(
          new Set(visibleEntryIds),
          entry.entryId,
          visibleEntryIds[0] ?? entry.entryId,
          selectionContextForEntryId(entry.entryId)
        );
        return;
      }

      switch (e.key) {
        case 'ArrowDown':
          take();
          selectByIndex(Math.min(currentIndex + 1, visibleEntryIds.length - 1));
          break;
        case 'ArrowUp':
          take();
          selectByIndex(Math.max(currentIndex - 1, 0));
          break;
        case 'Home':
          take();
          selectByIndex(0);
          break;
        case 'End':
          take();
          selectByIndex(visibleEntryIds.length - 1);
          break;
        case 'ArrowRight':
          take();
          if (entry.kind === 'catalog' || !entry.isDirectory) return;
          if (!expandedPaths.has(entry.path)) {
            expandDirectory(entry.path);
          } else if (entry.children?.length) {
            handleSelect(entry.children[0].entryId, { extend: e.shiftKey });
          }
          break;
        case 'ArrowLeft': {
          take();
          if (entry.kind === 'filesystem' && entry.isDirectory && expandedPaths.has(entry.path)) {
            collapseDirectory(entry.path);
            return;
          }
          const parentEntryId = findParentEntryId(
            visibleEntries,
            entry.entryId,
            catalogEntriesByParent,
            null,
            folder.path
          );
          if (parentEntryId) handleSelect(parentEntryId, { extend: e.shiftKey });
          break;
        }
        case 'Enter':
          take();
          if (e.metaKey || e.ctrlKey) return;
          if (entry.kind === 'filesystem' && entry.isDirectory) {
            handleToggle(entry.path);
          } else {
            handleOpen(entry);
          }
          break;
        case ' ':
          take();
          handleSelect(entry.entryId, { extend: e.shiftKey, toggle: !e.shiftKey });
          break;
      }
    },
    [
      collapseDirectory,
      catalogEntriesByParent,
      expandDirectory,
      expandedPaths,
      folder.path,
      handleOpen,
      handleSelect,
      handleToggle,
      onFindInFolder,
      onOpenInNewPanel,
      onSelectionChange,
      onStartRename,
      readOnly,
      selectionContextForEntryId,
      visibleEntries,
      visibleEntryIds,
    ]
  );

  const handleRootContextMenu = useCallback(
    (e: MouseEvent) => {
      e.preventDefault();
      onRootContextMenu(e, folder.path);
    },
    [folder.path, onRootContextMenu]
  );

  const handleProjectMenu = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.stopPropagation();
      if (project) onProjectMenu?.(e, project);
    },
    [onProjectMenu, project]
  );

  const handleProjectCreateMenu = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.stopPropagation();
      if (project && !readOnly) onProjectCreateMenu?.(e, project);
    },
    [onProjectCreateMenu, project, readOnly]
  );

  const displayName = project?.name.trim() || folder.name;

  return (
    <div ref={rootElement} data-workspace-root-path={folder.path}>
      {isDragOver && <div className="h-0.5 bg-accent" />}
      <div
        className={`group relative flex items-center hover:bg-bg-muted ${project ? 'bg-bg-subtle/40' : ''}`}
      >
        <button
          role="treeitem"
          aria-expanded={isExpanded}
          {...(hostedWorkspace
            ? {
                'data-testid': 'hosted-project',
                'data-workspace-id': hostedWorkspace.workspaceId,
                'data-client-workspace-id': hostedWorkspace.clientWorkspaceId ?? '',
              }
            : {})}
          data-entry-path={folder.path}
          data-file-drop-target="true"
          onClick={handleRootToggle}
          onContextMenu={handleRootContextMenu}
          draggable={isDraggable}
          onDragStart={(e) => {
            if (!isDraggable || index == null) return;
            e.dataTransfer.setData('application/x-waypoint-folder-reorder', String(index));
            e.dataTransfer.effectAllowed = 'move';
          }}
          onDragOver={(e) => {
            if (!isDraggable || index == null) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            onDragOver?.(e, index);
          }}
          onDrop={(e) => {
            if (!isDraggable || index == null) return;
            e.preventDefault();
            onDrop?.(e, index);
          }}
          onDragEnd={() => onDragEnd?.()}
          className={`flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden py-1.5 pl-2 pr-1 text-left group-hover:overflow-visible group-focus-within:overflow-visible ${
            isDraggable ? 'cursor-grab active:cursor-grabbing' : ''
          } data-[drop-active=true]:bg-accent/25 data-[drop-active=true]:ring-1 data-[drop-active=true]:ring-inset data-[drop-active=true]:ring-accent outline-none focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/45`}
        >
          {!isDraggable && !project && (
            <span className="flex w-3 flex-shrink-0 items-center justify-center text-fg-muted">
              <PinnedFolderMarker />
            </span>
          )}
          <span className="w-3 flex-shrink-0">
            <ChevronRotatableIcon expanded={isExpanded} />
          </span>
          {project ? (
            <span data-project-root-icon="true">
              <ProjectRootIcon />
            </span>
          ) : (
            <FolderIcon expanded={isExpanded} />
          )}
          <span
            data-testid="project-root-name"
            className="min-w-0 truncate text-sm font-semibold text-fg group-hover:overflow-visible group-hover:text-clip group-hover:whitespace-nowrap group-hover:bg-bg-muted group-focus-within:overflow-visible group-focus-within:text-clip group-focus-within:whitespace-nowrap group-focus-within:bg-bg-muted"
          >
            {displayName}
          </span>
        </button>
        {project && (
          <div
            data-testid="project-root-actions"
            className="relative z-20 mr-1 flex flex-shrink-0 items-center gap-0.5 group-hover:bg-bg-muted group-focus-within:bg-bg-muted"
          >
            {!readOnly &&
              (project.access ?? (folder.pinned ? 'reference' : 'writable')) !== 'reference' && (
                <Tooltip content={`Create in ${project.name}`} side="top">
                  <button
                    type="button"
                    aria-label={`Create in ${project.name}`}
                    data-testid="project-root-create-button"
                    data-project-path={project.repoPath}
                    onClick={handleProjectCreateMenu}
                    className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-fg-muted opacity-80 transition-colors hover:bg-bg-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 group-hover:opacity-100"
                  >
                    <PlusIcon className="h-3.5 w-3.5" />
                  </button>
                </Tooltip>
              )}
            <Tooltip content={`Project actions for ${project.name}`} side="top">
              <button
                type="button"
                aria-label={`Project actions for ${project.name}`}
                data-testid="project-root-menu-button"
                data-project-path={project.repoPath}
                onClick={handleProjectMenu}
                className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-fg-muted opacity-80 transition-colors hover:bg-bg-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 group-hover:opacity-100"
              >
                <EllipsisIcon />
              </button>
            </Tooltip>
          </div>
        )}
      </div>

      {indexFailed && (
        <div
          role="status"
          data-testid="project-index-error"
          className="mx-2 mb-1 rounded border border-warning/30 bg-warning/10 px-2 py-1 text-xs text-warning"
        >
          <p>Project records could not be loaded.</p>
          {onRetryIndex && (
            <button onClick={onRetryIndex} className="text-xs text-accent hover:underline">
              Retry project records
            </button>
          )}
        </div>
      )}
      {isExpanded && (
        <div className="pb-1">
          {isTrackViewLibrary ? (
            <TrackViewLibraryEntries
              onOpenView={(path) => onFileSelect(path, 'sequence')}
              activePath={revealTargetPath}
              refreshToken={refreshToken}
            />
          ) : (
            <>
              {partialError && (
                <div
                  className="mx-2 mb-1 rounded border border-warning/30 bg-warning/10 px-2 py-1 text-xs text-warning"
                  role="status"
                  data-testid="catalog-listing-partial-error"
                >
                  <p>Some registry items could not be loaded. Files remain available.</p>
                  <button onClick={refresh} className="text-xs text-accent hover:underline">
                    Retry registry items
                  </button>
                </div>
              )}
              {loading && rootBrowserEntries.length === 0 ? (
                <div className="px-4 py-2 flex items-center gap-2">
                  <SpinnerIcon />
                  <span className="text-xs text-fg-subtle">Loading...</span>
                </div>
              ) : error ? (
                <div className="px-4 py-2">
                  <p className="text-xs text-error mb-1">
                    {toUserMessage(error, 'operation.failed')}
                  </p>
                  <button onClick={refresh} className="text-xs text-accent hover:underline">
                    Retry
                  </button>
                </div>
              ) : rootBrowserEntries.length === 0 ? (
                <div className="px-4 py-2 text-xs text-fg-subtle italic">Empty folder</div>
              ) : (
                rootBrowserEntries.map((entry) => (
                  <FileTreeItem
                    key={entry.entryId}
                    entry={entry}
                    depth={1}
                    expandedPaths={expandedPaths}
                    selectedEntryId={selectedEntryId}
                    selectedEntryIds={selectedEntryIds}
                    focusableEntryId={focusableEntryId}
                    revealRequestId={revealRequestId}
                    revealTargetPath={revealTargetPath}
                    renamingPath={renamingPath}
                    gitStatusMap={gitStatusMap}
                    rootPath={folder.path}
                    catalogEntriesByParent={catalogEntriesByParent}
                    onToggle={handleToggle}
                    onSelect={handleSelect}
                    onOpen={handleOpen}
                    onKeyNavigate={handleKeyNavigate}
                    onContextMenu={(event, target) =>
                      onEntryContextMenu(event, target, folder.path)
                    }
                    onRenameComplete={onRenameComplete}
                    onRenameCancel={onRenameCancel}
                    onDelete={onDelete}
                    dragToMoveEnabled={!readOnly}
                  />
                ))
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
