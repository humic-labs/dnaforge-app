import { describe, expect, it, vi } from 'vitest';

vi.mock('../desktop-sync-client', () => ({ createDesktopSyncClient: vi.fn() }));

import { listWorkspaceSyncHistory } from '../workspace-sync-history';
import type { DesktopSyncClient } from '../desktop-sync-client';

const workspaceId = '20000000-0000-4000-8000-000000000001';
const snapshot = {
  id: '30000000-0000-4000-8000-000000000003',
  versionNumber: 3,
  representation: 'manifest_v1' as const,
  manifestSchemaVersion: 1,
  contentSha256: 'a'.repeat(64),
  sizeBytes: 321,
  fileCount: 3,
  createdAt: '2026-10-05T12:00:00.000Z',
  finalizedAt: '2026-10-05T12:00:01.000Z',
  createdBy: { accountId: workspaceId, email: 'history@example.test', displayName: null },
};

function clientWith(value: unknown) {
  const requestJson = vi.fn(async () => value);
  return { requestJson } as Pick<DesktopSyncClient, 'requestJson'> & {
    requestJson: typeof requestJson;
  };
}

describe('desktop accepted snapshot history', () => {
  it('reads the same paginated server snapshots without constructing a local Git timeline', async () => {
    const response = { workspaceId, versions: [snapshot], nextBeforeVersionNumber: 3 };
    const client = clientWith(response);
    await expect(
      listWorkspaceSyncHistory(workspaceId, { limit: 1, beforeVersionNumber: 4 }, client)
    ).resolves.toEqual(response);
    expect(client.requestJson).toHaveBeenCalledOnce();
    expect(client.requestJson).toHaveBeenCalledWith(
      `/api/desktop-sync/workspaces/${workspaceId}/versions?limit=1&beforeVersionNumber=4`,
      { method: 'GET' }
    );
  });

  it('keeps retained legacy bundle snapshots visible', async () => {
    const legacy = {
      ...snapshot,
      representation: 'bundle_v1',
      manifestSchemaVersion: null,
      createdBy: null,
    };
    const response = { workspaceId, versions: [legacy], nextBeforeVersionNumber: null };
    await expect(listWorkspaceSyncHistory(workspaceId, {}, clientWith(response))).resolves.toEqual(
      response
    );
  });

  it('reads scientific history summaries with their distinct current-file digest', async () => {
    const scientific = {
      ...snapshot,
      representation: 'scientific_manifest_v1',
      fileManifestSha256: 'b'.repeat(64),
    };
    const response = { workspaceId, versions: [scientific], nextBeforeVersionNumber: null };
    await expect(listWorkspaceSyncHistory(workspaceId, {}, clientWith(response))).resolves.toEqual(
      response
    );
    await expect(
      listWorkspaceSyncHistory(
        workspaceId,
        {},
        clientWith({ ...response, versions: [{ ...scientific, fileManifestSha256: undefined }] })
      )
    ).rejects.toThrow();
  });

  it.each([
    { workspaceId: 'other', versions: [snapshot], nextBeforeVersionNumber: null },
    { workspaceId, versions: [snapshot, snapshot], nextBeforeVersionNumber: null },
    { workspaceId, versions: [{ ...snapshot, sizeBytes: -1 }], nextBeforeVersionNumber: null },
    {
      workspaceId,
      versions: [{ ...snapshot, contentSha256: 'not-a-hash' }],
      nextBeforeVersionNumber: null,
    },
    { workspaceId, versions: [snapshot], nextBeforeVersionNumber: 4 },
    { workspaceId, versions: [], nextBeforeVersionNumber: 1 },
  ])('rejects malformed or mis-scoped server history %#', async (response) => {
    await expect(listWorkspaceSyncHistory(workspaceId, {}, clientWith(response))).rejects.toThrow();
  });

  it('rejects a snapshot at or above the requested history boundary', async () => {
    await expect(
      listWorkspaceSyncHistory(
        workspaceId,
        { beforeVersionNumber: 3 },
        clientWith({
          workspaceId,
          versions: [snapshot],
          nextBeforeVersionNumber: null,
        })
      )
    ).rejects.toThrow('unordered');
  });

  it('propagates authentication/network failures without returning an empty history', async () => {
    const requestJson = vi.fn(async () => {
      throw new Error('Account changed');
    });
    await expect(listWorkspaceSyncHistory(workspaceId, {}, { requestJson })).rejects.toThrow(
      'Account changed'
    );
  });
});
