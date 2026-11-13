import { describe, it, expect } from 'vitest';
import { startLoopback } from './loopback';

describe('startLoopback — RFC 8252 loopback OAuth listener', () => {
  it('binds 127.0.0.1 on an ephemeral port and resolves on a valid /callback', async () => {
    const lb = await startLoopback('fn-1');
    try {
      expect(lb.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
      const res = await fetch(`${lb.redirectUri}?code=abc123&flow_nonce=fn-1`);
      expect(res.status).toBe(200);
      await expect(lb.waitForCallback).resolves.toEqual({ code: 'abc123', flowNonce: 'fn-1' });
    } finally {
      lb.close();
    }
  });

  it('SECURITY: a /callback with a MISMATCHED flow_nonce does NOT resolve (anti-DoS)', async () => {
    const lb = await startLoopback('fn-1');
    try {
      const res = await fetch(`${lb.redirectUri}?code=forged&flow_nonce=WRONG`);
      expect(res.status).toBe(200);
      const pending = await Promise.race([
        lb.waitForCallback.then(() => 'resolved'),
        new Promise((r) => setTimeout(() => r('pending'), 150)),
      ]);
      expect(pending).toBe('pending');
    } finally {
      lb.close();
    }
  });

  it('returns 404 for non-/callback paths (does not resolve)', async () => {
    const lb = await startLoopback('fn-1');
    try {
      const res = await fetch(`${lb.redirectUri.replace('/callback', '/whatever')}`);
      expect(res.status).toBe(404);
    } finally {
      lb.close();
    }
  });

  it('a /callback missing params still 200s but does not complete the flow', async () => {
    const lb = await startLoopback('fn-1');
    try {
      const res = await fetch(lb.redirectUri);
      expect(res.status).toBe(200);
      const pending = await Promise.race([
        lb.waitForCallback.then(() => 'resolved'),
        new Promise((r) => setTimeout(() => r('pending'), 150)),
      ]);
      expect(pending).toBe('pending');
    } finally {
      lb.close();
    }
  });

  it('close() is idempotent', async () => {
    const lb = await startLoopback('fn-1');
    lb.close();
    expect(() => lb.close()).not.toThrow();
  });
});
