// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { parseAgentCallerResponse } from './agent-caller';

describe('authenticated caller contract', () => {
  it.each([
    null,
    {},
    { ok: true },
    { ok: true, caller: { agentIdentityId: '', effectiveCapabilities: ['*'] } },
    { ok: true, caller: { agentIdentityId: 'bound', effectiveCapabilities: [42] } },
    { ok: true, caller: { agentIdentityId: 'bound', effectiveCapabilities: [''] } },
    { ok: true, caller: { agentIdentityId: 'bound' } },
  ])(
    'rejects malformed authority without supplying empty or wildcard permissions (%j)',
    (value) => {
      expect(() => parseAgentCallerResponse(value)).toThrowError(/AGENT_AUTHORITY_UNAVAILABLE/);
    }
  );

  it('retains a valid empty grant and copies its scope array', () => {
    const effectiveCapabilities: string[] = [];
    const caller = parseAgentCallerResponse({
      ok: true,
      caller: { agentIdentityId: 'bound', effectiveCapabilities },
    });
    effectiveCapabilities.push('*');
    expect(caller).toEqual({ agentIdentityId: 'bound', effectiveCapabilities: [] });
  });

  it.each(['GRANT_MISSING', 'GRANT_REVOKED', 'GRANT_EXPIRED', 'BAD_SESSION'])(
    'preserves %s',
    (code) => {
      expect(() =>
        parseAgentCallerResponse({
          ok: false,
          error: { code, message: 'Refused.', retriable: false },
        })
      ).toThrowError(`${code}: Refused.`);
    }
  );
});
