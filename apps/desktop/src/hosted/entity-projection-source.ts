import type { PlatformBridge } from '../platform/types';
import {
  ENTITY_ARTIFACT_CURRENT_SCHEMA,
  isEntityArtifactPath,
  parseEntityArtifact,
} from '../shared/entity-artifact';
import {
  canonicalEntityArtifactValue,
  entityArtifactProjectionContent,
  entityArtifactProjectionFingerprint,
} from '../shared/entity-artifact-projection';
import { entitySchemaRevisionContent } from '../shared/entity-schema';
import type { SettleEntityProjectionSourceInput } from '../shared/entity-projection-source';
import { isSafeWorkspaceRelativePath } from '../shared/path-boundary';
import { workspaceScopeKey } from '../shared/workspace-scoped-identity';
import { parseHostedFsPath } from './paths';

interface HostedProjectionDb {
  select<T>(sql: string, params?: Array<string | number | null>): Promise<T>;
  execute(sql: string, params?: Array<string | number | null>): Promise<unknown>;
}

export function createHostedProjectionSourceCommands({
  db,
  fs,
  lims,
  settleNotebook,
}: {
  db: HostedProjectionDb;
  fs: Pick<PlatformBridge['fs'], 'readTextFile'>;
  lims: Pick<PlatformBridge['lims'], 'getRegistryPreview'>;
  settleNotebook: (input: SettleEntityProjectionSourceInput) => Promise<void>;
}) {
  return {
    async settleEntityProjectionSource(input: SettleEntityProjectionSourceInput): Promise<void> {
      const { key, fingerprint } = input;
      if (key.adapterKind === 'notebook') return settleNotebook(input);
      if (
        key.adapterKind !== 'lims-entity' ||
        key.projectionVersion !== 1 ||
        !isSafeWorkspaceRelativePath(key.relativePath) ||
        !isEntityArtifactPath(key.relativePath)
      )
        throw new Error('This hosted runtime cannot validate the requested projection source.');
      const workspaces = await db.select<
        Array<{
          id: number;
          path: string;
          repo_uuid: string | null;
          archived_at: number | null;
          trashed_at: number | null;
        }>
      >('SELECT id, path, repo_uuid, archived_at, trashed_at FROM workspaces');
      const matching = workspaces.filter(
        (workspace) =>
          key.workspaceKey === `scope:${workspaceScopeKey(workspace.repo_uuid, workspace.id)}` ||
          key.workspaceKey === `workspace:${workspace.id}` ||
          key.workspaceKey === `root:${workspace.path}`
      );
      const workspace = matching.length === 1 ? matching[0] : null;
      const hosted = workspace && parseHostedFsPath(workspace.path);
      if (
        !workspace ||
        !hosted?.workspaceId ||
        hosted.relativePath !== '' ||
        workspace.archived_at != null ||
        workspace.trashed_at != null
      )
        throw new Error('Registry source has no exact active hosted project owner.');
      const path = `${workspace.path}/${key.relativePath}`;
      const content = await fs.readTextFile(path);
      const document = parseEntityArtifact(content);
      if (document.schema !== ENTITY_ARTIFACT_CURRENT_SCHEMA || document.id !== key.entityId)
        throw new Error('Registry source has a different identity or no frozen schema.');
      const preview = await lims.getRegistryPreview({ entityId: key.entityId });
      const artifact = preview?.entity.fields.artifact;
      if (
        !preview ||
        preview.entity.workspaceId !== workspace.id ||
        !artifact ||
        typeof artifact !== 'object' ||
        Array.isArray(artifact) ||
        !('relativePath' in artifact) ||
        artifact.relativePath !== key.relativePath ||
        entityArtifactProjectionContent({
          ...preview.entity,
          archived: preview.entity.tombstone,
        }) !== entityArtifactProjectionContent(document) ||
        JSON.stringify(
          canonicalEntityArtifactValue(entitySchemaRevisionContent(preview.schemaSnapshot))
        ) !==
          JSON.stringify(
            canonicalEntityArtifactValue(entitySchemaRevisionContent(document.schemaSnapshot))
          ) ||
        fingerprint !== entityArtifactProjectionFingerprint(document)
      )
        throw new Error('Registry hosted projection differs from its canonical file.');
      if ((await fs.readTextFile(path)) !== content)
        throw new Error('Registry source changed before projection synchronization.');
      await db.execute(
        `INSERT INTO entity_projection_sources
        (adapter_kind, entity_id, workspace_key, relative_path, projection_version, synchronized_fingerprint, synchronized_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(adapter_kind, entity_id, workspace_key, relative_path, projection_version)
        DO UPDATE SET synchronized_fingerprint = excluded.synchronized_fingerprint, synchronized_at = excluded.synchronized_at`,
        [
          key.adapterKind,
          key.entityId,
          key.workspaceKey,
          key.relativePath,
          key.projectionVersion,
          fingerprint,
          Date.now(),
        ]
      );
    },
  };
}
