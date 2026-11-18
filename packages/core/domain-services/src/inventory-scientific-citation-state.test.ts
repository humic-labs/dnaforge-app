import { expect, it } from 'vitest';
import { createInventoryState, type InventoryState } from './inventory-types';
import { applyInventoryCommandBatch } from './inventory-state';
import { parseInventoryState } from './inventory-validation';
import { adoptInventoryState } from './inventory-adoption';
import { inventoryHasImportedAttribution } from './inventory-attribution';
import { inventoryScientificReferences } from './inventory-adoption';
import { inventoryRecordIdExists } from './inventory-identity';
import {
  applyInventoryScientificTransfer,
  inventoryScientificTransferPreview,
  inventoryNotebookSourceSha256,
} from './inventory-scientific';
import { inventoryScientificTransferIntentSha256V2 } from './inventory-scientific-source';
import {
  inventoryScientificCitationId,
  inventoryScientificCitationWithdrawalId,
  inventoryScientificCitationIntentSha256,
  inventoryScientificCitationWithdrawalIntentSha256,
} from './inventory-scientific-citation-identity';
import type {
  InventoryScientificCitation,
  InventoryScientificCitationWithdrawal,
} from './inventory-scientific-citation-types';

const principal = { kind: 'local-profile' as const, profileKey: 'profile' };
function fixture() {
  const initial = applyInventoryCommandBatch(
    createInventoryState(),
    {
      expectedRevision: 0,
      commands: [
        { kind: 'create-vessel', id: 'source', name: 'Source', placement: { kind: 'unplaced' } },
        {
          kind: 'create-vessel',
          id: 'destination',
          name: 'Destination',
          placement: { kind: 'unplaced' },
        },
        {
          kind: 'receive-stock',
          id: 'stock',
          vesselId: 'source',
          materialId: 'material',
          quantity: { kind: 'known', value: '20', unit: 'uL' },
          quality: 'usable',
        },
      ],
    },
    { at: 1, principal, authority: principal }
  );
  if (!initial.ok) throw Error(initial.message);
  const source = {
    schema: 'dnaforge.notebook-saved-source.v1' as const,
    projectId: 'project',
    workspaceScope: 'project',
    pageId: 'project::primary',
    fileObjectUuid: 'primary-file',
    title: 'Primary observation',
    content: { type: 'doc', content: [] },
  };
  const input = {
    identity: { namespace: 'manual', workId: 'one-transfer' },
    pageId: source.pageId,
    expectedSourceSha256: inventoryNotebookSourceSha256(source),
    sourceStockId: 'stock',
    destinationVesselId: 'destination',
    quantity: { value: '10', unit: 'uL' as const },
    reason: 'Observed transfer',
    source,
    target: { projectId: 'project', inventoryId: 'inventory', present: true, revision: 1 },
  };
  const preview = inventoryScientificTransferPreview(initial.state, {
    ...input,
    asOf: 2,
    principal,
    authority: principal,
  });
  if (preview.kind !== 'ready') throw Error('Expected fixture preview.');
  const applied = applyInventoryScientificTransfer(
    initial.state,
    { ...input, expectedPlanDigest: preview.planDigest },
    { at: 2, principal, authority: principal }
  );
  if (!applied.ok) throw Error(applied.message);
  const work = Object.values(applied.state.scientificWorks)[0];
  const citationSource = {
    ...source,
    pageId: 'project::citation',
    fileObjectUuid: 'citation-file',
    title: 'Supporting Notebook',
  };
  function citation(
    name: string,
    reinstates: InventoryScientificCitation['reinstates'] = null
  ): InventoryScientificCitation {
    const choices = {
      identity: { namespace: 'citations', citationId: name },
      workId: work.id,
      workIntentSha256: work.intentSha256,
      context: {
        kind: 'notebook-page' as const,
        entityId: citationSource.pageId,
        sourceSha256: inventoryNotebookSourceSha256(citationSource),
      },
      reinstates,
      reason: 'Supporting context',
    };
    return {
      id: inventoryScientificCitationId(choices.identity),
      ...choices,
      intentSha256: inventoryScientificCitationIntentSha256(choices),
      context: {
        kind: 'notebook-page',
        projectId: 'project',
        workspaceScope: 'project',
        entityId: citationSource.pageId,
        source: {
          kind: 'native-observed-saved-source',
          sha256: choices.context.sourceSha256,
          fileObjectUuid: citationSource.fileObjectUuid,
          title: citationSource.title,
        },
      },
      at: reinstates ? 5 : 3,
      by: principal,
    };
  }
  function withdrawal(
    c: InventoryScientificCitation,
    name = 'one'
  ): InventoryScientificCitationWithdrawal {
    const choices = {
      identity: { namespace: 'withdrawals', withdrawalId: name },
      citationId: c.id,
      citationIntentSha256: c.intentSha256,
      workId: work.id,
      workIntentSha256: work.intentSha256,
      reason: 'Correcting supporting context',
    };
    return {
      id: inventoryScientificCitationWithdrawalId(choices.identity),
      ...choices,
      intentSha256: inventoryScientificCitationWithdrawalIntentSha256(choices),
      at: 4,
      by: principal,
    };
  }
  const base = citation('base'),
    removed = withdrawal(base);
  const child = citation('child', {
    citationId: base.id,
    citationIntentSha256: base.intentSha256,
    withdrawalId: removed.id,
    withdrawalIntentSha256: removed.intentSha256,
  });
  const state: InventoryState = {
    ...applied.state,
    revision: 5,
    lastRecordedAt: 5,
    scientificCitations: { [base.id]: base, [child.id]: child },
    scientificCitationWithdrawals: { [removed.id]: removed },
  };
  return { state, work, base, removed, child, citation, withdrawal };
}

it('upcasts v24 Run and older empty state without changing the supplied bytes', () => {
  const { state, work } = fixture();
  const context = {
    kind: 'protocol-run' as const,
    projectId: 'project',
    workspaceScope: 'project',
    entityId: 'project::run',
    source: work.context.source,
  };
  const run = {
    ...work,
    context,
    intentSha256: inventoryScientificTransferIntentSha256V2({
      identity: work.identity,
      context: {
        kind: context.kind,
        entityId: context.entityId,
        sourceSha256: context.source.sha256,
      },
      sourceStockId: work.transfer.sourceStockId,
      destinationVesselId: work.transfer.destination.vesselId,
      quantity: work.transfer.quantity,
      reason: work.reason,
    }),
  };
  const {
    runValueAttributions,
    runValueAttributionWithdrawals,
    platePlanObservations,
    platePlanVersions,
    scientificCitations,
    scientificCitationWithdrawals,
    ...old
  } = state;
  const raw = { ...old, schema: 'dnaforge.inventory.v24', scientificWorks: { [run.id]: run } };
  const bytes = JSON.stringify(raw),
    parsed = parseInventoryState(raw);
  expect(parsed.scientificWorks[run.id]).toEqual(run);
  expect(parsed.scientificCitations).toEqual({});
  expect(parsed.scientificCitationWithdrawals).toEqual({});
  expect(JSON.stringify(raw)).toBe(bytes);
  expect(() => parseInventoryState({ ...raw, scientificCitations: {} })).toThrow();
  expect(() => parseInventoryState({ ...raw, scientificCitationWithdrawals: {} })).toThrow();
});

it('preserves an explicit linear correction chain and all physical state through ordinary commands', () => {
  const { state } = fixture();
  expect(parseInventoryState(state)).toEqual(state);
  const next = applyInventoryCommandBatch(
    state,
    {
      expectedRevision: state.revision,
      commands: [
        {
          kind: 'create-vessel',
          id: 'later-empty',
          name: 'Later empty vessel',
          placement: { kind: 'unplaced' },
        },
      ],
    },
    { at: 6, principal, authority: principal }
  );
  expect(next.ok).toBe(true);
  if (!next.ok) throw Error(next.message);
  expect(next.state.scientificCitations).toEqual(state.scientificCitations);
  expect(next.state.scientificCitationWithdrawals).toEqual(state.scientificCitationWithdrawals);
  expect(next.state.scientificWorks).toEqual(state.scientificWorks);
});

it('refuses identity, work pin, chronology and primary-context tampering', () => {
  const { state, base, work } = fixture();
  for (const change of [
    { id: 'changed' },
    { intentSha256: 'sha256:' + '0'.repeat(64) },
    { workIntentSha256: 'sha256:' + '0'.repeat(64) },
    { at: 1 },
    { at: 6 },
    { context: { ...base.context, entityId: 'other::citation' } },
  ]) {
    expect(() =>
      parseInventoryState({
        ...state,
        scientificCitations: { ...state.scientificCitations, [base.id]: { ...base, ...change } },
      })
    ).toThrow();
  }
  const primaryChoices = {
    identity: base.identity,
    workId: work.id,
    workIntentSha256: work.intentSha256,
    context: {
      kind: work.context.kind,
      entityId: work.context.kind === 'notebook-page' ? work.context.pageId : work.context.entityId,
      sourceSha256: work.context.source.sha256,
    },
    reinstates: null,
    reason: base.reason,
  };
  expect(() =>
    parseInventoryState({
      ...state,
      scientificCitations: {
        [base.id]: {
          ...base,
          intentSha256: inventoryScientificCitationIntentSha256(primaryChoices),
          context: {
            ...base.context,
            entityId: primaryChoices.context.entityId,
            source: work.context.source,
          },
        },
      },
      scientificCitationWithdrawals: {},
    })
  ).toThrow(/primary context/);
});

it('refuses duplicate historical bases, multiple withdrawals and predecessor forks', () => {
  const { state, base, citation, withdrawal, removed } = fixture();
  const duplicate = citation('duplicate');
  expect(() =>
    parseInventoryState({
      ...state,
      scientificCitations: { ...state.scientificCitations, [duplicate.id]: duplicate },
    })
  ).toThrow(/only once/);
  const extra = withdrawal(base, 'two');
  expect(() =>
    parseInventoryState({
      ...state,
      scientificCitationWithdrawals: { ...state.scientificCitationWithdrawals, [extra.id]: extra },
    })
  ).toThrow(/only one immutable withdrawal/);
  const fork = citation('fork', {
    citationId: base.id,
    citationIntentSha256: base.intentSha256,
    withdrawalId: removed.id,
    withdrawalIntentSha256: removed.intentSha256,
  });
  expect(() =>
    parseInventoryState({
      ...state,
      scientificCitations: { ...state.scientificCitations, [fork.id]: fork },
    })
  ).toThrow();
});

it('keeps citation IDs global and imported source provenance exact during adoption', () => {
  const { state, base, removed } = fixture();
  expect(inventoryRecordIdExists(state, base.id)).toBe(true);
  expect(inventoryRecordIdExists(state, removed.id)).toBe(true);
  expect(inventoryHasImportedAttribution(state)).toBe(false);
  const imported = adoptInventoryState(
    null,
    state,
    {
      source: {
        projectId: 'foreign',
        inventoryId: 'foreign-inventory',
        revision: state.revision,
        archiveSha256: 'sha256:' + 'c'.repeat(64),
      },
      materialBindings: { material: 'local-material' },
    },
    { at: 6, principal, authority: principal }
  );
  expect(imported.ok).toBe(true);
  if (!imported.ok) throw Error(imported.message);
  expect(inventoryHasImportedAttribution(imported.state)).toBe(true);
  expect(imported.state.scientificCitations[base.id]).toEqual({
    ...base,
    by: {
      kind: 'imported',
      source:
        imported.state.origin.kind === 'archive-adoption' ? imported.state.origin.source : null,
      principal: base.by,
    },
  });
  expect(imported.state.scientificCitations[base.id].context).toEqual(base.context);
  expect(imported.state.scientificCitations[base.id].intentSha256).toBe(base.intentSha256);
  expect(imported.state.scientificCitationWithdrawals[removed.id].intentSha256).toBe(
    removed.intentSha256
  );
  expect(inventoryScientificReferences(imported.state).map((x) => x.materialId)).toEqual([
    'local-material',
  ]);
  const collision = {
    ...state,
    vessels: { ...state.vessels, [base.id]: { ...state.vessels.source, id: base.id } },
  };
  expect(() => parseInventoryState(collision)).toThrow();
});

it('upcasts v25 without rewriting existing citation generations or withdrawal/source pins', () => {
  const { state } = fixture();
  const {
    runValueAttributions,
    runValueAttributionWithdrawals,
    platePlanObservations,
    platePlanVersions,
    ...old
  } = state;
  const prior = { ...old, schema: 'dnaforge.inventory.v25' },
    bytes = JSON.stringify(prior);
  const current = parseInventoryState(prior);
  expect(current.scientificWorks).toEqual(state.scientificWorks);
  expect(current.scientificCitations).toEqual(state.scientificCitations);
  expect(current.scientificCitationWithdrawals).toEqual(state.scientificCitationWithdrawals);
  expect(current.platePlanVersions).toEqual({});
  expect(JSON.stringify(prior)).toBe(bytes);
});
