import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type Database from 'better-sqlite3';

import type { LimsAuditRow } from '../shared/lims';
import { SHARE_LINEAGE_RELATIVE_PATH } from '../shared/share-lineage';
import { computeLimsAuditHash, LIMS_LOCAL_CLIENT_ID } from './lims-engine-core';
import { verifyLimsAuditHashChainRows } from './lims-projection-rebuild';

const MAX_LEGACY_LIMS_LOG_BYTES = 16 * 1024 * 1024;
const MAX_LEGACY_LIMS_MANIFEST_BYTES = 64 * 1024;
const MAX_SHARE_LINEAGE_BYTES = 64 * 1024;
const MAX_LEGACY_LIMS_SCAN_BYTES = 32 * 1024 * 1024;
const LEGACY_LIMS_REASON = 'historical_workspace_restore_activated_installation_global_lims';
const LIMS_AUDIT_INTEGRITY_REASON = 'lims_audit_hash_chain_invalid';
const LIMS_AUDIT_WORKSPACE_PROVENANCE_AMBIGUOUS_REASON =
  'lims_audit_workspace_provenance_ambiguous';

export const LIMS_SAFETY_QUARANTINED_ERROR_CODE = 'LIMS_SAFETY_QUARANTINED';

export type LimsSafetyEvidenceKind = 'cloud_restore' | 'share_import' | 'audit_integrity';

export interface LimsSafetyQuarantineState {
  status: 'quarantined';
  reason: string;
  evidenceKind: LimsSafetyEvidenceKind;
  evidenceWorkspaceId: number;
  detectedAt: number;
}

export interface LimsSafetyUnresolvedState {
  status: 'unresolved';
  pendingCandidateCount: number;
  reason?: string;
}

export type LimsSafetyAccessState = LimsSafetyQuarantineState | LimsSafetyUnresolvedState;

export interface LimsSafetyUserMessage {
  summary: string;
  detail: string;
}

interface QuarantineRow {
  status: 'quarantined' | 'resolved';
  reason: string;
  evidence_kind: LimsSafetyEvidenceKind;
  evidence_workspace_id: number;
  detected_at: number;
}

interface LegacyScanCandidateRow {
  workspace_id: number;
  path: string | null;
  restore_activation_at: number | null;
}

interface LegacyActivationEvidence {
  evidenceKind: Extract<LimsSafetyEvidenceKind, 'cloud_restore' | 'share_import'>;
  activatedAtMs: number;
}

interface StoredAuditIdentity {
  id: string;
  event_seq: number;
  idempotency_key: string | null;
  workspace_id: number | null;
  hash: string | null;
}

type StoredAuditRow = LimsAuditRow;

interface StoredAuditIndexes {
  byId: Map<string, StoredAuditIdentity>;
  byIdempotencyKey: Map<string, StoredAuditIdentity>;
  byEventSeq: Map<number, StoredAuditIdentity>;
  workspaceIds: Set<number>;
}

interface ScanBudget {
  remainingBytes: number;
}

interface LegacyExportEvent {
  eventId: string;
  eventSeq: number;
  schemaVersion: number;
  idempotencyKey: string;
  operationId: string | null;
  eventType: string;
  actorClientId: string | null;
  actorUserId: string | null;
  actorLegacy: string | null;
  createdAtMs: number;
  subjectType: string | null;
  subjectId: string | null;
  batchId: string | null;
  workspaceId: number | null;
  before: unknown;
  after: unknown;
  payload: unknown;
  hash: string | null;
}

interface RestoredAuditIdentity {
  id: string;
  eventSeq: number;
  idempotencyKey: string;
  workspaceId: number | null;
  hash: string | null;
  sourceWorkspaceWasRemapped: boolean;
}

type CandidateScanResult =
  | { kind: 'defer' }
  | { kind: 'clear' }
  | {
      kind: 'contaminated';
      evidenceKind: LimsSafetyEvidenceKind;
      matchedEventId: string;
      matchedEventSeq: number;
    };

type PathState = 'missing' | 'unsafe' | 'directory' | 'file';

export class LimsSafetyQuarantinedError extends Error {
  readonly code = LIMS_SAFETY_QUARANTINED_ERROR_CODE;

  constructor(state: LimsSafetyAccessState) {
    const message = describeLimsSafetyAccessState(state);
    super(`${message.summary} ${message.detail}`);
    this.name = 'LimsSafetyQuarantinedError';
  }
}

export function describeLimsSafetyAccessState(state: LimsSafetyAccessState): LimsSafetyUserMessage {
  if (
    state.status === 'quarantined' &&
    (state.evidenceKind === 'cloud_restore' || state.evidenceKind === 'share_import')
  ) {
    return {
      summary:
        'DNAForge found registry data that an older cloud or shared-project restore activated globally on this installation.',
      detail:
        'LIMS reads and writes are blocked to prevent further mixing. The database and project files were preserved for a future repair; all other DNAForge features remain available.',
    };
  }
  if (state.status === 'quarantined') {
    return {
      summary:
        'DNAForge found that the LIMS audit chain no longer matches its stored integrity hashes. This is not proof that cloud or shared-project data was imported.',
      detail:
        'LIMS reads and writes are blocked to prevent further changes. The database was preserved for a future repair; all other DNAForge features remain available.',
    };
  }
  if (state.reason === LIMS_AUDIT_WORKSPACE_PROVENANCE_AMBIGUOUS_REASON) {
    return {
      summary:
        'DNAForge found older LIMS audit data whose project identity was removed. This can follow an ordinary project deletion and is not proof that cloud data was imported.',
      detail:
        'LIMS reads and writes are blocked until that state can be reviewed. No registry data was removed; all other DNAForge features remain available.',
    };
  }
  return {
    summary:
      'DNAForge could not finish checking one or more older projects for a historical registry-import problem.',
    detail:
      'LIMS reads and writes are blocked until that check can finish. No registry data was removed; all other DNAForge features remain available.',
  };
}

export function readLimsSafetyQuarantineState(
  db: Database.Database
): LimsSafetyQuarantineState | null {
  const row = db
    .prepare(
      `SELECT status, reason, evidence_kind, evidence_workspace_id, detected_at
       FROM lims_safety_quarantine
       WHERE id = 1`
    )
    .get() as QuarantineRow | undefined;
  if (!row || row.status !== 'quarantined') return null;
  return {
    status: 'quarantined',
    reason: row.reason,
    evidenceKind: row.evidence_kind,
    evidenceWorkspaceId: row.evidence_workspace_id,
    detectedAt: row.detected_at,
  };
}

export function readLimsSafetyAccessState(db: Database.Database): LimsSafetyAccessState | null {
  const quarantine = readLimsSafetyQuarantineState(db);
  if (quarantine) return quarantine;
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM lims_safety_legacy_scan_candidates`)
    .get() as { count: number };
  const scanState = db
    .prepare(
      `SELECT status, unresolved_reason
       FROM lims_safety_legacy_scan_state
       WHERE id = 1`
    )
    .get() as { status: 'pending' | 'completed'; unresolved_reason: string | null } | undefined;
  if (row.count === 0 && scanState?.status !== 'pending') return null;
  return {
    status: 'unresolved',
    pendingCandidateCount: Math.max(row.count, 1),
    ...(scanState?.unresolved_reason ? { reason: scanState.unresolved_reason } : {}),
  };
}

export function assertLimsSafetyNotQuarantined(db: Database.Database): void {
  const state = readLimsSafetyAccessState(db);
  if (state) {
    throw new LimsSafetyQuarantinedError(state);
  }
}

export function reconcileLegacyLimsSafetyQuarantine(
  db: Database.Database,
  nowMs = Date.now(),
  maxScanBytes = MAX_LEGACY_LIMS_SCAN_BYTES
): LimsSafetyAccessState | null {
  const existing = readLimsSafetyQuarantineState(db);
  if (existing) return existing;

  const scanState = db
    .prepare(
      `SELECT status, last_workspace_id, unresolved_reason
       FROM lims_safety_legacy_scan_state
       WHERE id = 1`
    )
    .get() as
    | {
        status: 'pending' | 'completed';
        last_workspace_id: number;
        unresolved_reason: string | null;
      }
    | undefined;
  if (scanState?.status === 'completed') return null;
  if (scanState?.unresolved_reason) {
    if (scanState.unresolved_reason !== LIMS_AUDIT_WORKSPACE_PROVENANCE_AMBIGUOUS_REASON) {
      return readLimsSafetyAccessState(db);
    }
    db.prepare(
      `UPDATE lims_safety_legacy_scan_state
       SET unresolved_reason = NULL,
           unresolved_evidence_json = NULL,
           unresolved_detected_at = NULL
       WHERE id = 1`
    ).run();
  }

  const auditRows = loadStoredAuditRows(db);
  const auditHealth = verifyLimsAuditHashChainRows(auditRows);
  if (!auditHealth.ok) {
    if (!isAmbiguousWorkspaceDeletionHashFailure(auditRows, auditHealth.failures)) {
      const firstFailure = auditHealth.failures[0];
      persistQuarantine(db, {
        reason: LIMS_AUDIT_INTEGRITY_REASON,
        evidenceKind: 'audit_integrity',
        evidenceWorkspaceId: 0,
        evidenceJson: JSON.stringify({
          checkedEvents: auditHealth.checkedEvents,
          failureCount: auditHealth.failures.length,
          firstFailure,
        }),
        nowMs,
      });
      return readLimsSafetyQuarantineState(db);
    }
  }

  const auditIndexes = buildStoredAuditIndexes(auditRows);

  const candidatesById = db
    .prepare(
      `SELECT c.workspace_id, w.path,
              (
                SELECT MAX(COALESCE(rl.completed_at, rl.started_at))
                FROM workspace_sync_restore_locks rl
                WHERE rl.workspace_id = c.workspace_id
              ) AS restore_activation_at
       FROM lims_safety_legacy_scan_candidates c
       LEFT JOIN workspaces w ON w.id = c.workspace_id
       ORDER BY c.workspace_id ASC`
    )
    .all() as LegacyScanCandidateRow[];
  const cursor = scanState?.last_workspace_id ?? 0;
  const firstAfterCursor = candidatesById.findIndex((candidate) => candidate.workspace_id > cursor);
  const candidates =
    firstAfterCursor <= 0
      ? candidatesById
      : [...candidatesById.slice(firstAfterCursor), ...candidatesById.slice(0, firstAfterCursor)];

  const budget: ScanBudget = { remainingBytes: Math.max(0, maxScanBytes) };
  for (const candidate of candidates) {
    if (budget.remainingBytes === 0) break;
    if (!candidate.path || pathState(candidate.path) !== 'directory') {
      advanceLegacyScanCursor(db, candidate.workspace_id);
      if (candidate.restore_activation_at === null) {
        clearLegacyScanCandidate(db, candidate.workspace_id);
      }
      continue;
    }
    const result = scanLegacyCandidate(candidate, auditIndexes, budget);
    advanceLegacyScanCursor(db, candidate.workspace_id);
    if (result.kind === 'defer') continue;
    if (result.kind === 'clear') {
      clearLegacyScanCandidate(db, candidate.workspace_id);
      continue;
    }

    const evidenceJson = JSON.stringify({
      matchedEventId: result.matchedEventId,
      matchedEventSeq: result.matchedEventSeq,
    });
    persistQuarantine(db, {
      reason: LEGACY_LIMS_REASON,
      evidenceKind: result.evidenceKind,
      evidenceWorkspaceId: candidate.workspace_id,
      evidenceJson,
      nowMs,
    });
    return readLimsSafetyQuarantineState(db);
  }

  const remaining = db
    .prepare(`SELECT COUNT(*) AS count FROM lims_safety_legacy_scan_candidates`)
    .get() as { count: number };
  if (remaining.count === 0) {
    db.prepare(
      `UPDATE lims_safety_legacy_scan_state
       SET status = 'completed', completed_at = ?
       WHERE id = 1 AND status = 'pending'`
    ).run(nowMs);
  }
  return readLimsSafetyAccessState(db);
}

function persistQuarantine(
  db: Database.Database,
  input: {
    reason: string;
    evidenceKind: LimsSafetyEvidenceKind;
    evidenceWorkspaceId: number;
    evidenceJson: string;
    nowMs: number;
  }
): void {
  db.prepare(
    `INSERT INTO lims_safety_quarantine (
       id, status, reason, evidence_kind, evidence_workspace_id,
       evidence_json, detected_at, resolved_at
     ) VALUES (1, 'quarantined', ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(id) DO UPDATE SET
       status = 'quarantined',
       reason = excluded.reason,
       evidence_kind = excluded.evidence_kind,
       evidence_workspace_id = excluded.evidence_workspace_id,
       evidence_json = excluded.evidence_json,
       detected_at = excluded.detected_at,
       resolved_at = NULL`
  ).run(
    input.reason,
    input.evidenceKind,
    input.evidenceWorkspaceId,
    input.evidenceJson,
    input.nowMs
  );
}

function isAmbiguousWorkspaceDeletionHashFailure(
  auditRows: readonly StoredAuditRow[],
  failures: ReadonlyArray<{
    auditId: string;
    eventSeq: number;
    reason: 'missing_hash' | 'prev_hash_mismatch' | 'hash_mismatch';
  }>
): boolean {
  if (failures.length === 0) return false;
  const byId = new Map(auditRows.map((row) => [row.id, row]));
  return failures.every(
    (failure) =>
      failure.reason === 'hash_mismatch' && byId.get(failure.auditId)?.workspace_id === null
  );
}

function loadStoredAuditRows(db: Database.Database): StoredAuditRow[] {
  return db.prepare(`SELECT * FROM lims_audit ORDER BY event_seq ASC`).all() as StoredAuditRow[];
}

function buildStoredAuditIndexes(rows: readonly StoredAuditRow[]): StoredAuditIndexes {
  const byId = new Map<string, StoredAuditIdentity>();
  const byIdempotencyKey = new Map<string, StoredAuditIdentity>();
  const byEventSeq = new Map<number, StoredAuditIdentity>();
  const workspaceIds = new Set<number>();

  for (const row of rows) {
    byId.set(row.id, row);
    byIdempotencyKey.set(row.idempotency_key ?? `lims:v0:${row.id}`, row);
    byEventSeq.set(row.event_seq, row);
    if (isPositiveSafeInteger(row.workspace_id)) workspaceIds.add(row.workspace_id);
    collectWorkspaceIdsFromJson(row.before, workspaceIds);
    collectWorkspaceIdsFromJson(row.after, workspaceIds);
    collectWorkspaceIdsFromJson(row.payload, workspaceIds);
  }
  return { byId, byIdempotencyKey, byEventSeq, workspaceIds };
}

function collectWorkspaceIdsFromJson(raw: string | null, output: Set<number>): void {
  if (raw === null) return;
  let root: unknown;
  try {
    root = JSON.parse(raw) as unknown;
  } catch {
    return;
  }
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    if (!isRecord(current)) continue;
    for (const [key, nested] of Object.entries(current)) {
      if ((key === 'workspaceId' || key === 'workspace_id') && isPositiveSafeInteger(nested)) {
        output.add(nested);
      } else if (typeof nested === 'object' && nested !== null) {
        pending.push(nested);
      }
    }
  }
}

function scanLegacyCandidate(
  candidate: LegacyScanCandidateRow,
  auditIndexes: StoredAuditIndexes,
  budget: ScanBudget
): CandidateScanResult {
  const workspacePath = candidate.path;
  if (workspacePath === null || pathState(workspacePath) !== 'directory') {
    return { kind: 'defer' };
  }

  const lineagePath = join(workspacePath, ...SHARE_LINEAGE_RELATIVE_PATH.split('/'));
  const lineageState = pathStateThroughParents(
    workspacePath,
    SHARE_LINEAGE_RELATIVE_PATH.split('/')
  );
  const hasShareLineage = lineageState === 'file';
  if (lineageState === 'unsafe' || lineageState === 'directory') return { kind: 'defer' };

  const activationEvidence: LegacyActivationEvidence[] = [];
  let hasAmbiguousActivationEvidence = false;
  if (candidate.restore_activation_at !== null) {
    if (!isNonnegativeSafeInteger(candidate.restore_activation_at)) return { kind: 'defer' };
    activationEvidence.push({
      evidenceKind: 'cloud_restore',
      activatedAtMs: candidate.restore_activation_at,
    });
  }
  if (hasShareLineage) {
    const importedAtMs = readShareImportActivationAt(lineagePath, budget);
    if (importedAtMs === null) {
      hasAmbiguousActivationEvidence = true;
    } else {
      activationEvidence.push({ evidenceKind: 'share_import', activatedAtMs: importedAtMs });
    }
  }
  if (activationEvidence.length === 0 && !hasAmbiguousActivationEvidence) {
    return { kind: 'clear' };
  }

  const logDir = join(workspacePath, '.waypoint', 'lims', 'log');
  const logDirState = pathStateThroughParents(workspacePath, ['.waypoint', 'lims', 'log']);
  if (logDirState === 'missing') {
    return hasExactZeroEventManifest(workspacePath, budget) ? { kind: 'clear' } : { kind: 'defer' };
  }
  if (logDirState !== 'directory') return { kind: 'defer' };

  const events = readLegacyExportEvents(logDir, budget);
  if (events === null) return { kind: 'defer' };
  if (events.length === 0) {
    return hasExactZeroEventManifest(workspacePath, budget) ? { kind: 'clear' } : { kind: 'defer' };
  }

  let hasIncompleteEvidence = hasAmbiguousActivationEvidence;
  for (const evidence of activationEvidence) {
    const eventsPresentWhenActivated = events.filter(
      (event) => event.createdAtMs <= evidence.activatedAtMs
    );
    if (eventsPresentWhenActivated.length !== events.length) {
      hasIncompleteEvidence = true;
    }
    if (eventsPresentWhenActivated.length === 0) continue;
    const result = classifyHistoricalRestore(
      reproduceHistoricalRestoreIdentities(eventsPresentWhenActivated, candidate.workspace_id),
      auditIndexes,
      evidence.evidenceKind
    );
    if (result.kind === 'contaminated') return result;
    if (result.kind === 'defer') hasIncompleteEvidence = true;
  }
  return hasIncompleteEvidence ? { kind: 'defer' } : { kind: 'clear' };
}

function readShareImportActivationAt(lineagePath: string, budget: ScanBudget): number | null {
  let stats;
  try {
    stats = lstatSync(lineagePath);
  } catch {
    return null;
  }
  if (
    stats.isSymbolicLink() ||
    !stats.isFile() ||
    stats.size > MAX_SHARE_LINEAGE_BYTES ||
    stats.size > budget.remainingBytes
  ) {
    return null;
  }
  budget.remainingBytes -= stats.size;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(lineagePath, 'utf8')) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !isNonEmptyString(parsed.importedAt)) {
    return null;
  }
  const importedAtMs = Date.parse(parsed.importedAt);
  return isNonnegativeSafeInteger(importedAtMs) ? importedAtMs : null;
}

function hasExactZeroEventManifest(workspacePath: string, budget: ScanBudget): boolean {
  const manifestSegments = ['.waypoint', 'lims', 'manifest.json'] as const;
  if (pathStateThroughParents(workspacePath, manifestSegments) !== 'file') return false;

  const manifestPath = join(workspacePath, ...manifestSegments);
  let stats;
  try {
    stats = lstatSync(manifestPath);
  } catch {
    return false;
  }
  if (
    stats.isSymbolicLink() ||
    !stats.isFile() ||
    stats.size > MAX_LEGACY_LIMS_MANIFEST_BYTES ||
    stats.size > budget.remainingBytes
  ) {
    return false;
  }
  budget.remainingBytes -= stats.size;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
  } catch {
    return false;
  }
  if (!isRecord(parsed)) return false;
  const keys = Object.keys(parsed).sort();
  return (
    keys.length === 3 &&
    keys[0] === 'exportedThroughEventSeq' &&
    keys[1] === 'updatedAt' &&
    keys[2] === 'version' &&
    parsed.version === 1 &&
    parsed.exportedThroughEventSeq === 0 &&
    typeof parsed.updatedAt === 'string'
  );
}

function classifyHistoricalRestore(
  identities: readonly RestoredAuditIdentity[],
  auditIndexes: StoredAuditIndexes,
  evidenceKind: LimsSafetyEvidenceKind
): CandidateScanResult {
  const eventIds = new Set<string>();
  const eventSeqs = new Set<number>();
  const idempotencyKeys = new Set<string>();
  for (const identity of identities) {
    if (
      eventIds.has(identity.id) ||
      eventSeqs.has(identity.eventSeq) ||
      idempotencyKeys.has(identity.idempotencyKey)
    ) {
      return { kind: 'clear' };
    }
    eventIds.add(identity.id);
    eventSeqs.add(identity.eventSeq);
    idempotencyKeys.add(identity.idempotencyKey);
  }

  let remappedMatch: RestoredAuditIdentity | null = null;
  let incomplete = false;
  for (const identity of identities) {
    const stored = auditIndexes.byIdempotencyKey.get(identity.idempotencyKey);
    if (!stored) {
      if (auditIndexes.byId.has(identity.id) || auditIndexes.byEventSeq.has(identity.eventSeq)) {
        return { kind: 'clear' };
      }
      incomplete = true;
      continue;
    }
    const importerWouldAcceptDuplicate =
      stored.event_seq === identity.eventSeq &&
      stored.id === identity.id &&
      stored.hash === identity.hash;
    if (!importerWouldAcceptDuplicate) return { kind: 'clear' };
    const detectorIdentityMatches =
      stored.workspace_id === identity.workspaceId &&
      (stored.idempotency_key ?? `lims:v0:${stored.id}`) === identity.idempotencyKey;
    if (!detectorIdentityMatches) {
      incomplete = true;
      continue;
    }
    if (identity.sourceWorkspaceWasRemapped && remappedMatch === null) {
      remappedMatch = identity;
    }
  }

  if (incomplete) return { kind: 'defer' };
  return remappedMatch
    ? {
        kind: 'contaminated',
        evidenceKind,
        matchedEventId: remappedMatch.id,
        matchedEventSeq: remappedMatch.eventSeq,
      }
    : { kind: 'defer' };
}

function reproduceHistoricalRestoreIdentities(
  events: readonly LegacyExportEvent[],
  targetWorkspaceId: number
): RestoredAuditIdentity[] {
  let previousHash: string | null = null;
  return [...events]
    .sort((left, right) => left.eventSeq - right.eventSeq)
    .map((event) => {
      const workspaceId = event.workspaceId === null ? null : targetWorkspaceId;
      const actorLegacy = event.actorLegacy ?? event.actorUserId;
      const actorClientId = event.actorClientId ?? LIMS_LOCAL_CLIENT_ID;
      const actorUserId = event.actorUserId ?? actorLegacy;
      let hash = event.hash;
      if (event.schemaVersion >= 1) {
        hash = computeLimsAuditHash({
          id: event.eventId,
          event_seq: event.eventSeq,
          schema_version: event.schemaVersion,
          idempotency_key: event.idempotencyKey,
          operation_id: event.operationId,
          event_type: event.eventType,
          subject_table: event.subjectType,
          subject_id: event.subjectId,
          batch_id: event.batchId,
          actor: actorLegacy,
          actor_client_id: actorClientId,
          actor_user_id: actorUserId,
          workspace_id: workspaceId,
          before: remapWorkspaceIdInValue(event.before, targetWorkspaceId),
          after: remapWorkspaceIdInValue(event.after, targetWorkspaceId),
          payload: remapWorkspaceIdInValue(event.payload, targetWorkspaceId),
          prev_hash: previousHash,
          tombstone: 0,
          created_at: event.createdAtMs,
        });
      }
      previousHash = hash ?? previousHash;
      return {
        id: event.eventId,
        eventSeq: event.eventSeq,
        idempotencyKey: event.idempotencyKey,
        workspaceId,
        hash,
        sourceWorkspaceWasRemapped:
          event.workspaceId !== null ||
          containsRemappableWorkspaceId(event.before) ||
          containsRemappableWorkspaceId(event.after) ||
          containsRemappableWorkspaceId(event.payload),
      };
    });
}

function readLegacyExportEvents(logDir: string, budget: ScanBudget): LegacyExportEvent[] | null {
  let names: string[];
  try {
    names = readdirSync(logDir)
      .filter((name) => name.endsWith('.jsonl'))
      .sort();
  } catch {
    return null;
  }

  const events: LegacyExportEvent[] = [];
  let totalBytes = 0;
  for (const name of names) {
    const path = join(logDir, name);
    let stats;
    try {
      stats = lstatSync(path);
    } catch {
      return null;
    }
    if (stats.isSymbolicLink() || !stats.isFile()) return null;
    totalBytes += stats.size;
    if (totalBytes > MAX_LEGACY_LIMS_LOG_BYTES) return null;
    if (stats.size > budget.remainingBytes) {
      budget.remainingBytes = 0;
      return null;
    }
    budget.remainingBytes -= stats.size;

    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      return null;
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let json: unknown;
      try {
        json = JSON.parse(line) as unknown;
      } catch {
        return null;
      }
      const event = parseLegacyExportEvent(json);
      if (!event) return null;
      events.push(event);
    }
  }
  return events;
}

function parseLegacyExportEvent(value: unknown): LegacyExportEvent | null {
  if (!isRecord(value) || value.schema !== 'waypoint.lims.event.v1') return null;
  if (
    !isNonEmptyString(value.eventId) ||
    !isPositiveSafeInteger(value.eventSeq) ||
    !isNonnegativeSafeInteger(value.schemaVersion) ||
    !isNonEmptyString(value.idempotencyKey) ||
    !isNonEmptyString(value.eventType)
  ) {
    return null;
  }
  const actor = isRecord(value.actor) ? value.actor : {};
  const createdAtMs: unknown =
    typeof value.createdAtMs === 'number' && Number.isFinite(value.createdAtMs)
      ? value.createdAtMs
      : typeof value.createdAt === 'string'
        ? Date.parse(value.createdAt)
        : null;
  if (!isNonnegativeSafeInteger(createdAtMs)) return null;
  const workspaceId = value.workspaceId;
  if (workspaceId !== null && !isSafeInteger(workspaceId)) return null;

  return {
    eventId: value.eventId,
    eventSeq: value.eventSeq,
    schemaVersion: value.schemaVersion,
    idempotencyKey: value.idempotencyKey,
    operationId: nullableString(value.operationId),
    eventType: value.eventType,
    actorClientId: nullableString(actor.clientId),
    actorUserId: nullableString(actor.userId),
    actorLegacy: nullableString(actor.legacy),
    createdAtMs,
    subjectType: nullableString(value.subjectType),
    subjectId: nullableString(value.subjectId),
    batchId: nullableString(value.batchId),
    workspaceId,
    before: value.before ?? null,
    after: value.after ?? null,
    payload: value.payload ?? null,
    hash: nullableString(value.hash),
  };
}

function remapWorkspaceIdInValue(value: unknown, targetWorkspaceId: number): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => remapWorkspaceIdInValue(entry, targetWorkspaceId));
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      (key === 'workspaceId' || key === 'workspace_id') && isSafeInteger(nested)
        ? targetWorkspaceId
        : remapWorkspaceIdInValue(nested, targetWorkspaceId),
    ])
  );
}

function containsRemappableWorkspaceId(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsRemappableWorkspaceId);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([key, nested]) =>
      ((key === 'workspaceId' || key === 'workspace_id') && isSafeInteger(nested)) ||
      containsRemappableWorkspaceId(nested)
  );
}

function pathStateThroughParents(root: string, segments: readonly string[]): PathState {
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]);
    const state = pathState(current);
    if (state === 'missing' || state === 'unsafe') return state;
    if (index < segments.length - 1 && state !== 'directory') return 'unsafe';
    if (index === segments.length - 1) return state;
  }
  return 'unsafe';
}

function pathState(path: string): PathState {
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) return 'unsafe';
    if (stats.isDirectory()) return 'directory';
    if (stats.isFile()) return 'file';
    return 'unsafe';
  } catch (error) {
    return isMissingPathError(error) ? 'missing' : 'unsafe';
  }
}

function isMissingPathError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

function clearLegacyScanCandidate(db: Database.Database, workspaceId: number): void {
  db.prepare(`DELETE FROM lims_safety_legacy_scan_candidates WHERE workspace_id = ?`).run(
    workspaceId
  );
}

function advanceLegacyScanCursor(db: Database.Database, workspaceId: number): void {
  db.prepare(
    `UPDATE lims_safety_legacy_scan_state
     SET last_workspace_id = ?
     WHERE id = 1 AND status = 'pending'`
  ).run(workspaceId);
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isSafeInteger(value) && value > 0;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
