import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export function readOrCreateWorkspaceSyncDeviceId(
  db: Database.Database,
  deps: { nowMs?: () => number; createDeviceId?: () => string } = {}
): string {
  const existing = db
    .prepare(`SELECT device_id FROM workspace_sync_device WHERE id = 1 LIMIT 1`)
    .get() as { device_id: string } | undefined;
  if (existing?.device_id) return existing.device_id;

  const nowMs = deps.nowMs?.() ?? Date.now();
  const deviceId = deps.createDeviceId?.() ?? randomUUID();
  db.prepare(
    `INSERT INTO workspace_sync_device (id, device_id, created_at, updated_at)
     VALUES (1, ?, ?, ?)`
  ).run(deviceId, nowMs, nowMs);
  return deviceId;
}
