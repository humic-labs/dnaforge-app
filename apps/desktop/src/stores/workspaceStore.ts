import {
  DesktopWorkspaceSelection,
  type WorkspaceSelectionState,
  type WorkspaceActivationOptions,
} from '../features/workspace-session/desktop-selection';
import { create } from 'zustand';
import { platform } from '../platform';
import { findContainingPathBoundary, normalizePathForBoundary } from '../shared/path-boundary';
import { uniquelyNamedProjectRoot } from '../shared/project-root-selection';
import { isBrowserOnly } from '../utils/environment';
import { retainExpandedBranch } from '../shared/tree-expansion';

export interface WorkspaceFolder {
  path: string;
  name: string;
  addedAt: number;
  mountRequest?: number;
  pinned?: boolean;
}

export interface WorkspaceFile {
  folders: Array<{
    path: string;
    name: string;
    pinned?: boolean;
  }>;
  settings?: Record<string, unknown>;
}

export function workspaceScopeFromState(state: {
  activeWorkspaceFile: string | null;
  folders: readonly Pick<WorkspaceFolder, 'name' | 'path'>[];
}): string | null {
  if (state.activeWorkspaceFile) return `file:${state.activeWorkspaceFile}`;
  if (state.folders.length === 0) return null;
  return `folders:${JSON.stringify(state.folders.map((folder) => folder.path).sort())}`;
}

export interface PendingImport {
  id: string;
  originPath: string;
  displayName: string;
  kind: 'folder' | 'file';
  status: 'scanning' | 'copying' | 'finalizing';
  filesCopied?: number;
  totalFiles?: number;
  bytesCopied?: number;
  totalBytes?: number;
}

interface WorkspaceState {
  workspaceSelection: WorkspaceSelectionState;
  initializeWorkspaceSelection(): Promise<void>;
  refreshWorkspaceSelection(): Promise<void>;
  activateWorkspace(path: string, options?: WorkspaceActivationOptions): Promise<void>;
  clearWorkspaceSelection(): Promise<void>;
  selectWorkspaceDirectory(): Promise<string | null>;
  acceptMountedWorkspaceSelection(preferredPath?: string): Promise<void>;
  commitMountedFolders(
    patch: Pick<WorkspaceState, 'folders' | 'expandedPaths' | 'activeWorkspaceFile'>
  ): void;
  folders: WorkspaceFolder[];
  lastRemovedFolderPath: string | null;
  activeWorkspaceFile: string | null;
  expandedPaths: Set<string>;
  collapseOthersRequest: { path: string } | null;
  selectedPath: string | null;
  revealRequestId: number;
  revealTargetPath: string | null;
  revealTargetPaths: string[];
  isLoading: boolean;
  error: string | null;
  pendingImports: PendingImport[];

  startPendingImport: (pending: PendingImport) => void;
  updatePendingImport: (id: string, patch: Partial<Omit<PendingImport, 'id'>>) => void;
  finishPendingImport: (id: string) => void;

  addFolder: (path: string, name?: string, options?: { pinned?: boolean }) => void;
  removeFolder: (path: string) => void;
  renameFolder: (path: string, newName: string) => void;
  reorderFolders: (fromIndex: number, toIndex: number) => void;
  clearWorkspace: () => void;

  expandPath: (path: string) => void;
  collapsePath: (path: string) => void;
  collapseOtherBranches: (path: string) => void;
  togglePath: (path: string) => void;

  revealPath: (filePath: string) => void;
  revealPaths: (filePaths: readonly string[]) => void;
  fileTreeRefreshToken: number;
  bumpFileTreeRefresh: () => void;
  setSelectedPath: (path: string | null) => void;

  saveWorkspace: (filePath: string) => Promise<void>;
  loadWorkspace: (filePath: string) => Promise<void>;
  setActiveWorkspaceFile: (filePath: string | null) => void;
}

function getFolderName(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] || path;
}

function trimTrailingSlash(path: string): string {
  if (path.length <= 1) return path;
  return path.replace(/\/+$/, '');
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);
}

function normalizePath(path: string): string {
  const startsWithSlash = path.startsWith('/');
  const parts = path.split('/').filter(Boolean);
  const resolved: string[] = [];

  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') {
      resolved.pop();
      continue;
    }
    resolved.push(part);
  }

  const normalized = `${startsWithSlash ? '/' : ''}${resolved.join('/')}`;
  return trimTrailingSlash(normalized || (startsWithSlash ? '/' : '.'));
}

function isPathInFolder(path: string, folderPath: string): boolean {
  return path === folderPath || path.startsWith(folderPath + '/');
}

function joinInsideFolder(folderPath: string, relativePath: string): string | null {
  const normalizedFolder = trimTrailingSlash(folderPath);
  if (!relativePath || relativePath === '.') return normalizedFolder;

  const absolutePath = normalizePath(`${normalizedFolder}/${relativePath}`);
  return isPathInFolder(absolutePath, normalizedFolder) ? absolutePath : null;
}

export function resolveWorkspaceRevealPath(
  folders: WorkspaceFolder[],
  inputPath: string
): string | null {
  const filePath = trimTrailingSlash(inputPath.trim());
  if (!filePath) return null;

  if (isAbsolutePath(filePath)) {
    return normalizePath(filePath);
  }

  const segments = filePath.split('/').filter(Boolean);
  const firstSegment = segments[0] ?? '';
  const matchedFolder = uniquelyNamedProjectRoot(folders, firstSegment);

  if (matchedFolder) {
    return joinInsideFolder(matchedFolder.path, segments.slice(1).join('/'));
  }

  if (folders.length === 1) {
    return joinInsideFolder(folders[0].path, filePath);
  }

  return null;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaceSelection: { phase: 'uninitialized', path: null, error: null },
  initializeWorkspaceSelection: () => desktopWorkspaceSelection.restore(),
  refreshWorkspaceSelection: () => desktopWorkspaceSelection.restore(true),
  activateWorkspace: (path, options) => desktopWorkspaceSelection.activate(path, options),
  clearWorkspaceSelection: () => desktopWorkspaceSelection.clear(),
  selectWorkspaceDirectory: () => desktopWorkspaceSelection.selectDirectory(),
  acceptMountedWorkspaceSelection: (path) => desktopWorkspaceSelection.acceptMounts(path),
  commitMountedFolders: (patch) => {
    desktopWorkspaceSelection.invalidateMountRestore();
    set({
      ...patch,
      isLoading: false,
      error: null,
      lastRemovedFolderPath: patch.folders.some((root) => root.path === get().lastRemovedFolderPath)
        ? null
        : get().lastRemovedFolderPath,
    });
  },
  folders: [],
  fileTreeRefreshToken: 0,
  bumpFileTreeRefresh: () =>
    set((state) => ({ fileTreeRefreshToken: state.fileTreeRefreshToken + 1 })),
  lastRemovedFolderPath: null,
  activeWorkspaceFile: null,
  expandedPaths: new Set(),
  collapseOthersRequest: null,
  selectedPath: null,
  revealRequestId: 0,
  revealTargetPath: null,
  revealTargetPaths: [],
  isLoading: false,
  error: null,
  pendingImports: [],

  startPendingImport: (pending: PendingImport) => {
    const { pendingImports } = get();
    if (pendingImports.some((p) => p.id === pending.id)) return;
    set({ pendingImports: [...pendingImports, pending] });
  },

  updatePendingImport: (id: string, patch: Partial<Omit<PendingImport, 'id'>>) => {
    const { pendingImports } = get();
    const index = pendingImports.findIndex((p) => p.id === id);
    if (index === -1) return;
    const current = pendingImports[index];
    const changed = (Object.keys(patch) as Array<keyof typeof patch>).some(
      (key) => current[key] !== patch[key]
    );
    if (!changed) return;
    const next = pendingImports.slice();
    next[index] = { ...current, ...patch };
    set({ pendingImports: next });
  },

  finishPendingImport: (id: string) => {
    const { pendingImports } = get();
    if (!pendingImports.some((p) => p.id === id)) return;
    set({ pendingImports: pendingImports.filter((p) => p.id !== id) });
  },

  addFolder: (path: string, name?: string, options?: { pinned?: boolean }) => {
    const { folders, expandedPaths, lastRemovedFolderPath } = get();

    const normalizedPath = normalizePathForBoundary(path);
    if (folders.some((folder) => normalizePathForBoundary(folder.path) === normalizedPath)) {
      return;
    }

    desktopWorkspaceSelection.invalidateMountRestore();
    const newFolder: WorkspaceFolder = {
      path,
      name: name || getFolderName(path),
      addedAt: Date.now(),
      ...(options?.pinned ? { pinned: true } : {}),
    };

    const newExpanded = new Set(expandedPaths);
    newExpanded.add(path);

    set({
      isLoading: false,
      folders: [...folders, newFolder],
      lastRemovedFolderPath: lastRemovedFolderPath === path ? null : lastRemovedFolderPath,
      expandedPaths: newExpanded,
      error: null,
    });
  },

  removeFolder: (path: string) => {
    desktopWorkspaceSelection.invalidateMountRestore();
    const { folders, expandedPaths } = get();

    const newExpanded = new Set(expandedPaths);
    for (const expandedPath of expandedPaths) {
      if (expandedPath === path || expandedPath.startsWith(path + '/')) {
        newExpanded.delete(expandedPath);
      }
    }

    set({
      isLoading: false,
      folders: folders.filter((f) => f.path !== path),
      lastRemovedFolderPath: path,
      expandedPaths: newExpanded,
    });
    desktopWorkspaceSelection.removed(path);
  },

  renameFolder: (path: string, newName: string) => {
    const { folders } = get();
    const folder = folders.find((candidate) => candidate.path === path);
    if (!folder || folder.name === newName) return;
    set({
      folders: folders.map((f) => (f.path === path ? { ...f, name: newName } : f)),
    });
  },

  reorderFolders: (fromIndex: number, toIndex: number) => {
    const { folders } = get();
    if (fromIndex === toIndex) return;
    if (fromIndex < 0 || fromIndex >= folders.length) return;
    if (toIndex < 0 || toIndex >= folders.length) return;
    if (folders[fromIndex].pinned || folders[toIndex].pinned) return;

    const newFolders = [...folders];
    const [moved] = newFolders.splice(fromIndex, 1);
    newFolders.splice(toIndex, 0, moved);
    set({ folders: newFolders });
  },

  clearWorkspace: () => {
    desktopWorkspaceSelection.invalidateMountRestore();
    void desktopWorkspaceSelection.clear();
    set({
      folders: [],
      isLoading: false,
      activeWorkspaceFile: null,
      expandedPaths: new Set(),
      collapseOthersRequest: null,
      selectedPath: null,
      revealRequestId: 0,
      revealTargetPath: null,
      revealTargetPaths: [],
      error: null,
    });
  },

  expandPath: (path: string) => {
    const { expandedPaths } = get();
    const newExpanded = new Set(expandedPaths);
    newExpanded.add(path);
    set({ expandedPaths: newExpanded });
  },

  collapsePath: (path: string) => {
    const { expandedPaths } = get();
    const newExpanded = new Set(expandedPaths);
    newExpanded.delete(path);
    set({ expandedPaths: newExpanded });
  },

  collapseOtherBranches: (path: string) => {
    const { folders, expandedPaths } = get();
    if (!findContainingPathBoundary(folders, path)) return;
    set({
      expandedPaths: retainExpandedBranch(expandedPaths, path),
      collapseOthersRequest: { path },
    });
  },

  togglePath: (path: string) => {
    const { expandedPaths } = get();
    if (expandedPaths.has(path)) {
      get().collapsePath(path);
    } else {
      get().expandPath(path);
    }
  },

  revealPath: (filePath: string) => get().revealPaths([filePath]),

  revealPaths: (filePaths: readonly string[]) => {
    const { folders, expandedPaths } = get();
    const resolvedPaths = new Set<string>();
    const newExpanded = new Set(expandedPaths);
    for (const filePath of filePaths) {
      const resolvedPath = resolveWorkspaceRevealPath(folders, filePath);

      if (!resolvedPath) {
        console.warn(
          '[WorkspaceStore] Could not resolve file path for workspace reveal:',
          filePath
        );
        continue;
      }

      const containingFolder = findContainingPathBoundary(folders, resolvedPath);

      if (!containingFolder) {
        console.warn('[WorkspaceStore] File path not in any workspace folder:', resolvedPath);
        continue;
      }

      const relativePath = resolvedPath.slice(containingFolder.path.length);
      const pathParts = relativePath.split('/').filter(Boolean);

      let currentPath = containingFolder.path;

      newExpanded.add(currentPath);

      for (let i = 0; i < pathParts.length - 1; i++) {
        currentPath = `${currentPath}/${pathParts[i]}`;
        newExpanded.add(currentPath);
      }
      resolvedPaths.add(resolvedPath);
    }
    const paths = [...resolvedPaths];
    if (paths.length === 0) return;

    set({
      expandedPaths: newExpanded,
      selectedPath: paths[0],
      revealRequestId: get().revealRequestId + 1,
      revealTargetPath: paths[0],
      revealTargetPaths: paths,
    });
  },

  setSelectedPath: (path: string | null) => {
    set({ selectedPath: path });
  },

  saveWorkspace: async (filePath: string) => {
    const { folders } = get();

    if (isBrowserOnly()) {
      console.log('[WorkspaceStore] Browser mode - workspace save simulated');
      set({ activeWorkspaceFile: filePath });
      return;
    }

    set({ isLoading: true, error: null });

    try {
      const workspaceData: WorkspaceFile = {
        folders: folders.map((f) => ({
          path: f.path,
          name: f.name,
          ...(f.pinned ? { pinned: true } : {}),
        })),
        settings: {},
      };

      const finalPath = filePath.endsWith('.waypoint-workspace')
        ? filePath
        : `${filePath}.waypoint-workspace`;

      await platform().fs.writeTextFile(finalPath, JSON.stringify(workspaceData, null, 2));

      set({
        activeWorkspaceFile: finalPath,
        isLoading: false,
      });
    } catch (err) {
      console.error('[WorkspaceStore] Failed to save workspace:', err);
      set({
        error: err instanceof Error ? err.message : 'Failed to save project',
        isLoading: false,
      });
      throw err;
    }
  },

  loadWorkspace: async (filePath: string) => {
    const ownsRequest = desktopWorkspaceSelection.beginMountRestore();
    if (isBrowserOnly()) {
      console.log('[WorkspaceStore] Browser mode - workspace load simulated');
      set({
        folders: [
          { path: '/mock/project1', name: 'Project 1', addedAt: Date.now() },
          { path: '/mock/project2', name: 'Project 2', addedAt: Date.now() },
        ],
        activeWorkspaceFile: filePath,
      });
      await desktopWorkspaceSelection.acceptMounts();
      return;
    }

    set({ isLoading: true, error: null });

    try {
      const content = await platform().fs.readTextFile(filePath);
      if (!ownsRequest()) return;
      const workspaceData: WorkspaceFile = JSON.parse(content);

      const folders: WorkspaceFolder[] = workspaceData.folders.map((f) => ({
        path: f.path,
        name: f.name || getFolderName(f.path),
        addedAt: Date.now(),
        ...(f.pinned ? { pinned: true } : {}),
      }));

      set({
        folders,
        activeWorkspaceFile: filePath,
        expandedPaths: new Set(),
        isLoading: false,
      });
      await desktopWorkspaceSelection.acceptMounts();
    } catch (err) {
      if (!ownsRequest()) return;
      console.error('[WorkspaceStore] Failed to load workspace:', err);
      set({
        error: err instanceof Error ? err.message : 'Failed to load project',
        isLoading: false,
      });
      throw err;
    }
  },

  setActiveWorkspaceFile: (filePath: string | null) => {
    set({ activeWorkspaceFile: filePath });
  },
}));

const desktopWorkspaceSelection: DesktopWorkspaceSelection = new DesktopWorkspaceSelection({
  readState: () => useWorkspaceStore.getState().workspaceSelection,
  publish: (workspaceSelection) => useWorkspaceStore.setState({ workspaceSelection }),
  roots: () => useWorkspaceStore.getState().folders,
  mount: (path) => useWorkspaceStore.getState().addFolder(path),
});

export function getCurrentWorkspaceScope(): string | null {
  return workspaceScopeFromState(useWorkspaceStore.getState());
}
