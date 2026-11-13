import type { ValidationReport } from '../../shared/benchling-migration';

const BASE_REPORT_KEYS = new Set([
  'version',
  'runId',
  'scope',
  'snapshotId',
  'accountHash',
  'generatedAt',
  'passed',
  'sourceObjects',
  'attachments',
  'memberships',
  'relationships',
  'projections',
  'hashes',
  'rendering',
  'issues',
]);

const V2_REPORT_KEYS = new Set([
  ...BASE_REPORT_KEYS,
  'converterVersions',
  'exportJobs',
  'snapshotParts',
  'formulas',
  'nativeConversionExceptions',
  'collections',
  'scopedBoundary',
  'directFolderCapture',
  'directFolderImportScope',
  'linkedItemRecovery',
  'providerReferences',
  'folderTreeCapture',
  'destinationIntegrity',
  'providerTasks',
  'providerActivity',
  'gmailReceiptConfirmations',
  'localExport',
  'nativeImport',
]);

const SAFE_RELATIVE_PATH_KEYS = new Set([
  'path',
  'destinationPath',
  'entryPath',
  'evidencePath',
  'relativePath',
  'sourceArchivePath',
]);

const EMBEDDED_POSIX_PATH = /(?:^|[\s'"`(=:])\/(?!\/)(?:[^/\s'"`]+\/)+[^\s'"`]*/u;
const EMBEDDED_WINDOWS_PATH = /(?:^|[\s'"`(=:])(?:[a-z]:[\\/]|\\\\)[^\s'"`]*/iu;

export function assertValidationReportRendererPrivacySafe(
  value: unknown
): asserts value is ValidationReport {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2)) fail();
  const allowedTopLevelKeys = value.version === 2 ? V2_REPORT_KEYS : BASE_REPORT_KEYS;
  if (Object.keys(value).some((key) => !allowedTopLevelKeys.has(key))) fail();
  for (const required of BASE_REPORT_KEYS) {
    if (!(required in value)) fail();
  }
  visit(value, null, new WeakSet<object>());
}

export function assertValidationReportIssueDetailsRedacted(value: unknown): void {
  visitRedactedIssues(value, new WeakSet<object>());
}

function visitRedactedIssues(value: unknown, seen: WeakSet<object>): void {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) fail();
  seen.add(value);
  if (isMigrationIssueRecord(value) && Object.hasOwn(value, 'details')) fail();
  if (Array.isArray(value)) {
    for (const item of value) visitRedactedIssues(item, seen);
  } else {
    for (const nestedValue of Object.values(value)) visitRedactedIssues(nestedValue, seen);
  }
  seen.delete(value);
}

function visit(value: unknown, key: string | null, seen: WeakSet<object>): void {
  if (typeof value === 'string') {
    if (key && SAFE_RELATIVE_PATH_KEYS.has(key)) {
      if (!isSafeRelativePath(value)) fail();
      return;
    }
    if (containsFilesystemPath(value)) fail();
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) fail();
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) visit(item, null, seen);
  } else {
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      if (nestedKey === 'details' && isMigrationIssueRecord(value)) continue;
      if (/path/iu.test(nestedKey) && !SAFE_RELATIVE_PATH_KEYS.has(nestedKey)) fail();
      visit(nestedValue, nestedKey, seen);
    }
  }
  seen.delete(value);
}

function isSafeRelativePath(value: string): boolean {
  if (value.length === 0 || value.length > 4_096 || value.trim() !== value) return false;
  if (value.includes('\0')) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return false;
  }
  const portable = decoded.replace(/\\/gu, '/');
  if (portable.startsWith('/') || /^[a-z]:/iu.test(portable)) return false;
  return portable
    .split('/')
    .every(
      (segment) =>
        segment.length > 0 && segment !== '.' && segment !== '..' && !segment.includes(':')
    );
}

function containsFilesystemPath(value: string): boolean {
  return (
    value.startsWith('file://') ||
    EMBEDDED_POSIX_PATH.test(value) ||
    EMBEDDED_WINDOWS_PATH.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isMigrationIssueRecord(value: object): boolean {
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.code === 'string' &&
    typeof candidate.message === 'string' &&
    typeof candidate.blocking === 'boolean'
  );
}

function fail(): never {
  throw new Error('Validation report failed its renderer privacy boundary.');
}
