import { expect, it, vi } from 'vitest';
import type { NativeProtocolClient } from '../../shared/protocol-packages';
import { ProtocolOperationSession } from './protocol-operation-session';
function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}
function client() {
  return {
    createProtocol: vi.fn(),
    startRun: vi.fn(),
    savePackage: vi.fn(),
    inspectCreation: vi.fn(),
    recoverCreation: vi.fn(),
    readPackage: vi.fn(),
    readSavedProtocol: vi.fn(),
    listPackages: vi.fn(),
  } satisfies NativeProtocolClient;
}
const attempt = {
  kind: 'create' as const,
  request: { project: 'project', requestId: 'stable-request', title: 'Protocol' },
};
it('retains the same scientific creation request across missing acknowledgement and reopened client', async () => {
  const native = client(),
    saved = storage();
  native.createProtocol.mockRejectedValueOnce(Error('lost reply'));
  const first = new ProtocolOperationSession(native, saved, 'key');
  await first.begin(attempt);
  expect(first.getSnapshot().phase).toBe('unknown');
  const reopened = new ProtocolOperationSession(native, saved, 'key');
  native.createProtocol.mockResolvedValueOnce({
    kind: 'pending',
    requestId: 'stable-request',
    entityId: 'project::protocol',
    path: '/project/protocol/.forge/protocol.json',
    message: 'File published; catalog update pending',
  });
  await reopened.retry();
  expect(native.createProtocol).toHaveBeenNthCalledWith(2, attempt.request);
  expect(reopened.getSnapshot()).toMatchObject({ phase: 'result', result: { kind: 'pending' } });
  native.inspectCreation.mockResolvedValueOnce({ kind: 'missing', requestId: 'stable-request' });
  await reopened.inspect();
  expect(native.inspectCreation).toHaveBeenCalledWith({
    project: 'project',
    requestId: 'stable-request',
  });
  expect(new ProtocolOperationSession(native, saved, 'key').getSnapshot().phase).toBe('unknown');
});
it('never sends creation when its exact request cannot be persisted', async () => {
  const native = client(),
    session = new ProtocolOperationSession(
      native,
      {
        getItem: () => null,
        setItem: () => {
          throw Error('quota');
        },
      },
      'key'
    );
  await session.begin(attempt);
  expect(native.createProtocol).not.toHaveBeenCalled();
  expect(session.getSnapshot().phase).toBe('failed');
});
