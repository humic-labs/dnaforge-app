import { expect, it } from 'vitest';
import {
  inventoryRunValueAttributionFixture,
  inventoryRunValueSourceWithResult,
} from './inventory-run-value-attribution.fixtures';
import {
  inventoryRunValueCandidates,
  inventoryRunValueAttributionSelection,
  inventoryRunValueAttributionComparison,
} from './inventory-run-value-attribution-source';
import { inventoryRunValueRowSha256 } from './inventory-run-value-attribution-value';
import {
  inventoryRunValueAttributionPreview,
  applyInventoryRunValueAttribution,
  inventoryRunValueAttributionWithdrawalPreview,
  applyInventoryRunValueAttributionWithdrawal,
  inventoryRunValueAttributions,
} from './inventory-run-value-attributions';
import {
  inventoryRunValueAttributionId,
  inventoryRunValueAttributionIntentSha256,
} from './inventory-run-value-attribution-identity';
import {
  platePlanObservationTarget,
  applyPlatePlanObservationFixtureCommands,
} from './inventory-plate-plan-observation.fixtures';
import { parseInventoryState } from './inventory-validation';
import type { InventoryState } from './inventory-types';
import type { InventoryRunValueAttributionPreviewInput } from './inventory-run-value-attribution-types';

function record(state: InventoryState, input: InventoryRunValueAttributionPreviewInput) {
  const preview = inventoryRunValueAttributionPreview(state, {
    ...input,
    target: platePlanObservationTarget(state),
  });
  if (preview.kind !== 'ready') throw new Error(JSON.stringify(preview));
  const result = applyInventoryRunValueAttribution(
    state,
    { ...input, target: platePlanObservationTarget(state), expectedPlanDigest: preview.planDigest },
    { at: input.asOf, principal: input.principal, authority: input.authority }
  );
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return { state: result.state, attribution: preview.attribution };
}
function withdraw(
  state: InventoryState,
  attributionId: string,
  input: InventoryRunValueAttributionPreviewInput,
  withdrawalId = 'withdraw-base'
) {
  const attribution = state.runValueAttributions[attributionId],
    choices = {
      identity: { namespace: 'run-value-tests', withdrawalId },
      attributionId,
      attributionIntentSha256: attribution.intentSha256,
      reason: 'Correct the subject assertion',
    },
    preview = inventoryRunValueAttributionWithdrawalPreview(state, {
      ...choices,
      target: platePlanObservationTarget(state),
      asOf: input.asOf,
      principal: input.principal,
      authority: input.authority,
    });
  if (preview.kind !== 'ready') throw new Error(JSON.stringify(preview));
  const result = applyInventoryRunValueAttributionWithdrawal(
    state,
    {
      ...choices,
      target: platePlanObservationTarget(state),
      expectedPlanDigest: preview.planDigest,
    },
    { at: input.asOf, principal: input.principal, authority: input.authority }
  );
  if (!result.ok) throw new Error(result.message);
  return { state: result.state, withdrawal: preview.withdrawal };
}
it('retains complete candidate rows, known zero/false/empty/date and visible unsupported values', () => {
  const fixture = inventoryRunValueAttributionFixture(),
    candidates = inventoryRunValueCandidates(fixture.source);
  expect(candidates.rows.map((row) => [row.collection, row.key])).toEqual([
    ['inputs', 'sample'],
    ['outputs', 'result'],
    ['measurements', 'accepted'],
    ['measurements', 'date'],
    ['measurements', 'unsupported'],
  ]);
  expect(candidates.rows.map((row) => row.eligibility.kind)).toEqual([
    'eligible',
    'eligible',
    'eligible',
    'eligible',
    'unsupported',
  ]);
  expect(candidates.rows[1].row).toMatchObject({
    value: { type: 'number', value: 0, opaque: ['retained', 0, false] },
    rowExtra: { materialId: 'opaque-not-a-material-reference' },
  });
  expect(candidates.rows[1].origin).toMatchObject({ kind: 'frozen-declaration' });
  const selected = inventoryRunValueAttributionSelection(fixture.source, {
    collection: 'outputs',
    key: 'result',
  });
  expect(selected.valueSnapshot).toEqual(candidates.rows[1].row);
  expect(selected.runValue.rowSha256).toBe(
    inventoryRunValueRowSha256('outputs', candidates.rows[1].row)
  );
  expect(
    inventoryRunValueRowSha256('outputs', {
      ...selected.valueSnapshot,
      rowExtra: { different: true },
    })
  ).not.toBe(selected.runValue.rowSha256);
  expect(() =>
    inventoryRunValueRowSha256('outputs', { ...selected.valueSnapshot, invalidExtra: new Array(1) })
  ).toThrow(/JSON/);
  expect(() =>
    inventoryRunValueAttributionSelection(fixture.source, {
      collection: 'inputs',
      key: 'unrecorded',
    })
  ).toThrow(/missing/);
  expect(() =>
    inventoryRunValueAttributionSelection(fixture.source, {
      collection: 'measurements',
      key: 'unsupported',
    })
  ).toThrow(/type/);
});
it('adds one metadata revision for a new Run describing another Run physical output without changing physical facts', () => {
  const fixture = inventoryRunValueAttributionFixture(),
    before = structuredClone(fixture.state),
    original = fixture.source.originalText,
    result = record(fixture.state, fixture.input);
  expect(result.state.revision).toBe(before.revision + 1);
  expect(fixture.state).toEqual(before);
  expect(fixture.source.originalText).toBe(original);
  for (const key of Object.keys(before) as (keyof InventoryState)[])
    if (key !== 'revision' && key !== 'lastRecordedAt' && key !== 'runValueAttributions')
      expect(result.state[key]).toEqual(before[key]);
  expect(result.attribution.runValue.entityId).not.toBe(fixture.observation.context.entityId);
  expect(result.attribution.valueSnapshot.value.value).toBe(0);
  expect(fixture.observation.effects.destinations[0].after.quantity).toMatchObject({
    value: '4',
    unit: 'uL',
  });
  const used = applyPlatePlanObservationFixtureCommands(result.state, [
    {
      kind: 'consume',
      stockId: fixture.observation.effects.destinations[0].after.id,
      quantity: { value: '1', unit: 'uL' },
      reason: 'Later use',
    },
  ]);
  expect(parseInventoryState(used).runValueAttributions).toEqual(result.state.runValueAttributions);
  const wrong = {
    ...fixture.input,
    identity: { ...fixture.input.identity, attributionId: 'wrong-target' },
    physical: {
      ...fixture.input.physical,
      subject: { kind: 'source-stock' as const, stockId: 'not-in-observation' },
    },
  };
  expect(
    inventoryRunValueAttributionPreview(result.state, {
      ...wrong,
      target: platePlanObservationTarget(result.state),
    })
  ).toMatchObject({ kind: 'blocked', issues: [{ code: 'RUN_VALUE_ATTRIBUTION_TARGET_MISMATCH' }] });
  const tampered = structuredClone(result.state);
  (
    tampered.runValueAttributions[result.attribution.id].valueSnapshot.rowExtra as Record<
      string,
      unknown
    >
  ).changed = true;
  expect(() => parseInventoryState(tampered)).toThrow(/hash/);
});
it('keeps forever duplicates withdrawn and permits one explicit same-file/slot correction to new value and subject', () => {
  const fixture = inventoryRunValueAttributionFixture(),
    base = record(fixture.state, fixture.input),
    terminal = withdraw(base.state, base.attribution.id, fixture.input);
  for (const identity of [
    fixture.input.identity,
    { ...fixture.input.identity, attributionId: 'unused-duplicate' },
  ])
    expect(
      inventoryRunValueAttributionPreview(terminal.state, {
        ...fixture.input,
        identity,
        source: null,
      })
    ).toMatchObject({
      kind: 'no-change',
      attributionId: base.attribution.id,
      intentSha256: base.attribution.intentSha256,
      entry: {
        attribution: { id: base.attribution.id },
        withdrawal: { id: terminal.withdrawal.id },
      },
    });
  expect(
    inventoryRunValueAttributionPreview(terminal.state, {
      ...fixture.input,
      reason: 'Changed meaning',
      source: null,
    })
  ).toMatchObject({ kind: 'blocked', issues: [{ code: 'RUN_VALUE_ATTRIBUTION_CONFLICT' }] });
  const source = inventoryRunValueSourceWithResult(fixture.source, 1),
    selected = inventoryRunValueAttributionSelection(source, {
      collection: 'outputs',
      key: 'result',
    }),
    predecessor = {
      attributionId: base.attribution.id,
      attributionIntentSha256: base.attribution.intentSha256,
      withdrawalId: terminal.withdrawal.id,
      withdrawalIntentSha256: terminal.withdrawal.intentSha256,
    },
    childInput = {
      ...fixture.input,
      identity: { ...fixture.input.identity, attributionId: 'child' },
      runValue: selected.runValue,
      physical: {
        ...fixture.input.physical,
        subject: {
          kind: 'source-stock' as const,
          stockId: fixture.observation.effects.sources[0].before.id,
        },
      },
      predecessor,
      source,
      target: platePlanObservationTarget(terminal.state),
    };
  const child = record(terminal.state, childInput);
  expect(child.attribution.valueSnapshot.value.value).toBe(1);
  expect(child.attribution.physical.subject.kind).toBe('source-stock');
  expect(
    inventoryRunValueAttributionPreview(child.state, {
      ...childInput,
      identity: { ...childInput.identity, attributionId: 'fork' },
      reason: 'Fork attempt',
      physical: fixture.input.physical,
      target: platePlanObservationTarget(child.state),
    })
  ).toMatchObject({
    kind: 'blocked',
    issues: [{ code: 'RUN_VALUE_ATTRIBUTION_PREDECESSOR_MISMATCH' }],
  });
  const childTerminal = withdraw(child.state, child.attribution.id, childInput, 'withdraw-child');
  expect(
    inventoryRunValueAttributionPreview(childTerminal.state, { ...childInput, source: null })
  ).toMatchObject({
    kind: 'no-change',
    entry: { withdrawal: { id: childTerminal.withdrawal.id } },
  });
  expect(inventoryRunValueAttributions(childTerminal.state)).toHaveLength(2);
  expect(
    inventoryRunValueAttributions(childTerminal.state, {
      run: { projectId: 'foreign', workspaceScope: 'project', entityId: fixture.source.runId },
    })
  ).toEqual([]);
});
it('refuses correction across a replacement binding and fences changed source/row pins before admission', () => {
  const fixture = inventoryRunValueAttributionFixture(),
    base = record(fixture.state, fixture.input),
    terminal = withdraw(base.state, base.attribution.id, fixture.input),
    source = { ...fixture.source, fileObjectUuid: 'replacement-file' },
    selected = inventoryRunValueAttributionSelection(source, {
      collection: 'outputs',
      key: 'result',
    }),
    input = {
      ...fixture.input,
      identity: { ...fixture.input.identity, attributionId: 'replacement' },
      runValue: selected.runValue,
      source,
      target: platePlanObservationTarget(terminal.state),
      predecessor: {
        attributionId: base.attribution.id,
        attributionIntentSha256: base.attribution.intentSha256,
        withdrawalId: terminal.withdrawal.id,
        withdrawalIntentSha256: terminal.withdrawal.intentSha256,
      },
    };
  expect(inventoryRunValueAttributionPreview(terminal.state, input)).toMatchObject({
    kind: 'blocked',
    issues: [{ code: 'RUN_VALUE_ATTRIBUTION_PREDECESSOR_MISMATCH' }],
  });
  expect(
    inventoryRunValueAttributionPreview(terminal.state, { ...input, predecessor: null })
  ).toMatchObject({ kind: 'ready' });
  expect(
    inventoryRunValueAttributionPreview(fixture.state, {
      ...fixture.input,
      source: inventoryRunValueSourceWithResult(fixture.source, 1),
    })
  ).toMatchObject({ kind: 'blocked', issues: [{ code: 'SCIENTIFIC_CONTEXT_MISMATCH' }] });
  expect(inventoryRunValueAttributionId(fixture.input.identity)).toBe(base.attribution.id);
  expect(inventoryRunValueAttributionIntentSha256(fixture.input)).toBe(
    base.attribution.intentSha256
  );
});
it('compares current content independently of withdrawal and distinguishes row/source/binding/unavailable', () => {
  const fixture = inventoryRunValueAttributionFixture(),
    base = record(fixture.state, fixture.input),
    terminal = withdraw(base.state, base.attribution.id, fixture.input),
    entry = inventoryRunValueAttributions(terminal.state)[0];
  expect(inventoryRunValueAttributionComparison(entry, fixture.source)).toMatchObject({
    kind: 'same-source',
  });
  expect(entry.withdrawal).not.toBeNull();
  const changed = inventoryRunValueSourceWithResult(fixture.source, 1);
  expect(inventoryRunValueAttributionComparison(entry, changed)).toMatchObject({
    kind: 'changed-row',
    row: { row: { value: { value: 1 } } },
  });
  const raw = JSON.parse(fixture.source.originalText);
  raw.opaqueRoot = false;
  expect(
    inventoryRunValueAttributionComparison(entry, {
      ...fixture.source,
      originalText: JSON.stringify(raw),
    })
  ).toMatchObject({ kind: 'changed-source-same-row' });
  const unsupported = JSON.parse(fixture.source.originalText);
  unsupported.outputs[0].value = {
    type: 'quantity',
    lexical: '4 mystery',
    value: null,
    unit: 'mystery',
    unitCompatibility: 'unrecognized',
  };
  expect(
    inventoryRunValueAttributionComparison(entry, {
      ...fixture.source,
      originalText: JSON.stringify(unsupported),
    })
  ).toMatchObject({ kind: 'changed-row', row: { eligibility: { kind: 'unsupported' } } });
  const missing = JSON.parse(fixture.source.originalText);
  missing.outputs = [];
  expect(
    inventoryRunValueAttributionComparison(entry, {
      ...fixture.source,
      originalText: JSON.stringify(missing),
    })
  ).toMatchObject({ kind: 'missing-row' });
  expect(
    inventoryRunValueAttributionComparison(entry, {
      ...fixture.source,
      fileObjectUuid: 'replacement',
    })
  ).toMatchObject({ kind: 'replaced-binding' });
  expect(inventoryRunValueAttributionComparison(entry, null)).toMatchObject({
    kind: 'unavailable',
  });
  expect(inventoryRunValueAttributionComparison(entry, fixture.source)).toMatchObject({
    kind: 'same-source',
  });
});
