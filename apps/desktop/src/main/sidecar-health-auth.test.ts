import { describe, expect, it } from 'vitest';
import { isSidecarOwnershipMismatch, readSidecarSessionErrorCode } from './sidecar-health-auth';

describe('sidecar health authentication failures', () => {
  it('recognizes both maintained error envelopes', () => {
    expect(readSidecarSessionErrorCode({ error: { code: 'BAD_SESSION' } })).toBe('BAD_SESSION');
    expect(readSidecarSessionErrorCode({ detail: { code: 'MCP_SESSION_NOT_CONFIGURED' } })).toBe(
      'MCP_SESSION_NOT_CONFIGURED'
    );
  });

  it('fails fast for a configured foreign listener and an unconfigured listener', () => {
    expect(isSidecarOwnershipMismatch(401, null)).toBe(true);
    expect(
      isSidecarOwnershipMismatch(500, {
        error: { code: 'MCP_SESSION_NOT_CONFIGURED' },
      })
    ).toBe(true);
  });

  it('does not misclassify unrelated server failures as ownership mismatches', () => {
    expect(isSidecarOwnershipMismatch(500, { error: { code: 'INTERNAL_ERROR' } })).toBe(false);
    expect(isSidecarOwnershipMismatch(503, { code: 'MCP_SESSION_NOT_CONFIGURED' })).toBe(false);
  });
});
