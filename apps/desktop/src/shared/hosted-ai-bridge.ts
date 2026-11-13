import type {
  HostedAiContributionGateRequest,
  HostedAiContributionGateResult,
  HostedAiNativeToolCancelResult,
  HostedAiNativeToolRequest,
  HostedAiNativeToolResult,
  HostedAiRouteAvailabilityResult,
  HostedAiStreamCancelResult,
  HostedAiStreamEventEnvelope,
  HostedAiStreamStartRequest,
  HostedAiStreamStartResult,
  HostedAiToolClaimCancelRequest,
  HostedAiToolClaimCompleteRequest,
  HostedAiToolClaimRequest,
  HostedAiToolClaimResult,
  HostedAiToolObservationRequest,
  HostedAiToolObservationResult,
  HostedAiTurnBindingReleaseResult,
  HostedAiTurnBindingRequest,
  HostedAiTurnBindingResult,
  HostedAiWorkflowAuthorityResult,
  HostedAiWorkflowTerminalRequest,
  HostedAiWorkflowTerminalResult,
} from './hosted-ai-gateway-ipc';
import type {
  HostedCodexContributionRequest,
  HostedCodexContributionResult,
  HostedCodexPreparedTurnCancelRequest,
  HostedCodexPreparedTurnCancelResult,
  HostedCodexTurnEvent,
  HostedCodexTurnResult,
  HostedCodexTurnStartRequest,
  HostedCodexTurnStopRequest,
  HostedCodexTurnStopResult,
} from './hosted-codex-ipc';

export interface HostedAiBridge {
  prepareContribution(
    request: HostedAiContributionGateRequest
  ): Promise<HostedAiContributionGateResult>;
  validateTurnBinding(request: HostedAiTurnBindingRequest): Promise<HostedAiTurnBindingResult>;
  releaseTurnBinding(
    request: HostedAiTurnBindingRequest
  ): Promise<HostedAiTurnBindingReleaseResult>;
  startStream(request: HostedAiStreamStartRequest): Promise<HostedAiStreamStartResult>;
  cancelStream(clientRequestId: string): Promise<HostedAiStreamCancelResult>;
  onStreamEvent(callback: (envelope: HostedAiStreamEventEnvelope) => void): () => void;
  recordToolObservation(
    request: HostedAiToolObservationRequest
  ): Promise<HostedAiToolObservationResult>;
  claimTool(request: HostedAiToolClaimRequest): Promise<HostedAiToolClaimResult>;
  completeToolClaim(request: HostedAiToolClaimCompleteRequest): Promise<HostedAiToolClaimResult>;
  cancelToolClaim(request: HostedAiToolClaimCancelRequest): Promise<HostedAiToolClaimResult>;
  cancelWorkflow(request: HostedAiWorkflowTerminalRequest): Promise<HostedAiWorkflowTerminalResult>;
  executeNativeTool(request: HostedAiNativeToolRequest): Promise<HostedAiNativeToolResult>;
  cancelNativeTool(operationId: string): Promise<HostedAiNativeToolCancelResult>;
  getWorkflowAuthority(): Promise<HostedAiWorkflowAuthorityResult>;
  getRouteAvailability(): Promise<HostedAiRouteAvailabilityResult>;
}

export interface HostedCodexBridge {
  prepareContribution(
    request: HostedCodexContributionRequest
  ): Promise<HostedCodexContributionResult>;
  cancelPreparedTurn(
    request: HostedCodexPreparedTurnCancelRequest
  ): Promise<HostedCodexPreparedTurnCancelResult>;
  startTurn(request: HostedCodexTurnStartRequest): Promise<HostedCodexTurnResult>;
  stopTurn(request: HostedCodexTurnStopRequest): Promise<HostedCodexTurnStopResult>;
  onTurnEvent(callback: (event: HostedCodexTurnEvent) => void): () => void;
}
