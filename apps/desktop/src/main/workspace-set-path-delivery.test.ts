import { describe, expect, it, vi } from 'vitest';

import { WorkspaceSetPathDeliveryCoordinator } from './workspace-set-path-delivery';

interface TestTarget {
  id: number;
  isDestroyed(): boolean;
}

function createTarget(id = 7): TestTarget {
  return { id, isDestroyed: () => false };
}

describe('WorkspaceSetPathDeliveryCoordinator', () => {
  it('waits without a deadline until the renderer listener is ready', () => {
    const deliver = vi.fn();
    const coordinator = new WorkspaceSetPathDeliveryCoordinator<TestTarget>(
      deliver,
      () => 'delivery-a'
    );
    const target = createTarget();

    coordinator.queue(target, '/workspace');
    expect(deliver).not.toHaveBeenCalled();

    coordinator.markReady(target);
    expect(deliver).toHaveBeenCalledWith(target, {
      workspacePath: '/workspace',
      deliveryId: 'delivery-a',
    });
  });

  it('delivers immediately when readiness arrives before the startup workspace', () => {
    const deliver = vi.fn();
    const coordinator = new WorkspaceSetPathDeliveryCoordinator<TestTarget>(
      deliver,
      () => 'delivery-a'
    );
    const target = createTarget();

    coordinator.markReady(target);
    coordinator.queue(target, '/workspace', 'managed_sync');

    expect(deliver).toHaveBeenCalledWith(target, {
      workspacePath: '/workspace',
      deliveryId: 'delivery-a',
      telemetryContext: 'managed_sync',
    });
  });

  it('replays the same delivery after a renderer reload', () => {
    const deliver = vi.fn();
    const coordinator = new WorkspaceSetPathDeliveryCoordinator<TestTarget>(
      deliver,
      () => 'delivery-a'
    );
    const target = createTarget();

    coordinator.queue(target, '/workspace');
    coordinator.markReady(target);
    coordinator.markLoading(target.id);
    coordinator.markReady(target);

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls[0]?.[1]).toEqual(deliver.mock.calls[1]?.[1]);
  });

  it('forgets closed targets and ignores destroyed renderers', () => {
    const deliver = vi.fn();
    const coordinator = new WorkspaceSetPathDeliveryCoordinator<TestTarget>(
      deliver,
      () => 'delivery-a'
    );
    const target = createTarget();

    coordinator.queue(target, '/workspace');
    coordinator.remove(target.id);
    coordinator.markReady(target);
    coordinator.markReady({ id: 8, isDestroyed: () => true });

    expect(deliver).not.toHaveBeenCalled();
  });
});
