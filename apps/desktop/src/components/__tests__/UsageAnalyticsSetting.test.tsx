import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ConsentPolicyDecision } from '@waypoint/analytics-policy';

const analytics = vi.hoisted(() => ({
  readAnalyticsConsentPolicy: vi.fn<() => Promise<ConsentPolicyDecision | null>>(),
  optInAnalytics: vi.fn<() => Promise<void>>(),
  optOutAnalytics: vi.fn<() => Promise<void>>(),
  subscribeAnalyticsCaptureReady: vi.fn(() => () => {}),
}));
vi.mock('../../lib/analytics', () => analytics);

import { UsageAnalyticsSetting } from '../AboutSettingsSection';

const ON: ConsentPolicyDecision = {
  enabled: true,
  needsDisclosure: false,
  consent: 'true',
  version: '3',
};
const OFF: ConsentPolicyDecision = {
  enabled: false,
  needsDisclosure: false,
  consent: 'false',
  version: '3',
};
const NOT_ASKED: ConsentPolicyDecision = {
  enabled: false,
  needsDisclosure: true,
  consent: null,
  version: null,
};

function analyticsSwitch(): HTMLElement {
  return screen.getByRole('switch', { name: 'Share usage analytics and crash reports' });
}

beforeEach(() => {
  vi.clearAllMocks();
  analytics.optInAnalytics.mockResolvedValue(undefined);
  analytics.optOutAnalytics.mockResolvedValue(undefined);
});

describe('usage analytics setting', () => {
  it('reflects the main-process decision', async () => {
    analytics.readAnalyticsConsentPolicy.mockResolvedValue(ON);
    render(<UsageAnalyticsSetting />);
    await waitFor(() => expect(analyticsSwitch()).toHaveAttribute('aria-checked', 'true'));
    expect(analyticsSwitch()).not.toBeDisabled();
  });

  it('shows off before an opt-in region user has chosen', async () => {
    analytics.readAnalyticsConsentPolicy.mockResolvedValue(NOT_ASKED);
    render(<UsageAnalyticsSetting />);
    await waitFor(() => expect(analyticsSwitch()).toHaveAttribute('aria-checked', 'false'));
    expect(analyticsSwitch()).not.toBeDisabled();
  });

  it('turns sharing off through the opt-out path and shows the stored result', async () => {
    analytics.readAnalyticsConsentPolicy.mockResolvedValueOnce(ON).mockResolvedValueOnce(OFF);
    render(<UsageAnalyticsSetting />);
    await waitFor(() => expect(analyticsSwitch()).toHaveAttribute('aria-checked', 'true'));

    fireEvent.click(analyticsSwitch());

    expect(analytics.optOutAnalytics).toHaveBeenCalledTimes(1);
    expect(analytics.optInAnalytics).not.toHaveBeenCalled();
    await waitFor(() => expect(analyticsSwitch()).toHaveAttribute('aria-checked', 'false'));
    await waitFor(() => expect(analyticsSwitch()).not.toBeDisabled());
  });

  it('turns sharing on as the user explicit choice', async () => {
    analytics.readAnalyticsConsentPolicy.mockResolvedValueOnce(OFF).mockResolvedValueOnce(ON);
    render(<UsageAnalyticsSetting />);
    await waitFor(() => expect(analyticsSwitch()).toHaveAttribute('aria-checked', 'false'));

    fireEvent.click(analyticsSwitch());

    expect(analytics.optInAnalytics).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(analyticsSwitch()).toHaveAttribute('aria-checked', 'true'));
  });

  it('is unavailable where the main process cannot report a decision', async () => {
    analytics.readAnalyticsConsentPolicy.mockResolvedValue(null);
    render(<UsageAnalyticsSetting />);
    await waitFor(() => expect(screen.getByText('Unavailable in this window')).toBeInTheDocument());
    expect(analyticsSwitch()).toBeDisabled();
  });

  it('shows and changes a DevPanel review state without touching the stored choice', async () => {
    const { setUsageAnalyticsDevOverride } =
      await import('../../lib/usage-analytics-setting-source');
    setUsageAnalyticsDevOverride({ enabled: false });
    try {
      render(<UsageAnalyticsSetting />);
      await waitFor(() => expect(analyticsSwitch()).toHaveAttribute('aria-checked', 'false'));
      fireEvent.click(analyticsSwitch());
      await waitFor(() => expect(analyticsSwitch()).toHaveAttribute('aria-checked', 'true'));
      expect(analytics.readAnalyticsConsentPolicy).not.toHaveBeenCalled();
      expect(analytics.optInAnalytics).not.toHaveBeenCalled();
    } finally {
      setUsageAnalyticsDevOverride(null);
    }
  });
});
