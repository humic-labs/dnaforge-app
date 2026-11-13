import type { RegistryMutationOptions } from '../../shared/artifact-operation-ports';
import { emitLimsRegistryChanged } from './events';
import { platform } from '../../platform';
import { waitForWorkspaceSyncDatabase } from '../../db/workspace-sync-retry';
import { runWorkflowAction, type ScientificWorkflowAction } from '../../lib/workflow-telemetry';

import type {
  LimsApplyImportBatchInput,
  LimsApplyImportBatchResult,
  LimsAttachGenomeHypothesisInput,
  LimsAttachGenomeHypothesisResult,
  LimsAttachVerifiedGenomeInput,
  LimsAttachVerifiedGenomeResult,
  LimsEntity,
  LimsLink,
  LimsLinkEntitiesInput,
  LimsReplaceOutgoingRelationshipsInput,
  LimsReplaceOutgoingRelationshipsResult,
  LimsQueryEntitiesInput,
  LimsQueryRegistrySummariesInput,
  LimsIdScheme,
  LimsSchemaDefinitionView,
  LimsDefineSchemaInput,
  LimsRefineSchemaInput,
  LimsRegistryPreview,
  LimsRegistryPreviewInput,
  LimsRecordRelationshipTargetQuery,
  LimsRecordRelationshipTargetPage,
  LimsRegistrySummaryPage,
  LimsRegisterEntityInput,
  LimsRegistrationBadgeCandidate,
  LimsRegistrationBadgeInput,
  LimsSeedDemoDatasetInput,
  LimsSeedDemoDatasetResult,
  LimsSeedMockDemoInput,
  LimsSeedMockDemoResult,
  LimsSeedPracticeDemoInput,
  LimsSeedPracticeDemoResult,
  LimsSeedStarterRegistryInput,
  LimsSeedStarterRegistryResult,
  LimsResetRegistryResult,
  LimsTelemetryInput,
  LimsUndoImportBatchInput,
  LimsUndoImportBatchResult,
  LimsEntityActionInput,
  LimsRevertEntityResult,
  LimsEntityHistoryInput,
  LimsEntityHistoryEntry,
  LimsPendingRef,
  LimsConfirmPendingRefInput,
  LimsRejectPendingRefCandidateInput,
  LimsPendingRefActionInput,
} from '../../shared/lims';
export { updateLimsEntity } from '../../services/lims-entity-mutations';

export function ensureLimsSeeded(mutationToken?: string): Promise<void> {
  return platform().lims.ensureSeeded(mutationToken);
}

export function registerLimsEntity(
  input: LimsRegisterEntityInput,
  options: RegistryMutationOptions = {}
): Promise<LimsEntity> {
  return runRegistryMutation(
    'create',
    () => platform().lims.registerEntity(input, options.mutationToken),
    options
  );
}

export function revertLimsEntity(input: LimsEntityActionInput): Promise<LimsRevertEntityResult> {
  return runRegistryMutation('revert', () => platform().lims.revertEntity(input));
}

export function archiveLimsEntity(
  input: LimsEntityActionInput,
  options: RegistryMutationOptions = {}
): Promise<LimsEntity> {
  return runRegistryMutation(
    'archive',
    () => platform().lims.archiveEntity(input, options.mutationToken),
    options
  );
}

export function restoreLimsEntity(
  input: LimsEntityActionInput,
  options: RegistryMutationOptions = {}
): Promise<LimsEntity> {
  return runRegistryMutation(
    'restore',
    () => platform().lims.restoreEntity(input, options.mutationToken),
    options
  );
}

export function getLimsEntityHistory(
  input: LimsEntityHistoryInput
): Promise<LimsEntityHistoryEntry[]> {
  return platform().lims.getEntityHistory(input);
}

export function linkLimsEntities(
  input: LimsLinkEntitiesInput,
  options: RegistryMutationOptions = {}
): Promise<LimsLink> {
  return runRegistryMutation(
    'link',
    () => platform().lims.linkEntities(input, options.mutationToken),
    options
  );
}

export async function replaceLimsRecordRelationships(
  input: LimsReplaceOutgoingRelationshipsInput,
  options: RegistryMutationOptions = {}
): Promise<LimsReplaceOutgoingRelationshipsResult> {
  if (input.expectedEventSeq === undefined || !input.operationId)
    throw new Error('Inspect the record before replacing its relationships.');
  const result = await runRegistryMutation(
    'update',
    () => platform().lims.replaceOutgoingRelationships(input, options.mutationToken),
    options
  );
  emitLimsRegistryChanged();
  return result;
}

export function queryLimsEntities(input: LimsQueryEntitiesInput = {}): Promise<LimsEntity[]> {
  return waitForWorkspaceSyncDatabase(() => platform().lims.queryEntities(input));
}

export function queryLimsRegistrySummaries(
  input: LimsQueryRegistrySummariesInput = {}
): Promise<LimsRegistrySummaryPage> {
  return platform().lims.queryRegistrySummaries(input);
}

export function getLimsRegistryPreview(
  input: LimsRegistryPreviewInput
): Promise<LimsRegistryPreview> {
  return waitForWorkspaceSyncDatabase(() => platform().lims.getRegistryPreview(input));
}

export function queryLimsRecordRelationshipTargets(
  input: LimsRecordRelationshipTargetQuery
): Promise<LimsRecordRelationshipTargetPage> {
  return platform().lims.queryRecordRelationshipTargets(input);
}

export function getLimsIdSchemes(): Promise<LimsIdScheme[]> {
  return platform().lims.getIdSchemes();
}

export function getLimsSchemas(): Promise<LimsSchemaDefinitionView[]> {
  return platform().lims.listSchemas();
}

export function defineLimsSchema(input: LimsDefineSchemaInput): Promise<unknown> {
  return platform().lims.defineSchema(input);
}

export function refineLimsSchema(input: LimsRefineSchemaInput): Promise<unknown> {
  return platform().lims.refineSchema(input);
}

export function applyLimsImportBatch(
  input: LimsApplyImportBatchInput,
  mutationToken?: string
): Promise<LimsApplyImportBatchResult> {
  return runRegistryMutation('import', () =>
    platform().lims.applyImportBatch(input, mutationToken)
  );
}

export function undoLimsImportBatch(
  input: LimsUndoImportBatchInput
): Promise<LimsUndoImportBatchResult> {
  return runRegistryMutation('revert', () => platform().lims.undoImportBatch(input));
}

export function queryLimsPendingRefs(): Promise<LimsPendingRef[]> {
  return platform().lims.pendingRefs();
}
export function confirmLimsPendingRef(input: LimsConfirmPendingRefInput): Promise<void> {
  return runRegistryMutation('confirm', () => platform().lims.confirmPendingRef(input));
}
export function rejectLimsPendingRefCandidate(
  input: LimsRejectPendingRefCandidateInput
): Promise<void> {
  return runRegistryMutation('reject', () => platform().lims.rejectPendingRefCandidate(input));
}
export function dismissLimsPendingRef(input: LimsPendingRefActionInput): Promise<void> {
  return runRegistryMutation('dismiss', () => platform().lims.dismissPendingRef(input));
}
export function getLimsRegistrationBadgeCandidates(
  input: LimsRegistrationBadgeInput
): Promise<LimsRegistrationBadgeCandidate[]> {
  return platform().lims.getRegistrationBadgeCandidates(input);
}

export function seedLimsDemoDataset(
  input: LimsSeedDemoDatasetInput = {}
): Promise<LimsSeedDemoDatasetResult> {
  return runRegistryMutation('import', () => platform().lims.seedDemoDataset(input));
}

export function seedLimsMockDemo(
  input: LimsSeedMockDemoInput = {}
): Promise<LimsSeedMockDemoResult> {
  return runRegistryMutation('import', () => platform().lims.seedMockDemo(input));
}

export function seedLimsPracticeDemo(
  input: LimsSeedPracticeDemoInput = {}
): Promise<LimsSeedPracticeDemoResult> {
  return runRegistryMutation('import', () => platform().lims.seedPracticeDemo(input));
}

export function seedLimsStarterRegistry(
  input: LimsSeedStarterRegistryInput = {}
): Promise<LimsSeedStarterRegistryResult> {
  return runRegistryMutation('import', () => platform().lims.seedStarterRegistry(input));
}

export function resetLimsRegistry(): Promise<LimsResetRegistryResult> {
  return runRegistryMutation('reset', () => platform().lims.resetRegistry());
}

export function attachLimsGenomeHypothesis(
  input: LimsAttachGenomeHypothesisInput
): Promise<LimsAttachGenomeHypothesisResult> {
  return runRegistryMutation('attach', () => platform().lims.attachGenomeHypothesis(input));
}

export function attachVerifiedLimsGenome(
  input: LimsAttachVerifiedGenomeInput
): Promise<LimsAttachVerifiedGenomeResult> {
  return runRegistryMutation('attach', () => platform().lims.attachVerifiedGenome(input));
}

export function logLimsTelemetry(input: LimsTelemetryInput): Promise<unknown> {
  return platform().lims.logTelemetry(input);
}

function runRegistryMutation<T>(
  action: ScientificWorkflowAction,
  run: () => Promise<T>,
  options: RegistryMutationOptions = {}
): Promise<T> {
  return runWorkflowAction(
    {
      workflow: 'registry',
      workflowOrigin: 'direct',
      action,
      ...options,
    },
    run,
    (result) => ({
      status: actionStatus(action),
      affectedCount: affectedCount(result),
    })
  );
}

function affectedCount(result: unknown): number | undefined {
  if (Array.isArray(result)) return result.length;
  if (!result || typeof result !== 'object') return undefined;
  const record = result as Record<string, unknown>;
  for (const key of ['affectedCount', 'updatedCount', 'createdCount', 'registeredCount', 'count']) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  return 1;
}

function actionStatus(
  action: ScientificWorkflowAction
): 'created' | 'updated' | 'attached' | 'success' {
  if (action === 'create' || action === 'import') return 'created';
  if (action === 'update') return 'updated';
  if (action === 'attach' || action === 'link') return 'attached';
  return 'success';
}
