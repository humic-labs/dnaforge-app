import { beforeEach, expect, it, vi } from 'vitest';
import type { PrimerArtifactRevisionState } from '../shared/primer-artifact-revision';

const ports = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  lease: vi.fn(),
  read: vi.fn(),
  state: vi.fn(),
}));
vi.mock('../shared/ipc-contract', () => ({
  handleGroup: (_contract: unknown, handlers: Record<string, (...args: unknown[]) => unknown>) => {
    for (const [name, handler] of Object.entries(handlers)) ports.handlers.set(name, handler);
  },
}));
vi.mock('./auth/session-store', () => ({ getActiveStoredSession: vi.fn() }));
vi.mock('./primer-artifact-mutations', () => ({
  readPrimerArtifactRevisionStateInMain: ports.state,
  publishPrimerArtifactRevision: vi.fn(),
  resumePrimerArtifactPublication: vi.fn(),
}));
import { registerPrimerArtifactIpcHandlers } from './primer-artifact-ipc';

const pending = {
  state: 'pending',
  operationId: 'publication',
  entityId: 'registered-primer',
  workspaceId: 1,
  relativePath: 'Primers/saved.primer.json',
  name: 'Saved primer',
  artifactRevision: 1,
} satisfies PrimerArtifactRevisionState;
const sender = { id: 42 };
beforeEach(() => {
  vi.resetAllMocks();
  ports.handlers.clear();
});

it('reads registered revision state through the guarded read boundary while project edits cannot finish', async () => {
  ports.lease.mockReturnValue(new Promise(() => {}));
  ports.read.mockResolvedValue(pending);
  ports.state.mockResolvedValue(pending);
  registerPrimerArtifactIpcHandlers(ports.lease, ports.read);
  const result = await Promise.race([
    ports.handlers.get('readPrimerArtifactRevisionState')!(
      { sender },
      { entityId: 'registered-primer' }
    ),
    new Promise((resolve) => setTimeout(() => resolve('waiting for a project mutation'), 100)),
  ]);
  expect(result).toEqual(pending);
  expect(ports.lease).not.toHaveBeenCalled();
  expect(ports.read).toHaveBeenCalledWith(sender, expect.any(Function));
  const operation = ports.read.mock.calls[0][1];
  const database = Object.freeze({ fixture: 'read boundary' });
  const runDatabase = vi.fn();
  await operation(database, runDatabase);
  expect(ports.state).toHaveBeenCalledWith({
    db: database,
    runDatabase,
    getActiveAccountId: expect.any(Function),
    entityId: 'registered-primer',
  });
  expect(ports.lease).not.toHaveBeenCalled();
});

it('validates the primer identity before either native boundary is entered', async () => {
  registerPrimerArtifactIpcHandlers(ports.lease, ports.read);
  expect(() =>
    ports.handlers.get('readPrimerArtifactRevisionState')!({ sender }, { entityId: '' })
  ).toThrow('invalid');
  expect(ports.read).not.toHaveBeenCalled();
  expect(ports.lease).not.toHaveBeenCalled();
});
