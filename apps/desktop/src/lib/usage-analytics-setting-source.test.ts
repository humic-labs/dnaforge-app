import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const analytics = vi.hoisted(() => ({
  saved: { enabled: false },
  optInAnalytics: vi.fn<() => Promise<void>>(),
  optOutAnalytics: vi.fn<() => Promise<void>>(),
  readAnalyticsConsentPolicy: vi.fn<() => Promise<{ enabled: boolean } | null>>(),
  trackRendererEvent: vi.fn<(event: string, properties?: Record<string, unknown>) => boolean>(),
}));

vi.mock('./analytics', () => analytics);

import {
  readUsageAnalyticsChoice,
  setUsageAnalyticsChoice,
  setUsageAnalyticsDevOverride,
} from './usage-analytics-setting-source';

beforeEach(() => {
  analytics.saved.enabled = false;
  analytics.optInAnalytics.mockReset().mockImplementation(async () => {
    analytics.saved.enabled = true;
  });
  analytics.optOutAnalytics.mockReset().mockImplementation(async () => {
    analytics.saved.enabled = false;
  });
  analytics.readAnalyticsConsentPolicy
    .mockReset()
    .mockImplementation(async () => ({ enabled: analytics.saved.enabled }));
  analytics.trackRendererEvent.mockReset().mockReturnValue(true);
  setUsageAnalyticsDevOverride(null);
  vi.spyOn(window, 'dispatchEvent');
});

afterEach(() => {
  setUsageAnalyticsDevOverride(null);
  vi.restoreAllMocks();
});

describe('the production usage analytics choice', () => {
  it('records the registered re-enablement after consent is saved', async () => {
    analytics.trackRendererEvent.mockImplementation(() => {
      expect(analytics.saved.enabled).toBe(true);
      return true;
    });

    await setUsageAnalyticsChoice(true);

    expect(await readUsageAnalyticsChoice()).toBe(true);
    expect(analytics.trackRendererEvent).toHaveBeenCalledExactlyOnceWith('settings_changed', {
      feature_area: 'settings',
      setting: 'analytics',
    });
    expect(window.dispatchEvent).toHaveBeenCalledOnce();
  });

  it('does not invent another re-enablement for an already enabled choice', async () => {
    analytics.saved.enabled = true;

    await setUsageAnalyticsChoice(true);

    expect(analytics.trackRendererEvent).not.toHaveBeenCalled();
    expect(await readUsageAnalyticsChoice()).toBe(true);
  });

  it('begins revocation in the original dispatch and emits no opt-out event', async () => {
    analytics.saved.enabled = true;
    const result = setUsageAnalyticsChoice(false);
    try {
      expect(analytics.optOutAnalytics).toHaveBeenCalledOnce();
      expect(analytics.saved.enabled).toBe(false);
    } finally {
      await result;
    }
    expect(analytics.trackRendererEvent).not.toHaveBeenCalled();
  });

  it('does not let a delayed metric read override a later revocation', async () => {
    let releaseRead: ((choice: { enabled: boolean }) => void) | undefined;
    const previousChoice = new Promise<{ enabled: boolean }>((resolve) => {
      releaseRead = resolve;
    });
    analytics.readAnalyticsConsentPolicy.mockReturnValueOnce(previousChoice);

    const enabling = setUsageAnalyticsChoice(true);
    const revoking = setUsageAnalyticsChoice(false);
    releaseRead?.({ enabled: false });
    await Promise.all([enabling, revoking]);

    expect(analytics.saved.enabled).toBe(false);
    expect(analytics.trackRendererEvent).not.toHaveBeenCalled();
  });

  it('does not record a choice that failed to persist', async () => {
    analytics.optInAnalytics.mockRejectedValueOnce(new Error('Consent storage unavailable'));

    await expect(setUsageAnalyticsChoice(true)).rejects.toThrow('Consent storage unavailable');

    expect(analytics.saved.enabled).toBe(false);
    expect(analytics.trackRendererEvent).not.toHaveBeenCalled();
    expect(window.dispatchEvent).not.toHaveBeenCalled();
  });

  it('requires the saved gate to confirm a fulfilled grant', async () => {
    analytics.optInAnalytics.mockResolvedValueOnce(undefined);

    await setUsageAnalyticsChoice(true);

    expect(analytics.saved.enabled).toBe(false);
    expect(analytics.trackRendererEvent).not.toHaveBeenCalled();
  });

  it('does not infer a re-enablement from an unknown previous choice', async () => {
    analytics.readAnalyticsConsentPolicy.mockResolvedValueOnce(null);

    await setUsageAnalyticsChoice(true);

    expect(analytics.optInAnalytics).toHaveBeenCalledOnce();
    expect(analytics.saved.enabled).toBe(true);
    expect(analytics.trackRendererEvent).not.toHaveBeenCalled();
  });

  it('keeps the choice usable when the prior policy read is unavailable', async () => {
    analytics.readAnalyticsConsentPolicy.mockRejectedValueOnce(
      new Error('Policy read unavailable')
    );

    await expect(setUsageAnalyticsChoice(true)).resolves.toBeUndefined();

    expect(analytics.saved.enabled).toBe(true);
    expect(analytics.trackRendererEvent).not.toHaveBeenCalled();
    expect(window.dispatchEvent).toHaveBeenCalledOnce();
  });

  it('does not fail a saved choice when telemetry confirmation is unavailable', async () => {
    analytics.readAnalyticsConsentPolicy
      .mockResolvedValueOnce({ enabled: false })
      .mockRejectedValueOnce(new Error('Policy confirmation unavailable'));

    await expect(setUsageAnalyticsChoice(true)).resolves.toBeUndefined();

    expect(analytics.saved.enabled).toBe(true);
    expect(analytics.trackRendererEvent).not.toHaveBeenCalled();
    expect(window.dispatchEvent).toHaveBeenCalledOnce();
  });

  it('keeps a successful choice even when metric capture fails', async () => {
    analytics.trackRendererEvent.mockImplementationOnce(() => {
      throw new Error('Metric transport unavailable');
    });

    await expect(setUsageAnalyticsChoice(true)).resolves.toBeUndefined();

    expect(analytics.saved.enabled).toBe(true);
    expect(analytics.trackRendererEvent).toHaveBeenCalledOnce();
    expect(window.dispatchEvent).toHaveBeenCalledOnce();
  });

  it('keeps development preview changes outside the production consent and capture path', async () => {
    setUsageAnalyticsDevOverride({ enabled: false });

    await setUsageAnalyticsChoice(true);

    expect(await readUsageAnalyticsChoice()).toBe(true);
    expect(analytics.optInAnalytics).not.toHaveBeenCalled();
    expect(analytics.readAnalyticsConsentPolicy).not.toHaveBeenCalled();
    expect(analytics.trackRendererEvent).not.toHaveBeenCalled();
  });
});
