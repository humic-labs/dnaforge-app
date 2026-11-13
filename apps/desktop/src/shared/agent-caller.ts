export interface AgentCaller {
  readonly agentIdentityId: string;
  readonly effectiveCapabilities: readonly string[];
}

export class AgentAuthorityError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retriable: boolean,
    readonly details?: Record<string, unknown>
  ) {
    super(`${code}: ${message}`);
    this.name = 'AgentAuthorityError';
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseAgentCallerResponse(value: unknown): AgentCaller {
  const payload = record(value);
  const error = record(payload?.error);
  if (
    payload?.ok === false &&
    typeof error?.code === 'string' &&
    typeof error.message === 'string'
  ) {
    throw new AgentAuthorityError(
      error.code,
      error.message,
      error.retriable === true,
      record(error.details) ?? undefined
    );
  }
  const caller = record(payload?.caller);
  if (
    payload?.ok !== true ||
    typeof caller?.agentIdentityId !== 'string' ||
    !caller.agentIdentityId.trim() ||
    !Array.isArray(caller.effectiveCapabilities) ||
    !caller.effectiveCapabilities.every(
      (capability: unknown) => typeof capability === 'string' && capability.trim().length > 0
    )
  ) {
    throw new AgentAuthorityError(
      'AGENT_AUTHORITY_UNAVAILABLE',
      'The compute service returned an invalid caller context.',
      true
    );
  }
  return {
    agentIdentityId: caller.agentIdentityId,
    effectiveCapabilities: [...caller.effectiveCapabilities],
  };
}

export function agentAuthorityUnavailable(): AgentAuthorityError {
  return new AgentAuthorityError(
    'AGENT_AUTHORITY_UNAVAILABLE',
    'Could not check the current agent permission. Retry when the compute service is available.',
    true
  );
}
