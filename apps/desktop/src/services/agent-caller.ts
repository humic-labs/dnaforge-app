import { isApiError, getCurrentAgentCaller } from '@waypoint/api-client';
import { configureRendererSidecarApiClient, resolveSidecarBaseUrl } from './sidecar-session';
import {
  AgentAuthorityError,
  agentAuthorityUnavailable,
  parseAgentCallerResponse,
  type AgentCaller,
} from '../shared/agent-caller';

export async function resolveCurrentAgentCaller(signal?: AbortSignal): Promise<AgentCaller> {
  signal?.throwIfAborted();
  const lookupSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
    : AbortSignal.timeout(10_000);
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(lookupSignal.reason);
    lookupSignal.addEventListener('abort', onAbort, { once: true });
    if (lookupSignal.aborted) onAbort();
  });
  try {
    return await Promise.race([
      aborted,
      (async () => {
        const baseUrl = await resolveSidecarBaseUrl('Agent authority');
        lookupSignal.throwIfAborted();
        configureRendererSidecarApiClient(baseUrl);
        const response = await getCurrentAgentCaller({ signal: lookupSignal, cache: 'no-store' });
        lookupSignal.throwIfAborted();
        return parseAgentCallerResponse(response.data);
      })(),
    ]);
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof AgentAuthorityError) throw error;
    if (isApiError(error)) parseAgentCallerResponse(error.body);
    throw agentAuthorityUnavailable();
  } finally {
    lookupSignal.removeEventListener('abort', onAbort);
  }
}
