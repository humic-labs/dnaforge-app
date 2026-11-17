import { benchlingCaptureChoices } from './__tests__/benchling-capture-fixture';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectInventoryBenchlingCapture } from './inventory-benchling-source';
import {
  applyInventoryBenchlingCapture,
  inventoryBenchlingCapturePreview,
  normalizeInventoryBenchlingCaptureStocks,
} from './inventory-benchling-application';
import type {
  InventoryBenchlingCaptureChoices,
  InventoryBenchlingCapturedChoice,
  InventoryBenchlingCapturePreviewInput,
  InventoryBenchlingRecordDecision,
} from './inventory-benchling-application-types';
import {
  adoptInventoryState,
  applyInventoryCommandBatch,
  inventoryTableBindingKey,
  inventoryVesselContents,
  inventoryStoragePositions,
  inventoryTableSha256,
  inventoryWellId,
  parseInventoryState,
  type InventoryCommand,
  type InventoryState,
} from './inventory';
const maxBytes = 17 * 1024 * 1024;
const text = readFileSync(
  resolve(
    import.meta.dirname,
    '../../../../test-fixtures/lims-import/benchling-physical/representative-capture.json'
  ),
  'utf8'
);
const context = {
  at: 1000,
  principal: { kind: 'agent' as const, identityId: 'importer' },
  authority: { kind: 'local-profile' as const, profileKey: 'a'.repeat(64) },
};
const fingerprint = inventoryTableSha256('current material file');
const reason = 'Explicit synthetic capture interpretation';
const target = (state: InventoryState | null, inventoryId = 'inventory') => ({
  projectId: 'project',
  inventoryId,
  present: state !== null,
  revision: state?.revision ?? 0,
});
const choices = (sourceText = text) => benchlingCaptureChoices(sourceText);
function input(
  state: InventoryState | null,
  sourceText = text,
  options = choices(sourceText),
  inventoryId = 'inventory'
): InventoryBenchlingCapturePreviewInput {
  return {
    sourceText,
    options,
    target: target(state, inventoryId),
    bindings: options.records.flatMap((decision) =>
      decision.disposition === 'vessel' && decision.contents.kind === 'identify'
        ? [
            {
              sourceId: decision.record.sourceId,
              materialId: decision.contents.materialId,
              kind: 'admitted' as const,
              fingerprint,
            },
          ]
        : []
    ),
    asOf: Math.max(context.at, state?.lastRecordedAt ?? 0),
    principal: context.principal,
    authority: context.authority,
    maxBytes,
  };
}
function imported(
  state: InventoryState | null = null,
  sourceText = text,
  options = choices(sourceText),
  inventoryId = 'inventory'
) {
  const facts = input(state, sourceText, options, inventoryId);
  const preview = inventoryBenchlingCapturePreview(state, facts);
  if (preview.kind !== 'ready') throw new Error(JSON.stringify(preview));
  const result = applyInventoryBenchlingCapture(
    state,
    { ...facts, options: preview.options, expectedPlanDigest: preview.planDigest },
    { ...context, at: facts.asOf + 10 },
    maxBytes
  );
  if (!result.ok) throw new Error(result.message);
  return { state: result.state, preview };
}
const vessel = (state: InventoryState, sourceId: string) =>
  state.vesselBindings[inventoryTableBindingKey('benchling:synthetic-physical-example', sourceId)]
    .vesselId;
function manual(state: InventoryState, commands: readonly InventoryCommand[]) {
  const result = applyInventoryCommandBatch(
    state,
    { expectedRevision: state.revision, commands },
    { ...context, at: state.lastRecordedAt + 1 }
  );
  if (!result.ok) throw new Error(result.message);
  return parseInventoryState(result.state);
}
function editSource(change: (capture: any) => void, source = text) {
  const capture = JSON.parse(source);
  change(capture);
  return JSON.stringify(capture);
}
function editBody(capture: any, responseId: string, change: (body: any) => void) {
  const response = capture.responses.find((item: any) => item.id === responseId);
  const body = JSON.parse(response.bodyText);
  change(body);
  response.bodyText = JSON.stringify(body);
}

describe('atomic Benchling capture application', () => {
  it('imports all16 explicit records in one revision with exact stocks and unresolved physical knowledge', () => {
    const { state, preview } = imported();
    expect(state.revision).toBe(1);
    expect(Object.keys(state.hierarchyBindings)).toHaveLength(5);
    expect(Object.keys(state.vesselBindings)).toHaveLength(8);
    expect(Object.keys(state.tableBindings)).toHaveLength(3);
    expect(Object.keys(state.stocks)).toHaveLength(3);
    expect(inventoryVesselContents(state, vessel(state, 'con_empty'))).toEqual({
      kind: 'declared-empty',
    });
    expect(inventoryVesselContents(state, vessel(state, 'con_multiple'))?.kind).toBe(
      'unidentified'
    );
    expect(inventoryVesselContents(state, vessel(state, 'con_count'))?.kind).toBe('unidentified');
    expect(inventoryVesselContents(state, vessel(state, 'con_missing'))?.kind).toBe('unobserved');
    const zero = Object.values(state.stocks).find(
      (stock) => stock.vesselId === vessel(state, 'con_well_zero')
    )!;
    expect(zero.quantity).toEqual({ kind: 'known', value: '0', unit: 'uL' });
    expect(inventoryVesselContents(state, zero.vesselId)?.kind).toBe('identified');
    const filled = Object.values(state.stocks).find(
      (stock) => stock.vesselId === vessel(state, 'con_filled')
    )!;
    expect(filled.quantity).toEqual({ kind: 'known', value: '10.25', unit: 'uL' });
    expect(filled.quality).toBe('quarantined');
    const matrix =
      state.hierarchyBindings[
        inventoryTableBindingKey('benchling:synthetic-physical-example', 'plt_matrix')
      ].storageId;
    expect(Object.keys(state.storage[matrix].configuration.unavailablePositions)).toEqual([
      'A2',
      'B1',
      'B2',
    ]);
    const plate =
      state.hierarchyBindings[
        inventoryTableBindingKey('benchling:synthetic-physical-example', 'plt_fixed')
      ].storageId;
    expect(inventoryVesselContents(state, inventoryWellId(plate, 'B1'))?.kind).toBe('unobserved');
    expect(preview.commands.every((command) => command.kind !== 'receive-stock')).toBe(true);
    expect(parseInventoryState(state)).toEqual(state);
  });
  it('regenerates canonical preimages statelessly from retained source and saved resolved choices', () => {
    const { preview } = imported();
    const normalized = normalizeInventoryBenchlingCaptureStocks(text, preview.options, maxBytes);
    expect(normalized.kind).toBe('normalized');
    if (normalized.kind !== 'normalized') throw new Error('Expected normalized stock source.');
    expect(normalized.rows).toEqual(preview.options.normalizedStockRows);
    const forged = structuredClone(preview.options) as any;
    forged.normalizedStockRows[0].quantity = '999';
    expect(normalizeInventoryBenchlingCaptureStocks(text, forged, maxBytes).kind).toBe('blocked');
  });
  it('keeps later moves, consumption and knowledge when response order or explanatory reasons change', () => {
    let { state } = imported();
    const stock = Object.values(state.stocks).find(
      (stock) => stock.vesselId === vessel(state, 'con_filled')
    )!;
    state = manual(state, [
      { kind: 'set-quality', stockId: stock.id, quality: 'usable', reason },
      { kind: 'consume', stockId: stock.id, quantity: { value: '1', unit: 'uL' }, reason },
      { kind: 'move-vessel', id: vessel(state, 'con_multiple'), placement: { kind: 'unplaced' } },
      {
        kind: 'record-vessel-contents',
        vesselId: vessel(state, 'con_empty'),
        knowledge: 'unobserved',
        reason,
      },
    ]);
    const reordered = editSource((capture) => capture.responses.reverse());
    const options = choices(reordered);
    (options as any).records = [...options.records].reverse();
    const result = inventoryBenchlingCapturePreview(state, input(state, reordered, options));
    expect(result.kind).toBe('no-change');
    expect(state.stocks[stock.id].quantity).toEqual({ kind: 'known', value: '9.25', unit: 'uL' });
    expect(inventoryVesselContents(state, vessel(state, 'con_empty'))?.kind).toBe('unobserved');
  });
  it('resolves original physical and stock IDs before generating IDs after archive adoption', () => {
    const { state } = imported();
    const adopted = adoptInventoryState(
      null,
      state,
      {
        source: {
          archiveSha256: fingerprint,
          projectId: 'old',
          inventoryId: 'old',
          revision: state.revision,
        },
        materialBindings: { 'material-a': 'adopted-a', 'material-b': 'adopted-b' },
      },
      { ...context, at: 3000 }
    );
    if (!adopted.ok) throw new Error(adopted.message);
    const options = choices();
    for (const choice of options.records)
      if (choice.disposition === 'vessel' && choice.contents.kind === 'identify')
        (choice.contents as any).materialId =
          choice.contents.materialId === 'material-a' ? 'adopted-a' : 'adopted-b';
    expect(
      inventoryBenchlingCapturePreview(
        adopted.state,
        input(adopted.state, text, options, 'adopted-inventory')
      ).kind
    ).toBe('no-change');
  });
  it('preserves one physical vessel when a previously empty captured container later gains identified contents', () => {
    let { state } = imported();
    const id = vessel(state, 'con_empty');
    state = manual(state, [{ kind: 'move-vessel', id, placement: { kind: 'unplaced' } }]);
    const changed = editSource((capture) =>
      editBody(capture, 'box-page-1', (body) => {
        body.containers[0].contents = [{ entity: { id: 'seq_A' } }];
        body.containers[0].quantity.value = 5;
      })
    );
    const options = choices(changed);
    const decision = options.records.find(
      (choice) => choice.record.sourceId === 'con_empty'
    ) as Extract<InventoryBenchlingRecordDecision, { disposition: 'vessel' }>;
    (decision as any).contents = {
      kind: 'identify',
      selection: (decision.contents as any).selection,
      quantity: (decision.contents as any).quantity,
      materialId: 'material-a',
      quality: { value: 'usable', reason },
      reason,
    };
    const result = imported(state, changed, options);
    expect(vessel(result.state, 'con_empty')).toBe(id);
    expect(result.state.vessels[id].placement).toEqual({ kind: 'unplaced' });
    expect(Object.keys(result.state.vessels)).toHaveLength(Object.keys(state.vessels).length);
    expect(
      Object.values(result.state.stocks).find((stock) => stock.vesselId === id)?.quantity
    ).toMatchObject({ value: '5' });
  });
  it('blocks changed physical facts and stock source amounts at their original target without partial effects', () => {
    const { state } = imported();
    for (const changed of [
      editSource((capture) =>
        editBody(capture, 'freezer', (body) => {
          body.name = 'Renamed foreign freezer';
        })
      ),
      editSource((capture) =>
        editBody(capture, 'box-page-1', (body) => {
          body.containers[1].quantity.value = 12;
        })
      ),
    ]) {
      const before = JSON.stringify(state);
      const preview = inventoryBenchlingCapturePreview(state, input(state, changed));
      expect(preview.kind).toBe('blocked');
      expect(preview.rows.some((row) => row.kind === 'needs-reconciliation' && row.targetId)).toBe(
        true
      );
      expect(JSON.stringify(state)).toBe(before);
    }
  });
  it('refuses late occupied destinations and forged observation references without changing the original state', () => {
    const options = choices();
    const decision = options.records.find(
      (choice) => choice.record.sourceId === 'con_multiple'
    ) as Extract<InventoryBenchlingRecordDecision, { disposition: 'vessel' }>;
    if (decision.target.kind !== 'movable' || decision.target.placement.kind !== 'source')
      throw new Error('Expected source tube');
    (decision.target.placement as any).position = {
      value: 'A1',
      basis: 'declared-mapping',
      reason,
    };
    expect(inventoryBenchlingCapturePreview(null, input(null, text, options)).kind).toBe('blocked');
    const bad = choices();
    const location = bad.records.find((choice) => choice.record.kind === 'location') as Extract<
      InventoryBenchlingRecordDecision,
      { disposition: 'storage' }
    >;
    (location as any).name.pointer = '/quantity';
    expect(inventoryBenchlingCapturePreview(null, input(null, text, bad)).kind).toBe('blocked');
  });
  it('never declares contents[] physically empty from positive or unresolved volume', () => {
    for (const value of [1, null]) {
      const changed = editSource((capture) =>
        editBody(capture, 'box-page-1', (body) => {
          body.containers[0].quantity.value = value;
        })
      );
      expect(inventoryBenchlingCapturePreview(null, input(null, changed)).kind).toBe('blocked');
    }
  });
  it('requires exact unavailable policies and exposes domain-derived coordinates', () => {
    const options = choices();
    (options as any).uncapturedPositions = [];
    const result = inventoryBenchlingCapturePreview(null, input(null, text, options));
    expect(result.kind).toBe('blocked');
    expect(result.uncapturedPositions).toContainEqual({
      storageSourceId: 'plt_matrix',
      kind: 'unavailable',
      positions: ['A2', 'B1', 'B2'],
    });
  });
  it('refuses ambiguous storage source IDs even when one colliding record is skipped', () => {
    const changed = editSource((capture) => {
      const response = capture.responses.find((item: any) => item.id === 'box');
      const body = JSON.parse(response.bodyText);
      body.id = 'loc_freezer';
      response.bodyText = JSON.stringify(body);
      response.request.path = '/api/v2/boxes/loc_freezer';
    });
    const inspection = inspectInventoryBenchlingCapture(changed, maxBytes);
    const original = choices().records.find(
      (item) => item.record.kind === 'location' && item.record.sourceId === 'loc_freezer'
    )!;
    const options: InventoryBenchlingCaptureChoices = {
      scopeAcceptance: { kind: 'selected-records', reason },
      uncapturedPositions: [],
      sourceIssueDispositions: inspection.issues.map(({ code, responseId, bodyPointer }) => ({
        code,
        responseId,
        bodyPointer,
        reason,
      })),
      records: inspection.records.map(
        (record): InventoryBenchlingRecordDecision =>
          record.kind === 'location' && record.sourceId === 'loc_freezer'
            ? original
            : record.kind === 'box-schema' || record.kind === 'plate-schema'
              ? {
                  record: { kind: record.kind, sourceId: record.sourceId },
                  disposition: 'evidence',
                  reason,
                }
              : {
                  record: { kind: record.kind as any, sourceId: record.sourceId },
                  disposition: 'skip',
                  reason,
                }
      ),
    };
    expect(inventoryBenchlingCapturePreview(null, input(null, changed, options))).toMatchObject({
      kind: 'blocked',
      issues: [{ code: 'BENCHLING_STORAGE_ID_AMBIGUOUS' }],
    });
  });
  it('refuses an oversized complete proposal instead of splitting or publishing an accepted prefix', () => {
    const ids = Array.from({ length: 257 }, (_, index) => `source-container-${index}`);
    const capture = JSON.parse(text);
    capture.responses = ids.map((id) => ({
      id,
      request: { method: 'GET', path: `/api/v2/containers/${id}`, query: {} },
      bodyText: JSON.stringify({ id, name: id }),
    }));
    const sourceText = JSON.stringify(capture);
    const options: InventoryBenchlingCaptureChoices = {
      scopeAcceptance: { kind: 'selected-records', reason },
      sourceIssueDispositions: [],
      uncapturedPositions: [],
      records: ids.map((sourceId) => ({
        record: { kind: 'container', sourceId },
        disposition: 'vessel',
        target: {
          kind: 'movable',
          name: { kind: 'declared', value: sourceId, reason },
          placement: { kind: 'unplaced', basis: { kind: 'declared', reason } },
        },
        contents: { kind: 'unobserved', reason },
      })),
    };
    expect(inventoryBenchlingCapturePreview(null, input(null, sourceText, options))).toMatchObject({
      kind: 'blocked',
      issues: [{ code: 'BENCHLING_BATCH_TOO_LARGE' }],
    });
  });
  it('does not pin advancing native time into the plan digest', () => {
    const first = inventoryBenchlingCapturePreview(null, input(null));
    const second = inventoryBenchlingCapturePreview(null, { ...input(null), asOf: 2000 });
    expect(first.kind).toBe('ready');
    expect(second.kind).toBe('ready');
    expect(first.planDigest).toBe(second.planDigest);
  });
  it('advances only one real revision even when the private plan has several phases', () => {
    const state = manual(imported().state, [
      {
        kind: 'create-vessel',
        id: 'independent',
        name: 'Independent',
        placement: { kind: 'unplaced' },
      },
    ]);
    const base = parseInventoryState({ ...state, revision: Number.MAX_SAFE_INTEGER - 1 });
    const changed = editSource((capture) => {
      capture.namespace = 'second-explicit-source';
    });
    const options = choices(changed);
    for (const item of options.records)
      if (item.disposition === 'storage' && item.record.sourceId === 'loc_freezer')
        (item as any).name = { kind: 'declared', value: 'Second freezer', reason };
    expect(imported(base, changed, options).state.revision).toBe(Number.MAX_SAFE_INTEGER);
  });
  it('binds a newly captured empty permanent well without a dummy physical command', () => {
    const { state } = imported();
    const changed = editSource((capture) =>
      editBody(capture, 'fixed-plate', (body) => {
        body.wells.B1 = {
          id: 'con_well_later',
          parentStorageId: 'plt_fixed',
          contents: [],
          quantity: { value: 0, units: 'uL' },
        };
      })
    );
    const options = choices(changed);
    const later = options.records.find(
      (item) => item.record.sourceId === 'con_well_later'
    ) as Extract<InventoryBenchlingRecordDecision, { disposition: 'vessel' }>;
    const inspection = inspectInventoryBenchlingCapture(changed, maxBytes);
    const claim = inspection.placements.find((item) => item.containerId === 'con_well_later')!;
    const rec = inspection.records.find((item) => item.sourceId === 'con_well_later')!;
    const select = (field: string) => ({
      kind: 'captured' as const,
      responseId: rec.fields[field].observations[0].responseId,
      pointer: rec.fields[field].observations[0].pointer,
      reason,
    });
    (later as any).target = {
      kind: 'fixed-well',
      plateSourceId: 'plt_fixed',
      position: { value: 'B1', basis: 'captured-exact', reason },
      basis: { kind: 'membership', responseId: claim.responseId, pointer: claim.pointer, reason },
    };
    (later as any).contents = {
      kind: 'empty',
      selection: select('contents'),
      quantity: { kind: 'source-volume', sourceField: 'quantity', selection: select('quantity') },
      reason,
    };
    const next = imported(state, changed, options);
    expect(next.preview.commands).toEqual([]);
    expect(next.state.revision).toBe(state.revision + 1);
    expect(vessel(next.state, 'con_well_later')).toBe(
      inventoryWellId(
        next.state.hierarchyBindings[
          inventoryTableBindingKey('benchling:synthetic-physical-example', 'plt_fixed')
        ].storageId,
        'B1'
      )
    );
    expect(inventoryVesselContents(next.state, vessel(next.state, 'con_well_later'))?.kind).toBe(
      'unobserved'
    );
    expect(
      inventoryBenchlingCapturePreview(next.state, input(next.state, changed, options)).kind
    ).toBe('no-change');
  });
});
