import type { WorkspaceSyncExcludedSummary as BundleExcludedSummary } from '@waypoint/share-bundle';

import type { WorkspaceSyncExcludedSummary as StatusExcludedSummary } from '../shared/cloud-sync-status';

const STATUS_KEYS = [
  'unsupportedCount',
  'privateRawDataCount',
  'referencePointerCount',
  'fileTooLargeCount',
  'bundleTooLargeCount',
] as const;

export const UNKNOWN_WORKSPACE_SYNC_EXCLUSIONS: StatusExcludedSummary = {
  unsupportedCount: 1,
};

export function toWorkspaceSyncStatusExcludedSummary(
  summary: BundleExcludedSummary
): StatusExcludedSummary {
  return {
    unsupportedCount: summary.unsupported.count,
    privateRawDataCount: summary['private-raw-data'].count,
    referencePointerCount: summary['reference-pointer'].count,
    fileTooLargeCount: summary['file-too-large'].count,
    bundleTooLargeCount: summary['bundle-too-large'].count,
  };
}

export function serializeWorkspaceSyncExcludedSummary(summary: StatusExcludedSummary): string {
  return JSON.stringify(normalizeWorkspaceSyncExcludedSummary(summary));
}

export function parseWorkspaceSyncExcludedSummary(
  value: string | null | undefined
): StatusExcludedSummary | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) return null;
    const summary: StatusExcludedSummary = {};
    for (const key of STATUS_KEYS) {
      const count = parsed[key];
      if (!Number.isSafeInteger(count) || (count as number) < 0) return null;
      summary[key] = count as number;
    }
    return summary;
  } catch {
    return null;
  }
}

function normalizeWorkspaceSyncExcludedSummary(
  summary: StatusExcludedSummary
): Required<StatusExcludedSummary> {
  return {
    unsupportedCount: validCount(summary.unsupportedCount),
    privateRawDataCount: validCount(summary.privateRawDataCount),
    referencePointerCount: validCount(summary.referencePointerCount),
    fileTooLargeCount: validCount(summary.fileTooLargeCount),
    bundleTooLargeCount: validCount(summary.bundleTooLargeCount),
  };
}

function validCount(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value ?? 0) >= 0 ? (value ?? 0) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
