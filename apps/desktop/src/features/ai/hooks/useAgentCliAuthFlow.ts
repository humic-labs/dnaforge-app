import { useCallback, useEffect, useState } from 'react';
import { platform } from '../../../platform';
import { trackRendererEvent } from '../../../lib/analytics';
import { observedAuthenticatedState } from '../auth-publication-observation';
import type {
  AgentAuthEnvelopeShape,
  AgentAuthResultShape,
  AgentTransport,
} from '../../../platform';

type RefreshAgentDetection = (authentication?: AgentAuthResultShape) => Promise<unknown>;

const CLI_TRANSPORTS = new Set<AgentTransport>(['codex-sdk', 'claude-agent-sdk', 'grok-acp']);

function isAgentTransport(value: string): value is AgentTransport {
  return CLI_TRANSPORTS.has(value as AgentTransport);
}

function emptyAuthLog(): Record<AgentTransport, string[]> {
  return {
    'codex-sdk': [],
    'claude-agent-sdk': [],
    'grok-acp': [],
  };
}

function failedAuthResult(
  authId: string,
  transport: AgentTransport,
  error: unknown
): AgentAuthResultShape {
  return {
    authId,
    transport,
    ok: false,
    status: 'failed',
    command: [],
    output: '',
    error: error instanceof Error ? error.message : String(error),
    durationMs: 0,
  };
}

export function useAgentCliAuthFlow({
  refreshAgentDetection,
}: {
  refreshAgentDetection: RefreshAgentDetection;
}) {
  const [authenticatingTransport, setAuthenticatingTransport] = useState<AgentTransport | null>(
    null
  );
  const [authResult, setAuthResult] = useState<AgentAuthResultShape | null>(null);
  const [authLog, setAuthLog] = useState<Record<AgentTransport, string[]>>(emptyAuthLog);

  useEffect(() => {
    return platform().agentSdk.onAuthEvent((payload: AgentAuthEnvelopeShape) => {
      const event = payload.event;
      if (!isAgentTransport(event.transport)) return;
      const line = event.text.trimEnd();
      if (!line) return;
      setAuthLog((current) => ({
        ...current,
        [event.transport]: [...current[event.transport], line],
      }));
    });
  }, []);

  const runAgentAuth = useCallback(
    async (
      transport: AgentTransport,
      binaryPathOverride?: string
    ): Promise<AgentAuthResultShape> => {
      const authId = crypto.randomUUID();
      const observe = (
        stage: 'renderer_accepted' | 'renderer_published',
        outcome: 'started' | 'succeeded' | 'failed',
        reason: string
      ) =>
        trackRendererEvent('agent_auth_state_observed', {
          feature_area: 'auth',
          operation_id: authId,
          occurred_at_ms: Date.now(),
          auth_vendor:
            transport === 'claude-agent-sdk'
              ? 'claude'
              : transport === 'codex-sdk'
                ? 'codex'
                : 'grok',
          auth_stage: stage,
          auth_outcome: outcome,
          auth_reason: reason,
        });
      observe('renderer_accepted', 'started', 'none');
      setAuthenticatingTransport(transport);
      setAuthResult(null);
      setAuthLog((current) => ({
        ...current,
        [transport]: ['Launching vendor CLI sign-in...'],
      }));

      try {
        const result = await platform().agentSdk.authenticate(transport, {
          authId,
          ...(binaryPathOverride ? { binaryPathOverride } : {}),
        });
        setAuthResult(result);
        const detection = await refreshAgentDetection(result);
        const published = result.ok && observedAuthenticatedState(detection, transport);
        observe(
          'renderer_published',
          published ? 'succeeded' : 'failed',
          published ? 'none' : result.ok ? 'auth_not_detected' : (result.failureKind ?? 'unknown')
        );
        return result;
      } catch (error) {
        const result = failedAuthResult(authId, transport, error);
        setAuthResult(result);
        observe('renderer_published', 'failed', 'handler_error');
        await refreshAgentDetection();
        return result;
      } finally {
        setAuthenticatingTransport(null);
      }
    },
    [refreshAgentDetection]
  );

  return {
    authenticatingTransport,
    authResult,
    authLog,
    runAgentAuth,
  };
}
