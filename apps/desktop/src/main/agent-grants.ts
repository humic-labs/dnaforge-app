import { randomBytes } from 'node:crypto';
import { DEFAULT_MCP_GRANT_CAPABILITIES, DEFAULT_MCP_GRANT_IDENTITY } from './sidecar-capabilities';

export const IN_APP_CHAT_AGENT_IDENTITY = DEFAULT_MCP_GRANT_IDENTITY;

export interface InAppChatGrant {
  agentIdentityId: string;
  sessionToken: string;
  capabilities: string[];
}

export function mintInAppChatGrant(
  options: { sessionToken?: string; capabilities?: readonly string[] } = {}
): InAppChatGrant {
  return {
    agentIdentityId: IN_APP_CHAT_AGENT_IDENTITY,
    sessionToken: options.sessionToken ?? randomBytes(32).toString('base64url'),
    capabilities: options.capabilities
      ? [...options.capabilities]
      : [...DEFAULT_MCP_GRANT_CAPABILITIES],
  };
}
