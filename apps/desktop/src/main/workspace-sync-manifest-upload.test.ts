import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { defineBlob } from '@waypoint/workspace-revisions';
import { parseScientificCloudHistory } from '@waypoint/scientific-objects';
import {
  DEFAULT_WORKSPACE_SYNC_BUNDLE_LIMITS,
  workspaceSyncManifestHashInput,
  workspaceSyncUploadWireBytes,
  type WorkspaceSyncBundleV1,
} from '@waypoint/share-bundle';

import {
  createDesktopSyncClient,
  type DesktopSyncClient,
  type DesktopSyncRequestOptions,
} from './desktop-sync-client';
import {
  DESKTOP_SYNC_TUS_CHUNK_SIZE,
  createManifestWorkspaceSyncVersion,
  uploadBlobWithTus,
  WorkspaceSyncTusUrlStorage,
  workspaceSyncManifestFromBundle,
} from './workspace-sync-manifest-upload';

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '1.0.0'), isPackaged: false, getPath: vi.fn(() => '/tmp') },
  dialog: { showErrorBox: vi.fn() },
  shell: { openExternal: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(value)),
    decryptString: vi.fn((value: Buffer) => value.toString('utf8')),
  },
}));
vi.mock('@sentry/electron/main', () => ({ captureMessage: vi.fn() }));
vi.mock('./auth/auth-config', () => ({
  getWebBaseUrl: vi.fn(() => 'https://web.test'),
  getAuthChannel: vi.fn(() => 'dev'),
  getRedirectScheme: vi.fn(() => 'dnaforge-dev'),
}));

const REMOTE_WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const BLOB_ID = '22222222-2222-4222-8222-222222222222';
const RESERVATION_ID = '33333333-3333-4333-8333-333333333333';
const VERSION_ID = '44444444-4444-4444-8444-444444444444';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs} ms.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function readHttpBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
    request.once('end', () => resolve(Buffer.concat(chunks)));
    request.once('error', reject);
  });
}

function file(path: string, content: string) {
  const bytes = Buffer.from(content, 'utf8');
  return {
    id: path,
    relativePath: path,
    name: path.split('/').at(-1) ?? path,
    kind: 'notebook' as const,
    contentType: 'text/plain',
    sizeBytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    content,
  };
}

function bundle(): WorkspaceSyncBundleV1 {
  const files = [
    file('zeta.txt', 'zeta\n'),
    file('alpha.txt', 'alpha\n'),
    file('copy.txt', 'alpha\n'),
  ];
  const value: WorkspaceSyncBundleV1 = {
    schemaVersion: 1,
    capturedAt: '2026-09-29T00:00:00.000Z',
    workspace: { id: 'local-workspace', name: 'Manifest upload test' },
    files,
    excludedSummary: {
      unsupported: { count: 0, bytesApprox: 0 },
      'private-raw-data': { count: 0, bytesApprox: 0 },
      'reference-pointer': { count: 0, bytesApprox: 0 },
      'file-too-large': { count: 0, bytesApprox: 0 },
      'bundle-too-large': { count: 0, bytesApprox: 0 },
    },
    limits: DEFAULT_WORKSPACE_SYNC_BUNDLE_LIMITS,
    provenance: {
      source: 'dnaforge-desktop',
      appVersion: 'test',
      contentSha256: '0'.repeat(64),
    },
  };
  return value;
}

describe('workspace-sync manifest/blob upload', () => {
  it('uploads historical CAS bytes separately from current placements and refuses a corrupt archive', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dnaforge-scientific-wire-'));
    try {
      const archive = Buffer.from('supplied scientific archive');
      const historical = Buffer.from('retained historical bytes');
      const archiveBlob = defineBlob(archive),
        oldBlob = defineBlob(historical);
      const archivePath = join(root, 'archive'),
        oldPath = join(root, 'historical');
      writeFileSync(archivePath, archive);
      writeFileSync(oldPath, historical);
      const source = bundle(),
        manifest = workspaceSyncManifestFromBundle(source);
      const scientificHistory = parseScientificCloudHistory({
        formatVersion: 1,
        logicalWorkspaceId: 'portable-project',
        acceptedHead: null,
        archive: archiveBlob,
      });
      const requestJson = vi.fn(async (path: string, options: DesktopSyncRequestOptions) => {
        if (path.endsWith('/blobs/reserve')) {
          const blob = options.body as { contentSha256: string; sizeBytes: number };
          return { status: 'ready', blobId: BLOB_ID, ...blob };
        }
        if (path.endsWith('/versions')) return { status: 'in_progress' };
        throw new Error('Unexpected scientific transport route.');
      });
      const client: DesktopSyncClient = {
        requestJson: requestJson as DesktopSyncClient['requestJson'],
        requestStream: vi.fn(async () => {
          throw new Error('Unexpected stream.');
        }),
      };
      const request = {
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        ownerAccountId: 'account-a',
        idempotencyKey: 'scientific-version',
        baseVersionId: null,
        bundle: source,
        manifest,
        scientificHistory,
        scientificBlobRefs: [oldBlob],
        scientificBlobSources: new Map([
          [archiveBlob.hash, archivePath],
          [oldBlob.hash, oldPath],
        ]),
        fileManifestSha256: createHash('sha256')
          .update(workspaceSyncManifestHashInput(manifest))
          .digest('hex'),
      };
      await createManifestWorkspaceSyncVersion(client, request);
      expect(
        requestJson.mock.calls.filter(([path]) => path.endsWith('/blobs/reserve'))
      ).toHaveLength(4);
      const body = requestJson.mock.calls.find(([path]) => path.endsWith('/versions'))![1].body;
      expect(body).toEqual({
        representation: 'scientific_manifest_v1',
        baseVersionId: null,
        fileSelectionVersion: 0,
        manifest,
        excludedSummary: {},
        scientificHistory,
        scientificBlobRefs: [oldBlob],
      });
      expect(JSON.stringify(body)).not.toContain(root);
      requestJson.mockClear();
      writeFileSync(archivePath, Buffer.alloc(archive.byteLength, 0x78));
      await expect(createManifestWorkspaceSyncVersion(client, request)).rejects.toThrow(
        /bytes do not match/
      );
      expect(requestJson.mock.calls.some(([path]) => path.endsWith('/versions'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('publishes selection version outside portable manifest bytes and keeps ignore counts local', async () => {
    const source = bundle();
    const manifest = workspaceSyncManifestFromBundle(source);
    const requestJson = vi.fn(async (path: string, options: DesktopSyncRequestOptions) => {
      if (path.endsWith('/blobs/reserve')) {
        const blob = options.body as { contentSha256: string; sizeBytes: number };
        return { status: 'ready', blobId: BLOB_ID, ...blob };
      }
      if (path.endsWith('/versions')) return { status: 'in_progress' };
      throw new Error('Unexpected publication route.');
    });
    const client = { requestJson, requestStream: vi.fn() } as unknown as DesktopSyncClient;
    await createManifestWorkspaceSyncVersion(client, {
      remoteWorkspaceId: REMOTE_WORKSPACE_ID,
      ownerAccountId: 'account-a',
      idempotencyKey: 'selected-version',
      baseVersionId: null,
      bundle: source,
      manifest,
      fileSelectionVersion: 1,
      excludedSummary: { unsupportedCount: 2, ignoredCount: 3 },
    });
    const publication = requestJson.mock.calls.find(([path]) => path.endsWith('/versions'))![1];
    expect(publication.expectedAccountId).toBe('account-a');
    expect(publication.idempotencyKey).toBe('selected-version');
    expect(publication.body).toEqual({
      baseVersionId: null,
      fileSelectionVersion: 1,
      manifest,
      excludedSummary: { unsupportedCount: 2 },
    });
    expect(manifest).toEqual(workspaceSyncManifestFromBundle(source));
  });

  it('preserves concurrent resumable upload receipts from separate uploader instances', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dnaforge-tus-concurrent-'));
    const statePath = join(root, 'tus-uploads.json');
    const upload = {
      size: 12,
      metadata: {},
      creationTime: new Date().toString(),
      uploadUrl: 'http://127.0.0.1:54321/uploads/one',
      parallelUploadUrls: null,
    };
    try {
      const keys = await Promise.all(
        Array.from({ length: 16 }, (_, index) =>
          new WorkspaceSyncTusUrlStorage(statePath).addUpload(`file-${index}`, upload)
        )
      );
      const receipts = await new WorkspaceSyncTusUrlStorage(statePath).findAllUploads();
      expect(receipts.map((receipt) => receipt.urlStorageKey).sort()).toEqual(keys.sort());
      await Promise.all(
        keys.map((key) => new WorkspaceSyncTusUrlStorage(statePath).removeUpload(key))
      );
      expect(await new WorkspaceSyncTusUrlStorage(statePath).findAllUploads()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports the Storage rejection when no resumable upload was created', async () => {
    let requests = 0;
    const server = createServer((request, response) => {
      requests += 1;
      request.resume();
      response.writeHead(415, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ message: 'mime type image/png is not supported' }));
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      await expect(
        uploadBlobWithTus({
          bytes: Buffer.from('image'),
          sizeBytes: 5,
          endpoint: `http://127.0.0.1:${port}/storage/v1/upload/resumable/sign`,
          token: 'signed-secret',
          bucket: 'workspace-snapshots',
          path: 'desktop-sync/cas/personal/account/image',
          contentType: 'image/png',
          fingerprint: 'workspace-blob:rejected-image',
        })
      ).rejects.toMatchObject({
        code: 'BLOB_UPLOAD_FAILED',
        message: expect.stringContaining('mime type image/png is not supported'),
      });
      expect(requests).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('keeps the resumable TUS URL across uploader instances', async () => {
    const stagingRoot = mkdtempSync(join(tmpdir(), 'dnaforge-tus-state-'));
    const statePath = join(stagingRoot, 'tus-uploads.json');
    const upload = {
      size: 12,
      metadata: { bucketName: 'workspace-snapshots', objectName: 'blob.bin' },
      creationTime: new Date().toString(),
      uploadUrl: 'http://127.0.0.1:54321/uploads/one',
      parallelUploadUrls: null,
    };

    try {
      const firstProcess = new WorkspaceSyncTusUrlStorage(statePath);
      const key = await firstProcess.addUpload('workspace-blob:fingerprint', upload);
      const secondProcess = new WorkspaceSyncTusUrlStorage(statePath);
      await expect(
        secondProcess.findUploadsByFingerprint('workspace-blob:fingerprint')
      ).resolves.toEqual([{ ...upload, urlStorageKey: key }]);

      await secondProcess.removeUpload(key);
      await expect(
        secondProcess.findUploadsByFingerprint('workspace-blob:fingerprint')
      ).resolves.toEqual([]);
    } finally {
      rmSync(stagingRoot, { recursive: true, force: true });
    }
  });

  it('resumes a direct TUS blob after the first uploader is interrupted', async () => {
    const stagingRoot = mkdtempSync(join(tmpdir(), 'dnaforge-tus-resume-'));
    const statePath = join(stagingRoot, 'tus-uploads.json');
    const bytes = Buffer.alloc(DESKTOP_SYNC_TUS_CHUNK_SIZE * 2 + 123, 0x41);
    const uploadState = { id: 'upload-1', bytes: Buffer.alloc(0), length: bytes.byteLength };
    const secondPatchStarted = deferred<void>();
    let interruptNextPatch = true;
    let creations = 0;
    let resumeHeads = 0;
    const resumedPatchOffsets: number[] = [];
    let restarted = false;
    let serverPort = 0;
    let server: ReturnType<typeof createServer> | undefined;
    let firstAbort: AbortController | undefined;

    const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
      if (request.method === 'POST') {
        creations++;
        const body = await readHttpBody(request);
        uploadState.bytes = Buffer.from(body);
        response.statusCode = 201;
        response.setHeader('Location', `/storage/v1/upload/resumable/sign/${uploadState.id}`);
        response.setHeader('Tus-Resumable', '1.0.0');
        response.setHeader('Upload-Offset', String(uploadState.bytes.byteLength));
        response.end();
        return;
      }
      if (request.url !== `/storage/v1/upload/resumable/sign/${uploadState.id}`) {
        response.statusCode = 404;
        response.end();
        return;
      }
      if (request.method === 'HEAD') {
        if (restarted) resumeHeads++;
        response.statusCode = 200;
        response.setHeader('Tus-Resumable', '1.0.0');
        response.setHeader('Upload-Offset', String(uploadState.bytes.byteLength));
        response.setHeader('Upload-Length', String(uploadState.length));
        response.end();
        return;
      }
      if (request.method !== 'PATCH') {
        response.statusCode = 405;
        response.end();
        return;
      }
      if (interruptNextPatch) {
        interruptNextPatch = false;
        secondPatchStarted.resolve();
        request.resume();
        return;
      }
      const offset = Number(request.headers['upload-offset']);
      if (restarted) resumedPatchOffsets.push(offset);
      expect(offset).toBe(uploadState.bytes.byteLength);
      const body = await readHttpBody(request);
      uploadState.bytes = Buffer.concat([uploadState.bytes, body]);
      response.statusCode = 204;
      response.setHeader('Tus-Resumable', '1.0.0');
      response.setHeader('Upload-Offset', String(uploadState.bytes.byteLength));
      response.end();
    };

    try {
      server = createServer((request, response) => {
        void handleRequest(request, response).catch((error: unknown) => {
          response.destroy(error instanceof Error ? error : new Error(String(error)));
        });
      });
      await new Promise<void>((resolve) => {
        server!.listen(0, '127.0.0.1', () => {
          serverPort = (server!.address() as { port: number }).port;
          resolve();
        });
      });

      const input = {
        bytes,
        sizeBytes: bytes.byteLength,
        endpoint: `http://127.0.0.1:${serverPort}/storage/v1/upload/resumable/sign`,
        token: 'signed-secret',
        bucket: 'workspace-snapshots',
        path: 'desktop-sync/cas/personal/account/blob.bin',
        contentType: 'application/octet-stream',
        fingerprint: 'workspace-blob:resume-test',
        resumeStatePath: statePath,
      } as const;
      firstAbort = new AbortController();
      const firstAttempt = uploadBlobWithTus({ ...input, signal: firstAbort.signal });
      await withTimeout(secondPatchStarted.promise, 10_000);
      firstAbort.abort();
      await expect(firstAttempt).rejects.toMatchObject({ name: 'AbortError' });
      expect(uploadState.bytes.byteLength).toBe(DESKTOP_SYNC_TUS_CHUNK_SIZE);
      await expect(
        new WorkspaceSyncTusUrlStorage(statePath).findUploadsByFingerprint(input.fingerprint)
      ).resolves.toHaveLength(1);

      restarted = true;
      await uploadBlobWithTus(input);
      expect({ creations, resumeHeads }).toEqual({ creations: 1, resumeHeads: 1 });
      expect(resumedPatchOffsets[0]).toBe(DESKTOP_SYNC_TUS_CHUNK_SIZE);
      expect(uploadState.bytes.equals(bytes)).toBe(true);
    } finally {
      firstAbort?.abort();
      await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
      rmSync(stagingRoot, { recursive: true, force: true });
    }
  });

  it('rejects a saved upload for another origin, object, or size before sending any request', async () => {
    const stagingRoot = mkdtempSync(join(tmpdir(), 'dnaforge-tus-scope-'));
    let requests = 0;
    const server = createServer((request, response) => {
      requests++;
      request.resume();
      response.writeHead(404);
      response.end();
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      const endpoint = `http://127.0.0.1:${port}/storage/v1/upload/resumable/sign`;
      const bucket = 'workspace-snapshots';
      const path = 'desktop-sync/cas/personal/account/file.bin';
      const valid = {
        size: 4,
        metadata: { bucketName: bucket, objectName: path },
        creationTime: new Date().toString(),
        uploadUrl: `${endpoint}/transfer-1`,
        parallelUploadUrls: null,
      };
      const invalid = [
        { ...valid, uploadUrl: valid.uploadUrl.replace('127.0.0.1', 'localhost') },
        { ...valid, metadata: { ...valid.metadata, objectName: 'another-owner/file.bin' } },
        { ...valid, size: 5 },
      ];
      for (const [index, saved] of invalid.entries()) {
        const statePath = join(stagingRoot, `state-${index}.json`);
        await new WorkspaceSyncTusUrlStorage(statePath).addUpload('scope-fingerprint', saved);
        await expect(
          uploadBlobWithTus({
            bytes: Buffer.from('test'),
            sizeBytes: 4,
            endpoint,
            token: 'signed-secret',
            bucket,
            path,
            contentType: 'application/octet-stream',
            fingerprint: 'scope-fingerprint',
            resumeStatePath: statePath,
          })
        ).rejects.toMatchObject({
          code: 'BLOB_UPLOAD_FAILED',
          message: 'The saved TUS resource does not match this upload.',
        });
      }
      expect(requests).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(stagingRoot, { recursive: true, force: true });
    }
  });

  it('canonicalizes a bundle into a byte-free manifest and deduplicates blob uploads', () => {
    const manifest = workspaceSyncManifestFromBundle(bundle());
    expect(manifest.files.map((entry) => entry.path)).toEqual([
      'alpha.txt',
      'copy.txt',
      'zeta.txt',
    ]);
    expect(manifest.files[0]?.contentSha256).toBe(manifest.files[1]?.contentSha256);
    expect(JSON.stringify(manifest)).not.toContain('alpha\n');
  });

  it('keeps file bytes on direct Storage and publishes only control JSON through Next', async () => {
    const source = bundle();
    const stagingRoot = mkdtempSync(join(tmpdir(), 'dnaforge-manifest-upload-'));
    const stagedAlphaPath = join(stagingRoot, 'alpha.txt');
    writeFileSync(stagedAlphaPath, 'alpha\n', 'utf8');
    const calls: Array<{ path: string; options: Record<string, unknown> }> = [];
    const reserveCounts = new Map<string, number>();
    const upload = vi.fn(
      async (input: { bytes?: Uint8Array; filePath?: string; endpoint: string; token: string }) => {
        expect(input.endpoint).toBe(
          'https://project-ref.storage.supabase.co/storage/v1/upload/resumable/sign'
        );
        expect(input.token).toBe('signed-secret');
        expect(input.bytes).toBeUndefined();
        expect(input.filePath).toBe(stagedAlphaPath);
        expect(readFileSync(input.filePath!, 'utf8')).toBe('alpha\n');
      }
    );
    const requestJson = vi.fn(async (path: string, options: Record<string, unknown>) => {
      calls.push({ path, options });
      const body = options.body as Record<string, unknown>;
      if (path.endsWith('/blobs/reserve')) {
        const digest = body.contentSha256 as string;
        const count = (reserveCounts.get(digest) ?? 0) + 1;
        reserveCounts.set(digest, count);
        if (digest === source.files[0]?.sha256 || digest === source.files[1]?.sha256) {
          if (count === 1 && digest === source.files[1]?.sha256) {
            return {
              status: 'upload_required',
              reservationId: RESERVATION_ID,
              contentSha256: digest,
              sizeBytes: body.sizeBytes,
              contentType: body.contentType,
              upload: {
                protocol: 'tus',
                endpoint:
                  'https://project-ref.storage.supabase.co/storage/v1/upload/resumable/sign',
                token: 'signed-secret',
                bucket: 'workspace-snapshots',
                path: `owners/personal/account/${digest}`,
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
                upsert: false,
              },
            };
          }
          return {
            status: 'ready',
            blobId: BLOB_ID,
            contentSha256: digest,
            sizeBytes: body.sizeBytes,
          };
        }
      }
      if (path.endsWith('/blobs/complete')) {
        return { status: 'verifying', reservationId: RESERVATION_ID };
      }
      if (path.endsWith('/versions')) {
        const manifest = body.manifest as {
          files: Array<{
            path: string;
            contentSha256: string;
            sizeBytes: number;
            contentType: string;
          }>;
        };
        const manifestSha256 = createHash('sha256')
          .update(
            workspaceSyncManifestHashInput({ schemaVersion: 1, files: manifest.files }),
            'utf8'
          )
          .digest('hex');
        return {
          status: 'ready',
          workspaceId: REMOTE_WORKSPACE_ID,
          version: {
            id: VERSION_ID,
            versionNumber: 2,
            representation: 'manifest_v1',
            contentSha256: manifestSha256,
            sizeBytes: manifest.files.reduce((total, entry) => total + entry.sizeBytes, 0),
            fileCount: manifest.files.length,
          },
        };
      }
      throw new Error(`unexpected control route ${path}`);
    });
    const client = { requestJson } as unknown as DesktopSyncClient;

    const result = await createManifestWorkspaceSyncVersion(
      client,
      {
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        ownerAccountId: 'account-a',
        idempotencyKey: 'version-idempotency',
        baseVersionId: null,
        bundle: source,
        excludedSummary: {
          unsupportedCount: 2,
          privateRawDataCount: 1,
          referencePointerCount: 0,
          fileTooLargeCount: 0,
          bundleTooLargeCount: 0,
        },
        fileSources: new Map([['alpha.txt', stagedAlphaPath]]),
      },
      undefined,
      { uploadBlob: upload, sleep: async () => undefined }
    );

    expect(result).toMatchObject({ status: 'ready', workspaceId: REMOTE_WORKSPACE_ID });
    expect(upload).toHaveBeenCalledTimes(1);
    const reservePath = `/api/desktop-sync/workspaces/${REMOTE_WORKSPACE_ID}/blobs/reserve`;
    const completePath = `/api/desktop-sync/workspaces/${REMOTE_WORKSPACE_ID}/blobs/complete`;
    expect(
      calls
        .slice(0, -1)
        .map((call) => call.path)
        .sort()
    ).toEqual([reservePath, completePath, reservePath, reservePath].sort());
    expect(calls.at(-1)?.path).toBe(`/api/desktop-sync/workspaces/${REMOTE_WORKSPACE_ID}/versions`);
    const completionIndex = calls.findIndex((call) => call.path === completePath);
    const verifiedReadIndex = calls.findLastIndex(
      (call) =>
        call.path === reservePath &&
        (call.options.body as Record<string, unknown>).contentSha256 === source.files[1]!.sha256
    );
    expect(completionIndex).toBeGreaterThan(0);
    expect(verifiedReadIndex).toBeGreaterThan(completionIndex);
    expect(calls.every((call) => (call.options.expectedAccountId as string) === 'account-a')).toBe(
      true
    );
    const serializedControl = JSON.stringify(calls);
    expect(serializedControl).not.toContain('alpha\n');
    expect(serializedControl).not.toContain('signed-secret');
    const manifestBody = calls.at(-1)?.options.body as Record<string, unknown>;
    expect(manifestBody).not.toHaveProperty('bundle');
    expect(manifestBody).not.toHaveProperty('encodedBundle');
    expect(manifestBody.excludedSummary).toEqual({
      unsupportedCount: 2,
      privateRawDataCount: 1,
      referencePointerCount: 0,
      fileTooLargeCount: 0,
      bundleTooLargeCount: 0,
    });
    expect((manifestBody.manifest as Record<string, unknown>).files).toHaveLength(3);
    rmSync(stagingRoot, { recursive: true, force: true });
  });

  it('starts later blob transfers while earlier blobs await hosted verification', async () => {
    const source = bundle();
    source.files = Array.from({ length: 6 }, (_, index) =>
      file(`attachment-${index}.txt`, `independent attachment ${index}\n`)
    );
    const reserveCounts = new Map<string, number>();
    const allTransferred = deferred<void>();
    const verificationGate = deferred<void>();
    let verificationReady = false;
    let transferred = 0;
    const publish = vi.fn(async () => ({ status: 'ready' }));
    const onBlobsReady = vi.fn(async () => undefined);
    const requestJson = vi.fn(async (path: string, options: DesktopSyncRequestOptions) => {
      const body = options.body as Record<string, unknown>;
      if (path.endsWith('/blobs/reserve')) {
        const digest = body.contentSha256 as string;
        const count = (reserveCounts.get(digest) ?? 0) + 1;
        reserveCounts.set(digest, count);
        if (count === 1) {
          return {
            status: 'upload_required',
            reservationId: RESERVATION_ID,
            contentSha256: digest,
            sizeBytes: body.sizeBytes,
            contentType: body.contentType,
            upload: {
              protocol: 'tus',
              endpoint: 'https://project-ref.storage.supabase.co/storage/v1/upload/resumable/sign',
              token: 'signed-secret',
              bucket: 'workspace-snapshots',
              path: `owners/personal/account/${digest}`,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              upsert: false,
            },
          };
        }
        return verificationReady
          ? {
              status: 'ready',
              blobId: BLOB_ID,
              contentSha256: digest,
              sizeBytes: body.sizeBytes,
            }
          : { status: 'verifying', reservationId: RESERVATION_ID };
      }
      if (path.endsWith('/blobs/complete')) {
        return { status: 'verifying', reservationId: RESERVATION_ID };
      }
      if (path.endsWith('/versions')) return publish();
      throw new Error(`unexpected control route ${path}`);
    });
    const publication = createManifestWorkspaceSyncVersion(
      { requestJson } as unknown as DesktopSyncClient,
      {
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        ownerAccountId: 'account-a',
        idempotencyKey: 'verification-backlog',
        baseVersionId: null,
        bundle: source,
      },
      undefined,
      {
        uploadBlob: async () => {
          transferred += 1;
          if (transferred === source.files.length) allTransferred.resolve();
        },
        sleep: () => verificationGate.promise,
        onBlobsReady,
      }
    );
    void publication.catch(() => undefined);
    try {
      await withTimeout(allTransferred.promise, 1_000);
      expect(transferred).toBe(6);
      expect(onBlobsReady).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    } finally {
      verificationReady = true;
      verificationGate.resolve();
      await publication;
    }
    expect(onBlobsReady).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledOnce();
    expect(onBlobsReady.mock.invocationCallOrder[0]).toBeLessThan(
      publish.mock.invocationCallOrder[0]!
    );
  });

  it('starts the largest blob before small transfers occupy every upload slot', async () => {
    const source = bundle();
    source.files = [
      ...Array.from({ length: 4 }, (_, index) =>
        file(`metadata-${index}.txt`, `metadata ${index}`)
      ),
      file('zzz-large-attachment.txt', 'large attachment bytes\n'.repeat(100)),
    ];
    const largest = source.files.at(-1)!;
    const largeStarted = deferred<void>();
    const transferGate = deferred<void>();
    const reserveCounts = new Map<string, number>();
    const publication = createManifestWorkspaceSyncVersion(
      {
        requestJson: async (path: string, options: DesktopSyncRequestOptions) => {
          const body = options.body as Record<string, unknown>;
          if (path.endsWith('/blobs/reserve')) {
            const digest = body.contentSha256 as string;
            const count = (reserveCounts.get(digest) ?? 0) + 1;
            reserveCounts.set(digest, count);
            return count > 1
              ? {
                  status: 'ready',
                  blobId: BLOB_ID,
                  contentSha256: digest,
                  sizeBytes: body.sizeBytes,
                }
              : {
                  status: 'upload_required',
                  reservationId: RESERVATION_ID,
                  contentSha256: digest,
                  sizeBytes: body.sizeBytes,
                  contentType: body.contentType,
                  upload: {
                    protocol: 'tus',
                    endpoint:
                      'https://project-ref.storage.supabase.co/storage/v1/upload/resumable/sign',
                    token: 'signed-secret',
                    bucket: 'workspace-snapshots',
                    path: `owners/personal/account/${digest}`,
                    expiresAt: new Date(Date.now() + 60_000).toISOString(),
                    upsert: false,
                  },
                };
          }
          if (path.endsWith('/blobs/complete'))
            return { status: 'verifying', reservationId: RESERVATION_ID };
          if (path.endsWith('/versions')) {
            expect(body.manifest).toEqual(workspaceSyncManifestFromBundle(source));
            return { status: 'ready' };
          }
          throw new Error(`unexpected control route ${path}`);
        },
      } as unknown as DesktopSyncClient,
      {
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        ownerAccountId: 'account-a',
        idempotencyKey: 'largest-first',
        baseVersionId: null,
        bundle: source,
      },
      undefined,
      {
        uploadBlob: async ({ sizeBytes }) => {
          if (sizeBytes === largest.sizeBytes) largeStarted.resolve();
          await transferGate.promise;
        },
        sleep: async () => undefined,
      }
    );
    void publication.catch(() => undefined);
    try {
      await withTimeout(largeStarted.promise, 1_000);
    } finally {
      transferGate.resolve();
      await publication;
    }
  });

  it('checks verification immediately after completion without an idle poll delay', async () => {
    const source = bundle();
    source.files = source.files.slice(0, 1);
    const target = source.files[0]!;
    let reserveReads = 0;
    const requestJson = vi.fn(async (path: string) => {
      if (path.endsWith('/blobs/reserve')) {
        reserveReads += 1;
        return reserveReads > 1
          ? {
              status: 'ready',
              blobId: BLOB_ID,
              contentSha256: target.sha256,
              sizeBytes: target.sizeBytes,
            }
          : {
              status: 'upload_required',
              reservationId: RESERVATION_ID,
              contentSha256: target.sha256,
              sizeBytes: target.sizeBytes,
              contentType: target.contentType,
              upload: {
                protocol: 'tus',
                endpoint:
                  'https://project-ref.storage.supabase.co/storage/v1/upload/resumable/sign',
                token: 'signed-secret',
                bucket: 'workspace-snapshots',
                path: `owners/personal/account/${target.sha256}`,
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
                upsert: false,
              },
            };
      }
      if (path.endsWith('/blobs/complete'))
        return { status: 'verifying', reservationId: RESERVATION_ID };
      if (path.endsWith('/versions')) return { status: 'ready' };
      throw new Error(`unexpected control route ${path}`);
    });
    const sleep = vi.fn(async () => {
      throw new Error('An already verified blob must not wait for a polling timer.');
    });
    await createManifestWorkspaceSyncVersion(
      { requestJson } as unknown as DesktopSyncClient,
      {
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        ownerAccountId: 'account-a',
        idempotencyKey: 'immediate-ready',
        baseVersionId: null,
        bundle: source,
      },
      undefined,
      { uploadBlob: async () => undefined, sleep }
    );
    expect(reserveReads).toBe(2);
    expect(sleep).not.toHaveBeenCalled();
    expect(requestJson.mock.calls.map(([path]) => path.split('/').at(-1))).toEqual([
      'reserve',
      'complete',
      'reserve',
      'versions',
    ]);
  });

  it('streams a 50 MiB staged blob without placing bytes in control JSON', async () => {
    const stagingRoot = mkdtempSync(join(tmpdir(), 'dnaforge-manifest-large-upload-'));
    const stagedPath = join(stagingRoot, 'large.gb');
    const bytes = Buffer.alloc(50 * 1024 * 1024, 0x41);
    writeFileSync(stagedPath, bytes);
    const contentSha256 = createHash('sha256').update(bytes).digest('hex');
    const source = bundle();
    const largeBundle: WorkspaceSyncBundleV1 = {
      ...source,
      files: [
        {
          ...source.files[0],
          id: 'large.gb',
          relativePath: 'large.gb',
          name: 'large.gb',
          sizeBytes: bytes.byteLength,
          sha256: contentSha256,
          content: '',
        },
      ],
    };
    const manifest = workspaceSyncManifestFromBundle(largeBundle);
    const manifestContentSha256 = createHash('sha256')
      .update(workspaceSyncManifestHashInput(manifest), 'utf8')
      .digest('hex');
    const calls: Array<{ path: string; options: DesktopSyncRequestOptions }> = [];
    const upload = vi.fn(
      async (input: { bytes?: Uint8Array; filePath?: string; sizeBytes: number }) => {
        expect(input.bytes).toBeUndefined();
        expect(input.filePath).toBe(stagedPath);
        expect(input.sizeBytes).toBe(bytes.byteLength);
      }
    );
    let reserveReads = 0;
    const requestJson = vi.fn(async (path: string, options: DesktopSyncRequestOptions) => {
      calls.push({ path, options });
      const body = options.body as Record<string, unknown>;
      if (path.endsWith('/blobs/reserve')) {
        reserveReads += 1;
        if (reserveReads === 1) {
          return {
            status: 'upload_required',
            reservationId: RESERVATION_ID,
            contentSha256,
            sizeBytes: bytes.byteLength,
            contentType: 'text/plain',
            upload: {
              protocol: 'tus',
              endpoint: 'https://project-ref.storage.supabase.co/storage/v1/upload/resumable/sign',
              token: 'signed-secret',
              bucket: 'workspace-snapshots',
              path: `owners/personal/account/${contentSha256}`,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              upsert: false,
            },
          };
        }
        return {
          status: 'ready',
          blobId: BLOB_ID,
          contentSha256: body.contentSha256,
          sizeBytes: body.sizeBytes,
        };
      }
      if (path.endsWith('/blobs/complete')) {
        return { status: 'verifying', reservationId: RESERVATION_ID };
      }
      if (path.endsWith('/versions')) {
        return {
          status: 'ready',
          workspaceId: REMOTE_WORKSPACE_ID,
          version: {
            id: VERSION_ID,
            versionNumber: 1,
            representation: 'manifest_v1',
            contentSha256: manifestContentSha256,
            sizeBytes: bytes.byteLength,
            fileCount: 1,
          },
        };
      }
      throw new Error(`unexpected control route ${path}`);
    });
    const client: DesktopSyncClient = {
      requestJson: requestJson as DesktopSyncClient['requestJson'],
      requestStream: vi.fn(async () => {
        throw new Error('unexpected stream request');
      }),
    };

    await createManifestWorkspaceSyncVersion(
      client,
      {
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        ownerAccountId: 'account-a',
        idempotencyKey: 'large-version-idempotency',
        baseVersionId: null,
        manifest,
        fileSources: new Map([['large.gb', stagedPath]]),
      },
      undefined,
      { uploadBlob: upload, sleep: async () => undefined }
    );

    expect(upload).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(calls)).not.toContain('A'.repeat(1024));
    expect(calls.at(-1)?.path).toMatch(/\/versions$/u);
    rmSync(stagingRoot, { recursive: true, force: true });
  });

  it('rejects a generic Supabase endpoint before a byte upload', async () => {
    const source = bundle();
    const upload = vi.fn(async () => undefined);
    const requestJson = vi.fn(async (path: string) => {
      if (path.endsWith('/blobs/reserve')) {
        return {
          status: 'upload_required',
          reservationId: RESERVATION_ID,
          contentSha256: source.files[0]?.sha256,
          sizeBytes: source.files[0]?.sizeBytes,
          contentType: source.files[0]?.contentType,
          upload: {
            protocol: 'tus',
            endpoint: 'https://project-ref.supabase.co/storage/v1/upload/resumable',
            token: 'signed-secret',
            bucket: 'workspace-snapshots',
            path: 'owners/personal/account/blob',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            upsert: false,
          },
        };
      }
      throw new Error(`unexpected route ${path}`);
    });
    await expect(
      createManifestWorkspaceSyncVersion(
        { requestJson } as unknown as DesktopSyncClient,
        {
          remoteWorkspaceId: REMOTE_WORKSPACE_ID,
          ownerAccountId: 'account-a',
          idempotencyKey: 'version-idempotency',
          baseVersionId: null,
          bundle: source,
        },
        undefined,
        { uploadBlob: upload, sleep: async () => undefined }
      )
    ).rejects.toMatchObject({ code: 'BLOB_UPLOAD_FAILED', retryable: false });
    expect(upload).not.toHaveBeenCalled();
  });

  it('keeps the legacy route decision below the platform body ceiling', () => {
    expect(workspaceSyncUploadWireBytes(null, bundle())).toBeLessThan(4 * 1024 * 1024);
  });
});

describe('pending sequence-package publication', () => {
  function transport(response: (attempt: number) => Response) {
    const calls: Array<{ path: string; body: string; key: string | null; account: string | null }> =
      [];
    let versionCalls = 0;
    const client = createDesktopSyncClient({
      baseUrl: 'https://web.test',
      getActiveStoredSession: async () => ({
        accountId: 'account-a',
        desktopSessionId: 'session-a',
        accessToken: 'test-access-token',
        refreshToken: 'test-refresh-token',
        accessTokenExpiresAt: '2030-01-01T00:00:00.000Z',
        channel: 'dev',
        updatedAt: 0,
      }),
      performRefresh: async () => ({ status: 'refreshed' }),
      fetch: async (url, init) => {
        const path = new URL(String(url)).pathname;
        const body = String(init?.body ?? '');
        const headers = new Headers(init?.headers);
        calls.push({
          path,
          body,
          key: headers.get('Idempotency-Key'),
          account: headers.get('Authorization'),
        });
        if (path.endsWith('/blobs/reserve')) {
          const file = JSON.parse(body) as { contentSha256: string; sizeBytes: number };
          return new Response(JSON.stringify({ status: 'ready', blobId: BLOB_ID, ...file }), {
            headers: { 'content-type': 'application/json' },
          });
        }
        if (path.endsWith('/versions')) return response(++versionCalls);
        throw new Error('Unexpected route: ' + path);
      },
    });
    return { client, calls, versionCalls: () => versionCalls };
  }
  const pending = () =>
    new Response(
      JSON.stringify({
        code: 'SEQUENCE_PACKAGE_ADMISSION_PENDING',
        message: 'Stored sequence packages are being verified.',
      }),
      { status: 503, headers: { 'content-type': 'application/json' } }
    );
  const request = () => ({
    remoteWorkspaceId: REMOTE_WORKSPACE_ID,
    ownerAccountId: 'account-a',
    idempotencyKey: 'immutable-publication',
    baseVersionId: VERSION_ID,
    bundle: bundle(),
  });

  it('waits for inspection and publishes the exact immutable request without retransferring verified blobs', async () => {
    const t = transport((attempt) =>
      attempt < 3 ? pending() : new Response(JSON.stringify({ status: 'ready' }))
    );
    const sleep = vi.fn(async () => undefined);
    const onBlobsReady = vi.fn(async () => undefined);
    await expect(
      createManifestWorkspaceSyncVersion(t.client, request(), undefined, {
        sleep,
        onBlobsReady,
        maxVerificationPolls: 3,
      })
    ).resolves.toEqual({ status: 'ready' });
    const publications = t.calls.filter((call) => call.path.endsWith('/versions'));
    expect(publications).toHaveLength(3);
    expect(new Set(publications.map((call) => JSON.stringify(call))).size).toBe(1);
    expect(publications[0]?.key).toBe('immutable-publication');
    expect(JSON.parse(publications[0]!.body).baseVersionId).toBe(VERSION_ID);
    expect(t.calls.filter((call) => call.path.endsWith('/blobs/reserve'))).toHaveLength(2);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(onBlobsReady).toHaveBeenCalledTimes(1);
  });

  it.each([
    { code: 'BACKEND', status: 503, expected: 'SERVER' },
    { code: 'CONFLICT', status: 409, expected: 'CONFLICT' },
    { code: 'IDEMPOTENCY_CONFLICT', status: 409, expected: 'IDEMPOTENCY_CONFLICT' },
    { code: 'SEQUENCE_PACKAGE_INVALID', status: 422, expected: 'VALIDATION' },
    { code: 'SEQUENCE_PACKAGE_ADMISSION_UNSUPPORTED', status: 422, expected: 'VALIDATION' },
  ])(
    'leaves $code to the durable worker instead of polling it as inspection',
    async ({ code, status, expected }) => {
      const t = transport(
        () =>
          new Response(JSON.stringify({ code, message: 'Publication refused.' }), {
            status,
            headers: { 'content-type': 'application/json' },
          })
      );
      const sleep = vi.fn(async () => undefined);
      await expect(
        createManifestWorkspaceSyncVersion(t.client, request(), undefined, {
          sleep,
          maxVerificationPolls: 3,
        })
      ).rejects.toMatchObject({ code: expected });
      expect(t.versionCalls()).toBe(1);
      expect(sleep).not.toHaveBeenCalled();
    }
  );

  it('returns pending inspection to the durable worker when its finite poll budget ends', async () => {
    const t = transport(pending);
    const sleep = vi.fn(async () => undefined);
    await expect(
      createManifestWorkspaceSyncVersion(t.client, request(), undefined, {
        sleep,
        maxVerificationPolls: 2,
      })
    ).rejects.toMatchObject({ code: 'IN_PROGRESS', retryable: true, terminal: false });
    expect(t.versionCalls()).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(
      new Set(t.calls.filter((call) => call.path.endsWith('/versions')).map((call) => call.body))
        .size
    ).toBe(1);
  });

  it('stops before another publication when cancellation arrives during inspection', async () => {
    const t = transport(pending);
    const controller = new AbortController();
    await expect(
      createManifestWorkspaceSyncVersion(t.client, request(), controller.signal, {
        sleep: async () => {
          controller.abort();
        },
        maxVerificationPolls: 3,
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(t.versionCalls()).toBe(1);
  });
});
