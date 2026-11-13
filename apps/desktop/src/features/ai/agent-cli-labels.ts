import type { AgentTransport } from '../../platform';

export const AGENT_TRANSPORT_LABELS: Record<AgentTransport, string> = {
  'claude-agent-sdk': 'Claude Code',
  'codex-sdk': 'Codex CLI',
  'grok-acp': 'Grok Build',
};

export function getCodexAuthModeLabel(
  authMode: 'chatgpt' | 'apikey' | null | undefined
): string | null {
  if (authMode === 'chatgpt') return 'CLI auth: ChatGPT login';
  if (authMode === 'apikey') return 'CLI auth: Codex API key';
  return null;
}
