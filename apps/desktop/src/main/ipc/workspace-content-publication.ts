import type Database from 'better-sqlite3';
import { withEnrolledSequencePackagePublication } from '../scientific-sequence-package-publication';
import { assertKnownWorkspaceContentWritable } from '../workspace-content-write-access';
import { withRendererDatabaseStatement } from '../workspace-sync-database-fence';
export function withSequencePackageOwner<T>(
  db: Database.Database,
  ownerId: number,
  workspaceRoot: string,
  input: {
    packageRoot: string;
    packageId: string;
    mutationToken?: string;
  },
  mutationLease: (() => void) | undefined,
  operation: () => Promise<T>
): Promise<T> {
  return withEnrolledSequencePackagePublication(
    {
      db,
      workspaceRoot,
      packageRoot: input.packageRoot,
      packageId: input.packageId,
      renderer: { ownerId, mutationToken: input.mutationToken },
      mutationLease,
    },
    operation
  );
}
export function assertWorkspaceContentPublicationWritable(
  db: Database.Database,
  event: Electron.IpcMainInvokeEvent,
  workspaceRoot: string
): void {
  withRendererDatabaseStatement(db, event.sender, () =>
    assertKnownWorkspaceContentWritable(db, workspaceRoot)
  );
}
