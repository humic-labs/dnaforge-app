import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { DeepShareBundleV1, DeepShareParentRef } from '@waypoint/share-bundle';
import type {
  DeepSharePublishRequest,
  DeepSharePublishResult,
  DeepShareReview,
} from '../../shared/deep-share-ipc';
import { createDesktopSyncClient, type DesktopSyncClient } from '../desktop-sync-client';
import { parseShareLineage, SHARE_LINEAGE_RELATIVE_PATH } from '../../shared/share-lineage';
import { buildDeepShareBundle } from './bundle-builder';
import {
  buildDeepSharePreflight,
  DeepSharePreflightError,
  type DeepSharePreflight,
} from './preflight';

export interface DeepShareServerResponse {
  workspaceId: string;
  revisionPolicy: 'deep_bundle';
  pinnedVersion: {
    id: string;
    versionNumber: number;
    contentSha256: string;
    createdAt: string;
  };
  bundle: { id: string; contentSha256: string };
  share: { id: string; shortId: string; url: string };
}

export interface DeepSharePublishClient {
  createDeepShare(request: {
    remoteWorkspaceId: string;
    bundle: DeepShareBundleV1;
  }): Promise<DeepShareServerResponse>;
}

export interface PublishReviewedDeepShareDeps {
  forceSync(workspaceUuid: string): Promise<{ ok: boolean; message?: string }>;
  buildPreflight?: typeof buildDeepSharePreflight;
  client?: DeepSharePublishClient;
  readParent?: (workspacePath: string) => Promise<DeepShareParentRef | null>;
  appVersion: string;
  now?: () => string;
  assertAuthority?: () => Promise<void>;
}

export async function publishReviewedDeepShare(
  db: Database.Database,
  request: DeepSharePublishRequest,
  deps: PublishReviewedDeepShareDeps
): Promise<DeepSharePublishResult> {
  const synced = await deps.forceSync(request.workspaceUuid);
  if (!synced.ok) {
    return {
      ok: false,
      code: 'SYNC_FAILED',
      message: synced.message ?? 'Could not sync the project before sharing.',
    };
  }

  let preflight: DeepSharePreflight;
  try {
    preflight = await (deps.buildPreflight ?? buildDeepSharePreflight)(db, {
      workspaceUuid: request.workspaceUuid,
      rootArtifactId: request.rootArtifactId,
      selectedArtifactIds: request.selectedArtifactIds,
      selectedConversationIds: request.selectedConversationIds,
    });
  } catch (error) {
    return preflightFailure(error);
  }

  if (preflight.digest !== request.reviewedDigest) {
    return {
      ok: false,
      code: 'MANIFEST_STALE',
      message: 'The share contents changed after review. Review the refreshed manifest.',
      refreshedReview: toDeepShareReview(preflight),
    };
  }

  try {
    const parent = await (deps.readParent ?? readDeepShareParent)(preflight.workspace.path);
    const bundle = buildDeepShareBundle({
      preflight,
      appVersion: deps.appVersion,
      createdAt: deps.now?.(),
      parent,
    });
    await deps.assertAuthority?.();
    const response = await (deps.client ?? createDeepSharePublishClient()).createDeepShare({
      remoteWorkspaceId: preflight.workspace.remoteWorkspaceId,
      bundle,
    });
    const responseError = validateResponse(response, bundle);
    if (responseError) {
      return { ok: false, code: 'PUBLISH_FAILED', message: responseError };
    }
    return {
      ok: true,
      url: response.share.url,
      shortId: response.share.shortId,
      shareId: response.share.id,
      versionId: response.pinnedVersion.id,
      versionNumber: response.pinnedVersion.versionNumber,
      versionContentSha256: response.pinnedVersion.contentSha256,
      bundleId: response.bundle.id,
      bundleContentSha256: response.bundle.contentSha256,
    };
  } catch (error) {
    return {
      ok: false,
      code: 'PUBLISH_FAILED',
      message: error instanceof Error ? error.message : 'Could not publish the Deep Share link.',
    };
  }
}

export async function readDeepShareParent(
  workspacePath: string
): Promise<DeepShareParentRef | null> {
  try {
    const raw = await readFile(
      join(workspacePath, ...SHARE_LINEAGE_RELATIVE_PATH.split('/')),
      'utf8'
    );
    const lineage = parseShareLineage(JSON.parse(raw) as unknown);
    if (!lineage || lineage.schemaVersion !== 2) return null;
    return {
      shareId: lineage.source.shareId,
      sourceArtifactId: lineage.source.artifact.id,
      bundleContentSha256: lineage.source.bundle.contentSha256,
    };
  } catch {
    return null;
  }
}

export function toDeepShareReview(preflight: DeepSharePreflight): DeepShareReview {
  const root = preflight.manifest.artifacts.find(
    (artifact) => artifact.id === preflight.rootArtifactId
  );
  if (!root) throw new Error('Deep Share root is missing from the manifest.');
  return {
    workspace: {
      uuid: preflight.workspace.uuid,
      name: preflight.workspace.name,
      remoteWorkspaceId: preflight.workspace.remoteWorkspaceId,
    },
    rootArtifactId: preflight.rootArtifactId,
    rootArtifact: { id: root.id, type: root.type, name: root.name },
    manifest: preflight.manifest,
    files: preflight.files.map((file) => ({
      id: file.id,
      ownerArtifactId: file.ownerArtifactId,
      relativePath: file.relativePath,
      name: file.name,
      role: file.role,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
    })),
    chats: preflight.chats,
    conversationCandidates: preflight.conversationCandidates,
    digest: preflight.digest,
  };
}

export function createDeepSharePublishClient(
  client: DesktopSyncClient = createDesktopSyncClient(),
  expectedAccountId?: string
): DeepSharePublishClient {
  return {
    createDeepShare: ({ remoteWorkspaceId, bundle }) =>
      client.requestJson<DeepShareServerResponse>(
        `/api/desktop-sync/workspaces/${encodeURIComponent(remoteWorkspaceId)}/shares`,
        {
          method: 'POST',
          ...(expectedAccountId ? { expectedAccountId } : {}),
          body: {
            mode: 'deep',
            revisionPolicy: 'deep_bundle',
            scopeMode: 'anyone-with-link',
            bundle,
          },
        }
      ),
  };
}

function preflightFailure(error: unknown): DeepSharePublishResult {
  if (error instanceof DeepSharePreflightError) {
    return { ok: false, code: error.code, message: error.message };
  }
  return {
    ok: false,
    code: 'PUBLISH_FAILED',
    message: error instanceof Error ? error.message : 'Could not rebuild the Deep Share manifest.',
  };
}

function validateResponse(
  response: DeepShareServerResponse,
  bundle: DeepShareBundleV1
): string | null {
  if (response.revisionPolicy !== 'deep_bundle') return 'Server returned the wrong share policy.';
  if (response.workspaceId !== bundle.source.workspaceId) {
    return 'Server returned a share for a different workspace.';
  }
  if (
    response.pinnedVersion.id !== bundle.source.pinnedVersionId ||
    response.pinnedVersion.versionNumber !== bundle.source.pinnedVersionNumber ||
    response.pinnedVersion.contentSha256 !== bundle.source.pinnedVersionContentSha256
  ) {
    return 'Server pinned a different sync version than the reviewed bundle.';
  }
  if (response.bundle.contentSha256 !== bundle.contentSha256) {
    return 'Server returned a different Deep Share bundle hash.';
  }
  if (!response.bundle.id || !response.share.id || !response.share.shortId || !response.share.url) {
    return 'Server returned an incomplete Deep Share response.';
  }
  return null;
}
