import { assertCommittedDatabaseReadAllowed } from './workspace-sync-database-fence';
import type Database from 'better-sqlite3';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  ENTITY_ARTIFACT_CURRENT_SCHEMA,
  isEntityArtifactPath,
  parseEntityArtifact,
  serializeEntityArtifact,
  type EntityArtifact,
  type EntityArtifactV2,
} from '../shared/entity-artifact';
import {
  canonicalEntityArtifactValue,
  canonicalEntityArtifactProjection,
} from '../shared/entity-artifact-projection';
import { isDeveloperImportSourcePath } from '../shared/developer-import-sources';
import {
  normalizePathForBoundary,
  pathRelativeToBoundary,
  isSafeWorkspaceRelativePath,
} from '../shared/path-boundary';
import { MAX_WORKSPACE_BINARY_WRITE_BYTES } from '../shared/workspace-file-atomic';
import type {
  LegacyRegistryArtifactUpgradeInput,
  LegacyRegistryArtifactUpgradeResult,
} from '../shared/legacy-registry-artifact-upgrade';
import { developerImportSourceRootsInDb } from './registry-source-eligibility';
import { getLimsRegistryPreviewInDb } from './lims-registry-projection';
import {
  canonicalWorkspacePath,
  writeWorkspaceTextFileAtomicInMain,
} from './primer-artifact-files';

function relationshipFingerprint(relationships: EntityArtifact['relationships']): string {
  return JSON.stringify(
    relationships
      .map(({ type, fromEntityId, toEntityId, payload }) =>
        JSON.stringify(canonicalEntityArtifactValue({ type, fromEntityId, toEntityId, payload }))
      )
      .sort()
  );
}

function checkedAuthority(db: Database.Database, input: LegacyRegistryArtifactUpgradeInput) {
  assertCommittedDatabaseReadAllowed(db);
  const workspace = db
    .prepare(
      'SELECT id, path, repo_uuid, access_mode, archived_at, trashed_at FROM workspaces WHERE id=?'
    )
    .get(input.workspaceId) as
    | {
        id: number;
        path: string;
        repo_uuid: string | null;
        access_mode: string;
        archived_at: number | null;
        trashed_at: number | null;
      }
    | undefined;
  const roots = developerImportSourceRootsInDb(db);
  if (
    !workspace ||
    workspace.access_mode !== 'writable' ||
    workspace.archived_at != null ||
    workspace.trashed_at != null ||
    normalizePathForBoundary(workspace.path) !== normalizePathForBoundary(input.workspaceRoot) ||
    isDeveloperImportSourcePath(input.path, roots) ||
    isDeveloperImportSourcePath(input.workspaceRoot, roots)
  )
    return null;
  const relativePath = pathRelativeToBoundary(input.path, input.workspaceRoot);
  if (
    !isEntityArtifactPath(input.path) ||
    !relativePath ||
    !isSafeWorkspaceRelativePath(relativePath)
  )
    return null;
  if (!db.prepare('SELECT 1 FROM lims_entity WHERE id=?').get(input.entityId)) return null;
  const preview = getLimsRegistryPreviewInDb(db, { entityId: input.entityId });
  const bindings = db
    .prepare(
      "SELECT workspace_id, path FROM catalog_entity_files WHERE entity_id=? AND status='current' ORDER BY path"
    )
    .all(input.entityId) as Array<{ workspace_id: number | null; path: string }>;
  if (bindings.length > 0) {
    if (
      bindings.some(
        (binding) =>
          binding.workspace_id !== input.workspaceId ||
          normalizePathForBoundary(binding.path) !== normalizePathForBoundary(input.path)
      )
    )
      return null;
  } else {
    const artifact = preview.entity.fields.artifact;
    if (
      preview.entity.workspaceId !== input.workspaceId ||
      !artifact ||
      typeof artifact !== 'object' ||
      Array.isArray(artifact) ||
      !('relativePath' in artifact) ||
      typeof artifact.relativePath !== 'string' ||
      !isSafeWorkspaceRelativePath(artifact.relativePath) ||
      artifact.relativePath.replace(/\\/g, '/') !== relativePath.replace(/\\/g, '/')
    )
      return null;
  }
  const scope = db
    .prepare(
      'SELECT workspace_uuid, owner_account_id, owner_org_id, remote_workspace_id, enabled, detached_reason FROM workspace_sync_bindings WHERE workspace_id=?'
    )
    .get(input.workspaceId);
  return { workspace, bindings, preview, scope };
}

export async function upgradeLegacyRegistryArtifactInMain(request: {
  db: Database.Database;
  runDatabase: <T>(operation: () => T) => T;
  input: LegacyRegistryArtifactUpgradeInput;
}): Promise<LegacyRegistryArtifactUpgradeResult> {
  const { db, runDatabase, input } = request;
  const authority = runDatabase(() => checkedAuthority(db, input));
  if (!authority) return { published: false };
  const canonical = await canonicalWorkspacePath({ ...input, artifactNoun: 'Registry record' });
  const file = await open(canonical.candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const before = await file.stat();
    if (
      !before.isFile() ||
      !Number.isSafeInteger(before.size) ||
      before.size > MAX_WORKSPACE_BINARY_WRITE_BYTES
    )
      throw new Error('Registry source must be a regular file within the Files size bound.');
    const buffer = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        count,
        Math.min(1024 * 1024, buffer.length - count),
        count
      );
      if (!bytesRead) break;
      count += bytesRead;
    }
    const after = await file.stat();
    if (
      count !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.size !== after.size
    )
      throw new Error('Registry source changed during inspection.');
    bytes = buffer.subarray(0, count);
  } finally {
    await file.close();
  }
  if (createHash('sha256').update(bytes).digest('hex') !== input.expectedContentHash)
    throw new Error('Registry source changed since the checked format upgrade was requested.');
  const legacy = parseEntityArtifact(bytes.toString('utf8'));
  if (legacy.id !== input.entityId)
    throw new Error('Registry source identity does not match its owner.');
  if (legacy.schema === ENTITY_ARTIFACT_CURRENT_SCHEMA) return { published: false };
  const { preview } = authority;
  const document: EntityArtifactV2 = {
    ...legacy,
    schema: ENTITY_ARTIFACT_CURRENT_SCHEMA,
    schemaRevisionId: preview.schemaSnapshot.schemaRevisionId,
    schemaSnapshot: preview.schemaSnapshot,
    archived: preview.entity.tombstone,
  };
  if (
    preview.entity.kind !== legacy.kind ||
    preview.entity.schemaRevisionId !== document.schemaRevisionId ||
    !isDeepStrictEqual(
      canonicalEntityArtifactProjection({ ...preview.entity, archived: preview.entity.tombstone }),
      canonicalEntityArtifactProjection(document)
    ) ||
    relationshipFingerprint(legacy.relationships) !==
      relationshipFingerprint(preview.outgoingLinks.map(({ link }) => link))
  )
    return { published: false };
  await writeWorkspaceTextFileAtomicInMain(
    {
      workspaceRoot: input.workspaceRoot,
      path: input.path,
      content: serializeEntityArtifact(document),
      mode: 'replace',
      expectedContentHash: input.expectedContentHash,
      artifactNoun: 'Registry record',
    },
    {
      durable: true,
      beforePublish: () =>
        runDatabase(() => {
          if (!isDeepStrictEqual(checkedAuthority(db, input), authority))
            throw new Error('Registry format upgrade authority changed before publication.');
        }),
    }
  );
  return { published: true };
}
