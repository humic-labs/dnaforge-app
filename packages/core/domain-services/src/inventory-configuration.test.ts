import { describe, expect, it } from 'vitest';
import {
  applyInventoryCommandBatch,
  createInventoryState,
  inventoryAvailability,
  inventoryPlacementCompatibility,
  inventoryWellId,
  parseInventoryState,
  parseInventoryCommandBatch,
  unknownInventoryGeometry,
  type InventoryCommand,
  type InventoryGeometry,
  type InventoryState,
  type InventoryPhysicalItem,
} from './inventory';
const actor = {
  at: 10,
  principal: { kind: 'agent' as const, identityId: 'alice' },
  authority: { kind: 'local-profile' as const, profileKey: 'profile' },
};
const rack: InventoryPhysicalItem = { kind: 'storage', id: 'rack' },
  tube: InventoryPhysicalItem = { kind: 'vessel', id: 'tube' };
function apply(state: InventoryState, ...commands: InventoryCommand[]): InventoryState {
  const result = applyInventoryCommandBatch(
    state,
    { expectedRevision: state.revision, commands },
    actor
  );
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  expect(parseInventoryState(result.state)).toEqual(result.state);
  return result.state;
}
function refused(state: InventoryState, command: InventoryCommand, code: string): void {
  const bytes = JSON.stringify(state);
  expect(
    applyInventoryCommandBatch(
      state,
      { expectedRevision: state.revision, commands: [command] },
      actor
    )
  ).toMatchObject({ ok: false, code });
  expect(JSON.stringify(state)).toBe(bytes);
}
function definitions(): InventoryCommand[] {
  return [
    {
      kind: 'define-physical-type',
      id: 'tube-v1',
      typeId: 'tube-type',
      name: 'Tube',
      description: '',
      fields: [{ key: 'note', label: 'Note', type: 'text' }],
      sources: [],
      definition: {
        kind: 'vessel',
        mobility: 'movable',
        limits: {
          capacity: { kind: 'known', value: '200', unit: 'uL' },
          deadVolume: { kind: 'unknown' },
        },
        geometry: unknownInventoryGeometry(),
      },
    },
    {
      kind: 'define-physical-type',
      id: 'rack-v1',
      typeId: 'rack-type',
      name: 'Rack',
      description: '',
      fields: [],
      sources: [],
      definition: {
        kind: 'storage',
        layout: { kind: 'named', slots: ['A', 'B'] },
        childPolicy: { kind: 'types', typeIds: ['tube-type'] },
        positionRules: {},
        geometry: unknownInventoryGeometry(),
      },
    },
  ];
}
function fixture(): InventoryState {
  return apply(
    createInventoryState(),
    ...definitions(),
    {
      kind: 'instantiate-physical-type',
      typeVersionId: 'rack-v1',
      id: 'rack',
      name: 'Installed rack',
      destination: { kind: 'root' },
      metadata: {},
      reason: 'Install',
    },
    {
      kind: 'instantiate-physical-type',
      typeVersionId: 'tube-v1',
      id: 'tube',
      name: 'Tube',
      destination: { kind: 'located', storageId: 'rack', slotId: 'A' },
      metadata: { note: 'First' },
      reason: 'Install',
    }
  );
}
function configure(
  state: InventoryState,
  item: InventoryPhysicalItem,
  metadata: Record<string, string | number | boolean | readonly string[] | null> = {}
): InventoryCommand {
  const row = item.kind === 'storage' ? state.storage[item.id] : state.vessels[item.id];
  return {
    kind: 'configure-item',
    item,
    typeVersionId: row.configuration.typeVersionId,
    metadata,
    orientation: row.configuration.orientation,
    unavailablePositions: row.configuration.unavailablePositions,
    reason: 'Configure',
  };
}
function geometry(
  external: readonly [string, string, string] | null,
  usable: readonly [string, string, string] | null
): InventoryGeometry {
  const value = unknownInventoryGeometry();
  const dimensions = (tuple: readonly [string, string, string]) => ({
    width: { kind: 'known' as const, value: tuple[0], unit: 'mm' as const },
    height: { kind: 'known' as const, value: tuple[1], unit: 'mm' as const },
    depth: { kind: 'known' as const, value: tuple[2], unit: 'mm' as const },
  });
  return {
    external: external ? dimensions(external) : value.external,
    usable: usable ? dimensions(usable) : value.usable,
  };
}
const measure = (item: InventoryPhysicalItem, value: InventoryGeometry): InventoryCommand => ({
  kind: 'record-item-geometry',
  item,
  geometry: value,
  source: null,
  reason: 'Measured actual usable geometry',
});

describe('immutable physical type pins and instance edits', () => {
  it('accepts custom unknown fit without a gate and never invents stock', () => {
    const state = fixture();
    expect(Object.keys(state.stocks)).toEqual([]);
    expect(inventoryPlacementCompatibility(state, tube, 'rack', 'A')).toMatchObject({
      logical: 'allowed',
      fit: 'unknown',
    });
    expect(
      inventoryAvailability(state, actor.principal, 10).physical.items.tube.configuration
        .typeVersionId
    ).toBe('tube-v1');
  });
  it('publishes versions without changing existing pins, limits or values', () => {
    const state = fixture(),
      definition = definitions()[0];
    if (definition.kind !== 'define-physical-type') throw new Error('Fixture');
    const newer = apply(state, {
      ...definition,
      id: 'tube-v2',
      name: 'New tube fields',
      fields: [...definition.fields, { key: 'extra', label: 'Extra', type: 'boolean' }],
    });
    expect(newer.typeVersions['tube-v2'].version).toBe(2);
    expect(newer.vessels.tube).toEqual(state.vessels.tube);
    expect(newer.vessels.tube.limits.capacity).toMatchObject({ value: '200' });
    const second = apply(newer, {
      kind: 'instantiate-physical-type',
      typeVersionId: 'tube-v2',
      id: 'second',
      name: 'Second',
      metadata: { extra: false },
      destination: { kind: 'located', storageId: 'rack', slotId: 'B' },
      reason: 'Install newer allowed logical type',
    });
    expect(second.vessels.second.configuration.typeVersionId).toBe('tube-v2');
  });
  it('rejects unknown metadata, duplicate immutable IDs and disallowed child types atomically', () => {
    const state = fixture();
    refused(state, configure(state, tube, { unknown: 'value' }), 'INVALID_INVENTORY_INPUT');
    refused(state, definitions()[0], 'ID_ALREADY_EXISTS');
    refused(
      state,
      {
        kind: 'create-vessel',
        id: 'untyped',
        name: 'Unspecified tube',
        placement: { kind: 'located', storageId: 'rack', slotId: 'B' },
      },
      'INCOMPATIBLE_LAYOUT'
    );
  });
  it('preserves occupied positions and permanent well identities during installed-only layout edits', () => {
    const state = fixture();
    refused(
      state,
      {
        kind: 'reconfigure-storage',
        storageId: 'rack',
        layout: { kind: 'named', slots: ['B'] },
        reason: 'Remove A',
      },
      'SLOT_OCCUPIED'
    );
    const changed = apply(state, {
      kind: 'reconfigure-storage',
      storageId: 'rack',
      layout: { kind: 'named', slots: ['A', 'B', 'C'] },
      reason: 'Actual added bay',
    });
    expect(changed.typeVersions['rack-v1']).toEqual(state.typeVersions['rack-v1']);
    expect(changed.vessels.tube).toEqual(state.vessels.tube);
    expect(inventoryAvailability(changed, actor.principal, 10).physical.items.rack.customized).toBe(
      true
    );
    const plate = apply(state, {
      kind: 'create-layout-storage',
      id: 'plate',
      name: 'Plate',
      layout: { kind: 'fixed-well', rows: 8, columns: 12 },
      placement: { kind: 'root' },
    });
    refused(
      plate,
      {
        kind: 'reconfigure-storage',
        storageId: 'plate',
        layout: { kind: 'fixed-well', rows: 16, columns: 24 },
        reason: 'Different physical plate',
      },
      'FIXED_WELL_IMMUTABLE'
    );
    expect(plate.vessels[inventoryWellId('plate', 'A1')]).toBeDefined();
  });
  it('refuses disabling occupied positions but allows explicitly unavailable empty positions', () => {
    const state = fixture(),
      command = configure(state, rack);
    if (command.kind !== 'configure-item') throw new Error('Fixture');
    refused(state, { ...command, unavailablePositions: { A: 'Blocked' } }, 'INCOMPATIBLE_LAYOUT');
    const disabled = apply(state, {
      ...command,
      unavailablePositions: { B: 'Damaged insert position' },
    });
    refused(
      disabled,
      {
        kind: 'instantiate-physical-type',
        typeVersionId: 'tube-v1',
        id: 'blocked',
        name: 'Blocked',
        metadata: {},
        destination: { kind: 'located', storageId: 'rack', slotId: 'B' },
        reason: 'Try unavailable',
      },
      'INCOMPATIBLE_LAYOUT'
    );
  });
});

describe('exact geometry knowledge and scoped evidence', () => {
  it('retains truthful measured misfit and occupancy while refusing a new incompatible placement', () => {
    let state = fixture();
    state = apply(
      state,
      measure(tube, geometry(['20', '20', '20'], null)),
      measure(rack, geometry(null, ['10', '10', '10']))
    );
    expect(state.vessels.tube.placement).toMatchObject({ slotId: 'A' });
    expect(inventoryPlacementCompatibility(state, tube, 'rack', 'A').fit).toBe('incompatible');
    expect(state.typeVersions['rack-v1'].definition.geometry).toEqual(unknownInventoryGeometry());
    state = apply(state, { kind: 'move-vessel', id: 'tube', placement: { kind: 'unplaced' } });
    refused(
      state,
      {
        kind: 'move-vessel',
        id: 'tube',
        placement: { kind: 'located', storageId: 'rack', slotId: 'A' },
      },
      'INCOMPATIBLE_LAYOUT'
    );
  });
  it('does not assume upright height for unknown physical orientation', () => {
    let state = fixture();
    state = apply(
      state,
      measure(tube, geometry(['10', '100', '10'], null)),
      measure(rack, geometry(null, ['30', '30', '200']))
    );
    expect(inventoryPlacementCompatibility(state, tube, 'rack', 'A').fit).toBe('unknown');
    const command = configure(state, tube, { note: 'First' });
    if (command.kind !== 'configure-item') throw new Error('Fixture');
    state = apply(state, { ...command, orientation: { kind: 'known', quarterTurns: 0 } });
    expect(inventoryPlacementCompatibility(state, tube, 'rack', 'A').fit).toBe('incompatible');
  });
  it('uses directed exact evidence and preserves it through descriptive metadata edits only', () => {
    let state = fixture(),
      command = configure(state, tube, { note: 'First' });
    if (command.kind !== 'configure-item') throw new Error('Fixture');
    state = apply(state, { ...command, orientation: { kind: 'known', quarterTurns: 0 } });
    const parent = {
        kind: 'installed' as const,
        item: rack,
        configurationRevision: state.storage.rack.configuration.revision,
      },
      child = {
        kind: 'installed' as const,
        item: tube,
        configurationRevision: state.vessels.tube.configuration.revision,
      };
    state = apply(state, {
      kind: 'record-fit-evidence',
      id: 'fit',
      parent,
      child,
      positionId: 'A',
      orientations: [0],
      result: 'compatible',
      basis: 'locally-verified',
      source: null,
      reason: 'Observed this exact installed combination',
    });
    expect(inventoryPlacementCompatibility(state, tube, 'rack', 'A').fit).toBe('compatible');
    const before = state.vessels.tube.configuration.revision;
    state = apply(state, configure(state, tube, { note: 'Description changed' }));
    expect(state.vessels.tube.configuration.revision).toBe(before);
    expect(inventoryPlacementCompatibility(state, tube, 'rack', 'A').fit).toBe('compatible');
    expect(inventoryPlacementCompatibility(state, tube, 'rack', 'B').fit).toBe('unknown');
    state = apply(state, measure(tube, geometry(['1', '1', '1'], null)));
    expect(inventoryPlacementCompatibility(state, tube, 'rack', 'A').fit).toBe('unknown');
    expect(state.fitEvidence.fit).toBeDefined();
  });
  it('does not let type evidence survive a customized layout or invent symmetry', () => {
    let state = fixture(),
      command = configure(state, tube, { note: 'First' });
    if (command.kind !== 'configure-item') throw new Error('Fixture');
    state = apply(
      state,
      { ...command, orientation: { kind: 'known', quarterTurns: 0 } },
      {
        kind: 'record-fit-evidence',
        id: 'type-fit',
        parent: { kind: 'type-version', versionId: 'rack-v1' },
        child: { kind: 'type-version', versionId: 'tube-v1' },
        positionId: null,
        orientations: [0],
        result: 'compatible',
        basis: 'locally-verified',
        source: null,
        reason: 'Exact default combination',
      }
    );
    expect(inventoryPlacementCompatibility(state, tube, 'rack', 'A').fit).toBe('compatible');
    state = apply(state, {
      kind: 'reconfigure-storage',
      storageId: 'rack',
      layout: { kind: 'named', slots: ['A', 'B', 'C'] },
      reason: 'Additional custom position',
    });
    expect(inventoryPlacementCompatibility(state, tube, 'rack', 'A').fit).toBe('unknown');
  });
  it('requires an actual manufacturer assertion and source instead of a source URL alone', () => {
    const state = fixture();
    refused(
      state,
      {
        kind: 'record-fit-evidence',
        id: 'unsupported',
        parent: { kind: 'type-version', versionId: 'rack-v1' },
        child: { kind: 'type-version', versionId: 'tube-v1' },
        positionId: null,
        orientations: [0],
        result: 'compatible',
        basis: 'manufacturer-supported',
        source: null,
        reason: 'No applicable citation',
      },
      'INVALID_INVENTORY_INPUT'
    );
    expect(inventoryPlacementCompatibility(state, tube, 'rack', 'A').fit).toBe('unknown');
  });
});

describe('selected installed components', () => {
  it('creates only chosen actual heterogeneous components and keeps recipe pins through refresh', () => {
    let state = apply(createInventoryState(), ...definitions());
    const base = definitions()[1];
    if (base.kind !== 'define-physical-type' || base.definition.kind !== 'storage')
      throw new Error('Fixture');
    state = apply(
      state,
      {
        ...base,
        id: 'rack15',
        typeId: 'rack15',
        definition: {
          ...base.definition,
          layout: { kind: 'named', slots: Array.from({ length: 15 }, (_, i) => String(i + 1)) },
          childPolicy: { kind: 'any-legal' },
        },
      },
      {
        ...base,
        id: 'rack25',
        typeId: 'rack25',
        definition: {
          ...base.definition,
          layout: { kind: 'named', slots: Array.from({ length: 25 }, (_, i) => String(i + 1)) },
          childPolicy: { kind: 'any-legal' },
        },
      },
      {
        ...base,
        id: 'freezer-type',
        typeId: 'freezer',
        definition: {
          ...base.definition,
          layout: { kind: 'named', slots: ['upper', 'lower'] },
          childPolicy: { kind: 'types', typeIds: ['rack15', 'rack25'] },
        },
      }
    );
    const recipe: Extract<InventoryCommand, { kind: 'define-equipment-recipe' }> = {
      kind: 'define-equipment-recipe',
      id: 'recipe-v1',
      recipeId: 'mixed',
      name: 'Mixed equipment',
      description: '',
      model: {
        manufacturer: 'Custom',
        model: 'Observed mixed',
        partNumber: null,
        region: null,
        revision: null,
      },
      components: [
        {
          key: 'root',
          parentKey: null,
          positionId: null,
          name: 'Freezer',
          typeVersionId: 'freezer-type',
        },
        {
          key: 'upper',
          parentKey: 'root',
          positionId: 'upper',
          name: '25-position rack',
          typeVersionId: 'rack25',
        },
        {
          key: 'lower',
          parentKey: 'root',
          positionId: 'lower',
          name: '15-position rack',
          typeVersionId: 'rack15',
        },
      ],
      sources: [],
    };
    state = apply(state, recipe, {
      kind: 'instantiate-equipment-recipe',
      recipeVersionId: 'recipe-v1',
      name: 'Actual partial equipment',
      components: [
        { key: 'upper', id: 'upper-rack', metadata: {} },
        { key: 'root', id: 'freezer', metadata: {} },
      ],
      destination: { kind: 'root' },
      reason: 'Only these components installed',
    });
    expect(Object.keys(state.storage).sort()).toEqual(['freezer', 'upper-rack']);
    expect(Object.keys(state.stocks)).toEqual([]);
    expect(state.storage['upper-rack'].layout).toMatchObject({
      slots: expect.arrayContaining(['25']),
    });
    const installed = JSON.stringify(state.storage);
    state = apply(state, { ...recipe, id: 'recipe-v2', name: 'New publication' });
    expect(JSON.stringify(state.storage)).toBe(installed);
    expect(state.storage.freezer.configuration.recipe?.recipeVersionId).toBe('recipe-v1');
  });
  it('does not bypass foreign reservations when instantiating a new typed child', () => {
    const state = apply(fixture(), {
        kind: 'reserve-item',
        id: 'booking',
        item: rack,
        deadline: null,
        purpose: 'Owned fixture',
      }),
      bytes = JSON.stringify(state);
    expect(
      applyInventoryCommandBatch(
        state,
        {
          expectedRevision: state.revision,
          commands: [
            {
              kind: 'instantiate-physical-type',
              typeVersionId: 'tube-v1',
              id: 'foreign',
              name: 'Foreign',
              metadata: {},
              destination: { kind: 'located', storageId: 'rack', slotId: 'B' },
              reason: 'Attempt',
            },
          ],
        },
        { ...actor, principal: { kind: 'agent', identityId: 'bob' } }
      )
    ).toMatchObject({ ok: false, code: 'ITEM_RESERVED' });
    expect(JSON.stringify(state)).toBe(bytes);
  });
  it('checks structural roles when editing installed layouts', () => {
    let state = fixture();
    state = apply(
      state,
      {
        kind: 'create-storage',
        id: 'outer',
        name: 'Outer',
        slots: ['A1'],
        placement: { kind: 'root' },
      },
      {
        kind: 'move-storage',
        id: 'rack',
        placement: { kind: 'located', storageId: 'outer', slotId: 'A1' },
      }
    );
    refused(
      state,
      {
        kind: 'reconfigure-storage',
        storageId: 'outer',
        layout: { kind: 'removable-tube', rows: 1, columns: 1 },
        reason: 'Incorrect role',
      },
      'INCOMPATIBLE_LAYOUT'
    );
  });
});

it('keeps selected stack prefixes exact and processes reversed bindings in ordinal order', () => {
  const base = definitions()[1];
  if (base.kind !== 'define-physical-type' || base.definition.kind !== 'storage')
    throw new Error('Fixture');
  let state = apply(
    createInventoryState(),
    ...definitions(),
    {
      ...base,
      id: 'stack-type',
      typeId: 'stack',
      definition: {
        ...base.definition,
        layout: { kind: 'stack', capacity: 3, removal: 'top-only' },
        childPolicy: { kind: 'any-legal' },
      },
    },
    {
      kind: 'define-equipment-recipe',
      id: 'stack-recipe',
      recipeId: 'ordered',
      name: 'Ordered',
      description: '',
      model: {
        manufacturer: 'Custom',
        model: 'Stack',
        partNumber: null,
        region: null,
        revision: null,
      },
      components: [
        {
          key: 'root',
          parentKey: null,
          positionId: null,
          name: 'Stack',
          typeVersionId: 'stack-type',
        },
        {
          key: 'first',
          parentKey: 'root',
          positionId: '1',
          name: 'First',
          typeVersionId: 'tube-v1',
        },
        {
          key: 'second',
          parentKey: 'root',
          positionId: '2',
          name: 'Second',
          typeVersionId: 'tube-v1',
        },
      ],
      sources: [],
    }
  );
  refused(
    state,
    {
      kind: 'instantiate-equipment-recipe',
      recipeVersionId: 'stack-recipe',
      name: 'Gap',
      components: [
        { key: 'root', id: 'gap', metadata: {} },
        { key: 'second', id: 'second', metadata: {} },
      ],
      destination: { kind: 'root' },
      reason: 'Gap attempt',
    },
    'STACK_OPERATION_REQUIRED'
  );
  state = apply(state, {
    kind: 'instantiate-equipment-recipe',
    recipeVersionId: 'stack-recipe',
    name: 'Installed',
    components: [
      { key: 'second', id: 'two', metadata: {} },
      { key: 'first', id: 'one', metadata: {} },
      { key: 'root', id: 'stack', metadata: {} },
    ],
    destination: { kind: 'root' },
    reason: 'Actual components',
  });
  expect(state.vessels.one.placement).toMatchObject({ slotId: '1' });
  expect(state.vessels.two.placement).toMatchObject({ slotId: '2' });
});
it('retains permanent wells while unavailable cells reject physical receiving', () => {
  const base = definitions()[1];
  if (base.kind !== 'define-physical-type' || base.definition.kind !== 'storage')
    throw new Error('Fixture');
  const state = apply(
    createInventoryState(),
    {
      ...base,
      id: 'plate-type',
      typeId: 'plate',
      definition: {
        ...base.definition,
        layout: { kind: 'fixed-well', rows: 8, columns: 12 },
        childPolicy: { kind: 'none' },
        positionRules: { A1: { kind: 'unavailable', reason: 'Unused edge well' } },
      },
    },
    {
      kind: 'instantiate-physical-type',
      typeVersionId: 'plate-type',
      id: 'plate',
      name: 'Plate',
      metadata: {},
      destination: { kind: 'root' },
      reason: 'Actual plate',
    }
  );
  expect(Object.keys(state.vessels)).toHaveLength(96);
  expect(state.vessels[inventoryWellId('plate', 'A1')]).toBeDefined();
  refused(
    state,
    {
      kind: 'receive-stock',
      id: 'sample',
      vesselId: inventoryWellId('plate', 'A1'),
      materialId: 'dna',
      quantity: { kind: 'known', value: '10', unit: 'uL' },
      quality: 'usable',
    },
    'POSITION_UNAVAILABLE'
  );
});
it('rejects broken saved pins and new contextual commands without context', () => {
  const state = fixture(),
    raw = JSON.parse(JSON.stringify(state));
  raw.vessels.tube.configuration.typeVersionId = 'missing-version';
  expect(() => parseInventoryState(raw)).toThrow();
  expect(
    applyInventoryCommandBatch(createInventoryState(), {
      expectedRevision: 0,
      commands: [definitions()[0]],
    })
  ).toMatchObject({ ok: false, code: 'CONTEXT_REQUIRED' });
});
it('upcasts frozen v6 bytes without adding defaults to legacy requests or changing custody', () => {
  const request =
    '{"expectedRevision":0,"commands":[{"kind":"create-vessel","id":"a","name":"A","placement":{"kind":"unplaced"}}]}';
  const snapshot =
    '{"schema":"dnaforge.inventory.v6","revision":1,"lastRecordedAt":0,"storage":{},"vessels":{"a":{"kind":"movable","id":"a","name":"A","placement":{"kind":"unplaced"},"lifecycle":"active","limits":{"capacity":{"kind":"unknown"},"deadVolume":{"kind":"unknown"}},"custody":{"kind":"available"}}},"stocks":{},"lots":{},"reservations":{}}';
  const input = JSON.parse(snapshot),
    state = parseInventoryState(input);
  expect(JSON.stringify(input)).toBe(snapshot);
  expect(state.revision).toBe(1);
  expect(state.lastRecordedAt).toBe(0);
  expect(state.typeVersions).toEqual({});
  expect(state.vessels.a.configuration.typeVersionId).toBeNull();
  const batch = parseInventoryCommandBatch(JSON.parse(request));
  expect(JSON.stringify(batch)).toBe(request);
  const replay = applyInventoryCommandBatch(createInventoryState(), batch);
  expect(replay.ok && replay.state).toEqual(state);
});
