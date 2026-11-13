import { describe, expect, it, vi } from 'vitest';

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
vi.mock('../desktop-sync-client', () => ({ createDesktopSyncClient: vi.fn() }));

import type { DesktopSyncClient } from '../desktop-sync-client';
import { createOrganizationRegistryClient } from '../org-registry-sync-client';

const ORG_ID = 'cccccccc-cccc-cccc-cccc-ccccccccccc1';
const ACCOUNT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1';
const MUTATION_ID = '51000000-0000-0000-0000-000000000001';

function desktopClient(responses: unknown[]): {
  client: DesktopSyncClient;
  requestJson: ReturnType<typeof vi.fn>;
} {
  const requestJson = vi.fn();
  for (const response of responses) requestJson.mockResolvedValueOnce(response);
  return {
    requestJson,
    client: {
      requestJson,
      requestStream: vi.fn(),
    } as unknown as DesktopSyncClient,
  };
}

describe('organization Registry hosted client', () => {
  it('addresses snapshot and event pulls by organization, client, account, and cursor', async () => {
    const { client, requestJson } = desktopClient([
      {
        format: 'paged-v2',
        accessGeneration: 'scope-1',
        orgId: ORG_ID,
        snapshotId: 'snapshot-1',
        cursor: 7,
        totalRecords: 1,
        expiresAt: 100_000,
        after: 0,
        nextAfter: 1,
        hasMore: false,
        records: [
          { ordinal: 1, recordType: 'entity', recordId: 'entity-1', payload: { id: 'entity-1' } },
        ],
      },
      {
        accessGeneration: 'scope-1',
        events: [{ eventSeq: 8, eventType: 'entity.updated', payload: { entity: {} } }],
        nextCursor: 8,
        currentCursor: 9,
        hasMore: true,
      },
    ]);
    const registry = createOrganizationRegistryClient(client);

    await expect(
      registry.getSnapshotPage({
        orgId: ORG_ID,
        accountId: ACCOUNT_ID,
        clientId: 'desktop/device 1',
        snapshotId: 'snapshot-1',
        after: 0,
        limit: 500,
        accessGeneration: null,
      })
    ).resolves.toMatchObject({
      cursor: 7,
      records: [
        { ordinal: 1, recordType: 'entity', recordId: 'entity-1', payload: { id: 'entity-1' } },
      ],
    });
    await expect(
      registry.getEvents({
        orgId: ORG_ID,
        accountId: ACCOUNT_ID,
        clientId: 'desktop/device 1',
        accessGeneration: 'scope-1',
        after: 7,
        limit: 500,
      })
    ).resolves.toMatchObject({ nextCursor: 8, currentCursor: 9, hasMore: true });

    expect(requestJson).toHaveBeenNthCalledWith(
      1,
      `/api/desktop-sync/organizations/${ORG_ID}/registry?format=paged-v2&clientId=desktop%2Fdevice+1&snapshotId=snapshot-1&after=0&limit=500`,
      { method: 'GET', expectedAccountId: ACCOUNT_ID, maxResponseBytes: 2 * 1024 * 1024 }
    );
    expect(requestJson).toHaveBeenNthCalledWith(
      2,
      `/api/desktop-sync/organizations/${ORG_ID}/registry/events?format=paged-v2&after=7&limit=500&clientId=desktop%2Fdevice%201&accessGeneration=scope-1`,
      { method: 'GET', expectedAccountId: ACCOUNT_ID, maxResponseBytes: 2 * 1024 * 1024 }
    );
  });

  it('posts an idempotent mutation using the same mutation id in the body and header', async () => {
    const { client, requestJson } = desktopClient([
      { status: 'applied', eventSeq: 9, mutationId: MUTATION_ID, accessGeneration: 'scope-1' },
    ]);
    const registry = createOrganizationRegistryClient(client);

    await expect(
      registry.applyMutation({
        orgId: ORG_ID,
        accountId: ACCOUNT_ID,
        clientId: 'desktop-1',
        accessGeneration: 'scope-1',
        mutationId: MUTATION_ID,
        operation: 'entity.update',
        payload: { id: 'entity-1', expectedRevision: 2, name: 'updated' },
      })
    ).resolves.toEqual({
      status: 'applied',
      eventSeq: 9,
      mutationId: MUTATION_ID,
      accessGeneration: 'scope-1',
    });

    expect(requestJson).toHaveBeenCalledWith(`/api/desktop-sync/organizations/${ORG_ID}/registry`, {
      method: 'POST',
      expectedAccountId: ACCOUNT_ID,
      idempotencyKey: MUTATION_ID,
      body: {
        format: 'paged-v2',
        clientId: 'desktop-1',
        accessGeneration: 'scope-1',
        mutationId: MUTATION_ID,
        operation: 'entity.update',
        payload: { id: 'entity-1', expectedRevision: 2, name: 'updated' },
      },
    });
  });

  it('loads admin health and deletion impact and configures the namespace', async () => {
    const { client, requestJson } = desktopClient([
      {
        orgId: ORG_ID,
        cursor: 12,
        entityCount: 3,
        conflictCount: 1,
        replicas: [
          {
            clientId: 'desktop-1',
            accountId: ACCOUNT_ID,
            accountName: 'Alice',
            lastEventSeq: 11,
            lagEvents: 1,
            lastPushAt: null,
            lastPullAt: '2026-09-21T12:00:00Z',
            lastErrorCode: null,
            conflictCount: 1,
            updatedAt: '2026-09-21T12:00:00Z',
          },
        ],
      },
      {
        orgId: ORG_ID,
        projectCount: 2,
        archivedProjectCount: 1,
        registryEntityCount: 3,
        archivedRegistryEntityCount: 4,
        registrySchemaCount: 1,
        registryReplicaCount: 1,
        syncStorageObjectCount: 5,
        syncStorageReservationCount: 2,
        canDelete: false,
      },
      { status: 'configured', cursor: 1 },
    ]);
    const registry = createOrganizationRegistryClient(client);

    await expect(
      registry.getSyncHealth({ orgId: ORG_ID, accountId: ACCOUNT_ID })
    ).resolves.toMatchObject({ cursor: 12, conflictCount: 1 });
    await expect(
      registry.getDeletionImpact({ orgId: ORG_ID, accountId: ACCOUNT_ID })
    ).resolves.toMatchObject({
      projectCount: 2,
      syncStorageObjectCount: 5,
      syncStorageReservationCount: 2,
      canDelete: false,
    });
    await expect(
      registry.configure({
        orgId: ORG_ID,
        accountId: ACCOUNT_ID,
        defaultPrefix: 'SMITH',
        defaultPadWidth: 6,
        schemes: [{ entityKind: 'strain', prefix: 'STR', padWidth: 5 }],
      })
    ).resolves.toEqual({ status: 'configured', cursor: 1 });

    expect(requestJson.mock.calls.map((call) => call[0])).toEqual([
      `/api/desktop-sync/organizations/${ORG_ID}/registry/sync-health`,
      `/api/desktop-sync/organizations/${ORG_ID}/deletion-impact`,
      `/api/desktop-sync/organizations/${ORG_ID}/registry/configuration`,
    ]);
  });

  it('rejects malformed successful payloads instead of poisoning the local cache', async () => {
    const malformed = [
      { cursor: 1, idSchemes: [], entities: [] },
      { events: [{ eventSeq: 4, eventType: '', payload: {} }], nextCursor: 4 },
      { status: 'applied', eventSeq: -1 },
    ];
    const { client } = desktopClient(malformed);
    const registry = createOrganizationRegistryClient(client);

    await expect(
      registry.getSnapshotPage({
        orgId: ORG_ID,
        accountId: ACCOUNT_ID,
        clientId: 'desktop-1',
        snapshotId: 'snapshot-1',
        after: 0,
        limit: 500,
        accessGeneration: null,
      })
    ).rejects.toThrow('scoped paged-v2');
    await expect(
      registry.getEvents({
        orgId: ORG_ID,
        accountId: ACCOUNT_ID,
        clientId: 'desktop-1',
        accessGeneration: 'scope-1',
        after: 3,
        limit: 500,
      })
    ).rejects.toThrow('invalid Registry event page');
    await expect(
      registry.applyMutation({
        orgId: ORG_ID,
        accountId: ACCOUNT_ID,
        clientId: 'desktop-1',
        accessGeneration: 'scope-1',
        mutationId: MUTATION_ID,
        operation: 'entity.update',
        payload: {},
      })
    ).rejects.toThrow('invalid Registry mutation response');
  });
  it('accepts only identity-free filtered checkpoints and exact access reset responses', async () => {
    const request = {
      orgId: ORG_ID,
      accountId: ACCOUNT_ID,
      clientId: 'desktop-1',
      after: 7,
      limit: 500,
      accessGeneration: 'scope-1',
    };
    const page = {
      accessGeneration: 'scope-1',
      events: [{ eventSeq: 8, eventType: 'scope.filtered', payload: {} }],
      nextCursor: 8,
      currentCursor: 8,
      hasMore: false,
    };
    const reset = {
      status: 'reset_required',
      reason: 'access_changed',
      accessGeneration: 'scope-2',
    };
    const { client } = desktopClient([
      page,
      { ...page, events: [{ ...page.events[0], entityId: 'secret' }] },
      reset,
      { ...reset, entityId: 'secret' },
    ]);
    const registry = createOrganizationRegistryClient(client);
    await expect(registry.getEvents(request)).resolves.toEqual(page);
    await expect(registry.getEvents(request)).rejects.toThrow('invalid Registry event page');
    await expect(registry.getEvents(request)).resolves.toEqual(reset);
    await expect(registry.getEvents(request)).rejects.toThrow('Invalid Registry access reset');
  });
});
