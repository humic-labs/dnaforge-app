import { expect, it } from 'vitest';
import type { InventoryItemCodeLookupSnapshot } from '../../shared/inventory-client';
import { inventoryExpectedItemCode } from './inventory-item-code-view';

it('compares project, inventory and the full tagged item rather than a bare identifier', () => {
  const lookup: InventoryItemCodeLookupSnapshot = {
    projectId: 'project',
    inventoryId: 'inventory',
    revision: 1,
    asOf: 1,
    principal: { kind: 'agent', identityId: 'synthetic-agent' },
    resolution: {
      kind: 'resolved',
      match: {
        id: 'code',
        namespace: 'lab',
        value: '00123',
        item: { kind: 'vessel', id: 'same-id' },
        assignedAt: 1,
        assignedBy: { kind: 'agent', identityId: 'synthetic-agent' },
        reason: 'Synthetic label',
        lifecycle: { kind: 'active' },
      },
    },
    targets: [],
  };
  const expected = {
    projectId: 'project',
    inventoryId: 'inventory',
    item: { kind: 'vessel' as const, id: 'same-id' },
  };
  expect(inventoryExpectedItemCode(lookup, expected)).toBe(true);
  expect(inventoryExpectedItemCode(lookup, { ...expected, projectId: 'other' })).toBe(false);
  expect(inventoryExpectedItemCode(lookup, { ...expected, inventoryId: 'other' })).toBe(false);
  expect(
    inventoryExpectedItemCode(lookup, { ...expected, item: { kind: 'storage', id: 'same-id' } })
  ).toBe(false);
  expect(
    inventoryExpectedItemCode(
      { ...lookup, resolution: { kind: 'ambiguous', matches: [] } },
      expected
    )
  ).toBeNull();
});
