import { expect, it } from 'vitest';
import { inventoryOrganizationAdmissionBoundary } from './inventory-admission-time';
import { organizationCommands, organizationFixture } from './inventory-organization.fixtures';
import { createInventoryState } from './inventory-types';
it('uses the earliest aggregate validity/reservation/custody boundary, including after opening', () => {
  const state = organizationCommands(organizationFixture(), [
    {
      kind: 'record-stock-opening',
      id: 'opened',
      stockId: 'stock',
      value: 'opened',
      observedAt: 95,
      source: null,
      reason: 'Observed',
    },
    {
      kind: 'record-validity-decision',
      id: 'validity',
      owner: { kind: 'stock', stockId: 'stock' },
      rule: { kind: 'after-opening', openingStockId: 'stock', elapsedMs: 25 },
      sourceText: 'Use within window',
      sourcePrecision: 'unknown',
      source: null,
      reason: 'Policy',
    },
    {
      kind: 'reserve-quantity',
      id: 'hold',
      stockId: 'stock',
      quantity: { value: '1', unit: 'uL' },
      deadline: 115,
      purpose: 'Reserved',
    },
    { kind: 'checkout-item', item: { kind: 'storage', id: 'rack' }, dueAt: 110, reason: 'Work' },
  ]);
  expect(inventoryOrganizationAdmissionBoundary(state, state, 100)).toBe(110);
  expect(inventoryOrganizationAdmissionBoundary(state, state, 110)).toBe(115);
  expect(inventoryOrganizationAdmissionBoundary(state, state, 115)).toBe(120);
  expect(inventoryOrganizationAdmissionBoundary(state, state, 120)).toBeNull();
  expect(state.reservations.hold.lifecycle.kind).toBe('active');
});
it('includes inherited lot deadlines and both endpoint states conservatively', () => {
  const state = organizationCommands(organizationFixture(), [
    {
      kind: 'create-lot',
      id: 'lot',
      name: 'Lot',
      materialId: 'material',
      origin: { kind: 'received', supplier: 'Supplier', lotNumber: '1' },
    },
    {
      kind: 'record-validity-decision',
      id: 'validity',
      owner: { kind: 'lot', lotId: 'lot' },
      rule: { kind: 'absolute', deadlineAt: 130 },
      sourceText: 'Expiry',
      sourcePrecision: 'unknown',
      source: null,
      reason: 'Policy',
    },
    { kind: 'associate-stock-lot', stockId: 'stock', lotId: 'lot', reason: 'Known source' },
  ]);
  expect(inventoryOrganizationAdmissionBoundary(state, state, 100)).toBe(130);
  const final = organizationFixture();
  expect(inventoryOrganizationAdmissionBoundary(state, final, 100)).toBe(130);
  expect(inventoryOrganizationAdmissionBoundary(createInventoryState(), final, 100)).toBeNull();
  expect(() => inventoryOrganizationAdmissionBoundary(state, final, 99)).toThrow();
});
