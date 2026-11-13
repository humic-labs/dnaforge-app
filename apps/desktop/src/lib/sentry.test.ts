// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sentryMocks = vi.hoisted(() => ({
  init: vi.fn(),
  startInactiveSpan: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(() => 'captured-event-id'),
  isErrorReportingEnabled: vi.fn(async () => true),
  getClient: vi.fn(),
}));

vi.mock('@sentry/electron/renderer', () => ({
  init: sentryMocks.init,
  startInactiveSpan: sentryMocks.startInactiveSpan,
  captureException: sentryMocks.captureException,
  captureMessage: sentryMocks.captureMessage,
  getClient: sentryMocks.getClient,
}));

describe('sentry renderer process', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.stubEnv('VITE_SENTRY_DSN', 'https://example@sentry.io/123');
    sentryMocks.isErrorReportingEnabled.mockResolvedValue(true);
    vi.stubGlobal('window', {
      electronAPI: { startup: { isErrorReportingEnabled: sentryMocks.isErrorReportingEnabled } },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('skips init when no DSN is set', async () => {
    vi.stubEnv('VITE_SENTRY_DSN', '');
    vi.stubEnv('PROD', true);
    const { initSentryRenderer } = await import('./sentry');
    await initSentryRenderer();
    expect(sentryMocks.init).not.toHaveBeenCalled();
  });

  it('skips init in development even when a DSN is set', async () => {
    vi.stubEnv('PROD', false);
    vi.stubEnv('MODE', 'development');
    const { initSentryRenderer } = await import('./sentry');
    await initSentryRenderer();
    expect(sentryMocks.init).not.toHaveBeenCalled();
  });

  it('initializes Sentry in production builds', async () => {
    vi.stubEnv('PROD', true);
    vi.stubEnv('MODE', 'production');
    const { initSentryRenderer } = await import('./sentry');
    await initSentryRenderer();
    expect(sentryMocks.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: 'https://example@sentry.io/123',
        release: '1.0.0',
        tracesSampler: expect.any(Function),
      })
    );

    const tracesSampler = sentryMocks.init.mock.calls[0]?.[0]?.tracesSampler;
    expect(tracesSampler?.({ name: 'structure.viewer.load' })).toBe(1);
    expect(tracesSampler?.({ name: 'unrelated.renderer.span' })).toBe(0);
  });

  it('preserves renderer exceptions while refusing ordinary messages', async () => {
    vi.stubEnv('PROD', true);
    const { initSentryRenderer, reportException } = await import('./sentry');
    await initSentryRenderer();
    const beforeSend = sentryMocks.init.mock.calls[0][0].beforeSend;
    const exception = { exception: { values: [{ type: 'Error', value: 'unexpected failure' }] } };
    expect(beforeSend(exception)).toBe(exception);
    expect(beforeSend({ message: 'structure.viewer.load.slow', level: 'warning' })).toBeNull();
    const error = new Error('unknown failure');
    reportException(error);
    expect(sentryMocks.captureException).toHaveBeenCalledWith(error, undefined);
  });

  it('keeps the renderer reporting facade compatible without exposing SDK configuration', async () => {
    vi.stubEnv('PROD', true);
    const { initSentryRenderer, Sentry } = await import('./sentry');
    await initSentryRenderer();
    expect(Object.keys(Sentry).sort()).toEqual(['captureMessage', 'startInactiveSpan']);
    expect(Object.isFrozen(Sentry)).toBe(true);
    const context = { level: 'warning' as const };
    expect(Sentry.captureMessage('structure.viewer.load.slow', context)).toBe('captured-event-id');
    expect(sentryMocks.captureMessage).toHaveBeenCalledWith('structure.viewer.load.slow', context);
    const beforeSend = sentryMocks.init.mock.calls[0][0].beforeSend;
    expect(beforeSend({ message: 'structure.viewer.load.slow', level: 'warning' })).toBeNull();
    expect(
      beforeSend({ exception: { values: [{ type: 'Error', value: 'unexpected failure' }] } })
    ).not.toBeNull();
  });

  it('does not initialize renderer transport when main reporting is suppressed', async () => {
    vi.stubEnv('PROD', true);
    sentryMocks.isErrorReportingEnabled.mockResolvedValue(false);
    const { initSentryRenderer } = await import('./sentry');
    await initSentryRenderer();
    expect(sentryMocks.init).not.toHaveBeenCalled();
  });

  it('does not initialize renderer transport when main capability is unavailable', async () => {
    vi.stubEnv('PROD', true);
    sentryMocks.isErrorReportingEnabled.mockRejectedValue(new Error('bridge unavailable'));
    const { initSentryRenderer } = await import('./sentry');
    await initSentryRenderer();
    expect(sentryMocks.init).not.toHaveBeenCalled();
  });
});
