import { createHash } from 'node:crypto';
import {
  parseWorkspaceSyncManifest,
  workspaceSyncManifestHashInput,
  type WorkspaceSyncManifestV1,
  DESKTOP_SYNC_MANIFEST_JSON_MAX_BYTES,
} from '@waypoint/share-bundle';
import type { WorkspaceSyncExcludedSummary } from '../shared/cloud-sync-status';
import type { DesktopSyncClient } from './desktop-sync-client';
import { isWorkspaceSyncRemoteUuid } from './workspace-sync-remote-id';
import { parseWorkspacePath } from '@waypoint/workspace-revisions';
import {
  parseWorkspaceSyncScientificHistoryMetadata,
  workspaceSyncScientificContentSha256,
  type WorkspaceSyncScientificHistoryMetadata,
} from './workspace-sync-scientific-history';

export interface WorkspaceSyncRecoveryCandidateReceipt extends WorkspaceSyncScientificHistoryMetadata {
  readonly representation?: 'scientific_manifest_v1';
  readonly id: string;
  readonly accountId: string;
  readonly baseVersionId: string | null;
  readonly contentSha256: string;
  readonly requestSha256: string;
  readonly reason: 'dirty' | 'conflict' | 'invalid-package';

  readonly coverage: 'captured-bytes' | 'incomplete';
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface WorkspaceSyncRecoveryCandidateRequest extends WorkspaceSyncScientificHistoryMetadata {
  readonly remoteWorkspaceId: string;
  readonly ownerAccountId: string;
  readonly baseVersionId: string | null;
  readonly manifest: WorkspaceSyncManifestV1;
  readonly reason: WorkspaceSyncRecoveryCandidateReceipt['reason'];
  readonly excludedSummary?: WorkspaceSyncExcludedSummary;
  readonly missingPaths?: readonly string[];
  readonly resourceIdentities?: readonly { path: string; resourceId: string }[];
}

export type WorkspaceSyncRecoveryOperationIdentity =
  | Readonly<{ acceptedOperationId: string; parentAcceptedOperationId: string | null }>
  | Readonly<{ acceptedOperationId: null; parentAcceptedOperationId: null }>;

interface WorkspaceSyncRecoveryCandidateIntentState {
  readonly schema: 'dnaforge.desktop-recovery-intent/v1';
  readonly idempotencyKey: string;
  readonly ownerAccountId: string;
  readonly remoteWorkspaceId: string;
  readonly localHeadSha: string;
  readonly snapshotContentSha256: string;
  readonly requestSha256: string;
  readonly createdAtMs: number;
  readonly retainedAtMs: number | null;
  readonly receipt?: WorkspaceSyncRecoveryCandidateReceipt;
}

export type WorkspaceSyncRecoveryCandidateIntent = WorkspaceSyncRecoveryCandidateIntentState &
  WorkspaceSyncRecoveryOperationIdentity;

export interface ScientificWorkspaceSyncRecoveryDetail {
  readonly workspaceId: string;
  readonly candidate: WorkspaceSyncRecoveryCandidateReceipt &
    Required<WorkspaceSyncScientificHistoryMetadata> & { representation: 'scientific_manifest_v1' };
  readonly manifest: WorkspaceSyncManifestV1;
  readonly resourceIdentities: readonly { path: string; resourceId: string }[];
  readonly excludedSummary: Required<Omit<WorkspaceSyncExcludedSummary, 'ignoredCount'>>;
  readonly missingPaths: readonly string[];
}

export function parseScientificWorkspaceSyncRecoveryDetail(
  value: unknown,
  input: { workspaceId: string; candidateId: string; accountId: string; nowMs?: number }
): ScientificWorkspaceSyncRecoveryDetail {
  if (
    !record(value) ||
    value.workspaceId !== input.workspaceId ||
    !record(value.candidate) ||
    value.candidate.id !== input.candidateId ||
    value.candidate.accountId !== input.accountId ||
    value.candidate.representation !== 'scientific_manifest_v1' ||
    !Array.isArray(value.resourceIdentities) ||
    !Array.isArray(value.missingPaths) ||
    value.missingPaths.some((path) => typeof path !== 'string') ||
    !record(value.excludedSummary) ||
    Object.keys(value.excludedSummary).sort().join(',') !== [...SUMMARY_KEYS].sort().join(',')
  )
    throw badReceipt('Scientific recovery detail has incomplete or foreign authority.');
  const manifest = parseWorkspaceSyncManifest(value.manifest);
  if (!manifest.ok) throw badReceipt('Scientific recovery captured manifest is invalid.');
  const receipt = parseWorkspaceSyncRecoveryCandidateReceipt(value.candidate);
  if (
    !receipt ||
    receipt.representation !== 'scientific_manifest_v1' ||
    Date.parse(receipt.expiresAt) <= (input.nowMs ?? Date.now())
  )
    throw badReceipt('Scientific recovery receipt is unavailable or expired.');
  const resourceIdentities = value.resourceIdentities.map((identity: unknown) => {
    if (
      !record(identity) ||
      Object.keys(identity).sort().join(',') !== 'path,resourceId' ||
      typeof identity.path !== 'string' ||
      !isWorkspaceSyncRemoteUuid(identity.resourceId)
    )
      throw badReceipt('Scientific recovery resource identity is invalid.');
    return { path: identity.path, resourceId: identity.resourceId };
  });
  const request: WorkspaceSyncRecoveryCandidateRequest = {
    remoteWorkspaceId: input.workspaceId,
    ownerAccountId: input.accountId,
    baseVersionId: receipt.baseVersionId,
    manifest: manifest.manifest,
    reason: receipt.reason,
    resourceIdentities,
    excludedSummary: value.excludedSummary,
    missingPaths: value.missingPaths as string[],
    scientificHistory: receipt.scientificHistory,
    scientificBlobRefs: receipt.scientificBlobRefs,
    fileManifestSha256: receipt.fileManifestSha256,
  };
  const expected = workspaceSyncRecoveryCandidateRequest(request);
  if (
    JSON.stringify(resourceIdentities) !== JSON.stringify(expected.body.resourceIdentities) ||
    JSON.stringify(value.missingPaths) !== JSON.stringify(expected.body.missingPaths)
  )
    throw badReceipt('Scientific recovery choices are not canonical.');
  const candidate = validateWorkspaceSyncRecoveryCandidateReceipt(receipt, request);
  if (!expected.scientific) throw badReceipt('Scientific recovery is missing accepted history.');
  return {
    workspaceId: input.workspaceId,
    candidate: { ...candidate, ...expected.scientific, representation: 'scientific_manifest_v1' },
    manifest: manifest.manifest,
    resourceIdentities: expected.body.resourceIdentities,
    excludedSummary: expected.body.excludedSummary,
    missingPaths: expected.body.missingPaths,
  };
}

export function createScientificWorkspaceSyncRecoveryClient(client: DesktopSyncClient) {
  return {
    async readDetail(
      input: { workspaceId: string; candidateId: string; accountId: string },
      signal?: AbortSignal
    ) {
      const value = await client.requestJson<unknown>(
        `/api/desktop-sync/workspaces/${encodeURIComponent(input.workspaceId)}/recovery-candidates/${encodeURIComponent(input.candidateId)}`,
        {
          method: 'GET',
          expectedAccountId: input.accountId,
          signal,
          maxResponseBytes: DESKTOP_SYNC_MANIFEST_JSON_MAX_BYTES,
        }
      );
      return parseScientificWorkspaceSyncRecoveryDetail(value, input);
    },
    downloadHistoryBlob(
      input: { workspaceId: string; candidateId: string; accountId: string },
      blob: { hash: string },
      signal?: AbortSignal
    ) {
      if (!/^sha256:[0-9a-f]{64}$/u.test(blob.hash))
        throw badReceipt('Scientific recovery blob identity is invalid.');
      return client.requestStream(
        `/api/desktop-sync/workspaces/${encodeURIComponent(input.workspaceId)}/recovery-candidates/${encodeURIComponent(input.candidateId)}/scientific-blobs/${blob.hash.slice('sha256:'.length)}`,
        { method: 'GET', expectedAccountId: input.accountId, signal, timeoutMs: 30 * 60_000 }
      );
    },
    downloadCapturedFile(
      input: { workspaceId: string; candidateId: string; accountId: string },
      path: string,
      signal?: AbortSignal
    ) {
      if (!parseWorkspacePath(path).ok)
        throw badReceipt('Scientific recovery file path is invalid.');
      return client.requestStream(
        `/api/desktop-sync/workspaces/${encodeURIComponent(input.workspaceId)}/recovery-candidates/${encodeURIComponent(input.candidateId)}/files?path=${encodeURIComponent(path)}`,
        { method: 'GET', expectedAccountId: input.accountId, signal, timeoutMs: 30 * 60_000 }
      );
    },
  };
}

const SUMMARY_KEYS = [
  'unsupportedCount',
  'privateRawDataCount',
  'referencePointerCount',
  'fileTooLargeCount',
  'bundleTooLargeCount',
] as const;
export const WORKSPACE_SYNC_RECOVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DIGEST = /^[a-f0-9]{64}$/u;

export function workspaceSyncRecoveryCandidateRequest(
  input: WorkspaceSyncRecoveryCandidateRequest
) {
  const parsed = parseWorkspaceSyncManifest(input.manifest);
  if (!parsed.ok) throw badReceipt(`Recovery manifest is invalid: ${parsed.errors.join('; ')}`);
  const excludedSummary = Object.fromEntries(
    SUMMARY_KEYS.map((key) => {
      const value = input.excludedSummary?.[key] ?? 0;
      if (!Number.isSafeInteger(value) || value < 0)
        throw badReceipt('Recovery exclusion counters are invalid.');
      return [key, value];
    })
  ) as Required<Omit<WorkspaceSyncExcludedSummary, 'ignoredCount'>>;
  const missingPaths = [...(input.missingPaths ?? [])].sort((a, b) =>
    Buffer.compare(Buffer.from(a), Buffer.from(b))
  );
  const fileManifestSha256 = sha256(workspaceSyncManifestHashInput(parsed.manifest));
  const scientific = parseWorkspaceSyncScientificHistoryMetadata(input, fileManifestSha256);
  if (
    scientific &&
    (!isWorkspaceSyncRemoteUuid(input.remoteWorkspaceId) ||
      !isWorkspaceSyncRemoteUuid(input.ownerAccountId) ||
      (input.baseVersionId !== null && !isWorkspaceSyncRemoteUuid(input.baseVersionId)))
  )
    throw badReceipt('Scientific recovery identities are invalid.');
  if (
    scientific &&
    (new Set(missingPaths).size !== missingPaths.length ||
      missingPaths.some((path) => !parseWorkspacePath(path).ok))
  )
    throw badReceipt('Scientific recovery missing paths are invalid.');
  const resourceIdentities = [...(input.resourceIdentities ?? [])].sort((a, b) =>
    Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))
  );
  const paths = new Set(parsed.manifest.files.map((file) => file.path));
  if (
    new Set(resourceIdentities.map((identity) => identity.path)).size !==
      resourceIdentities.length ||
    new Set(resourceIdentities.map((identity) => identity.resourceId)).size !==
      resourceIdentities.length ||
    resourceIdentities.some(
      (identity) => !paths.has(identity.path) || !isWorkspaceSyncRemoteUuid(identity.resourceId)
    )
  )
    throw badReceipt('Recovery resource identities are invalid.');
  const normalizedIdentities = resourceIdentities.map(({ path, resourceId }) => ({
    path,
    resourceId: resourceId.toLowerCase(),
  }));
  const contentSha256 = scientific
    ? workspaceSyncScientificContentSha256(fileManifestSha256, scientific.scientificHistory)
    : fileManifestSha256;
  const requestSha256 = sha256(
    JSON.stringify({
      schema: scientific
        ? 'dnaforge.workspace-sync-recovery-candidate/scientific-v1'
        : 'dnaforge.workspace-sync-recovery-candidate/v1',
      workspaceId: scientific ? input.remoteWorkspaceId.toLowerCase() : input.remoteWorkspaceId,
      accountId: scientific ? input.ownerAccountId.toLowerCase() : input.ownerAccountId,
      baseVersionId: scientific
        ? (input.baseVersionId?.toLowerCase() ?? null)
        : input.baseVersionId,
      ...(scientific ? { representation: 'scientific_manifest_v1', fileManifestSha256 } : {}),
      contentSha256,
      ...(scientific
        ? {
            scientificHistory: scientific.scientificHistory,
            scientificBlobRefs: scientific.scientificBlobRefs,
          }
        : {}),
      reason: input.reason,
      resourceIdentities: normalizedIdentities,
      excludedSummary,
      missingPaths,
    })
  );
  return {
    body: {
      baseVersionId: scientific
        ? (input.baseVersionId?.toLowerCase() ?? null)
        : input.baseVersionId,
      manifest: parsed.manifest,
      resourceIdentities: normalizedIdentities,
      reason: input.reason,
      excludedSummary,
      missingPaths,
      ...(scientific
        ? {
            representation: 'scientific_manifest_v1',
            scientificHistory: scientific.scientificHistory,
            scientificBlobRefs: scientific.scientificBlobRefs,
          }
        : {}),
    },
    scientific,
    contentSha256,
    requestSha256,
    coverage:
      missingPaths.length || SUMMARY_KEYS.some((key) => excludedSummary[key] > 0)
        ? ('incomplete' as const)
        : ('captured-bytes' as const),
  };
}

export async function retainWorkspaceSyncRecoveryCandidate(
  client: DesktopSyncClient,
  input: WorkspaceSyncRecoveryCandidateRequest & { readonly idempotencyKey: string },
  signal?: AbortSignal
): Promise<WorkspaceSyncRecoveryCandidateReceipt> {
  const expected = workspaceSyncRecoveryCandidateRequest(input);
  const response = await client.requestJson<unknown>(
    `/api/desktop-sync/workspaces/${encodeURIComponent(input.remoteWorkspaceId)}/recovery-candidates`,
    {
      method: 'POST',
      expectedAccountId: input.ownerAccountId,
      idempotencyKey: input.idempotencyKey,
      body: expected.body,
      maxResponseBytes: expected.scientific ? DESKTOP_SYNC_MANIFEST_JSON_MAX_BYTES : 64 * 1024,
      signal,
    }
  );
  if (
    !record(response) ||
    response.status !== 'retained' ||
    response.workspaceId !== input.remoteWorkspaceId
  ) {
    throw badReceipt('Recovery receipt belongs to another workspace or is not retained.');
  }
  return validateWorkspaceSyncRecoveryCandidateReceipt(response.candidate, input);
}

export function validateWorkspaceSyncRecoveryCandidateReceipt(
  value: unknown,
  input: WorkspaceSyncRecoveryCandidateRequest
): WorkspaceSyncRecoveryCandidateReceipt {
  const expected = workspaceSyncRecoveryCandidateRequest(input);
  const receipt = parseWorkspaceSyncRecoveryCandidateReceipt(value);
  if (
    !receipt ||
    receipt.accountId !==
      (expected.scientific ? input.ownerAccountId.toLowerCase() : input.ownerAccountId) ||
    receipt.baseVersionId !==
      (expected.scientific ? (input.baseVersionId?.toLowerCase() ?? null) : input.baseVersionId) ||
    receipt.contentSha256 !== expected.contentSha256 ||
    receipt.requestSha256 !== expected.requestSha256 ||
    receipt.reason !== input.reason ||
    receipt.coverage !== expected.coverage ||
    receipt.representation !== (expected.scientific ? 'scientific_manifest_v1' : undefined) ||
    (expected.scientific &&
      (receipt.fileManifestSha256 !== expected.scientific.fileManifestSha256 ||
        JSON.stringify(receipt.scientificHistory) !==
          JSON.stringify(expected.scientific.scientificHistory) ||
        JSON.stringify(receipt.scientificBlobRefs) !==
          JSON.stringify(expected.scientific.scientificBlobRefs)))
  ) {
    throw badReceipt(
      'Recovery receipt does not cover the exact account, base, captured content, request, or retention.'
    );
  }
  return receipt;
}

export function parseWorkspaceSyncRecoveryCandidateReceipt(
  value: unknown
): WorkspaceSyncRecoveryCandidateReceipt | null {
  if (
    !record(value) ||
    !isWorkspaceSyncRemoteUuid(value.id) ||
    typeof value.accountId !== 'string' ||
    (value.baseVersionId !== null && typeof value.baseVersionId !== 'string') ||
    typeof value.contentSha256 !== 'string' ||
    !DIGEST.test(value.contentSha256) ||
    typeof value.requestSha256 !== 'string' ||
    !DIGEST.test(value.requestSha256) ||
    (value.reason !== 'dirty' &&
      value.reason !== 'conflict' &&
      value.reason !== 'invalid-package') ||
    (value.coverage !== 'captured-bytes' && value.coverage !== 'incomplete') ||
    typeof value.createdAt !== 'string' ||
    typeof value.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    Date.parse(value.expiresAt) - Date.parse(value.createdAt) !==
      WORKSPACE_SYNC_RECOVERY_RETENTION_MS
  ) {
    return null;
  }
  let scientific: ReturnType<typeof parseWorkspaceSyncScientificHistoryMetadata> = null;
  try {
    if (value.representation === 'scientific_manifest_v1') {
      if (typeof value.fileManifestSha256 !== 'string' || !DIGEST.test(value.fileManifestSha256))
        return null;
      scientific = parseWorkspaceSyncScientificHistoryMetadata(value, value.fileManifestSha256);
      if (
        !scientific ||
        workspaceSyncScientificContentSha256(
          scientific.fileManifestSha256,
          scientific.scientificHistory
        ) !== value.contentSha256
      )
        return null;
    } else if (
      value.representation !== undefined ||
      value.scientificHistory !== undefined ||
      value.scientificBlobRefs !== undefined ||
      value.fileManifestSha256 !== undefined
    )
      return null;
  } catch {
    return null;
  }
  return {
    id: value.id,
    accountId: value.accountId,
    baseVersionId: value.baseVersionId,
    contentSha256: value.contentSha256,
    requestSha256: value.requestSha256,
    reason: value.reason,
    coverage: value.coverage,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    ...(scientific ? { ...scientific, representation: 'scientific_manifest_v1' as const } : {}),
  };
}

function badReceipt(message: string) {
  return Object.assign(new Error(message), {
    code: 'BAD_RESPONSE',
    retryable: true,
    terminal: false,
  });
}
function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
