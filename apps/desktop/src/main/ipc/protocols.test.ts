import { expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import type { NativeProtocolPackages } from '../native-protocol-packages';

const captured = vi.hoisted(() => ({
  handlers: {} as Record<string, (...args: unknown[]) => unknown>,
}));
vi.mock('../../shared/ipc-contract', () => ({
  handleGroup: (_contract: unknown, handlers: typeof captured.handlers) => {
    captured.handlers = handlers;
    return () => {};
  },
}));
import { registerProtocolHandlers } from './protocols';

it('keeps creation recovery on the original request and refuses a changed caller before commit', async () => {
  const frame = {};
  const target = { id: 7, mainFrame: frame, isDestroyed: () => false } as unknown as WebContents;
  const event = { sender: target, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  const createProtocol = vi.fn(
    async (_request: unknown, invocation: { assertCurrent(): void; actor: string }) => {
      invocation.assertCurrent();
      return { kind: 'pending', requestId: 'original' };
    }
  );
  const recoverCreation = vi.fn(
    async (_request: unknown, invocation: { assertCurrent(): void }) => {
      current = null;
      invocation.assertCurrent();
    }
  );
  const owner = { createProtocol, recoverCreation } as unknown as NativeProtocolPackages;
  let current: NativeProtocolPackages | null = owner;
  registerProtocolHandlers({ owner: () => current, target: () => target });
  const request = { project: 'project', requestId: 'original', title: 'Protocol' };
  expect(await captured.handlers.createProtocol(event, request)).toEqual({
    kind: 'pending',
    requestId: 'original',
  });
  expect(createProtocol.mock.calls[0][0]).toBe(request);
  expect(createProtocol.mock.calls[0][1].actor).toBe('human:desktop:7');
  expect(() => captured.handlers.createProtocol({ ...event, senderFrame: {} }, request)).toThrow(
    'PROTOCOL_DESKTOP_CALLER_CHANGED'
  );
  expect(createProtocol).toHaveBeenCalledTimes(1);
  await expect(
    captured.handlers.recoverCreation(event, { project: 'project', requestId: 'original' })
  ).rejects.toThrow('PROTOCOL_DESKTOP_CALLER_CHANGED');
});

it('rechecks the client before returning asynchronously read source bytes', async () => {
  const target = { id: 7, isDestroyed: () => false } as unknown as WebContents;
  const event = { sender: target } as IpcMainInvokeEvent;
  let current: NativeProtocolPackages | null;
  const readPackage = vi.fn(async () => {
    current = null;
    return { originalText: 'private saved source' };
  });
  current = { readPackage } as unknown as NativeProtocolPackages;
  registerProtocolHandlers({ owner: () => current, target: () => target });
  await expect(
    captured.handlers.readPackage(event, { project: 'project', entityId: 'project::protocol' })
  ).rejects.toThrow('PROTOCOL_DESKTOP_CALLER_CHANGED');
});
