import {
  optInAnalytics,
  optOutAnalytics,
  readAnalyticsConsentPolicy,
  trackRendererEvent,
} from './analytics';

export const USAGE_ANALYTICS_CHOICE_CHANGED_EVENT = 'dnaforge:usage-analytics-choice-changed';

let devOverride: { enabled: boolean | null } | null = null;

export function setUsageAnalyticsDevOverride(state: { enabled: boolean | null } | null): void {
  devOverride = state ? { ...state } : null;
}

export async function readUsageAnalyticsChoice(): Promise<boolean | null> {
  if (devOverride) return devOverride.enabled;
  const decision = await readAnalyticsConsentPolicy();
  return decision ? decision.enabled : null;
}

async function enableUsageAnalyticsChoice(): Promise<void> {
  const previousChoice = readAnalyticsConsentPolicy().catch(() => null);
  await optInAnalytics();
  if ((await previousChoice)?.enabled !== false) return;
  try {
    const savedChoice = await readAnalyticsConsentPolicy();
    if (savedChoice?.enabled === true) {
      trackRendererEvent('settings_changed', {
        feature_area: 'settings',
        setting: 'analytics',
      });
    }
  } catch {
    return;
  }
}

export async function setUsageAnalyticsChoice(enabled: boolean): Promise<void> {
  if (devOverride) devOverride = { enabled };
  else await (enabled ? enableUsageAnalyticsChoice() : optOutAnalytics());
  window.dispatchEvent(new Event(USAGE_ANALYTICS_CHOICE_CHANGED_EVENT));
}
