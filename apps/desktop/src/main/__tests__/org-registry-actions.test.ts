import type Database from 'better-sqlite3';
import type { StoredSession } from '../auth/session-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../org-registry-sync-client', () => ({
  createOrganizationRegistryClient: vi.fn(),
}));
vi.mock('../auth/session-store', () => ({ getActiveStoredSession: vi.fn() }));
vi.mock('../org-registry-sync-worker', () => ({ syncOrganizationRegistry: vi.fn() }));

import { ensureSchema } from '../schema';
import { createOrganizationRegistryActionHandlers } from '../org-registry-actions';
import {
  readOrgRegistrySyncDetails,
  replaceOrgRegistrySnapshot,
  revokeOrgRegistryCache,
} from '../org-registry-sync-cache';
import type { OrganizationRegistryClient } from '../org-registry-sync-client';
import { createTestDb } from './test-db';

const ORG = '20000000-0000-4000-8000-000000000001';
const ACCOUNT = '10000000-0000-4000-8000-000000000001';
const MUTATION = '50000000-0000-4000-8000-000000000001';

let db: Database.Database;

function remoteClient(): OrganizationRegistryClient {
  return {
    getSnapshotPage: vi.fn(),
    acknowledgeSnapshot: vi.fn(),
    getEvents: vi.fn(),
    applyMutation: vi.fn(),
    configure: vi.fn(async () => ({ status: 'configured' as const, cursor: 1 })),
    getSyncHealth: vi.fn(async () => ({
      orgId: ORG,
      cursor: 1,
      entityCount: 0,
      conflictCount: 0,
      replicas: [],
    })),
    getDeletionImpact: vi.fn(async () => ({
      orgId: ORG,
      projectCount: 0,
      archivedProjectCount: 0,
      registryEntityCount: 0,
      archivedRegistryEntityCount: 0,
      registrySchemaCount: 0,
      registryReplicaCount: 0,
      syncStorageObjectCount: 0,
      syncStorageReservationCount: 0,
      canDelete: true,
    })),
  };
}

beforeEach(() => {
  db = createTestDb();
  ensureSchema(db, ':memory:');
});

afterEach(() => db?.close());

describe('organization Registry main actions', () => {
  it('discovers only the current account’s previously synchronized, unrevoked Registry caches', async () => {
    const otherOrg = '20000000-0000-4000-8000-000000000002';
    const revokedOrg = '20000000-0000-4000-8000-000000000003';
    const seed = (orgId: string, accountId: string) =>
      replaceOrgRegistrySnapshot(db, {
        orgId,
        accountId,
        cursor: 1,
        accessGeneration: 'verified-home-access',
        now: 1,
        snapshot: {
          idSchemes: [],
          schemas: [],
          schemaRevisions: [],
          entities: [],
          entityRevisions: [],
          relationships: [],
          placements: [],
        },
      });
    seed(ORG, ACCOUNT);
    seed(otherOrg, 'another-account');
    seed(revokedOrg, ACCOUNT);
    revokeOrgRegistryCache(db, { orgId: revokedOrg, accountId: ACCOUNT, now: 2 });
    const getActiveSession = vi.fn(async () => ({ accountId: ACCOUNT }) as never);
    const sync = vi.fn();
    const client = remoteClient();
    const actions = createOrganizationRegistryActionHandlers(db, {
      getActiveSession,
      getDeviceId: () => 'device-1',
      client,
      sync,
    });
    await actions.getOrganizationRegistry('20000000-0000-4000-8000-000000000004');
    await expect(actions.listCachedOrganizationRegistries()).resolves.toEqual({
      ok: true,
      accountId: ACCOUNT,
      organizationIds: [ORG],
    });
    expect(sync).not.toHaveBeenCalled();
    expect(client.getSnapshotPage).not.toHaveBeenCalled();
    getActiveSession
      .mockResolvedValueOnce({ accountId: ACCOUNT } as never)
      .mockResolvedValueOnce({ accountId: 'another-account' } as never);
    await expect(actions.listCachedOrganizationRegistries()).resolves.toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
    });
    getActiveSession.mockResolvedValue(null as never);
    await expect(actions.listCachedOrganizationRegistries()).resolves.toMatchObject({
      ok: false,
      code: 'SIGNED_OUT',
    });
  });

  it('keeps a mutation in the durable outbox before attempting a remote sync', async () => {
    const client = remoteClient();
    const sync = vi.fn(async () => ({
      status: 'error' as const,
      cursor: 0,
      pendingCount: 1,
      conflictCount: 0,
      errorCode: 'NETWORK',
      errorMessage: 'offline',
    }));
    const actions = createOrganizationRegistryActionHandlers(db, {
      getActiveSession: async () => ({ accountId: ACCOUNT }) as never,
      getDeviceId: () => 'device-1',
      client,
      sync,
      nowMs: () => 100,
      createMutationId: () => 'unused',
    });

    await expect(
      actions.mutateOrganizationRegistry(ORG, {
        mutationId: MUTATION,
        operation: 'entity.create',
        payload: { name: 'MG1655', entityKind: 'strain' },
      })
    ).resolves.toMatchObject({
      ok: true,
      mutationId: MUTATION,
      sync: { status: 'error', errorCode: 'NETWORK' },
      registry: {
        pendingMutations: [expect.objectContaining({ mutationId: MUTATION, status: 'pending' })],
      },
    });
    expect(sync).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        orgId: ORG,
        accountId: ACCOUNT,
        clientId: 'desktop:device-1',
        client,
      })
    );
    expect(
      readOrgRegistrySyncDetails(db, { orgId: ORG, accountId: ACCOUNT }).mutations
    ).toHaveLength(1);
  });

  it.each([false, true])(
    'only notifies the current account after native Registry sync (account changed: %s)',
    async (accountChanged) => {
      let finish!: () => void;
      const blocked = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const session: StoredSession = {
        accountId: ACCOUNT,
        desktopSessionId: 'session',
        accessToken: 'test-access',
        refreshToken: 'test-refresh',
        accessTokenExpiresAt: '2099-01-01T00:00:00Z',
        channel: 'test',
        updatedAt: 0,
      };
      const getActiveSession = vi.fn(async () => session);
      const onRegistryChanged = vi.fn();
      const sync = vi.fn(async () => {
        await blocked;
        return { status: 'ready' as const, cursor: 1, pendingCount: 0, conflictCount: 0 };
      });
      const actions = createOrganizationRegistryActionHandlers(db, {
        getActiveSession,
        getDeviceId: () => 'device-1',
        client: remoteClient(),
        sync,
        onRegistryChanged,
      });
      const pending = actions.syncOrganizationRegistry(ORG);
      await vi.waitFor(() => expect(sync).toHaveBeenCalledOnce());
      expect(onRegistryChanged).not.toHaveBeenCalled();
      if (accountChanged)
        getActiveSession.mockResolvedValue({ ...session, accountId: 'another-account' });
      finish();
      const result = await pending;
      if (accountChanged) {
        expect(result).toMatchObject({ ok: false, code: 'FORBIDDEN' });
        expect(onRegistryChanged).not.toHaveBeenCalled();
      } else {
        expect(result.ok).toBe(true);
        expect(onRegistryChanged).toHaveBeenCalledExactlyOnceWith({
          accountId: ACCOUNT,
          orgId: ORG,
        });
      }
    }
  );

  it('serializes background and explicit sync passes for the same account and organization', async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let active = 0;
    let maxActive = 0;
    const sync = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (sync.mock.calls.length === 1) await firstBlocked;
      active -= 1;
      return {
        status: 'ready' as const,
        cursor: 1,
        pendingCount: 0,
        conflictCount: 0,
      };
    });
    const actions = createOrganizationRegistryActionHandlers(db, {
      getActiveSession: async () => ({ accountId: ACCOUNT }) as never,
      getDeviceId: () => 'device-1',
      client: remoteClient(),
      sync,
      nowMs: () => 100,
    });

    const background = actions.syncOrganizationRegistry(ORG);
    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
    const explicit = actions.syncOrganizationRegistry(ORG);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sync).toHaveBeenCalledTimes(1);
    expect(maxActive).toBe(1);
    releaseFirst();
    await expect(Promise.all([background, explicit])).resolves.toHaveLength(2);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
  });

  it('configures, synchronizes, and exposes health and deletion impact under the active account', async () => {
    const client = remoteClient();
    const sync = vi.fn(async () => ({
      status: 'ready' as const,
      cursor: 1,
      pendingCount: 0,
      conflictCount: 0,
    }));
    const actions = createOrganizationRegistryActionHandlers(db, {
      getActiveSession: async () => ({ accountId: ACCOUNT }) as never,
      getDeviceId: () => 'device-1',
      client,
      sync,
      nowMs: () => 100,
      createMutationId: () => 'replacement-id',
    });

    await expect(
      actions.configureOrganizationRegistry(ORG, {
        defaultPrefix: 'REG',
        defaultPadWidth: 6,
        schemes: [],
      })
    ).resolves.toMatchObject({ ok: true, cursor: 1 });
    expect(client.configure).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG, accountId: ACCOUNT, defaultPrefix: 'REG' })
    );
    await expect(actions.getOrganizationRegistrySyncHealth(ORG)).resolves.toMatchObject({
      ok: true,
      health: { orgId: ORG, cursor: 1 },
    });
    await expect(actions.getOrganizationDeletionImpact(ORG)).resolves.toMatchObject({
      ok: true,
      impact: { canDelete: true },
    });
  });

  it('fails closed while signed out and does not create local organization state', async () => {
    const actions = createOrganizationRegistryActionHandlers(db, {
      getActiveSession: async () => null,
      getDeviceId: () => 'device-1',
      client: remoteClient(),
      nowMs: () => 100,
    });
    await expect(actions.syncOrganizationRegistry(ORG)).resolves.toEqual({
      ok: false,
      code: 'SIGNED_OUT',
      message: 'Sign in to synchronize the organization Registry.',
    });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM org_registry_sync_state`).get()).toEqual({
      count: 0,
    });
  });
});
