import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  ensureOrgRegistryState,
  requireOrgRegistryAccessGeneration,
  finishOrgRegistrySnapshotCache,
  orgRegistryRecordId,
  ORG_REGISTRY_SNAPSHOT_RECORDS,
  type CacheRecordType,
} from './org-registry-sync-cache';

export const REGISTRY_SNAPSHOT_PAGE_BYTES = 2 * 1024 * 1024;
export const REGISTRY_SNAPSHOT_PAGE_RECORDS = 500;
export interface OrganizationRegistrySnapshotPage {
  format: 'paged-v2';
  orgId: string;
  accessGeneration: string;
  snapshotId: string;
  cursor: number;
  totalRecords: number;
  expiresAt: number;
  after: number;
  nextAfter: number;
  hasMore: boolean;
  records: Array<{
    ordinal: number;
    recordType: CacheRecordType;
    recordId: string;
    payload: Record<string, unknown>;
  }>;
}
export interface RegistrySnapshotTransfer {
  accessGeneration: string | null;
  clientId: string;
  snapshotId: string | null;
  cursor: number | null;
  totalRecords: number | null;
  nextAfter: number;
  expiresAt: number | null;
  downloadComplete: boolean;
  bootstrapComplete: boolean;
}
interface Context {
  orgId: string;
  accountId: string;
  clientId: string;
}
export function readRegistrySnapshotTransfer(
  db: Database.Database,
  input: Pick<Context, 'orgId' | 'accountId'>
): RegistrySnapshotTransfer | null {
  const row = db
    .prepare(
      `SELECT client_id AS clientId,snapshot_id AS snapshotId,
    access_generation AS accessGeneration,cursor,total_records AS totalRecords,next_after AS nextAfter,expires_at AS expiresAt,
    download_complete AS downloadComplete,bootstrap_complete AS bootstrapComplete
    FROM org_registry_snapshot_transfer WHERE org_id=? AND account_id=?`
    )
    .get(input.orgId, input.accountId) as
    | (Omit<RegistrySnapshotTransfer, 'downloadComplete' | 'bootstrapComplete'> & {
        downloadComplete: number;
        bootstrapComplete: number;
      })
    | undefined;
  return row
    ? {
        ...row,
        downloadComplete: row.downloadComplete === 1,
        bootstrapComplete: row.bootstrapComplete === 1,
      }
    : null;
}
export function beginRegistrySnapshotTransfer(
  db: Database.Database,
  input: Context & { now: number }
): RegistrySnapshotTransfer {
  const snapshotId = randomUUID();
  db.transaction(() => {
    ensureOrgRegistryState(db, input.orgId, input.accountId, input.clientId, input.now);
    db.prepare(`DELETE FROM org_registry_snapshot_transfer WHERE org_id=? AND account_id=?`).run(
      input.orgId,
      input.accountId
    );
    db.prepare(
      `INSERT INTO org_registry_snapshot_transfer(org_id,account_id,client_id,snapshot_id)
      VALUES(?,?,?,?)`
    ).run(input.orgId, input.accountId, input.clientId, snapshotId);
  })();
  return readRegistrySnapshotTransfer(db, input)!;
}

export function stageRegistrySnapshotPage(
  db: Database.Database,
  input: Context & { page: OrganizationRegistrySnapshotPage; now: number }
): void {
  const state = readRegistrySnapshotTransfer(db, input);
  const page = input.page;
  requireOrgRegistryAccessGeneration(page.accessGeneration);
  const count = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;
  if (
    !state ||
    state.clientId !== input.clientId ||
    !state.snapshotId ||
    (state.accessGeneration !== null && state.accessGeneration !== page.accessGeneration) ||
    page.format !== 'paged-v2' ||
    page.orgId !== input.orgId ||
    page.snapshotId !== state.snapshotId ||
    !count(page.cursor) ||
    !count(page.totalRecords) ||
    !count(page.expiresAt) ||
    page.expiresAt <= input.now ||
    !count(page.after) ||
    page.after !== state.nextAfter ||
    !count(page.nextAfter) ||
    page.nextAfter > page.totalRecords ||
    typeof page.hasMore !== 'boolean' ||
    page.hasMore !== page.nextAfter < page.totalRecords ||
    (state.cursor !== null && state.cursor !== page.cursor) ||
    (state.totalRecords !== null && state.totalRecords !== page.totalRecords) ||
    (state.expiresAt !== null && state.expiresAt !== page.expiresAt) ||
    !Array.isArray(page.records) ||
    page.records.length > REGISTRY_SNAPSHOT_PAGE_RECORDS ||
    page.nextAfter !== page.after + page.records.length ||
    (page.hasMore && page.records.length === 0) ||
    Buffer.byteLength(JSON.stringify(page), 'utf8') > REGISTRY_SNAPSHOT_PAGE_BYTES
  )
    throw new Error('Registry snapshot page does not match its durable transfer.');
  const records = page.records.map((record, index) => {
    if (
      record.ordinal !== page.after + index + 1 ||
      !ORG_REGISTRY_SNAPSHOT_RECORDS.some((x) => x.type === record.recordType) ||
      !record.payload ||
      typeof record.payload !== 'object' ||
      Array.isArray(record.payload) ||
      (record.payload.orgId !== undefined && record.payload.orgId !== input.orgId) ||
      orgRegistryRecordId(record.recordType, record.payload) !== record.recordId
    )
      throw new Error('Registry snapshot record has a mismatched identity or ordinal.');
    return { ...record, json: JSON.stringify(record.payload) };
  });
  db.transaction(() => {
    const current = readRegistrySnapshotTransfer(db, input);
    if (
      current?.snapshotId !== page.snapshotId ||
      current.nextAfter !== page.after ||
      current.accessGeneration !== state.accessGeneration
    )
      throw new Error('Registry snapshot transfer changed before its page was stored.');
    const insert = db.prepare(`INSERT INTO org_registry_snapshot_record
      (org_id,account_id,ordinal,record_type,record_id,payload_json) VALUES(?,?,?,?,?,?)`);
    for (const record of records)
      insert.run(
        input.orgId,
        input.accountId,
        record.ordinal,
        record.recordType,
        record.recordId,
        record.json
      );
    db.prepare(
      `UPDATE org_registry_snapshot_transfer SET cursor=?,access_generation=?,total_records=?,
      next_after=?,expires_at=?,download_complete=? WHERE org_id=? AND account_id=?`
    ).run(
      page.cursor,
      page.accessGeneration,
      page.totalRecords,
      page.nextAfter,
      page.expiresAt,
      page.hasMore ? 0 : 1,
      input.orgId,
      input.accountId
    );
  })();
}
export function promoteRegistrySnapshot(
  db: Database.Database,
  input: Context & { snapshotId: string; accessGeneration: string; now: number }
): void {
  db.transaction(() => {
    const state = readRegistrySnapshotTransfer(db, input);
    const rows = db
      .prepare(
        `SELECT count(*) AS count FROM org_registry_snapshot_record
      WHERE org_id=? AND account_id=?`
      )
      .get(input.orgId, input.accountId) as { count: number };
    if (
      !state ||
      state.clientId !== input.clientId ||
      state.snapshotId !== input.snapshotId ||
      !state.accessGeneration ||
      state.accessGeneration !== input.accessGeneration ||
      !state.downloadComplete ||
      state.cursor === null ||
      state.totalRecords === null ||
      state.nextAfter !== state.totalRecords ||
      rows.count !== state.totalRecords
    )
      throw new Error('Registry snapshot cannot publish an incomplete transfer.');
    db.prepare(`DELETE FROM org_registry_cache WHERE org_id=? AND account_id=?`).run(
      input.orgId,
      input.accountId
    );
    db.prepare(
      `INSERT INTO org_registry_cache
      (org_id,account_id,record_type,record_id,payload_json,event_seq,updated_at)
      SELECT org_id,account_id,record_type,record_id,payload_json,?,?
      FROM org_registry_snapshot_record WHERE org_id=? AND account_id=?`
    ).run(state.cursor, input.now, input.orgId, input.accountId);
    finishOrgRegistrySnapshotCache(db, { ...input, cursor: state.cursor });
  })();
}
