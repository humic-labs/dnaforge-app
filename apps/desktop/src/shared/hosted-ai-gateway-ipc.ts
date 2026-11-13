import type {
  ContributionPolicy,
  ContributionReceipt,
  HostedGenerateRequest,
  HostedResponsesRequest,
  HostedStreamEvent,
} from '@waypoint/hosted-ai-contract';

export type HostedAiTier = 'auto' | 'deep';

interface HostedAiStreamStartRequestBase {
  readonly clientRequestId: string;
  readonly idempotencyKey: string;
  readonly turnBindingToken: string;
}

export type HostedAiStreamStartRequest =
  | (HostedAiStreamStartRequestBase & {
      readonly route?: 'generate';
      readonly request: HostedGenerateRequest;
    })
  | (HostedAiStreamStartRequestBase & {
      readonly route: 'responses';
      readonly request: HostedResponsesRequest;
    });

export type HostedAiStreamStartResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code:
        | 'not_configured'
        | 'signed_out'
        | 'invalid_request'
        | 'request_too_large'
        | 'gateway_paused'
        | 'allowance_exhausted'
        | 'rate_limited'
        | 'provider_exposure_reconciliation_required'
        | 'allowance_or_policy_rejected'
        | 'gateway_unavailable';
      readonly message: string;
      readonly retryAfterSeconds?: number;
    };

export type HostedAiStreamEventEnvelope =
  | {
      readonly clientRequestId: string;
      readonly kind: 'event';
      readonly event: HostedStreamEvent;
    }
  | {
      readonly clientRequestId: string;
      readonly kind: 'transport_error';
      readonly message: string;
    };

export interface HostedAiStreamCancelResult {
  readonly ok: boolean;
}

export type HostedContributionRefusalCode =
  | 'legal_acceptance_missing'
  | 'contribution_policy_stale'
  | 'contribution_choice_rejected';

export type HostedAiContributionGateRequest =
  | {
      readonly surface: 'first_hosted_attempt';
      readonly workflowId: string;
      readonly runId: string;
      readonly turnId: string;
      readonly workspacePath: string | null;
    }
  | { readonly surface: 'settings'; readonly choice?: 'joined' | 'withdrawn' };

export type HostedAiContributionGateResult =
  | {
      readonly ok: true;
      readonly started: boolean;
      readonly policy: ContributionPolicy;
      readonly receipt: ContributionReceipt | null;
      readonly turnBindingToken: string | null;
    }
  | {
      readonly ok: false;
      readonly code:
        | 'not_configured'
        | 'signed_out'
        | 'invalid_request'
        | 'gateway_unavailable'
        | HostedContributionRefusalCode;
      readonly message: string;
    };

export interface HostedAiTurnBindingRequest {
  readonly turnBindingToken: string;
  readonly workflowId: string;
  readonly runId: string;
  readonly turnId: string;
}

export type HostedAiTurnBindingResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: 'signed_out' | 'invalid_request';
      readonly message: string;
    };
export interface HostedAiTurnBindingReleaseResult {
  readonly ok: boolean;
}

export interface HostedAiNativeToolRequest extends HostedAiTurnBindingRequest {
  readonly operationId: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly shellSupervision: import('./agent-runtime-ipc').AgentShellSupervision;
  readonly permissions?: import('./agent-permissions').ResolvedAgentPermissions;
}

export type HostedAiNativeToolResult =
  | {
      readonly ok: true;
      readonly output: unknown;
      readonly effectReceiptRef: string;
    }
  | {
      readonly ok: false;
      readonly code: 'invalid_request' | 'signed_out' | 'user_declined' | 'stopped' | 'tool_failed';
      readonly message: string;
    };

export interface HostedAiNativeToolCancelResult {
  readonly ok: boolean;
}

export interface HostedAiGenerationRequest {
  readonly workflowId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly tier: HostedAiTier;
  readonly input: string;
  readonly maxOutputTokens: number;
  readonly tracePayload: Record<string, unknown>;
  readonly routePinScope?: 'turn' | 'workflow';
}

export interface HostedAiAgentModelStepRequest extends HostedAiGenerationRequest {
  readonly agentWorkflowRunId?: string;
  readonly agentStepSequence: number;
}

export interface HostedAiWorkflowTraceStep {
  readonly workflowRunId: string;
  readonly workflowStepId: string;
}

export interface HostedAiAgentToolTicket {
  readonly token: string;
  readonly expiresAt: string;
  readonly providerCallId: string;
  readonly toolName: string;
  readonly argumentsPayload: Record<string, unknown>;
  readonly requiresUserApproval: boolean;
}

export interface HostedAiAgentToolObservationRequest {
  readonly ticket: string;
  readonly argumentsPayload: Record<string, unknown>;
  readonly observationPayload: Record<string, unknown>;
}

export interface HostedAiToolObservationRequest extends HostedAiTurnBindingRequest {
  readonly ticket: string;
  readonly claimId?: string;
  readonly argumentsPayload: Record<string, unknown>;
  readonly observationPayload: Record<string, unknown>;
}

export interface HostedAiToolObservationReceipt {
  readonly ticketId: string;
  readonly workflowRunId: string;
  readonly workflowStepId: string;
  readonly providerCallId: string;
  readonly toolName: string;
}

export interface HostedAiAgentWorkflowFinalizationRequest extends HostedAiWorkflowTraceStep {
  readonly terminalOutput: string;
}

export interface HostedAiWorkflowAuthority {
  readonly accountPlanSetting: 'never_corpus' | 'private_ai' | 'research_contribution';
  readonly researchContributionEligible: boolean;
  readonly showResearchContributionNotice: boolean;
  readonly termsUrl: string;
  readonly privacyUrl: string;
}

export interface HostedAiRawTraceDeletionReceipt {
  readonly deletionRequestId: string;
  readonly desktopSessionId: string;
  readonly requestedAt: string;
  readonly deleteBy: string;
  readonly idempotent: boolean;
}

export interface ResearchContributionNotice {
  readonly showNotice: true;
  readonly noticeText: 'DNAForge AI is offered in accordance with our Terms of Service and Privacy Policy.';
  readonly termsUrl: string;
  readonly privacyUrl: string;
}

export type HostedAiGenerationResult =
  | {
      readonly ok: true;
      readonly providerResponse: unknown;
      readonly researchContributionNotice: ResearchContributionNotice | null;
    }
  | {
      readonly ok: false;
      readonly code:
        | 'not_configured'
        | 'signed_out'
        | 'invalid_request'
        | 'gateway_paused'
        | 'allowance_exhausted'
        | 'rate_limited'
        | 'allowance_or_policy_rejected'
        | 'gateway_unavailable';
      readonly message: string;
      readonly retryAfterSeconds?: number;
    };

export type HostedAiAgentModelStepResult =
  | {
      readonly ok: true;
      readonly providerResponse: unknown;
      readonly workflowTrace: HostedAiWorkflowTraceStep | null;
      readonly toolTickets: readonly HostedAiAgentToolTicket[];
      readonly researchContributionNotice: ResearchContributionNotice | null;
    }
  | Extract<HostedAiGenerationResult, { ok: false }>;

export type HostedAiAgentWorkflowFinalizationResult =
  | { readonly ok: true }
  | Extract<HostedAiGenerationResult, { ok: false }>;

export type HostedAiPendingToolObservationsResult = {
  readonly ok: true;
  readonly pendingToolObservations: true;
  readonly workflowTrace: HostedAiWorkflowTraceStep;
  readonly pendingTicketCount: number;
};

export type HostedAiAgentToolObservationResult =
  | HostedAiAgentModelStepResult
  | HostedAiPendingToolObservationsResult;

export type HostedAiToolObservationResult =
  | { readonly ok: true; readonly receipt: HostedAiToolObservationReceipt }
  | Extract<HostedAiGenerationResult, { ok: false }>;

export type HostedAiToolClaimStatus = 'claimed' | 'completed' | 'canceled' | 'expired';

export interface HostedAiToolClaim {
  readonly claimId: string;
  readonly status: HostedAiToolClaimStatus;
  readonly toolTicketId: string;
  readonly toolName: string;
  readonly expiresAt: string;
  readonly version: number;
  readonly alreadyApplied: boolean;
}

export interface HostedAiToolClaimRequest extends HostedAiTurnBindingRequest {
  readonly ticket: string;
  readonly approvalReceiptRef: string;
  readonly idempotencyKey: string;
}

export interface HostedAiToolClaimCompleteRequest extends HostedAiTurnBindingRequest {
  readonly claimId: string;
  readonly idempotencyKey: string;
  readonly effectReceiptRef: string;
}

export interface HostedAiToolClaimCancelRequest extends HostedAiTurnBindingRequest {
  readonly claimId: string;
  readonly idempotencyKey: string;
  readonly reason: 'stopped_before_effect' | 'user_declined_before_effect' | 'pre_effect_failure';
}

export type HostedAiToolClaimResult =
  | { readonly ok: true; readonly claim: HostedAiToolClaim }
  | Extract<HostedAiGenerationResult, { ok: false }>;

export interface HostedAiWorkflowTerminalRequest extends HostedAiTurnBindingRequest {
  readonly workflowRunId: string;
  readonly workflowStepId: string;
}

export interface HostedAiWorkflowTerminalReceipt {
  readonly workflowRunId: string;
  readonly workflowStepId: string;
  readonly canaryLeaseId: string;
  readonly finalStatus: 'cancelled';
  readonly idempotent: boolean;
}

export type HostedAiWorkflowTerminalResult =
  | { readonly ok: true; readonly receipt: HostedAiWorkflowTerminalReceipt }
  | Extract<HostedAiGenerationResult, { ok: false }>;

export interface HostedAiWorkflowStopIntentReceipt {
  readonly workflowRunId: string;
  readonly workflowStepId: string;
  readonly idempotent: boolean;
}

export type HostedAiWorkflowStopIntentResult =
  | { readonly ok: true; readonly receipt: HostedAiWorkflowStopIntentReceipt }
  | Extract<HostedAiGenerationResult, { ok: false }>;

export type HostedAiWorkflowAuthorityResult =
  | { readonly ok: true; readonly authority: HostedAiWorkflowAuthority }
  | Extract<HostedAiGenerationResult, { ok: false }>;

export type HostedAiRouteUnavailableReason =
  | 'gateway_paused'
  | 'account_not_enabled'
  | 'sign_in_required'
  | 'workflow_unavailable'
  | 'provider_unavailable'
  | 'gateway_not_ready'
  | 'browser_agent_unavailable';

export type HostedAiRouteAvailabilityErrorCode =
  | 'not_configured'
  | 'signed_out'
  | 'gateway_unavailable'
  | 'invalid_response';

export type HostedAiRouteAvailabilityResult =
  | {
      readonly ok: true;
      readonly available: true;
      readonly gatewayOrigin: string;
    }
  | {
      readonly ok: true;
      readonly available: false;
      readonly reason: HostedAiRouteUnavailableReason;
      readonly gatewayOrigin: string;
    }
  | {
      readonly ok: false;
      readonly code: HostedAiRouteAvailabilityErrorCode;
      readonly message: string;
      readonly gatewayOrigin: string | null;
    };

export type HostedAiRawTraceDeletionResult =
  | {
      readonly ok: true;
      readonly httpStatus: 202;
      readonly receipt: HostedAiRawTraceDeletionReceipt;
    }
  | Extract<HostedAiGenerationResult, { ok: false }>
  | {
      readonly ok: false;
      readonly code: 'gateway_unavailable';
      readonly message: string;
      readonly requestMayHaveBeenAccepted: true;
    };

export const HOSTED_AI_GATEWAY_RECORD_TOOL_OBSERVATION_CHANNEL = 'hostedAi:recordToolObservation';
export const HOSTED_AI_GATEWAY_CLAIM_TOOL_CHANNEL = 'hostedAi:claimTool';
export const HOSTED_AI_GATEWAY_COMPLETE_TOOL_CLAIM_CHANNEL = 'hostedAi:completeToolClaim';
export const HOSTED_AI_GATEWAY_CANCEL_TOOL_CLAIM_CHANNEL = 'hostedAi:cancelToolClaim';
export const HOSTED_AI_GATEWAY_CANCEL_WORKFLOW_CHANNEL = 'hostedAi:cancelWorkflow';
export const HOSTED_AI_GATEWAY_GET_WORKFLOW_AUTHORITY_CHANNEL = 'hostedAi:getWorkflowAuthority';
export const HOSTED_AI_GATEWAY_GET_ROUTE_AVAILABILITY_CHANNEL = 'hostedAi:getRouteAvailability';
export const HOSTED_AI_GATEWAY_REQUEST_RAW_TRACE_DELETION_CHANNEL =
  'hostedAi:requestRawTraceDeletion';
export const HOSTED_AI_GATEWAY_START_STREAM_CHANNEL = 'hostedAi:startStream';
export const HOSTED_AI_GATEWAY_CANCEL_STREAM_CHANNEL = 'hostedAi:cancelStream';
export const HOSTED_AI_GATEWAY_VALIDATE_TURN_BINDING_CHANNEL = 'hostedAi:validateTurnBinding';
export const HOSTED_AI_GATEWAY_RELEASE_TURN_BINDING_CHANNEL = 'hostedAi:releaseTurnBinding';
export const HOSTED_AI_GATEWAY_EXECUTE_NATIVE_TOOL_CHANNEL = 'hostedAi:executeNativeTool';
export const HOSTED_AI_GATEWAY_CANCEL_NATIVE_TOOL_CHANNEL = 'hostedAi:cancelNativeTool';
export const HOSTED_AI_GATEWAY_STREAM_EVENT_CHANNEL = 'hostedAi:streamEvent';
export const HOSTED_AI_GATEWAY_PREPARE_CONTRIBUTION_CHANNEL = 'hostedAi:prepareContribution';
