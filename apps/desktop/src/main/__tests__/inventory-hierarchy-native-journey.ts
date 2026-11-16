import { expect } from 'vitest';
import {
  inventoryStackItems,
  inventoryWellId,
  type InventoryHierarchyChoices,
} from '@waypoint/domain-services';
import type { createNativeInventoryOwner } from '../inventory-owner';
import type {
  InventoryAcceptedRequest,
  InventoryApplyHierarchyRequest,
  InventoryReadRequest,
  NativeInventoryExecution,
  NativeInventoryReceipt,
} from '../../shared/inventory-command';
import type {
  InventoryExportSnapshot,
  InventoryHierarchyPreviewSnapshot,
  InventoryImportPreviewSnapshot,
  InventoryTablePreviewSnapshot,
} from '../../shared/inventory-client';

type Command =
  | 'inventory.execute'
  | 'inventory.preview-hierarchy'
  | 'inventory.apply-hierarchy'
  | 'inventory.preview-table'
  | 'inventory.apply-table'
  | 'inventory.export-snapshot'
  | 'inventory.preview-import'
  | 'inventory.apply-import';
interface HierarchyContext {
  scope: InventoryReadRequest;
  projectId: string;
  owner: ReturnType<typeof createNativeInventoryOwner>;
  success<T>(label: string, command: Command, request: unknown): Promise<T>;
  loseAcknowledgement(
    request: InventoryAcceptedRequest,
    evidenceKey?: string
  ): Promise<NativeInventoryReceipt>;
}
const headers = [
  'source_id',
  'name',
  'layout_kind',
  'positions',
  'rows',
  'columns',
  'capacity',
  'parent_kind',
  'parent_key',
  'slot',
];
const csv = (value: string) =>
  /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
const source = (rows: readonly (readonly string[])[]) =>
  '\uFEFF' +
  headers.join(',') +
  '\r\n' +
  rows.map((row) => row.map(csv).join(',')).join('\r\n') +
  '\r\n';

export async function runNativeHierarchyJourney(ctx: HierarchyContext) {
  const scope = { ...ctx.scope, inventoryId: 'inventory-hierarchy' };
  const adopted = { ...ctx.scope, inventoryId: 'inventory-hierarchy-adopted' };
  const rows = [
    ['aa-top', 'Hierarchy top plate', 'fixed-well', '', '1', '2', '', 'source', 'stack', '2'],
    ['plate', 'Hierarchy nested plate', 'fixed-well', '', '2', '2', '', 'source', 'box', 'A1'],
    ['box', 'Hierarchy grid box', 'grid', '', '2', '2', '', 'source', 'shelf', 'BoxA'],
    [
      'tube-box',
      'Hierarchy removable tube box',
      'removable-tube',
      '',
      '2',
      '2',
      '',
      'source',
      'shelf',
      'TubeBox',
    ],
    ['zz-bottom', 'Hierarchy bottom plate', 'fixed-well', '', '1', '2', '', 'source', 'stack', '1'],
    [
      'shelf',
      'Hierarchy shelf',
      'named',
      '["BoxA","BoxB","Stack","TubeBox"]',
      '',
      '',
      '',
      'source',
      'freezer',
      'Shelf1',
    ],
    ['stack', 'Hierarchy ordered stack', 'stack', '', '', '', '2', 'source', 'shelf', 'Stack'],
    ['freezer', 'Hierarchy freezer', 'named', '["Shelf1"]', '', '', '', 'root', '', ''],
  ];
  const sourceText = source(rows);
  const options: InventoryHierarchyChoices = {
    namespace: 'synthetic:hierarchy:stable',
    delimiter: ',',
    parents: [],
    skips: [],
  };
  const preview = (text = sourceText, choices = options, target = scope) =>
    ctx.success<InventoryHierarchyPreviewSnapshot>(
      'preview explicit hierarchy without writes',
      'inventory.preview-hierarchy',
      { ...target, format: 'hierarchy-v1', sourceText: text, options: choices }
    );
  const initial = await preview();
  expect(initial.kind).toBe('ready');
  expect(ctx.owner.inspect(scope)).toBeNull();
  if (initial.kind !== 'ready') throw new Error('Expected shuffled hierarchy plan.');
  expect(initial.commands).toHaveLength(10);
  const request: InventoryApplyHierarchyRequest = {
    ...scope,
    kind: 'import-hierarchy',
    operationId: 'hierarchy:import-once',
    expectedRevision: 0,
    sourceText,
    options: initial.options,
    expectedPlanDigest: initial.planDigest,
  };
  const receipt = await ctx.loseAcknowledgement(request, 'hierarchyLostAcknowledgement');
  expect(
    await ctx.success('retry hierarchy after lost response', 'inventory.apply-hierarchy', request)
  ).toEqual(receipt);
  expect(
    await ctx.success<NativeInventoryExecution>(
      'same hierarchy operation conflicts with changed bytes',
      'inventory.apply-hierarchy',
      { ...request, sourceText: sourceText + '\n' }
    )
  ).toMatchObject({ status: 'rejected', code: 'INVENTORY_OPERATION_CONFLICT' });
  const imported = ctx.owner.inspect(scope)!;
  expect(Object.keys(imported.storage)).toHaveLength(8);
  expect(Object.keys(imported.hierarchyBindings)).toHaveLength(8);
  expect(Object.keys(imported.vessels)).toHaveLength(8);
  const id = (sourceId: string) =>
    Object.values(imported.hierarchyBindings).find((value) => value.sourceId === sourceId)!
      .storageId;
  expect(inventoryStackItems(imported, id('stack')).map((value) => value.id)).toEqual([
    id('zz-bottom'),
    id('aa-top'),
  ]);
  expect(imported.vessels[inventoryWellId(id('plate'), 'A1')]).toMatchObject({
    kind: 'fixed-well',
    placement: { kind: 'located', storageId: id('plate'), slotId: 'A1' },
  });
  const receiveText =
    'source_id,name,material_key,quantity_kind,quantity,unit,quality,vessel_kind,vessel_key,location_key,slot\nwell-1,,sample,unknown,,,usable,existing,well,,\ntube-1,Hierarchy stock tube,sample,known,10,uL,usable,new,,box,A1\n';
  const receiveOptions = {
    namespace: 'synthetic:hierarchy:stocks',
    delimiter: ',' as const,
    materials: [{ key: 'sample', materialId: 'synthetic-material' }],
    locations: [{ key: 'box', target: { kind: 'storage' as const, storageId: id('tube-box') } }],
    vessels: [{ key: 'well', vesselId: inventoryWellId(id('plate'), 'A1') }],
    skips: [],
  };
  const receive = await ctx.success<InventoryTablePreviewSnapshot>(
    'preview separate atomic stock stage into imported hierarchy',
    'inventory.preview-table',
    { ...scope, format: 'receive-v1', sourceText: receiveText, options: receiveOptions }
  );
  if (receive.kind !== 'ready') throw new Error('Expected explicit stock stage.');
  await ctx.success('fill imported permanent well and tube box', 'inventory.apply-table', {
    ...scope,
    kind: 'receive-table',
    operationId: 'hierarchy:receive-stocks',
    expectedRevision: 1,
    sourceText: receiveText,
    options: receive.options,
    expectedPlanDigest: receive.planDigest,
  });
  const afterReceive = ctx.owner.inspect(scope)!;
  const stale = await ctx.success<NativeInventoryExecution>(
    'refuse stale new hierarchy plan',
    'inventory.apply-hierarchy',
    { ...request, operationId: 'hierarchy:stale', expectedRevision: 0 }
  );
  expect(stale).toMatchObject({ status: 'rejected', code: 'REVISION_CONFLICT' });
  await ctx.success(
    'move imported box without changing original hierarchy binding',
    'inventory.execute',
    {
      ...scope,
      operationId: 'hierarchy:move-box',
      expectedRevision: 2,
      commands: [
        {
          kind: 'move-storage',
          id: id('box'),
          placement: { kind: 'located', storageId: id('shelf'), slotId: 'BoxB' },
        },
      ],
    }
  );
  const state = ctx.owner.inspect(scope)!;
  expect(state.hierarchyBindings).toEqual(imported.hierarchyBindings);
  expect((await preview(source([...rows].reverse()))).kind).toBe('no-change');
  expect(
    (
      await preview(
        source(
          rows.map((row) =>
            row[0] === 'box'
              ? row.map((value, index) => (index === 1 ? 'Changed external box name' : value))
              : row
          )
        )
      )
    ).kind
  ).toBe('blocked');
  const cycle = await preview(
    source([
      ['cycle-a', 'Cycle A', 'named', '["X"]', '', '', '', 'source', 'cycle-b', 'X'],
      ['cycle-b', 'Cycle B', 'named', '["X"]', '', '', '', 'source', 'cycle-a', 'X'],
    ]),
    { ...options, namespace: 'synthetic:cycle' }
  );
  expect(cycle.kind).toBe('blocked');
  const late = await preview(
    source([
      ['first', 'First candidate', 'named', '["X"]', '', '', '', 'existing', 'shelf', 'BoxA'],
      [
        'second',
        'Late conflicting placement',
        'named',
        '["X"]',
        '',
        '',
        '',
        'existing',
        'shelf',
        'BoxB',
      ],
    ]),
    {
      ...options,
      namespace: 'synthetic:late-conflict',
      parents: [{ key: 'shelf', storageId: id('shelf') }],
    }
  );
  expect(late.kind).toBe('blocked');
  expect(ctx.owner.inspect(scope)).toEqual(state);
  const artifact = await ctx.success<InventoryExportSnapshot>(
    'export hierarchy bindings, exact raw table and permanent-well identities',
    'inventory.export-snapshot',
    { ...scope, format: 'native-v1' }
  );
  const accepted = JSON.parse(artifact.sourceText)
    .content.history.map((entry: { requestJson: string }) => JSON.parse(entry.requestJson))
    .find((entry: InventoryAcceptedRequest) => entry.operationId === request.operationId);
  expect(accepted).toEqual({ ...request, project: ctx.projectId });
  const plan = await ctx.success<InventoryImportPreviewSnapshot>(
    'preview archive containing hierarchy and stock imports',
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
  if (plan.kind !== 'ready') throw new Error('Expected hierarchy archive adoption.');
  await ctx.success(
    'adopt imported hierarchy without regenerating physical IDs',
    'inventory.apply-import',
    {
      ...adopted,
      kind: 'adopt-archive',
      operationId: 'hierarchy:adopt',
      expectedRevision: 0,
      sourceText: artifact.sourceText,
      options: plan.options,
      expectedPlanDigest: plan.planDigest,
    }
  );
  const adoptedState = ctx.owner.inspect(adopted)!;
  expect(adoptedState.hierarchyBindings).toEqual(state.hierarchyBindings);
  expect(adoptedState.storage).toEqual(state.storage);
  expect(adoptedState.vessels).toEqual(state.vessels);
  expect((await preview(sourceText, options, adopted)).kind).toBe('no-change');
  return {
    scope,
    adopted,
    sourceText,
    rows,
    options,
    request,
    receipt,
    imported,
    afterReceive,
    state,
    history: ctx.owner.history(scope),
    adoptedState,
    artifact,
    cycle,
    late,
  };
}

export async function verifyNativeHierarchyReopen(
  ctx: HierarchyContext,
  before: Awaited<ReturnType<typeof runNativeHierarchyJourney>>
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
      'reopened hierarchy exact retry returns original receipt',
      'inventory.apply-hierarchy',
      before.request
    )
  ).toEqual(before.receipt);
  const preview = await ctx.success<InventoryHierarchyPreviewSnapshot>(
    'reopened adopted hierarchy retains source identity despite box movement',
    'inventory.preview-hierarchy',
    {
      ...before.adopted,
      format: 'hierarchy-v1',
      sourceText: before.sourceText,
      options: before.options,
    }
  );
  expect(preview.kind).toBe('no-change');
  const artifact = await ctx.success<InventoryExportSnapshot>(
    'reopened hierarchy archive retains exact bytes',
    'inventory.export-snapshot',
    { ...before.scope, format: 'native-v1' }
  );
  expect(artifact.sourceText).toBe(before.artifact.sourceText);
  return { state: ctx.owner.inspect(before.scope), preview, artifact };
}
