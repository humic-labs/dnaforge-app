import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { workspaceSyncManifestHashInput } from '@waypoint/share-bundle';

const { parseLatestInWorker } = vi.hoisted(() => ({
  parseLatestInWorker: vi.fn(),
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

vi.mock('@sentry/electron/main', () => ({ captureMessage: vi.fn() }));
vi.mock('../auth/auth-config', () => ({
  getWebBaseUrl: vi.fn(() => 'https://web.test'),
  getAuthChannel: vi.fn(() => 'dev'),
  getRedirectScheme: vi.fn(() => 'dnaforge-dev'),
}));
vi.mock('../workspace-sync-latest-worker-client', () => ({
  parseAndValidateDesktopSyncLatestInDedicatedWorker: parseLatestInWorker,
}));

import {
  DesktopSyncClientError,
  MAX_DESKTOP_SYNC_LATEST_RESPONSE_BYTES,
  type DesktopSyncClient,
  type DesktopSyncRequestOptions,
} from '../desktop-sync-client';
import { createWorkspaceSyncProjectsClient } from '../workspace-sync-projects';

const REMOTE_WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const REMOTE_VERSION_ID = '22222222-2222-4222-8222-222222222222';

async function unexpectedRequestStream(): Promise<Response> {
  throw new Error('requestStream is not expected in this test.');
}

function desktopSyncClientReturning(response: unknown): DesktopSyncClient {
  return {
    requestJson: async <T>() => response as T,
    requestStream: unexpectedRequestStream,
  };
}

describe('workspace sync projects client', () => {
  it('joins bounded project pages while fencing every request to the starting account', async () => {
    const accountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
    const nextId = '33333333-3333-4333-8333-333333333333';
    const requestJson = vi
      .fn()
      .mockResolvedValueOnce({
        format: 'paged-v1',
        workspaces: [validWorkspaceSummary()],
        hasMore: true,
        nextCursor: REMOTE_WORKSPACE_ID,
      })
      .mockResolvedValueOnce({
        format: 'paged-v1',
        workspaces: [
          { ...validWorkspaceSummary(), workspaceId: nextId, clientWorkspaceId: 'second-project' },
        ],
        hasMore: false,
        nextCursor: null,
      });
    const assertAccount = vi.fn();
    const client = createWorkspaceSyncProjectsClient({
      requestJson,
      requestStream: unexpectedRequestStream,
      getAccountId: async () => accountId,
      assertAccount,
    });
    const rows = await client.listWorkspaces();
    expect(rows.map((row) => row.workspaceId)).toEqual([REMOTE_WORKSPACE_ID, nextId]);
    expect(requestJson).toHaveBeenCalledTimes(2);
    for (const [, options] of requestJson.mock.calls)
      expect(options).toMatchObject({
        expectedAccountId: accountId,
        maxResponseBytes: 2 * 1024 * 1024,
      });
    expect(requestJson.mock.calls[1][0]).toContain(`after=${REMOTE_WORKSPACE_ID}`);
    expect(assertAccount).toHaveBeenCalledWith(accountId);
  });

  it('rejects a repeated project-page cursor instead of looping or publishing an incomplete list', async () => {
    const requestJson = vi
      .fn()
      .mockResolvedValueOnce({
        format: 'paged-v1',
        workspaces: [validWorkspaceSummary()],
        hasMore: true,
        nextCursor: REMOTE_WORKSPACE_ID,
      })
      .mockResolvedValueOnce({
        format: 'paged-v1',
        workspaces: [validWorkspaceSummary()],
        hasMore: true,
        nextCursor: REMOTE_WORKSPACE_ID,
      });
    const client = createWorkspaceSyncProjectsClient({
      requestJson,
      requestStream: unexpectedRequestStream,
    });
    await expect(client.listWorkspaces()).rejects.toBeInstanceOf(DesktopSyncClientError);
  });

  it('refuses a legacy list at the provider row ceiling because completeness cannot be known', async () => {
    const workspaces = Array.from({ length: 1000 }, (_, i) => ({
      ...validWorkspaceSummary(),
      workspaceId: `11111111-1111-4111-8111-${(i + 1).toString(16).padStart(12, '0')}`,
    }));
    const client = createWorkspaceSyncProjectsClient(desktopSyncClientReturning({ workspaces }));
    await expect(client.listWorkspaces()).rejects.toBeInstanceOf(DesktopSyncClientError);
  });

  it.each(['valid', 'foreign workspace', 'foreign version'])(
    'recovers manifest file ownership without downloading historical blobs (%s)',
    async (identity) => {
      const manifest = {
        schemaVersion: 1 as const,
        files: [
          {
            path: 'Lab notes/assets/large.bin',
            contentSha256: 'b'.repeat(64),
            sizeBytes: 12 * 1024 ** 3,
            contentType: 'application/octet-stream',
          },
        ],
      };
      const digest = createHash('sha256')
        .update(workspaceSyncManifestHashInput(manifest), 'utf8')
        .digest('hex');
      const requestJson = vi
        .fn()
        .mockRejectedValueOnce(
          new DesktopSyncClientError('MANIFEST_RESTORE_REQUIRED', 'Manifest version', {
            retryable: false,
            terminal: false,
          })
        )
        .mockResolvedValueOnce({
          workspaceId:
            identity === 'foreign workspace'
              ? '33333333-3333-4333-8333-333333333333'
              : REMOTE_WORKSPACE_ID,
          version: {
            id:
              identity === 'foreign version'
                ? '44444444-4444-4444-8444-444444444444'
                : REMOTE_VERSION_ID,
            versionNumber: 2,
            representation: 'manifest_v1',
            manifestSchemaVersion: 1,
            contentSha256: digest,
            sizeBytes: manifest.files[0].sizeBytes,
            fileCount: 1,
            createdAt: '2026-09-18T00:00:00.000Z',
            finalizedAt: '2026-09-18T00:00:01.000Z',
          },
          manifest,
          resourceIdentities: [
            { path: manifest.files[0].path, resourceId: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1' },
          ],
        });
      const requestStream = vi.fn(unexpectedRequestStream);
      const client = createWorkspaceSyncProjectsClient({
        requestJson,
        requestStream,
        getAccountId: async () => 'account-a',
      } as DesktopSyncClient);
      const operation = client.readVersionPaths!(REMOTE_WORKSPACE_ID, REMOTE_VERSION_ID);
      if (identity === 'valid') await expect(operation).resolves.toEqual([manifest.files[0].path]);
      else await expect(operation).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
      expect(requestStream).not.toHaveBeenCalled();
      expect(requestJson).toHaveBeenNthCalledWith(
        2,
        `/api/desktop-sync/workspaces/${REMOTE_WORKSPACE_ID}/versions/${REMOTE_VERSION_ID}/manifest`,
        expect.objectContaining({ expectedAccountId: 'account-a' })
      );
    }
  );

  it('does not fall back to another ownership representation after access is denied', async () => {
    const denied = new DesktopSyncClientError('FORBIDDEN', 'Access removed', {
      retryable: false,
      terminal: true,
    });
    const requestJson = vi.fn().mockRejectedValue(denied);
    const client = createWorkspaceSyncProjectsClient({
      requestJson,
      requestStream: unexpectedRequestStream,
    } as DesktopSyncClient);
    await expect(client.readVersionPaths!(REMOTE_WORKSPACE_ID, REMOTE_VERSION_ID)).rejects.toBe(
      denied
    );
    expect(requestJson).toHaveBeenCalledTimes(1);
  });

  it.each(['FORBIDDEN', 'ACCOUNT_CHANGED'] as const)(
    'does not fetch restore metadata after %s',
    async (code) => {
      const rejected = new DesktopSyncClientError(
        code,
        'Restore account cannot access this project.',
        {
          retryable: false,
          terminal: true,
        }
      );
      const requestJson = vi.fn().mockRejectedValue(rejected);
      const requestStream = vi.fn(unexpectedRequestStream);
      const client = createWorkspaceSyncProjectsClient({
        requestJson,
        requestStream,
        getAccountId: async () => 'account-a',
      } as DesktopSyncClient);
      await expect(client.downloadLatestForRestore!(REMOTE_WORKSPACE_ID)).rejects.toBe(rejected);
      expect(requestJson).toHaveBeenCalledTimes(1);
      expect(requestJson).toHaveBeenCalledWith(
        `/api/desktop-sync/workspaces/${REMOTE_WORKSPACE_ID}/latest`,
        expect.objectContaining({ expectedAccountId: 'account-a' })
      );
      expect(requestStream).not.toHaveBeenCalled();
    }
  );

  it('keeps the desktop reader broad enough for historical inline V1 versions', () => {
    expect(MAX_DESKTOP_SYNC_LATEST_RESPONSE_BYTES).toBe(16 * 1024 * 1024);
  });

  it('accepts a complete workspace list and preserves an empty list', async () => {
    const requestJson = vi
      .fn()
      .mockResolvedValueOnce({ workspaces: [validWorkspaceSummary()] })
      .mockResolvedValueOnce({ workspaces: [] });
    const client = createWorkspaceSyncProjectsClient({
      requestJson,
      requestStream: unexpectedRequestStream,
    } as DesktopSyncClient);

    await expect(client.listWorkspaces()).resolves.toEqual([validWorkspaceSummary()]);
    await expect(client.listWorkspaces()).resolves.toEqual([]);
  });

  it.each([
    { label: 'missing workspaces', response: {} },
    { label: 'wrong collection type', response: { workspaces: {} } },
    {
      label: 'near-miss item with a negative version number',
      response: {
        workspaces: [
          {
            ...validWorkspaceSummary(),
            latest: { ...validWorkspaceSummary().latest, versionNumber: -1 },
          },
        ],
      },
    },
    {
      label: 'workspace with a non-UUID remote id',
      response: {
        workspaces: [{ ...validWorkspaceSummary(), workspaceId: 'not-a-uuid' }],
      },
    },
    {
      label: 'workspace with a non-UUID latest version id',
      response: {
        workspaces: [
          {
            ...validWorkspaceSummary(),
            latest: { ...validWorkspaceSummary().latest, versionId: 'not-a-uuid' },
          },
        ],
      },
    },
    {
      label: 'personal workspace with an empty account id',
      response: {
        workspaces: [
          {
            ...validWorkspaceSummary(),
            owner: { kind: 'personal', accountId: '   ' },
          },
        ],
      },
    },
    {
      label: 'organization workspace with an empty organization id',
      response: {
        workspaces: [
          {
            ...validWorkspaceSummary(),
            owner: { kind: 'org', orgId: '' },
          },
        ],
      },
    },
    {
      label: 'workspace with an empty required identity string',
      response: {
        workspaces: [{ ...validWorkspaceSummary(), deviceId: ' ' }],
      },
    },
  ])('rejects $label instead of treating it as no cloud projects', async ({ response }) => {
    const client = createWorkspaceSyncProjectsClient(desktopSyncClientReturning(response));

    await expect(client.listWorkspaces()).rejects.toMatchObject({
      code: 'BAD_RESPONSE',
      retryable: true,
      terminal: false,
    });
  });

  it('bounds and delegates latest-bundle parsing to the dedicated worker path', async () => {
    let options: DesktopSyncRequestOptions | undefined;
    const latest = {
      workspaceId: REMOTE_WORKSPACE_ID,
      version: {
        id: REMOTE_VERSION_ID,
        versionNumber: 1,
        contentSha256: 'a'.repeat(64),
        sizeBytes: 0,
        fileCount: 0,
        createdAt: '2026-08-24T00:00:00.000Z',
      },
      bundle: {},
    };
    const requestJson = vi.fn(async (_path: string, requestOptions: DesktopSyncRequestOptions) => {
      options = requestOptions;
      return latest;
    });
    const client = createWorkspaceSyncProjectsClient({
      requestJson,
      requestStream: unexpectedRequestStream,
    } as DesktopSyncClient);

    await expect(client.downloadLatest('remote-workspace-a')).resolves.toBe(latest);
    expect(options).toMatchObject({
      method: 'GET',
      maxResponseBytes: MAX_DESKTOP_SYNC_LATEST_RESPONSE_BYTES,
      parseResponse: expect.any(Function),
    });
  });

  it('forwards runtime cancellation to both replica requests', async () => {
    const requestJson = vi
      .fn()
      .mockResolvedValueOnce({ workspaces: [] })
      .mockResolvedValueOnce({
        workspaceId: REMOTE_WORKSPACE_ID,
        version: {
          id: REMOTE_VERSION_ID,
          versionNumber: 1,
          contentSha256: 'a'.repeat(64),
          sizeBytes: 0,
          fileCount: 0,
          createdAt: '2026-08-24T00:00:00.000Z',
        },
        bundle: {},
      });
    const client = createWorkspaceSyncProjectsClient({
      requestJson,
      requestStream: unexpectedRequestStream,
    } as DesktopSyncClient);
    const controller = new AbortController();

    await client.listWorkspaces(controller.signal);
    await client.downloadLatest(REMOTE_WORKSPACE_ID, controller.signal);

    expect(requestJson.mock.calls[0][1]).toMatchObject({ signal: controller.signal });
    expect(requestJson.mock.calls[1][1]).toMatchObject({ signal: controller.signal });
  });

  it('forwards runtime cancellation into dedicated latest parsing', async () => {
    let options: DesktopSyncRequestOptions | undefined;
    const latest = {
      workspaceId: REMOTE_WORKSPACE_ID,
      version: {
        id: REMOTE_VERSION_ID,
        versionNumber: 1,
        contentSha256: 'a'.repeat(64),
        sizeBytes: 0,
        fileCount: 0,
        createdAt: '2026-08-24T00:00:00.000Z',
      },
      bundle: {},
    };
    const requestJson = vi.fn(async (_path: string, requestOptions: DesktopSyncRequestOptions) => {
      options = requestOptions;
      return latest;
    });
    const client = createWorkspaceSyncProjectsClient({
      requestJson,
      requestStream: unexpectedRequestStream,
    } as DesktopSyncClient);
    const controller = new AbortController();
    const bytes = new Uint8Array([1, 2, 3]);
    parseLatestInWorker.mockResolvedValueOnce(latest);

    await client.downloadLatest(REMOTE_WORKSPACE_ID, controller.signal);
    await options?.parseResponse?.(bytes);

    expect(parseLatestInWorker).toHaveBeenLastCalledWith(bytes, { signal: controller.signal });
  });

  it('parses an authorized manifest version and streams each file through the long-lived download path', async () => {
    const manifest = {
      schemaVersion: 1 as const,
      files: [
        {
          path: 'sequences/sample.gbk',
          contentSha256: 'b'.repeat(64),
          sizeBytes: 12,
          contentType: 'application/genbank',
        },
      ],
    };
    const digest = createHash('sha256')
      .update(workspaceSyncManifestHashInput(manifest), 'utf8')
      .digest('hex');
    const requestJson = vi.fn(async () => ({
      workspaceId: REMOTE_WORKSPACE_ID,
      version: {
        id: REMOTE_VERSION_ID,
        versionNumber: 2,
        representation: 'manifest_v1',
        manifestSchemaVersion: 1,
        contentSha256: digest,
        sizeBytes: 12,
        fileCount: 1,
        createdAt: '2026-09-18T00:00:00.000Z',
        finalizedAt: '2026-09-18T00:00:01.000Z',
      },
      manifest,
      resourceIdentities: [
        { path: 'sequences/sample.gbk', resourceId: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1' },
      ],
    }));
    const fileResponse = new Response('genbank-body');
    const requestStream = vi.fn(async () => fileResponse);
    const client = createWorkspaceSyncProjectsClient({
      requestJson,
      requestStream,
    } as DesktopSyncClient);

    await expect(
      client.downloadManifestVersion?.(REMOTE_WORKSPACE_ID, REMOTE_VERSION_ID)
    ).resolves.toMatchObject({
      workspaceId: REMOTE_WORKSPACE_ID,
      version: { id: REMOTE_VERSION_ID, representation: 'manifest_v1', contentSha256: digest },
      resourceIdentities: [
        { path: 'sequences/sample.gbk', resourceId: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1' },
      ],
    });
    await expect(
      client.downloadManifestFile?.(REMOTE_WORKSPACE_ID, REMOTE_VERSION_ID, manifest.files[0])
    ).resolves.toBe(fileResponse);
    expect(requestJson).toHaveBeenCalledWith(
      `/api/desktop-sync/workspaces/${REMOTE_WORKSPACE_ID}/versions/${REMOTE_VERSION_ID}/manifest`,
      expect.objectContaining({ method: 'GET' })
    );
    expect(requestStream).toHaveBeenCalledWith(
      `/api/desktop-sync/workspaces/${REMOTE_WORKSPACE_ID}/versions/${REMOTE_VERSION_ID}/files?path=sequences%2Fsample.gbk`,
      expect.objectContaining({ method: 'GET', timeoutMs: 10 * 60 * 1000 })
    );
  });

  it('rejects a manifest whose resource identities do not cover every file', async () => {
    const manifest = {
      schemaVersion: 1 as const,
      files: [
        {
          path: 'sequences/sample.gbk',
          contentSha256: 'b'.repeat(64),
          sizeBytes: 12,
          contentType: 'application/genbank',
        },
      ],
    };
    const client = createWorkspaceSyncProjectsClient(
      desktopSyncClientReturning({
        workspaceId: REMOTE_WORKSPACE_ID,
        version: {
          id: REMOTE_VERSION_ID,
          versionNumber: 2,
          representation: 'manifest_v1',
          manifestSchemaVersion: 1,
          contentSha256: createHash('sha256')
            .update(workspaceSyncManifestHashInput(manifest), 'utf8')
            .digest('hex'),
          sizeBytes: 12,
          fileCount: 1,
          createdAt: '2026-09-18T00:00:00.000Z',
          finalizedAt: '2026-09-18T00:00:01.000Z',
        },
        manifest,
        resourceIdentities: [],
      })
    );

    await expect(
      client.downloadManifestVersion?.(REMOTE_WORKSPACE_ID, REMOTE_VERSION_ID)
    ).rejects.toMatchObject({
      code: 'BAD_RESPONSE',
      retryable: true,
      terminal: false,
    });
  });
});

function validWorkspaceSummary() {
  return {
    workspaceId: REMOTE_WORKSPACE_ID,
    clientWorkspaceId: 'workspace-a',
    displayName: 'Project A',
    owner: { kind: 'personal' as const, accountId: 'account-a' },
    latest: {
      versionId: REMOTE_VERSION_ID,
      versionNumber: 1,
      contentSha256: 'a'.repeat(64),
    },
    storageBytesUsed: 0,
    versionCount: 1,
    updatedAt: '2026-08-24T00:00:00.000Z',
    lastSeenAt: '2026-08-24T00:00:00.000Z',
    deviceId: 'device-a',
  };
}
