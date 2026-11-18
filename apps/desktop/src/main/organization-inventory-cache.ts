import type Database from 'better-sqlite3';
import {
  ORGANIZATION_INVENTORY_RESPONSE_MAX_BYTES,
  ORGANIZATION_INVENTORY_RESPONSE_SCHEMA,
  organizationInventoryCanonicalJson,
  parseOrganizationInventoryResponseEnvelope,
  type InventoryOrganizationTarget,
  type OrganizationInventorySnapshotResponse,
} from '@waypoint/domain-services';
import {
  inventoryOrganizationSessionIdentitySchema,
  type InventoryOrganizationSessionIdentity,
} from '../shared/inventory-organization-client';

type Snapshot = Extract<OrganizationInventorySnapshotResponse, { kind: 'ready' }>;

export interface OrganizationInventoryProjection {
  readonly session: InventoryOrganizationSessionIdentity;
  readonly snapshot: Snapshot;
}

export function createOrganizationInventoryProjectionTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS organization_inventory_projection (
      account_id TEXT NOT NULL,
      org_id TEXT NOT NULL,
      inventory_id TEXT NOT NULL,
      desktop_session_id TEXT NOT NULL,
      known_access_token_expires_at INTEGER NOT NULL CHECK(known_access_token_expires_at >= 0),
      snapshot_text TEXT NOT NULL CHECK(length(CAST(snapshot_text AS BLOB)) <= 2097152),
      revision INTEGER NOT NULL CHECK(revision >= 0),
      state_sha256 TEXT NOT NULL,
      PRIMARY KEY(account_id, org_id, inventory_id)
    );
  `);
}

function parseSnapshot(value: unknown): Snapshot {
  const result = parseOrganizationInventoryResponseEnvelope({
    schema: ORGANIZATION_INVENTORY_RESPONSE_SCHEMA,
    purpose: 'snapshot',
    result: value,
  });
  if (result.purpose !== 'snapshot' || result.result.kind !== 'ready')
    throw new TypeError('A complete organization inventory snapshot is required.');
  return result.result;
}

export function readOrganizationInventoryProjection(
  db: Database.Database,
  accountId: string,
  target: InventoryOrganizationTarget
): OrganizationInventoryProjection | null {
  const row = db
    .prepare(
      `SELECT desktop_session_id, known_access_token_expires_at, snapshot_text,
      revision, state_sha256 FROM organization_inventory_projection
      WHERE account_id = ? AND org_id = ? AND inventory_id = ?`
    )
    .get(accountId, target.orgId, target.inventoryId) as
    | {
        desktop_session_id: string;
        known_access_token_expires_at: number;
        snapshot_text: string;
        revision: number;
        state_sha256: string;
      }
    | undefined;
  if (!row) return null;
  const session = inventoryOrganizationSessionIdentitySchema.parse({
    accountId,
    desktopSessionId: row.desktop_session_id,
    knownAccessTokenExpiresAt: row.known_access_token_expires_at,
  });
  const snapshot = parseSnapshot(JSON.parse(row.snapshot_text));
  if (
    snapshot.header.accountId !== accountId ||
    organizationInventoryCanonicalJson(snapshot.header.target) !==
      organizationInventoryCanonicalJson(target) ||
    snapshot.header.revision !== row.revision ||
    snapshot.header.stateSha256 !== row.state_sha256 ||
    organizationInventoryCanonicalJson(snapshot) !== row.snapshot_text
  )
    throw new TypeError('The cached organization inventory does not match its scope.');
  return { session, snapshot };
}

export function writeOrganizationInventoryProjection(
  db: Database.Database,
  identity: InventoryOrganizationSessionIdentity,
  value: Snapshot
): OrganizationInventoryProjection {
  const session = inventoryOrganizationSessionIdentitySchema.parse(identity);
  const snapshot = parseSnapshot(value);
  if (snapshot.header.accountId !== session.accountId)
    throw new TypeError('The inventory snapshot belongs to another account.');
  const text = organizationInventoryCanonicalJson(snapshot);
  if (Buffer.byteLength(text, 'utf8') > ORGANIZATION_INVENTORY_RESPONSE_MAX_BYTES)
    throw new TypeError('The inventory snapshot exceeds its complete bound.');
  return db.transaction(() => {
    const prior = readOrganizationInventoryProjection(
      db,
      session.accountId,
      snapshot.header.target
    );
    if (
      prior &&
      (prior.snapshot.header.revision > snapshot.header.revision ||
        (prior.snapshot.header.revision === snapshot.header.revision &&
          prior.snapshot.header.stateSha256 !== snapshot.header.stateSha256))
    )
      throw new TypeError('The inventory snapshot conflicts with its confirmed revision.');
    db.prepare(
      `INSERT INTO organization_inventory_projection
      (account_id, org_id, inventory_id, desktop_session_id,
       known_access_token_expires_at, snapshot_text, revision, state_sha256)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, org_id, inventory_id) DO UPDATE SET
        desktop_session_id = excluded.desktop_session_id,
        known_access_token_expires_at = excluded.known_access_token_expires_at,
        snapshot_text = excluded.snapshot_text,
        revision = excluded.revision,
        state_sha256 = excluded.state_sha256`
    ).run(
      session.accountId,
      snapshot.header.target.orgId,
      snapshot.header.target.inventoryId,
      session.desktopSessionId,
      session.knownAccessTokenExpiresAt,
      text,
      snapshot.header.revision,
      snapshot.header.stateSha256
    );
    return { session, snapshot };
  })();
}

export function removeOrganizationInventoryProjection(
  db: Database.Database,
  accountId: string,
  target: InventoryOrganizationTarget,
  desktopSessionId: string
): void {
  db.prepare(
    `DELETE FROM organization_inventory_projection
    WHERE account_id = ? AND org_id = ? AND inventory_id = ? AND desktop_session_id = ?`
  ).run(accountId, target.orgId, target.inventoryId, desktopSessionId);
}
