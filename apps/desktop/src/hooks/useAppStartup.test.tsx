import { StrictMode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAppStartup } from './useAppStartup';

const mocks = vi.hoisted(() => ({
  hosted: true,
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(undefined),
  setAnalyticsConsent: vi.fn().mockResolvedValue(true),
  failClosedAnalyticsForSession: vi.fn().mockResolvedValue(undefined),
  optInAnalytics: vi.fn().mockResolvedValue(undefined),
  optOutAnalytics: vi.fn().mockResolvedValue(undefined),
  readAnalyticsConsentPolicy: vi.fn(),
  hasTelemetryDestination: vi.fn().mockResolvedValue(true),
  addRichToast: vi.fn(),
}));

vi.mock('../utils/environment', () => ({
  isDesktopRuntime: () => !mocks.hosted,
  isHostedBrowserRuntime: () => mocks.hosted,
}));
vi.mock('../db', () => ({ getSetting: mocks.getSetting, setSetting: mocks.setSetting }));
vi.mock('../lib/analytics', () => ({
  setAnalyticsConsent: mocks.setAnalyticsConsent,
  failClosedAnalyticsForSession: mocks.failClosedAnalyticsForSession,
  optInAnalytics: mocks.optInAnalytics,
  optOutAnalytics: mocks.optOutAnalytics,
  readAnalyticsConsentPolicy: mocks.readAnalyticsConsentPolicy,
  hasTelemetryDestination: mocks.hasTelemetryDestination,
}));
vi.mock('../stores/toast-store', () => ({
  useToastStore: { getState: () => ({ addRichToast: mocks.addRichToast }) },
}));
vi.mock('../lib/applyZoomLevel', () => ({ applyZoomLevel: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../features/design', () => ({ startMocloFactoryStageOutputSync: vi.fn() }));

function startupOptions(): Parameters<typeof useAppStartup>[0] {
  return {
    shellPrepared: true,
    setShellPrepared: vi.fn(),
    shellError: null,
    setShellError: vi.fn(),
    workspaceRestored: true,
    setWorkspaceRestored: vi.fn(),
    workspaceLoading: false,
    workspaceError: null,
    libraryLoaded: true,
    projectCollectionRestoredRef: { current: true },
    optionalSetupStarted: { current: false },
    getDevTestWindow: () => null,
    devScenarioRuntimeEnabled: false,
    devScenarioReplayEpoch: 0,
    getE2E: () => ({}),
  };
}

describe('hosted versus desktop startup analytics', () => {
  afterEach(() => {
    mocks.hosted = true;
    localStorage.clear();
    vi.clearAllMocks();
  });

  it.each([null, 'false', 'true'])(
    'does not substitute desktop analytics consent or notices for browser consent %j',
    async (consent) => {
      if (consent !== null) {
        localStorage.setItem('analytics_consent', consent);
        localStorage.setItem('analytics_consent_version', '3');
      }
      const options = startupOptions();
      renderHook(() => useAppStartup(options), { wrapper: StrictMode });
      await waitFor(() => expect(mocks.failClosedAnalyticsForSession).toHaveBeenCalled());
      expect(mocks.setAnalyticsConsent).not.toHaveBeenCalled();
      expect(mocks.getSetting).not.toHaveBeenCalled();
      expect(mocks.setSetting).not.toHaveBeenCalled();
      expect(mocks.addRichToast).not.toHaveBeenCalled();
      expect(localStorage.getItem('analytics_consent')).toBe(consent);
    }
  );

  it('preserves the opt-out-region default and its disclosure', async () => {
    mocks.hosted = false;
    mocks.readAnalyticsConsentPolicy.mockResolvedValue({
      enabled: true,
      needsDisclosure: true,
      consent: 'true',
      version: '3',
    });
    const options = startupOptions();
    renderHook(() => useAppStartup(options));
    await waitFor(() => expect(mocks.addRichToast).toHaveBeenCalled());
    expect(mocks.setAnalyticsConsent).toHaveBeenCalledWith(true, {
      resumeExistingEpisode: false,
    });
    expect(mocks.addRichToast).toHaveBeenCalledWith(
      expect.objectContaining({ definition: 'data-privacy' })
    );
    expect(mocks.failClosedAnalyticsForSession).not.toHaveBeenCalled();
  });

  it.each([
    ['the opt-out-region disclosure', true, 'true'],
    ['the opt-in-region question', false, null],
  ])('shows no %s when the build has nowhere to send', async (_label, enabled, consent) => {
    mocks.hosted = false;
    mocks.hasTelemetryDestination.mockResolvedValueOnce(false);
    mocks.readAnalyticsConsentPolicy.mockResolvedValue({
      enabled,
      needsDisclosure: true,
      consent,
      version: '3',
    });
    const options = startupOptions();
    renderHook(() => useAppStartup(options));
    await waitFor(() => expect(mocks.hasTelemetryDestination).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        enabled ? mocks.setAnalyticsConsent : mocks.failClosedAnalyticsForSession
      ).toHaveBeenCalled()
    );
    expect(mocks.addRichToast).not.toHaveBeenCalled();
  });

  it.each([
    ['a returning user', { analytics_banner_seen: 'true' }, false, true],
    [
      'a user who already saw it',
      { analytics_banner_seen: 'true', privacy_policy_update_seen: '2026-10-31' },
      false,
      false,
    ],
    ['a new user', {}, true, false],
  ])(
    'shows the privacy policy update once, to %s only',
    async (_label, settings, needsDisclosure, shown) => {
      mocks.hosted = false;
      mocks.getSetting.mockImplementation(
        async (key: string) => (settings as Record<string, string>)[key] ?? null
      );
      mocks.readAnalyticsConsentPolicy.mockResolvedValue({
        enabled: true,
        needsDisclosure,
        consent: 'true',
        version: '3',
      });
      const options = startupOptions();
      renderHook(() => useAppStartup(options));
      await waitFor(() => expect(mocks.setAnalyticsConsent).toHaveBeenCalled());
      const definitions = mocks.addRichToast.mock.calls.map(
        (call) => (call[0] as { definition: string }).definition
      );
      expect(definitions.includes('privacy-policy-updated')).toBe(shown);
      if ('privacy_policy_update_seen' in settings) {
        expect(mocks.setSetting).not.toHaveBeenCalledWith(
          'privacy_policy_update_seen',
          expect.anything()
        );
      } else {
        expect(mocks.setSetting).toHaveBeenCalledWith('privacy_policy_update_seen', '2026-10-31');
      }
      mocks.getSetting.mockReset();
      mocks.getSetting.mockResolvedValue(null);
    }
  );

  it('asks first in an opt-in region and shares nothing until the user allows it', async () => {
    mocks.hosted = false;
    mocks.readAnalyticsConsentPolicy.mockResolvedValue({
      enabled: false,
      needsDisclosure: true,
      consent: null,
      version: null,
    });
    const options = startupOptions();
    renderHook(() => useAppStartup(options));
    await waitFor(() => expect(mocks.addRichToast).toHaveBeenCalled());
    expect(mocks.failClosedAnalyticsForSession).toHaveBeenCalled();
    expect(mocks.setAnalyticsConsent).not.toHaveBeenCalled();

    const toast = mocks.addRichToast.mock.calls[0][0] as {
      definition: string;
      actions: Array<{ label: string; onClick: () => void }>;
    };
    expect(toast.definition).toBe('data-privacy-opt-in');
    expect(toast.actions.map((action) => action.label)).toEqual([
      'Share',
      "Don't share",
      'Privacy details',
    ]);
    toast.actions[0].onClick();
    expect(mocks.optInAnalytics).toHaveBeenCalledTimes(1);
    toast.actions[1].onClick();
    expect(mocks.optOutAnalytics).toHaveBeenCalledTimes(1);
  });

  it('keeps an explicit opt-out without notices', async () => {
    mocks.hosted = false;
    mocks.readAnalyticsConsentPolicy.mockResolvedValue({
      enabled: false,
      needsDisclosure: false,
      consent: 'false',
      version: '3',
    });
    const options = startupOptions();
    renderHook(() => useAppStartup(options));
    await waitFor(() => expect(mocks.setAnalyticsConsent).toHaveBeenCalledWith(false));
    expect(mocks.addRichToast).not.toHaveBeenCalled();
  });

  it('fails closed when the main process cannot report a decision', async () => {
    mocks.hosted = false;
    mocks.readAnalyticsConsentPolicy.mockResolvedValue(null);
    const options = startupOptions();
    renderHook(() => useAppStartup(options));
    await waitFor(() => expect(mocks.failClosedAnalyticsForSession).toHaveBeenCalled());
    expect(mocks.setAnalyticsConsent).not.toHaveBeenCalled();
    expect(mocks.addRichToast).not.toHaveBeenCalled();
  });
});
