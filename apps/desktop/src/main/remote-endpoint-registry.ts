import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

import type { RemoteEndpointProfileV1, RemoteSshFailureV1 } from '../shared/remote-genomics-ipc';
import { RemoteGenomicsError } from './remote-genomics-error';
import { isRemoteSshTarget } from '../shared/remote-ssh-target';

interface RemoteEndpointProfileRow {
  readonly endpoint_id: string;
  readonly display_name: string;
  readonly ssh_target: string;
  readonly last_connected_at: number;
  readonly observed_platform: string | null;
  readonly last_failure_code: string | null;
  readonly last_failure_message: string | null;
}

export function saveRemoteEndpointProfile(
  db: Database.Database,
  input: { readonly target: string; readonly displayName: string },
  nowMs = Date.now()
): RemoteEndpointProfileV1 {
  if (!input || typeof input.target !== 'string' || !isRemoteSshTarget(input.target.trim())) {
    throw new RemoteGenomicsError(
      'invalid-request',
      'Enter an SSH alias or user@host, without command options.'
    );
  }
  const target = input.target.trim();
  const name = requireProfileText(input.displayName, 'Host name');
  db.prepare(
    `INSERT INTO remote_endpoint_profiles (
    endpoint_id, display_name, ssh_target, last_connected_at, last_validated_at,
    observed_platform, last_failure_code, last_failure_message, created_at, updated_at
  ) VALUES (?, ?, ?, 0, 0, NULL, NULL, NULL, ?, ?)
  ON CONFLICT(ssh_target) DO UPDATE SET display_name = excluded.display_name, updated_at = excluded.updated_at`
  ).run(randomUUID(), name, target, nowMs, nowMs);
  return findRemoteEndpointProfileByTarget(db, target)!;
}

export function listRemoteEndpointProfiles(db: Database.Database): RemoteEndpointProfileV1[] {
  return db
    .prepare(
      `SELECT endpoint_id, display_name, ssh_target, last_connected_at,
              observed_platform, last_failure_code, last_failure_message
         FROM remote_endpoint_profiles
        ORDER BY last_connected_at DESC, display_name COLLATE NOCASE ASC`
    )
    .all()
    .map((row) => profileFromRow(row as RemoteEndpointProfileRow));
}

export function findRemoteEndpointProfileByTarget(
  db: Database.Database,
  target: string
): RemoteEndpointProfileV1 | null {
  const row = db
    .prepare(
      `SELECT endpoint_id, display_name, ssh_target, last_connected_at,
              observed_platform, last_failure_code, last_failure_message
         FROM remote_endpoint_profiles
        WHERE ssh_target = ?`
    )
    .get(target) as RemoteEndpointProfileRow | undefined;
  return row ? profileFromRow(row) : null;
}

export function findRemoteEndpointProfileById(
  db: Database.Database,
  endpointId: string
): RemoteEndpointProfileV1 | null {
  const row = db
    .prepare(
      `SELECT endpoint_id, display_name, ssh_target, last_connected_at,
              observed_platform, last_failure_code, last_failure_message
         FROM remote_endpoint_profiles
        WHERE endpoint_id = ?`
    )
    .get(endpointId) as RemoteEndpointProfileRow | undefined;
  return row ? profileFromRow(row) : null;
}

export function recordRemoteEndpointSuccess(
  db: Database.Database,
  profile: RemoteEndpointProfileV1,
  nowMs = Date.now()
): RemoteEndpointProfileV1 {
  db.prepare(
    `INSERT INTO remote_endpoint_profiles (
       endpoint_id, display_name, ssh_target, last_connected_at, last_validated_at,
       observed_platform, last_failure_code, last_failure_message, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
     ON CONFLICT(ssh_target) DO UPDATE SET
       display_name = excluded.display_name,
       last_connected_at = excluded.last_connected_at,
       last_validated_at = excluded.last_validated_at,
       observed_platform = excluded.observed_platform,
       last_failure_code = NULL,
       last_failure_message = NULL,
       updated_at = excluded.updated_at`
  ).run(
    profile.endpointId,
    profile.displayName,
    profile.target,
    profile.lastConnectedAt ?? 0,
    profile.lastConnectedAt ?? 0,
    profile.observedPlatform,
    nowMs,
    nowMs
  );
  return findRemoteEndpointProfileByTarget(db, profile.target) as RemoteEndpointProfileV1;
}

export function recordRemoteEndpointFailure(
  db: Database.Database,
  target: string,
  failure: RemoteSshFailureV1,
  nowMs = Date.now()
): void {
  db.prepare(
    `UPDATE remote_endpoint_profiles
        SET last_failure_code = ?, last_failure_message = ?, updated_at = ?
      WHERE ssh_target = ?`
  ).run(failure.code, failure.message, nowMs, target);
}

export function renameRemoteEndpointProfile(
  db: Database.Database,
  endpointId: string,
  displayName: string,
  nowMs = Date.now()
): RemoteEndpointProfileV1 | null {
  const id = requireProfileText(endpointId, 'Endpoint ID');
  const name = requireProfileText(displayName, 'Connection name');
  db.prepare(
    'UPDATE remote_endpoint_profiles SET display_name = ?, updated_at = ? WHERE endpoint_id = ?'
  ).run(name, nowMs, id);
  return findRemoteEndpointProfileById(db, id);
}

export function forgetRemoteEndpointProfile(db: Database.Database, endpointId: string): boolean {
  const id = requireProfileText(endpointId, 'Endpoint ID');
  return (
    db.prepare('DELETE FROM remote_endpoint_profiles WHERE endpoint_id = ?').run(id).changes > 0
  );
}

function requireProfileText(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.trim().length > 200 ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new RemoteGenomicsError(
      'invalid-request',
      `${label} must contain 1–200 characters without control characters.`
    );
  }
  return value.trim();
}

function profileFromRow(row: RemoteEndpointProfileRow): RemoteEndpointProfileV1 {
  return {
    endpointId: row.endpoint_id,
    displayName: row.display_name,
    target: row.ssh_target,
    lastConnectedAt: row.last_connected_at > 0 ? row.last_connected_at : null,
    observedPlatform: row.observed_platform,
    lastFailure:
      row.last_failure_code && row.last_failure_message
        ? {
            code: row.last_failure_code as RemoteSshFailureV1['code'],
            message: row.last_failure_message,
          }
        : null,
  };
}
