import { inferCatalogFileKind } from './catalog-file-kind';
import { pathRelativeToBoundary } from './path-boundary';

export type CatalogFileBindingStatus = 'current' | 'missing' | 'historical' | 'conflict';

export interface CatalogFileBindingRequest {
  entityId: string;
  path: string;
  fileKind?: string;
  workspaceRoot?: string | null;
  contentHash?: string | null;
  sizeBytes?: number | null;
  modifiedAt?: number | null;
  status?: CatalogFileBindingStatus;
  lastSeenAt?: number | null;
  missingSince?: number | null;
  objectUuid?: string;
  supersedesMovedPath?: string;
}

export interface CatalogFileBindingRow {
  id: string;
  entity_id: string;
  workspace_id: number | null;
  path: string;
  relative_path: string | null;
  file_kind: string;
  content_hash: string | null;
  sequence_fingerprint: string | null;
  object_uuid: string | null;
  size_bytes: number | null;
  modified_at: number | null;
  status: CatalogFileBindingStatus;
  last_seen_at: number | null;
  missing_since: number | null;
  created_at: number;
  updated_at: number;
}

export const ADOPT_OBJECT_UUID_SQL = `SELECT id, object_uuid, content_hash, size_bytes, modified_at
      FROM catalog_entity_files
      WHERE content_hash = ?
        AND status = 'missing'
        AND object_uuid IS NOT NULL
        AND workspace_id IS ?`;

export const SAVED_FILE_RESTORE_STAGE_PREFIX = '.dnaforge-file-restore-';
function isSavedFileRestoreStagePath(path: string): boolean {
  return path
    .split(/[\\/]/)
    .some(
      (member) =>
        member.toLowerCase().startsWith(SAVED_FILE_RESTORE_STAGE_PREFIX) &&
        /^[a-z0-9]{6}$/i.test(member.slice(SAVED_FILE_RESTORE_STAGE_PREFIX.length))
    );
}

export function assertPublishedCatalogFilePath(path: string): void {
  if (isSavedFileRestoreStagePath(path))
    throw new Error('A package being restored cannot be cataloged until publication is complete.');
}

export function parseCatalogFileBindingRequest(value: unknown): CatalogFileBindingRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Catalog file binding request must be an object.');
  }
  const input = value as CatalogFileBindingRequest;
  if (typeof input.entityId !== 'string' || !input.entityId.trim() || input.entityId.length > 512) {
    throw new Error('Catalog file binding identity is invalid.');
  }
  if (typeof input.path !== 'string' || !input.path.trim() || input.path.includes('\0')) {
    throw new Error('Catalog file binding path is invalid.');
  }
  assertPublishedCatalogFilePath(input.path);
  for (const value of [input.fileKind, input.objectUuid, input.supersedesMovedPath]) {
    if (value !== undefined && (typeof value !== 'string' || !value.trim())) {
      throw new Error('Catalog file binding kind or object identity is invalid.');
    }
  }
  for (const value of [input.workspaceRoot, input.contentHash]) {
    if (value !== undefined && value !== null && (typeof value !== 'string' || !value.trim())) {
      throw new Error('Catalog file binding workspace or content hash is invalid.');
    }
  }
  for (const value of [input.modifiedAt, input.lastSeenAt, input.missingSince]) {
    if (
      value !== undefined &&
      value !== null &&
      (typeof value !== 'number' || !Number.isFinite(value))
    ) {
      throw new Error('Catalog file binding timestamp is invalid.');
    }
  }
  if (
    input.sizeBytes !== undefined &&
    input.sizeBytes !== null &&
    (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0)
  ) {
    throw new Error('Catalog file binding size is invalid.');
  }
  if (
    input.status !== undefined &&
    !['current', 'missing', 'historical', 'conflict'].includes(input.status)
  ) {
    throw new Error('Catalog file binding status is invalid.');
  }
  if (input.workspaceRoot && pathRelativeToBoundary(input.path, input.workspaceRoot) === null) {
    throw new Error('Catalog file binding path is outside its declared workspace.');
  }
  return input;
}

export function buildCatalogFileBindingRow(
  input: CatalogFileBindingRequest,
  workspaceId: number | null,
  existing: CatalogFileBindingRow | undefined,
  now: number,
  createId: () => string,
  sequenceFingerprint?: string | null
): CatalogFileBindingRow {
  if (existing && existing.entity_id !== input.entityId)
    throw new Error('Catalog file path belongs to another entity identity.');
  if (existing && existing.workspace_id !== workspaceId)
    throw new Error('Catalog file identity belongs to a different workspace owner.');
  const contentHash = input.contentHash ?? existing?.content_hash ?? null;
  return {
    id: existing?.id ?? createId(),
    entity_id: input.entityId,
    workspace_id: workspaceId,
    path: input.path,
    relative_path: input.workspaceRoot
      ? pathRelativeToBoundary(input.path, input.workspaceRoot)
      : null,
    file_kind: input.fileKind ?? inferCatalogFileKind(input.path),
    content_hash: contentHash,
    sequence_fingerprint:
      sequenceFingerprint !== undefined
        ? sequenceFingerprint
        : existing && existing.content_hash === contentHash
          ? (existing.sequence_fingerprint ?? null)
          : null,
    object_uuid: existing?.object_uuid ?? input.objectUuid ?? createId(),
    size_bytes: input.sizeBytes ?? existing?.size_bytes ?? null,
    modified_at: input.modifiedAt ?? existing?.modified_at ?? null,
    status: input.status ?? 'current',
    last_seen_at: input.lastSeenAt ?? now,
    missing_since: input.missingSince ?? null,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
}

export function planCatalogMemoryFileBinding(
  inputValue: unknown,
  workspaceId: number | null,
  files: readonly CatalogFileBindingRow[],
  now: number,
  createId: () => string
): {
  binding: CatalogFileBindingRow;
  files: CatalogFileBindingRow[];
  events: Array<Record<string, string | number>>;
} {
  const input = parseCatalogFileBindingRequest(inputValue);
  let existing = files.find((file) => file.path === input.path);
  if (!existing && input.contentHash?.startsWith('sha256:')) {
    const candidates = files.filter(
      (file) =>
        file.entity_id === input.entityId &&
        file.content_hash === input.contentHash &&
        file.workspace_id === workspaceId &&
        file.status === 'missing' &&
        file.object_uuid != null
    );
    if (candidates.length === 1) existing = candidates[0];
  }
  const binding = buildCatalogFileBindingRow(input, workspaceId, existing, now, createId);
  const events: Array<Record<string, string | number>> = [];
  const nextFiles = files.map((file) => {
    if (file.id === binding.id) return binding;
    if (
      binding.status === 'current' &&
      file.entity_id === input.entityId &&
      file.status === 'current'
    ) {
      events.push({
        id: createId(),
        entity_id: file.entity_id,
        event_type: 'file_historical',
        actor: 'user',
        summary: 'Catalog file binding is historical',
        created_at: now,
        payload: JSON.stringify({
          path: file.path,
          reason: 'superseded-current-binding',
          fileKind: file.file_kind,
        }),
      });
      return { ...file, status: 'historical' as const, updated_at: now };
    }
    return file;
  });
  if (!existing) nextFiles.push(binding);
  if (
    nextFiles.some(
      (file) =>
        file.id !== binding.id &&
        file.object_uuid != null &&
        file.object_uuid === binding.object_uuid
    )
  ) {
    throw new Error('Catalog object identity is already bound to another file.');
  }
  return { binding, files: nextFiles, events };
}
