import type { WorkspaceMutationRunner } from '../shared/artifact-operation-ports';
import type { ArtifactIO } from '../shared/artifact-io';

import type { CatalogFileBindingRequest, CatalogFileBindingRow } from '../shared/catalog-binding';
import { pickCanonicalBinding } from '../shared/catalog-canonical-binding';
import { scopedProjectionId, workspaceScopeKey } from '../shared/workspace-scoped-identity';
import {
  findContainingPathBoundary,
  pathIsAtOrUnder,
  isSafeWorkspaceRelativePath,
} from '../shared/path-boundary';
import { isTextSequenceFileKind, TEXT_SEQUENCE_FILE_KINDS } from '../shared/catalog-file-kind';
import { SEQUENCE_PACKAGE_FILE_KIND_ALIASES } from './sequence-package-contract';
import {
  type CatalogEntityType,
  type CatalogRecordPresentationKind,
} from '../shared/catalog-entity';
import {
  workspaceCanContributeRecentEdits,
  type WorkspaceAccess,
} from '../shared/workspace-access';

export { inferCatalogFileKind } from '../shared/catalog-file-kind';

export type { CatalogEntityType } from '../shared/catalog-entity';

export type CatalogStorageType = 'file' | 'database' | 'localStorage' | 'sidecar' | 'external';

export type CatalogConfidence = 'suggested' | 'confirmed' | 'rejected';

export type CatalogEntityStatus = 'active' | 'missing' | 'archived' | 'conflict';

export type { CatalogFileBindingStatus } from '../shared/catalog-binding';

export type CatalogWorkspacePlacementStatus = 'active' | 'hidden';

export type CatalogWorkspacePresentationKind = CatalogRecordPresentationKind;

export interface DBCatalogEntity {
  id: string;
  type: CatalogEntityType;
  name: string;
  locator: string;
  storage_type: CatalogStorageType;
  status: string;
  workspace_id: number | null;
  metadata: string | null;
  created_at: number;
  updated_at: number;
}

export type DBCatalogEntityFile = CatalogFileBindingRow;

export type CurrentCatalogFileFingerprint = Pick<
  DBCatalogEntityFile,
  | 'id'
  | 'entity_id'
  | 'path'
  | 'object_uuid'
  | 'file_kind'
  | 'content_hash'
  | 'size_bytes'
  | 'modified_at'
> & { workspace_id: number };

export interface DBCatalogEntityLink {
  id: string;
  source_entity_id: string;
  relation: string;
  target_entity_id: string;
  confidence: CatalogConfidence;
  evidence: string | null;
  created_at: number;
  updated_at: number;
}

export interface DBCatalogEntityEvent {
  id: string;
  entity_id: string;
  event_type: string;
  actor: string;
  summary: string | null;
  payload: string | null;
  created_at: number;
}

export interface DBCatalogWorkspacePlacement {
  entity_id: string;
  workspace_id: number;
  parent_relative_path: string;
  display_name: string;
  normalized_sibling_name: string;
  presentation_kind: CatalogWorkspacePresentationKind;
  status: CatalogWorkspacePlacementStatus;
  created_at: number;
  updated_at: number;
}

export interface WriteCatalogWorkspacePlacementInput {
  entityId: string;
  workspaceId: number;
  parentRelativePath: string;
  displayName: string;
  presentationKind: CatalogWorkspacePresentationKind;
  status?: CatalogWorkspacePlacementStatus;
}

interface RegisterCatalogEntityInput {
  id?: string;
  type: CatalogEntityType;
  name: string;
  locator: string;
  storageType: CatalogStorageType;
  status?: string;
  workspaceRoot?: string | null;
  metadata?: Record<string, unknown> | null;
  preserveExistingName?: boolean;
  workspaceAccess?: WorkspaceAccess;
}

interface RegisterWorkspaceFileInput {
  path: string;
  name?: string;
  entityType?: CatalogEntityType;
  fileKind?: string;
  workspaceRoot?: string | null;
  contentHash?: string | null;
  sizeBytes?: number | null;
  modifiedAt?: number | null;
  metadata?: Record<string, unknown> | null;
  workspaceAccess?: WorkspaceAccess;
  mutationToken?: string;
}

interface BindCatalogEntityFileInput extends CatalogFileBindingRequest {
  mutationToken?: string;
}

interface RegisterContextualEntityInput {
  id: string;
  type: CatalogEntityType;
  name: string;
  locator: string;
  storageType: CatalogStorageType;
  workspaceRoot?: string | null;
  metadata?: Record<string, unknown> | null;
  context?: CatalogCreationContext | null;
  mutationToken?: string;
}

export interface CatalogCreationContext {
  targetPath?: string | null;
  targetKind?: 'file' | 'folder' | null;
  parentPath?: string | null;
}

export { ADOPT_OBJECT_UUID_SQL } from '../shared/catalog-binding';

export interface RecentlyEditedCatalogEntity {
  id: string;
  type: CatalogEntityType;
  name: string;
  locator: string;
  storage_type: CatalogStorageType;
  workspace_id: number | null;
  workspace_name: string | null;
  workspace_path: string | null;
  current_file_path: string | null;
  updated_at: number;
}

export type CatalogDatabase = Pick<
  ArtifactIO['db'],
  'select' | 'execute' | 'bindCatalogEntityFile'
> &
  Pick<
    import('../shared/ipc/contract').ClientOf<
      typeof import('../shared/ipc/db.contract').dbContract
    >,
    | 'refreshCatalogFileFingerprints'
    | 'ensureWorkspaceOwner'
    | 'releaseMissingCatalogFilePath'
    | 'writeCatalogWorkspacePlacement'
    | 'removeCatalogWorkspacePlacement'
    | 'registerCatalogEntity'
    | 'registerWorkspaceFile'
    | 'linkCatalogEntities'
    | 'recordCatalogEvent'
    | 'updateCatalogEntityPresentation'
    | 'setCatalogFileState'
    | 'rebindCatalogFiles'
    | 'clearCatalogProjection'
    | 'deleteCatalogEntityIfUnbound'
    | 'deleteCatalogEntityWithExactBinding'
  >;
export interface CatalogRepositoryDependencies {
  db(): CatalogDatabase;
  stat: ArtifactIO['fs']['stat'];
  isHosted(): boolean;
  withMutation: WorkspaceMutationRunner;
}

export function createCatalogRepository(dependencies: CatalogRepositoryDependencies) {
  async function getWorkspaceRootByScope(scope: string): Promise<string | null> {
    const rows = await getConnection().select<Array<{ path: string }>>(
      "SELECT path FROM workspaces WHERE repo_uuid = ? OR (repo_uuid IS NULL AND 'ws' || id = ?)",
      [scope, scope]
    );
    if (rows.length > 1)
      throw Error('The molecular document project identity has ambiguous roots.');
    return rows[0]?.path ?? null;
  }
  async function getCurrentMolecularDocumentFiles(
    projectId?: string
  ): Promise<DBCatalogEntityFile[]> {
    return getConnection().select<DBCatalogEntityFile[]>(
      `SELECT f.* FROM catalog_entity_files f
     JOIN catalog_entities e ON e.id = f.entity_id
     WHERE f.status = 'current' AND e.status = 'active' AND e.type = 'molecular-document'
       ${projectId ? "AND substr(e.id, 1, instr(e.id, '::') - 1) = ?" : ''}`,
      projectId ? [projectId] : []
    );
  }

  const withRendererWorkspaceMutation = dependencies.withMutation;
  async function refreshCurrentCatalogFileFingerprints(
    files: readonly CurrentCatalogFileFingerprint[]
  ): Promise<void> {
    await getConnection().refreshCatalogFileFingerprints(files);
  }

  function getConnection(): CatalogDatabase {
    return dependencies.db();
  }

  function findWorkspaceRootForPath(
    folders: Array<{ path: string }>,
    filePath: string | null | undefined
  ): string | null {
    if (!filePath) return null;
    return findContainingPathBoundary(folders, filePath)?.path ?? null;
  }

  const pendingWorkspaceResolutions = new Map<string, Promise<number | null>>();

  async function resolveWorkspaceId(
    workspaceRoot: string | null | undefined,
    workspaceAccess?: WorkspaceAccess
  ): Promise<number | null> {
    if (!workspaceRoot) return null;
    const key = JSON.stringify([workspaceRoot, workspaceAccess ?? null]);
    const pending = pendingWorkspaceResolutions.get(key);
    if (pending) return pending;
    const resolution = resolveWorkspaceIdOnce(workspaceRoot, workspaceAccess);
    pendingWorkspaceResolutions.set(key, resolution);
    try {
      return await resolution;
    } finally {
      if (pendingWorkspaceResolutions.get(key) === resolution)
        pendingWorkspaceResolutions.delete(key);
    }
  }

  async function resolveWorkspaceIdOnce(
    workspaceRoot: string,
    workspaceAccess?: WorkspaceAccess
  ): Promise<number | null> {
    const existing = await getConnection().select<
      Array<{ id: number; access_mode?: WorkspaceAccess }>
    >('SELECT id,access_mode FROM workspaces WHERE path = ?', [workspaceRoot]);
    if (existing.length === 1 && (!workspaceAccess || existing[0].access_mode === workspaceAccess))
      return existing[0].id;
    return getConnection().ensureWorkspaceOwner(workspaceRoot, workspaceAccess);
  }

  async function getWorkspaceRootById(workspaceId: number | null): Promise<string | null> {
    if (workspaceId == null) return null;
    const sqlite = getConnection();
    const rows = await sqlite.select<Array<{ path: string }>>(
      'SELECT path FROM workspaces WHERE id = ? LIMIT 1',
      [workspaceId]
    );
    return rows[0]?.path ?? null;
  }

  async function resolveWorkspaceScope(
    workspaceRoot: string | null | undefined
  ): Promise<string | null> {
    const workspaceId = await resolveWorkspaceId(workspaceRoot);
    if (workspaceId == null) return null;
    const sqlite = getConnection();
    const rows = await sqlite.select<{ repo_uuid: string | null }[]>(
      'SELECT repo_uuid FROM workspaces WHERE id = ?',
      [workspaceId]
    );
    return workspaceScopeKey(rows[0]?.repo_uuid ?? null, workspaceId);
  }

  async function resolveCatalogEntityIdForWorkspace(
    workspaceRoot: string,
    portableId: string
  ): Promise<string> {
    const scope = await resolveWorkspaceScope(workspaceRoot);
    if (!scope) throw new Error('A workspace-scoped catalog entity requires a workspace scope.');
    return scopedProjectionId(scope, portableId);
  }

  async function getCatalogEntity(id: string): Promise<DBCatalogEntity | null> {
    const sqlite = getConnection();
    const rows = await sqlite.select<DBCatalogEntity[]>(
      'SELECT * FROM catalog_entities WHERE id = ?',
      [id]
    );
    return rows[0] ?? null;
  }

  async function getCatalogEntityForWorkspaceRoot(
    id: string,
    workspaceRoot: string
  ): Promise<DBCatalogEntity | null> {
    const sqlite = getConnection();
    const workspaces = await sqlite.select<Array<{ id: number }>>(
      `SELECT id FROM workspaces
      WHERE path = ?
        AND archived_at IS NULL
        AND trashed_at IS NULL
      LIMIT 1`,
      [workspaceRoot]
    );
    const workspaceId = workspaces[0]?.id;
    if (workspaceId == null) return null;
    const entity = await getCatalogEntity(id);
    return entity?.workspace_id === workspaceId ? entity : null;
  }

  async function getCatalogEntityByLocator(locator: string): Promise<DBCatalogEntity | null> {
    const sqlite = getConnection();
    const rows = await sqlite.select<DBCatalogEntity[]>(
      'SELECT * FROM catalog_entities WHERE locator = ?',
      [locator]
    );
    return rows[0] ?? null;
  }

  async function getCatalogEntityForFilePath(path: string): Promise<DBCatalogEntity | null> {
    const sqlite = getConnection();
    const files = await sqlite.select<DBCatalogEntityFile[]>(
      'SELECT * FROM catalog_entity_files WHERE path = ?',
      [path]
    );
    if (!files[0]) return null;
    return getCatalogEntity(files[0].entity_id);
  }

  async function getCatalogFileForPath(path: string): Promise<DBCatalogEntityFile | null> {
    const sqlite = getConnection();
    const rows = await sqlite.select<DBCatalogEntityFile[]>(
      'SELECT * FROM catalog_entity_files WHERE path = ?',
      [path]
    );
    return rows[0] ?? null;
  }

  async function releaseMissingCatalogFilePath(
    file: DBCatalogEntityFile,
    replacementEntityId: string
  ): Promise<void> {
    await getConnection().releaseMissingCatalogFilePath(file, replacementEntityId);
  }

  async function getCatalogWorkspaceRootForFilePath(path: string): Promise<string | null> {
    const sqlite = getConnection();
    if (dependencies.isHosted()) {
      const [file] = await sqlite.select<Array<{ workspace_id: number | null }>>(
        'SELECT workspace_id FROM catalog_entity_files WHERE path = ? LIMIT 1',
        [path]
      );
      if (file?.workspace_id == null) return null;
      const [workspace] = await sqlite.select<Array<{ path: string }>>(
        'SELECT path FROM workspaces WHERE id = ? LIMIT 1',
        [file.workspace_id]
      );
      return workspace?.path ?? null;
    }
    const rows = await sqlite.select<Array<{ path: string }>>(
      `SELECT workspaces.path AS path
     FROM catalog_entity_files
     JOIN workspaces ON workspaces.id = catalog_entity_files.workspace_id
     WHERE catalog_entity_files.path = ?
     LIMIT 1`,
      [path]
    );
    return rows[0]?.path ?? null;
  }

  async function getCurrentCatalogFileForEntity(
    entityId: string
  ): Promise<DBCatalogEntityFile | null> {
    const files = await getCatalogFilesForEntity(entityId);
    return (
      files
        .filter((file) => file.status === 'current')
        .sort((a, b) => b.updated_at - a.updated_at)[0] ?? null
    );
  }

  async function getCurrentSequenceFileForDocumentId(
    documentId: string
  ): Promise<DBCatalogEntityFile | null> {
    if (dependencies.isHosted()) {
      return getCurrentSequenceFileForDocumentIdOnHosted(documentId);
    }
    const files = await getConnection().select<DBCatalogEntityFile[]>(
      `SELECT f.* FROM catalog_entity_files f
       JOIN catalog_entities e ON e.id = f.entity_id
       WHERE f.status = 'current' AND e.status = 'active'
         AND (e.type IN ('sequence', 'trace')
           OR f.file_kind IN (${SEQUENCE_PACKAGE_FILE_KIND_ALIASES.map(() => '?').join(',')})
           OR (e.type = 'file' AND f.file_kind IN (${TEXT_SEQUENCE_FILE_KINDS.map(() => '?').join(',')})))
         AND (f.entity_id = ? OR f.entity_id IN
           (SELECT entity_id FROM catalog_entity_files WHERE object_uuid = ?))
       LIMIT 2`,
      [...SEQUENCE_PACKAGE_FILE_KIND_ALIASES, ...TEXT_SEQUENCE_FILE_KINDS, documentId, documentId]
    );
    if (files.length > 1) {
      throw new Error(`Ambiguous sequence document identity: ${documentId}.`);
    }
    return files[0] ?? null;
  }

  async function getCurrentSequenceFileForDocumentIdOnHosted(
    documentId: string
  ): Promise<DBCatalogEntityFile | null> {
    const sqlite = getConnection();
    const currentByEntity = await sqlite.select<DBCatalogEntityFile[]>(
      'SELECT * FROM catalog_entity_files WHERE status = ? AND entity_id = ?',
      ['current', documentId]
    );
    const uuidMatches = await sqlite.select<Array<{ entity_id: string }>>(
      'SELECT entity_id FROM catalog_entity_files WHERE object_uuid = ?',
      [documentId]
    );
    const extraIds = [
      ...new Set(
        uuidMatches
          .map((row) => row.entity_id)
          .filter((entityId): entityId is string => Boolean(entityId) && entityId !== documentId)
      ),
    ];
    const currentByUuid: DBCatalogEntityFile[] = [];
    for (const entityId of extraIds) {
      currentByUuid.push(
        ...(await sqlite.select<DBCatalogEntityFile[]>(
          'SELECT * FROM catalog_entity_files WHERE status = ? AND entity_id = ?',
          ['current', entityId]
        ))
      );
    }
    const matching: DBCatalogEntityFile[] = [];
    const seen = new Set<string>();
    for (const file of [...currentByEntity, ...currentByUuid]) {
      if (seen.has(file.id)) continue;
      seen.add(file.id);
      const entity = await getCatalogEntity(file.entity_id);
      if (!entity || entity.status !== 'active') continue;
      if (
        entity.type !== 'sequence' &&
        entity.type !== 'trace' &&
        !(SEQUENCE_PACKAGE_FILE_KIND_ALIASES as readonly string[]).includes(file.file_kind) &&
        !(entity.type === 'file' && isTextSequenceFileKind(file.file_kind))
      ) {
        continue;
      }
      matching.push(file);
    }
    if (matching.length > 1) {
      throw new Error(`Ambiguous sequence document identity: ${documentId}.`);
    }
    return matching[0] ?? null;
  }

  function normalizeCatalogSiblingName(displayName: string): string {
    const normalized = normalizeCatalogDisplayName(displayName).toLowerCase();
    if (!normalized) throw new Error('Catalog workspace placement display name is required.');
    return normalized;
  }

  async function writeCatalogWorkspacePlacement(
    input: WriteCatalogWorkspacePlacementInput
  ): Promise<DBCatalogWorkspacePlacement> {
    return getConnection().writeCatalogWorkspacePlacement(input);
  }

  async function getCatalogWorkspacePlacement(
    entityId: string
  ): Promise<DBCatalogWorkspacePlacement | null> {
    requireCatalogEntityId(entityId);
    const sqlite = getConnection();
    const rows = await sqlite.select<DBCatalogWorkspacePlacement[]>(
      'SELECT * FROM catalog_workspace_placements WHERE entity_id = ? LIMIT 1',
      [entityId]
    );
    return rows[0] ?? null;
  }

  async function getCatalogWorkspacePlacementsForParent(input: {
    workspaceId: number;
    parentRelativePath: string;
  }): Promise<DBCatalogWorkspacePlacement[]> {
    const workspaceId = requireWorkspaceId(input.workspaceId);
    const parentRelativePath = normalizeCatalogParentRelativePath(input.parentRelativePath);
    const sqlite = getConnection();
    return sqlite.select<DBCatalogWorkspacePlacement[]>(
      `SELECT * FROM catalog_workspace_placements
     WHERE workspace_id = ? AND parent_relative_path = ? AND status = 'active'
     ORDER BY normalized_sibling_name ASC, entity_id ASC`,
      [workspaceId, parentRelativePath]
    );
  }

  async function moveCatalogWorkspacePlacement(input: {
    entityId: string;
    workspaceId: number;
    parentRelativePath: string;
    displayName: string;
  }): Promise<DBCatalogWorkspacePlacement> {
    const existing = await getCatalogWorkspacePlacement(input.entityId);
    if (!existing) throw new Error(`Catalog workspace placement does not exist: ${input.entityId}`);
    return writeCatalogWorkspacePlacement({
      ...input,
      presentationKind: existing.presentation_kind,
      status: existing.status,
    });
  }

  async function deactivateCatalogWorkspacePlacement(entityId: string): Promise<boolean> {
    return getConnection().removeCatalogWorkspacePlacement(entityId, 'hide');
  }

  async function deleteCatalogWorkspacePlacement(entityId: string): Promise<boolean> {
    return getConnection().removeCatalogWorkspacePlacement(entityId, 'delete');
  }

  function normalizeCatalogDisplayName(value: string): string {
    if (typeof value !== 'string') throw new Error('Catalog workspace placement name is invalid.');
    const normalized = value.trim().normalize('NFC');
    if (!normalized) throw new Error('Catalog workspace placement display name is required.');
    return normalized;
  }

  function normalizeCatalogParentRelativePath(value: string): string {
    if (typeof value !== 'string') throw new Error('Catalog workspace parent path is invalid.');
    const normalized = value.normalize('NFC').replace(/\\/g, '/');
    if (normalized === '') return normalized;
    if (!isSafeWorkspaceRelativePath(normalized)) {
      throw new Error('Catalog workspace parent path is unsafe.');
    }
    const topLevel = normalized.split('/')[0]?.toLowerCase();
    if (topLevel && ['.git', '.dnaforge', '.forge', '.waypoint'].includes(topLevel)) {
      throw new Error('Catalog workspace parent path uses a protected root.');
    }
    return normalized;
  }

  function requireCatalogEntityId(value: string): string {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error('Catalog workspace placement entity ID is required.');
    }
    return value;
  }

  function requireWorkspaceId(value: number): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error('Catalog workspace placement workspace ID is invalid.');
    }
    return value;
  }

  async function registerCatalogEntity(
    input: RegisterCatalogEntityInput
  ): Promise<DBCatalogEntity> {
    await resolveWorkspaceId(input.workspaceRoot, input.workspaceAccess);
    const { workspaceAccess: _workspaceAccess, ...request } = input;
    return getConnection().registerCatalogEntity(request);
  }

  const workspaceFileRegistrationTails = new Map<string, Promise<void>>();

  async function registerWorkspaceFileOnce(
    input: RegisterWorkspaceFileInput
  ): Promise<DBCatalogEntity> {
    await resolveWorkspaceId(input.workspaceRoot, input.workspaceAccess);
    const { workspaceAccess: _workspaceAccess, mutationToken, ...request } = input;
    return getConnection().registerWorkspaceFile(request, mutationToken);
  }

  async function registerWorkspaceFile(
    input: RegisterWorkspaceFileInput
  ): Promise<DBCatalogEntity> {
    if (input.workspaceRoot && !input.mutationToken) {
      await resolveWorkspaceId(input.workspaceRoot, input.workspaceAccess);
      return withRendererWorkspaceMutation(
        input.workspaceRoot,
        (mutationToken) => registerWorkspaceFileSerialized({ ...input, mutationToken }),
        undefined,
        { waitForAvailability: true }
      );
    }
    return registerWorkspaceFileSerialized(input);
  }

  async function registerWorkspaceFileSerialized(
    input: RegisterWorkspaceFileInput
  ): Promise<DBCatalogEntity> {
    const previous = workspaceFileRegistrationTails.get(input.path) ?? Promise.resolve();
    let unlock!: () => void;
    const current = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    workspaceFileRegistrationTails.set(input.path, tail);

    await previous.catch(() => undefined);
    try {
      return await registerWorkspaceFileOnce(input);
    } finally {
      unlock();
      if (workspaceFileRegistrationTails.get(input.path) === tail) {
        workspaceFileRegistrationTails.delete(input.path);
      }
    }
  }

  async function bindCatalogEntityToFile(
    input: BindCatalogEntityFileInput
  ): Promise<DBCatalogEntityFile> {
    const workspaceId = await resolveWorkspaceId(input.workspaceRoot);
    const { mutationToken, ...request } = input;
    const workspaceRoot = input.workspaceRoot;
    const files =
      workspaceRoot && !mutationToken ? await getCatalogFilesForEntity(input.entityId) : [];
    if (
      workspaceRoot &&
      !mutationToken &&
      files.every(
        (file) => file.workspace_id === workspaceId && pathIsAtOrUnder(file.path, workspaceRoot)
      )
    )
      return withRendererWorkspaceMutation(
        workspaceRoot,
        (token) => getConnection().bindCatalogEntityFile(request, token),
        undefined,
        { waitForAvailability: true }
      );
    return getConnection().bindCatalogEntityFile(request, mutationToken);
  }
  async function linkCatalogEntities(
    input: import('../shared/catalog-associations').CatalogEntityLinkInput
  ): Promise<DBCatalogEntityLink> {
    return getConnection().linkCatalogEntities(input);
  }
  async function recordCatalogEvent(
    input: import('../shared/catalog-associations').CatalogEventInput
  ): Promise<DBCatalogEntityEvent> {
    return getConnection().recordCatalogEvent(input);
  }

  async function updateCatalogEntityMetadata(
    entityId: string,
    patch: Record<string, unknown>
  ): Promise<DBCatalogEntity | null> {
    return getConnection().updateCatalogEntityPresentation({ entityId, metadataPatch: patch });
  }

  async function updateCatalogEntityName(
    entityId: string,
    name: string
  ): Promise<DBCatalogEntity | null> {
    return getConnection().updateCatalogEntityPresentation({ entityId, name });
  }

  async function markCatalogFileMissing(
    path: string,
    reason = 'not-seen-during-reconcile'
  ): Promise<DBCatalogEntityFile | null> {
    return getConnection().setCatalogFileState(path, 'missing', reason);
  }

  async function markCatalogFileHistorical(
    path: string,
    reason = 'replaced-by-new-current-binding'
  ): Promise<DBCatalogEntityFile | null> {
    return getConnection().setCatalogFileState(path, 'historical', reason);
  }

  async function markCatalogPathMissing(
    path: string,
    reason = 'not-seen-during-reconcile'
  ): Promise<{ updated: number }> {
    const files = await getCatalogFilesUnderPath(path);
    if (files.length === 0) {
      const file = await markCatalogFileMissing(path, reason);
      return { updated: file ? 1 : 0 };
    }

    let updated = 0;
    for (const file of files.sort((a, b) => a.path.length - b.path.length)) {
      const changed = await markCatalogFileMissing(file.path, reason);
      if (changed) updated++;
    }
    return { updated };
  }

  async function rebindCatalogFilePath(
    input: import('../shared/catalog-registration').CatalogFileRebindRequest & {
      mutationToken?: string;
    }
  ): Promise<{ updated: number; missingOldPath: boolean }> {
    const { mutationToken, ...request } = input;
    return getConnection().rebindCatalogFiles(request, mutationToken);
  }

  async function clearCatalogProjectionForWorkspaceRoot(workspaceRoot: string): Promise<{
    workspaceId: number | null;
    entities: number;
    files: number;
    links: number;
    events: number;
  }> {
    return getConnection().clearCatalogProjection(workspaceRoot);
  }

  async function registerContextualCatalogEntity(
    input: RegisterContextualEntityInput
  ): Promise<DBCatalogEntity> {
    const entity = await registerCatalogEntity({
      id: input.id,
      type: input.type,
      name: input.name,
      locator: input.locator,
      storageType: input.storageType,
      workspaceRoot: input.workspaceRoot,
      metadata: {
        ...(input.metadata ?? {}),
        creationContext: input.context ?? null,
      },
    });

    if (input.context?.targetPath && input.context.targetKind) {
      const target =
        (await getCatalogEntityForFilePath(input.context.targetPath)) ??
        (await registerWorkspaceFile({
          path: input.context.targetPath,
          entityType: input.context.targetKind,
          fileKind: input.context.targetKind,
          workspaceRoot: input.workspaceRoot,
          metadata: { discoveredFrom: 'creation-context' },
          mutationToken: input.mutationToken,
        }));
      await linkCatalogEntities({
        sourceEntityId: entity.id,
        relation: input.context.targetKind === 'folder' ? 'created_in' : 'created_beside',
        targetEntityId: target.id,
        confidence: 'confirmed',
        evidence: {
          source: 'file-explorer-new-menu',
          parentPath: input.context.parentPath ?? null,
        },
      });
    }

    return entity;
  }

  async function getCatalogFilesForEntity(entityId: string): Promise<DBCatalogEntityFile[]> {
    const sqlite = getConnection();
    return sqlite.select<DBCatalogEntityFile[]>(
      'SELECT * FROM catalog_entity_files WHERE entity_id = ?',
      [entityId]
    );
  }

  async function repairDuplicateCurrentBindings(): Promise<{
    entities: number;
    demoted: number;
  }> {
    const sqlite = getConnection();
    const all = await sqlite.select<DBCatalogEntityFile[]>('SELECT * FROM catalog_entity_files');
    const currents = all.filter((file) => file.status === 'current');
    const byEntity = new Map<string, DBCatalogEntityFile[]>();
    for (const file of currents) {
      const list = byEntity.get(file.entity_id) ?? [];
      list.push(file);
      byEntity.set(file.entity_id, list);
    }
    let entities = 0;
    let demoted = 0;
    for (const files of byEntity.values()) {
      if (files.length <= 1) continue;
      entities++;
      const canonical = pickCanonicalBinding(files);
      for (const file of files) {
        if (file.path === canonical.path) continue;
        await markCatalogFileHistorical(file.path, 'duplicate-current-binding-repair');
        demoted++;
      }
    }
    return { entities, demoted };
  }

  async function getCatalogFilesUnderPath(rootPath: string): Promise<DBCatalogEntityFile[]> {
    const sqlite = getConnection();
    const rows = await sqlite.select<DBCatalogEntityFile[]>('SELECT * FROM catalog_entity_files');
    return rows.filter((file) => pathIsAtOrUnder(file.path, rootPath));
  }

  async function getCatalogLinksForEntity(entityId: string): Promise<DBCatalogEntityLink[]> {
    const sqlite = getConnection();
    return sqlite.select<DBCatalogEntityLink[]>(
      `SELECT * FROM catalog_entity_links
     WHERE source_entity_id = ? OR target_entity_id = ?
     ORDER BY updated_at DESC`,
      [entityId, entityId]
    );
  }

  async function getCatalogEventsForEntity(entityId: string): Promise<DBCatalogEntityEvent[]> {
    const sqlite = getConnection();
    return sqlite.select<DBCatalogEntityEvent[]>(
      `SELECT * FROM catalog_entity_events
     WHERE entity_id = ?
     ORDER BY created_at DESC`,
      [entityId]
    );
  }

  async function findConstructIdForAcceptedAssemblyVersion(
    acceptedAssemblyVersionId: string
  ): Promise<string | null> {
    const sqlite = getConnection();
    const rows = await sqlite.select<DBCatalogEntityEvent[]>(
      `SELECT * FROM catalog_entity_events
     WHERE event_type = 'assembly_finalized'
     ORDER BY created_at DESC`
    );
    for (const row of rows) {
      if (!row.payload) continue;
      try {
        const payload = JSON.parse(row.payload) as Record<string, unknown>;
        if (payload.acceptedAssemblyVersionId === acceptedAssemblyVersionId) return row.entity_id;
      } catch {}
    }
    return null;
  }

  async function listFinalizedAssemblyConstructIds(): Promise<string[]> {
    const sqlite = getConnection();
    const distinct = (rows: readonly { entity_id: string }[]): string[] => {
      const ordered: string[] = [];
      const seen = new Set<string>();
      for (const row of rows) {
        if (seen.has(row.entity_id)) continue;
        seen.add(row.entity_id);
        ordered.push(row.entity_id);
      }
      return ordered;
    };
    const finalized = distinct(
      await sqlite.select<{ entity_id: string }[]>(
        `SELECT entity_id FROM catalog_entity_events
         WHERE event_type = 'assembly_finalized'
         ORDER BY created_at DESC`
      )
    );
    if (finalized.length > 0) return finalized;
    return distinct(
      await sqlite.select<{ entity_id: string }[]>(
        `SELECT entity_id FROM catalog_entity_files
         WHERE status = 'current'
           AND file_kind IN (${SEQUENCE_PACKAGE_FILE_KIND_ALIASES.map(() => '?').join(',')})`,
        [...SEQUENCE_PACKAGE_FILE_KIND_ALIASES]
      )
    );
  }

  async function deleteCatalogEntityIfUnbound(entityId: string): Promise<boolean> {
    return getConnection().deleteCatalogEntityIfUnbound(entityId);
  }

  async function deleteCatalogEntityWithExactBinding(input: {
    entityId: string;
    path: string;
    fileKind: string;
  }): Promise<boolean> {
    return getConnection().deleteCatalogEntityWithExactBinding(input);
  }

  async function getRecentlyEditedCatalogEntities(
    limit: number = 10
  ): Promise<RecentlyEditedCatalogEntity[]> {
    const sqlite = getConnection();
    const safeLimit = Math.max(1, Math.min(100, Math.floor(Number.isFinite(limit) ? limit : 10)));
    const [entities, workspaceRows, catalogFiles] = await Promise.all([
      sqlite.select<DBCatalogEntity[]>('SELECT * FROM catalog_entities'),
      sqlite.select<
        {
          id: number;
          name: string;
          path: string;
          archived_at: number | null;
          trashed_at: number | null;
          access_mode?: WorkspaceAccess;
        }[]
      >('SELECT * FROM workspaces'),
      sqlite.select<DBCatalogEntityFile[]>('SELECT * FROM catalog_entity_files'),
    ]);
    const workspaceById = new Map(workspaceRows.map((w) => [w.id, w]));
    const filesByEntity = new Map<string, DBCatalogEntityFile[]>();
    for (const file of catalogFiles) {
      if (file.status !== 'current') continue;
      const files = filesByEntity.get(file.entity_id) ?? [];
      files.push(file);
      filesByEntity.set(file.entity_id, files);
    }
    const isWorkspaceHidden = (workspaceId: number | null) => {
      if (workspaceId == null) return false;
      const workspace = workspaceById.get(workspaceId);
      return (
        !!workspace &&
        (!workspaceCanContributeRecentEdits(workspace.access_mode) ||
          !!workspace.archived_at ||
          !!workspace.trashed_at)
      );
    };

    return entities
      .filter(
        (entity) =>
          entity.type !== 'notebook' &&
          entity.status === 'active' &&
          !isWorkspaceHidden(entity.workspace_id)
      )
      .sort((a, b) => b.updated_at - a.updated_at)
      .slice(0, safeLimit)
      .map((entity) => {
        const workspace =
          entity.workspace_id != null ? workspaceById.get(entity.workspace_id) : null;
        const files = (filesByEntity.get(entity.id) ?? []).filter(
          (file) =>
            workspace != null &&
            file.workspace_id === entity.workspace_id &&
            pathIsAtOrUnder(file.path, workspace.path)
        );
        return {
          id: entity.id,
          type: entity.type,
          name: entity.name,
          locator: entity.locator,
          storage_type: entity.storage_type,
          workspace_id: entity.workspace_id,
          workspace_name: workspace?.name ?? null,
          workspace_path: workspace?.path ?? null,
          current_file_path:
            entity.storage_type === 'file' && files.length
              ? pickCanonicalBinding(files).path
              : null,
          updated_at: entity.updated_at,
        };
      });
  }
  return {
    getWorkspaceRootByScope,
    getCurrentMolecularDocumentFiles,
    refreshCurrentCatalogFileFingerprints,
    findWorkspaceRootForPath,
    resolveWorkspaceId,
    getWorkspaceRootById,
    resolveWorkspaceScope,
    resolveCatalogEntityIdForWorkspace,
    getCatalogEntity,
    getCatalogEntityForWorkspaceRoot,
    getCatalogEntityByLocator,
    getCatalogEntityForFilePath,
    getCatalogFileForPath,
    releaseMissingCatalogFilePath,
    getCatalogWorkspaceRootForFilePath,
    getCurrentCatalogFileForEntity,
    getCurrentSequenceFileForDocumentId,
    normalizeCatalogSiblingName,
    writeCatalogWorkspacePlacement,
    getCatalogWorkspacePlacement,
    getCatalogWorkspacePlacementsForParent,
    moveCatalogWorkspacePlacement,
    deactivateCatalogWorkspacePlacement,
    deleteCatalogWorkspacePlacement,
    registerCatalogEntity,
    registerWorkspaceFile,
    bindCatalogEntityToFile,
    linkCatalogEntities,
    recordCatalogEvent,
    updateCatalogEntityMetadata,
    updateCatalogEntityName,
    markCatalogFileMissing,
    markCatalogFileHistorical,
    markCatalogPathMissing,
    rebindCatalogFilePath,
    clearCatalogProjectionForWorkspaceRoot,
    registerContextualCatalogEntity,
    getCatalogFilesForEntity,
    repairDuplicateCurrentBindings,
    getCatalogFilesUnderPath,
    getCatalogLinksForEntity,
    getCatalogEventsForEntity,
    findConstructIdForAcceptedAssemblyVersion,
    listFinalizedAssemblyConstructIds,
    deleteCatalogEntityIfUnbound,
    deleteCatalogEntityWithExactBinding,
    getRecentlyEditedCatalogEntities,
  };
}
