import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopAuthRefreshOutcome } from '../auth/controller';
import type { StoredSession } from '../auth/session-store';

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

import { createTestDb } from './test-db';
import { ensureSchema } from '../schema';
import { readWorkspaceSyncStatus } from '../workspace-sync-status';
import {
  enqueueWorkspaceSyncJob,
  claimNextWorkspaceSyncJob,
  markWorkspaceSyncJobFailed,
} from '../workspace-sync-queue';
import { describeWorkspaceSyncDisplay } from '../../features/auth/workspace-sync-display';
import { createDesktopSyncClient, type DesktopSyncClientDeps } from '../desktop-sync-client';
import {
  BUNDLE_SCHEMA_CAPABILITY_HEADER,
  WORKSPACE_SYNC_BUNDLE_SCHEMA_VERSION,
} from '@waypoint/share-bundle';

describe('desktop sync client', () => {
  let activeSession: StoredSession | null;
  let fetchMock: ReturnType<typeof vi.fn>;
  const performRefresh = vi.fn<() => Promise<DesktopAuthRefreshOutcome>>();

  beforeEach(() => {
    activeSession = session({ accessToken: 'at-old', expiresAt: futureIso() });
    fetchMock = vi.fn();
    performRefresh.mockReset();
    performRefresh.mockImplementation(async () => {
      activeSession = session({ accessToken: 'at-new', expiresAt: futureIso() });
      return { status: 'refreshed' };
    });
  });

  it('refreshes an expired token before the request using the shared auth refresh path', async () => {
    activeSession = session({ accessToken: 'at-expired', expiresAt: pastIso() });
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));

    const client = makeClient();
    await expect(
      client.requestJson('/api/desktop-sync/workspaces', { method: 'GET' })
    ).resolves.toEqual({
      ok: true,
    });

    expect(performRefresh).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://web.test/api/desktop-sync/workspaces',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer at-new',
          [BUNDLE_SCHEMA_CAPABILITY_HEADER]: String(WORKSPACE_SYNC_BUNDLE_SCHEMA_VERSION),
        }),
      })
    );
  });

  it('retries once after a 401 with a freshly refreshed token', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { code: 'TOKEN_EXPIRED', message: 'expired' }))
      .mockResolvedValueOnce(jsonResponse(200, { claimed: true }));

    const client = makeClient();
    await expect(
      client.requestJson('/api/desktop-sync/workspaces', {
        method: 'POST',
        idempotencyKey: 'claim:workspace-a',
        body: { clientWorkspaceId: 'workspace-a' },
      })
    ).resolves.toEqual({ claimed: true });

    expect(performRefresh).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      headers: expect.objectContaining({
        Authorization: 'Bearer at-old',
        'Idempotency-Key': 'claim:workspace-a',
      }),
    });
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      headers: expect.objectContaining({ Authorization: 'Bearer at-new' }),
    });
  });

  it('negotiates multipart without changing the strict reservation JSON contract', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { status: 'upload_required' }));
    const body = {
      contentSha256: 'a'.repeat(64),
      sizeBytes: 17 * 1024 ** 2,
      contentType: 'application/octet-stream',
    };
    await makeClient().requestJson('/api/desktop-sync/workspaces/owned/blobs/reserve', {
      method: 'POST',
      body,
      blobUploadProtocol: 's3-multipart-v1',
    });
    expect(fetchMock.mock.calls[0][1].headers['x-workspace-sync-blob-upload']).toBe(
      's3-multipart-v1'
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(body);
  });

  it('sends Bearer APIs to www when the sealed origin is apex', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
    const client = createDesktopSyncClient({
      fetch: fetchMock as unknown as typeof fetch,
      getActiveStoredSession: async () => activeSession,
      performRefresh,
      nowMs: () => Date.parse('2026-07-08T12:00:00.000Z'),
      baseUrl: 'https://dnaforge.com',
    });

    await expect(
      client.requestJson('/api/desktop-sync/workspaces', { method: 'GET' })
    ).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.dnaforge.com/api/desktop-sync/workspaces',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer at-old' }),
      })
    );
  });

  it('maps a revoked session after refresh to an auth-paused terminal error', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { code: 'REVOKED', message: 'revoked' }));
    performRefresh.mockImplementationOnce(async () => {
      activeSession = null;
      return { status: 'signed_out' };
    });

    const client = makeClient();
    await expect(
      client.requestJson('/api/desktop-sync/workspaces', { method: 'GET' })
    ).rejects.toMatchObject({
      code: 'SESSION_REVOKED',
      authPaused: true,
      retryable: false,
      terminal: true,
    });
  });

  it('keeps a transient refresh failure retryable without resending a rejected token', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { code: 'TOKEN_EXPIRED' }));
    performRefresh.mockResolvedValueOnce({
      status: 'transient',
      code: 'SERVER',
      message: 'refresh service unavailable',
    });

    await expect(
      makeClient().requestJson('/api/desktop-sync/workspaces', { method: 'GET' })
    ).rejects.toMatchObject({
      code: 'SERVER',
      retryable: true,
      terminal: false,
      authPaused: false,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(activeSession?.accessToken).toBe('at-old');
  });

  it('does not resend a rejected bearer when refresh claims success without replacing it', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { code: 'TOKEN_EXPIRED' }));
    performRefresh.mockResolvedValueOnce({ status: 'refreshed' });

    await expect(
      makeClient().requestJson('/api/desktop-sync/workspaces', { method: 'GET' })
    ).rejects.toMatchObject({
      code: 'BAD_RESPONSE',
      retryable: true,
      terminal: false,
      authPaused: false,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('preserves an expired local session when refresh is temporarily offline', async () => {
    activeSession = session({ accessToken: 'at-expired', expiresAt: pastIso() });
    performRefresh.mockResolvedValueOnce({
      status: 'transient',
      code: 'NETWORK',
      message: 'offline',
    });

    await expect(
      makeClient().requestJson('/api/desktop-sync/workspaces', { method: 'GET' })
    ).rejects.toMatchObject({
      code: 'NETWORK',
      retryable: true,
      terminal: false,
      authPaused: false,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(activeSession?.accessToken).toBe('at-expired');
  });

  it('maps desktop-sync API failures to retryable or terminal typed errors', async () => {
    const cases: Array<{
      status: number;
      body: Record<string, unknown>;
      code: string;
      retryable: boolean;
      terminal: boolean;
    }> = [
      {
        status: 409,
        body: {
          code: 'SYNC_CONFLICT',
          message: 'base changed',
          details: { remoteVersionId: 'v2' },
        },
        code: 'CONFLICT',
        retryable: false,
        terminal: true,
      },
      {
        status: 409,
        body: { code: 'IDEMPOTENCY_CONFLICT', message: 'different body' },
        code: 'IDEMPOTENCY_CONFLICT',
        retryable: false,
        terminal: true,
      },
      {
        status: 409,
        body: { code: 'RECOVERY_BLOBS_PENDING', message: 'verified bytes are not ready' },
        code: 'SERVER',
        retryable: true,
        terminal: false,
      },
      {
        status: 410,
        body: { code: 'RECOVERY_CANDIDATE_EXPIRED', message: 'recovery retention ended' },
        code: 'RECOVERY_CANDIDATE_EXPIRED',
        retryable: false,
        terminal: true,
      },
      {
        status: 409,
        body: { code: 'MANIFEST_RESTORE_REQUIRED', message: 'use the manifest API' },
        code: 'MANIFEST_RESTORE_REQUIRED',
        retryable: false,
        terminal: false,
      },
      {
        status: 409,
        body: { code: 'BAD_HASH', message: 'hash mismatch' },
        code: 'VALIDATION',
        retryable: false,
        terminal: true,
      },
      {
        status: 409,
        body: { code: 'UPLOAD_FAILED', message: 'previous upload failed' },
        code: 'VALIDATION',
        retryable: false,
        terminal: true,
      },
      {
        status: 409,
        body: { code: 'LEGACY_LIMS_QUARANTINED', message: 'repair required' },
        code: 'VALIDATION',
        retryable: false,
        terminal: true,
      },
      {
        status: 413,
        body: { code: 'QUOTA_EXCEEDED', message: 'quota' },
        code: 'QUOTA_EXCEEDED',
        retryable: false,
        terminal: true,
      },
      {
        status: 413,
        body: { code: 'BLOB_QUOTA_EXCEEDED', message: 'Workspace blob quota exceeded.' },
        code: 'QUOTA_EXCEEDED',
        retryable: false,
        terminal: true,
      },
      {
        status: 413,
        body: { code: 'PAYLOAD_TOO_LARGE', message: 'body too large' },
        code: 'VALIDATION',
        retryable: false,
        terminal: true,
      },
      {
        status: 413,
        body: { code: 'BUNDLE_TOO_LARGE', message: 'bundle too large' },
        code: 'VALIDATION',
        retryable: false,
        terminal: true,
      },
      {
        status: 426,
        body: { code: 'UPGRADE_REQUIRED', message: 'update DNAForge' },
        code: 'UPGRADE_REQUIRED',
        retryable: false,
        terminal: true,
      },
      {
        status: 429,
        body: { code: 'RATE_LIMITED', message: 'slow down' },
        code: 'RATE_LIMITED',
        retryable: true,
        terminal: false,
      },
      {
        status: 503,
        body: { code: 'FEATURE_DISABLED', message: 'rollout paused' },
        code: 'FEATURE_DISABLED',
        retryable: true,
        terminal: false,
      },
      {
        status: 503,
        body: { code: 'UNAVAILABLE', message: 'try later' },
        code: 'SERVER',
        retryable: true,
        terminal: false,
      },
    ];

    for (const item of cases) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValue(jsonResponse(item.status, item.body));
      const client = makeClient();

      await expect(
        client.requestJson('/api/desktop-sync/workspaces', { method: 'GET' })
      ).rejects.toMatchObject({
        code: item.code,
        retryable: item.retryable,
        terminal: item.terminal,
      });
    }
  });

  it('retries only an explicitly renewable multipart lease expiry', async () => {
    const path = '/api/desktop-sync/workspaces/owned/blobs/multipart';
    const client = makeClient();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(409, { code: 'MULTIPART_LEASE_EXPIRED' }))
      .mockResolvedValueOnce(jsonResponse(409, { code: 'CONFLICT' }));
    const options = { method: 'POST' as const, body: { action: 'sign-part' } };

    await expect(client.requestJson(path, options)).rejects.toMatchObject({
      code: 'MULTIPART_LEASE_EXPIRED',
      retryable: true,
      terminal: false,
    });
    await expect(client.requestJson(path, options)).rejects.toMatchObject({
      code: 'CONFLICT',
      retryable: false,
      terminal: true,
    });
  });

  it('recovers on the same client after a feature-flag suspension without revoking auth', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(503, { code: 'FEATURE_DISABLED', message: 'rollout paused' })
      )
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const client = makeClient();

    await expect(
      client.requestJson('/api/desktop-sync/workspaces', { method: 'GET' })
    ).rejects.toMatchObject({
      code: 'FEATURE_DISABLED',
      retryable: true,
      terminal: false,
      authPaused: false,
    });
    await expect(
      client.requestJson('/api/desktop-sync/workspaces', { method: 'GET' })
    ).resolves.toEqual({ ok: true });
    expect(performRefresh).not.toHaveBeenCalled();
    expect(activeSession?.accessToken).toBe('at-old');
  });

  it('maps network failures as retryable and preserves structured error details', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('network down'));
    const client = makeClient();

    await expect(
      client.requestJson('/api/desktop-sync/workspaces', { method: 'GET' })
    ).rejects.toMatchObject({
      code: 'NETWORK',
      retryable: true,
      terminal: false,
    });

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, {
        code: 'BAD_REQUEST',
        message: 'invalid bundle',
        details: { field: 'bundle' },
      })
    );
    await expect(
      client.requestJson('/api/desktop-sync/workspaces', { method: 'GET' })
    ).rejects.toMatchObject({
      code: 'VALIDATION',
      details: { field: 'bundle' },
    });
  });

  it('keeps pending exact-package admission retryable and never reports it as a conflict or acceptance', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 'SEQUENCE_PACKAGE_ADMISSION_PENDING',
          message: 'Package inspection is pending.',
        }),
        { status: 503, headers: { 'content-type': 'application/json', 'retry-after': '2' } }
      )
    );
    await expect(
      makeClient().requestJson('/api/desktop-sync/workspaces/project/versions/manifest', {
        method: 'POST',
        idempotencyKey: 'same-immutable-request',
        body: { manifest: { files: [] } },
      })
    ).rejects.toMatchObject({ code: 'IN_PROGRESS', status: 503, retryable: true, terminal: false });
  });

  it.each([
    { code: 'SEQUENCE_PACKAGE_ADMISSION_PENDING', axis: 'queued', label: 'Syncing' },
    {
      code: 'INTERNAL_ERROR',
      axis: 'offline_retry',
      label: 'Offline — changes saved on this computer',
    },
  ])(
    'renders durable $code retries truthfully without claiming acceptance',
    async ({ code, axis, label }) => {
      const db = createTestDb();
      try {
        ensureSchema(db, ':memory:');
        db.prepare(
          `INSERT INTO workspace_sync_device (id, device_id, created_at, updated_at) VALUES (1, 'device-a', 1, 1)`
        ).run();
        db.prepare(
          `INSERT INTO workspaces (id, name, path, repo_uuid, created_at, last_opened_at)
        VALUES (1, 'Project', '/managed/workspace-a/repo', 'workspace-a', 1, 1)`
        ).run();
        db.prepare(
          `INSERT INTO workspace_sync_bindings (
        workspace_id, workspace_uuid, owner_account_id, remote_workspace_id,
        enabled, last_acked_local_head_sha, created_at, updated_at
      ) VALUES (1, 'workspace-a', 'account-a', 'remote-a', 1, 'head-a', 1, 1)`
        ).run();
        db.prepare(
          `UPDATE workspace_sync_bindings SET access_role = 'editor', access_source = 'direct', shared_with_others = 1 WHERE workspace_id = 1`
        ).run();
        enqueueWorkspaceSyncJob(db, {
          id: 'upload-a',
          workspaceId: 1,
          operation: 'upload',
          localHeadSha: 'head-b',
          nowMs: 100,
        });
        expect(
          claimNextWorkspaceSyncJob(db, {
            activeAccountId: 'account-a',
            deviceId: 'device-a',
            nowMs: 100,
          })?.id
        ).toBe('upload-a');
        fetchMock.mockResolvedValueOnce(
          jsonResponse(503, { code, message: 'Pending server work.' })
        );
        const error = await makeClient()
          .requestJson('/api/desktop-sync/workspaces/project/versions/manifest', {
            method: 'POST',
            body: {},
          })
          .then(
            () => {
              throw new Error('An unaccepted revision must not succeed.');
            },
            (failure: unknown) => failure
          );
        expect(error).toBeInstanceOf(Error);
        if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'string')
          throw new Error('Expected typed sync failure.');
        const job = markWorkspaceSyncJobFailed(db, {
          id: 'upload-a',
          expectedStatus: 'running',
          nowMs: 100,
          retryable: true,
          retryDelayMs: 2000,
          maxAttempts: 3,
          errorCode: error.code,
          errorMessage: error.message,
        });
        expect(job.status).toBe('retry_wait');
        const status = readWorkspaceSyncStatus(db, {
          workspaceUuid: 'workspace-a',
          getActiveAccountId: () => 'account-a',
          getCurrentLocalHeadSha: () => 'head-b',
          getDirtyByWorkspace: () => ({}),
          getExcludedSummary: () => null,
          isOffline: () => false,
          nowMs: () => 100,
        });
        expect(status).toMatchObject({
          syncAxis: axis,
          canDisplayPlainSynced: false,
          blockers: expect.arrayContaining(['queued_work', 'local_head_mismatch']),
        });
        expect(describeWorkspaceSyncDisplay({ signedIn: true, status }).label).toBe(label);
      } finally {
        db.close();
      }
    }
  );

  it.each(['SEQUENCE_PACKAGE_INVALID', 'SEQUENCE_PACKAGE_ADMISSION_UNSUPPORTED'])(
    'reports %s as terminal validation, not a stale-base conflict',
    async (code) => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(422, { code, message: 'Package cannot be admitted.' })
      );
      await expect(
        makeClient().requestJson('/api/desktop-sync/workspaces/project/versions/manifest', {
          method: 'POST',
          idempotencyKey: 'same-immutable-request',
          body: { manifest: { files: [] } },
        })
      ).rejects.toMatchObject({ code: 'VALIDATION', retryable: false, terminal: true });
    }
  );

  it.each([
    { label: 'empty', body: '' },
    { label: 'malformed', body: '{' },
    { label: 'invalid UTF-8', body: new Uint8Array([0xc3, 0x28]) },
  ])('rejects an $label successful response instead of inventing data', async ({ body }) => {
    fetchMock.mockResolvedValueOnce(new Response(body, { status: 200 }));

    await expect(
      makeClient().requestJson('/api/desktop-sync/workspaces', { method: 'GET' })
    ).rejects.toMatchObject({
      code: 'BAD_RESPONSE',
      retryable: true,
      terminal: false,
    });
  });

  it('bounds advertised and streamed responses while accepting the exact limit', async () => {
    const advertisedCancel = vi.fn();
    fetchMock.mockResolvedValueOnce(
      new Response(new ReadableStream({ cancel: advertisedCancel }), {
        status: 200,
        headers: { 'content-length': '17' },
      })
    );
    await expect(
      makeClient().requestJson('/api/desktop-sync/workspaces', {
        method: 'GET',
        maxResponseBytes: 16,
      })
    ).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
    expect(advertisedCancel).toHaveBeenCalledOnce();

    fetchMock.mockResolvedValueOnce(new Response('"123456789012345"', { status: 200 }));
    await expect(
      makeClient().requestJson('/api/desktop-sync/workspaces', {
        method: 'GET',
        maxResponseBytes: 16,
      })
    ).rejects.toMatchObject({ code: 'BAD_RESPONSE' });

    const edgeBody = '"12345678901234"';
    expect(Buffer.byteLength(edgeBody, 'utf8')).toBe(16);
    fetchMock.mockResolvedValueOnce(new Response(edgeBody, { status: 200 }));
    await expect(
      makeClient().requestJson('/api/desktop-sync/workspaces', {
        method: 'GET',
        maxResponseBytes: 16,
      })
    ).resolves.toBe('12345678901234');
  });

  it('hands bounded bytes to a caller-owned parser and normalizes parser rejection', async () => {
    const parseResponse = vi.fn(async (bytes: Uint8Array) => ({ decoded: bytes.byteLength }));
    fetchMock.mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));

    await expect(
      makeClient().requestJson('/api/desktop-sync/workspaces', {
        method: 'GET',
        maxResponseBytes: 64,
        parseResponse,
      })
    ).resolves.toEqual({ decoded: 11 });
    expect(parseResponse).toHaveBeenCalledOnce();

    fetchMock.mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    await expect(
      makeClient().requestJson('/api/desktop-sync/workspaces', {
        method: 'GET',
        parseResponse: async () => {
          throw new Error('worker rejected the envelope');
        },
      })
    ).rejects.toMatchObject({ code: 'BAD_RESPONSE', message: 'worker rejected the envelope' });
  });

  it('returns an authorized file stream without parsing it as JSON', async () => {
    fetchMock.mockResolvedValueOnce(new Response('genbank-bytes', { status: 200 }));
    const client = makeClient();
    const response = await client.requestStream('/api/desktop-sync/workspaces/w/versions/v/files', {
      method: 'GET',
      timeoutMs: 45_000,
    });
    await expect(response.text()).resolves.toBe('genbank-bytes');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://web.test/api/desktop-sync/workspaces/w/versions/v/files',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('times out a request that never returns', async () => {
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        })
    );

    await expect(
      makeClient({ requestTimeoutMs: 5 }).requestJson('/api/desktop-sync/workspaces', {
        method: 'GET',
      })
    ).rejects.toMatchObject({ code: 'NETWORK', retryable: true, terminal: false });
  });

  it('keeps a response-body network failure retryable after headers and one chunk arrive', async () => {
    let pullCount = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1;
        if (pullCount === 1) {
          controller.enqueue(new TextEncoder().encode('{"partial":'));
          return;
        }
        controller.error(new Error('socket reset during response body'));
      },
    });
    fetchMock.mockResolvedValueOnce(new Response(body, { status: 200 }));

    await expect(
      makeClient().requestJson('/api/desktop-sync/workspaces', { method: 'GET' })
    ).rejects.toMatchObject({
      code: 'NETWORK',
      retryable: true,
      terminal: false,
      message: 'socket reset during response body',
    });
  });

  it('stops a preflight renewal that lands on a different account instead of sending under it', async () => {
    activeSession = session({ accessToken: 'at-expired', expiresAt: pastIso() });
    performRefresh.mockImplementationOnce(async () => {
      activeSession = session({
        accessToken: 'at-b',
        expiresAt: futureIso(),
        accountId: 'account-b',
      });
      return { status: 'refreshed' };
    });

    await expect(
      makeClient().requestJson('/api/desktop-sync/workspaces/claim', {
        method: 'POST',
        body: { clientWorkspaceId: 'workspace-a' },
        expectedAccountId: 'account-a',
      })
    ).rejects.toMatchObject({
      code: 'ACCOUNT_CHANGED',
      retryable: true,
      terminal: false,
      authPaused: true,
      details: { expectedAccountId: 'account-a', activeAccountId: 'account-b' },
    });

    expect(performRefresh).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stops a 401 retry that would resend the body under a different account', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, { code: 'TOKEN_EXPIRED', message: 'expired' })
    );
    performRefresh.mockImplementationOnce(async () => {
      activeSession = session({
        accessToken: 'at-b',
        expiresAt: futureIso(),
        accountId: 'account-b',
      });
      return { status: 'refreshed' };
    });

    await expect(
      makeClient().requestJson('/api/desktop-sync/workspaces/claim', {
        method: 'POST',
        body: { clientWorkspaceId: 'workspace-a' },
        expectedAccountId: 'account-a',
      })
    ).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED', authPaused: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      headers: expect.objectContaining({ Authorization: 'Bearer at-old' }),
    });
  });

  it('refuses to dispatch when the active account already differs from the caller-captured account', async () => {
    activeSession = session({
      accessToken: 'at-b',
      expiresAt: futureIso(),
      accountId: 'account-b',
    });

    await expect(
      makeClient().requestJson('/api/desktop-sync/workspaces/claim', {
        method: 'POST',
        body: { clientWorkspaceId: 'workspace-a' },
        expectedAccountId: 'account-a',
      })
    ).rejects.toMatchObject({
      code: 'ACCOUNT_CHANGED',
      details: { expectedAccountId: 'account-a', activeAccountId: 'account-b' },
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(performRefresh).not.toHaveBeenCalled();
  });

  it('keeps same-account token rotation working when the caller pins its account', async () => {
    activeSession = session({ accessToken: 'at-expired', expiresAt: pastIso() });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { claimed: true }));

    await expect(
      makeClient().requestJson('/api/desktop-sync/workspaces/claim', {
        method: 'POST',
        body: { clientWorkspaceId: 'workspace-a' },
        expectedAccountId: 'account-a',
      })
    ).resolves.toEqual({ claimed: true });

    expect(performRefresh).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      headers: expect.objectContaining({ Authorization: 'Bearer at-new' }),
    });
  });

  it("reports an account change, not a revocation, when renewal ends the request's account and another becomes active", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { code: 'REVOKED', message: 'revoked' }));
    performRefresh.mockImplementationOnce(async () => {
      activeSession = session({
        accessToken: 'at-b',
        expiresAt: futureIso(),
        accountId: 'account-b',
      });
      return { status: 'signed_out' };
    });

    await expect(
      makeClient().requestJson('/api/desktop-sync/workspaces/claim', {
        method: 'POST',
        body: { clientWorkspaceId: 'workspace-a' },
        expectedAccountId: 'account-a',
      })
    ).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED', authPaused: true, retryable: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('pins continuity to the starting account even when the caller passes no expected account', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, { code: 'TOKEN_EXPIRED', message: 'expired' })
    );
    performRefresh.mockImplementationOnce(async () => {
      activeSession = session({
        accessToken: 'at-b',
        expiresAt: futureIso(),
        accountId: 'account-b',
      });
      return { status: 'refreshed' };
    });

    await expect(
      makeClient().requestJson('/api/desktop-sync/workspaces', { method: 'GET' })
    ).rejects.toMatchObject({
      code: 'ACCOUNT_CHANGED',
      details: { expectedAccountId: 'account-a', activeAccountId: 'account-b' },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  function makeClient(overrides: Partial<DesktopSyncClientDeps> = {}) {
    const deps: DesktopSyncClientDeps = {
      baseUrl: 'https://web.test',
      fetch: fetchMock as unknown as typeof fetch,
      getActiveStoredSession: async () => activeSession,
      performRefresh,
      nowMs: () => Date.parse('2026-07-08T12:00:00.000Z'),
      ...overrides,
    };
    return createDesktopSyncClient(deps);
  }
});

function session(input: {
  accessToken: string;
  expiresAt: string;
  accountId?: string;
}): StoredSession {
  return {
    accountId: input.accountId ?? 'account-a',
    desktopSessionId: 'session-a',
    accessToken: input.accessToken,
    accessTokenExpiresAt: input.expiresAt,
    refreshToken: 'refresh-a',
    email: 'a@example.com',
    displayName: 'A',
    channel: 'dev',
    updatedAt: 1,
  };
}

function futureIso(): string {
  return '2026-07-08T12:30:00.000Z';
}

function pastIso(): string {
  return '2026-07-08T11:59:00.000Z';
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
