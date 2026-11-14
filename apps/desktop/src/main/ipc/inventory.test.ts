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
  owner = { execute, availability } as unknown as NativeInventoryOwner;
  registerInventoryHandlers({ owner: () => owner, target: () => target });
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
