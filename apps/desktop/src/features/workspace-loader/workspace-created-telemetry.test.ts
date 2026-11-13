import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrackedEmptyWorkspace, trackWorkspaceCreated } from './workspace-created-telemetry';

const mocks = vi.hoisted(() => ({
  createEmptyWorkspace: vi.fn(),
  trackRendererEvent: vi.fn(),
}));

vi.mock('../../platform', () => ({
  platform: () => ({
    workspace: { createEmptyWorkspace: mocks.createEmptyWorkspace },
  }),
}));
vi.mock('../../lib/analytics', () => ({
  trackRendererEvent: mocks.trackRendererEvent,
}));

describe('workspace creation telemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createEmptyWorkspace.mockResolvedValue({
      rootPath: '/managed/new/repo',
      displayName: 'New workspace',
      createdAt: 1,
    });
  });

  it('records a user-triggered workspace only after it was created', async () => {
    const created = await createTrackedEmptyWorkspace({ name: 'New workspace' });

    expect(created.rootPath).toBe('/managed/new/repo');
    expect(mocks.trackRendererEvent).toHaveBeenCalledWith('workspace_created', {
      feature_area: 'workspace',
    });
  });

  it('does not record a creation when the platform write fails', async () => {
    mocks.createEmptyWorkspace.mockRejectedValueOnce(new Error('disk full'));

    await expect(createTrackedEmptyWorkspace({ name: 'New workspace' })).rejects.toThrow(
      'disk full'
    );
    expect(mocks.trackRendererEvent).not.toHaveBeenCalled();
  });

  it('never lets telemetry failure abort a created workspace', async () => {
    mocks.trackRendererEvent.mockImplementationOnce(() => {
      throw new Error('posthog failed');
    });

    await expect(createTrackedEmptyWorkspace({ name: 'New workspace' })).resolves.toMatchObject({
      rootPath: '/managed/new/repo',
    });
  });

  it('keeps the standalone tracker non-throwing for import-created workspaces', () => {
    mocks.trackRendererEvent.mockImplementationOnce(() => {
      throw new Error('posthog failed');
    });

    expect(() => trackWorkspaceCreated()).not.toThrow();
  });
});
