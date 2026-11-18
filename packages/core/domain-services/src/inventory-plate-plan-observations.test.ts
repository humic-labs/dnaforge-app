import { expect, it } from 'vitest';
import {
  inventoryPlatePlanObservationFixture,
  platePlanObservationTarget,
  applyPlatePlanObservationFixtureCommands,
} from './inventory-plate-plan-observation.fixtures';
import {
  applyInventoryPlatePlanObservation,
  inventoryPlatePlanObservationPreview,
  inventoryPlatePlanObservations,
} from './inventory-plate-plan-observations';
import {
  inventoryPlatePlanObservationStockId,
  inventoryPlatePlanObservationIntentSha256,
} from './inventory-plate-plan-observation-identity';
import { parseInventoryState } from './inventory-validation';
import { inventoryNotebookSourceSha256 } from './inventory-scientific-source';
import type { InventoryState } from './inventory-types';
import type { InventoryPlatePlanObservationPreviewInput } from './inventory-plate-plan-observation-types';

function record(fixture = inventoryPlatePlanObservationFixture()) {
  const preview = inventoryPlatePlanObservationPreview(fixture.state, fixture.input);
  if (preview.kind !== 'ready') throw new Error(JSON.stringify(preview));
  const result = applyInventoryPlatePlanObservation(
    fixture.state,
    { ...fixture.input, expectedPlanDigest: preview.planDigest },
    fixture.context
  );
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return { ...fixture, preview, recorded: result.state, observation: preview.observation };
}
it('records the ordered whole occurrence in one revision with grouped alias debit and separate output aliquots', () => {
  const fixture = inventoryPlatePlanObservationFixture(),
    before = JSON.stringify(fixture.state),
    raw = JSON.stringify(fixture.input),
    result = record(fixture);
  expect(JSON.stringify(fixture.state)).toBe(before);
  expect(JSON.stringify(fixture.input)).toBe(raw);
  expect(result.recorded.revision).toBe(fixture.state.revision + 1);
  expect(Object.keys(result.recorded.platePlanObservations)).toEqual([result.observation.id]);
  expect(result.observation).toMatchObject({
    observation: { kind: 'reported-completed-manual-plate-plan' },
    plate: {
      id: 'plate',
      name: 'Original plate',
      layout: { kind: 'fixed-well', rows: 2, columns: 3 },
    },
    effects: {
      sources: [
        {
          sourceSlotKeys: ['sample', 'control'],
          before: { quantity: { value: '8' } },
          after: { quantity: { value: '0' } },
        },
      ],
    },
  });
  expect(result.observation.actions.map((row) => row.actionId)).toEqual(['z-first', 'a-second']);
  expect(result.observation.effects.destinations.map((row) => row.after.id)).toEqual(
    ['z-first', 'a-second'].map((id) =>
      inventoryPlatePlanObservationStockId(fixture.input.identity, id)
    )
  );
  expect(result.observation.effects.destinations.map((row) => row.after.quantity)).toEqual([
    { kind: 'known', value: '4', unit: 'uL' },
    { kind: 'known', value: '4', unit: 'uL' },
  ]);
  for (const map of [
    'scientificWorks',
    'scientificCitations',
    'scientificCitationWithdrawals',
    'platePlanVersions',
    'reservations',
    'vessels',
    'storage',
  ] as const)
    expect(result.recorded[map]).toEqual(fixture.state[map]);
  expect(inventoryPlatePlanObservations(result.recorded)).toMatchObject([
    {
      id: result.observation.id,
      actionCount: 2,
      sourceStockCount: 1,
      versionId: fixture.version.id,
    },
  ]);
  expect(
    inventoryPlatePlanObservations(result.recorded, {
      context: {
        kind: 'notebook-page',
        projectId: 'foreign',
        workspaceScope: 'project',
        entityId: 'project::page',
      },
    })
  ).toEqual([]);
});
it('returns the original occurrence before fresh state/source admission and conflicts on changed meaning', () => {
  const result = record(inventoryPlatePlanObservationFixture('16')),
    input = {
      ...result.input,
      source: null,
      target: result.input.target,
      binding: { ...result.input.binding, sources: [...result.input.binding.sources].reverse() },
    };
  expect(inventoryPlatePlanObservationIntentSha256(input, result.version.definition)).toBe(
    result.observation.intentSha256
  );
  expect(inventoryPlatePlanObservationPreview(result.recorded, input)).toMatchObject({
    kind: 'no-change',
    observation: result.observation,
    commands: [],
    planDigest: null,
  });
  expect(
    applyInventoryPlatePlanObservation(
      result.recorded,
      { ...input, expectedPlanDigest: result.preview.planDigest },
      result.context
    )
  ).toEqual({ ok: true, state: result.recorded });
  for (const changed of [
    { ...input, reason: 'Different physical report' },
    { ...input, context: { ...input.context, sourceSha256: `sha256:${'b'.repeat(64)}` as const } },
  ])
    expect(inventoryPlatePlanObservationPreview(result.recorded, changed)).toMatchObject({
      kind: 'blocked',
      issues: [{ code: 'PLATE_PLAN_OBSERVATION_CONFLICT' }],
    });
  expect(
    inventoryPlatePlanObservationPreview(result.recorded, {
      ...result.input,
      identity: { ...result.input.identity, observationId: 'another-occurrence' },
      target: platePlanObservationTarget(result.recorded),
    })
  ).toMatchObject({ kind: 'blocked', issues: [{ code: 'STOCK_ALREADY_PRESENT' }] });
});
it('refuses the whole cumulative batch for insufficient stock, active holds and an occupied known-zero well', () => {
  const insufficient = inventoryPlatePlanObservationFixture('6'),
    before = JSON.stringify(insufficient.state);
  expect(
    inventoryPlatePlanObservationPreview(insufficient.state, insufficient.input)
  ).toMatchObject({
    kind: 'blocked',
    issues: [{ code: 'INSUFFICIENT_QUANTITY' }],
    observation: null,
    commands: [],
  });
  expect(JSON.stringify(insufficient.state)).toBe(before);
  const enough = inventoryPlatePlanObservationFixture(),
    held = applyPlatePlanObservationFixtureCommands(enough.state, [
      {
        kind: 'reserve-quantity',
        id: 'hold',
        stockId: 'stock',
        quantity: { value: '8', unit: 'uL' },
        deadline: 150,
        purpose: 'Held for another use',
      },
    ]);
  expect(
    inventoryPlatePlanObservationPreview(held, {
      ...enough.input,
      target: platePlanObservationTarget(held),
      asOf: 200,
    })
  ).toMatchObject({ kind: 'blocked', issues: [{ code: 'QUANTITY_RESERVED' }] });
  const occupied = applyPlatePlanObservationFixtureCommands(enough.state, [
    {
      kind: 'receive-stock',
      id: 'zero-stock',
      vesselId: 'well:plate#A3',
      materialId: 'material',
      quantity: { kind: 'known', value: '0', unit: 'uL' },
      quality: 'usable',
    },
  ]);
  expect(
    inventoryPlatePlanObservationPreview(occupied, {
      ...enough.input,
      target: platePlanObservationTarget(occupied),
    })
  ).toMatchObject({ kind: 'blocked', issues: [{ code: 'STOCK_ALREADY_PRESENT' }] });
});
it('rechecks native time and saved source while retaining equivalent preview intent across ordinary time passage', () => {
  const fixture = inventoryPlatePlanObservationFixture('10'),
    managed = applyPlatePlanObservationFixtureCommands(fixture.state, [
      {
        kind: 'record-validity-decision',
        id: 'expiry',
        owner: { kind: 'stock', stockId: 'stock' },
        rule: { kind: 'absolute', deadlineAt: 200 },
        sourceText: 'Exact expiry',
        sourcePrecision: 'instant',
        source: null,
        reason: 'Observed validity',
      },
    ]);
  const input = { ...fixture.input, target: platePlanObservationTarget(managed), asOf: 198 },
    preview = inventoryPlatePlanObservationPreview(managed, input);
  expect(preview).toMatchObject({ kind: 'ready', nextBoundaryAt: 200 });
  if (preview.kind !== 'ready') throw new Error(JSON.stringify(preview));
  const later = applyInventoryPlatePlanObservation(
    managed,
    { ...input, expectedPlanDigest: preview.planDigest },
    { ...fixture.context, at: 199 }
  );
  expect(later.ok).toBe(true);
  expect(
    applyInventoryPlatePlanObservation(
      managed,
      { ...input, expectedPlanDigest: preview.planDigest },
      { ...fixture.context, at: 200 }
    )
  ).toMatchObject({ ok: false, code: 'MATERIAL_EXPIRED' });
  if (fixture.source.schema !== 'dnaforge.notebook-saved-source.v1')
    throw new Error('Notebook fixture required.');
  const source = { ...fixture.source, title: 'Changed\0title' };
  expect(
    inventoryPlatePlanObservationPreview(fixture.state, {
      ...fixture.input,
      source,
      context: {
        kind: 'notebook-page',
        entityId: source.pageId,
        sourceSha256: inventoryNotebookSourceSha256(source),
      },
    })
  ).toMatchObject({ kind: 'blocked' });
  expect(
    inventoryPlatePlanObservationPreview(fixture.state, {
      ...fixture.input,
      source: { ...fixture.source, title: 'Changed source' },
    })
  ).toMatchObject({ kind: 'blocked', issues: [{ code: 'SCIENTIFIC_CONTEXT_MISMATCH' }] });
});
it('preserves completed Run lineage after later stock use and rejects corrupt arithmetic, outputs and action order', () => {
  const result = record(inventoryPlatePlanObservationFixture('10', 'protocol-run')),
    output = result.observation.effects.destinations[0].after.id;
  const used = applyPlatePlanObservationFixtureCommands(
    result.recorded,
    [
      {
        kind: 'consume',
        stockId: output,
        quantity: { value: '1', unit: 'uL' },
        reason: 'Later scientific use',
      },
    ],
    101
  );
  expect(parseInventoryState(used).platePlanObservations).toEqual(
    result.recorded.platePlanObservations
  );
  expect(used.stocks[output].quantity).toEqual({ kind: 'known', value: '3', unit: 'uL' });
  expect(result.observation.effects.destinations[0].after.quantity).toEqual({
    kind: 'known',
    value: '4',
    unit: 'uL',
  });
  const mutations: ((state: InventoryState) => void)[] = [
    (state) => {
      (
        state.platePlanObservations[result.observation.id].effects.sources[0].after.quantity as {
          value: string;
        }
      ).value = '3';
    },
    (state) => {
      (
        state.platePlanObservations[result.observation.id].effects.destinations[0].after as {
          materialId: string;
        }
      ).materialId = 'different-material';
    },
    (state) => {
      (state.platePlanObservations[result.observation.id].actions as unknown[]).reverse();
    },
  ];
  for (const mutate of mutations) {
    const state = structuredClone(used);
    mutate(state);
    expect(() => parseInventoryState(state)).toThrow();
  }
});
