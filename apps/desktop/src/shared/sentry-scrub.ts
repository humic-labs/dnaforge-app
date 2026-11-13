import { redactTelemetryText } from './redact-telemetry';

interface ScrubbableEvent {
  message?: string;
  exception?: { values?: Array<{ value?: string }> };
  breadcrumbs?: Array<{ message?: string }> | null;
}

interface ScrubbableBreadcrumb {
  message?: string;
}

export function scrubSentryEvent<T extends ScrubbableEvent>(event: T): T {
  if (typeof event.message === 'string') {
    event.message = redactTelemetryText(event.message);
  }
  for (const value of event.exception?.values ?? []) {
    if (typeof value.value === 'string') {
      value.value = redactTelemetryText(value.value);
    }
  }
  for (const crumb of event.breadcrumbs ?? []) {
    if (typeof crumb.message === 'string') {
      crumb.message = redactTelemetryText(crumb.message);
    }
  }
  return event;
}

export function scrubSentryBreadcrumb<T extends ScrubbableBreadcrumb>(breadcrumb: T): T {
  if (typeof breadcrumb.message === 'string') {
    breadcrumb.message = redactTelemetryText(breadcrumb.message);
  }
  return breadcrumb;
}
