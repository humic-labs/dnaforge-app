import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  DEEP_SHARE_ARTIFACT_TYPES,
  resolveShareBundleLimits,
  type DeepShareArtifactType,
  type DeepShareFileV1,
  type DeepShareManifestV1,
  type PortableConversationV1,
} from '@waypoint/share-bundle';
import { resolveHeadCommit } from '../workspace-git';
import { resolveDeepShareArtifactFiles, type DeepShareCatalogFileRow } from './artifact-resolver';
import { buildDeepShareArtifactClosure, type DeepShareClosureLink } from './closure';
import {
  listDeepShareConversationCandidates,
  loadPortableConversation,
  type DeepShareConversationCandidate,
} from './portable-chat';

export interface DeepSharePreflightInput {
  workspaceUuid: string;
  rootArtifactId: string;
  selectedArtifactIds?: readonly string[];
  selectedConversationIds: readonly string[];
  getCurrentHeadSha?: (repoPath: string) => string | Promise<string>;
}

export interface DeepSharePreflight {
  workspace: {
    localId: number;
    uuid: string;
    name: string;
    path: string;
    remoteWorkspaceId: string;
    latestVersionId: string | null;
    latestVersionNumber: number | null;
    latestVersionContentSha256: string | null;
    sourceHeadSha: string;
  };
  rootArtifactId: string;
  manifest: DeepShareManifestV1;
  files: DeepShareFileV1[];
  chats: PortableConversationV1[];
  conversationCandidates: DeepShareConversationCandidate[];
  digest: string;
}

export type DeepSharePreflightErrorCode =
  | 'WORKSPACE_NOT_READY'
  | 'ROOT_NOT_FOUND'
  | 'ROOT_HAS_NO_PORTABLE_FILE'
  | 'INVALID_SELECTION';

export class DeepSharePreflightError extends Error {
  constructor(
    readonly code: DeepSharePreflightErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'DeepSharePreflightError';
  }
}

export async function buildDeepSharePreflight(
  db: Database.Database,
  input: DeepSharePreflightInput
): Promise<DeepSharePreflight> {
  const workspace = selectWorkspace(db, input.workspaceUuid);
  const entities = selectEntities(db, workspace.localId);
  const entityById = new Map(entities.map((entity) => [entity.id, entity]));
  if (!entityById.has(input.rootArtifactId)) {
    throw new DeepSharePreflightError('ROOT_NOT_FOUND', 'Deep Share root was not found.');
  }
  const closure = buildDeepShareArtifactClosure({
    rootArtifactId: input.rootArtifactId,
    entities,
    links: selectLinks(db, new Set(entities.map((entity) => entity.id))),
  });
  const selectedIds = selectionIds(
    input,
    closure.artifacts.map((artifact) => artifact.id)
  );
  const artifacts = closure.artifacts.filter((artifact) => selectedIds.has(artifact.id));
  const relationships = closure.relationships.filter(
    (relationship) =>
      selectedIds.has(relationship.sourceArtifactId) &&
      selectedIds.has(relationship.targetArtifactId)
  );
  const resolvedFiles = await resolveDeepShareArtifactFiles({
    workspaceRoot: workspace.path,
    artifacts,
    catalogFiles: selectCatalogFiles(db, workspace.localId, selectedIds),
    limits: resolveShareBundleLimits(),
  });
  if (!resolvedFiles.files.some((file) => file.ownerArtifactId === input.rootArtifactId)) {
    throw new DeepSharePreflightError(
      'ROOT_HAS_NO_PORTABLE_FILE',
      'The selected artifact has no portable file to share.'
    );
  }

  const chatArtifacts = artifacts.flatMap((artifact) => {
    const entity = entityById.get(artifact.id);
    return entity
      ? [{ id: entity.id, type: entity.type, name: entity.name, locator: entity.locator }]
      : [];
  });
  const conversationCandidates = listDeepShareConversationCandidates(db, {
    workspacePath: workspace.path,
    artifacts: chatArtifacts,
  });
  const candidateIds = new Set(conversationCandidates.map((candidate) => candidate.id));
  const selectedConversationIds = [...new Set(input.selectedConversationIds)].sort();
  for (const conversationId of selectedConversationIds) {
    if (!candidateIds.has(conversationId)) {
      throw new DeepSharePreflightError(
        'INVALID_SELECTION',
        'A selected conversation does not belong to this workspace.'
      );
    }
  }
  const chats = selectedConversationIds.map((conversationId) =>
    loadPortableConversation(db, {
      conversationId,
      workspacePath: workspace.path,
      artifacts: chatArtifacts,
    })
  );
  const manifest: DeepShareManifestV1 = {
    rootArtifactId: input.rootArtifactId,
    artifacts,
    relationships,
    files: resolvedFiles.files.map((file) => ({
      fileId: file.id,
      ownerArtifactId: file.ownerArtifactId,
      role: file.role,
    })),
    chats: chats.map((chat) => ({ conversationId: chat.id, title: chat.title })),
    omissions: [...closure.omissions, ...resolvedFiles.omissions],
  };
  const sourceHeadSha = await (input.getCurrentHeadSha?.(workspace.path) ??
    resolveHeadCommit(workspace.path));
  if (!sourceHeadSha) {
    throw new DeepSharePreflightError(
      'WORKSPACE_NOT_READY',
      'Commit the managed project before sharing.'
    );
  }
  const digest = hashPreflight({
    rootArtifactId: input.rootArtifactId,
    sourceHeadSha,
    manifest,
    files: resolvedFiles.files,
    chats,
  });

  return {
    workspace: { ...workspace, sourceHeadSha },
    rootArtifactId: input.rootArtifactId,
    manifest,
    files: resolvedFiles.files,
    chats,
    conversationCandidates,
    digest,
  };
}

interface WorkspaceRecord {
  localId: number;
  uuid: string;
  name: string;
  path: string;
  remoteWorkspaceId: string;
  latestVersionId: string | null;
  latestVersionNumber: number | null;
  latestVersionContentSha256: string | null;
}

function selectWorkspace(db: Database.Database, workspaceUuid: string): WorkspaceRecord {
  const row = objectRecord(
    db
      .prepare(
        `SELECT w.id, w.repo_uuid, w.name, w.path, w.archived_at, w.trashed_at,
                b.remote_workspace_id, b.enabled, b.remote_latest_version_id,
                b.remote_latest_version_number, b.remote_latest_content_sha256
         FROM workspaces w
         JOIN workspace_sync_bindings b ON b.workspace_id = w.id
         WHERE w.repo_uuid = ?
         LIMIT 1`
      )
      .get(workspaceUuid)
  );
  const localId = integer(row?.id);
  const uuid = text(row?.repo_uuid);
  const name = text(row?.name);
  const path = text(row?.path);
  const remoteWorkspaceId = text(row?.remote_workspace_id);
  if (
    localId === null ||
    !uuid ||
    !name ||
    !path ||
    !remoteWorkspaceId ||
    row?.enabled !== 1 ||
    row.archived_at !== null ||
    row.trashed_at !== null
  ) {
    throw new DeepSharePreflightError(
      'WORKSPACE_NOT_READY',
      'Turn on cloud sync for an active managed project before sharing.'
    );
  }
  return {
    localId,
    uuid,
    name,
    path,
    remoteWorkspaceId,
    latestVersionId: nullableText(row.remote_latest_version_id),
    latestVersionNumber: nullableInteger(row.remote_latest_version_number),
    latestVersionContentSha256: nullableText(row.remote_latest_content_sha256),
  };
}

interface CatalogEntityRecord {
  id: string;
  type: DeepShareArtifactType;
  name: string;
  locator: string;
}

function selectEntities(db: Database.Database, workspaceId: number): CatalogEntityRecord[] {
  return db
    .prepare(
      `SELECT id, type, name, locator
       FROM catalog_entities
       WHERE workspace_id = ? AND status = 'active'
       ORDER BY id ASC`
    )
    .all(workspaceId)
    .flatMap((row) => {
      const record = objectRecord(row);
      const id = text(record?.id);
      const type = artifactType(record?.type);
      const name = text(record?.name);
      const locator = text(record?.locator);
      return id && type && name && locator ? [{ id, type, name, locator }] : [];
    });
}

function selectLinks(
  db: Database.Database,
  entityIds: ReadonlySet<string>
): DeepShareClosureLink[] {
  return db
    .prepare(
      `SELECT source_entity_id, relation, target_entity_id, confidence
       FROM catalog_entity_links
       ORDER BY source_entity_id, relation, target_entity_id`
    )
    .all()
    .flatMap((row) => {
      const record = objectRecord(row);
      const sourceArtifactId = text(record?.source_entity_id);
      const relation = text(record?.relation);
      const targetArtifactId = text(record?.target_entity_id);
      const confidence = linkConfidence(record?.confidence);
      return sourceArtifactId &&
        relation &&
        targetArtifactId &&
        confidence &&
        (entityIds.has(sourceArtifactId) || entityIds.has(targetArtifactId))
        ? [{ sourceArtifactId, relation, targetArtifactId, confidence }]
        : [];
    });
}

function selectCatalogFiles(
  db: Database.Database,
  workspaceId: number,
  artifactIds: ReadonlySet<string>
): DeepShareCatalogFileRow[] {
  return db
    .prepare(
      `SELECT entity_id, path, relative_path, file_kind
       FROM catalog_entity_files
       WHERE workspace_id = ? AND status = 'current'
       ORDER BY entity_id, path`
    )
    .all(workspaceId)
    .flatMap((row) => {
      const record = objectRecord(row);
      const entityId = text(record?.entity_id);
      const path = text(record?.path);
      const relativePath = nullableText(record?.relative_path);
      const fileKind = text(record?.file_kind);
      return entityId && artifactIds.has(entityId) && path && fileKind
        ? [{ entityId, path, relativePath, fileKind }]
        : [];
    });
}

function selectionIds(
  input: DeepSharePreflightInput,
  discoveredIds: readonly string[]
): Set<string> {
  const selected = new Set(input.selectedArtifactIds ?? discoveredIds);
  selected.add(input.rootArtifactId);
  const discovered = new Set(discoveredIds);
  for (const id of selected) {
    if (!discovered.has(id)) {
      throw new DeepSharePreflightError(
        'INVALID_SELECTION',
        'A selected artifact is not part of the reviewed relationship closure.'
      );
    }
  }
  return selected;
}

function hashPreflight(input: {
  rootArtifactId: string;
  sourceHeadSha: string;
  manifest: DeepShareManifestV1;
  files: readonly DeepShareFileV1[];
  chats: readonly PortableConversationV1[];
}): string {
  const review = {
    rootArtifactId: input.rootArtifactId,
    sourceHeadSha: input.sourceHeadSha,
    manifest: input.manifest,
    files: input.files.map((file) => ({
      id: file.id,
      ownerArtifactId: file.ownerArtifactId,
      relativePath: file.relativePath,
      role: file.role,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
    })),
    chats: input.chats,
  };
  return createHash('sha256').update(JSON.stringify(review), 'utf8').digest('hex');
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record: Record<string, unknown> = {};
  for (const key of Object.keys(value))
    record[key] = Object.getOwnPropertyDescriptor(value, key)?.value;
  return record;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function nullableInteger(value: unknown): number | null {
  return value === null ? null : integer(value);
}

function artifactType(value: unknown): DeepShareArtifactType | null {
  return typeof value === 'string'
    ? (DEEP_SHARE_ARTIFACT_TYPES.find((candidate) => candidate === value) ?? null)
    : null;
}

function linkConfidence(value: unknown): 'suggested' | 'confirmed' | 'rejected' | null {
  return value === 'suggested' || value === 'confirmed' || value === 'rejected' ? value : null;
}
