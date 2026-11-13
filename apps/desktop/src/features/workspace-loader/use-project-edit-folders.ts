import { isPathInsideBoundary } from '../../shared/path-boundary';
import { useEffect, useMemo, useState } from 'react';
import {
  subscribeProjectSharedEditAccess,
  currentProjectSharedEditAccess,
} from './project-shared-edit-access';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import {
  listProjectEditFolders,
  mergeProjectEditFolders,
  type ProjectEditFolder,
} from './project-edit-folders';

const NO_OWNING_PATHS: readonly string[] = [];

export function useProjectEditFolders(
  owningPaths: readonly string[] = NO_OWNING_PATHS
): ProjectEditFolder[] {
  const mounted = useWorkspaceStore((state) => state.folders);
  const refresh = useWorkspaceStore((state) => state.fileTreeRefreshToken);
  const [revision, setRevision] = useState(0);
  const [registered, setRegistered] = useState<ProjectEditFolder[]>([]);
  const [availability, setAvailability] = useState<'checking' | 'ready' | 'unavailable'>(
    'checking'
  );
  useEffect(() => {
    let cancelled = false;
    void listProjectEditFolders()
      .then((folders) => {
        if (!cancelled) {
          setRegistered(folders);
          setAvailability('ready');
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          console.error('Could not read project availability:', error);
          setAvailability('unavailable');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [mounted, refresh]);
  useEffect(() => {
    const paths = [...mounted.map((folder) => folder.path), ...owningPaths];
    const uuids = new Set(
      registered.flatMap((folder) =>
        folder.repoUuid &&
        folder.sharedEditAccess?.kind !== 'unavailable' &&
        !(folder.sharedEditAccess?.kind === 'ready' && folder.sharedEditAccess.role === null) &&
        paths.some((path) => isPathInsideBoundary(path, folder.path))
          ? [folder.repoUuid]
          : []
      )
    );
    const stops = [...uuids].map((uuid) =>
      subscribeProjectSharedEditAccess(uuid, () => {
        setRevision((current) => current + 1);
      })
    );
    return () => {
      for (const stop of stops) stop();
    };
  }, [registered, mounted, owningPaths]);
  return useMemo(() => {
    const folders = mergeProjectEditFolders(registered, mounted).map((folder) =>
      folder.repoUuid
        ? {
            ...folder,
            sharedEditAccess:
              folder.sharedEditAccess?.kind === 'unavailable' ||
              (folder.sharedEditAccess?.kind === 'ready' && folder.sharedEditAccess.role === null)
                ? folder.sharedEditAccess
                : (currentProjectSharedEditAccess(folder.repoUuid) ??
                  folder.sharedEditAccess ?? { kind: 'checking' as const }),
          }
        : folder
    );

    return availability === 'ready'
      ? folders
      : folders.map((folder) => ({ ...folder, editAvailability: availability }));
  }, [registered, mounted, availability, revision]);
}
