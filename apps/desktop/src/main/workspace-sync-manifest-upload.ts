import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createKeyedMutex } from './workspace-git/keyed-mutex';
import { forEachSyncFileBounded } from './workspace-sync-transfer-pool';
import {
  uploadWorkspaceMultipart,
  type WorkspaceMultipartControl,
  type WorkspaceMultipartSession,
} from './workspace-sync-multipart-upload';

import { Upload } from 'tus-js-client';
import {
  decodeBundleFileContent,
  parseWorkspaceSyncManifest,
  type WorkspaceSyncBundle,
  workspaceSyncManifestHashInput,
  DESKTOP_SYNC_MANIFEST_JSON_MAX_BYTES,
  type WorkspaceSyncManifestV1,
} from '@waypoint/share-bundle';

import { DesktopSyncClientError } from './desktop-sync-client-errors';
import type { DesktopSyncClient, DesktopSyncRequestOptions } from './desktop-sync-client';
import {
  parseWorkspaceSyncScientificHistoryMetadata,
  type WorkspaceSyncScientificHistoryMetadata,
} from './workspace-sync-scientific-history';
import type { WorkspaceSyncExcludedSummary as StatusExcludedSummary } from '../shared/cloud-sync-status';

export const DESKTOP_SYNC_TUS_CHUNK_SIZE = 6 * 1024 * 1024;
export const DESKTOP_SYNC_TUS_RETRY_DELAYS = [0, 1_000, 3_000, 5_000, 10_000] as const;
export const DESKTOP_SYNC_BLOB_VERIFICATION_POLL_MS = 2_000;
export const DESKTOP_SYNC_BLOB_VERIFICATION_MAX_POLLS =
  (30 * 60_000) / DESKTOP_SYNC_BLOB_VERIFICATION_POLL_MS;

const withTusStateMutation = createKeyedMutex();

const MAX_CONTROL_RESPONSE_BYTES = 512 * 1024;
const DIRECT_STORAGE_HOST_SUFFIX = '.storage.supabase.co';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface TusBlobUploadLocation {
  protocol: 'tus';
  endpoint: string;
  token: string;
  bucket: string;
  path: string;
  expiresAt: string;
  upsert: false;
}
interface MultipartBlobUploadLocation {
  protocol: 's3-multipart';
  generation: string;
  uploadId: string;
  providerOrigin: string;
}
type BlobUploadLocation = TusBlobUploadLocation | MultipartBlobUploadLocation;

interface ReadyBlobReservation {
  status: 'ready';
  blobId: string;
  contentSha256: string;
  sizeBytes: number;
}

interface VerifyingBlobReservation {
  status: 'verifying';
  reservationId: string;
}

interface UploadRequiredBlobReservation {
  status: 'upload_required';
  reservationId: string;
  contentSha256: string;
  sizeBytes: number;
  contentType: string;
  upload: BlobUploadLocation;
}

type BlobReservation =
  | ReadyBlobReservation
  | VerifyingBlobReservation
  | UploadRequiredBlobReservation;

export interface WorkspaceSyncManifestUploadRequest extends WorkspaceSyncScientificHistoryMetadata {
  remoteWorkspaceId: string;
  ownerAccountId: string;
  idempotencyKey: string;
  baseVersionId: string | null;
  fileSelectionVersion?: 0 | 1;

  bundle?: WorkspaceSyncBundle;

  manifest?: WorkspaceSyncManifestV1;

  excludedSummary?: StatusExcludedSummary;

  fileSources?: ReadonlyMap<string, string>;

  scientificBlobSources?: ReadonlyMap<string, string>;

  resumeStatePath?: string;
}

interface WorkspaceSyncBlobUploadIdentity {
  contentSha256: string;
  sizeBytes: number;
  contentType: string;

  label: string;
}

export interface WorkspaceSyncManifestUploadOptions {
  onBlobsReady?: (manifest: WorkspaceSyncManifestV1) => Promise<void>;

  uploadBlob?: (input: {
    bytes?: Uint8Array;
    filePath?: string;
    sizeBytes: number;
    endpoint: string;
    token: string;
    bucket: string;
    path: string;
    contentType: string;
    fingerprint: string;
    resumeStatePath?: string;
    signal?: AbortSignal;
    assertAccount?: () => Promise<void>;
  }) => Promise<void>;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  maxVerificationPolls?: number;
}

export interface WorkspaceSyncTusStoredUpload {
  size: number | null;
  metadata: Record<string, string>;
  creationTime: string;
  uploadUrl: string | null;
  parallelUploadUrls: string[] | null;
}

type WorkspaceSyncTusStoredUploads = Record<string, WorkspaceSyncTusStoredUpload>;

export class WorkspaceSyncTusUrlStorage {
  constructor(private readonly filePath: string) {}

  async findAllUploads(): Promise<Array<WorkspaceSyncTusStoredUpload & { urlStorageKey: string }>> {
    const stored = await this.read();
    return Object.entries(stored).map(([urlStorageKey, upload]) => ({
      ...upload,
      urlStorageKey,
    }));
  }

  async findUploadsByFingerprint(
    fingerprint: string
  ): Promise<Array<WorkspaceSyncTusStoredUpload & { urlStorageKey: string }>> {
    const prefix = `tus::${fingerprint}::`;
    const stored = await this.read();
    return Object.entries(stored)
      .filter(([urlStorageKey]) => urlStorageKey.startsWith(prefix))
      .map(([urlStorageKey, upload]) => ({ ...upload, urlStorageKey }));
  }

  async removeUpload(urlStorageKey: string): Promise<void> {
    await withTusStateMutation(resolve(this.filePath), async () => {
      const stored = await this.read();
      if (!Object.prototype.hasOwnProperty.call(stored, urlStorageKey)) return;
      delete stored[urlStorageKey];
      await this.write(stored);
    });
  }

  async addUpload(fingerprint: string, upload: WorkspaceSyncTusStoredUpload): Promise<string> {
    const key = await withTusStateMutation(resolve(this.filePath), async () => {
      const stored = await this.read();
      const urlStorageKey = `tus::${fingerprint}::${randomUUID()}`;
      stored[urlStorageKey] = {
        size: upload.size,
        metadata: { ...upload.metadata },
        creationTime: upload.creationTime,
        uploadUrl: upload.uploadUrl,
        parallelUploadUrls: upload.parallelUploadUrls
          ? [...upload.parallelUploadUrls]
          : upload.parallelUploadUrls,
      };
      await this.write(stored);
      return urlStorageKey;
    });
    const testPauseMs = readTestTusPauseAfterStateWriteMs();
    if (testPauseMs > 0) await sleepWithAbort(testPauseMs);
    return key;
  }

  private async read(): Promise<WorkspaceSyncTusStoredUploads> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return {};
      throw error;
    }
    if (!raw.trim()) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw blobUploadError('The durable TUS upload state is unreadable.', true);
    }
    if (!isRecord(parsed)) {
      throw blobUploadError('The durable TUS upload state is invalid.', true);
    }
    const result: WorkspaceSyncTusStoredUploads = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!isStoredUpload(value)) {
        throw blobUploadError('The durable TUS upload state is invalid.', true);
      }
      result[key] = normalizeStoredUpload(value);
    }
    return result;
  }

  private async write(stored: WorkspaceSyncTusStoredUploads): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, JSON.stringify(stored), { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await rmFile(temporaryPath);
      throw error;
    }
  }
}

export function workspaceSyncManifestFromBundle(
  bundle: WorkspaceSyncBundle
): WorkspaceSyncManifestV1 {
  const parsed = parseWorkspaceSyncManifest({
    schemaVersion: 1,
    files: bundle.files.map((file) => ({
      path: file.relativePath,
      contentSha256: file.sha256.toLowerCase(),
      sizeBytes: file.sizeBytes,
      contentType: file.contentType,
    })),
  });
  if (!parsed.ok) {
    throw Object.assign(
      new Error(`Workspace sync manifest is invalid: ${parsed.errors.join('; ')}`),
      { code: 'BAD_BUNDLE', retryable: false }
    );
  }
  return parsed.manifest;
}

export async function createManifestWorkspaceSyncVersion(
  client: DesktopSyncClient,
  request: WorkspaceSyncManifestUploadRequest,
  signal?: AbortSignal,
  options: WorkspaceSyncManifestUploadOptions = {}
): Promise<unknown> {
  const manifest =
    request.manifest ?? (request.bundle ? workspaceSyncManifestFromBundle(request.bundle) : null);
  if (!manifest) {
    throw Object.assign(new Error('Workspace sync manifest upload has no manifest source.'), {
      code: 'BAD_BUNDLE',
      retryable: false,
    });
  }
  const scientific = parseWorkspaceSyncScientificHistoryMetadata(
    request,
    createHash('sha256').update(workspaceSyncManifestHashInput(manifest), 'utf8').digest('hex')
  );
  const filesByPath = new Map(request.bundle?.files.map((file) => [file.relativePath, file]));
  const uniqueByDigest = new Map<string, WorkspaceSyncBlobUploadIdentity>();
  const sourcesByDigest = new Map<string, { filePath?: string; bytes?: Uint8Array }>();
  for (const file of manifest.files) {
    const previous = uniqueByDigest.get(file.contentSha256);
    if (previous && previous.sizeBytes !== file.sizeBytes)
      throw blobUploadError('One digest names inconsistent current file lengths.', false);
    if (!previous) {
      uniqueByDigest.set(file.contentSha256, {
        contentSha256: file.contentSha256,
        sizeBytes: file.sizeBytes,
        contentType: file.contentType,
        label: file.path,
      });
      const filePath = request.fileSources?.get(file.path);
      const source = filesByPath.get(file.path);
      sourcesByDigest.set(file.contentSha256, {
        filePath,
        bytes: !filePath && source ? Buffer.from(decodeBundleFileContent(source)) : undefined,
      });
    }
  }
  if (scientific) {
    for (const blob of [scientific.scientificHistory.archive, ...scientific.scientificBlobRefs]) {
      const digest = blob.hash.slice('sha256:'.length);
      const previous = uniqueByDigest.get(digest);
      if (previous && previous.sizeBytes !== blob.byteLength)
        throw blobUploadError('One digest names inconsistent scientific blob lengths.', false);
      if (previous) continue;

      uniqueByDigest.set(digest, {
        contentSha256: digest,
        sizeBytes: blob.byteLength,
        contentType: 'application/octet-stream',
        label: blob.hash,
      });
      sourcesByDigest.set(digest, { filePath: request.scientificBlobSources?.get(blob.hash) });
    }
  }

  const uniqueFiles = [...uniqueByDigest.values()].sort(
    (left, right) => right.sizeBytes - left.sizeBytes
  );
  const uploadBlob = options.uploadBlob ?? uploadBlobWithTus;
  const sleep = options.sleep ?? sleepWithAbort;
  const maxPolls = normalizePollLimit(options.maxVerificationPolls);
  const pendingVerification: WorkspaceSyncBlobUploadIdentity[] = [];

  await forEachSyncFileBounded(uniqueFiles, signal, async (file, requestSignal) => {
    const { filePath, bytes } = sourcesByDigest.get(file.contentSha256) ?? {};
    if (!bytes && !filePath) {
      throw Object.assign(new Error(`Workspace sync source blob is missing: ${file.label}`), {
        code: 'BAD_BUNDLE',
        retryable: false,
      });
    }
    if (filePath) {
      await assertBlobFileMatch(filePath, file);
    } else if (bytes) {
      assertBlobBytesMatch(bytes, file);
    }
    const needsVerification = await transferWorkspaceSyncBlob({
      client,
      request,
      file,
      bytes,
      filePath,
      uploadBlob,
      signal: requestSignal,
    });
    if (needsVerification) pendingVerification.push(file);
  });

  await forEachSyncFileBounded(pendingVerification, signal, (file, requestSignal) =>
    waitForWorkspaceSyncBlob({ client, request, file, sleep, maxPolls, signal: requestSignal })
  );

  await options.onBlobsReady?.(manifest);

  const endpoint = `/api/desktop-sync/workspaces/${encodeURIComponent(request.remoteWorkspaceId)}/versions`;
  const publication: DesktopSyncRequestOptions = {
    method: 'POST',
    expectedAccountId: request.ownerAccountId,
    idempotencyKey: request.idempotencyKey,
    body: {
      baseVersionId: request.baseVersionId,
      fileSelectionVersion: request.fileSelectionVersion ?? 0,
      manifest,
      excludedSummary: request.excludedSummary
        ? Object.fromEntries(
            Object.entries(request.excludedSummary).filter(([key]) => key !== 'ignoredCount')
          )
        : {},
      ...(scientific
        ? {
            representation: 'scientific_manifest_v1',
            scientificHistory: scientific.scientificHistory,
            scientificBlobRefs: scientific.scientificBlobRefs,
          }
        : {}),
    },
    maxResponseBytes: scientific
      ? DESKTOP_SYNC_MANIFEST_JSON_MAX_BYTES
      : MAX_CONTROL_RESPONSE_BYTES,
    signal,
  };

  for (let attempt = 0; ; attempt += 1) {
    if (signal?.aborted) throw abortError();
    try {
      return await client.requestJson<unknown>(endpoint, publication);
    } catch (error) {
      if (
        !(error instanceof DesktopSyncClientError) ||
        error.code !== 'IN_PROGRESS' ||
        error.status !== 503 ||
        !error.retryable ||
        error.terminal ||
        error.details?.serverErrorCode !== 'SEQUENCE_PACKAGE_ADMISSION_PENDING' ||
        attempt + 1 >= maxPolls
      )
        throw error;
      await sleep(DESKTOP_SYNC_BLOB_VERIFICATION_POLL_MS, signal);
    }
  }
}

async function transferWorkspaceSyncBlob(input: {
  client: DesktopSyncClient;
  request: WorkspaceSyncManifestUploadRequest;
  file: WorkspaceSyncBlobUploadIdentity;
  bytes?: Uint8Array;
  filePath?: string;
  uploadBlob: NonNullable<WorkspaceSyncManifestUploadOptions['uploadBlob']>;
  signal?: AbortSignal;
}): Promise<boolean> {
  const body = {
    contentSha256: input.file.contentSha256,
    sizeBytes: input.file.sizeBytes,
    contentType: input.file.contentType,
  };
  const idempotencyKey = blobIdempotencyKey(input.request.idempotencyKey, input.file.contentSha256);

  const reservation = await reserveWorkspaceSyncBlob(
    input.client,
    input.request,
    idempotencyKey,
    body,
    input.signal,
    !!input.filePath && !!input.request.resumeStatePath
  );
  if (reservation.status === 'ready') {
    assertReadyBlob(reservation, input.file);
    return false;
  }

  if (reservation.status === 'upload_required') {
    assertUploadReservation(reservation, input.file);
    if (reservation.upload.protocol === 's3-multipart') {
      if (!input.filePath || !input.request.resumeStatePath)
        throw blobUploadError('Multipart upload requires a durable local source.', false);
      const session: WorkspaceMultipartSession = {
        reservationId: reservation.reservationId,
        generation: reservation.upload.generation,
        uploadId: reservation.upload.uploadId,
        providerOrigin: reservation.upload.providerOrigin,
      };
      await uploadWorkspaceMultipart({
        accountId: input.request.ownerAccountId,
        filePath: input.filePath,
        sizeBytes: input.file.sizeBytes,
        sha256: input.file.contentSha256,
        resumeStatePath: input.request.resumeStatePath,
        session,
        control: createMultipartControl(input.client, input.request, session),
        assertAccount: () =>
          input.client.assertAccount?.(input.request.ownerAccountId) ?? Promise.resolve(),
        signal: input.signal,
      });
      return true;
    }
    await input.uploadBlob({
      bytes: input.bytes,
      filePath: input.filePath,
      sizeBytes: input.file.sizeBytes,
      endpoint: reservation.upload.endpoint,
      token: reservation.upload.token,
      bucket: reservation.upload.bucket,
      path: reservation.upload.path,
      contentType: reservation.contentType,
      fingerprint: `workspace-blob:${input.request.ownerAccountId}:${input.request.remoteWorkspaceId}:${input.file.contentSha256}`,
      assertAccount: () =>
        input.client.assertAccount?.(input.request.ownerAccountId) ?? Promise.resolve(),
      resumeStatePath: input.request.resumeStatePath,
      signal: input.signal,
    });
    const completed = await input.client.requestJson<unknown>(
      `/api/desktop-sync/workspaces/${encodeURIComponent(input.request.remoteWorkspaceId)}/blobs/complete`,
      {
        method: 'POST',
        expectedAccountId: input.request.ownerAccountId,
        idempotencyKey,
        body: { reservationId: reservation.reservationId },
        maxResponseBytes: MAX_CONTROL_RESPONSE_BYTES,
        signal: input.signal,
      }
    );

    parseCompletion(completed, reservation.reservationId);
  }
  return true;
}

async function waitForWorkspaceSyncBlob(input: {
  client: DesktopSyncClient;
  request: WorkspaceSyncManifestUploadRequest;
  file: WorkspaceSyncBlobUploadIdentity;
  sleep: NonNullable<WorkspaceSyncManifestUploadOptions['sleep']>;
  maxPolls: number;
  signal?: AbortSignal;
}): Promise<void> {
  const body = {
    contentSha256: input.file.contentSha256,
    sizeBytes: input.file.sizeBytes,
    contentType: input.file.contentType,
  };
  const idempotencyKey = blobIdempotencyKey(input.request.idempotencyKey, input.file.contentSha256);

  for (let attempt = 0; attempt < input.maxPolls; attempt += 1) {
    if (attempt > 0) await input.sleep(DESKTOP_SYNC_BLOB_VERIFICATION_POLL_MS, input.signal);
    const reservation = await reserveWorkspaceSyncBlob(
      input.client,
      input.request,
      idempotencyKey,
      body,
      input.signal
    );
    if (reservation.status === 'ready') {
      assertReadyBlob(reservation, input.file);
      return;
    }
    if (reservation.status !== 'verifying') {
      throw blobUploadError('Blob verification returned an invalid state.', false);
    }
  }
  throw blobUploadError('Blob verification did not finish before the upload lease expired.', true);
}

async function reserveWorkspaceSyncBlob(
  client: DesktopSyncClient,
  request: WorkspaceSyncManifestUploadRequest,
  idempotencyKey: string,
  body: { contentSha256: string; sizeBytes: number; contentType: string },
  signal?: AbortSignal,
  multipartAccepted = false
): Promise<BlobReservation> {
  const value = await client.requestJson<unknown>(
    `/api/desktop-sync/workspaces/${encodeURIComponent(request.remoteWorkspaceId)}/blobs/reserve`,
    {
      method: 'POST',
      expectedAccountId: request.ownerAccountId,
      idempotencyKey,
      body,
      maxResponseBytes: MAX_CONTROL_RESPONSE_BYTES,
      signal,
      blobUploadProtocol:
        multipartAccepted && body.sizeBytes >= 16 * 1024 ** 2 ? 's3-multipart-v1' : undefined,
    }
  );
  return parseReservation(value, body);
}

function parseReservation(
  value: unknown,
  expected: { contentSha256: string; sizeBytes: number; contentType: string }
): BlobReservation {
  if (!isRecord(value) || typeof value.status !== 'string') {
    throw blobUploadError('Blob reservation response was invalid.', false);
  }
  if (value.status === 'ready') {
    const blobId = value.blobId;
    const contentSha256 = value.contentSha256;
    const sizeBytes = value.sizeBytes;
    if (
      !isUuid(blobId) ||
      typeof contentSha256 !== 'string' ||
      contentSha256 !== expected.contentSha256 ||
      typeof sizeBytes !== 'number' ||
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes !== expected.sizeBytes
    ) {
      throw blobUploadError(
        'Ready blob reservation metadata did not match the local bytes.',
        false
      );
    }
    return { status: 'ready', blobId, contentSha256, sizeBytes };
  }
  if (value.status === 'verifying') {
    const reservationId = value.reservationId;
    if (!isUuid(reservationId)) {
      throw blobUploadError('Blob verification response omitted its reservation.', false);
    }
    return { status: 'verifying', reservationId };
  }
  if (value.status !== 'upload_required') {
    throw blobUploadError('Blob reservation returned an invalid status.', false);
  }
  const reservationId = value.reservationId;
  const contentSha256 = value.contentSha256;
  const sizeBytes = value.sizeBytes;
  const contentType = value.contentType;
  if (
    !isUuid(reservationId) ||
    typeof contentSha256 !== 'string' ||
    contentSha256 !== expected.contentSha256 ||
    typeof sizeBytes !== 'number' ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes !== expected.sizeBytes ||
    typeof contentType !== 'string' ||
    contentType !== expected.contentType ||
    !isRecord(value.upload)
  ) {
    throw blobUploadError('Blob upload reservation metadata was invalid.', false);
  }
  const upload = value.upload;
  if (upload.protocol === 's3-multipart') {
    if (
      !isUuid(upload.generation) ||
      typeof upload.uploadId !== 'string' ||
      !upload.uploadId ||
      upload.uploadId.length > 1024 ||
      typeof upload.providerOrigin !== 'string'
    )
      throw blobUploadError(
        'Blob upload reservation returned an invalid multipart session.',
        false
      );
    return {
      status: 'upload_required',
      reservationId,
      contentSha256,
      sizeBytes,
      contentType,
      upload: {
        protocol: 's3-multipart',
        generation: upload.generation,
        uploadId: upload.uploadId,
        providerOrigin: upload.providerOrigin,
      },
    };
  }
  if (
    upload.protocol !== 'tus' ||
    upload.upsert !== false ||
    typeof upload.endpoint !== 'string' ||
    typeof upload.token !== 'string' ||
    typeof upload.bucket !== 'string' ||
    typeof upload.path !== 'string' ||
    typeof upload.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(upload.expiresAt)) ||
    Date.parse(upload.expiresAt) <= Date.now()
  ) {
    throw blobUploadError('Blob upload reservation returned an invalid TUS session.', false);
  }
  validateTusEndpoint(upload.endpoint);
  validateObjectLocation(upload.bucket, upload.path);
  if (upload.token.length < 1 || upload.token.length > 4_096) {
    throw blobUploadError('Blob upload reservation returned an invalid token.', false);
  }
  return {
    status: 'upload_required',
    reservationId,
    contentSha256,
    sizeBytes,
    contentType,
    upload: {
      protocol: 'tus',
      endpoint: upload.endpoint,
      token: upload.token,
      bucket: upload.bucket,
      path: upload.path,
      expiresAt: upload.expiresAt,
      upsert: false,
    },
  };
}

function createMultipartControl(
  client: DesktopSyncClient,
  request: WorkspaceSyncManifestUploadRequest,
  session: WorkspaceMultipartSession
): WorkspaceMultipartControl {
  const control = async (
    action: 'inspect' | 'sign-part' | 'complete',
    signal?: AbortSignal,
    partNumber?: number
  ): Promise<Record<string, unknown>> => {
    const result = await client.requestJson<unknown>(
      `/api/desktop-sync/workspaces/${encodeURIComponent(request.remoteWorkspaceId)}/blobs/multipart`,
      {
        method: 'POST',
        expectedAccountId: request.ownerAccountId,
        body: {
          reservationId: session.reservationId,
          generation: session.generation,
          action,
          ...(partNumber === undefined ? {} : { partNumber }),
        },
        maxResponseBytes: MAX_CONTROL_RESPONSE_BYTES,
        signal,
      }
    );
    if (!isRecord(result))
      throw blobUploadError('Multipart control returned an invalid response.', false);
    return result;
  };
  return {
    inspect: async (_session, signal) => {
      const result = await control('inspect', signal);
      if (typeof result.completed !== 'boolean' || !Array.isArray(result.parts))
        throw blobUploadError('Multipart inspection returned an invalid response.', false);
      const parts = result.parts.map((part: unknown) => {
        if (
          !isRecord(part) ||
          typeof part.partNumber !== 'number' ||
          typeof part.sizeBytes !== 'number' ||
          typeof part.etag !== 'string'
        ) {
          throw blobUploadError('Multipart inspection returned an invalid part.', false);
        }
        return { partNumber: part.partNumber, sizeBytes: part.sizeBytes, etag: part.etag };
      });
      return { completed: result.completed, parts };
    },
    signPart: async (_session, partNumber, signal) => {
      const result = await control('sign-part', signal, partNumber);
      if (
        typeof result.partNumber !== 'number' ||
        typeof result.sizeBytes !== 'number' ||
        typeof result.url !== 'string' ||
        typeof result.expiresAt !== 'string'
      ) {
        throw blobUploadError('Multipart signer returned an invalid capability.', false);
      }
      return {
        partNumber: result.partNumber,
        sizeBytes: result.sizeBytes,
        url: result.url,
        expiresAt: result.expiresAt,
      };
    },
    complete: async (_session, signal) => {
      if ((await control('complete', signal)).completed !== true)
        throw blobUploadError('Multipart completion was not accepted.', false);
    },
  };
}

function parseCompletion(value: unknown, reservationId: string): { status: 'verifying' | 'ready' } {
  if (
    !isRecord(value) ||
    (value.status !== 'verifying' && value.status !== 'ready') ||
    value.reservationId !== reservationId
  ) {
    throw blobUploadError('Blob completion response was invalid.', false);
  }
  return { status: value.status };
}

function assertReadyBlob(value: ReadyBlobReservation, file: WorkspaceSyncBlobUploadIdentity): void {
  if (value.contentSha256 !== file.contentSha256 || value.sizeBytes !== file.sizeBytes) {
    throw blobUploadError('Verified blob metadata did not match the manifest.', false);
  }
}

function assertUploadReservation(
  value: UploadRequiredBlobReservation,
  file: WorkspaceSyncBlobUploadIdentity
): void {
  if (value.contentSha256 !== file.contentSha256 || value.sizeBytes !== file.sizeBytes) {
    throw blobUploadError('Upload reservation did not match the manifest.', false);
  }
}

function assertBlobBytesMatch(bytes: Uint8Array, file: WorkspaceSyncBlobUploadIdentity): void {
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (bytes.byteLength !== file.sizeBytes || actual !== file.contentSha256) {
    throw Object.assign(new Error(`Workspace sync file bytes do not match ${file.label}.`), {
      code: 'BAD_BUNDLE',
      retryable: false,
    });
  }
}

async function assertBlobFileMatch(
  filePath: string,
  file: WorkspaceSyncBlobUploadIdentity
): Promise<void> {
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    throw Object.assign(new Error(`Workspace sync staged file is missing: ${file.label}.`), {
      code: 'BAD_BUNDLE',
      retryable: false,
    });
  }
  if (!fileStat.isFile() || fileStat.size !== file.sizeBytes) {
    throw Object.assign(
      new Error(`Workspace sync staged file size does not match ${file.label}.`),
      {
        code: 'BAD_BUNDLE',
        retryable: false,
      }
    );
  }
  const actual = await hashFile(filePath);
  if (actual !== file.contentSha256) {
    throw Object.assign(new Error(`Workspace sync staged file bytes do not match ${file.label}.`), {
      code: 'BAD_BUNDLE',
      retryable: false,
    });
  }
}

export async function uploadBlobWithTus(input: {
  bytes?: Uint8Array;
  filePath?: string;
  sizeBytes: number;
  endpoint: string;
  token: string;
  bucket: string;
  path: string;
  contentType: string;
  fingerprint: string;
  resumeStatePath?: string;
  signal?: AbortSignal;
  assertAccount?: () => Promise<void>;
}): Promise<void> {
  validateTusEndpoint(input.endpoint);
  validateObjectLocation(input.bucket, input.path);
  if (!input.bytes && !input.filePath) {
    throw blobUploadError('Blob upload has no local source bytes.', false);
  }
  const storage = input.resumeStatePath
    ? new WorkspaceSyncTusUrlStorage(input.resumeStatePath)
    : new MemoryUrlStorage();
  const options = {
    endpoint: input.endpoint,
    chunkSize: DESKTOP_SYNC_TUS_CHUNK_SIZE,
    retryDelays: [...DESKTOP_SYNC_TUS_RETRY_DELAYS],
    headers: { 'x-signature': input.token, 'x-upsert': 'false' },
    metadata: {
      bucketName: input.bucket,
      objectName: input.path,
      contentType: input.contentType,
      cacheControl: '3600',
    },
    uploadDataDuringCreation: true,
    storeFingerprintForResuming: true,
    removeFingerprintOnSuccess: !input.resumeStatePath,
    fingerprint: async () => input.fingerprint,
    uploadSize: input.sizeBytes,
    urlStorage: storage,
    onBeforeRequest: async () => {
      input.signal?.throwIfAborted();
      await input.assertAccount?.();
    },
  };

  const createSource = (): Buffer | ReturnType<typeof createReadStream> =>
    input.filePath
      ? createReadStream(input.filePath)
      : Buffer.from(input.bytes!.buffer, input.bytes!.byteOffset, input.bytes!.byteLength);

  const saved = await storage.findUploadsByFingerprint(input.fingerprint);
  if (saved.length > 1)
    throw blobUploadError('TUS upload could not find one resumable upload.', true);
  if (saved[0]) validateSavedTusUpload(saved[0], input);
  let upload = new Upload(createSource(), options);
  if (saved[0]) upload.resumeFromPreviousUpload(saved[0]);
  let initialFailure = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) {
      const previous = await upload.findPreviousUploads();
      if (previous.length === 0) {
        throw blobUploadError(initialFailure, true);
      }
      if (previous.length !== 1) {
        throw blobUploadError('TUS upload could not find one resumable upload.', true);
      }
      validateSavedTusUpload(previous[0], input);
      upload = new Upload(createSource(), options);
      upload.resumeFromPreviousUpload(previous[0]);
    }
    try {
      await startTusUpload(upload, input.signal);
      return;
    } catch (error) {
      if (input.signal?.aborted) throw abortError();
      if (attempt === 1) throw blobUploadError(errorMessage(error), true);
      initialFailure = errorMessage(error);
    }
  }
}

function validateSavedTusUpload(
  saved: Pick<WorkspaceSyncTusStoredUpload, 'size' | 'metadata' | 'uploadUrl'>,
  expected: { endpoint: string; bucket: string; path: string; sizeBytes: number }
): void {
  const endpoint = new URL(expected.endpoint);
  let resource: URL;
  try {
    if (!saved.uploadUrl) throw new Error('Missing resumable resource.');
    resource = new URL(saved.uploadUrl);
  } catch {
    throw blobUploadError('The saved TUS resource is invalid.', false);
  }
  if (
    resource.origin !== endpoint.origin ||
    !resource.pathname.startsWith(`${endpoint.pathname.replace(/\/+$/u, '')}/`) ||
    resource.username ||
    resource.password ||
    resource.search ||
    resource.hash ||
    saved.size !== expected.sizeBytes ||
    saved.metadata.bucketName !== expected.bucket ||
    saved.metadata.objectName !== expected.path
  ) {
    throw blobUploadError('The saved TUS resource does not match this upload.', false);
  }
}

function startTusUpload(upload: Upload, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (kind: 'resolve' | 'reject', value?: unknown): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (kind === 'resolve') resolve();
      else reject(value);
    };
    const onAbort = (): void => {
      void upload
        .abort(false)
        .catch(() => undefined)
        .finally(() => finish('reject', abortError()));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    upload.options.onSuccess = () => finish('resolve');
    upload.options.onError = (error) => finish('reject', error);
    upload.start();
  });
}

class MemoryUrlStorage {
  private readonly uploads = new Map<string, StoredUpload>();

  async findAllUploads(): Promise<StoredUpload[]> {
    return [...this.uploads.values()];
  }

  async findUploadsByFingerprint(fingerprint: string): Promise<StoredUpload[]> {
    const upload = this.uploads.get(storageKey(fingerprint));
    return upload ? [upload] : [];
  }

  async removeUpload(urlStorageKey: string): Promise<void> {
    this.uploads.delete(urlStorageKey);
  }

  async addUpload(fingerprint: string, upload: StoredUpload): Promise<string> {
    const key = storageKey(fingerprint);
    this.uploads.set(key, { ...upload, urlStorageKey: key });
    return key;
  }
}

interface StoredUpload {
  size: number | null;
  metadata: Record<string, string>;
  creationTime: string;
  urlStorageKey: string;
  uploadUrl: string | null;
  parallelUploadUrls: string[] | null;
}

function storageKey(fingerprint: string): string {
  return `tus::${fingerprint}`;
}

function validateTusEndpoint(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw blobUploadError('Blob reservation returned an invalid Storage endpoint.', false);
  }
  const loopback =
    (endpoint.hostname === '127.0.0.1' || endpoint.hostname === 'localhost') &&
    endpoint.protocol === 'http:';
  const directStorage =
    endpoint.protocol === 'https:' &&
    endpoint.hostname.endsWith(DIRECT_STORAGE_HOST_SUFFIX) &&
    /^[a-z0-9-]+$/u.test(endpoint.hostname.slice(0, -DIRECT_STORAGE_HOST_SUFFIX.length));
  if (
    (!loopback && !directStorage) ||
    endpoint.username ||
    endpoint.password ||
    (!loopback && endpoint.port) ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname.replace(/\/+$/u, '') !== '/storage/v1/upload/resumable/sign'
  ) {
    throw blobUploadError('Blob reservation did not use a direct Storage endpoint.', false);
  }
  return endpoint.toString().replace(/\/$/u, '');
}

function validateObjectLocation(bucket: string, path: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,62}$/u.test(bucket)) {
    throw blobUploadError('Blob reservation returned an invalid bucket.', false);
  }
  if (
    !path ||
    path.length > 1_024 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw blobUploadError('Blob reservation returned an invalid object path.', false);
  }
}

function blobIdempotencyKey(versionIdempotencyKey: string, digest: string): string {
  const suffix = createHash('sha256')
    .update(`dnaforge.workspace-sync-blob/v1\n${versionIdempotencyKey}\n${digest}\n`, 'utf8')
    .digest('hex');
  return `blob:${suffix}`;
}

function normalizePollLimit(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    return DESKTOP_SYNC_BLOB_VERIFICATION_MAX_POLLS;
  }
  return Math.min(value as number, DESKTOP_SYNC_BLOB_VERIFICATION_MAX_POLLS);
}

function readTestTusPauseAfterStateWriteMs(): number {
  const value = Number(process.env.DNAFORGE_TEST_TUS_PAUSE_AFTER_STATE_WRITE_MS ?? 0);
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 60_000) : 0;
}

async function hashFile(filePath: string): Promise<string> {
  const digest = createHash('sha256');
  const stream = createReadStream(filePath);
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk: Buffer | string) => digest.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(digest.digest('hex')));
  });
}

async function sleepWithAbort(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function abortError(): Error {
  const error = new Error('Workspace sync blob upload cancelled.');
  error.name = 'AbortError';
  return error;
}

function blobUploadError(
  message: string,
  retryable: boolean
): Error & { code: string; retryable: boolean } {
  return Object.assign(new Error(message), { code: 'BLOB_UPLOAD_FAILED', retryable });
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStoredUpload(value: unknown): value is WorkspaceSyncTusStoredUpload {
  if (!isRecord(value)) return false;
  const metadata = value.metadata;
  return (
    (value.size === null ||
      (typeof value.size === 'number' && Number.isSafeInteger(value.size) && value.size >= 0)) &&
    isRecord(metadata) &&
    Object.values(metadata).every((entry) => typeof entry === 'string') &&
    typeof value.creationTime === 'string' &&
    (value.uploadUrl === null || typeof value.uploadUrl === 'string') &&
    (value.parallelUploadUrls === undefined ||
      value.parallelUploadUrls === null ||
      (Array.isArray(value.parallelUploadUrls) &&
        value.parallelUploadUrls.every((entry) => typeof entry === 'string')))
  );
}

function normalizeStoredUpload(value: WorkspaceSyncTusStoredUpload): WorkspaceSyncTusStoredUpload {
  return {
    size: value.size,
    metadata: { ...value.metadata },
    creationTime: value.creationTime,
    uploadUrl: value.uploadUrl,
    parallelUploadUrls: Array.isArray(value.parallelUploadUrls)
      ? [...value.parallelUploadUrls]
      : null,
  };
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}

async function rmFile(filePath: string): Promise<void> {
  await unlink(filePath).catch((error: unknown) => {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
  });
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}
