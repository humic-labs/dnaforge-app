import type Database from 'better-sqlite3';
import { parseLegacyRegistryArtifactUpgradeInput } from '../../shared/legacy-registry-artifact-upgrade';
import { workspaceMutationRootIdentity } from '../workspace-sync-mutation-lease';
import { workspaceMutationCapabilities } from './workspace-mutation-capability';
import { upgradeLegacyRegistryArtifactInMain } from '../legacy-registry-artifact-upgrade';
import {
  withRendererDatabaseStatement,
  type RendererDatabaseLifecycleSender,
} from '../workspace-sync-database-fence';
import { assertLimsSafetyNotQuarantined } from '../lims-safety-quarantine';
import { assertWorkspaceMigrationActionsSettled } from '../workspace-migration-admission';

export async function upgradeLegacyRegistryArtifactForRenderer(request: {
  db: Database.Database;
  sender: RendererDatabaseLifecycleSender;
  input: unknown;
  mutationToken: unknown;
}) {
  const input = parseLegacyRegistryArtifactUpgradeInput(request.input);
  const { db, sender, mutationToken } = request;
  if (typeof mutationToken !== 'string' || !mutationToken || mutationToken.length > 128)
    throw new Error('WORKSPACE_MUTATION_TOKEN_INVALID');
  const root = workspaceMutationCapabilities.resolveOwnedWorkspaceRoot(mutationToken, sender.id);
  if (!root || root !== workspaceMutationRootIdentity(input.workspaceRoot))
    throw new Error('WORKSPACE_MUTATION_TOKEN_INVALID');
  const runDatabase = <T>(work: () => T): T => withRendererDatabaseStatement(db, sender, work);
  const result = await workspaceMutationCapabilities.runWithToken(
    mutationToken,
    sender.id,
    root,
    async () => {
      runDatabase(() => assertLimsSafetyNotQuarantined(db));
      await assertWorkspaceMigrationActionsSettled(root);
      return upgradeLegacyRegistryArtifactInMain({ db, runDatabase, input });
    }
  );
  if (!result.active) throw new Error('WORKSPACE_MUTATION_TOKEN_INVALID');
  return result.value;
}
