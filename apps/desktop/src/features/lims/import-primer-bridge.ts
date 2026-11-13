import {
  commitPrimerBatchHistory,
  currentDirtyLimsPaths,
} from '../primers/public/primer-artifact-service';
import { recordPrimers } from '../primers/public/record-primers';
import { primerServices } from '../primers/public/primer-services';
import { persistImportSet } from './import-set';
import { createPrimerImportWriter } from './import-primer-owner';
import { applyLimsImportReview } from './import-review-client';
export * from './import-primer-owner';
const owner = createPrimerImportWriter({
  commitPrimerBatchHistory,
  currentDirtyLimsPaths,
  recordPrimers,
  primerServices,
  persistImportSet,
});
export const {
  oligoImportSourceRowId,
  plannedPrimersFromImport,
  plannedPrimersForDestination,
  persistImportedPrimerImportSet,
} = owner;
export const recordImportedPrimers: typeof owner.recordImportedPrimers = async (
  plan,
  destination
) => {
  if (!plan.review) return owner.recordImportedPrimers(plan, destination);
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
    artifactRelativePaths: receipt.artifactPaths,
    importSet: receipt.importSet ?? null,
    ...(receipt.failed && receipt.partialEffects?.length
      ? { importSetError: receipt.partialEffects.join('; ') }
      : {}),
    members,
    partition: { plan: document.plan, members },
  };
};
