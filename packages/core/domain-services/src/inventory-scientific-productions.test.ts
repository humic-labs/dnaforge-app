import { inventoryIncidentTypedSnapshots } from './inventory-incident-codec-compat';
import { expect, it } from 'vitest';
import {
  inventoryScientificProductionFixture,
  recordedScientificProductionFixture,
} from './inventory-scientific-production.fixtures';
import {
  inventoryScientificProductionPreview,
  applyInventoryScientificProduction,
  inventoryScientificProductions,
} from './inventory-scientific-productions';
import {
  inventoryScientificProductionChoices,
  inventoryScientificProductionIntentSha256,
} from './inventory-scientific-production-identity';
import { parseInventoryState, parseInventoryScientificProduction } from './inventory-validation';
import { applyPlatePlanObservationFixtureCommands } from './inventory-plate-plan-observation.fixtures';
import { adoptInventoryState, inventoryScientificReferences } from './inventory-adoption';
import { inventoryHasImportedAttribution } from './inventory-attribution';

it('records a measured product in one revision, preserving zero source and independent initial QA', () => {
  const fixture = inventoryScientificProductionFixture(),
    before = JSON.stringify(fixture.state),
    raw = JSON.stringify(fixture.input);
  const result = recordedScientificProductionFixture();
  expect(JSON.stringify(fixture.state)).toBe(before);
  expect(JSON.stringify(fixture.input)).toBe(raw);
  expect(result.recorded.revision).toBe(fixture.state.revision + 1);
  expect(result.recorded.stocks.stock.quantity).toEqual({ kind: 'known', value: '0', unit: 'uL' });
  expect(result.production.effects.lot.after).toMatchObject({
    name: '  Measured product batch  ',
    materialId: 'designed-dna',
    origin: { kind: 'prepared', inputs: [{ stockId: 'stock', materialId: 'material' }] },
    controls: { kind: 'managed', assessment: { value: 'unassessed', at: 100 } },
  });
  expect(result.production.effects.stock.after).toMatchObject({
    quantity: { kind: 'known', value: '5', unit: 'uL' },
    quality: 'quarantined',
    composition: { kind: 'unknown' },
  });
  expect(parseInventoryScientificProduction(result.production)).toEqual(result.production);
  expect(parseInventoryState(result.recorded)).toEqual(result.recorded);
  expect(inventoryScientificProductionChoices(result.production)).toEqual({
    identity: fixture.input.identity,
    context: fixture.input.context,
    design: fixture.input.design,
    inputs: fixture.input.inputs,
    output: fixture.input.output,
    method: fixture.input.method,
    reason: fixture.input.reason,
  });
  for (const key of [
    'vessels',
    'storage',
    'reservations',
    'scientificWorks',
    'platePlanObservations',
    'runValueAttributions',
    'platePlanVersions',
  ] as const)
    expect(result.recorded[key]).toEqual(fixture.state[key]);
  expect(inventoryScientificProductions(result.recorded)).toMatchObject([
    {
      id: result.production.id,
      inputStockCount: 1,
      output: { lotName: fixture.input.output.lotName },
    },
  ]);
});
it('keeps native time out of semantic preview and returns existing identity before current admission', () => {
  const f = inventoryScientificProductionFixture('16'),
    preview = inventoryScientificProductionPreview(f.state, f.input);
  expect(preview.kind).toBe('ready');
  if (preview.kind !== 'ready') throw new Error(JSON.stringify(preview));
  const later = inventoryScientificProductionPreview(f.state, { ...f.input, asOf: 101 });
  expect(later.kind === 'ready' && later.planDigest).toBe(preview.planDigest);
  const applied = applyInventoryScientificProduction(
    f.state,
    { ...f.input, expectedPlanDigest: preview.planDigest },
    { ...f.context, at: 101 }
  );
  expect(applied.ok).toBe(true);
  if (!applied.ok) throw new Error(applied.message);
  const stale = {
    ...f.input,
    source: null,
    designBinding: null,
    asOf: 0,
    target: { ...f.input.target, revision: 0, present: false },
  };
  const existing = inventoryScientificProductionPreview(applied.state, stale);
  expect(existing.kind).toBe('no-change');
  expect(existing.kind === 'no-change' && existing.production.at).toBe(101);
  expect(
    inventoryScientificProductionPreview(applied.state, { ...stale, method: 'Different meaning' })
  ).toMatchObject({ kind: 'blocked', issues: [{ code: 'SCIENTIFIC_PRODUCTION_CONFLICT' }] });
  const replay = applyInventoryScientificProduction(
    applied.state,
    { ...stale, expectedPlanDigest: preview.planDigest },
    { ...f.context, at: 0 }
  );
  expect(replay).toEqual({ ok: true, state: applied.state });
});
it('refuses held inputs, occupied output and invalid exact choices with no partial effects', () => {
  const f = inventoryScientificProductionFixture(),
    before = JSON.stringify(f.state);
  const held = applyPlatePlanObservationFixtureCommands(f.state, [
    { kind: 'set-quality', stockId: 'stock', quality: 'quarantined', reason: 'Hold for testing' },
  ]);
  const p = inventoryScientificProductionPreview(held, {
    ...f.input,
    target: { ...f.input.target, revision: held.revision },
  });
  expect(p).toMatchObject({ kind: 'blocked', issues: [{ code: 'STOCK_QUARANTINED' }] });
  const occupied = applyPlatePlanObservationFixtureCommands(f.state, [
    {
      kind: 'receive-stock',
      id: 'occupied',
      vesselId: f.input.output.vesselId,
      materialId: 'material',
      quantity: { kind: 'known', value: '1', unit: 'uL' },
      quality: 'usable',
    },
  ]);
  expect(
    inventoryScientificProductionPreview(occupied, {
      ...f.input,
      target: { ...f.input.target, revision: occupied.revision },
    })
  ).toMatchObject({ kind: 'blocked', issues: [{ code: 'STOCK_ALREADY_PRESENT' }] });
  for (const inputs of [
    [...f.input.inputs, ...f.input.inputs],
    [{ stockId: 'stock', quantity: { value: '8.0', unit: 'uL' as const } }],
    [{ stockId: 'stock', quantity: { value: '0', unit: 'uL' as const } }],
  ])
    expect(inventoryScientificProductionPreview(f.state, { ...f.input, inputs }).kind).toBe(
      'blocked'
    );
  expect(JSON.stringify(f.state)).toBe(before);
});
it('preserves immutable effects after ordinary current edits and rejects altered historical debits or initial QA', () => {
  const f = recordedScientificProductionFixture('16');
  const later = applyPlatePlanObservationFixtureCommands(
    f.recorded,
    [
      {
        kind: 'consume',
        stockId: 'stock',
        quantity: { value: '1', unit: 'uL' },
        reason: 'Later use',
      },
      {
        kind: 'set-quality',
        stockId: f.production.output.stockId,
        quality: 'usable',
        reason: 'Current quality observation',
      },
    ],
    102
  );
  expect(later.scientificProductions).toEqual(f.recorded.scientificProductions);
  expect(parseInventoryState(later).scientificProductions).toEqual(
    f.recorded.scientificProductions
  );
  for (const mutate of [
    (r: typeof f.production) => {
      (r.effects.sources[0].after.quantity as { value: string }).value = '9';
    },
    (r: typeof f.production) => {
      (r.effects.stock.after as { quality: string }).quality = 'usable';
    },
    (r: typeof f.production) => {
      (r.design.document as { length: number }).length = 0;
    },
  ]) {
    const changed = structuredClone(f.recorded);
    mutate(changed.scientificProductions[f.production.id]);
    expect(() => parseInventoryState(changed)).toThrow();
  }
});
it('maps physical material references and nested actors on adoption while retaining original design and intent', () => {
  const f = recordedScientificProductionFixture();
  expect(inventoryScientificReferences(f.recorded).map((r) => r.materialId)).toEqual([
    'designed-dna',
    'material',
  ]);
  const result = adoptInventoryState(
    null,
    f.recorded,
    {
      source: {
        projectId: 'project',
        inventoryId: 'inventory',
        revision: f.recorded.revision,
        archiveSha256: `sha256:${'e'.repeat(64)}`,
      },
      materialBindings: { material: 'foreign-source', 'designed-dna': 'foreign-product' },
    },
    { ...f.context, at: 200 }
  );
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  expect(result.ok).toBe(true);
  const row = result.state.scientificProductions[f.production.id];
  expect(row.design).toEqual(f.production.design);
  expect(row.materialBinding).toEqual({
    sourceMaterialId: 'designed-dna',
    destinationMaterialId: 'foreign-product',
  });
  expect(row.effects.sources[0].before.materialId).toBe('foreign-source');
  expect(row.effects.lot.after.materialId).toBe('foreign-product');
  expect(row.by.kind).toBe('imported');
  expect(
    row.effects.lot.after.controls.kind === 'managed' &&
      row.effects.lot.after.controls.assessment.by
  ).toEqual(row.by);
  expect(inventoryHasImportedAttribution(result.state)).toBe(true);
  expect(inventoryScientificProductionChoices(row)).toEqual(
    inventoryScientificProductionChoices(f.production)
  );
  expect(inventoryScientificProductionIntentSha256(inventoryScientificProductionChoices(row))).toBe(
    f.production.intentSha256
  );
});
it('upcasts raw28 without mutating its source and refuses new raw schema or maps under inherited false', () => {
  const f = inventoryScientificProductionFixture(),
    raw = structuredClone(f.state) as unknown as Record<string, unknown>;
  for (const key of [
    'equipmentIncidents',
    'equipmentIncidentReviewRoots',
    'equipmentIncidentFacts',
  ])
    delete raw[key];
  for (const row of inventoryIncidentTypedSnapshots(raw)) delete row.incidentReviewRootIds;
  raw.schema = 'dnaforge.inventory.v28';
  delete raw.scientificProductions;
  const text = JSON.stringify(raw),
    parsed = parseInventoryState(raw, { allowScientificProductions: false });
  expect(parsed.schema).toBe('dnaforge.inventory.v30');
  expect(parsed.scientificProductions).toEqual({});
  expect(JSON.stringify(raw)).toBe(text);
  expect(() => parseInventoryState(f.state, { allowScientificProductions: false })).toThrow(
    /scientific productions/
  );
  expect(() =>
    parseInventoryState(
      { ...raw, scientificProductions: {} },
      { allowScientificProductions: false }
    )
  ).toThrow(/scientific productions/);
  expect(() => parseInventoryState({ ...raw, scientificProductions: {} })).toThrow();
});
