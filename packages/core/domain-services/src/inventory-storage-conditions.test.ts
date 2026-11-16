import { describe, expect, it } from 'vitest';
import {
  applyInventoryCommandBatch,
  createInventoryState,
  parseInventoryState,
  parseInventoryCommand,
  inventoryCommandJsonSchema,
  inventoryStorageConditionsProjection,
  inventoryTemperatureFreshness,
  normalizeInventoryTemperature,
  normalizeInventoryTemperatureRange,
  compareInventoryTemperatures,
  unknownInventoryGeometry,
  type InventoryCommand,
  type InventoryState,
  type InventoryTemperatureRange,
} from './inventory';

const item = { kind: 'storage' as const, id: 'freezer' };
const principal = { kind: 'agent' as const, identityId: 'operator' };
const temp = (value: string) => ({ value, unit: 'C' as const });
const range = (minimum: string, maximum: string): InventoryTemperatureRange => ({
  minimum: temp(minimum),
  maximum: temp(maximum),
});
const provenance = { observedAt: null, source: null, reason: 'Explicit inventory fact' };
const context = (at: number) => ({
  at,
  principal,
  authority: { kind: 'local-profile' as const, profileKey: 'profile' },
});
function apply(state: InventoryState, ...commands: InventoryCommand[]): InventoryState {
  const result = applyInventoryCommandBatch(
    state,
    { expectedRevision: state.revision, commands },
    context(state.lastRecordedAt + 10)
  );
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  expect(parseInventoryState(result.state)).toEqual(result.state);
  return result.state;
}
function fixture(): InventoryState {
  return apply(
    createInventoryState(),
    {
      kind: 'create-storage',
      id: 'freezer',
      name: 'Freezer',
      slots: ['rack'],
      placement: { kind: 'root' },
    },
    {
      kind: 'create-storage',
      id: 'warm',
      name: '-80 freezer in name only',
      slots: ['rack'],
      placement: { kind: 'root' },
    },
    {
      kind: 'create-storage',
      id: 'box',
      name: 'Box',
      slots: ['tube'],
      placement: { kind: 'located', storageId: 'freezer', slotId: 'rack' },
    },
    {
      kind: 'create-vessel',
      id: 'tube',
      name: 'Tube',
      placement: { kind: 'located', storageId: 'box', slotId: 'tube' },
    },
    {
      kind: 'create-lot',
      id: 'lot',
      materialId: 'formulation',
      name: 'Lot',
      origin: { kind: 'received', supplier: 'Supplier', lotNumber: 'A' },
    },
    {
      kind: 'receive-lot-stock',
      id: 'stock',
      vesselId: 'tube',
      lotId: 'lot',
      quantity: { kind: 'known', value: '100', unit: 'uL' },
      quality: 'usable',
    },
    {
      kind: 'reserve-quantity',
      id: 'hold',
      stockId: 'stock',
      quantity: { value: '30', unit: 'uL' },
      deadline: null,
      purpose: 'Experiment',
    },
    { kind: 'record-thermal-context', item, value: { kind: 'self' }, ...provenance }
  );
}
const setpoint = (value: string, target = item): InventoryCommand => ({
  kind: 'record-equipment-setpoint',
  item: target,
  value: { kind: 'known', temperature: temp(value) },
  ...provenance,
});
const requirement = (minimum = '-85', maximum = '-75'): InventoryCommand => ({
  kind: 'record-storage-requirement',
  target: { kind: 'lot', id: 'lot' },
  value: { kind: 'specified', range: range(minimum, maximum) },
  ...provenance,
});
function claim(
  state: InventoryState,
  id: string,
  minimum: string,
  maximum: string,
  qualified = false
): InventoryCommand {
  return {
    kind: 'record-temperature-claim',
    id,
    subject: {
      kind: 'installed',
      item,
      configurationRevision: state.storage.freezer.configuration.revision,
    },
    assertion: qualified
      ? {
          kind: 'qualified-envelope',
          scope: 'physical-and-thermal-arrangement',
          range: range(minimum, maximum),
          atSetpoint: temp('-80'),
          assumptions: 'Declared physical qualification conditions',
        }
      : { kind: 'specified-setpoint-range', range: range(minimum, maximum) },
    ...provenance,
  };
}
const projection = (state: InventoryState, asOf = 100, freshnessMaxAgeMs: number | null = null) =>
  inventoryStorageConditionsProjection(state, { asOf, freshnessMaxAgeMs });

describe('exact signed Celsius', () => {
  it('normalizes negative zero and decimals without binary floating point, with inclusive absolute zero', () => {
    expect(normalizeInventoryTemperature(temp('-0.000'))).toEqual(temp('0'));
    expect(normalizeInventoryTemperature(temp('-80.0100'))).toEqual(temp('-80.01'));
    expect(normalizeInventoryTemperature(temp('-273.15000'))).toEqual(temp('-273.15'));
    expect(compareInventoryTemperatures(temp('-80.000000000000000000000001'), temp('-80'))).toBe(
      -1
    );
    expect(compareInventoryTemperatures(temp('-80.000'), temp('-80'))).toBe(0);
    expect(normalizeInventoryTemperatureRange(range('-80.000', '-80'))).toEqual(
      range('-80', '-80')
    );
  });
  it('rejects impossible, reversed, unsupported and malformed values', () => {
    for (const value of [
      '-273.1500000000000000001',
      '-274',
      '+2',
      '01',
      '.5',
      '-.5',
      '1e2',
      'NaN',
      '2\n',
      '2 ',
      '1'.repeat(129),
    ])
      expect(() => normalizeInventoryTemperature(temp(value))).toThrow();
    expect(() => normalizeInventoryTemperature({ value: '-80', unit: 'F' } as never)).toThrow();
    expect(() => normalizeInventoryTemperatureRange(range('-70', '-80'))).toThrow();
  });
});

describe('explicit freshness policy', () => {
  it('never invents observation time or a live claim and defines exact boundary and future observations', () => {
    expect(inventoryTemperatureFreshness(null, 100, 10)).toEqual({
      state: 'unknown',
      observedAt: null,
      ageMs: null,
      reason: 'time-unknown',
    });
    expect(inventoryTemperatureFreshness(90, 100, null)).toEqual({
      state: 'unknown',
      observedAt: 90,
      ageMs: 10,
      reason: 'no-policy',
    });
    expect(inventoryTemperatureFreshness(90, 100, 10).state).toBe('fresh');
    expect(inventoryTemperatureFreshness(89, 100, 10).state).toBe('stale');
    expect(inventoryTemperatureFreshness(101, 100, 10)).toEqual({
      state: 'unknown',
      observedAt: 101,
      ageMs: -1,
      reason: 'future-observation',
    });
    for (const max of [-1, NaN, undefined, Infinity, 0.1])
      expect(() => inventoryTemperatureFreshness(null, 100, max as never)).toThrow();
    expect(() => inventoryTemperatureFreshness(0, -1, null)).toThrow();
  });
});

describe('storage-temperature evidence ownership', () => {
  it('keeps capability, target and whole qualified envelope independent without changing physical/material facts', () => {
    const before = fixture();
    const state = apply(
      before,
      requirement(),
      setpoint('-70'),
      claim(before, 'capability', '-90', '-60'),
      claim(before, 'qualification', '-82', '-78', true)
    );
    const facts = projection(state).stocks.stock;
    expect(facts.environment).toEqual({ kind: 'known', item });
    expect(facts.capability.state).toBe('supported');
    expect(facts.reportedTarget.state).toBe('incompatible');
    expect(facts.qualifiedSupport.state).toBe('unknown');
    expect(
      projection(state).equipment['storage:freezer'].claims.find(
        (x) => x.claim.id === 'qualification'
      )?.applicability
    ).toBe('setpoint-changed');
    for (const key of ['storage', 'vessels', 'stocks', 'lots', 'reservations'] as const)
      expect(state[key]).toEqual(before[key]);
    const corrected = apply(state, setpoint('-80.000'));
    expect(projection(corrected).stocks.stock.qualifiedSupport.state).toBe('supported');
    const narrow = apply(corrected, requirement('-81', '-79'));
    expect(projection(narrow).stocks.stock.qualifiedSupport.state).toBe('incompatible');
    expect(projection(narrow).stocks.stock.capability.state).toBe('supported');
    expect(narrow.stocks).toEqual(before.stocks);
    expect(narrow.reservations).toEqual(before.reservations);
  });
  it('requires source-independent explicit requirements, lot inheritance and unknown override', () => {
    const state = apply(fixture(), requirement(), setpoint('-80'));
    expect(projection(state).stocks.stock.requirement).toMatchObject({
      value: { kind: 'specified' },
      inheritedFromLotId: 'lot',
      reason: 'lot-inheritance',
    });
    const unknown = apply(state, {
      kind: 'record-storage-requirement',
      target: { kind: 'stock', id: 'stock' },
      value: { kind: 'unknown' },
      ...provenance,
    });
    expect(projection(unknown).stocks.stock.requirement).toMatchObject({
      value: { kind: 'unknown' },
      inheritedFromLotId: null,
      reason: 'stock-override',
    });
    expect(projection(unknown).stocks.stock.reportedTarget.state).toBe('unknown');
    const inherited = apply(unknown, {
      kind: 'record-storage-requirement',
      target: { kind: 'stock', id: 'stock' },
      value: { kind: 'inherit' },
      ...provenance,
    });
    expect(projection(inherited).stocks.stock.requirement.value.kind).toBe('specified');
    expect(inherited.storageRequirements['stock:stock'].value.kind).toBe('inherit');
    expect(() =>
      parseInventoryCommand({
        kind: 'record-storage-requirement',
        target: { kind: 'lot', id: 'lot' },
        value: { kind: 'inherit' },
        ...provenance,
      })
    ).toThrow();
  });
  it('retains conflicting equal-scope facts, with explicit withdrawal and no newest-source winner', () => {
    const base = apply(fixture(), requirement(), setpoint('-80'));
    const state = apply(
      base,
      claim(base, 'first', '-90', '-60'),
      claim(base, 'same', '-90.0', '-60.00'),
      claim(base, 'contrary', '-86', '-50')
    );
    expect(projection(state).stocks.stock.capability).toMatchObject({
      state: 'conflicting',
      claimIds: ['contrary', 'first', 'same'],
    });
    const withdrawn = apply(state, {
      kind: 'withdraw-temperature-claim',
      claimId: 'contrary',
      reason: 'The source applies to a different model',
    });
    expect(projection(withdrawn).stocks.stock.capability.state).toBe('supported');
    expect(withdrawn.temperatureClaims.contrary).toMatchObject({
      lifecycle: {
        kind: 'withdrawn',
        by: principal,
        reason: 'The source applies to a different model',
      },
    });
    expect(withdrawn.temperatureClaims.first).toEqual(state.temperatureClaims.first);
    expect(
      applyInventoryCommandBatch(
        withdrawn,
        {
          expectedRevision: withdrawn.revision,
          commands: [{ kind: 'withdraw-temperature-claim', claimId: 'contrary', reason: 'Again' }],
        },
        context(100)
      )
    ).toMatchObject({ ok: false, code: 'TEMPERATURE_CLAIM_WITHDRAWN' });
  });
  it('prefers applicable exact installed specified ranges over type defaults with provenance', () => {
    let state = apply(fixture(), {
      kind: 'define-physical-type',
      id: 'model-v1',
      typeId: 'model',
      name: 'Model',
      description: '',
      fields: [],
      sources: [],
      definition: {
        kind: 'storage',
        layout: { kind: 'named', slots: ['rack'] },
        childPolicy: { kind: 'any-legal' },
        positionRules: {},
        geometry: unknownInventoryGeometry(),
      },
    });
    state = apply(state, {
      kind: 'configure-item',
      item,
      typeVersionId: 'model-v1',
      metadata: {},
      orientation: { kind: 'unknown' },
      unavailablePositions: {},
      reason: 'Adopt exact model',
    });
    state = apply(state, requirement(), {
      kind: 'record-temperature-claim',
      id: 'type-default',
      subject: { kind: 'type-version', versionId: 'model-v1' },
      assertion: { kind: 'specified-setpoint-range', range: range('-60', '-50') },
      ...provenance,
    });
    expect(projection(state).stocks.stock.capability.state).toBe('incompatible');
    state = apply(state, claim(state, 'local', '-90', '-75'));
    expect(projection(state).stocks.stock.capability).toMatchObject({
      state: 'supported',
      claimIds: ['local'],
    });
    expect(projection(state).equipment['storage:freezer'].claims).toHaveLength(2);
  });
  it('preserves qualification through metadata edits but makes physical changes inapplicable', () => {
    let state = apply(fixture(), requirement(), setpoint('-80'));
    state = apply(state, {
      kind: 'define-physical-type',
      id: 'metadata-model-v1',
      typeId: 'metadata-model',
      name: 'Model',
      description: '',
      fields: [{ key: 'notes', label: 'Notes', type: 'text' }],
      sources: [],
      definition: {
        kind: 'storage',
        layout: { kind: 'named', slots: ['rack'] },
        childPolicy: { kind: 'any-legal' },
        positionRules: {},
        geometry: unknownInventoryGeometry(),
      },
    });
    state = apply(state, {
      kind: 'configure-item',
      item,
      typeVersionId: 'metadata-model-v1',
      metadata: { notes: 'Original notes' },
      orientation: { kind: 'unknown' },
      unavailablePositions: {},
      reason: 'Pin model',
    });
    state = apply(state, claim(state, 'qualification', '-82', '-78', true));
    const old = state.temperatureClaims.qualification;
    state = apply(state, {
      kind: 'configure-item',
      item,
      typeVersionId: 'metadata-model-v1',
      metadata: { notes: 'Notes corrected' },
      orientation: { kind: 'unknown' },
      unavailablePositions: {},
      reason: 'Correct notes',
    });
    expect(projection(state).stocks.stock.qualifiedSupport.state).toBe('supported');
    state = apply(state, {
      kind: 'configure-item',
      item,
      typeVersionId: 'metadata-model-v1',
      metadata: { notes: 'Notes corrected' },
      orientation: { kind: 'known', quarterTurns: 1 },
      unavailablePositions: {},
      reason: 'Physical orientation changed',
    });
    expect(projection(state).equipment['storage:freezer'].claims[0].applicability).toBe(
      'configuration-changed'
    );
    expect(state.temperatureClaims.qualification).toEqual(old);
    expect(projection(state).stocks.stock.qualifiedSupport.state).toBe('unknown');
  });
  it('pins physical descendants and internal positions, excluding stock, metadata and the assembly external position', () => {
    let state = apply(fixture(), requirement(), setpoint('-80'));
    state = apply(state, claim(state, 'qualification', '-82', '-78', true));
    const saved = state.temperatureClaims.qualification.installation!;
    expect(saved.map((entry) => entry.item.id)).toEqual(['freezer', 'box', 'tube']);
    expect(saved[0].placement).toEqual({ kind: 'root' });
    expect(saved[1].placement).toEqual({ kind: 'located', storageId: 'freezer', slotId: 'rack' });
    state = apply(state, {
      kind: 'reconcile',
      stockId: 'stock',
      quantity: { kind: 'known', value: '99', unit: 'uL' },
      reason: 'Truthful amount correction',
    });
    expect(projection(state).stocks.stock.qualifiedSupport.state).toBe('supported');
    state = apply(
      state,
      {
        kind: 'create-storage',
        id: 'room',
        name: 'Room',
        slots: ['freezer'],
        placement: { kind: 'root' },
      },
      {
        kind: 'move-storage',
        id: 'freezer',
        placement: { kind: 'located', storageId: 'room', slotId: 'freezer' },
      }
    );
    expect(projection(state).stocks.stock.qualifiedSupport.state).toBe('supported');
    state = apply(state, {
      kind: 'configure-item',
      item: { kind: 'storage', id: 'box' },
      typeVersionId: null,
      metadata: {},
      orientation: { kind: 'known', quarterTurns: 1 },
      unavailablePositions: {},
      reason: 'Change internal hardware',
    });
    expect(projection(state).equipment['storage:freezer'].claims[0].applicability).toBe(
      'configuration-changed'
    );
    expect(state.temperatureClaims.qualification.installation).toEqual(saved);
    let added = apply(fixture(), requirement(), setpoint('-80'));
    added = apply(added, claim(added, 'qualification', '-82', '-78', true));
    added = apply(
      added,
      {
        kind: 'reconfigure-storage',
        storageId: 'box',
        layout: { kind: 'named', slots: ['tube', 'new'] },
        reason: 'New position',
      },
      {
        kind: 'create-vessel',
        id: 'new-tube',
        name: 'New tube',
        placement: { kind: 'located', storageId: 'box', slotId: 'new' },
      }
    );
    expect(projection(added).equipment['storage:freezer'].claims[0].applicability).toBe(
      'configuration-changed'
    );
    const removed = apply(added, {
      kind: 'move-vessel',
      id: 'new-tube',
      placement: { kind: 'unplaced' },
    });
    expect(projection(removed).equipment['storage:freezer'].claims[0].applicability).toBe(
      'configuration-changed'
    );
  });
  it('uses current ancestry only and recomputes whole holder moves without rewriting stock', () => {
    let state = apply(fixture(), requirement(), setpoint('-80'));
    const oldStock = state.stocks;
    state = apply(state, {
      kind: 'move-storage',
      id: 'box',
      placement: { kind: 'located', storageId: 'warm', slotId: 'rack' },
    });
    expect(projection(state).stocks.stock.environment).toEqual({
      kind: 'unknown',
      reason: 'no-thermal-context',
    });
    state = apply(state, setpoint('-20', { kind: 'storage', id: 'warm' }), {
      kind: 'record-thermal-context',
      item: { kind: 'storage', id: 'warm' },
      value: { kind: 'self' },
      ...provenance,
    });
    expect(projection(state).stocks.stock.reportedTarget.state).toBe('incompatible');
    state = apply(state, {
      kind: 'checkout-item',
      item: { kind: 'storage', id: 'box' },
      dueAt: null,
      reason: 'Take box to bench',
    });
    expect(projection(state).stocks.stock.environment).toEqual({
      kind: 'unknown',
      reason: 'custody-unavailable',
    });
    expect(state.stocks).toEqual(oldStock);
  });
  it('tracks internal placement changes even when equipment revisions do not change', () => {
    let state = apply(fixture(), requirement(), setpoint('-80'), {
      kind: 'reconfigure-storage',
      storageId: 'box',
      layout: { kind: 'named', slots: ['tube', 'spare'] },
      reason: 'Two existing positions',
    });
    state = apply(state, claim(state, 'qualification', '-82', '-78', true));
    const oldRevision = state.storage.freezer.configuration.revision;
    state = apply(state, {
      kind: 'move-vessel',
      id: 'tube',
      placement: { kind: 'located', storageId: 'box', slotId: 'spare' },
    });
    expect(state.storage.freezer.configuration.revision).toBe(oldRevision);
    expect(projection(state).equipment['storage:freezer'].claims[0].applicability).toBe(
      'configuration-changed'
    );
    state = apply(state, {
      kind: 'move-vessel',
      id: 'tube',
      placement: { kind: 'located', storageId: 'box', slotId: 'tube' },
    });
    expect(projection(state).stocks.stock.qualifiedSupport.state).toBe('supported');
  });
  it('reports stale/future time separately without relabeling the operator report as a measurement', () => {
    let state = apply(fixture(), requirement(), {
      ...setpoint('-80'),
      observedAt: 10,
    } as InventoryCommand);
    expect(projection(state, 20, 10).equipment['storage:freezer'].setpointFreshness.state).toBe(
      'fresh'
    );
    expect(projection(state, 21, 10).stocks.stock.reportedTarget.reasons).toContain(
      'REPORT_EXCEEDS_POLICY'
    );
    state = apply(state, { ...setpoint('-80'), observedAt: 1000 } as InventoryCommand);
    expect(projection(state, 100, 10).stocks.stock.reportedTarget.reasons).toContain(
      'REPORT_FUTURE_OBSERVATION'
    );
    expect(projection(state, 100, 10).stocks.stock.reportedTarget.state).toBe('supported');
  });
  it('requires trusted context, refuses scope errors atomically and owns claim IDs across material and reservation paths', () => {
    const before = fixture();
    expect(
      applyInventoryCommandBatch(before, {
        expectedRevision: before.revision,
        commands: [setpoint('-80')],
      })
    ).toMatchObject({ ok: false, code: 'CONTEXT_REQUIRED' });
    expect(
      applyInventoryCommandBatch(
        before,
        {
          expectedRevision: before.revision,
          commands: [
            setpoint('-80'),
            {
              ...claim(before, 'bad', '-90', '-60'),
              subject: { kind: 'installed', item, configurationRevision: 9 },
            } as InventoryCommand,
          ],
        },
        context(20)
      )
    ).toMatchObject({ ok: false, code: 'TEMPERATURE_SCOPE_CONFLICT' });
    expect(before.equipmentSetpoints).toEqual({});
    const state = apply(before, claim(before, 'claim-id', '-90', '-60'));
    for (const command of [
      {
        kind: 'create-lot',
        id: 'claim-id',
        materialId: 'm',
        name: 'New lot',
        origin: { kind: 'received', supplier: 'Supplier', lotNumber: 'N' },
      },
      {
        kind: 'reserve-quantity',
        id: 'claim-id',
        stockId: 'stock',
        quantity: { value: '1', unit: 'uL' },
        deadline: null,
        purpose: 'Experiment',
      },
      { kind: 'create-vessel', id: 'claim-id', name: 'New tube', placement: { kind: 'unplaced' } },
    ] as InventoryCommand[])
      expect(
        applyInventoryCommandBatch(
          state,
          { expectedRevision: state.revision, commands: [command] },
          context(100)
        )
      ).toMatchObject({ ok: false, code: 'ID_ALREADY_EXISTS' });
  });
  it('strictly rejects hidden fields, unsupported units, missing observation time and impossible saved targets', () => {
    const good = setpoint('-80');
    const omitted = { ...good } as Record<string, unknown>;
    delete omitted.observedAt;
    for (const bad of [
      omitted,
      { ...good, at: 99 },
      { ...good, value: { kind: 'known', temperature: { value: '-80', unit: 'K' } } },
      { ...good, value: { kind: 'known', temperature: temp('-273.151') } },
    ])
      expect(() => parseInventoryCommand(bad)).toThrow();
    const state = apply(fixture(), good);
    expect(() =>
      parseInventoryState({
        ...state,
        equipmentSetpoints: { 'storage:wrong': state.equipmentSetpoints['storage:freezer'] },
      })
    ).toThrow();
    expect(() =>
      parseInventoryState({
        ...state,
        equipmentSetpoints: {
          'storage:freezer': {
            ...state.equipmentSetpoints['storage:freezer'],
            at: state.lastRecordedAt + 1,
          },
        },
      })
    ).toThrow();
    const schema = JSON.stringify(inventoryCommandJsonSchema());
    expect(schema).toContain('record-equipment-setpoint');
    expect(schema).toContain('record-storage-requirement');
  });
  it('returns detached projections and never writes state or reads the machine clock', () => {
    const state = apply(fixture(), requirement(), setpoint('-80'));
    const before = JSON.stringify(state);
    const first = projection(state);
    (
      first.equipment['storage:freezer'].setpoint!.value as {
        kind: 'known';
        temperature: { value: string };
      }
    ).temperature.value = '2';
    expect(JSON.stringify(state)).toBe(before);
    expect(projection(state).equipment['storage:freezer'].setpoint!.value).toEqual({
      kind: 'known',
      temperature: temp('-80'),
    });
  });
  it('keeps a selected inner environment when its only claim is withdrawn or becomes inapplicable', () => {
    let state = apply(fixture(), requirement(), setpoint('-80'));
    const box = { kind: 'storage' as const, id: 'box' };
    const boxClaim: InventoryCommand = {
      kind: 'record-temperature-claim',
      id: 'box-range',
      subject: { kind: 'installed', item: box, configurationRevision: 0 },
      assertion: { kind: 'specified-setpoint-range', range: range('-30', '-10') },
      ...provenance,
    };
    state = apply(state, boxClaim, {
      kind: 'record-thermal-context',
      item: box,
      value: { kind: 'self' },
      ...provenance,
    });
    expect(projection(state).stocks.stock.environment).toEqual({ kind: 'known', item: box });
    expect(projection(state).stocks.stock.capability.state).toBe('incompatible');
    const changed = apply(state, {
      kind: 'configure-item',
      item: box,
      typeVersionId: null,
      metadata: {},
      orientation: { kind: 'known', quarterTurns: 1 },
      unavailablePositions: {},
      reason: 'Change insert configuration',
    });
    expect(projection(changed).stocks.stock.environment).toEqual({ kind: 'known', item: box });
    expect(projection(changed).stocks.stock.capability.state).toBe('unknown');
    const withdrawn = apply(state, {
      kind: 'withdraw-temperature-claim',
      claimId: 'box-range',
      reason: 'Withdraw source assertion',
    });
    expect(projection(withdrawn).stocks.stock.environment).toEqual({ kind: 'known', item: box });
    expect(projection(withdrawn).stocks.stock.reportedTarget.state).toBe('unknown');
    const inherited = apply(withdrawn, {
      kind: 'record-thermal-context',
      item: box,
      value: { kind: 'inherit' },
      ...provenance,
    });
    expect(projection(inherited).stocks.stock.environment).toEqual({ kind: 'known', item });
    expect(projection(inherited).stocks.stock.reportedTarget.state).toBe('supported');
    const unknown = apply(inherited, {
      kind: 'record-thermal-context',
      item: box,
      value: { kind: 'unknown' },
      ...provenance,
    });
    expect(projection(unknown).stocks.stock.environment).toEqual({
      kind: 'unknown',
      reason: 'thermal-context-unknown',
    });
    expect(projection(unknown).stocks.stock.reportedTarget.state).toBe('unknown');
    expect(unknown.stocks).toEqual(state.stocks);
    expect(unknown.reservations).toEqual(state.reservations);
    expect(unknown.storage).toEqual(state.storage);
  });
  it('does not infer a thermal relationship from new evidence or reports and projects context-only items', () => {
    let state = apply(fixture(), requirement(), setpoint('-80'));
    const box = { kind: 'storage' as const, id: 'box' };
    const originalContexts = state.thermalContexts;
    state = apply(state, setpoint('-20', box), {
      kind: 'record-temperature-claim',
      id: 'box-range',
      subject: { kind: 'installed', item: box, configurationRevision: 0 },
      assertion: { kind: 'specified-setpoint-range', range: range('-30', '-10') },
      ...provenance,
    });
    expect(state.thermalContexts).toEqual(originalContexts);
    expect(projection(state).stocks.stock.environment).toEqual({ kind: 'known', item });
    const contextOnly = apply(fixture(), {
      kind: 'record-thermal-context',
      item: box,
      value: { kind: 'self' },
      ...provenance,
    });
    expect(projection(contextOnly).equipment['storage:box']).toMatchObject({
      setpoint: null,
      claims: [],
      thermalContext: {
        item: box,
        value: { kind: 'self' },
        observedAt: null,
        at: 20,
        by: principal,
      },
    });
    expect(projection(contextOnly).stocks.stock.environment).toEqual({ kind: 'known', item: box });
    expect(projection(contextOnly).stocks.stock.reportedTarget.state).toBe('unknown');
  });
  it('pins effective thermal relationships in qualification while excluding replacement provenance', () => {
    let state = apply(fixture(), requirement(), setpoint('-80'));
    state = apply(state, claim(state, 'qualification', '-82', '-78', true));
    expect(
      state.temperatureClaims.qualification.installation!.map((entry) => entry.thermalRelationship)
    ).toEqual(['self', 'inherit', 'inherit']);
    state = apply(state, {
      kind: 'record-thermal-context',
      item,
      value: { kind: 'self' },
      observedAt: 25,
      source: null,
      reason: 'Same declared relationship with corrected observation time',
    });
    expect(projection(state).stocks.stock.qualifiedSupport.state).toBe('supported');
    state = apply(state, {
      kind: 'record-thermal-context',
      item: { kind: 'storage', id: 'box' },
      value: { kind: 'self' },
      ...provenance,
    });
    expect(projection(state).equipment['storage:freezer'].claims[0].applicability).toBe(
      'configuration-changed'
    );
    state = apply(state, {
      kind: 'record-thermal-context',
      item: { kind: 'storage', id: 'box' },
      value: { kind: 'inherit' },
      ...provenance,
    });
    const reopened = parseInventoryState(JSON.parse(JSON.stringify(state)));
    expect(projection(reopened).stocks.stock.qualifiedSupport.state).toBe('supported');
    expect(projection(reopened)).toEqual(projection(state));
  });
  it('strictly owns thermal relationship input, target and trusted record clock', () => {
    const state = fixture(),
      command: InventoryCommand = {
        kind: 'record-thermal-context',
        item,
        value: { kind: 'self' },
        ...provenance,
      };
    expect(
      applyInventoryCommandBatch(state, { expectedRevision: state.revision, commands: [command] })
    ).toMatchObject({ ok: false, code: 'CONTEXT_REQUIRED' });
    for (const input of [
      { ...command, value: { kind: 'controlled' } },
      { ...command, by: principal },
      { ...command, observedAt: undefined },
    ])
      expect(() => parseInventoryCommand(input)).toThrow();
    const accepted = apply(state, command);
    expect(() =>
      parseInventoryState({
        ...accepted,
        thermalContexts: { 'storage:bad-key': accepted.thermalContexts['storage:freezer'] },
      })
    ).toThrow();
    expect(() =>
      parseInventoryState({
        ...accepted,
        thermalContexts: {
          'storage:freezer': { ...accepted.thermalContexts['storage:freezer'], at: 999 },
        },
      })
    ).toThrow();
    expect(inventoryCommandJsonSchema()).toBeTruthy();
    expect(JSON.stringify(inventoryCommandJsonSchema())).toContain('record-thermal-context');
  });
});
