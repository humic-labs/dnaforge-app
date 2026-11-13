import type { AgentTransport } from '../../platform';

export function observedAuthenticatedState(detection: unknown, transport: AgentTransport): boolean {
  if (!detection || typeof detection !== 'object') return false;
  const key =
    transport === 'claude-agent-sdk' ? 'claudeCode' : transport === 'codex-sdk' ? 'codex' : 'grok';
  const state = Object.getOwnPropertyDescriptor(detection, key)?.value;
  return (
    !!state &&
    typeof state === 'object' &&
    Object.getOwnPropertyDescriptor(state, 'auth')?.value === 'authenticated'
  );
}
