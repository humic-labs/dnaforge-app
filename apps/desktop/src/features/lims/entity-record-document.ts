import { platform } from '../../platform';
import {
  getCatalogFilesForEntity,
  getWorkspaceRootById,
  resolveWorkspaceId,
} from '../../db/workspace-catalog';
import { reconcileEntityFile } from '../../db/entity-substrate/adapter';
import { limsEntityArtifactAdapter } from '../../db/entity-substrate/lims-entity-adapter';
import { isDeveloperImportSourcePath } from '../../shared/developer-import-sources';
import {
  isSafeWorkspaceRelativePath,
  normalizePathForBoundary,
  pathIsAtOrUnder,
  resolveContainingPathBoundary,
} from '../../shared/path-boundary';
import {
  canonicalEntityArtifactValue,
  entityArtifactProjectionFingerprint,
} from '../../shared/entity-artifact-projection';
import { registryRepresentationForEntity } from '../../shared/registry-entity-opening';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { readDesktopScientificDocument } from '../scientific-document/public/read-desktop-scientific-document';
import {
  ENTITY_ARTIFACT_CURRENT_SCHEMA,
  isEntityArtifactPath,
  parseEntityArtifact,
} from './entity-artifact';
import { getLimsEntityById } from './open-target';
import { getLimsRegistryPreview } from './operations';

export async function readEntityArtifactFile(
  path: string,
  expected?: { entityId: string; workspaceId: number },
  signal?: AbortSignal,
  reconcile = true
) {
  const owner = resolveContainingPathBoundary(useWorkspaceStore.getState().folders, path);
  const workspaceRoot = expected
    ? await getWorkspaceRootById(expected.workspaceId)
    : owner.status === 'unique'
      ? owner.entry.path
      : null;
  if (!workspaceRoot) {
    throw new Error('Open this record’s owning project once before opening the record.');
  }
  if (!pathIsAtOrUnder(path, workspaceRoot)) {
    throw new Error('The saved file and its home project do not agree.');
  }
  const importSource = isDeveloperImportSourcePath(path);
  const workspaceId = importSource
    ? null
    : (expected?.workspaceId ?? (await resolveWorkspaceId(workspaceRoot)));
  if (expected && workspaceId !== expected.workspaceId) {
    throw new Error('The saved record and its home project do not agree.');
  }
  const [read, stat] = await Promise.all([
    importSource
      ? platform().fs.readTextFile(path)
      : readDesktopScientificDocument({ filePath: path, workspaceRoot, signal }),
    platform().fs.stat(path),
  ]);
  if (signal?.aborted) throw new Error('Opening cancelled.');
  if (typeof read !== 'string' && !read.ok) throw new Error(read.error.message);
  const content = typeof read === 'string' ? read : read.document.content;
  const artifact = parseEntityArtifact(content);

  if (expected && artifact.id !== expected.entityId) {
    throw new Error('The saved file identity does not match the selected Registry record.');
  }
  if (
    !importSource &&
    reconcile &&
    (typeof read === 'string' || read.document.revision.kind !== 'accepted-object')
  ) {
    const projection = await reconcileEntityFile(
      limsEntityArtifactAdapter,
      content,
      path,
      typeof stat.mtime === 'number' ? stat.mtime : 0,
      { workspaceRoot, workspaceId }
    );
    if (projection.outcome === 'conflict') {
      throw new Error(
        'The saved file and Registry contain conflicting changes. Preserve both versions before reopening this record.'
      );
    }
  }
  return { artifact, content, path, workspaceRoot, workspaceId, importSource };
}

export async function loadSavedEntityRecord(entityId: string, signal?: AbortSignal) {
  const entity = await getLimsEntityById(entityId);
  if (!entity || entity.workspaceId === null)
    throw new Error('This record’s home project is unavailable.');
  const target = registryRepresentationForEntity(entity).openTarget;
  if (target.kind !== 'record_file')
    throw new Error('This record has no supported saved record file.');
  const bindings = (await getCatalogFilesForEntity(entityId)).filter(
    (file) => file.status === 'current'
  );
  if (bindings.length > 1) throw new Error('This record has conflicting current file bindings.');
  const binding = bindings[0];
  if (binding && binding.workspace_id !== entity.workspaceId) {
    throw new Error('The saved file and its home project do not agree.');
  }
  const root = await getWorkspaceRootById(entity.workspaceId);
  if (!root || !isSafeWorkspaceRelativePath(target.artifactRelativePath)) {
    throw new Error('This record’s saved file location is unavailable.');
  }
  const separator = root.includes('\\') ? '\\' : '/';
  const path =
    binding?.path ??
    `${root.replace(/[\\/]+$/, '')}${separator}${target.artifactRelativePath.replace(/\//g, separator)}`;
  if (
    !isEntityArtifactPath(path) ||
    !pathIsAtOrUnder(path, root) ||
    isDeveloperImportSourcePath(path)
  ) {
    throw new Error('This record has no editable saved file in its home project.');
  }

  const loaded = await readEntityArtifactFile(
    path,
    { entityId, workspaceId: entity.workspaceId },
    signal,
    false
  );
  if (signal?.aborted) throw new Error('Opening cancelled.');
  if (loaded.artifact.schema !== ENTITY_ARTIFACT_CURRENT_SCHEMA) {
    throw new Error('This legacy record needs its saved schema restored before it can be edited.');
  }
  const preview = await getLimsRegistryPreview({ entityId });
  const artifact = loaded.artifact;
  if (
    preview.entity.id !== entityId ||
    preview.entity.workspaceId !== entity.workspaceId ||
    normalizePathForBoundary(loaded.workspaceRoot) !== normalizePathForBoundary(root) ||
    entityArtifactProjectionFingerprint({
      ...preview.entity,
      archived: preview.entity.tombstone,
    }) !== entityArtifactProjectionFingerprint(artifact) ||
    JSON.stringify(
      canonicalEntityArtifactValue({
        ...preview.schemaSnapshot,
        description: preview.schemaSnapshot.description ?? null,
      })
    ) !==
      JSON.stringify(
        canonicalEntityArtifactValue({
          ...artifact.schemaSnapshot,
          description: artifact.schemaSnapshot.description ?? null,
        })
      )
  ) {
    throw new Error(
      'The saved record, its schema, and its Registry projection do not agree. Reconcile its project before editing.'
    );
  }
  return { ...loaded, artifact, preview };
}

export type LoadedEntityRecord = Awaited<ReturnType<typeof loadSavedEntityRecord>>;
