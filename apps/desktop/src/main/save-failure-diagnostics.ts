import { randomUUID } from 'node:crypto';
import { appendBootLog } from './boot-log';
import { trackEvent } from './analytics';
import { redactTelemetryText } from '../shared/redact-telemetry';
import { saveFailureProperties } from '../shared/save-failure-diagnostics';

function errorDetails(error: unknown, depth = 0): string {
  if (!(error instanceof Error)) return String(error);
  if (depth >= 3) return '[nested error]';
  const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
  const cause = Object.getOwnPropertyDescriptor(error, 'cause')?.value;
  return [
    `${error.name}: ${error.message}`,
    typeof code === 'string' ? `code=${code}` : '',
    cause === undefined ? '' : `cause=${errorDetails(cause, depth + 1)}`,
    error.stack ?? '',
  ]
    .filter(Boolean)
    .join(' ');
}

export function reportNativeSaveFailure(error: unknown): void {
  try {
    appendBootLog(`native_save_failed ${redactTelemetryText(errorDetails(error)).slice(0, 2000)}`);
  } catch {}
  try {
    trackEvent('workflow_action_observed', saveFailureProperties(error, randomUUID()));
  } catch {}
}
