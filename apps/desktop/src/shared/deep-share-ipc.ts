import type {
  DeepShareArtifactType,
  DeepShareManifestV1,
  PortableConversationV1,
} from '@waypoint/share-bundle';

const OPAQUE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,499}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

export interface DeepShareSelectionRequest {
  workspaceUuid: string;
  rootArtifactId: string;
  selectedArtifactIds?: string[];
  selectedConversationIds: string[];
}

export interface DeepSharePublishRequest extends DeepShareSelectionRequest {
  reviewedDigest: string;
}

export interface DeepShareReviewFile {
  id: string;
  ownerArtifactId: string;
  relativePath: string;
  name: string;
  role: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
}

export interface DeepShareConversationCandidateReview {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  exactReferenceCount: number;
}

export interface DeepShareReview {
  workspace: {
    uuid: string;
    name: string;
    remoteWorkspaceId: string;
  };
  rootArtifactId: string;
  rootArtifact: { id: string; type: DeepShareArtifactType; name: string };
  manifest: DeepShareManifestV1;
  files: DeepShareReviewFile[];
  chats: PortableConversationV1[];
  conversationCandidates: DeepShareConversationCandidateReview[];
  digest: string;
}

export type DeepShareErrorCode =
  | 'INVALID_REQUEST'
  | 'WORKSPACE_NOT_READY'
  | 'ROOT_NOT_FOUND'
  | 'ROOT_HAS_NO_PORTABLE_FILE'
  | 'INVALID_SELECTION'
  | 'SYNC_FAILED'
  | 'MANIFEST_STALE'
  | 'PUBLISH_FAILED';

export interface DeepShareErrorResult {
  ok: false;
  code: DeepShareErrorCode;
  message: string;
  refreshedReview?: DeepShareReview;
}

export interface DeepSharePreflightOk {
  ok: true;
  review: DeepShareReview;
}

export type DeepSharePreflightResult = DeepSharePreflightOk | DeepShareErrorResult;

export interface DeepSharePublishOk {
  ok: true;
  url: string;
  shortId: string;
  shareId: string;
  versionId: string;
  versionNumber: number;
  versionContentSha256: string;
  bundleId: string;
  bundleContentSha256: string;
}

export type DeepSharePublishResult = DeepSharePublishOk | DeepShareErrorResult;

export function parseDeepShareSelectionRequest(value: unknown): DeepShareSelectionRequest {
  const record = requestRecord(value);
  return {
    workspaceUuid: opaqueId(record.workspaceUuid, 'workspaceUuid'),
    rootArtifactId: opaqueId(record.rootArtifactId, 'rootArtifactId'),
    selectedArtifactIds:
      record.selectedArtifactIds === undefined
        ? undefined
        : idArray(record.selectedArtifactIds, 'selectedArtifactIds'),
    selectedConversationIds: idArray(record.selectedConversationIds, 'selectedConversationIds'),
  };
}

export function parseDeepSharePublishRequest(value: unknown): DeepSharePublishRequest {
  const selection = parseDeepShareSelectionRequest(value);
  const record = requestRecord(value);
  if (typeof record.reviewedDigest !== 'string' || !SHA256_RE.test(record.reviewedDigest)) {
    throw new Error('reviewedDigest must be a lowercase SHA-256 hash');
  }
  return { ...selection, reviewedDigest: record.reviewedDigest };
}

function requestRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Deep Share request must be an object');
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    'workspaceUuid',
    'rootArtifactId',
    'selectedArtifactIds',
    'selectedConversationIds',
    'reviewedDigest',
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error(`Unknown Deep Share request field: ${key}`);
  }
  return record;
}

function opaqueId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !OPAQUE_ID_RE.test(value)) {
    throw new Error(`${label} must be an opaque id`);
  }
  return value;
}

function idArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 2000) {
    throw new Error(`${label} must be an array with at most 2000 ids`);
  }
  const parsed = value.map((entry) => opaqueId(entry, `${label} entry`));
  if (new Set(parsed).size !== parsed.length)
    throw new Error(`${label} must not contain duplicates`);
  return parsed;
}
