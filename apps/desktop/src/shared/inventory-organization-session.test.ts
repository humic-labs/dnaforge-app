import { expect, it } from 'vitest';
import {
  applyInventoryOrganizationAction,
  organizationInventoryStateSha256,
  organizationInventoryPlanDigest,
  organizationInventoryActionSha256,
  type InventoryOrganizationTarget,
} from '@waypoint/domain-services';
import { organizationBootstrap } from '../../../../packages/core/domain-services/src/inventory-organization.fixtures';
import {
  inventoryOrganizationDirectoryRequestSchema,
  inventoryOrganizationSnapshotReadSchema,
  inventoryOrganizationPreviewRequestSchema,
  type InventoryOrganizationSessionIdentity,
  type InventoryOrganizationBinding,
  type InventoryOrganizationSnapshotRead,
  type InventoryOrganizationPreviewRead,
} from './inventory-organization-client';
import {
  createInventoryOrganizationSession,
  selectInventoryOrganizationSession,
  invalidateInventoryOrganizationSession,
  beginInventoryOrganizationDirectory,
  beginInventoryOrganizationSnapshot,
  beginInventoryOrganizationPreview,
  publishInventoryOrganizationDirectory,
  publishInventoryOrganizationSnapshot,
  publishInventoryOrganizationPreview,
  inventoryOrganizationSessionView,
} from './inventory-organization-session';
const accountId = '11111111-1111-4111-8111-111111111111',
  desktopSessionId = '22222222-2222-4222-8222-222222222222';
const target: InventoryOrganizationTarget = {
  kind: 'organization-inventory',
  orgId: '33333333-3333-4333-8333-333333333333',
  inventoryId: '44444444-4444-4444-8444-444444444444',
};
const identity: InventoryOrganizationSessionIdentity = {
  accountId,
  desktopSessionId,
  knownAccessTokenExpiresAt: 10000,
};
const binding: InventoryOrganizationBinding = {
  ...identity,
  target,
  accessGeneration: 'access-a',
  bindingEpoch: 'issued-a',
};
const now = (wallTime = 1000, monotonicTime = 1000) => ({ wallTime, monotonicTime });
const snapshotRequest = {
  expectedAccountId: accountId,
  expectedDesktopSessionId: desktopSessionId,
  target,
};
function fixture() {
  const context = {
    at: 1000,
    principal: { kind: 'organization-account' as const, orgId: target.orgId, accountId },
    authority: {
      kind: 'organization-inventory' as const,
      orgId: target.orgId,
      inventoryId: target.inventoryId,
      accountId,
    },
  };
  const result = applyInventoryOrganizationAction(null, {
    target,
    expectedRevision: 0,
    action: organizationBootstrap,
    context,
    admittedMaterialIds: ['material'],
  });
  if (!result.ok) throw Error(result.message);
  const header = {
    accountId,
    target,
    permission: 'operate' as const,
    canBootstrap: false,
    accessGeneration: binding.accessGeneration,
    accessEpoch: 1,
    revision: result.state.revision,
    stateSha256: organizationInventoryStateSha256(result.state),
    asOf: 1000,
  };
  const read: InventoryOrganizationSnapshotRead = {
    kind: 'current',
    binding,
    snapshot: { kind: 'ready', header, state: result.state },
  };
  let state = selectInventoryOrganizationSession(
    createInventoryOrganizationSession(),
    identity,
    target
  );
  const pending = beginInventoryOrganizationSnapshot(state, snapshotRequest, now());
  state = publishInventoryOrganizationSnapshot(
    pending.state,
    pending.ticket,
    read,
    identity,
    now(1001, 1001)
  );
  const request = {
    binding,
    request: {
      target,
      expectedRevision: 1,
      accessGeneration: binding.accessGeneration,
      action: {
        kind: 'consume' as const,
        stockId: 'stock',
        quantity: { value: '7', unit: 'uL' as const },
        reason: 'Completed manual use',
      },
    },
  };
  const candidate = applyInventoryOrganizationAction(result.state, {
    target,
    expectedRevision: 1,
    action: request.request.action,
    context: { ...context, at: 1001 },
    admittedMaterialIds: [],
  });
  if (!candidate.ok) throw Error(candidate.message);
  const ready: InventoryOrganizationPreviewRead = {
    kind: 'ready',
    previewHandleId: '77777777-7777-4777-8777-777777777777',
    binding,
    preview: {
      kind: 'ready',
      header,
      planDigest: organizationInventoryPlanDigest({
        ...request.request,
        beforeStateSha256: header.stateSha256,
        materialAdmission: [],
      }),
      actionSha256: organizationInventoryActionSha256(request.request),
      evaluatedAt: 1001,
      nextBoundaryAt: null,
      readyUntilExclusive: 6001,
      proposed: {
        state: candidate.state,
        stateSha256: organizationInventoryStateSha256(candidate.state),
      },
    },
  };
  return { state, read, request, ready };
}
it('keeps exact Native session pins and reuses strict wire snapshot/binding validation', () => {
  expect(() =>
    inventoryOrganizationDirectoryRequestSchema.parse({
      expectedAccountId: accountId,
      orgId: target.orgId,
    })
  ).toThrow();
  const f = fixture();
  expect(inventoryOrganizationSnapshotReadSchema.parse(f.read)).toEqual(f.read);
  expect(() =>
    inventoryOrganizationSnapshotReadSchema.parse({
      ...f.read,
      binding: { ...binding, accessGeneration: 'other' },
    })
  ).toThrow();
  expect(() =>
    inventoryOrganizationPreviewRequestSchema.parse({
      ...f.request,
      principal: { kind: 'agent', identityId: 'fake' },
    })
  ).toThrow();
  expect(() =>
    inventoryOrganizationPreviewRequestSchema.parse({
      ...f.request,
      binding: { ...binding, bindingEpoch: 'client-made' },
      request: { ...f.request.request, accessGeneration: 'other' },
    })
  ).toThrow();
});
it('discards stale directory/snapshot generations before parsing and fences active account/session/target synchronously', () => {
  let state = selectInventoryOrganizationSession(
    createInventoryOrganizationSession(),
    identity,
    null
  );
  const directory = beginInventoryOrganizationDirectory(
    state,
    {
      expectedAccountId: accountId,
      expectedDesktopSessionId: desktopSessionId,
      orgId: target.orgId,
    },
    now()
  );
  state = selectInventoryOrganizationSession(directory.state, identity, target);
  expect(
    publishInventoryOrganizationDirectory(state, directory.ticket, null, identity, now())
  ).toBe(state);
  const f = fixture(),
    pending = beginInventoryOrganizationSnapshot(f.state, snapshotRequest, now());
  const newer = beginInventoryOrganizationSnapshot(pending.state, snapshotRequest, now(1001, 1001));
  expect(
    publishInventoryOrganizationSnapshot(
      newer.state,
      pending.ticket,
      { bad: true },
      identity,
      now()
    )
  ).toBe(newer.state);
  const differentAccount = { ...identity, accountId: target.orgId };
  expect(inventoryOrganizationSessionView(f.state, differentAccount, target, now())).toEqual({
    kind: 'hidden',
    reason: 'session',
  });
  expect(
    inventoryOrganizationSessionView(
      f.state,
      { ...identity, desktopSessionId: target.orgId },
      target,
      now()
    )
  ).toEqual({ kind: 'hidden', reason: 'session' });
  expect(
    inventoryOrganizationSessionView(
      f.state,
      identity,
      { ...target, inventoryId: accountId },
      now()
    )
  ).toEqual({ kind: 'hidden', reason: 'target' });
  expect(
    inventoryOrganizationSessionView(
      invalidateInventoryOrganizationSession(f.state, 'access-denied'),
      identity,
      target,
      now()
    )
  ).toEqual({ kind: 'hidden', reason: 'access-denied' });
  expect(
    publishInventoryOrganizationSnapshot(
      pending.state,
      pending.ticket,
      f.read,
      differentAccount,
      now()
    )
  ).toBe(pending.state);
});
it('only shows confirmed offline data for its original live known token bound and never enables preview', () => {
  const f = fixture();
  if (f.read.kind !== 'current') throw Error('fixture');
  const active = { ...identity, knownAccessTokenExpiresAt: 20000 };
  const pending = beginInventoryOrganizationSnapshot(f.state, snapshotRequest, now());
  const offline = publishInventoryOrganizationSnapshot(
    pending.state,
    pending.ticket,
    {
      ...f.read,
      kind: 'cached-offline',
      failure: { kind: 'unavailable', code: 'OFFLINE', message: 'Disconnected', retryable: true },
    },
    active,
    now(9999, 2000)
  );
  const view = inventoryOrganizationSessionView(offline, active, target, now(9999, 2000));
  expect(view.kind === 'visible' && view.snapshot?.kind).toBe('cached-offline');
  expect(view.kind === 'visible' && view.canPreview).toBe(false);
  expect(() => beginInventoryOrganizationPreview(offline, f.request, now(9999, 2000))).toThrow();
  const expired = inventoryOrganizationSessionView(offline, active, target, now(10000, 2001));
  expect(expired.kind === 'visible' && expired.snapshot).toBeNull();
  expect(
    inventoryOrganizationSessionView(
      offline,
      { ...active, desktopSessionId: target.inventoryId },
      target,
      now(9999, 2000)
    ).kind
  ).toBe('hidden');
  expect(() =>
    inventoryOrganizationSnapshotReadSchema.parse({
      ...f.read,
      kind: 'cached-offline',
      failure: {
        kind: 'unavailable',
        code: 'FORBIDDEN',
        message: 'Access removed',
        retryable: false,
      },
    })
  ).toThrow();
});
it('anchors Ready before RPC, expires slow responses without a Ready flash, and never promotes proposed state', () => {
  const f = fixture(),
    started = beginInventoryOrganizationPreview(f.state, f.request, now());
  const ready = publishInventoryOrganizationPreview(
    started.state,
    started.ticket,
    f.ready,
    identity,
    now(1002, 1200)
  );
  const view = inventoryOrganizationSessionView(ready, identity, target, now(1002, 1200));
  expect(view.kind === 'visible' && view.preview?.kind).toBe('ready');
  expect(
    view.kind === 'visible' && view.snapshot?.snapshot.state.stocks.stock.quantity
  ).toMatchObject({ value: '10' });
  expect(
    f.ready.kind === 'ready' && f.ready.preview.proposed.state.stocks.stock.quantity
  ).toMatchObject({ value: '3' });
  const expired = inventoryOrganizationSessionView(ready, identity, target, now(1000, 6000));
  expect(expired.kind === 'visible' && expired.preview).toEqual({ kind: 'expired' });
  const late = publishInventoryOrganizationPreview(
    started.state,
    started.ticket,
    f.ready,
    identity,
    now(1002, 6000)
  );
  expect(late.preview).toEqual({ kind: 'expired' });
  expect(
    publishInventoryOrganizationPreview(
      invalidateInventoryOrganizationSession(started.state, 'edit'),
      started.ticket,
      { bad: true },
      identity,
      now()
    )
  ).toMatchObject({ preview: null });
  expect(invalidateInventoryOrganizationSession(ready, 'close-preview').snapshot).toBe(
    f.state.snapshot
  );
  const changed = invalidateInventoryOrganizationSession(ready, 'binding-change');
  expect(changed.snapshot).toBeNull();
  expect(changed.preview).toBeNull();
  expect(
    publishInventoryOrganizationPreview(changed, started.ticket, { bad: true }, identity, now())
  ).toBe(changed);
});
it('retains a blocked stale-base explanation while requiring a fresh snapshot', () => {
  const f = fixture(),
    started = beginInventoryOrganizationPreview(f.state, f.request, now());
  if (f.ready.kind !== 'ready') throw Error('fixture');
  const blocked = {
    kind: 'blocked',
    binding,
    preview: {
      kind: 'blocked',
      header: { ...f.ready.preview.header, revision: 2 },
      issues: [{ code: 'REVISION_CONFLICT', message: 'Refresh the inventory' }],
    },
  };
  const state = publishInventoryOrganizationPreview(
    started.state,
    started.ticket,
    blocked,
    identity,
    now(1002, 1200)
  );
  const view = inventoryOrganizationSessionView(state, identity, target, now(1002, 1200));
  expect(view.kind === 'visible' && view.preview?.kind).toBe('blocked');
  expect(view.kind === 'visible' && view.snapshot).toBeNull();
  expect(view.kind === 'visible' && view.canPreview).toBe(false);
});
