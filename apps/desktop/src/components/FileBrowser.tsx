import { INTERACTION_CLASS } from '@waypoint/ui-components';
import {
  toUserMessage,
  userMessage,
  userMessageWithValues,
  userMessageValue,
  UserMessageError,
} from '@waypoint/user-messages';
import { useProjectEditFolders } from '../features/workspace-loader/public/use-project-edit-folders';
import { projectPathIsReadOnly } from '../features/workspace-loader/public/project-edit-folders';
import {
  useCallback,
  useState,
  useRef,
  useEffect,
  useMemo,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import type { CatalogRecordPresentationKind } from '../shared/catalog-entity';
import { useWorkspaceStore, type WorkspaceFolder } from '../stores/workspaceStore';
import { formatImportProgress } from '../features/workspace-loader/format-import-progress';
import { confirmDialog } from './confirm-dialog-store';
import { useToastStore } from '../stores/toast-store';
import { notifyGitStatusChanged } from '../hooks/useGitStatus';
import { useFolderGitState } from '../hooks/useFolderGitState';
import { FileContextMenu } from './FileContextMenu';
import { ActionMenu, type ActionMenuEntry } from './ActionMenu';
import { FileTrash } from './FileTrash';
import {
  FileLifecycleError,
  deleteWorkspaceFile,
} from '../features/workspace/public/file-lifecycle-commands';
import {
  archiveWorkspaceByPath,
  type WorkspaceLibraryEntry,
} from '../features/workspace-loader/workspace-library';
import { removalWouldLeaveNoWorkspace } from '../features/workspace-loader/workspace-existence-guard';
import { type WorkspaceProject } from '../features/workspace-loader/workspace-projects';
import { SpinnerIcon } from './icons';
import { ProjectSwitcherPopover } from './ProjectSwitcherPopover';
import { isPathInsideBoundary } from '../shared/path-boundary';
import { platform } from '../platform';
import { isBrowserOnly, isHostedBrowserRuntime } from '../utils/environment';
import { getTabTypeForFile } from '../utils/fileTypes';
import { isManagedCatalogHeadCandidate } from '../shared/catalog-file-kind';
import type { TabType } from '../features/canvas/types';
import { gitInit } from '../features/workspace/git';
import {
  findWorkspaceRootForPath,
  getCatalogFileForPath,
  registerWorkspaceFile,
} from '../db/workspace-catalog';

import { relocateRegistryFile } from '../features/workspace/relocate-registry-file';
import {
  normalizeWorkspaceArtifactFileName,
  recordWorkspaceArtifactFileRenameInProjectMemory,
} from '../db/workspace-artifacts';
import {
  COMMAND_IDS,
  COMMAND_SCOPES,
  useCommandHandler,
  useCommandRegistry,
  useCommandScope,
} from '../commands';
import { workspaceRelativePathForPath } from './fileBrowserTreeUtils';
import { withRendererWorkspaceMutation } from '../services/workspace-mutation-transaction';
import { copyAcceptedScientificPath } from '../services/copy-scientific-resource';
import { nextAvailableFolderName, createFolderArtifact } from './folder-create';
import { RootFolder } from './RootFolder';
import {
  ExplorerAddPicker,
  ExplorerAddHeader,
  buildExplorerAddEntries,
  type ExplorerAddEntriesOptions,
  type ExplorerAssemblyCreateRequest,
  type ExplorerEntityCreateRequest,
  type ExplorerEntityImportRequest,
} from './ExplorerAddPicker';
import {
  normalizeEmptyDnaSequenceName,
  SequenceCreationPendingError,
} from '../features/sequence/create-empty-dna-sequence';
import type {
  FileBrowserTreeEntry,
  FileSelectionContext,
  PendingArtifactCreate,
  PendingArtifactKind,
  WorkspaceCreateHandler,
  WorkspaceCreationContext,
} from './fileBrowserTypes';
import {
  dispatchOpenNativeEntityReference,
  dispatchViewOriginalNativeEntitySource,
} from '../features/page/editor/native-entity-links';
import { OriginalProviderSourceDialog } from '../features/lims/components/registry/OriginalProviderSourceDialog';
import type { ExternalProviderSourceRequest } from '../shared/benchling-migration-raw-source';
import { beginWorkflowAction, observeWorkflowAction } from '../lib/workflow-telemetry';
import { fileTypeCategory } from '../features/sequence/public/file-open-telemetry';
import type { ManagedSequenceDocumentRef } from '../shared/managed-sequence-document';
import type { FileEntry } from '../hooks/useFileBrowser';
import type { DocumentPackageKind } from '../shared/document-package';
import { fileMenuPathActions } from './file-menu-path-actions';
import { beginSequenceEntryRename } from './sequence-entry-rename';
import { openFileBrowserFile } from './open-file-browser-file';

export type { WorkspaceCreationContext } from './fileBrowserTypes';

interface FileBrowserProps {
  active?: boolean;
  onFileSelect: (path: string, tabType: TabType) => void;
  onOpenInNewPanel?: (path: string, tabType: TabType) => void;
  onAddFolder: () => void;
  onImportFile?: () => void;
  onImportEntity?: (request: ExplorerEntityImportRequest) => void;
  onImportProject?: () => void;
  onImportProjectWithAgent?: () => void;
  onMigrateFromBenchling?: () => void;
  onCreateEntity?: (
    request: ExplorerEntityCreateRequest & { name?: string }
  ) => void | Promise<{ filePath: string } | void>;
  onCreateAssembly?: (request: ExplorerAssemblyCreateRequest) => void;
  mountedProjects?: WorkspaceProject[];
  failedProjectIndexRoots?: ReadonlySet<string>;
  onRetryProjectIndex?: (rootPath: string) => void;
  onOpenProject?: (workspace: WorkspaceLibraryEntry) => void;
  onCreateProject?: (name: string) => Promise<boolean>;
  onOpenProjectHome?: (repoPath: string) => void;
  onRenameProject?: (repoPath: string) => void | Promise<void>;
  onArchiveProject?: (repoPath: string) => void | Promise<void>;
  onTrashProject?: (repoPath: string) => void | Promise<void>;
  onNewNotebook?: WorkspaceCreateHandler;
  onNewAssembly?: WorkspaceCreateHandler;
  onWorkspaceChanged?: (rootPath: string | null) => void | Promise<void>;
  onFindInFolder?: (path: string) => void;
  refreshSignal?: number;
  selectedPath?: string | null;
}

function isArtifactPendingKind(
  kind: PendingArtifactKind
): kind is Extract<PendingArtifactKind, 'notebook' | 'assembly'> {
  return kind === 'notebook' || kind === 'assembly';
}

function artifactTypeForPendingKind(
  kind: Extract<PendingArtifactKind, 'notebook' | 'assembly'>
): 'notebook' | 'design' {
  return kind === 'notebook' ? 'notebook' : 'design';
}

function defaultArtifactFileName(kind: PendingArtifactKind): string {
  if (kind === 'notebook') return 'Untitled';
  if (kind === 'assembly') return 'Untitled.wpdesign.json';
  if (kind === 'dna-sequence') return 'Untitled DNA sequence';
  if (kind === 'table') return 'Untitled table';
  if (kind === 'folder') return 'New Folder';
  return 'Untitled.txt';
}

interface FilesystemContextMenuState {
  kind: 'filesystem';
  x: number;
  y: number;
  entryId: string;
  path: string;
  relativePath: string | null;
  displayName: string;
  isDirectory: boolean;
  isNotebookPackage?: boolean;
  packageKind?: DocumentPackageKind;
  sequenceDocument?: ManagedSequenceDocumentRef;
  documentAvailability?: FileEntry['documentAvailability'];
  isRootFolder: boolean;
  pinned: boolean;
}

interface CatalogContextMenuState {
  kind: 'catalog';
  x: number;
  y: number;
  entryId: string;
  workspaceId: number;
  entityId: string;
  sourceRecordId: string | null;
  displayName: string;
  presentationKind: CatalogRecordPresentationKind;
  workspaceRoot: string;
}

type ContextMenuState = FilesystemContextMenuState | CatalogContextMenuState;

interface AddPickerLaunch {
  anchorPoint: { x: number; y: number };
  destinationLabel: string;
  destinationPath: string;
}

function getCreationParentPath(targetPath: string, targetKind: 'file' | 'folder'): string {
  if (targetKind === 'folder') {
    return targetPath;
  }
  const lastSlash = targetPath.lastIndexOf('/');
  return lastSlash >= 0 ? targetPath.slice(0, lastSlash) : targetPath;
}

function getCreationContext(
  contextMenu: FilesystemContextMenuState,
  folders: WorkspaceFolder[]
): WorkspaceCreationContext {
  const targetKind = contextMenu.isDirectory ? 'folder' : 'file';
  return {
    targetPath: contextMenu.path,
    targetKind,
    parentPath: getCreationParentPath(contextMenu.path, targetKind),
    workspaceRoot: findWorkspaceRootForPath(folders, contextMenu.path),
  };
}

function pathIsAtOrUnder(path: string, root: string): boolean {
  return isPathInsideBoundary(path, root);
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

function filesystemEntryId(path: string): string {
  return `filesystem:${path}`;
}

function filesystemPathFromEntryId(entryId: string): string | null {
  return entryId.startsWith('filesystem:') ? entryId.slice('filesystem:'.length) : null;
}

function withoutNestedDeleteTargets(paths: string[]): string[] {
  const uniquePaths = Array.from(new Set(paths)).sort((a, b) => a.length - b.length);
  return uniquePaths.filter(
    (path, index) =>
      !uniquePaths.slice(0, index).some((parentPath) => pathIsAtOrUnder(path, parentPath))
  );
}

function ContextMenuWithGit({
  contextMenu,
  onClose,
  onOpen,
  onOpenInNewPanel,
  onRename,
  onDuplicate,
  onMoveTo,
  onDelete,
  onNewNotebook,
  onNewAssembly,
  onNewTextFile,
  onNewFolder,
  newMenuEntries,
  newMenuHeader,
  newMenuLabel,
  newMenuDataAttributes,
  onFindInFolder,
  onCollapseOthers,
  onRemoveFromWorkspace,
  onRenameProject,
  onArchiveProject,
  onTrashProject,
  onProjectHistory,
  onWorkspaceChanged,
}: {
  contextMenu: FilesystemContextMenuState;
  onClose: () => void;
  onOpen?: () => void;
  onOpenInNewPanel?: () => void;
  onRename?: () => void;
  onDuplicate?: () => void;
  onMoveTo?: () => void;
  onDelete?: () => void;
  onNewNotebook?: () => void;
  onNewAssembly?: () => void;
  onNewTextFile?: () => void;
  onNewFolder?: () => void;
  newMenuEntries?: readonly ActionMenuEntry[];
  newMenuHeader?: ReactNode;
  newMenuLabel?: string;
  newMenuDataAttributes?: Record<`data-${string}`, string | undefined>;
  onFindInFolder?: () => void;
  onCollapseOthers?: () => void;
  onRemoveFromWorkspace?: () => void;
  onRenameProject?: () => void;
  onArchiveProject?: () => void;
  onTrashProject?: () => void;
  onProjectHistory?: () => void;
  onWorkspaceChanged?: (rootPath: string | null) => void | Promise<void>;
}) {
  const folderPath = contextMenu.isRootFolder && !contextMenu.pinned ? contextMenu.path : null;
  const { state: gitState, refresh: refreshGitState } = useFolderGitState(folderPath);
  const [initializing, setInitializing] = useState(false);

  const handleInitGit = useCallback(async () => {
    if (!folderPath) return;
    setInitializing(true);
    try {
      await gitInit(folderPath);
      await refreshGitState();
      notifyGitStatusChanged(folderPath);
      void Promise.resolve(onWorkspaceChanged?.(folderPath));
    } catch (err) {
      console.error('[FileBrowser] git init failed:', err);
    } finally {
      setInitializing(false);
    }
  }, [folderPath, onWorkspaceChanged, refreshGitState]);

  return (
    <FileContextMenu
      position={{ x: contextMenu.x, y: contextMenu.y }}
      {...fileMenuPathActions(contextMenu.path, contextMenu.relativePath)}
      displayName={contextMenu.displayName}
      isDirectory={contextMenu.isDirectory}
      isRootFolder={contextMenu.isRootFolder}
      gitState={folderPath ? gitState : undefined}
      onInitGit={folderPath && gitState === 'not-initialized' ? handleInitGit : undefined}
      gitInitInProgress={initializing}
      onClose={onClose}
      onOpen={onOpen}
      onOpenInNewPanel={onOpenInNewPanel}
      onRename={onRename}
      onDuplicate={onDuplicate}
      onMoveTo={onMoveTo}
      onDelete={onDelete}
      onNewNotebook={onNewNotebook}
      onNewAssembly={onNewAssembly}
      onNewTextFile={onNewTextFile}
      onNewFolder={onNewFolder}
      newMenuEntries={newMenuEntries}
      newMenuHeader={newMenuHeader}
      newMenuLabel={newMenuLabel}
      newMenuDataAttributes={newMenuDataAttributes}
      onFindInFolder={contextMenu.isDirectory ? onFindInFolder : undefined}
      onCollapseOthers={onCollapseOthers}
      pinnedRoot={contextMenu.pinned}
      onRemoveFromWorkspace={onRemoveFromWorkspace}
      onRenameProject={onRenameProject}
      onArchiveProject={onArchiveProject}
      onTrashProject={onTrashProject}
      onProjectHistory={onProjectHistory}
    />
  );
}

function CatalogContextMenu({
  contextMenu,
  onClose,
  onOpen,
  onViewOriginalSource,
}: {
  contextMenu: CatalogContextMenuState;
  onClose: () => void;
  onOpen: () => void;
  onViewOriginalSource: () => void;
}) {
  return (
    <ActionMenu
      open
      label={`Actions for ${contextMenu.displayName}`}
      anchorPoint={{ x: contextMenu.x, y: contextMenu.y }}
      onClose={onClose}
      testId="catalog-entry-context-menu"
      dataAttributes={{ 'data-analytics-block': 'true' }}
      entries={[
        { id: 'open-registry', label: 'Open in Registry', onSelect: onOpen },
        { id: 'view-source', label: 'View original source', onSelect: onViewOriginalSource },
      ]}
    />
  );
}

export function FileBrowser({
  active = true,
  onFileSelect,
  onOpenInNewPanel,
  onAddFolder,
  onCreateEntity,
  onCreateAssembly,
  onImportEntity,
  onImportProject,
  onImportProjectWithAgent,
  onMigrateFromBenchling,
  mountedProjects = [],
  failedProjectIndexRoots,
  onRetryProjectIndex,
  onOpenProject,
  onCreateProject,
  onOpenProjectHome,
  onRenameProject,
  onArchiveProject,
  onTrashProject,
  onNewNotebook,
  onNewAssembly,
  onWorkspaceChanged,
  onFindInFolder,
  refreshSignal,
  selectedPath,
}: FileBrowserProps) {
  const {
    folders,
    pendingImports = [],
    revealRequestId,
    revealTargetPath,
    revealTargetPaths,
    removeFolder,
    reorderFolders,
    expandPath,
    setSelectedPath,
    revealPath,
  } = useWorkspaceStore();

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const filesystemContextMenu = contextMenu?.kind === 'filesystem' ? contextMenu : null;
  const catalogContextMenu = contextMenu?.kind === 'catalog' ? contextMenu : null;
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [pendingArtifacts, setPendingArtifacts] = useState<PendingArtifactCreate[]>([]);
  const [treeSelectedEntryIds, setTreeSelectedEntryIds] = useState<Set<string>>(new Set());
  const [activeTreeEntryId, setActiveTreeEntryId] = useState<string | null>(null);
  const [activeTreeFilesystemPath, setActiveTreeFilesystemPath] = useState<string | null>(null);
  const [activeTreeTargetKind, setActiveTreeTargetKind] = useState<
    'file' | 'folder' | 'catalog' | null
  >(null);
  const [selectionAnchorEntryId, setSelectionAnchorEntryId] = useState<string | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [addPickerLaunch, setAddPickerLaunch] = useState<AddPickerLaunch | null>(null);
  const [originalSourceDialog, setOriginalSourceDialog] = useState<{
    request: ExternalProviderSourceRequest;
    label: string;
  } | null>(null);
  const externalSelectedPath = renamingPath ?? selectedPath ?? null;
  const effectiveSelectedPath =
    renamingPath ?? (activeTreeEntryId ? activeTreeFilesystemPath : (selectedPath ?? null));
  const effectiveSelectedEntryId =
    (renamingPath ? filesystemEntryId(renamingPath) : activeTreeEntryId) ??
    (selectedPath ? filesystemEntryId(selectedPath) : null);
  const refreshKey = `${refreshTrigger}-${refreshSignal ?? 0}`;
  const pendingInternalSelectionRef = useRef<{
    path: string;
    previousExternalPath: string | null;
  } | null>(null);
  const fileTreeScope = useCommandScope(COMMAND_SCOPES.sidebarFileTree, { enabled: active });
  const { dispatchCommand } = useCommandRegistry();
  const handleFileOpen = useCallback(
    (path: string, tabType: TabType) => {
      fileTreeScope.release();
      onFileSelect(path, tabType);
    },
    [fileTreeScope, onFileSelect]
  );

  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const [projectSwitcher, setProjectSwitcher] = useState<{
    x: number;
    y: number;
  } | null>(null);

  const unpinnedFolders = useMemo(() => folders.filter((f) => !f.pinned), [folders]);
  const pinnedFolders = useMemo(() => folders.filter((f) => f.pinned), [folders]);
  const selectedPathRoot = useMemo(
    () => (effectiveSelectedPath ? findWorkspaceRootForPath(folders, effectiveSelectedPath) : null),
    [effectiveSelectedPath, folders]
  );
  const handleTreeSelectionChange = useCallback(
    (
      nextSelectedEntryIds: Set<string>,
      activeEntryId: string,
      anchorEntryId: string,
      context?: FileSelectionContext
    ) => {
      const activeFilesystemPath = context?.activeFilesystemPath ?? null;
      pendingInternalSelectionRef.current = activeFilesystemPath
        ? {
            path: activeFilesystemPath,
            previousExternalPath: externalSelectedPath,
          }
        : null;
      setTreeSelectedEntryIds(new Set(nextSelectedEntryIds));
      setActiveTreeEntryId(activeEntryId);
      setActiveTreeFilesystemPath(activeFilesystemPath);
      setActiveTreeTargetKind(context?.activeTargetKind ?? null);
      setSelectionAnchorEntryId(anchorEntryId);
      if (activeFilesystemPath) setSelectedPath(activeFilesystemPath);
      if (
        activeFilesystemPath &&
        context?.activeTargetKind === 'folder' &&
        activeFilesystemPath !== activeTreeFilesystemPath
      ) {
        observeWorkflowAction({
          workflow: 'navigation',
          action: 'navigate',
          status: 'completed',
        });
      }
    },
    [activeTreeFilesystemPath, externalSelectedPath, setSelectedPath]
  );

  const handleFolderDragStart = useCallback((index: number) => {
    setIsDragging(true);
    setDragOverIndex(null);
    void index;
  }, []);

  const handleFolderDragOver = useCallback((_e: ReactDragEvent, index: number) => {
    setDragOverIndex(index);
  }, []);

  const handleFolderDrop = useCallback(
    (e: ReactDragEvent, targetIndex: number) => {
      const sourceIndexStr = e.dataTransfer.getData('application/x-waypoint-folder-reorder');
      if (!sourceIndexStr) return;
      const sourceUnpinnedIndex = parseInt(sourceIndexStr, 10);
      if (isNaN(sourceUnpinnedIndex)) return;

      const sourceFolder = unpinnedFolders[sourceUnpinnedIndex];
      const targetFolder = unpinnedFolders[targetIndex];
      if (!sourceFolder || !targetFolder) return;

      const absoluteFrom = folders.indexOf(sourceFolder);
      const absoluteTo = folders.indexOf(targetFolder);
      if (absoluteFrom >= 0 && absoluteTo >= 0) {
        reorderFolders(absoluteFrom, absoluteTo);
      }

      setDragOverIndex(null);
      setIsDragging(false);
    },
    [folders, unpinnedFolders, reorderFolders]
  );

  const handleFolderDragEnd = useCallback(() => {
    setDragOverIndex(null);
    setIsDragging(false);
  }, []);

  const handleRootContextMenu = useCallback(
    (e: ReactMouseEvent, path: string) => {
      e.preventDefault();
      setAddPickerLaunch(null);
      const rootFolder = folders.find((f) => f.path === path);
      if (!rootFolder) return;
      setContextMenu({
        kind: 'filesystem',
        x: e.clientX,
        y: e.clientY,
        entryId: filesystemEntryId(path),
        path,
        relativePath: workspaceRelativePathForPath(folders, path),
        displayName: rootFolder.name,
        isDirectory: true,
        isNotebookPackage: false,
        isRootFolder: true,
        pinned: rootFolder.pinned ?? false,
      });
    },
    [folders]
  );

  const handleEntryContextMenu = useCallback(
    (e: ReactMouseEvent, entry: FileBrowserTreeEntry, workspaceRoot: string) => {
      e.preventDefault();
      setAddPickerLaunch(null);
      if (entry.kind === 'catalog') {
        setContextMenu({
          kind: 'catalog',
          x: e.clientX,
          y: e.clientY,
          entryId: entry.entryId,
          workspaceId: entry.workspaceId,
          entityId: entry.entityId,
          sourceRecordId: entry.sourceRecordId,
          displayName: entry.name,
          presentationKind: entry.presentationKind,
          workspaceRoot,
        });
        return;
      }
      setContextMenu({
        kind: 'filesystem',
        x: e.clientX,
        y: e.clientY,
        entryId: entry.entryId,
        path: entry.path,
        relativePath: workspaceRelativePathForPath(folders, entry.path),
        displayName: entry.name,
        isDirectory: entry.isDirectory,
        isNotebookPackage: entry.isNotebookPackage ?? false,
        packageKind: entry.packageKind,
        sequenceDocument: entry.sequenceDocument,
        documentAvailability: entry.documentAvailability,
        isRootFolder: false,
        pinned: folders.find((folder) => folder.path === workspaceRoot)?.pinned ?? false,
      });
    },
    [folders]
  );

  const handleProjectMenuClick = useCallback(
    (e: ReactMouseEvent<HTMLButtonElement>, project: WorkspaceProject) => {
      const rect = e.currentTarget.getBoundingClientRect();
      setAddPickerLaunch(null);
      setProjectSwitcher(null);
      setContextMenu({
        kind: 'filesystem',
        x: rect.left,
        y: rect.bottom + 4,
        entryId: filesystemEntryId(project.repoPath),
        path: project.repoPath,
        displayName: project.name,
        relativePath: null,
        isDirectory: true,
        isRootFolder: true,
        pinned: project.access === 'reference',
      });
    },
    []
  );

  const handleProjectCreateMenuClick = useCallback(
    (e: ReactMouseEvent<HTMLButtonElement>, project: WorkspaceProject) => {
      const rect = e.currentTarget.getBoundingClientRect();
      setContextMenu(null);
      setProjectSwitcher(null);
      setAddPickerLaunch({
        anchorPoint: { x: rect.left, y: rect.bottom + 4 },
        destinationLabel: project.name,
        destinationPath: project.repoPath,
      });
    },
    []
  );

  const handleProjectSwitcherClick = useCallback((e: ReactMouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setContextMenu(null);
    setAddPickerLaunch(null);
    setProjectSwitcher((current) => (current ? null : { x: rect.left - 5, y: rect.top - 5 }));
  }, []);

  const handleRemoveFromWorkspace = useCallback(() => {
    if (!filesystemContextMenu) return;
    const isE2E = new URLSearchParams(window.location.search).get('e2e') === 'true';
    if (!isE2E && removalWouldLeaveNoWorkspace(folders, filesystemContextMenu.path)) {
      useToastStore
        .getState()
        .addToast(
          userMessage(
            'notice.you-can-t-remove-your-only-project-dnaforge-always-keeps-at-least-one-'
          ),
          {
            definition:
              'file-browser-you-can-t-remove-your-only-project-dnaforge-always-keeps-at-least-one-open',
          }
        );
      return;
    }
    removeFolder(filesystemContextMenu.path);
  }, [filesystemContextMenu, folders, removeFolder]);

  const archiveProjectPath = useCallback(
    async (repoPath: string, label: string) => {
      if (onArchiveProject) {
        await Promise.resolve(onArchiveProject(repoPath));
        return;
      }
      const isE2E = new URLSearchParams(window.location.search).get('e2e') === 'true';
      if (!isE2E && removalWouldLeaveNoWorkspace(folders, repoPath)) {
        useToastStore
          .getState()
          .addToast(
            userMessageWithValues(
              'notice.you-can-t-archive-value-it-s-your-only-project-and-dnaforge-always-kee',
              { value0: userMessageValue(label) }
            ),
            {
              definition:
                'file-browser-you-can-t-archive-example-it-s-your-only-project-and-dnaforge-always-keep',
            }
          );
        return;
      }
      if (
        !(await confirmDialog({
          title: userMessage('dialog.archive-project'),
          message: userMessageWithValues(
            'dialog.archive-value-it-moves-to-your-archived-projects-you-can-restore-it-an',
            { value0: userMessageValue(label) }
          ),
          confirmLabel: userMessage('dialog.archive'),
        }))
      ) {
        return;
      }
      let changed = 0;
      try {
        changed = await archiveWorkspaceByPath(repoPath);
      } catch (err) {
        useToastStore.getState().addToast(toUserMessage(err, 'operation.failed'), {
          definition: 'file-browser-couldn-t-archive-example',
        });
        return;
      }
      if (changed === 0) {
        useToastStore.getState().addToast(
          userMessageWithValues('notice.couldn-t-archive-value-it-isn-t-a-managed-project-yet', {
            value0: userMessageValue(label),
          }),
          {
            definition: 'file-browser-couldn-t-archive-example-it-isn-t-a-managed-project-yet',
          }
        );
        return;
      }
      removeFolder(repoPath);
    },
    [folders, onArchiveProject, removeFolder]
  );

  const handleArchiveContextProject = useCallback(async () => {
    if (!filesystemContextMenu) return;
    await archiveProjectPath(filesystemContextMenu.path, basename(filesystemContextMenu.path));
  }, [archiveProjectPath, filesystemContextMenu]);

  const handleTrashContextProject = useCallback(() => {
    if (filesystemContextMenu) void onTrashProject?.(filesystemContextMenu.path);
  }, [filesystemContextMenu, onTrashProject]);

  const handleRenameContextProject = useCallback(() => {
    if (filesystemContextMenu) void onRenameProject?.(filesystemContextMenu.path);
  }, [filesystemContextMenu, onRenameProject]);

  const handleProjectHistoryContext = useCallback(() => {
    if (filesystemContextMenu) onOpenProjectHome?.(filesystemContextMenu.path);
  }, [filesystemContextMenu, onOpenProjectHome]);

  const mountedProjectByPath = useMemo(
    () => new Map(mountedProjects.map((project) => [project.repoPath, project])),
    [mountedProjects]
  );
  const projectEditFolders = useProjectEditFolders();
  const projectAllowsWritesForPath = useCallback(
    (path: string): boolean => {
      if (projectPathIsReadOnly(path, projectEditFolders)) return false;
      const rootPath = findWorkspaceRootForPath(folders, path);
      if (!rootPath) return true;
      const rootFolder = folders.find((folder) => folder.path === rootPath);
      return (
        rootFolder?.pinned !== true && mountedProjectByPath.get(rootPath)?.access !== 'reference'
      );
    },
    [folders, mountedProjectByPath, projectEditFolders]
  );
  const contextAllowsWrites =
    filesystemContextMenu !== null && projectAllowsWritesForPath(filesystemContextMenu.path);
  const isManagedContextRoot =
    !!filesystemContextMenu &&
    filesystemContextMenu.isRootFolder &&
    mountedProjectByPath.get(filesystemContextMenu.path)?.access !== 'reference' &&
    mountedProjectByPath.has(filesystemContextMenu.path);
  const openRepoPaths = folders.map((folder) => folder.path);

  const handleContextMenuOpen = useCallback(() => {
    if (!filesystemContextMenu) return;
    if (!filesystemContextMenu.isDirectory) {
      void openFileBrowserFile(filesystemContextMenu, handleFileOpen);
    }
  }, [filesystemContextMenu, handleFileOpen]);

  const handleContextMenuOpenInNewPanel = useCallback(() => {
    if (!filesystemContextMenu || !onOpenInNewPanel) return;
    if (!filesystemContextMenu.isDirectory) {
      void openFileBrowserFile(filesystemContextMenu, onOpenInNewPanel);
    }
  }, [filesystemContextMenu, onOpenInNewPanel]);

  const handleCatalogContextOpen = useCallback(() => {
    if (!catalogContextMenu) return;
    dispatchOpenNativeEntityReference({
      entityId: catalogContextMenu.entityId,
      label: catalogContextMenu.displayName,
      owningRoot: catalogContextMenu.workspaceRoot,
    });
  }, [catalogContextMenu]);

  const handleCatalogContextViewOriginalSource = useCallback(() => {
    if (!catalogContextMenu) return;
    if (!catalogContextMenu.sourceRecordId) {
      useToastStore
        .getState()
        .addToast(userMessage('notice.this-record-has-no-exact-original-source-binding'), {
          definition: 'file-browser-this-record-has-no-exact-original-source-binding',
        });
      return;
    }
    const request = {
      workspaceId: catalogContextMenu.workspaceId,
      entityId: catalogContextMenu.entityId,
      sourceRecordId: catalogContextMenu.sourceRecordId,
    } satisfies ExternalProviderSourceRequest;
    setOriginalSourceDialog({ request, label: catalogContextMenu.displayName });
    dispatchViewOriginalNativeEntitySource({ ...request, label: catalogContextMenu.displayName });
  }, [catalogContextMenu]);

  const handleRenameFilesystemEntry = useCallback(
    (entry: Pick<FileEntry, 'path' | 'name' | 'packageKind' | 'sequenceDocument'>) => {
      if (!beginSequenceEntryRename(entry)) setRenamingPath(entry.path);
    },
    []
  );

  const handleStartRename = useCallback(() => {
    if (filesystemContextMenu) {
      handleRenameFilesystemEntry({
        path: filesystemContextMenu.path,
        name: filesystemContextMenu.displayName,
        packageKind: filesystemContextMenu.packageKind,
        sequenceDocument: filesystemContextMenu.sequenceDocument,
      });
      setContextMenu(null);
    }
  }, [filesystemContextMenu, handleRenameFilesystemEntry]);

  const handleDuplicate = useCallback(async () => {
    if (
      !filesystemContextMenu ||
      (filesystemContextMenu.isDirectory && filesystemContextMenu.packageKind !== 'sequence') ||
      filesystemContextMenu.isNotebookPackage
    ) {
      return;
    }
    const sourcePath = filesystemContextMenu.path;
    const workspaceRoot = findWorkspaceRootForPath(folders, sourcePath);
    setContextMenu(null);

    if (!workspaceRoot || !projectAllowsWritesForPath(sourcePath)) {
      useToastStore.getState().addToast(userMessage('notice.reference-projects-are-read-only'), {
        definition: 'file-browser-reference-projects-are-read-only',
      });
      return;
    }
    if (isBrowserOnly()) {
      console.log('[FileBrowser] Browser mode - duplicate simulated:', sourcePath);
      return;
    }

    const telemetry = beginWorkflowAction({
      workflow: 'file',
      action: 'duplicate',
      fileTypeCategory: fileTypeCategory(sourcePath),
    });
    try {
      const duplicatePath =
        filesystemContextMenu.packageKind === 'table'
          ? await (async () => {
              const opened = await platform().fs.tableDocument({
                kind: 'open',
                location: { workspaceRoot, packageRoot: sourcePath },
              });
              if (opened.kind !== 'resolved' || opened.table.owner.kind !== 'file')
                throw new Error('Open the current table before making an independent copy.');
              const source = await platform().fs.fileDocument({
                target: { documentId: opened.table.owner.documentId },
                operation: {
                  kind: 'inspect',
                  offset: 0,
                  limit: 2000,
                  rowOffset: 0,
                  rowLimit: 20,
                  columnOffset: 0,
                  columnLimit: 20,
                },
              });
              const name = basename(sourcePath);
              const parent = sourcePath.slice(0, -(name.length + 1));
              for (let index = 1; index <= 10000; index++) {
                const candidate = `${parent}/${name} copy${index === 1 ? '' : ` ${index}`}`;
                if (await platform().fs.exists(candidate)) continue;
                const copied = await platform().fs.tableDocument({
                  kind: 'copy',
                  requestId: crypto.randomUUID(),
                  source: opened.table.reference,
                  expectedRevision: source.revision,
                  destination: { workspaceRoot, packageRoot: candidate },
                  title: `${name} copy`,
                });
                if (copied.kind !== 'created')
                  throw new Error('The table copy is pending recovery.');
                return candidate;
              }
              throw new Error('Could not choose an available table copy name.');
            })()
          : filesystemContextMenu.packageKind === 'sequence' && isHostedBrowserRuntime()
            ? await (
                await import('../hosted/duplicate-sequence-package')
              ).duplicateHostedSequencePackage(sourcePath)
            : await withRendererWorkspaceMutation(workspaceRoot, async (mutationToken) => {
                const sourceName = basename(sourcePath);
                const parentPath = sourcePath.slice(0, -(sourceName.length + 1));
                const suffix = ['.primer.json', '.entity.json'].find((extension) =>
                  sourceName.toLowerCase().endsWith(extension)
                );
                const lastDot =
                  filesystemContextMenu.packageKind === 'sequence'
                    ? -1
                    : suffix
                      ? sourceName.length - suffix.length
                      : sourceName.lastIndexOf('.');
                const hasExtension = lastDot > 0;
                const stem = hasExtension ? sourceName.slice(0, lastDot) : sourceName;
                const extension = hasExtension ? sourceName.slice(lastDot) : '';

                for (let copyNumber = 1; copyNumber <= 10_000; copyNumber += 1) {
                  const suffix = copyNumber === 1 ? ' copy' : ` copy ${copyNumber}`;
                  const candidate = `${parentPath}/${stem}${suffix}${extension}`;
                  if (await platform().fs.exists(candidate)) continue;
                  try {
                    if (
                      await copyAcceptedScientificPath({
                        workspaceRoot,
                        sourcePath,
                        destinationPath: candidate,
                        mutationToken,
                      })
                    )
                      return candidate;
                    if (filesystemContextMenu.packageKind === 'sequence')
                      throw new Error(
                        'Enroll this sequence project in accepted storage before duplicating its package.'
                      );
                    const content = await platform().fs.readFile(sourcePath);
                    await platform().fs.writeWorkspaceBinaryFileAtomic({
                      workspaceRoot,
                      path: candidate,
                      content,
                      mutationToken,
                      artifactNoun: 'file',
                    });
                    return candidate;
                  } catch (error) {
                    if (error instanceof Error && /already exists/i.test(error.message)) continue;
                    throw error;
                  }
                }
                throw new Error('Could not find an available duplicate file name.');
              });

      try {
        await Promise.resolve(onWorkspaceChanged?.(workspaceRoot));
      } catch (error) {
        console.warn('[FileBrowser] Duplicate was saved but catalog refresh failed:', error);
      }
      notifyGitStatusChanged(workspaceRoot);
      revealPath(duplicatePath);
      setRefreshTrigger((prev) => prev + 1);
      telemetry.complete({ status: 'created', affectedCount: 1 });
    } catch (error) {
      telemetry.fail('duplicate_failed');
      useToastStore.getState().addToast(toUserMessage(error, 'failure.copy-accepted'), {
        definition: 'file-browser-couldn-t-duplicate-example-file',
      });
      console.error('[FileBrowser] Failed to duplicate:', error);
    }
  }, [filesystemContextMenu, folders, onWorkspaceChanged, projectAllowsWritesForPath, revealPath]);

  const moveItemIntoDir = useCallback(
    async (source: string, destDir: string) => {
      if (!projectAllowsWritesForPath(source) || !projectAllowsWritesForPath(destDir)) {
        useToastStore.getState().addToast(userMessage('notice.reference-projects-are-read-only'), {
          definition: 'file-browser-reference-projects-are-read-only',
        });
        return;
      }
      if (isBrowserOnly()) {
        console.log('[FileBrowser] Browser mode - move simulated:', source, '->', destDir);
        return;
      }
      const telemetry = beginWorkflowAction({
        workflow: 'file',
        action: 'move',
        fileTypeCategory: fileTypeCategory(source),
      });
      try {
        const sourceRoot = findWorkspaceRootForPath(folders, source);
        const base = source.replace(/\/+$/, '').split('/').pop() ?? source;
        const newPath = `${destDir.replace(/\/+$/, '')}/${base}`;
        const destPath = await withRendererWorkspaceMutation(sourceRoot, async (mutationToken) => {
          const relocated = await relocateRegistryFile({
            workspaceRoot: sourceRoot ?? null,
            oldPath: source,
            newPath,
            mutationToken,
          });
          await recordWorkspaceArtifactFileRenameInProjectMemory({
            oldPath: source,
            newPath: relocated.newPath,
            workspaceRoot: sourceRoot,
            mutationToken,
          });
          return relocated.newPath;
        });
        const destRoot = findWorkspaceRootForPath(folders, destPath);
        for (const root of new Set([sourceRoot, destRoot].filter(Boolean) as string[])) {
          notifyGitStatusChanged(root);
          void Promise.resolve(onWorkspaceChanged?.(root));
        }
        setRefreshTrigger((prev) => prev + 1);
        telemetry.complete({ status: 'updated' });
      } catch (err) {
        telemetry.fail('move_failed');
        const raw = err instanceof Error ? err.message : '';
        useToastStore.getState().addToast(
          raw.replace(/^MOVE_[A-Z_]+:\s*/, '')
            ? toUserMessage(raw.replace(/^MOVE_[A-Z_]+:\s*/, ''), 'operation.failed')
            : userMessageWithValues('notice.couldn-t-move-value', {
                value0: userMessageValue(source.split('/').pop() ?? source),
              }),
          {
            definition: 'file-browser-move-item-into-dir',
            variant: raw.startsWith('MOVE_NOOP') ? 'info' : 'error',
          }
        );
        console.error('[FileBrowser] Failed to move:', err);
      }
    },
    [folders, onWorkspaceChanged, projectAllowsWritesForPath]
  );

  const handleMoveTo = useCallback(async () => {
    if (!filesystemContextMenu) return;
    const source = filesystemContextMenu.path;
    const name = filesystemContextMenu.displayName;
    setContextMenu(null);

    if (isBrowserOnly()) {
      console.log('[FileBrowser] Browser mode - move simulated:', source);
      return;
    }

    let picked: string | string[] | null;
    try {
      picked = await platform().dialog.open({ directory: true, title: `Move "${name}" to…` });
    } catch (err) {
      console.error('[FileBrowser] Move folder picker failed:', err);
      return;
    }
    const destDir = Array.isArray(picked) ? picked[0] : picked;
    if (!destDir) return;

    await moveItemIntoDir(source, destDir);
  }, [filesystemContextMenu, moveItemIntoDir]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ sourcePath?: string; destDir?: string }>).detail;
      if (detail?.sourcePath && detail?.destDir) {
        void moveItemIntoDir(detail.sourcePath, detail.destDir);
      }
    };
    window.addEventListener('waypoint-file-move', handler);
    return () => window.removeEventListener('waypoint-file-move', handler);
  }, [moveItemIntoDir]);

  const handleFindInFolder = useCallback(() => {
    if (!filesystemContextMenu?.isDirectory) return;
    const result = dispatchCommand(COMMAND_IDS.workspaceFindInFolder, {
      source: 'ui',
      payload: { folderPath: filesystemContextMenu.path },
    });
    if (!result.handled) {
      onFindInFolder?.(filesystemContextMenu.path);
    }
  }, [filesystemContextMenu, dispatchCommand, onFindInFolder]);

  const createRootCreationContext = useCallback(async (): Promise<
    WorkspaceCreationContext | undefined
  > => {
    if (effectiveSelectedPath && selectedPathRoot) {
      const isExternalSelection = effectiveSelectedPath !== activeTreeFilesystemPath;
      let targetKind: 'file' | 'folder' | null =
        effectiveSelectedPath === selectedPathRoot
          ? 'folder'
          : isExternalSelection
            ? null
            : activeTreeTargetKind === 'catalog'
              ? null
              : activeTreeTargetKind;
      if (!targetKind) {
        try {
          const stat = await platform().fs.stat(effectiveSelectedPath);
          targetKind = stat.isDirectory ? 'folder' : 'file';
        } catch {
          targetKind = 'file';
        }
      }
      const parentPath = getCreationParentPath(effectiveSelectedPath, targetKind);
      return {
        targetPath: effectiveSelectedPath,
        targetKind,
        parentPath,
        workspaceRoot: selectedPathRoot,
      };
    }

    return undefined;
  }, [activeTreeFilesystemPath, activeTreeTargetKind, effectiveSelectedPath, selectedPathRoot]);

  const nextPendingArtifact = useCallback(
    async (
      kind: PendingArtifactKind,
      context: WorkspaceCreationContext
    ): Promise<PendingArtifactCreate> => {
      const parentPath = context.parentPath ?? context.workspaceRoot ?? context.targetPath ?? null;
      if (!parentPath) {
        throw new Error('Cannot create a project artifact without a parent folder');
      }

      if (kind === 'folder') {
        const chosen = await nextAvailableFolderName(
          parentPath,
          (path) => pendingArtifacts.some((p) => p.path === path) || platform().fs.exists(path)
        );
        if (!chosen) throw new Error('Could not choose a unique folder artifact name');
        return {
          id: crypto.randomUUID(),
          kind,
          parentPath,
          path: chosen.path,
          fileName: chosen.name,
          workspaceRoot: context.workspaceRoot ?? findWorkspaceRootForPath(folders, parentPath),
          context,
        };
      }

      const defaultName = defaultArtifactFileName(kind);
      for (let index = 1; index <= 100; index++) {
        const suffix = index === 1 ? '' : ` ${index}`;
        let fileName: string;
        if (isArtifactPendingKind(kind)) {
          const type = artifactTypeForPendingKind(kind);
          fileName = normalizeWorkspaceArtifactFileName({
            fileName:
              index === 1
                ? defaultName
                : `${defaultName.slice(0, defaultName.indexOf('.'))}${suffix}${defaultName.slice(
                    defaultName.indexOf('.')
                  )}`,
            type,
          }).fileName;
        } else if (kind === 'dna-sequence') {
          fileName = index === 1 ? defaultName : `Untitled DNA sequence ${index}`;
        } else if (kind === 'text-file') {
          fileName = index === 1 ? defaultName : `Untitled ${index}.txt`;
        } else if (kind === 'table') {
          fileName = index === 1 ? defaultName : `Untitled table ${index}`;
        } else {
          fileName = index === 1 ? defaultName : `New Folder ${index}`;
        }
        const path = `${parentPath}/${fileName}`;
        const collidesWithPending = pendingArtifacts.some((pending) => pending.path === path);
        if (!collidesWithPending && !(await platform().fs.exists(path))) {
          return {
            id: crypto.randomUUID(),
            kind,
            parentPath,
            path,
            fileName,
            workspaceRoot: context.workspaceRoot ?? findWorkspaceRootForPath(folders, parentPath),
            context,
          };
        }
      }
      throw new Error(`Could not choose a unique ${kind} artifact name`);
    },
    [folders, pendingArtifacts]
  );

  const beginPendingArtifact = useCallback(
    async (kind: PendingArtifactKind, context?: WorkspaceCreationContext) => {
      const creationContext = context ?? (await createRootCreationContext());
      setContextMenu(null);
      setAddPickerLaunch(null);
      if (!creationContext) {
        if (kind === 'notebook') {
          void Promise.resolve(onNewNotebook?.());
        } else if (kind === 'assembly') {
          void Promise.resolve(onNewAssembly?.());
        }
        return;
      }
      const destinationPath = creationContext.parentPath ?? creationContext.workspaceRoot;
      if (destinationPath && !projectAllowsWritesForPath(destinationPath)) {
        useToastStore.getState().addToast(userMessage('notice.reference-projects-are-read-only'), {
          definition: 'file-browser-reference-projects-are-read-only',
        });
        return;
      }

      try {
        const pending = await nextPendingArtifact(kind, creationContext);
        const rootPath = findWorkspaceRootForPath(folders, pending.parentPath);
        if (rootPath) expandPath(rootPath);
        setPendingArtifacts((prev) => [...prev, pending]);
        setRenamingPath(pending.path);
        revealPath(pending.path);
      } catch (err) {
        console.error('[FileBrowser] Failed to start pending artifact create:', err);
      }
    },
    [
      createRootCreationContext,
      expandPath,
      folders,
      nextPendingArtifact,
      onNewAssembly,
      onNewNotebook,
      projectAllowsWritesForPath,
      revealPath,
    ]
  );

  const handleNewFolderCommand = useCallback(() => {
    void beginPendingArtifact('folder');
    return true;
  }, [beginPendingArtifact]);
  const canCreateFolderFromCommand = useCallback(
    () => active && folders.length > 0,
    [active, folders.length]
  );
  useCommandHandler(COMMAND_IDS.fileNewFolder, handleNewFolderCommand, {
    scope: COMMAND_SCOPES.sidebarFileTree,
    active,
    enabled: canCreateFolderFromCommand,
    label: 'New Folder',
  });

  const commitPendingArtifact = useCallback(
    async (pending: PendingArtifactCreate, requestedFileName: string) => {
      if (!projectAllowsWritesForPath(pending.parentPath)) {
        setPendingArtifacts((prev) => prev.filter((item) => item.id !== pending.id));
        setRenamingPath(null);
        useToastStore.getState().addToast(userMessage('notice.reference-projects-are-read-only'), {
          definition: 'file-browser-reference-projects-are-read-only',
        });
        return;
      }
      const trimmedFileName = requestedFileName.trim();
      const normalizedDnaName =
        pending.kind === 'dna-sequence' ? normalizeEmptyDnaSequenceName(trimmedFileName) : null;
      const finalFileName = isArtifactPendingKind(pending.kind)
        ? normalizeWorkspaceArtifactFileName({
            fileName: trimmedFileName,
            type: artifactTypeForPendingKind(pending.kind),
          }).fileName
        : (normalizedDnaName ?? trimmedFileName);
      const finalPath = `${pending.parentPath}/${finalFileName}`;
      let createdPath: string | null = finalPath;
      let textFileRegistered = false;

      if (
        finalPath !== pending.path &&
        pendingArtifacts.some((item) => item.id !== pending.id && item.path === finalPath)
      ) {
        console.error('[FileBrowser] Pending name is already in use:', finalPath);
        return;
      }
      if (
        finalPath !== pending.path &&
        !pending.sequenceCreation &&
        (await platform().fs.exists(finalPath))
      ) {
        console.error('[FileBrowser] File already exists:', finalPath);
        return;
      }

      const telemetry = beginWorkflowAction({
        workflow: 'file',
        action: 'create',
        fileTypeCategory: fileTypeCategory(finalPath),
      });
      try {
        if (isArtifactPendingKind(pending.kind)) {
          const type = artifactTypeForPendingKind(pending.kind);
          const normalized = normalizeWorkspaceArtifactFileName({
            fileName: trimmedFileName,
            type,
          });
          const context: WorkspaceCreationContext = {
            ...pending.context,
            parentPath: pending.parentPath,
            workspaceRoot: pending.workspaceRoot,
            artifactFileName: normalized.fileName,
            artifactTitle: normalized.stem,
          };

          await Promise.resolve(
            pending.kind === 'notebook' ? onNewNotebook?.(context) : onNewAssembly?.(context)
          );
        } else if (pending.kind === 'dna-sequence') {
          const created = await Promise.resolve(
            onCreateEntity?.({
              entityType: 'dna-sequences',
              destinationPath: pending.parentPath,
              name: normalizedDnaName ?? trimmedFileName,
              creationId: pending.id,
              ...(pending.sequenceCreation ? { sequenceCreation: pending.sequenceCreation } : {}),
            })
          );
          createdPath = created?.filePath ?? null;
        } else if (pending.kind === 'table') {
          if (!pending.workspaceRoot)
            throw new Error('Choose a registered project for this table.');
          const created = await platform().fs.tableDocument({
            kind: 'create',
            requestId: pending.id,
            destination: { workspaceRoot: pending.workspaceRoot, packageRoot: finalPath },
            title: finalFileName,
            rows: 3,
            columns: 3,
          });
          if (created.kind !== 'created' || created.table.owner.kind !== 'file')
            throw new Error('The native table creation is still pending recovery.');
          createdPath = finalPath;
          onFileSelect(created.table.owner.path, 'table');
        } else if (pending.kind === 'text-file') {
          await platform().fs.writeTextFile(finalPath, '');
          await registerWorkspaceFile({
            path: finalPath,
            name: finalFileName,
            entityType: 'file',
            fileKind: 'text',
            workspaceRoot: pending.workspaceRoot,
            metadata: {
              createdBy: 'file-explorer-new-menu',
              parentPath: pending.parentPath,
            },
          })
            .then(() => {
              textFileRegistered = true;
            })
            .catch((err) => {
              console.warn('[FileBrowser] Failed to register text file in catalog:', err);
            });
        } else {
          await createFolderArtifact({
            path: finalPath,
            name: finalFileName,
            parentPath: pending.parentPath,
            workspaceRoot: pending.workspaceRoot,
            createdBy: 'file-explorer-new-menu',
          });
        }
      } catch (error) {
        if (error instanceof SequenceCreationPendingError)
          setPendingArtifacts((previous) =>
            previous.map((item) =>
              item.id === pending.id ? { ...item, sequenceCreation: error.creation } : item
            )
          );
        telemetry.fail('create_failed');
        throw error;
      }
      setPendingArtifacts((prev) => prev.filter((item) => item.id !== pending.id));
      setRenamingPath(null);
      if (createdPath) revealPath(createdPath);
      if (pending.workspaceRoot) {
        notifyGitStatusChanged(pending.workspaceRoot);
        if (
          pending.kind !== 'table' &&
          (pending.kind !== 'text-file' ||
            !textFileRegistered ||
            getTabTypeForFile(finalPath) !== 'text' ||
            isManagedCatalogHeadCandidate(finalPath))
        )
          void Promise.resolve(onWorkspaceChanged?.(pending.workspaceRoot));
      }
      setRefreshTrigger((prev) => prev + 1);
      telemetry.complete({ status: 'created' });
    },
    [
      onCreateEntity,
      onNewAssembly,
      onNewNotebook,
      onFileSelect,
      onWorkspaceChanged,
      pendingArtifacts,
      projectAllowsWritesForPath,
      revealPath,
    ]
  );

  const handleRenameComplete = useCallback(
    async (oldPath: string, newName: string) => {
      if (!projectAllowsWritesForPath(oldPath)) {
        setRenamingPath(null);
        useToastStore.getState().addToast(userMessage('notice.reference-projects-are-read-only'), {
          definition: 'file-browser-reference-projects-are-read-only',
        });
        return;
      }
      const pending = pendingArtifacts.find((item) => item.path === oldPath);
      if (pending) {
        try {
          await commitPendingArtifact(pending, newName);
        } catch (err) {
          console.error('[FileBrowser] Failed to create pending artifact:', err);
          throw err;
        }
        return;
      }

      setRenamingPath(null);

      if (isBrowserOnly()) {
        console.log('[FileBrowser] Browser mode - rename simulated:', oldPath, '->', newName);
        return;
      }

      const telemetry = beginWorkflowAction({
        workflow: 'file',
        action: 'rename',
        fileTypeCategory: fileTypeCategory(oldPath),
      });
      try {
        const parentDir = oldPath.substring(0, oldPath.lastIndexOf('/'));
        const newPath = `${parentDir}/${newName}`;
        const workspaceRoot = findWorkspaceRootForPath(folders, oldPath);
        const binding = await getCatalogFileForPath(oldPath);
        if (binding?.file_kind === 'waypoint-notebook') {
          const { usePageStore } = await import('../features/page/public/store');
          const page = await usePageStore.getState().fetchPage(binding.entity_id);
          if (!page) throw new UserMessageError('document.openFailed');
          const renamed = await usePageStore
            .getState()
            .renamePageArtifact(binding.entity_id, newName);
          if (!renamed) throw new UserMessageError('document.saveFailed');
        } else {
          await withRendererWorkspaceMutation(workspaceRoot, async (mutationToken) => {
            const relocated = await relocateRegistryFile({
              workspaceRoot: workspaceRoot ?? null,
              oldPath,
              newPath,
              mutationToken,
            });
            await recordWorkspaceArtifactFileRenameInProjectMemory({
              oldPath,
              newPath: relocated.newPath,
              workspaceRoot,
              mutationToken,
            });
          });
        }
        if (workspaceRoot) {
          notifyGitStatusChanged(workspaceRoot);
          void Promise.resolve(onWorkspaceChanged?.(workspaceRoot));
        }
        setRefreshTrigger((prev) => prev + 1);
        telemetry.complete({ status: 'updated' });
      } catch (err) {
        telemetry.fail('rename_failed');
        console.error('[FileBrowser] Failed to rename:', err);
      }
    },
    [
      commitPendingArtifact,
      folders,
      onWorkspaceChanged,
      pendingArtifacts,
      projectAllowsWritesForPath,
    ]
  );

  const handleRenameCancel = useCallback(() => {
    if (renamingPath) {
      const wasPendingArtifact = pendingArtifacts.some((pending) => pending.path === renamingPath);
      setPendingArtifacts((prev) => prev.filter((pending) => pending.path !== renamingPath));
      if (wasPendingArtifact) {
        setSelectedPath(null);
      }
    }
    setRenamingPath(null);
  }, [pendingArtifacts, renamingPath, setSelectedPath]);

  const handleNewNotebook = useCallback(() => {
    const creationContext = filesystemContextMenu
      ? getCreationContext(filesystemContextMenu, folders)
      : undefined;
    void beginPendingArtifact('notebook', creationContext);
  }, [beginPendingArtifact, filesystemContextMenu, folders]);

  const handleNewAssembly = useCallback(() => {
    const creationContext = filesystemContextMenu
      ? getCreationContext(filesystemContextMenu, folders)
      : undefined;
    void beginPendingArtifact('assembly', creationContext);
  }, [beginPendingArtifact, filesystemContextMenu, folders]);

  const handleNewTextFile = useCallback(() => {
    if (!filesystemContextMenu) return;
    void beginPendingArtifact('text-file', getCreationContext(filesystemContextMenu, folders));
  }, [beginPendingArtifact, filesystemContextMenu, folders]);

  const handleNewFolder = useCallback(() => {
    if (!filesystemContextMenu) return;
    void beginPendingArtifact('folder', getCreationContext(filesystemContextMenu, folders));
  }, [beginPendingArtifact, filesystemContextMenu, folders]);

  const handleCreateEntityFromPicker = useCallback(
    (request: ExplorerEntityCreateRequest) => {
      if (request.destinationPath && !projectAllowsWritesForPath(request.destinationPath)) {
        useToastStore
          .getState()
          .addToast(userMessage('notice.choose-a-writable-project-before-creating'), {
            definition: 'file-browser-choose-a-writable-project-before-creating',
          });
        return;
      }
      if (
        request.entityType === 'notebook' ||
        request.entityType === 'assembly' ||
        request.entityType === 'table'
      ) {
        const destinationPath = request.destinationPath;
        if (!destinationPath) {
          if (onCreateEntity && request.entityType !== 'table') {
            void onCreateEntity(request);
            return;
          }
          useToastStore
            .getState()
            .addToast(userMessage('notice.choose-a-writable-project-before-creating'), {
              definition: 'file-browser-choose-a-writable-project-before-creating',
            });
          return;
        }
        void beginPendingArtifact(request.entityType, {
          targetPath: destinationPath,
          targetKind: 'folder',
          parentPath: destinationPath,
          workspaceRoot: findWorkspaceRootForPath(folders, destinationPath),
        });
        return;
      }
      if (!onCreateEntity) return;
      if (request.entityType !== 'dna-sequences') {
        void onCreateEntity(request);
        return;
      }
      const destinationPath = request.destinationPath;
      if (!destinationPath) {
        void onCreateEntity(request);
        return;
      }
      void beginPendingArtifact('dna-sequence', {
        targetPath: destinationPath,
        targetKind: 'folder',
        parentPath: destinationPath,
        workspaceRoot: findWorkspaceRootForPath(folders, destinationPath),
      });
    },
    [beginPendingArtifact, folders, onCreateEntity, projectAllowsWritesForPath]
  );

  const effectiveTreeSelectedEntryIds = useMemo(() => {
    if (treeSelectedEntryIds.size > 0) return treeSelectedEntryIds;
    return effectiveSelectedPath
      ? new Set([filesystemEntryId(effectiveSelectedPath)])
      : new Set<string>();
  }, [effectiveSelectedPath, treeSelectedEntryIds]);

  const trashWorkspacePaths = useCallback(
    async (sourcePath: string) => {
      const sourceEntryId = filesystemEntryId(sourcePath);
      const selectedTargets =
        effectiveTreeSelectedEntryIds.has(sourceEntryId) && effectiveTreeSelectedEntryIds.size > 1
          ? Array.from(effectiveTreeSelectedEntryIds)
              .map(filesystemPathFromEntryId)
              .filter((path): path is string => path !== null)
          : [sourcePath];
      if (selectedTargets.some((path) => !projectAllowsWritesForPath(path))) {
        setContextMenu(null);
        useToastStore.getState().addToast(userMessage('notice.reference-projects-are-read-only'), {
          definition: 'file-browser-reference-projects-are-read-only',
        });
        return;
      }
      const rootPaths = new Set(folders.map((folder) => folder.path));
      const pathsToTrash = withoutNestedDeleteTargets(
        selectedTargets.filter((path) => !rootPaths.has(path))
      );
      if (pathsToTrash.length === 0) return;

      setContextMenu(null);
      const deletedCategories = new Set(pathsToTrash.map(fileTypeCategory));
      const telemetry = beginWorkflowAction({
        workflow: 'file',
        action: 'delete',
        fileTypeCategory: deletedCategories.size === 1 ? [...deletedCategories][0] : 'unknown',
      });

      const affectedRoots = new Set<string>();
      const trashedPaths: string[] = [];
      let uncertainTrash = false;
      try {
        for (const path of pathsToTrash) {
          const workspaceRoot = findWorkspaceRootForPath(folders, path);
          if (workspaceRoot) affectedRoots.add(workspaceRoot);

          if (!workspaceRoot) throw new Error('Choose a file in a mounted writable project.');
          let result: Awaited<ReturnType<typeof deleteWorkspaceFile>>;
          try {
            result = await deleteWorkspaceFile(workspaceRoot, path);
          } catch (error) {
            if (error instanceof FileLifecycleError) {
              if (error.receipt.stateChanged === true) trashedPaths.push(path);
              if (error.receipt.stateChanged === 'unknown') uncertainTrash = true;
            }
            throw error;
          }
          if (result === null) continue;
          trashedPaths.push(path);
          if (result && 'warnings' in result && result.warnings.length)
            useToastStore.getState().addToast(toUserMessage(result.warnings.join(' ')), {
              definition: 'file-operation-failed',
            });
        }
      } catch (err) {
        console.error('[FileBrowser] Failed to move item to trash:', err);
        const items = userMessageValue(
          pathsToTrash.length === 1 ? `"${basename(pathsToTrash[0])}"` : 'items'
        );
        const deliveryPending = err instanceof Error && err.message.startsWith('Delete accepted;');
        const message = deliveryPending
          ? userMessage('file.deleteDeliveryPending')
          : isHostedBrowserRuntime()
            ? userMessageWithValues('file.deleteUnconfirmed', { items })
            : uncertainTrash
              ? userMessage('file.trashUncertain')
              : trashedPaths.length === 0
                ? userMessageWithValues('file.trashFailed', { items })
                : userMessageWithValues('file.trashPartial', {
                    moved: userMessageValue(
                      `${trashedPaths.length} item${trashedPaths.length === 1 ? '' : 's'}`
                    ),
                  });
        useToastStore.getState().addToast(message, {
          definition: 'file-operation-failed',
        });
        if (deliveryPending) {
          for (const workspaceRoot of affectedRoots) {
            notifyGitStatusChanged(workspaceRoot);
            void Promise.resolve(onWorkspaceChanged?.(workspaceRoot));
          }
        }
        if (deliveryPending || uncertainTrash || isHostedBrowserRuntime())
          setRefreshTrigger((value) => value + 1);
      } finally {
        if (trashedPaths.length > 0) {
          setTreeSelectedEntryIds((prev) => {
            const next = new Set(
              Array.from(prev).filter((entryId) => {
                const path = filesystemPathFromEntryId(entryId);
                return (
                  path === null ||
                  !trashedPaths.some((trashedPath) => pathIsAtOrUnder(path, trashedPath))
                );
              })
            );
            return next;
          });

          if (
            activeTreeFilesystemPath &&
            trashedPaths.some((trashedPath) =>
              pathIsAtOrUnder(activeTreeFilesystemPath, trashedPath)
            )
          ) {
            setActiveTreeEntryId(null);
            setActiveTreeFilesystemPath(null);
            setSelectionAnchorEntryId(null);
          }

          if (
            effectiveSelectedPath &&
            trashedPaths.some((trashedPath) => pathIsAtOrUnder(effectiveSelectedPath, trashedPath))
          ) {
            setSelectedPath(null);
          }

          for (const workspaceRoot of affectedRoots) {
            notifyGitStatusChanged(workspaceRoot);
            void Promise.resolve(onWorkspaceChanged?.(workspaceRoot));
          }
          setRefreshTrigger((prev) => prev + 1);
          telemetry.complete({ status: 'deleted', affectedCount: trashedPaths.length });
        } else {
          telemetry.fail('delete_failed');
        }
      }
    },
    [
      activeTreeFilesystemPath,
      effectiveSelectedPath,
      effectiveTreeSelectedEntryIds,
      folders,
      onWorkspaceChanged,
      projectAllowsWritesForPath,
      setSelectedPath,
    ]
  );

  const handleDeleteFromWorkspace = useCallback(() => {
    if (!filesystemContextMenu || filesystemContextMenu.isRootFolder) return;
    void trashWorkspacePaths(filesystemContextMenu.path);
  }, [filesystemContextMenu, trashWorkspacePaths]);

  useEffect(() => {
    const pendingInternalSelection = pendingInternalSelectionRef.current;
    if (pendingInternalSelection) {
      if (externalSelectedPath === pendingInternalSelection.path) {
        pendingInternalSelectionRef.current = null;
        return;
      }
      if (externalSelectedPath === pendingInternalSelection.previousExternalPath) {
        return;
      }
      pendingInternalSelectionRef.current = null;
    }

    if (!externalSelectedPath) {
      setTreeSelectedEntryIds(new Set());
      setActiveTreeEntryId(null);
      setActiveTreeFilesystemPath(null);
      setActiveTreeTargetKind(null);
      setSelectionAnchorEntryId(null);
      return;
    }
    const entryId = filesystemEntryId(externalSelectedPath);
    setTreeSelectedEntryIds(new Set([entryId]));
    setActiveTreeEntryId(entryId);
    setActiveTreeFilesystemPath(externalSelectedPath);
    setActiveTreeTargetKind(null);
    setSelectionAnchorEntryId(entryId);
  }, [externalSelectedPath]);

  useEffect(() => {
    if (!revealRequestId || !revealTargetPaths?.length) return;
    const first = revealTargetPaths[0];
    const entryId = filesystemEntryId(first);
    pendingInternalSelectionRef.current = null;
    setTreeSelectedEntryIds(new Set(revealTargetPaths.map(filesystemEntryId)));
    setActiveTreeEntryId(entryId);
    setActiveTreeFilesystemPath(first);
    setActiveTreeTargetKind(null);
    setSelectionAnchorEntryId(entryId);
  }, [revealRequestId, revealTargetPaths]);

  const explorerActions: ExplorerAddEntriesOptions = {
    launchSource: 'context-menu',
    hasWorkspace: folders.some((folder) => !folder.pinned),
    onCreateEntity:
      onCreateEntity || onNewNotebook || onNewAssembly || !isBrowserOnly()
        ? handleCreateEntityFromPicker
        : undefined,
    canCreateEntity: (entityType) => {
      if (entityType === 'table') return !isBrowserOnly();
      if (entityType === 'notebook') return Boolean(onNewNotebook || onCreateEntity);
      if (entityType === 'assembly') return Boolean(onNewAssembly || onCreateEntity);
      return Boolean(onCreateEntity);
    },
    onCreateAssembly,
    onImportEntity,
    onImportProject: onImportProject ?? onAddFolder,
    onImportProjectWithAgent,
    onMigrateFromBenchling,
  };
  const contextMenuCreation = filesystemContextMenu
    ? getCreationContext(filesystemContextMenu, folders)
    : null;
  const contextMenuDestinationPath =
    contextMenuCreation?.parentPath ?? filesystemContextMenu?.path ?? null;
  const contextMenuDestinationLabel = filesystemContextMenu?.isDirectory
    ? filesystemContextMenu.displayName
    : contextMenuDestinationPath
      ? basename(contextMenuDestinationPath)
      : undefined;

  return (
    <div
      data-analytics-block
      className="ph-no-capture h-full flex flex-col"
      {...fileTreeScope.eventHandlers}
    >
      <div className="border-b border-border">
        <div className="flex items-center justify-between gap-2 px-3 py-2">
          <div className="flex min-w-0 items-center gap-2 overflow-hidden">
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold text-fg">Projects</span>
              <span className="block truncate text-[11px] text-fg-muted">
                {mountedProjects.length} open
              </span>
            </span>
          </div>
          <div className="flex flex-shrink-0 items-center gap-1.5">
            {!isHostedBrowserRuntime() && (
              <FileTrash
                folders={folders}
                onChanged={() => setRefreshTrigger((value) => value + 1)}
              />
            )}
            <button
              type="button"
              aria-label="Manage projects"
              aria-haspopup="dialog"
              aria-expanded={projectSwitcher !== null}
              onClick={handleProjectSwitcherClick}
              className={`${INTERACTION_CLASS} ${projectSwitcher ? 'invisible ' : ''}inline-flex h-7 items-center rounded px-2 text-xs font-medium text-fg-muted`}
            >
              Manage projects
            </button>
            <ExplorerAddPicker
              {...explorerActions}
              open={addPickerLaunch !== null}
              anchorPoint={addPickerLaunch?.anchorPoint}
              destinationLabel={addPickerLaunch?.destinationLabel}
              destinationPath={addPickerLaunch?.destinationPath}
              onRequestClose={() => setAddPickerLaunch(null)}
              onCommitAction={() => setContextMenu(null)}
            />
          </div>
        </div>
      </div>

      <div
        className="flex-1 overflow-y-auto"
        data-testid="file-browser-scroll-container"
        role="tree"
        aria-label="Project files"
        aria-multiselectable="true"
      >
        {pendingImports.map((pending) => (
          <div
            key={pending.id}
            data-testid="pending-import-row"
            data-import-id={pending.id}
            data-import-status={pending.status}
            className="flex items-center gap-2 border-b border-border bg-bg-subtle/40 px-2 py-1.5"
            title={`Importing ${pending.displayName}`}
          >
            <SpinnerIcon className="h-3 w-3 flex-shrink-0" />
            <span className="truncate text-sm font-semibold text-fg">{pending.displayName}</span>
            <span className="ml-auto flex-shrink-0 text-[11px] text-fg-muted">
              {formatImportProgress(pending)}
            </span>
          </div>
        ))}
        {folders.length === 0 && pendingImports.length > 0 ? null : folders.length === 0 ? (
          <div className="p-4 text-center">
            <p className="text-sm text-fg-subtle mb-3">No projects</p>
            <button
              onClick={onAddFolder}
              className={`${INTERACTION_CLASS} inline-flex items-center gap-2 px-4 py-2 border border-border text-sm text-fg rounded-lg transition-colors`}
              data-testid={
                isHostedBrowserRuntime() ? 'hosted-new-project' : 'file-browser-open-folder'
              }
            >
              <svg
                className="w-4 h-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
              Import project
            </button>
          </div>
        ) : (
          <>
            {unpinnedFolders.map((folder, i) => (
              <RootFolder
                active={active}
                key={folder.path}
                folder={folder}
                indexFailed={failedProjectIndexRoots?.has(folder.path) ?? false}
                onRetryIndex={
                  onRetryProjectIndex ? () => onRetryProjectIndex(folder.path) : undefined
                }
                selectedEntryId={effectiveSelectedEntryId}
                activeEntryId={activeTreeEntryId}
                selectedEntryIds={effectiveTreeSelectedEntryIds}
                selectionAnchorEntryId={selectionAnchorEntryId}
                revealRequestId={revealRequestId}
                revealTargetPath={revealTargetPath}
                revealTargetPaths={revealTargetPaths}
                renamingPath={renamingPath}
                onFileSelect={handleFileOpen}
                onSelectionChange={handleTreeSelectionChange}
                onRootContextMenu={handleRootContextMenu}
                onEntryContextMenu={handleEntryContextMenu}
                onRenameComplete={handleRenameComplete}
                onRenameCancel={handleRenameCancel}
                onStartRename={handleRenameFilesystemEntry}
                onOpenInNewPanel={onOpenInNewPanel}
                onFindInFolder={(folderPath) => {
                  dispatchCommand(COMMAND_IDS.workspaceFindInFolder, {
                    source: 'keyboard',
                    payload: { folderPath },
                  });
                  onFindInFolder?.(folderPath);
                }}
                onDelete={trashWorkspacePaths}
                pendingArtifacts={pendingArtifacts}
                refreshToken={refreshKey}
                index={i}
                draggable={unpinnedFolders.length > 1}
                onDragStart={handleFolderDragStart}
                onDragOver={handleFolderDragOver}
                onDrop={handleFolderDrop}
                onDragEnd={handleFolderDragEnd}
                isDragOver={isDragging && dragOverIndex === i}
                project={mountedProjectByPath.get(folder.path) ?? null}
                onProjectMenu={handleProjectMenuClick}
                onProjectCreateMenu={handleProjectCreateMenuClick}
                readOnly={!projectAllowsWritesForPath(folder.path)}
              />
            ))}
            {pinnedFolders.map((folder) => (
              <RootFolder
                active={active}
                key={folder.path}
                folder={folder}
                indexFailed={failedProjectIndexRoots?.has(folder.path) ?? false}
                onRetryIndex={
                  onRetryProjectIndex ? () => onRetryProjectIndex(folder.path) : undefined
                }
                selectedEntryId={effectiveSelectedEntryId}
                activeEntryId={activeTreeEntryId}
                selectedEntryIds={effectiveTreeSelectedEntryIds}
                selectionAnchorEntryId={selectionAnchorEntryId}
                revealRequestId={revealRequestId}
                revealTargetPath={revealTargetPath}
                revealTargetPaths={revealTargetPaths}
                renamingPath={renamingPath}
                onFileSelect={handleFileOpen}
                onSelectionChange={handleTreeSelectionChange}
                onRootContextMenu={handleRootContextMenu}
                onEntryContextMenu={handleEntryContextMenu}
                onRenameComplete={handleRenameComplete}
                onRenameCancel={handleRenameCancel}
                onStartRename={handleRenameFilesystemEntry}
                onOpenInNewPanel={onOpenInNewPanel}
                onFindInFolder={(folderPath) => {
                  dispatchCommand(COMMAND_IDS.workspaceFindInFolder, {
                    source: 'keyboard',
                    payload: { folderPath },
                  });
                  onFindInFolder?.(folderPath);
                }}
                onDelete={trashWorkspacePaths}
                pendingArtifacts={pendingArtifacts}
                refreshToken={refreshKey}
                project={mountedProjectByPath.get(folder.path) ?? null}
                onProjectMenu={handleProjectMenuClick}
                onProjectCreateMenu={handleProjectCreateMenuClick}
                readOnly
              />
            ))}
          </>
        )}
      </div>

      {filesystemContextMenu && (
        <ContextMenuWithGit
          contextMenu={filesystemContextMenu}
          onClose={() => {
            setContextMenu(null);
            setAddPickerLaunch(null);
          }}
          onOpen={
            filesystemContextMenu.isDirectory ||
            filesystemContextMenu.documentAvailability?.state === 'blocked'
              ? undefined
              : handleContextMenuOpen
          }
          onOpenInNewPanel={
            onOpenInNewPanel && filesystemContextMenu.documentAvailability?.state !== 'blocked'
              ? handleContextMenuOpenInNewPanel
              : undefined
          }
          onRename={
            contextAllowsWrites && !filesystemContextMenu.isRootFolder
              ? handleStartRename
              : undefined
          }
          onDuplicate={
            contextAllowsWrites &&
            (!filesystemContextMenu.isDirectory ||
              filesystemContextMenu.packageKind === 'sequence') &&
            !filesystemContextMenu.isNotebookPackage
              ? handleDuplicate
              : undefined
          }
          onMoveTo={
            contextAllowsWrites && !filesystemContextMenu.isRootFolder ? handleMoveTo : undefined
          }
          onDelete={
            contextAllowsWrites && !filesystemContextMenu.isRootFolder
              ? handleDeleteFromWorkspace
              : undefined
          }
          onNewNotebook={contextAllowsWrites && onNewNotebook ? handleNewNotebook : undefined}
          onNewAssembly={contextAllowsWrites && onNewAssembly ? handleNewAssembly : undefined}
          onNewTextFile={contextAllowsWrites ? handleNewTextFile : undefined}
          onNewFolder={contextAllowsWrites ? handleNewFolder : undefined}
          newMenuEntries={
            contextAllowsWrites
              ? buildExplorerAddEntries({
                  ...explorerActions,
                  destinationPath: contextMenuDestinationPath,
                })
              : undefined
          }
          newMenuHeader={
            <ExplorerAddHeader
              launchSource="context-menu"
              destinationLabel={contextMenuDestinationLabel}
            />
          }
          newMenuLabel={`Add to folder ${contextMenuDestinationLabel ?? 'project'}/`}
          newMenuDataAttributes={{
            'data-launch-source': 'context-menu',
            'data-destination-path': contextMenuDestinationPath ?? '',
          }}
          onFindInFolder={
            onFindInFolder && filesystemContextMenu.isDirectory ? handleFindInFolder : undefined
          }
          onRemoveFromWorkspace={handleRemoveFromWorkspace}
          onCollapseOthers={
            filesystemContextMenu.isDirectory
              ? () => useWorkspaceStore.getState().collapseOtherBranches(filesystemContextMenu.path)
              : undefined
          }
          onRenameProject={
            contextAllowsWrites && isManagedContextRoot && onRenameProject
              ? handleRenameContextProject
              : undefined
          }
          onArchiveProject={handleArchiveContextProject}
          onTrashProject={
            isManagedContextRoot && onTrashProject ? handleTrashContextProject : undefined
          }
          onProjectHistory={
            isManagedContextRoot && onOpenProjectHome ? handleProjectHistoryContext : undefined
          }
          onWorkspaceChanged={onWorkspaceChanged}
        />
      )}

      {catalogContextMenu && (
        <CatalogContextMenu
          contextMenu={catalogContextMenu}
          onClose={() => setContextMenu(null)}
          onOpen={handleCatalogContextOpen}
          onViewOriginalSource={handleCatalogContextViewOriginalSource}
        />
      )}

      {originalSourceDialog && (
        <OriginalProviderSourceDialog
          request={originalSourceDialog.request}
          label={originalSourceDialog.label}
          onClose={() => setOriginalSourceDialog(null)}
        />
      )}

      {projectSwitcher && (
        <ProjectSwitcherPopover
          x={projectSwitcher.x}
          y={projectSwitcher.y}
          openRepoPaths={openRepoPaths}
          onClose={() => setProjectSwitcher(null)}
          onOpenProject={(workspace) => onOpenProject?.(workspace)}
          onCreateProject={onCreateProject}
          onImportProject={onImportProject ?? onAddFolder}
        />
      )}
    </div>
  );
}
