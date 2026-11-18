import { expect, it } from 'vitest';
import {
  applyInventoryOrganizationAction,
  parseInventoryOrganizationAction,
} from './inventory-organization';
import { applyInventoryCommandBatch } from './inventory-state';
import {
  parseInventoryExecutionContext,
  parseInventoryOrganizationExecutionContext,
  parseInventoryState,
} from './inventory-validation';
import {
  organizationBootstrap,
  organizationCommands,
  organizationContext,
  organizationFixture,
  organizationResult,
  organizationTarget,
} from './inventory-organization.fixtures';
import { recordedEquipmentIncidentFixture } from './inventory-equipment-incident.fixtures';
import type { InventoryOrganizationAction } from './inventory-organization-types';
const consume: InventoryOrganizationAction = {
  kind: 'consume',
  stockId: 'stock',
  quantity: { value: '7', unit: 'uL' },
  reason: 'Completed use',
};
const act = (
  state: ReturnType<typeof organizationFixture>,
  action: InventoryOrganizationAction = consume,
  accountId = 'alice',
  at = 100
) =>
  applyInventoryOrganizationAction(state, {
    target: organizationTarget,
    expectedRevision: state.revision,
    action,
    context: organizationContext(accountId, at),
    admittedMaterialIds: [],
  });
it('uses one copied batch for admitted initial inventory and existing consume/move rules', () => {
  const state = organizationFixture(),
    before = JSON.stringify(state);
  expect(parseInventoryState(state)).toEqual(state);
  const used = organizationResult(act(state));
  expect(used.stocks.stock.quantity).toEqual({ kind: 'known', value: '3', unit: 'uL' });
  expect(state.revision).toBe(1);
  expect(used.revision).toBe(2);
  expect(JSON.stringify(state)).toBe(before);
  const moved = organizationResult(
    act(state, {
      kind: 'move-vessel',
      id: 'tube',
      placement: { kind: 'located', storageId: 'rack', slotId: 'B' },
    })
  );
  expect(moved.vessels.tube.placement).toMatchObject({ slotId: 'B' });
  expect(
    applyInventoryOrganizationAction(used, {
      target: organizationTarget,
      expectedRevision: 1,
      action: consume,
      context: organizationContext(),
      admittedMaterialIds: [],
    })
  ).toMatchObject({ ok: false, code: 'REVISION_CONFLICT' });
});
it('refuses unsupported actions, mixed account authority and bootstrap re-entry without effects', () => {
  const state = organizationFixture(),
    before = JSON.stringify(state),
    ctx = organizationContext();
  expect(() => parseInventoryExecutionContext(ctx)).toThrow();
  expect(() =>
    parseInventoryOrganizationExecutionContext({
      ...ctx,
      authority: { ...ctx.authority, accountId: 'bob' },
    })
  ).toThrow();
  for (const action of [
    { kind: 'cancel-reservation', reservationId: 'hold', reason: 'manager' },
    { kind: 'consume', stockId: 'stock', quantity: { value: '0', unit: 'uL' }, reason: 'Zero' },
  ])
    expect(() => parseInventoryOrganizationAction(action)).toThrow();
  expect(act(state, organizationBootstrap)).toMatchObject({ ok: false });
  expect(
    applyInventoryOrganizationAction(state, {
      target: { ...organizationTarget, orgId: 'other' },
      expectedRevision: 1,
      action: consume,
      context: ctx,
      admittedMaterialIds: [],
    })
  ).toMatchObject({ ok: false });
  expect(JSON.stringify(state)).toBe(before);
});
it('requires admitted positive known bootstrap materials and rolls back occupancy collisions', () => {
  const run = (action: InventoryOrganizationAction, admittedMaterialIds = ['material']) =>
    applyInventoryOrganizationAction(null, {
      target: organizationTarget,
      expectedRevision: 0,
      action,
      context: organizationContext(),
      admittedMaterialIds,
    });
  expect(run(organizationBootstrap, [])).toMatchObject({ ok: false });
  if (organizationBootstrap.kind !== 'bootstrap') throw Error('setup');
  expect(
    run({
      ...organizationBootstrap,
      stocks: organizationBootstrap.stocks.map((s) => ({
        ...s,
        quantity: { value: '0', unit: 'uL' },
      })),
    })
  ).toMatchObject({ ok: false });
  expect(
    run({
      ...organizationBootstrap,
      vessels: [
        ...organizationBootstrap.vessels,
        { ...organizationBootstrap.vessels[0], id: 'collision' },
      ],
    })
  ).toMatchObject({ ok: false, code: 'SLOT_OCCUPIED' });
});
it('preserves owned and foreign reservations and does not expire holds on clock passage', () => {
  const state = organizationCommands(organizationFixture(), [
    {
      kind: 'reserve-quantity',
      id: 'hold',
      stockId: 'stock',
      quantity: { value: '8', unit: 'uL' },
      deadline: 110,
      purpose: 'Experiment',
    },
  ]);
  expect(act(state, consume, 'alice')).toMatchObject({ ok: false, code: 'QUANTITY_RESERVED' });
  expect(act(state, consume, 'bob', 120)).toMatchObject({ ok: false, code: 'QUANTITY_RESERVED' });
  expect(state.reservations.hold.lifecycle.kind).toBe('active');
  const item = organizationCommands(organizationFixture(), [
    {
      kind: 'reserve-item',
      id: 'item-hold',
      item: { kind: 'storage', id: 'rack' },
      deadline: null,
      purpose: 'Keep whole rack',
    },
  ]);
  expect(
    act(item, { kind: 'move-vessel', id: 'tube', placement: { kind: 'unplaced' } }, 'bob')
  ).toMatchObject({ ok: false, code: 'ITEM_RESERVED' });
});
it('matches checked-out account across submissions and preserves transit/quality/validity restrictions', () => {
  const checked = organizationCommands(organizationFixture(), [
    { kind: 'checkout-item', item: { kind: 'storage', id: 'rack' }, dueAt: 150, reason: 'Work' },
  ]);
  expect(act(checked, consume, 'alice')).toMatchObject({ ok: true });
  expect(act(checked, consume, 'bob')).toMatchObject({ ok: false, code: 'ITEM_CHECKED_OUT' });
  const transit = organizationCommands(organizationFixture(), [
    {
      kind: 'start-item-transit',
      item: { kind: 'storage', id: 'rack' },
      destination: { kind: 'root' },
      reason: 'Moving',
    },
  ]);
  expect(act(transit)).toMatchObject({ ok: false, code: 'ITEM_IN_TRANSIT' });
  const quarantined = organizationCommands(organizationFixture(), [
    { kind: 'set-quality', stockId: 'stock', quality: 'quarantined', reason: 'Quality hold' },
  ]);
  expect(act(quarantined)).toMatchObject({ ok: false });
  const expired = organizationCommands(organizationFixture(), [
    {
      kind: 'record-validity-decision',
      id: 'expiry',
      owner: { kind: 'stock', stockId: 'stock' },
      rule: { kind: 'absolute', deadlineAt: 110 },
      sourceText: 'Expiry',
      sourcePrecision: 'unknown',
      source: null,
      reason: 'Policy',
    },
  ]);
  expect(act(expired, consume, 'alice', 110)).toMatchObject({
    ok: false,
    code: 'MATERIAL_EXPIRED',
  });
});
it('retains an open incident blocker through the shared physical owner', () => {
  const f = recordedEquipmentIncidentFixture();
  const state = structuredClone(f.recorded);
  const rewrite = (v: unknown): void => {
    if (!v || typeof v !== 'object') return;
    for (const [key, value] of Object.entries(v)) {
      if (
        key === 'by' &&
        value &&
        typeof value === 'object' &&
        'kind' in value &&
        value.kind === 'local-profile'
      )
        Reflect.set(v, key, organizationContext().principal);
      else rewrite(value);
    }
  };
  rewrite(state);
  const result = applyInventoryOrganizationAction(state, {
    target: organizationTarget,
    expectedRevision: state.revision,
    action: { ...consume, quantity: { value: '1', unit: 'uL' } },
    context: organizationContext(),
    admittedMaterialIds: [],
  });
  expect(result).toMatchObject({ ok: false, code: 'INCIDENT_REVIEW_REQUIRED' });
});
it('local commands reject an organization context even without actor-bearing records', () => {
  expect(
    applyInventoryCommandBatch(
      organizationFixture(),
      { expectedRevision: 1, commands: [consume] },
      organizationContext() as never
    )
  ).toMatchObject({ ok: false, code: 'INVALID_INVENTORY_INPUT' });
});

it('validates setup reason directly while preserving exact allowed text', () => {
  const reason = '  Completed setup: µL\nOperator report  ';
  const parsed = parseInventoryOrganizationAction({ ...organizationBootstrap, reason });
  expect(parsed.kind === 'bootstrap' && parsed.reason).toBe(reason);
  for (const reason of ['', '   ', 'x'.repeat(2001), 'nul\u0000text'])
    expect(() => parseInventoryOrganizationAction({ ...organizationBootstrap, reason })).toThrow();
});
