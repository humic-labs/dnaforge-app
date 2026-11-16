import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { beforeEach, expect, it, vi } from 'vitest';
import type {
  InventoryExecuteRequest,
  NativeInventoryExecution,
} from '../../shared/inventory-command';
import type { NativeInventoryOwner } from '../inventory-owner';
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
  previewStocktake = vi.fn(() => ({ kind: 'ready', target: { revision: 0 } }));
  applyStocktake = vi.fn(() => ({ status: 'committed' }));
  previewSourceRevision = vi.fn(() => ({ kind: 'ready', target: { revision: 0 } }));
  acknowledgeSource = vi.fn(() => ({ status: 'committed' }));
  owner = {
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
    applyStocktake,
    previewSourceRevision,
    acknowledgeSource,
  } as unknown as NativeInventoryOwner;
  registerInventoryHandlers({ owner: () => owner, target: () => target });
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
