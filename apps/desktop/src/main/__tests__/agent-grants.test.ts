import { describe, it, expect } from 'vitest';
import { IN_APP_CHAT_AGENT_IDENTITY, mintInAppChatGrant } from '../agent-grants';
import { DEFAULT_MCP_GRANT_CAPABILITIES } from '../sidecar-capabilities';

describe('mintInAppChatGrant', () => {
  it('returns the stable in-app chat identity', () => {
    const grant = mintInAppChatGrant();
    expect(grant.agentIdentityId).toBe(IN_APP_CHAT_AGENT_IDENTITY);
    expect(IN_APP_CHAT_AGENT_IDENTITY).toBe('local-in-app-chat');
  });

  it('generates a fresh session token per call when none is provided', () => {
    const a = mintInAppChatGrant();
    const b = mintInAppChatGrant();
    expect(a.sessionToken).not.toEqual(b.sessionToken);
    expect(a.sessionToken).toHaveLength(43);
    expect(a.sessionToken).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('reuses a caller-supplied session token verbatim', () => {
    const grant = mintInAppChatGrant({ sessionToken: 'pinned-test-token' });
    expect(grant.sessionToken).toBe('pinned-test-token');
  });

  it('defaults capabilities to DEFAULT_MCP_GRANT_CAPABILITIES', () => {
    const grant = mintInAppChatGrant();
    expect(grant.capabilities).toEqual([...DEFAULT_MCP_GRANT_CAPABILITIES]);
    expect(grant.capabilities).toContain('edit-primers');
  });

  it('uses caller-supplied capabilities when provided', () => {
    const grant = mintInAppChatGrant({ capabilities: ['debug.echo'] });
    expect(grant.capabilities).toEqual(['debug.echo']);
  });

  it('returns a fresh capabilities array each call (no shared reference)', () => {
    const a = mintInAppChatGrant();
    const b = mintInAppChatGrant();
    expect(a.capabilities).not.toBe(b.capabilities);
    a.capabilities.push('debug.tamper');
    expect(b.capabilities).not.toContain('debug.tamper');
  });
});
