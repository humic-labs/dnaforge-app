import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useAppStartup } from './useAppStartup';

const mocks = vi.hoisted(() => {
  const settings = new Map<string, string>();
  return {
    settings,
    getSetting: vi.fn(async (key: string) => settings.get(key) ?? null),
    setSetting: vi.fn(async (key: string, value: string) => {
      settings.set(key, value);
    }),
    setAnalyticsConsent: vi.fn().mockResolvedValue(true),
    failClosedAnalyticsForSession: vi.fn().mockResolvedValue(undefined),
    optInAnalytics: vi.fn().mockResolvedValue(undefined),
    optOutAnalytics: vi.fn().mockResolvedValue(undefined),
    readAnalyticsConsentPolicy: vi.fn(),
    hasTelemetryDestination: vi.fn().mockResolvedValue(true),
    addRichToast: vi.fn(),
  };
});

vi.mock('../utils/environment', () => ({
  isDesktopRuntime: () => true,
  isHostedBrowserRuntime: () => false,
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

function options(): Parameters<typeof useAppStartup>[0] {
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

afterEach(() => {
  mocks.settings.clear();
  vi.clearAllMocks();
});

it('persists an unseen desktop analytics disclosure until the actual notice is dismissed', async () => {
  mocks.readAnalyticsConsentPolicy.mockResolvedValue({
    enabled: true,
    needsDisclosure: true,
    consent: 'true',
    version: '3',
  });
  const initial = options();
  const rendered = renderHook(() => useAppStartup(initial));
  try {
    await waitFor(() =>
      expect(mocks.addRichToast).toHaveBeenCalledWith(
        expect.objectContaining({ definition: 'data-privacy' })
      )
    );
    expect(mocks.settings.get('analytics_banner_seen')).toBe('false');
    expect(mocks.setAnalyticsConsent).toHaveBeenCalledWith(true, {
      resumeExistingEpisode: false,
    });
    expect(mocks.failClosedAnalyticsForSession).not.toHaveBeenCalled();
    const notice = mocks.addRichToast.mock.calls.find(
      (call) => call[0].definition === 'data-privacy'
    )?.[0] as { onDismiss?: () => Promise<void> };
    expect(typeof notice.onDismiss).toBe('function');
    await notice.onDismiss?.();
    expect(mocks.settings.get('analytics_banner_seen')).toBe('true');
  } finally {
    rendered.unmount();
  }
});

it('preserves an acknowledged desktop analytics notice without resetting its persisted state', async () => {
  mocks.settings.set('analytics_banner_seen', 'true');
  mocks.readAnalyticsConsentPolicy.mockResolvedValue({
    enabled: true,
    needsDisclosure: false,
    consent: 'true',
    version: '3',
  });
  const initial = options();
  const rendered = renderHook(() => useAppStartup(initial));
  try {
    await waitFor(() => expect(mocks.setAnalyticsConsent).toHaveBeenCalled());
    expect(mocks.settings.get('analytics_banner_seen')).toBe('true');
    expect(mocks.setSetting).not.toHaveBeenCalledWith('analytics_banner_seen', 'false');
    expect(
      mocks.addRichToast.mock.calls.some((call) => call[0].definition === 'data-privacy')
    ).toBe(false);
    expect(mocks.failClosedAnalyticsForSession).not.toHaveBeenCalled();
  } finally {
    rendered.unmount();
  }
});
