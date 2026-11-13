import { sidecarFetch } from './sidecar-session-runtime';
import {
  AgentAuthorityError,
  agentAuthorityUnavailable,
  parseAgentCallerResponse,
  type AgentCaller,
} from '../shared/agent-caller';

export async function resolveCurrentAgentCaller(signal?: AbortSignal): Promise<AgentCaller> {
  signal?.throwIfAborted();
  try {
    const response = await sidecarFetch('/mcp/caller', {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
        : AbortSignal.timeout(10_000),
      cache: 'no-store',
    });
    const payload: unknown = await response.json();
    if (!response.ok) {
      parseAgentCallerResponse(payload);
      throw agentAuthorityUnavailable();
    }
    return parseAgentCallerResponse(payload);
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof AgentAuthorityError) throw error;
    throw agentAuthorityUnavailable();
  }
}
