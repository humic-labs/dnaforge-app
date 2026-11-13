// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { scrubSentryEvent, scrubSentryBreadcrumb } from './sentry-scrub';

describe('sentry-scrub ', () => {
  it('redacts the event message, exception values, and attached breadcrumb messages', () => {
    const event = {
      message: 'boom for alice@example.com',
      exception: { values: [{ value: 'read /Users/alice/x.gb failed' }] },
      breadcrumbs: [{ message: 'token: xxxxxxxxxxxx' }],
    };
    const out = scrubSentryEvent(event);
    expect(out.message).toBe('boom for [redacted-email]');
    expect(out.exception.values[0].value).toBe(
      'read /Users/[redacted-user]/[redacted-path] failed'
    );
    expect(out.breadcrumbs[0].message).toBe('token: [redacted]');
  });

  it('scrubs a breadcrumb message', () => {
    expect(scrubSentryBreadcrumb({ message: 'user bob@lab.org' }).message).toBe(
      'user [redacted-email]'
    );
  });

  it('handles missing fields without throwing', () => {
    expect(() => scrubSentryEvent({})).not.toThrow();
    expect(scrubSentryBreadcrumb({}).message).toBeUndefined();
  });
});
