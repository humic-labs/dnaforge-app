import { expect, it } from 'vitest';
import {
  inventoryPlatePlanObservationFixture,
  platePlanObservationContext,
} from './inventory-plate-plan-observation.fixtures';
import {
  applyInventoryPlatePlanObservation,
  inventoryPlatePlanObservationPreview,
} from './inventory-plate-plan-observations';
import {
  inventoryRunValueAttributionId,
  inventoryRunValueAttributionIntentSha256,
  inventoryRunValueAttributionWithdrawalId,
  inventoryRunValueAttributionWithdrawalIntentSha256,
} from './inventory-run-value-attribution-identity';
import { inventoryRunValueRowSha256 } from './inventory-run-value-attribution-value';
import type {
  InventoryRunValueAttribution,
  InventoryRunValueAttributionWithdrawal,
} from './inventory-run-value-attribution-types';
import { parseInventoryState } from './inventory-validation';
import { adoptInventoryState, inventoryScientificReferences } from './inventory-adoption';
import { inventoryHasImportedAttribution } from './inventory-attribution';
import { inventoryRecordIdExists } from './inventory-identity';
import { applyInventoryCommandBatch } from './inventory-state';

function fixture() {
  const initial = inventoryPlatePlanObservationFixture('60');
  const preview = inventoryPlatePlanObservationPreview(initial.state, initial.input);
  if (preview.kind !== 'ready') throw Error(JSON.stringify(preview));
  const applied = applyInventoryPlatePlanObservation(
    initial.state,
    { ...initial.input, expectedPlanDigest: preview.planDigest },
    initial.context
  );
  if (!applied.ok) throw Error(applied.message);
  const observation = preview.observation;
  const valueSnapshot = {
    key: 'count',
    label: 'Result count',
    value: { type: 'number' as const, value: 0, vendor: { annotation: ['retained', false, null] } },
    extra: { original: 'preserve complete row' },
  };
  const choices = {
    identity: { namespace: 'associations', attributionId: 'one' },
    runValue: {
      entityId: 'project::run',
      sourceSha256: `sha256:${'b'.repeat(64)}` as const,
      collection: 'outputs' as const,
      key: 'count',
      rowSha256: inventoryRunValueRowSha256('outputs', valueSnapshot),
    },
    physical: {
      observationId: observation.id,
      observationIntentSha256: observation.intentSha256,
      subject: { kind: 'source-stock' as const, stockId: observation.effects.sources[0].before.id },
    },
    predecessor: null,
    reason: 'This saved value describes the recorded subject',
  };
  const attribution: InventoryRunValueAttribution = {
    ...choices,
    id: inventoryRunValueAttributionId(choices.identity),
    intentSha256: inventoryRunValueAttributionIntentSha256(choices),
    source: {
      kind: 'native-observed-saved-source',
      projectId: 'project',
      workspaceScope: 'project',
      fileObjectUuid: 'run-file',
      title: 'Saved Run',
    },
    valueSnapshot,
    origin: { kind: 'local-actual' },
    at: 101,
    by: platePlanObservationContext.principal,
  };
  const withdrawalChoices = {
    identity: { namespace: 'associations', withdrawalId: 'withdraw-one' },
    attributionId: attribution.id,
    attributionIntentSha256: attribution.intentSha256,
    reason: 'Correct the recorded association',
  };
  const withdrawal: InventoryRunValueAttributionWithdrawal = {
    ...withdrawalChoices,
    id: inventoryRunValueAttributionWithdrawalId(withdrawalChoices.identity),
    intentSha256: inventoryRunValueAttributionWithdrawalIntentSha256(withdrawalChoices),
    at: 102,
    by: platePlanObservationContext.principal,
  };
  const state = {
    ...applied.state,
    revision: applied.state.revision + 2,
    lastRecordedAt: 102,
    runValueAttributions: { [attribution.id]: attribution },
    runValueAttributionWithdrawals: { [withdrawal.id]: withdrawal },
  };
  return { before: applied.state, state, attribution, withdrawal };
}

it('upcasts a nonempty v27 observation without rewriting it and refuses future maps on older schemas', () => {
  const { before } = fixture();
  const { scientificProductions, runValueAttributions, runValueAttributionWithdrawals, ...old } =
    before;
  const previous = { ...old, schema: 'dnaforge.inventory.v27' };
  const bytes = JSON.stringify(previous),
    parsed = parseInventoryState(previous);
  expect(parsed.schema).toBe('dnaforge.inventory.v29');
  expect(parsed.platePlanObservations).toEqual(before.platePlanObservations);
  expect(parsed.runValueAttributions).toEqual({});
  expect(parsed.runValueAttributionWithdrawals).toEqual({});
  expect(JSON.stringify(previous)).toBe(bytes);
  for (const field of ['runValueAttributions', 'runValueAttributionWithdrawals'])
    expect(() => parseInventoryState({ ...previous, [field]: {} })).toThrow();
});

it('preserves the complete raw value and terminal withdrawal through codecs and ordinary physical commands', () => {
  const { state, attribution, withdrawal } = fixture();
  expect(parseInventoryState(state)).toEqual(state);
  expect(
    parseInventoryState(JSON.parse(JSON.stringify(state))).runValueAttributions[attribution.id]
      .valueSnapshot
  ).toEqual(attribution.valueSnapshot);
  for (const record of [attribution, withdrawal]) {
    expect(inventoryRecordIdExists(state, record.id)).toBe(true);
    expect(
      applyInventoryCommandBatch(
        state,
        {
          expectedRevision: state.revision,
          commands: [
            {
              kind: 'create-vessel',
              id: record.id,
              name: 'Collision',
              placement: { kind: 'unplaced' },
            },
          ],
        },
        { ...platePlanObservationContext, at: 103 }
      )
    ).toMatchObject({ ok: false, code: 'ID_ALREADY_EXISTS' });
  }
  const changed = applyInventoryCommandBatch(
    state,
    {
      expectedRevision: state.revision,
      commands: [
        {
          kind: 'create-vessel',
          id: 'unrelated',
          name: 'Unrelated vessel',
          placement: { kind: 'unplaced' },
        },
      ],
    },
    { ...platePlanObservationContext, at: 103 }
  );
  if (!changed.ok) throw Error(changed.message);
  expect(changed.state.runValueAttributions).toEqual(state.runValueAttributions);
  expect(changed.state.runValueAttributionWithdrawals).toEqual(
    state.runValueAttributionWithdrawals
  );
  expect(parseInventoryState(changed.state)).toEqual(changed.state);
  const corrupt = structuredClone(state);
  (
    corrupt.runValueAttributions[attribution.id].valueSnapshot.extra as { original: string }
  ).original = 'silently changed';
  expect(() => parseInventoryState(corrupt)).toThrow();
});

it('adopts principals without rebinding saved sources, snapshots, physical identities or intents', () => {
  const { state, attribution, withdrawal } = fixture();
  const source = {
    archiveSha256: `sha256:${'c'.repeat(64)}`,
    projectId: 'foreign-project',
    inventoryId: 'foreign-inventory',
    revision: state.revision,
  };
  const adopted = adoptInventoryState(
    null,
    state,
    { source, materialBindings: { material: 'mapped-material' } },
    { ...platePlanObservationContext, at: 103 }
  );
  if (!adopted.ok) throw Error(adopted.message);
  expect(inventoryHasImportedAttribution(adopted.state)).toBe(true);
  expect(adopted.state.runValueAttributions[attribution.id]).toEqual({
    ...attribution,
    by: { kind: 'imported', source, principal: attribution.by },
  });
  expect(adopted.state.runValueAttributionWithdrawals[withdrawal.id]).toEqual({
    ...withdrawal,
    by: { kind: 'imported', source, principal: withdrawal.by },
  });
  expect(
    inventoryScientificReferences(state).some((ref) =>
      ref.pointers.some((pointer) => pointer.startsWith('/runValueAttributions/'))
    )
  ).toBe(false);
  expect(parseInventoryState(adopted.state)).toEqual(adopted.state);
});

it('retains complete raw28 attributions and withdrawals while upcasting only the new empty production map', () => {
  const { state, attribution, withdrawal } = fixture();
  const { scientificProductions, ...old } = state;
  const raw = { ...old, schema: 'dnaforge.inventory.v28' },
    text = JSON.stringify(raw);
  const parsed = parseInventoryState(raw, { allowScientificProductions: false });
  expect(parsed.scientificProductions).toEqual({});
  expect(parsed.runValueAttributions[attribution.id]).toEqual(attribution);
  expect(parsed.runValueAttributionWithdrawals[withdrawal.id]).toEqual(withdrawal);
  expect(parsed).toEqual(state);
  expect(JSON.stringify(raw)).toBe(text);
});
