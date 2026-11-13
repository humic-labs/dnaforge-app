// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { startGoogleSheetsLoopback } from './loopback';

const state = 'synthetic-state-with-at-least-32-characters';
describe('Google native OAuth loopback boundary', () => {
  it('binds loopback on an ephemeral port, returns only the code and closes after completion', async () => {
    const listener = await startGoogleSheetsLoopback({ state });
    try {
      expect(listener.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
      const response = await fetch(`${listener.redirectUri}?state=${state}&code=synthetic-code`);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(await response.text()).not.toContain('synthetic-code');
      await expect(listener.result).resolves.toEqual({ kind: 'code', code: 'synthetic-code' });
      await expect(fetch(listener.redirectUri)).rejects.toThrow();
    } finally {
      listener.cancel();
    }
  });
  it('ignores forged, ambiguous and wrong-path callbacks without consuming the real flow', async () => {
    const listener = await startGoogleSheetsLoopback({ state });
    try {
      for (const suffix of [
        '?state=wrong&code=forged',
        `?state=${state}&state=${state}&code=forged`,
        `?state=${state}&code=one&code=two`,
        `?state=${state}&code=one&error=access_denied`,
        `?state=${state}`,
      ])
        expect((await fetch(listener.redirectUri + suffix)).status).toBe(400);
      expect((await fetch(listener.redirectUri.replace('/callback', '/foreign'))).status).toBe(404);
      expect((await fetch(listener.redirectUri, { method: 'POST' })).status).toBe(405);
      const response = await fetch(`${listener.redirectUri}?state=${state}&code=real`);
      expect(response.status).toBe(200);
      await expect(listener.result).resolves.toEqual({ kind: 'code', code: 'real' });
    } finally {
      listener.cancel();
    }
  });
  it('settles a provider denial without treating it as an authorized connection', async () => {
    const listener = await startGoogleSheetsLoopback({ state });
    try {
      await fetch(`${listener.redirectUri}?state=${state}&error=access_denied`);
      await expect(listener.result).resolves.toEqual({ kind: 'denied' });
    } finally {
      listener.cancel();
    }
  });
  it('cancels idempotently and releases its actual listener', async () => {
    const listener = await startGoogleSheetsLoopback({ state });
    listener.cancel();
    listener.cancel();
    await expect(listener.result).resolves.toEqual({ kind: 'cancelled' });
    await expect(fetch(listener.redirectUri)).rejects.toThrow();
  });
  it('times out without a callback and rejects an insufficient state nonce before binding', async () => {
    const listener = await startGoogleSheetsLoopback({ state, timeoutMs: 10 });
    await expect(listener.result).resolves.toEqual({ kind: 'timeout' });
    await expect(fetch(listener.redirectUri)).rejects.toThrow();
    expect(() => startGoogleSheetsLoopback({ state: 'short' })).toThrow();
  });
});
