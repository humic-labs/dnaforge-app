import { describe, expect, it } from 'vitest';
import {
  applyInventoryCommandBatch,
  createInventoryState,
  inventoryAvailability,
  inventoryCatalogProjection,
  inventoryCatalogRecipeEligibility,
  inventoryCatalogTypeAdoption,
  inventoryCatalogVersionStatus,
  inventoryCommandJsonSchema,
  parseInventoryCommand,
  parseInventoryState,
  unknownInventoryGeometry,
  type InventoryCatalogTarget,
  type InventoryCommand,
  type InventoryState,
} from './inventory';

const actor = {
  at: 10,
  principal: { kind: 'agent' as const, identityId: 'alice' },
  authority: { kind: 'local-profile' as const, profileKey: 'profile' },
};
const typeTarget = (versionId: string): InventoryCatalogTarget => ({
  kind: 'type-version',
  versionId,
});
const recipeTarget = (versionId = 'recipe-v1'): InventoryCatalogTarget => ({
  kind: 'recipe-version',
  versionId,
});
const retire = (target: InventoryCatalogTarget): InventoryCommand => ({
  kind: 'retire-catalog-version',
  target,
  reason: 'Withdraw new selections',
});
const restore = (target: InventoryCatalogTarget): InventoryCommand => ({
  kind: 'restore-catalog-version',
  target,
  reason: 'Restore exact published version',
});
function apply(state: InventoryState, ...commands: InventoryCommand[]): InventoryState {
  const result = applyInventoryCommandBatch(
    state,
    { expectedRevision: state.revision, commands },
    { ...actor, at: state.lastRecordedAt + 1 }
  );
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  expect(parseInventoryState(result.state)).toEqual(result.state);
  return result.state;
}
function refused(state: InventoryState, code: string, ...commands: InventoryCommand[]): void {
  const before = JSON.stringify(state);
  expect(
    applyInventoryCommandBatch(
      state,
      { expectedRevision: state.revision, commands },
      { ...actor, at: state.lastRecordedAt + 1 }
    )
  ).toMatchObject({ ok: false, code });
  expect(JSON.stringify(state)).toBe(before);
}
function typeDefinition(
  id: string,
  typeId = id
): Extract<InventoryCommand, { kind: 'define-physical-type' }> {
  return {
    kind: 'define-physical-type',
    id,
    typeId,
    name: id,
    description: '',
    fields: [{ key: 'notes', label: 'Notes', type: 'text' }],
    sources: [],
    definition: {
      kind: 'storage',
      layout: { kind: 'named', slots: ['A', 'B'] },
      childPolicy: { kind: 'any-legal' },
      positionRules: {},
      geometry: unknownInventoryGeometry(),
    },
  };
}
function install(
  recipeVersionId = 'recipe-v1',
  suffix = 'new',
  keys = ['root', 'rack', 'tube']
): InventoryCommand {
  return {
    kind: 'instantiate-equipment-recipe',
    recipeVersionId,
    name: suffix,
    components: keys.map((key) => ({ key, id: `${suffix}-${key}`, metadata: {} })),
    destination: { kind: 'root' },
    reason: 'Install actual selected components',
  };
}
function fixture(): InventoryState {
  return apply(
    createInventoryState(),
    typeDefinition('outer-v1', 'outer'),
    typeDefinition('rack-v1', 'rack'),
    {
      ...typeDefinition('tube-v1', 'tube'),
      definition: {
        kind: 'vessel',
        mobility: 'movable',
        limits: {
          capacity: { kind: 'known', value: '200', unit: 'uL' },
          deadVolume: { kind: 'known', value: '0', unit: 'uL' },
        },
        geometry: unknownInventoryGeometry(),
      },
    },
    {
      kind: 'define-equipment-recipe',
      id: 'recipe-v1',
      recipeId: 'recipe',
      name: 'Recipe',
      description: '',
      model: {
        manufacturer: 'Custom',
        model: 'Equipment',
        partNumber: null,
        region: null,
        revision: null,
      },
      sources: [],
      components: [
        {
          key: 'root',
          parentKey: null,
          positionId: null,
          name: 'Outer',
          typeVersionId: 'outer-v1',
        },
        { key: 'rack', parentKey: 'root', positionId: 'A', name: 'Rack', typeVersionId: 'rack-v1' },
        { key: 'tube', parentKey: 'rack', positionId: 'A', name: 'Tube', typeVersionId: 'tube-v1' },
      ],
    },
    install('recipe-v1', 'existing'),
    {
      kind: 'receive-stock',
      id: 'stock',
      vesselId: 'existing-tube',
      materialId: 'material',
      quantity: { kind: 'known', value: '100', unit: 'uL' },
      quality: 'usable',
    },
    {
      kind: 'reserve-quantity',
      id: 'hold',
      stockId: 'stock',
      quantity: { value: '40', unit: 'uL' },
      deadline: null,
      purpose: 'Preserved allocation',
    }
  );
}

describe('catalog selection lifecycle', () => {
  it('keeps the highest published head current when retired and permits explicit available older versions', () => {
    let state = fixture();
    state = apply(state, typeDefinition('rack-v2', 'rack'), retire(typeTarget('rack-v2')));
    expect(inventoryCatalogVersionStatus(state, typeTarget('rack-v2'))).toMatchObject({
      relationship: 'current',
      headVersionId: 'rack-v2',
      selection: { kind: 'retired' },
      eligibility: { kind: 'blocked' },
      actions: { retire: false, restore: true },
    });
    expect(inventoryCatalogVersionStatus(state, typeTarget('rack-v1'))).toMatchObject({
      relationship: 'superseded',
      headVersionId: 'rack-v2',
      selection: { kind: 'available' },
      eligibility: { kind: 'selectable' },
    });
    const installed = apply(state, {
      kind: 'instantiate-physical-type',
      typeVersionId: 'rack-v1',
      id: 'explicit-old',
      name: 'Explicit older version',
      destination: { kind: 'root' },
      metadata: {},
      reason: 'Choose exact superseded version',
    });
    expect(installed.storage['explicit-old'].configuration.typeVersionId).toBe('rack-v1');
    refused(state, 'CATALOG_VERSION_RETIRED', {
      kind: 'instantiate-physical-type',
      typeVersionId: 'rack-v2',
      id: 'blocked',
      name: 'Blocked',
      destination: { kind: 'root' },
      metadata: {},
      reason: 'Attempt',
    });
  });
});

it('changes selection alone without retiring, moving or releasing installed contents', () => {
  const before = fixture(),
    state = apply(before, retire(typeTarget('tube-v1')), retire(recipeTarget()));
  expect(state.typeVersions['tube-v1'].selection).toEqual({
    kind: 'retired',
    at: 2,
    by: actor.principal,
    reason: 'Withdraw new selections',
  });
  expect(state.storage).toEqual(before.storage);
  expect(state.vessels).toEqual(before.vessels);
  expect(state.stocks).toEqual(before.stocks);
  expect(state.reservations).toEqual(before.reservations);
  expect(state.typeVersions['tube-v1']).toEqual({
    ...before.typeVersions['tube-v1'],
    selection: state.typeVersions['tube-v1'].selection,
  });
  const used = apply(state, {
    kind: 'consume',
    stockId: 'stock',
    quantity: { value: '10', unit: 'uL' },
    reason: 'Use existing material',
  });
  expect(used.stocks.stock.quantity).toEqual({ kind: 'known', value: '90', unit: 'uL' });
  expect(used.reservations).toEqual(state.reservations);
});

it('allows same-pin configuration edits while refusing new adoption of the retired version', () => {
  let state = apply(fixture(), retire(typeTarget('tube-v1')), {
    kind: 'create-vessel',
    id: 'untyped',
    name: 'Untyped',
    placement: { kind: 'unplaced' },
  });
  const configuration = {
    kind: 'configure-item' as const,
    item: { kind: 'vessel' as const, id: 'existing-tube' },
    typeVersionId: 'tube-v1',
    metadata: { notes: 'Changed notes' },
    orientation: { kind: 'known' as const, quarterTurns: 1 as const },
    unavailablePositions: {},
    reason: 'Edit existing exact pin',
  };
  expect(inventoryCatalogTypeAdoption(state, configuration.item, 'tube-v1')).toEqual({
    kind: 'selectable',
  });
  expect(
    inventoryCatalogTypeAdoption(state, { kind: 'vessel', id: 'untyped' }, 'tube-v1')
  ).toMatchObject({ kind: 'blocked' });
  state = apply(state, configuration);
  expect(state.vessels['existing-tube'].configuration.metadata).toEqual({ notes: 'Changed notes' });
  refused(state, 'CATALOG_VERSION_RETIRED', {
    ...configuration,
    item: { kind: 'vessel', id: 'untyped' },
  });
  expect(inventoryCatalogTypeAdoption(state, { kind: 'vessel', id: 'untyped' }, null)).toEqual({
    kind: 'selectable',
  });
});

it('derives full recipe blockers but permits omission of optional retired components', () => {
  const state = apply(fixture(), retire(typeTarget('rack-v1')));
  expect(inventoryCatalogVersionStatus(state, recipeTarget())?.eligibility).toEqual({
    kind: 'blocked',
    blockers: [
      { code: 'CATALOG_DEPENDENCY_RETIRED', target: recipeTarget(), typeVersionIds: ['rack-v1'] },
    ],
  });
  expect(inventoryCatalogVersionStatus(state, recipeTarget(), ['root'])?.eligibility).toEqual({
    kind: 'selectable',
  });
  expect(inventoryCatalogVersionStatus(state, recipeTarget(), ['tube'])?.eligibility).toMatchObject(
    { kind: 'blocked' }
  );
  const shell = apply(state, install('recipe-v1', 'shell', ['root']));
  expect(shell.storage['shell-root']).toBeDefined();
  expect(shell.storage['shell-rack']).toBeUndefined();
  refused(state, 'CATALOG_DEPENDENCY_RETIRED', install());
  refused(state, 'INVALID_PLACEMENT', install('recipe-v1', 'missing-parent', ['root', 'tube']));
});

it('restoring a recipe does not restore retired selected component types', () => {
  const state = apply(fixture(), retire(recipeTarget()), retire(typeTarget('tube-v1')));
  refused(state, 'CATALOG_VERSION_RETIRED', install('recipe-v1', 'shell', ['root']));
  const restored = apply(state, restore(recipeTarget()));
  expect(restored.recipeVersions['recipe-v1'].selection).toEqual({ kind: 'available' });
  expect(restored.typeVersions['tube-v1'].selection.kind).toBe('retired');
  refused(restored, 'CATALOG_DEPENDENCY_RETIRED', install());
  const installed = apply(restored, restore(typeTarget('tube-v1')), install());
  expect(installed.vessels['new-tube'].configuration.typeVersionId).toBe('tube-v1');
  expect(installed.vessels['existing-tube']).toEqual(state.vessels['existing-tube']);
});

it('publishing successors never restores predecessors or changes installed pins', () => {
  let state = apply(fixture(), retire(typeTarget('rack-v1')), retire(recipeTarget()));
  const before = state;
  const {
    selection: _,
    publishedAt: _at,
    publishedBy: _by,
    version: _version,
    ...recipe
  } = state.recipeVersions['recipe-v1'];
  state = apply(state, typeDefinition('rack-v2', 'rack'), {
    ...recipe,
    kind: 'define-equipment-recipe',
    id: 'recipe-v2',
  });
  expect(state.typeVersions['rack-v1'].selection.kind).toBe('retired');
  expect(state.recipeVersions['recipe-v1'].selection.kind).toBe('retired');
  expect(state.recipeVersions['recipe-v2'].selection).toEqual({ kind: 'available' });
  expect(state.storage).toEqual(before.storage);
  expect(inventoryCatalogVersionStatus(state, recipeTarget())?.relationship).toBe('superseded');
});

it('refuses invalid transitions and rolls back earlier changes in the same batch', () => {
  const state = fixture();
  refused(state, 'INVALID_CATALOG_TRANSITION', restore(typeTarget('rack-v1')));
  refused(
    state,
    'INVALID_CATALOG_TRANSITION',
    retire(typeTarget('rack-v1')),
    retire(typeTarget('rack-v1'))
  );
  refused(state, 'CATALOG_DEPENDENCY_RETIRED', retire(typeTarget('rack-v1')), install());
  refused(state, 'INVALID_INVENTORY_INPUT', retire(typeTarget('missing')));
  refused(state, 'INVALID_INVENTORY_INPUT', retire(recipeTarget('rack-v1')));
});

it('requires trusted context and its nondecreasing clock', () => {
  const state = fixture(),
    command = retire(typeTarget('rack-v1'));
  expect(
    applyInventoryCommandBatch(state, { expectedRevision: state.revision, commands: [command] })
  ).toMatchObject({ ok: false, code: 'CONTEXT_REQUIRED' });
  expect(
    applyInventoryCommandBatch(
      state,
      { expectedRevision: state.revision, commands: [command] },
      { ...actor, at: 0 }
    )
  ).toMatchObject({ ok: false, code: 'CLOCK_REGRESSION' });
});

it('exports independent detached status and lifecycle facts for native availability', () => {
  const state = apply(fixture(), retire(typeTarget('tube-v1')));
  const before = JSON.stringify(state),
    projection = inventoryCatalogProjection(state);
  expect(
    inventoryAvailability(state, actor.principal, state.lastRecordedAt).physical.catalog
  ).toEqual(projection);
  const selection = projection.typeVersions['tube-v1'].selection;
  if (selection.kind !== 'retired') throw new Error('Fixture');
  (selection as { reason: string }).reason = 'Caller edited projection';
  expect(JSON.stringify(state)).toBe(before);
  expect(inventoryCatalogVersionStatus(state, typeTarget('missing'))).toBeNull();
});

it('keeps prospective eligibility explicit without invented publication timestamps or actors', () => {
  const state = apply(fixture(), retire(typeTarget('rack-v1'))),
    components = state.recipeVersions['recipe-v1'].components;
  expect(inventoryCatalogVersionStatus(state, recipeTarget('prospective'))).toBeNull();
  expect(inventoryCatalogRecipeEligibility(state, 'prospective', components)).toMatchObject({
    kind: 'blocked',
  });
  expect(inventoryCatalogRecipeEligibility(state, 'prospective', components, ['root'])).toEqual({
    kind: 'selectable',
  });
  expect(
    inventoryCatalogRecipeEligibility(state, 'prospective', [
      { ...components[0], typeVersionId: 'prospective-type' },
    ])
  ).toEqual({ kind: 'selectable' });
});

it('keeps strict reason-bearing command shapes and rejects caller-authored lifecycle authority', () => {
  for (const command of [retire(typeTarget('tube-v1')), restore(recipeTarget())]) {
    expect(parseInventoryCommand(command)).toEqual(command);
    expect(() =>
      parseInventoryCommand({ ...command, target: { kind: 'type-version', id: 'tube-v1' } })
    ).toThrow();
    expect(() => parseInventoryCommand({ ...command, reason: '' })).toThrow();
    expect(() => parseInventoryCommand({ ...command, at: 99, by: actor.principal })).toThrow();
  }
  const schema = JSON.stringify(inventoryCommandJsonSchema());
  expect(schema).toContain('retire-catalog-version');
  expect(schema).toContain('restore-catalog-version');
});
