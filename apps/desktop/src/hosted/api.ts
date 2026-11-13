import { Upload } from 'tus-js-client';
import {
  mergeWorkspaceSessionFiles,
  type WorkspaceSessionPublicationCondition,
} from '@waypoint/domain-services';
import {
  WORKSPACE_SYNC_MANIFEST_MAX_FILES,
  WORKSPACE_SYNC_MANIFEST_MAX_PATH_LENGTH,
  WORKSPACE_SYNC_MANIFEST_MAX_CONTENT_TYPE_LENGTH,
} from '@waypoint/share-bundle/protocol';

const CONTROL_RESPONSE_MAX_BYTES = 256 * 1024;
const MAX_JSON_BYTES_PER_CODE_UNIT = 6;
const RESPONSE_ENVELOPE_MAX_BYTES = 64 * 1024;
export const HOSTED_MANIFEST_RESPONSE_MAX_BYTES =
  RESPONSE_ENVELOPE_MAX_BYTES +
  WORKSPACE_SYNC_MANIFEST_MAX_FILES *
    (2 * WORKSPACE_SYNC_MANIFEST_MAX_PATH_LENGTH * MAX_JSON_BYTES_PER_CODE_UNIT +
      WORKSPACE_SYNC_MANIFEST_MAX_CONTENT_TYPE_LENGTH * MAX_JSON_BYTES_PER_CODE_UNIT +
      256);
export const HOSTED_RECOVERY_DETAIL_RESPONSE_MAX_BYTES =
  HOSTED_MANIFEST_RESPONSE_MAX_BYTES +
  WORKSPACE_SYNC_MANIFEST_MAX_FILES *
    (WORKSPACE_SYNC_MANIFEST_MAX_PATH_LENGTH * MAX_JSON_BYTES_PER_CODE_UNIT + 3);
const TUS_RETRY_DELAYS = [0, 500, 1_500, 3_000, 5_000];
const VERIFICATION_ATTEMPTS = 80;
const VERIFICATION_POLL_MS = 500;
const HOSTED_BLOB_UPLOAD_CONCURRENCY = 4;
const activeHostedBlobPreparations = new Map<string, Promise<void>>();
const hostedBlobPreparationWaiters: Array<() => void> = [];
let activeHostedBlobPreparationCount = 0;

async function withHostedBlobPreparationSlot(operation: () => Promise<void>): Promise<void> {
  if (activeHostedBlobPreparationCount >= HOSTED_BLOB_UPLOAD_CONCURRENCY) {
    await new Promise<void>((resolve) => hostedBlobPreparationWaiters.push(resolve));
  } else {
    activeHostedBlobPreparationCount += 1;
  }
  try {
    await operation();
  } finally {
    const next = hostedBlobPreparationWaiters.shift();
    if (next) next();
    else activeHostedBlobPreparationCount -= 1;
  }
}

function shareHostedBlobPreparation(key: string, operation: () => Promise<void>): Promise<void> {
  const existing = activeHostedBlobPreparations.get(key);
  if (existing) return existing;
  const pending = withHostedBlobPreparationSlot(() => {
    const locks = globalThis.navigator?.locks;
    return locks ? locks.request(`dnaforge-blob-prepare:${key}`, operation) : operation();
  });
  activeHostedBlobPreparations.set(key, pending);
  void pending
    .finally(() => {
      if (activeHostedBlobPreparations.get(key) === pending)
        activeHostedBlobPreparations.delete(key);
    })
    .catch(() => undefined);
  return pending;
}

export interface HostedAccount {
  id: string;
  email: string;
  displayName: string | null;
}

export interface HostedWorkspaceSummary {
  workspaceId: string;
  clientWorkspaceId: string;
  displayName: string;
  ownerDisplayName: string;
  access: { role: 'viewer' | 'editor' | 'manager' | 'owner' };
  latest: { versionId: string | null; versionNumber: number; contentSha256: string | null };
  storageBytesUsed: number;
  versionCount: number;
  updatedAt: string;
}

export interface HostedWorkspaceIndex {
  account: HostedAccount;
  workspaces: HostedWorkspaceSummary[];
}

export interface HostedManifestFile {
  resourceId?: string;
  path: string;
  contentSha256: string;
  sizeBytes: number;
  contentType: string;
}

export interface HostedManifestDetail {
  workspaceId: string;
  version: {
    id: string;
    versionNumber: number;
    contentSha256: string;
    createdAt: string;
  };
  manifest: { schemaVersion: 1; files: HostedManifestFile[] };
  resourceIdentities: Array<{ path: string; resourceId: string }>;
}

export interface HostedFileWrite {
  path: string;
  bytes: Uint8Array;
  contentType: string;
  resourceId?: string | null;
}

export interface HostedWorkspacePublishResult {
  id: string;
  versionNumber: number;
  contentSha256: string;
  files: HostedManifestFile[];
}

export interface HostedWorkspaceRevision {
  id: string;
  versionNumber: number;
  representation: 'bundle_v1' | 'manifest_v1';
  manifestSchemaVersion: number | null;
  contentSha256: string;
  sizeBytes: number;
  fileCount: number;
  createdAt: string;
  finalizedAt: string | null;
  createdBy: {
    accountId: string;
    email: string | null;
    displayName: string | null;
  } | null;
}

export interface HostedWorkspaceHistory {
  workspaceId: string;
  versions: HostedWorkspaceRevision[];
  nextBeforeVersionNumber: number | null;
}

export interface HostedWorkspaceShareResult {
  workspaceId: string;
  revisionPolicy: 'pinned_version';
  pinnedVersion: {
    id: string;
    versionNumber: number;
    contentSha256: string;
    sizeBytes: number;
    fileCount: number;
    createdAt: string;
  };
  share: {
    id: string;
    shortId: string;
    linkToken: string;
    url: string;
    scopeMode: 'anyone-with-link';
    displayLabel: string | null;
    expiresAt: string | null;
    createdAt: string;
  };
  short_id: string;
  link_token: string;
  url: string;
}

interface JsonErrorBody {
  error?: string;
  message?: string;
}

export class HostedWorkspaceApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'HostedWorkspaceApiError';
  }
}

export async function loadHostedWorkspaceIndex(
  expectedAccountId?: string
): Promise<HostedWorkspaceIndex> {
  return requestJson<HostedWorkspaceIndex>('/api/hosted-workspaces', {
    headers: accountHeaders(expectedAccountId),
  });
}

export async function createHostedWorkspace(
  displayName: string,
  expectedAccountId?: string
): Promise<{ workspaceId: string }> {
  const accountId = requireHostedMutationAccountId(expectedAccountId);
  const clientWorkspaceId = crypto.randomUUID();
  return requestJson('/api/hosted-workspaces', {
    method: 'POST',
    headers: jsonHeaders(accountHeaders(accountId)),
    body: JSON.stringify({
      clientWorkspaceId,
      displayName,
      deviceId: `hosted-browser:${clientWorkspaceId}`,
      owner: { kind: 'personal' },
    }),
  });
}

export async function createHostedWorkspaceShare(args: {
  workspaceId: string;
  expectedLatestVersionId: string;
  displayLabel?: string | null;
  expectedAccountId?: string;
}): Promise<HostedWorkspaceShareResult> {
  const accountId = requireHostedMutationAccountId(args.expectedAccountId);
  return requestJson<HostedWorkspaceShareResult>(
    `/api/hosted-workspaces/${encodeURIComponent(args.workspaceId)}/shares`,
    {
      method: 'POST',
      headers: jsonHeaders(accountHeaders(accountId)),
      body: JSON.stringify({
        mode: 'pinned',
        expectedLatestVersionId: args.expectedLatestVersionId,
        scopeMode: 'anyone-with-link',
        displayLabel: args.displayLabel ?? null,
      }),
    }
  );
}

export async function signOutHostedWorkspace(): Promise<void> {
  await requestJson('/api/hosted-workspaces/session', { method: 'DELETE' });
}

export async function loadHostedManifest(
  workspaceId: string,
  versionId: string,
  expectedAccountId?: string
): Promise<HostedManifestDetail> {
  const detail = await requestJson<HostedManifestDetail>(
    `/api/hosted-workspaces/${encodeURIComponent(workspaceId)}/versions/${encodeURIComponent(versionId)}/manifest`,
    { headers: accountHeaders(expectedAccountId) },
    { maxResponseBytes: HOSTED_MANIFEST_RESPONSE_MAX_BYTES }
  );
  const resourceIds = new Map(
    detail.resourceIdentities.map((identity) => [identity.path, identity.resourceId])
  );
  return {
    ...detail,
    manifest: {
      ...detail.manifest,
      files: detail.manifest.files.map((file) => {
        const resourceId = resourceIds.get(file.path);
        if (!resourceId) {
          throw new HostedWorkspaceApiError(
            502,
            'BAD_RESPONSE',
            `Hosted manifest omitted the resource identity for ${file.path}.`
          );
        }
        return { ...file, resourceId };
      }),
    },
  };
}

export async function loadHostedWorkspaceHistory(
  workspaceId: string
): Promise<HostedWorkspaceHistory> {
  return requestJson(
    `/api/hosted-workspaces/${encodeURIComponent(workspaceId)}/versions?limit=100`
  );
}

export async function downloadHostedFile(args: {
  workspaceId: string;
  versionId: string;
  file: HostedManifestFile;
}): Promise<Uint8Array> {
  const url =
    `/api/hosted-workspaces/${encodeURIComponent(args.workspaceId)}` +
    `/versions/${encodeURIComponent(args.versionId)}/files?path=${encodeURIComponent(args.file.path)}`;
  const response = await fetch(url, {
    credentials: 'same-origin',
    redirect: 'follow',
    headers: { Accept: args.file.contentType },
  });
  if (!response.ok) throw await responseError(response);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== args.file.sizeBytes) {
    throw new HostedWorkspaceApiError(409, 'INTEGRITY', 'Downloaded file size did not match.');
  }
  const digest = await sha256Hex(bytes);
  if (digest !== args.file.contentSha256) {
    throw new HostedWorkspaceApiError(409, 'INTEGRITY', 'Downloaded file digest did not match.');
  }
  return bytes;
}

export async function publishHostedFile(args: {
  workspaceId: string;
  baseVersionId: string | null;
  baseFiles?: readonly HostedManifestFile[];
  path: string;
  bytes: Uint8Array;
  contentType: string;
  onProgress?: (sent: number, total: number) => void;
  expectedAccountId?: string;
}): Promise<{
  id: string;
  versionNumber: number;
  contentSha256: string;
  file: HostedManifestFile;
}> {
  const result = await publishHostedWorkspaceFiles({
    workspaceId: args.workspaceId,
    baseVersionId: args.baseVersionId,
    baseFiles: args.baseFiles ?? [],
    files: [{ path: args.path, bytes: args.bytes, contentType: args.contentType }],
    onProgress: args.onProgress,
    expectedAccountId: args.expectedAccountId,
  });
  const file = result.files.find((candidate) => candidate.path === args.path);
  if (!file) {
    throw new HostedWorkspaceApiError(502, 'BAD_RESPONSE', 'Accepted revision omitted the file.');
  }
  return { ...result, file };
}

export interface HostedWorkspacePublishInput {
  workspaceId: string;
  baseVersionId: string | null;
  baseFiles: readonly HostedManifestFile[];
  files: readonly HostedFileWrite[];
  removePaths?: readonly string[];
  onProgress?: (sent: number, total: number) => void;
  expectedAccountId?: string;
  operationId?: string;
  publicationCondition?: WorkspaceSessionPublicationCondition;
}

export async function publishHostedWorkspaceFiles(
  args: HostedWorkspacePublishInput,
  retainedFiles?: readonly HostedManifestFile[]
): Promise<HostedWorkspacePublishResult> {
  const expectedAccountId = requireHostedMutationAccountId(args.expectedAccountId);
  const described = retainedFiles
    ? await describeHostedWorkspaceFiles({ ...args, expectedAccountId })
    : undefined;
  const files =
    described && JSON.stringify(described.manifestFiles) === JSON.stringify(retainedFiles)
      ? described.manifestFiles
      : await prepareHostedWorkspaceFiles({ ...args, expectedAccountId });
  return publishHostedManifest({
    workspaceId: args.workspaceId,
    baseVersionId: args.baseVersionId,
    files,
    expectedAccountId,
    idempotencyScope: args.operationId,
    ...(args.publicationCondition ? { publicationCondition: args.publicationCondition } : {}),
  });
}

export async function prepareHostedWorkspaceFiles(
  args: HostedWorkspacePublishInput
): Promise<HostedManifestFile[]> {
  const { manifestFiles, pending, expectedAccountId } = await describeHostedWorkspaceFiles(args);
  await prepareHostedBlobs(args, pending, expectedAccountId);
  return manifestFiles;
}

async function describeHostedWorkspaceFiles(args: HostedWorkspacePublishInput) {
  const expectedAccountId = requireHostedMutationAccountId(args.expectedAccountId);
  if (args.files.length === 0 && (args.removePaths?.length ?? 0) === 0) {
    throw new HostedWorkspaceApiError(400, 'BAD_REQUEST', 'At least one file is required.');
  }
  const pending = await Promise.all(
    args.files.map(async (file) => ({
      ...file,
      contentSha256: await sha256Hex(file.bytes),
      sizeBytes: file.bytes.byteLength,
    }))
  );
  const manifestFiles = mergeWorkspaceSessionFiles(
    args.baseFiles.map((file) => ({
      resourceId: null,
      ...file,
      contentRevision: `sha256:${file.contentSha256}`,
    })),
    pending.map((file) => ({
      ...(file.resourceId !== undefined ? { resourceId: file.resourceId } : {}),
      path: file.path,
      contentRevision: `sha256:${file.contentSha256}`,
      contentSha256: file.contentSha256,
      sizeBytes: file.sizeBytes,
      contentType: file.contentType,
    })),
    { removePaths: args.removePaths }
  ).map(({ resourceId, path, contentSha256, sizeBytes, contentType }) => {
    if (!contentSha256) {
      throw new HostedWorkspaceApiError(
        500,
        'BAD_RESPONSE',
        `Hosted manifest file is missing its SHA-256 claim: ${path}.`
      );
    }
    return {
      ...(resourceId ? { resourceId } : {}),
      path,
      contentSha256,
      sizeBytes,
      contentType,
    };
  });

  return { manifestFiles, pending, expectedAccountId };
}

export async function prepareHostedWorkspaceWrites(
  args: Pick<
    HostedWorkspacePublishInput,
    'workspaceId' | 'files' | 'expectedAccountId' | 'onProgress'
  > & { baseFiles?: readonly HostedManifestFile[]; removePaths?: readonly string[] }
): Promise<void> {
  const expectedAccountId = requireHostedMutationAccountId(args.expectedAccountId);
  if (args.baseFiles) {
    const files = await prepareHostedWorkspaceFiles({
      ...args,
      baseFiles: args.baseFiles,
      baseVersionId: null,
    });
    const result = await requestJson<{ status: string }>(
      `/api/hosted-workspaces/${encodeURIComponent(args.workspaceId)}/package-admission`,
      {
        method: 'POST',
        headers: jsonHeaders(accountHeaders(expectedAccountId)),
        body: JSON.stringify({ baseVersionId: null, manifest: hostedManifestBody(files) }),
      }
    );
    if (result.status !== 'pending' && result.status !== 'ready')
      throw new HostedWorkspaceApiError(
        502,
        'BAD_RESPONSE',
        'Package preparation returned an invalid response.'
      );
    return;
  }
  const pending = await Promise.all(
    args.files.map(async (file) => ({
      ...file,
      contentSha256: await sha256Hex(file.bytes),
      sizeBytes: file.bytes.byteLength,
    }))
  );
  await prepareHostedBlobs(args, pending, expectedAccountId);
}

async function prepareHostedBlobs(
  args: Pick<HostedWorkspacePublishInput, 'workspaceId' | 'onProgress'>,
  pending: readonly (HostedFileWrite & { contentSha256: string; sizeBytes: number })[],
  expectedAccountId: string
): Promise<void> {
  const totalBytes = pending.reduce((total, file) => total + file.sizeBytes, 0);
  args.onProgress?.(0, totalBytes);
  const sentBytes = pending.map(() => 0);
  const reportProgress = (index: number, sent: number) => {
    sentBytes[index] = Math.max(sentBytes[index], Math.min(sent, pending[index].sizeBytes));
    args.onProgress?.(
      sentBytes.reduce((sum, bytes) => sum + bytes, 0),
      totalBytes
    );
  };
  const blobTransfers = new Map<string, Promise<void>>();
  let nextIndex = 0;
  let failed = false;
  const transfers = await Promise.allSettled(
    Array.from({ length: Math.min(HOSTED_BLOB_UPLOAD_CONCURRENCY, pending.length) }, async () => {
      while (!failed && nextIndex < pending.length) {
        const index = nextIndex++;
        const file = pending[index];
        try {
          const key = `hosted-blob:${args.workspaceId}:${file.contentSha256}:${file.sizeBytes}`;
          let transfer = blobTransfers.get(key);
          if (!transfer) {
            transfer = shareHostedBlobPreparation(`${expectedAccountId}:${key}`, () =>
              ensureHostedBlob({
                workspaceId: args.workspaceId,
                bytes: file.bytes,
                contentType: file.contentType,
                contentSha256: file.contentSha256,
                idempotencyKey: key,
                expectedAccountId,
                onProgress: (sent) => reportProgress(index, sent),
              })
            );
            blobTransfers.set(key, transfer);
          }
          await transfer;
          reportProgress(index, file.sizeBytes);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    })
  );
  for (const transfer of transfers) {
    if (transfer.status === 'rejected') throw transfer.reason;
  }
}

export async function restoreHostedWorkspaceVersion(args: {
  workspaceId: string;
  baseVersionId: string | null;
  revisionId: string;
  expectedAccountId?: string;
}): Promise<HostedWorkspacePublishResult> {
  const expectedAccountId = requireHostedMutationAccountId(args.expectedAccountId);
  const historical = await loadHostedManifest(args.workspaceId, args.revisionId, expectedAccountId);
  return publishHostedManifest({
    workspaceId: args.workspaceId,
    baseVersionId: args.baseVersionId,
    files: historical.manifest.files,
    idempotencyScope: `restore:${args.revisionId}`,
    expectedAccountId,
  });
}

function hostedManifestBody(files: readonly HostedManifestFile[]) {
  return {
    schemaVersion: 1 as const,
    files: files.map(({ path, contentSha256, sizeBytes, contentType }) => ({
      path,
      contentSha256,
      sizeBytes,
      contentType,
    })),
  };
}

async function publishHostedManifest(args: {
  workspaceId: string;
  baseVersionId: string | null;
  files: readonly HostedManifestFile[];
  idempotencyScope?: string;
  expectedAccountId?: string;
  publicationCondition?: WorkspaceSessionPublicationCondition;
}): Promise<HostedWorkspacePublishResult> {
  const expectedAccountId = requireHostedMutationAccountId(args.expectedAccountId);
  const manifest = hostedManifestBody(args.files);
  const resourceIdentities = args.files
    .filter((file): file is HostedManifestFile & { resourceId: string } => !!file.resourceId)
    .map(({ path, resourceId }) => ({ path, resourceId }));
  const manifestFingerprint = await sha256Hex(
    new TextEncoder().encode(
      JSON.stringify({
        manifest,
        resourceIdentities,
        ...(args.publicationCondition ? { publicationCondition: args.publicationCondition } : {}),
      })
    )
  );
  const publishKey = [
    'hosted-version',
    args.workspaceId,
    args.baseVersionId ?? 'initial',
    args.idempotencyScope ?? 'commit',
    manifestFingerprint,
  ].join(':');
  const request: RequestInit = {
    method: 'POST',
    headers: jsonHeaders({
      'Idempotency-Key': publishKey,
      ...accountHeaders(expectedAccountId),
    }),
    body: JSON.stringify({
      baseVersionId: args.baseVersionId,
      manifest,
      ...(resourceIdentities.length > 0 ? { resourceIdentities } : {}),
      ...(args.publicationCondition ? { publicationCondition: args.publicationCondition } : {}),
    }),
  };
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const result = await requestJson<{
        status: 'ready' | 'unchanged';
        version: { id: string; versionNumber: number; contentSha256: string };
      }>(`/api/hosted-workspaces/${encodeURIComponent(args.workspaceId)}/versions`, request);
      return { ...result.version, files: [...args.files] };
    } catch (error) {
      if (
        !args.publicationCondition ||
        !(error instanceof HostedWorkspaceApiError) ||
        error.code !== 'SEQUENCE_PACKAGE_ADMISSION_PENDING' ||
        Date.now() >= deadline
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

async function ensureHostedBlob(args: {
  workspaceId: string;
  bytes: Uint8Array;
  contentType: string;
  contentSha256: string;
  idempotencyKey: string;
  expectedAccountId?: string;
  onProgress?: (sent: number, total: number) => void;
}): Promise<void> {
  const expectedAccountId = requireHostedMutationAccountId(args.expectedAccountId);
  const reservePath = `/api/hosted-workspaces/${encodeURIComponent(args.workspaceId)}/blobs/reserve`;
  const reserve = () =>
    requestJson<Record<string, unknown>>(reservePath, {
      method: 'POST',
      headers: jsonHeaders({
        'Idempotency-Key': args.idempotencyKey,
        ...accountHeaders(expectedAccountId),
      }),
      body: JSON.stringify({
        contentSha256: args.contentSha256,
        sizeBytes: args.bytes.byteLength,
        contentType: args.contentType,
      }),
    });

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const reservation = await reserve();
    if (reservation.status === 'ready') return;
    if (reservation.status === 'verifying') {
      await pollUntilBlobReady(reserve);
      return;
    }
    if (reservation.status !== 'upload_required') {
      throw new HostedWorkspaceApiError(503, 'BAD_RESERVATION', 'Upload reservation was invalid.');
    }
    const reservationId = requiredString(reservation.reservationId, 'reservationId');
    const upload = requiredRecord(reservation.upload, 'upload');
    const endpoint = validTusEndpoint(requiredString(upload.endpoint, 'upload.endpoint'));
    const uploadArgs = {
      bytes: args.bytes,
      endpoint,
      token: requiredString(upload.token, 'upload.token'),
      bucket: requiredString(upload.bucket, 'upload.bucket'),
      path: requiredString(upload.path, 'upload.path'),
      contentType: args.contentType,
      fingerprint: hostedUploadFingerprint({
        accountId: expectedAccountId,
        workspaceId: args.workspaceId,
        endpoint,
        bucket: requiredString(upload.bucket, 'upload.bucket'),
        path: requiredString(upload.path, 'upload.path'),
        contentSha256: args.contentSha256,
        sizeBytes: args.bytes.byteLength,
      }),
      onProgress: args.onProgress,
    };
    try {
      if (isLoopbackHttpUrl(endpoint)) {
        await uploadLocalSignedObject(uploadArgs);
      } else {
        await uploadTus(uploadArgs);
      }
      const complete = await requestJson<Record<string, unknown>>(
        `/api/hosted-workspaces/${encodeURIComponent(args.workspaceId)}/blobs/complete`,
        {
          method: 'POST',
          headers: jsonHeaders(accountHeaders(expectedAccountId)),
          body: JSON.stringify({ reservationId }),
        }
      );
      if (complete.status === 'ready') return;
      if (complete.status !== 'verifying') {
        throw new HostedWorkspaceApiError(
          503,
          'BAD_VERIFICATION',
          'Upload verification did not start.'
        );
      }
      await pollUntilBlobReady(reserve);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new HostedWorkspaceApiError(503, 'LOCAL_STORAGE_UPLOAD_FAILED', 'Upload did not complete.');
}

async function pollUntilBlobReady(reserve: () => Promise<Record<string, unknown>>): Promise<void> {
  for (let attempt = 0; attempt < VERIFICATION_ATTEMPTS; attempt += 1) {
    await delay(VERIFICATION_POLL_MS);
    const result = await reserve();
    if (result.status === 'ready') return;
    if (result.status !== 'verifying') {
      throw new HostedWorkspaceApiError(
        409,
        'VERIFICATION_FAILED',
        'Uploaded file did not pass integrity verification.'
      );
    }
  }
  throw new HostedWorkspaceApiError(
    504,
    'VERIFICATION_TIMEOUT',
    'Uploaded file verification timed out.'
  );
}

async function uploadTus(args: {
  bytes: Uint8Array;
  endpoint: string;
  token: string;
  bucket: string;
  path: string;
  contentType: string;
  fingerprint: string;
  onProgress?: (sent: number, total: number) => void;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const blob = new Blob([args.bytes], { type: args.contentType });
    const upload = new Upload(blob, {
      endpoint: args.endpoint,
      retryDelays: TUS_RETRY_DELAYS,
      chunkSize: 6 * 1024 * 1024,
      headers: { 'x-signature': args.token, 'x-upsert': 'false' },
      metadata: {
        bucketName: args.bucket,
        objectName: args.path,
        contentType: args.contentType,
        cacheControl: '3600',
      },
      uploadDataDuringCreation: true,
      storeFingerprintForResuming: true,
      removeFingerprintOnSuccess: true,
      fingerprint: async () => args.fingerprint,
      onProgress: args.onProgress,
      onError: (error) => reject(error),
      onSuccess: () => resolve(),
    });
    void upload.findPreviousUploads().then((previous) => {
      if (previous.length > 0) upload.resumeFromPreviousUpload(previous[0]);
      upload.start();
    }, reject);
  });
}

export function hostedUploadFingerprint(input: {
  accountId: string;
  workspaceId: string;
  endpoint: string;
  bucket: string;
  path: string;
  contentSha256: string;
  sizeBytes: number;
}): string {
  return `dnaforge-hosted-v2:${JSON.stringify([
    input.accountId,
    input.workspaceId,
    input.endpoint,
    input.bucket,
    input.path,
    input.contentSha256,
    input.sizeBytes,
  ])}`;
}

async function uploadLocalSignedObject(args: {
  bytes: Uint8Array;
  endpoint: string;
  token: string;
  bucket: string;
  path: string;
  contentType: string;
  onProgress?: (sent: number, total: number) => void;
}): Promise<void> {
  const target = localSignedObjectUploadUrl({
    tusEndpoint: args.endpoint,
    token: args.token,
    bucket: args.bucket,
    path: args.path,
  });
  const blob = new Blob([args.bytes], { type: args.contentType });
  args.onProgress?.(0, args.bytes.byteLength);
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 1; attempt += 1) {
    const body = new FormData();
    body.append('cacheControl', '3600');
    body.append('', blob);
    try {
      const response = await fetch(target, {
        method: 'PUT',
        body,
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        headers: { 'x-upsert': 'false' },
      });
      if (response.ok) {
        args.onProgress?.(args.bytes.byteLength, args.bytes.byteLength);
        return;
      }
      const detail = (await response.text().catch(() => '')).slice(0, 200);
      lastError = new HostedWorkspaceApiError(
        response.status,
        'LOCAL_STORAGE_UPLOAD_FAILED',
        `The local Storage upload was rejected (${response.status})${detail ? `: ${detail}` : '.'}`
      );
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new HostedWorkspaceApiError(
        503,
        'LOCAL_STORAGE_UPLOAD_FAILED',
        'The local Storage upload was rejected.'
      );
}

export function localSignedObjectUploadUrl(args: {
  tusEndpoint: string;
  token: string;
  bucket: string;
  path: string;
}): string {
  const endpoint = validTusEndpoint(args.tusEndpoint);
  if (!isLoopbackHttpUrl(endpoint)) {
    throw new HostedWorkspaceApiError(
      503,
      'BAD_RESERVATION',
      'Local signed upload is restricted to loopback Storage.'
    );
  }
  validateObjectLocation(args.bucket, args.path);
  const target = new URL(endpoint);
  target.pathname =
    '/storage/v1/object/upload/sign/' +
    [args.bucket, ...args.path.split('/')].map((segment) => encodeURIComponent(segment)).join('/');
  target.searchParams.set('token', args.token);
  return target.toString();
}

function validateObjectLocation(bucket: string, path: string): void {
  const invalidPathCharacter = Array.from(path).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
  if (
    !/^[a-z0-9][a-z0-9._-]{0,62}$/u.test(bucket) ||
    !path ||
    path.length > 1_024 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    invalidPathCharacter ||
    path.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new HostedWorkspaceApiError(503, 'BAD_RESERVATION', 'Upload location was invalid.');
  }
}

function isLoopbackHttpUrl(value: string): boolean {
  const url = new URL(value);
  return (
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
  );
}

function validTusEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HostedWorkspaceApiError(503, 'BAD_RESERVATION', 'Upload endpoint was invalid.');
  }
  const local = isLoopbackHttpUrl(url.toString());
  const hosted = url.protocol === 'https:' && url.hostname.endsWith('.storage.supabase.co');
  const pathname = url.pathname.replace(/\/+$/u, '');
  if (
    (!local && (!hosted || pathname !== '/storage/v1/upload/resumable/sign')) ||
    (local &&
      pathname !== '/storage/v1/upload/resumable' &&
      pathname !== '/storage/v1/upload/resumable/sign') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    pathname === ''
  ) {
    throw new HostedWorkspaceApiError(503, 'BAD_RESERVATION', 'Upload endpoint was invalid.');
  }
  return url.toString().replace(/\/+$/u, '');
}

export async function requestJson<T>(
  input: string,
  init: RequestInit = {},
  options: { maxResponseBytes?: number } = {}
): Promise<T> {
  const maxResponseBytes = options.maxResponseBytes ?? CONTROL_RESPONSE_MAX_BYTES;
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
    throw new Error('Hosted response byte limit must be a positive safe integer.');
  }
  const headers = new Headers({ Accept: 'application/json' });
  new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  const method = (init.method ?? 'GET').toUpperCase();
  const signOut = method === 'DELETE' && input === '/api/hosted-workspaces/session';
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS' && !signOut) {
    requireHostedMutationAccountId(headers.get('X-DNAForge-Account-ID') ?? undefined);
  }
  const response = await fetch(input, {
    ...init,
    credentials: 'same-origin',
    headers,
    signal: init.signal ?? AbortSignal.timeout(30_000),
  });
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxResponseBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new HostedWorkspaceApiError(502, 'OVERSIZED_RESPONSE', 'Server response was too large.');
  }
  const bytes = await boundedResponseBytes(response, maxResponseBytes);
  let body: unknown;
  try {
    body = bytes.byteLength === 0 ? {} : JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HostedWorkspaceApiError(
      response.status,
      'BAD_RESPONSE',
      'Server response was invalid.'
    );
  }
  if (!response.ok) throw jsonResponseError(response.status, body);
  return body as T;
}

async function boundedResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      const value = chunk.value;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        throw new HostedWorkspaceApiError(
          502,
          'OVERSIZED_RESPONSE',
          'Server response was too large.'
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function responseError(response: Response): Promise<HostedWorkspaceApiError> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {}
  return jsonResponseError(response.status, body);
}

function jsonResponseError(status: number, body: unknown): HostedWorkspaceApiError {
  const record = body && typeof body === 'object' ? (body as JsonErrorBody) : {};
  return new HostedWorkspaceApiError(
    status,
    typeof record.error === 'string' ? record.error : 'HTTP_ERROR',
    typeof record.message === 'string' ? record.message : `Request failed (${status}).`
  );
}

function jsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'Content-Type': 'application/json', ...extra };
}

function accountHeaders(accountId: string | undefined): Record<string, string> {
  return accountId ? { 'X-DNAForge-Account-ID': accountId } : {};
}

export function requireHostedMutationAccountId(value: string | undefined): string {
  if (
    !value ||
    value !== value.trim() ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  ) {
    throw new HostedWorkspaceApiError(
      409,
      'account_changed',
      'The initiating account is unavailable. Reopen this project before changing it.'
    );
  }
  return value;
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HostedWorkspaceApiError(503, 'BAD_RESERVATION', `${label} was invalid.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new HostedWorkspaceApiError(503, 'BAD_RESERVATION', `${label} was invalid.`);
  }
  return value;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const view =
    bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const digest = await crypto.subtle.digest('SHA-256', view as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
