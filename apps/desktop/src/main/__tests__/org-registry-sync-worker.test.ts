import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '1.0.0'),
    isPackaged: false,
    getPath: vi.fn(() => '/tmp'),
  },
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
import { ensureSchema } from '../schema';
import { createTestDb } from './test-db';
import { DesktopSyncClientError } from '../desktop-sync-client';
import { enqueueOrgRegistryMutation, readOrgRegistryCache } from '../org-registry-sync-cache';
import {
  syncOrganizationRegistry,
  type OrganizationRegistryRemoteClient,
} from '../org-registry-sync-worker';

const ORG = '20000000-0000-4000-8000-000000000001';
const ACCOUNT_A = '10000000-0000-4000-8000-000000000001';
const ACCOUNT_B = '10000000-0000-4000-8000-000000000002';
const ENTITY = '30000000-0000-4000-8000-000000000001';

class FakeRegistryServer implements OrganizationRegistryRemoteClient {
  cursor = 1;
  accessGeneration = 'scope-1';
  entity = {
    homeWorkspaceId: 'home-1',
    id: ENTITY,
    registryId: 'REG-000001',
    name: 'Before',
    revision: 1,
  };
  events: Array<{
    eventSeq: number;
    eventType: string;
    payload: Record<string, unknown>;
  }> = [];
  revokedAccounts = new Set<string>();

  async getSnapshotPage(input: Parameters<OrganizationRegistryRemoteClient['getSnapshotPage']>[0]) {
    this.assertAccess(input.accountId);
    return {
      format: 'paged-v2' as const,
      accessGeneration: this.accessGeneration,
      orgId: ORG,
      snapshotId: input.snapshotId,
      cursor: this.cursor,
      totalRecords: 3,
      expiresAt: Date.now() + 100_000,
      after: 0,
      nextAfter: 3,
      hasMore: false,
      records: [
        {
          ordinal: 1,
          recordType: 'id_scheme' as const,
          recordId: '*',
          payload: {
            entityKind: '*',
            prefix: 'REG',
            padWidth: 6,
            nextValue: 2,
          },
        },
        {
          ordinal: 2,
          recordType: 'entity' as const,
          recordId: ENTITY,
          payload: { ...this.entity },
        },
        {
          ordinal: 3,
          recordType: 'entity_revision' as const,
          recordId: `${ENTITY}:${this.entity.revision}`,
          payload: {
            entityId: ENTITY,
            revision: this.entity.revision,
            eventSeq: this.cursor,
            snapshot: { ...this.entity },
          },
        },
      ],
    };
  }
  async acknowledgeSnapshot(
    input: Parameters<OrganizationRegistryRemoteClient['acknowledgeSnapshot']>[0]
  ) {
    return {
      status: 'acknowledged' as const,
      snapshotId: input.snapshotId,
      cursor: input.cursor,
      accessGeneration: input.accessGeneration,
    };
  }

  async getEvents(input: Parameters<OrganizationRegistryRemoteClient['getEvents']>[0]) {
    this.assertAccess(input.accountId);
    const events = this.events.filter((event) => event.eventSeq > input.after);
    return {
      accessGeneration: this.accessGeneration,
      events,
      nextCursor: events.at(-1)?.eventSeq ?? input.after,
      currentCursor: this.cursor,
      hasMore: false,
    };
  }

  async applyMutation(input: Parameters<OrganizationRegistryRemoteClient['applyMutation']>[0]) {
    this.assertAccess(input.accountId);
    if (input.operation !== 'entity.update') throw new Error('unexpected operation');
    if (input.payload.expectedRevision !== this.entity.revision) {
      throw new DesktopSyncClientError('CONFLICT', 'Revision changed.', {
        status: 409,
        retryable: false,
        terminal: false,
        details: { currentRevision: this.entity.revision },
      });
    }
    this.cursor += 1;
    this.entity = {
      ...this.entity,
      name: String(input.payload.name),
      revision: this.entity.revision + 1,
    };
    this.events.push({
      eventSeq: this.cursor,
      eventType: 'entity.updated',
      payload: {
        status: 'applied',
        eventSeq: this.cursor,
        entity: { ...this.entity },
        entityRevision: {
          entityId: ENTITY,
          revision: this.entity.revision,
          eventSeq: this.cursor,
          snapshot: { ...this.entity },
        },
      },
    });
    return {
      status: 'applied' as const,
      eventSeq: this.cursor,
      accessGeneration: this.accessGeneration,
      mutationId: input.mutationId,
      entityId: ENTITY,
      homeWorkspaceId: this.entity.homeWorkspaceId,
      entity: { ...this.entity },
    };
  }

  private assertAccess(accountId: string): void {
    if (!this.revokedAccounts.has(accountId)) return;
    throw new DesktopSyncClientError('NOT_FOUND', 'Organization not found.', {
      status: 404,
      retryable: false,
      terminal: true,
    });
  }
}

let dbA: Database.Database;
let dbB: Database.Database;
let server: FakeRegistryServer;

beforeEach(() => {
  dbA = createTestDb();
  dbB = createTestDb();
  ensureSchema(dbA, ':memory:');
  ensureSchema(dbB, ':memory:');
  server = new FakeRegistryServer();
});

afterEach(() => {
  dbA.close();
  dbB.close();
});

it('confirms the final Registry page only after its cursor is durably applied', async () => {
  const input = {
    orgId: ORG,
    accountId: ACCOUNT_A,
    clientId: 'desktop:a',
    client: server,
  };
  await syncOrganizationRegistry(dbA, input);
  await server.applyMutation({
    orgId: ORG,
    clientId: 'desktop:remote',
    mutationId: 'remote-mutation',
    accessGeneration: server.accessGeneration,
    accountId: ACCOUNT_A,
    operation: 'entity.update',
    payload: { id: ENTITY, expectedRevision: 1, name: 'After' },
  });
  const getEvents = vi.spyOn(server, 'getEvents');
  const result = await syncOrganizationRegistry(dbA, input);
  expect(result.status).toBe('ready');
  expect(readOrgRegistryCache(dbA, input).entities[0]).toMatchObject({
    name: 'After',
    revision: 2,
  });
  expect(getEvents.mock.calls.at(-1)?.[0].after).toBe(result.cursor);
});

describe('organization Registry sync worker', () => {
  it('converges the same stable identity and revision across two desktop caches', async () => {
    await syncOrganizationRegistry(dbA, {
      orgId: ORG,
      accountId: ACCOUNT_A,
      clientId: 'desktop:a',
      client: server,
      now: () => 100,
    });
    await syncOrganizationRegistry(dbB, {
      orgId: ORG,
      accountId: ACCOUNT_B,
      clientId: 'desktop:b',
      client: server,
      now: () => 100,
    });

    enqueueOrgRegistryMutation(dbA, {
      orgId: ORG,
      accountId: ACCOUNT_A,
      clientId: 'desktop:a',
      mutationId: '50000000-0000-4000-8000-000000000001',
      operation: 'entity.update',
      payload: { id: ENTITY, expectedRevision: 1, name: 'After' },
      now: 200,
    });
    await syncOrganizationRegistry(dbA, {
      orgId: ORG,
      accountId: ACCOUNT_A,
      clientId: 'desktop:a',
      client: server,
      now: () => 300,
    });
    await syncOrganizationRegistry(dbB, {
      orgId: ORG,
      accountId: ACCOUNT_B,
      clientId: 'desktop:b',
      client: server,
      now: () => 400,
    });

    const entityA = readOrgRegistryCache(dbA, {
      orgId: ORG,
      accountId: ACCOUNT_A,
    }).entities[0];
    const entityB = readOrgRegistryCache(dbB, {
      orgId: ORG,
      accountId: ACCOUNT_B,
    }).entities[0];
    expect(entityA).toMatchObject({
      id: ENTITY,
      registryId: 'REG-000001',
      name: 'After',
      revision: 2,
    });
    expect(entityB).toEqual(entityA);
    expect(readOrgRegistryCache(dbB, { orgId: ORG, accountId: ACCOUNT_B }).entityRevisions).toEqual(
      [
        expect.objectContaining({ entityId: ENTITY, revision: 1 }),
        expect.objectContaining({ entityId: ENTITY, revision: 2 }),
      ]
    );
    expect(dbA.prepare(`SELECT COUNT(*) AS count FROM org_registry_outbox`).get()).toEqual({
      count: 0,
    });
  });

  it('retains an offline stale edit as an explicit conflict after pulling the remote revision', async () => {
    await syncOrganizationRegistry(dbA, {
      orgId: ORG,
      accountId: ACCOUNT_A,
      clientId: 'desktop:a',
      client: server,
      now: () => 100,
    });
    await syncOrganizationRegistry(dbB, {
      orgId: ORG,
      accountId: ACCOUNT_B,
      clientId: 'desktop:b',
      client: server,
      now: () => 100,
    });
    enqueueOrgRegistryMutation(dbB, {
      orgId: ORG,
      accountId: ACCOUNT_B,
      clientId: 'desktop:b',
      mutationId: '50000000-0000-4000-8000-000000000002',
      operation: 'entity.update',
      payload: { id: ENTITY, expectedRevision: 1, name: 'Offline B' },
      now: 150,
    });
    enqueueOrgRegistryMutation(dbA, {
      orgId: ORG,
      accountId: ACCOUNT_A,
      clientId: 'desktop:a',
      mutationId: '50000000-0000-4000-8000-000000000003',
      operation: 'entity.update',
      payload: { id: ENTITY, expectedRevision: 1, name: 'Remote A' },
      now: 160,
    });
    await syncOrganizationRegistry(dbA, {
      orgId: ORG,
      accountId: ACCOUNT_A,
      clientId: 'desktop:a',
      client: server,
      now: () => 200,
    });
    const result = await syncOrganizationRegistry(dbB, {
      orgId: ORG,
      accountId: ACCOUNT_B,
      clientId: 'desktop:b',
      client: server,
      now: () => 300,
    });

    expect(result.conflictCount).toBe(1);
    expect(
      readOrgRegistryCache(dbB, { orgId: ORG, accountId: ACCOUNT_B }).entities[0]
    ).toMatchObject({
      name: 'Remote A',
      revision: 2,
    });
    expect(dbB.prepare(`SELECT status FROM org_registry_outbox`).get()).toEqual({
      status: 'conflict',
    });
    expect(dbB.prepare(`SELECT error_code FROM org_registry_conflicts`).get()).toEqual({
      error_code: 'CONFLICT',
    });
  });

  it('hides revoked cached data and retains unsent intent without sending it', async () => {
    await syncOrganizationRegistry(dbB, {
      orgId: ORG,
      accountId: ACCOUNT_B,
      clientId: 'desktop:b',
      client: server,
      now: () => 100,
    });
    enqueueOrgRegistryMutation(dbB, {
      orgId: ORG,
      accountId: ACCOUNT_B,
      clientId: 'desktop:b',
      mutationId: '50000000-0000-4000-8000-000000000004',
      operation: 'entity.update',
      payload: { id: ENTITY, expectedRevision: 1, name: 'Never sent' },
      now: 150,
    });
    const apply = vi.spyOn(server, 'applyMutation');
    server.revokedAccounts.add(ACCOUNT_B);

    await expect(
      syncOrganizationRegistry(dbB, {
        orgId: ORG,
        accountId: ACCOUNT_B,
        clientId: 'desktop:b',
        client: server,
        now: () => 200,
      })
    ).resolves.toMatchObject({ status: 'access_revoked' });
    expect(readOrgRegistryCache(dbB, { orgId: ORG, accountId: ACCOUNT_B })).toMatchObject({
      state: { status: 'access_revoked' },
      entities: [],
    });
    expect(apply).not.toHaveBeenCalled();
    expect(dbB.prepare(`SELECT COUNT(*) AS count FROM org_registry_outbox`).get()).toEqual({
      count: 1,
    });
  });

  it('preserves readable organization data when only a mutation target is missing', async () => {
    await syncOrganizationRegistry(dbA, {
      orgId: ORG,
      accountId: ACCOUNT_A,
      clientId: 'desktop:a',
      client: server,
      now: () => 100,
    });
    enqueueOrgRegistryMutation(dbA, {
      orgId: ORG,
      accountId: ACCOUNT_A,
      clientId: 'desktop:a',
      mutationId: '50000000-0000-4000-8000-000000000005',
      operation: 'entity.update',
      payload: { id: ENTITY, expectedRevision: 1, name: 'Missing remotely' },
      now: 150,
    });
    const missingTargetClient: OrganizationRegistryRemoteClient = {
      getSnapshotPage: server.getSnapshotPage.bind(server),
      acknowledgeSnapshot: server.acknowledgeSnapshot.bind(server),
      getEvents: server.getEvents.bind(server),
      applyMutation: async () => {
        throw new DesktopSyncClientError('NOT_FOUND', 'Registry entity not found.', {
          status: 404,
          retryable: false,
          terminal: true,
        });
      },
    };

    await expect(
      syncOrganizationRegistry(dbA, {
        orgId: ORG,
        accountId: ACCOUNT_A,
        clientId: 'desktop:a',
        client: missingTargetClient,
        now: () => 200,
      })
    ).resolves.toMatchObject({ status: 'ready', cursor: 1 });
    expect(readOrgRegistryCache(dbA, { orgId: ORG, accountId: ACCOUNT_A })).toMatchObject({
      state: { status: 'ready' },
      entities: [expect.objectContaining({ id: ENTITY })],
    });
    expect(dbA.prepare(`SELECT status FROM org_registry_outbox`).get()).toEqual({
      status: 'failed',
    });
  });

  it('reboots from a snapshot when the organization namespace is reconfigured', async () => {
    const getSnapshot = vi.spyOn(server, 'getSnapshotPage');
    await syncOrganizationRegistry(dbA, {
      orgId: ORG,
      accountId: ACCOUNT_A,
      clientId: 'desktop:a',
      client: server,
      now: () => 100,
    });
    server.cursor = 2;
    server.events.push({
      eventSeq: 2,
      eventType: 'namespace.configured',
      payload: { defaultPrefix: 'LAB', defaultPadWidth: 6, schemes: [] },
    });

    await expect(
      syncOrganizationRegistry(dbA, {
        orgId: ORG,
        accountId: ACCOUNT_A,
        clientId: 'desktop:a',
        client: server,
        now: () => 200,
      })
    ).resolves.toMatchObject({ status: 'ready', cursor: 2 });
    expect(getSnapshot).toHaveBeenCalledTimes(2);
  });

  it('keeps the complete cache through an interrupted paged bootstrap and resumes its exact snapshot', async () => {
    const input = {
      orgId: ORG,
      accountId: ACCOUNT_A,
      clientId: 'desktop:a',
      client: server,
    };
    await syncOrganizationRegistry(dbA, { ...input, now: () => 100 });
    server.cursor = 2;
    server.events.push({
      eventSeq: 2,
      eventType: 'namespace.configured',
      payload: {},
    });
    let interrupted = true;
    const getSnapshotPage = vi.fn(async (page: { snapshotId: string; after: number }) => {
      if (page.after === 1 && interrupted) {
        throw new DesktopSyncClientError('NETWORK', 'Interrupted metadata transfer.', {
          retryable: true,
          terminal: false,
        });
      }
      const second = page.after === 1;
      return {
        format: 'paged-v2' as const,
        accessGeneration: server.accessGeneration,
        orgId: ORG,
        snapshotId: page.snapshotId,
        cursor: 2,
        totalRecords: 2,
        expiresAt: 100_000,
        after: page.after,
        nextAfter: second ? 2 : 1,
        hasMore: !second,
        records: second
          ? [
              {
                ordinal: 2,
                recordType: 'entity_revision',
                recordId: `${ENTITY}:2`,
                payload: {
                  orgId: ORG,
                  entityId: ENTITY,
                  revision: 2,
                  snapshot: { name: 'After' },
                },
              },
            ]
          : [
              {
                ordinal: 1,
                recordType: 'entity',
                recordId: ENTITY,
                payload: {
                  orgId: ORG,
                  id: ENTITY,
                  name: 'After',
                  revision: 2,
                },
              },
            ],
      };
    });
    const acknowledgeSnapshot = vi.fn(server.acknowledgeSnapshot.bind(server));
    Object.assign(server, { getSnapshotPage, acknowledgeSnapshot });

    await expect(
      syncOrganizationRegistry(dbA, { ...input, now: () => 200 })
    ).resolves.toMatchObject({ status: 'error', cursor: 1 });
    expect(getSnapshotPage).toHaveBeenCalledTimes(2);
    expect(readOrgRegistryCache(dbA, input).entities[0].name).toBe('Before');
    expect(acknowledgeSnapshot).not.toHaveBeenCalled();
    const snapshotId = getSnapshotPage.mock.calls[0][0].snapshotId;

    interrupted = false;
    await expect(
      syncOrganizationRegistry(dbA, { ...input, now: () => 300 })
    ).resolves.toMatchObject({ status: 'ready', cursor: 2 });
    expect(getSnapshotPage.mock.calls[2][0]).toMatchObject({
      snapshotId,
      after: 1,
    });
    expect(acknowledgeSnapshot).toHaveBeenCalledTimes(1);
    expect(readOrgRegistryCache(dbA, input).entities[0].name).toBe('After');
    expect(readOrgRegistryCache(dbB, { orgId: ORG, accountId: ACCOUNT_B }).entities).toEqual([]);
  });
  it('hides a discarded scope before a changed ACK, preserves the write, and reboots before retry', async () => {
    const input = {
      orgId: ORG,
      accountId: ACCOUNT_A,
      clientId: 'desktop:a',
      client: server,
      now: () => 100,
    };
    const mutationId = '50000000-0000-4000-8000-000000000099';
    enqueueOrgRegistryMutation(dbA, {
      ...input,
      mutationId,
      operation: 'entity.update',
      payload: { id: ENTITY, expectedRevision: 1, name: 'Queued' },
      now: 1,
    });
    const ack = vi.spyOn(server, 'acknowledgeSnapshot');
    ack.mockImplementationOnce(async () => {
      expect(readOrgRegistryCache(dbA, input).entities).toEqual([]);
      server.accessGeneration = 'scope-2';
      server.entity = { ...server.entity, name: 'Newly granted old record' };
      return {
        status: 'reset_required',
        reason: 'access_changed',
        accessGeneration: 'scope-2',
      } as never;
    });
    const pages = vi.spyOn(server, 'getSnapshotPage');
    const send = vi.spyOn(server, 'applyMutation');
    send.mockImplementationOnce(async (request) => {
      expect(request.accessGeneration).toBe('scope-2');
      expect(readOrgRegistryCache(dbA, input).entities[0].name).toBe('Newly granted old record');
      throw new DesktopSyncClientError('FORBIDDEN', 'Home is read-only.', {
        status: 403,
        retryable: false,
        terminal: true,
      });
    });
    await expect(syncOrganizationRegistry(dbA, input)).resolves.toMatchObject({
      status: 'ready',
    });
    expect(pages).toHaveBeenCalledTimes(2);
    expect(pages.mock.calls[0][0].snapshotId).not.toBe(pages.mock.calls[1][0].snapshotId);
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      dbA.prepare('SELECT mutation_id,status,payload_json FROM org_registry_outbox').get()
    ).toMatchObject({
      mutation_id: mutationId,
      status: 'failed',
      payload_json: JSON.stringify({
        expectedRevision: 1,
        id: ENTITY,
        name: 'Queued',
      }),
    });
    expect(readOrgRegistryCache(dbA, input).state.accessGeneration).toBe('scope-2');
  });

  it('confirms a page of filtered events with the durable cursor before ready', async () => {
    const input = {
      orgId: ORG,
      accountId: ACCOUNT_A,
      clientId: 'desktop:a',
      client: server,
      now: () => 100,
    };
    await syncOrganizationRegistry(dbA, input);
    server.cursor = 3;
    server.events.push(
      { eventSeq: 2, eventType: 'scope.filtered', payload: {} },
      { eventSeq: 3, eventType: 'scope.filtered', payload: {} }
    );
    const events = vi.spyOn(server, 'getEvents');
    await expect(syncOrganizationRegistry(dbA, input)).resolves.toMatchObject({
      status: 'ready',
      cursor: 3,
    });
    expect(events.mock.calls.map(([request]) => request.after)).toEqual([1, 3]);
    expect(readOrgRegistryCache(dbA, input).entities).toEqual([server.entity]);
  });
  it('restarts an unscoped persisted transfer after upgrading without publishing or ACKing it', async () => {
    const input = {
      orgId: ORG,
      accountId: ACCOUNT_A,
      clientId: 'desktop:a',
      client: server,
      now: () => 100,
    };
    await syncOrganizationRegistry(dbA, input);
    dbA.prepare('UPDATE org_registry_sync_state SET access_generation=NULL').run();
    dbA
      .prepare(
        `UPDATE org_registry_snapshot_transfer SET snapshot_id='legacy-transfer',cursor=1,total_records=1,next_after=1,download_complete=1,bootstrap_complete=0`
      )
      .run();
    expect(readOrgRegistryCache(dbA, input).entities).toEqual([]);
    const pages = vi.spyOn(server, 'getSnapshotPage');
    const ack = vi.spyOn(server, 'acknowledgeSnapshot');
    await expect(syncOrganizationRegistry(dbA, input)).resolves.toMatchObject({
      status: 'ready',
    });
    expect(pages.mock.calls[0][0]).toMatchObject({
      after: 0,
      accessGeneration: null,
    });
    expect(ack.mock.calls[0][0].snapshotId).not.toBe('legacy-transfer');
    expect(readOrgRegistryCache(dbA, input).entities).toEqual([server.entity]);
  });
});

describe('saved registered records retain one canonical identity', () => {
  const HOME = '60000000-0000-4000-8000-000000000001';
  const REMOTE_HOME = '60000000-0000-4000-8000-000000000002';
  const SCHEMA = '70000000-0000-4000-8000-000000000001';
  const REVISION = '70000000-0000-4000-8000-000000000002';
  const context = { orgId: ORG, accountId: ACCOUNT_A, clientId: 'desktop:a' };

  class PublicationServer extends FakeRegistryServer {
    override entity = {
      id: ENTITY,
      name: 'Before',
      revision: 1,
      registryId: 'REG-000001',
      orgId: ORG,
      homeWorkspaceId: REMOTE_HOME,
      schemaId: SCHEMA,
      schemaRevisionId: REVISION,
      kind: 'oligo',
      fields: {} as Record<string, unknown>,
      registrationStatus: 'tracked',
      domainStatus: null as string | null,
      archivedAt: null as string | null,
    };
    created = false;
    calls: Array<Parameters<OrganizationRegistryRemoteClient['applyMutation']>[0]> = [];
    receipts = new Map<
      string,
      {
        fingerprint: string;
        response: Awaited<ReturnType<FakeRegistryServer['applyMutation']>>;
      }
    >();

    override async getSnapshotPage(
      input: Parameters<OrganizationRegistryRemoteClient['getSnapshotPage']>[0]
    ) {
      const page = await super.getSnapshotPage(input);
      return this.created ? page : { ...page, totalRecords: 0, nextAfter: 0, records: [] };
    }

    override async applyMutation(
      input: Parameters<OrganizationRegistryRemoteClient['applyMutation']>[0]
    ) {
      if (this.revokedAccounts.has(input.accountId))
        throw new DesktopSyncClientError('FORBIDDEN', 'Access removed.', {
          status: 403,
          retryable: false,
          terminal: true,
        });
      this.calls.push(structuredClone(input));
      const fingerprint = JSON.stringify([
        input.accountId,
        input.clientId,
        input.operation,
        input.payload,
      ]);
      const prior = this.receipts.get(input.mutationId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new Error('Mutation identity changed.');
        return { ...prior.response, accessGeneration: this.accessGeneration };
      }
      if (input.operation === 'entity.create') {
        if (this.created) throw new Error('Duplicate entity.');
        this.created = true;
        this.entity = {
          ...this.entity,
          name: String(input.payload.name),
          fields: input.payload.fields as Record<string, unknown>,
          registrationStatus: String(input.payload.registrationStatus),
          domainStatus: input.payload.domainStatus as string | null,
          revision: 1,
        };
      } else {
        if (input.payload.expectedRevision !== this.entity.revision)
          throw new DesktopSyncClientError('CONFLICT', 'Revision changed.', {
            status: 409,
            retryable: false,
            terminal: false,
            details: { currentRevision: this.entity.revision },
          });
        if (input.operation === 'entity.update')
          this.entity = {
            ...this.entity,
            name: input.payload.name === undefined ? this.entity.name : String(input.payload.name),
            fields:
              input.payload.fields === undefined
                ? this.entity.fields
                : (input.payload.fields as Record<string, unknown>),
            registrationStatus:
              input.payload.registrationStatus === undefined
                ? this.entity.registrationStatus
                : String(input.payload.registrationStatus),
            domainStatus:
              input.payload.domainStatus === undefined
                ? this.entity.domainStatus
                : (input.payload.domainStatus as string | null),
          };
        else if (input.operation === 'entity.archive')
          this.entity = { ...this.entity, archivedAt: '2000-01-01T00:00:00Z' };
        else if (input.operation === 'entity.restore')
          this.entity = { ...this.entity, archivedAt: null };
        else throw new Error('Unexpected operation.');
        this.entity = { ...this.entity, revision: this.entity.revision + 1 };
      }
      this.cursor++;
      const response = {
        status: 'applied' as const,
        eventSeq: this.cursor,
        accessGeneration: this.accessGeneration,
        mutationId: input.mutationId,
        entityId: ENTITY,
        homeWorkspaceId: REMOTE_HOME,
        entity: structuredClone(this.entity),
      };
      this.events.push({
        eventSeq: this.cursor,
        eventType: 'entity.updated',
        payload: { entity: structuredClone(this.entity) },
      });
      this.receipts.set(input.mutationId, { fingerprint, response });
      return response;
    }
  }

  async function enrolled() {
    const owner = await import('../org-registry-record-sync');
    const engine = await import('../lims-engine-core');
    const lifecycle = await import('../lims-entity-lifecycle');
    const crypto = await import('node:crypto');
    dbA
      .prepare('INSERT INTO workspaces(id,name,path,repo_uuid,created_at) VALUES(1,?,?,?,1)')
      .run('Existing home', '/tmp/fixture-registered-record-unit-home', HOME);
    dbA
      .prepare(
        `INSERT INTO workspace_sync_bindings
      (workspace_id,workspace_uuid,owner_account_id,owner_org_id,remote_workspace_id,enabled,access_role,created_at,updated_at)
      VALUES(1,?,?,?,?,0,'editor',1,1)`
      )
      .run(HOME, ACCOUNT_A, ORG, REMOTE_HOME);
    engine.seedLimsBuiltinsInDb(dbA);
    const local = dbA.transaction(() =>
      engine.registerLimsEntityInsideTx(dbA, {
        id: ENTITY,
        kind: 'oligo',
        name: 'Before',
        workspaceId: 1,
        fields: {
          sequence: {
            mode: 'inline',
            bases: 'GTAAAACGACGGCCAGT',
            length: 17,
            topology: 'linear',
          },
          use: 'primer',
        },
      })
    )();
    const remote = new PublicationServer();
    const mutationId = crypto.randomUUID();
    const payload = {
      id: ENTITY,
      homeWorkspaceId: REMOTE_HOME,
      schemaId: SCHEMA,
      schemaRevisionId: REVISION,
      kind: local.kind,
      name: local.name,
      fields: local.fields,
      registrationStatus: local.registrationStatus,
      domainStatus: local.domainStatus,
    };
    dbA.transaction(() => {
      enqueueOrgRegistryMutation(dbA, {
        ...context,
        mutationId,
        operation: 'entity.create',
        payload,
        now: 1,
      });
      owner.enrollOrgRegistryRecordInTx(dbA, {
        ...context,
        mutationId,
        now: 1,
        claim: {
          mutationId,
          sourceEntityId: ENTITY,
          sourceRegistryId: local.registryId,
          sourceRevision: 'checked-source',
          homeWorkspaceId: REMOTE_HOME,
          homeProjectUuid: HOME,
          homeProjectName: 'Existing home',
          payload,
        },
      });
    })();
    function save(
      name: string,
      options: { ready?: boolean; archived?: boolean; accountId?: string } = {}
    ) {
      const operationId = crypto.randomUUID();
      const result = dbA.transaction(() => {
        if (options.archived === false) lifecycle.restoreLimsEntityInsideTx(dbA, { id: ENTITY });
        let entity = engine.updateLimsEntityInsideTx(dbA, { id: ENTITY, name });
        if (options.archived === true)
          entity = lifecycle.archiveLimsEntityInsideTx(dbA, { id: ENTITY });

        const publicationDigest = owner.orgRegistryDatabasePublicationDigest(entity);
        owner.captureOrgRegistryRecordPublicationInTx(dbA, {
          accountId: options.accountId ?? ACCOUNT_A,
          operationId,
          entity,
          publicationDigest,
          now: 2,
        });
        return { operationId, entity, publicationDigest };
      })();
      if (options.ready !== false)
        dbA.transaction(() =>
          owner.markOrgRegistryRecordPublicationReadyInTx(dbA, {
            ...result,
            entityId: ENTITY,
            now: 3,
          })
        )();
      return result;
    }
    return {
      owner,
      remote,
      save,
      mutationId,
      input: { ...context, client: remote, now: () => 10_000 },
    };
  }

  it('waits for publication and Claim ACK, then serializes both offline saves into the same record across profiles', async () => {
    const f = await enrolled();
    const first = f.save('First offline save', { ready: false });
    f.save('Second offline save');
    await syncOrganizationRegistry(dbA, f.input);
    expect(f.remote.calls.map((call) => call.operation)).toEqual(['entity.create']);
    expect(f.remote.entity).toMatchObject({
      id: ENTITY,
      name: 'Before',
      revision: 1,
      homeWorkspaceId: REMOTE_HOME,
    });
    dbA.transaction(() =>
      f.owner.markOrgRegistryRecordPublicationReadyInTx(dbA, {
        ...first,
        entityId: ENTITY,
        now: 3,
      })
    )();
    const intentIds = dbA
      .prepare('SELECT mutation_id FROM org_registry_record_publications ORDER BY local_event_seq')
      .all() as Array<{ mutation_id: string }>;
    await syncOrganizationRegistry(dbA, f.input);
    expect(
      f.remote.calls.slice(1).map((call) => ({
        id: call.mutationId,
        base: call.payload.expectedRevision,
        name: call.payload.name,
      }))
    ).toEqual([
      { id: intentIds[0].mutation_id, base: 1, name: 'First offline save' },
      { id: intentIds[1].mutation_id, base: 2, name: 'Second offline save' },
    ]);
    await syncOrganizationRegistry(dbB, {
      ...f.input,
      accountId: ACCOUNT_B,
      clientId: 'desktop:b',
    });
    expect(readOrgRegistryCache(dbA, context).entities).toEqual(
      readOrgRegistryCache(dbB, { orgId: ORG, accountId: ACCOUNT_B }).entities
    );
    expect(f.remote.entity).toMatchObject({
      id: ENTITY,
      homeWorkspaceId: REMOTE_HOME,
      name: 'Second offline save',
      revision: 3,
    });
    expect(
      f.owner.readOrgRegistryRecordSyncStatus(dbA, {
        accountId: ACCOUNT_A,
        entityId: ENTITY,
      })
    ).toMatchObject({ status: 'synced', acknowledgedRevision: 3 });

    await f.remote.applyMutation({
      ...context,
      mutationId: 'remote-change-without-local-edit',
      accessGeneration: f.remote.accessGeneration,
      operation: 'entity.update',
      payload: { id: ENTITY, expectedRevision: 3, name: 'Changed by another editor' },
    });
    await syncOrganizationRegistry(dbA, f.input);
    expect(
      f.owner.readOrgRegistryRecordSyncStatus(dbA, {
        accountId: ACCOUNT_A,
        entityId: ENTITY,
      })
    ).toMatchObject({ status: 'remote_changes', acknowledgedRevision: 3 });
    expect(dbA.prepare('SELECT name FROM lims_entity WHERE id=?').get(ENTITY)).toEqual({
      name: 'Second offline save',
    });
  });

  it('replays a lost response with the same mutation and blocks a later edit until that acknowledgement', async () => {
    const f = await enrolled();
    await syncOrganizationRegistry(dbA, f.input);
    f.save('First');
    f.save('Second');
    const apply = f.remote.applyMutation.bind(f.remote);
    let interrupted = false;
    vi.spyOn(f.remote, 'applyMutation').mockImplementation(async (input) => {
      const receipt = await apply(input);
      if (!interrupted) {
        interrupted = true;
        throw new DesktopSyncClientError('NETWORK', 'Lost response.', {
          status: 503,
          retryable: true,
          terminal: false,
        });
      }
      return receipt;
    });
    await syncOrganizationRegistry(dbA, f.input);
    expect(f.remote.entity).toMatchObject({ name: 'First', revision: 2 });
    await syncOrganizationRegistry(dbA, { ...f.input, now: () => 100_000 });
    expect(f.remote.calls.slice(1).map((call) => call.mutationId)).toEqual([
      f.remote.calls[1].mutationId,
      f.remote.calls[1].mutationId,
      f.remote.calls[3].mutationId,
    ]);
    expect(f.remote.calls[1].payload).toEqual(f.remote.calls[2].payload);
    expect(f.remote.entity).toMatchObject({ name: 'Second', revision: 3 });
  });

  it('keeps a concurrent revision conflict explicit and leaves its saved successor blocked', async () => {
    const f = await enrolled();
    await syncOrganizationRegistry(dbA, f.input);
    f.save('Local first');
    f.save('Local second');
    await f.remote.applyMutation({
      ...context,
      mutationId: 'remote-change',
      accessGeneration: f.remote.accessGeneration,
      operation: 'entity.update',
      payload: { id: ENTITY, expectedRevision: 1, name: 'Other editor' },
    });
    await syncOrganizationRegistry(dbA, f.input);
    const { readOrgRegistrySyncDetails, resolveOrgRegistryConflict } =
      await import('../org-registry-sync-cache');
    const details = readOrgRegistrySyncDetails(dbA, context);
    expect(details.conflicts).toHaveLength(1);
    expect(
      f.owner.readOrgRegistryRecordConflict(dbA, {
        ...context,
        conflictId: details.conflicts[0].id,
        expectedAccessGeneration: f.remote.accessGeneration,
      })
    ).toMatchObject({
      canonical: { name: 'Other editor', revision: 2 },
      publications: [{ desired: { name: 'Local first' } }, { desired: { name: 'Local second' } }],
    });
    expect(
      f.owner.readOrgRegistryRecordConflict(dbA, {
        ...context,
        accountId: ACCOUNT_B,
        conflictId: details.conflicts[0].id,
      })
    ).toBeNull();
    expect(() =>
      f.owner.readOrgRegistryRecordConflict(dbA, {
        ...context,
        conflictId: details.conflicts[0].id,
        expectedAccessGeneration: 'obsolete',
      })
    ).toThrow(/access/);
    expect(details.conflicts[0].localPayload).toMatchObject({
      id: ENTITY,
      expectedRevision: 1,
      name: 'Local first',
    });
    expect(f.remote.entity).toMatchObject({
      name: 'Other editor',
      revision: 2,
    });
    expect(dbA.prepare('SELECT name FROM lims_entity WHERE id=?').get(ENTITY)).toEqual({
      name: 'Local second',
    });
    expect(
      dbA
        .prepare('SELECT status FROM org_registry_record_publications ORDER BY local_event_seq')
        .all()
    ).toEqual([{ status: 'queued' }, { status: 'ready' }]);
    expect(() =>
      resolveOrgRegistryConflict(dbA, {
        ...context,
        conflictId: details.conflicts[0].id,
        resolution: 'use_remote',
        now: 20_000,
      })
    ).toThrow(/saved file/);
    expect(
      f.owner.readOrgRegistryRecordSyncStatus(dbA, {
        accountId: ACCOUNT_A,
        entityId: ENTITY,
      })
    ).toMatchObject({ status: 'conflict', acknowledgedRevision: 1 });
  });

  it('retains hidden pending work and receipts through revocation, and resumes only under the verified original account', async () => {
    const f = await enrolled();
    await syncOrganizationRegistry(dbA, f.input);
    f.save('Waiting');
    const { readOrgRegistrySyncDetails, readOrgRegistryMutationReceipt } =
      await import('../org-registry-sync-cache');
    const before = dbA.prepare('SELECT * FROM org_registry_record_publications').all();
    const receipt = dbA.prepare('SELECT * FROM org_registry_mutation_receipts').all();
    f.remote.revokedAccounts.add(ACCOUNT_A);
    await syncOrganizationRegistry(dbA, f.input);
    expect(f.remote.calls).toHaveLength(1);
    expect(readOrgRegistryCache(dbA, context).entities).toEqual([]);
    expect(readOrgRegistrySyncDetails(dbA, context)).toEqual({
      mutations: [],
      conflicts: [],
    });
    expect(
      readOrgRegistryMutationReceipt(dbA, {
        ...context,
        mutationId: f.mutationId,
      })
    ).toBeNull();
    expect(() =>
      f.owner.readOrgRegistryRecordSyncStatus(dbA, {
        accountId: ACCOUNT_A,
        entityId: ENTITY,
      })
    ).toThrow(/access/);
    expect(
      f.owner.readOrgRegistryRecordSyncStatus(dbA, {
        accountId: ACCOUNT_B,
        entityId: ENTITY,
      })
    ).toBeNull();
    expect(() => f.save('Wrong account', { accountId: ACCOUNT_B })).toThrow(/Sign in/);
    expect(dbA.prepare('SELECT name FROM lims_entity WHERE id=?').get(ENTITY)).toEqual({
      name: 'Waiting',
    });
    await syncOrganizationRegistry(dbA, {
      ...f.input,
      accountId: ACCOUNT_B,
      clientId: 'desktop:b',
    });
    expect(f.remote.calls).toHaveLength(1);
    expect(dbA.prepare('SELECT * FROM org_registry_record_publications').all()).toEqual(before);
    expect(dbA.prepare('SELECT * FROM org_registry_mutation_receipts').all()).toEqual(receipt);
    f.remote.revokedAccounts.delete(ACCOUNT_A);
    f.remote.accessGeneration = 'scope-restored';
    await syncOrganizationRegistry(dbA, f.input);
    expect(f.remote.calls.at(-1)).toMatchObject({
      accountId: ACCOUNT_A,
      accessGeneration: 'scope-restored',
      payload: { expectedRevision: 1, name: 'Waiting' },
    });
    expect(f.remote.entity).toMatchObject({
      id: ENTITY,
      homeWorkspaceId: REMOTE_HOME,
      name: 'Waiting',
      revision: 2,
    });
  });

  it('finishes fields and lifecycle for each saved edit before advancing to the next restore', async () => {
    const f = await enrolled();
    await syncOrganizationRegistry(dbA, f.input);
    f.save('Archived edit', { archived: true });
    f.save('Restored edit', { archived: false });
    const ids = dbA
      .prepare(
        'SELECT mutation_id,lifecycle_mutation_id FROM org_registry_record_publications ORDER BY local_event_seq'
      )
      .all() as Array<{ mutation_id: string; lifecycle_mutation_id: string }>;
    await syncOrganizationRegistry(dbA, f.input);
    expect(
      f.remote.calls
        .slice(1)
        .map((call) => [call.operation, call.payload.expectedRevision, call.mutationId])
    ).toEqual([
      ['entity.update', 1, ids[0].mutation_id],
      ['entity.archive', 2, ids[0].lifecycle_mutation_id],
      ['entity.update', 3, ids[1].mutation_id],
      ['entity.restore', 4, ids[1].lifecycle_mutation_id],
    ]);
    expect(f.remote.entity).toMatchObject({
      id: ENTITY,
      name: 'Restored edit',
      archivedAt: null,
      revision: 5,
    });
    expect(
      f.owner.readOrgRegistryRecordSyncStatus(dbA, {
        accountId: ACCOUNT_A,
        entityId: ENTITY,
      })
    ).toMatchObject({ status: 'synced', acknowledgedRevision: 5 });
    f.save('Restored edit', { archived: true });
    await syncOrganizationRegistry(dbA, f.input);
    expect(f.remote.calls.at(-1)).toMatchObject({
      operation: 'entity.archive',
      payload: { id: ENTITY, expectedRevision: 5 },
    });
    expect(f.remote.entity.revision).toBe(6);
  });

  async function conflictedRecord() {
    const f = await enrolled();
    await syncOrganizationRegistry(dbA, f.input);
    f.save('First local edit');
    f.save('Latest saved edit');
    await f.remote.applyMutation({
      ...context,
      mutationId: 'remote-before-review',
      accessGeneration: f.remote.accessGeneration,
      operation: 'entity.update',
      payload: { id: ENTITY, expectedRevision: 1, name: 'Organization version' },
    });
    await syncOrganizationRegistry(dbA, f.input);
    return f;
  }

  async function publishReviewedChoice(
    f: Awaited<ReturnType<typeof enrolled>>,
    choice: 'use_remote' | 'keep_saved'
  ) {
    const { randomUUID } = await import('node:crypto');
    const engine = await import('../lims-engine-core');
    const review = f.owner.readOrgRegistryRecordReview(dbA, { ...context, entityId: ENTITY })!;
    const resolutionId = randomUUID();
    const operationId = randomUUID();
    const publication = dbA.transaction(() => {
      f.owner.prepareOrgRegistryRecordResolutionInTx(dbA, {
        ...context,
        entityId: ENTITY,
        resolutionId,
        choice,
        review,
        publicationOperationId: operationId,
        now: 10,
      });
      const entity = engine.updateLimsEntityInsideTx(dbA, {
        id: ENTITY,
        expectedEventSeq: review.localEventSeq!,
        name: String(choice === 'use_remote' ? review.canonical.name : review.local.name),
      });
      const publicationDigest = f.owner.orgRegistryDatabasePublicationDigest(entity);
      const result = {
        accountId: ACCOUNT_A,
        resolutionId,
        operationId,
        entity,
        publicationDigest,
        verifiedAccessGeneration: f.remote.accessGeneration,
        now: 11,
      };
      f.owner.captureOrgRegistryRecordResolutionPublicationInTx(dbA, result);
      return result;
    })();
    return { review, publication };
  }

  it('settles only the approved remote snapshot after local publication and retains later remote changes', async () => {
    const f = await conflictedRecord();
    const { review, publication } = await publishReviewedChoice(f, 'use_remote');
    expect(review.publications).toHaveLength(2);
    expect(
      dbA
        .prepare('SELECT COUNT(*) AS count FROM org_registry_record_publication_supersessions')
        .get()
    ).toEqual({ count: 0 });
    expect(
      dbA.prepare("SELECT COUNT(*) AS count FROM org_registry_conflicts WHERE status='open'").get()
    ).toEqual({ count: 1 });
    expect(
      dbA.prepare('SELECT reviewed_resolution_id FROM org_registry_local_records').get()
    ).toEqual({ reviewed_resolution_id: null });
    const callsBefore = f.remote.calls.length;
    await syncOrganizationRegistry(dbA, f.input);
    expect(f.remote.calls).toHaveLength(callsBefore);
    expect(() => f.save('Unreviewed edit while publication is pending')).toThrow(
      /Finish the reviewed/
    );
    expect(dbA.prepare('SELECT name FROM lims_entity WHERE id=?').get(ENTITY)).toEqual({
      name: 'Organization version',
    });

    await f.remote.applyMutation({
      ...context,
      mutationId: 'remote-after-review',
      accessGeneration: f.remote.accessGeneration,
      operation: 'entity.update',
      payload: { id: ENTITY, expectedRevision: 2, name: 'A later organization edit' },
    });
    await syncOrganizationRegistry(dbA, f.input);
    dbA.transaction(() => f.owner.settleOrgRegistryRecordResolutionInTx(dbA, publication))();
    dbA.transaction(() => f.owner.settleOrgRegistryRecordResolutionInTx(dbA, publication))();
    expect(
      f.owner.readOrgRegistryRecordSyncStatus(dbA, { accountId: ACCOUNT_A, entityId: ENTITY })
    ).toMatchObject({
      status: 'remote_changes',
      acknowledgedRevision: 1,
      baseRevision: 2,
      baseProvenance: 'reviewed_remote',
    });
    expect(
      dbA
        .prepare('SELECT COUNT(*) AS count FROM org_registry_record_publication_supersessions')
        .get()
    ).toEqual({ count: 2 });
    expect(
      dbA.prepare('SELECT COUNT(*) AS count FROM org_registry_record_publications').get()
    ).toEqual({ count: 2 });
    expect(
      dbA
        .prepare("SELECT COUNT(*) AS count FROM org_registry_conflicts WHERE status='discarded'")
        .get()
    ).toEqual({ count: 1 });
    expect(
      dbA.prepare('SELECT COUNT(*) AS count FROM org_registry_mutation_receipts').get()
    ).toEqual({ count: 1 });
    expect(dbA.prepare('SELECT name FROM lims_entity WHERE id=?').get(ENTITY)).toEqual({
      name: 'Organization version',
    });
    f.save('Another explicit local save');
    await syncOrganizationRegistry(dbA, f.input);
    expect(f.remote.calls.at(-1)?.payload).toMatchObject({
      expectedRevision: 2,
      name: 'Another explicit local save',
    });
    expect(
      f.owner.readOrgRegistryRecordSyncStatus(dbA, { accountId: ACCOUNT_A, entityId: ENTITY })
    ).toMatchObject({ status: 'conflict' });
  });

  it('queues one fresh saved revision from the explicit reviewed base and preserves retired intent history', async () => {
    const f = await conflictedRecord();
    const { review, publication } = await publishReviewedChoice(f, 'keep_saved');
    expect(publication.entity.eventSeq).toBeGreaterThan(review.localEventSeq!);
    dbA.transaction(() => f.owner.settleOrgRegistryRecordResolutionInTx(dbA, publication))();
    const fresh = dbA
      .prepare('SELECT mutation_id FROM org_registry_record_publications WHERE operation_id=?')
      .get(publication.operationId) as { mutation_id: string };
    expect(review.publications.map((row) => row.mutationId)).not.toContain(fresh.mutation_id);
    expect(
      f.owner.readOrgRegistryRecordSyncStatus(dbA, { accountId: ACCOUNT_A, entityId: ENTITY })
    ).toMatchObject({
      status: 'queued',
      acknowledgedRevision: 1,
      baseRevision: 2,
      baseProvenance: 'reviewed_remote',
    });
    await syncOrganizationRegistry(dbA, f.input);
    expect(f.remote.calls.at(-1)).toMatchObject({
      mutationId: fresh.mutation_id,
      operation: 'entity.update',
      payload: { id: ENTITY, expectedRevision: 2, name: 'Latest saved edit' },
    });
    expect(f.remote.entity).toMatchObject({
      id: ENTITY,
      homeWorkspaceId: REMOTE_HOME,
      name: 'Latest saved edit',
      revision: 3,
    });
    expect(
      f.owner.readOrgRegistryRecordSyncStatus(dbA, { accountId: ACCOUNT_A, entityId: ENTITY })
    ).toMatchObject({
      status: 'synced',
      acknowledgedRevision: 3,
      baseRevision: 3,
      baseProvenance: 'receipt',
    });

    dbA.transaction(() => f.owner.settleOrgRegistryRecordResolutionInTx(dbA, publication))();
    expect(
      dbA
        .prepare(
          'SELECT reviewed_resolution_id,acknowledged_mutation_id FROM org_registry_local_records'
        )
        .get()
    ).toEqual({ reviewed_resolution_id: null, acknowledged_mutation_id: fresh.mutation_id });
    expect(
      dbA.prepare('SELECT COUNT(*) AS count FROM org_registry_record_publications').get()
    ).toEqual({ count: 3 });
    expect(
      dbA
        .prepare('SELECT COUNT(*) AS count FROM org_registry_record_publication_supersessions')
        .get()
    ).toEqual({ count: 2 });
    expect(
      dbA
        .prepare("SELECT COUNT(*) AS count FROM org_registry_conflicts WHERE status='resolved'")
        .get()
    ).toEqual({ count: 1 });
  });

  it('refuses stale review, account, generation, home, schema and published digest without retiring the conflicting edits', async () => {
    const f = await conflictedRecord();
    const review = f.owner.readOrgRegistryRecordReview(dbA, { ...context, entityId: ENTITY })!;
    const prepare = {
      ...context,
      entityId: ENTITY,
      resolutionId: 'review-fence',
      choice: 'use_remote' as const,
      review,
      publicationOperationId: 'review-fence-operation',
      now: 10,
    };
    expect(() =>
      dbA.transaction(() =>
        f.owner.prepareOrgRegistryRecordResolutionInTx(dbA, { ...prepare, accountId: ACCOUNT_B })
      )()
    ).toThrow(/account|organization/);
    expect(() =>
      dbA.transaction(() =>
        f.owner.prepareOrgRegistryRecordResolutionInTx(dbA, {
          ...prepare,
          review: { ...review, localEventSeq: 0 },
        })
      )()
    ).toThrow(/changed/);
    expect(
      dbA.prepare('SELECT COUNT(*) AS count FROM org_registry_record_resolutions').get()
    ).toEqual({ count: 0 });
    const { publication } = await publishReviewedChoice(f, 'use_remote');
    const settle = () =>
      dbA.transaction(() => f.owner.settleOrgRegistryRecordResolutionInTx(dbA, publication))();
    expect(() =>
      dbA.transaction(() =>
        f.owner.settleOrgRegistryRecordResolutionInTx(dbA, {
          ...publication,
          publicationDigest: { ...publication.publicationDigest, sha256: '0'.repeat(64) },
        })
      )()
    ).toThrow(/checked local bytes/);
    dbA
      .prepare(
        'UPDATE org_registry_sync_state SET access_generation=? WHERE org_id=? AND account_id=?'
      )
      .run('changed', ORG, ACCOUNT_A);
    expect(settle).toThrow(/access/);
    dbA
      .prepare(
        'UPDATE org_registry_sync_state SET access_generation=? WHERE org_id=? AND account_id=?'
      )
      .run(f.remote.accessGeneration, ORG, ACCOUNT_A);
    dbA
      .prepare("UPDATE workspace_sync_bindings SET access_role='viewer' WHERE workspace_id=1")
      .run();
    expect(settle).toThrow(/home|write access/);
    dbA
      .prepare("UPDATE workspace_sync_bindings SET access_role='editor' WHERE workspace_id=1")
      .run();
    const canonical = readOrgRegistryCache(dbA, context).entities.find(
      (entity) => entity.id === ENTITY
    )!;
    dbA
      .prepare(
        "UPDATE org_registry_cache SET payload_json=? WHERE org_id=? AND account_id=? AND record_type='entity' AND record_id=?"
      )
      .run(
        JSON.stringify({ ...canonical, schemaRevisionId: 'different-schema' }),
        ORG,
        ACCOUNT_A,
        ENTITY
      );
    expect(settle).toThrow(/definition/);
    dbA
      .prepare(
        "UPDATE org_registry_cache SET payload_json=? WHERE org_id=? AND account_id=? AND record_type='entity' AND record_id=?"
      )
      .run(JSON.stringify(canonical), ORG, ACCOUNT_A, ENTITY);
    expect(
      dbA
        .prepare('SELECT COUNT(*) AS count FROM org_registry_record_publication_supersessions')
        .get()
    ).toEqual({ count: 0 });
    expect(
      dbA.prepare("SELECT COUNT(*) AS count FROM org_registry_conflicts WHERE status='open'").get()
    ).toEqual({ count: 1 });
    settle();
    expect(
      dbA
        .prepare('SELECT COUNT(*) AS count FROM org_registry_record_publication_supersessions')
        .get()
    ).toEqual({ count: 2 });
  });

  it('accepts an explicitly reviewed incoming version without a local conflict or a fabricated receipt', async () => {
    const f = await enrolled();
    await syncOrganizationRegistry(dbA, f.input);
    await f.remote.applyMutation({
      ...context,
      mutationId: 'incoming-version',
      accessGeneration: f.remote.accessGeneration,
      operation: 'entity.update',
      payload: { id: ENTITY, expectedRevision: 1, name: 'Incoming organization version' },
    });
    await syncOrganizationRegistry(dbA, f.input);
    const { review, publication } = await publishReviewedChoice(f, 'use_remote');
    expect(review.conflictId).toBeNull();
    expect(review.publications).toEqual([]);
    const receiptLocalEvent = (
      dbA.prepare('SELECT acknowledged_local_event_seq FROM org_registry_local_records').get() as {
        acknowledged_local_event_seq: number;
      }
    ).acknowledged_local_event_seq;
    dbA.transaction(() => f.owner.settleOrgRegistryRecordResolutionInTx(dbA, publication))();
    expect(
      dbA.prepare('SELECT acknowledged_local_event_seq FROM org_registry_local_records').get()
    ).toEqual({ acknowledged_local_event_seq: receiptLocalEvent });
    dbA.transaction(() =>
      f.owner.captureOrgRegistryRecordPublicationInTx(dbA, {
        accountId: ACCOUNT_A,
        operationId: 'replay-already-published-local-version',
        entity: publication.entity,
        publicationDigest: publication.publicationDigest,
        now: 12,
      })
    )();
    expect(
      f.owner.readOrgRegistryRecordSyncStatus(dbA, { accountId: ACCOUNT_A, entityId: ENTITY })
    ).toMatchObject({
      status: 'synced',
      acknowledgedRevision: 1,
      baseRevision: 2,
      baseProvenance: 'reviewed_remote',
    });
    expect(
      dbA.prepare('SELECT COUNT(*) AS count FROM org_registry_mutation_receipts').get()
    ).toEqual({ count: 1 });
    expect(
      dbA.prepare('SELECT COUNT(*) AS count FROM org_registry_record_publications').get()
    ).toEqual({ count: 0 });
    expect(dbA.prepare('SELECT name FROM lims_entity WHERE id=?').get(ENTITY)).toEqual({
      name: 'Incoming organization version',
    });
    const next = f.save('New saved edit after explicit acceptance');
    await syncOrganizationRegistry(dbA, f.input);
    expect(f.remote.calls.at(-1)?.payload).toMatchObject({
      expectedRevision: 2,
      name: 'New saved edit after explicit acceptance',
    });
    expect(
      dbA.prepare('SELECT acknowledged_local_event_seq FROM org_registry_local_records').get()
    ).toEqual({ acknowledged_local_event_seq: next.entity.eventSeq });
  });

  it('resumes identical published bytes after verified regrant without adopting a newer remote revision', async () => {
    const f = await conflictedRecord();
    const { publication } = await publishReviewedChoice(f, 'use_remote');
    f.remote.revokedAccounts.add(ACCOUNT_A);
    await syncOrganizationRegistry(dbA, f.input);
    expect(() =>
      dbA.transaction(() => f.owner.settleOrgRegistryRecordResolutionInTx(dbA, publication))()
    ).toThrow(/access/);
    expect(
      dbA
        .prepare('SELECT COUNT(*) AS count FROM org_registry_record_publication_supersessions')
        .get()
    ).toEqual({ count: 0 });
    expect(() =>
      f.owner.readOrgRegistryRecordSyncStatus(dbA, { accountId: ACCOUNT_A, entityId: ENTITY })
    ).toThrow(/access/);
    await f.remote.applyMutation({
      ...context,
      accountId: ACCOUNT_B,
      mutationId: 'remote-during-revocation',
      accessGeneration: f.remote.accessGeneration,
      operation: 'entity.update',
      payload: {
        id: ENTITY,
        expectedRevision: 2,
        name: 'Changed remotely while access was removed',
      },
    });
    f.remote.revokedAccounts.delete(ACCOUNT_A);
    f.remote.accessGeneration = 'verified-regained-access';
    await syncOrganizationRegistry(dbA, f.input);
    expect(() =>
      dbA.transaction(() => f.owner.settleOrgRegistryRecordResolutionInTx(dbA, publication))()
    ).toThrow(/access/);
    const resumed = { ...publication, verifiedAccessGeneration: f.remote.accessGeneration };
    dbA.transaction(() => f.owner.settleOrgRegistryRecordResolutionInTx(dbA, resumed))();
    dbA.transaction(() => f.owner.settleOrgRegistryRecordResolutionInTx(dbA, resumed))();
    expect(
      f.owner.readOrgRegistryRecordSyncStatus(dbA, { accountId: ACCOUNT_A, entityId: ENTITY })
    ).toMatchObject({
      status: 'remote_changes',
      acknowledgedRevision: 1,
      baseRevision: 2,
      baseProvenance: 'reviewed_remote',
    });
    expect(dbA.prepare('SELECT name FROM lims_entity WHERE id=?').get(ENTITY)).toEqual({
      name: 'Organization version',
    });
    expect(f.remote.entity).toMatchObject({
      revision: 3,
      name: 'Changed remotely while access was removed',
    });
    expect(
      dbA.prepare('SELECT COUNT(*) AS count FROM org_registry_record_resolutions').get()
    ).toEqual({ count: 1 });
    expect(
      dbA.prepare('SELECT COUNT(*) AS count FROM org_registry_mutation_receipts').get()
    ).toEqual({ count: 1 });
    expect(
      dbA
        .prepare('SELECT COUNT(*) AS count FROM org_registry_record_publication_supersessions')
        .get()
    ).toEqual({ count: 2 });
  });
});
