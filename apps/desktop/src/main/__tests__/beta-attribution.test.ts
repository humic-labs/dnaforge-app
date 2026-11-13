import { beforeEach, describe, expect, it, vi } from 'vitest';

const runMock = vi.fn();
const sendMock = vi.fn();
const trackAllowedEventMock = vi.fn();

vi.mock('../ipc/database', () => ({
  getDb: () => ({
    prepare: () => ({
      run: (...args: unknown[]) => runMock(...args),
    }),
  }),
}));

vi.mock('../auth/auth-config', () => ({
  getWebBaseUrl: () => 'https://dnaforge.com',
}));

vi.mock('../analytics', () => ({
  trackAllowedEvent: (...args: unknown[]) => trackAllowedEventMock(...args),
}));

import { handleBetaAttributionUrl, isBetaAttributionUrl } from '../beta-attribution';
import { BETA_ATTRIBUTION_SETTING_KEY } from '../../shared/beta-attribution';

describe('desktop beta attribution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('recognizes only dnaforge beta-attribution URLs', () => {
    expect(isBetaAttributionUrl('dnaforge://beta-attribution?code=abc')).toBe(true);
    expect(isBetaAttributionUrl('dnaforge-beta://beta-attribution?code=abc')).toBe(true);
    expect(isBetaAttributionUrl('dnaforge-dev://beta-attribution?code=abc')).toBe(true);
    expect(isBetaAttributionUrl('dnaforge://auth-callback?code=abc')).toBe(false);
    expect(isBetaAttributionUrl('https://dnaforge.com/beta-attribution?code=abc')).toBe(false);
  });

  it('exchanges nothing in a community build', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('__DNAFORGE_DISTRIBUTION__', 'community');
    try {
      await handleBetaAttributionUrl(
        'dnaforge://beta-attribution?code=abcdefghijklmnopqrstuvwxyzABCDE.abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ',
        { isDestroyed: () => false, webContents: { send: sendMock } } as never
      );
    } finally {
      vi.stubGlobal('__DNAFORGE_DISTRIBUTION__', 'official');
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(runMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('exchanges, stores, tracks, and notifies renderer for valid attribution links', async () => {
    const responseBody = {
      beta_invite_id: 'bti_0123456789abcdef',
      beta_cohort: 'closed_beta',
      invite_batch: 'manual_onboarding',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => responseBody,
      }))
    );

    await handleBetaAttributionUrl(
      'dnaforge://beta-attribution?code=abcdefghijklmnopqrstuvwxyzABCDE.abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ',
      {
        isDestroyed: () => false,
        webContents: { send: sendMock },
      } as any
    );

    expect(fetch).toHaveBeenCalledWith('https://dnaforge.com/api/beta-attribution/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: expect.stringContaining('abcdefghijklmnopqrstuvwxyzABCDE'),
    });
    expect(runMock).toHaveBeenCalledWith(
      BETA_ATTRIBUTION_SETTING_KEY,
      expect.stringContaining('"beta_invite_id":"bti_0123456789abcdef"'),
      expect.any(Number)
    );
    expect(trackAllowedEventMock).toHaveBeenCalledWith('beta_install_attributed', {
      feature_area: 'lifecycle',
      beta_invite_id: 'bti_0123456789abcdef',
      beta_cohort: 'closed_beta',
      invite_batch: 'manual_onboarding',
    });
    expect(sendMock).toHaveBeenCalledWith('analytics:beta-attribution-updated');
  });

  it('ignores invalid code shapes before calling the web exchange', async () => {
    vi.stubGlobal('fetch', vi.fn());

    await handleBetaAttributionUrl('dnaforge://beta-attribution?code=not-valid');

    expect(fetch).not.toHaveBeenCalled();
    expect(runMock).not.toHaveBeenCalled();
  });
});
