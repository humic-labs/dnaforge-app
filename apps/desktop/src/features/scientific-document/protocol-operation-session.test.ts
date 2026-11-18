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
    editProtocolDeclarations: vi.fn(),
    recordRunValues: vi.fn(),
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

const valueAttempt = {
  kind: 'record-values' as const,
  request: {
    project: 'project',
    entityId: 'project::run',
    requestId: 'value-operation',
    expectedSourceSha256: `sha256:${'a'.repeat(64)}` as const,
    choices: {
      upserts: [
        {
          collection: 'measurements' as const,
          key: 'checked',
          label: 'Checked',
          value: { type: 'boolean' as const, value: false },
          origin: { kind: 'local-actual' as const },
        },
      ],
      reason: 'Record explicit false',
    },
  },
};
it('rereads the shared pending namespace before a competing typed save', async () => {
  const native = client(),
    saved = storage(),
    first = new ProtocolOperationSession(native, saved, 'shared'),
    second = new ProtocolOperationSession(native, saved, 'shared');
  native.recordRunValues.mockRejectedValueOnce(Error('Lost reply'));
  await first.begin(valueAttempt);
  const original = saved.getItem('shared');
  await second.begin({
    ...valueAttempt,
    request: { ...valueAttempt.request, requestId: 'competing-save' },
  });
  expect(second.getSnapshot()).toMatchObject({ phase: 'unknown', attempt: valueAttempt });
  expect(native.recordRunValues).toHaveBeenCalledOnce();
  expect(saved.getItem('shared')).toBe(original);
});
it('keeps an acknowledgement for another Run unknown with its exact original pending request', async () => {
  const native = client(),
    saved = storage(),
    session = new ProtocolOperationSession(native, saved, 'shared');
  native.recordRunValues.mockResolvedValueOnce({
    kind: 'ready',
    requestId: valueAttempt.request.requestId,
    package: { projectId: 'project', entityId: 'other-run' },
  });
  await session.begin(valueAttempt);
  expect(session.getSnapshot().phase).toBe('unknown');
  expect(JSON.parse(saved.getItem('shared')!).attempt).toEqual(valueAttempt);
});
it('shares a canonical entity owner and preserves an exact legacy-key pending save', async () => {
  const { sharedProtocolEntityOperation } = await import('./protocol-operation-session');
  const native = client(),
    saved = storage(),
    resource = {
      projectId: 'project',
      entityId: 'project::run',
      path: '/project/run/.forge/protocol-run.json',
    },
    legacy = `dnaforge.protocol.compat.v1:${JSON.stringify(['project', resource.path, 'save'])}`,
    old = {
      kind: 'save',
      request: {
        project: 'project',
        entityId: resource.entityId,
        requestId: 'old-save',
        expectedSourceSha256: `sha256:${'b'.repeat(64)}`,
        originalText: 'original legacy bytes',
      },
    };
  const bytes = JSON.stringify({ version: 1, attempt: old });
  saved.setItem(legacy, bytes);
  const first = sharedProtocolEntityOperation(native, saved, resource),
    same = sharedProtocolEntityOperation(native, saved, {
      ...resource,
      path: '/project/moved/.forge/protocol-run.json',
    });
  expect(same).toBe(first);
  first.refresh();
  await first.begin(valueAttempt);
  expect(first.getSnapshot()).toMatchObject({ phase: 'unknown', attempt: old });
  expect(native.recordRunValues).not.toHaveBeenCalled();
  expect(saved.getItem(legacy)).toBe(bytes);
});
