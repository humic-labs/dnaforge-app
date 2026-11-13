import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type {
  LimsRecordRelationshipTargetQuery,
  LimsRecordRelationshipTargetPage,
  LimsRecordRelationshipTarget,
} from '../shared/lims';
import {
  NATIVE_WORKSPACE_MANIFEST_PATH,
  parseNativeWorkspaceManifest,
} from '../shared/native-workspace-manifest';
import { scopedProjectionId, workspaceScopeKey } from '../shared/workspace-scoped-identity';
import { assertWorkspaceProjectionPathSafe } from './workspace-projection-boundary';

export async function queryNativeRecordRelationshipTargets(
  db: Database.Database,
  input: LimsRecordRelationshipTargetQuery,
  runDatabase: <T>(operation: () => T) => T
): Promise<LimsRecordRelationshipTargetPage> {
  if (
    !input ||
    typeof input.entityId !== 'string' ||
    !input.entityId ||
    input.entityId.length > 1024 ||
    (input.search !== undefined &&
      (typeof input.search !== 'string' || input.search.length > 256)) ||
    (input.offset !== undefined && (!Number.isSafeInteger(input.offset) || input.offset < 0))
  )
    throw new Error('Record relationship search is invalid.');
  const scope = () => {
    const row = db
      .prepare(
        `SELECT w.id,w.path,w.repo_uuid FROM catalog_entities c
      JOIN lims_entity l ON l.id=c.id AND l.workspace_id=c.workspace_id
      JOIN workspaces w ON w.id=c.workspace_id WHERE c.id=? AND c.type='record'
      AND c.status='active' AND l.tombstone=0 AND l.archived_at IS NULL
      AND w.archived_at IS NULL AND w.trashed_at IS NULL`
      )
      .get(input.entityId);
    if (
      !record(row) ||
      typeof row.id !== 'number' ||
      typeof row.path !== 'string' ||
      (row.repo_uuid !== null && typeof row.repo_uuid !== 'string')
    )
      throw new Error('Relationship editor has no active project record.');
    return { id: row.id, path: row.path, scope: workspaceScopeKey(row.repo_uuid, row.id) };
  };
  const authority = runDatabase(scope);
  const path = join(authority.path, NATIVE_WORKSPACE_MANIFEST_PATH);
  assertWorkspaceProjectionPathSafe(authority.path, path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const manifest = await (async () => {
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size > 32 * 1024 * 1024)
        throw new Error('Relationship catalog must be a regular file below 32 MiB.');
      const buffer = Buffer.alloc(before.size + 1);
      let count = 0;
      while (count < buffer.length) {
        const read = await file.read(buffer, count, buffer.length - count, null);
        if (read.bytesRead === 0) break;
        count += read.bytesRead;
      }
      const bytes = buffer.subarray(0, count);
      const after = await file.stat();
      if (
        bytes.length !== before.size ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs
      )
        throw new Error('Relationship catalog changed during search. Try again.');
      return parseNativeWorkspaceManifest(bytes.toString('utf8'));
    } finally {
      await file.close();
    }
  })();
  if (manifest.schema !== 'dnaforge.native-workspace-manifest.v2')
    throw new Error('Relationship project changed during search.');
  const eligible = new Set(
    manifest.entities
      .filter((entity) => entity.lims && entity.lifecycle?.state !== 'archived')
      .map((entity) => scopedProjectionId(authority.scope, entity.id))
  );
  if (!eligible.has(input.entityId))
    throw new Error('Relationship editor is not in the portable catalog.');
  const query = input.search?.trim().toLowerCase() ?? '';
  const rows = runDatabase(() => {
    const current = scope();
    if (
      current.id !== authority.id ||
      current.path !== authority.path ||
      current.scope !== authority.scope
    )
      throw new Error('Relationship project changed during search.');
    return db
      .prepare(
        `SELECT l.id,l.name,l.registry_id,l.kind FROM lims_entity l
    JOIN catalog_entities c ON c.id=l.id WHERE l.workspace_id=? AND c.workspace_id=?
    AND c.status='active' AND l.tombstone=0 AND l.archived_at IS NULL AND l.id<>?
    ORDER BY lower(l.name),l.id`
      )
      .all(authority.id, authority.id, input.entityId);
  });
  const matches: LimsRecordRelationshipTarget[] = [];
  for (const row of rows) {
    if (
      !record(row) ||
      typeof row.id !== 'string' ||
      typeof row.name !== 'string' ||
      typeof row.kind !== 'string' ||
      (row.registry_id !== null && typeof row.registry_id !== 'string')
    )
      throw new Error('Relationship target projection is invalid.');
    if (
      !eligible.has(row.id) ||
      (query &&
        !row.name.toLowerCase().includes(query) &&
        !(row.registry_id ?? '').toLowerCase().includes(query))
    )
      continue;
    matches.push({ id: row.id, name: row.name, registryId: row.registry_id, kind: row.kind });
  }
  const offset = input.offset ?? 0;
  return { targets: matches.slice(offset, offset + 50), hasMore: matches.length > offset + 50 };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
