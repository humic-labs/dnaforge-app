import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  ANALYTICS_OUTBOX_PAYLOAD_SCHEMA_VERSION,
  putAnalyticsOutboxEvent,
  type CommittedOptionalAnalyticsReceipt,
  type OptionalTelemetryOrigin,
} from '../analytics-outbox';
import type { MigrationStore } from './store';
import {
  benchlingMigrationAttemptFinishedProperties,
  benchlingMigrationIssueSummaryProperties,
  type BenchlingMigrationOutcome,
  type BenchlingMigrationTelemetry,
  type BenchlingMigrationTelemetryAcceptance,
} from './telemetry';

export function reconcileBenchlingMigrationTelemetryOutbox(
  store: MigrationStore,
  globalDb: Database.Database,
  runId: string,
  telemetry?: Pick<BenchlingMigrationTelemetry, 'publish'>
): { attempts: number; issues: number } {
  if (telemetry) return publishCommittedMigrationTelemetry(store, runId, telemetry);
  let attempts = 0;
  let issues = 0;
  for (const receipt of store.listMigrationTelemetryTerminalReceipts(runId)) {
    putAnalyticsOutboxEvent(globalDb, {
      eventId: receipt.identity.terminalEventId,
      eventName: 'benchling_migration_attempt_finished',
      payloadSchemaVersion: ANALYTICS_OUTBOX_PAYLOAD_SCHEMA_VERSION,
      referenceKind: 'benchling_migration_attempt',
      referenceId: receipt.identity.attemptId,
      properties: benchlingMigrationAttemptFinishedProperties(receipt),
      createdAtMs: Date.parse(receipt.terminalAt),
    });
    attempts += 1;
    const summaries = benchlingMigrationIssueSummaryProperties(receipt);
    for (const summary of summaries) {
      putAnalyticsOutboxEvent(globalDb, {
        eventId: summary.$insert_id,
        eventName: 'benchling_migration_issue_summary',
        payloadSchemaVersion: ANALYTICS_OUTBOX_PAYLOAD_SCHEMA_VERSION,
        referenceKind: 'benchling_migration_issue',
        referenceId: `${receipt.identity.attemptId}:${summary.issue_code}:${summary.blocking ? 'blocking' : 'nonblocking'}`,
        properties: summary,
        createdAtMs: Date.parse(receipt.terminalAt),
      });
      issues += 1;
    }
  }
  return { attempts, issues };
}

function correlationProperties(
  store: MigrationStore,
  acceptance: BenchlingMigrationTelemetryAcceptance
): Record<string, string> {
  const parent = acceptance.parentAttemptId
    ? store.getMigrationTelemetryAcceptance(acceptance.parentAttemptId)
    : null;
  const sameOrigin =
    parent?.origin &&
    acceptance.origin &&
    parent.origin.consentScope === acceptance.origin.consentScope &&
    parent.origin.contextId === acceptance.origin.contextId &&
    parent.origin.classification === acceptance.origin.classification;
  return {
    attempt_correlation_id: acceptance.attemptId,
    ...(sameOrigin && parent ? { retry_parent_attempt_id: parent.attemptId } : {}),
  };
}

function readCommittedStart(
  store: MigrationStore,
  attemptId: string
): CommittedOptionalAnalyticsReceipt<Record<string, unknown>> | null {
  const acceptance = store.getMigrationTelemetryAcceptance(attemptId);
  if (!acceptance?.origin) return null;
  return {
    origin: acceptance.origin,
    event: {
      eventId: acceptance.startedEventId,
      eventName: 'benchling_migration_attempt_started',
      payloadSchemaVersion: ANALYTICS_OUTBOX_PAYLOAD_SCHEMA_VERSION,
      referenceKind: 'benchling_migration_attempt',
      referenceId: acceptance.attemptId,
      properties: {
        feature_area: 'import',
        operation: acceptance.operation,
        source_kind: acceptance.sourceKind,
        scope_kind: acceptance.scopeKind,
        ...correlationProperties(store, acceptance),
      },
      createdAtMs: Date.parse(acceptance.startedAt),
    },
  };
}

function readCommittedTerminal(
  store: MigrationStore,
  attemptId: string,
  issueEventId?: string
): CommittedOptionalAnalyticsReceipt<Record<string, unknown>> | null {
  const acceptance = store.getMigrationTelemetryAcceptance(attemptId);
  const terminal = store.getCommittedMigrationTelemetryTerminal(attemptId);
  if (!acceptance?.origin || !terminal) return null;
  if (acceptance.startedAt !== terminal.identity.startedAt) return null;
  if (issueEventId) {
    const issue = benchlingMigrationIssueSummaryProperties(terminal).find(
      (summary) => summary.$insert_id === issueEventId
    );
    if (!issue) return null;
    return {
      origin: acceptance.origin,
      event: {
        eventId: issue.$insert_id,
        eventName: 'benchling_migration_issue_summary',
        payloadSchemaVersion: ANALYTICS_OUTBOX_PAYLOAD_SCHEMA_VERSION,
        referenceKind: 'benchling_migration_issue',
        referenceId: `${attemptId}:${issue.issue_code}:${issue.blocking ? 'blocking' : 'nonblocking'}`,
        properties: { ...issue, ...correlationProperties(store, acceptance) },
        createdAtMs: Date.parse(terminal.terminalAt),
      },
    };
  }
  return {
    origin: acceptance.origin,
    event: {
      eventId: terminal.identity.terminalEventId,
      eventName: 'benchling_migration_attempt_finished',
      payloadSchemaVersion: ANALYTICS_OUTBOX_PAYLOAD_SCHEMA_VERSION,
      referenceKind: 'benchling_migration_attempt',
      referenceId: attemptId,
      properties: {
        ...benchlingMigrationAttemptFinishedProperties(terminal),
        ...correlationProperties(store, acceptance),
      },
      createdAtMs: Date.parse(terminal.terminalAt),
    },
  };
}

function publishCommittedMigrationTelemetry(
  store: MigrationStore,
  runId: string,
  telemetry: Pick<BenchlingMigrationTelemetry, 'publish'>
): { attempts: number; issues: number } {
  let attempts = 0;
  let issues = 0;
  for (const acceptance of store.listMigrationTelemetryAcceptances(runId)) {
    telemetry.publish(() => readCommittedStart(store, acceptance.attemptId));
  }
  for (const terminal of store.listMigrationTelemetryTerminalReceipts(runId)) {
    const attemptId = terminal.identity.attemptId;
    if (telemetry.publish(() => readCommittedTerminal(store, attemptId))) attempts += 1;
    for (const issue of terminal.issues) {
      if (telemetry.publish(() => readCommittedTerminal(store, attemptId, issue.eventId))) {
        issues += 1;
      }
    }
  }
  return { attempts, issues };
}

export function publishBenchlingMigrationDiscardDisposition(
  telemetry: Pick<BenchlingMigrationTelemetry, 'publish'>,
  origin: OptionalTelemetryOrigin,
  priorOutcome: BenchlingMigrationOutcome,
  committedAtMs: number
): void {
  const eventId = randomUUID();
  telemetry.publish(() => ({
    origin,
    event: {
      eventId,
      eventName: 'benchling_migration_run_disposition_changed',
      payloadSchemaVersion: ANALYTICS_OUTBOX_PAYLOAD_SCHEMA_VERSION,
      referenceKind: 'benchling_migration_disposition',
      referenceId: eventId,
      properties: {
        feature_area: 'import',
        $insert_id: eventId,
        prior_outcome: priorOutcome,
        disposition: 'discarded',
      },
      createdAtMs: committedAtMs,
    },
  }));
}
