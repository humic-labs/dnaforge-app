import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

const setAsDefaultProtocolClient = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/fixture-test', setAsDefaultProtocolClient },
}));
vi.mock('../auth-config', () => ({ getRedirectScheme: () => 'dnaforge-dev' }));

import {
  parseCallbackUrl,
  findCallbackUrlInArgv,
  createPendingFlow,
  getPendingFlow,
  clearPendingFlow,
  clearAllPendingFlows,
  pendingFlowNonces,
  registerProtocolScheme,
  sha256Base64Url,
} from '../protocol';

beforeEach(() => clearAllPendingFlows());

describe('registerProtocolScheme', () => {
  it('registers the scheme in an official build and leaves the OS untouched in a community build', () => {
    setAsDefaultProtocolClient.mockClear();
    expect(registerProtocolScheme()).toBe('dnaforge-dev');
    expect(setAsDefaultProtocolClient).toHaveBeenCalledTimes(1);

    setAsDefaultProtocolClient.mockClear();
    vi.stubGlobal('__DNAFORGE_DISTRIBUTION__', 'community');
    try {
      expect(registerProtocolScheme()).toBe('dnaforge-dev');
      expect(setAsDefaultProtocolClient).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('parseCallbackUrl', () => {
  it('parses a valid dnaforge://auth-callback URL', () => {
    expect(parseCallbackUrl('dnaforge://auth-callback?code=abc&flow_nonce=fn1')).toEqual({
      code: 'abc',
      flowNonce: 'fn1',
    });
  });
  it('accepts the beta and dev schemes', () => {
    expect(parseCallbackUrl('dnaforge-beta://auth-callback?code=c&flow_nonce=n')).not.toBeNull();
    expect(parseCallbackUrl('dnaforge-dev://auth-callback?code=c&flow_nonce=n')).not.toBeNull();
  });
  it('rejects a foreign scheme', () => {
    expect(parseCallbackUrl('evil://auth-callback?code=c&flow_nonce=n')).toBeNull();
    expect(parseCallbackUrl('https://auth-callback?code=c&flow_nonce=n')).toBeNull();
  });
  it('rejects a wrong host', () => {
    expect(parseCallbackUrl('dnaforge://evil?code=c&flow_nonce=n')).toBeNull();
  });
  it('rejects missing code or flow_nonce', () => {
    expect(parseCallbackUrl('dnaforge://auth-callback?code=c')).toBeNull();
    expect(parseCallbackUrl('dnaforge://auth-callback?flow_nonce=n')).toBeNull();
  });
  it('rejects garbage', () => {
    expect(parseCallbackUrl('not a url')).toBeNull();
  });
});

describe('findCallbackUrlInArgv', () => {
  it('finds the dnaforge*:// URL among other argv', () => {
    expect(
      findCallbackUrlInArgv([
        '/path/electron',
        '--flag',
        'dnaforge://auth-callback?code=c&flow_nonce=n',
      ])
    ).toBe('dnaforge://auth-callback?code=c&flow_nonce=n');
  });
  it('finds non-auth dnaforge URLs for the shared protocol router', () => {
    expect(
      findCallbackUrlInArgv([
        '/path/electron',
        '--flag',
        'dnaforge://beta-attribution?code=payload.signature',
      ])
    ).toBe('dnaforge://beta-attribution?code=payload.signature');
  });
  it('returns null when no callback url present', () => {
    expect(findCallbackUrlInArgv(['/path/electron', '--flag'])).toBeNull();
  });
});

describe('in-memory pending-flow store', () => {
  it('derives challenge + poll_secret_hash exactly like the web side (base64url sha256)', () => {
    const flow = createPendingFlow('dev');
    expect(flow.challenge).toBe(createHash('sha256').update(flow.verifier).digest('base64url'));
    expect(flow.pollSecretHash).toBe(
      createHash('sha256').update(flow.pollSecret).digest('base64url')
    );
    expect(sha256Base64Url(flow.verifier)).toBe(flow.challenge);
  });
  it('stores and retrieves a flow, and a cold/unknown nonce returns undefined', () => {
    const flow = createPendingFlow('stable');
    expect(getPendingFlow(flow.flowNonce)).toBe(flow);
    expect(getPendingFlow('unknown-nonce')).toBeUndefined();
  });
  it('clears a single flow and all flows', () => {
    const a = createPendingFlow('dev');
    const b = createPendingFlow('dev');
    expect(pendingFlowNonces()).toHaveLength(2);
    clearPendingFlow(a.flowNonce);
    expect(getPendingFlow(a.flowNonce)).toBeUndefined();
    expect(getPendingFlow(b.flowNonce)).toBe(b);
    clearAllPendingFlows();
    expect(pendingFlowNonces()).toHaveLength(0);
  });
  it('generates distinct high-entropy nonces/verifiers', () => {
    const a = createPendingFlow('dev');
    const b = createPendingFlow('dev');
    expect(a.flowNonce).not.toBe(b.flowNonce);
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.verifier.length).toBeGreaterThanOrEqual(43);
  });
});
