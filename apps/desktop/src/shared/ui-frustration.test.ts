import { describe, expect, it } from 'vitest';
import { isAllowedClosedBetaEvent, sanitizeClosedBetaProperties } from './analytics-allowlist';
import { CLOSED_BETA_EVENT_PROPERTIES } from './analytics-registry.generated';

describe('ui_frustration analytics contract', () => {
  it('admits the event and preserves canvas attribution through sanitization', () => {
    expect(isAllowedClosedBetaEvent('ui_frustration')).toBe(true);
    expect(CLOSED_BETA_EVENT_PROPERTIES.ui_frustration).toEqual(['component', 'action']);
    expect(
      sanitizeClosedBetaProperties({ component: 'sequence-viewer.feature', action: 'click' })
    ).toEqual({ component: 'sequence-viewer.feature', action: 'click' });
  });

  it('rejects arbitrary document text as a component', () => {
    expect(sanitizeClosedBetaProperties({ component: 'private-sequence-name' })).toEqual({});
  });
});
