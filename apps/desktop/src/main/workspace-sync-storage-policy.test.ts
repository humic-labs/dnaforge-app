import { describe, expect, it, vi } from 'vitest';
vi.mock('./desktop-sync-client', () => ({
  DesktopSyncClientError: class extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly options: unknown
    ) {
      super(message);
    }
  },
}));
import { createTestDb, createFileTestDb, openFileTestDb } from './__tests__/test-db';
import type { DesktopSyncClient } from './desktop-sync-client';
import {
  readWorkspaceSyncCapturePolicy,
  readWorkspaceSyncStoragePolicy,
} from './workspace-sync-storage-policy';
const policy = {
  schemaVersion: 1 as const,
  policyKey: 'expanded',
  revision: 1,
  maxFileBytes: 12 * 1024 ** 3,
  maxProjectBytes: 120 * 1024 ** 3,
  maxFiles: 2000,
  storageQuotaBytes: 240 * 1024 ** 3,
};
const error = (code: string) => Object.assign(new Error(code), { code });
function database() {
  const db = createTestDb();
  db.exec(
    'CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)'
  );
  return db;
}

describe('negotiated project file selection', () => {
  it.each([0, 1])(
    'negotiates support and reads a workspace requiring version %i',
    async (requiredVersion) => {
      const requestJson = vi.fn(async () => ({
        schema: 'dnaforge.workspace-sync-publication-policy/v1',
        policy,
        fileSelection: { supportedVersion: 1, requiredVersion },
      }));
      const client = { requestJson, requestStream: vi.fn() } as unknown as DesktopSyncClient;
      expect(await readWorkspaceSyncStoragePolicy(client, 'project/a', 'account-a')).toEqual(
        policy
      );
      expect(requestJson).toHaveBeenCalledWith(
        '/api/desktop-sync/workspaces/project%2Fa/storage-policy?fileSelectionVersion=1',
        { method: 'GET', expectedAccountId: 'account-a', signal: undefined, maxResponseBytes: 4096 }
      );
    }
  );

  it.each([
    policy,
    {
      schema: 'dnaforge.workspace-sync-publication-policy/v1',
      policy,
      fileSelection: { supportedVersion: 1, requiredVersion: 2 },
    },
  ])('refuses an unnegotiated or unsupported service response', async (response) => {
    const client = {
      requestJson: vi.fn(async () => response),
      requestStream: vi.fn(),
    } as unknown as DesktopSyncClient;
    await expect(
      readWorkspaceSyncStoragePolicy(client, 'project-a', 'account-a')
    ).rejects.toMatchObject({
      code: 'UPGRADE_REQUIRED',
    });
  });
});

describe('durable policy copy for offline capture', () => {
  it('can queue offline after reopening SQLite and keeps the copy scoped to the account and project', async () => {
    const fixture = createFileTestDb('offline-storage-policy');
    let db = fixture.db;
    db.exec(
      'CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)'
    );
    try {
      const online = vi.fn(async () => policy);
      const input = {
        remoteWorkspaceId: 'project-a',
        expectedAccountId: 'account-a',
        readPolicy: online,
      };
      expect(await readWorkspaceSyncCapturePolicy(db, input)).toEqual(policy);
      db.close();
      db = openFileTestDb(fixture.dbPath);
      const offline = vi.fn(async () => {
        throw error('NETWORK');
      });
      expect(await readWorkspaceSyncCapturePolicy(db, { ...input, readPolicy: offline })).toEqual(
        policy
      );
      await expect(
        readWorkspaceSyncCapturePolicy(db, {
          ...input,
          readPolicy: offline,
          expectedAccountId: 'account-b',
        })
      ).rejects.toMatchObject({ code: 'NETWORK' });
      await expect(
        readWorkspaceSyncCapturePolicy(db, {
          ...input,
          readPolicy: offline,
          remoteWorkspaceId: 'project-b',
        })
      ).rejects.toMatchObject({ code: 'NETWORK' });
    } finally {
      db.close();
      fixture.cleanup();
    }
  });

  it('refreshes a changed allowance and never replaces malformed backend data with a cached grant', async () => {
    const db = database();
    try {
      const input = {
        remoteWorkspaceId: 'project-a',
        expectedAccountId: 'account-a',
        readPolicy: async () => policy,
      };
      await readWorkspaceSyncCapturePolicy(db, input);
      const reduced = { ...policy, revision: 2, maxFileBytes: 1024 };
      expect(
        await readWorkspaceSyncCapturePolicy(db, { ...input, readPolicy: async () => reduced })
      ).toEqual(reduced);
      await expect(
        readWorkspaceSyncCapturePolicy(db, {
          ...input,
          readPolicy: async () => ({ ...policy, maxFileBytes: 0 }),
        })
      ).rejects.toThrow();
    } finally {
      db.close();
    }
  });

  it.each([
    'FORBIDDEN',
    'NOT_FOUND',
    'SESSION_REVOKED',
    'ACCOUNT_CHANGED',
    'SIGNED_OUT',
    'BAD_RESPONSE',
    'UPGRADE_REQUIRED',
  ])('never uses a cached allowance after %s', async (code) => {
    const db = database();
    try {
      const input = {
        remoteWorkspaceId: 'project-a',
        expectedAccountId: 'account-a',
        readPolicy: async () => policy,
      };
      await readWorkspaceSyncCapturePolicy(db, input);
      await expect(
        readWorkspaceSyncCapturePolicy(db, {
          ...input,
          readPolicy: async () => {
            throw error(code);
          },
        })
      ).rejects.toMatchObject({ code });
      await expect(
        readWorkspaceSyncCapturePolicy(db, {
          ...input,
          readPolicy: async () => {
            throw error('NETWORK');
          },
        })
      ).rejects.toMatchObject({ code: 'NETWORK' });
    } finally {
      db.close();
    }
  });
});
