import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import {
  resolveWorkspaceSyncBundleLimits,
  workspaceSyncManifestHashInput,
  workspaceSyncBundleHashInput,
  type WorkspaceSyncManifestV1,
  type WorkspaceSyncBundleV1,
  type WorkspaceSyncBundleV3,
  type WorkspaceSyncPublicationPolicy,
} from '@waypoint/share-bundle';

vi.mock('../workspace-sync-direct-upload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workspace-sync-direct-upload')>()),
  uploadWorkspaceSyncFileDirect: vi.fn(),
}));

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

vi.mock('@sentry/electron/main', () => ({
  captureMessage: vi.fn(),
}));

vi.mock('../auth/auth-config', () => ({
  getWebBaseUrl: vi.fn(() => 'https://web.test'),
  getAuthChannel: vi.fn(() => 'dev'),
  getRedirectScheme: vi.fn(() => 'dnaforge-dev'),
}));

vi.mock('../workspace-sync-projection', () => ({
  prepareWorkspaceSyncProjection: vi.fn(() => ({
    notebooksMirrored: 0,
    limsAppendedEvents: 0,
    limsLogFiles: [],
  })),
}));

import { recordPendingWorkspaceSyncRendererRefresh } from '../workspace-sync-renderer-refresh-pending';
import { ensureSchema } from '../schema';
import { createDesktopSyncClient, type DesktopSyncClient } from '../desktop-sync-client';
import {
  WORKSPACE_SYNC_RECOVERY_RETENTION_MS,
  workspaceSyncRecoveryCandidateRequest,
  type WorkspaceSyncRecoveryCandidateRequest,
} from '../workspace-sync-recovery-candidate';
import {
  ensureWorkspaceSyncRecoveryCandidateIntent,
  readWorkspaceSyncRecoveryCandidateIntent,
} from '../workspace-sync-upload-snapshots';
import { uploadWorkspaceSyncFileDirect } from '../workspace-sync-direct-upload';
import * as manifestUpload from '../workspace-sync-manifest-upload';
import {
  createWorkspaceSyncUploadClient,
  assertWorkspaceSyncUploadFitsWire,
  WorkspaceSyncUploadWorker,
  type WorkspaceSyncUploadClient,
  type WorkspaceSyncUploadWorkerDeps,
} from '../workspace-sync-upload-worker';
import { createTestDb } from './test-db';
import {
  enqueueWorkspaceSyncJob,
  markWorkspaceSyncJobFailed,
  requeueWorkspaceSyncJob,
  claimNextWorkspaceSyncJob,
  recoverWorkspaceSyncQueue,
} from '../workspace-sync-queue';
import { acquireWorkspaceMutationShared } from '../workspace-sync-mutation-lease';
import { readWorkspaceSyncStatus } from '../workspace-sync-status';
import { recordWorkspaceSyncReplicaFiles } from '../workspace-sync-replica-files';
import {
  assertRendererDatabaseStatementAllowed,
  notifyRendererDatabaseStatementSettled,
} from '../workspace-sync-database-fence';
import {
  recordWorkspaceSyncUploadSnapshot,
  workspaceSyncUploadSnapshotDirectory,
} from '../workspace-sync-upload-snapshots';
import {
  assertWorkspaceSyncUploadCaptureMatchesCommit,
  type WorkspaceSyncUploadCapture,
} from '../workspace-sync-snapshotter';
import { commitAllIfDirty, initManagedRepo, resolveHeadCommit } from '../workspace-git';
import { workspaceSyncScientificContentSha256 } from '../workspace-sync-scientific-history';
import {
  configureWorkspaceSyncUploadTelemetry,
  type WorkspaceSyncUploadTelemetryEvent,
} from '../workspace-sync-upload-telemetry';
import {
  acceptWorkspaceSyncRecoveryTelemetry,
  configureWorkspaceSyncRecoveryTelemetry,
  WORKSPACE_SYNC_RECOVERY_RECEIPT_PREFIX,
  type WorkspaceSyncRecoveryTelemetryEvent,
} from '../workspace-sync-recovery-telemetry';

const BUNDLE_METADATA = new Map<string, { sizeBytes: number; fileCount: number }>();
const CONTENT_A = bundleFor('workspace-a').provenance.contentSha256;
const CONTENT_B = bundleFor('workspace-b').provenance.contentSha256;
const BASE_CONTENT = 'b'.repeat(64);
const REMOTE_WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const REMOTE_VERSION_ID = '22222222-2222-4222-8222-222222222222';
const TEST_STORAGE_POLICY = {
  schemaVersion: 1 as const,
  policyKey: 'test-expanded',
  revision: 1,
  maxFileBytes: 12 * 1024 ** 3,
  maxProjectBytes: 120 * 1024 ** 3,
  maxFiles: 2000,
  storageQuotaBytes: 240 * 1024 ** 3,
};

function publicationPolicy(policy = TEST_STORAGE_POLICY): WorkspaceSyncPublicationPolicy {
  return {
    schema: 'dnaforge.workspace-sync-publication-policy/v1',
    policy,
    fileSelection: { supportedVersion: 1, requiredVersion: 0 },
  };
}

describe('manifest upload scheduling', () => {
  beforeEach(() => {
    vi.mocked(uploadWorkspaceSyncFileDirect).mockReset();
  });

  it('requires complete scientific placement and history authority before accepting an upload receipt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scientific-upload-receipt-'));
    try {
      const bytes = Buffer.from('retained project bytes');
      const archiveBytes = Buffer.from('transport fixture archive');
      const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
      const filePath = join(root, 'current'),
        archivePath = join(root, 'archive');
      writeFileSync(filePath, bytes);
      writeFileSync(archivePath, archiveBytes);
      const fileManifest: WorkspaceSyncManifestV1 = {
        schemaVersion: 1,
        files: [
          {
            path: 'notes.md',
            contentSha256: digest(bytes),
            sizeBytes: bytes.length,
            contentType: 'text/markdown',
          },
        ],
      };
      const fileManifestSha256 = createHash('sha256')
        .update(workspaceSyncManifestHashInput(fileManifest))
        .digest('hex');
      const scientificHistory = {
        formatVersion: 1 as const,
        logicalWorkspaceId: 'ws1' as never,
        acceptedHead: null,
        archive: {
          hash: `sha256:${digest(archiveBytes)}` as never,
          byteLength: archiveBytes.length,
        },
      };
      const scientificBlobRefs = [
        { hash: `sha256:${digest(bytes)}` as never, byteLength: bytes.length },
      ];
      const ownerAccountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const request = {
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        ownerAccountId,
        baseVersionId: null,
        idempotencyKey: 'scientific-complete-receipt',
        manifest: fileManifest,
        fileManifestSha256,
        scientificHistory,
        scientificBlobRefs,
        fileSources: new Map([['notes.md', filePath]]),
        scientificBlobSources: new Map([
          [scientificHistory.archive.hash, archivePath],
          [scientificBlobRefs[0].hash, filePath],
        ]),
      };
      const authority = {
        status: 'ready',
        workspaceId: REMOTE_WORKSPACE_ID,
        version: {
          id: REMOTE_VERSION_ID,
          versionNumber: 1,
          representation: 'scientific_manifest_v1',
          fileManifestSha256,
          contentSha256: workspaceSyncScientificContentSha256(
            fileManifestSha256,
            scientificHistory
          ),
          sizeBytes: bytes.length,
          fileCount: 1,
          createdAt: '2026-10-13T00:00:00.000Z',
          finalizedAt: '2026-10-13T00:00:01.000Z',
        },
        manifest: fileManifest,
        resourceIdentities: [{ path: 'notes.md', resourceId: REMOTE_VERSION_ID }],
        scientificHistory,
        scientificBlobRefs,
      };
      let returned: Record<string, unknown> = authority;
      const expectedRecovery = workspaceSyncRecoveryCandidateRequest({
        ...request,
        reason: 'dirty',
      });
      const transport: DesktopSyncClient = {
        requestStream: vi.fn(),
        requestJson: async <T>(
          path: string,
          options: Parameters<DesktopSyncClient['requestJson']>[1]
        ) => {
          expect(options.expectedAccountId).toBe(ownerAccountId);
          if (path.endsWith('/storage-policy?fileSelectionVersion=1'))
            return publicationPolicy() as T;
          if (path.endsWith('/reserve')) {
            const body = options.body as { contentSha256: string; sizeBytes: number };
            return { status: 'ready', blobId: REMOTE_VERSION_ID, ...body } as T;
          }
          if (path.endsWith('/recovery-candidates'))
            return {
              status: 'retained',
              workspaceId: REMOTE_WORKSPACE_ID,
              candidate: {
                id: REMOTE_VERSION_ID,
                accountId: ownerAccountId,
                baseVersionId: null,
                contentSha256: expectedRecovery.contentSha256,
                requestSha256: expectedRecovery.requestSha256,
                reason: 'dirty',
                coverage: 'captured-bytes',
                createdAt: '2026-10-13T00:00:00.000Z',
                expiresAt: '2026-10-20T00:00:00.000Z',
                representation: 'scientific_manifest_v1',
                fileManifestSha256,
                scientificHistory,
                scientificBlobRefs,
              },
            } as T;
          return returned as T;
        },
      };
      const client = createWorkspaceSyncUploadClient(transport);
      await expect(client.createVersion(request)).resolves.toMatchObject(authority);
      for (const missing of ['manifest', 'resourceIdentities', 'scientificBlobRefs']) {
        returned = { ...authority };
        delete returned[missing];
        await expect(client.createVersion(request)).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
      }
      returned = {
        ...authority,
        resourceIdentities: [{ path: 'different.md', resourceId: REMOTE_VERSION_ID }],
      };
      await expect(client.createVersion(request)).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refreshes an account-bound policy on each retry and rejects a downgrade before reserving bytes', async () => {
    const base = bundleFor('policy-change');
    const bundle: WorkspaceSyncBundleV3 = {
      ...base,
      schemaVersion: 3,
      files: [{ ...base.files[0], sizeBytes: 8 * 1024 ** 3, content: '', encoding: 'blob' }],
    };
    let policy = TEST_STORAGE_POLICY;
    let reserves = 0;
    let publications = 0;
    const reads: string[] = [];
    const transport: DesktopSyncClient = {
      requestStream: vi.fn(),
      requestJson: async <T>(
        path: string,
        options: Parameters<DesktopSyncClient['requestJson']>[1]
      ) => {
        expect(options.expectedAccountId).toBe('account-a');
        if (path.endsWith('/storage-policy?fileSelectionVersion=1')) {
          reads.push(path);
          expect(options.method).toBe('GET');
          return publicationPolicy(policy) as T;
        }
        if (path.endsWith('/recovery-candidates')) return recoveryResponse(options.body) as T;
        if (path.endsWith('/reserve')) {
          reserves++;
          return {
            status: 'ready',
            blobId: REMOTE_VERSION_ID,
            contentSha256: bundle.files[0].sha256,
            sizeBytes: bundle.files[0].sizeBytes,
          } as T;
        }
        publications++;
        return {
          ...readyVersion(REMOTE_VERSION_ID, 1, base.provenance.contentSha256),
          workspaceId: REMOTE_WORKSPACE_ID,
        } as T;
      },
    };
    const client = createWorkspaceSyncUploadClient(transport);
    const request = {
      remoteWorkspaceId: REMOTE_WORKSPACE_ID,
      ownerAccountId: 'account-a',
      idempotencyKey: 'policy-change',
      baseVersionId: null,
      bundle,
    };
    await client.createVersion(request);
    policy = { ...policy, revision: 2, maxFileBytes: 1024 };
    await expect(client.createVersion(request)).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
      retryable: false,
    });
    expect(reads).toHaveLength(2);
    expect(reserves).toBe(1);
    expect(publications).toBe(1);
    expect(uploadWorkspaceSyncFileDirect).not.toHaveBeenCalled();
  });

  it('fails closed on malformed policy data before any storage request', async () => {
    const base = bundleFor('missing-policy');
    const requestJson = vi.fn(async () =>
      publicationPolicy({ ...TEST_STORAGE_POLICY, maxFileBytes: 0 })
    );
    const client = createWorkspaceSyncUploadClient({ requestJson } as unknown as DesktopSyncClient);
    await expect(
      client.createVersion({
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        ownerAccountId: 'account-a',
        idempotencyKey: 'missing-policy',
        baseVersionId: null,
        bundle: {
          ...base,
          schemaVersion: 3,
          files: [{ ...base.files[0], content: '', encoding: 'blob' }],
        },
      })
    ).rejects.toMatchObject({ code: 'UPGRADE_REQUIRED' });
    expect(requestJson).toHaveBeenCalledTimes(1);
    expect(uploadWorkspaceSyncFileDirect).not.toHaveBeenCalled();
  });

  it('handles the full 2,000-file manifest without uploading already verified bytes', async () => {
    const base = bundleFor('many-files');
    const bundle: WorkspaceSyncBundleV3 = {
      ...base,
      schemaVersion: 3,
      files: Array.from({ length: 2000 }, (_, index) => ({
        ...base.files[0],
        id: `file-${index}`,
        relativePath: `design-${index}.gb`,
        sha256: createHash('sha256').update(String(index)).digest('hex'),
        content: '',
        encoding: 'blob',
      })),
    };
    let reservations = 0;
    let publications = 0;
    const transport: DesktopSyncClient = {
      requestStream: async () => {
        throw new Error('Unexpected stream request');
      },
      requestJson: async <T>(
        path: string,
        options: Parameters<DesktopSyncClient['requestJson']>[1]
      ) => {
        if (path.endsWith('/storage-policy?fileSelectionVersion=1'))
          return publicationPolicy() as T;
        if (path.endsWith('/recovery-candidates')) return recoveryResponse(options.body) as T;
        if (path.endsWith('/reserve')) {
          reservations++;
          const body = options.body as Record<string, unknown>;
          return {
            status: 'ready',
            blobId: REMOTE_VERSION_ID,
            contentSha256: body.contentSha256,
            sizeBytes: body.sizeBytes,
          } as T;
        }
        publications++;
        expect(reservations).toBe(2000);
        expect(JSON.stringify(options.body).length).toBeLessThan(4 * 1024 * 1024);
        return {
          ...readyVersion(REMOTE_VERSION_ID, 1, base.provenance.contentSha256),
          workspaceId: REMOTE_WORKSPACE_ID,
        } as T;
      },
    };
    await createWorkspaceSyncUploadClient(transport).createVersion({
      remoteWorkspaceId: REMOTE_WORKSPACE_ID,
      ownerAccountId: 'account-a',
      idempotencyKey: 'many-files',
      baseVersionId: null,
      bundle,
    });
    expect(publications).toBe(1);
    expect(uploadWorkspaceSyncFileDirect).not.toHaveBeenCalled();
  });

  it('aborts and drains sibling transfers on account change while preserving the original failure', async () => {
    const base = bundleFor('account-fence');
    const bundle: WorkspaceSyncBundleV3 = {
      ...base,
      schemaVersion: 3,
      files: Array.from({ length: 12 }, (_, index) => ({
        ...base.files[0],
        id: `file-${index}`,
        relativePath: `design-${index}.gb`,
        sha256: createHash('sha256').update(String(index)).digest('hex'),
        content: '',
        encoding: 'blob',
      })),
    };
    const accountError = Object.assign(new Error('Account changed.'), { code: 'ACCOUNT_CHANGED' });
    let reservations = 0;
    let active = 0;
    let terminalRequests = 0;
    vi.mocked(uploadWorkspaceSyncFileDirect).mockImplementation(
      async (_file, _capability, _key, options) => {
        const signal = options?.signal;
        if (!signal) throw new Error('Every transfer must receive an abort signal.');
        active++;
        try {
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            });
          });
        } finally {
          active--;
        }
      }
    );
    const transport: DesktopSyncClient = {
      requestStream: async () => {
        throw new Error('Unexpected stream request');
      },
      requestJson: async <T>(
        path: string,
        options: Parameters<DesktopSyncClient['requestJson']>[1]
      ) => {
        if (path.endsWith('/storage-policy?fileSelectionVersion=1'))
          return publicationPolicy() as T;
        if (!path.endsWith('/reserve')) {
          terminalRequests++;
          throw new Error('Must not complete or publish after account switch');
        }
        reservations++;
        const body = options.body as Record<string, unknown>;
        if (body.contentSha256 === bundle.files[0].sha256) {
          await new Promise((resolve) => setTimeout(resolve, 30));
          throw accountError;
        }
        return {
          status: 'upload_required',
          reservationId: REMOTE_VERSION_ID,
          contentSha256: body.contentSha256,
          sizeBytes: body.sizeBytes,
          upload: {
            protocol: 'tus',
            endpoint: 'https://fixture.storage.supabase.co/storage/v1/upload/resumable/sign',
            token: 'fixture',
            bucket: 'workspace-snapshots',
            path: `owner/${body.contentSha256}`,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            upsert: false,
          },
        } as T;
      },
    };
    await expect(
      createWorkspaceSyncUploadClient(transport).createVersion({
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        ownerAccountId: 'account-a',
        idempotencyKey: 'account-fence',
        baseVersionId: null,
        bundle,
      })
    ).rejects.toBe(accountError);
    expect(reservations).toBe(4);
    expect(active).toBe(0);
    expect(terminalRequests).toBe(0);
  });

  it('uploads unique files with bounded concurrency before verification, then publishes metadata once', async () => {
    const base = bundleFor('large-project');
    const files = Array.from({ length: 12 }, (_, index) => ({
      ...base.files[0],
      id: `file-${index}`,
      relativePath: `design-${index}.gb`,
      sha256: createHash('sha256').update(String(index)).digest('hex'),
      content: '',
      encoding: 'blob' as const,
    }));
    const bundle: WorkspaceSyncBundleV3 = {
      ...base,
      schemaVersion: 3,
      files: [...files, { ...files[0], id: 'duplicate', relativePath: 'duplicate.gb' }],
    };
    const completed = new Set<string>();
    const calls: Array<{ path: string; body: unknown; accountId: string | undefined }> = [];
    let verificationReady = false;
    let active = 0;
    let peak = 0;
    vi.mocked(uploadWorkspaceSyncFileDirect).mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
    });
    const transport: DesktopSyncClient = {
      requestStream: async () => {
        throw new Error('Unexpected stream request');
      },
      requestJson: async <T>(
        path: string,
        options: Parameters<DesktopSyncClient['requestJson']>[1]
      ) => {
        if (path.endsWith('/storage-policy?fileSelectionVersion=1'))
          return publicationPolicy() as T;
        if (path.endsWith('/recovery-candidates')) return recoveryResponse(options.body) as T;
        calls.push({ path, body: options.body, accountId: options.expectedAccountId });
        const body = options.body as Record<string, unknown>;
        if (path.endsWith('/reserve')) {
          const digest = String(body.contentSha256);
          const common = { contentSha256: digest, sizeBytes: body.sizeBytes };
          return (
            completed.has(digest)
              ? verificationReady
                ? { ...common, status: 'ready', blobId: REMOTE_VERSION_ID }
                : { ...common, status: 'verifying' }
              : {
                  ...common,
                  status: 'upload_required',
                  reservationId: digest,
                  upload: {
                    protocol: 'tus',
                    endpoint:
                      'https://fixture.storage.supabase.co/storage/v1/upload/resumable/sign',
                    token: 'fixture',
                    bucket: 'workspace-snapshots',
                    path: `owner/${digest}`,
                    expiresAt: new Date(Date.now() + 60_000).toISOString(),
                    upsert: false,
                  },
                }
          ) as T;
        }
        if (path.endsWith('/complete')) {
          completed.add(String(body.reservationId));
          return { status: verificationReady ? 'ready' : 'verifying' } as T;
        }
        expect(verificationReady).toBe(true);
        expect(completed.size).toBe(files.length);
        return {
          ...readyVersion(REMOTE_VERSION_ID, 1, base.provenance.contentSha256),
          workspaceId: REMOTE_WORKSPACE_ID,
        } as T;
      },
    };
    const operation = createWorkspaceSyncUploadClient(transport).createVersion({
      remoteWorkspaceId: REMOTE_WORKSPACE_ID,
      ownerAccountId: 'account-a',
      idempotencyKey: 'manifest-upload',
      baseVersionId: null,
      bundle,
    });
    try {
      await vi.waitFor(() => expect(completed.size).toBe(files.length), { timeout: 500 });
      expect(calls.some(({ path }) => path.endsWith('/versions'))).toBe(false);
      expect(peak).toBe(4);
    } finally {
      verificationReady = true;
      await operation;
    }
    expect(active).toBe(0);
    expect(uploadWorkspaceSyncFileDirect).toHaveBeenCalledTimes(files.length);
    expect(calls.every(({ accountId }) => accountId === 'account-a')).toBe(true);
    const published = calls.filter(({ path }) => path.endsWith('/versions'));
    expect(published).toHaveLength(1);
    expect(JSON.stringify(published[0].body)).not.toContain('"content":');
    expect(JSON.stringify(published[0].body)).not.toContain('"encoding":');
  });
});

describe('workspace sync upload worker', () => {
  it('admits a single 50 MiB streamed manifest at the final wire check', () => {
    const file = {
      path: 'large.fasta',
      contentSha256: 'a'.repeat(64),
      sizeBytes: 50 * 1024 * 1024,
      contentType: 'text/plain',
    };
    const manifest: WorkspaceSyncManifestV1 = {
      schemaVersion: 1,
      files: [file],
    };
    expect(() =>
      assertWorkspaceSyncUploadFitsWire(undefined, null, { allowManifest: true, manifest })
    ).not.toThrow();
    expect(() =>
      assertWorkspaceSyncUploadFitsWire(undefined, null, { allowManifest: false, manifest })
    ).toThrow('not supported');
    expect(() =>
      assertWorkspaceSyncUploadFitsWire(undefined, null, {
        allowManifest: true,
        manifest: {
          ...manifest,
          files: [{ ...file, sizeBytes: 5 * 1024 * 1024 * 1024 + 1 }],
        },
      })
    ).not.toThrow();
    expect(() =>
      assertWorkspaceSyncUploadFitsWire(undefined, null, {
        allowManifest: true,
        manifest: {
          ...manifest,
          files: [{ ...file, sizeBytes: Number.MAX_SAFE_INTEGER + 1 }],
        },
      })
    ).toThrow('invalid');
  });

  let db: Database.Database;
  let nowMs: number;
  let timers: Array<{ callback: () => void | Promise<void>; ms: number; cleared: boolean }>;
  let snapshotWorkspace: ReturnType<typeof vi.fn>;
  let createVersion: ReturnType<typeof vi.fn>;
  let nextJobId: string;

  beforeEach(() => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
    nowMs = 100;
    timers = [];
    nextJobId = 'queue-a';
    snapshotWorkspace = vi.fn(async () => snapshot('workspace-a', CONTENT_A, 'head-a'));
    createVersion = vi.fn(async () => readyVersion('remote-version-a', 2, CONTENT_A));
    seedSyncWorkspace(db, {
      workspaceId: 1,
      workspaceUuid: 'workspace-a',
      accountId: 'account-a',
      remoteWorkspaceId: 'remote-workspace-a',
      remoteLatestVersionId: 'remote-base-a',
      remoteLatestVersionNumber: 1,
      remoteLatestContentSha256: BASE_CONTENT,
    });
  });

  function collectUploadStages() {
    const events = new Map<string, WorkspaceSyncUploadTelemetryEvent>();
    const origin = {
      consentScope: '11111111-1111-4111-8111-111111111111',
      contextId: '22222222-2222-4222-8222-222222222222',
      processId: '33333333-3333-4333-8333-333333333333',
      classification: 'synthetic' as const,
    };
    const captureOrigin = vi.fn(() => origin);
    configureWorkspaceSyncUploadTelemetry({
      captureOrigin,
      currentAccountId: () => 'account-a',
      publish: (reader) => {
        expect(db.inTransaction).toBe(false);
        const receipt = reader();
        if (!receipt) return false;
        events.set(receipt.event.eventId, structuredClone(receipt));
        return true;
      },
    });
    return {
      events,
      captureOrigin,
      stages: () => [...events.values()].map((row) => row.event.properties.sync_stage),
    };
  }

  it('commits native upload acceptance before the request and its terminal only after native acknowledgement', async () => {
    const observed = collectUploadStages();
    try {
      createVersion.mockImplementationOnce(async () => {
        expect(observed.stages()).toEqual(['accepted']);
        expect(uploadSnapshotCount(db, 'queue-a')).toBe(1);
        expect(queueStatus(db, 'queue-a')).toBe('running');
        nowMs = 200;
        return readyVersion('remote-version-a', 2, CONTENT_A);
      });
      await expect(makeWorker().flushWorkspace('workspace-a')).resolves.toMatchObject({
        status: 'uploaded',
      });
      expect(observed.stages()).toEqual(['accepted', 'uploaded']);
      const [accepted, terminal] = [...observed.events.values()];
      expect(terminal?.event.properties).toMatchObject({
        operation_id: accepted?.event.properties.operation_id,
        origin_started_at_ms: 100,
        occurred_at_ms: 200,
      });
      expect(queueRow(db, 'queue-a').created_at).toBe(100);
      expect(observed.captureOrigin).toHaveBeenCalledOnce();
    } finally {
      configureWorkspaceSyncUploadTelemetry(null);
    }
  });

  it.each([false, true])(
    'records recovery stages at the native owner while preserving upload success under optional refusal: %s',
    async (refuseOptional) => {
      const root = mkdtempSync(join(tmpdir(), 'dnaforge-recovery-stage-owner-'));
      const events = new Map<string, WorkspaceSyncRecoveryTelemetryEvent>();
      const stages = () =>
        [...events.values()].map((value) => value.event.properties.recovery_stage);
      const origin = {
        consentScope: '11111111-1111-4111-8111-111111111111',
        contextId: '22222222-2222-4222-8222-222222222222',
        processId: '33333333-3333-4333-8333-333333333333',
        classification: 'synthetic' as const,
      };
      const captureOrigin = vi.fn(() => origin);
      configureWorkspaceSyncRecoveryTelemetry({
        captureOrigin,
        currentAccountId: () => 'account-a',
        publish: (reader) => {
          expect(db.inTransaction).toBe(false);
          const value = reader();
          if (!value) return false;
          events.set(value.event.eventId, structuredClone(value));
          return true;
        },
      });
      let faults = 0;
      if (refuseOptional) {
        db.function('witness_recovery_owner_optional_refusal', () => {
          faults += 1;
          return 1;
        });
        db.exec(`CREATE TRIGGER refuse_recovery_owner_optional BEFORE INSERT ON settings
        WHEN substr(NEW.key,1,${WORKSPACE_SYNC_RECOVERY_RECEIPT_PREFIX.length}) = '${WORKSPACE_SYNC_RECOVERY_RECEIPT_PREFIX}'
        BEGIN SELECT witness_recovery_owner_optional_refusal(); SELECT RAISE(ABORT,'optional refused'); END;`);
      }
      try {
        db.prepare(
          'UPDATE workspace_sync_bindings SET remote_workspace_id = ?, remote_latest_version_id = ? WHERE workspace_id = 1'
        ).run(REMOTE_WORKSPACE_ID, REMOTE_VERSION_ID);
        const content = 'LOCUS       RECOVERY_OWNER\nORIGIN\n        1 acgt\n//\n';
        const source = join(root, 'design.gb');
        writeFileSync(source, content);
        const captured = manifestCapture(source, content);
        let stagesAtRequest: string[] = [];
        let stagesAfterAcknowledgement: string[] = [];
        let nativeAtAcknowledgement: ReturnType<typeof readWorkspaceSyncRecoveryCandidateIntent> =
          null;
        let capturedBytes = '';
        let nativeOperationId: string | null = null;
        const createVersion = vi.fn(
          async (request: Parameters<WorkspaceSyncUploadClient['createVersion']>[0]) => {
            if (
              !request.recoveryCandidateIntent ||
              !request.onRecoveryCandidateRetained ||
              !request.manifest
            )
              throw new Error('Expected the native recovery request contract.');
            const staged = request.fileSources?.get('design.gb');
            if (!staged) throw new Error('Expected the native captured file.');
            capturedBytes = readFileSync(staged, 'utf8');
            stagesAtRequest = stages();
            nativeOperationId = request.recoveryCandidateIntent.acceptedOperationId;
            const expected = workspaceSyncRecoveryCandidateRequest({
              remoteWorkspaceId: REMOTE_WORKSPACE_ID,
              ownerAccountId: 'account-a',
              baseVersionId: request.baseVersionId,
              manifest: request.manifest,
              reason: 'dirty',
              excludedSummary: request.excludedSummary,
            });
            nowMs = 200;
            await request.onRecoveryCandidateRetained({
              id: '44444444-4444-4444-8444-444444444444',
              accountId: 'account-a',
              baseVersionId: request.baseVersionId,
              contentSha256: expected.contentSha256,
              requestSha256: expected.requestSha256,
              reason: 'dirty',
              coverage: expected.coverage,
              createdAt: '2026-11-02T00:00:00.000Z',
              expiresAt: '2026-11-09T00:00:00.000Z',
            });
            nativeAtAcknowledgement = readWorkspaceSyncRecoveryCandidateIntent(db, 'queue-a');
            stagesAfterAcknowledgement = stages();
            nowMs = 300;
            return {
              status: 'ready' as const,
              workspaceId: REMOTE_WORKSPACE_ID,
              version: {
                id: '55555555-5555-4555-8555-555555555555',
                versionNumber: 2,
                contentSha256: captured.contentSha256,
                sizeBytes: captured.includedBytes,
                fileCount: captured.includedFileCount,
                representation: 'manifest_v1' as const,
              },
            };
          }
        );
        const worker = new WorkspaceSyncUploadWorker(db, {
          ...baseDeps(),
          client: { supportsManifest: true, createVersion },
          snapshotUploadWorkspace: vi.fn(async () => captured),
          verifyUploadCaptureMatchesCommit: vi.fn(async () => undefined),
          hasWorkingTreeChanges: () => false,
          uploadSnapshotRoot: root,
        });
        await expect(worker.flushWorkspace('workspace-a')).resolves.toMatchObject({
          status: 'uploaded',
        });
        expect(createVersion).toHaveBeenCalledOnce();
        expect(queueStatus(db, 'queue-a')).toBe('succeeded');
        expect(versionCount(db)).toBe(1);
        expect(capturedBytes).toBe(content);
        expect(nativeAtAcknowledgement).toMatchObject({
          acceptedOperationId: nativeOperationId,
          createdAtMs: 100,
          retainedAtMs: 200,
        });
        expect(stagesAtRequest).toEqual(refuseOptional ? [] : ['accepted']);
        expect(stagesAfterAcknowledgement).toEqual(refuseOptional ? [] : ['accepted', 'retained']);
        expect(stages()).toEqual(refuseOptional ? [] : ['accepted', 'retained']);
        expect(faults).toBe(refuseOptional ? 1 : 0);
        expect(captureOrigin).toHaveBeenCalledOnce();
        if (!refuseOptional) {
          expect([...events.values()][1]?.event.properties).toMatchObject({
            operation_id: nativeOperationId,
            origin_started_at_ms: 100,
            occurred_at_ms: 200,
          });
        }
      } finally {
        configureWorkspaceSyncRecoveryTelemetry(null);
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it.each([
    { renewed: false, alreadyRetained: false },
    { renewed: false, alreadyRetained: true },
    { renewed: true, alreadyRetained: false },
    { renewed: true, alreadyRetained: true },
  ])(
    'keeps recovery acknowledgement owned by its native intent across a replacement claim: renewed=$renewed/retained=$alreadyRetained',
    async ({ renewed, alreadyRetained }) => {
      const root = mkdtempSync(join(tmpdir(), 'dnaforge-recovery-replacement-claim-'));
      const events = new Map<string, WorkspaceSyncRecoveryTelemetryEvent>();
      configureWorkspaceSyncRecoveryTelemetry({
        captureOrigin: () => ({
          consentScope: '11111111-1111-4111-8111-111111111111',
          contextId: '22222222-2222-4222-8222-222222222222',
          processId: '33333333-3333-4333-8333-333333333333',
          classification: 'synthetic',
        }),
        currentAccountId: () => 'account-a',
        publish: (reader) => {
          expect(db.inTransaction).toBe(false);
          const value = reader();
          if (!value) return false;
          events.set(value.event.eventId, structuredClone(value));
          return true;
        },
      });
      const snapshotRow = () =>
        db.prepare('SELECT * FROM workspace_sync_upload_snapshots WHERE job_id = ?').get('queue-a');
      const snapshotBytesMetadata = () =>
        db
          .prepare(
            "SELECT content_sha256, json_remove(bundle_json, '$.recoveryCandidate') AS captured, created_at FROM workspace_sync_upload_snapshots WHERE job_id = ?"
          )
          .get('queue-a');
      let replacement: ReturnType<typeof queueRow> | undefined;
      let expectedSnapshot: unknown;
      let preservedBytes: unknown;
      try {
        db.prepare(
          'UPDATE workspace_sync_bindings SET remote_workspace_id = ?, remote_latest_version_id = ? WHERE workspace_id = 1'
        ).run(REMOTE_WORKSPACE_ID, REMOTE_VERSION_ID);
        const content = 'LOCUS       RECOVERY_REPLACEMENT\nORIGIN\n        1 acgt\n//\n';
        const source = join(root, 'design.gb');
        writeFileSync(source, content);
        const captured = manifestCapture(source, content);
        const createVersion = vi.fn(
          async (request: Parameters<WorkspaceSyncUploadClient['createVersion']>[0]) => {
            const firstIntent = request.recoveryCandidateIntent;
            const acknowledge = request.onRecoveryCandidateRetained;
            if (!firstIntent || !acknowledge || !request.manifest)
              throw new Error('Expected the native recovery request.');
            const staged = request.fileSources?.get('design.gb');
            if (!staged) throw new Error('Expected the durable captured bytes.');
            expect(readFileSync(staged, 'utf8')).toBe(content);
            const requestIdentity = workspaceSyncRecoveryCandidateRequest({
              remoteWorkspaceId: REMOTE_WORKSPACE_ID,
              ownerAccountId: 'account-a',
              baseVersionId: request.baseVersionId,
              manifest: request.manifest,
              reason: 'dirty',
              excludedSummary: request.excludedSummary,
            });
            const receipt = {
              id: '44444444-4444-4444-8444-444444444444',
              accountId: 'account-a',
              baseVersionId: request.baseVersionId,
              contentSha256: requestIdentity.contentSha256,
              requestSha256: requestIdentity.requestSha256,
              reason: 'dirty' as const,
              coverage: requestIdentity.coverage,
              createdAt: '2026-11-02T00:00:00.000Z',
              expiresAt: '2026-11-09T00:00:00.000Z',
            };
            if (alreadyRetained) {
              nowMs = 200;
              await acknowledge(receipt);
            }
            const originalNative = readWorkspaceSyncRecoveryCandidateIntent(db, 'queue-a');
            const originalEvents = [...events.values()];
            const originalJob = queueRow(db, 'queue-a');
            nowMs = renewed ? Date.parse(receipt.expiresAt) + 1 : 300;
            expect(
              recoverWorkspaceSyncQueue(db, {
                nowMs,
                staleLockMs: 1,
                deviceId: 'device-b',
                activeAccountId: 'account-a',
              }).staleReclaimed
            ).toBe(1);
            db.prepare('UPDATE workspace_sync_device SET device_id = ?').run('device-b');
            const claimed = claimNextWorkspaceSyncJob(db, {
              activeAccountId: 'account-a',
              deviceId: 'device-b',
              nowMs,
              operation: 'upload',
              jobId: 'queue-a',
            });
            if (!claimed) throw new Error('Expected the replacement upload claim.');
            expect(claimed).toMatchObject({
              status: 'running',
              localHeadSha: firstIntent.localHeadSha,
              lockedByDeviceId: 'device-b',
              lockedAt: nowMs,
              attemptCount: 2,
              acceptedOperationId: originalJob.accepted_operation_id,
              acceptedOperationStartedAt: originalJob.accepted_operation_started_at,
            });
            expect(claimed.lockedAt).not.toBe(originalJob.locked_at);
            replacement = queueRow(db, 'queue-a');
            if (renewed) {
              db.transaction(() => {
                const next = ensureWorkspaceSyncRecoveryCandidateIntent(db, {
                  jobId: 'queue-a',
                  ownerAccountId: firstIntent.ownerAccountId,
                  remoteWorkspaceId: firstIntent.remoteWorkspaceId,
                  localHeadSha: firstIntent.localHeadSha,
                  snapshotContentSha256: firstIntent.snapshotContentSha256,
                  requestSha256: firstIntent.requestSha256,
                  uploadIdempotencyKey: request.idempotencyKey,
                  nowMs,
                });
                expect(next.acceptedOperationId).not.toBe(firstIntent.acceptedOperationId);
                expect(next.parentAcceptedOperationId).toBe(firstIntent.acceptedOperationId);
                acceptWorkspaceSyncRecoveryTelemetry(db, {
                  job: claimed,
                  intent: next,
                  previousOperationId: firstIntent.acceptedOperationId,
                  nowMs,
                });
              })();
            }
            preservedBytes = snapshotBytesMetadata();
            const beforeAcknowledgement = snapshotRow();
            const eventsBeforeAcknowledgement = [...events.values()];
            const currentNative = readWorkspaceSyncRecoveryCandidateIntent(db, 'queue-a');
            const ledgerBeforeAcknowledgement = db
              .prepare('SELECT value FROM settings WHERE key = ?')
              .get(WORKSPACE_SYNC_RECOVERY_RECEIPT_PREFIX + 'queue-a');
            if (renewed) {
              await expect(acknowledge(receipt)).rejects.toThrow(
                'Recovery receipt no longer owns this captured request.'
              );
              expect(readWorkspaceSyncRecoveryCandidateIntent(db, 'queue-a')).toEqual(
                currentNative
              );
              expect(snapshotRow()).toEqual(beforeAcknowledgement);
              expect([...events.values()]).toEqual(eventsBeforeAcknowledgement);
              expect(
                db
                  .prepare('SELECT value FROM settings WHERE key = ?')
                  .get(WORKSPACE_SYNC_RECOVERY_RECEIPT_PREFIX + 'queue-a')
              ).toEqual(ledgerBeforeAcknowledgement);
            } else {
              await acknowledge(receipt);
              expect(readWorkspaceSyncRecoveryCandidateIntent(db, 'queue-a')).toEqual({
                ...originalNative,
                retainedAtMs: alreadyRetained ? 200 : 300,
                receipt,
              });
              const afterAcknowledgement = snapshotRow();
              nowMs = 400;
              await acknowledge(receipt);
              expect(snapshotRow()).toEqual(afterAcknowledgement);
              expect([...events.values()].map((value) => value.event.properties)).toEqual([
                originalEvents[0]?.event.properties,
                {
                  feature_area: 'workspace',
                  recovery_stage: 'retained',
                  operation_id: firstIntent.acceptedOperationId,
                  origin_started_at_ms: 100,
                  occurred_at_ms: alreadyRetained ? 200 : 300,
                },
              ]);
              if (alreadyRetained) {
                expect(snapshotRow()).toEqual(beforeAcknowledgement);
                expect([...events.values()]).toEqual(originalEvents);
              }
            }
            expectedSnapshot = snapshotRow();
            expect(snapshotBytesMetadata()).toEqual(preservedBytes);
            expect(readFileSync(staged, 'utf8')).toBe(content);
            expect(queueRow(db, 'queue-a')).toEqual(replacement);
            return {
              status: 'ready' as const,
              workspaceId: REMOTE_WORKSPACE_ID,
              version: {
                id: '55555555-5555-4555-8555-555555555555',
                versionNumber: 2,
                contentSha256: captured.contentSha256,
                sizeBytes: captured.includedBytes,
                fileCount: captured.includedFileCount,
                representation: 'manifest_v1' as const,
              },
            };
          }
        );
        const worker = new WorkspaceSyncUploadWorker(db, {
          ...baseDeps(),
          client: { supportsManifest: true, createVersion },
          snapshotUploadWorkspace: vi.fn(async () => captured),
          verifyUploadCaptureMatchesCommit: vi.fn(async () => undefined),
          hasWorkingTreeChanges: () => false,
          uploadSnapshotRoot: root,
        });
        await worker.flushWorkspace('workspace-a');
        expect(createVersion).toHaveBeenCalledOnce();
        const requestResult = createVersion.mock.results[0];
        if (!requestResult || requestResult.type !== 'return')
          throw new Error('Expected the recovery request promise.');
        await requestResult.value;
        expect(replacement).toBeDefined();
        expect(expectedSnapshot).toBeDefined();
        expect(queueRow(db, 'queue-a')).toEqual(replacement);
        expect(snapshotRow()).toEqual(expectedSnapshot);
        expect(snapshotBytesMetadata()).toEqual(preservedBytes);
        expect(uploadSnapshotCount(db, 'queue-a')).toBe(1);
        expect(versionCount(db)).toBe(0);
        expect(bindingState(db)).toMatchObject({
          remote_latest_version_id: REMOTE_VERSION_ID,
          last_acked_local_head_sha: null,
        });
      } finally {
        configureWorkspaceSyncRecoveryTelemetry(null);
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it('keeps retry_wait nonterminal and preserves native accepted telemetry across worker restart', async () => {
    const observed = collectUploadStages();
    try {
      createVersion.mockRejectedValueOnce(
        Object.assign(new Error('offline'), { code: 'NETWORK', retryable: true })
      );
      await expect(makeWorker().flushWorkspace('workspace-a')).resolves.toMatchObject({
        status: 'retry_wait',
      });
      expect(observed.stages()).toEqual(['accepted']);
      const accepted = [...observed.events.values()][0]!;
      nowMs = 5100;
      await expect(makeWorker().runNext()).resolves.toMatchObject({ status: 'uploaded' });
      expect(observed.stages()).toEqual(['accepted', 'uploaded']);
      expect([...observed.events.values()][1]?.event.properties).toMatchObject({
        operation_id: accepted.event.properties.operation_id,
        origin_started_at_ms: 100,
        occurred_at_ms: 5100,
      });
      expect(observed.captureOrigin).toHaveBeenCalledOnce();
      expect(queueRow(db, 'queue-a')).toMatchObject({ created_at: 100, attempt_count: 2 });
    } finally {
      configureWorkspaceSyncUploadTelemetry(null);
    }
  });

  it('records a distinct accepted retry after native failed while preserving the native job identity', async () => {
    const observed = collectUploadStages();
    try {
      createVersion.mockRejectedValueOnce(
        Object.assign(new Error('schema refusal'), { code: 'VALIDATION', retryable: false })
      );
      await expect(makeWorker().flushWorkspace('workspace-a')).resolves.toMatchObject({
        status: 'failed',
      });
      expect(observed.stages()).toEqual(['accepted', 'failed']);
      const first = [...observed.events.values()][0]!;
      nowMs = 300;
      await expect(
        makeWorker().flushWorkspace('workspace-a', { force: true })
      ).resolves.toMatchObject({ status: 'uploaded' });
      expect(observed.stages()).toEqual(['accepted', 'failed', 'accepted', 'uploaded']);
      const retry = [...observed.events.values()][2]!;
      expect(retry.event.properties.operation_id).not.toBe(first.event.properties.operation_id);
      expect(retry.event.properties).toMatchObject({
        parent_action_id: first.event.properties.operation_id,
        origin_started_at_ms: 300,
      });
      expect(queueRow(db, 'queue-a')).toMatchObject({
        id: 'queue-a',
        created_at: 100,
        status: 'succeeded',
      });
      expect(observed.captureOrigin).toHaveBeenCalledTimes(2);
    } finally {
      configureWorkspaceSyncUploadTelemetry(null);
    }
  });

  it('does not mint a telemetry terminal from a stale native lease failure callback', async () => {
    const observed = collectUploadStages();
    try {
      createVersion.mockImplementationOnce(async () => {
        db.prepare(
          "UPDATE workspace_sync_queue SET status='retry_wait', locked_at=NULL, locked_by_device_id=NULL, error_code='STALE_LOCK_RECLAIMED', updated_at=200 WHERE id='queue-a'"
        ).run();
        return readyVersion('remote-version-a', 2, CONTENT_A);
      });
      await expect(makeWorker().flushWorkspace('workspace-a')).resolves.toMatchObject({
        status: 'retry_wait',
      });
      expect(observed.stages()).toEqual(['accepted']);
      expect(versionCount(db)).toBe(0);
    } finally {
      configureWorkspaceSyncUploadTelemetry(null);
    }
  });

  it.each([
    { response: 'ready', deviceId: 'device-a', status: 'running' },
    { response: 'throws', deviceId: 'device-a', status: 'running' },
    { response: 'ready', deviceId: 'device-b', status: 'running' },
    { response: 'throws', deviceId: 'device-b', status: 'running' },
    { response: 'ready', deviceId: 'device-a', status: 'failed' },
    { response: 'throws', deviceId: 'device-a', status: 'failed' },
    { response: 'ready', deviceId: 'device-b', status: 'failed' },
    { response: 'throws', deviceId: 'device-b', status: 'failed' },
  ])(
    'preserves a replacement upload claim and its bytes after an older $response callback: $deviceId/$status',
    async ({ response, deviceId, status }) => {
      const observed = collectUploadStages();
      let replacement: ReturnType<typeof queueRow> | undefined;
      let retainedSnapshot: unknown;
      const readSnapshot = () =>
        db
          .prepare(
            'SELECT content_sha256, bundle_json, created_at FROM workspace_sync_upload_snapshots WHERE job_id = ?'
          )
          .get('queue-a');
      try {
        createVersion.mockImplementationOnce(async () => {
          const first = queueRow(db, 'queue-a');
          expect(
            recoverWorkspaceSyncQueue(db, {
              nowMs: 200,
              staleLockMs: 1,
              deviceId,
              activeAccountId: 'account-a',
            }).staleReclaimed
          ).toBe(1);
          db.prepare('UPDATE workspace_sync_device SET device_id = ?').run(deviceId);
          const claimed = claimNextWorkspaceSyncJob(db, {
            activeAccountId: 'account-a',
            deviceId,
            nowMs: 200,
            operation: 'upload',
            jobId: 'queue-a',
          });
          expect(claimed).toMatchObject({
            status: 'running',
            lockedAt: 200,
            lockedByDeviceId: deviceId,
            attemptCount: 2,
            acceptedOperationId: first.accepted_operation_id,
            acceptedOperationStartedAt: first.accepted_operation_started_at,
          });
          if (status === 'failed') {
            markWorkspaceSyncJobFailed(db, {
              id: 'queue-a',
              expectedStatus: 'running',
              nowMs: 201,
              retryable: false,
              retryDelayMs: 0,
              maxAttempts: 1,
              errorCode: 'BAD_RESPONSE',
              errorMessage: 'replacement refusal',
            });
          }
          replacement = queueRow(db, 'queue-a');
          retainedSnapshot = readSnapshot();
          expect(retainedSnapshot).toBeDefined();
          nowMs = 300;
          if (response === 'throws') {
            throw Object.assign(new Error('old request refusal'), {
              code: 'BAD_RESPONSE',
              retryable: false,
            });
          }
          return readyVersion('remote-version-a', 2, CONTENT_A);
        });
        await makeWorker().flushWorkspace('workspace-a');
        expect(replacement).toBeDefined();
        expect(queueRow(db, 'queue-a')).toEqual(replacement);
        expect(readSnapshot()).toEqual(retainedSnapshot);
        expect(uploadSnapshotCount(db, 'queue-a')).toBe(1);
        expect(versionCount(db)).toBe(0);
        expect(bindingState(db)).toMatchObject({
          remote_latest_version_id: 'remote-base-a',
          last_acked_local_head_sha: null,
        });
        expect(observed.stages()).toEqual(['accepted']);
      } finally {
        configureWorkspaceSyncUploadTelemetry(null);
      }
    }
  );

  it('keeps native upload successful when optional receipt persistence is refused by SQLite', async () => {
    const observed = collectUploadStages();
    try {
      db.exec(
        "CREATE TRIGGER reject_optional_receipt BEFORE INSERT ON settings WHEN substr(NEW.key,1,35) = '_cloud_backup_telemetry_receipt_v2:' BEGIN SELECT RAISE(ABORT,'optional telemetry refused'); END;"
      );
      await expect(makeWorker().flushWorkspace('workspace-a')).resolves.toMatchObject({
        status: 'uploaded',
      });
      expect(queueStatus(db, 'queue-a')).toBe('succeeded');
      expect(versionCount(db)).toBe(1);
      expect(observed.stages()).toEqual([]);
    } finally {
      configureWorkspaceSyncUploadTelemetry(null);
    }
  });

  it('does not give a retry the prior operation receipt after optional terminal and retry receipt writes fail', async () => {
    const observed = collectUploadStages();
    let faults = 0;
    db.function('witness_receipt_update_failure', () => {
      faults += 1;
      return 1;
    });
    db.exec(`CREATE TRIGGER reject_optional_attempt_updates BEFORE UPDATE ON settings
      WHEN substr(NEW.key,1,35) = '_cloud_backup_telemetry_receipt_v2:' AND
        (instr(NEW.value,'"outcome":"failed"') > 0 OR
          json_array_length(NEW.value,'$.attempts') > json_array_length(OLD.value,'$.attempts'))
      BEGIN SELECT witness_receipt_update_failure(); SELECT RAISE(ABORT,'optional receipt update refused'); END;`);
    try {
      createVersion.mockRejectedValueOnce(
        Object.assign(new Error('validation refusal'), { code: 'VALIDATION', retryable: false })
      );
      await expect(makeWorker().flushWorkspace('workspace-a')).resolves.toMatchObject({
        status: 'failed',
      });
      expect(observed.stages()).toEqual(['accepted']);
      expect(faults).toBe(1);
      nowMs = 300;
      await expect(
        makeWorker().flushWorkspace('workspace-a', { force: true })
      ).resolves.toMatchObject({ status: 'uploaded' });
      expect(queueRow(db, 'queue-a')).toMatchObject({
        id: 'queue-a',
        created_at: 100,
        status: 'succeeded',
      });
      expect(observed.stages()).toEqual(['accepted']);
      expect(faults).toBe(2);
    } finally {
      configureWorkspaceSyncUploadTelemetry(null);
    }
  });

  it('rejects an older native upload acknowledgement after a retry reuses the same lease clock and device', async () => {
    const observed = collectUploadStages();
    let replacementOperation: string | null = null;
    try {
      createVersion.mockImplementationOnce(async () => {
        const firstOperation = queueRow(db, 'queue-a').accepted_operation_id;
        markWorkspaceSyncJobFailed(db, {
          id: 'queue-a',
          expectedStatus: 'running',
          nowMs: 100,
          retryable: false,
          retryDelayMs: 0,
          maxAttempts: 1,
          errorCode: 'VALIDATION',
          errorMessage: 'replaced attempt',
        });
        requeueWorkspaceSyncJob(db, { id: 'queue-a', nowMs: 100, resetAttemptCount: true });
        const replacement = claimNextWorkspaceSyncJob(db, {
          activeAccountId: 'account-a',
          deviceId: 'device-a',
          nowMs: 100,
          operation: 'upload',
          jobId: 'queue-a',
        });
        expect(replacement).toMatchObject({
          status: 'running',
          lockedAt: 100,
          lockedByDeviceId: 'device-a',
          attemptCount: 1,
        });
        replacementOperation = replacement?.acceptedOperationId ?? null;
        expect(replacementOperation).not.toBe(firstOperation);
        return readyVersion('remote-version-a', 2, CONTENT_A);
      });
      await expect(makeWorker().flushWorkspace('workspace-a')).resolves.toMatchObject({
        status: 'failed',
      });
      expect(queueRow(db, 'queue-a')).toMatchObject({
        status: 'running',
        accepted_operation_id: replacementOperation,
        created_at: 100,
      });
      expect(versionCount(db)).toBe(0);
      expect(bindingState(db)).toMatchObject({
        remote_latest_version_id: 'remote-base-a',
        last_acked_local_head_sha: null,
      });
      expect(uploadSnapshotCount(db, 'queue-a')).toBe(1);
      expect(observed.stages()).toEqual(['accepted']);
    } finally {
      configureWorkspaceSyncUploadTelemetry(null);
    }
  });

  it('recaptures an obsolete automatic snapshot without another workspace event', async () => {
    let head = 'head-a';
    snapshotWorkspace.mockImplementation(async () => snapshot('workspace-a', CONTENT_A, head));
    snapshotWorkspace.mockImplementationOnce(async () => {
      const captured = snapshot('workspace-a', CONTENT_A, head);
      head = 'head-b';
      return captured;
    });
    const worker = new WorkspaceSyncUploadWorker(db, {
      ...baseDeps(),
      getCurrentLocalHeadSha: () => head,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      worker.scheduleWorkspaceChanged('workspace-a');
      await timers[0].callback();
      expect(snapshotWorkspace).toHaveBeenCalledOnce();
      expect(queueCount(db)).toBe(0);
      expect(createVersion).not.toHaveBeenCalled();
      expect(timers).toHaveLength(2);
      expect(timers[1]).toMatchObject({ ms: 1000, cleared: false });
      await timers[1].callback();
      expect(snapshotWorkspace).toHaveBeenCalledTimes(2);
      expect(createVersion).toHaveBeenCalledOnce();
      expect(queueRow(db, 'queue-a')).toMatchObject({
        status: 'succeeded',
        local_head_sha: 'head-b',
      });
      expect(bindingState(db).last_acked_local_head_sha).toBe('head-b');
    } finally {
      warn.mockRestore();
      await worker.stopAndWaitForIdle();
    }
  });

  it.each([
    {
      label: 'workspace id',
      response: {
        status: 'ready',
        workspaceId: 'not-a-uuid',
        version: {
          id: REMOTE_VERSION_ID,
          versionNumber: 2,
          contentSha256: CONTENT_A,
          sizeBytes: BUNDLE_METADATA.get(CONTENT_A)?.sizeBytes ?? 0,
          fileCount: BUNDLE_METADATA.get(CONTENT_A)?.fileCount ?? 0,
        },
      },
    },
    {
      label: 'ready version id',
      response: {
        status: 'ready',
        workspaceId: REMOTE_WORKSPACE_ID,
        version: {
          id: 'not-a-uuid',
          versionNumber: 2,
          contentSha256: CONTENT_A,
          sizeBytes: BUNDLE_METADATA.get(CONTENT_A)?.sizeBytes ?? 0,
          fileCount: BUNDLE_METADATA.get(CONTENT_A)?.fileCount ?? 0,
        },
      },
    },
    {
      label: 'in-progress version id',
      response: {
        status: 'in_progress',
        workspaceId: REMOTE_WORKSPACE_ID,
        versionId: 'not-a-uuid',
        leaseExpiresAt: null,
      },
    },
  ])('rejects a non-UUID remote $label before returning it to the worker', async ({ response }) => {
    const client = createWorkspaceSyncUploadClient({
      requestJson: vi.fn(async (path: string) =>
        path.endsWith('/storage-policy?fileSelectionVersion=1') ? publicationPolicy() : response
      ),
      requestStream: async () => {
        throw new Error('requestStream is not expected in this test.');
      },
    } as DesktopSyncClient);

    await expect(
      client.createVersion({
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        ownerAccountId: 'account-a',
        idempotencyKey: 'upload-idempotency-key',
        baseVersionId: null,
        bundle: bundleFor('workspace-a'),
      })
    ).rejects.toMatchObject({ code: 'BAD_RESPONSE', retryable: true });
  });

  it('pins each upload request to the binding owner so renewal cannot switch callers ', async () => {
    const requestJson = vi.fn(async () => {
      throw Object.assign(new Error('account changed'), { code: 'ACCOUNT_CHANGED' });
    });
    const client = createWorkspaceSyncUploadClient({ requestJson } as unknown as DesktopSyncClient);

    await expect(
      client.createVersion({
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        ownerAccountId: 'account-a',
        idempotencyKey: 'upload-idempotency-key',
        baseVersionId: null,
        bundle: bundleFor('workspace-a'),
      })
    ).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' });

    expect(requestJson).toHaveBeenCalledWith(
      `/api/desktop-sync/workspaces/${REMOTE_WORKSPACE_ID}/storage-policy?fileSelectionVersion=1`,
      expect.objectContaining({ method: 'GET', expectedAccountId: 'account-a' })
    );
  });

  it('retries identical legacy bytes with a new stable request key after an allowance revision', async () => {
    const bundle = bundleFor('legacy-policy-retry');
    let policy = TEST_STORAGE_POLICY;
    const keys: string[] = [];
    const bodies: unknown[] = [];
    const requestJson = vi.fn(
      async (path: string, options: { idempotencyKey?: string; body?: unknown }) => {
        if (path.endsWith('/storage-policy?fileSelectionVersion=1'))
          return publicationPolicy(policy);
        keys.push(options.idempotencyKey!);
        bodies.push(options.body);
        if (keys.length === 1)
          throw Object.assign(new Error('Policy changed during publication'), {
            code: 'QUOTA_EXCEEDED',
          });
        return {
          status: 'ready',
          workspaceId: REMOTE_WORKSPACE_ID,
          version: {
            id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
            versionNumber: 1,
            contentSha256: bundle.provenance.contentSha256,
            sizeBytes: BUNDLE_METADATA.get(bundle.provenance.contentSha256)!.sizeBytes,
            fileCount: bundle.files.length,
          },
        };
      }
    );
    const client = createWorkspaceSyncUploadClient({ requestJson } as unknown as DesktopSyncClient);
    const request = {
      remoteWorkspaceId: REMOTE_WORKSPACE_ID,
      ownerAccountId: 'account-a',
      idempotencyKey: 'immutable-legacy-job',
      baseVersionId: null,
      bundle,
    };
    await expect(client.createVersion(request)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    policy = { ...policy, revision: policy.revision + 1 };
    await client.createVersion(request);
    await client.createVersion(request);
    expect(keys[1]).not.toBe(keys[0]);
    expect(keys[2]).toBe(keys[1]);
    expect(bodies).toEqual(
      Array.from({ length: 3 }, () => ({ baseVersionId: null, fileSelectionVersion: 0, bundle }))
    );
  });

  it('publishes an oversized queued legacy bundle as control metadata and retains policy revision keys', async () => {
    const bytes = Buffer.from(`>sequence\n${'ACGT'.repeat(1024 * 1024)}\n`);
    const base = bundleFor('oversized-legacy');
    const bundle = {
      ...base,
      schemaVersion: 2 as const,
      files: [
        {
          ...base.files[0]!,
          relativePath: 'large.fasta',
          name: 'large.fasta',
          kind: 'fasta' as const,
          contentType: 'text/plain',
          encoding: 'base64' as const,
          content: bytes.toString('base64'),
          sizeBytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    };
    bundle.provenance = {
      ...base.provenance,
      contentSha256: createHash('sha256')
        .update(workspaceSyncBundleHashInput(bundle))
        .digest('hex'),
    };
    let policy = TEST_STORAGE_POLICY;
    const publications: Array<{ key: string; body: Record<string, unknown> }> = [];
    const requestJson = vi.fn(
      async (
        path: string,
        options: {
          expectedAccountId?: string;
          idempotencyKey?: string;
          body?: Record<string, unknown>;
        }
      ) => {
        expect(options.expectedAccountId).toBe('account-a');
        if (path.endsWith('/storage-policy?fileSelectionVersion=1'))
          return publicationPolicy(policy);
        if (path.endsWith('/recovery-candidates')) return recoveryResponse(options.body);
        if (path.endsWith('/blobs/reserve'))
          return {
            status: 'ready',
            blobId: REMOTE_VERSION_ID,
            contentSha256: bundle.files[0]!.sha256,
            sizeBytes: bytes.length,
          };
        expect(path).toBe(`/api/desktop-sync/workspaces/${REMOTE_WORKSPACE_ID}/versions`);
        const body = options.body!;
        expect(body).not.toHaveProperty('bundle');
        expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(4096);
        publications.push({ key: options.idempotencyKey!, body });
        if (publications.length === 1)
          throw Object.assign(new Error('Policy changed'), {
            code: 'QUOTA_EXCEEDED',
          });
        return {
          status: 'ready',
          workspaceId: REMOTE_WORKSPACE_ID,
          version: {
            id: REMOTE_VERSION_ID,
            versionNumber: 1,
            representation: 'manifest_v1',
            contentSha256: createHash('sha256')
              .update(workspaceSyncManifestHashInput(body.manifest as WorkspaceSyncManifestV1))
              .digest('hex'),
            sizeBytes: bytes.length,
            fileCount: 1,
          },
        };
      }
    );
    const client = createWorkspaceSyncUploadClient({ requestJson } as unknown as DesktopSyncClient);
    const request = {
      remoteWorkspaceId: REMOTE_WORKSPACE_ID,
      ownerAccountId: 'account-a',
      idempotencyKey: 'immutable-oversized-job',
      baseVersionId: null,
      bundle,
    };
    await expect(client.createVersion(request)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    policy = { ...policy, revision: policy.revision + 1 };
    await client.createVersion(request);
    await client.createVersion(request);
    expect(publications[1]!.key).not.toBe(publications[0]!.key);
    expect(publications[2]!.key).toBe(publications[1]!.key);
    expect(publications.map((entry) => entry.body)).toEqual(
      Array.from({ length: 3 }, () => publications[0]!.body)
    );
  });

  it('debounces rapid changes, persists a queue row before network, and records successful upload state', async () => {
    const observedStatuses: string[] = [];
    createVersion.mockImplementation(async (request) => {
      observedStatuses.push(queueStatus(db, 'queue-a'));
      expect(request).toMatchObject({
        remoteWorkspaceId: 'remote-workspace-a',
        idempotencyKey: `upload:workspace-a:remote-base-a:head-a:${CONTENT_A}`,
        baseVersionId: 'remote-base-a',
      });
      return readyVersion('remote-version-a', 2, CONTENT_A);
    });
    const worker = makeWorker();

    worker.scheduleWorkspaceChanged('workspace-a');
    worker.scheduleWorkspaceChanged('workspace-a');

    expect(timers).toHaveLength(2);
    expect(timers[0].cleared).toBe(true);
    expect(queueCount(db)).toBe(0);

    await timers[1].callback();

    expect(queueCount(db)).toBe(1);
    expect(observedStatuses).toEqual(['running']);
    expect(snapshotWorkspace).toHaveBeenCalledWith('workspace-a');
    expect(createVersion).toHaveBeenCalledTimes(1);
    expect(queueStatus(db, 'queue-a')).toBe('succeeded');
    expect(bindingState(db)).toMatchObject({
      remote_latest_version_id: 'remote-version-a',
      remote_latest_version_number: 2,
      remote_latest_content_sha256: CONTENT_A,
      last_acked_local_head_sha: 'head-a',
      last_uploaded_at: 100,
    });
    expect(latestVersion(db)).toMatchObject({
      remote_version_id: 'remote-version-a',
      version_number: 2,
      content_sha256: CONTENT_A,
      local_head_sha: 'head-a',
      excluded_summary_json: JSON.stringify({
        ignoredCount: 0,
        unsupportedCount: 0,
        privateRawDataCount: 0,
        referencePointerCount: 0,
        fileTooLargeCount: 0,
        bundleTooLargeCount: 0,
      }),
      status: 'ready',
      is_latest: 1,
    });
  });

  it('uses the manifest-only capture for a client that supports direct blob uploads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dnaforge-worker-manifest-'));
    try {
      const content = 'A'.repeat(1024 * 1024);
      const sourcePath = join(root, 'design.gb');
      writeFileSync(sourcePath, content, 'utf8');
      const capture = manifestCapture(sourcePath, content);
      const snapshotUploadWorkspace = vi.fn(async () => capture);
      const verifyUploadCaptureMatchesCommit = vi.fn(async () => undefined);
      const createVersion = vi.fn(async (request) => {
        expect(request.bundle).toBeUndefined();
        expect(request.manifest).toEqual(capture.manifest);
        expect(request.excludedSummary).toEqual(capture.statusExcludedSummary);
        const stagedSourcePath = request.fileSources?.get('design.gb');
        expect(stagedSourcePath).toBeDefined();
        expect(stagedSourcePath).not.toBe(sourcePath);
        expect(request.resumeStatePath).toBe(
          join(workspaceSyncUploadSnapshotDirectory(root, 'queue-a'), 'tus-uploads.json')
        );
        return {
          status: 'ready' as const,
          workspaceId: 'remote-workspace-a',
          version: {
            id: 'remote-version-manifest',
            versionNumber: 2,
            contentSha256: capture.contentSha256,
            sizeBytes: capture.includedBytes,
            fileCount: capture.includedFileCount,
            representation: 'manifest_v1' as const,
          },
        };
      });
      const worker = new WorkspaceSyncUploadWorker(db, {
        ...baseDeps(),
        client: { supportsManifest: true, createVersion },
        snapshotUploadWorkspace,
        verifyUploadCaptureMatchesCommit,
        hasWorkingTreeChanges: () => false,
        uploadSnapshotRoot: root,
      });

      worker.scheduleWorkspaceChanged('workspace-a');
      await timers[0]!.callback();

      expect(snapshotUploadWorkspace).toHaveBeenCalledWith('workspace-a');
      expect(verifyUploadCaptureMatchesCommit).toHaveBeenCalledWith(capture, 'head-a');
      expect(createVersion).toHaveBeenCalledTimes(1);
      expect(queueStatus(db, 'queue-a')).toBe('succeeded');
      expect(uploadSnapshotCount(db, 'queue-a')).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('durably enqueues an uncommitted watcher edit after a direct retry upload succeeds', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sync-watcher-edit-'));
    await initManagedRepo(root);
    writeFileSync(join(root, 'design.gb'), 'LOCUS       design\nORIGIN\n        1 atgc\n//\n');
    db.prepare('UPDATE workspaces SET path = ? WHERE id = 1').run(root);
    recordWorkspaceSyncReplicaFiles(db, {
      workspaceUuid: 'workspace-a',
      remoteWorkspaceId: 'remote-workspace-a',
      remoteVersionId: 'remote-base-a',
      paths: ['design.gb'],
      nowMs,
    });
    try {
      enqueueWorkspaceSyncJob(db, {
        id: 'queue-a',
        workspaceId: 1,
        operation: 'upload',
        idempotencyKey: 'upload:workspace-a:remote-base-a:head-a',
        baseRemoteVersionId: 'remote-base-a',
        localHeadSha: 'head-a',
        nowMs,
      });
      let localHeadSha = 'head-a';
      let workingTreeDirty = false;
      let releaseUpload: (() => void) | undefined;
      createVersion.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseUpload = () => resolve(readyVersion('remote-version-a', 2, CONTENT_A));
          })
      );
      const worker = new WorkspaceSyncUploadWorker(db, {
        ...baseDeps(),
        getCurrentLocalHeadSha: () => localHeadSha,
        commitWorkingTreeIfDirty: async () => {
          if (!workingTreeDirty) return localHeadSha;
          workingTreeDirty = false;
          localHeadSha = 'head-b';
          return localHeadSha;
        },
      });

      const uploading = worker.runNext();
      await vi.waitFor(() => expect(createVersion).toHaveBeenCalledOnce());
      workingTreeDirty = true;
      nextJobId = 'queue-b';
      worker.scheduleWorkspaceChanged('workspace-a');
      invokeDeferred(releaseUpload);

      await expect(uploading).resolves.toMatchObject({ status: 'uploaded' });
      expect(queueStatus(db, 'queue-a')).toBe('succeeded');
      expect(queueStatus(db, 'queue-b')).toBe('pending');
      expect(localHeadSha).toBe('head-b');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('flushes the exact workspace job even when an older upload for another workspace exists', async () => {
    seedSyncWorkspace(db, {
      workspaceId: 2,
      workspaceUuid: 'workspace-b',
      accountId: 'account-a',
      remoteWorkspaceId: 'remote-workspace-b',
      remoteLatestVersionId: 'remote-base-b',
      remoteLatestVersionNumber: 1,
      remoteLatestContentSha256: BASE_CONTENT,
    });
    enqueueWorkspaceSyncJob(db, {
      id: 'queue-b-older',
      workspaceId: 2,
      operation: 'upload',
      idempotencyKey: 'upload:workspace-b:remote-base-b:head-a',
      baseRemoteVersionId: 'remote-base-b',
      localHeadSha: 'head-a',
      nowMs: 50,
    });
    const worker = makeWorker();

    await expect(worker.flushWorkspace('workspace-a')).resolves.toMatchObject({
      status: 'uploaded',
      job: { id: 'queue-a', workspaceId: 1 },
    });
    expect(createVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        remoteWorkspaceId: 'remote-workspace-a',
        ownerAccountId: 'account-a',
      }),
      expect.any(AbortSignal)
    );
    expect(queueStatus(db, 'queue-b-older')).toBe('pending');
  });

  it('joins the same upload when the background drain claims it before a foreground flush', async () => {
    const queued = enqueueWorkspaceSyncJob(db, {
      id: 'queue-background-race',
      workspaceId: 1,
      operation: 'upload',
      idempotencyKey: `upload:workspace-a:remote-base-a:head-a:${CONTENT_A}`,
      baseRemoteVersionId: 'remote-base-a',
      localHeadSha: 'head-a',
      bundleContentSha256: CONTENT_A,
      nowMs: 50,
    });
    recordWorkspaceSyncUploadSnapshot(db, {
      jobId: queued.id,
      snapshot: snapshot('workspace-a', CONTENT_A, 'head-a'),
      nowMs: 50,
    });
    let releaseUpload: (() => void) | undefined;
    createVersion.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseUpload = () => resolve(readyVersion('remote-version-a', 2, CONTENT_A));
        })
    );
    const worker = makeWorker();

    const background = worker.runNext();
    await vi.waitFor(() => expect(createVersion).toHaveBeenCalledOnce());
    const foreground = worker.flushWorkspace('workspace-a');
    invokeDeferred(releaseUpload);

    await expect(background).resolves.toMatchObject({
      status: 'uploaded',
      job: { id: queued.id },
    });
    await expect(foreground).resolves.toMatchObject({
      status: 'uploaded',
      job: { id: queued.id },
    });
    expect(createVersion).toHaveBeenCalledOnce();
  });

  it('resumes an account-paused upload when the bound account is active again', async () => {
    const blocked = enqueueWorkspaceSyncJob(db, {
      id: 'queue-account-paused',
      workspaceId: 1,
      operation: 'upload',
      idempotencyKey: `upload:workspace-a:remote-base-a:head-a:${CONTENT_A}`,
      baseRemoteVersionId: 'remote-base-a',
      localHeadSha: 'head-a',
      bundleContentSha256: CONTENT_A,
      nowMs: 50,
    });
    recordWorkspaceSyncUploadSnapshot(db, {
      jobId: blocked.id,
      snapshot: snapshot('workspace-a', CONTENT_A, 'head-a'),
      nowMs: 50,
    });
    db.prepare(
      `UPDATE workspace_sync_queue
       SET status = 'blocked',
           error_code = 'ACCOUNT_PAUSED',
           error_message = 'Sync paused until the bound account is active.'
       WHERE id = ?`
    ).run(blocked.id);

    await expect(makeWorker().flushWorkspace('workspace-a')).resolves.toMatchObject({
      status: 'uploaded',
      job: { id: blocked.id },
    });
    expect(createVersion).toHaveBeenCalledOnce();
    expect(queueStatus(db, blocked.id)).toBe('succeeded');
  });

  it('reports an account-paused upload as failed for a different active account', async () => {
    const blocked = enqueueWorkspaceSyncJob(db, {
      id: 'queue-wrong-account',
      workspaceId: 1,
      operation: 'upload',
      idempotencyKey: 'upload:workspace-a:remote-base-a:head-a:wrong-account',
      baseRemoteVersionId: 'remote-base-a',
      localHeadSha: 'head-a',
      nowMs: 50,
    });
    db.prepare(
      `UPDATE workspace_sync_queue
       SET status = 'blocked',
           error_code = 'ACCOUNT_PAUSED',
           error_message = 'Sync paused until the bound account is active.'
       WHERE id = ?`
    ).run(blocked.id);
    const worker = new WorkspaceSyncUploadWorker(db, {
      ...baseDeps(),
      getActiveAccountId: () => 'account-b',
    });

    await expect(worker.flushWorkspace('workspace-a')).resolves.toMatchObject({
      status: 'failed',
      job: { id: blocked.id, status: 'blocked' },
      errorCode: 'ACCOUNT_PAUSED',
    });
    expect(createVersion).not.toHaveBeenCalled();
    expect(queueStatus(db, blocked.id)).toBe('blocked');
  });

  it('does not report success when the active account changes before the resumed upload claim', async () => {
    const blocked = enqueueWorkspaceSyncJob(db, {
      id: 'queue-account-switch-race',
      workspaceId: 1,
      operation: 'upload',
      idempotencyKey: 'upload:workspace-a:remote-base-a:head-a:account-switch',
      baseRemoteVersionId: 'remote-base-a',
      localHeadSha: 'head-a',
      nowMs: 50,
    });
    db.prepare(
      `UPDATE workspace_sync_queue
       SET status = 'blocked',
           error_code = 'ACCOUNT_PAUSED',
           error_message = 'Sync paused until the bound account is active.'
       WHERE id = ?`
    ).run(blocked.id);
    const getActiveAccountId = vi
      .fn<WorkspaceSyncUploadWorkerDeps['getActiveAccountId']>()
      .mockResolvedValueOnce('account-a')
      .mockResolvedValueOnce('account-b');
    const worker = new WorkspaceSyncUploadWorker(db, {
      ...baseDeps(),
      getActiveAccountId,
    });

    await expect(worker.flushWorkspace('workspace-a')).resolves.toMatchObject({
      status: 'failed',
      job: { id: blocked.id, status: 'pending' },
      errorCode: 'UPLOAD_NOT_PERFORMED',
    });
    expect(getActiveAccountId).toHaveBeenCalledTimes(2);
    expect(createVersion).not.toHaveBeenCalled();
    expect(queueStatus(db, blocked.id)).toBe('pending');
  });

  it('rejects escaped JSON that exceeds the HTTP wire cap before creating a queue row', async () => {
    snapshotWorkspace.mockResolvedValueOnce({
      ...snapshot('workspace-a', CONTENT_A, 'head-a'),
      bundle: {
        schemaVersion: 1,
        files: [{ relativePath: 'escaped.txt', content: '"'.repeat(7 * 1024 * 1024) }],
      } as unknown as WorkspaceSyncBundleV1,
    });
    const worker = makeWorker();

    await expect(worker.flushWorkspace('workspace-a')).rejects.toMatchObject({
      code: 'BUNDLE_TOO_LARGE',
      retryable: false,
    });
    expect(queueCount(db)).toBe(0);
    expect(createVersion).not.toHaveBeenCalled();
  });

  it('does not grant a remote-pull lease while a local edit is waiting to upload', () => {
    const worker = makeWorker();

    worker.scheduleWorkspaceChanged('workspace-a');

    expect(worker.beginRemotePull('workspace-a')).toBe(false);
    expect(timers).toHaveLength(1);
    expect(timers[0].cleared).toBe(false);
  });

  it('pauses timer, watcher, manual upload, and remote-pull admission while sync disables', async () => {
    const worker = makeWorker();
    enqueueWorkspaceSyncJob(db, {
      id: 'queue-paused',
      workspaceId: 1,
      operation: 'upload',
      idempotencyKey: 'upload:workspace-a:remote-base-a:head-paused',
      baseRemoteVersionId: 'remote-base-a',
      localHeadSha: 'head-paused',
      nowMs: 40,
    });

    worker.scheduleWorkspaceChanged('workspace-a');
    worker.pauseWorkspace('workspace-a');

    expect(timers[0].cleared).toBe(true);
    worker.scheduleWorkspaceChanged('workspace-a');
    await expect(worker.flushWorkspace('workspace-a')).resolves.toEqual({ status: 'idle' });
    await expect(worker.runNext()).resolves.toEqual({ status: 'idle' });
    expect(worker.beginRemotePull('workspace-a')).toBe(false);
    expect(createVersion).not.toHaveBeenCalled();
    expect(queueStatus(db, 'queue-paused')).toBe('pending');

    worker.resumeWorkspace('workspace-a');
    worker.scheduleWorkspaceChanged('workspace-a');
    expect(timers).toHaveLength(2);
    expect(timers[1].cleared).toBe(false);
  });

  it('defers watcher and manual uploads until the remote-pull lease is released', async () => {
    db.prepare(
      `UPDATE workspace_sync_bindings
       SET last_acked_local_head_sha = 'head-a'
       WHERE workspace_id = 1`
    ).run();
    const worker = makeWorker();

    expect(worker.beginRemotePull('workspace-a')).toBe(true);
    worker.scheduleWorkspaceChanged('workspace-a');
    await expect(worker.flushWorkspace('workspace-a')).resolves.toEqual({ status: 'idle' });
    expect(timers).toHaveLength(0);
    expect(createVersion).not.toHaveBeenCalled();

    worker.endRemotePull('workspace-a');

    expect(timers).toHaveLength(1);
    await timers[0].callback();
    expect(createVersion).not.toHaveBeenCalled();
    expect(queueCount(db)).toBe(0);
  });

  it('discards deferred watcher work when sync is disabled during a remote pull', () => {
    const worker = makeWorker();

    expect(worker.beginRemotePull('workspace-a')).toBe(true);
    worker.scheduleWorkspaceChanged('workspace-a');
    db.prepare(`UPDATE workspace_sync_bindings SET enabled = 0 WHERE workspace_id = 1`).run();
    worker.endRemotePull('workspace-a');

    expect(timers).toHaveLength(0);
    worker.scheduleWorkspaceChanged('workspace-a');
    expect(timers).toHaveLength(0);
  });

  it('refuses watcher and manual uploads for a recovery-quarantined workspace', async () => {
    const job = enqueueWorkspaceSyncJob(db, {
      id: 'recovery-quarantine',
      workspaceId: 1,
      operation: 'refresh',
      idempotencyKey: 'replica-recovery:workspace-a',
      nowMs,
    });
    markWorkspaceSyncJobFailed(db, {
      id: job.id,
      nowMs,
      retryable: false,
      retryDelayMs: 0,
      maxAttempts: 1,
      errorCode: 'REPLICA_RECOVERY_REQUIRED',
      errorMessage: 'journal proof failed',
    });
    const worker = makeWorker();

    worker.scheduleWorkspaceChanged('workspace-a');
    expect(timers).toHaveLength(0);
    await expect(worker.flushWorkspace('workspace-a')).rejects.toThrow('REPLICA_RECOVERY_REQUIRED');
    expect(createVersion).not.toHaveBeenCalled();
  });

  it('keeps uploads blocked across restart until package recovery succeeds', async () => {
    const job = enqueueWorkspaceSyncJob(db, {
      id: 'package-recovery-quarantine',
      workspaceId: 1,
      operation: 'refresh',
      idempotencyKey: 'package-recovery:workspace-a:package-a',
      nowMs,
    });
    markWorkspaceSyncJobFailed(db, {
      id: job.id,
      nowMs,
      retryable: false,
      retryDelayMs: 0,
      maxAttempts: 1,
      errorCode: 'PACKAGE_RECOVERY_REQUIRED',
      errorMessage: 'package rollback failed',
    });
    const worker = makeWorker();

    worker.scheduleWorkspaceChanged('workspace-a');
    expect(timers).toHaveLength(0);
    await expect(worker.flushWorkspace('workspace-a')).rejects.toThrow('PACKAGE_RECOVERY_REQUIRED');
    expect(createVersion).not.toHaveBeenCalled();
  });

  it('refuses watcher, manual, and forced uploads while the dedicated screen delivery is pending', async () => {
    db.exec(
      `UPDATE workspace_sync_bindings SET last_acked_local_head_sha = 'head-a' WHERE workspace_id = 1`
    );
    recordPendingWorkspaceSyncRendererRefresh(db, {
      workspaceId: 1,
      localHeadSha: 'head-a',
      nowMs,
      notice: {
        workspaceUuid: 'workspace-a',
        workspaceRoot: '/managed/workspace-a/repo',
        remoteVersionId: 'remote-base-a',
        changedPaths: [],
        deletedPaths: [],
        affectedNotebookIds: [],
        affectedDesignIds: [],
        deletedDesignIds: [],
      },
    });
    const worker = makeWorker();
    worker.scheduleWorkspaceChanged('workspace-a');
    expect(timers).toHaveLength(0);
    await expect(worker.flushWorkspace('workspace-a')).rejects.toThrow('RENDERER_REFRESH_PENDING');
    await expect(worker.flushWorkspace('workspace-a', { force: true })).rejects.toThrow(
      'RENDERER_REFRESH_PENDING'
    );
    expect(snapshotWorkspace).not.toHaveBeenCalled();
    expect(createVersion).not.toHaveBeenCalled();
  });

  it('refuses watcher and manual uploads until a committed renderer refresh is acknowledged', async () => {
    const job = enqueueWorkspaceSyncJob(db, {
      id: 'renderer-refresh-pending',
      workspaceId: 1,
      operation: 'refresh',
      idempotencyKey: 'renderer-refresh:workspace-a:remote-version-b',
      nowMs,
    });
    markWorkspaceSyncJobFailed(db, {
      id: job.id,
      nowMs,
      retryable: false,
      retryDelayMs: 0,
      maxAttempts: 1,
      errorCode: 'RENDERER_REFRESH_PENDING',
      errorMessage: '{"version":1}',
    });
    const worker = makeWorker();

    worker.scheduleWorkspaceChanged('workspace-a');
    expect(timers).toHaveLength(0);
    await expect(worker.flushWorkspace('workspace-a')).rejects.toThrow('RENDERER_REFRESH_PENDING');
    expect(createVersion).not.toHaveBeenCalled();
  });

  it('does not grant a remote-pull lease while an upload flush is in flight', async () => {
    let releaseUpload: (() => void) | null = null;
    const uploadStarted = new Promise<void>((resolve) => {
      createVersion.mockImplementationOnce(
        () =>
          new Promise((resolveUpload) => {
            releaseUpload = () => resolveUpload(readyVersion('remote-version-a', 2, CONTENT_A));
            resolve();
          })
      );
    });
    const worker = makeWorker();

    const flush = worker.flushWorkspace('workspace-a');
    await uploadStarted;

    expect(worker.beginRemotePull('workspace-a')).toBe(false);

    invokeDeferred(releaseUpload);
    await flush;
    expect(queueStatus(db, 'queue-a')).toBe('succeeded');
  });

  it('backs off retryable failures durably and retries when due', async () => {
    createVersion.mockRejectedValueOnce(
      Object.assign(new Error('offline'), { code: 'NETWORK', retryable: true, terminal: false })
    );
    const worker = makeWorker();

    await worker.flushWorkspace('workspace-a');

    expect(queueStatus(db, 'queue-a')).toBe('retry_wait');
    expect(queueRow(db, 'queue-a')).toMatchObject({
      next_attempt_at: 5100,
      error_code: 'NETWORK',
      error_message: 'offline',
      attempt_count: 1,
    });

    nowMs = 5099;
    await expect(worker.runNext()).resolves.toMatchObject({ status: 'idle' });
    expect(createVersion).toHaveBeenCalledTimes(1);

    nowMs = 5100;
    await expect(worker.runNext()).resolves.toMatchObject({ status: 'uploaded' });
    expect(createVersion).toHaveBeenCalledTimes(2);
    expect(queueStatus(db, 'queue-a')).toBe('succeeded');
    expect(queueRow(db, 'queue-a').attempt_count).toBe(2);
  });

  it('reuses byte-identical durable request content after a lost response and restart', async () => {
    const requests: string[] = [];
    createVersion.mockImplementationOnce(async (request) => {
      requests.push(JSON.stringify(request));
      throw Object.assign(new Error('response lost'), {
        code: 'NETWORK',
        retryable: true,
        terminal: false,
      });
    });
    const firstWorker = makeWorker();

    await expect(firstWorker.flushWorkspace('workspace-a')).resolves.toMatchObject({
      status: 'retry_wait',
      errorCode: 'NETWORK',
    });
    expect(uploadSnapshotCount(db, 'queue-a')).toBe(1);

    snapshotWorkspace.mockRejectedValue(
      new Error('A durable retry must not read the changed working tree after restart.')
    );
    nowMs = 5_100;
    createVersion.mockImplementationOnce(async (request) => {
      requests.push(JSON.stringify(request));
      return readyVersion('remote-version-a', 2, CONTENT_A);
    });
    const restartedWorker = makeWorker();

    await expect(restartedWorker.runNext()).resolves.toMatchObject({ status: 'uploaded' });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toBe(requests[0]);
    expect(snapshotWorkspace).toHaveBeenCalledTimes(1);
    expect(uploadSnapshotCount(db, 'queue-a')).toBe(0);
  });

  it('retries pending package admission beyond its attempt budget and after restart using the exact durable request', async () => {
    const requests: string[] = [];
    const pending = createDesktopSyncClient({
      baseUrl: 'https://web.test',
      nowMs: () => nowMs,
      getActiveStoredSession: async () =>
        ({
          accountId: 'account-a',
          accessToken: 'test-access-token',
          refreshToken: 'test-refresh-token',
          expiresAt: '2030-01-01T00:00:00.000Z',
        }) as never,
      performRefresh: async () => ({ status: 'refreshed' }),
      fetch: async () =>
        new Response(
          JSON.stringify({
            code: 'SEQUENCE_PACKAGE_ADMISSION_PENDING',
            message: 'Package inspection is pending.',
          }),
          { status: 503, headers: { 'content-type': 'application/json', 'retry-after': '2' } }
        ),
    });
    createVersion.mockImplementation(async (request) => {
      requests.push(JSON.stringify(request));
      await pending.requestJson('/api/desktop-sync/workspaces/project/versions/manifest', {
        method: 'POST',
        idempotencyKey: request.idempotencyKey,
        body: request.manifest ?? request.bundle,
      });
      throw new Error('Pending admission must not return success.');
    });
    await expect(makeWorker().flushWorkspace('workspace-a')).resolves.toMatchObject({
      status: 'retry_wait',
      errorCode: 'IN_PROGRESS',
    });
    snapshotWorkspace.mockRejectedValue(new Error('Restart must not recapture current bytes.'));
    const restarted = makeWorker();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      nowMs += 60_000;
      await expect(restarted.runNext()).resolves.toMatchObject({ status: 'retry_wait' });
    }
    expect(queueRow(db, 'queue-a').attempt_count).toBeGreaterThan(3);
    expect(uploadSnapshotCount(db, 'queue-a')).toBe(1);
    expect(versionCount(db)).toBe(0);
    expect(snapshotWorkspace).toHaveBeenCalledTimes(1);
    expect(new Set(requests).size).toBe(1);
    createVersion.mockImplementationOnce(async (request) => {
      requests.push(JSON.stringify(request));
      return readyVersion('remote-version-a', 2, CONTENT_A);
    });
    nowMs += 60_000;
    await expect(restarted.runNext()).resolves.toMatchObject({ status: 'uploaded' });
    expect(new Set(requests).size).toBe(1);
    expect(queueStatus(db, 'queue-a')).toBe('succeeded');
    expect(uploadSnapshotCount(db, 'queue-a')).toBe(0);
  });

  it('retains exact recovery bytes across lost candidate acknowledgement, restart, pending admission, inspection interruption and terminal invalid-package refusal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dnaforge-worker-recovery-'));
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const publishManifest = manifestUpload.createManifestWorkspaceSyncVersion;
    const pollBudget = vi
      .spyOn(manifestUpload, 'createManifestWorkspaceSyncVersion')
      .mockImplementation((client, request, signal, options) =>
        publishManifest(client, request, signal, { ...options, maxVerificationPolls: 1 })
      );
    try {
      db.prepare(
        `UPDATE workspace_sync_bindings SET remote_workspace_id = ?, remote_latest_version_id = ?, last_acked_local_head_sha = 'base-head' WHERE workspace_id = 1`
      ).run(REMOTE_WORKSPACE_ID, REMOTE_VERSION_ID);
      const source = join(root, 'design.gb');
      const content = 'LOCUS       original\nORIGIN\n        1 acgt\n//\n';
      writeFileSync(source, content);
      const capture = manifestCapture(source, content);
      const snapshotUploadWorkspace = vi.fn(async () => capture);
      const candidateRequests: Array<{ key: string | undefined; body: unknown }> = [];
      let loseAck = true;
      let terminal = false;
      let versionRequests = 0;
      const publicationBodies: string[] = [];
      const transport = createDesktopSyncClient({
        baseUrl: 'https://web.test',
        nowMs: () => nowMs,
        getActiveStoredSession: async () =>
          ({
            accountId: 'account-a',
            accessToken: 'test-access-token',
            refreshToken: 'test-refresh-token',
            accessTokenExpiresAt: '2030-01-01T00:00:00.000Z',
          }) as never,
        performRefresh: async () => ({ status: 'refreshed' }),
        fetch: async (url, options) => {
          const requestUrl = new URL(String(url));
          const path = requestUrl.pathname;
          const body = options?.body ? JSON.parse(String(options.body)) : null;
          let response: unknown;
          if (path.endsWith('/storage-policy')) {
            expect(requestUrl.search).toBe('?fileSelectionVersion=1');
            response = publicationPolicy();
          } else if (path.endsWith('/blobs/reserve'))
            response = {
              status: 'ready',
              blobId: REMOTE_VERSION_ID,
              contentSha256: body.contentSha256,
              sizeBytes: body.sizeBytes,
            };
          else if (path.endsWith('/recovery-candidates')) {
            const key = new Headers(options?.headers).get('Idempotency-Key') ?? undefined;
            candidateRequests.push({ key, body });
            response = recoveryResponse(body);
            if (loseAck) {
              loseAck = false;
              throw new TypeError('Candidate retained remotely; acknowledgement lost.');
            }
          } else {
            expect(path).toBe(`/api/desktop-sync/workspaces/${REMOTE_WORKSPACE_ID}/versions`);
            versionRequests += 1;
            publicationBodies.push(
              JSON.stringify({ key: new Headers(options?.headers).get('Idempotency-Key'), body })
            );

            if (!terminal && versionRequests > 1) {
              return new Response(
                JSON.stringify({ code: 'BACKEND', message: 'Inspection connection lost.' }),
                {
                  status: 503,
                  headers: { 'content-type': 'application/json' },
                }
              );
            }
            return new Response(
              JSON.stringify({
                code: terminal ? 'SEQUENCE_PACKAGE_INVALID' : 'SEQUENCE_PACKAGE_ADMISSION_PENDING',
                message: terminal ? 'Invalid package is not accepted.' : 'Admission pending.',
              }),
              { status: terminal ? 422 : 503, headers: { 'content-type': 'application/json' } }
            );
          }
          return new Response(JSON.stringify(response), {
            headers: { 'content-type': 'application/json' },
          });
        },
      });
      const workerDeps: WorkspaceSyncUploadWorkerDeps = {
        ...baseDeps(),
        snapshotWorkspace: undefined,
        snapshotUploadWorkspace,
        verifyUploadCaptureMatchesCommit: async () => undefined,
        hasWorkingTreeChanges: () => false,
        uploadSnapshotRoot: root,
        client: createWorkspaceSyncUploadClient(transport),
      };
      const status = (overrides: Partial<Parameters<typeof readWorkspaceSyncStatus>[1]> = {}) =>
        readWorkspaceSyncStatus(db, {
          workspaceUuid: 'workspace-a',
          getActiveAccountId: () => 'account-a',
          getCurrentLocalHeadSha: () => 'head-a',
          nowMs: () => nowMs,
          ...overrides,
        });
      expect(
        await new WorkspaceSyncUploadWorker(db, workerDeps).flushWorkspace('workspace-a')
      ).toMatchObject({ status: 'retry_wait', errorCode: 'NETWORK' });
      expect(readWorkspaceSyncRecoveryCandidateIntent(db, 'queue-a')?.receipt).toBeUndefined();
      expect(status().recoveryCandidate).toBeUndefined();
      expect(versionRequests).toBe(0);
      snapshotUploadWorkspace.mockRejectedValue(
        new Error('Recovery retry must not recapture changed working bytes.')
      );
      writeFileSync(source, 'later unreviewed file bytes');
      nowMs = 5_100;
      const restarted = new WorkspaceSyncUploadWorker(db, workerDeps);
      expect(await restarted.runNext()).toMatchObject({
        status: 'retry_wait',
        errorCode: 'IN_PROGRESS',
      });
      expect(versionRequests).toBe(1);
      expect(new Set(publicationBodies).size).toBe(1);
      const retained = readWorkspaceSyncRecoveryCandidateIntent(db, 'queue-a')!;
      expect(retained.receipt?.coverage).toBe('captured-bytes');
      expect(candidateRequests).toHaveLength(2);
      expect(candidateRequests[1]).toEqual(candidateRequests[0]);
      expect(snapshotUploadWorkspace).toHaveBeenCalledTimes(1);
      expect(status()).toMatchObject({
        canDisplayPlainSynced: false,
        recoveryCandidate: {
          candidateId: retained.receipt!.id,
          localHeadSha: 'head-a',
          expiresAt: retained.receipt!.expiresAt,
        },
      });
      expect(
        status({ workspaceUuid: 'workspace-a', getActiveAccountId: () => 'account-b' })
          .recoveryCandidate
      ).toBeUndefined();
      expect(
        status({ workspaceUuid: 'workspace-a', getCurrentLocalHeadSha: () => 'new-head' })
          .recoveryCandidate
      ).toBeUndefined();
      expect(
        status({
          workspaceUuid: 'workspace-a',
          nowMs: () => Date.parse(retained.receipt!.expiresAt) + 1,
        }).recoveryCandidate
      ).toBeUndefined();
      nowMs = 15_100;
      expect(await restarted.runNext()).toMatchObject({
        status: 'retry_wait',
        errorCode: 'SERVER',
      });
      expect(versionRequests).toBe(2);
      expect(new Set(publicationBodies).size).toBe(1);
      expect(snapshotUploadWorkspace).toHaveBeenCalledTimes(1);
      expect(uploadSnapshotCount(db, 'queue-a')).toBe(1);
      terminal = true;
      nowMs = 35_100;
      expect(await restarted.runNext()).toMatchObject({
        status: 'failed',
        errorCode: 'VALIDATION',
      });
      expect(candidateRequests).toHaveLength(2);
      expect(versionRequests).toBe(3);
      expect(new Set(publicationBodies).size).toBe(1);
      expect(versionCount(db)).toBe(0);
      expect(bindingState(db)).toMatchObject({
        remote_latest_version_id: REMOTE_VERSION_ID,
        last_acked_local_head_sha: 'base-head',
      });
      expect(uploadSnapshotCount(db, 'queue-a')).toBe(1);
      expect(status().recoveryCandidate?.candidateId).toBe(retained.receipt!.id);
      const frozenPath = join(
        workspaceSyncUploadSnapshotDirectory(root, 'queue-a'),
        'files',
        capture.manifest.files[0]!.contentSha256
      );
      expect(readFileSync(frozenPath, 'utf8')).toBe(content);
    } finally {
      pollBudget.mockRestore();
      clock.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('retains a locally invalid package through conservative raw capture without ever calling accepted publication', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dnaforge-invalid-recovery-worker-'));
    const repo = join(root, 'repo');
    const uploads = join(root, 'uploads');
    try {
      mkdirSync(join(repo, 'sequences/invalid/.forge'), { recursive: true });
      const marker = JSON.stringify({
        schema: 'waypoint.sequence.v1',
        kind: 'sequence',
        formatVersion: 99,
        id: 'invalid-stable-id',
        product: { file: 'construct.gb' },
        members: [{ id: 'missing', path: 'contents/missing.bin', role: 'data' }],
      });
      writeFileSync(join(repo, 'sequences/invalid/.forge/plasmid.json'), marker);
      writeFileSync(join(repo, 'sequences/invalid/construct.gb'), Buffer.from([0xff, 0xfe, 0x00]));
      writeFileSync(join(repo, 'notes.txt'), 'exact recovery notes');
      await initManagedRepo(repo);
      await commitAllIfDirty(repo, 'Invalid package draft retained locally');
      db.prepare(`UPDATE workspaces SET path = ? WHERE id = 1`).run(repo);
      db.prepare(
        `UPDATE workspace_sync_bindings SET remote_workspace_id = ?, remote_latest_version_id = ?, last_acked_local_head_sha = 'base-head' WHERE workspace_id = 1`
      ).run(REMOTE_WORKSPACE_ID, REMOTE_VERSION_ID);
      recordWorkspaceSyncReplicaFiles(db, {
        workspaceUuid: 'workspace-a',
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        remoteVersionId: REMOTE_VERSION_ID,
        paths: ['notes.txt'],
        nowMs,
      });
      const head = (await resolveHeadCommit(repo))!;
      const observed: unknown[] = [];
      let publicationRequests = 0;
      const transport: DesktopSyncClient = {
        requestStream: vi.fn(),
        requestJson: async <T>(
          path: string,
          options: Parameters<DesktopSyncClient['requestJson']>[1]
        ) => {
          if (path.endsWith('/storage-policy?fileSelectionVersion=1'))
            return {
              schema: 'dnaforge.workspace-sync-publication-policy/v1',
              policy: TEST_STORAGE_POLICY,
              fileSelection: { supportedVersion: 1, requiredVersion: 0 },
            } as T;
          if (path.endsWith('/storage-policy')) return TEST_STORAGE_POLICY as T;
          if (path.endsWith('/blobs/reserve')) {
            const body = options.body as { contentSha256: string; sizeBytes: number };
            return { status: 'ready', blobId: REMOTE_VERSION_ID, ...body } as T;
          }
          if (path.endsWith('/recovery-candidates')) {
            observed.push(options.body);
            return recoveryResponse(options.body) as T;
          }
          publicationRequests += 1;
          throw new Error('An invalid local package must never reach accepted publication.');
        },
      };
      const worker = new WorkspaceSyncUploadWorker(db, {
        ...baseDeps(),
        snapshotWorkspace: undefined,
        getCurrentLocalHeadSha: () => resolveHeadCommit(repo),
        commitWorkingTreeIfDirty: () => commitAllIfDirty(repo, 'Freeze recovery draft'),
        uploadSnapshotRoot: uploads,
        client: createWorkspaceSyncUploadClient(transport),
      });
      const result = await worker.flushWorkspace('workspace-a');
      expect(result).toMatchObject({ status: 'failed', errorCode: 'RECOVERY_CAPTURE_ONLY' });
      expect(publicationRequests).toBe(0);
      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({
        reason: 'invalid-package',
        missingPaths: ['sequences/invalid/contents/missing.bin'],
      });
      expect(versionCount(db)).toBe(0);
      expect(bindingState(db)).toMatchObject({
        remote_latest_version_id: REMOTE_VERSION_ID,
        last_acked_local_head_sha: 'base-head',
      });
      expect(uploadSnapshotCount(db, 'queue-a')).toBe(1);
      const retained = readWorkspaceSyncRecoveryCandidateIntent(db, 'queue-a')!;
      expect(retained).toMatchObject({
        localHeadSha: head,
        receipt: { coverage: 'incomplete', reason: 'invalid-package' },
      });
      expect(
        readWorkspaceSyncStatus(db, {
          workspaceUuid: 'workspace-a',
          getActiveAccountId: () => 'account-a',
          getCurrentLocalHeadSha: () => head,
          nowMs: () => nowMs,
        })
      ).toMatchObject({
        canDisplayPlainSynced: false,
        recoveryCandidate: {
          localHeadSha: head,
          coverage: 'incomplete',
          candidateId: retained.receipt!.id,
        },
      });
      const envelope = JSON.parse(
        (
          db
            .prepare(
              `SELECT bundle_json FROM workspace_sync_upload_snapshots WHERE job_id = 'queue-a'`
            )
            .get() as { bundle_json: string }
        ).bundle_json
      );
      expect(envelope.recoveryOnly).toMatchObject({ reason: 'invalid-package' });
      const product = envelope.manifest.files.find((entry: { path: string }) =>
        entry.path.endsWith('construct.gb')
      );
      expect([
        ...readFileSync(
          join(
            workspaceSyncUploadSnapshotDirectory(uploads, 'queue-a'),
            'files',
            product.contentSha256
          )
        ),
      ]).toEqual([0xff, 0xfe, 0x00]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed before network when a durable job key no longer names its bytes', async () => {
    createVersion.mockRejectedValueOnce(
      Object.assign(new Error('response lost'), {
        code: 'NETWORK',
        retryable: true,
        terminal: false,
      })
    );
    const worker = makeWorker();
    await worker.flushWorkspace('workspace-a');
    expect(uploadSnapshotCount(db, 'queue-a')).toBe(1);
    db.prepare(
      `UPDATE workspace_sync_queue SET idempotency_key = 'upload:tampered' WHERE id = 'queue-a'`
    ).run();
    nowMs = 5_100;

    await expect(worker.runNext()).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'DURABLE_UPLOAD_INVALID',
    });
    expect(createVersion).toHaveBeenCalledTimes(1);
    expect(uploadSnapshotCount(db, 'queue-a')).toBe(0);
  });

  it('leaves terminal failures unclaimable', async () => {
    createVersion.mockRejectedValueOnce(
      Object.assign(new Error('remote changed'), {
        code: 'CONFLICT',
        retryable: false,
        terminal: true,
      })
    );
    const worker = makeWorker();

    await worker.flushWorkspace('workspace-a');

    expect(queueStatus(db, 'queue-a')).toBe('failed');
    expect(queueRow(db, 'queue-a')).toMatchObject({
      next_attempt_at: null,
      error_code: 'CONFLICT',
      error_message: 'remote changed',
    });
    nowMs = 10_000;
    await expect(worker.runNext()).resolves.toMatchObject({ status: 'idle' });
    expect(createVersion).toHaveBeenCalledTimes(1);
  });

  it('force flush requeues a failed NETWORK job and uploads instead of returning idle ok', async () => {
    createVersion
      .mockRejectedValueOnce(
        Object.assign(new Error('offline'), { code: 'NETWORK', retryable: true, terminal: false })
      )
      .mockResolvedValueOnce(readyVersion('remote-version-a', 2, CONTENT_A));

    const worker = makeWorker();
    await worker.flushWorkspace('workspace-a');
    db.prepare(
      `UPDATE workspace_sync_queue
       SET status = 'failed', next_attempt_at = NULL, attempt_count = 5
       WHERE workspace_id = 1`
    ).run();

    await expect(worker.flushWorkspace('workspace-a')).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'NETWORK',
    });
    expect(createVersion).toHaveBeenCalledTimes(1);

    await expect(worker.flushWorkspace('workspace-a', { force: true })).resolves.toMatchObject({
      status: 'uploaded',
    });
    expect(createVersion).toHaveBeenCalledTimes(2);
    expect(queueStatus(db, 'queue-a')).toBe('succeeded');
  });

  it.each([false, true])(
    'manually retries an unchanged upload after a blob failure with automatic retry %s',
    async (retryable) => {
      createVersion.mockRejectedValue(
        Object.assign(new Error('storage transfer failed'), {
          code: 'BLOB_UPLOAD_FAILED',
          retryable,
          terminal: !retryable,
        })
      );
      const worker = new WorkspaceSyncUploadWorker(db, { ...baseDeps(), maxAttempts: undefined });
      await worker.flushWorkspace('workspace-a');
      for (let attempt = 1; attempt < 5; attempt += 1) {
        nowMs += 60_000;
        await worker.runNext();
      }

      const failedAttempts = retryable ? 5 : 1;
      expect(createVersion).toHaveBeenCalledTimes(failedAttempts);
      expect(queueRow(db, 'queue-a')).toMatchObject({
        status: 'failed',
        attempt_count: failedAttempts,
        error_code: 'BLOB_UPLOAD_FAILED',
        next_attempt_at: null,
      });
      expect(uploadSnapshotCount(db, 'queue-a')).toBe(0);

      createVersion.mockResolvedValue(readyVersion('remote-version-a', 2, CONTENT_A));
      nowMs += 60_000;
      await expect(worker.runNext()).resolves.toMatchObject({ status: 'idle' });
      await expect(worker.flushWorkspace('workspace-a')).resolves.toMatchObject({
        status: 'failed',
        errorCode: 'BLOB_UPLOAD_FAILED',
      });
      expect(createVersion).toHaveBeenCalledTimes(failedAttempts);

      await expect(worker.flushWorkspace('workspace-a', { force: true })).resolves.toMatchObject({
        status: 'uploaded',
      });
      expect(createVersion).toHaveBeenCalledTimes(failedAttempts + 1);
      expect(queueRow(db, 'queue-a')).toMatchObject({
        status: 'succeeded',
        attempt_count: 1,
        error_code: null,
        local_head_sha: 'head-a',
        bundle_content_sha256: CONTENT_A,
      });
      expect(createVersion.mock.calls.at(-1)?.[0].bundle).toEqual(
        createVersion.mock.calls[0]?.[0].bundle
      );
    }
  );

  it('publishes an approved selection after a legacy refusal without changing saved bytes', async () => {
    createVersion.mockRejectedValueOnce(
      Object.assign(new Error('This project requires shared file selection.'), {
        code: 'UPGRADE_REQUIRED',
        retryable: false,
        terminal: true,
      })
    );
    const worker = makeWorker();
    await expect(worker.flushWorkspace('workspace-a')).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'UPGRADE_REQUIRED',
    });
    const oldRequest = JSON.stringify(createVersion.mock.calls[0][0]);
    expect(createVersion.mock.calls[0][0].fileSelectionVersion).toBe(0);
    const reviewed = {
      ...snapshot('workspace-a', CONTENT_A, 'head-a'),
      excludedFiles: [],
      selection: {
        version: 1 as const,
        revision: 'a'.repeat(64),
        state: 'active' as const,
        ruleFiles: [],
        newlyIncludedPaths: [],
      },
    };
    snapshotWorkspace.mockResolvedValue(reviewed);
    nextJobId = 'queue-b';
    nowMs += 1000;
    await expect(worker.flushWorkspace('workspace-a', { force: true })).resolves.toMatchObject({
      status: 'uploaded',
      job: { id: 'queue-b' },
    });
    expect(createVersion).toHaveBeenCalledTimes(2);
    const upgraded = createVersion.mock.calls[1][0];
    expect(upgraded.fileSelectionVersion).toBe(1);
    expect(upgraded.idempotencyKey).not.toBe(createVersion.mock.calls[0][0].idempotencyKey);
    expect(upgraded.bundle).toEqual(createVersion.mock.calls[0][0].bundle);
    expect(JSON.stringify(createVersion.mock.calls[0][0])).toBe(oldRequest);
    expect(queueRow(db, 'queue-b')).toMatchObject({
      status: 'succeeded',
      local_head_sha: 'head-a',
      bundle_content_sha256: CONTENT_A,
    });
    expect(
      readWorkspaceSyncStatus(db, {
        workspaceUuid: 'workspace-a',
        getActiveAccountId: () => 'account-a',
        getCurrentLocalHeadSha: () => 'head-a',
        nowMs: () => nowMs,
      })
    ).toMatchObject({ syncAxis: 'idle_synced', terminalErrorCode: null });
  });

  it.each(['NETWORK', 'QUOTA_EXCEEDED'])(
    'preserves an already reviewed upload with an older queue key after %s',
    async (refusalCode) => {
      const captured = {
        ...snapshot('workspace-a', CONTENT_A, 'head-a'),
        excludedFiles: [],
        selection: {
          version: 1 as const,
          revision: 'b'.repeat(64),
          state: 'active' as const,
          ruleFiles: [],
          newlyIncludedPaths: [],
        },
      };
      const oldKey = `upload:workspace-a:remote-base-a:head-a:${CONTENT_A}`;
      enqueueWorkspaceSyncJob(db, {
        id: 'queue-a',
        workspaceId: 1,
        operation: 'upload',
        idempotencyKey: oldKey,
        baseRemoteVersionId: 'remote-base-a',
        localHeadSha: 'head-a',
        bundleContentSha256: CONTENT_A,
        nowMs,
      });
      recordWorkspaceSyncUploadSnapshot(db, { jobId: 'queue-a', snapshot: captured, nowMs });
      createVersion.mockRejectedValueOnce(
        Object.assign(new Error(refusalCode), {
          code: refusalCode,
          retryable: refusalCode === 'NETWORK',
          terminal: refusalCode !== 'NETWORK',
        })
      );
      const refused = await makeWorker().runNext();
      expect(refused, JSON.stringify(refused)).toMatchObject({ errorCode: refusalCode });
      const originalRequest = JSON.stringify(createVersion.mock.calls[0][0]);
      expect(createVersion.mock.calls[0][0].fileSelectionVersion).toBe(1);
      nextJobId = 'queue-b';
      nowMs += 60000;
      const restarted = makeWorker();
      if (refusalCode === 'NETWORK') {
        snapshotWorkspace.mockRejectedValue(new Error('Do not recapture a queued retry.'));
        await expect(restarted.runNext()).resolves.toMatchObject({ status: 'uploaded' });
      } else {
        snapshotWorkspace.mockResolvedValue({
          ...captured,
          bundle: { ...captured.bundle, capturedAt: '2026-07-08T00:00:01.000Z' },
        });
        await expect(
          restarted.flushWorkspace('workspace-a', { force: true })
        ).resolves.toMatchObject({
          status: 'uploaded',
          job: { id: 'queue-a' },
        });
      }
      expect(createVersion).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(createVersion.mock.calls[1][0])).toBe(originalRequest);
      expect(createVersion.mock.calls[1][0].idempotencyKey).toBe(oldKey);
      expect(queueCount(db)).toBe(1);
      expect(queueStatus(db, 'queue-a')).toBe('succeeded');
    }
  );

  it.each(['VALIDATION', 'QUOTA_EXCEEDED'])(
    'force flush reuses immutable bytes after a %s refusal',
    async (refusalCode) => {
      const requests: string[] = [];
      createVersion
        .mockImplementationOnce(async (request) => {
          requests.push(JSON.stringify(request));
          throw Object.assign(new Error('schemaVersion must be 1'), {
            code: refusalCode,
            retryable: false,
            terminal: true,
          });
        })
        .mockImplementationOnce(async (request) => {
          requests.push(JSON.stringify(request));
          return readyVersion('remote-version-a', 2, CONTENT_A);
        });
      const worker = makeWorker();

      await expect(worker.flushWorkspace('workspace-a')).resolves.toMatchObject({
        status: 'failed',
        errorCode: refusalCode,
      });
      expect(uploadSnapshotCount(db, 'queue-a')).toBe(1);

      const recaptured = snapshot('workspace-a', CONTENT_A, 'head-a');
      recaptured.bundle = {
        ...recaptured.bundle,
        capturedAt: '2026-07-08T00:00:01.000Z',
      };
      recaptured.bundleSizeBytes = Buffer.byteLength(JSON.stringify(recaptured.bundle), 'utf8');
      snapshotWorkspace.mockResolvedValue(recaptured);

      await expect(worker.flushWorkspace('workspace-a', { force: true })).resolves.toMatchObject({
        status: 'uploaded',
      });
      expect(requests).toHaveLength(2);
      expect(requests[1]).toBe(requests[0]);
      expect(queueStatus(db, 'queue-a')).toBe('succeeded');
    }
  );

  it('keeps NETWORK failures in retry_wait even after maxAttempts', async () => {
    createVersion.mockRejectedValue(
      Object.assign(new Error('offline'), { code: 'NETWORK', retryable: true, terminal: false })
    );
    const worker = makeWorker();

    await worker.flushWorkspace('workspace-a');
    for (let i = 0; i < 5; i += 1) {
      nowMs += 60_000;
      await worker.runNext();
    }

    expect(queueStatus(db, 'queue-a')).toBe('retry_wait');
    expect(queueRow(db, 'queue-a').attempt_count).toBeGreaterThanOrEqual(3);
    expect(queueRow(db, 'queue-a').error_code).toBe('NETWORK');
  });

  it('keeps rollout-disabled uploads queued until the feature is enabled', async () => {
    createVersion.mockRejectedValue(
      Object.assign(new Error('rollout disabled'), {
        code: 'FEATURE_DISABLED',
        retryable: true,
        terminal: false,
      })
    );
    const worker = makeWorker();

    await worker.flushWorkspace('workspace-a');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      nowMs += 60_000;
      await worker.runNext();
    }

    expect(queueStatus(db, 'queue-a')).toBe('retry_wait');
    expect(queueRow(db, 'queue-a').attempt_count).toBeGreaterThanOrEqual(3);
    expect(queueRow(db, 'queue-a').error_code).toBe('FEATURE_DISABLED');

    createVersion.mockResolvedValue(readyVersion('remote-version-a', 2, CONTENT_A));
    nowMs += 60_000;
    await worker.runNext();

    expect(queueStatus(db, 'queue-a')).toBe('succeeded');
    expect(queueCount(db)).toBe(1);
  });

  it('queues a follow-up upload when the local head changes while upload is in flight', async () => {
    let head = 'head-a';
    nextJobId = 'queue-a';
    const worker = new WorkspaceSyncUploadWorker(db, {
      ...baseDeps(),
      getCurrentLocalHeadSha: () => head,
      createJobId: () => {
        const id = nextJobId;
        nextJobId = 'queue-b';
        return id;
      },
    });
    createVersion.mockImplementationOnce(async () => {
      head = 'head-b';
      return readyVersion('remote-version-a', 2, CONTENT_A);
    });

    await worker.flushWorkspace('workspace-a');

    expect(queueStatus(db, 'queue-a')).toBe('succeeded');
    expect(queueRow(db, 'queue-b')).toMatchObject({
      status: 'pending',
      operation: 'upload',
      idempotency_key: `upload:workspace-a:remote-version-a:head-b:${CONTENT_A}`,
      local_head_sha: 'head-b',
      base_remote_version_id: 'remote-version-a',
    });
    expect(bindingState(db)).toMatchObject({
      remote_latest_version_id: 'remote-version-a',
      last_acked_local_head_sha: 'head-a',
    });
  });

  it('does not race a second null-base upload while the first remote version is in flight', async () => {
    db.prepare(
      `UPDATE workspace_sync_bindings
       SET remote_latest_version_id = NULL,
           remote_latest_version_number = NULL,
           remote_latest_content_sha256 = NULL
       WHERE workspace_id = 1`
    ).run();

    let head = 'head-a';
    let releaseUpload: (() => void) | null = null;
    const uploadStarted = new Promise<void>((resolve) => {
      createVersion.mockImplementationOnce(
        () =>
          new Promise((resolveUpload) => {
            releaseUpload = () => resolveUpload(readyVersion('remote-version-a', 1, CONTENT_A));
            resolve();
          })
      );
    });

    nextJobId = 'queue-a';
    const worker = new WorkspaceSyncUploadWorker(db, {
      ...baseDeps(),
      getCurrentLocalHeadSha: () => head,
      createJobId: () => {
        const id = nextJobId;
        nextJobId = 'queue-b';
        return id;
      },
    });

    const firstFlush = worker.flushWorkspace('workspace-a');
    await uploadStarted;

    head = 'head-b';
    const secondFlush = worker.flushWorkspace('workspace-a');
    expect(secondFlush).toBe(firstFlush);
    expect(queueCount(db)).toBe(1);
    expect(queueRow(db, 'queue-a')).toMatchObject({
      status: 'running',
      base_remote_version_id: null,
      local_head_sha: 'head-a',
    });

    invokeDeferred(releaseUpload);
    await expect(Promise.all([firstFlush, secondFlush])).resolves.toHaveLength(2);

    expect(queueStatus(db, 'queue-a')).toBe('succeeded');
    expect(queueRow(db, 'queue-b')).toMatchObject({
      status: 'pending',
      idempotency_key: `upload:workspace-a:remote-version-a:head-b:${CONTENT_A}`,
      base_remote_version_id: 'remote-version-a',
      local_head_sha: 'head-b',
    });
  });

  it('does not enqueue or upload when current local head is already acked', async () => {
    db.prepare(
      `UPDATE workspace_sync_bindings
       SET last_acked_local_head_sha = 'head-a'
       WHERE workspace_id = 1`
    ).run();
    const worker = makeWorker();

    await expect(worker.flushWorkspace('workspace-a')).resolves.toEqual({ status: 'idle' });

    expect(queueCount(db)).toBe(0);
    expect(snapshotWorkspace).not.toHaveBeenCalled();
    expect(createVersion).not.toHaveBeenCalled();
  });

  it('manual Sync recaptures an acknowledged head so a larger allowance can include previously excluded files', async () => {
    db.prepare(
      "UPDATE workspace_sync_bindings SET last_acked_local_head_sha = 'head-a' WHERE workspace_id = 1"
    ).run();
    const worker = makeWorker();
    await expect(worker.flushWorkspace('workspace-a', { force: true })).resolves.toMatchObject({
      status: 'uploaded',
    });
    expect(snapshotWorkspace).toHaveBeenCalledWith('workspace-a');
    expect(createVersion).toHaveBeenCalledTimes(1);
  });

  it('commits working-tree drift before HEAD-gated enqueue so dirty mirrors upload', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sync-working-tree-drift-'));
    await initManagedRepo(root);
    writeFileSync(join(root, 'design.gb'), 'LOCUS       design\nORIGIN\n        1 atgc\n//\n');
    db.prepare('UPDATE workspaces SET path = ? WHERE id = 1').run(root);
    recordWorkspaceSyncReplicaFiles(db, {
      workspaceUuid: 'workspace-a',
      remoteWorkspaceId: 'remote-workspace-a',
      remoteVersionId: 'remote-base-a',
      paths: ['design.gb'],
      nowMs,
    });
    try {
      db.prepare(
        `UPDATE workspace_sync_bindings
       SET last_acked_local_head_sha = 'head-a'
       WHERE workspace_id = 1`
      ).run();
      let head = 'head-a';
      const commitWorkingTreeIfDirty = vi.fn(async () => {
        head = 'head-b';
        return 'head-b';
      });
      const worker = new WorkspaceSyncUploadWorker(db, {
        ...baseDeps(),
        getCurrentLocalHeadSha: () => head,
        commitWorkingTreeIfDirty,
      });

      await worker.flushWorkspace('workspace-a');

      expect(commitWorkingTreeIfDirty).toHaveBeenCalledWith(root, {
        forceInclude: ['design.gb'],
      });
      expect(createVersion).toHaveBeenCalledTimes(1);
      expect(bindingState(db)).toMatchObject({
        last_acked_local_head_sha: 'head-b',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes only capture directories left by exited processes at startup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sync-abandoned-capture-'));
    const exitedPid = Number(
      execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
        encoding: 'utf8',
      })
    );
    const abandoned = `.capture-${exitedPid}-ABCDEF`;
    const active = `.capture-${process.pid}-ABCDEF`;
    for (const name of [abandoned, active, 'job-retained', 'unrelated']) {
      mkdirSync(join(root, name));
      writeFileSync(join(root, name, 'bytes'), name);
    }
    const worker = new WorkspaceSyncUploadWorker(db, { ...baseDeps(), uploadSnapshotRoot: root });
    try {
      expect(readdirSync(root).sort()).toEqual([active, 'job-retained', 'unrelated'].sort());
      expect(readFileSync(join(root, active, 'bytes'), 'utf8')).toBe(active);
    } finally {
      await worker.stopAndWaitForIdle();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    "access_role = 'viewer'",
    "remote_latest_version_id = 'changed-remote-version'",
    "owner_account_id = 'account-b'",
    'uncommitted local edit',
    'active account changed',
  ])('rejects unlocked immutable capture after authority changes: %s', async (change) => {
    const root = mkdtempSync(join(tmpdir(), 'sync-capture-authority-'));
    const repo = join(root, 'repo');
    const uploads = join(root, 'uploads');
    mkdirSync(repo);
    writeFileSync(join(repo, 'notes.txt'), 'shared notes\n');
    await initManagedRepo(repo);
    await commitAllIfDirty(repo, 'Shared notes');
    db.prepare('UPDATE workspaces SET path = ? WHERE id = 1').run(repo);
    recordWorkspaceSyncReplicaFiles(db, {
      workspaceUuid: 'workspace-a',
      remoteWorkspaceId: 'remote-workspace-a',
      remoteVersionId: 'remote-base-a',
      paths: ['notes.txt'],
      nowMs,
    });
    let finishVerification: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      finishVerification = resolve;
    });
    let started = false;
    let currentAccount = 'account-a';
    const worker = new WorkspaceSyncUploadWorker(db, {
      ...baseDeps(),
      snapshotWorkspace: undefined,
      getActiveAccountId: () => currentAccount,
      getCurrentLocalHeadSha: () => resolveHeadCommit(repo),
      uploadSnapshotRoot: uploads,
      client: {
        supportsManifest: true,
        readStoragePolicy: async () => TEST_STORAGE_POLICY,
        createVersion,
      },
      verifyUploadCaptureMatchesCommit: async (capture, head) => {
        started = true;
        await gate;
        await assertWorkspaceSyncUploadCaptureMatchesCommit(capture, head);
      },
    });
    const flushing = worker.flushWorkspace('workspace-a').then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error })
    );
    try {
      await vi.waitFor(() => expect(started).toBe(true));
      const release = await acquireWorkspaceMutationShared(repo);
      release();
      if (change === 'uncommitted local edit') {
        writeFileSync(join(repo, 'notes.txt'), 'new local bytes without a commit\n');
      } else if (change === 'active account changed') {
        currentAccount = 'account-b';
      } else {
        db.prepare(`UPDATE workspace_sync_bindings SET ${change} WHERE workspace_id = 1`).run();
      }
      finishVerification!();
      expect((await flushing).error).toMatchObject({ code: 'LOCAL_CAPTURE_OBSOLETE' });
      expect(createVersion).not.toHaveBeenCalled();
      expect(db.prepare('SELECT count(*) AS count FROM workspace_sync_queue').get()).toEqual({
        count: 0,
      });
      expect(readdirSync(uploads)).toEqual([]);
    } finally {
      finishVerification!();
      await flushing;
      await worker.stopAndWaitForIdle();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('lets a foreground save finish during immutable verification and recaptures the new commit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sync-foreground-save-'));
    const repo = join(root, 'repo');
    const uploads = join(root, 'uploads');
    mkdirSync(repo);
    const source = join(repo, 'large.fasta');
    const bytes = Buffer.alloc(2 * 1024 * 1024, 'A');
    bytes.write('>large\n');
    bytes[bytes.length - 1] = 10;
    writeFileSync(source, bytes);
    writeFileSync(join(repo, 'notes.txt'), 'original notes\n');
    await initManagedRepo(repo);
    const originalHead = await commitAllIfDirty(repo, 'Original shared project');
    expect(originalHead).toBeTruthy();
    db.prepare('UPDATE workspaces SET path = ? WHERE id = 1').run(repo);
    recordWorkspaceSyncReplicaFiles(db, {
      workspaceUuid: 'workspace-a',
      remoteWorkspaceId: 'remote-workspace-a',
      remoteVersionId: 'remote-base-a',
      paths: ['large.fasta', 'notes.txt'],
      nowMs,
    });
    const originalStat = statSync(source);
    let finishVerification: (() => void) | undefined;
    const verificationGate = new Promise<void>((resolve) => {
      finishVerification = resolve;
    });
    let captured: WorkspaceSyncUploadCapture | undefined;
    let firstVerification = true;
    let saved = false;
    let foreground: Promise<void> | undefined;
    const publish = vi.fn(
      async (request: Parameters<WorkspaceSyncUploadClient['createVersion']>[0]) => {
        const manifest = request.manifest!;
        expect(readFileSync(request.fileSources!.get('notes.txt')!, 'utf8')).toBe(
          'saved while verifying\n'
        );
        return {
          status: 'ready' as const,
          workspaceId: 'remote-workspace-a',
          version: {
            id: 'remote-version-a',
            versionNumber: 2,
            contentSha256: createHash('sha256')
              .update(workspaceSyncManifestHashInput(manifest))
              .digest('hex'),
            sizeBytes: manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0),
            fileCount: manifest.files.length,
            representation: 'manifest_v1' as const,
          },
        };
      }
    );
    const worker = new WorkspaceSyncUploadWorker(db, {
      ...baseDeps(),
      snapshotWorkspace: undefined,
      getCurrentLocalHeadSha: () => resolveHeadCommit(repo),
      commitWorkingTreeIfDirty: (path) => commitAllIfDirty(path, 'Sync preparation'),
      uploadSnapshotRoot: uploads,
      client: {
        supportsManifest: true,
        readStoragePolicy: async () => TEST_STORAGE_POLICY,
        createVersion: publish,
      },
      verifyUploadCaptureMatchesCommit: async (capture, head) => {
        if (firstVerification) {
          firstVerification = false;
          captured = capture;
          await verificationGate;
        }
        await assertWorkspaceSyncUploadCaptureMatchesCommit(capture, head);
      },
    });
    const flushing = worker.flushWorkspace('workspace-a').then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error })
    );
    try {
      await vi.waitFor(() => expect(captured).toBeDefined());
      foreground = acquireWorkspaceMutationShared(repo).then(async (release) => {
        try {
          writeFileSync(join(repo, 'notes.txt'), 'saved while verifying\n');
          await commitAllIfDirty(repo, 'Foreground Save');
          saved = true;
          worker.scheduleWorkspaceChanged('workspace-a');
        } finally {
          release();
        }
      });

      await vi.waitFor(() => expect(saved).toBe(true), { timeout: 1000 });
      expect(readFileSync(captured!.fileSources.get('notes.txt')!, 'utf8')).toBe(
        'original notes\n'
      );
      expect(statSync(captured!.fileSources.get('large.fasta')!).ino).not.toBe(originalStat.ino);
      expect(statSync(source).ctimeMs).toBe(originalStat.ctimeMs);
      finishVerification!();
      await foreground;
      expect((await flushing).error).toMatchObject({ code: 'LOCAL_CAPTURE_OBSOLETE' });
      expect(publish).not.toHaveBeenCalled();
      expect(db.prepare('SELECT count(*) AS count FROM workspace_sync_queue').get()).toEqual({
        count: 0,
      });
      expect(readdirSync(uploads)).toEqual([]);
      expect(timers).toHaveLength(1);
      await timers[0].callback();
      expect(publish).toHaveBeenCalledOnce();
      expect(bindingState(db).last_acked_local_head_sha).toBe(await resolveHeadCommit(repo));
      expect(statSync(source).ctimeMs).toBe(originalStat.ctimeMs);
      expect(readdirSync(uploads).filter((name) => name.startsWith('.capture-'))).toEqual([]);
    } finally {
      finishVerification!();
      await Promise.allSettled([flushing, foreground]);
      await worker.stopAndWaitForIdle();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('holds the exclusive workspace lease through HEAD and snapshot capture', async () => {
    let finishSnapshot: (() => void) | undefined;
    snapshotWorkspace.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSnapshot = () => resolve(snapshot('workspace-a', CONTENT_A, 'head-a'));
        })
    );
    const worker = makeWorker();
    const flushing = worker.flushWorkspace('workspace-a');
    await vi.waitFor(() => expect(snapshotWorkspace).toHaveBeenCalledOnce());
    let laterMutationEntered = false;
    const laterMutation = acquireWorkspaceMutationShared('/managed/workspace-a/repo').then(
      (release) => {
        laterMutationEntered = true;
        return release;
      }
    );

    await Promise.resolve();
    expect(laterMutationEntered).toBe(false);

    expect(() => {
      assertRendererDatabaseStatementAllowed(db);
      seedSyncWorkspace(db, {
        workspaceId: 2,
        workspaceUuid: 'workspace-b',
        accountId: 'account-a',
        remoteWorkspaceId: 'remote-workspace-b',
        remoteLatestVersionId: null,
        remoteLatestVersionNumber: null,
        remoteLatestContentSha256: null,
      });
    }).not.toThrow();

    finishSnapshot?.();
    const releaseLaterMutation = await laterMutation;
    expect(laterMutationEntered).toBe(true);
    releaseLaterMutation();
    await expect(flushing).resolves.toMatchObject({ status: 'uploaded' });
  });

  it('keeps its file lease and drains a renderer transaction before admitting a completed capture', async () => {
    let finishSnapshot: (() => void) | undefined;
    snapshotWorkspace.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSnapshot = () => resolve(snapshot('workspace-a', CONTENT_A, 'head-a'));
        })
    );
    const getCurrentLocalHeadSha = vi.fn(() => 'head-a');
    const worker = new WorkspaceSyncUploadWorker(db, { ...baseDeps(), getCurrentLocalHeadSha });
    const flushing = worker.flushWorkspace('workspace-a');
    await vi.waitFor(() => expect(snapshotWorkspace).toHaveBeenCalledOnce());

    assertRendererDatabaseStatementAllowed(db);
    db.exec('BEGIN TRANSACTION');
    finishSnapshot?.();
    await vi.waitFor(() => expect(getCurrentLocalHeadSha).toHaveBeenCalledTimes(2));
    let laterMutationEntered = false;
    const laterMutation = acquireWorkspaceMutationShared('/managed/workspace-a/repo').then(
      (release) => {
        laterMutationEntered = true;
        return release;
      }
    );
    await Promise.resolve();
    expect(laterMutationEntered).toBe(false);
    expect(createVersion).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS count FROM workspace_sync_queue').get()).toEqual({
      count: 0,
    });

    db.exec('ROLLBACK');
    notifyRendererDatabaseStatementSettled(db);
    const releaseLaterMutation = await laterMutation;
    releaseLaterMutation();
    await expect(flushing).resolves.toMatchObject({ status: 'uploaded' });
  });

  it('admits a capture after its provisional manager grant refreshes to organization owner', async () => {
    db.prepare(
      "UPDATE workspace_sync_bindings SET access_role = 'manager', access_source = 'direct' WHERE workspace_id = 1"
    ).run();
    let finishSnapshot: (() => void) | undefined;
    snapshotWorkspace.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSnapshot = () => resolve(snapshot('workspace-a', CONTENT_A, 'head-a'));
        })
    );
    const flushing = makeWorker().flushWorkspace('workspace-a');
    const uploaded = expect(flushing).resolves.toMatchObject({ status: 'uploaded' });
    await vi.waitFor(() => expect(snapshotWorkspace).toHaveBeenCalledOnce());
    db.prepare(
      "UPDATE workspace_sync_bindings SET access_role = 'owner', access_source = 'org_admin' WHERE workspace_id = 1"
    ).run();
    finishSnapshot?.();
    await uploaded;
    expect(createVersion).toHaveBeenCalledOnce();
  });

  it.each([
    "remote_latest_version_id = 'remote-base-changed'",
    "access_role = 'viewer'",
    "owner_account_id = 'account-b'",
  ])('rejects stale capture admission after its binding changes: %s', async (change) => {
    let finishSnapshot: (() => void) | undefined;
    snapshotWorkspace.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSnapshot = () => resolve(snapshot('workspace-a', CONTENT_A, 'head-a'));
        })
    );
    const flushing = makeWorker().flushWorkspace('workspace-a');
    const rejected = expect(flushing).rejects.toMatchObject({ code: 'LOCAL_CAPTURE_OBSOLETE' });
    await vi.waitFor(() => expect(snapshotWorkspace).toHaveBeenCalledOnce());
    assertRendererDatabaseStatementAllowed(db);
    db.prepare(`UPDATE workspace_sync_bindings SET ${change} WHERE workspace_id = 1`).run();
    finishSnapshot?.();
    await rejected;
    expect(createVersion).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS count FROM workspace_sync_queue').get()).toEqual({
      count: 0,
    });
  });

  it('waits for a direct upload before stop completes and rejects later admission', async () => {
    let releaseUpload: (() => void) | undefined;
    createVersion.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseUpload = () => resolve(readyVersion('remote-version-a', 2, CONTENT_A));
        })
    );
    const worker = makeWorker();
    const flush = worker.flushWorkspace('workspace-a');
    await vi.waitFor(() => expect(createVersion).toHaveBeenCalledOnce());

    let stopped = false;
    const stopping = worker.stopAndWaitForIdle().then(() => {
      stopped = true;
    });
    await Promise.resolve();

    expect(stopped).toBe(false);
    await expect(worker.flushWorkspace('workspace-a')).resolves.toEqual({ status: 'idle' });
    invokeDeferred(releaseUpload);
    await Promise.all([flush, stopping]);
    expect(stopped).toBe(true);
  });

  it('waits for an open renderer transaction before capturing or uploading', async () => {
    db.exec('BEGIN TRANSACTION');
    const worker = makeWorker();

    const upload = worker.flushWorkspace('workspace-a');
    await Promise.resolve();
    await Promise.resolve();
    expect(createVersion).not.toHaveBeenCalled();

    db.exec('ROLLBACK');
    notifyRendererDatabaseStatementSettled(db);
    await expect(upload).resolves.toMatchObject({ status: 'uploaded' });
    expect(createVersion).toHaveBeenCalledOnce();
  });

  it('waits for a renderer transaction to settle before acknowledging a remote upload', async () => {
    let releaseUpload: (() => void) | undefined;
    createVersion.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseUpload = () => resolve(readyVersion('remote-version-a', 2, CONTENT_A));
        })
    );
    const worker = makeWorker();
    let settled = false;
    const upload = worker.flushWorkspace('workspace-a').then((result) => {
      settled = true;
      return result;
    });
    await vi.waitFor(() => expect(createVersion).toHaveBeenCalledOnce());

    db.exec('BEGIN TRANSACTION');
    invokeDeferred(releaseUpload);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    db.exec('ROLLBACK');
    notifyRendererDatabaseStatementSettled(db);
    await expect(upload).resolves.toMatchObject({ status: 'uploaded' });
    expect(bindingState(db)).toMatchObject({ remote_latest_version_id: 'remote-version-a' });
  });

  it('owns an upload started by a debounce callback until stop settles', async () => {
    let releaseUpload: (() => void) | undefined;
    createVersion.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseUpload = () => resolve(readyVersion('remote-version-a', 2, CONTENT_A));
        })
    );
    const worker = makeWorker();
    worker.scheduleWorkspaceChanged('workspace-a');
    const timer = timers.at(-1);
    if (!timer) throw new Error('Expected a debounce timer.');

    const debounced = timer.callback();
    await vi.waitFor(() => expect(createVersion).toHaveBeenCalledOnce());
    let stopped = false;
    const stopping = worker.stopAndWaitForIdle().then(() => {
      stopped = true;
    });
    await Promise.resolve();

    expect(stopped).toBe(false);
    invokeDeferred(releaseUpload);
    await Promise.all([Promise.resolve(debounced), stopping]);
    expect(stopped).toBe(true);
  });

  it('does not claim a later queued upload after shutdown begins', async () => {
    seedSyncWorkspace(db, {
      workspaceId: 2,
      workspaceUuid: 'workspace-b',
      accountId: 'account-a',
      remoteWorkspaceId: 'remote-workspace-b',
      remoteLatestVersionId: 'remote-base-b',
      remoteLatestVersionNumber: 1,
      remoteLatestContentSha256: BASE_CONTENT,
    });
    enqueueWorkspaceSyncJob(db, {
      id: 'queue-b-first',
      workspaceId: 2,
      operation: 'upload',
      idempotencyKey: 'upload:workspace-b:remote-base-b:head-a',
      baseRemoteVersionId: 'remote-base-b',
      localHeadSha: 'head-a',
      nowMs: 50,
    });
    enqueueWorkspaceSyncJob(db, {
      id: 'queue-a-later',
      workspaceId: 1,
      operation: 'upload',
      idempotencyKey: 'upload:workspace-a:remote-base-a:head-a',
      baseRemoteVersionId: 'remote-base-a',
      localHeadSha: 'head-a',
      nowMs: 60,
    });
    snapshotWorkspace.mockImplementation(async (workspaceUuid: string) => ({
      ...snapshot(workspaceUuid, CONTENT_A, 'head-a'),
      workspaceId: workspaceUuid === 'workspace-b' ? 2 : 1,
    }));
    let releaseUpload: (() => void) | undefined;
    createVersion.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseUpload = () =>
            resolve({
              ...readyVersion('remote-version-b', 2, CONTENT_B),
              workspaceId: 'remote-workspace-b',
            });
        })
    );
    const worker = makeWorker();
    const first = worker.runNext();
    await vi.waitFor(() => expect(createVersion).toHaveBeenCalledOnce());

    worker.beginStopping();
    invokeDeferred(releaseUpload);
    await first;

    expect(queueStatus(db, 'queue-b-first')).toBe('succeeded');
    expect(queueStatus(db, 'queue-a-later')).toBe('pending');
    await expect(worker.runNext()).resolves.toEqual({ status: 'idle' });
    expect(createVersion).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: 'workspace identity',
      response: {
        ...readyVersion('remote-version-a', 2, CONTENT_A),
        workspaceId: 'remote-workspace-b',
      },
    },
    {
      label: 'content hash',
      response: readyVersion('remote-version-a', 2, 'c'.repeat(64)),
    },
    {
      label: 'file count',
      response: {
        ...readyVersion('remote-version-a', 2, CONTENT_A),
        version: {
          ...readyVersion('remote-version-a', 2, CONTENT_A).version,
          fileCount: 2,
        },
      },
    },
    {
      label: 'unchanged version identity',
      response: {
        ...readyVersion('remote-version-a', 1, CONTENT_A),
        status: 'unchanged' as const,
      },
    },
    {
      label: 'unchanged version number',
      response: {
        ...readyVersion('remote-base-a', 2, CONTENT_A),
        status: 'unchanged' as const,
      },
    },
    {
      label: 'ready version identity',
      response: readyVersion('remote-base-a', 2, CONTENT_A),
    },
    {
      label: 'ready version number',
      response: readyVersion('remote-version-a', 1, CONTENT_A),
    },
  ])('rejects an upload response with mismatched $label', async ({ response }) => {
    createVersion.mockResolvedValueOnce(response);
    const worker = makeWorker();

    await expect(worker.flushWorkspace('workspace-a')).resolves.toMatchObject({
      status: 'retry_wait',
      errorCode: 'BAD_RESPONSE',
    });
    expect(bindingState(db)).toMatchObject({
      remote_latest_version_id: 'remote-base-a',
      last_acked_local_head_sha: null,
    });
    expect(versionCount(db)).toBe(0);
  });

  it('rejects a remote version id already linked to another local workspace', async () => {
    seedSyncWorkspace(db, {
      workspaceId: 2,
      workspaceUuid: 'workspace-b',
      accountId: 'account-a',
      remoteWorkspaceId: 'remote-workspace-b',
      remoteLatestVersionId: 'remote-version-a',
      remoteLatestVersionNumber: 1,
      remoteLatestContentSha256: BASE_CONTENT,
    });
    db.prepare(
      `INSERT INTO workspace_sync_versions (
         id, workspace_id, remote_version_id, version_number, content_sha256,
         file_count, size_bytes, excluded_summary_json, status, is_latest,
         created_at, updated_at
       ) VALUES ('remote-version-a', 2, 'remote-version-a', 1, ?, 1, 123, '{}',
                 'ready', 1, 1, 1)`
    ).run(BASE_CONTENT);
    const worker = makeWorker();

    await expect(worker.flushWorkspace('workspace-a')).resolves.toMatchObject({
      status: 'retry_wait',
      errorCode: 'BAD_RESPONSE',
    });
    expect(bindingState(db)).toMatchObject({ remote_latest_version_id: 'remote-base-a' });
    expect(versionCount(db)).toBe(1);
  });

  it('supersedes an older failed upload after a newer upload succeeds', async () => {
    enqueueWorkspaceSyncJob(db, {
      id: 'queue-old-failure',
      workspaceId: 1,
      operation: 'upload',
      idempotencyKey: 'upload:workspace-a:remote-base-a:old-head',
      baseRemoteVersionId: 'remote-base-a',
      localHeadSha: 'old-head',
      nowMs: 10,
    });
    markWorkspaceSyncJobFailed(db, {
      id: 'queue-old-failure',
      nowMs: 20,
      retryable: false,
      retryDelayMs: 0,
      maxAttempts: 1,
      errorCode: 'BUNDLE_TOO_LARGE',
      errorMessage: 'old failure',
    });
    const worker = makeWorker();

    await expect(worker.flushWorkspace('workspace-a')).resolves.toMatchObject({
      status: 'uploaded',
    });
    expect(queueStatus(db, 'queue-old-failure')).toBe('canceled');
    expect(
      readWorkspaceSyncStatus(db, {
        workspaceUuid: 'workspace-a',
        getActiveAccountId: () => 'account-a',
        getCurrentLocalHeadSha: () => 'head-a',
        nowMs: () => nowMs,
      })
    ).toMatchObject({ syncAxis: 'idle_synced', canDisplayPlainSynced: true });
  });

  it('deletes an obsolete disabled-upload snapshot after a newer upload succeeds', async () => {
    const oldJob = enqueueWorkspaceSyncJob(db, {
      id: 'queue-old-disabled',
      workspaceId: 1,
      operation: 'upload',
      idempotencyKey: 'upload:workspace-a:remote-base-a:old-head',
      baseRemoteVersionId: 'remote-base-a',
      localHeadSha: 'old-head',
      bundleContentSha256: CONTENT_A,
      nowMs: 10,
    });
    recordWorkspaceSyncUploadSnapshot(db, {
      jobId: oldJob.id,
      snapshot: snapshot('workspace-a', CONTENT_A, 'old-head'),
      nowMs: 10,
    });
    db.prepare(
      `UPDATE workspace_sync_queue
       SET status = 'canceled',
           error_code = 'SYNC_DISABLED',
           error_message = 'Auto sync was turned off before this upload ran.',
           updated_at = 20
       WHERE id = ?`
    ).run(oldJob.id);
    expect(uploadSnapshotCount(db, oldJob.id)).toBe(1);

    await expect(makeWorker().flushWorkspace('workspace-a')).resolves.toMatchObject({
      status: 'uploaded',
    });

    expect(uploadSnapshotCount(db, oldJob.id)).toBe(0);
    expect(queueRow(db, oldJob.id)).toMatchObject({
      status: 'canceled',
      error_code: 'SUPERSEDED_BY_UPLOAD_SUCCESS',
    });
  });

  it('rolls back upload acknowledgement when the binding changes in flight', async () => {
    createVersion.mockImplementationOnce(async () => {
      db.prepare(`UPDATE workspace_sync_bindings SET enabled = 0 WHERE workspace_id = 1`).run();
      return readyVersion('remote-version-a', 2, CONTENT_A);
    });
    const worker = makeWorker();

    await expect(worker.flushWorkspace('workspace-a')).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'SYNC_CONFLICT',
    });
    expect(bindingState(db)).toMatchObject({
      enabled: 0,
      remote_latest_version_id: 'remote-base-a',
    });
    expect(versionCount(db)).toBe(0);
  });

  it('does not acknowledge a response after another worker reclaims its upload lease', async () => {
    let releaseUpload: (() => void) | undefined;
    createVersion.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseUpload = () => resolve(readyVersion('remote-version-a', 2, CONTENT_A));
        })
    );
    const worker = makeWorker();
    const upload = worker.flushWorkspace('workspace-a');
    await vi.waitFor(() => expect(createVersion).toHaveBeenCalledOnce());

    db.prepare(
      `UPDATE workspace_sync_queue
       SET status = 'retry_wait',
           next_attempt_at = 500,
           locked_at = NULL,
           locked_by_device_id = NULL,
           error_code = 'STALE_LOCK_RECLAIMED',
           error_message = 'reclaimed',
           updated_at = 200
       WHERE id = 'queue-a'`
    ).run();
    invokeDeferred(releaseUpload);

    await expect(upload).resolves.toMatchObject({
      status: 'retry_wait',
      errorCode: 'STALE_LOCK_RECLAIMED',
    });
    expect(bindingState(db)).toMatchObject({
      remote_latest_version_id: 'remote-base-a',
      last_acked_local_head_sha: null,
    });
    expect(versionCount(db)).toBe(0);
    expect(uploadSnapshotCount(db, 'queue-a')).toBe(1);
  });

  function makeWorker(): WorkspaceSyncUploadWorker {
    return new WorkspaceSyncUploadWorker(db, baseDeps());
  }

  function baseDeps(): WorkspaceSyncUploadWorkerDeps {
    const deps: WorkspaceSyncUploadWorkerDeps = {
      deviceId: 'device-a',
      appVersion: '0.4.0',
      getActiveAccountId: () => 'account-a',
      getCurrentLocalHeadSha: () => 'head-a',
      snapshotWorkspace,
      client: { createVersion, readStoragePolicy: async () => TEST_STORAGE_POLICY },
      nowMs: () => nowMs,
      debounceMs: 1000,
      retryBaseDelayMs: 5000,
      retryMaxDelayMs: 60_000,
      maxAttempts: 3,
      createJobId: () => nextJobId,
      setDebounceTimer: (callback, ms) => {
        const timer = { callback, ms, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearDebounceTimer: (timer) => {
        (timer as { cleared: boolean }).cleared = true;
      },
    };
    return deps;
  }
});

function seedSyncWorkspace(
  db: Database.Database,
  input: {
    workspaceId: number;
    workspaceUuid: string;
    accountId: string;
    remoteWorkspaceId: string;
    remoteLatestVersionId: string | null;
    remoteLatestVersionNumber: number | null;
    remoteLatestContentSha256: string | null;
  }
): void {
  db.prepare(
    `INSERT OR IGNORE INTO workspace_sync_device (id, device_id, created_at, updated_at)
     VALUES (1, 'device-a', 1, 1)`
  ).run();
  db.prepare(
    `INSERT INTO workspaces (id, name, path, repo_uuid, created_at, last_opened_at)
     VALUES (?, ?, ?, ?, 1, 1)`
  ).run(
    input.workspaceId,
    'Project A',
    `/managed/${input.workspaceUuid}/repo`,
    input.workspaceUuid
  );
  db.prepare(
    `INSERT INTO workspace_sync_bindings (
      workspace_id, workspace_uuid, owner_account_id, remote_workspace_id,
      enabled, remote_latest_version_id, remote_latest_version_number,
      remote_latest_content_sha256, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, 1, 1)`
  ).run(
    input.workspaceId,
    input.workspaceUuid,
    input.accountId,
    input.remoteWorkspaceId,
    input.remoteLatestVersionId,
    input.remoteLatestVersionNumber,
    input.remoteLatestContentSha256
  );
}

function snapshot(workspaceUuid: string, contentSha256: string, localHeadSha: string) {
  const bundle = bundleFor(workspaceUuid);
  const actualContentSha256 = bundle.provenance.contentSha256;
  if (workspaceUuid === 'workspace-a') expect(actualContentSha256).toBe(contentSha256);
  const fileBytes = bundle.files.reduce((total, file) => total + file.sizeBytes, 0);
  return {
    workspaceId: 1,
    workspaceUuid,
    repoPath: `/managed/${workspaceUuid}/repo`,
    bundle,
    contentSha256: actualContentSha256,
    bundleSizeBytes: Buffer.byteLength(JSON.stringify(bundle), 'utf8'),
    includedFileCount: bundle.files.length,
    includedBytes: fileBytes,
    excludedSummary: bundle.excludedSummary,
    statusExcludedSummary: {
      unsupportedCount: 0,
      privateRawDataCount: 0,
      referencePointerCount: 0,
      fileTooLargeCount: 0,
      bundleTooLargeCount: 0,
    },
    localHeadSha,
  };
}

function readyVersion(remoteVersionId: string, versionNumber: number, contentSha256: string) {
  const metadata = BUNDLE_METADATA.get(contentSha256) ?? BUNDLE_METADATA.get(CONTENT_A);
  if (!metadata) throw new Error('Missing default test bundle metadata.');
  return {
    status: 'ready' as const,
    workspaceId: 'remote-workspace-a',
    version: {
      id: remoteVersionId,
      versionNumber,
      contentSha256,
      sizeBytes: metadata.sizeBytes,
      fileCount: metadata.fileCount,
      createdAt: '2026-07-08T00:00:00.000Z',
    },
  };
}

function bundleFor(workspaceUuid: string): WorkspaceSyncBundleV1 {
  const content = 'LOCUS       TEST                       1 bp    DNA\nORIGIN\n        1 a\n//\n';
  const excludedSummary = {
    unsupported: { count: 0, bytesApprox: 0 },
    'private-raw-data': { count: 0, bytesApprox: 0 },
    'reference-pointer': { count: 0, bytesApprox: 0 },
    'file-too-large': { count: 0, bytesApprox: 0 },
    'bundle-too-large': { count: 0, bytesApprox: 0 },
  };
  const bundle: WorkspaceSyncBundleV1 = {
    schemaVersion: 1,
    capturedAt: '2026-07-08T00:00:00.000Z',
    workspace: { id: workspaceUuid, name: workspaceUuid },
    files: [
      {
        id: 'file-test',
        relativePath: 'design.gb',
        name: 'design.gb',
        kind: 'genbank',
        contentType: 'text/plain',
        sizeBytes: Buffer.byteLength(content, 'utf8'),
        sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
        content,
      },
    ],
    excludedSummary,
    limits: resolveWorkspaceSyncBundleLimits(),
    provenance: {
      source: 'dnaforge-desktop',
      appVersion: '1.0.0',
      contentSha256: '0'.repeat(64),
    },
  };
  bundle.provenance.contentSha256 = createHash('sha256')
    .update(workspaceSyncBundleHashInput(bundle), 'utf8')
    .digest('hex');
  BUNDLE_METADATA.set(bundle.provenance.contentSha256, {
    sizeBytes: Buffer.byteLength(JSON.stringify(bundle), 'utf8'),
    fileCount: bundle.files.length,
  });
  return bundle;
}

function recoveryResponse(body: unknown) {
  const createdAtMs = Date.now();
  const request = {
    ...(body as WorkspaceSyncRecoveryCandidateRequest),
    remoteWorkspaceId: REMOTE_WORKSPACE_ID,
    ownerAccountId: 'account-a',
  };
  const expected = workspaceSyncRecoveryCandidateRequest(request);
  return {
    status: 'retained',
    workspaceId: REMOTE_WORKSPACE_ID,
    candidate: {
      id: '33333333-3333-4333-8333-333333333333',
      accountId: 'account-a',
      baseVersionId: request.baseVersionId,
      contentSha256: expected.contentSha256,
      requestSha256: expected.requestSha256,
      reason: request.reason,
      coverage: expected.coverage,
      createdAt: new Date(createdAtMs).toISOString(),
      expiresAt: new Date(createdAtMs + WORKSPACE_SYNC_RECOVERY_RETENTION_MS).toISOString(),
    },
  };
}

function manifestCapture(sourcePath: string, content: string): WorkspaceSyncUploadCapture {
  const manifest: WorkspaceSyncManifestV1 = {
    schemaVersion: 1,
    files: [
      {
        path: 'design.gb',
        contentSha256: createHash('sha256').update(content, 'utf8').digest('hex'),
        sizeBytes: Buffer.byteLength(content, 'utf8'),
        contentType: 'text/plain',
      },
    ],
  };
  const excludedSummary = {
    unsupported: { count: 0, bytesApprox: 0 },
    'private-raw-data': { count: 0, bytesApprox: 0 },
    'reference-pointer': { count: 0, bytesApprox: 0 },
    'file-too-large': { count: 0, bytesApprox: 0 },
    'bundle-too-large': { count: 0, bytesApprox: 0 },
  };
  return {
    workspaceId: 1,
    workspaceUuid: 'workspace-a',
    repoPath: '/managed/workspace-a/repo',
    manifest,
    fileSources: new Map([['design.gb', sourcePath]]),
    contentSha256: createHash('sha256')
      .update(workspaceSyncManifestHashInput(manifest), 'utf8')
      .digest('hex'),
    bundleSizeBytes: Buffer.byteLength(JSON.stringify(manifest), 'utf8'),
    includedFileCount: 1,
    includedBytes: Buffer.byteLength(content, 'utf8'),
    excludedSummary,
    statusExcludedSummary: {
      unsupportedCount: 0,
      privateRawDataCount: 0,
      referencePointerCount: 0,
      fileTooLargeCount: 0,
      bundleTooLargeCount: 0,
    },
  };
}

function queueStatus(db: Database.Database, id: string): string {
  const status = queueRow(db, id).status;
  if (typeof status !== 'string') throw new Error(`Expected queue status for ${id}.`);
  return status;
}

function invokeDeferred(release: (() => void) | null | undefined): void {
  if (!release) throw new Error('Expected deferred operation to be releasable.');
  release();
}

function uploadSnapshotCount(db: Database.Database, jobId: string): number {
  return (
    db
      .prepare(`SELECT COUNT(*) AS count FROM workspace_sync_upload_snapshots WHERE job_id = ?`)
      .get(jobId) as { count: number }
  ).count;
}

function queueRow(db: Database.Database, id: string): Record<string, unknown> {
  return db.prepare(`SELECT * FROM workspace_sync_queue WHERE id = ?`).get(id) as Record<
    string,
    unknown
  >;
}

function queueCount(db: Database.Database): number {
  return (
    db.prepare(`SELECT COUNT(*) AS count FROM workspace_sync_queue`).get() as { count: number }
  ).count;
}

function bindingState(db: Database.Database): Record<string, unknown> {
  return db.prepare(`SELECT * FROM workspace_sync_bindings WHERE workspace_id = 1`).get() as Record<
    string,
    unknown
  >;
}

function latestVersion(db: Database.Database): Record<string, unknown> {
  return db.prepare(`SELECT * FROM workspace_sync_versions WHERE is_latest = 1`).get() as Record<
    string,
    unknown
  >;
}

function versionCount(db: Database.Database): number {
  return (
    db.prepare(`SELECT COUNT(*) AS count FROM workspace_sync_versions`).get() as { count: number }
  ).count;
}
