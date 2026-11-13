import { expect, it } from 'vitest';
import { CLOSED_BETA_EVENT_PROPERTIES } from './analytics-registry.generated';
import { sanitizeClosedBetaProperties } from './analytics-allowlist';

it('accepts the actual updater fallback manual flag without rejecting the event property', () => {
  const properties = { feature_area: 'reliability', origin_index: 0, stage: 'check', manual: true };
  expect(
    Object.keys(properties).filter(
      (key) => !CLOSED_BETA_EVENT_PROPERTIES.app_update_origin_failed.includes(key)
    )
  ).toEqual([]);
  expect(sanitizeClosedBetaProperties(properties)).toEqual(properties);
});
