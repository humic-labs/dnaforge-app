import { createDesktopSyncClient, type DesktopSyncClient } from './desktop-sync-client';
import {
  parseWorkspaceSyncHistoryOptions,
  type WorkspaceSyncHistoryOptions,
  type WorkspaceSyncHistoryVersion,
  type WorkspaceSyncVersionHistory,
} from '../shared/workspace-sync-ipc';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SHA256_RE = /^[0-9a-f]{64}$/u;

export async function listWorkspaceSyncHistory(
  remoteWorkspaceId: string,
  options: WorkspaceSyncHistoryOptions = {},
  client: Pick<DesktopSyncClient, 'requestJson'> = createDesktopSyncClient()
): Promise<WorkspaceSyncVersionHistory> {
  if (!UUID_RE.test(remoteWorkspaceId)) throw new Error('remoteWorkspaceId must be a UUID');
  const parsed = parseWorkspaceSyncHistoryOptions(options);
  const limit = parsed.limit ?? 50;
  const query = new URLSearchParams({ limit: String(limit) });
  if (parsed.beforeVersionNumber !== undefined) {
    query.set('beforeVersionNumber', String(parsed.beforeVersionNumber));
  }
  const response = await client.requestJson<unknown>(
    `/api/desktop-sync/workspaces/${remoteWorkspaceId}/versions?${query}`,
    { method: 'GET' }
  );
  return parseHistory(response, remoteWorkspaceId, limit, parsed.beforeVersionNumber);
}

function parseHistory(
  value: unknown,
  workspaceId: string,
  limit: number,
  before?: number
): WorkspaceSyncVersionHistory {
  if (
    !isRecord(value) ||
    value.workspaceId !== workspaceId ||
    !Array.isArray(value.versions) ||
    value.versions.length > limit
  ) {
    throw new Error('Workspace history returned an invalid response');
  }
  const versions = value.versions.map(parseVersion);
  const seen = new Set<string>();
  let previous = before ?? Infinity;
  for (const version of versions) {
    if (seen.has(version.id) || version.versionNumber >= previous) {
      throw new Error('Workspace history returned duplicate or unordered snapshots');
    }
    seen.add(version.id);
    previous = version.versionNumber;
  }
  const cursor = value.nextBeforeVersionNumber;
  if (cursor !== null && (versions.length === 0 || cursor !== previous)) {
    throw new Error('Workspace history returned an invalid pagination cursor');
  }
  return {
    workspaceId,
    versions,
    nextBeforeVersionNumber: cursor as number | null,
  };
}

function parseVersion(value: unknown): WorkspaceSyncHistoryVersion {
  if (
    !isRecord(value) ||
    !isUuid(value.id) ||
    !isCount(value.versionNumber, 1) ||
    (value.representation !== 'bundle_v1' &&
      value.representation !== 'manifest_v1' &&
      value.representation !== 'scientific_manifest_v1') ||
    (value.representation === 'scientific_manifest_v1' &&
      (value.manifestSchemaVersion !== 1 ||
        typeof value.fileManifestSha256 !== 'string' ||
        !SHA256_RE.test(value.fileManifestSha256))) ||
    (value.manifestSchemaVersion !== null && !isCount(value.manifestSchemaVersion)) ||
    typeof value.contentSha256 !== 'string' ||
    !SHA256_RE.test(value.contentSha256) ||
    !isCount(value.sizeBytes) ||
    !isCount(value.fileCount) ||
    !isDate(value.createdAt) ||
    (value.finalizedAt !== null && !isDate(value.finalizedAt)) ||
    !isAuthor(value.createdBy)
  ) {
    throw new Error('Workspace history returned an invalid snapshot');
  }
  return {
    id: value.id,
    versionNumber: value.versionNumber,
    representation: value.representation,
    ...(value.representation === 'scientific_manifest_v1'
      ? { fileManifestSha256: value.fileManifestSha256 as string }
      : {}),
    manifestSchemaVersion: value.manifestSchemaVersion as number | null,
    contentSha256: value.contentSha256,
    sizeBytes: value.sizeBytes,
    fileCount: value.fileCount,
    createdAt: value.createdAt,
    finalizedAt: value.finalizedAt as string | null,
    createdBy: value.createdBy,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function isCount(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function isDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isAuthor(value: unknown): value is WorkspaceSyncHistoryVersion['createdBy'] {
  return (
    value === null ||
    (isRecord(value) &&
      isUuid(value.accountId) &&
      (value.email === null || typeof value.email === 'string') &&
      (value.displayName === null || typeof value.displayName === 'string'))
  );
}
