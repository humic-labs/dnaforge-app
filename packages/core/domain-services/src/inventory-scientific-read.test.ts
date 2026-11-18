import { expect, it } from 'vitest';
import { inventoryScientificWorksForContext } from './inventory-scientific-read';
import type { InventoryScientificWork } from './inventory-scientific-types';

function work(
  id: string,
  at: number,
  context: InventoryScientificWork['context']
): InventoryScientificWork {
  const stock = {
    id: 'source',
    vesselId: 'vessel',
    materialId: 'material',
    source: { kind: 'unattributed' as const, rootStockId: 'source' },
    quantity: { kind: 'known' as const, value: '20', unit: 'uL' as const },
    quality: 'usable' as const,
    composition: { kind: 'unknown' as const },
    lotConstraints: { knowledge: 'legacy-partial' as const, lotIds: [] },
    opening: { kind: 'unobserved' as const, observationId: null },
    validity: { kind: 'legacy-untracked' as const },
    inheritedValidity: [],
  };
  return {
    id,
    at,
    context,
    identity: { namespace: 'manual', workId: id },
    intentSha256: `sha256:${'a'.repeat(64)}`,
    observation: { kind: 'completed-manual-transfer' },
    transfer: {
      kind: 'transfer',
      sourceStockId: 'source',
      quantity: { value: '10', unit: 'uL' },
      destination: { kind: 'new-stock', stockId: 'aliquot', vesselId: 'well' },
      reason: 'Observed manual transfer',
    },
    effects: {
      source: {
        before: stock,
        after: { ...stock, quantity: { ...stock.quantity, value: '10' } },
        vessel: {
          id: 'vessel',
          kind: 'movable',
          name: 'Saved tube name',
          placement: { kind: 'unplaced' },
        },
      },
      destination: {
        before: null,
        after: {
          ...stock,
          id: 'aliquot',
          vesselId: 'well',
          quantity: { ...stock.quantity, value: '10' },
        },
        vessel: {
          id: 'well',
          kind: 'fixed-well',
          name: 'A2',
          placement: { kind: 'located', storageId: 'plate', slotId: 'A2' },
        },
      },
    },
    by: { kind: 'local-profile', profileKey: 'a'.repeat(64) },
    reason: 'Observed manual transfer',
  };
}
const context = {
  kind: 'protocol-run' as const,
  projectId: 'project',
  workspaceScope: 'project',
  entityId: 'project::run',
  source: {
    kind: 'native-observed-saved-source' as const,
    sha256: `sha256:${'b'.repeat(64)}` as const,
    fileObjectUuid: 'old-file-binding',
    title: 'Same saved title',
  },
};
const identity = {
  projectId: 'project',
  workspaceScope: 'project',
  kind: 'protocol-run' as const,
  entityId: 'project::run',
};
it('matches exact original kind, project, scope and identity without rebinding same-title foreign history', () => {
  const rows = [
    work('exact', 1, context),
    work('other-run', 1, { ...context, entityId: 'project::other-run' }),
    work('foreign-project', 1, { ...context, projectId: 'foreign' }),
    work('foreign-scope', 1, { ...context, workspaceScope: 'foreign' }),
    work('notebook', 1, { ...context, kind: 'notebook-page', pageId: context.entityId }),
  ];
  const state = { scientificWorks: Object.fromEntries(rows.map((row) => [row.id, row])) };
  expect(inventoryScientificWorksForContext(state, identity).map((row) => row.id)).toEqual([
    'exact',
  ]);
  expect(
    inventoryScientificWorksForContext(state, { ...identity, kind: 'notebook-page' }).map(
      (row) => row.id
    )
  ).toEqual(['notebook']);
});
it('orders equal native times by exact ID and returns independent historical facts without current-source access', () => {
  const rows = [work('z', 2, context), work('a', 2, context), work('earlier', 1, context)];
  const state = { scientificWorks: Object.fromEntries(rows.map((row) => [row.id, row])) };
  const before = JSON.stringify(state);
  const found = inventoryScientificWorksForContext(state, identity);
  expect(found.map((row) => row.id)).toEqual(['earlier', 'a', 'z']);
  expect(found[0]).toEqual(rows[2]);
  (found[0].effects.source.before as { materialId: string }).materialId = 'changed-copy';
  expect(JSON.stringify(state)).toBe(before);
});
