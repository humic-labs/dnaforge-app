import { beforeEach, describe, expect, it, vi } from 'vitest';

const sentry = vi.hoisted(() => {
  let scope: Record<string, unknown> = {};
  const captures: Array<Record<string, unknown>> = [];
  return {
    init: vi.fn(),
    addBreadcrumb: vi.fn(),
    captureMessage: vi.fn((message: string, options?: Record<string, unknown>) => {
      captures.push({ ...scope, ...options, message });
    }),
    captureException: vi.fn((error: unknown, options?: Record<string, unknown>) => {
      captures.push({ ...scope, ...options, error });
    }),
    withScope: (callback: (value: unknown) => void) => {
      scope = {};
      callback({
        setTag: vi.fn(),
        setLevel: (level: string) => {
          scope.level = level;
        },
        setFingerprint: (fingerprint: string[]) => {
          scope.fingerprint = fingerprint;
        },
        setContext: (name: string, value: unknown) => {
          scope.contexts = { ...(scope.contexts as Record<string, unknown>), [name]: value };
        },
      });
      scope = {};
    },
    captures,
  };
});

vi.mock('@sentry/electron/main', () => sentry);
vi.mock('electron', () => ({ app: { isPackaged: true, getVersion: () => '1.0.0' } }));
vi.mock('../telemetry-actor-context', () => ({
  isTelemetryEgressSuppressed: () => false,
  resolvePublicTelemetryActorRequestContext: () => ({
    appVersion: '1.0.0',
    releaseChannel: 'prod',
    telemetryActor: 'user',
  }),
}));

async function initializedCapture() {
  const { initSentryMain, captureSidecarLifecycleEvent } = await import('../sentry');
  initSentryMain();
  expect(sentry.init).toHaveBeenCalledOnce();
  return captureSidecarLifecycleEvent;
}

describe(' sidecar lifecycle Sentry contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.stubGlobal('__SENTRY_DSN__', 'https://contract@sentry.io/4044');
    sentry.captures.length = 0;
  });

  it.each(['ready', 'stopped', 'initial'])(
    '%s records an info breadcrumb without capturing an event',
    async (eventClass) => {
      const capture = await initializedCapture();
      capture(eventClass, { port: '8000', reason: 'contract-smoke' });
      expect(sentry.addBreadcrumb).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          category: 'sidecar',
          level: 'info',
          data: expect.objectContaining({
            event_class: eventClass,
            port: '8000',
            reason: 'contract-smoke',
          }),
        })
      );
      expect(sentry.captureMessage).not.toHaveBeenCalled();
      expect(sentry.captureException).not.toHaveBeenCalled();
    }
  );

  it.each([
    { eventClass: 'restart_exhausted', code: undefined },
    { eventClass: 'exit', code: 1 },
  ])(
    '$eventClass captures exactly one error with fingerprint and redacted stderr context',
    async ({ eventClass, code }) => {
      const capture = await initializedCapture();
      capture(eventClass, {
        code,
        port: '8000',
        retryAttempt: 3,
        stderrTail: 'worker failed reading /Users/alice/private/sample.gb',
      });
      expect(sentry.captures).toHaveLength(1);
      expect(sentry.captures[0]).toEqual(
        expect.objectContaining({
          level: 'error',
          fingerprint: ['sidecar', eventClass],
          contexts: expect.objectContaining({
            sidecar: expect.objectContaining({
              event_class: eventClass,
              code,
              port: '8000',
              retry_attempt: 3,
              stderr_tail: 'worker failed reading /Users/[redacted-user]/[redacted-path]',
            }),
          }),
        })
      );
    }
  );

  it('exit with code 0 does not capture an event', async () => {
    const capture = await initializedCapture();
    capture('exit', { code: 0 });
    expect(sentry.captureMessage).not.toHaveBeenCalled();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });
});
