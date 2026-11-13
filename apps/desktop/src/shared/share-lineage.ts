import {
  DEEP_SHARE_ARTIFACT_TYPES,
  type DeepShareArtifactType,
  type DeepShareParentRef,
} from '@waypoint/share-bundle';

export interface ShareLineageV1 {
  schemaVersion: 1;
  shareId: string | null;
  shortId: string;
  pinnedVersionId: string | null;
  pinnedVersionNumber: number | null;
  originalName: string;
  sharedAt: string | null;
  contentSha256: string | null;
  senderDisplayName: string | null;
  importedAt: string;
  notice: 'Opened from a public snapshot link. This is your editable local copy.';
}

export interface ShareLineageV2 {
  schemaVersion: 2;
  source: {
    shareId: string;
    shortId: string;
    workspaceId: string;
    artifact: { id: string; type: DeepShareArtifactType; name: string };
    pinnedVersion: { id: string; number: number; contentSha256: string };
    bundle: { schema: 'dnaforge.deep-share/v1'; contentSha256: string };
    parent: DeepShareParentRef | null;
    sharedAt: string | null;
  };
  importedAt: string;
  localWorkspaceUuid: string;
  conversationIdMap: Record<string, string>;
  notice: 'Imported as a private local fork. Changes do not affect the sender.';
}

export type ShareLineageB = ShareLineageV1 | ShareLineageV2;

export const SHARE_LINEAGE_NOTICE: ShareLineageV1['notice'] =
  'Opened from a public snapshot link. This is your editable local copy.';
export const DEEP_SHARE_LINEAGE_NOTICE: ShareLineageV2['notice'] =
  'Imported as a private local fork. Changes do not affect the sender.';
export const SHARE_LINEAGE_RELATIVE_PATH = '.dnaforge/share-lineage.json';

export function parseShareLineage(value: unknown): ShareLineageB | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion === 1) return parseV1(record);
  if (record.schemaVersion === 2) return parseV2(record);
  return null;
}

function parseV1(record: Record<string, unknown>): ShareLineageV1 | null {
  const shareId = nullableString(record.shareId);
  const pinnedVersionId = nullableString(record.pinnedVersionId);
  const pinnedVersionNumber = nullableNumber(record.pinnedVersionNumber);
  const sharedAt = nullableString(record.sharedAt);
  const contentSha256 = nullableString(record.contentSha256);
  const senderDisplayName = nullableString(record.senderDisplayName);
  if (
    typeof record.shortId !== 'string' ||
    typeof record.originalName !== 'string' ||
    typeof record.importedAt !== 'string' ||
    record.notice !== SHARE_LINEAGE_NOTICE ||
    shareId === false ||
    pinnedVersionId === false ||
    pinnedVersionNumber === false ||
    sharedAt === false ||
    contentSha256 === false ||
    senderDisplayName === false
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    shareId,
    shortId: record.shortId,
    pinnedVersionId,
    pinnedVersionNumber,
    originalName: record.originalName,
    sharedAt,
    contentSha256,
    senderDisplayName,
    importedAt: record.importedAt,
    notice: SHARE_LINEAGE_NOTICE,
  };
}

function parseV2(record: Record<string, unknown>): ShareLineageV2 | null {
  const source = object(record.source);
  const artifact = object(source?.artifact);
  const version = object(source?.pinnedVersion);
  const bundle = object(source?.bundle);
  const conversationEntries = object(record.conversationIdMap);
  const parent = parseParent(source?.parent);
  const sharedAt = nullableString(source?.sharedAt);
  if (
    !source ||
    !artifact ||
    !version ||
    !bundle ||
    !conversationEntries ||
    parent === false ||
    sharedAt === false ||
    typeof source.shareId !== 'string' ||
    typeof source.shortId !== 'string' ||
    typeof source.workspaceId !== 'string' ||
    typeof artifact.id !== 'string' ||
    !isDeepShareArtifactType(artifact.type) ||
    typeof artifact.name !== 'string' ||
    typeof version.id !== 'string' ||
    typeof version.number !== 'number' ||
    typeof version.contentSha256 !== 'string' ||
    bundle.schema !== 'dnaforge.deep-share/v1' ||
    typeof bundle.contentSha256 !== 'string' ||
    typeof record.importedAt !== 'string' ||
    typeof record.localWorkspaceUuid !== 'string' ||
    record.notice !== DEEP_SHARE_LINEAGE_NOTICE
  ) {
    return null;
  }
  const conversationIdMap: Record<string, string> = {};
  for (const [key, value] of Object.entries(conversationEntries)) {
    if (typeof value !== 'string') return null;
    conversationIdMap[key] = value;
  }
  return {
    schemaVersion: 2,
    source: {
      shareId: source.shareId,
      shortId: source.shortId,
      workspaceId: source.workspaceId,
      artifact: { id: artifact.id, type: artifact.type, name: artifact.name },
      pinnedVersion: {
        id: version.id,
        number: version.number,
        contentSha256: version.contentSha256,
      },
      bundle: { schema: 'dnaforge.deep-share/v1', contentSha256: bundle.contentSha256 },
      parent,
      sharedAt,
    },
    importedAt: record.importedAt,
    localWorkspaceUuid: record.localWorkspaceUuid,
    conversationIdMap,
    notice: DEEP_SHARE_LINEAGE_NOTICE,
  };
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nullableString(value: unknown): string | null | false {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : false;
}

function nullableNumber(value: unknown): number | null | false {
  if (value === undefined || value === null) return null;
  return typeof value === 'number' ? value : false;
}

function isDeepShareArtifactType(value: unknown): value is DeepShareArtifactType {
  return (
    typeof value === 'string' && (DEEP_SHARE_ARTIFACT_TYPES as readonly string[]).includes(value)
  );
}

function parseParent(value: unknown): DeepShareParentRef | null | false {
  if (value === undefined || value === null) return null;
  const record = object(value);
  if (
    !record ||
    typeof record.shareId !== 'string' ||
    typeof record.sourceArtifactId !== 'string' ||
    typeof record.bundleContentSha256 !== 'string'
  ) {
    return false;
  }
  return {
    shareId: record.shareId,
    sourceArtifactId: record.sourceArtifactId,
    bundleContentSha256: record.bundleContentSha256,
  };
}
