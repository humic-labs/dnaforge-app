import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  WorkspaceSyncReplicaDeliveryAck,
  WorkspaceSyncReplicaLifecycleEvent,
} from '../shared/workspace-sync-ipc';
import { WorkspaceSyncReplicaPublisher } from './workspace-sync-replica-publisher';
import type { WorkspaceSyncReplicaPublisherDeps } from './workspace-sync-replica-publisher';
import {
  MAX_WORKSPACE_MUTATION_TOKENS_PER_OWNER,
  workspaceMutationCapabilities,
} from './ipc/workspace-mutation-capability';

const PREPARING_NOTICE = {
  workspaceUuid: 'workspace-a',
  workspaceRoot: '/managed/workspace-a',
  remoteVersionId: 'version-b',
  affectedNotebookIds: ['notebook-a'],
  affectedDesignIds: [],
};

const APPLIED_NOTICE = {
  ...PREPARING_NOTICE,
  changedPaths: ['/managed/workspace-a/design.gb'],
  deletedPaths: ['/managed/workspace-a/deleted.gb'],
  affectedNotebookIds: ['notebook-a'],
  affectedDesignIds: [],
  deletedDesignIds: [],
};

afterEach(() => {
  vi.useRealTimers();
  workspaceMutationCapabilities.releaseOwner(7);
});

describe('WorkspaceSyncReplicaPublisher', () => {
  it('requires exact sender, delivery, phase, and success for both lifecycle acknowledgements', async () => {
    let ack: ((senderId: number, value: unknown) => void) | null = null;
    const sent: WorkspaceSyncReplicaLifecycleEvent[] = [];
    const publisher = new WorkspaceSyncReplicaPublisher({
      getTarget: () => ({ id: 7, isDestroyed: () => false }),
      send: (_target, event) => sent.push(event),
      subscribeAck: (listener) => {
        ack = listener;
        return () => {};
      },
      createDeliveryId: () => 'delivery-a',
    });

    let prepared = false;
    const preparing = publisher.prepare(PREPARING_NOTICE).then((value) => {
      prepared = true;
      return value;
    });
    await Promise.resolve();
    expect(sent[0]).toEqual({ deliveryId: 'delivery-a', phase: 'preparing', ...PREPARING_NOTICE });

    invokeAck(ack, 99, replicaAck('preparing'));
    invokeAck(ack, 7, { ...replicaAck('preparing'), deliveryId: 'forged' });
    invokeAck(ack, 7, replicaAck('applied'));
    await Promise.resolve();
    expect(prepared).toBe(false);

    invokeAck(ack, 7, replicaAck('preparing'));
    const preparationId = await preparing;
    expect(preparationId).toBe('delivery-a');

    const publishing = publisher.publish(preparationId, APPLIED_NOTICE);
    await Promise.resolve();
    expect(sent[1]).toEqual({
      deliveryId: 'delivery-a',
      phase: 'applied',
      mutationToken: expect.any(String),
      ...APPLIED_NOTICE,
    });
    invokeAck(ack, 7, replicaAck('preparing'));
    await Promise.resolve();
    let applied = false;
    void publishing.then(() => {
      applied = true;
    });
    await Promise.resolve();
    expect(applied).toBe(false);
    invokeAck(ack, 7, replicaAck('applied'));
    await expect(publishing).resolves.toBeUndefined();
    expect(workspaceMutationCapabilities.activeCountForTest(7)).toBe(0);
  });

  it('rejects and aborts preparation when the renderer misses the bounded acknowledgement', async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const sent: WorkspaceSyncReplicaLifecycleEvent[] = [];
    const publisher = new WorkspaceSyncReplicaPublisher({
      getTarget: () => ({ id: 7, isDestroyed: () => false }),
      send: (_target, event) => sent.push(event),
      subscribeAck: () => () => {},
      timeoutMs: 25,
      createDeliveryId: () => 'delivery-timeout',
      warn,
    });

    const preparing = publisher.prepare(PREPARING_NOTICE);
    const rejection = expect(preparing).rejects.toThrow('did not acknowledge');
    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(sent.map((event) => event.phase)).toEqual(['preparing', 'aborted']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('within 25ms'));
  });

  it('rejects an explicit renderer failure instead of acknowledging it in finally', async () => {
    let ack: ((senderId: number, value: unknown) => void) | null = null;
    const publisher = new WorkspaceSyncReplicaPublisher({
      getTarget: () => ({ id: 7, isDestroyed: () => false }),
      send: vi.fn(),
      subscribeAck: (listener) => {
        ack = listener;
        return () => {};
      },
      createDeliveryId: () => 'delivery-failed',
    });

    const preparing = publisher.prepare(PREPARING_NOTICE);
    await Promise.resolve();
    invokeAck(ack, 7, {
      deliveryId: 'delivery-failed',
      phase: 'preparing',
      status: 'failed',
      error: 'dirty editor',
    });
    await expect(preparing).rejects.toThrow('dirty editor');
  });

  it('does not wait without a renderer and rejects send failures safely', async () => {
    const subscribeAck = vi.fn(() => () => {});
    const noTarget = new WorkspaceSyncReplicaPublisher({
      getTarget: () => null,
      send: vi.fn(),
      subscribeAck,
    });
    await expect(noTarget.prepare(PREPARING_NOTICE)).resolves.toBeNull();
    await expect(noTarget.publish(null, APPLIED_NOTICE)).rejects.toThrow(/no prepared renderer/i);
    expect(subscribeAck).not.toHaveBeenCalled();

    const warn = vi.fn();
    const sendFailure = new WorkspaceSyncReplicaPublisher({
      getTarget: () => ({ id: 7, isDestroyed: () => false }),
      send: () => {
        throw new Error('renderer exited');
      },
      subscribeAck: () => () => {},
      createDeliveryId: () => 'delivery-send-failure',
      warn,
    });
    await expect(sendFailure.prepare(PREPARING_NOTICE)).rejects.toThrow('renderer exited');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('renderer exited'));
  });

  it('sends an abort that releases the freeze when applied hydration times out', async () => {
    vi.useFakeTimers();
    let ack: ((senderId: number, value: unknown) => void) | null = null;
    const sent: WorkspaceSyncReplicaLifecycleEvent[] = [];
    const reloadTarget = vi.fn();
    const publisher = new WorkspaceSyncReplicaPublisher({
      getTarget: () => ({ id: 7, isDestroyed: () => false }),
      send: (_target, event) => sent.push(event),
      subscribeAck: (listener) => {
        ack = listener;
        return () => {};
      },
      timeoutMs: 25,
      createDeliveryId: () => 'delivery-applied-timeout',
      reloadTarget,
    });

    const preparing = publisher.prepare(PREPARING_NOTICE);
    await Promise.resolve();
    invokeAck(ack, 7, {
      deliveryId: 'delivery-applied-timeout',
      phase: 'preparing',
      status: 'ok',
    });
    const preparationId = await preparing;
    const publishing = publisher.publish(preparationId, APPLIED_NOTICE);
    const rejection = expect(publishing).rejects.toThrow('did not acknowledge');
    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(sent.map((event) => event.phase)).toEqual(['preparing', 'applied', 'aborted']);
    expect(reloadTarget).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }));
  });

  it('aborts a prepared renderer when capability admission fails and permits a later replay', async () => {
    let ack: ((senderId: number, value: unknown) => void) | null = null;
    const sent: WorkspaceSyncReplicaLifecycleEvent[] = [];
    let delivery = 0;
    const publisher = new WorkspaceSyncReplicaPublisher({
      getTarget: () => ({ id: 7, isDestroyed: () => false }),
      send: (_target, event) => sent.push(event),
      subscribeAck: (listener) => {
        ack = listener;
        return () => {};
      },
      createDeliveryId: () => `delivery-cap-${(delivery += 1)}`,
    });
    for (let index = 0; index < MAX_WORKSPACE_MUTATION_TOKENS_PER_OWNER; index += 1) {
      workspaceMutationCapabilities.issue(7, `/managed/filler-${index}`, () => undefined);
    }

    const firstPreparation = publisher.prepare(PREPARING_NOTICE);
    await Promise.resolve();
    invokeAck(ack, 7, {
      deliveryId: 'delivery-cap-1',
      phase: 'preparing',
      status: 'ok',
    });
    const firstPreparationId = await firstPreparation;
    await expect(publisher.publish(firstPreparationId, APPLIED_NOTICE)).rejects.toThrow(
      'WORKSPACE_MUTATION_OWNER_TOKEN_LIMIT'
    );
    expect(sent.map((event) => event.phase)).toEqual(['preparing', 'aborted']);

    workspaceMutationCapabilities.releaseOwner(7);
    const replayPreparation = publisher.prepare(PREPARING_NOTICE);
    await Promise.resolve();
    invokeAck(ack, 7, {
      deliveryId: 'delivery-cap-2',
      phase: 'preparing',
      status: 'ok',
    });
    const replayPreparationId = await replayPreparation;
    const replay = publisher.publish(replayPreparationId, APPLIED_NOTICE);
    await Promise.resolve();
    invokeAck(ack, 7, {
      deliveryId: 'delivery-cap-2',
      phase: 'applied',
      status: 'ok',
    });
    await expect(replay).resolves.toBeUndefined();
    expect(sent.map((event) => event.phase)).toEqual([
      'preparing',
      'aborted',
      'preparing',
      'applied',
    ]);
  });

  it('allows healthy applied hydration to exceed the short preparation deadline', async () => {
    vi.useFakeTimers();
    let ack: ((senderId: number, value: unknown) => void) | null = null;
    const publisher = new WorkspaceSyncReplicaPublisher({
      getTarget: () => ({ id: 7, isDestroyed: () => false }),
      send: vi.fn(),
      subscribeAck: (listener) => {
        ack = listener;
        return () => {};
      },
      createDeliveryId: () => 'delivery-slow-applied',
    });

    const preparing = publisher.prepare(PREPARING_NOTICE);
    await Promise.resolve();
    invokeAck(ack, 7, {
      deliveryId: 'delivery-slow-applied',
      phase: 'preparing',
      status: 'ok',
    });
    const preparationId = await preparing;
    let settled = false;
    const publishing = publisher.publish(preparationId, APPLIED_NOTICE).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(5_001);
    expect(settled).toBe(false);
    invokeAck(ack, 7, {
      deliveryId: 'delivery-slow-applied',
      phase: 'applied',
      status: 'ok',
    });
    await expect(publishing).resolves.toBeUndefined();
  });

  it('rejects a pending applied acknowledgement immediately and stays closed on shutdown', async () => {
    let ack: ((senderId: number, value: unknown) => void) | null = null;
    const publisher = new WorkspaceSyncReplicaPublisher({
      getTarget: () => ({ id: 7, isDestroyed: () => false }),
      send: vi.fn(),
      subscribeAck: (listener) => {
        ack = listener;
        return () => {};
      },
      createDeliveryId: () => 'delivery-shutdown',
      appliedTimeoutMs: 60_000,
    });

    const preparing = publisher.prepare(PREPARING_NOTICE);
    await Promise.resolve();
    invokeAck(ack, 7, {
      deliveryId: 'delivery-shutdown',
      phase: 'preparing',
      status: 'ok',
    });
    const preparationId = await preparing;
    const publishing = publisher.publish(preparationId, APPLIED_NOTICE);
    await Promise.resolve();

    publisher.stop();

    await expect(publishing).rejects.toThrow(/publisher stopped/i);
    await expect(publisher.prepare(PREPARING_NOTICE)).rejects.toThrow(/publisher stopped/i);
  });
});

function replicaAck(
  phase: WorkspaceSyncReplicaDeliveryAck['phase']
): WorkspaceSyncReplicaDeliveryAck {
  return { deliveryId: 'delivery-a', phase, status: 'ok' };
}

type ReplicaAckListener = Parameters<WorkspaceSyncReplicaPublisherDeps['subscribeAck']>[0];

function invokeAck(listener: ReplicaAckListener | null, senderId: number, value: unknown): void {
  if (!listener) throw new Error('Expected replica acknowledgement listener to be subscribed.');
  listener(senderId, value);
}
