import { isCodexAccountModelRejection } from '../../shared/cli-assistant-text';
import type { NativeTurnFailure } from '../../shared/native-turn-failure';

type Reason = NativeTurnFailure['reason'];
type Stage = NativeTurnFailure['stage'];

function fields(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function messageReason(message: string): Reason {
  if (/\b(?:ENOTFOUND|EAI_AGAIN)\b/u.test(message)) return 'dns_resolution_failed';
  if (
    /^(?:Claude Code process (?:exited with code \d+|terminated by signal SIG\w+)|Codex Exec exited with (?:code \d+|signal SIG\w+):)/u.test(
      message
    )
  )
    return 'process_exit';
  return 'unknown';
}

export function nativeProviderError(value: unknown, stage: Stage): NativeTurnFailure {
  const error = fields(value);
  const cause = fields(error.cause);
  const code = error.code ?? cause.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN')
    return { reason: 'dns_resolution_failed', stage };
  if (
    code === 'ENOENT' &&
    [error.syscall, cause.syscall].some((s) => typeof s === 'string' && s.startsWith('spawn'))
  ) {
    return { reason: 'executable_unavailable', stage: 'provider_start' };
  }
  const message = typeof value === 'string' ? value : String(error.message ?? '');
  return { reason: messageReason(message), stage };
}

export function codexProviderError(value: unknown, stage: Stage): NativeTurnFailure {
  const message = typeof value === 'string' ? value : fields(value).message;
  if (typeof message === 'string' && isCodexAccountModelRejection(message))
    return { reason: 'provider_rejected', stage };
  return nativeProviderError(value, stage);
}

export function codexTurnError(value: unknown): NativeTurnFailure {
  const error = fields(value);
  const stage = 'provider_stream';
  switch (error.codexErrorInfo) {
    case 'serverOverloaded':
      return { reason: 'provider_capacity', stage };
    case 'unauthorized':
      return { reason: 'authentication_required', stage };
    case 'badRequest':
    case 'contextWindowExceeded':
    case 'usageLimitExceeded':
    case 'sessionBudgetExceeded':
    case 'cyberPolicy':
    case 'misalignmentPolicyViolation':
      return { reason: 'provider_rejected', stage };
    case 'internalServerError':
      return nativeProviderError(error, stage).reason === 'dns_resolution_failed'
        ? { reason: 'dns_resolution_failed', stage }
        : { reason: 'provider_error', stage };
  }
  return codexProviderError(value, stage);
}

export function claudeTurnError(code: unknown, detail: string): NativeTurnFailure {
  const stage = 'provider_stream';
  switch (code) {
    case 'authentication_failed':
    case 'oauth_org_not_allowed':
      return { reason: 'authentication_required', stage };
    case 'rate_limit':
      return { reason: 'provider_capacity', stage };
    case 'invalid_request':
    case 'billing_error':
    case 'model_not_found':
    case 'max_output_tokens':
      return { reason: 'provider_rejected', stage };
    case 'server_error':
      return messageReason(detail) === 'dns_resolution_failed'
        ? { reason: 'dns_resolution_failed', stage }
        : { reason: 'provider_error', stage };
  }
  return nativeProviderError(detail, stage);
}

export function codexCompletedTool(value: unknown): boolean {
  const item = fields(value);
  if (
    !['command_execution', 'file_change', 'mcp_tool_call', 'web_search'].includes(String(item.type))
  )
    return false;
  return item.status !== 'failed' && item.status !== 'declined' && !item.error;
}
