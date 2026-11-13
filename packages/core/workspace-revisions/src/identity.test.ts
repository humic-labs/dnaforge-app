import { describe, expect, it } from 'vitest';

import { parseMemberId, parseOperationId, parseResourceId, parseWorkspaceId } from './identity';
import { defineBlob, hashCanonicalRecord } from './hash';

describe('stable identity parsing', () => {
  it('accepts opaque existing IDs without rewriting them', () => {
    expect(parseWorkspaceId('workspace_existing-01')).toEqual({
      ok: true,
      value: 'workspace_existing-01',
    });
    expect(parseResourceId('pkg_alpha')).toEqual({ ok: true, value: 'pkg_alpha' });
    expect(parseMemberId('member/product:primary')).toEqual({
      ok: true,
      value: 'member/product:primary',
    });
    expect(parseOperationId('capture-0001')).toEqual({ ok: true, value: 'capture-0001' });
  });

  it.each([
    ['', 'empty'],
    ['line\nbreak', 'control-character'],
    ['\ud800', 'invalid-unicode'],
    ['cafe\u0301', 'not-nfc'],
    ['x'.repeat(257), 'too-long'],
  ] as const)('rejects invalid workspace identity %j as %s', (value, kind) => {
    expect(parseWorkspaceId(value)).toEqual({ ok: false, error: { kind } });
  });

  it('measures the 256-byte limit as UTF-8 rather than JavaScript code units', () => {
    expect(parseWorkspaceId('é'.repeat(128)).ok).toBe(true);
    expect(parseWorkspaceId('é'.repeat(129))).toEqual({
      ok: false,
      error: { kind: 'too-long' },
    });
  });
});

describe('content identity', () => {
  it('hashes exact blob bytes', () => {
    expect(defineBlob(new Uint8Array()).hash).toBe(
      'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
  });

  it('domain-separates canonical record IDs', () => {
    const canonical = '{"a":1}';
    expect(hashCanonicalRecord('resource-state', canonical)).toBe(
      'rs_89518e7bbcb9c170e7f7044c7ac6f2c16b5d2347802959c8d59f717be6a9b90d'
    );
    expect(hashCanonicalRecord('resource-revision', canonical)).toBe(
      'rr_de41b9961534844be4e24be34064a085f4086e5bdd595ed23718ca131bb81173'
    );
    expect(hashCanonicalRecord('workspace-version', canonical)).toBe(
      'wv_00844404aeac4e7ff2dba2a91c96310832ab92063fa60d9796e13918af72e603'
    );
  });
});
