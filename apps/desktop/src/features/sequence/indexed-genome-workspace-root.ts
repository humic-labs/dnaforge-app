import { findContainingPathBoundary } from '../../shared/path-boundary';

export function pickIndexedGenomeWorkspaceRoot(
  sourcePath: string,
  currentWorkspace: string | null,
  mountedWorkspaceFolders: readonly string[]
): string | null {
  const candidates = [...mountedWorkspaceFolders, currentWorkspace].filter((path): path is string =>
    Boolean(path)
  );
  const owner = findContainingPathBoundary(
    [...new Set(candidates)].map((path) => ({ path })),
    sourcePath
  );
  return owner?.path ?? null;
}
