import { findContainingPathBoundary } from '../../shared/path-boundary';
import { resolveWorkspaceRevealPath, type WorkspaceFolder } from '../../stores/workspaceStore';
import type { WorkspaceLibraryEntry } from './workspace-library';
import type { OpenWorkspaceOptions, WorkspaceSource } from './types';

type WorkspaceLibrary = {
  active: WorkspaceLibraryEntry[];
  archived: WorkspaceLibraryEntry[];
  trashed: WorkspaceLibraryEntry[];
};

export interface RevealWorkspacePathDependencies {
  getMountedFolders: () => readonly WorkspaceFolder[];
  listWorkspaceLibrary: () => Promise<WorkspaceLibrary>;
  openWorkspaceSource: (
    source: WorkspaceSource,
    options?: OpenWorkspaceOptions
  ) => Promise<boolean>;
  resolveOutsideFolder?: (targetPath: string) => Promise<string | null>;
  resolveVisibleTreePath: (targetPath: string) => string | Promise<string>;
  revealPath: (targetPath: string) => void;
  showExplorer: () => void;
  reportUnavailable: (targetPath: string) => void;
}

export type RevealWorkspacePathResult = 'revealed' | 'mounted-and-revealed' | 'unavailable';

function isMounted(targetPath: string, folders: readonly WorkspaceFolder[]): boolean {
  return findContainingPathBoundary(folders, targetPath) != null;
}

export async function revealWorkspacePath(
  targetPath: string,
  dependencies: RevealWorkspacePathDependencies,
  options: { openOutsideFolder?: boolean } = {}
): Promise<RevealWorkspacePathResult> {
  dependencies.showExplorer();
  const initiallyMountedFolders = dependencies.getMountedFolders();
  const resolvedTargetPath =
    resolveWorkspaceRevealPath([...initiallyMountedFolders], targetPath) ?? targetPath;
  const unresolvedVisibleTreePath = dependencies.resolveVisibleTreePath(resolvedTargetPath);
  const visibleTreePath =
    typeof unresolvedVisibleTreePath === 'string'
      ? unresolvedVisibleTreePath
      : await unresolvedVisibleTreePath;

  if (isMounted(visibleTreePath, initiallyMountedFolders)) {
    dependencies.revealPath(visibleTreePath);
    return 'revealed';
  }

  const library = await dependencies.listWorkspaceLibrary();
  const activeRoots = library.active.map((entry) => ({ ...entry, path: entry.repoPath }));
  const inactiveRoots = [...library.archived, ...library.trashed].map((entry) => ({
    ...entry,
    path: entry.repoPath,
  }));
  let owningWorkspace = findContainingPathBoundary(activeRoots, resolvedTargetPath);
  let revealTargetPath = visibleTreePath;
  if (!owningWorkspace) {
    if (
      !options.openOutsideFolder ||
      !dependencies.resolveOutsideFolder ||
      findContainingPathBoundary(inactiveRoots, resolvedTargetPath)
    ) {
      dependencies.reportUnavailable(targetPath);
      return 'unavailable';
    }
    const canonicalFolder = await dependencies.resolveOutsideFolder(resolvedTargetPath);
    if (!canonicalFolder || findContainingPathBoundary(inactiveRoots, canonicalFolder)) {
      dependencies.reportUnavailable(targetPath);
      return 'unavailable';
    }
    revealTargetPath = canonicalFolder;
    if (isMounted(canonicalFolder, dependencies.getMountedFolders())) {
      dependencies.revealPath(canonicalFolder);
      return 'revealed';
    }
    owningWorkspace = findContainingPathBoundary(activeRoots, canonicalFolder);
  }

  const opened = await dependencies.openWorkspaceSource(
    owningWorkspace
      ? { kind: 'local-folder', path: owningWorkspace.repoPath, name: owningWorkspace.name }
      : { kind: 'local-folder', path: revealTargetPath },
    {
      inPlace: true,
      replaceCurrent: false,
      telemetrySource: 'unknown',
    }
  );
  if (!opened || !isMounted(revealTargetPath, dependencies.getMountedFolders())) {
    if (opened) dependencies.reportUnavailable(targetPath);
    return 'unavailable';
  }

  dependencies.revealPath(revealTargetPath);
  return 'mounted-and-revealed';
}
