import { expect, it } from 'vitest';
import { createInventoryState, type InventoryState } from './inventory-types';
import { parseInventoryState, parseInventoryPlatePlanVersion } from './inventory-validation';
import { applyInventoryCommandBatch } from './inventory-state';
import { adoptInventoryState, inventoryScientificReferences } from './inventory-adoption';
import { inventoryHasImportedAttribution } from './inventory-attribution';
import { inventoryRecordIdExists } from './inventory-identity';
import {
  inventoryPlatePlanDefinitionSha256,
  inventoryPlatePlanVersionId,
} from './inventory-plate-plan-identity';
import type {
  InventoryPlatePlanDefinition,
  InventoryPlatePlanVersion,
} from './inventory-plate-plan-types';

const principal = { kind: 'local-profile' as const, profileKey: 'profile' };
const definition: InventoryPlatePlanDefinition = {
  schema: 'dnaforge.inventory-plate-plan-definition.v1',
  title: 'Aliquot plan',
  layout: { kind: 'fixed-well', rows: 8, columns: 12 },
  sourceSlots: [{ key: 'template', label: 'Template' }],
  transfers: [
    {
      actionId: 'first',
      sourceSlotKey: 'template',
      destinationPosition: 'A3',
      quantity: { value: '4', unit: 'uL' },
      label: 'First aliquot',
    },
  ],
};
function fixture(): { state: InventoryState; version: InventoryPlatePlanVersion } {
  const identity = { namespace: 'manual-plans', planId: 'one-family' },
    hash = inventoryPlatePlanDefinitionSha256(definition);
  const version: InventoryPlatePlanVersion = {
    id: inventoryPlatePlanVersionId(identity, hash),
    identity,
    definitionSha256: hash,
    definition,
    at: 10,
    by: principal,
    reason: 'Reusable intended layout',
  };
  return {
    state: {
      ...createInventoryState(),
      revision: 1,
      lastRecordedAt: 10,
      platePlanVersions: { [version.id]: version },
    },
    version,
  };
}
it('upcasts v25 with an empty plan map without rewriting input and refuses future maps on old schemas', () => {
  const { state } = fixture();
  const { platePlanVersions, ...old } = state;
  const prior = { ...old, schema: 'dnaforge.inventory.v25' },
    bytes = JSON.stringify(prior);
  const parsed = parseInventoryState(prior);
  expect(parsed.platePlanVersions).toEqual({});
  expect(parsed.scientificCitations).toEqual(state.scientificCitations);
  expect(parsed.scientificCitationWithdrawals).toEqual(state.scientificCitationWithdrawals);
  expect(JSON.stringify(prior)).toBe(bytes);
  expect(() => parseInventoryState({ ...prior, platePlanVersions: {} })).toThrow();
});
it('binds exact version identity and definition while preserving it through physical commands', () => {
  const { state, version } = fixture();
  expect(parseInventoryPlatePlanVersion(version)).toEqual(version);
  expect(parseInventoryState(state)).toEqual(state);
  for (const changed of [
    { id: 'other' },
    { definitionSha256: 'sha256:' + '0'.repeat(64) },
    { definition: { ...definition, title: 'Different intended layout' } },
    { at: 11 },
  ]) {
    expect(() =>
      parseInventoryState({
        ...state,
        platePlanVersions: { [version.id]: { ...version, ...changed } },
      })
    ).toThrow();
  }
  const moved = applyInventoryCommandBatch(
    state,
    {
      expectedRevision: 1,
      commands: [
        {
          kind: 'create-vessel',
          id: 'later-vessel',
          name: 'Later vessel',
          placement: { kind: 'unplaced' },
        },
      ],
    },
    { at: 11, principal, authority: principal }
  );
  expect(moved.ok).toBe(true);
  if (!moved.ok) throw Error(moved.message);
  expect(moved.state.platePlanVersions).toEqual(state.platePlanVersions);
  expect(inventoryRecordIdExists(moved.state, version.id)).toBe(true);
  expect(() =>
    parseInventoryState({
      ...moved.state,
      vessels: {
        ...moved.state.vessels,
        [version.id]: { ...moved.state.vessels['later-vessel'], id: version.id },
      },
    })
  ).toThrow();
});
it('preserves foreign plan identity and first reason while mapping attribution during adoption', () => {
  const { state, version } = fixture();
  const source = {
    archiveSha256: 'sha256:' + 'a'.repeat(64),
    projectId: 'foreign',
    inventoryId: 'foreign-inventory',
    revision: 1,
  };
  expect(inventoryScientificReferences(state)).toEqual([]);
  expect(inventoryHasImportedAttribution(state)).toBe(false);
  const adopted = adoptInventoryState(
    null,
    state,
    { source, materialBindings: {} },
    { at: 11, principal, authority: principal }
  );
  expect(adopted.ok).toBe(true);
  if (!adopted.ok) throw Error(adopted.message);
  expect(adopted.state.platePlanVersions[version.id]).toEqual({
    ...version,
    by: { kind: 'imported', source, principal },
  });
  expect(inventoryHasImportedAttribution(adopted.state)).toBe(true);
  expect(inventoryScientificReferences(adopted.state)).toEqual([]);
  const twice = adoptInventoryState(
    null,
    adopted.state,
    { source: { ...source, archiveSha256: 'sha256:' + 'b'.repeat(64) }, materialBindings: {} },
    { at: 12, principal, authority: principal }
  );
  expect(twice.ok).toBe(true);
  if (!twice.ok) throw Error(twice.message);
  expect(twice.state.platePlanVersions[version.id].by).toEqual(
    adopted.state.platePlanVersions[version.id].by
  );
});
it('does not accept guessed coordinates, noncanonical volumes or extension fields', () => {
  const { state, version } = fixture();
  for (const update of [
    { destinationPosition: 'A03' },
    { quantity: { value: '4.0', unit: 'uL' } },
    { quantity: { value: '0.004', unit: 'mL' } },
    { sourceSlotKey: 'guessed' },
    { extra: true },
  ]) {
    const def = { ...definition, transfers: [{ ...definition.transfers[0], ...update }] };
    expect(() =>
      parseInventoryState({
        ...state,
        platePlanVersions: { [version.id]: { ...version, definition: def } },
      })
    ).toThrow();
  }
});
