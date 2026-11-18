import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { beforeEach, expect, it, vi } from 'vitest';
import type {
  InventoryExecuteRequest,
  NativeInventoryExecution,
} from '../../shared/inventory-command';
import type { NativeInventoryOwner } from '../inventory-owner';
import type { OrganizationInventoryOwner } from '../organization-inventory-owner';
import { unavailableInventoryClient } from '../../shared/inventory-client';
import { NativeDocumentCommandError } from '../../shared/native-document-error';

const captured = vi.hoisted(() => ({ handlers: {} as Record<string, unknown> }));
vi.mock('../../shared/ipc-contract', () => ({
  handleGroup: (_contract: unknown, handlers: Record<string, unknown>) => {
    captured.handlers = handlers;
    return () => {};
  },
}));
import { registerInventoryHandlers } from './inventory';

const frame = {};
const target = { id: 7, isDestroyed: () => false, mainFrame: frame } as unknown as WebContents;
const event = { sender: target, senderFrame: frame } as unknown as IpcMainInvokeEvent;
const request: InventoryExecuteRequest = {
  project: 'project',
  inventoryId: 'inventory',
  operationId: 'once',
  expectedRevision: 0,
  commands: [
    { kind: 'create-vessel', id: 'vessel', name: 'Vessel', placement: { kind: 'unplaced' } },
  ],
};
let owner: NativeInventoryOwner | null;
let scientificWorksForContext: ReturnType<typeof vi.fn>;
let inspectBenchlingCapture: ReturnType<typeof vi.fn>;
let previewBenchlingCapture: ReturnType<typeof vi.fn>;
let applyBenchlingCapture: ReturnType<typeof vi.fn>;
let execute: ReturnType<typeof vi.fn>;
let availability: ReturnType<typeof vi.fn>;
let catalog: ReturnType<typeof vi.fn>;
let catalogUpdatePreview: ReturnType<typeof vi.fn>;
let resolveItemCode: ReturnType<typeof vi.fn>;
let prepareLabel: ReturnType<typeof vi.fn>;
let storageConditions: ReturnType<typeof vi.fn>;
let exportSnapshot: ReturnType<typeof vi.fn>;
let previewImport: ReturnType<typeof vi.fn>;
let applyImport: ReturnType<typeof vi.fn>;
let previewTable: ReturnType<typeof vi.fn>;
let applyTable: ReturnType<typeof vi.fn>;
let previewStocktake: ReturnType<typeof vi.fn>;
let previewMappedTable: ReturnType<typeof vi.fn>;
let applyMappedTable: ReturnType<typeof vi.fn>;
let previewHierarchy: ReturnType<typeof vi.fn>;
let applyHierarchy: ReturnType<typeof vi.fn>;
let applyStocktake: ReturnType<typeof vi.fn>;
let previewSourceRevision: ReturnType<typeof vi.fn>;
let acknowledgeSource: ReturnType<typeof vi.fn>;
const call = (input: unknown = request) =>
  (
    captured.handlers.execute as (
      event: IpcMainInvokeEvent,
      input: unknown
    ) => NativeInventoryExecution
  )(event, input);

beforeEach(() => {
  scientificWorksForContext = vi.fn(() => ({ kind: 'inventory-absent' }));
  inspectBenchlingCapture = vi.fn(() => ({ kind: 'blocked', capture: null }));
  previewBenchlingCapture = vi.fn(() => ({ kind: 'blocked', issues: [] }));
  applyBenchlingCapture = vi.fn(() => ({ status: 'committed', operationId: 'capture-once' }));
  execute = vi.fn(() => ({ status: 'committed' }));
  availability = vi.fn(() => null);
  catalog = vi.fn(() => []);
  catalogUpdatePreview = vi.fn(() => ({ revision: 0, canApply: true }));
  resolveItemCode = vi.fn(() => ({ revision: 0, resolution: { kind: 'not-found' } }));
  prepareLabel = vi.fn(async () => ({ rendered: { svg: 'exact SVG bytes' } }));
  storageConditions = vi.fn(() => ({ revision: 0, equipment: {}, stocks: {} }));
  exportSnapshot = vi.fn(() => ({ sourceText: 'exact archive text' }));
  previewImport = vi.fn(() => ({ kind: 'ready', target: { revision: 0 } }));
  applyImport = vi.fn(() => ({ status: 'committed' }));
  previewTable = vi.fn(() => ({ kind: 'ready', target: { revision: 0 } }));
  applyTable = vi.fn(() => ({ status: 'committed' }));
  previewMappedTable = vi.fn(() => ({ kind: 'ready', target: { revision: 0 } }));
  applyMappedTable = vi.fn(() => ({ status: 'committed' }));
  previewHierarchy = vi.fn(() => ({ kind: 'ready', target: { revision: 0 } }));
  applyHierarchy = vi.fn(() => ({ status: 'committed' }));
  previewStocktake = vi.fn(() => ({ kind: 'ready', target: { revision: 0 } }));
  applyStocktake = vi.fn(() => ({ status: 'committed' }));
  previewSourceRevision = vi.fn(() => ({ kind: 'ready', target: { revision: 0 } }));
  acknowledgeSource = vi.fn(() => ({ status: 'committed' }));
  owner = {
    scientificWorksForContext,
    inspectBenchlingCapture,
    previewBenchlingCapture,
    applyBenchlingCapture,
    execute,
    availability,
    catalog,
    catalogUpdatePreview,
    resolveItemCode,
    prepareLabel,
    storageConditions,
    exportSnapshot,
    previewImport,
    applyImport,
    previewTable,
    applyTable,
    previewStocktake,
    previewHierarchy,
    previewMappedTable,
    applyMappedTable,
    applyHierarchy,
    applyStocktake,
    previewSourceRevision,
    acknowledgeSource,
  } as unknown as NativeInventoryOwner;
  registerInventoryHandlers({ owner: () => owner, target: () => target });
});

it.each(['organizationDirectory', 'organizationSnapshot', 'organizationPreview'] as const)(
  'forwards %s only through the optional current organization owner',
  async (method) => {
    const result = { kind: 'unavailable', code: 'OFFLINE', message: 'Offline.', retryable: true };
    const read = vi.fn(async (_request, assertCurrent: () => void) => {
      assertCurrent();
      return result;
    });
    const organizationOwner = { [method]: read } as unknown as OrganizationInventoryOwner;
    registerInventoryHandlers({
      owner: () => owner,
      organizationOwner: () => organizationOwner,
      target: () => target,
    });
    const handler = captured.handlers[method] as (
      event: IpcMainInvokeEvent,
      request: unknown
    ) => Promise<unknown>;
    const input = { exact: 'retained request' };
    await expect(handler(event, input)).resolves.toEqual(result);
    expect(read).toHaveBeenCalledExactlyOnceWith(
      input,
      expect.any(Function),
      ...(method === 'organizationPreview' ? [target] : [])
    );
    await expect(
      handler({ ...event, senderFrame: {} } as IpcMainInvokeEvent, input)
    ).rejects.toMatchObject({
      code: 'INVENTORY_DESKTOP_CALLER_UNAVAILABLE',
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  }
);

it.each(['organizationPreview', 'organizationCancelPreview', 'organizationSubmit'] as const)(
  'passes a stable native WebContents key and fresh current callbacks to %s',
  async (method) => {
    const read = vi.fn(async (_request: unknown, assertCurrent: () => void, callerKey: object) => {
      assertCurrent();
      expect(callerKey).toBe(target);
      return { kind: 'unavailable', code: 'TEST', message: 'No effect.', retryable: false };
    });
    const organizationOwner = { [method]: read } as unknown as OrganizationInventoryOwner;
    registerInventoryHandlers({
      owner: () => owner,
      organizationOwner: () => organizationOwner,
      target: () => target,
    });
    const handler = captured.handlers[method] as (
      event: IpcMainInvokeEvent,
      input: unknown
    ) => Promise<unknown>;
    await handler(event, {});
    await handler(event, {});
    expect(read.mock.calls[0][2]).toBe(read.mock.calls[1][2]);
    expect(read.mock.calls[0][1]).not.toBe(read.mock.calls[1][1]);
    await expect(
      handler({ ...event, senderFrame: {} } as IpcMainInvokeEvent, {})
    ).rejects.toMatchObject({ code: 'INVENTORY_DESKTOP_CALLER_UNAVAILABLE' });
    expect(read).toHaveBeenCalledTimes(2);
  }
);

it.each(['owner', 'caller'] as const)(
  'discards an awaited organization response after its %s changes',
  async (changed) => {
    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    const read = vi.fn((_request: unknown, _assertCurrent: () => void) => pending);
    let organizationOwner: OrganizationInventoryOwner | null = {
      organizationSnapshot: read,
    } as unknown as OrganizationInventoryOwner;
    let currentTarget = target;
    registerInventoryHandlers({
      owner: () => owner,
      organizationOwner: () => organizationOwner,
      target: () => currentTarget,
    });
    const handler = captured.handlers.organizationSnapshot as (
      event: IpcMainInvokeEvent,
      request: unknown
    ) => Promise<unknown>;
    const response = handler(event, {});
    const assertCurrent = read.mock.calls[0][1] as () => void;
    if (changed === 'owner') organizationOwner = null;
    else currentTarget = { ...target, id: 9 } as WebContents;
    expect(assertCurrent).toThrow(NativeDocumentCommandError);
    finish({ kind: 'current' });
    await expect(response).rejects.toMatchObject({
      code:
        changed === 'owner'
          ? 'INVENTORY_OWNER_UNAVAILABLE'
          : 'INVENTORY_DESKTOP_CALLER_UNAVAILABLE',
    });
  }
);

it('keeps legacy registrations usable without an organization owner and returns explicit unavailable platform reads', async () => {
  const read = captured.handlers.organizationDirectory as (
    event: IpcMainInvokeEvent,
    request: unknown
  ) => Promise<unknown>;
  await expect(read(event, {})).rejects.toMatchObject({ code: 'INVENTORY_OWNER_UNAVAILABLE' });
  expect(call()).toMatchObject({ status: 'committed' });
  const client = unavailableInventoryClient();
  const unavailable = {
    kind: 'unavailable',
    code: 'INVENTORY_OWNER_UNAVAILABLE',
    retryable: false,
  };
  await expect(client.organizationDirectory({} as never)).resolves.toMatchObject(unavailable);
  await expect(client.organizationSnapshot({} as never)).resolves.toMatchObject(unavailable);
  await expect(client.organizationPreview({} as never)).resolves.toMatchObject(unavailable);
  await expect(client.organizationCancelPreview({} as never)).resolves.toMatchObject(unavailable);
  await expect(client.organizationSubmit({} as never)).resolves.toMatchObject(unavailable);
  await expect(client.organizationAttempt({} as never)).resolves.toMatchObject(unavailable);
  await expect(client.organizationRecover({} as never)).resolves.toMatchObject(unavailable);
  await expect(client.inspect({} as never)).rejects.toThrow('INVENTORY_OWNER_UNAVAILABLE');
});

it('reads physical work under its exact scoped query without any mutation method', () => {
  const read = captured.handlers.scientificWorksForContext as (
    event: IpcMainInvokeEvent,
    input: unknown
  ) => unknown;
  const input = {
    project: 'project',
    inventoryId: 'inventory',
    context: { kind: 'protocol-run', entityId: 'project::run' },
    limit: 20,
  };
  expect(read(event, input)).toEqual({ kind: 'inventory-absent' });
  expect(scientificWorksForContext).toHaveBeenCalledExactlyOnceWith(input);
  expect(execute).not.toHaveBeenCalled();
  expect(() => read({ ...event, senderFrame: {} } as IpcMainInvokeEvent, input)).toThrow();
  expect(scientificWorksForContext).toHaveBeenCalledTimes(1);
});

it('keeps capture inspection under the current renderer caller without mutation', () => {
  const read = captured.handlers.inspectBenchlingCapture as (
    event: IpcMainInvokeEvent,
    input: unknown
  ) => unknown;
  const input = { project: 'project', inventoryId: 'inventory', sourceText: '' };
  expect(read(event, input)).toEqual({ kind: 'blocked', capture: null });
  expect(inspectBenchlingCapture).toHaveBeenCalledExactlyOnceWith(input);
  expect(execute).not.toHaveBeenCalled();
  expect(() => read({ ...event, senderFrame: {} } as IpcMainInvokeEvent, input)).toThrow();
  expect(inspectBenchlingCapture).toHaveBeenCalledTimes(1);
  owner = null;
  expect(() => read(event, input)).toThrow(/INVENTORY_OWNER_UNAVAILABLE/);
});

it('keeps capture preview read-only and routes only the resolved accepted request to apply', () => {
  const options = {
    scopeAcceptance: { kind: 'selected-records', reason: '' },
    records: [],
    sourceIssueDispositions: [],
    uncapturedPositions: [],
  };
  const read = captured.handlers.previewBenchlingCapture as (
    event: IpcMainInvokeEvent,
    input: unknown
  ) => unknown;
  const preview = { project: 'project', inventoryId: 'inventory', sourceText: '', options };
  expect(read(event, preview)).toEqual({ kind: 'blocked', issues: [] });
  expect(previewBenchlingCapture).toHaveBeenCalledWith(preview);
  expect(applyBenchlingCapture).not.toHaveBeenCalled();
  const apply = captured.handlers.applyBenchlingCapture as (
    event: IpcMainInvokeEvent,
    input: unknown
  ) => NativeInventoryExecution;
  const accepted = {
    ...preview,
    sourceText: '{}',
    kind: 'import-benchling-capture',
    operationId: 'capture-once',
    expectedRevision: 0,
    expectedPlanDigest: `sha256:${'a'.repeat(64)}`,
    options: {
      ...options,
      materials: [],
      resolvedTargets: [],
      normalizedStockRows: [],
      normalizedTableOptions: {
        namespace: 'source',
        delimiter: ',',
        materials: [],
        locations: [],
        vessels: [],
        skips: [],
      },
    },
  };
  expect(apply(event, accepted)).toMatchObject({ status: 'committed' });
  expect(applyBenchlingCapture).toHaveBeenCalledWith(accepted, expect.any(Function), {
    actor: 'human:desktop:7',
  });
  expect(apply(event, { ...accepted, options })).toMatchObject({
    status: 'rejected',
    code: 'INVALID_INVENTORY_INPUT',
  });
  expect(applyBenchlingCapture).toHaveBeenCalledTimes(1);
});

it('keeps source revision preview read-only and source acknowledgement under the same current-caller fence', () => {
  const options = {
    table: {
      namespace: 'source',
      delimiter: ',',
      materials: [],
      locations: [],
      vessels: [],
      skips: [],
    },
    acknowledgements: [],
  };
  const preview = {
    project: 'project',
    inventoryId: 'inventory',
    format: 'receive-v1',
    sourceText: 'exact source\r\n',
    options,
  };
  const read = captured.handlers.previewSourceRevision as (
    event: IpcMainInvokeEvent,
    input: unknown
  ) => unknown;
  expect(read(event, preview)).toMatchObject({ kind: 'ready' });
  expect(previewSourceRevision).toHaveBeenCalledExactlyOnceWith(preview);
  expect(acknowledgeSource).not.toHaveBeenCalled();
  const input = {
    kind: 'acknowledge-table-source',
    project: 'project',
    inventoryId: 'inventory',
    operationId: 'source-once',
    expectedRevision: 0,
    sourceText: preview.sourceText,
    options: { ...options, preimages: [] },
    expectedPlanDigest: `sha256:${'0'.repeat(64)}`,
  };
  const apply = captured.handlers.acknowledgeSource as (
    event: IpcMainInvokeEvent,
    input: unknown
  ) => NativeInventoryExecution;
  expect(apply(event, input)).toMatchObject({ status: 'committed' });
  expect(acknowledgeSource).toHaveBeenCalledWith(input, expect.any(Function), {
    actor: 'human:desktop:7',
  });
  expect(apply(event, { ...input, recordedAt: 0 })).toMatchObject({
    status: 'rejected',
    operationId: 'source-once',
    code: 'INVALID_INVENTORY_INPUT',
  });
  expect(acknowledgeSource).toHaveBeenCalledTimes(1);
  expect(
    apply({ sender: { id: 9, isDestroyed: () => false } } as IpcMainInvokeEvent, input)
  ).toMatchObject({
    status: 'rejected',
    operationId: 'source-once',
    code: 'INVENTORY_DESKTOP_CALLER_UNAVAILABLE',
  });
  expect(acknowledgeSource).toHaveBeenCalledTimes(1);
  expect(execute).not.toHaveBeenCalled();
  expect(applyImport).not.toHaveBeenCalled();
});

it('keeps mapped table preview read-only and mapped table application under the same current-caller fence', () => {
  const options = {
    namespace: 'source',
    delimiter: ',',
    columns: { sourceId: 'ID', plate: 'Plate', well: 'Well' },
    materials: [],
    plates: [],
    quantity: { kind: 'unknown', reason: 'No source measurements' },
    qualities: [],
    evidenceOnlyColumns: [],
    skips: [],
  };
  const preview = {
    project: 'project',
    inventoryId: 'inventory',
    format: 'mapped-plate-v1',
    sourceText: 'exact source\r\n',
    options,
  };
  const read = captured.handlers.previewMappedTable as (
    event: IpcMainInvokeEvent,
    input: unknown
  ) => unknown;
  expect(read(event, preview)).toMatchObject({ kind: 'ready' });
  expect(previewMappedTable).toHaveBeenCalledExactlyOnceWith(preview);
  expect(applyMappedTable).not.toHaveBeenCalled();
  const input = {
    kind: 'receive-mapped-table',
    project: 'project',
    inventoryId: 'inventory',
    operationId: 'mapped-once',
    expectedRevision: 0,
    sourceText: preview.sourceText,
    options,
    expectedPlanDigest: `sha256:${'0'.repeat(64)}`,
  };
  const apply = captured.handlers.applyMappedTable as (
    event: IpcMainInvokeEvent,
    input: unknown
  ) => NativeInventoryExecution;
  expect(apply(event, input)).toMatchObject({ status: 'committed' });
  expect(applyMappedTable).toHaveBeenCalledWith(input, expect.any(Function), {
    actor: 'human:desktop:7',
  });
  expect(apply(event, { ...input, recordedAt: 0 })).toMatchObject({
    status: 'rejected',
    operationId: 'mapped-once',
    code: 'INVALID_INVENTORY_INPUT',
  });
  expect(applyMappedTable).toHaveBeenCalledTimes(1);
  expect(
    apply({ sender: { id: 9, isDestroyed: () => false } } as IpcMainInvokeEvent, input)
  ).toMatchObject({
    status: 'rejected',
    operationId: 'mapped-once',
    code: 'INVENTORY_DESKTOP_CALLER_UNAVAILABLE',
  });
  expect(applyMappedTable).toHaveBeenCalledTimes(1);
  expect(execute).not.toHaveBeenCalled();
  expect(applyImport).not.toHaveBeenCalled();
});

it('keeps hierarchy preview read-only and hierarchy application under the same current-caller fence', () => {
  const options = {
    namespace: 'source',
    delimiter: ',',
    parents: [],
    skips: [],
  };
  const preview = {
    project: 'project',
    inventoryId: 'inventory',
    format: 'hierarchy-v1',
    sourceText: 'exact source\r\n',
    options,
  };
  const read = captured.handlers.previewHierarchy as (
    event: IpcMainInvokeEvent,
    input: unknown
  ) => unknown;
  expect(read(event, preview)).toMatchObject({ kind: 'ready' });
  expect(previewHierarchy).toHaveBeenCalledExactlyOnceWith(preview);
  expect(applyHierarchy).not.toHaveBeenCalled();
  const input = {
    kind: 'import-hierarchy',
    project: 'project',
    inventoryId: 'inventory',
    operationId: 'hierarchy-once',
    expectedRevision: 0,
    sourceText: preview.sourceText,
    options,
    expectedPlanDigest: `sha256:${'0'.repeat(64)}`,
  };
  const apply = captured.handlers.applyHierarchy as (
    event: IpcMainInvokeEvent,
    input: unknown
  ) => NativeInventoryExecution;
  expect(apply(event, input)).toMatchObject({ status: 'committed' });
  expect(applyHierarchy).toHaveBeenCalledWith(input, expect.any(Function), {
    actor: 'human:desktop:7',
  });
  expect(apply(event, { ...input, recordedAt: 0 })).toMatchObject({
    status: 'rejected',
    operationId: 'hierarchy-once',
    code: 'INVALID_INVENTORY_INPUT',
  });
  expect(applyHierarchy).toHaveBeenCalledTimes(1);
  expect(
    apply({ sender: { id: 9, isDestroyed: () => false } } as IpcMainInvokeEvent, input)
  ).toMatchObject({
    status: 'rejected',
    operationId: 'hierarchy-once',
    code: 'INVENTORY_DESKTOP_CALLER_UNAVAILABLE',
  });
  expect(applyHierarchy).toHaveBeenCalledTimes(1);
  expect(execute).not.toHaveBeenCalled();
  expect(applyImport).not.toHaveBeenCalled();
});

it('keeps stocktake preview read-only and stocktake application under the same current-caller fence', () => {
  const options = {
    namespace: 'source',
    delimiter: ',',
    subjects: [],
    locations: [],
    decisions: [],
  };
  const preview = {
    project: 'project',
    inventoryId: 'inventory',
    format: 'stocktake-v1',
    sourceText: 'exact source\r\n',
    options,
  };
  const read = captured.handlers.previewStocktake as (
    event: IpcMainInvokeEvent,
    input: unknown
  ) => unknown;
  expect(read(event, preview)).toMatchObject({ kind: 'ready' });
  expect(previewStocktake).toHaveBeenCalledExactlyOnceWith(preview);
  expect(applyStocktake).not.toHaveBeenCalled();
  const input = {
    kind: 'apply-stocktake',
    project: 'project',
    inventoryId: 'inventory',
    operationId: 'stocktake-once',
    expectedRevision: 0,
    sourceText: preview.sourceText,
    options,
    expectedPlanDigest: `sha256:${'0'.repeat(64)}`,
  };
  const apply = captured.handlers.applyStocktake as (
    event: IpcMainInvokeEvent,
    input: unknown
  ) => NativeInventoryExecution;
  expect(apply(event, input)).toMatchObject({ status: 'committed' });
  expect(applyStocktake).toHaveBeenCalledWith(input, expect.any(Function), {
    actor: 'human:desktop:7',
  });
  expect(apply(event, { ...input, recordedAt: 0 })).toMatchObject({
    status: 'rejected',
    operationId: 'stocktake-once',
    code: 'INVALID_INVENTORY_INPUT',
  });
  expect(applyStocktake).toHaveBeenCalledTimes(1);
  expect(
    apply({ sender: { id: 9, isDestroyed: () => false } } as IpcMainInvokeEvent, input)
  ).toMatchObject({
    status: 'rejected',
    operationId: 'stocktake-once',
    code: 'INVENTORY_DESKTOP_CALLER_UNAVAILABLE',
  });
  expect(applyStocktake).toHaveBeenCalledTimes(1);
  expect(execute).not.toHaveBeenCalled();
  expect(applyImport).not.toHaveBeenCalled();
});

it('keeps table preview read-only and table application under the same current-caller fence', () => {
  const options = {
    namespace: 'source',
    delimiter: ',',
    materials: [],
    locations: [],
    vessels: [],
    skips: [],
  };
  const preview = {
    project: 'project',
    inventoryId: 'inventory',
    format: 'receive-v1',
    sourceText: 'exact source\r\n',
    options,
  };
  const read = captured.handlers.previewTable as (
    event: IpcMainInvokeEvent,
    input: unknown
  ) => unknown;
  expect(read(event, preview)).toMatchObject({ kind: 'ready' });
  expect(previewTable).toHaveBeenCalledExactlyOnceWith(preview);
  expect(applyTable).not.toHaveBeenCalled();
  const input = {
    kind: 'receive-table',
    project: 'project',
    inventoryId: 'inventory',
    operationId: 'table-once',
    expectedRevision: 0,
    sourceText: preview.sourceText,
    options,
    expectedPlanDigest: `sha256:${'0'.repeat(64)}`,
  };
  const apply = captured.handlers.applyTable as (
    event: IpcMainInvokeEvent,
    input: unknown
  ) => NativeInventoryExecution;
  expect(apply(event, input)).toMatchObject({ status: 'committed' });
  expect(applyTable).toHaveBeenCalledWith(input, expect.any(Function), {
    actor: 'human:desktop:7',
  });
  expect(apply(event, { ...input, recordedAt: 0 })).toMatchObject({
    status: 'rejected',
    operationId: 'table-once',
    code: 'INVALID_INVENTORY_INPUT',
  });
  expect(applyTable).toHaveBeenCalledTimes(1);
  expect(
    apply({ sender: { id: 9, isDestroyed: () => false } } as IpcMainInvokeEvent, input)
  ).toMatchObject({
    status: 'rejected',
    operationId: 'table-once',
    code: 'INVENTORY_DESKTOP_CALLER_UNAVAILABLE',
  });
  expect(applyTable).toHaveBeenCalledTimes(1);
  expect(execute).not.toHaveBeenCalled();
  expect(applyImport).not.toHaveBeenCalled();
});

it('keeps archive reads on the current caller without mutation dispatch', () => {
  for (const [name, input, mock] of [
    [
      'exportSnapshot',
      { project: 'project', inventoryId: 'inventory', format: 'native-v1' },
      exportSnapshot,
    ],
    [
      'previewImport',
      {
        project: 'project',
        inventoryId: 'inventory',
        sourceText: 'exact archive text',
        options: { bindings: [] },
      },
      previewImport,
    ],
  ] as const) {
    const handler = captured.handlers[name] as (
      event: IpcMainInvokeEvent,
      input: unknown
    ) => unknown;
    handler(event, input);
    expect(mock).toHaveBeenCalledExactlyOnceWith(input);
    expect(() =>
      handler({ sender: { id: 9, isDestroyed: () => false } } as IpcMainInvokeEvent, input)
    ).toThrow('INVENTORY_DESKTOP_CALLER_UNAVAILABLE');
  }
  expect(execute).not.toHaveBeenCalled();
  expect(applyImport).not.toHaveBeenCalled();
});

it('routes adoption through the same current caller fence and preserves malformed operation identity', () => {
  const input = {
    kind: 'adopt-archive',
    project: 'project',
    inventoryId: 'inventory',
    operationId: 'adopt',
    expectedRevision: 0,
    sourceText: 'archive',
    options: { bindings: [] },
    expectedPlanDigest: `sha256:${'0'.repeat(64)}`,
  };
  const handler = captured.handlers.applyImport as (
    event: IpcMainInvokeEvent,
    input: unknown
  ) => unknown;
  expect(handler(event, input)).toEqual({ status: 'committed' });
  expect(applyImport).toHaveBeenCalledWith(input, expect.any(Function), {
    actor: 'human:desktop:7',
  });
  const assertCurrent = applyImport.mock.calls[0][1] as () => void;
  owner = null;
  expect(assertCurrent).toThrow('INVENTORY_OWNER_UNAVAILABLE');
  expect(
    handler(event, { ...input, principal: { kind: 'agent', identityId: 'forged' } })
  ).toMatchObject({ status: 'rejected', operationId: 'adopt', code: 'INVALID_INVENTORY_INPUT' });
  expect(applyImport).toHaveBeenCalledTimes(1);
});

it('reads the catalog through the current desktop owner and caller', () => {
  const input = { project: 'project' };
  const handler = captured.handlers.catalog as (
    event: IpcMainInvokeEvent,
    request: unknown
  ) => unknown;
  expect(handler(event, input)).toEqual([]);
  expect(catalog).toHaveBeenCalledExactlyOnceWith(input);
  expect(() =>
    handler({ sender: { id: 9, isDestroyed: () => false } } as IpcMainInvokeEvent, input)
  ).toThrow('INVENTORY_DESKTOP_CALLER_UNAVAILABLE');
});

it('previews a catalog update through the current desktop owner without executing commands', () => {
  const input = { project: 'project', inventoryId: 'inventory', catalogEntryId: 'catalog-entry' };
  const handler = captured.handlers.catalogUpdatePreview as (
    event: IpcMainInvokeEvent,
    request: unknown
  ) => unknown;
  expect(handler(event, input)).toEqual({ revision: 0, canApply: true });
  expect(catalogUpdatePreview).toHaveBeenCalledExactlyOnceWith(input);
  expect(execute).not.toHaveBeenCalled();
  expect(() =>
    handler({ sender: { id: 9, isDestroyed: () => false } } as IpcMainInvokeEvent, input)
  ).toThrow('INVENTORY_DESKTOP_CALLER_UNAVAILABLE');
  owner = null;
  expect(() => handler(event, input)).toThrow('INVENTORY_OWNER_UNAVAILABLE');
});

it('resolves raw item codes through the current desktop caller without executing commands', () => {
  const input = {
    project: 'project',
    inventoryId: 'inventory',
    query: { namespace: null, value: ' 001a\r\n' },
  };
  const handler = captured.handlers.resolveItemCode as (
    event: IpcMainInvokeEvent,
    request: unknown
  ) => unknown;
  expect(handler(event, input)).toEqual({ revision: 0, resolution: { kind: 'not-found' } });
  expect(resolveItemCode).toHaveBeenCalledExactlyOnceWith(input);
  expect(execute).not.toHaveBeenCalled();
  expect(() =>
    handler(
      {
        sender: { id: 9, isDestroyed: () => false },
      } as IpcMainInvokeEvent,
      input
    )
  ).toThrow('INVENTORY_DESKTOP_CALLER_UNAVAILABLE');
  owner = null;
  expect(() => handler(event, input)).toThrow('INVENTORY_OWNER_UNAVAILABLE');
});

it('reads availability through the current native profile owner', () => {
  const input = { project: 'project', inventoryId: 'inventory' };
  const handler = captured.handlers.availability as (
    event: IpcMainInvokeEvent,
    request: unknown
  ) => unknown;
  expect(handler(event, input)).toBeNull();
  expect(availability).toHaveBeenCalledExactlyOnceWith(input);
  expect(() =>
    handler({ sender: { id: 9, isDestroyed: () => false } } as IpcMainInvokeEvent, input)
  ).toThrow('INVENTORY_DESKTOP_CALLER_UNAVAILABLE');
});

it('reads conditions through the current desktop caller without accepting a caller clock', () => {
  const input = { project: 'project', inventoryId: 'inventory', freshnessMaxAgeMs: null };
  const handler = captured.handlers.storageConditions as (
    event: IpcMainInvokeEvent,
    request: unknown
  ) => unknown;
  expect(handler(event, input)).toEqual({ revision: 0, equipment: {}, stocks: {} });
  expect(storageConditions).toHaveBeenCalledExactlyOnceWith(input);
  expect(execute).not.toHaveBeenCalled();
  expect(() =>
    handler({ sender: { id: 9, isDestroyed: () => false } } as IpcMainInvokeEvent, input)
  ).toThrow('INVENTORY_DESKTOP_CALLER_UNAVAILABLE');
  owner = null;
  expect(() => handler(event, input)).toThrow('INVENTORY_OWNER_UNAVAILABLE');
});

it('prepares label bytes through the current desktop owner and fences a late owner change', async () => {
  const input = {
    project: 'project',
    inventoryId: 'inventory',
    codeId: 'code',
    mediaProfileId: 'qr-50x30-300dpi',
  };
  const handler = captured.handlers.prepareLabel as (
    event: IpcMainInvokeEvent,
    request: unknown
  ) => Promise<unknown>;
  await expect(handler(event, input)).resolves.toEqual({ rendered: { svg: 'exact SVG bytes' } });
  expect(prepareLabel).toHaveBeenCalledExactlyOnceWith(input);
  expect(execute).not.toHaveBeenCalled();
  await expect(
    handler({ sender: { id: 9, isDestroyed: () => false } } as IpcMainInvokeEvent, input)
  ).rejects.toThrow('INVENTORY_DESKTOP_CALLER_UNAVAILABLE');
  let complete: (() => void) | undefined;
  prepareLabel.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => (complete = resolve));
    return { rendered: { svg: 'late bytes' } };
  });
  const pending = handler(event, input);
  owner = null;
  complete!();
  await expect(pending).rejects.toThrow('INVENTORY_OWNER_UNAVAILABLE');
});

it('passes trusted human identity and a live caller check to the shared owner', () => {
  expect(call()).toEqual({ status: 'committed' });
  expect(execute).toHaveBeenCalledWith(request, expect.any(Function), { actor: 'human:desktop:7' });
  const assertCurrent = execute.mock.calls[0][1] as () => void;
  expect(assertCurrent).not.toThrow();
  owner = null;
  expect(assertCurrent).toThrow('INVENTORY_OWNER_UNAVAILABLE');
});

it('returns a known no-effect rejection for malformed draft commands before execution', () => {
  expect(call({ ...request, commands: [{ kind: 'fabricated-command' }] })).toMatchObject({
    status: 'rejected',
    inventoryId: 'inventory',
    operationId: 'once',
    code: 'INVALID_INVENTORY_INPUT',
  });
  expect(execute).not.toHaveBeenCalled();
});

it('retains the operation identity for known no-effect access denial or unavailable owner', () => {
  execute.mockImplementation(() => {
    throw new NativeDocumentCommandError('PROJECT_ACCESS_DENIED', 'Unavailable project.', false);
  });
  expect(call()).toMatchObject({
    status: 'rejected',
    operationId: 'once',
    code: 'PROJECT_ACCESS_DENIED',
  });
  owner = null;
  expect(call()).toMatchObject({
    status: 'rejected',
    operationId: 'once',
    code: 'INVENTORY_OWNER_UNAVAILABLE',
  });
});

it.each([
  new Error('PROJECT_ACCESS_DENIED: An arbitrary infrastructure error.'),
  new NativeDocumentCommandError('PUBLICATION_UNKNOWN', 'The outcome is unknown.', 'unknown'),
])('preserves unqualified failures for outcome-unknown recovery', (error) => {
  execute.mockImplementation(() => {
    throw error;
  });
  expect(() => call()).toThrow(error);
});

it('routes citation reads and fences asynchronous previews against owner replacement', async () => {
  let finish: (value: unknown) => void = () => {};
  const previewScientificCitation = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const scientificCitations = vi.fn(() => ({ kind: 'ready', entries: [] }));
  const scientificCitationSource = vi.fn(() => ({ kind: 'unavailable' }));
  owner = {
    ...owner,
    previewScientificCitation,
    scientificCitations,
    scientificCitationSource,
  } as unknown as NativeInventoryOwner;
  const source = { project: 'project', inventoryId: 'inventory', citationId: 'citation' };
  const query = {
    project: 'project',
    inventoryId: 'inventory',
    workId: 'work',
    workIntentSha256: `sha256:${'a'.repeat(64)}`,
  };
  const read = captured.handlers.scientificCitations as (
    event: IpcMainInvokeEvent,
    input: unknown
  ) => unknown;
  const saved = captured.handlers.scientificCitationSource as typeof read;
  expect(read(event, query)).toEqual({ kind: 'ready', entries: [] });
  expect(saved(event, source)).toEqual({ kind: 'unavailable' });
  expect(scientificCitations).toHaveBeenCalledExactlyOnceWith(query);
  expect(scientificCitationSource).toHaveBeenCalledExactlyOnceWith(source);
  const preview = captured.handlers.previewScientificCitation as typeof read;
  const pending = preview(event, query);
  owner = null;
  finish({ kind: 'ready' });
  await expect(pending).rejects.toMatchObject({
    code: 'INVENTORY_OWNER_UNAVAILABLE',
    stateChanged: false,
  });
});

it('routes source-free citation withdrawal with a current desktop caller guard', async () => {
  const applyScientificCitationWithdrawal = vi.fn(
    async (_request: unknown, _guard: () => void, _invocation: unknown) => ({ status: 'committed' })
  );
  owner = { ...owner, applyScientificCitationWithdrawal } as unknown as NativeInventoryOwner;
  const input = {
    project: 'project',
    inventoryId: 'inventory',
    operationId: 'withdraw-once',
    expectedRevision: 94,
    kind: 'withdraw-scientific-citation',
    expectedPlanDigest: `sha256:${'a'.repeat(64)}`,
    choices: {
      identity: { namespace: 'citations', withdrawalId: 'withdraw-once' },
      citationId: `scientific-citation:${'b'.repeat(64)}`,
      citationIntentSha256: `sha256:${'a'.repeat(64)}`,
      workId: `scientific-work:${'c'.repeat(64)}`,
      workIntentSha256: `sha256:${'a'.repeat(64)}`,
      reason: 'Correct supporting context',
    },
  };
  const apply = captured.handlers.applyScientificCitationWithdrawal as (
    event: IpcMainInvokeEvent,
    input: unknown
  ) => unknown;
  await apply(event, input);
  expect(applyScientificCitationWithdrawal).toHaveBeenCalledExactlyOnceWith(
    input,
    expect.any(Function),
    { actor: 'human:desktop:7' }
  );
  const guard = applyScientificCitationWithdrawal.mock.calls[0][1] as () => void;
  owner = null;
  expect(guard).toThrow('owner changed');
  await expect(
    apply(event, { ...input, scientificSource: { content: 'caller body' } })
  ).rejects.toThrow();
  expect(applyScientificCitationWithdrawal).toHaveBeenCalledTimes(1);
});

it('routes exact plate-plan reads and source-free saves through the current desktop owner', async () => {
  const previewPlatePlanVersion = vi.fn(() => ({ kind: 'no-change' }));
  const platePlanVersions = vi.fn(() => ({ kind: 'ready', versions: [] }));
  const platePlanVersion = vi.fn(() => ({ kind: 'unavailable' }));
  const previewPlatePlanBinding = vi.fn(() => ({ kind: 'blocked' }));
  const applyPlatePlanVersion = vi.fn(
    (_request: unknown, _guard: () => void, _invocation: unknown) => ({ status: 'committed' })
  );
  owner = {
    ...owner,
    previewPlatePlanVersion,
    platePlanVersions,
    platePlanVersion,
    previewPlatePlanBinding,
    applyPlatePlanVersion,
  } as unknown as NativeInventoryOwner;
  const input = { project: 'project', inventoryId: 'inventory' };
  for (const [method, spy] of [
    ['previewPlatePlanVersion', previewPlatePlanVersion],
    ['platePlanVersions', platePlanVersions],
    ['platePlanVersion', platePlanVersion],
    ['previewPlatePlanBinding', previewPlatePlanBinding],
  ] as const) {
    (captured.handlers[method] as (event: IpcMainInvokeEvent, input: unknown) => unknown)(
      event,
      input
    );
    expect(spy).toHaveBeenCalledExactlyOnceWith(input);
  }
  const request = {
    ...input,
    kind: 'save-plate-plan-version',
    operationId: 'same-plan-save',
    expectedRevision: 0,
    expectedPlanDigest: `sha256:${'a'.repeat(64)}`,
    choices: {
      identity: { namespace: 'plans', planId: 'plan' },
      reason: 'Reusable definition',
      definition: {
        schema: 'dnaforge.inventory-plate-plan-definition.v1',
        title: 'Plan',
        layout: { kind: 'fixed-well', rows: 1, columns: 1 },
        sourceSlots: [{ key: 'sample', label: 'Sample' }],
        transfers: [
          {
            actionId: 'aliquot',
            sourceSlotKey: 'sample',
            destinationPosition: 'A1',
            quantity: { value: '1', unit: 'uL' },
            label: 'Aliquot',
          },
        ],
      },
    },
  };
  const apply = captured.handlers.applyPlatePlanVersion as (
    event: IpcMainInvokeEvent,
    input: unknown
  ) => Promise<unknown>;
  await apply(event, request);
  expect(applyPlatePlanVersion).toHaveBeenCalledExactlyOnceWith(request, expect.any(Function), {
    actor: 'human:desktop:7',
  });
  const guard = applyPlatePlanVersion.mock.calls[0][1];
  owner = null;
  expect(guard).toThrow('owner changed');
  await expect(
    apply(event, { ...request, scientificSource: { content: 'caller witness' } })
  ).rejects.toThrow();
  expect(applyPlatePlanVersion).toHaveBeenCalledTimes(1);
});

it('routes saved Run attribution reads and fences its asynchronous desktop caller', async () => {
  const current = owner!;
  const runValueCandidates = vi.fn(async () => ({ kind: 'unavailable' }));
  const runValueAttributions = vi.fn(() => ({ kind: 'ready', entries: [] }));
  const applyRunValueAttribution = vi.fn(async () => ({ status: 'committed' }));
  Object.assign(current, { runValueCandidates, runValueAttributions, applyRunValueAttribution });
  const read = captured.handlers.runValueCandidates as (
    event: IpcMainInvokeEvent,
    input: unknown
  ) => Promise<unknown>;
  await expect(
    read(event, { project: 'project', inventoryId: 'inventory', runId: 'project::run' })
  ).resolves.toEqual({ kind: 'unavailable' });
  expect(runValueCandidates).toHaveBeenCalledOnce();
  let finish: (() => void) | undefined;
  runValueCandidates.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => (finish = resolve));
    return { kind: 'unavailable' };
  });
  const pending = read(event, {});
  owner = null;
  finish!();
  await expect(pending).rejects.toThrow('INVENTORY_OWNER_UNAVAILABLE');
  owner = current;
  expect(
    (
      captured.handlers.runValueAttributions as (
        event: IpcMainInvokeEvent,
        input: unknown
      ) => unknown
    )(event, {})
  ).toEqual({ kind: 'ready', entries: [] });
  expect(execute).not.toHaveBeenCalled();
});

it('routes full plate-plan observation reads and preserves the current caller on asynchronous reports', async () => {
  const platePlanObservations = vi.fn(() => ({ kind: 'ready', observations: [] }));
  const platePlanObservation = vi.fn(() => ({ kind: 'unavailable' }));
  const platePlanObservationSource = vi.fn(() => ({ kind: 'unavailable' }));
  const previewPlatePlanObservation = vi.fn(async () => ({ kind: 'blocked' }));
  const applyPlatePlanObservation = vi.fn(
    async (_request: unknown, _guard: () => void, _invocation: unknown) => ({ status: 'committed' })
  );
  owner = {
    ...owner,
    platePlanObservations,
    platePlanObservation,
    platePlanObservationSource,
    previewPlatePlanObservation,
    applyPlatePlanObservation,
  } as unknown as NativeInventoryOwner;
  const input = { project: 'project', inventoryId: 'inventory' };
  for (const [method, spy] of [
    ['platePlanObservations', platePlanObservations],
    ['platePlanObservation', platePlanObservation],
    ['platePlanObservationSource', platePlanObservationSource],
    ['previewPlatePlanObservation', previewPlatePlanObservation],
  ] as const) {
    await (captured.handlers[method] as (event: IpcMainInvokeEvent, input: unknown) => unknown)(
      event,
      input
    );
    expect(spy).toHaveBeenCalledExactlyOnceWith(input);
  }
  const digest = `sha256:${'a'.repeat(64)}`,
    request = {
      ...input,
      kind: 'record-plate-plan-observation',
      operationId: 'same-report',
      expectedRevision: 98,
      expectedPlanDigest: digest,
      choices: {
        identity: { namespace: 'manual', observationId: 'same-occurrence' },
        context: { kind: 'protocol-run', entityId: 'project::run', sourceSha256: digest },
        binding: {
          versionId: 'version',
          definitionSha256: digest,
          destinationPlateId: 'plate',
          sources: [{ sourceSlotKey: 'sample', stockId: 'stock' }],
        },
        reason: 'Reported completed full manual plan',
      },
    };
  const apply = captured.handlers.applyPlatePlanObservation as (
    event: IpcMainInvokeEvent,
    input: unknown
  ) => Promise<unknown>;
  await apply(event, request);
  expect(applyPlatePlanObservation).toHaveBeenCalledExactlyOnceWith(request, expect.any(Function), {
    actor: 'human:desktop:7',
  });
  const guard = applyPlatePlanObservation.mock.calls[0][1];
  owner = null;
  expect(guard).toThrow('owner changed');
  await expect(
    apply(event, { ...request, scientificSource: { content: 'caller witness' } })
  ).rejects.toThrow();
  expect(applyPlatePlanObservation).toHaveBeenCalledTimes(1);
});

it('routes production reads and exact accepted choices through the current native owner', async () => {
  const digest = 'sha256:' + 'a'.repeat(64),
    scope = { project: 'project', inventoryId: 'inventory' };
  const choices = {
    identity: { namespace: 'manual', productionId: 'once' },
    context: { kind: 'protocol-run', entityId: 'project::run', sourceSha256: digest },
    design: {
      scientificWorkspaceId: 'project',
      revision: {
        kind: 'accepted-object',
        resourceId: 'design',
        resourceRevisionId: 'rr_' + 'b'.repeat(64),
        workspaceVersionId: 'wv_' + 'c'.repeat(64),
        contentSha256: 'd'.repeat(64),
      },
    },
    inputs: [{ stockId: 'source', quantity: { value: '4', unit: 'uL' } }],
    output: { vesselId: 'output', quantity: { value: '3', unit: 'uL' }, lotName: 'Product' },
    method: 'Manual',
    reason: 'Completed report',
  };
  const requests = {
    scientificProductionDesigns: scope,
    previewScientificProduction: { ...scope, expectedRevision: 1, choices },
    scientificProductions: scope,
    scientificProduction: {
      ...scope,
      productionId: 'scientific-production:' + 'e'.repeat(64),
      intentSha256: digest,
    },
    scientificProductionSource: {
      ...scope,
      productionId: 'scientific-production:' + 'e'.repeat(64),
      intentSha256: digest,
    },
  };
  for (const [method, input] of Object.entries(requests)) {
    const native = vi.fn(async (_input: unknown) => ({ kind: 'unavailable' }));
    Object.assign(owner!, { [method]: native });
    await (
      captured.handlers[method] as (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>
    )(event, input);
    expect(native.mock.calls[0][0]).toEqual(input);
  }
  const apply = vi.fn(async (_input: unknown) => ({
    status: 'rejected',
    operationId: 'once',
    inventoryId: 'inventory',
    code: 'INVENTORY_SCIENTIFIC_PRODUCTION_NO_CHANGES',
  }));
  Object.assign(owner!, { applyScientificProduction: apply });
  const input = {
    ...scope,
    kind: 'record-scientific-production',
    operationId: 'once',
    expectedRevision: 1,
    choices,
    expectedPlanDigest: digest,
  };
  const result = await (
    captured.handlers.applyScientificProduction as (
      event: IpcMainInvokeEvent,
      input: unknown
    ) => Promise<unknown>
  )(event, input);
  expect(result).toMatchObject({ status: 'rejected', operationId: 'once' });
  expect(apply.mock.calls[0][0]).toEqual(input);
  await expect(
    (
      captured.handlers.applyScientificProduction as (
        event: IpcMainInvokeEvent,
        input: unknown
      ) => Promise<unknown>
    )(event, { ...input, acceptedDesign: { forged: true } })
  ).rejects.toThrow();
  expect(apply).toHaveBeenCalledTimes(1);
});
it('fences production preview authority before producing a new timed read', async () => {
  const produced = vi.fn();
  Object.assign(owner!, {
    previewScientificProduction: async (
      _input: unknown,
      invocation: { beforeScientificRead(): Promise<void> }
    ) => {
      await Promise.resolve();
      owner = null;
      await invocation.beforeScientificRead();
      produced();
      return { kind: 'unavailable' };
    },
  });
  await expect(
    (
      captured.handlers.previewScientificProduction as (
        event: IpcMainInvokeEvent,
        input: unknown
      ) => Promise<unknown>
    )(event, {})
  ).rejects.toThrow('INVENTORY_OWNER_UNAVAILABLE');
  expect(produced).not.toHaveBeenCalled();
});
it('routes incident purposes with exact choices and fences the current desktop caller', async () => {
  const digest = 'sha256:' + 'a'.repeat(64),
    scope = { project: 'project', inventoryId: 'inventory' };
  const choices = {
    identity: { namespace: 'manual', actionId: 'outage' },
    action: {
      kind: 'report',
      equipment: { storageId: 'freezer', configurationRevision: 0 },
      noticedAt: null,
      description: 'Outage',
      reason: 'Operator observation',
    },
  };
  const pin = { incidentId: 'equipment-incident-action:' + 'b'.repeat(64), intentSha256: digest };
  for (const [method, input] of Object.entries({
    previewEquipmentIncidentAction: { ...scope, expectedRevision: 103, choices },
    equipmentIncidents: scope,
    equipmentIncident: { ...scope, ...pin },
    equipmentIncidentSubjects: { ...scope, ...pin, view: 'review' },
    equipmentIncidentFacts: { ...scope, ...pin, query: { kind: 'page' } },
  })) {
    const native = vi.fn(async (_input: unknown) => ({ kind: 'unavailable' }));
    Object.assign(owner!, { [method]: native });
    await (
      captured.handlers[method] as (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>
    )(event, input);
    expect(native.mock.calls[0][0]).toEqual(input);
  }
  const native = vi.fn((_input: unknown, _guard: () => void) => ({
    status: 'rejected',
    operationId: 'once',
    inventoryId: 'inventory',
    code: 'INVENTORY_EQUIPMENT_INCIDENT_NO_CHANGES',
  }));
  Object.assign(owner!, { applyEquipmentIncidentAction: native });
  const input = {
    ...scope,
    kind: 'record-equipment-incident-action',
    operationId: 'once',
    expectedRevision: 103,
    choices,
    expectedPlanDigest: digest,
  };
  const apply = captured.handlers.applyEquipmentIncidentAction as (
    event: IpcMainInvokeEvent,
    input: unknown
  ) => Promise<unknown>;
  expect(await apply(event, input)).toMatchObject({ status: 'rejected', operationId: 'once' });
  expect(native.mock.calls[0][0]).toEqual(input);
  await expect(apply(event, { ...input, scientificSource: { forged: true } })).rejects.toThrow();
  expect(native).toHaveBeenCalledTimes(1);
  owner = null;
  expect(native.mock.calls[0][1]).toThrow('owner changed');
});
