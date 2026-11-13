import type { ContributionPolicy, ContributionReceipt } from '@waypoint/hosted-ai-contract';
import type { UserMessageKey } from '@waypoint/user-messages';

import type { HostedAiTier, HostedAiContributionGateResult } from './hosted-ai-gateway-ipc';

export interface HostedCodexTurnIdentity {
  readonly workflowId: string;
  readonly runId: string;
  readonly turnId: string;
}

export interface HostedCodexContributionRequest extends HostedCodexTurnIdentity {
  readonly workspacePath: string | null;
}

export type HostedCodexContributionResult =
  | {
      readonly ok: true;
      readonly started: boolean;
      readonly policy: ContributionPolicy;
      readonly receipt: ContributionReceipt | null;
    }
  | {
      readonly ok: false;
      readonly code: Extract<HostedAiContributionGateResult, { ok: false }>['code'];
      readonly message: string;
    };

export interface HostedCodexTurnStartRequest extends HostedCodexTurnIdentity {
  readonly tier: HostedAiTier;
  readonly developerInstructions: string;
  readonly userMessage: string;
  readonly priorConversationContext: string | null;
  readonly workspaceOpen: boolean;
  readonly stagedReferenceIds: readonly string[];
  readonly permissions?: import('./agent-permissions').AgentPermissions;
}

export interface HostedCodexGatewayProvenanceShape {
  readonly gatewayOrigin: string;
  readonly catalogVersion: string | null;
  readonly rateCardVersion: string | null;
  readonly reservationIds: readonly string[];
  readonly usageEventIds: readonly string[];
  readonly workflowRunId: string | null;
  readonly workflowStepId: string | null;
  readonly completedToolCallIds: readonly string[];
  readonly terminalError: {
    readonly code: string;
    readonly httpStatusCode: number | null;
    readonly retryable: boolean;
  } | null;
}

export interface HostedCodexArtifactIdentityShape {
  readonly desktopSourceCommit: string | null;
  readonly appServerVersion: string;
  readonly appServerSha256: string;
  readonly appServerTarget: string;
}

export type HostedTurnFailureCode =
  | 'context_window_exceeded'
  | 'session_budget_exceeded'
  | 'usage_limit_exceeded'
  | 'server_overloaded'
  | 'policy_blocked'
  | 'http_connection_failed'
  | 'response_stream_connection_failed'
  | 'internal_server_error'
  | 'unauthorized'
  | 'bad_request'
  | 'thread_rollback_failed'
  | 'sandbox_error'
  | 'response_stream_disconnected'
  | 'response_too_many_failed_attempts'
  | 'active_turn_not_steerable'
  | 'other';

export type HostedCodexTurnResult =
  | {
      readonly ok: true;
      readonly outcome: 'completed' | 'stopped';
      readonly text: string;
      readonly gateway: HostedCodexGatewayProvenanceShape;
      readonly artifact: HostedCodexArtifactIdentityShape;
    }
  | {
      readonly ok: false;
      readonly code:
        | 'not_prepared'
        | 'not_configured'
        | 'signed_out'
        | 'invalid_request'
        | 'gateway_paused'
        | 'allowance_exhausted'
        | 'rate_limited'
        | 'provider_exposure_reconciliation_required'
        | 'allowance_or_policy_rejected'
        | 'gateway_unavailable'
        | 'app_server_unavailable'
        | 'tool_failed'
        | 'provider_rate_limited'
        | 'provider_authentication_failed'
        | 'provider_request_rejected'
        | 'provider_service_unavailable'
        | 'provider_http_error'
        | 'provider_stream_disconnected'
        | 'provider_stream_failed'
        | 'provider_continuity_missing'
        | 'provider_continuity_mismatch'
        | 'provider_start_budget_exhausted'
        | 'provider_spend_budget_exhausted'
        | 'workflow_lease_lost'
        | 'gateway_processing_failed'
        | 'request_too_large'
        | HostedTurnFailureCode
        | 'turn_failed';
      readonly message: string;
      readonly userMessageKey?: UserMessageKey;
    };

export type HostedCodexTurnStopRequest = HostedCodexTurnIdentity;

export interface HostedCodexTurnStopResult {
  readonly ok: boolean;
}

export type HostedCodexPreparedTurnCancelRequest = HostedCodexTurnIdentity;

export interface HostedCodexPreparedTurnCancelResult {
  readonly ok: boolean;
}

export type HostedCodexTurnEvent =
  | (HostedCodexTurnIdentity & {
      readonly kind: 'text_delta';
      readonly delta: string;
    })
  | (HostedCodexTurnIdentity & {
      readonly kind: 'tool_completed';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: unknown;
      readonly output: unknown;
      readonly isError: boolean;
    });

export const HOSTED_CODEX_TURN_EVENT_CHANNEL = 'hostedCodex:turnEvent';
