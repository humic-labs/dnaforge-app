import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { OptionalTelemetryOrigin } from '../../shared/analytics-types';
import type { CommittedOptionalAnalyticsReceipt } from '../analytics-outbox';
import {
  isValidationReportV2,
  type LocalNativeFolderZipInventory,
  type LinkedItemRecoveryProgress,
  type LinkedItemRecoveryState,
  type MigrationIssue,
  type MigrationIssueCode,
  type MigrationRun,
  type ValidationReport,
} from '../../shared/benchling-migration';

type LinkedItemRecoveryTelemetryFailure = Readonly<{
  code:
    | Extract<
        MigrationIssueCode,
        'source_unavailable' | 'unsafe_archive' | 'projection_failed' | 'validation_failed'
      >
    | 'copy_failed'
    | 'decode_failed'
    | 'target_mismatch'
    | 'internal';
}>;

type LinkedItemRecoveryTelemetryAttempt = Readonly<
  Pick<LinkedItemRecoveryProgress, 'state' | 'recoveredUniqueObjectCount'> & {
    selectedFileCount: number;
    fileResults: readonly Readonly<{
      outcome: 'accepted' | 'duplicate' | 'rejected';
      failure: LinkedItemRecoveryTelemetryFailure | null;
    }>[];
    resumeState: Exclude<LinkedItemRecoveryState, 'completed' | 'failed'> | null;
    safeFailure: LinkedItemRecoveryTelemetryFailure | null;
  }
>;

export const BENCHLING_MIGRATION_TELEMETRY_RECEIPT_VERSION = 1 as const;
export const BENCHLING_MIGRATION_TELEMETRY_COUNT_MAX = 10_000 as const;
const OVERFLOW_SENTINEL = BENCHLING_MIGRATION_TELEMETRY_COUNT_MAX + 1;
const TELEMETRY_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const BENCHLING_MIGRATION_OPERATIONS = [
  'initial_import',
  'linked_item_recovery',
  'workspace_append',
] as const;
export type BenchlingMigrationOperation = (typeof BENCHLING_MIGRATION_OPERATIONS)[number];

export const BENCHLING_MIGRATION_SOURCE_KINDS = [
  'benchling_export_zip',
  'benchling_export_html',
  'legacy_provider_capture',
] as const;
export type BenchlingMigrationSourceKind = (typeof BENCHLING_MIGRATION_SOURCE_KINDS)[number];

export interface BenchlingMigrationTelemetry {
  captureOrigin(): OptionalTelemetryOrigin | null;
  publish<Properties extends object>(
    readCommitted: () => CommittedOptionalAnalyticsReceipt<Properties> | null
  ): boolean;
}

const acceptanceSchema = z
  .object({
    schema: z.literal('dnaforge.benchling.telemetry-acceptance.v1'),
    attemptId: z.string().uuid(),
    startedEventId: z.string().uuid(),
    parentAttemptId: z.string().uuid().nullable(),
    operation: z.enum(BENCHLING_MIGRATION_OPERATIONS),
    sourceKind: z.enum(BENCHLING_MIGRATION_SOURCE_KINDS),
    scopeKind: z.enum(['file', 'folder', 'folder_tree']),
    startedAt: z.string().datetime({ offset: true }),
    origin: z
      .object({
        consentScope: z.string().uuid(),
        contextId: z.string().uuid(),
        processId: z.string().uuid(),
        classification: z.enum(['synthetic', 'private', 'unknown', 'eligible_release']),
      })
      .strict()
      .nullable(),
  })
  .strict();

export type BenchlingMigrationTelemetryAcceptance = z.infer<typeof acceptanceSchema>;

export function createBenchlingMigrationTelemetryAcceptance(input: {
  identity: BenchlingMigrationAttemptIdentity;
  run: MigrationRun;
  origin: OptionalTelemetryOrigin | null;
  parentAttemptId: string | null;
}): BenchlingMigrationTelemetryAcceptance {
  return acceptanceSchema.parse({
    schema: 'dnaforge.benchling.telemetry-acceptance.v1',
    attemptId: input.identity.attemptId,
    startedEventId: randomUUID(),
    parentAttemptId: input.parentAttemptId,
    operation: input.identity.operation,
    sourceKind:
      input.identity.operation === 'initial_import'
        ? sourceKind(input.run, null)
        : 'benchling_export_zip',
    scopeKind: input.run.scope.kind,
    startedAt: input.identity.startedAt,
    origin: input.origin,
  });
}

export function parseBenchlingMigrationTelemetryAcceptance(
  bodyJson: string
): BenchlingMigrationTelemetryAcceptance {
  return acceptanceSchema.parse(JSON.parse(bodyJson));
}

export const BENCHLING_MIGRATION_TERMINAL_STAGES = [
  'intake',
  'scope',
  'capture',
  'parsing',
  'resolution',
  'projection',
  'validation',
  'finalization',
  'recovery',
  'unknown',
] as const;
export type BenchlingMigrationTerminalStage = (typeof BENCHLING_MIGRATION_TERMINAL_STAGES)[number];

export type BenchlingMigrationOutcome =
  | 'succeeded'
  | 'failed'
  | 'cancelled_preserved'
  | 'needs_action';

export type BenchlingMigrationTelemetryIssueCode =
  | MigrationIssueCode
  | 'copy_failed'
  | 'decode_failed'
  | 'target_mismatch';

export type BenchlingMigrationIssueReceipt = Readonly<{
  eventId: string;
  code: BenchlingMigrationTelemetryIssueCode;
  blocking: boolean;
  count: number;
}>;

export type BenchlingMigrationAttemptIdentity = Readonly<{
  schema: 'dnaforge.benchling.telemetry-attempt.v1';
  attemptId: string;
  terminalEventId: string;
  runId: string;
  sourceAttemptReference: string;
  attemptSequence: number;
  operation: BenchlingMigrationOperation;
  startedAt: string;
}>;

export type BenchlingMigrationAttemptReceiptIdentity = Readonly<
  Omit<BenchlingMigrationAttemptIdentity, 'runId' | 'sourceAttemptReference'>
>;

export type BenchlingMigrationAttemptTerminalReceipt = Readonly<{
  schema: 'dnaforge.benchling.telemetry-terminal.v1';
  identity: BenchlingMigrationAttemptReceiptIdentity;
  sourceKind: BenchlingMigrationSourceKind;
  scopeKind: MigrationRun['scope']['kind'];
  outcome: BenchlingMigrationOutcome;
  usableResult: boolean;
  terminalStage: BenchlingMigrationTerminalStage;
  terminalAt: string;
  durationBucket: 'lt_1s' | '1_5s' | '5_30s' | '30s_plus' | 'unknown';
  counts: Readonly<{
    sourceObject: number;
    importedObject: number;
    skippedObject: number;
    attachment: number;
    resolvedRelationship: number;
    unresolvedRelationship: number;
    ambiguousRelationship: number;
    brokenRelationship: number;
    supportedFormula: number;
    unsupportedFormula: number;
    staleFormula: number;
    projectionException: number;
    blockingIssue: number;
  }>;
  primaryIssueCode: BenchlingMigrationTelemetryIssueCode | 'none';
  countOverflow: boolean;
  issues: readonly BenchlingMigrationIssueReceipt[];
}>;

export type BenchlingMigrationAttemptFinishedProperties = Readonly<{
  feature_area: 'import';
  $insert_id: string;
  operation: BenchlingMigrationOperation;
  source_kind: BenchlingMigrationSourceKind;
  scope_kind: MigrationRun['scope']['kind'];
  outcome: BenchlingMigrationOutcome;
  usable_result: boolean;
  terminal_stage: BenchlingMigrationTerminalStage;
  duration_bucket: BenchlingMigrationAttemptTerminalReceipt['durationBucket'];
  source_object_count: number;
  imported_object_count: number;
  skipped_object_count: number;
  attachment_count: number;
  resolved_relationship_count: number;
  unresolved_relationship_count: number;
  ambiguous_relationship_count: number;
  broken_relationship_count: number;
  supported_formula_count: number;
  unsupported_formula_count: number;
  stale_formula_count: number;
  projection_exception_count: number;
  blocking_issue_count: number;
  primary_issue_code: BenchlingMigrationAttemptTerminalReceipt['primaryIssueCode'];
  count_overflow: boolean;
}>;

export type BenchlingMigrationIssueSummaryProperties = Readonly<{
  feature_area: 'import';
  $insert_id: string;
  attempt_correlation_id: string;
  operation: BenchlingMigrationOperation;
  stage: BenchlingMigrationTerminalStage;
  issue_code: BenchlingMigrationTelemetryIssueCode;
  blocking: boolean;
  count: number;
}>;

export function createBenchlingMigrationAttemptIdentity(input: {
  runId: string;
  sourceAttemptReference: string;
  attemptSequence: number;
  operation: BenchlingMigrationOperation;
  startedAt: string;
  uuid?: () => string;
}): BenchlingMigrationAttemptIdentity {
  const uuid = input.uuid ?? randomUUID;
  const attemptId = uuid();
  const terminalEventId = uuid();
  if (!TELEMETRY_UUID_RE.test(attemptId) || !TELEMETRY_UUID_RE.test(terminalEventId)) {
    throw new Error('Benchling telemetry IDs must be UUIDs.');
  }
  return Object.freeze({
    schema: 'dnaforge.benchling.telemetry-attempt.v1',
    attemptId,
    terminalEventId,
    runId: input.runId,
    sourceAttemptReference: input.sourceAttemptReference,
    attemptSequence: input.attemptSequence,
    operation: input.operation,
    startedAt: input.startedAt,
  });
}

export function projectBenchlingMigrationTerminal(input: {
  identity: BenchlingMigrationAttemptIdentity;
  run: MigrationRun;
  outcome: BenchlingMigrationOutcome;
  terminalStage: BenchlingMigrationTerminalStage;
  terminalAt: string;
  report: ValidationReport | null;
  inventory?: LocalNativeFolderZipInventory | null;
  linkedAttempt?: LinkedItemRecoveryTelemetryAttempt | null;
  uuid?: () => string;
}): BenchlingMigrationAttemptTerminalReceipt {
  if (input.identity.runId !== input.run.id) {
    throw new Error('Benchling telemetry attempt does not match its migration run.');
  }
  const report = input.report;
  if (report && report.runId !== input.run.id) {
    throw new Error('Benchling telemetry report does not match its migration run.');
  }
  const inventory = input.inventory ?? nativeInventory(report);
  const rawCounts = projectCounts(report, inventory, input.linkedAttempt ?? null);
  const bounded = boundCounts(rawCounts);
  const issues = projectIssues(input.run, report, input.linkedAttempt ?? null, input.uuid);
  const blockingIssueCount = issues
    .filter((issue) => issue.blocking)
    .reduce((total, issue) => total + issue.count, 0);
  const boundedBlocking = boundOne(blockingIssueCount);
  const issueCountOverflow = issues.some(
    (issue) => issue.count > BENCHLING_MIGRATION_TELEMETRY_COUNT_MAX
  );
  const importedObjectCount = bounded.counts.importedObject;
  return Object.freeze({
    schema: 'dnaforge.benchling.telemetry-terminal.v1',
    identity: benchlingMigrationAttemptReceiptIdentity(input.identity),
    sourceKind: sourceKind(input.run, input.linkedAttempt ?? null),
    scopeKind: input.run.scope.kind,
    outcome: input.outcome,
    usableResult:
      importedObjectCount > 0 &&
      report !== null &&
      (input.outcome === 'succeeded' || input.outcome === 'needs_action'),
    terminalStage: input.terminalStage,
    terminalAt: input.terminalAt,
    durationBucket: durationBucket(input.identity.startedAt, input.terminalAt),
    counts: Object.freeze({ ...bounded.counts, blockingIssue: boundedBlocking.value }),
    primaryIssueCode: issues.find((issue) => issue.blocking)?.code ?? issues[0]?.code ?? 'none',
    countOverflow: bounded.overflow || boundedBlocking.overflow || issueCountOverflow,
    issues: Object.freeze(issues),
  });
}

export function benchlingMigrationAttemptReceiptIdentity(
  identity: BenchlingMigrationAttemptIdentity
): BenchlingMigrationAttemptReceiptIdentity {
  return Object.freeze({
    schema: identity.schema,
    attemptId: identity.attemptId,
    terminalEventId: identity.terminalEventId,
    attemptSequence: identity.attemptSequence,
    operation: identity.operation,
    startedAt: identity.startedAt,
  });
}

export function benchlingMigrationAttemptFinishedProperties(
  receipt: BenchlingMigrationAttemptTerminalReceipt
): BenchlingMigrationAttemptFinishedProperties {
  return Object.freeze({
    feature_area: 'import',
    $insert_id: receipt.identity.terminalEventId,
    operation: receipt.identity.operation,
    source_kind: receipt.sourceKind,
    scope_kind: receipt.scopeKind,
    outcome: receipt.outcome,
    usable_result: receipt.usableResult,
    terminal_stage: receipt.terminalStage,
    duration_bucket: receipt.durationBucket,
    source_object_count: receipt.counts.sourceObject,
    imported_object_count: receipt.counts.importedObject,
    skipped_object_count: receipt.counts.skippedObject,
    attachment_count: receipt.counts.attachment,
    resolved_relationship_count: receipt.counts.resolvedRelationship,
    unresolved_relationship_count: receipt.counts.unresolvedRelationship,
    ambiguous_relationship_count: receipt.counts.ambiguousRelationship,
    broken_relationship_count: receipt.counts.brokenRelationship,
    supported_formula_count: receipt.counts.supportedFormula,
    unsupported_formula_count: receipt.counts.unsupportedFormula,
    stale_formula_count: receipt.counts.staleFormula,
    projection_exception_count: receipt.counts.projectionException,
    blocking_issue_count: receipt.counts.blockingIssue,
    primary_issue_code: receipt.primaryIssueCode,
    count_overflow: receipt.countOverflow,
  });
}

export function benchlingMigrationIssueSummaryProperties(
  receipt: BenchlingMigrationAttemptTerminalReceipt
): BenchlingMigrationIssueSummaryProperties[] {
  return receipt.issues.map((issue) =>
    Object.freeze({
      feature_area: 'import',
      $insert_id: issue.eventId,
      attempt_correlation_id: receipt.identity.attemptId,
      operation: receipt.identity.operation,
      stage: receipt.terminalStage,
      issue_code: issue.code,
      blocking: issue.blocking,
      count: boundOne(issue.count).value,
    })
  );
}

export function terminalStageForRunState(
  state: MigrationRun['state'] | null | undefined
): BenchlingMigrationTerminalStage {
  switch (state) {
    case 'draft':
    case 'identity_confirmation':
      return 'intake';
    case 'scope_planning':
    case 'export_pending':
      return 'scope';
    case 'downloading':
      return 'capture';
    case 'parsing':
      return 'parsing';
    case 'offline_resolution':
    case 'targeted_reads':
      return 'resolution';
    case 'projecting':
      return 'projection';
    case 'validating':
    case 'ready_to_unlock':
      return 'validation';
    case 'unlocked':
      return 'finalization';
    case 'paused':
    case 'cancelled_preserved':
      return 'recovery';
    default:
      return 'unknown';
  }
}

export function terminalOutcomeForRun(run: MigrationRun): BenchlingMigrationOutcome | null {
  if (run.state === 'unlocked') return 'succeeded';
  if (run.state === 'failed') return 'failed';
  if (run.state === 'cancelled_preserved') return 'cancelled_preserved';
  if (run.state === 'action_required') return 'needs_action';
  return null;
}

export function terminalOutcomeForLinkedAttempt(
  attempt: LinkedItemRecoveryTelemetryAttempt
): BenchlingMigrationOutcome | null {
  if (attempt.state === 'failed') return 'failed';
  if (attempt.state !== 'completed') return null;
  const rejected = attempt.fileResults.filter((result) => result.outcome === 'rejected').length;
  if (rejected === 0) return 'succeeded';
  return rejected === attempt.selectedFileCount ? 'failed' : 'needs_action';
}

export function terminalStageForLinkedAttempt(
  state:
    | LinkedItemRecoveryTelemetryAttempt['state']
    | LinkedItemRecoveryTelemetryAttempt['resumeState']
): BenchlingMigrationTerminalStage {
  switch (state) {
    case 'copying':
      return 'intake';
    case 'parsing':
      return 'parsing';
    case 'awaiting_conflict_resolution':
    case 'reconciling':
      return 'resolution';
    case 'validating':
      return 'validation';
    case 'completed':
      return 'finalization';
    default:
      return 'unknown';
  }
}

function sourceKind(
  run: MigrationRun,
  linkedAttempt: LinkedItemRecoveryTelemetryAttempt | null
): BenchlingMigrationSourceKind {
  if (linkedAttempt) return 'benchling_export_zip';
  if (
    run.externalZipSource ||
    run.localExportIntake?.format === 'zip' ||
    run.localExportArtifact?.format === 'zip'
  ) {
    return 'benchling_export_zip';
  }
  if (run.localExportIntake?.format === 'html' || run.localExportArtifact?.format === 'html') {
    return 'benchling_export_html';
  }
  return 'legacy_provider_capture';
}

function nativeInventory(report: ValidationReport | null): LocalNativeFolderZipInventory | null {
  return report && isValidationReportV2(report)
    ? (report.localExport?.evidence.nativeFolderZipInventory ?? null)
    : null;
}

function projectCounts(
  report: ValidationReport | null,
  inventory: LocalNativeFolderZipInventory | null,
  linkedAttempt: LinkedItemRecoveryTelemetryAttempt | null
): Omit<BenchlingMigrationAttemptTerminalReceipt['counts'], 'blockingIssue'> {
  const relationship = report?.relationships.countsByClass;
  const imported =
    linkedAttempt?.recoveredUniqueObjectCount ??
    inventory?.canonicalObjects.importedTotal ??
    report?.projections.actual ??
    0;
  const source = inventory?.canonicalObjects.selectedTotal ?? report?.sourceObjects.actual ?? 0;
  const skipped = inventory
    ? inventory.canonicalObjects.skipped.length
    : Math.max(0, source - imported);
  return {
    sourceObject: source,
    importedObject: imported,
    skippedObject: skipped,
    attachment: inventory?.selectedAttachments.total ?? report?.attachments.actual ?? 0,
    resolvedRelationship: (relationship?.exact ?? 0) + (relationship?.heuristic ?? 0),
    unresolvedRelationship: (relationship?.unresolved ?? 0) + (relationship?.external ?? 0),
    ambiguousRelationship: relationship?.ambiguous ?? 0,
    brokenRelationship: relationship?.source_broken ?? 0,
    supportedFormula: report && isValidationReportV2(report) ? report.formulas.supported : 0,
    unsupportedFormula: report && isValidationReportV2(report) ? report.formulas.unsupported : 0,
    staleFormula: report && isValidationReportV2(report) ? report.formulas.stale : 0,
    projectionException:
      report && isValidationReportV2(report)
        ? report.nativeConversionExceptions.actual
        : (report?.projections.exceptions ?? 0),
  };
}

function projectIssues(
  run: MigrationRun,
  report: ValidationReport | null,
  linkedAttempt: LinkedItemRecoveryTelemetryAttempt | null,
  uuid: (() => string) | undefined
): BenchlingMigrationIssueReceipt[] {
  const issueInputs: Array<{ code: BenchlingMigrationTelemetryIssueCode; blocking: boolean }> = [];
  for (const issue of report?.issues ?? []) issueInputs.push(migrationIssueInput(issue));
  if (run.lastError) {
    const runIssue = migrationIssueInput(run.lastError);
    if (!issueInputs.some((issue) => sameIssueClass(issue, runIssue))) issueInputs.push(runIssue);
  }
  for (const result of linkedAttempt?.fileResults ?? []) {
    if (result.outcome === 'rejected' && result.failure) {
      issueInputs.push(linkedFailureInput(result.failure));
    }
  }
  if (linkedAttempt?.safeFailure) {
    const linkedIssue = linkedFailureInput(linkedAttempt.safeFailure);
    if (!issueInputs.some((issue) => sameIssueClass(issue, linkedIssue)))
      issueInputs.push(linkedIssue);
  }
  const grouped = new Map<
    string,
    { code: BenchlingMigrationTelemetryIssueCode; blocking: boolean; count: number }
  >();
  for (const issue of issueInputs) {
    const key = `${issue.code}:${issue.blocking ? 'blocking' : 'nonblocking'}`;
    const current = grouped.get(key);
    grouped.set(key, { ...issue, count: (current?.count ?? 0) + 1 });
  }
  const makeUuid = uuid ?? randomUUID;
  return [...grouped.values()]
    .sort(
      (left, right) =>
        Number(right.blocking) - Number(left.blocking) || left.code.localeCompare(right.code)
    )
    .map((issue) => {
      const eventId = makeUuid();
      if (!TELEMETRY_UUID_RE.test(eventId)) {
        throw new Error('Benchling telemetry issue event IDs must be UUIDs.');
      }
      return Object.freeze({ eventId, ...issue });
    });
}

function sameIssueClass(
  left: { code: BenchlingMigrationTelemetryIssueCode; blocking: boolean },
  right: { code: BenchlingMigrationTelemetryIssueCode; blocking: boolean }
): boolean {
  return left.code === right.code && left.blocking === right.blocking;
}

function migrationIssueInput(issue: MigrationIssue): {
  code: MigrationIssueCode;
  blocking: boolean;
} {
  return { code: issue.code, blocking: issue.blocking };
}

function linkedFailureInput(failure: LinkedItemRecoveryTelemetryFailure): {
  code: BenchlingMigrationTelemetryIssueCode;
  blocking: boolean;
} {
  const code: BenchlingMigrationTelemetryIssueCode =
    failure.code === 'internal'
      ? 'internal_invariant'
      : failure.code === 'validation_failed'
        ? 'validation_failed'
        : failure.code === 'projection_failed'
          ? 'projection_failed'
          : failure.code;
  return { code, blocking: true };
}

function durationBucket(
  startedAt: string,
  terminalAt: string
): BenchlingMigrationAttemptTerminalReceipt['durationBucket'] {
  const duration = Date.parse(terminalAt) - Date.parse(startedAt);
  if (!Number.isFinite(duration) || duration < 0) return 'unknown';
  if (duration < 1_000) return 'lt_1s';
  if (duration < 5_000) return '1_5s';
  if (duration < 30_000) return '5_30s';
  return '30s_plus';
}

function boundCounts(
  counts: Omit<BenchlingMigrationAttemptTerminalReceipt['counts'], 'blockingIssue'>
): {
  counts: Omit<BenchlingMigrationAttemptTerminalReceipt['counts'], 'blockingIssue'>;
  overflow: boolean;
} {
  let overflow = false;
  const entries = Object.entries(counts).map(([key, value]) => {
    const bounded = boundOne(value);
    overflow ||= bounded.overflow;
    return [key, bounded.value];
  });
  return {
    counts: Object.fromEntries(entries) as Omit<
      BenchlingMigrationAttemptTerminalReceipt['counts'],
      'blockingIssue'
    >,
    overflow,
  };
}

function boundOne(value: number): { value: number; overflow: boolean } {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Benchling telemetry count must be a non-negative safe integer.');
  }
  return value > BENCHLING_MIGRATION_TELEMETRY_COUNT_MAX
    ? { value: OVERFLOW_SENTINEL, overflow: true }
    : { value, overflow: false };
}
