import type Database from 'better-sqlite3';
import { withSafeWritablePaths } from './ipc/path-allowlist';
import { withKnownWorkspacePathsMutationAcrossWorkspaces } from './workspace-sync-mutation-lease';
import { assertWorkspaceWriteAllowed } from './workspace-write-admission';
import { assertProjectFilesystemMutationAllowed } from './project-filesystem-authority';

export function withHostedNativeWritablePaths<T>(
  db: Database.Database,
  paths: readonly string[],
  operation: (paths: readonly string[]) => Promise<T>
): Promise<T> {
  return withSafeWritablePaths(
    paths.map((path) => ({ path })),
    async (canonicalPaths) => {
      await assertProjectFilesystemMutationAllowed(db, canonicalPaths);
      assertWorkspaceWriteAllowed(db, canonicalPaths);
      return withKnownWorkspacePathsMutationAcrossWorkspaces(db, canonicalPaths, async () => {
        await assertProjectFilesystemMutationAllowed(db, canonicalPaths);
        assertWorkspaceWriteAllowed(db, canonicalPaths);
        return operation(canonicalPaths);
      });
    }
  );
}
