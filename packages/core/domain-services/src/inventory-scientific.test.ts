import { expect, it } from 'vitest';
import { adoptInventoryState } from './inventory-adoption';
import { inventoryWellId } from './inventory-layout';
import {
  applyInventoryScientificTransfer,
  inventoryNotebookSourceSha256,
  inventoryScientificStockId,
  inventoryScientificTransferExisting,
  inventoryScientificTransferIntentSha256,
  inventoryScientificTransferIntentSha256V2,
  inventoryProtocolRunSourceSha256,
  inventoryScientificTransferPreviewV2,
  applyInventoryScientificTransferV2,
  inventoryScientificTransferPreview,
  inventoryScientificWorkId,
} from './inventory-scientific';
import { applyInventoryCommandBatch } from './inventory-state';
import {
  createInventoryState,
  type InventoryCommand,
  type InventoryState,
} from './inventory-types';
import { parseInventoryState } from './inventory-validation';
import type {
  InventoryNotebookSavedSource,
  InventoryScientificTransferChoices,
  InventoryScientificTransferPreviewInput,
  InventoryScientificTransferChoicesV2,
  InventoryProtocolRunSavedSource,
} from './inventory-scientific-types';

function v2Choices(value = choices()): InventoryScientificTransferChoicesV2 {
  const { pageId, expectedSourceSha256, ...fields } = value;
  return {
    ...fields,
    context: { kind: 'notebook-page', entityId: pageId, sourceSha256: expectedSourceSha256 },
  };
}
function runSource(): InventoryProtocolRunSavedSource {
  return {
    schema: 'dnaforge.protocol-run-saved-source.v1',
    projectId: 'project',
    workspaceScope: 'project',
    runId: 'project::run',
    fileObjectUuid: 'run-file',
    title: 'Saved Run',
    originalText: JSON.stringify({
      schema: 'dnaforge.protocol-run.v1',
      kind: 'protocol_run',
      id: 'run',
      title: 'Saved Run',
      status: 'in_progress',
      immutable: false,
      protocol: {
        sourceId: 'protocol',
        destinationId: 'project::protocol',
        name: 'Protocol',
        pinnedVersionId: 'source-v1',
        pinnedVersionHash: `sha256:${'a'.repeat(64)}`,
      },
      inputs: [],
      outputs: [],
      measurements: [],
      tables: [],
      links: [],
      startedAt: null,
      completedAt: null,
      amendments: [],
      provenance: { provider: 'dnaforge', immutableSource: false },
    }),
  };
}

const principal = { kind: 'local-profile' as const, profileKey: 'profile' };
const context = { at: 100, principal, authority: principal };
const source: InventoryNotebookSavedSource = {
  schema: 'dnaforge.notebook-saved-source.v1',
  projectId: 'project',
  workspaceScope: 'project',
  pageId: 'project::page',
  fileObjectUuid: 'file-object',
  title: 'Observed experiment',
  content: {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Transfer 10 µL to A1' }] }],
  },
};
function apply(state: InventoryState, commands: readonly InventoryCommand[], at = 100) {
  const result = applyInventoryCommandBatch(
    state,
    { expectedRevision: state.revision, commands },
    { ...context, at }
  );
  if (!result.ok) throw Error(`${result.code}: ${result.message}`);
  return result.state;
}
function fixture(): InventoryState {
  return apply(createInventoryState(), [
    {
      kind: 'create-layout-storage',
      id: 'plate',
      name: 'Plate',
      layout: { kind: 'fixed-well', rows: 1, columns: 2 },
      placement: { kind: 'root' },
    },
    { kind: 'create-storage', id: 'box', name: 'Box', slots: ['A'], placement: { kind: 'root' } },
    { kind: 'create-vessel', id: 'vial', name: 'Source vial', placement: { kind: 'unplaced' } },
    {
      kind: 'receive-stock',
      id: 'stock',
      vesselId: 'vial',
      materialId: 'dna',
      quantity: { kind: 'known', value: '100', unit: 'uL' },
      quality: 'usable',
    },
  ]);
}
function choices(): InventoryScientificTransferChoices {
  return {
    identity: { namespace: 'manual-work', workId: 'transfer-once' },
    pageId: source.pageId,
    expectedSourceSha256: inventoryNotebookSourceSha256(source),
    sourceStockId: 'stock',
    destinationVesselId: inventoryWellId('plate', 'A1'),
    quantity: { value: '10', unit: 'uL' },
    reason: 'Operator observed the completed manual transfer',
  };
}
function input(state: InventoryState, value = choices()): InventoryScientificTransferPreviewInput {
  return {
    ...value,
    target: {
      projectId: 'project',
      inventoryId: 'inventory',
      present: true,
      revision: state.revision,
    },
    source,
    asOf: 100,
    principal,
    authority: principal,
  };
}
function recorded(state = fixture()) {
  const request = input(state),
    preview = inventoryScientificTransferPreview(state, request);
  if (preview.kind !== 'ready') throw Error(JSON.stringify(preview));
  const result = applyInventoryScientificTransfer(
    state,
    { ...request, expectedPlanDigest: preview.planDigest },
    { ...context, at: 110 }
  );
  if (!result.ok) throw Error(`${result.code}: ${result.message}`);
  return { state: result.state, request, preview };
}

it('previews without mutation and records one existing transfer with exact original and resulting stock facts', () => {
  const before = fixture(),
    bytes = JSON.stringify(before),
    { state, preview } = recorded(before),
    work = state.scientificWorks[inventoryScientificWorkId(choices().identity)],
    destination = inventoryScientificStockId(choices().identity);
  expect(JSON.stringify(before)).toBe(bytes);
  expect(preview.work.at).toBe(100);
  expect(state.revision).toBe(before.revision + 1);
  expect(state.lastRecordedAt).toBe(110);
  expect(work.at).toBe(110);
  expect(state.stocks.stock.quantity).toEqual({ kind: 'known', value: '90', unit: 'uL' });
  expect(state.stocks[destination].quantity).toEqual({ kind: 'known', value: '10', unit: 'uL' });
  expect(work.effects.source.before).toEqual(before.stocks.stock);
  expect(work.effects.source.after).toEqual(state.stocks.stock);
  expect(work.effects.destination.before).toBeNull();
  expect(work.effects.destination.after).toEqual(state.stocks[destination]);
  expect(work.effects.destination.vessel).toMatchObject({
    kind: 'fixed-well',
    placement: { kind: 'located', storageId: 'plate', slotId: 'A1' },
  });
  expect(state.stocks[destination].materialId).toBe('dna');
  expect(state.stocks[destination].source).toEqual(before.stocks.stock.source);
  expect(state.stocks[destination].lotConstraints).toEqual(before.stocks.stock.lotConstraints);
  expect(work.context.source).toEqual({
    kind: 'native-observed-saved-source',
    sha256: choices().expectedSourceSha256,
    fileObjectUuid: 'file-object',
    title: source.title,
  });
  expect(JSON.stringify(work)).not.toContain('"content":');
  expect(parseInventoryState(state)).toEqual(state);
});

it('never repeats physical effects after later use, movement, disposal or unavailable current notebook source', () => {
  const saved = recorded(),
    original = structuredClone(saved.state.scientificWorks),
    destination = inventoryScientificStockId(choices().identity),
    later = apply(
      saved.state,
      [
        {
          kind: 'consume',
          stockId: 'stock',
          quantity: { value: '5', unit: 'uL' },
          reason: 'Later experiment',
        },
        {
          kind: 'consume',
          stockId: destination,
          quantity: { value: '2', unit: 'uL' },
          reason: 'Later experiment',
        },
        {
          kind: 'move-vessel',
          id: 'vial',
          placement: { kind: 'located', storageId: 'box', slotId: 'A' },
        },
        { kind: 'dispose-vessel', id: 'vial', reason: 'Discarded remaining source' },
      ],
      120
    ),
    request = { ...input(later), source: null, asOf: 130 },
    before = JSON.stringify(later),
    preview = inventoryScientificTransferPreview(later, request);
  expect(preview.kind).toBe('no-change');
  expect(preview.commands).toEqual([]);
  const result = applyInventoryScientificTransfer(
    later,
    { ...request, expectedPlanDigest: saved.preview.planDigest },
    { ...context, at: 130 }
  );
  expect(result).toEqual({ ok: true, state: later });
  expect(result.ok && result.state).toBe(later);
  expect(JSON.stringify(later)).toBe(before);
  expect(later.scientificWorks).toEqual(original);
  expect(parseInventoryState(later)).toEqual(later);
});

it('normalizes equivalent units for stable observation identity and refuses changed meaning without source access', () => {
  const { state } = recorded(),
    value = choices();
  expect(
    inventoryScientificTransferIntentSha256({ ...value, quantity: { value: '0.01', unit: 'mL' } })
  ).toBe(inventoryScientificTransferIntentSha256(value));
  expect(
    inventoryScientificTransferExisting(state, {
      ...value,
      quantity: { value: '10000', unit: 'nL' },
    }).kind
  ).toBe('no-change');
  for (const changed of [
    { ...value, quantity: { value: '9', unit: 'uL' as const } },
    { ...value, destinationVesselId: inventoryWellId('plate', 'A2') },
    { ...value, pageId: 'project::different-page' },
    {
      ...value,
      expectedSourceSha256: inventoryNotebookSourceSha256({ ...source, title: 'Later saved page' }),
    },
    { ...value, reason: 'Different observed work' },
  ]) {
    const before = JSON.stringify(state),
      preview = inventoryScientificTransferPreview(state, {
        ...input(state, changed),
        source: null,
      });
    expect(preview).toMatchObject({
      kind: 'blocked',
      issues: [{ code: 'SCIENTIFIC_WORK_CONFLICT' }],
    });
    expect(JSON.stringify(state)).toBe(before);
  }
});

it('pins the actual notebook file identity and exact structured source while refusing stale or cross-project capture', () => {
  const state = fixture(),
    request = input(state),
    current = inventoryScientificTransferPreview(state, request);
  expect(current.kind).toBe('ready');
  expect(inventoryNotebookSourceSha256({ ...source, fileObjectUuid: 'replacement-file' })).not.toBe(
    request.expectedSourceSha256
  );
  for (const packet of [
    null,
    { ...source, projectId: 'different-project' },
    { ...source, content: { type: 'doc', content: [] } },
    { ...source, fileObjectUuid: 'replacement-file' },
  ]) {
    const preview = inventoryScientificTransferPreview(state, { ...request, source: packet });
    expect(preview).toMatchObject({
      kind: 'blocked',
      issues: [{ code: 'SCIENTIFIC_CONTEXT_MISMATCH' }],
    });
  }
  const invalidSource = { ...source, title: 'Notebook\0title' },
    invalidRequest = {
      ...request,
      source: invalidSource,
      expectedSourceSha256: inventoryNotebookSourceSha256(invalidSource),
    },
    original = JSON.stringify(state);
  expect(inventoryScientificTransferPreview(state, invalidRequest)).toMatchObject({
    kind: 'blocked',
    issues: [{ code: 'INVALID_INVENTORY_INPUT' }],
  });
  if (current.kind !== 'ready') throw Error('Ready preview required');
  expect(
    applyInventoryScientificTransfer(
      state,
      { ...invalidRequest, expectedPlanDigest: current.planDigest },
      { ...context, at: 110 }
    )
  ).toMatchObject({ ok: false, code: 'INVALID_INVENTORY_INPUT' });
  expect(JSON.stringify(state)).toBe(original);
  const later = apply(
      state,
      [
        {
          kind: 'consume',
          stockId: 'stock',
          quantity: { value: '1', unit: 'uL' },
          reason: 'Other work',
        },
      ],
      101
    ),
    before = JSON.stringify(later),
    result = applyInventoryScientificTransfer(
      later,
      { ...request, expectedPlanDigest: current.planDigest },
      { ...context, at: 110 }
    );
  expect(result).toMatchObject({ ok: false, code: 'REVISION_CONFLICT' });
  expect(JSON.stringify(later)).toBe(before);
});

it('preserves existing transfer admission and atomic refusal instead of storing an unperformed observation', () => {
  const cases: readonly { commands: readonly InventoryCommand[]; code: string }[] = [
    {
      commands: [{ kind: 'set-quality', stockId: 'stock', quality: 'quarantined', reason: 'Hold' }],
      code: 'STOCK_QUARANTINED',
    },
    {
      commands: [
        {
          kind: 'reconcile',
          stockId: 'stock',
          quantity: { kind: 'unknown', unit: 'uL' },
          reason: 'Unmeasured',
        },
      ],
      code: 'QUANTITY_UNKNOWN',
    },
    {
      commands: [
        {
          kind: 'reserve-quantity',
          id: 'hold',
          stockId: 'stock',
          quantity: { value: '95', unit: 'uL' },
          deadline: null,
          purpose: 'Other work',
        },
      ],
      code: 'QUANTITY_RESERVED',
    },
    {
      commands: [
        {
          kind: 'record-validity-decision',
          id: 'cutoff',
          owner: { kind: 'stock', stockId: 'stock' },
          rule: { kind: 'absolute', deadlineAt: 100 },
          sourceText: 'Explicit cutoff',
          sourcePrecision: 'instant',
          source: null,
          reason: 'Recorded policy',
        },
      ],
      code: 'MATERIAL_EXPIRED',
    },
    {
      commands: [
        {
          kind: 'receive-stock',
          id: 'occupied',
          vesselId: inventoryWellId('plate', 'A1'),
          materialId: 'dna',
          quantity: { kind: 'known', value: '1', unit: 'uL' },
          quality: 'usable',
        },
      ],
      code: 'STOCK_ALREADY_PRESENT',
    },
  ];
  for (const row of cases) {
    const state = apply(fixture(), row.commands),
      before = JSON.stringify(state),
      preview = inventoryScientificTransferPreview(state, input(state));
    expect(preview).toMatchObject({ kind: 'blocked', issues: [{ code: row.code }] });
    expect(Object.keys(state.scientificWorks)).toEqual([]);
    expect(JSON.stringify(state)).toBe(before);
  }
});

it('keeps source provenance and physical work identity through explicit material remapping on adoption', () => {
  const { state } = recorded(),
    work = Object.values(state.scientificWorks)[0],
    adopted = adoptInventoryState(
      null,
      state,
      {
        source: {
          archiveSha256: `sha256:${'a'.repeat(64)}`,
          projectId: 'project',
          inventoryId: 'inventory',
          revision: state.revision,
        },
        materialBindings: { dna: 'local-dna' },
      },
      { ...context, at: 200 }
    );
  expect(adopted.ok).toBe(true);
  if (!adopted.ok) throw Error(adopted.message);
  const imported = adopted.state.scientificWorks[work.id];
  expect(imported.id).toBe(work.id);
  expect(imported.identity).toEqual(work.identity);
  expect(imported.intentSha256).toBe(work.intentSha256);
  expect(imported.context).toEqual(work.context);
  expect(imported.by.kind).toBe('imported');
  expect(imported.effects.source.before.materialId).toBe('local-dna');
  expect(imported.effects.source.after.materialId).toBe('local-dna');
  expect(imported.effects.destination.after.materialId).toBe('local-dna');
  expect(parseInventoryState(adopted.state)).toEqual(adopted.state);
  expect(
    inventoryScientificTransferPreview(adopted.state, {
      ...input(adopted.state),
      target: {
        projectId: 'local-project',
        inventoryId: 'local-inventory',
        present: true,
        revision: adopted.state.revision,
      },
      source: null,
    }).kind
  ).toBe('no-change');
});

it('preserves the frozen pre-extension V1 digest for either Notebook request format', () => {
  const original: InventoryScientificTransferChoices = {
    identity: { namespace: 'frozen-manual', workId: 'frozen-work' },
    pageId: 'project::page',
    expectedSourceSha256: `sha256:${'a'.repeat(64)}`,
    sourceStockId: 'source-stock',
    destinationVesselId: 'plate:well:A1',
    quantity: { value: '0.01', unit: 'mL' },
    reason: 'Observed completed transfer',
  };
  const frozen = 'sha256:1d21cb9553bac879edfad35b3dc56ca26e7f58e91e72a1f2e1cacb852507cc1d';
  expect(inventoryScientificTransferIntentSha256(original)).toBe(frozen);
  expect(inventoryScientificTransferIntentSha256V2(v2Choices(original))).toBe(frozen);
});

it('normalizes a fresh V2 Notebook call to the original observation before live source or physical admission', () => {
  const saved = recorded(),
    before = JSON.stringify(saved.state),
    request = {
      ...v2Choices(),
      target: input(saved.state).target,
      source: null,
      asOf: 120,
      principal,
      authority: principal,
    };
  expect(inventoryScientificTransferPreviewV2(saved.state, request).kind).toBe('no-change');
  const result = applyInventoryScientificTransferV2(
    saved.state,
    { ...request, expectedPlanDigest: saved.preview.planDigest },
    { ...context, at: 120 }
  );
  expect(result.ok && result.state).toBe(saved.state);
  expect(JSON.stringify(saved.state)).toBe(before);
  expect(
    inventoryScientificTransferPreviewV2(saved.state, {
      ...request,
      context: { ...request.context, kind: 'protocol-run' },
    })
  ).toMatchObject({ kind: 'blocked', issues: [{ code: 'SCIENTIFIC_WORK_CONFLICT' }] });
});

it('records a Run context through the same physical reducer and preserves it across explicit adoption', () => {
  const state = fixture(),
    packet = runSource(),
    request = {
      ...v2Choices(),
      context: {
        kind: 'protocol-run' as const,
        entityId: packet.runId,
        sourceSha256: inventoryProtocolRunSourceSha256(packet),
      },
      target: input(state).target,
      source: packet,
      asOf: 100,
      principal,
      authority: principal,
    },
    preview = inventoryScientificTransferPreviewV2(state, request),
    before = JSON.stringify(state);
  expect(preview.kind).toBe('ready');
  expect(JSON.stringify(state)).toBe(before);
  if (preview.kind !== 'ready') throw Error(JSON.stringify(preview));
  const result = applyInventoryScientificTransferV2(
    state,
    { ...request, expectedPlanDigest: preview.planDigest },
    { ...context, at: 110 }
  );
  if (!result.ok) throw Error(result.message);
  const work = result.state.scientificWorks[preview.work.id];
  expect(work.context).toMatchObject({
    kind: 'protocol-run',
    entityId: packet.runId,
    source: { sha256: request.context.sourceSha256 },
  });
  expect('pageId' in work.context).toBe(false);
  expect(result.state.revision).toBe(state.revision + 1);
  expect(result.state.stocks.stock.quantity).toEqual({ kind: 'known', value: '90', unit: 'uL' });
  expect(JSON.stringify(work)).not.toContain('originalText');
  expect(parseInventoryState(result.state)).toEqual(result.state);
  const adopted = adoptInventoryState(
    null,
    result.state,
    {
      source: {
        archiveSha256: `sha256:${'a'.repeat(64)}`,
        projectId: 'project',
        inventoryId: 'inventory',
        revision: result.state.revision,
      },
      materialBindings: { dna: 'local-dna' },
    },
    { ...context, at: 200 }
  );
  if (!adopted.ok) throw Error(adopted.message);
  expect(adopted.state.scientificWorks[work.id].context).toEqual(work.context);
  expect(adopted.state.scientificWorks[work.id].intentSha256).toBe(work.intentSha256);
  expect(adopted.state.scientificWorks[work.id].effects.source.before.materialId).toBe('local-dna');
  expect(
    inventoryScientificTransferPreviewV2(adopted.state, {
      ...request,
      target: {
        projectId: 'local-project',
        inventoryId: 'local-inventory',
        present: true,
        revision: adopted.state.revision,
      },
      source: null,
      asOf: 200,
    }).kind
  ).toBe('no-change');
});
