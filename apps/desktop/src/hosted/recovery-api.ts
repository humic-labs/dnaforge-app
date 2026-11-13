import { withUserMessage } from '@waypoint/user-messages';
import { workspaceSyncManifestHashInput } from '@waypoint/share-bundle/protocol';
import {
  HostedWorkspaceApiError,
  HOSTED_RECOVERY_DETAIL_RESPONSE_MAX_BYTES,
  prepareHostedWorkspaceFiles,
  requestJson,
  sha256Hex,
  type HostedManifestFile,
  type HostedWorkspacePublishInput,
} from './api';

export interface HostedRecoveryCandidate {
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

export interface HostedRecoveryDetail {
  readonly workspaceId: string;
  readonly candidate: HostedRecoveryCandidate;
  readonly manifest: { readonly schemaVersion: 1; readonly files: readonly HostedManifestFile[] };
  readonly resourceIdentities: readonly { readonly path: string; readonly resourceId: string }[];
  readonly missingPaths: readonly string[];
}

export async function retainHostedRecoveryCandidate(
  input: HostedWorkspacePublishInput & {
    operationId: string;
    onPrepared?: (files: readonly HostedManifestFile[]) => void;
  }
): Promise<HostedRecoveryCandidate> {
  if (!input.expectedAccountId)
    throw new HostedWorkspaceApiError(
      409,
      'account_changed',
      'The account that initiated this recovery capture is missing. Sign in again before syncing.'
    );
  const accountId = normalizedUuid(input.expectedAccountId);
  const workspaceId = normalizedUuid(input.workspaceId);
  const baseVersionId = input.baseVersionId === null ? null : normalizedUuid(input.baseVersionId);
  const key = `hosted-recovery:${input.operationId}`;
  if (
    !input.operationId ||
    input.operationId !== input.operationId.trim() ||
    key.length > 200 ||
    [...key].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    throw new HostedWorkspaceApiError(
      400,
      'BAD_REQUEST',
      'The frozen recovery operation identity is invalid.'
    );
  const files = [
    ...(await prepareHostedWorkspaceFiles({
      ...input,
      workspaceId,
      baseVersionId,
      expectedAccountId: accountId,
    })),
  ].sort((left, right) => compareUtf8(left.path, right.path));
  const manifest = {
    schemaVersion: 1 as const,
    files: files.map(({ path, contentSha256, sizeBytes, contentType }) => ({
      path,
      contentSha256,
      sizeBytes,
      contentType,
    })),
  };
  const resourceIdentities = files.flatMap((file) =>
    file.resourceId ? [{ path: file.path, resourceId: normalizedUuid(file.resourceId) }] : []
  );
  const excludedSummary = {
    unsupportedCount: 0,
    privateRawDataCount: 0,
    referencePointerCount: 0,
    fileTooLargeCount: 0,
    bundleTooLargeCount: 0,
  };
  const missingPaths: string[] = [];
  const reason = 'dirty';
  const contentSha256 = await sha256Hex(
    new TextEncoder().encode(workspaceSyncManifestHashInput(manifest))
  );
  const requestSha256 = await sha256Hex(
    new TextEncoder().encode(
      JSON.stringify({
        schema: 'dnaforge.workspace-sync-recovery-candidate/v1',
        workspaceId,
        accountId,
        baseVersionId,
        contentSha256,
        reason,
        resourceIdentities,
        excludedSummary,
        missingPaths,
      })
    )
  );
  const result = await requestJson<unknown>(candidatePath(workspaceId), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
      'X-DNAForge-Account-ID': accountId,
    },
    body: JSON.stringify({
      baseVersionId,
      manifest,
      resourceIdentities,
      reason,
      excludedSummary,
      missingPaths,
    }),
  });
  const receipt = record(result) && record(result.candidate) ? result.candidate : null;
  if (
    !record(result) ||
    result.status !== 'retained' ||
    result.workspaceId !== workspaceId ||
    !receipt ||
    typeof receipt.id !== 'string' ||
    !UUID_RE.test(receipt.id) ||
    receipt.accountId !== accountId ||
    receipt.baseVersionId !== baseVersionId ||
    receipt.contentSha256 !== contentSha256 ||
    receipt.requestSha256 !== requestSha256 ||
    receipt.reason !== reason ||
    receipt.coverage !== 'captured-bytes' ||
    typeof receipt.createdAt !== 'string' ||
    typeof receipt.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(receipt.createdAt)) ||
    !Number.isFinite(Date.parse(receipt.expiresAt)) ||
    Date.parse(receipt.expiresAt) - Date.parse(receipt.createdAt) !== 7 * 24 * 60 * 60 * 1000
  )
    throw new HostedWorkspaceApiError(
      502,
      'BAD_RESPONSE',
      'The recovery receipt does not cover the exact account, base, captured content, request and seven-day retention.'
    );
  input.onPrepared?.(files);
  return receipt as unknown as HostedRecoveryCandidate;
}

export function listHostedRecoveryCandidates(
  workspaceId: string,
  expectedAccountId?: string
): Promise<{ candidates: HostedRecoveryCandidate[] }> {
  return requestJson(candidatePath(workspaceId), { headers: accountFence(expectedAccountId) });
}

export function loadHostedRecoveryCandidate(
  workspaceId: string,
  candidateId: string,
  expectedAccountId?: string
): Promise<HostedRecoveryDetail> {
  return requestJson(
    `${candidatePath(workspaceId)}/${encodeURIComponent(candidateId)}`,
    { headers: accountFence(expectedAccountId) },
    { maxResponseBytes: HOSTED_RECOVERY_DETAIL_RESPONSE_MAX_BYTES }
  );
}

export async function downloadHostedRecoveryFile(
  detail: HostedRecoveryDetail,
  file: HostedManifestFile,
  expectedAccountId?: string
): Promise<Uint8Array> {
  const grant = await requestJson<{ signedUrl: string }>(
    `${candidatePath(detail.workspaceId)}/${encodeURIComponent(detail.candidate.id)}/files?path=${encodeURIComponent(file.path)}`,
    { headers: accountFence(expectedAccountId) }
  );
  const response = await fetch(grant.signedUrl, {
    credentials: 'omit',
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok)
    throw new HostedWorkspaceApiError(
      response.status,
      'RECOVERY_DOWNLOAD_FAILED',
      'The recovery file could not be downloaded.'
    );
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== file.sizeBytes || (await sha256Hex(bytes)) !== file.contentSha256)
    throw withUserMessage(
      new HostedWorkspaceApiError(
        409,
        'INTEGRITY',
        'The recovery file did not match its saved size and digest.'
      ),
      'recovery.fileVerificationFailed'
    );
  return bytes;
}

function candidatePath(workspaceId: string): string {
  return `/api/hosted-workspaces/${encodeURIComponent(workspaceId)}/recovery-candidates`;
}

function accountFence(accountId?: string): Record<string, string> {
  return accountId ? { 'X-DNAForge-Account-ID': accountId } : {};
}

const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
function normalizedUuid(value: string): string {
  if (!UUID_RE.test(value))
    throw new HostedWorkspaceApiError(
      400,
      'BAD_REQUEST',
      'The hosted recovery identity is invalid.'
    );
  return value.toLowerCase();
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function compareUtf8(left: string, right: string): number {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1)
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  return a.length - b.length;
}
