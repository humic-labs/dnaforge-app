import { expect, it } from 'vitest';
import { applyInventoryCommandBatch, createInventoryState, parseInventoryState } from './inventory';
import {
  inventoryEquipmentCatalog,
  inventoryEquipmentCatalogMissingDefinitions,
  type InventoryEquipmentCatalogEntry,
} from './inventory-equipment-catalog';
import type { InventoryCommand, InventoryState } from './inventory-types';

function apply(state: InventoryState, commands: readonly InventoryCommand[]): InventoryState {
  const result = applyInventoryCommandBatch(
    state,
    { expectedRevision: state.revision, commands },
    {
      at: state.lastRecordedAt + 1,
      principal: { kind: 'agent', identityId: 'catalog-acceptance' },
      authority: { kind: 'local-profile', profileKey: 'catalog-profile' },
    }
  );
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  expect(parseInventoryState(result.state)).toEqual(result.state);
  return result.state;
}
function install(state: InventoryState, entry: InventoryEquipmentCatalogEntry, suffix: number) {
  const recipe = entry.definitions.find(
    (definition) => definition.kind === 'define-equipment-recipe'
  );
  if (!recipe || recipe.kind !== 'define-equipment-recipe')
    throw new Error('Missing catalog recipe.');
  return apply(state, [
    ...inventoryEquipmentCatalogMissingDefinitions(state, entry),
    {
      kind: 'instantiate-equipment-recipe',
      recipeVersionId: entry.recipeVersionId,
      name: `Catalog acceptance ${suffix}`,
      destination: { kind: 'root' },
      components: recipe.components.map((component) => ({
        key: component.key,
        id: `catalog-instance-${suffix}:${component.key}`,
        metadata: {},
      })),
      reason: 'Synthetic catalog recipe acceptance; no physical qualification.',
    },
  ]);
}

it('installs curated alternatives without stock or invented boxes and reuses identical definitions', () => {
  let state = createInventoryState();
  for (const [index, entry] of inventoryEquipmentCatalog().entries()) {
    const beforeIds = new Set(Object.keys(state.storage));
    state = install(state, entry, index);
    const added = Object.values(state.storage).filter((item) => !beforeIds.has(item.id));
    const boxPositions = added
      .filter((item) => item.configuration.recipe?.componentKey !== 'freezer')
      .reduce(
        (total, item) => total + (item.layout.kind === 'named' ? item.layout.slots.length : 0),
        0
      );
    expect(boxPositions).toBe(entry.boxPositions);
    expect(state.vessels).toEqual({});
    expect(state.stocks).toEqual({});
    expect(inventoryEquipmentCatalogMissingDefinitions(state, entry)).toEqual([]);
  }
});

it('keeps source-backed alternatives and heterogeneous rack counts distinct', () => {
  const catalog = inventoryEquipmentCatalog();
  const thermo2 = catalog.find((entry) => entry.id === 'catalog:thermo:tsx60086:920090')!;
  const thermo3 = catalog.find((entry) => entry.id === 'catalog:thermo:tsx60086:920091')!;
  expect(thermo2.boxPositions).toBe(600);
  expect(thermo3.boxPositions).toBe(360);
  const eppendorf = catalog.find(
    (entry) => entry.id === 'catalog:eppendorf:f740hi:5c:drawer:53mm'
  )!;
  const state = install(createInventoryState(), eppendorf, 100);
  const racks = Object.values(state.storage).filter(
    (item) => item.configuration.recipe?.componentKey !== 'freezer'
  );
  expect(
    racks.filter(
      (item) => item.configuration.typeVersionId === 'catalog:eppendorf:rack:6001022210:v1'
    )
  ).toHaveLength(24);
  expect(
    racks.filter(
      (item) => item.configuration.typeVersionId === 'catalog:eppendorf:rack:6001082210:v1'
    )
  ).toHaveLength(6);
  expect(eppendorf.boxPositions).toBe(528);
  expect(eppendorf.nominalBoxClass).toContain('53 mm');
  expect(thermo2.nominalBoxClass).toContain('5.08 cm');
});

it('refuses semantic existing-ID conflicts instead of selecting a different definition', () => {
  const entry = inventoryEquipmentCatalog()[0];
  const first = entry.definitions[0];
  if (first.kind !== 'define-physical-type') throw new Error('Expected physical type.');
  const state = apply(createInventoryState(), [{ ...first, name: 'Different local definition' }]);
  const before = JSON.stringify(state);
  expect(() => inventoryEquipmentCatalogMissingDefinitions(state, entry)).toThrow('differs');
  expect(JSON.stringify(state)).toBe(before);
});

it('reuses a catalog type after exact input dimensions normalize to millimeters', () => {
  const entry = structuredClone(inventoryEquipmentCatalog()[0]);
  const first = entry.definitions[0];
  if (first.kind !== 'define-physical-type') throw new Error('Expected physical type.');
  const equivalent = {
    ...first,
    definition: {
      ...first.definition,
      geometry: {
        ...first.definition.geometry,
        external: {
          ...first.definition.geometry.external,
          width: { kind: 'known' as const, value: '1', unit: 'cm' as const },
        },
      },
    },
  };
  const custom = { ...entry, definitions: [equivalent] };
  const state = apply(createInventoryState(), custom.definitions);
  expect(inventoryEquipmentCatalogMissingDefinitions(state, custom)).toEqual([]);
  expect(state.typeVersions[first.id].definition.geometry.external.width).toEqual({
    kind: 'known',
    value: '10',
    unit: 'mm',
  });
  const parsed = parseInventoryState(JSON.parse(JSON.stringify(state)));
  const geometry = parsed.typeVersions[first.id].definition.geometry;
  Object.assign(geometry.external, { width: { kind: 'known', value: '1.00', unit: 'cm' } });
  const before = JSON.stringify(parsed);
  expect(inventoryEquipmentCatalogMissingDefinitions(parseInventoryState(parsed), custom)).toEqual(
    []
  );
  expect(JSON.stringify(parsed)).toBe(before);
  Object.assign(geometry.external, { width: { kind: 'known', value: '1.1', unit: 'cm' } });
  expect(() =>
    inventoryEquipmentCatalogMissingDefinitions(parseInventoryState(parsed), custom)
  ).toThrow('differs');
});

it('keeps conflicting F740h exterior depth unknown with both source scopes', () => {
  const entry = inventoryEquipmentCatalog().find(
    (item) => item.id === 'catalog:eppendorf:f740h:3c:drawer:53mm'
  )!;
  const root = entry.definitions.find(
    (item) => item.kind === 'define-physical-type' && item.id.includes(':f740h:')
  );
  if (!root || root.kind !== 'define-physical-type') throw new Error('Expected F740h type.');
  expect(root.definition.geometry.external.depth).toEqual({ kind: 'unknown' });
  expect(root.sources.some((source) => source.locator.includes('91.3 cm'))).toBe(true);
  expect(root.sources.some((source) => source.sha256 !== null)).toBe(true);
});

it('detaches separate catalog entries and subsequent reads from an edited caller draft', () => {
  const catalog = inventoryEquipmentCatalog();
  const first = catalog[0].definitions[0],
    second = catalog[1].definitions[0];
  if (first.kind !== 'define-physical-type' || second.kind !== 'define-physical-type')
    throw new Error('Expected types.');
  const original = second.name;
  (first as { name: string }).name = 'Edited caller draft';
  expect(second.name).toBe(original);
  const fresh = inventoryEquipmentCatalog()[0].definitions[0];
  expect(fresh.kind === 'define-physical-type' ? fresh.name : null).toBe(original);
});
