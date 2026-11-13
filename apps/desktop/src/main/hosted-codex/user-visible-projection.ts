import { userMessage, type UserMessage, type UserMessageKey } from '@waypoint/user-messages';

export type HostedCodexVisibleErrorCode =
  | 'HOSTED_CODEX_APP_SERVER_CRASH'
  | 'HOSTED_RENDERER_TEARDOWN'
  | 'HOSTED_APP_RESTART'
  | 'HOSTED_STOPPED'
  | 'HOSTED_RATE_LIMITED'
  | 'HOSTED_ALLOWANCE_EXHAUSTED'
  | 'HOSTED_CONTEXT_TOO_LARGE'
  | 'HOSTED_REQUEST_TOO_LARGE'
  | 'HOSTED_TURN_BUDGET_EXHAUSTED'
  | 'HOSTED_SERVICE_OVERLOADED'
  | 'HOSTED_POLICY_BLOCKED'
  | 'HOSTED_CONNECTION_FAILED'
  | 'HOSTED_AUTHENTICATION_FAILED'
  | 'HOSTED_LEGAL_ACCEPTANCE_REQUIRED'
  | 'HOSTED_CONTRIBUTION_POLICY_CHANGED'
  | 'HOSTED_CONTRIBUTION_CHOICE_REJECTED'
  | 'HOSTED_INVALID_REQUEST'
  | 'HOSTED_RESPONSE_CONTRACT_FAILED'
  | 'HOSTED_COMPLETION_UNGROUNDED'
  | 'HOSTED_LOCAL_TOOL_FAILED'
  | 'HOSTED_TURN_STATE_FAILED'
  | 'HOSTED_APPROVAL_DECLINED'
  | 'HOSTED_RECONCILIATION_REQUIRED'
  | 'HOSTED_PROVIDER_EXPOSURE_RECONCILIATION_REQUIRED'
  | 'HOSTED_UNAVAILABLE';

export interface HostedCodexVisibleError {
  readonly code: HostedCodexVisibleErrorCode;
  readonly message: UserMessage;
  readonly userMessageKey: UserMessageKey;
  readonly retryable: boolean;
}

export type HostedCodexDiagnosticStage =
  | 'sign_in'
  | 'turn_preparation'
  | 'local_runtime'
  | 'gateway_request'
  | 'provider_response'
  | 'local_tool'
  | 'final_response_after_local_tools'
  | 'turn_finalization'
  | 'reconciliation';

export interface HostedCodexDiagnosticContext {
  readonly technicalCode: string;
  readonly stage: HostedCodexDiagnosticStage;
  readonly retryable: boolean;
  readonly referenceId: string;
  readonly httpStatusCode?: number | null;
}

const VISIBLE_MESSAGES: Readonly<
  Record<HostedCodexVisibleErrorCode, { key: UserMessageKey; retryable: boolean }>
> = Object.freeze({
  HOSTED_CODEX_APP_SERVER_CRASH: { key: 'assistant.hostedAppServerCrash', retryable: true },
  HOSTED_RENDERER_TEARDOWN: { key: 'assistant.hostedRendererTeardown', retryable: true },
  HOSTED_APP_RESTART: { key: 'assistant.hostedAppRestart', retryable: true },
  HOSTED_STOPPED: { key: 'assistant.hostedStopped', retryable: true },
  HOSTED_RATE_LIMITED: { key: 'assistant.hostedRateLimited', retryable: true },
  HOSTED_ALLOWANCE_EXHAUSTED: { key: 'assistant.hostedAllowanceExhausted', retryable: false },
  HOSTED_CONTEXT_TOO_LARGE: { key: 'assistant.hostedContextTooLarge', retryable: false },
  HOSTED_REQUEST_TOO_LARGE: { key: 'assistant.hostedRequestTooLarge', retryable: false },
  HOSTED_TURN_BUDGET_EXHAUSTED: { key: 'assistant.hostedTurnBudgetExhausted', retryable: false },
  HOSTED_SERVICE_OVERLOADED: { key: 'assistant.hostedServiceOverloaded', retryable: true },
  HOSTED_POLICY_BLOCKED: { key: 'assistant.hostedPolicyBlocked', retryable: false },
  HOSTED_CONNECTION_FAILED: { key: 'assistant.hostedConnectionFailed', retryable: true },
  HOSTED_AUTHENTICATION_FAILED: { key: 'assistant.hostedAuthenticationFailed', retryable: false },
  HOSTED_LEGAL_ACCEPTANCE_REQUIRED: {
    key: 'assistant.hostedLegalAcceptanceRequired',
    retryable: false,
  },
  HOSTED_CONTRIBUTION_POLICY_CHANGED: {
    key: 'assistant.hostedContributionPolicyChanged',
    retryable: false,
  },
  HOSTED_CONTRIBUTION_CHOICE_REJECTED: {
    key: 'assistant.hostedContributionChoiceRejected',
    retryable: false,
  },
  HOSTED_INVALID_REQUEST: { key: 'assistant.hostedInvalidRequest', retryable: false },
  HOSTED_RESPONSE_CONTRACT_FAILED: {
    key: 'assistant.hostedResponseContractFailed',
    retryable: false,
  },
  HOSTED_COMPLETION_UNGROUNDED: { key: 'assistant.hostedCompletionUngrounded', retryable: true },
  HOSTED_LOCAL_TOOL_FAILED: { key: 'assistant.hostedLocalToolFailed', retryable: true },
  HOSTED_TURN_STATE_FAILED: { key: 'assistant.hostedTurnStateFailed', retryable: false },
  HOSTED_APPROVAL_DECLINED: { key: 'assistant.hostedApprovalDeclined', retryable: true },
  HOSTED_RECONCILIATION_REQUIRED: {
    key: 'assistant.hostedReconciliationRequired',
    retryable: false,
  },
  HOSTED_PROVIDER_EXPOSURE_RECONCILIATION_REQUIRED: {
    key: 'assistant.hostedProviderExposureReconciliationRequired',
    retryable: false,
  },
  HOSTED_UNAVAILABLE: { key: 'assistant.hostedUnavailable', retryable: true },
});

export class HostedCodexProjectionError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'HostedCodexProjectionError';
  }
}

const SHA256 = /\b[0-9a-f]{64}\b/iu;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu;
const DEPLOYMENT = /\b(?:staging|prod|production|dev)-[a-z0-9][a-z0-9.-]*\b/iu;
const INTERNAL_ID =
  /\b(?:reservation|workflow|run|turn|thread|item|call|claim|effect|observation|capsule|attempt)[-_](?:id|Id|ID)?[-_]?[A-Za-z0-9]{6,}\b/u;
const PROTOCOL_OBJECT = /[{[]\s*"[A-Za-z_][A-Za-z0-9_]*"\s*:/u;

const LEAK_RULES: readonly { readonly pattern: RegExp; readonly kind: string }[] = [
  { pattern: SHA256, kind: 'a content digest' },
  { pattern: UUID, kind: 'an internal identifier' },
  { pattern: DEPLOYMENT, kind: 'a provider deployment name' },
  { pattern: INTERNAL_ID, kind: 'an internal identifier' },
  { pattern: PROTOCOL_OBJECT, kind: 'a raw protocol object' },
];

export function assertNoInternalIdentifiers(text: string, label = 'user-visible text'): void {
  for (const rule of LEAK_RULES) {
    if (rule.pattern.test(text)) {
      throw new HostedCodexProjectionError(
        'internal_identifier_leaked',
        `${label} contains ${rule.kind}, which must never reach the interface`
      );
    }
  }
}

export function projectHostedCodexError(
  code: HostedCodexVisibleErrorCode,
  diagnostic?: HostedCodexDiagnosticContext
): HostedCodexVisibleError {
  const entry = VISIBLE_MESSAGES[code];
  if (!entry) {
    throw new HostedCodexProjectionError(
      'unknown_visible_error_code',
      `no user-visible message is defined for "${String(code)}"`
    );
  }
  const message = userMessage(entry.key);
  assertNoInternalIdentifiers(message, `visible message for ${code}`);
  return {
    code,
    message,
    userMessageKey: entry.key,
    retryable: diagnostic?.retryable ?? entry.retryable,
  };
}

export function hostedCodexVisibleErrorCodes(): readonly HostedCodexVisibleErrorCode[] {
  return Object.keys(VISIBLE_MESSAGES) as HostedCodexVisibleErrorCode[];
}
