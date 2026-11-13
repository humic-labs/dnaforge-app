import { beforeEach, expect, it, vi } from 'vitest';
import type {
  PrimerArtifactRevisionState,
  PrimerArtifactRevisionStateRequest,
} from '../shared/primer-artifact-revision';
import type { RendererDatabaseLifecycleSender } from './workspace-sync-database-fence';

type ReadHandler = (
  event: { sender: RendererDatabaseLifecycleSender },
  input: PrimerArtifactRevisionStateRequest
) => Promise<PrimerArtifactRevisionState>;
const handlers = vi.hoisted(() => new Map<string, ReadHandler>());
vi.mock('../shared/ipc-contract', () => ({
  handleGroup: (_contract: unknown, group: { readPrimerArtifactRevisionState: ReadHandler }) =>
    handlers.set('read', group.readPrimerArtifactRevisionState),
}));
vi.mock('./auth/session-store', () => ({ getActiveStoredSession: vi.fn() }));
vi.mock('./primer-artifact-mutations', () => ({
  publishPrimerArtifactRevision: vi.fn(),
  readPrimerArtifactRevisionStateInMain: vi.fn(),
  resumePrimerArtifactPublication: vi.fn(),
}));
import { registerPrimerArtifactIpcHandlers } from './primer-artifact-ipc';

const sender: RendererDatabaseLifecycleSender = {
  id: 42,
  once: vi.fn<RendererDatabaseLifecycleSender['once']>(),
  on: vi.fn<RendererDatabaseLifecycleSender['on']>(),
  removeListener: vi.fn<RendererDatabaseLifecycleSender['removeListener']>(),
};
const ports: { lease: Parameters<typeof registerPrimerArtifactIpcHandlers>[0] } = {
  lease: () => new Promise(() => {}),
};
const lease = vi.spyOn(ports, 'lease');
const read = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  handlers.clear();
  read.mockResolvedValue({ state: 'not_enrolled' });
});

it('reads an unenrolled primer without waiting behind unrelated project mutations', async () => {
  lease.mockReturnValue(new Promise(() => {}));
  registerPrimerArtifactIpcHandlers(ports.lease, read);
  const result = await Promise.race([
    handlers.get('read')!({ sender }, { entityId: 'saved-local-primer' }),
    new Promise((resolve) => setTimeout(() => resolve('queued behind mutation'), 100)),
  ]);
  expect(result).toEqual({ state: 'not_enrolled' });
  expect(lease).not.toHaveBeenCalled();
});

it('uses the guarded read context for an organization-enrolled primer', async () => {
  registerPrimerArtifactIpcHandlers(ports.lease, read);
  await handlers.get('read')!({ sender }, { entityId: 'registered-primer' });
  expect(read).toHaveBeenCalledWith(sender, expect.any(Function));
  expect(lease).not.toHaveBeenCalled();
});

it('keeps mutation-token reads on their existing project lease', async () => {
  lease.mockResolvedValue({ state: 'not_enrolled' });
  registerPrimerArtifactIpcHandlers(ports.lease, read);
  await handlers.get('read')!(
    { sender },
    { entityId: 'saved-local-primer', mutationToken: 'held-project-edit' }
  );
  expect(lease).toHaveBeenCalledWith(
    sender,
    { entityId: 'saved-local-primer' },
    expect.any(Function),
    'held-project-edit'
  );
});
