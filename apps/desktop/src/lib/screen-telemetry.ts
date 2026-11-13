import { setAnalyticsScreenCategory, trackRendererEvent } from './analytics';
import type { SafeScreenCategory, SafeSourceSurface } from '@waypoint/analytics-policy';

export type ScreenCategory = SafeScreenCategory;

let navigationEpoch = 0;
let lastTargetKey: string | null = null;

export function observeCommittedScreen(input: {
  targetKey: string;
  screenCategory: ScreenCategory;
  sourceSurface: SafeSourceSurface;
}): boolean {
  if (input.targetKey === lastTargetKey) return false;
  setAnalyticsScreenCategory(input.screenCategory);
  const sourceSurface = navigationEpoch === 0 ? 'startup' : input.sourceSurface;
  const accepted = trackRendererEvent('screen_viewed', {
    feature_area: 'navigation',
    screen_category: input.screenCategory,
    source_surface: sourceSurface,
  });
  if (!accepted) return false;
  lastTargetKey = input.targetKey;
  navigationEpoch += 1;
  return true;
}

export function __resetScreenTelemetryForTests(): void {
  navigationEpoch = 0;
  lastTargetKey = null;
}
