import { expect, it } from 'vitest';
import { applyInventoryCommandBatch } from './inventory-state';
import { createInventoryState, type InventoryState } from './inventory-types';
import { parseInventoryState } from './inventory-validation';
import { adoptInventoryState } from './inventory-adoption';
import {
  applyInventoryScientificTransfer,
  inventoryNotebookSourceSha256,
  inventoryScientificTransferPreview,
} from './inventory-scientific';
import type { InventoryNotebookSavedSource } from './inventory-scientific-types';
import { inventoryScientificTransferIntentSha256V2 } from './inventory-scientific-source';

const principal = { kind: 'local-profile' as const, profileKey: 'profile' };
const context = { at: 100, principal, authority: principal };
function fixture(): InventoryState {
  const result = applyInventoryCommandBatch(
    createInventoryState(),
    {
      expectedRevision: 0,
      commands: [
        { kind: 'create-vessel', id: 'source', name: 'Source', placement: { kind: 'unplaced' } },
        { kind: 'create-vessel', id: 'target', name: 'Target', placement: { kind: 'unplaced' } },
        {
          kind: 'receive-stock',
          id: 'stock',
          vesselId: 'source',
          materialId: 'material',
          quantity: { kind: 'known', value: '2', unit: 'mg' },
          quality: 'usable',
        },
        {
          kind: 'record-expected-delivery',
          id: 'expected',
          name: 'Expected material',
          supplier: null,
          externalReference: null,
          materialId: 'material',
          quantity: { value: '3', unit: 'mg' },
          reason: 'Local expectation',
        },
        {
          kind: 'record-reorder-rule',
          id: 'rule',
          name: 'Reserve threshold',
          materialId: 'material',
          threshold: { value: '1', unit: 'mg' },
          actionBasis: 'reserve',
          validityBasis: 'current-recorded-rules',
          reason: 'Explicit local policy',
        },
      ],
    },
    context
  );
  if (!result.ok) throw Error(result.message);
  return result.state;
}
function observed(): InventoryState {
  const state = fixture();
  const source: InventoryNotebookSavedSource = {
    schema: 'dnaforge.notebook-saved-source.v1',
    projectId: 'project',
    workspaceScope: 'project',
    pageId: 'project::page',
    fileObjectUuid: 'file',
    title: 'Experiment',
    content: { type: 'doc', content: [] },
  };
  const input = {
    identity: { namespace: 'manual', workId: 'observed-once' },
    pageId: source.pageId,
    expectedSourceSha256: inventoryNotebookSourceSha256(source),
    sourceStockId: 'stock',
    destinationVesselId: 'target',
    quantity: { value: '0.5', unit: 'mg' as const },
    reason: 'Completed manual aliquot',
    source,
    target: { projectId: 'project', inventoryId: 'inventory', present: true, revision: 1 },
  };
  const preview = inventoryScientificTransferPreview(state, {
    ...input,
    asOf: 101,
    principal,
    authority: principal,
  });
  if (preview.kind !== 'ready') throw Error('Scientific fixture preview must be ready.');
  const result = applyInventoryScientificTransfer(
    state,
    { ...input, expectedPlanDigest: preview.planDigest },
    { ...context, at: 102 }
  );
  if (!result.ok) throw Error(result.message);
  return result.state;
}

function runObserved(): InventoryState {
  const state = observed();
  const original = Object.values(state.scientificWorks)[0];
  const runContext = {
    kind: 'protocol-run' as const,
    projectId: 'project',
    workspaceScope: 'project',
    entityId: 'project::run',
    source: { ...original.context.source },
  };
  const work = {
    ...original,
    context: runContext,
    intentSha256: inventoryScientificTransferIntentSha256V2({
      identity: original.identity,
      context: {
        kind: runContext.kind,
        entityId: runContext.entityId,
        sourceSha256: runContext.source.sha256,
      },
      sourceStockId: original.transfer.sourceStockId,
      destinationVesselId: original.transfer.destination.vesselId,
      quantity: original.transfer.quantity,
      reason: original.reason,
    }),
  };
  return { ...state, scientificWorks: { [work.id]: work } };
}

it('upcasts v22 without changing stockroom facts or persisting invented scientific work', () => {
  const state = fixture();
  const {
    platePlanVersions,
    scientificWorks,
    scientificCitations,
    scientificCitationWithdrawals,
    ...previous
  } = state;
  const old = { ...previous, schema: 'dnaforge.inventory.v22' };
  const original = JSON.stringify(old);
  const current = parseInventoryState(old);
  expect(current).toEqual(state);
  expect(current.scientificWorks).toEqual({});
  expect(JSON.stringify(old)).toBe(original);
});

it('preserves historical before and after quantities when current stock changes', () => {
  const state = observed();
  const result = applyInventoryCommandBatch(
    state,
    {
      expectedRevision: state.revision,
      commands: [
        {
          kind: 'consume',
          stockId: 'stock',
          quantity: { value: '0.25', unit: 'mg' },
          reason: 'Later independent use',
        },
      ],
    },
    { ...context, at: 103 }
  );
  if (!result.ok) throw Error(result.message);
  const parsed = parseInventoryState(result.state);
  expect(parsed.scientificWorks).toEqual(state.scientificWorks);
  expect(parsed.stocks.stock.quantity).toEqual({ kind: 'known', value: '1250000', unit: 'ng' });
});

it('upcasts v23 without changing a saved notebook observation or its source and intent pins', () => {
  const state = observed();
  const { platePlanVersions, scientificCitations, scientificCitationWithdrawals, ...previous } =
    state;
  const old = { ...previous, schema: 'dnaforge.inventory.v23' };
  const original = JSON.stringify(old);
  const workBytes = JSON.stringify(old.scientificWorks);
  const current = parseInventoryState(old);
  expect(current).toEqual(state);
  expect(JSON.stringify(current.scientificWorks)).toBe(workBytes);
  expect(JSON.stringify(old)).toBe(original);
});

it('admits explicit run context only under v24 without reinterpreting notebook-shaped records', () => {
  const state = runObserved();
  expect(parseInventoryState(state)).toEqual(state);
  const { platePlanVersions, scientificCitations, scientificCitationWithdrawals, ...previous } =
    state;
  expect(() => parseInventoryState({ ...previous, schema: 'dnaforge.inventory.v23' })).toThrow(
    'v23'
  );
  const mixed = structuredClone(state);
  Object.assign(Object.values(mixed.scientificWorks)[0].context, { pageId: 'project::page' });
  expect(() => parseInventoryState(mixed)).toThrow();
});

it.each(['unscoped', 'wrong-scope', 'source-pin', 'kind'])(
  'refuses a run observation with altered %s context',
  (field) => {
    const state = structuredClone(runObserved());
    const work = Object.values(state.scientificWorks)[0];
    if (field === 'unscoped') Object.assign(work.context, { entityId: 'run' });
    if (field === 'wrong-scope') Object.assign(work.context, { workspaceScope: 'other' });
    if (field === 'source-pin')
      Object.assign(work.context.source, { sha256: `sha256:${'0'.repeat(64)}` });
    if (field === 'kind')
      Object.assign(work.context, { kind: 'notebook-page', pageId: 'project::run' });
    expect(() => parseInventoryState(state)).toThrow();
  }
);

it('adopts run effects and attribution while retaining foreign context and physical identities', () => {
  const state = runObserved();
  const work = Object.values(state.scientificWorks)[0];
  const result = adoptInventoryState(
    null,
    state,
    {
      source: {
        archiveSha256: `sha256:${'a'.repeat(64)}`,
        projectId: 'source-project',
        inventoryId: 'source-inventory',
        revision: state.revision,
      },
      materialBindings: { material: 'destination-material' },
    },
    { ...context, at: 200 }
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw Error(result.message);
  const imported = result.state.scientificWorks[work.id];
  expect(imported.context).toEqual(work.context);
  expect(imported.transfer).toEqual(work.transfer);
  expect(imported.intentSha256).toBe(work.intentSha256);
  expect(imported.by).toMatchObject({ kind: 'imported', principal });
  for (const stock of [
    imported.effects.source.before,
    imported.effects.source.after,
    imported.effects.destination.after,
  ])
    expect(stock.materialId).toBe('destination-material');
  expect(parseInventoryState(result.state)).toEqual(result.state);
});

it.each(['identity', 'intent', 'debit', 'credit', 'clock', 'provenance'])(
  'refuses altered scientific observation %s',
  (field) => {
    const state = structuredClone(observed());
    const work = Object.values(state.scientificWorks)[0];
    if (field === 'identity') Object.assign(work.identity, { workId: 'different' });
    if (field === 'intent') Object.assign(work, { intentSha256: `sha256:${'0'.repeat(64)}` });
    if (field === 'debit') Object.assign(work.effects.source.after.quantity, { value: '1499999' });
    if (field === 'credit')
      Object.assign(work.effects.destination.after.quantity, { value: '500001' });
    if (field === 'clock') Object.assign(work, { at: state.lastRecordedAt + 1 });
    if (field === 'provenance')
      Object.assign(work.effects.destination.after, { materialId: 'other' });
    expect(() => parseInventoryState(state)).toThrow();
  }
);
