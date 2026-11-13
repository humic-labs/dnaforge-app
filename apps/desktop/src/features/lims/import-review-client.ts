import { platform } from '../../platform';
import { useSettingsStore } from '../junction-workbench/public/settings';
import { waitForNativeFileDocumentReadiness } from '../workspace/public/file-document-client';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { findContainingPathBoundary } from '../../shared/path-boundary';
import type { ImportReviewCommand, ImportReviewDocument } from '../../shared/import-review';
import type { LimsImportColumnMappingOverride, LimsImportPlan } from '../../shared/lims';
import {
  createLimsImportPlan,
  applyImportPlanColumnMappings,
  setImportPlanRecordsAccepted,
  type DryRunLimsImportInput,
} from './ingress';

function snapshotPlan(document: ImportReviewDocument): LimsImportPlan {
  return { ...document.plan, review: { id: document.id, revision: document.revision } };
}

export async function prepareLimsImportReview(
  source: DryRunLimsImportInput
): Promise<LimsImportPlan> {
  if (!platform().runtime.getProfile().isElectron) return createLimsImportPlan(source);
  await waitForNativeFileDocumentReadiness();
  const nativeSource = { ...source };
  const settings = useSettingsStore.getState();
  const primerTmSettings = {
    userSetting: settings.tmModel,
    userSettingIsExplicit: settings.tmModelExplicit,
    conditions: settings.tmConditions,
    concNm: settings.primerConcNm,
  };
  if (
    nativeSource.sourcePath &&
    !findContainingPathBoundary(useWorkspaceStore.getState().folders, nativeSource.sourcePath)
  )
    delete nativeSource.sourcePath;
  const inspection = await platform().importReview.call({
    kind: 'prepare',
    workspaceRoot: '',
    destinationDir: '',
    source: { ...nativeSource, primerTmSettings },
  });
  return snapshotPlan(await platform().importReview.snapshot(inspection.id));
}

export async function executeLimsImportReview(
  plan: LimsImportPlan,
  command: ImportReviewCommand
): Promise<LimsImportPlan> {
  if (!plan.review)
    throw new Error('IMPORT_REVIEW_REQUIRED: Reopen the source before changing this review.');
  await waitForNativeFileDocumentReadiness();
  const inspection = await platform().importReview.call({
    kind: 'execute',
    id: plan.review.id,
    expectedRevision: plan.review.revision,
    command,
  });
  return snapshotPlan(await platform().importReview.snapshot(inspection.id));
}

export async function mapLimsImportReview(
  plan: LimsImportPlan,
  mappings: readonly LimsImportColumnMappingOverride[]
): Promise<LimsImportPlan> {
  return plan.review
    ? executeLimsImportReview(plan, { kind: 'set-mappings', mappings: [...mappings] })
    : applyImportPlanColumnMappings(plan, mappings);
}

export async function acceptLimsImportReviewRecords(
  plan: LimsImportPlan,
  recordIds: readonly string[],
  accepted: boolean
): Promise<LimsImportPlan> {
  return plan.review
    ? executeLimsImportReview(plan, {
        kind: 'set-records-accepted',
        recordIds: [...recordIds],
        accepted,
      })
    : setImportPlanRecordsAccepted(plan, recordIds, accepted);
}

export async function applyLimsImportReview(
  plan: LimsImportPlan,
  workspaceRoot: string,
  destinationDir: string
): Promise<ImportReviewDocument> {
  const located = await executeLimsImportReview(plan, {
    kind: 'set-destination',
    workspaceRoot,
    destinationDir,
  });
  await executeLimsImportReview(located, { kind: 'apply', requestId: crypto.randomUUID() });
  return platform().importReview.snapshot(located.review!.id);
}

export async function inspectLimsImportReview(
  id: string
): Promise<{ document: ImportReviewDocument; plan: LimsImportPlan }> {
  const document = await platform().importReview.snapshot(id);
  return { document, plan: snapshotPlan(document) };
}

export async function cancelLimsImportReview(plan: LimsImportPlan): Promise<void> {
  if (!plan.review) return;
  const current = await platform().importReview.snapshot(plan.review.id);
  if (current.phase === 'review')
    await executeLimsImportReview(snapshotPlan(current), { kind: 'cancel' });
}
