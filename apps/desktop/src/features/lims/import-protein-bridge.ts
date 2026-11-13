import { recordProtein, ProteinProjectionError } from '../proteins/public/record-proteins';
import { gitCommitPaths, isGitRepo } from '../workspace/public/git';
import { persistImportSet } from './import-set';
import { resolveEntityArtifactSchemaFields } from './record-entity-artifact';
import { beginWorkflowAction } from '../../lib/workflow-telemetry';
import { createProteinImportWriter } from './import-protein-owner';
import { applyLimsImportReview } from './import-review-client';
export * from './import-protein-owner';
const owner = createProteinImportWriter({
  projectionError: ProteinProjectionError,
  recordProtein,
  gitCommitPaths,
  isGitRepo,
  persistImportSet,
  resolveEntityArtifactSchemaFields,
  beginWorkflowAction,
});
export const recordImportedProteins: typeof owner.recordImportedProteins = async (
  plan,
  destination
) => {
  if (!plan.review) return owner.recordImportedProteins(plan, destination);
  const document = await applyLimsImportReview(
    plan,
    destination.workspaceRoot,
    destination.destinationDir
  );
  const receipt = document.receipt;
  if (!receipt) throw new Error(document.error ?? 'Import outcome is unavailable.');
  const members = receipt.members ?? [];
  return {
    added: receipt.imported,
    skipped: receipt.skipped,
    failed: receipt.failed,
    failures: (receipt.partialEffects ?? []).map((message) => ({
      name: document.plan.sourceName,
      message,
    })),
    reconciliationRequired: [],
    artifactRelativePaths: receipt.artifactPaths,
    artifactAbsolutePaths: receipt.artifactPaths.map(
      (path) => `${destination.workspaceRoot}/${path}`
    ),
    gitCommitted: receipt.gitCommitted ?? false,
    importSet: receipt.importSet ?? null,
    ...(receipt.failed && receipt.partialEffects?.length
      ? { importSetError: receipt.partialEffects.join('; ') }
      : {}),
    members,
    partition: { plan: document.plan, members },
  };
};
