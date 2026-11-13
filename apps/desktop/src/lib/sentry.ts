import * as SentrySdk from '@sentry/electron/renderer';
import { scrubSentryEvent, scrubSentryBreadcrumb } from '../shared/sentry-scrub';
import { createSentryErrorPolicy } from '@waypoint/analytics-policy/sentry-error-policy';

export async function initSentryRenderer(): Promise<void> {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn || !import.meta.env.PROD) {
    return;
  }

  try {
    if (!(await window.electronAPI?.startup?.isErrorReportingEnabled())) {
      console.info(
        'dnaforge_sentry_suppression=' +
          JSON.stringify({
            process: 'renderer',
            sdk_initialized: SentrySdk.getClient() !== undefined,
            source_commit:
              typeof __DNAFORGE_APP_BUILD__ === 'undefined'
                ? null
                : __DNAFORGE_APP_BUILD__?.sourceCommit,
          })
      );
      return;
    }
  } catch {
    return;
  }

  const errorPolicy = createSentryErrorPolicy();
  SentrySdk.init({
    dsn,
    release: __APP_VERSION__,
    tracesSampler: ({ name }) => (name === 'structure.viewer.load' ? 1 : 0),
    sendDefaultPii: false,
    beforeSend: (event) => errorPolicy(scrubSentryEvent(event)),
    beforeBreadcrumb: (breadcrumb) => scrubSentryBreadcrumb(breadcrumb),
  });
}

export function reportException(
  error: unknown,
  context?: Parameters<typeof SentrySdk.captureException>[1]
): void {
  SentrySdk.captureException(error, context);
}

export const Sentry = Object.freeze({
  startInactiveSpan: SentrySdk.startInactiveSpan,
  captureMessage(
    message: Parameters<typeof SentrySdk.captureMessage>[0],
    context?: Parameters<typeof SentrySdk.captureMessage>[1]
  ) {
    return SentrySdk.captureMessage(message, context);
  },
});
