import { expect, it } from 'vitest';
import { applyInventoryCommandBatch } from './inventory-state';
import { createInventoryState, type InventoryState } from './inventory-types';
import {
  applyInventoryScientificTransfer,
  inventoryScientificTransferPreview,
  inventoryNotebookSourceSha256,
} from './inventory-scientific';
import {
  inventoryScientificCitationPreview,
  applyInventoryScientificCitation,
  inventoryScientificCitationWithdrawalPreview,
  applyInventoryScientificCitationWithdrawal,
  inventoryScientificCitationExisting,
  inventoryScientificCitationWithdrawalExisting,
  inventoryScientificCitationsForWork,
} from './inventory-scientific-citations';
import type {
  InventoryScientificCitationChoices,
  InventoryScientificCitationEntry,
  InventoryScientificCitationWithdrawalChoices,
} from './inventory-scientific-citation-types';
import { parseInventoryState } from './inventory-validation';
import { adoptInventoryState } from './inventory-adoption';
const principal = { kind: 'local-profile' as const, profileKey: 'a'.repeat(64) },
  execution = { at: 100, principal, authority: principal };
const source = {
  schema: 'dnaforge.notebook-saved-source.v1' as const,
  projectId: 'project',
  workspaceScope: 'project',
  pageId: 'project::support',
  fileObjectUuid: 'support-binding',
  title: 'Supporting observation',
  content: {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Retained support µL' }] }],
  },
};
function fixture(): InventoryState {
  const initial = applyInventoryCommandBatch(
    createInventoryState(),
    {
      expectedRevision: 0,
      commands: [
        {
          kind: 'create-vessel',
          id: 'source-vial',
          name: 'Source',
          placement: { kind: 'unplaced' },
        },
        {
          kind: 'create-vessel',
          id: 'destination',
          name: 'Aliquot',
          placement: { kind: 'unplaced' },
        },
        {
          kind: 'receive-stock',
          id: 'stock',
          vesselId: 'source-vial',
          materialId: 'material',
          quantity: { kind: 'known', value: '100', unit: 'uL' },
          quality: 'usable',
        },
      ],
    },
    execution
  );
  if (!initial.ok) throw Error(initial.message);
  const primary = {
      ...source,
      pageId: 'project::primary',
      fileObjectUuid: 'primary-binding',
      title: 'Primary work context',
    },
    input = {
      identity: { namespace: 'manual', workId: 'physical-once' },
      pageId: primary.pageId,
      expectedSourceSha256: inventoryNotebookSourceSha256(primary),
      sourceStockId: 'stock',
      destinationVesselId: 'destination',
      quantity: { value: '10', unit: 'uL' as const },
      reason: 'Completed manual transfer',
      source: primary,
      target: {
        projectId: 'project',
        inventoryId: 'inventory',
        present: true,
        revision: initial.state.revision,
      },
    };
  const preview = inventoryScientificTransferPreview(initial.state, {
    ...input,
    asOf: 100,
    principal,
    authority: principal,
  });
  if (preview.kind !== 'ready') throw Error(JSON.stringify(preview));
  const result = applyInventoryScientificTransfer(
    initial.state,
    { ...input, expectedPlanDigest: preview.planDigest },
    execution
  );
  if (!result.ok) throw Error(result.message);
  return result.state;
}
function choices(
  state: InventoryState,
  citationId = 'citation-once'
): InventoryScientificCitationChoices {
  const work = Object.values(state.scientificWorks)[0];
  return {
    identity: { namespace: 'saved-support', citationId },
    workId: work.id,
    workIntentSha256: work.intentSha256,
    context: {
      kind: 'notebook-page',
      entityId: source.pageId,
      sourceSha256: inventoryNotebookSourceSha256(source),
    },
    reinstates: null,
    reason: 'Saved support for the recorded observation',
  };
}
function target(state: InventoryState) {
  return {
    projectId: 'project',
    inventoryId: 'inventory',
    present: true,
    revision: state.revision,
  };
}
function cite(state: InventoryState, input = choices(state)) {
  const preview = inventoryScientificCitationPreview(state, {
    ...input,
    target: target(state),
    source,
    asOf: execution.at,
    principal,
    authority: principal,
  });
  if (preview.kind !== 'ready') throw Error(JSON.stringify(preview));
  const result = applyInventoryScientificCitation(
    state,
    { ...input, target: target(state), source, expectedPlanDigest: preview.planDigest },
    execution
  );
  if (!result.ok) throw Error(result.message);
  return { state: result.state, citation: preview.citation };
}
function withdrawalChoices(
  entry: InventoryScientificCitationEntry,
  withdrawalId = 'withdraw-once'
): InventoryScientificCitationWithdrawalChoices {
  return {
    identity: { namespace: 'corrections', withdrawalId },
    citationId: entry.citation.id,
    citationIntentSha256: entry.citation.intentSha256,
    workId: entry.citation.workId,
    workIntentSha256: entry.citation.workIntentSha256,
    reason: 'This supporting citation was attached in error',
  };
}
function withdraw(
  state: InventoryState,
  input = withdrawalChoices(
    inventoryScientificCitationsForWork(state, Object.keys(state.scientificWorks)[0])[0]
  )
) {
  const preview = inventoryScientificCitationWithdrawalPreview(state, {
    ...input,
    target: target(state),
    asOf: execution.at,
    principal,
    authority: principal,
  });
  if (preview.kind !== 'ready') throw Error(JSON.stringify(preview));
  const result = applyInventoryScientificCitationWithdrawal(
    state,
    { ...input, target: target(state), expectedPlanDigest: preview.planDigest },
    execution
  );
  if (!result.ok) throw Error(result.message);
  return { state: result.state, withdrawal: preview.withdrawal };
}
it('records only canonical citation metadata, preserves physical work and rejects malformed external source metadata', () => {
  const before = fixture(),
    input = choices(before),
    bytes = JSON.stringify(before);
  const preview = inventoryScientificCitationPreview(before, {
    ...input,
    target: target(before),
    source,
    asOf: 100,
    principal,
    authority: principal,
  });
  expect(preview.kind).toBe('ready');
  expect(JSON.stringify(before)).toBe(bytes);
  const saved = cite(before);
  expect(saved.state.revision).toBe(before.revision + 1);
  for (const key of [
    'scientificWorks',
    'storage',
    'vessels',
    'stocks',
    'lots',
    'reservations',
  ] as const)
    expect(saved.state[key]).toEqual(before[key]);
  expect(parseInventoryState(saved.state)).toEqual(saved.state);
  const malformed = { ...source, title: 'Broken\0source' };
  expect(
    inventoryScientificCitationPreview(before, {
      ...input,
      context: { ...input.context, sourceSha256: inventoryNotebookSourceSha256(malformed) },
      target: target(before),
      source: malformed,
      asOf: 100,
      principal,
      authority: principal,
    })
  ).toMatchObject({ kind: 'blocked', issues: [{ code: 'INVALID_INVENTORY_INPUT' }] });
  expect(JSON.stringify(before)).toBe(bytes);
});
it('keeps original identities/reasons and forever deduplicates withdrawn bases before current source access', () => {
  const initial = fixture(),
    base = choices(initial),
    saved = cite(initial),
    corrected = withdraw(saved.state);
  expect(
    inventoryScientificCitationExisting(corrected.state, {
      ...base,
      identity: { ...base.identity, citationId: 'fresh-duplicate' },
      reason: 'A new reason is not silently saved',
    })
  ).toMatchObject({
    kind: 'no-change',
    match: {
      kind: 'citation',
      entry: { citation: saved.citation, withdrawal: corrected.withdrawal },
    },
  });
  expect(
    inventoryScientificCitationExisting(corrected.state, {
      ...base,
      reason: 'Changed same identity',
    })
  ).toMatchObject({ kind: 'blocked', issue: { code: 'SCIENTIFIC_CITATION_CONFLICT' } });
  const preview = inventoryScientificCitationPreview(corrected.state, {
    ...base,
    target: target(initial),
    source: null,
    asOf: 0,
    principal,
    authority: principal,
  });
  expect(preview.kind).toBe('no-change');
  const work = Object.values(initial.scientificWorks)[0];
  expect(
    inventoryScientificCitationExisting(initial, {
      ...base,
      context: {
        kind: 'notebook-page',
        entityId:
          work.context.kind === 'notebook-page' ? work.context.pageId : work.context.entityId,
        sourceSha256: work.context.source.sha256,
      },
    })
  ).toMatchObject({ kind: 'no-change', match: { kind: 'primary-context' } });
  const withdrawal = withdrawalChoices({ citation: saved.citation, withdrawal: null });
  expect(
    inventoryScientificCitationWithdrawalExisting(corrected.state, {
      ...withdrawal,
      identity: { ...withdrawal.identity, withdrawalId: 'fresh-duplicate' },
    })
  ).toMatchObject({ kind: 'no-change', withdrawal: corrected.withdrawal });
  expect(
    inventoryScientificCitationWithdrawalExisting(corrected.state, {
      ...withdrawal,
      reason: 'Changed correction',
    })
  ).toMatchObject({ kind: 'blocked', issue: { code: 'SCIENTIFIC_CITATION_WITHDRAWAL_CONFLICT' } });
});
it('requires explicit linear predecessor generations and never restores an old base or child on refreshed retries', () => {
  const saved = cite(fixture()),
    corrected = withdraw(saved.state),
    base = choices(saved.state);
  const childInput = {
    ...base,
    identity: { ...base.identity, citationId: 'explicit-child' },
    reinstates: {
      citationId: saved.citation.id,
      citationIntentSha256: saved.citation.intentSha256,
      withdrawalId: corrected.withdrawal.id,
      withdrawalIntentSha256: corrected.withdrawal.intentSha256,
    },
  };
  const child = cite(corrected.state, childInput),
    childWithdrawal = withdraw(
      child.state,
      withdrawalChoices({ citation: child.citation, withdrawal: null }, 'withdraw-child')
    );
  expect(
    inventoryScientificCitationExisting(childWithdrawal.state, {
      ...base,
      identity: { ...base.identity, citationId: 'old-base-business-retry' },
    })
  ).toMatchObject({
    kind: 'no-change',
    match: {
      kind: 'citation',
      entry: { citation: saved.citation, withdrawal: corrected.withdrawal },
    },
  });
  expect(
    inventoryScientificCitationExisting(childWithdrawal.state, {
      ...childInput,
      identity: { ...base.identity, citationId: 'old-child-business-retry' },
    })
  ).toMatchObject({
    kind: 'no-change',
    match: {
      kind: 'citation',
      entry: { citation: child.citation, withdrawal: childWithdrawal.withdrawal },
    },
  });
  expect(
    inventoryScientificCitationExisting(childWithdrawal.state, {
      ...childInput,
      identity: { ...base.identity, citationId: 'wrong-chain' },
      context: { ...base.context, sourceSha256: `sha256:${'0'.repeat(64)}` },
    })
  ).toMatchObject({ kind: 'blocked', issue: { code: 'SCIENTIFIC_CITATION_PREDECESSOR_MISMATCH' } });
  const next = cite(childWithdrawal.state, {
    ...childInput,
    identity: { ...base.identity, citationId: 'explicit-grandchild' },
    reinstates: {
      citationId: child.citation.id,
      citationIntentSha256: child.citation.intentSha256,
      withdrawalId: childWithdrawal.withdrawal.id,
      withdrawalIntentSha256: childWithdrawal.withdrawal.intentSha256,
    },
  });
  expect(Object.keys(next.state.scientificCitations)).toHaveLength(3);
  expect(Object.keys(next.state.scientificCitationWithdrawals)).toHaveLength(2);
  expect(next.state.scientificWorks).toEqual(saved.state.scientificWorks);
});
it('adopts citation history without rebinding foreign sources or changing business hashes', () => {
  const saved = cite(fixture()),
    corrected = withdraw(saved.state);
  const adopted = adoptInventoryState(
    null,
    corrected.state,
    {
      materialBindings: { material: 'local-material' },
      source: {
        archiveSha256: `sha256:${'a'.repeat(64)}`,
        projectId: 'foreign',
        inventoryId: 'foreign-inventory',
        revision: corrected.state.revision,
      },
    },
    execution
  );
  expect(adopted.ok).toBe(true);
  if (!adopted.ok) throw Error(adopted.message);
  expect(adopted.state.scientificCitations[saved.citation.id].context).toEqual(
    saved.citation.context
  );
  expect(adopted.state.scientificCitations[saved.citation.id].intentSha256).toBe(
    saved.citation.intentSha256
  );
  expect(adopted.state.scientificCitations[saved.citation.id].by.kind).toBe('imported');
  expect(adopted.state.scientificCitationWithdrawals[corrected.withdrawal.id].by.kind).toBe(
    'imported'
  );
  expect(parseInventoryState(adopted.state)).toEqual(adopted.state);
});
