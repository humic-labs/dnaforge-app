// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deliverWorkspaceDisplay,
  registerWorkspaceDisplayParticipant,
  workspaceDisplayParticipantCount,
} from './workspace-display-participants';

const context = {
  workspaceRoot: '/Users/test/lab-workspace',
  operationId: 'workspace-reconcile:test',
  assertCurrent: () => undefined,
};

describe('workspace display participants', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  it('unregistering removes the participant so a later delivery reports zero', async () => {
    const unregister = registerWorkspaceDisplayParticipant(async () => undefined);
    expect(workspaceDisplayParticipantCount()).toBe(1);
    unregister();
    expect(workspaceDisplayParticipantCount()).toBe(0);
    await expect(deliverWorkspaceDisplay(context)).resolves.toEqual({
      participants: 0,
      errors: [],
    });
  });

  it('runs every participant even when one rejects and one throws synchronously', async () => {
    const healthy = vi.fn(async () => undefined);
    cleanups.push(
      registerWorkspaceDisplayParticipant(async () => {
        throw new Error('rejects');
      }),
      registerWorkspaceDisplayParticipant(() => {
        throw new Error('throws');
      }),
      registerWorkspaceDisplayParticipant(healthy)
    );
    const report = await deliverWorkspaceDisplay(context);
    expect(report.participants).toBe(3);
    expect(report.errors.map((error) => (error as Error).message).sort()).toEqual([
      'rejects',
      'throws',
    ]);
    expect(healthy).toHaveBeenCalledWith(context);
  });

  it('does not run a participant registered while a delivery is already in flight', async () => {
    const gate = Promise.withResolvers<void>();
    const late = vi.fn(async () => undefined);
    cleanups.push(registerWorkspaceDisplayParticipant(async () => gate.promise));
    const delivery = deliverWorkspaceDisplay(context);
    cleanups.push(registerWorkspaceDisplayParticipant(late));
    gate.resolve();
    await expect(delivery).resolves.toEqual({ participants: 1, errors: [] });
    expect(late).not.toHaveBeenCalled();
  });
});
