import { resolveEntityArtifactSchemaSnapshot } from './record-entity-artifact';
import { platform } from '../../platform';
import { resolveWorkspaceId } from '../../db/workspace-catalog';
import { withRendererWorkspaceMutation } from '../../services/workspace-mutation-transaction';
import { gitCommitPaths, isGitRepo } from '../workspace/public/git';
import { applyAcceptedLimsImportPlan } from './ingress';
import { persistImportSet } from './import-set';
import * as core from './import-entity-artifact-core';
import { applyLimsImportReview } from './import-review-client';
export * from './import-entity-artifact-core';
function defaults(): core.ImportedEntityArtifactDependencies {
  return {
    fs: platform().fs,
    resolveSchemaSnapshot: resolveEntityArtifactSchemaSnapshot,
    resolveWorkspaceId,
    withMutation: (root, operation) => withRendererWorkspaceMutation(root, operation),
    applyPlan: applyAcceptedLimsImportPlan,
    persistSet: persistImportSet,
    isGitRepo,
    commitPaths: gitCommitPaths,
  };
}
export const recordImportedEntityArtifacts = async (
  input: Parameters<typeof core.recordImportedEntityArtifacts>[0],
  dependencies = defaults()
): Promise<core.ImportedEntityArtifactResult> => {
  if (!input.plan.review) return core.recordImportedEntityArtifacts(input, dependencies);
  const document = await applyLimsImportReview(
    input.plan,
    input.workspaceRoot,
    input.destinationDir
  );
  const receipt = document.receipt;
  if (!receipt || (document.phase !== 'applied' && document.phase !== 'partial'))
    throw new Error(document.error ?? 'Import outcome is unavailable.');
  const members = receipt.members ?? [];
  return {
    applyResult: {
      batchId: receipt.batchId ?? document.id,
      insertedEntities: receipt.imported,
      insertedLinks: receipt.insertedLinks ?? 0,
      skipped: receipt.skipped,
      insertedEntityIds: members.map((member) => ({
        recordId: member.sourceRecordId,
        entityId: member.entityId,
      })),
      insertedLinkIds: [],
      skippedRecordIds: document.plan.records
        .filter((record) => !record.accepted)
        .map((record) => record.id),
      unresolvedLinks: [],
      errors: [],
    },
    artifactPaths: receipt.artifactPaths,
    artifactAbsolutePaths: receipt.artifactPaths.map((path) => `${input.workspaceRoot}/${path}`),
    gitCommitted: receipt.gitCommitted ?? false,
    importSet: receipt.importSet ?? null,
    ...(receipt.partialEffects?.length
      ? { importSetError: receipt.partialEffects.join('; ') }
      : {}),
    members,
    partition: { plan: document.plan, members },
  };
};
