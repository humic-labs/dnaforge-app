import type Database from 'better-sqlite3';
import { ScientificObjectStore, hasAcceptedScientificWorkspace } from './scientific-object-store';
import { reconcileScientificNativeProjectionsInsideTx } from './scientific-native-projection';
import { acquireWorkspaceSyncDatabaseFence } from './workspace-sync-database-fence';
import { withDeclaredWorkspaceMutation } from './workspace-sync-mutation-lease';
import { withDeclaredRendererWorkspaceMutation } from './ipc/workspace-mutation-authority';
import { assertWorkspaceMigrationActionsSettled } from './workspace-migration-admission';
import { materializeScientificWorkspace } from './scientific-object-materializer';
import { repairAcceptedSequencePackageCaches } from './scientific-package-cache-migration';

export async function reconcileScientificProjections(input: {
  readonly db: Database.Database;
  readonly workspaceId: number;
  readonly renderer?: { readonly ownerId: number; readonly mutationToken?: string };
}) {
  if (input.db.inTransaction)
    throw new Error('Scientific projection cannot enter an open database transaction.');
  if (!hasAcceptedScientificWorkspace(input.db, input.workspaceId))
    return { head: null, projectedPaths: [], relationships: 0 };
  const store = new ScientificObjectStore(input.db, input.workspaceId);
  const { head } = store.catalog();
  if (head === null && store.pendingMaterializations().length === 0)
    return { head, projectedPaths: [], relationships: 0 };
  const root = store.workspaceRoot();
  const operation = async () => {
    await assertWorkspaceMigrationActionsSettled(root);
    if (input.db.inTransaction)
      throw new Error('Scientific projection cannot borrow an open transaction.');
    const release = await acquireWorkspaceSyncDatabaseFence(input.db);
    try {
      const delivery = await materializeScientificWorkspace(store);
      if (delivery.kind === 'blocked')
        throw new Error(`Accepted scientific file delivery is pending: ${delivery.error}`);
      if (repairAcceptedSequencePackageCaches(input.db, store, input.workspaceId)) {
        const repaired = await materializeScientificWorkspace(store);
        if (repaired.kind === 'blocked')
          throw new Error(`Accepted package cache repair is pending: ${repaired.error}`);
      }
      return input.db
        .transaction(() =>
          reconcileScientificNativeProjectionsInsideTx(input.db, input.workspaceId)
        )
        .immediate();
    } finally {
      release();
    }
  };
  return input.renderer
    ? withDeclaredRendererWorkspaceMutation({
        db: input.db,
        ownerId: input.renderer.ownerId,
        workspaceRoot: root,
        ...(input.renderer.mutationToken ? { mutationToken: input.renderer.mutationToken } : {}),
        operation,
      })
    : withDeclaredWorkspaceMutation(input.db, root, [], operation);
}
