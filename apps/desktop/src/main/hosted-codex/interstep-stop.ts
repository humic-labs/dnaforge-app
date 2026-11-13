import type {
  HostedAiWorkflowTerminalRequest,
  HostedAiWorkflowTerminalResult,
} from '../../shared/hosted-ai-gateway-ipc';

type StoppedWorkflowIdentity = Pick<
  HostedAiWorkflowTerminalRequest,
  'turnBindingToken' | 'workflowId' | 'runId' | 'turnId'
>;

interface StoppedWorkflowProvenance {
  readonly workflowRunId: string | null;
  readonly workflowStepId: string | null;
  readonly reservationIds: readonly string[];
  readonly usageEventIds: readonly string[];
  readonly completedToolCallIds: readonly string[];
}

export interface StoppedWorkflowTerminalization {
  readonly attempted: boolean;
  readonly result: HostedAiWorkflowTerminalResult | null;
}

export async function terminalizeStoppedHostedWorkflow(options: {
  readonly identity: StoppedWorkflowIdentity;
  readonly provenance: StoppedWorkflowProvenance;
  readonly cancel: (
    request: HostedAiWorkflowTerminalRequest
  ) => Promise<HostedAiWorkflowTerminalResult>;
}): Promise<StoppedWorkflowTerminalization> {
  const { workflowRunId, workflowStepId } = options.provenance;
  if (
    !workflowRunId ||
    !workflowStepId ||
    options.provenance.reservationIds.length === 0 ||
    options.provenance.usageEventIds.length !== options.provenance.reservationIds.length ||
    options.provenance.completedToolCallIds.length === 0
  ) {
    return { attempted: false, result: null };
  }
  return {
    attempted: true,
    result: await options.cancel({
      ...options.identity,
      workflowRunId,
      workflowStepId,
    }),
  };
}
