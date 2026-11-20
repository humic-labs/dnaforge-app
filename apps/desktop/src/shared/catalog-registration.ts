import { hasWorkspaceScope, scopedProjectionId } from './workspace-scoped-identity';
import { CATALOG_ENTITY_TYPES, type CatalogEntityType } from './catalog-entity';
import { REGISTRY_ARTIFACT_SEARCH_PROJECTION_KEY } from './registry-file-types';

export type CatalogStorageType = 'file' | 'database' | 'localStorage' | 'sidecar' | 'external';
export type CatalogEntityStatus = 'active' | 'missing' | 'archived' | 'conflict';

export interface CatalogEntityRow {
  id: string;
  type: CatalogEntityType;
  name: string;
  locator: string;
  storage_type: CatalogStorageType;
  status: CatalogEntityStatus;
  workspace_id: number | null;
  metadata: string | null;
  created_at: number;
  updated_at: number;
}

export interface CatalogEntityRegistrationRequest {
  id?: string;
  type: CatalogEntityType;
  name: string;
  locator: string;
  storageType: CatalogStorageType;
  status?: string;
  workspaceRoot?: string | null;
  metadata?: Record<string, unknown> | null;
  preserveExistingName?: boolean;
}

export function parseCatalogEntityRegistration(value: unknown): CatalogEntityRegistrationRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Catalog registration must be an object.');
  const input = value as CatalogEntityRegistrationRequest;
  for (const [field, value] of Object.entries({ name: input.name, locator: input.locator }))
    if (typeof value !== 'string' || !value.trim() || value.includes('\0'))
      throw new Error(`Catalog registration ${field} is invalid.`);
  if (
    input.id !== undefined &&
    (typeof input.id !== 'string' || !input.id.trim() || input.id.includes('\0'))
  )
    throw new Error('Catalog registration identity is invalid.');
  if (!CATALOG_ENTITY_TYPES.some((kind) => kind === input.type))
    throw new Error('Catalog registration kind is invalid.');
  if (!['file', 'database', 'localStorage', 'sidecar', 'external'].includes(input.storageType))
    throw new Error('Catalog registration storage type is invalid.');
  if (
    input.status !== undefined &&
    !['active', 'missing', 'archived', 'conflict'].includes(input.status)
  )
    throw new Error('Catalog registration status is invalid.');
  if (
    input.workspaceRoot !== undefined &&
    input.workspaceRoot !== null &&
    (typeof input.workspaceRoot !== 'string' ||
      !input.workspaceRoot.trim() ||
      input.workspaceRoot.includes('\0'))
  )
    throw new Error('Catalog registration workspace is invalid.');
  if (
    input.metadata != null &&
    (typeof input.metadata !== 'object' || Array.isArray(input.metadata))
  )
    throw new Error('Catalog registration metadata is invalid.');
  if (input.preserveExistingName !== undefined && typeof input.preserveExistingName !== 'boolean')
    throw new Error('Catalog registration name policy is invalid.');
  return input;
}

export function planCatalogEntityRegistration(
  inputValue: unknown,
  workspaceId: number | null,
  entities: readonly CatalogEntityRow[],
  now: number,
  createId: () => string,
  workspaceScope: string | null
): CatalogEntityRow {
  const input = parseCatalogEntityRegistration(inputValue);
  const matchedId = input.id ? entities.find((entity) => entity.id === input.id) : undefined;
  const byId =
    matchedId &&
    input.storageType === 'file' &&
    matchedId.workspace_id === workspaceId &&
    isRegistrySearchProjection(matchedId)
      ? undefined
      : matchedId;
  const byLocator = entities.find((entity) => entity.locator === input.locator);
  if (input.id && byLocator && byLocator.id !== input.id)
    throw new Error('Catalog locator belongs to another entity identity.');
  if (byId && byId.locator !== input.locator)
    throw new Error('Catalog identity has a different locator; use the owned relocation command.');
  const existing = byId ?? byLocator;
  const id = existing?.id ?? input.id ?? createId();
  if (hasWorkspaceScope(id) && scopedProjectionId(workspaceScope, id) !== id)
    throw new Error('Catalog identity carries a different workspace owner scope.');
  if (existing && existing.workspace_id !== workspaceId)
    throw new Error('Catalog identity belongs to a different workspace owner.');
  const looseFile =
    existing?.locator.startsWith('file://') &&
    existing.storage_type === 'file' &&
    input.storageType === 'file';
  if (
    existing &&
    existing.type !== input.type &&
    !(looseFile && (existing.type === 'file' || input.type === 'file'))
  )
    throw new Error('Catalog identity belongs to a different entity kind.');
  if (existing && existing.storage_type !== input.storageType)
    throw new Error('Catalog identity has a different storage owner.');
  return {
    id,
    type: existing && looseFile && input.type === 'file' ? existing.type : input.type,
    name: input.preserveExistingName && existing ? existing.name : input.name,
    locator: input.locator,
    storage_type: input.storageType,
    status: (input.status ?? 'active') as CatalogEntityStatus,
    workspace_id: workspaceId,
    metadata: input.metadata == null ? null : JSON.stringify(input.metadata),
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
}

function isRegistrySearchProjection(entity: CatalogEntityRow): boolean {
  if (
    entity.type !== 'record' ||
    entity.storage_type !== 'database' ||
    entity.locator !== `entity://lims/${entity.id}`
  )
    return false;
  try {
    return JSON.parse(entity.metadata ?? '{}')?.[REGISTRY_ARTIFACT_SEARCH_PROJECTION_KEY] === true;
  } catch {
    return false;
  }
}

export interface CatalogFileRebindRequest {
  oldPath: string;
  newPath: string;
  workspaceRoot?: string | null;
  actor?: string;
  targetFileKind?: string;
}

export interface CatalogProjectionClearResult {
  workspaceId: number | null;
  entities: number;
  files: number;
  links: number;
  events: number;
}

export const CATALOG_RESET_RETAINED_MESSAGE =
  'Recovery requires an empty workspace catalog. The populated catalog and its history were preserved.';

export const CATALOG_ROLLBACK_RETAINED_MESSAGE =
  'The catalog entity was already committed. Its record and file were preserved.';

export interface CatalogEntityRollbackRequest {
  entityId: string;
  path: string;
  fileKind: string;
}

export interface CatalogWorkspaceFileRegistrationRequest {
  path: string;
  name?: string;
  entityType?: CatalogEntityType;
  fileKind?: string;
  workspaceRoot?: string | null;
  contentHash?: string | null;
  sizeBytes?: number | null;
  modifiedAt?: number | null;
  metadata?: Record<string, unknown> | null;
}

export type CatalogFileFingerprint = Pick<
  import('./catalog-binding').CatalogFileBindingRow,
  | 'id'
  | 'entity_id'
  | 'workspace_id'
  | 'path'
  | 'object_uuid'
  | 'file_kind'
  | 'content_hash'
  | 'size_bytes'
  | 'modified_at'
>;
