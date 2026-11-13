import { toUserMessage } from '@waypoint/user-messages';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type { WorkspaceFolder } from '../stores/workspaceStore';
import { isDesktopRuntime } from '../utils/environment';
import { useSheetSyncProjects } from '../features/lims/public/sheet-sync-projects';
import {
  listWorkspaceLibrary,
  type WorkspaceLibraryEntry,
} from '../features/workspace-loader/workspace-library';
import {
  deriveMountedWorkspaceProjects,
  deriveWorkspaceProjectForPath,
  reconcileManagedWorkspaceFolderNames,
  type WorkspaceProject,
} from '../features/workspace-loader/workspace-projects';

import {
  listProjectEditFolders,
  type ProjectEditFolder,
} from '../features/workspace-loader/project-edit-folders';

export type WorkspaceLibrary = Awaited<ReturnType<typeof listWorkspaceLibrary>>;

export type UseWorkspaceLibraryOptions = {
  readonly shellPrepared: boolean;
  readonly workspacePath: string | null;
  readonly folders: WorkspaceFolder[];
  readonly fileTreeRefreshToken: number;
  readonly projectHomePath: string | null;
  readonly renameFolder: (path: string, newName: string) => void;
};

export type WorkspaceLibraryState = {
  readonly workspaceLibrary: WorkspaceLibrary;
  readonly registeredProjectFolders: ProjectEditFolder[];
  readonly setWorkspaceLibrary: Dispatch<SetStateAction<WorkspaceLibrary>>;
  readonly libraryLoaded: boolean;
  readonly refreshWorkspaceLibrary: () => Promise<void>;
  readonly workspaceLibraryEntries: WorkspaceLibraryEntry[];
};

export type UseWorkspaceLibraryResult = {
  readonly library: WorkspaceLibraryState;
  readonly workspaceLibrary: WorkspaceLibrary;
  readonly registeredProjectFolders: ProjectEditFolder[];
  readonly setWorkspaceLibrary: Dispatch<SetStateAction<WorkspaceLibrary>>;
  readonly libraryLoaded: boolean;
  readonly libraryLoadError: string | null;
  readonly refreshWorkspaceLibrary: () => Promise<void>;
  readonly workspaceLibraryEntries: WorkspaceLibraryEntry[];
  readonly mountedProjects: WorkspaceProject[];
  readonly projectHomeProject: WorkspaceProject | null;
};

export function useWorkspaceLibrary({
  shellPrepared,
  workspacePath,
  folders,
  fileTreeRefreshToken,
  projectHomePath,
  renameFolder,
}: UseWorkspaceLibraryOptions): UseWorkspaceLibraryResult {
  const [workspaceLibrary, setConfirmedLibrary] = useState<WorkspaceLibrary>({
    active: [],
    archived: [],
    trashed: [],
  });

  const [registeredProjectFolders, setRegisteredProjectFolders] = useState<ProjectEditFolder[]>([]);
  const [libraryLoaded, setLibraryLoaded] = useState(false);
  const [libraryLoadError, setLibraryLoadError] = useState<string | null>(null);

  const libraryRequest = useRef(0);

  const setWorkspaceLibrary = useCallback<Dispatch<SetStateAction<WorkspaceLibrary>>>((next) => {
    libraryRequest.current += 1;
    setConfirmedLibrary(next);
  }, []);

  const refreshWorkspaceLibrary = useCallback(async () => {
    if (!shellPrepared || !isDesktopRuntime()) return;
    const request = ++libraryRequest.current;
    try {
      const [library, registered] = await Promise.all([
        listWorkspaceLibrary(),
        listProjectEditFolders(),
      ]);
      if (request !== libraryRequest.current) return;
      setConfirmedLibrary(library);
      setRegisteredProjectFolders(registered);
      setLibraryLoadError(null);
      setLibraryLoaded(true);
    } catch (err) {
      if (request !== libraryRequest.current) return;
      setLibraryLoadError(toUserMessage(err, 'failure.dnaforge-could-not-restore-your-projects'));
      console.warn('[App] Failed to refresh workspace library:', err);
    }
  }, [shellPrepared]);

  useEffect(
    () => () => {
      libraryRequest.current += 1;
    },
    [shellPrepared]
  );

  useEffect(() => {
    void refreshWorkspaceLibrary();
  }, [folders, refreshWorkspaceLibrary, workspacePath, fileTreeRefreshToken]);

  const workspaceLibraryEntries = useMemo(
    () => [...workspaceLibrary.active, ...workspaceLibrary.archived],
    [workspaceLibrary.active, workspaceLibrary.archived]
  );

  useEffect(() => {
    if (!libraryLoaded) return;
    for (const correction of reconcileManagedWorkspaceFolderNames({
      folders,
      activeLibraryEntries: workspaceLibrary.active,
    })) {
      renameFolder(correction.path, correction.name);
    }
  }, [workspaceLibrary.active, folders, libraryLoaded, renameFolder]);

  const mountedProjects = useMemo(
    () =>
      deriveMountedWorkspaceProjects({
        folders,
        libraryEntries: workspaceLibraryEntries,
      }),
    [folders, workspaceLibraryEntries]
  );

  useSheetSyncProjects(
    mountedProjects
      .filter((project) => project.access === 'writable')
      .map((project) => project.repoPath),
    shellPrepared && libraryLoaded
  );

  const projectHomeProject = useMemo(
    () => deriveWorkspaceProjectForPath(projectHomePath, folders, workspaceLibraryEntries),
    [folders, projectHomePath, workspaceLibraryEntries]
  );

  const library = useMemo<WorkspaceLibraryState>(
    () => ({
      workspaceLibrary,
      registeredProjectFolders,
      setWorkspaceLibrary,
      libraryLoaded,
      refreshWorkspaceLibrary,
      workspaceLibraryEntries,
    }),
    [
      workspaceLibrary,
      registeredProjectFolders,
      setWorkspaceLibrary,
      libraryLoaded,
      refreshWorkspaceLibrary,
      workspaceLibraryEntries,
    ]
  );

  return {
    library,
    workspaceLibrary,
    registeredProjectFolders,
    setWorkspaceLibrary,
    libraryLoaded,
    libraryLoadError,
    refreshWorkspaceLibrary,
    workspaceLibraryEntries,
    mountedProjects,
    projectHomeProject,
  };
}
