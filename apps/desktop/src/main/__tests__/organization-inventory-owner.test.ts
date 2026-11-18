import type Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0', isPackaged: false, getPath: () => '/tmp' },
  dialog: { showErrorBox: vi.fn() },
  shell: { openExternal: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (v: string) => Buffer.from(v),
    decryptString: (v: Buffer) => v.toString(),
  },
}));
vi.mock('@sentry/electron/main', () => ({ captureMessage: vi.fn() }));
vi.mock('../auth/auth-config', () => ({
  getWebBaseUrl: () => 'https://web.test',
  getAuthChannel: () => 'dev',
  getRedirectScheme: () => 'dnaforge-dev',
}));
import {
  applyInventoryOrganizationAction,
  organizationInventoryStateSha256,
  organizationInventoryActionSha256,
  organizationInventoryPlanDigest,
  type InventoryOrganizationTarget,
  type OrganizationInventorySnapshotResponse,
  type OrganizationInventoryPreviewRequest,
  type OrganizationInventoryPreviewResponse,
} from '@waypoint/domain-services';
import { organizationBootstrap } from '../../../../../packages/core/domain-services/src/inventory-organization.fixtures';
import { createOrganizationInventoryOwner } from '../organization-inventory-owner';
import {
  createOrganizationInventoryProjectionTable,
  readOrganizationInventoryProjection,
  writeOrganizationInventoryProjection,
} from '../organization-inventory-cache';
import { DesktopSyncClientError } from '../desktop-sync-client';
import type { StoredSession } from '../auth/session-store';
import type { OrganizationInventoryHttpClient } from '../organization-inventory-client';
import { createTestDb, createFileTestDb, openFileTestDb } from './test-db';
import { ensureSchema, ensureSchemaForBuild, CURRENT_SCHEMA_VERSION } from '../schema';
const accountId = '11111111-1111-4111-8111-111111111111',
  sessionId = '22222222-2222-4222-8222-222222222222';
const target: InventoryOrganizationTarget = {
  kind: 'organization-inventory',
  orgId: '33333333-3333-4333-8333-333333333333',
  inventoryId: '44444444-4444-4444-8444-444444444444',
};
const request = { expectedAccountId: accountId, expectedDesktopSessionId: sessionId, target };
const session = (desktopSessionId = sessionId, expires = 10000): StoredSession => ({
  accountId,
  desktopSessionId,
  accessTokenExpiresAt: new Date(expires).toISOString(),
  accessToken: 'synthetic-token',
  refreshToken: 'synthetic-refresh',
  channel: 'dev',
  updatedAt: 0,
});
const context = (at = 1000) => ({
  at,
  principal: { kind: 'organization-account' as const, orgId: target.orgId, accountId },
  authority: {
    kind: 'organization-inventory' as const,
    orgId: target.orgId,
    inventoryId: target.inventoryId,
    accountId,
  },
});
type Snapshot = Extract<OrganizationInventorySnapshotResponse, { kind: 'ready' }>;
function snapshot(revision = 1): Snapshot {
  const created = applyInventoryOrganizationAction(null, {
    target,
    expectedRevision: 0,
    action: organizationBootstrap,
    context: context(),
    admittedMaterialIds: ['material'],
  });
  if (!created.ok) throw Error(created.message);
  let state = created.state;
  for (let i = 1; i < revision; i++) {
    const used = applyInventoryOrganizationAction(state, {
      target,
      expectedRevision: state.revision,
      action: {
        kind: 'consume',
        stockId: 'stock',
        quantity: { value: '1', unit: 'uL' },
        reason: 'Use',
      },
      context: context(),
      admittedMaterialIds: [],
    });
    if (!used.ok) throw Error(used.message);
    state = used.state;
  }
  return {
    kind: 'ready',
    header: {
      accountId,
      target,
      permission: 'operate',
      canBootstrap: false,
      accessGeneration: 'generation',
      accessEpoch: 1,
      revision: state.revision,
      stateSha256: organizationInventoryStateSha256(state),
      asOf: 1000,
    },
    state,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const dbs: Database.Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) if (db.open) db.close();
});
function fixture(db = createTestDb()) {
  dbs.push(db);
  createOrganizationInventoryProjectionTable(db);
  let active = session(),
    wall = 1000,
    mono = 1000,
    epoch = 0;
  const client: OrganizationInventoryHttpClient = {
    listDirectory: vi.fn(async () => ({
      kind: 'unavailable' as const,
      code: 'UNUSED',
      message: 'Unused',
      retryable: false,
    })),
    readSnapshot: vi.fn(async () => snapshot()),
    preview: vi.fn(async () => ({
      kind: 'unavailable' as const,
      code: 'UNUSED',
      message: 'Unused',
      retryable: false,
    })),
    applyAction: vi.fn(),
    readOperation: vi.fn(),
  };
  const owner = createOrganizationInventoryOwner({
    db,
    client,
    getActiveSession: async () => active,
    refreshSession: async () => {},
    nowMs: () => wall,
    monotonicMs: () => mono,
    createBindingEpoch: () => `binding-${++epoch}`,
  });
  return {
    db,
    client,
    owner,
    setSession: (v: StoredSession) => {
      active = v;
    },
    setClock: (w: number, m = w) => {
      wall = w;
      mono = m;
    },
  };
}
const rows = (db: Database.Database) =>
  db
    .prepare(
      'SELECT * FROM organization_inventory_projection ORDER BY account_id,org_id,inventory_id'
    )
    .all();
const changes = (db: Database.Database) =>
  (db.prepare('SELECT total_changes() AS count').get() as { count: number }).count;
it('does not erase confirmed projection when its caller is disposed during a delayed snapshot', async () => {
  const f = fixture();
  expect((await f.owner.organizationSnapshot(request)).kind).toBe('current');
  const before = rows(f.db),
    writes = changes(f.db),
    gate = deferred<OrganizationInventorySnapshotResponse>();
  vi.mocked(f.client.readSnapshot).mockImplementationOnce(() => gate.promise);
  let alive = true;
  const pending = f.owner.organizationSnapshot(request, () => {
    if (!alive) throw Error('Caller disposed');
  });
  await vi.waitFor(() => expect(f.client.readSnapshot).toHaveBeenCalledTimes(2));
  alive = false;
  gate.resolve(snapshot(2));
  expect((await pending).kind).toBe('unavailable');
  expect(rows(f.db)).toEqual(before);
  expect(changes(f.db)).toBe(writes);
});
it.each(['old-snapshot', 'old-denial'] as const)(
  'keeps a newer independent caller projection intact after %s completes',
  async (outcome) => {
    const f = fixture();
    const callerA = {};
    const callerB = {};
    const gate = deferred<OrganizationInventorySnapshotResponse>();
    vi.mocked(f.client.readSnapshot).mockImplementationOnce(() => gate.promise);
    const older = f.owner.organizationSnapshot(request, () => {}, callerA);
    await vi.waitFor(() => expect(f.client.readSnapshot).toHaveBeenCalledOnce());
    vi.mocked(f.client.readSnapshot).mockResolvedValueOnce(snapshot(2));
    const newer = await f.owner.organizationSnapshot(request, () => {}, callerB);
    expect(newer.kind).toBe('current');
    expect(
      readOrganizationInventoryProjection(f.db, accountId, target)?.snapshot.header.revision
    ).toBe(2);
    const before = rows(f.db);
    const writes = changes(f.db);
    gate.resolve(
      outcome === 'old-snapshot'
        ? snapshot()
        : {
            kind: 'unavailable',
            code: 'ACCESS_UNAVAILABLE',
            message: 'Older independent denied read.',
            retryable: false,
          }
    );
    expect(await older).toMatchObject({ kind: 'unavailable', code: 'SUPERSEDED' });
    expect(rows(f.db)).toEqual(before);
    expect(changes(f.db)).toBe(writes);
  }
);
it('does not publish a delayed old snapshot or let its later failure erase the newer confirmed binding', async () => {
  for (const outcome of ['old-snapshot', 'old-failure'] as const) {
    const f = fixture(),
      gate = deferred<OrganizationInventorySnapshotResponse>();
    vi.mocked(f.client.readSnapshot).mockImplementationOnce(() => gate.promise);
    const pending = f.owner.organizationSnapshot(request);
    await vi.waitFor(() => expect(f.client.readSnapshot).toHaveBeenCalledTimes(1));
    vi.mocked(f.client.readSnapshot).mockResolvedValueOnce(snapshot(2));
    const current = await f.owner.organizationSnapshot(request);
    expect(current.kind).toBe('current');
    const before = rows(f.db),
      writes = changes(f.db);
    if (outcome === 'old-snapshot') gate.resolve(snapshot());
    else
      gate.resolve({
        kind: 'unavailable',
        code: 'ACCESS_UNAVAILABLE',
        message: 'Old denied read',
        retryable: false,
      });
    expect(await pending).toMatchObject({ kind: 'unavailable', code: 'SUPERSEDED' });
    expect(rows(f.db)).toEqual(before);
    expect(changes(f.db)).toBe(writes);
    if (current.kind !== 'current') throw Error('current');
    const blocked = await f.owner.organizationPreview({
      binding: current.binding,
      request: {
        target,
        expectedRevision: 2,
        accessGeneration: 'generation',
        action: {
          kind: 'consume',
          stockId: 'stock',
          quantity: { value: '1', unit: 'uL' },
          reason: 'Use',
        },
      },
    });
    expect(vi.mocked(f.client.preview)).toHaveBeenCalledOnce();
    expect(blocked.kind).toBe('unavailable');
  }
});
it('cannot publish or remove another current session projection after replacement or owner disposal', async () => {
  for (const scenario of ['replacement', 'owner-dispose'] as const) {
    const f = fixture();
    await f.owner.organizationSnapshot(request);
    const gate = deferred<OrganizationInventorySnapshotResponse>();
    vi.mocked(f.client.readSnapshot).mockImplementationOnce(() => gate.promise);
    const pending = f.owner.organizationSnapshot(request);
    await vi.waitFor(() => expect(f.client.readSnapshot).toHaveBeenCalledTimes(2));
    if (scenario === 'replacement') {
      const replacement = target.orgId;
      f.setSession(session(replacement));
      expect(
        (await f.owner.organizationSnapshot({ ...request, expectedDesktopSessionId: replacement }))
          .kind
      ).toBe('current');
    } else f.owner.dispose();
    const before = rows(f.db),
      writes = changes(f.db);
    gate.resolve(snapshot(2));
    expect((await pending).kind).toBe('unavailable');
    expect(rows(f.db)).toEqual(before);
    expect(changes(f.db)).toBe(writes);
  }
});
it('keeps proposed preview state out of the actual confirmed SQLite projection', async () => {
  const f = fixture(),
    read = await f.owner.organizationSnapshot(request);
  if (read.kind !== 'current') throw Error('current');
  const original = rows(f.db),
    writes = changes(f.db);
  vi.mocked(f.client.preview).mockImplementationOnce(async ({ request: body }) => {
    const candidate = applyInventoryOrganizationAction(read.snapshot.state, {
      target,
      expectedRevision: body.expectedRevision,
      action: body.action,
      context: context(),
      admittedMaterialIds: [],
    });
    if (!candidate.ok) throw Error(candidate.message);
    const result: OrganizationInventoryPreviewResponse = {
      kind: 'ready',
      header: read.snapshot.header,
      planDigest: organizationInventoryPlanDigest({
        ...body,
        beforeStateSha256: read.snapshot.header.stateSha256,
        materialAdmission: [],
      }),
      actionSha256: organizationInventoryActionSha256(body),
      evaluatedAt: 1000,
      nextBoundaryAt: null,
      readyUntilExclusive: 6000,
      proposed: {
        state: candidate.state,
        stateSha256: organizationInventoryStateSha256(candidate.state),
      },
    };
    return result;
  });
  const body: OrganizationInventoryPreviewRequest = {
    target,
    expectedRevision: 1,
    accessGeneration: 'generation',
    action: {
      kind: 'consume',
      stockId: 'stock',
      quantity: { value: '7', unit: 'uL' },
      reason: 'Use',
    },
  };
  const preview = await f.owner.organizationPreview({ binding: read.binding, request: body });
  expect(preview.kind).toBe('ready');
  if (preview.kind === 'ready')
    expect(preview.preview.proposed.state.stocks.stock.quantity).toMatchObject({ value: '3' });
  expect(
    readOrganizationInventoryProjection(f.db, accountId, target)?.snapshot.state.stocks.stock
      .quantity
  ).toMatchObject({ value: '10' });
  expect(rows(f.db)).toEqual(original);
  expect(changes(f.db)).toBe(writes);
});
it('uses readonly offline projection only for NETWORK under the original session and minimum known expiry', async () => {
  const f = fixture();
  await f.owner.organizationSnapshot(request);
  vi.mocked(f.client.readSnapshot).mockRejectedValue(
    new DesktopSyncClientError('NETWORK', 'Offline', { retryable: true, terminal: false })
  );
  f.setSession(session(sessionId, 20000));
  f.setClock(9999);
  const cached = await f.owner.organizationSnapshot(request);
  expect(cached.kind).toBe('cached-offline');
  if (cached.kind !== 'cached-offline') throw Error('cached');
  expect(cached.binding.knownAccessTokenExpiresAt).toBe(10000);
  const before = rows(f.db);
  f.setClock(10000);
  expect((await f.owner.organizationSnapshot(request)).kind).toBe('unavailable');
  expect(rows(f.db)).toEqual(before);
  f.setClock(9999);
  f.setSession(session(target.orgId, 20000));
  expect(
    (await f.owner.organizationSnapshot({ ...request, expectedDesktopSessionId: target.orgId }))
      .kind
  ).toBe('unavailable');
  f.setSession(session(sessionId, 20000));
  const again = await f.owner.organizationSnapshot(request);
  expect(again.kind).toBe('cached-offline');
  if (again.kind !== 'cached-offline') throw Error('cached');
  expect(
    (
      await f.owner.organizationPreview({
        binding: again.binding,
        request: {
          target,
          expectedRevision: 1,
          accessGeneration: 'generation',
          action: {
            kind: 'consume',
            stockId: 'stock',
            quantity: { value: '1', unit: 'uL' },
            reason: 'Use',
          },
        },
      })
    ).kind
  ).toBe('unavailable');
  expect(f.client.preview).not.toHaveBeenCalled();
});
it('removes only the matching denied derived projection so a later network error cannot revive it', async () => {
  const f = fixture();
  await f.owner.organizationSnapshot(request);
  const otherAccount = target.orgId,
    otherSnapshot = snapshot();
  writeOrganizationInventoryProjection(
    f.db,
    {
      accountId: otherAccount,
      desktopSessionId: target.inventoryId,
      knownAccessTokenExpiresAt: 10000,
    },
    { ...otherSnapshot, header: { ...otherSnapshot.header, accountId: otherAccount } }
  );
  const other = rows(f.db).find(
    (row) => (row as { account_id: string }).account_id === otherAccount
  );
  vi.mocked(f.client.readSnapshot).mockResolvedValueOnce({
    kind: 'unavailable',
    code: 'ACCESS_UNAVAILABLE',
    message: 'Access removed',
    retryable: false,
  });
  expect(await f.owner.organizationSnapshot(request)).toMatchObject({
    kind: 'unavailable',
    code: 'ACCESS_UNAVAILABLE',
  });
  expect(readOrganizationInventoryProjection(f.db, accountId, target)).toBeNull();
  expect(rows(f.db)).toEqual([other]);
  vi.mocked(f.client.readSnapshot).mockRejectedValueOnce(
    new DesktopSyncClientError('NETWORK', 'Offline', { retryable: true, terminal: false })
  );
  expect((await f.owner.organizationSnapshot(request)).kind).toBe('unavailable');
  expect(rows(f.db)).toEqual([other]);
});
it('reopens exact file projection and initializes attempt storage only with authorized schema migration or repair', async () => {
  const file = createFileTestDb('organization-inventory-owner');
  let reopened: Database.Database | undefined;
  try {
    const f = fixture(file.db);
    await f.owner.organizationSnapshot(request);
    const before = rows(file.db);
    file.db.close();
    reopened = openFileTestDb(file.dbPath);
    expect(rows(reopened)).toEqual(before);
    expect(readOrganizationInventoryProjection(reopened, accountId, target)?.snapshot).toEqual(
      snapshot()
    );
  } finally {
    reopened?.close();
    file.cleanup();
  }
  const db = createTestDb();
  dbs.push(db);
  ensureSchema(db, ':memory:');
  db.exec(
    "CREATE TABLE local_sentinel(value BLOB NOT NULL); INSERT INTO local_sentinel VALUES(X'0001FF')"
  );
  db.exec(
    'DROP TABLE organization_inventory_projection; DROP TABLE organization_inventory_attempt'
  );
  db.pragma('user_version = 47');
  const otherTables = () =>
    db
      .prepare(
        "SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT IN ('organization_inventory_projection','organization_inventory_attempt') ORDER BY name"
      )
      .all();
  const before = otherTables();
  ensureSchema(db, ':memory:');
  expect(db.pragma('user_version', { simple: true })).toBe(48);
  expect(CURRENT_SCHEMA_VERSION).toBe(48);
  expect(otherTables()).toEqual(before);
  expect(rows(db)).toEqual([]);
  expect(db.prepare('SELECT * FROM organization_inventory_attempt').all()).toEqual([]);
  expect(db.prepare('SELECT hex(value) FROM local_sentinel').pluck().get()).toBe('0001FF');
  writeOrganizationInventoryProjection(
    db,
    {
      accountId,
      desktopSessionId: sessionId,
      knownAccessTokenExpiresAt: 10000,
    },
    snapshot()
  );
  const projection = rows(db);
  db.exec('DROP TABLE organization_inventory_attempt');
  ensureSchema(db, ':memory:');
  expect(db.prepare('SELECT * FROM organization_inventory_attempt').all()).toEqual([]);
  expect(rows(db)).toEqual(projection);
  expect(otherTables()).toEqual(before);
  db.exec('DROP TABLE organization_inventory_attempt');
  const policy = {
    migrationAllowed: false,
    writer: {
      version: '0.7.1',
      isReleaseBuild: false,
      fingerprint: 'synthetic-fixture',
      writtenAt: 1000,
    },
  };
  ensureSchemaForBuild(db, ':memory:', policy);
  expect(
    db.prepare("SELECT name FROM sqlite_master WHERE name='organization_inventory_attempt'").get()
  ).toBeUndefined();
  expect(rows(db)).toEqual(projection);
  expect(db.prepare('SELECT hex(value) FROM local_sentinel').pluck().get()).toBe('0001FF');
  db.pragma('user_version = 47');
  expect(() => ensureSchemaForBuild(db, ':memory:', policy)).toThrow(/not authorized/);
  expect(
    db.prepare("SELECT name FROM sqlite_master WHERE name='organization_inventory_attempt'").get()
  ).toBeUndefined();
  expect(rows(db)).toEqual(projection);
});
