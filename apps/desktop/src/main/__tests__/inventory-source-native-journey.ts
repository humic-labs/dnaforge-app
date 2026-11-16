import { expect } from 'vitest';
import type {
  InventorySourceRevisionChoices,
  InventoryState,
  InventoryTableChoices,
} from '@waypoint/domain-services';
import type { createNativeInventoryOwner } from '../inventory-owner';
import type {
  InventoryAcceptedRequest,
  InventoryAcknowledgeSourceRequest,
  InventoryReadRequest,
  NativeInventoryExecution,
  NativeInventoryReceipt,
} from '../../shared/inventory-command';
import type {
  InventoryExportSnapshot,
  InventoryImportPreviewSnapshot,
  InventorySourceRevisionPreviewSnapshot,
  InventoryTablePreviewSnapshot,
} from '../../shared/inventory-client';

type Command =
  | 'inventory.execute'
  | 'inventory.preview-table'
  | 'inventory.apply-table'
  | 'inventory.preview-source-revision'
  | 'inventory.acknowledge-source'
  | 'inventory.export-snapshot'
  | 'inventory.preview-import'
  | 'inventory.apply-import';
interface SourceContext {
  scope: InventoryReadRequest;
  projectId: string;
  owner: ReturnType<typeof createNativeInventoryOwner>;
  success<T>(label: string, command: Command, request: unknown): Promise<T>;
  loseAcknowledgement(
    request: InventoryAcceptedRequest,
    evidenceKey?: string
  ): Promise<NativeInventoryReceipt>;
}
const columns =
  'source_id,name,material_key,quantity_kind,quantity,unit,quality,vessel_kind,vessel_key,location_key,slot';
const physicalFacts = ({
  revision: _revision,
  lastRecordedAt: _clock,
  tableBindings: _bindings,
  ...facts
}: InventoryState) => facts;

export async function runNativeSourceJourney(ctx: SourceContext) {
  const scope = { ...ctx.scope, inventoryId: 'inventory-source-revisions' };
  const nested = { ...ctx.scope, inventoryId: 'inventory-source-original-adopted' };
  const adopted = { ...ctx.scope, inventoryId: 'inventory-source-revisions-adopted' };
  await ctx.success('create explicit source-revision destinations', 'inventory.execute', {
    ...scope,
    operationId: 'source:destinations',
    expectedRevision: 0,
    commands: [
      {
        kind: 'create-storage',
        id: 'source-box',
        name: 'Synthetic source comparison box',
        slots: ['A', 'B', 'C'],
        placement: { kind: 'root' },
      },
    ],
  });
  const original =
    columns + '\n0007,Original source tube,sample,known,80,uL,usable,new,,freezer,A\n';
  const revised = original
    .replace('Original source tube', 'Revised external label')
    .replace(',80,uL,usable,', ',90,uL,quarantined,')
    .replace('freezer,A', 'freezer,C');
  const table: InventoryTableChoices = {
    namespace: 'synthetic:external-register:stable',
    delimiter: ',',
    materials: [{ key: 'sample', materialId: 'synthetic-material' }],
    locations: [{ key: 'freezer', target: { kind: 'storage', storageId: 'source-box' } }],
    vessels: [],
    skips: [],
  };
  const tablePlan = await ctx.success<InventoryTablePreviewSnapshot>(
    'receive original external source once',
    'inventory.preview-table',
    { ...scope, format: 'receive-v1', sourceText: original, options: table }
  );
  if (tablePlan.kind !== 'ready') throw new Error('Expected original table receipt plan.');
  await ctx.success('commit original receive table through native owner', 'inventory.apply-table', {
    ...scope,
    kind: 'receive-table',
    operationId: 'source:original-receipt',
    expectedRevision: 1,
    sourceText: original,
    options: tablePlan.options,
    expectedPlanDigest: tablePlan.planDigest,
  });
  const [bindingKey, binding] = Object.entries(ctx.owner.inspect(scope)!.tableBindings)[0];
  await ctx.success('make actual stock independent from its original source', 'inventory.execute', {
    ...scope,
    operationId: 'source:actual-inventory',
    expectedRevision: 2,
    commands: [
      {
        kind: 'consume',
        stockId: binding.stockId,
        quantity: { value: '10', unit: 'uL' },
        reason: 'Synthetic use before source comparison',
      },
      {
        kind: 'move-vessel',
        id: binding.vesselId,
        placement: { kind: 'located', storageId: 'source-box', slotId: 'B' },
      },
      {
        kind: 'reserve-quantity',
        id: 'source-hold',
        stockId: binding.stockId,
        quantity: { value: '30', unit: 'uL' },
        deadline: null,
        purpose: 'Source acknowledgement must preserve this hold',
      },
      {
        kind: 'record-inventory-observation',
        namespace: 'source:observation',
        observationId: 'record-only',
        subject: { kind: 'stock', stockId: binding.stockId },
        observedAt: null,
        fact: { kind: 'quantity', quantity: { kind: 'known', value: '70', unit: 'uL' } },
        reason: 'Source acknowledgement must preserve immutable observations',
      },
    ],
  });
  const inspect = () => ctx.owner.inspect(scope)!;
  const initial = inspect();
  const choices: InventorySourceRevisionChoices = { table, acknowledgements: [] };
  const preview = (text = revised, options = choices, target = scope) =>
    ctx.success<InventorySourceRevisionPreviewSnapshot>(
      'compare true previous source, revised source and actual inventory',
      'inventory.preview-source-revision',
      { ...target, format: 'receive-v1', sourceText: text, options }
    );
  const comparison = await preview();
  expect(comparison.kind).toBe('needs-acknowledgement');
  const row = comparison.rows.find((row) => row.sourceId === '0007')!;
  expect(row.previousFields).toMatchObject({
    name: 'Original source tube',
    quantity: '80',
    quality: 'usable',
    slot: 'A',
  });
  expect(row.revisedFields).toMatchObject({
    name: 'Revised external label',
    quantity: '90',
    quality: 'quarantined',
    slot: 'C',
  });
  expect(row.actual?.stock.quantity).toEqual({ kind: 'known', value: '70', unit: 'uL' });
  expect(row.actual?.vessel.placement).toEqual({
    kind: 'located',
    storageId: 'source-box',
    slotId: 'B',
  });
  expect(inspect()).toEqual(initial);
  const options: InventorySourceRevisionChoices = {
    table,
    acknowledgements: [
      {
        sourceId: '0007',
        expectedPreviousRowSha256: row.previousRowSha256!,
        reason: 'Acknowledge the revised external record; preserve physical inventory',
      },
    ],
  };
  const ready = await preview(revised, options);
  if (ready.kind !== 'ready') throw new Error('Expected explicit source acknowledgement plan.');
  await ctx.success(
    'change revision and occupy source-claimed destination before acknowledgement',
    'inventory.execute',
    {
      ...scope,
      operationId: 'source:invalidate-plan',
      expectedRevision: 3,
      commands: [
        {
          kind: 'create-vessel',
          id: 'source-other-vessel',
          name: 'Synthetic existing occupant of source position C',
          placement: { kind: 'located', storageId: 'source-box', slotId: 'C' },
        },
      ],
    }
  );
  const stale = await ctx.success<NativeInventoryExecution>(
    'refuse stale source acknowledgement without metadata or physical effects',
    'inventory.acknowledge-source',
    {
      ...scope,
      kind: 'acknowledge-table-source',
      operationId: 'source:stale',
      expectedRevision: 3,
      sourceText: revised,
      options: ready.options,
      expectedPlanDigest: ready.planDigest,
    }
  );
  expect(stale).toMatchObject({ status: 'rejected', code: 'REVISION_CONFLICT' });
  const fresh = await preview(revised, options);
  if (fresh.kind !== 'ready')
    throw new Error('Acknowledgement must not attempt placement into occupied C.');
  const before = inspect();
  const originalArtifact = await ctx.success<InventoryExportSnapshot>(
    'retain original source evidence before any acknowledgement',
    'inventory.export-snapshot',
    { ...scope, format: 'native-v1' }
  );
  const adopt = async (
    target: InventoryReadRequest,
    artifact: InventoryExportSnapshot,
    operationId: string
  ) => {
    const plan = await ctx.success<InventoryImportPreviewSnapshot>(
      'preview source archive adoption',
      'inventory.preview-import',
      {
        ...target,
        sourceText: artifact.sourceText,
        options: {
          bindings: [
            { sourceMaterialId: 'synthetic-material', destinationMaterialId: 'synthetic-material' },
          ],
        },
      }
    );
    if (plan.kind !== 'ready') throw new Error('Expected source archive adoption plan.');
    return ctx.success<NativeInventoryExecution>(
      'adopt source archive without regenerating physical identities',
      'inventory.apply-import',
      {
        ...target,
        kind: 'adopt-archive',
        operationId,
        expectedRevision: 0,
        sourceText: artifact.sourceText,
        options: plan.options,
        expectedPlanDigest: plan.planDigest,
      }
    );
  };
  await adopt(nested, originalArtifact, 'source:adopt-original');
  const nestedPreview = await preview(revised, options, nested);
  if (nestedPreview.kind !== 'ready')
    throw new Error('Original source preimage must survive nested archive adoption.');
  expect(nestedPreview.rows[0].previousFields).toEqual(row.previousFields);
  const request: InventoryAcknowledgeSourceRequest = {
    ...scope,
    kind: 'acknowledge-table-source',
    operationId: 'source:acknowledge-once',
    expectedRevision: 4,
    sourceText: revised,
    options: fresh.options,
    expectedPlanDigest: fresh.planDigest,
  };
  const receipt = await ctx.loseAcknowledgement(request, 'sourceRevisionLostAcknowledgement');
  expect(
    await ctx.success(
      'retry source acknowledgement after lost response',
      'inventory.acknowledge-source',
      request
    )
  ).toEqual(receipt);
  expect(
    await ctx.success<NativeInventoryExecution>(
      'changed source bytes conflict under original operation',
      'inventory.acknowledge-source',
      { ...request, sourceText: revised + '\n' }
    )
  ).toMatchObject({ status: 'rejected', code: 'INVENTORY_OPERATION_CONFLICT' });
  const acknowledged = inspect();
  expect(physicalFacts(acknowledged)).toEqual(physicalFacts(before));
  expect(acknowledged.tableBindings[bindingKey]).toMatchObject({
    ...binding,
    sourceRevisions: expect.any(Array),
  });
  const revisions = acknowledged.tableBindings[bindingKey].sourceRevisions;
  expect(revisions).toHaveLength(1);
  expect(revisions[0]).toMatchObject({
    previousRowSha256: binding.rowSha256,
    fields: row.revisedFields,
    at: receipt.recordedAt,
    by: receipt.context!.principal,
  });
  expect(acknowledged.tableBindings[bindingKey].rowSha256).toBe(binding.rowSha256);
  const receiveAgain = (text: string, target = scope) =>
    ctx.success<InventoryTablePreviewSnapshot>(
      'reimport accepted source without resetting current stock',
      'inventory.preview-table',
      { ...target, format: 'receive-v1', sourceText: text, options: table }
    );
  expect((await receiveAgain(revised)).kind).toBe('no-change');
  await ctx.success('use physical stock after source acknowledgement', 'inventory.execute', {
    ...scope,
    operationId: 'source:later-use',
    expectedRevision: acknowledged.revision,
    commands: [
      {
        kind: 'consume',
        stockId: binding.stockId,
        quantity: { value: '5', unit: 'uL' },
        reason: 'Later use must survive revised source reimport',
      },
    ],
  });
  const afterUse = inspect();
  expect(afterUse.stocks[binding.stockId].quantity).toEqual({
    kind: 'known',
    value: '65',
    unit: 'uL',
  });
  expect((await receiveAgain(revised)).kind).toBe('no-change');
  const unbound = await preview(revised.replace('0007,', 'unbound,'));
  expect(unbound.kind).toBe('blocked');
  const rebound = await preview(revised.replace(',90,uL,', ',95,uL,'), {
    ...choices,
    table: { ...table, materials: [{ key: 'sample', materialId: 'unrelated-scientific-id' }] },
  });
  expect(rebound.kind).toBe('blocked');
  const obsolete = await preview(revised.replace(',90,uL,', ',95,uL,'), options);
  expect(obsolete.kind).toBe('blocked');
  expect(inspect()).toEqual(afterUse);
  const rollbackChoices: InventorySourceRevisionChoices = {
    table,
    acknowledgements: [
      {
        sourceId: '0007',
        expectedPreviousRowSha256: revisions[0].rowSha256,
        reason: 'Acknowledge a deliberate external rollback without changing stock',
      },
    ],
  };
  const rollback = await preview(original, rollbackChoices);
  if (rollback.kind !== 'ready')
    throw new Error('Expected append-only external rollback acknowledgement.');
  await ctx.success(
    'append rollback instead of erasing source history',
    'inventory.acknowledge-source',
    {
      ...scope,
      kind: 'acknowledge-table-source',
      operationId: 'source:acknowledge-rollback',
      expectedRevision: afterUse.revision,
      sourceText: original,
      options: rollback.options,
      expectedPlanDigest: rollback.planDigest,
    }
  );
  const state = inspect();
  expect(physicalFacts(state)).toEqual(physicalFacts(afterUse));
  expect(state.tableBindings[bindingKey].sourceRevisions).toHaveLength(2);
  expect(state.tableBindings[bindingKey].sourceRevisions[1].rowSha256).toBe(binding.rowSha256);
  expect((await receiveAgain(original)).kind).toBe('no-change');
  const artifact = await ctx.success<InventoryExportSnapshot>(
    'export complete source-revision chain and exact requests',
    'inventory.export-snapshot',
    { ...scope, format: 'native-v1' }
  );
  const saved = JSON.parse(artifact.sourceText)
    .content.history.map((entry: { requestJson: string }) => JSON.parse(entry.requestJson))
    .find((entry: InventoryAcceptedRequest) => entry.operationId === request.operationId);
  expect(saved).toEqual({ ...request, project: ctx.projectId });
  await adopt(adopted, artifact, 'source:adopt-revisions');
  const adoptedState = ctx.owner.inspect(adopted)!;
  expect(adoptedState.tableBindings[bindingKey].sourceRevisions).toHaveLength(2);
  for (const revision of adoptedState.tableBindings[bindingKey].sourceRevisions)
    expect(revision.by.kind).toBe('imported');
  expect((await receiveAgain(original, adopted)).kind).toBe('no-change');
  return {
    scope,
    nested,
    adopted,
    original,
    revised,
    table,
    choices,
    options,
    request,
    receipt,
    bindingKey,
    binding,
    comparison,
    nestedPreview,
    stale,
    before,
    acknowledged,
    state,
    history: ctx.owner.history(scope),
    nestedState: ctx.owner.inspect(nested)!,
    adoptedState,
    artifact,
  };
}

export async function verifyNativeSourceReopen(
  ctx: SourceContext,
  before: Awaited<ReturnType<typeof runNativeSourceJourney>>
) {
  expect(ctx.owner.inspect(before.scope)).toEqual(before.state);
  expect(ctx.owner.history(before.scope)).toEqual(before.history);
  expect(ctx.owner.replay(before.scope)).toEqual({
    state: before.state,
    acceptedOperations: before.state.revision,
  });
  expect(ctx.owner.inspect(before.nested)).toEqual(before.nestedState);
  expect(ctx.owner.inspect(before.adopted)).toEqual(before.adoptedState);
  expect(ctx.owner.replay(before.adopted)).toEqual({
    state: before.adoptedState,
    acceptedOperations: before.adoptedState.revision,
  });
  expect(
    await ctx.success(
      'reopened exact source acknowledgement retry returns original receipt',
      'inventory.acknowledge-source',
      before.request
    )
  ).toEqual(before.receipt);
  const preview = await ctx.success<InventoryTablePreviewSnapshot>(
    'reopened accepted source cannot replenish stock',
    'inventory.preview-table',
    { ...before.adopted, format: 'receive-v1', sourceText: before.original, options: before.table }
  );
  expect(preview.kind).toBe('no-change');
  const artifact = await ctx.success<InventoryExportSnapshot>(
    'reopened source revision export retains exact bytes',
    'inventory.export-snapshot',
    { ...before.scope, format: 'native-v1' }
  );
  expect(artifact.sourceText).toBe(before.artifact.sourceText);
  return { state: ctx.owner.inspect(before.scope), preview, artifact };
}
