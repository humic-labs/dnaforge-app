import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { ANALYTICS_CONSENT_VERSION } from '@waypoint/analytics-policy';
import { getAnalyticsOutboxEvent, type OptionalTelemetryOrigin } from './analytics-outbox';
import {
  captureOptionalTelemetryOrigin,
  enqueueOptionalAnalyticsEvent,
  enqueueOptionalAnalyticsEventFromReceipt,
} from './analytics';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const UPDATE_BOOT_ID = randomUUID();

type TerminalOutcome = 'succeeded' | 'failed' | 'cancelled';
export interface UpdateInstallMeasurement {
  operationId: string;
  terminalEventId: string;
  launchEventId?: string;
  originBootId: string;
  consentEpoch: number | null;

  telemetryOrigin?: OptionalTelemetryOrigin;
  parentRequestId?: string;
  parentAttemptId?: string;
  downloadOperationId?: string;
  terminal?: { outcome: TerminalOutcome; occurredAtMs: number; code: string; bootId?: string };
}

function consentEpoch(database?: Database.Database): number | null {
  try {
    const rows = database
      ?.prepare('SELECT key, value, updated_at FROM settings WHERE key IN (?, ?)')
      .all('analytics_consent', 'analytics_consent_version') as
      | { key: string; value: string; updated_at: number }[]
      | undefined;
    const consent = rows?.find((row) => row.key === 'analytics_consent');
    const version = rows?.find((row) => row.key === 'analytics_consent_version');
    return consent?.value === 'true' &&
      version?.value === String(ANALYTICS_CONSENT_VERSION) &&
      Number.isSafeInteger(consent.updated_at)
      ? consent.updated_at
      : null;
  } catch {
    return null;
  }
}

export function createUpdateInstallMeasurement(
  database?: Database.Database,
  parentRequestId?: string,
  parentAttemptId?: string,
  downloadOperationId?: string
): UpdateInstallMeasurement {
  const telemetryOrigin = currentTelemetryOrigin();
  return {
    operationId: randomUUID(),
    terminalEventId: randomUUID(),
    launchEventId: randomUUID(),
    originBootId: UPDATE_BOOT_ID,
    consentEpoch: consentEpoch(database),
    ...(telemetryOrigin ? { telemetryOrigin } : {}),
    ...(parentRequestId ? { parentRequestId } : {}),
    ...(parentAttemptId ? { parentAttemptId } : {}),
    ...(isUpdateDownloadMeasurementPermitted(database, downloadOperationId)
      ? { downloadOperationId }
      : {}),
  };
}

export function isUpdateDownloadMeasurementPermitted(
  database: Database.Database | undefined,
  operationId: string | undefined
): boolean {
  const epoch = consentEpoch(database);
  if (!database || epoch === null || !operationId || !UUID.test(operationId)) return false;
  try {
    const row = getAnalyticsOutboxEvent(database, operationId);
    return Boolean(
      row &&
      row.referenceKind === 'updater_operation' &&
      row.referenceId === `${operationId}:${epoch}` &&
      ['app_update_available', 'app_update_download_started', 'app_update_downloaded'].includes(
        row.eventName
      ) &&
      currentOriginMatches(row.authority?.origin)
    );
  } catch {
    return false;
  }
}

export function recordUpdateDownloadMeasurement(
  database: Database.Database | undefined,
  eventName: 'app_update_available' | 'app_update_download_started' | 'app_update_downloaded',
  properties: { operation_id: string; occurred_at_ms: number; [key: string]: unknown },
  { requireExistingAuthority = false }: { requireExistingAuthority?: boolean } = {}
): boolean {
  const epoch = consentEpoch(database);
  const origin = currentTelemetryOrigin();
  if (!database || epoch === null || !origin) return false;
  if (
    requireExistingAuthority &&
    !isUpdateDownloadMeasurementPermitted(database, properties.operation_id)
  ) {
    return false;
  }
  const eventId = requireExistingAuthority ? randomUUID() : properties.operation_id;
  try {
    return enqueueOptionalAnalyticsEvent<Record<string, unknown>>(origin, {
      eventId,
      eventName,
      payloadSchemaVersion: 1,
      referenceKind: 'updater_operation',

      referenceId: `${properties.operation_id}:${epoch}`,
      createdAtMs: properties.occurred_at_ms,
      properties:
        eventName === 'app_update_available'
          ? { version: properties.version, $insert_id: eventId }
          : { ...properties, $insert_id: eventId },
    });
  } catch {
    console.warn('[AutoUpdater] Download measurement persistence unavailable.');
    return false;
  }
}

function parseTelemetryOrigin(value: unknown): OptionalTelemetryOrigin | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).some(
      (key) => !['consentScope', 'contextId', 'processId', 'classification'].includes(key)
    ) ||
    ![row.consentScope, row.contextId, row.processId].every(
      (id) => typeof id === 'string' && UUID.test(id)
    ) ||
    typeof row.classification !== 'string' ||
    !['synthetic', 'private', 'unknown', 'eligible_release'].includes(row.classification)
  )
    return undefined;
  return {
    consentScope: row.consentScope as string,
    contextId: row.contextId as string,
    processId: row.processId as string,
    classification: row.classification as OptionalTelemetryOrigin['classification'],
  };
}

function currentTelemetryOrigin(): OptionalTelemetryOrigin | null {
  try {
    return captureOptionalTelemetryOrigin();
  } catch {
    return null;
  }
}

function currentOriginMatches(origin: OptionalTelemetryOrigin | undefined): boolean {
  const current = currentTelemetryOrigin();
  return Boolean(
    origin &&
    current &&
    origin.consentScope === current.consentScope &&
    origin.contextId === current.contextId &&
    origin.classification === current.classification
  );
}

export function parseUpdateInstallMeasurement(
  value: unknown
): UpdateInstallMeasurement | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  if (
    typeof row.operationId !== 'string' ||
    !UUID.test(row.operationId) ||
    typeof row.terminalEventId !== 'string' ||
    !UUID.test(row.terminalEventId) ||
    (row.launchEventId !== undefined &&
      (typeof row.launchEventId !== 'string' || !UUID.test(row.launchEventId))) ||
    typeof row.originBootId !== 'string' ||
    !UUID.test(row.originBootId) ||
    (row.consentEpoch !== null &&
      (typeof row.consentEpoch !== 'number' ||
        !Number.isSafeInteger(row.consentEpoch) ||
        row.consentEpoch < 0)) ||
    (row.parentRequestId !== undefined &&
      (typeof row.parentRequestId !== 'string' || !UUID.test(row.parentRequestId))) ||
    (row.downloadOperationId !== undefined &&
      (typeof row.downloadOperationId !== 'string' || !UUID.test(row.downloadOperationId))) ||
    (row.parentAttemptId !== undefined &&
      (typeof row.parentAttemptId !== 'string' || !UUID.test(row.parentAttemptId)))
  )
    return undefined;
  const telemetryOrigin = parseTelemetryOrigin(row.telemetryOrigin);
  if (row.telemetryOrigin !== undefined && !telemetryOrigin) return undefined;
  let terminal: UpdateInstallMeasurement['terminal'];
  if (row.terminal !== undefined) {
    if (!row.terminal || typeof row.terminal !== 'object') return undefined;
    const t = row.terminal as Record<string, unknown>;
    if (
      (t.outcome !== 'succeeded' && t.outcome !== 'failed' && t.outcome !== 'cancelled') ||
      typeof t.occurredAtMs !== 'number' ||
      !Number.isSafeInteger(t.occurredAtMs) ||
      t.occurredAtMs < 0 ||
      (t.bootId !== undefined && (typeof t.bootId !== 'string' || !UUID.test(t.bootId))) ||
      typeof t.code !== 'string' ||
      ![
        'version_advanced',
        'same_version_relaunch',
        'shutdown_failed',
        'native_install_failed',
        'quit_cancelled',
      ].includes(t.code)
    )
      return undefined;
    terminal = {
      outcome: t.outcome,
      occurredAtMs: t.occurredAtMs,
      code: t.code,
      ...(typeof t.bootId === 'string' ? { bootId: t.bootId } : {}),
    };
  }
  return {
    operationId: row.operationId,
    terminalEventId: row.terminalEventId,
    ...(typeof row.launchEventId === 'string' ? { launchEventId: row.launchEventId } : {}),
    originBootId: row.originBootId,
    consentEpoch: row.consentEpoch,
    ...(telemetryOrigin ? { telemetryOrigin } : {}),
    ...(typeof row.parentRequestId === 'string' ? { parentRequestId: row.parentRequestId } : {}),
    ...(typeof row.parentAttemptId === 'string' ? { parentAttemptId: row.parentAttemptId } : {}),
    ...(typeof row.downloadOperationId === 'string'
      ? { downloadOperationId: row.downloadOperationId }
      : {}),
    ...(terminal ? { terminal } : {}),
  };
}

function hasMeasuredInstallOrigin(
  database: Database.Database,
  measurement: UpdateInstallMeasurement
): boolean {
  if (
    measurement.consentEpoch === null ||
    consentEpoch(database) !== measurement.consentEpoch ||
    !measurement.telemetryOrigin
  )
    return false;
  try {
    const row = getAnalyticsOutboxEvent(database, measurement.operationId);
    return Boolean(
      row &&
      row.eventName === 'app_update_install_attempt' &&
      row.referenceKind === 'updater_operation' &&
      row.referenceId === measurement.operationId &&
      row.authority &&
      JSON.stringify(row.authority.origin) === JSON.stringify(measurement.telemetryOrigin)
    );
  } catch {
    return false;
  }
}

export function isUpdateInstallMeasurementPermitted(
  database: Database.Database | undefined,
  measurement: UpdateInstallMeasurement | undefined
): boolean {
  return Boolean(
    database &&
    measurement &&
    currentOriginMatches(measurement.telemetryOrigin) &&
    hasMeasuredInstallOrigin(database, measurement)
  );
}

export interface UpdateInstallMeasurementReceipt {
  fromVersion: string;
  targetVersion: string;
  attemptedAt: number;
  measurement?: UpdateInstallMeasurement;
}

const PENDING_INSTALL_TELEMETRY = '_update_install_telemetry_receipt_v1:';

function normalizedReceipt(
  value: UpdateInstallMeasurementReceipt
): UpdateInstallMeasurementReceipt {
  return {
    fromVersion: value.fromVersion,
    targetVersion: value.targetVersion,
    attemptedAt: value.attemptedAt,
    measurement: parseUpdateInstallMeasurement(value.measurement),
  };
}

function readPendingInstallTelemetry(
  database: Database.Database,
  operationId: string
): UpdateInstallMeasurementReceipt | null {
  try {
    const row = database
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(`${PENDING_INSTALL_TELEMETRY}${operationId}`) as { value: string } | undefined;
    if (!row) return null;
    const value: unknown = JSON.parse(row.value);
    if (!value || typeof value !== 'object') return null;
    const receipt = value as UpdateInstallMeasurementReceipt;
    if (
      typeof receipt.fromVersion !== 'string' ||
      !receipt.fromVersion ||
      typeof receipt.targetVersion !== 'string' ||
      !receipt.targetVersion ||
      !Number.isSafeInteger(receipt.attemptedAt) ||
      receipt.attemptedAt <= 0
    )
      return null;
    const normalized = normalizedReceipt(receipt);
    return normalized.measurement?.terminal &&
      normalized.measurement.telemetryOrigin &&
      normalized.measurement.operationId === operationId
      ? normalized
      : null;
  } catch {
    return null;
  }
}

function retainPendingInstallTelemetry(
  database: Database.Database,
  receipt: UpdateInstallMeasurementReceipt
): boolean {
  try {
    const operationId = receipt.measurement!.operationId;
    const existing = readPendingInstallTelemetry(database, operationId);
    const serialized = JSON.stringify(normalizedReceipt(receipt));
    if (existing?.measurement?.operationId === receipt.measurement?.operationId)
      return JSON.stringify(existing) === serialized;
    database
      .prepare('INSERT OR IGNORE INTO settings (key,value,updated_at) VALUES (?,?,?)')
      .run(`${PENDING_INSTALL_TELEMETRY}${operationId}`, serialized, Date.now());
    const retained = readPendingInstallTelemetry(database, operationId);
    if (!retained || JSON.stringify(retained) !== serialized) return false;
    return true;
  } catch {
    return false;
  }
}

export function reconcileUpdateInstallTelemetryReceipt(database: Database.Database): void {
  try {
    const rows = database
      .prepare('SELECT key FROM settings WHERE substr(key,1,?) = ? ORDER BY updated_at,key')
      .all(PENDING_INSTALL_TELEMETRY.length, PENDING_INSTALL_TELEMETRY) as { key: string }[];
    for (const row of rows) {
      const operationId = row.key.slice(PENDING_INSTALL_TELEMETRY.length);
      if (!UUID.test(operationId)) continue;
      const receipt = readPendingInstallTelemetry(database, operationId);
      if (receipt)
        recordUpdateInstallMeasurement(database, receipt, false, () =>
          readPendingInstallTelemetry(database, operationId)
        );
    }
  } catch (ignoredError) {
    void ignoredError;
  }
}

export function recordUpdateInstallMeasurement(
  database: Database.Database | undefined,
  input: UpdateInstallMeasurementReceipt,
  acceptedNow = false,
  readCommittedIntent?: () => UpdateInstallMeasurementReceipt | null
): void {
  const m = input.measurement;
  if (
    !database ||
    !m ||
    !readCommittedIntent ||
    !m.telemetryOrigin ||
    m.consentEpoch === null ||
    consentEpoch(database) !== m.consentEpoch
  )
    return;
  if (!acceptedNow && !hasMeasuredInstallOrigin(database, m)) return;
  try {
    const readExact = (): UpdateInstallMeasurementReceipt | null => {
      const persisted = readCommittedIntent();
      if (
        !persisted ||
        JSON.stringify(normalizedReceipt(persisted)) !== JSON.stringify(normalizedReceipt(input))
      )
        return null;
      return normalizedReceipt(persisted);
    };
    const committed = readExact();
    if (!committed) return;

    if (
      m.terminal &&
      (!hasMeasuredInstallOrigin(database, m) ||
        !retainPendingInstallTelemetry(database, committed))
    )
      return;
    if (!currentOriginMatches(m.telemetryOrigin)) return;
    const put = (terminal: boolean): boolean => {
      const t = terminal ? m.terminal : undefined;
      const occurredAtMs = t?.occurredAtMs ?? input.attemptedAt;
      const eventId = terminal ? m.terminalEventId : m.operationId;
      return enqueueOptionalAnalyticsEventFromReceipt(() => {
        const persisted = readExact();
        const original = persisted?.measurement;

        if (
          !original?.telemetryOrigin ||
          !currentOriginMatches(original.telemetryOrigin) ||
          consentEpoch(database) !== original.consentEpoch ||
          (!acceptedNow && !hasMeasuredInstallOrigin(database, original))
        )
          return null;
        return {
          origin: original.telemetryOrigin,
          event: {
            eventId,
            eventName: 'app_update_install_attempt',
            payloadSchemaVersion: 1,
            referenceKind: 'updater_operation',
            referenceId: original.operationId,
            createdAtMs: occurredAtMs,
            properties: {
              $insert_id: eventId,
              feature_area: 'reliability',
              operation_id: original.operationId,
              origin_boot_id: original.originBootId,
              from_version: persisted!.fromVersion,
              version: persisted!.targetVersion,
              occurred_at_ms: occurredAtMs,
              origin_started_at_ms: persisted!.attemptedAt,
              action_phase: t
                ? t.outcome === 'succeeded'
                  ? 'commit'
                  : t.outcome === 'cancelled'
                    ? 'cancel'
                    : 'error'
                : 'start',
              outcome: t?.outcome ?? 'started',
              ...(t ? { error_code: t.code } : {}),
              ...(t?.bootId ? { update_boot_id: t.bootId } : {}),
              ...(original.parentRequestId ? { parent_action_id: original.parentRequestId } : {}),
              ...(original.parentAttemptId
                ? { retry_parent_attempt_id: original.parentAttemptId }
                : {}),
              ...(isUpdateDownloadMeasurementPermitted(database, original.downloadOperationId)
                ? { download_operation_id: original.downloadOperationId }
                : {}),
            },
          },
        };
      });
    };

    if (acceptedNow) put(false);
    if (m.terminal && put(true)) {
      const pending = readPendingInstallTelemetry(database, m.operationId);
      if (pending && JSON.stringify(pending) === JSON.stringify(normalizedReceipt(input))) {
        database
          .prepare('DELETE FROM settings WHERE key = ? AND value = ?')
          .run(`${PENDING_INSTALL_TELEMETRY}${m.operationId}`, JSON.stringify(pending));
      }
    }
  } catch {
    console.warn('[AutoUpdater] Install measurement delivery remains pending.');
  }
}
