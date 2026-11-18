import { expect, it } from 'vitest';
import {
  createInventoryState,
  type InventoryState,
  type InventoryCommand,
} from './inventory-types';
import { applyInventoryCommandBatch } from './inventory-state';
import {
  inventoryPlatePlanVersionPreview,
  applyInventoryPlatePlanVersion,
  inventoryPlatePlanVersions,
} from './inventory-plate-plans';
import { inventoryPlatePlanBindingPreview } from './inventory-plate-plan-binding';
import { parseInventoryPlatePlanDefinition } from './inventory-plate-plan-definition';
import { inventoryPlatePlanDefinitionSha256 } from './inventory-plate-plan-identity';
import { renderInventoryPlatePlanDiagram } from './inventory-plate-plan-diagram';
import { inventoryTableSha256 } from './inventory-table-binding';
import { adoptInventoryState } from './inventory-adoption';
import type {
  InventoryPlatePlanDefinition,
  InventoryPlatePlanVersionChoices,
  InventoryPlatePlanBindingPreviewInput,
} from './inventory-plate-plan-types';
import {
  inventoryApplyPlatePlanVersionRequestSchema,
  inventoryPlatePlanBindingPreviewSnapshotSchema,
  inventoryPlatePlanVersionReadSchema,
} from '../../../../apps/desktop/src/shared/inventory-plate-plans';
const principal = { kind: 'local-profile' as const, profileKey: 'a'.repeat(64) },
  context = { at: 100, principal, authority: principal };
const identity = { namespace: 'manual-plate-plans', planId: 'stable-family' };
function definition(rows = 2, columns = 3): InventoryPlatePlanDefinition {
  return {
    schema: 'dnaforge.inventory-plate-plan-definition.v1',
    title: 'Aliquot plan µL',
    layout: { kind: 'fixed-well', rows, columns },
    sourceSlots: [
      { key: 'template', label: 'Template' },
      { key: 'control', label: 'Positive control' },
    ],
    transfers: [
      {
        actionId: 'z-first',
        sourceSlotKey: 'template',
        destinationPosition: 'A3',
        quantity: { value: '4', unit: 'uL' },
        label: 'Template aliquot',
      },
      {
        actionId: 'a-second',
        sourceSlotKey: 'control',
        destinationPosition: 'B1',
        quantity: { value: '4', unit: 'uL' },
        label: 'Control aliquot',
      },
    ],
  };
}
function target(state: InventoryState) {
  return {
    projectId: 'project',
    inventoryId: 'inventory',
    present: state.revision !== 0,
    revision: state.revision,
  };
}
function save(state: InventoryState, def = definition(), reason = 'First saved instructions') {
  const choices: InventoryPlatePlanVersionChoices = { identity, definition: def, reason };
  const preview = inventoryPlatePlanVersionPreview(state, {
    ...choices,
    target: target(state),
    asOf: 100,
    principal,
    authority: principal,
  });
  if (preview.kind !== 'ready') throw Error(JSON.stringify(preview));
  const result = applyInventoryPlatePlanVersion(
    state,
    { ...choices, target: target(state), expectedPlanDigest: preview.planDigest },
    context
  );
  if (!result.ok) throw Error(result.message);
  return { state: result.state, version: preview.version, preview, choices };
}
function apply(state: InventoryState, commands: readonly InventoryCommand[]) {
  const result = applyInventoryCommandBatch(
    state,
    { expectedRevision: state.revision, commands },
    context
  );
  if (!result.ok) throw Error(result.message);
  return result.state;
}
function fixture(quantity = '8') {
  const saved = save(createInventoryState());
  const state = apply(saved.state, [
    {
      kind: 'create-layout-storage',
      id: 'plate',
      name: 'Physical plate',
      layout: { kind: 'fixed-well', rows: 2, columns: 3 },
      placement: { kind: 'root' },
    },
    { kind: 'create-vessel', id: 'vial', name: 'Source', placement: { kind: 'unplaced' } },
    {
      kind: 'receive-stock',
      id: 'stock',
      vesselId: 'vial',
      materialId: 'material',
      quantity: { kind: 'known', value: quantity, unit: 'uL' },
      quality: 'usable',
    },
  ]);
  const input: InventoryPlatePlanBindingPreviewInput = {
    target: target(state),
    binding: {
      versionId: saved.version.id,
      definitionSha256: saved.version.definitionSha256,
      destinationPlateId: 'plate',
      sources: [
        { sourceSlotKey: 'control', stockId: 'stock' },
        { sourceSlotKey: 'template', stockId: 'stock' },
      ],
    },
    asOf: 100,
    principal,
    authority: principal,
  };
  return { state, input, saved };
}
it('saves metadata into an absent inventory and reuses original A across A-B-A without replacing audit reason', () => {
  const initial = createInventoryState(),
    bytes = JSON.stringify(initial),
    a = save(initial, definition(8, 12)),
    b = save(a.state, definition(), 'A smaller logical grid');
  expect(JSON.stringify(initial)).toBe(bytes);
  expect(a.state.revision).toBe(1);
  for (const key of [
    'stocks',
    'storage',
    'vessels',
    'lots',
    'reservations',
    'scientificWorks',
    'scientificCitations',
  ] as const)
    expect(a.state[key]).toEqual(initial[key]);
  const preview = inventoryPlatePlanVersionPreview(b.state, {
    ...a.choices,
    reason: 'A new reason does not create a new content version',
    target: target(initial),
    asOf: 0,
    principal,
    authority: principal,
  });
  expect(preview).toMatchObject({
    kind: 'no-change',
    version: a.version,
    target: { revision: b.state.revision, present: true },
  });
  expect(inventoryPlatePlanVersions(b.state, identity)).toHaveLength(2);
  expect(inventoryPlatePlanVersions(b.state, { ...identity, planId: 'another-family' })).toEqual(
    []
  );
});
it('validates canonical input without rewriting accepted choices, local key order or exact text', () => {
  const saved = save(createInventoryState()),
    request = {
      project: 'project',
      inventoryId: 'inventory',
      kind: 'save-plate-plan-version' as const,
      operationId: 'save-once',
      expectedRevision: 0,
      expectedPlanDigest: saved.preview.planDigest,
      choices: {
        ...saved.choices,
        identity: { namespace: ' exact namespace ', planId: ' exact plan ' },
      },
    };
  const raw = JSON.stringify(request),
    parsed = inventoryApplyPlatePlanVersionRequestSchema.parse(request);
  expect(parsed).toEqual(request);
  expect(JSON.stringify(parsed.choices)).toBe(JSON.stringify(request.choices));
  expect(JSON.stringify(request)).toBe(raw);
  for (const quantity of [
    { value: '4.0', unit: 'uL' },
    { value: '0', unit: 'uL' },
    { value: '0.004', unit: 'mL' },
  ]) {
    const changed = {
      ...request,
      choices: {
        ...request.choices,
        definition: {
          ...request.choices.definition,
          transfers: [
            { ...request.choices.definition.transfers[0], quantity },
            request.choices.definition.transfers[1],
          ],
        },
      },
    };
    expect(inventoryApplyPlatePlanVersionRequestSchema.safeParse(changed).success).toBe(false);
    expect(() => parseInventoryPlatePlanDefinition(changed.choices.definition)).toThrow();
  }
  expect(
    inventoryApplyPlatePlanVersionRequestSchema.safeParse({ ...request, source: {} }).success
  ).toBe(false);
  const reordered = { ...definition(), transfers: [...definition().transfers].reverse() };
  expect(inventoryPlatePlanDefinitionSha256(reordered)).not.toBe(
    inventoryPlatePlanDefinitionSha256(definition())
  );
});
it('simulates aliased logical roles cumulatively and permits a zero projected balance without changing real state', () => {
  const { state, input } = fixture(),
    before = JSON.stringify(state),
    preview = inventoryPlatePlanBindingPreview(state, input);
  expect(preview.kind).toBe('ready');
  if (preview.kind !== 'ready') throw Error(JSON.stringify(preview));
  expect(preview.binding.sources.map((row) => row.sourceSlotKey)).toEqual(['template', 'control']);
  expect(preview.sources).toHaveLength(1);
  expect(preview.sources[0].sourceSlotKeys).toEqual(['template', 'control']);
  expect(preview.sources[0].demand).toEqual({ value: '8', unit: 'uL' });
  expect(preview.sources[0].projectedRemaining).toEqual({ value: '0', unit: 'uL' });
  expect(preview.destinations.map((row) => row.actionId)).toEqual(['z-first', 'a-second']);
  const wire = {
    ...preview,
    projectId: 'project',
    inventoryId: 'inventory',
    revision: state.revision,
  };
  expect(inventoryPlatePlanBindingPreviewSnapshotSchema.safeParse(wire).success).toBe(true);
  expect(
    inventoryPlatePlanBindingPreviewSnapshotSchema.safeParse({
      ...wire,
      sources: [{ ...wire.sources[0], availability: {} }],
    }).success
  ).toBe(false);
  expect(
    inventoryPlatePlanBindingPreviewSnapshotSchema.safeParse({
      ...wire,
      sources: [
        {
          ...wire.sources[0],
          availability: { ...wire.sources[0].availability, held: { value: 'NaN', unit: 'uL' } },
        },
      ],
    }).success
  ).toBe(false);
  expect(JSON.stringify(state)).toBe(before);
});
it('blocks aggregate overbooking, fully held stock after deadline, layout mismatch and occupied known-zero wells without projected partial results', () => {
  const short = fixture('6'),
    shortBefore = JSON.stringify(short.state),
    shortPreview = inventoryPlatePlanBindingPreview(short.state, short.input);
  expect(shortPreview).toMatchObject({
    kind: 'blocked',
    issues: [{ code: 'INSUFFICIENT_QUANTITY', pointer: '/binding' }],
  });
  expect(shortPreview.sources.every((row) => !('projectedRemaining' in row))).toBe(true);
  expect(JSON.stringify(short.state)).toBe(shortBefore);
  const held = fixture('10'),
    heldState = apply(held.state, [
      {
        kind: 'reserve-quantity',
        id: 'hold',
        stockId: 'stock',
        quantity: { value: '10', unit: 'uL' },
        deadline: 200,
        purpose: 'Explicit held material',
      },
    ]);
  expect(
    inventoryPlatePlanBindingPreview(heldState, {
      ...held.input,
      target: target(heldState),
      asOf: 200,
    })
  ).toMatchObject({
    kind: 'blocked',
    issues: [{ code: 'QUANTITY_RESERVED' }],
    sources: [{ availability: { held: { value: '10' }, unreserved: { value: '0' } } }],
  });
  const big = save(held.state, definition(8, 12));
  expect(
    inventoryPlatePlanBindingPreview(big.state, {
      ...held.input,
      target: target(big.state),
      binding: {
        ...held.input.binding,
        versionId: big.version.id,
        definitionSha256: big.version.definitionSha256,
      },
    })
  ).toMatchObject({ kind: 'blocked', issues: [{ code: 'INCOMPATIBLE_LAYOUT' }] });
  const occupied = apply(held.state, [
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
    inventoryPlatePlanBindingPreview(occupied, { ...held.input, target: target(occupied) })
  ).toMatchObject({ kind: 'blocked', issues: [{ code: 'STOCK_ALREADY_PRESENT' }] });
});
it('observes validity expiration exactly at its deadline without relying on revision changes', () => {
  const { state, input } = fixture('10'),
    managed = apply(state, [
      {
        kind: 'record-validity-decision',
        id: 'expiry',
        owner: { kind: 'stock', stockId: 'stock' },
        rule: { kind: 'absolute', deadlineAt: 200 },
        sourceText: 'Recorded exact deadline',
        sourcePrecision: 'instant',
        source: null,
        reason: 'Current local validity',
      },
    ]);
  const before = JSON.stringify(managed);
  expect(
    inventoryPlatePlanBindingPreview(managed, { ...input, target: target(managed), asOf: 199 })
  ).toMatchObject({ kind: 'ready', nextBoundaryAt: 200 });
  expect(
    inventoryPlatePlanBindingPreview(managed, { ...input, target: target(managed), asOf: 200 })
  ).toMatchObject({ kind: 'blocked', issues: [{ code: 'MATERIAL_EXPIRED' }] });
  expect(JSON.stringify(managed)).toBe(before);
});
it('renders exact coordinate/order/Unicode SVG safely and leaves metadata readable when labels overflow', () => {
  const def = { ...definition(8, 12), title: 'Plan <script> & µL' },
    saved = save(createInventoryState(), def),
    rendered = renderInventoryPlatePlanDiagram(saved.version);
  expect(rendered.kind).toBe('rendered');
  if (rendered.kind !== 'rendered') throw Error(JSON.stringify(rendered));
  const artifact = rendered.artifact;
  expect(artifact.svg.match(/>Unplanned<\/text>/g) ?? []).toHaveLength(94);
  expect(artifact.svg).toContain('H12');
  expect(artifact.svg).toContain('1. Template');
  expect(artifact.svg.indexOf('1. Template')).toBeLessThan(
    artifact.svg.indexOf('2. Positive control')
  );
  expect(artifact.svg).toContain('Plan &lt;script&gt; &amp; µL');
  expect(artifact.svg).not.toMatch(/<script|href=|foreignObject/iu);
  expect(artifact.sha256).toBe(inventoryTableSha256(artifact.svg));
  const wire = {
    kind: 'available',
    projectId: 'project',
    inventoryId: 'inventory',
    revision: saved.state.revision,
    version: saved.version,
    diagram: rendered,
  };
  expect(inventoryPlatePlanVersionReadSchema.safeParse(wire).success).toBe(true);
  expect(inventoryPlatePlanVersionReadSchema.safeParse({ ...wire, version: {} }).success).toBe(
    false
  );
  const long = save(saved.state, {
    ...definition(),
    sourceSlots: [{ key: 'template', label: 'x'.repeat(200) }, definition().sourceSlots[1]],
  });
  const refused = renderInventoryPlatePlanDiagram(long.version);
  expect(refused).toMatchObject({ kind: 'refused', code: 'LAYOUT_OVERFLOW' });
  expect(
    inventoryPlatePlanVersionReadSchema.safeParse({
      ...wire,
      version: long.version,
      diagram: refused,
    }).success
  ).toBe(true);
});
it('preserves version identity/content and wraps audit attribution on adoption without adding material references', () => {
  const saved = save(createInventoryState()),
    imported = adoptInventoryState(
      null,
      saved.state,
      {
        source: {
          archiveSha256: `sha256:${'a'.repeat(64)}`,
          projectId: 'foreign',
          inventoryId: 'foreign-inventory',
          revision: saved.state.revision,
        },
        materialBindings: {},
      },
      context
    );
  if (!imported.ok) throw Error(imported.message);
  const version = imported.state.platePlanVersions[saved.version.id];
  expect(version.identity).toEqual(saved.version.identity);
  expect(version.definition).toEqual(saved.version.definition);
  expect(version.definitionSha256).toBe(saved.version.definitionSha256);
  expect(version.reason).toBe(saved.version.reason);
  expect(version.by.kind).toBe('imported');
});
