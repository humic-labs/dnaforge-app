import { withUserMessage } from '@waypoint/user-messages';
import {
  parseProviderObjectReference,
  type ProviderObjectReference,
  type ProviderReferenceResolution,
} from './provider-object-reference';
import type {
  MigrationIssue,
  LinkedItemRecoveryProgress,
  MigrationScope,
  MigrationState,
  SourceBinding,
  ValidationReport,
} from './benchling-migration';
import {
  isImportDecision,
  type ImportDecision,
  type PendingImportDecision,
} from './benchling-import-decision';
import {
  parseRegistryTableMappingDecision,
  type RegistryTableMappingDecision,
  type RegistryTableReviewCandidate,
} from './benchling-registry-table-review';

export const BENCHLING_MIGRATION_SUBSCRIBE_PROGRESS_CHANNEL =
  'benchlingMigration:subscribeProgress';
export const BENCHLING_MIGRATION_UNSUBSCRIBE_PROGRESS_CHANNEL =
  'benchlingMigration:unsubscribeProgress';
export const BENCHLING_MIGRATION_PROGRESS_CHANGED_CHANNEL = 'benchlingMigration:progressChanged';

export const BENCHLING_MIGRATION_IPC_CHANNELS = Object.freeze({
  getActiveRun: 'benchlingMigration:getActiveRun',
  resolveProviderReference: 'benchlingMigration:resolveProviderReference',
  surveyImportDestinations: 'benchlingMigration:surveyImportDestinations',
  getHistory: 'benchlingMigration:getHistory',
  getHistoryDetail: 'benchlingMigration:getHistoryDetail',
  viewExternalSource: 'benchlingMigration:viewExternalSource',
  importLocalBundle: 'benchlingMigration:importLocalBundle',
  addLinkedItemExports: 'benchlingMigration:addLinkedItemExports',
  appendWorkspaceExports: 'benchlingMigration:appendWorkspaceExports',
  resolveImportDecision: 'benchlingMigration:resolveImportDecision',
  openLinkedItemRecoveryLocation: 'benchlingMigration:openLinkedItemRecoveryLocation',
  start: 'benchlingMigration:start',
  pause: 'benchlingMigration:pause',
  resume: 'benchlingMigration:resume',
  cancelPreserved: 'benchlingMigration:cancelPreserved',
  startOverPreserved: 'benchlingMigration:startOverPreserved',
  getReport: 'benchlingMigration:getReport',
  unlock: 'benchlingMigration:unlock',
  discard: 'benchlingMigration:discard',
  subscribeProgress: BENCHLING_MIGRATION_SUBSCRIBE_PROGRESS_CHANNEL,
  unsubscribeProgress: BENCHLING_MIGRATION_UNSUBSCRIBE_PROGRESS_CHANNEL,
  progressChanged: BENCHLING_MIGRATION_PROGRESS_CHANGED_CHANNEL,
} as const);

export type BenchlingMigrationBindingView = Pick<
  SourceBinding,
  | 'version'
  | 'benchlingOrigin'
  | 'benchlingOrganizationBaseUrl'
  | 'benchlingAccountEmail'
  | 'benchlingOrganizationId'
  | 'benchlingOrganizationName'
  | 'gmailMailbox'
  | 'confirmedAt'
  | 'gmailMismatchConfirmedAt'
>;

export type BenchlingMigrationRecoveryAction = 'start_new_migration_select_original_export';

export type BenchlingMigrationRunIssueView = Omit<MigrationIssue, 'details'>;

export type BenchlingMigrationSourceArtifactView = {
  kind: 'local_bundle';
  format: 'zip' | 'html';
  fileName: string;
  sha256: string;
  sizeBytes: number;
};

export type BenchlingMigrationPendingImportDecisionView = PendingImportDecision;

export type BenchlingMigrationRunView = {
  version: 1;
  id: string;
  workspaceId: string;
  displayName: string;

  workspaceOrigin?: 'migration_created' | 'adopted_existing';
  scope: MigrationScope;
  binding: BenchlingMigrationBindingView | null;
  state: MigrationState;
  resumeState: import('./benchling-migration').ActiveMigrationState | null;
  attempt: number;
  converterVersions: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  unlockedAt: string | null;
  lastError: BenchlingMigrationRunIssueView | null;
  recoveryAction: BenchlingMigrationRecoveryAction | null;

  sourceArtifact?: BenchlingMigrationSourceArtifactView;

  localBundleState: 'waiting_for_selection' | 'copying' | 'ready' | null;

  localBundleMode?: 'external_zip' | 'copied_artifact';

  retryWithoutFileAvailable?: boolean;

  bestEffortRecoveryPending?: boolean;
  linkedItemRecovery?: LinkedItemRecoveryProgress | null;
};

type RedactedValidationReport<Value> = Value extends MigrationIssue
  ? BenchlingMigrationRunIssueView
  : Value extends readonly (infer Item)[]
    ? RedactedValidationReport<Item>[]
    : Value extends object
      ? {
          [Key in keyof Value as Key extends
            | 'accountHash'
            | 'sourceAccountHash'
            | 'providerTaskId'
            | 'providerTaskHandleSha256'
            | 'receiptId'
            ? never
            : Key]: RedactedValidationReport<Value[Key]>;
        }
      : Value;

export type BenchlingMigrationReportView = RedactedValidationReport<ValidationReport>;

export type BenchlingMigrationCreatedObjectView = Readonly<{
  id: string;
  type: import('./native-workspace-manifest').NativeWorkspaceManifestEntityType;
  name: string;
  path: string;
}>;

export type BenchlingMigrationHistorySummaryView = Readonly<{
  run: BenchlingMigrationRunView;
  createdObjectCount: number;
  missingDependencyCount: number;
}>;

export type BenchlingMigrationHistoryDetailView = Readonly<{
  run: BenchlingMigrationRunView;
  report: BenchlingMigrationReportView | null;
  createdObjects: readonly BenchlingMigrationCreatedObjectView[];
}>;

export type BenchlingMigrationImportLocalBundleResult = {
  run: BenchlingMigrationRunView | null;
};

export type BenchlingMigrationImportLocalBundleRequest = {
  retryFailedRunId?: string;
  reviewedTables?: readonly RegistryTableMappingDecision[];

  runId?: string;

  sourcePath?: string;

  workspaceName?: string;

  workspaceDbId?: number;
};

export type BenchlingMigrationAddLinkedItemExportsRequest = {
  runId: string;
  sourcePaths?: string[];
  reviewedTables?: readonly RegistryTableMappingDecision[];
};

export type BenchlingMigrationAppendWorkspaceExportsRequest = {
  runId: string;
  sourcePaths?: string[];
  reviewedTables?: readonly RegistryTableMappingDecision[];
};

export type BenchlingMigrationAppendWorkspaceExportsResult = {
  run: BenchlingMigrationRunView | null;
};

export type BenchlingMigrationResolveImportDecisionRequest = {
  runId: string;
  attemptId: string;
  decision: ImportDecision;
};

export type BenchlingMigrationResolveImportDecisionResult = {
  run: BenchlingMigrationRunView;
};

export type BenchlingMigrationAddLinkedItemExportsResult = {
  run: BenchlingMigrationRunView | null;
};

export type BenchlingMigrationLinkedItemRecoveryLocationKind = 'folder' | 'target';

export type BenchlingMigrationOpenLinkedItemRecoveryLocationRequest = {
  runId: string;
  kind: BenchlingMigrationLinkedItemRecoveryLocationKind;
  sourceId: string;
};

export type BenchlingMigrationOpenLinkedItemRecoveryLocationResult = {
  opened: true;
};

export type BenchlingMigrationSubscribeProgressRequest = {
  runId: string;
  subscriptionId: string;
};

export type BenchlingMigrationProgressEvent = {
  runId: string;
  run: BenchlingMigrationRunView;
  message: string;
  completedItems: number | null;
  totalItems: number | null;

  warnings: string[];
  sequence: number;
  emittedAt: number;
};

export type BenchlingMigrationProgressSubscriptionStatus = 'ready' | 'failed';

export type BenchlingMigrationUnlockResult = {
  run: BenchlingMigrationRunView;
  workspaceId: string;
};

export type BenchlingMigrationDiscardResult = {
  runId: string;
  discarded: true;
};

const OPAQUE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function parseBenchlingMigrationOpaqueId(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be an opaque ID.`);
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes('..') ||
    !OPAQUE_ID_RE.test(trimmed)
  ) {
    throw new Error(`${label} must be an opaque ID.`);
  }
  return trimmed;
}

export function parseBenchlingMigrationRunId(value: unknown): string {
  return parseBenchlingMigrationOpaqueId(value, 'runId');
}

export function parseBenchlingMigrationSubscriptionId(value: unknown): string {
  return parseBenchlingMigrationOpaqueId(value, 'subscriptionId');
}

export function parseBenchlingMigrationImportLocalBundleRequest(
  value: unknown
): BenchlingMigrationImportLocalBundleRequest {
  if (value === undefined) return {};
  const record = requireRecord(value, 'importLocalBundle request must be an object.');
  const keys = Object.keys(record);
  if (keys.length === 0) return {};
  const allowedKeys = new Set([
    'retryFailedRunId',
    'runId',
    'sourcePath',
    'workspaceName',
    'workspaceDbId',
    'reviewedTables',
  ]);
  if (keys.some((key) => !allowedKeys.has(key))) {
    throw new Error(
      'importLocalBundle request must contain only runId, sourcePath, workspaceName, and/or workspaceDbId.'
    );
  }
  if (Object.prototype.hasOwnProperty.call(record, 'retryFailedRunId') && keys.length !== 1) {
    throw new Error('A failed-file retry cannot be combined with another import selection.');
  }
  if (
    Object.prototype.hasOwnProperty.call(record, 'runId') &&
    Object.prototype.hasOwnProperty.call(record, 'workspaceName')
  ) {
    throw new Error('workspaceName cannot be provided when replacing an existing run export.');
  }
  if (
    Object.prototype.hasOwnProperty.call(record, 'runId') &&
    Object.prototype.hasOwnProperty.call(record, 'workspaceDbId')
  ) {
    throw new Error('runId cannot be combined with workspaceDbId.');
  }
  if (
    Object.prototype.hasOwnProperty.call(record, 'workspaceName') &&
    Object.prototype.hasOwnProperty.call(record, 'workspaceDbId')
  ) {
    throw new Error('Choose either a new workspace name or an existing workspace.');
  }
  return {
    ...(Object.prototype.hasOwnProperty.call(record, 'retryFailedRunId')
      ? { retryFailedRunId: parseBenchlingMigrationRunId(record.retryFailedRunId) }
      : {}),
    ...reviewedTablesFromRequest(record),
    ...(Object.prototype.hasOwnProperty.call(record, 'runId')
      ? { runId: parseBenchlingMigrationRunId(record.runId) }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(record, 'sourcePath')
      ? { sourcePath: parseBenchlingMigrationDroppedExportPath(record.sourcePath) }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(record, 'workspaceName')
      ? { workspaceName: parseBenchlingMigrationWorkspaceName(record.workspaceName) }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(record, 'workspaceDbId')
      ? { workspaceDbId: parseWorkspaceDbId(record.workspaceDbId) }
      : {}),
  };
}

function parseWorkspaceDbId(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error('workspaceDbId must be a positive integer.');
  }
  return value as number;
}

function parseBenchlingMigrationWorkspaceName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('workspaceName must be a string.');
  }
  const normalized = value.replace(/\s+/gu, ' ').trim();
  if (normalized.length === 0 || normalized.length > 120) {
    throw new Error('workspaceName must contain 1 to 120 characters.');
  }
  if (normalized.includes('/') || normalized.includes('\\')) {
    throw new Error('workspaceName must not contain path separators.');
  }
  if ([...normalized].some((character) => (character.codePointAt(0) ?? 0) <= 31)) {
    throw new Error('workspaceName must not contain control characters.');
  }
  return normalized;
}

export const BENCHLING_MIGRATION_MAX_LINKED_ITEM_EXPORT_FILES = 64;

function reviewedTablesFromRequest(record: Record<string, unknown>): {
  reviewedTables?: readonly RegistryTableMappingDecision[];
} {
  if (!Object.prototype.hasOwnProperty.call(record, 'reviewedTables')) return {};
  const value = record.reviewedTables;
  if (!Array.isArray(value) || value.length > 6400)
    throw new Error('reviewedTables must contain at most 6400 table choices.');
  const reviewedTables = value.map(parseRegistryTableMappingDecision);
  const keys = reviewedTables.map(({ source }) => `${source.archiveSha256}:${source.entryPath}`);
  if (new Set(keys).size !== keys.length)
    throw new Error('reviewedTables contains duplicate table choices.');
  return { reviewedTables };
}

export function parseBenchlingMigrationAddLinkedItemExportsRequest(
  value: unknown
): BenchlingMigrationAddLinkedItemExportsRequest {
  const record = requireRecord(value, 'addLinkedItemExports request must be an object.');
  const keys = Object.keys(record)
    .filter((key) => key !== 'reviewedTables')
    .sort();
  if (
    !(
      (keys.length === 1 && keys[0] === 'runId') ||
      (keys.length === 2 && keys[0] === 'runId' && keys[1] === 'sourcePaths')
    )
  ) {
    throw new Error('addLinkedItemExports request must contain runId and optional sourcePaths.');
  }
  const runId = parseBenchlingMigrationRunId(record.runId);
  const reviewedTables = reviewedTablesFromRequest(record);
  if (!Object.prototype.hasOwnProperty.call(record, 'sourcePaths'))
    return { runId, ...reviewedTables };
  if (
    !Array.isArray(record.sourcePaths) ||
    record.sourcePaths.length === 0 ||
    record.sourcePaths.length > BENCHLING_MIGRATION_MAX_LINKED_ITEM_EXPORT_FILES
  ) {
    throw new Error(
      `sourcePaths must contain 1 to ${BENCHLING_MIGRATION_MAX_LINKED_ITEM_EXPORT_FILES} Benchling ZIP paths.`
    );
  }
  return {
    runId,
    ...reviewedTables,
    sourcePaths: record.sourcePaths.map(parseBenchlingMigrationDroppedLinkedItemExportPath),
  };
}

export function parseBenchlingMigrationAppendWorkspaceExportsRequest(
  value: unknown
): BenchlingMigrationAppendWorkspaceExportsRequest {
  const record = requireRecord(value, 'appendWorkspaceExports request must be an object.');
  const keys = Object.keys(record)
    .filter((key) => key !== 'reviewedTables')
    .sort();
  if (
    !(
      (keys.length === 1 && keys[0] === 'runId') ||
      (keys.length === 2 && keys[0] === 'runId' && keys[1] === 'sourcePaths')
    )
  ) {
    throw new Error('appendWorkspaceExports request must contain runId and optional sourcePaths.');
  }
  const runId = parseBenchlingMigrationRunId(record.runId);
  const reviewedTables = reviewedTablesFromRequest(record);
  if (!Object.prototype.hasOwnProperty.call(record, 'sourcePaths'))
    return { runId, ...reviewedTables };
  if (
    !Array.isArray(record.sourcePaths) ||
    record.sourcePaths.length === 0 ||
    record.sourcePaths.length > BENCHLING_MIGRATION_MAX_LINKED_ITEM_EXPORT_FILES
  ) {
    throw new Error(
      `sourcePaths must contain 1 to ${BENCHLING_MIGRATION_MAX_LINKED_ITEM_EXPORT_FILES} Benchling ZIP paths.`
    );
  }
  return {
    runId,
    ...reviewedTables,
    sourcePaths: record.sourcePaths.map(parseBenchlingMigrationDroppedLinkedItemExportPath),
  };
}

export function parseBenchlingMigrationResolveImportDecisionRequest(
  value: unknown
): BenchlingMigrationResolveImportDecisionRequest {
  const record = requireRecord(value, 'resolveImportDecision request must be an object.');
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== 'attemptId' ||
    keys[1] !== 'decision' ||
    keys[2] !== 'runId'
  ) {
    throw new Error('resolveImportDecision request must contain runId, attemptId, and decision.');
  }
  if (!isImportDecision(record.decision) || record.decision.kind === 'registry_table_mapping') {
    throw new Error('resolveImportDecision decision is invalid.');
  }
  return {
    runId: parseBenchlingMigrationRunId(record.runId),
    attemptId: parseBenchlingMigrationOpaqueId(record.attemptId, 'attemptId'),
    decision: record.decision,
  };
}

export function parseBenchlingMigrationOpenLinkedItemRecoveryLocationRequest(
  value: unknown
): BenchlingMigrationOpenLinkedItemRecoveryLocationRequest {
  const record = requireRecord(value, 'openLinkedItemRecoveryLocation request must be an object.');
  const keys = Object.keys(record).sort();
  if (keys.length !== 3 || keys[0] !== 'kind' || keys[1] !== 'runId' || keys[2] !== 'sourceId') {
    throw new Error(
      'openLinkedItemRecoveryLocation request must contain only runId, kind, and sourceId.'
    );
  }
  if (record.kind !== 'folder' && record.kind !== 'target') {
    throw new Error('kind must be folder or target.');
  }
  return {
    runId: parseBenchlingMigrationRunId(record.runId),
    kind: record.kind,
    sourceId: parseBenchlingMigrationOpaqueId(record.sourceId, 'sourceId'),
  };
}

function parseBenchlingMigrationDroppedLinkedItemExportPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw new Error('A dropped linked-item export must be a non-empty absolute path.');
  }
  const hasControlCharacter = [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if (hasControlCharacter) {
    throw new Error('A dropped linked-item export path must not contain control characters.');
  }
  if (!/\.zip$/iu.test(value)) {
    throw new Error('Add Benchling ZIP exports only.');
  }
  return value;
}

export function parseBenchlingMigrationDroppedExportPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw new Error('A dropped Benchling export must be a non-empty absolute path.');
  }

  const hasControlCharacter = [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if (hasControlCharacter) {
    throw new Error('A dropped Benchling export path must not contain control characters.');
  }
  if (!/\.(?:zip|html?)$/iu.test(value)) {
    throw withUserMessage(
      new Error('Drop a Benchling ZIP or HTML export.'),
      'guidance.drop-a-benchling-zip-or-html-export'
    );
  }
  return value;
}

export function parseBenchlingMigrationSubscribeProgressRequest(
  value: unknown
): BenchlingMigrationSubscribeProgressRequest {
  const record = requireRecord(value, 'subscribeProgress request must be an object.');
  return {
    runId: parseBenchlingMigrationRunId(record.runId),
    subscriptionId: parseBenchlingMigrationSubscriptionId(record.subscriptionId),
  };
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

export type BenchlingMigrationResolveProviderReferenceRequest = {
  workspaceRoot: string;
  reference: ProviderObjectReference;
  disposition?: 'pending' | 'external' | 'source_broken';
  sourceUrl?: string | null;
  brokenReason?: string | null;
};

export type BenchlingMigrationResolveProviderReferenceResult = {
  resolution: ProviderReferenceResolution;
  target: {
    entityId: string;
    title: string;
    entityType: string;
    scope: 'workspace' | 'registry';
  } | null;
};

const RESOLVE_PROVIDER_REFERENCE_DISPOSITIONS = new Set(['pending', 'external', 'source_broken']);
const MAX_PROVIDER_REFERENCE_URL_LENGTH = 2048;
const MAX_PROVIDER_REFERENCE_REASON_LENGTH = 512;

export type BenchlingMigrationSurveyImportDestinationsRequest = {
  archivePath: string;
};

export type BenchlingMigrationImportDestinationCandidateView = {
  workspaceDbId: number;
  workspaceName: string;
  repoUuid: string | null;
  overlapCount: number;
  busy?: boolean;
};

export type BenchlingMigrationImportDestinationSurveyView = {
  registryTables?: readonly RegistryTableReviewCandidate[];

  preparedArchivePath: string;

  sourceDisplayName: string;
  archiveObjectCount: number;
  candidates: readonly BenchlingMigrationImportDestinationCandidateView[];
};

export function parseBenchlingMigrationSurveyImportDestinationsRequest(
  value: unknown
): BenchlingMigrationSurveyImportDestinationsRequest {
  const record = requireRecord(value, 'surveyImportDestinations request must be an object.');
  for (const key of Object.keys(record)) {
    if (key !== 'archivePath') {
      throw new Error(`surveyImportDestinations request has an unsupported field: ${key}`);
    }
  }
  if (typeof record.archivePath !== 'string' || record.archivePath.trim() === '') {
    throw new Error('surveyImportDestinations request requires an archive path.');
  }
  return { archivePath: record.archivePath };
}

export function parseBenchlingMigrationResolveProviderReferenceRequest(
  value: unknown
): BenchlingMigrationResolveProviderReferenceRequest {
  const record = requireRecord(value, 'resolveProviderReference request must be an object.');
  const allowedKeys = new Set([
    'workspaceRoot',
    'reference',
    'disposition',
    'sourceUrl',
    'brokenReason',
  ]);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`resolveProviderReference request has an unsupported field: ${key}`);
    }
  }
  if (typeof record.workspaceRoot !== 'string' || record.workspaceRoot.trim() === '') {
    throw new Error('resolveProviderReference request requires a workspace root.');
  }

  const reference = parseProviderObjectReference(record.reference);
  if (!reference) {
    throw new Error('resolveProviderReference request requires a valid provider reference.');
  }
  if (
    record.disposition !== undefined &&
    (typeof record.disposition !== 'string' ||
      !RESOLVE_PROVIDER_REFERENCE_DISPOSITIONS.has(record.disposition))
  ) {
    throw new Error('resolveProviderReference disposition is unsupported.');
  }
  if (
    record.sourceUrl !== undefined &&
    record.sourceUrl !== null &&
    (typeof record.sourceUrl !== 'string' ||
      record.sourceUrl.length > MAX_PROVIDER_REFERENCE_URL_LENGTH)
  ) {
    throw new Error('resolveProviderReference source URL is invalid.');
  }
  if (
    record.brokenReason !== undefined &&
    record.brokenReason !== null &&
    (typeof record.brokenReason !== 'string' ||
      record.brokenReason.length > MAX_PROVIDER_REFERENCE_REASON_LENGTH)
  ) {
    throw new Error('resolveProviderReference broken reason is invalid.');
  }
  return {
    workspaceRoot: record.workspaceRoot,
    reference,
    ...(record.disposition
      ? {
          disposition: record.disposition as 'pending' | 'external' | 'source_broken',
        }
      : {}),
    ...(record.sourceUrl === undefined ? {} : { sourceUrl: record.sourceUrl as string | null }),
    ...(record.brokenReason === undefined
      ? {}
      : { brokenReason: record.brokenReason as string | null }),
  };
}
