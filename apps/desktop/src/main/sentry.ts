import * as Sentry from '@sentry/electron/main';
import { app, crashReporter } from 'electron';
import { scrubSentryEvent, scrubSentryBreadcrumb } from '../shared/sentry-scrub';
import { getTelemetryConsent } from './telemetry-consent';
import { redactTelemetryText } from '../shared/redact-telemetry';
import {
  createSentryErrorPolicy,
  operationalFailureContext,
} from '@waypoint/analytics-policy/sentry-error-policy';
import {
  isTelemetryEgressSuppressed,
  resolvePublicTelemetryActorRequestContext,
} from './telemetry-actor-context';
import { isLocalNativeCrashCaptureStarted } from './native-crash-reporter-start';

let sentryInitialized = false;

export function isSentryReportingEnabled(): boolean {
  return sentryInitialized && !isTelemetryEgressSuppressed();
}

function reportingIdentity() {
  const identity = resolvePublicTelemetryActorRequestContext();
  const environment =
    identity.telemetryActor === 'ci'
      ? 'ci'
      : identity.telemetryActor === 'dev' || identity.releaseChannel === 'dev'
        ? 'development'
        : identity.releaseChannel === 'prod'
          ? 'production'
          : identity.releaseChannel === 'closed_beta' || identity.releaseChannel === 'preview'
            ? 'staging'
            : 'unknown';
  return {
    release: identity.appVersion,
    environment,
    tags: {
      release_channel: identity.releaseChannel,
      telemetry_actor: identity.telemetryActor,
      ...(identity.buildTag ? { build_tag: identity.buildTag } : {}),
      ...(identity.ciRunId ? { ci_run_id: identity.ciRunId } : {}),
    },
  };
}

const sidecarFailureClasses = new Set([
  'spawn_error',
  'start_failed',
  'health_timeout',
  'health_mismatch',
  'restart_exhausted',
  'reclaim_failed',
  'resolve_failed',
  'termination_failed',
  'manual_restart_failed',
]);

export function initSentryMain(): void {
  if (sentryInitialized) return;
  const dsn = (typeof __SENTRY_DSN__ !== 'undefined' && __SENTRY_DSN__) || process.env.SENTRY_DSN;
  if (!dsn) {
    console.log('[Sentry] No DSN configured, skipping init');
    return;
  }

  if (!app.isPackaged) {
    console.log('[Sentry] App is not packaged, skipping init');
    return;
  }

  if (isTelemetryEgressSuppressed()) {
    let nativeUploadEnabled: boolean | null = null;
    let nativeUploadError: string | undefined;
    try {
      nativeUploadEnabled = crashReporter.getUploadToServer();
    } catch (error) {
      nativeUploadError = error instanceof Error ? error.message : String(error);
    }
    console.info(
      'dnaforge_sentry_suppression=' +
        JSON.stringify({
          process: 'main',
          packaged: app.isPackaged,
          sdk_initialized: Sentry.getClient() !== undefined,
          native_upload_enabled: nativeUploadEnabled,
          native_upload_error: nativeUploadError,
          local_crash_capture_started: isLocalNativeCrashCaptureStarted(),
          source_commit:
            typeof __DNAFORGE_APP_BUILD__ === 'undefined'
              ? null
              : __DNAFORGE_APP_BUILD__?.sourceCommit,
        })
    );
    return;
  }
  const identity = reportingIdentity();
  const errorPolicy = createSentryErrorPolicy();

  Sentry.init({
    dsn,
    release: identity.release,
    environment: identity.environment,
    initialScope: { tags: identity.tags },
    sendDefaultPii: false,
    beforeSend: (event) => {
      if (isTelemetryEgressSuppressed()) return null;
      const currentIdentity = reportingIdentity();
      event.release = currentIdentity.release;
      event.environment = currentIdentity.environment;
      event.tags = { ...event.tags, ...currentIdentity.tags };
      return errorPolicy(scrubSentryEvent(event));
    },
    beforeBreadcrumb: (breadcrumb) => scrubSentryBreadcrumb(breadcrumb),
    transportOptions: {
      shouldSend: () => !isTelemetryEgressSuppressed() && getTelemetryConsent() === 'allowed',
      shouldStore: () => !isTelemetryEgressSuppressed() && getTelemetryConsent() !== 'denied',
    },
  });
  sentryInitialized = true;

  console.log('[Sentry] Main process initialized');
}

export function reportException(
  error: unknown,
  context?: Parameters<typeof Sentry.captureException>[1]
): void {
  Sentry.captureException(error, context);
}

export function reportOperationalFailure(
  operation: string,
  context: Pick<Sentry.Event, 'level' | 'tags' | 'fingerprint' | 'extra' | 'contexts'> = {}
): void {
  const classification = operationalFailureContext(operation);
  Sentry.captureMessage(operation, {
    ...context,
    level: context.level ?? 'error',
    tags: { ...context.tags, ...classification.tags },
    fingerprint: context.fingerprint ?? classification.fingerprint,
  });
}

export function setSentryAnalyticsIdentity(identity: {
  distinctId: string;
  sessionId: string;
}): void {
  if (!sentryInitialized) return;
  Sentry.setUser({ id: identity.distinctId });
  Sentry.setTag('posthog_session_id', identity.sessionId);
}

export function captureSidecarLifecycleEvent(
  eventClass: string,
  context: {
    process_memory?: number | null;
    uptime_ms?: number | null;
    port?: string;
    code?: number | null;
    signal?: NodeJS.Signals | null;
    retryAttempt?: number;
    stderrTail?: string;
    reason?: string;
    manual?: boolean;
    fatal?: boolean;
  } = {}
): void {
  if (!sentryInitialized) return;

  const data = {
    event_class: eventClass,
    process_memory: context.process_memory,
    uptime_ms: context.uptime_ms,
    port: context.port,
    code: context.code,
    signal: context.signal,
    retry_attempt: context.retryAttempt,
    reason: context.reason,
    manual: context.manual,
    stderr_tail: context.stderrTail ? redactTelemetryText(context.stderrTail) : undefined,
  };
  const isFailure =
    context.fatal ||
    sidecarFailureClasses.has(eventClass) ||
    (eventClass === 'exit' && typeof context.code === 'number' && context.code !== 0);

  if (!isFailure) {
    Sentry.addBreadcrumb({ category: 'sidecar', level: 'info', data });
    return;
  }

  Sentry.withScope((scope) => {
    scope.setTag('component', 'sidecar');
    scope.setLevel('error');
    scope.setFingerprint(['sidecar', eventClass]);
    scope.setContext('sidecar', data);
    reportOperationalFailure(`sidecar_${eventClass}`, { fingerprint: ['sidecar', eventClass] });
  });
}
