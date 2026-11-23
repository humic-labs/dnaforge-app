import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import {
  SEQUENCE_DATA_LAYER_DIRECTORY,
  SEQUENCE_DATA_LAYER_SUFFIX,
} from '../shared/sequence-data-layer';
import { savedFileWorkspace } from './saved-file-publication';
import { assertCommittedDatabaseReadAllowed } from './workspace-sync-database-fence';

function idFor(seed: string, requestId: string) {
  return 'layer-' + createHash('sha256').update(seed).update('\0').update(requestId).digest('hex');
}

export function sequenceLayerIdentity(db: Database.Database, root: string, requestId: string) {
  assertCommittedDatabaseReadAllowed(db);
  const owner = savedFileWorkspace(db, root);
  if (!owner) throw new Error('The layer has no owning project.');
  const identity = JSON.stringify([String(owner.id)]);
  const first = db
    .prepare(
      `SELECT revision_id,json_extract(payload,'$.repo_uuid') AS repo
    FROM saved_entity_row_versions WHERE source_table='workspaces' AND identity=? ORDER BY version LIMIT 1`
    )
    .get(identity) as { revision_id: string; repo: string | null } | undefined;
  if (!first) throw new Error('The layer project identity has no retained origin.');
  const localId = idFor('library-workspace:' + first.revision_id, requestId);
  const repositoryId = owner.repo_uuid ?? first.repo;
  const stableId = repositoryId ? idFor('repository:' + repositoryId, requestId) : localId;
  const legacyIds = () => {
    const roots = db
      .prepare(
        `SELECT DISTINCT json_extract(payload,'$.path') FROM saved_entity_row_versions
      WHERE source_table='workspaces' AND identity=?`
      )
      .pluck()
      .all(identity) as Array<string | null>;
    return [
      ...new Set(
        [root, ...roots.filter((path): path is string => typeof path === 'string')].map((path) =>
          idFor(path, requestId)
        )
      ),
    ];
  };
  return { stableId, localId, legacyIds, workspaceId: owner.id };
}

export async function resolveSequenceLayerCreationId(
  db: Database.Database,
  root: string,
  requestId: string
) {
  const owner = sequenceLayerIdentity(db, root, requestId);
  const known: Array<{ id: string; restore?: { workspaceId: number; revisionId: string } }> = [];
  const retained = db
    .prepare(
      "SELECT id FROM retained_file_source_revisions WHERE workspace_id=? AND entity_id=? AND status='committed' ORDER BY created_at DESC,rowid DESC LIMIT 1"
    )
    .pluck();
  for (const id of new Set([owner.stableId, owner.localId, ...owner.legacyIds()])) {
    try {
      await lstat(join(root, SEQUENCE_DATA_LAYER_DIRECTORY, id + SEQUENCE_DATA_LAYER_SUFFIX));
      known.push({ id });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const revisionId = retained.get(owner.workspaceId, id) as string | undefined;
      if (revisionId) known.push({ id, restore: { workspaceId: owner.workspaceId, revisionId } });
    }
  }
  if (known.length > 1)
    throw new Error('The layer request has multiple saved identities in this project.');
  return known[0] ?? { id: owner.stableId };
}
