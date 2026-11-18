import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0', isPackaged: false, getPath: () => '/tmp' },
  dialog: { showErrorBox: vi.fn() },
  shell: { openExternal: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
}));
vi.mock('@sentry/electron/main', () => ({ captureMessage: vi.fn() }));
vi.mock('../auth/auth-config', () => ({
  getWebBaseUrl: () => 'https://web.test',
  getAuthChannel: () => 'dev',
  getRedirectScheme: () => 'dnaforge-dev',
}));

import {
  ORGANIZATION_INVENTORY_DISPOSITION_SCHEMA,
  ORGANIZATION_INVENTORY_RESPONSE_SCHEMA,
  applyInventoryOrganizationAction,
  assertOrganizationInventoryResponse,
  organizationInventoryActionSha256,
  organizationInventoryCanonicalJson,
  organizationInventoryPlanDigest,
  organizationInventoryRequestSha256,
  organizationInventoryStateSha256,
  parseOrganizationInventoryResponseEnvelope,
  type InventoryOrganizationTarget,
  type OrganizationInventoryAcceptedAction,
  type OrganizationInventoryApplyResponse,
  type OrganizationInventoryPreviewResponse,
  type OrganizationInventorySnapshotResponse,
} from '@waypoint/domain-services';
import { organizationBootstrap } from '../../../../../packages/core/domain-services/src/inventory-organization.fixtures';
import {
  inventoryOrganizationActionAttemptReadSchema,
  type InventoryOrganizationPreviewRead,
} from '../../shared/inventory-organization-client';
import type { StoredSession } from '../auth/session-store';
import { DesktopSyncClientError } from '../desktop-sync-client';
import type { OrganizationInventoryHttpClient } from '../organization-inventory-client';
import { readOrganizationInventoryProjection } from '../organization-inventory-cache';
import { createOrganizationInventoryOwner } from '../organization-inventory-owner';
import { ensureSchema } from '../schema';
import { createFileTestDb, openFileTestDb } from './test-db';

const accountId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const replacementSessionId = '55555555-5555-4555-8555-555555555555';
const otherAccountId = '66666666-6666-4666-8666-666666666666';
const target: InventoryOrganizationTarget = {
  kind: 'organization-inventory',
  orgId: '33333333-3333-4333-8333-333333333333',
  inventoryId: '44444444-4444-4444-8444-444444444444',
};
const pins = { expectedAccountId: accountId, expectedDesktopSessionId: sessionId, target };
const noop = () => {};
const syntheticSession = (
  desktopSessionId = sessionId,
  selectedAccountId = accountId
): StoredSession => ({
  accountId: selectedAccountId,
  desktopSessionId,
  accessToken: 'synthetic-token',
  refreshToken: 'synthetic-refresh',
  accessTokenExpiresAt: new Date(60000).toISOString(),
  channel: 'dev',
  updatedAt: 0,
});
const context = () => ({
  at: 1000,
  principal: { kind: 'organization-account' as const, orgId: target.orgId, accountId },
  authority: { ...target, accountId },
});
const networkFailure = () =>
  new DesktopSyncClientError('NETWORK', 'Synthetic lost acknowledgement.', {
    retryable: true,
    terminal: false,
  });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture() {
  const file = createFileTestDb('organization-submission');
  let db: Database.Database = file.db;
  ensureSchema(db, file.dbPath);
  let active = syntheticSession();
  let wall = 1000;
  let mono = 1000;
  let epoch = 0;
  let generation = 'generation-original';
  const created = applyInventoryOrganizationAction(null, {
    target,
    expectedRevision: 0,
    action: organizationBootstrap,
    context: context(),
    admittedMaterialIds: ['material'],
  });
  if (!created.ok) throw new Error(created.message);
  let serverState = created.state;
  const accepted = new Map<string, OrganizationInventoryAcceptedAction>();
  const snapshot = (): Extract<OrganizationInventorySnapshotResponse, { kind: 'ready' }> => ({
    kind: 'ready',
    header: {
      accountId: active.accountId,
      target,
      permission: 'operate',
      canBootstrap: false,
      accessGeneration: generation,
      accessEpoch: 1,
      revision: serverState.revision,
      stateSha256: organizationInventoryStateSha256(serverState),
      asOf: wall,
    },
    state: serverState,
  });
  const accept = (
    input: Parameters<OrganizationInventoryHttpClient['applyAction']>[0]
  ): OrganizationInventoryApplyResponse => {
    const request = input.request;
    let disposition = accepted.get(request.body.operationId);
    const replayed = disposition !== undefined;
    if (!disposition) {
      const changed = applyInventoryOrganizationAction(serverState, {
        target,
        expectedRevision: request.body.expectedRevision,
        action: request.body.action,
        context: context(),
        admittedMaterialIds: [],
      });
      if (!changed.ok) throw new Error(changed.message);
      serverState = changed.state;
      disposition = {
        schema: ORGANIZATION_INVENTORY_DISPOSITION_SCHEMA,
        kind: 'action-accepted',
        target,
        operationId: request.body.operationId,
        requestSha256: organizationInventoryRequestSha256(request),
        submitterAccountId: accountId,
        originClientId: request.body.clientId,
        baseRevision: request.body.expectedRevision,
        revision: serverState.revision,
        recordedAt: 1000,
        acceptedAt: 1000,
        stateSha256: organizationInventoryStateSha256(serverState),
        accessGenerationAtDecision: request.body.accessGeneration,
        planDigest: request.body.expectedPlanDigest,
      };
      accepted.set(request.body.operationId, disposition);
    }
    const response = parseOrganizationInventoryResponseEnvelope({
      schema: ORGANIZATION_INVENTORY_RESPONSE_SCHEMA,
      purpose: 'action',
      result: { kind: 'decided', header: snapshot().header, disposition, replayed },
    });
    assertOrganizationInventoryResponse(request, response);
    if (response.purpose !== 'action') throw new Error('Action response required.');
    return response.result;
  };
  const client: OrganizationInventoryHttpClient = {
    listDirectory: vi.fn(async () => ({
      kind: 'unavailable' as const,
      code: 'UNUSED',
      message: 'Unused',
      retryable: false,
    })),
    readSnapshot: vi.fn(async () => snapshot()),
    preview: vi.fn(async ({ request }): Promise<OrganizationInventoryPreviewResponse> => {
      const changed = applyInventoryOrganizationAction(serverState, {
        target,
        expectedRevision: request.expectedRevision,
        action: request.action,
        context: context(),
        admittedMaterialIds: [],
      });
      if (!changed.ok) throw new Error(changed.message);
      const response = parseOrganizationInventoryResponseEnvelope({
        schema: ORGANIZATION_INVENTORY_RESPONSE_SCHEMA,
        purpose: 'preview',
        result: {
          kind: 'ready',
          header: snapshot().header,
          actionSha256: organizationInventoryActionSha256(request),
          planDigest: organizationInventoryPlanDigest({
            ...request,
            beforeStateSha256: snapshot().header.stateSha256,
            materialAdmission: [],
          }),
          evaluatedAt: wall,
          nextBoundaryAt: null,
          readyUntilExclusive: wall + 5000,
          proposed: {
            state: changed.state,
            stateSha256: organizationInventoryStateSha256(changed.state),
          },
        },
      });
      if (response.purpose !== 'preview') throw new Error('Preview response required.');
      return response.result;
    }),
    applyAction: vi.fn(async (input) => accept(input)),
    readOperation: vi.fn(async ({ request }) => {
      const disposition = accepted.get(request.operationId);
      const response = parseOrganizationInventoryResponseEnvelope({
        schema: ORGANIZATION_INVENTORY_RESPONSE_SCHEMA,
        purpose: 'operation',
        result: disposition
          ? { kind: 'known', header: snapshot().header, disposition }
          : {
              kind: 'not-found',
              header: snapshot().header,
              operationId: request.operationId,
              requestSha256: request.requestSha256,
            },
      });
      if (response.purpose !== 'operation') throw new Error('Operation response required.');
      return response.result;
    }),
  };
  const getActiveSession = vi.fn(async () => active);
  const makeOwner = () =>
    createOrganizationInventoryOwner({
      db,
      client,
      getActiveSession,
      refreshSession: async () => {},
      nowMs: () => wall,
      monotonicMs: () => mono,
      createBindingEpoch: () => `binding-${++epoch}`,
    });
  let owner = makeOwner();
  cleanups.push(() => {
    owner.dispose();
    if (db.open) db.close();
    file.cleanup();
  });
  return {
    get db() {
      return db;
    },
    get owner() {
      return owner;
    },
    client,
    getActiveSession,
    accept,
    accepted,
    get serverState() {
      return serverState;
    },
    setSession(value: StoredSession) {
      active = value;
    },
    setClock(w: number, m = w) {
      wall = w;
      mono = m;
    },
    setGeneration(value: string) {
      generation = value;
    },
    restart() {
      owner.dispose();
      db.close();
      db = openFileTestDb(file.dbPath);
      owner = makeOwner();
    },
    async prepare(caller: object, assertCurrent = noop) {
      const current = await owner.organizationSnapshot({
        ...pins,
        expectedAccountId: active.accountId,
        expectedDesktopSessionId: active.desktopSessionId,
      });
      if (current.kind !== 'current') throw new Error(`Snapshot unavailable: ${current.kind}`);
      const preview = await owner.organizationPreview(
        {
          binding: current.binding,
          request: {
            target,
            expectedRevision: current.snapshot.header.revision,
            accessGeneration: current.binding.accessGeneration,
            action: {
              kind: 'consume',
              stockId: 'stock',
              quantity: { value: '1', unit: 'uL' },
              reason: 'Manual shared use',
            },
          },
        },
        assertCurrent,
        caller
      );
      if (preview.kind !== 'ready') throw new Error(`Preview unavailable: ${preview.kind}`);
      return preview;
    },
  };
}

const attempts = (db: Database.Database) =>
  db.prepare('SELECT * FROM organization_inventory_attempt ORDER BY operation_id').all() as Record<
    string,
    unknown
  >[];
const submitRequest = (read: Extract<InventoryOrganizationPreviewRead, { kind: 'ready' }>) => ({
  ...pins,
  previewHandleId: read.previewHandleId,
});

describe('organization submission with real file SQLite and synthetic HTTP boundaries', () => {
  it('cancels its live handle synchronously before a stalled session read lets Submit authenticate', async () => {
    const f = fixture();
    const caller = {};
    const ready = await f.prepare(caller);
    const request = submitRequest(ready);
    const cancelIdentity = deferred<StoredSession>();
    f.getActiveSession.mockImplementationOnce(() => cancelIdentity.promise);
    const readsBefore = f.getActiveSession.mock.calls.length;
    const cancelled = f.owner.organizationCancelPreview(request, noop, caller);
    await vi.waitFor(() => expect(f.getActiveSession).toHaveBeenCalledTimes(readsBefore + 1));
    let submitted;
    let rowsBeforeCancelResolved;
    try {
      submitted = await f.owner.organizationSubmit(request, noop, caller);
      rowsBeforeCancelResolved = attempts(f.db);
    } finally {
      cancelIdentity.resolve(syntheticSession());
    }
    const cancelResult = await cancelled;
    expect(submitted).toMatchObject({ kind: 'unavailable', code: 'PREVIEW_NOT_LIVE' });
    expect(rowsBeforeCancelResolved).toHaveLength(0);
    expect(f.client.applyAction).not.toHaveBeenCalled();
    expect(cancelResult.kind).toBe('cancelled');
    expect(attempts(f.db)).toHaveLength(0);
  });

  it.each(['wrong-caller', 'cancelled', 'monotonic-expiry'] as const)(
    'cannot send a %s ready handle',
    async (scenario) => {
      const f = fixture();
      const caller = {};
      const ready = await f.prepare(caller);
      const request = submitRequest(ready);
      if (scenario === 'cancelled')
        expect((await f.owner.organizationCancelPreview(request, noop, caller)).kind).toBe(
          'cancelled'
        );
      if (scenario === 'monotonic-expiry') f.setClock(1000, 6000);
      expect(
        (await f.owner.organizationSubmit(request, noop, scenario === 'wrong-caller' ? {} : caller))
          .kind
      ).toBe('unavailable');
      expect(attempts(f.db)).toHaveLength(0);
      expect(f.client.applyAction).not.toHaveBeenCalled();
      expect(f.serverState.stocks.stock.quantity).toEqual({
        kind: 'known',
        value: '10',
        unit: 'uL',
      });
    }
  );

  it('retains and sends one operation when the same handle is submitted twice', async () => {
    const f = fixture();
    const caller = {};
    const ready = await f.prepare(caller);
    const gate = deferred<OrganizationInventoryApplyResponse>();
    vi.mocked(f.client.applyAction).mockImplementationOnce(() => gate.promise);
    const first = f.owner.organizationSubmit(submitRequest(ready), noop, caller);
    await vi.waitFor(() => expect(f.client.applyAction).toHaveBeenCalledOnce());
    const duplicate = inventoryOrganizationActionAttemptReadSchema.parse(
      await f.owner.organizationSubmit(submitRequest(ready), noop, caller)
    );
    expect(duplicate.kind).toBe('sent-unknown');
    expect(attempts(f.db)).toHaveLength(1);
    gate.resolve(f.accept(vi.mocked(f.client.applyAction).mock.calls[0][0]));
    const completed = inventoryOrganizationActionAttemptReadSchema.parse(await first);
    if (completed.kind !== 'accepted' || duplicate.kind !== 'sent-unknown')
      throw new Error('Expected one retained accepted outcome.');
    expect(completed.attempt).toEqual(duplicate.attempt);
    expect(completed.delivery.kind).toBe('current');
    expect(f.client.applyAction).toHaveBeenCalledOnce();
    expect(attempts(f.db)).toHaveLength(1);
    expect(f.serverState.stocks.stock.quantity).toEqual({ kind: 'known', value: '9', unit: 'uL' });
  });

  it('recovers a lost accepted acknowledgement after restart under a new same-account session', async () => {
    const f = fixture();
    const caller = {};
    const ready = await f.prepare(caller);
    vi.mocked(f.client.applyAction).mockImplementationOnce(async (input) => {
      f.accept(input);
      throw networkFailure();
    });
    const unknown = inventoryOrganizationActionAttemptReadSchema.parse(
      await f.owner.organizationSubmit(submitRequest(ready), noop, caller)
    );
    if (unknown.kind !== 'sent-unknown')
      throw new Error('Expected unknown accepted acknowledgement.');
    const originalText = attempts(f.db)[0].request_text;
    const original = unknown.attempt;
    expect(original.originalDesktopSessionId).toBe(sessionId);
    f.restart();
    f.setSession(syntheticSession(replacementSessionId));
    f.setGeneration('generation-current');
    const recovered = inventoryOrganizationActionAttemptReadSchema.parse(
      await f.owner.organizationRecover({
        ...pins,
        expectedDesktopSessionId: replacementSessionId,
        operationId: original.operationId,
        requestSha256: original.requestSha256,
        mode: 'inspect',
      })
    );
    if (recovered.kind !== 'accepted') throw new Error('Expected accepted recovery.');
    expect(recovered.attempt).toEqual(original);
    expect(recovered.session.desktopSessionId).toBe(replacementSessionId);
    expect(recovered.delivery.kind).toBe('current');
    expect(attempts(f.db)[0].request_text).toBe(originalText);
    expect(organizationInventoryRequestSha256(recovered.attempt.request)).toBe(
      original.requestSha256
    );
    expect(recovered.attempt.request.body.accessGeneration).toBe('generation-original');
    expect(f.client.readOperation).toHaveBeenCalledWith({
      accountId,
      desktopSessionId: replacementSessionId,
      request: { target, operationId: original.operationId, requestSha256: original.requestSha256 },
    });
    expect(f.client.applyAction).toHaveBeenCalledOnce();
    expect(f.serverState.stocks.stock.quantity).toEqual({ kind: 'known', value: '9', unit: 'uL' });
  });

  it.each(['caller', 'account'] as const)(
    'retains a matching late acknowledgement after %s change without publishing it',
    async (scenario) => {
      const f = fixture();
      const caller = {};
      let alive = true;
      const assertCurrent = () => {
        if (!alive) throw new Error('Caller detached.');
      };
      const ready = await f.prepare(caller, assertCurrent);
      const gate = deferred<OrganizationInventoryApplyResponse>();
      vi.mocked(f.client.applyAction).mockImplementationOnce(() => gate.promise);
      const pending = f.owner.organizationSubmit(submitRequest(ready), assertCurrent, caller);
      await vi.waitFor(() => expect(f.client.applyAction).toHaveBeenCalledOnce());
      const input = vi.mocked(f.client.applyAction).mock.calls[0][0];
      const acknowledgement = f.accept(input);
      if (scenario === 'caller') alive = false;
      else f.setSession(syntheticSession(replacementSessionId, otherAccountId));
      gate.resolve(acknowledgement);
      const answer = await pending;
      expect(answer.kind).toBe('unavailable');
      expect(organizationInventoryCanonicalJson(answer)).not.toContain(
        input.request.body.operationId
      );
      expect(attempts(f.db)[0].disposition_kind).toBe('action-accepted');
      expect(attempts(f.db)[0].account_id).toBe(accountId);
      expect(attempts(f.db)[0].projection_confirmed_revision).toBeNull();
      expect(
        readOrganizationInventoryProjection(f.db, accountId, target)?.snapshot.state.stocks.stock
          .quantity
      ).toEqual({ kind: 'known', value: '10', unit: 'uL' });
      expect(readOrganizationInventoryProjection(f.db, otherAccountId, target)).toBeNull();
      expect(f.client.readSnapshot).toHaveBeenCalledOnce();
    }
  );

  it('does not retain a late acknowledgement through a disposed database owner', async () => {
    const f = fixture();
    const caller = {};
    const ready = await f.prepare(caller);
    const gate = deferred<OrganizationInventoryApplyResponse>();
    vi.mocked(f.client.applyAction).mockImplementationOnce(() => gate.promise);
    const pending = f.owner.organizationSubmit(submitRequest(ready), noop, caller);
    await vi.waitFor(() => expect(f.client.applyAction).toHaveBeenCalledOnce());
    const acknowledgement = f.accept(vi.mocked(f.client.applyAction).mock.calls[0][0]);
    f.owner.dispose();
    const before = attempts(f.db);
    gate.resolve(acknowledgement);
    expect((await pending).kind).toBe('unavailable');
    expect(attempts(f.db)).toEqual(before);
    expect(attempts(f.db)[0].disposition_kind).toBeNull();
    expect(f.client.readSnapshot).toHaveBeenCalledOnce();
  });

  it('keeps unknown and missing lookup separate from a durable refusal', async () => {
    const f = fixture();
    const caller = {};
    const ready = await f.prepare(caller);
    vi.mocked(f.client.applyAction).mockRejectedValueOnce(networkFailure());
    const unknown = inventoryOrganizationActionAttemptReadSchema.parse(
      await f.owner.organizationSubmit(submitRequest(ready), noop, caller)
    );
    if (unknown.kind !== 'sent-unknown') throw new Error('Expected unknown transport outcome.');
    const recover = {
      ...pins,
      operationId: unknown.attempt.operationId,
      requestSha256: unknown.attempt.requestSha256,
      mode: 'inspect' as const,
    };
    expect((await f.owner.organizationRecover(recover)).kind).toBe('sent-unknown');
    vi.mocked(f.client.readOperation).mockResolvedValueOnce({
      kind: 'unavailable',
      code: 'ACCESS_UNAVAILABLE',
      message: 'Access is unavailable.',
      retryable: false,
    });
    expect((await f.owner.organizationRecover(recover)).kind).toBe('unavailable');
    expect(attempts(f.db)).toHaveLength(1);
    expect(attempts(f.db)[0].send_state).toBe('may-have-sent');
    expect(attempts(f.db)[0].disposition_kind).toBeNull();
    expect(f.client.applyAction).toHaveBeenCalledOnce();
    expect(f.serverState.stocks.stock.quantity).toEqual({ kind: 'known', value: '10', unit: 'uL' });
  });

  it('keeps an accepted outcome delivery-pending when the complete snapshot cannot refresh', async () => {
    const f = fixture();
    const caller = {};
    const ready = await f.prepare(caller);
    vi.mocked(f.client.readSnapshot).mockRejectedValueOnce(networkFailure());
    const answer = inventoryOrganizationActionAttemptReadSchema.parse(
      await f.owner.organizationSubmit(submitRequest(ready), noop, caller)
    );
    if (answer.kind !== 'accepted') throw new Error('Expected known accepted outcome.');
    expect(answer.delivery.kind).toBe('pending');
    expect(attempts(f.db)[0].disposition_kind).toBe('action-accepted');
    expect(attempts(f.db)[0].projection_confirmed_revision).toBeNull();
    expect(
      readOrganizationInventoryProjection(f.db, accountId, target)?.snapshot.state.stocks.stock
        .quantity
    ).toEqual({ kind: 'known', value: '10', unit: 'uL' });
    expect(f.serverState.stocks.stock.quantity).toEqual({ kind: 'known', value: '9', unit: 'uL' });
    expect(f.client.applyAction).toHaveBeenCalledOnce();
  });
});
