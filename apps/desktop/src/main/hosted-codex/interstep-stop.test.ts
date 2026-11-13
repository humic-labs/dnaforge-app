import { describe, expect, it, vi } from 'vitest';

import { terminalizeStoppedHostedWorkflow } from './interstep-stop';

const identity = {
  turnBindingToken: 'turn-binding-token-1',
  workflowId: 'workflow-1',
  runId: 'run-1',
  turnId: 'turn-1',
};

const provenance = {
  workflowRunId: '11111111-1111-4111-8111-111111111111',
  workflowStepId: '22222222-2222-4222-8222-222222222222',
  reservationIds: ['reservation-1'],
  usageEventIds: ['usage-1'],
  completedToolCallIds: ['tool-1'],
};

describe('terminalizeStoppedHostedWorkflow', () => {
  it('closes the exact settled workflow after a stopped inter-step turn', async () => {
    const cancel = vi.fn(async () => ({
      ok: true as const,
      receipt: {
        workflowRunId: provenance.workflowRunId,
        workflowStepId: provenance.workflowStepId,
        canaryLeaseId: '33333333-3333-4333-8333-333333333333',
        finalStatus: 'cancelled' as const,
        idempotent: false,
      },
    }));

    await expect(
      terminalizeStoppedHostedWorkflow({ identity, provenance, cancel })
    ).resolves.toEqual({
      attempted: true,
      result: expect.objectContaining({ ok: true }),
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith({
      ...identity,
      workflowRunId: provenance.workflowRunId,
      workflowStepId: provenance.workflowStepId,
    });
  });

  it('does nothing when no settled gateway step exists', async () => {
    const cancel = vi.fn();

    await expect(
      terminalizeStoppedHostedWorkflow({
        identity,
        provenance: { ...provenance, workflowRunId: null, workflowStepId: null },
        cancel,
      })
    ).resolves.toEqual({ attempted: false, result: null });
    expect(cancel).not.toHaveBeenCalled();
  });

  it('does not fabricate a mixed workflow identity', async () => {
    const cancel = vi.fn();

    await expect(
      terminalizeStoppedHostedWorkflow({
        identity,
        provenance: { ...provenance, workflowStepId: null },
        cancel,
      })
    ).resolves.toEqual({ attempted: false, result: null });
    expect(cancel).not.toHaveBeenCalled();
  });

  it.each([{ usageEventIds: [] }, { completedToolCallIds: [] }, { reservationIds: [] }])(
    'leaves stream cancellation to its owner for an admitted but unobserved step: %j',
    async (missing) => {
      const cancel = vi.fn();
      await expect(
        terminalizeStoppedHostedWorkflow({
          identity,
          provenance: { ...provenance, ...missing },
          cancel,
        })
      ).resolves.toEqual({ attempted: false, result: null });
      expect(cancel).not.toHaveBeenCalled();
    }
  );
});
