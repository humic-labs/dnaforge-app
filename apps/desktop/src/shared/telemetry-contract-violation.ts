export interface TelemetryContractViolation {
  process: 'main' | 'renderer';
  event: string;
  reason: string;
  keys: readonly string[];
}

export function telemetryContractViolationMessage(violation: TelemetryContractViolation): string {
  const keys = violation.keys.length > 0 ? ` [${violation.keys.join(', ')}]` : '';
  return (
    `[TELEMETRY CONTRACT VIOLATION] ${violation.process} ${violation.event}: ` +
    `${violation.reason}${keys}. Production silently drops this. Register the ` +
    'event/property in tools/devops/analytics/registry.json and give it a sanitizer ' +
    'rule in apps/desktop/src/shared/analytics-allowlist.ts.'
  );
}

export function failLoudlyOnTelemetryContractViolation(
  violation: TelemetryContractViolation,
  isDevelopment: boolean
): void {
  const error = new Error(telemetryContractViolationMessage(violation));
  console.error(error);
  if (!isDevelopment) return;
  setTimeout(() => {
    throw error;
  }, 0);
}
