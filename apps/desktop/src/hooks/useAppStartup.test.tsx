import { StrictMode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveConsentPolicy } from '@waypoint/analytics-policy';
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
    mocks.getSetting.mockReset().mockResolvedValue(null);
    mocks.setSetting.mockReset().mockResolvedValue(undefined);
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

  it('asks for explicit opt-in when an acknowledged default grant is invalid in the current region', async () => {
    mocks.hosted = false;
    const settings = new Map<string, string>([
      ['analytics_banner_seen', 'true'],
      ['analytics_consent', 'true'],
      ['analytics_consent_version', '3'],
      ['analytics_consent_basis', 'default'],
    ]);
    mocks.getSetting.mockImplementation(async (key: string) => settings.get(key) ?? null);
    mocks.setSetting.mockImplementation(async (key: string, value: string) => {
      settings.set(key, value);
    });
    const decision = resolveConsentPolicy({
      surface: 'desktop',
      regime: 'opt_in',
      storedConsent: settings.get('analytics_consent') ?? null,
      storedVersion: settings.get('analytics_consent_version') ?? null,
      storedBasis: settings.get('analytics_consent_basis') ?? null,
    });
    expect(decision).toEqual({
      enabled: false,
      needsDisclosure: true,
      consent: null,
      version: null,
    });
    mocks.readAnalyticsConsentPolicy.mockResolvedValue(decision);
    renderHook(() => useAppStartup(startupOptions()));
    await waitFor(() =>
      expect(mocks.addRichToast).toHaveBeenCalledWith(
        expect.objectContaining({ definition: 'data-privacy-opt-in' })
      )
    );
    expect(mocks.failClosedAnalyticsForSession).toHaveBeenCalled();
    expect(mocks.setAnalyticsConsent).not.toHaveBeenCalled();
    expect(mocks.optInAnalytics).not.toHaveBeenCalled();
    expect(mocks.optOutAnalytics).not.toHaveBeenCalled();
    expect(settings.get('analytics_banner_seen')).toBe('true');
    expect(settings.get('analytics_consent')).toBe('true');
    expect(settings.get('analytics_consent_basis')).toBe('default');
  });

  it('remembers a dismissed opt-in prompt across startup without granting consent', async () => {
    mocks.hosted = false;
    const settings = new Map<string, string>();
    mocks.getSetting.mockImplementation(async (key: string) => settings.get(key) ?? null);
    mocks.setSetting.mockImplementation(async (key: string, value: string) => {
      settings.set(key, value);
    });
    mocks.readAnalyticsConsentPolicy.mockResolvedValue({
      enabled: false,
      needsDisclosure: true,
      consent: null,
      version: null,
    });
    const launch = () => {
      const options = startupOptions();
      return renderHook(() => useAppStartup(options));
    };
    const first = launch();
    await waitFor(() => expect(mocks.addRichToast).toHaveBeenCalled());
    const notice = mocks.addRichToast.mock.calls[0][0];
    expect(notice.definition).toBe('data-privacy-opt-in');
    await notice.onDismiss?.();
    first.unmount();
    vi.clearAllMocks();
    launch();
    await waitFor(() => expect(mocks.failClosedAnalyticsForSession).toHaveBeenCalled());
    expect(mocks.addRichToast).not.toHaveBeenCalled();
    expect(mocks.optInAnalytics).not.toHaveBeenCalled();
    expect(mocks.optOutAnalytics).not.toHaveBeenCalled();
  });

  it('honors an explicit sharing choice made before the notice was remembered', async () => {
    mocks.hosted = false;
    mocks.getSetting.mockImplementation(async (key: string) =>
      key === 'analytics_consent_basis'
        ? 'explicit'
        : key === 'privacy_policy_update_seen'
          ? '2026-10-31'
          : null
    );
    mocks.readAnalyticsConsentPolicy.mockResolvedValue({
      enabled: true,
      needsDisclosure: false,
      consent: 'true',
      version: '3',
    });
    const options = startupOptions();
    renderHook(() => useAppStartup(options));
    await waitFor(() =>
      expect(mocks.setAnalyticsConsent).toHaveBeenCalledWith(true, {
        resumeExistingEpisode: true,
      })
    );
    expect(mocks.addRichToast).not.toHaveBeenCalled();
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
