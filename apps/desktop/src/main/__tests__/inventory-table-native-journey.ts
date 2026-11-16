import { expect } from 'vitest';
import {
  inventoryWellId,
  type InventoryState,
  type InventoryTableChoices,
} from '@waypoint/domain-services';
import type { createNativeInventoryOwner } from '../inventory-owner';
import type {
  InventoryAcceptedRequest,
  InventoryApplyTableRequest,
  InventoryReadRequest,
  NativeInventoryExecution,
  NativeInventoryReceipt,
} from '../../shared/inventory-command';
import type {
  InventoryExportSnapshot,
  InventoryImportPreviewSnapshot,
  InventoryTablePreviewSnapshot,
} from '../../shared/inventory-client';

type Command =
  | 'inventory.execute'
  | 'inventory.preview-table'
  | 'inventory.apply-table'
  | 'inventory.export-snapshot'
  | 'inventory.preview-import'
  | 'inventory.apply-import';
interface TableContext {
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
const rows = [
  '0007,"Tube, alpha\nsecond line",sample,known,80,uL,usable,new,,freezer,A',
  '0008,Zero tube,sample,known,0,uL,quarantined,new,,bench,',
  '0009,,sample,unknown,,,usable,existing,well,,',
];

export async function runNativeTableJourney(ctx: TableContext) {
  const scope = { ...ctx.scope, inventoryId: 'inventory-table-receiving' };
  const adopted = { ...ctx.scope, inventoryId: 'inventory-table-adopted' };
  expect(
    await ctx.success<NativeInventoryExecution>(
      'prepare explicit table destinations',
      'inventory.execute',
      {
        ...scope,
        operationId: 'table:destinations',
        expectedRevision: 0,
        commands: [
          {
            kind: 'create-storage',
            id: 'table-box',
            name: 'Synthetic table box',
            slots: ['A', 'B', 'C'],
            placement: { kind: 'root' },
          },
          {
            kind: 'create-layout-storage',
            id: 'table-plate',
            name: 'Synthetic table plate',
            layout: { kind: 'fixed-well', rows: 1, columns: 1 },
            placement: { kind: 'root' },
          },
        ],
      }
    )
  ).toMatchObject({ status: 'committed', revision: 1 });
  const sourceText = '\uFEFF' + columns + '\r\n' + rows.join('\r\n') + '\r\n';
  const options: InventoryTableChoices = {
    namespace: 'synthetic:receiving:stable',
    delimiter: ',',
    materials: [{ key: 'sample', materialId: 'synthetic-material' }],
    locations: [
      { key: 'freezer', target: { kind: 'storage', storageId: 'table-box' } },
      { key: 'bench', target: { kind: 'unplaced' } },
    ],
    vessels: [{ key: 'well', vesselId: inventoryWellId('table-plate', 'A1') }],
    skips: [],
  };
  const inspect = () => ctx.owner.inspect(scope)!;
  const initial = inspect();
  const blocked = await ctx.success<InventoryTablePreviewSnapshot>(
    'table preview missing explicit mappings has no effects',
    'inventory.preview-table',
    {
      ...scope,
      format: 'receive-v1',
      sourceText,
      options: { ...options, materials: [], locations: [], vessels: [] },
    }
  );
  expect(blocked.kind).toBe('blocked');
  expect(inspect()).toEqual(initial);
  const preview = (text = sourceText, selectedScope = scope) =>
    ctx.success<InventoryTablePreviewSnapshot>(
      'preview pinned receive table',
      'inventory.preview-table',
      {
        ...selectedScope,
        format: 'receive-v1',
        sourceText: text,
        options,
      }
    );
  const first = await preview();
  expect(first.kind).toBe('ready');
  if (first.kind !== 'ready') throw new Error('Expected resolved table proposal.');
  expect(first.commands).toHaveLength(5);
  expect(first.rows.map((row) => row.sourceId)).toEqual(['0007', '0008', '0009']);
  await ctx.success('change inventory after table preview', 'inventory.execute', {
    ...scope,
    operationId: 'table:invalidate-preview',
    expectedRevision: 1,
    commands: [
      {
        kind: 'create-vessel',
        id: 'table-unrelated-vessel',
        name: 'Synthetic unrelated vessel',
        placement: { kind: 'unplaced' },
      },
    ],
  });
  const stale = await ctx.success<NativeInventoryExecution>(
    'refuse stale table without creating stock',
    'inventory.apply-table',
    {
      ...scope,
      kind: 'receive-table',
      operationId: 'table:stale',
      expectedRevision: 1,
      sourceText,
      options: first.options,
      expectedPlanDigest: first.planDigest,
    }
  );
  expect(stale).toMatchObject({ status: 'rejected', code: 'REVISION_CONFLICT' });
  expect(Object.keys(inspect().stocks)).toHaveLength(0);
  const ready = await preview();
  if (ready.kind !== 'ready') throw new Error('Expected fresh table proposal.');
  const request: InventoryApplyTableRequest = {
    ...scope,
    kind: 'receive-table',
    operationId: 'table:receive-once',
    expectedRevision: 2,
    sourceText,
    options: ready.options,
    expectedPlanDigest: ready.planDigest,
  };
  const receipt = await ctx.loseAcknowledgement(request, 'tableLostAcknowledgement');
  expect(receipt).toMatchObject({ status: 'committed', revision: 3 });
  expect(
    await ctx.success('retry exact table after lost response', 'inventory.apply-table', request)
  ).toEqual(receipt);
  expect(
    await ctx.success<NativeInventoryExecution>(
      'same table operation rejects changed bytes',
      'inventory.apply-table',
      { ...request, sourceText: sourceText + '\n' }
    )
  ).toMatchObject({ status: 'rejected', code: 'INVENTORY_OPERATION_CONFLICT' });
  const received = inspect();
  const bindings = Object.values(received.tableBindings);
  expect(bindings).toHaveLength(3);
  const binding = (id: string) => bindings.find((row) => row.sourceId === id)!;
  expect(received.stocks[binding('0007').stockId].quantity).toEqual({
    kind: 'known',
    value: '80',
    unit: 'uL',
  });
  expect(received.vessels[binding('0007').vesselId].name).toBe('Tube, alpha\nsecond line');
  expect(received.stocks[binding('0008').stockId].quantity).toEqual({
    kind: 'known',
    value: '0',
    unit: 'uL',
  });
  expect(received.stocks[binding('0009').stockId].quantity).toEqual({ kind: 'unknown' });
  const reordered = columns + '\n' + [...rows].reverse().join('\n') + '\n';
  expect((await preview(reordered)).kind).toBe('no-change');
  await ctx.success(
    'use and move received stock without changing lifetime source binding',
    'inventory.execute',
    {
      ...scope,
      operationId: 'table:use-and-move',
      expectedRevision: 3,
      commands: [
        {
          kind: 'consume',
          stockId: binding('0007').stockId,
          quantity: { value: '10', unit: 'uL' },
          reason: 'Synthetic accepted use after receiving',
        },
        {
          kind: 'move-vessel',
          id: binding('0007').vesselId,
          placement: { kind: 'located', storageId: 'table-box', slotId: 'B' },
        },
      ],
    }
  );
  const afterUse = inspect();
  expect(afterUse.tableBindings).toEqual(received.tableBindings);
  expect((await preview(reordered)).kind).toBe('no-change');
  expect((await preview(sourceText.replace(',80,uL,', ',90,uL,'))).kind).toBe('blocked');
  expect(inspect()).toEqual(afterUse);
  const badText =
    columns +
    '\n' +
    [
      'bad-1,First candidate,sample,known,1,uL,usable,new,,freezer,C',
      'bad-2,Late occupied position,sample,known,1,uL,usable,new,,freezer,B',
    ].join('\n');
  const badOptions = {
    ...options,
    namespace: 'synthetic:late-invalid',
    locations: [options.locations[0]],
    vessels: [],
  };
  const bad = await ctx.success<InventoryTablePreviewSnapshot>(
    'late invalid placement blocks whole table proposal',
    'inventory.preview-table',
    {
      ...scope,
      format: 'receive-v1',
      sourceText: badText,
      options: badOptions,
    }
  );
  expect(bad.kind).toBe('blocked');
  expect(inspect()).toEqual(afterUse);
  const artifact = await ctx.success<InventoryExportSnapshot>(
    'export mixed ordinary and table journal',
    'inventory.export-snapshot',
    { ...scope, format: 'native-v1' }
  );
  const document = JSON.parse(artifact.sourceText);
  const savedTable = document.content.history
    .map((row: { requestJson: string }) => JSON.parse(row.requestJson))
    .find((row: InventoryAcceptedRequest) => 'kind' in row && row.kind === 'receive-table');
  expect(savedTable).toEqual({ ...request, project: ctx.projectId });
  const adoption = await ctx.success<InventoryImportPreviewSnapshot>(
    'preview archive containing lifetime table bindings',
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
  if (adoption.kind !== 'ready') throw new Error('Expected archive with table journal to replay.');
  expect(
    await ctx.success<NativeInventoryExecution>(
      'adopt table history through existing archive owner',
      'inventory.apply-import',
      {
        ...adopted,
        kind: 'adopt-archive',
        operationId: 'table:archive-adoption',
        expectedRevision: 0,
        sourceText: artifact.sourceText,
        options: adoption.options,
        expectedPlanDigest: adoption.planDigest,
      }
    )
  ).toMatchObject({ status: 'committed', revision: 1 });
  const adoptedState = ctx.owner.inspect(adopted)!;
  expect(adoptedState.tableBindings).toEqual(afterUse.tableBindings);
  expect((await preview(reordered, adopted)).kind).toBe('no-change');
  return {
    scope,
    adopted,
    sourceText,
    reordered,
    options,
    request,
    receipt,
    received,
    state: afterUse,
    history: ctx.owner.history(scope),
    adoptedState,
    adoptedHistory: ctx.owner.history(adopted),
    artifact,
    blocked,
    stale,
    bad,
  };
}

export async function verifyNativeTableReopen(
  ctx: TableContext,
  before: Awaited<ReturnType<typeof runNativeTableJourney>>
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
  const preview = await ctx.success<InventoryTablePreviewSnapshot>(
    'reopened table source remains unchanged despite use and archive adoption',
    'inventory.preview-table',
    {
      ...before.adopted,
      format: 'receive-v1',
      sourceText: before.reordered,
      options: before.options,
    }
  );
  expect(preview.kind).toBe('no-change');
  expect(
    await ctx.success(
      'reopened table exact retry returns original receipt',
      'inventory.apply-table',
      before.request
    )
  ).toEqual(before.receipt);
  const artifact = await ctx.success<InventoryExportSnapshot>(
    'reopened table export retains exact source bytes',
    'inventory.export-snapshot',
    { ...before.scope, format: 'native-v1' }
  );
  expect(artifact.sourceText).toBe(before.artifact.sourceText);
  return { state: ctx.owner.inspect(before.scope) as InventoryState, preview, artifact };
}
