import {
  inventoryPlatePlanObservationFixture,
  platePlanObservationContext,
} from './inventory-plate-plan-observation.fixtures';
import {
  inventoryPlatePlanObservationPreview,
  applyInventoryPlatePlanObservation,
} from './inventory-plate-plan-observations';
import { adoptInventoryState, inventoryScientificReferences } from './inventory-adoption';
import { inventoryHasImportedAttribution } from './inventory-attribution';
import { inventoryRecordIdExists } from './inventory-identity';
import { applyInventoryCommandBatch } from './inventory-state';
import { expect, it } from 'vitest';
import { createInventoryState } from './inventory-types';
import { parseInventoryState } from './inventory-validation';
import {
  inventoryPlatePlanDefinitionSha256,
  inventoryPlatePlanVersionId,
} from './inventory-plate-plan-identity';
import type { InventoryPlatePlanDefinition } from './inventory-plate-plan-types';

it('upcasts retained v26 plan versions without rewriting bytes and rejects future observation maps', () => {
  const definition: InventoryPlatePlanDefinition = {
    schema: 'dnaforge.inventory-plate-plan-definition.v1',
    title: 'Retained reusable plan',
    layout: { kind: 'fixed-well', rows: 2, columns: 3 },
    sourceSlots: [{ key: 'template', label: 'Template' }],
    transfers: [
      {
        actionId: 'first',
        sourceSlotKey: 'template',
        destinationPosition: 'A3',
        quantity: { value: '4', unit: 'uL' },
        label: 'Template aliquot',
      },
    ],
  };
  const identity = { namespace: 'manual-plans', planId: 'retained' },
    definitionSha256 = inventoryPlatePlanDefinitionSha256(definition),
    id = inventoryPlatePlanVersionId(identity, definitionSha256),
    version = {
      id,
      identity,
      definitionSha256,
      definition,
      at: 10,
      by: { kind: 'local-profile' as const, profileKey: 'profile' },
      reason: 'Keep original reusable instructions',
    };
  const {
    equipmentIncidents,
    equipmentIncidentReviewRoots,
    equipmentIncidentFacts,
    scientificProductions,
    runValueAttributions,
    runValueAttributionWithdrawals,
    platePlanObservations,
    ...old
  } = createInventoryState();
  const previous = {
      ...old,
      schema: 'dnaforge.inventory.v26',
      revision: 1,
      lastRecordedAt: 10,
      platePlanVersions: { [id]: version },
    },
    bytes = JSON.stringify(previous),
    current = parseInventoryState(previous);
  expect(current.schema).toBe('dnaforge.inventory.v30');
  expect(current.platePlanObservations).toEqual({});
  expect(current.platePlanVersions).toEqual({ [id]: version });
  expect(JSON.stringify(previous)).toBe(bytes);
  const {
    equipmentIncidents: currentIncidents,
    equipmentIncidentReviewRoots: currentRoots,
    equipmentIncidentFacts: currentFacts,
    scientificProductions: currentProductions,
    runValueAttributions: currentAttributions,
    runValueAttributionWithdrawals: currentWithdrawals,
    platePlanObservations: currentObservations,
    schema,
    ...unchanged
  } = current;
  const { schema: previousSchema, ...original } = previous;
  expect(unchanged).toEqual(original);
  for (const invalid of [
    { ...previous, platePlanObservations: {} },
    { ...current, platePlanObservations: null },
    { ...current, platePlanObservations: undefined },
  ])
    expect(() => parseInventoryState(invalid)).toThrow();
});

function recorded() {
  const { state, input, context } = inventoryPlatePlanObservationFixture('60');
  const preview = inventoryPlatePlanObservationPreview(state, input);
  expect(preview.kind).toBe('ready');
  if (preview.kind !== 'ready') throw Error(JSON.stringify(preview));
  const applied = applyInventoryPlatePlanObservation(
    state,
    { ...input, expectedPlanDigest: preview.planDigest },
    context
  );
  expect(applied.ok).toBe(true);
  if (!applied.ok) throw Error(applied.message);
  return { state: applied.state, observation: preview.observation };
}

it('includes historical batch materials in adoption bindings and preserves original occurrence pins', () => {
  const { state, observation } = recorded();
  const references = inventoryScientificReferences(state);
  expect(references.find((row) => row.materialId === 'material')?.pointers).toContain(
    `/platePlanObservations/${observation.id}/effects/sources/0/before/materialId`
  );
  const source = {
    archiveSha256: `sha256:${'a'.repeat(64)}`,
    projectId: 'foreign-project',
    inventoryId: 'foreign-inventory',
    revision: state.revision,
  };
  const adopted = adoptInventoryState(
    null,
    state,
    { source, materialBindings: { material: 'resolved-material' } },
    { ...platePlanObservationContext, at: 101 }
  );
  expect(adopted.ok).toBe(true);
  if (!adopted.ok) throw Error(adopted.message);
  const retained = adopted.state.platePlanObservations[observation.id];
  expect(retained.id).toBe(observation.id);
  expect(retained.intentSha256).toBe(observation.intentSha256);
  expect(retained.context).toEqual(observation.context);
  expect(retained.binding).toEqual(observation.binding);
  expect(retained.plate).toEqual(observation.plate);
  expect(retained.by).toEqual({ kind: 'imported', source, principal: observation.by });
  expect(inventoryHasImportedAttribution(adopted.state)).toBe(true);
  for (const effect of retained.effects.sources) {
    expect(effect.before.materialId).toBe('resolved-material');
    expect(effect.after.materialId).toBe('resolved-material');
  }
  for (const effect of retained.effects.destinations)
    expect(effect.after.materialId).toBe('resolved-material');
  expect(parseInventoryState(adopted.state)).toEqual(adopted.state);
  expect(state.platePlanObservations[observation.id]).toEqual(observation);
});

it('reserves occurrence identities across ordinary physical commands without erasing reports', () => {
  const { state, observation } = recorded();
  expect(inventoryRecordIdExists(state, observation.id)).toBe(true);
  const collision = applyInventoryCommandBatch(
    state,
    {
      expectedRevision: state.revision,
      commands: [
        {
          kind: 'create-vessel',
          id: observation.id,
          name: 'Conflicting physical identity',
          placement: { kind: 'unplaced' },
        },
      ],
    },
    { ...platePlanObservationContext, at: 101 }
  );
  expect(collision).toMatchObject({ ok: false, code: 'ID_ALREADY_EXISTS' });
  const changed = applyInventoryCommandBatch(
    state,
    {
      expectedRevision: state.revision,
      commands: [
        {
          kind: 'create-vessel',
          id: 'unrelated-vessel',
          name: 'Later vessel',
          placement: { kind: 'unplaced' },
        },
      ],
    },
    { ...platePlanObservationContext, at: 101 }
  );
  expect(changed.ok).toBe(true);
  if (!changed.ok) throw Error(changed.message);
  expect(changed.state.platePlanObservations).toEqual(state.platePlanObservations);
  expect(parseInventoryState(changed.state)).toEqual(changed.state);
});
