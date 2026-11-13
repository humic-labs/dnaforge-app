import type Database from 'better-sqlite3';
import {
  subscribeWorkspaceMutationReleased,
  workspaceMutationRootIdentity,
} from './workspace-sync-mutation-lease';

export function subscribeOrganizationRegistryPublicationWake(
  db: Database.Database,
  deps: {
    currentAccountId(): string | null;
    wake(): void;
    warn?(message: string): void;
  }
): () => void {
  return subscribeWorkspaceMutationReleased((workspaceRoot) => {
    const accountId = deps.currentAccountId();
    if (!accountId) return;
    try {
      const homes = db
        .prepare(
          `
        SELECT DISTINCT w.path FROM org_registry_record_publications p
        JOIN org_registry_local_records b USING (org_id, account_id, entity_id)
        JOIN workspaces w ON w.id = b.workspace_id
        WHERE p.account_id = ? AND p.status = 'ready'
          AND w.path IS NOT NULL AND length(w.path) > 0
          AND NOT EXISTS (
            SELECT 1 FROM org_registry_record_publication_supersessions s
            WHERE s.mutation_id = p.mutation_id
          )
      `
        )
        .all(accountId) as Array<{ path: string }>;
      if (homes.some((home) => workspaceMutationRootIdentity(home.path) === workspaceRoot)) {
        deps.wake();
      }
    } catch (error) {
      deps.warn?.(`Could not wake organization Registry synchronization: ${String(error)}`);
    }
  });
}
