import { describe, expect, it, vi } from 'vitest';
import { openRecentlyEditedItem } from './open-recently-edited';
import type { RecentlyEditedItem } from './recently-edited';

const item: RecentlyEditedItem = {
  id: 'page-1',
  title: 'Lab notes',
  workspaceRoot: '/managed/lab',
  workspaceName: 'Lab',
  updatedAt: 1000,
  open: { kind: 'entity', tabType: 'page', entityId: 'page-1' },
};

describe('openRecentlyEditedItem', () => {
  it('mounts a known recent workspace directly and opens the target after the mount commits', async () => {
    const order: string[] = [];
    const mountWorkspace = vi.fn(async () => {
      order.push('mount');
      return true;
    });
    const openTarget = vi.fn(async () => {
      order.push('target');
      return true;
    });

    await expect(
      openRecentlyEditedItem(item, {
        isWorkspaceMounted: () => false,
        mountWorkspace,
        openTarget,
      })
    ).resolves.toBe(true);

    expect(mountWorkspace).toHaveBeenCalledWith(
      { kind: 'local-folder', path: '/managed/lab' },
      { inPlace: true, telemetrySource: 'recent' }
    );
    expect(order).toEqual(['mount', 'target']);
  });

  it('does not open a target or navigate when its workspace cannot be mounted', async () => {
    const openTarget = vi.fn(async () => true);

    await expect(
      openRecentlyEditedItem(item, {
        isWorkspaceMounted: () => false,
        mountWorkspace: async () => false,
        openTarget,
      })
    ).resolves.toBe(false);

    expect(openTarget).not.toHaveBeenCalled();
  });

  it('uses the already-mounted workspace without running any mount work', async () => {
    const mountWorkspace = vi.fn(async () => true);

    await expect(
      openRecentlyEditedItem(item, {
        isWorkspaceMounted: () => true,
        mountWorkspace,
        openTarget: async () => true,
      })
    ).resolves.toBe(true);

    expect(mountWorkspace).not.toHaveBeenCalled();
  });
});
