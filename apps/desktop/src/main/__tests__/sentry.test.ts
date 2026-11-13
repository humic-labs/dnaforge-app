import { describe, it, expect, vi, beforeEach } from 'vitest';

const sentryMocks = vi.hoisted(() => ({
  init: vi.fn(),
  isPackaged: true,
  suppressed: false,
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  getClient: vi.fn(),
  releaseChannel: 'closed_beta',
  telemetryActor: 'user',
}));

vi.mock('@sentry/electron/main', () => ({
  init: sentryMocks.init,
  captureMessage: sentryMocks.captureMessage,
  captureException: sentryMocks.captureException,
  getClient: sentryMocks.getClient,
}));

vi.mock('../telemetry-actor-context', () => ({
  isTelemetryEgressSuppressed: () => sentryMocks.suppressed,
  resolvePublicTelemetryActorRequestContext: () => ({
    appVersion: '1.0.0',
    releaseChannel: sentryMocks.releaseChannel,
    buildTag: 'v1.0.0-beta.1',
    telemetryActor: sentryMocks.telemetryActor,
  }),
}));

vi.mock('../telemetry-consent', () => ({ getTelemetryConsent: () => 'allowed' }));

vi.mock('electron', () => ({
  crashReporter: { getUploadToServer: () => false },
  app: {
    getVersion: () => '1.0.0',
    get isPackaged() {
      return sentryMocks.isPackaged;
    },
  },
}));

describe('sentry main process', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.unstubAllGlobals();
    sentryMocks.isPackaged = true;
    sentryMocks.suppressed = false;
    sentryMocks.releaseChannel = 'closed_beta';
    sentryMocks.telemetryActor = 'user';
    delete process.env.SENTRY_DSN;
  });

  it('calls Sentry.init with DSN from baked build constant for packaged builds', async () => {
    vi.stubGlobal('__SENTRY_DSN__', 'https://baked@sentry.io/456');
    process.env.SENTRY_DSN = 'https://runtime@sentry.io/123';
    const { initSentryMain, isSentryReportingEnabled } = await import('../sentry');
    expect(isSentryReportingEnabled()).toBe(false);
    initSentryMain();
    expect(isSentryReportingEnabled()).toBe(true);
    expect(sentryMocks.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: 'https://baked@sentry.io/456',
        environment: 'staging',
      })
    );
  });

  it('falls back to SENTRY_DSN when baked DSN is empty for packaged builds', async () => {
    vi.stubGlobal('__SENTRY_DSN__', '');
    process.env.SENTRY_DSN = 'https://runtime@sentry.io/123';
    const { initSentryMain } = await import('../sentry');
    initSentryMain();
    expect(sentryMocks.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: 'https://runtime@sentry.io/123',
        environment: 'staging',
      })
    );
  });

  it('includes release version from app.getVersion', async () => {
    vi.stubGlobal('__SENTRY_DSN__', '');
    process.env.SENTRY_DSN = 'https://example@sentry.io/123';
    const { initSentryMain } = await import('../sentry');
    initSentryMain();
    expect(sentryMocks.init).toHaveBeenCalledWith(
      expect.objectContaining({
        release: '1.0.0',
      })
    );
  });

  it('skips init when no DSN is set', async () => {
    vi.stubGlobal('__SENTRY_DSN__', '');
    const { initSentryMain } = await import('../sentry');
    initSentryMain();
    expect(sentryMocks.init).not.toHaveBeenCalled();
  });

  it('skips init when a baked DSN is set but the app is not packaged', async () => {
    vi.stubGlobal('__SENTRY_DSN__', 'https://baked@sentry.io/456');
    sentryMocks.isPackaged = false;
    process.env.SENTRY_DSN = 'https://runtime@sentry.io/123';
    const { initSentryMain } = await import('../sentry');
    initSentryMain();
    expect(sentryMocks.init).not.toHaveBeenCalled();
  });

  it('does not initialize native or JavaScript Sentry reporting under a suppression fence', async () => {
    vi.stubGlobal('__SENTRY_DSN__', 'https://baked@sentry.io/456');
    sentryMocks.suppressed = true;
    const { initSentryMain } = await import('../sentry');
    initSentryMain();
    expect(sentryMocks.init).not.toHaveBeenCalled();
  });

  it('applies main authority to renderer events and blocks delivery and storage under later suppression', async () => {
    vi.stubGlobal('__SENTRY_DSN__', 'https://baked@sentry.io/456');
    const { initSentryMain } = await import('../sentry');
    initSentryMain();
    const options = sentryMocks.init.mock.calls[0][0];
    const event = { exception: { values: [{ value: 'failure' }] }, environment: 'production' };
    expect(options.beforeSend(event)).toMatchObject({
      environment: 'staging',
      release: '1.0.0',
      tags: { release_channel: 'closed_beta', build_tag: 'v1.0.0-beta.1', telemetry_actor: 'user' },
    });
    expect(options.transportOptions.shouldSend()).toBe(true);
    expect(options.transportOptions.shouldStore()).toBe(true);
    sentryMocks.suppressed = true;
    expect(options.beforeSend(event)).toBeNull();
    expect(options.transportOptions.shouldSend()).toBe(false);
    expect(options.transportOptions.shouldStore()).toBe(false);
  });

  it('classifies authored operational failures and preserves unexpected exception reports', async () => {
    const { reportOperationalFailure, reportException } = await import('../sentry');
    reportOperationalFailure('auth.session_decryption_unavailable', { level: 'warning' });
    expect(sentryMocks.captureMessage).toHaveBeenCalledWith(
      'auth.session_decryption_unavailable',
      expect.objectContaining({
        level: 'warning',
        tags: {
          error_report_kind: 'operational_failure',
          error_operation: 'auth.session_decryption_unavailable',
        },
      })
    );
    const error = new Error('unknown failure');
    reportException(error);
    expect(sentryMocks.captureException).toHaveBeenCalledWith(error, undefined);
  });

  it.each([
    ['closed_beta', 'user', 'staging'],
    ['preview', 'user', 'staging'],
    ['prod', 'user', 'production'],
    ['dev', 'user', 'development'],
    ['prod', 'dev', 'development'],
    ['prod', 'ci', 'ci'],
    ['unknown', 'user', 'unknown'],
  ])(
    'maps %s channel and %s actor to %s while preserving channel identity',
    async (channel, actor, environment) => {
      vi.stubGlobal('__SENTRY_DSN__', 'https://baked@sentry.io/456');
      sentryMocks.releaseChannel = channel;
      sentryMocks.telemetryActor = actor;
      const { initSentryMain } = await import('../sentry');
      initSentryMain();
      const options = sentryMocks.init.mock.calls[0][0];
      expect(options.environment).toBe(environment);
      expect(options.initialScope.tags.release_channel).toBe(channel);
      expect(options.beforeSend({ exception: { values: [{ type: 'Error' }] } })).toMatchObject({
        environment,
        tags: { release_channel: channel, telemetry_actor: actor },
      });
    }
  );
});
