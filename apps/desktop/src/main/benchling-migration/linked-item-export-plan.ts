import { createHash } from 'node:crypto';

import {
  BENCHLING_LINKED_ITEM_EXPORT_PLAN_VERSION,
  parseBenchlingLinkedItemExportPlan,
  type BenchlingLinkedItemExportPlan,
} from '../../shared/benchling-linked-item-export-plan';
import { isValidationReportV2, type ValidationReport } from '../../shared/benchling-migration';

export function linkedItemExportPlan(
  runId: string,
  report: ValidationReport | null
): BenchlingLinkedItemExportPlan {
  if (!report || !isValidationReportV2(report) || !report.linkedItemRecovery) {
    throw new Error('This migration has no linked-item export plan.');
  }
  const evidence = report.linkedItemRecovery.evidence;
  const folders = evidence.folders
    .filter((folder) => folder.recoveredTargetCount < folder.targetCount)
    .map((folder) => ({
      sourceId: folder.sourceId,
      name: folder.name,
      sourceUrl: folder.sourceUrl,
      targetCount: folder.targetCount - folder.recoveredTargetCount,
    }))
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  if (folders.length === 0) throw new Error('All linked-item folders have already been recovered.');
  const canonical = {
    version: BENCHLING_LINKED_ITEM_EXPORT_PLAN_VERSION,
    kind: 'linked_item_export' as const,
    runId,
    organizationBaseUrl: evidence.organizationBaseUrl,
    folders,
  };
  const planId = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  return parseBenchlingLinkedItemExportPlan({ ...canonical, planId });
}
