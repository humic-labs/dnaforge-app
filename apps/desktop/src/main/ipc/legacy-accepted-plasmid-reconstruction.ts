import type Database from 'better-sqlite3';
import { parseLegacyAcceptedPlasmidReconstructionInput } from '../../shared/legacy-accepted-plasmid-reconstruction';
import {
  assertCommittedDatabaseReadAllowed,
  withRendererDatabaseStatement,
  type RendererDatabaseLifecycleSender,
} from '../workspace-sync-database-fence';
import {
  findKnownWorkspaceRoot,
  withKnownWorkspacePathMutation,
  workspaceMutationRootIdentity,
} from '../workspace-sync-mutation-lease';
import { workspaceMutationCapabilities } from './workspace-mutation-capability';
import { assertWorkspaceMigrationActionsSettled } from '../workspace-migration-admission';
import { reconstructLegacyAcceptedPlasmidInMain } from '../legacy-accepted-plasmid-reconstruction';

export async function reconstructLegacyAcceptedPlasmidForRenderer(request: {
  db: Database.Database;
  sender: RendererDatabaseLifecycleSender;
  input: unknown;
  mutationToken: unknown;
}) {
  const input = parseLegacyAcceptedPlasmidReconstructionInput(request.input);
  const { db, sender, mutationToken } = request;
  const runDatabase = <T>(work: () => T): T => withRendererDatabaseStatement(db, sender, work);
  const root = runDatabase(() => {
    assertCommittedDatabaseReadAllowed(db);
    const knownRoot = findKnownWorkspaceRoot(db, input.metadataPath);
    if (!knownRoot) throw new Error('The legacy Plasmid source has no known project.');
    return knownRoot;
  });
  const run = async () => {
    await assertWorkspaceMigrationActionsSettled(root);
    return reconstructLegacyAcceptedPlasmidInMain({ db, runDatabase, input });
  };
  if (mutationToken !== undefined) {
    if (typeof mutationToken !== 'string' || !mutationToken || mutationToken.length > 128)
      throw new Error('WORKSPACE_MUTATION_TOKEN_INVALID');
    const owned = workspaceMutationCapabilities.resolveOwnedWorkspaceRoot(mutationToken, sender.id);
    if (!owned || owned !== workspaceMutationRootIdentity(root))
      throw new Error('WORKSPACE_MUTATION_TOKEN_INVALID');
    const result = await workspaceMutationCapabilities.runWithToken(
      mutationToken,
      sender.id,
      owned,
      run
    );
    if (!result.active) throw new Error('WORKSPACE_MUTATION_TOKEN_INVALID');
    return result.value;
  }
  return withKnownWorkspacePathMutation(db, [input.metadataPath], run);
}
