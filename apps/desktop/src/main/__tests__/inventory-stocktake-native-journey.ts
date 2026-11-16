import { expect } from 'vitest';
import { inventoryWellId, type InventoryStocktakeChoices } from '@waypoint/domain-services';
import type { createNativeInventoryOwner } from '../inventory-owner';
import type {
  InventoryAcceptedRequest,
  InventoryApplyStocktakeRequest,
  InventoryReadRequest,
  NativeInventoryExecution,
  NativeInventoryReceipt,
} from '../../shared/inventory-command';
import type {
  InventoryExportSnapshot,
  InventoryImportPreviewSnapshot,
  InventoryStocktakePreviewSnapshot,
} from '../../shared/inventory-client';

type Command =
  | 'inventory.execute'
  | 'inventory.preview-stocktake'
  | 'inventory.apply-stocktake'
  | 'inventory.export-snapshot'
  | 'inventory.preview-import'
  | 'inventory.apply-import';
interface StocktakeContext {
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
  'observation_id,subject_key,observed_at,quantity_kind,quantity,unit,presence,location_key,slot,reason';
const source = (...rows: string[]) => '\uFEFF' + columns + '\r\n' + rows.join('\r\n') + '\r\n';

export async function runNativeStocktakeJourney(ctx: StocktakeContext) {
  const scope = { ...ctx.scope, inventoryId: 'inventory-stocktake' };
  const adopted = { ...ctx.scope, inventoryId: 'inventory-stocktake-adopted' };
  await ctx.success(
    'prepare held and checked-out stock for truthful measurement',
    'inventory.execute',
    {
      ...scope,
      operationId: 'stocktake:fixture',
      expectedRevision: 0,
      commands: [
        {
          kind: 'create-storage',
          id: 'stocktake-box',
          name: 'Synthetic stocktake box',
          slots: ['A', 'B'],
          placement: { kind: 'root' },
        },
        {
          kind: 'create-layout-storage',
          id: 'stocktake-plate',
          name: 'Synthetic stocktake plate',
          layout: { kind: 'fixed-well', rows: 1, columns: 1 },
          placement: { kind: 'root' },
        },
        {
          kind: 'create-vessel',
          id: 'stocktake-tube',
          name: 'Synthetic stocktake tube',
          placement: { kind: 'located', storageId: 'stocktake-box', slotId: 'A' },
        },
        {
          kind: 'receive-stock',
          id: 'stocktake-stock',
          vesselId: 'stocktake-tube',
          materialId: 'synthetic-material',
          quantity: { kind: 'known', value: '100', unit: 'uL' },
          quality: 'usable',
        },
        {
          kind: 'reserve-quantity',
          id: 'stocktake-hold',
          stockId: 'stocktake-stock',
          quantity: { value: '70', unit: 'uL' },
          deadline: null,
          purpose: 'Synthetic hold must survive measurements and custody',
        },
        {
          kind: 'checkout-item',
          item: { kind: 'vessel', id: 'stocktake-tube' },
          dueAt: null,
          reason: 'Synthetic responsibility is independent from quantity',
        },
      ],
    }
  );
  const options: InventoryStocktakeChoices = {
    namespace: 'synthetic:stocktake:stable',
    delimiter: ',',
    subjects: [{ key: 'sample', subject: { kind: 'stock', stockId: 'stocktake-stock' } }],
    locations: [],
    decisions: [
      {
        observationId: '0001',
        choice: { kind: 'apply', reason: 'Apply explicit first measured amount' },
      },
      { observationId: '0002', choice: { kind: 'record-only' } },
    ],
  };
  const sourceText = source(
    '0001,sample,unknown,known,50,uL,not-observed,,,Synthetic measured shortfall',
    '0002,sample,unknown,known,80,uL,not-observed,,,Synthetic recorded measurement awaiting explicit application'
  );
  const inspect = () => ctx.owner.inspect(scope)!;
  const initial = inspect();
  const preview = (text = sourceText, choices = options, target = scope) =>
    ctx.success<InventoryStocktakePreviewSnapshot>(
      'preview exact stocktake observations without writes',
      'inventory.preview-stocktake',
      { ...target, format: 'stocktake-v1', sourceText: text, options: choices }
    );
  const blocked = await preview(sourceText, { ...options, subjects: [], decisions: [] });
  expect(blocked.kind).toBe('blocked');
  expect(inspect()).toEqual(initial);
  const ready = await preview();
  if (ready.kind !== 'ready') throw new Error('Expected explicit stocktake plan.');
  expect(ready.commands).toHaveLength(3);
  const request: InventoryApplyStocktakeRequest = {
    ...scope,
    kind: 'apply-stocktake',
    operationId: 'stocktake:record-and-apply-once',
    expectedRevision: initial.revision,
    sourceText,
    options: ready.options,
    expectedPlanDigest: ready.planDigest,
  };
  const receipt = await ctx.loseAcknowledgement(request, 'stocktakeLostAcknowledgement');
  expect(
    await ctx.success(
      'retry exact stocktake after lost response',
      'inventory.apply-stocktake',
      request
    )
  ).toEqual(receipt);
  expect(
    await ctx.success<NativeInventoryExecution>(
      'same stocktake operation rejects changed source bytes',
      'inventory.apply-stocktake',
      { ...request, sourceText: sourceText + '\n' }
    )
  ).toMatchObject({ status: 'rejected', code: 'INVENTORY_OPERATION_CONFLICT' });
  const measured = inspect();
  const observation = (state: typeof measured, id: string) =>
    Object.values(state.observations).find((row) => row.observationId === id)!;
  expect(measured.stocks['stocktake-stock'].quantity).toEqual({
    kind: 'known',
    value: '50',
    unit: 'uL',
  });
  expect(measured.reservations['stocktake-hold']).toEqual(initial.reservations['stocktake-hold']);
  expect(measured.vessels['stocktake-tube']).toEqual(initial.vessels['stocktake-tube']);
  expect(observation(measured, '0001').application.kind).toBe('applied');
  expect(observation(measured, '0002').application.kind).toBe('unapplied');
  const shortfall = ctx.owner.availability(scope).stocks['stocktake-stock'];
  expect(shortfall.held).toEqual({ value: '70', unit: 'uL' });
  expect(shortfall.blockers).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: 'ALLOCATION_SHORTFALL' })])
  );
  const laterOptions: InventoryStocktakeChoices = {
    ...options,
    decisions: [
      options.decisions[0],
      {
        observationId: '0002',
        choice: {
          kind: 'apply',
          reason: 'Apply previously recorded second measurement explicitly',
        },
      },
    ],
  };
  async function apply(
    label: string,
    text: string,
    choices: InventoryStocktakeChoices,
    target = scope
  ) {
    const plan = await preview(text, choices, target);
    if (plan.kind !== 'ready')
      throw new Error(`Expected ready stocktake: ${label}: ${JSON.stringify(plan.issues)}`);
    const result = await ctx.success<NativeInventoryExecution>(label, 'inventory.apply-stocktake', {
      ...target,
      kind: 'apply-stocktake',
      operationId: label,
      expectedRevision: ctx.owner.inspect(target)?.revision ?? 0,
      sourceText: text,
      options: plan.options,
      expectedPlanDigest: plan.planDigest,
    });
    expect(result.status).toBe('committed');
    return result;
  }
  const secondPlan = await preview(sourceText, laterOptions);
  expect(secondPlan.kind).toBe('ready');
  if (secondPlan.kind === 'ready') expect(secondPlan.commands).toHaveLength(1);
  await apply('stocktake:apply-recorded-observation', sourceText, laterOptions);
  expect(inspect().stocks['stocktake-stock'].quantity).toEqual({
    kind: 'known',
    value: '80',
    unit: 'uL',
  });
  expect(inspect().vessels['stocktake-tube']).toEqual(initial.vessels['stocktake-tube']);
  const itemSubject = {
    key: 'physical-tube',
    subject: { kind: 'item' as const, item: { kind: 'vessel' as const, id: 'stocktake-tube' } },
  };
  const missingText = source(
    'missing-1,physical-tube,unknown,not-observed,,,missing,,,Synthetic explicit missing report'
  );
  const missingOptions: InventoryStocktakeChoices = {
    namespace: options.namespace,
    delimiter: ',',
    subjects: [itemSubject],
    locations: [],
    decisions: [
      {
        observationId: 'missing-1',
        choice: { kind: 'apply', reason: 'Apply explicit physical missing observation' },
      },
    ],
  };
  const beforeMissing = inspect();
  await apply('stocktake:report-missing', missingText, missingOptions);
  const missing = inspect();
  expect(missing.vessels['stocktake-tube']).toMatchObject({
    custody: { kind: 'missing' },
    placement: { kind: 'unplaced' },
  });
  expect(missing.stocks).toEqual(beforeMissing.stocks);
  expect(missing.reservations).toEqual(initial.reservations);
  const foundText = source(
    'found-1,physical-tube,unknown,not-observed,,,found,found-place,B,Synthetic explicit found destination'
  );
  const foundOptions: InventoryStocktakeChoices = {
    ...missingOptions,
    locations: [{ key: 'found-place', target: { kind: 'storage', storageId: 'stocktake-box' } }],
    decisions: [
      {
        observationId: 'found-1',
        choice: { kind: 'apply', reason: 'Locate only at this explicit valid destination' },
      },
    ],
  };
  await apply('stocktake:locate-missing', foundText, foundOptions);
  expect(inspect().vessels['stocktake-tube']).toMatchObject({
    custody: { kind: 'available' },
    placement: { kind: 'located', storageId: 'stocktake-box', slotId: 'B' },
  });
  expect(inspect().stocks).toEqual(missing.stocks);
  expect(inspect().reservations).toEqual(initial.reservations);
  await ctx.success('use stock after all recorded observations', 'inventory.execute', {
    ...scope,
    operationId: 'stocktake:later-use',
    expectedRevision: inspect().revision,
    commands: [
      {
        kind: 'consume',
        stockId: 'stocktake-stock',
        quantity: { value: '5', unit: 'uL' },
        reason: 'Synthetic later use must survive observation reimport',
      },
    ],
  });
  const afterUse = inspect();
  expect(afterUse.stocks['stocktake-stock'].quantity).toEqual({
    kind: 'known',
    value: '75',
    unit: 'uL',
  });
  expect((await preview()).kind).toBe('no-change');
  expect((await preview(sourceText.replace(',50,uL,', ',51,uL,'))).kind).toBe('blocked');
  expect(inspect()).toEqual(afterUse);
  const lateInvalidText = source(
    'atomic-first,sample,unknown,known,75,uL,not-observed,,,Synthetic valid record must roll back with late refusal',
    'well-missing,well,unknown,not-observed,,,missing,,,A permanent well cannot independently depart its plate'
  );
  const lateInvalidOptions: InventoryStocktakeChoices = {
    ...options,
    subjects: [
      options.subjects[0],
      {
        key: 'well',
        subject: {
          kind: 'item',
          item: { kind: 'vessel', id: inventoryWellId('stocktake-plate', 'A1') },
        },
      },
    ],
    decisions: [
      { observationId: 'atomic-first', choice: { kind: 'record-only' } },
      {
        observationId: 'well-missing',
        choice: { kind: 'apply', reason: 'Synthetic impossible independent well custody' },
      },
    ],
  };
  const lateInvalid = await preview(lateInvalidText, lateInvalidOptions);
  expect(lateInvalid.kind).toBe('blocked');
  expect(inspect()).toEqual(afterUse);
  const artifact = await ctx.success<InventoryExportSnapshot>(
    'export exact stocktake source and application journal',
    'inventory.export-snapshot',
    { ...scope, format: 'native-v1' }
  );
  const accepted = JSON.parse(artifact.sourceText)
    .content.history.map((row: { requestJson: string }) => JSON.parse(row.requestJson))
    .find((row: InventoryAcceptedRequest) => row.operationId === request.operationId);
  expect(accepted).toEqual({ ...request, project: ctx.projectId });
  const importPreview = await ctx.success<InventoryImportPreviewSnapshot>(
    'preview archive containing applied and recorded observations',
    'inventory.preview-import',
    {
      ...adopted,
      sourceText: artifact.sourceText,
      options: {
        bindings: [
          { sourceMaterialId: 'synthetic-material', destinationMaterialId: 'synthetic-material' },
        ],
      },
    }
  );
  if (importPreview.kind !== 'ready') throw new Error('Expected stocktake archive adoption.');
  await ctx.success(
    'adopt immutable observations without transferring actor authority',
    'inventory.apply-import',
    {
      ...adopted,
      kind: 'adopt-archive',
      operationId: 'stocktake:adopt',
      expectedRevision: 0,
      sourceText: artifact.sourceText,
      options: importPreview.options,
      expectedPlanDigest: importPreview.planDigest,
    }
  );
  const adoptedState = ctx.owner.inspect(adopted)!;
  for (const value of Object.values(adoptedState.observations)) {
    expect(value.by.kind).toBe('imported');
    if (value.application.kind === 'applied') expect(value.application.by.kind).toBe('imported');
  }
  expect((await preview(sourceText, options, adopted)).kind).toBe('no-change');
  return {
    scope,
    adopted,
    sourceText,
    options,
    laterOptions,
    missingText,
    missingOptions,
    foundText,
    foundOptions,
    request,
    receipt,
    initial,
    measured,
    shortfall,
    lateInvalid,
    state: afterUse,
    history: ctx.owner.history(scope),
    adoptedState,
    adoptedHistory: ctx.owner.history(adopted),
    artifact,
  };
}

export async function verifyNativeStocktakeReopen(
  ctx: StocktakeContext,
  before: Awaited<ReturnType<typeof runNativeStocktakeJourney>>
) {
  expect(ctx.owner.inspect(before.scope)).toEqual(before.state);
  expect(ctx.owner.history(before.scope)).toEqual(before.history);
  expect(ctx.owner.replay(before.scope)).toEqual({
    state: before.state,
    acceptedOperations: before.state.revision,
  });
  expect(ctx.owner.inspect(before.adopted)).toEqual(before.adoptedState);
  expect(ctx.owner.replay(before.adopted)).toEqual({
    state: before.adoptedState,
    acceptedOperations: before.adoptedState.revision,
  });
  expect(
    await ctx.success(
      'reopened exact stocktake retry returns original receipt',
      'inventory.apply-stocktake',
      before.request
    )
  ).toEqual(before.receipt);
  const preview = await ctx.success<InventoryStocktakePreviewSnapshot>(
    'reopened observations cannot repeat corrections after later consumption',
    'inventory.preview-stocktake',
    {
      ...before.adopted,
      format: 'stocktake-v1',
      sourceText: before.sourceText,
      options: before.laterOptions,
    }
  );
  expect(preview.kind).toBe('no-change');
  const artifact = await ctx.success<InventoryExportSnapshot>(
    'reopened export retains exact stocktake history bytes',
    'inventory.export-snapshot',
    { ...before.scope, format: 'native-v1' }
  );
  expect(artifact.sourceText).toBe(before.artifact.sourceText);
  return { state: ctx.owner.inspect(before.scope), preview, artifact };
}
