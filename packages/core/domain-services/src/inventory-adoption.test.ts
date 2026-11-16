import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  adoptInventoryState,
  applyInventoryCommandBatch,
  createInventoryState,
  inventoryAvailability,
  inventoryPrincipalMatchesActor,
  inventoryScientificReferences,
  inventoryStorageConditionsProjection,
  parseInventoryExecutionContext,
  parseInventoryState,
  unknownInventoryGeometry,
  type InventoryAdoptionSource,
  type InventoryCommand,
  type InventoryExecutionContext,
  type InventoryState,
} from './inventory';

const originalActor = { kind: 'agent' as const, identityId: 'same-agent-id' };
const importer: InventoryExecutionContext = {
  at: 1000,
  principal: originalActor,
  authority: { kind: 'local-profile', profileKey: 'destination-profile' },
};
const bindings = {
  'material/a': 'destination-a',
  'material-b': 'destination-b',
  'analyte~/old': 'destination-analyte',
};
const provenance = { observedAt: null, source: null, reason: 'Synthetic source fact' };
const range = {
  minimum: { value: '-82', unit: 'C' as const },
  maximum: { value: '-78', unit: 'C' as const },
};
function apply(
  state: InventoryState,
  commands: readonly InventoryCommand[],
  local = false
): InventoryState {
  const result = applyInventoryCommandBatch(
    state,
    { expectedRevision: state.revision, commands },
    {
      at: state.lastRecordedAt + 10,
      principal: local ? { kind: 'local-profile', profileKey: 'source-profile' } : originalActor,
      authority: { kind: 'local-profile', profileKey: 'source-profile' },
    }
  );
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return parseInventoryState(result.state);
}
function fixture(): InventoryState {
  let state = apply(createInventoryState(), [
    {
      kind: 'define-physical-type',
      id: 'freezer-v1',
      typeId: 'freezer',
      name: 'Freezer',
      description: '',
      fields: [{ key: 'materialId', label: 'Literal metadata', type: 'text' }],
      sources: [],
      definition: {
        kind: 'storage',
        layout: { kind: 'named', slots: ['A', 'B'] },
        childPolicy: { kind: 'any-legal' },
        positionRules: {},
        geometry: unknownInventoryGeometry(),
      },
    },
    {
      kind: 'define-equipment-recipe',
      id: 'recipe-v1',
      recipeId: 'recipe',
      name: 'Freezer recipe',
      description: '',
      model: {
        manufacturer: 'Synthetic',
        model: 'Fixture',
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
          name: 'Freezer',
          typeVersionId: 'freezer-v1',
        },
      ],
    },
    {
      kind: 'instantiate-equipment-recipe',
      recipeVersionId: 'recipe-v1',
      name: 'Freezer',
      destination: { kind: 'root' },
      components: [{ key: 'root', id: 'freezer', metadata: { materialId: 'material/a' } }],
      reason: 'Synthetic installation',
    },
    {
      kind: 'create-vessel',
      id: 'tube',
      name: 'Tube',
      placement: { kind: 'located', storageId: 'freezer', slotId: 'A' },
    },
    {
      kind: 'create-vessel',
      id: 'product-tube',
      name: 'Product',
      placement: { kind: 'located', storageId: 'freezer', slotId: 'B' },
    },
    { kind: 'create-vessel', id: 'custody-tube', name: 'Custody', placement: { kind: 'unplaced' } },
    {
      kind: 'receive-stock',
      id: 'stock',
      vesselId: 'tube',
      materialId: 'material/a',
      quantity: { kind: 'known', value: '100', unit: 'uL' },
      quality: 'usable',
    },
    {
      kind: 'record-composition',
      stockId: 'stock',
      reason: 'Synthetic rational composition',
      composition: {
        kind: 'homogeneous',
        analytes: {
          'analyte~/old': { kind: 'known', numerator: '1', denominator: '3', unit: 'ng/uL' },
        },
      },
    },
    {
      kind: 'create-lot',
      id: 'prepared-lot',
      materialId: 'material-b',
      name: 'Preparation',
      origin: { kind: 'prepared', sourceStockIds: ['stock'], method: 'Synthetic preparation' },
    },
    {
      kind: 'receive-lot-stock',
      id: 'prepared-stock',
      vesselId: 'product-tube',
      lotId: 'prepared-lot',
      quantity: { kind: 'unknown' },
      quality: 'quarantined',
    },
    {
      kind: 'attach-item-code',
      id: 'code',
      namespace: 'lab',
      value: ' 00123 ',
      item: { kind: 'vessel', id: 'tube' },
      reason: 'Exact original label',
    },
    {
      kind: 'attach-item-code',
      id: 'retired-code',
      namespace: 'lab',
      value: 'retired',
      item: { kind: 'vessel', id: 'tube' },
      reason: 'Old original label',
    },
    { kind: 'retire-item-code', codeId: 'retired-code', reason: 'Retain old label' },
    {
      kind: 'record-item-geometry',
      item: { kind: 'storage', id: 'freezer' },
      geometry: unknownInventoryGeometry(),
      source: null,
      reason: 'Recorded unknown geometry',
    },
    {
      kind: 'record-thermal-context',
      item: { kind: 'storage', id: 'freezer' },
      value: { kind: 'self' },
      ...provenance,
    },
    {
      kind: 'record-equipment-setpoint',
      item: { kind: 'storage', id: 'freezer' },
      value: { kind: 'known', temperature: { value: '-80', unit: 'C' } },
      ...provenance,
    },
    {
      kind: 'record-storage-requirement',
      target: { kind: 'stock', id: 'stock' },
      value: { kind: 'specified', range },
      ...provenance,
    },
  ]);
  state = apply(state, [
    {
      kind: 'record-fit-evidence',
      id: 'fit',
      parent: { kind: 'type-version', versionId: 'freezer-v1' },
      child: {
        kind: 'installed',
        item: { kind: 'vessel', id: 'tube' },
        configurationRevision: state.vessels.tube.configuration.revision,
      },
      positionId: 'A',
      orientations: [0],
      result: 'compatible',
      basis: 'locally-verified',
      source: null,
      reason: 'Synthetic fit observation',
    },
    {
      kind: 'record-temperature-claim',
      id: 'qualification',
      subject: {
        kind: 'installed',
        item: { kind: 'storage', id: 'freezer' },
        configurationRevision: state.storage.freezer.configuration.revision,
      },
      assertion: {
        kind: 'qualified-envelope',
        scope: 'physical-and-thermal-arrangement',
        range,
        atSetpoint: { value: '-80', unit: 'C' },
        assumptions: 'Synthetic recorded arrangement only',
      },
      ...provenance,
    },
    {
      kind: 'record-temperature-claim',
      id: 'withdrawn',
      subject: { kind: 'type-version', versionId: 'freezer-v1' },
      assertion: { kind: 'specified-setpoint-range', range },
      ...provenance,
    },
    {
      kind: 'withdraw-temperature-claim',
      claimId: 'withdrawn',
      reason: 'Retain withdrawn evidence',
    },
    {
      kind: 'reserve-quantity',
      id: 'active-hold',
      stockId: 'stock',
      quantity: { value: '40', unit: 'uL' },
      deadline: null,
      purpose: 'Foreign responsibility',
    },
    {
      kind: 'reserve-quantity',
      id: 'cancelled-hold',
      stockId: 'stock',
      quantity: { value: '10', unit: 'uL' },
      deadline: null,
      purpose: 'Recorded cancellation authority',
    },
    {
      kind: 'checkout-item',
      item: { kind: 'vessel', id: 'custody-tube' },
      dueAt: null,
      reason: 'Source custody',
    },
    {
      kind: 'retire-catalog-version',
      target: { kind: 'type-version', versionId: 'freezer-v1' },
      reason: 'Retain source installation',
    },
    {
      kind: 'retire-catalog-version',
      target: { kind: 'recipe-version', versionId: 'recipe-v1' },
      reason: 'Retain source recipe',
    },
  ]);
  return apply(
    state,
    [
      {
        kind: 'cancel-reservation',
        reservationId: 'cancelled-hold',
        reason: 'Source local cancellation',
      },
    ],
    true
  );
}
function sourceDescriptor(state: InventoryState): InventoryAdoptionSource {
  return {
    archiveSha256: `sha256:${'a'.repeat(64)}`,
    projectId: 'source-project',
    inventoryId: 'source-inventory',
    revision: state.revision,
  };
}
function adopted(state = fixture()): InventoryState {
  const result = adoptInventoryState(
    null,
    state,
    { source: sourceDescriptor(state), materialBindings: bindings },
    importer
  );
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.state;
}

describe('inventory archive adoption authority', () => {
  it('maps only semantic scientific references including escaped analyte and immutable contribution paths', () => {
    const source = fixture();
    const refs = inventoryScientificReferences(source);
    expect(refs.map((reference) => reference.materialId)).toEqual([
      'analyte~/old',
      'material-b',
      'material/a',
    ]);
    expect(refs[0].pointers).toEqual([
      '/lots/prepared-lot/origin/inputs/0/composition/analytes/analyte~0~1old',
      '/stocks/stock/composition/analytes/analyte~0~1old',
    ]);
    expect(refs[2].pointers).toEqual([
      '/lots/prepared-lot/origin/inputs/0/materialId',
      '/stocks/stock/materialId',
    ]);
    const before = JSON.stringify(source);
    const state = adopted(source);
    expect(JSON.stringify(source)).toBe(before);
    expect(state.origin).toEqual({
      kind: 'archive-adoption',
      source: sourceDescriptor(source),
      at: 1000,
      by: originalActor,
    });
    expect(state.revision).toBe(1);
    expect(state.lastRecordedAt).toBe(1000);
    expect(state.stocks.stock.materialId).toBe('destination-a');
    expect(state.lots['prepared-lot'].materialId).toBe('destination-b');
    const origin = state.lots['prepared-lot'].origin;
    if (origin.kind !== 'prepared') throw new Error('Expected preparation.');
    expect(origin.inputs[0]).toMatchObject({
      materialId: 'destination-a',
      composition: { analytes: { 'destination-analyte': { numerator: '1', denominator: '3' } } },
    });
    expect(state.storage.freezer.configuration.metadata).toEqual({ materialId: 'material/a' });
    expect(state.itemCodes.code.value).toBe(' 00123 ');
    expect(state.stocks.stock.quantity).toEqual(source.stocks.stock.quantity);
    expect(state.stocks['prepared-stock'].quantity).toEqual({ kind: 'unknown' });
    expect(state.stocks['prepared-stock'].quality).toBe('quarantined');
    expect(parseInventoryState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it('retains physical and thermal qualification scope and every recorded actor as imported evidence', () => {
    const source = fixture();
    const state = adopted(source);
    const actor = { kind: 'imported', source: sourceDescriptor(source), principal: originalActor };
    expect(state.reservations['active-hold'].holder).toEqual(actor);
    expect(state.itemCodes.code.assignedBy).toEqual(actor);
    expect(state.itemCodes['retired-code'].lifecycle).toMatchObject({ kind: 'retired', by: actor });
    expect(state.typeVersions['freezer-v1']).toMatchObject({
      publishedBy: actor,
      selection: { kind: 'retired', by: actor },
    });
    expect(state.recipeVersions['recipe-v1']).toMatchObject({
      publishedBy: actor,
      selection: { kind: 'retired', by: actor },
    });
    expect(state.fitEvidence.fit.by).toEqual(actor);
    expect(state.storage.freezer.configuration.geometryOverride?.by).toEqual(actor);
    expect(state.temperatureClaims.qualification.by).toEqual(actor);
    expect(state.temperatureClaims.withdrawn.lifecycle).toMatchObject({
      kind: 'withdrawn',
      by: actor,
    });
    expect(state.equipmentSetpoints['storage:freezer'].by).toEqual(actor);
    expect(state.storageRequirements['stock:stock'].by).toEqual(actor);
    expect(state.thermalContexts['storage:freezer'].by).toEqual(actor);
    expect(state.reservations['cancelled-hold'].lifecycle).toMatchObject({
      kind: 'cancelled',
      authority: {
        kind: 'imported',
        source: sourceDescriptor(source),
        authority: { kind: 'local-profile', profileKey: 'source-profile' },
      },
    });
    expect(state.temperatureClaims.qualification.installation).toEqual(
      source.temperatureClaims.qualification.installation
    );
    expect(state.temperatureClaims.qualification.at).toBe(
      source.temperatureClaims.qualification.at
    );
    const projection = inventoryStorageConditionsProjection(state, {
      asOf: 1000,
      freshnessMaxAgeMs: null,
    });
    expect(projection.stocks.stock.qualifiedSupport.state).toBe('supported');
  });

  it('maps pooled and diluted contribution snapshots without changing exact quantities or ratios', () => {
    const source = apply(fixture(), [
      ...['water', 'pooled', 'diluted'].map(
        (name): InventoryCommand => ({
          kind: 'create-vessel',
          id: `${name}-tube`,
          name,
          placement: { kind: 'unplaced' },
        })
      ),
      {
        kind: 'receive-stock',
        id: 'water-stock',
        vesselId: 'water-tube',
        materialId: 'material/a',
        quantity: { kind: 'known', value: '20', unit: 'uL' },
        quality: 'usable',
      },
      {
        kind: 'record-composition',
        stockId: 'water-stock',
        composition: {
          kind: 'homogeneous',
          analytes: {
            'analyte~/old': { kind: 'known', numerator: '0', denominator: '1', unit: 'ng/uL' },
          },
        },
        reason: 'Synthetic known-zero concentration',
      },
      {
        kind: 'pool',
        lotId: 'pooled-lot',
        stockId: 'pooled-stock',
        vesselId: 'pooled-tube',
        materialId: 'material-b',
        name: 'Pooled',
        inputs: [
          { stockId: 'stock', quantity: { value: '10', unit: 'uL' } },
          { stockId: 'water-stock', quantity: { value: '5', unit: 'uL' } },
        ],
        mixing: 'homogeneous',
        reason: 'Synthetic exact mixture',
      },
      {
        kind: 'dilute',
        lotId: 'diluted-lot',
        stockId: 'diluted-stock',
        vesselId: 'diluted-tube',
        materialId: 'material-b',
        name: 'Diluted',
        sample: { stockId: 'pooled-stock', quantity: { value: '5', unit: 'uL' } },
        diluent: { stockId: 'water-stock', quantity: { value: '5', unit: 'uL' } },
        mixing: 'homogeneous',
        reason: 'Synthetic exact dilution',
      },
    ]);
    const references = inventoryScientificReferences(source);
    expect(references.find((entry) => entry.materialId === 'material/a')?.pointers).toContain(
      '/lots/pooled-lot/origin/inputs/1/materialId'
    );
    expect(references.find((entry) => entry.materialId === 'material-b')?.pointers).toContain(
      '/lots/diluted-lot/origin/sample/materialId'
    );
    expect(references.find((entry) => entry.materialId === 'analyte~/old')?.pointers).toContain(
      '/lots/diluted-lot/origin/diluent/composition/analytes/analyte~0~1old'
    );
    const state = adopted(source);
    const pooled = state.lots['pooled-lot'].origin;
    const diluted = state.lots['diluted-lot'].origin;
    if (pooled.kind !== 'pooled' || diluted.kind !== 'diluted')
      throw new Error('Expected contribution snapshots.');
    expect(pooled.inputs.map((entry) => entry.materialId)).toEqual([
      'destination-a',
      'destination-a',
    ]);
    expect(diluted.sample.materialId).toBe('destination-b');
    expect(diluted.diluent.materialId).toBe('destination-a');
    expect(diluted.sample.composition).toMatchObject({
      analytes: { 'destination-analyte': { numerator: '2', denominator: '9' } },
    });
    expect(state.stocks['diluted-stock'].composition).toMatchObject({
      analytes: { 'destination-analyte': { numerator: '1', denominator: '9' } },
    });
    for (const id of Object.keys(source.stocks))
      expect(state.stocks[id].quantity).toEqual(source.stocks[id].quantity);
  });

  it('never lets a matching destination agent claim imported reservations or custody', () => {
    const state = adopted();
    const availability = inventoryAvailability(state, originalActor, 1000);
    expect(availability.stocks.stock).toMatchObject({
      mine: { value: '0', unit: 'uL' },
      held: { value: '40', unit: 'uL' },
    });
    expect(availability.reservations['active-hold']).toMatchObject({
      mine: false,
      actions: { release: false, fulfill: false },
    });
    expect(availability.items['custody-tube'].actions.return).toBe(false);
    for (const [command, code] of [
      [
        {
          kind: 'release-reservation',
          reservationId: 'active-hold',
          reason: 'Matching raw agent is not ownership',
        },
        'RESERVATION_NOT_OWNED',
      ],
      [
        {
          kind: 'return-item',
          item: { kind: 'vessel', id: 'custody-tube' },
          destination: { kind: 'unplaced' },
          reason: 'Matching raw agent is not custody',
        },
        'CUSTODY_NOT_OWNED',
      ],
    ] as const)
      expect(
        applyInventoryCommandBatch(state, { expectedRevision: 1, commands: [command] }, importer)
      ).toMatchObject({ ok: false, code });
    const recovered = applyInventoryCommandBatch(
      state,
      {
        expectedRevision: 1,
        commands: [
          {
            kind: 'cancel-reservation',
            reservationId: 'active-hold',
            reason: 'Explicit local reconciliation',
          },
          {
            kind: 'return-item',
            item: { kind: 'vessel', id: 'custody-tube' },
            destination: { kind: 'unplaced' },
            reason: 'Explicit local custody recovery',
          },
        ],
      },
      {
        ...importer,
        at: 1001,
        principal: { kind: 'local-profile', profileKey: 'destination-profile' },
      }
    );
    expect(recovered.ok).toBe(true);
  });

  it('retains already imported attribution flat while recording a new immediate adoption origin', () => {
    const first = adopted();
    const source = {
      ...sourceDescriptor(first),
      archiveSha256: `sha256:${'b'.repeat(64)}`,
      projectId: 'second-source',
    };
    const result = adoptInventoryState(
      null,
      first,
      {
        source,
        materialBindings: {
          'destination-a': 'final-a',
          'destination-b': 'final-b',
          'destination-analyte': 'final-analyte',
        },
      },
      { ...importer, at: 2000 }
    );
    if (!result.ok) throw new Error(result.message);
    expect(result.state.reservations['active-hold'].holder).toEqual(
      first.reservations['active-hold'].holder
    );
    expect(result.state.reservations['cancelled-hold'].lifecycle).toEqual(
      first.reservations['cancelled-hold'].lifecycle
    );
    expect(result.state.origin).toEqual({
      kind: 'archive-adoption',
      source,
      at: 2000,
      by: originalActor,
    });
  });

  it('rejects target presence, future clocks, incomplete and colliding bindings without source mutation', () => {
    const source = fixture();
    const before = JSON.stringify(source);
    const options = { source: sourceDescriptor(source), materialBindings: bindings };
    expect(adoptInventoryState(createInventoryState(), source, options, importer)).toMatchObject({
      ok: false,
      code: 'IMPORT_TARGET_PRESENT',
    });
    expect(
      adoptInventoryState(null, source, options, { ...importer, at: source.lastRecordedAt - 1 })
    ).toMatchObject({ ok: false, code: 'IMPORT_SOURCE_CLOCK_FUTURE' });
    expect(
      adoptInventoryState(
        null,
        source,
        { ...options, materialBindings: { 'material/a': 'a' } },
        importer
      )
    ).toMatchObject({ ok: false, code: 'IMPORT_BINDING_MISSING' });
    expect(
      adoptInventoryState(
        null,
        source,
        { ...options, materialBindings: { ...bindings, extra: 'unused' } },
        importer
      )
    ).toMatchObject({ ok: false, code: 'IMPORT_BINDING_UNUSED' });
    expect(
      adoptInventoryState(
        null,
        source,
        { ...options, materialBindings: { ...bindings, 'material-b': 'destination-a' } },
        importer
      )
    ).toMatchObject({ ok: false, code: 'IMPORT_BINDING_COLLISION' });
    expect(
      adoptInventoryState(
        null,
        source,
        { ...options, source: { ...options.source, revision: 99 } },
        importer
      )
    ).toMatchObject({ ok: false, code: 'IMPORT_SOURCE_INVALID' });
    expect(JSON.stringify(source)).toBe(before);
  });

  it('cannot use imported identities or authority as native execution context', () => {
    const source = fixture();
    const imported = {
      kind: 'imported' as const,
      source: sourceDescriptor(source),
      principal: originalActor,
    };
    expect(inventoryPrincipalMatchesActor(imported, originalActor)).toBe(false);
    expect(
      inventoryPrincipalMatchesActor({ kind: 'agent', identityId: 'same-agent-id' }, originalActor)
    ).toBe(true);
    expect(() => parseInventoryExecutionContext({ ...importer, principal: imported })).toThrow();
    expect(() =>
      parseInventoryExecutionContext({
        ...importer,
        authority: {
          kind: 'imported',
          source: sourceDescriptor(source),
          authority: importer.authority,
        },
      })
    ).toThrow();
    const {
      origin: _origin,
      tableBindings: _tableBindings,
      observations: _observations,
      ...oldShape
    } = adopted(source);
    expect(() => parseInventoryState({ ...oldShape, schema: 'dnaforge.inventory.v11' })).toThrow(
      'Legacy inventory schemas cannot contain imported attribution'
    );
  });
});

it('requires own bindings for prototype-like scientific identifiers and preserves analyte keys safely', () => {
  const source = apply(createInventoryState(), [
    { kind: 'create-vessel', id: 'tube', name: 'Tube', placement: { kind: 'unplaced' } },
    {
      kind: 'receive-stock',
      id: 'stock',
      vesselId: 'tube',
      materialId: 'constructor',
      quantity: { kind: 'known', value: '1', unit: 'uL' },
      quality: 'usable',
    },
    {
      kind: 'record-composition',
      stockId: 'stock',
      reason: 'Exact analyte identity',
      composition: {
        kind: 'homogeneous',
        analytes: Object.fromEntries([
          ['__proto__', { kind: 'known', numerator: '1', denominator: '3', unit: 'ng/uL' }],
        ]),
      },
    },
  ]);
  expect(inventoryScientificReferences(source).map((entry) => entry.materialId)).toEqual([
    '__proto__',
    'constructor',
  ]);
  const inherited = Object.create({
    constructor: 'inherited-material',
    ['__proto__']: 'inherited-analyte',
  });
  expect(
    adoptInventoryState(
      null,
      source,
      { source: sourceDescriptor(source), materialBindings: inherited },
      importer
    )
  ).toMatchObject({ ok: false, code: 'IMPORT_BINDING_MISSING' });
  const result = adoptInventoryState(
    null,
    source,
    {
      source: sourceDescriptor(source),
      materialBindings: Object.fromEntries([
        ['constructor', 'mapped-material'],
        ['__proto__', '__proto__'],
      ]),
    },
    importer
  );
  if (!result.ok) throw new Error(result.message);
  expect(result.state.stocks.stock.materialId).toBe('mapped-material');
  const composition = result.state.stocks.stock.composition;
  if (composition.kind !== 'homogeneous') throw new Error('Expected exact composition.');
  expect(Object.hasOwn(composition.analytes, '__proto__')).toBe(true);
  expect(composition.analytes['__proto__']).toMatchObject({ numerator: '1', denominator: '3' });
});

const V11 =
  '{"schema":"dnaforge.inventory.v11","revision":0,"lastRecordedAt":0,"thermalContexts":{},"temperatureClaims":{},"equipmentSetpoints":{},"storageRequirements":{},"itemCodes":{},"typeVersions":{},"recipeVersions":{},"fitEvidence":{},"storage":{},"vessels":{},"stocks":{},"lots":{},"reservations":{}}';
it('upcasts a frozen v11 snapshot to explicit native origin without changing stored bytes or clock', () => {
  const before = JSON.parse(V11);
  const bytes = JSON.stringify(before);
  const state = parseInventoryState(before);
  expect(state).toEqual({
    ...before,
    schema: 'dnaforge.inventory.v15',
    observations: {},
    origin: { kind: 'native' },
    tableBindings: {},
  });
  expect(JSON.stringify(before)).toBe(bytes);
  expect(createHash('sha256').update(V11).digest('hex')).toBe(
    '0a4dd0f9aa9000e294b65a12bdfa479cc670c464cabe688c3e9bf736eb53f6af'
  );
});
