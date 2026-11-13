export interface SentryErrorPolicyEvent {
  message?: string;
  logentry?: { message?: string };
  level?: string;
  platform?: string;
  type?: string;
  release?: string;
  environment?: string;
  exception?: { values?: unknown[] };
  fingerprint?: string[];
  tags?: Record<string, unknown>;
  contexts?: Record<string, Record<string, unknown> | undefined>;
}

export function operationalFailureContext(operation: string) {
  if (!/^[a-z0-9][a-z0-9_.:-]{0,127}$/i.test(operation)) {
    throw new Error('An operational failure requires a stable operation code');
  }
  return {
    tags: { error_report_kind: 'operational_failure', error_operation: operation },
    fingerprint: ['operational_failure', operation],
  };
}

export function createSentryErrorPolicy({
  now = Date.now,
  repeatWindowMs = 5 * 60 * 1000,
  maxTrackedKeys = 256,
}: {
  now?: () => number;
  repeatWindowMs?: number;
  maxTrackedKeys?: number;
} = {}) {
  if (!Number.isFinite(repeatWindowMs) || repeatWindowMs <= 0) {
    throw new Error('The error repetition window must be positive');
  }
  if (!Number.isInteger(maxTrackedKeys) || maxTrackedKeys <= 0) {
    throw new Error('The tracked error limit must be a positive integer');
  }
  const operations = new Map<string, { sentAt: number; suppressed: number }>();

  return <T extends SentryErrorPolicyEvent>(event: T): T | null => {
    if (
      event.exception ||
      event.level === 'fatal' ||
      event.platform === 'native' ||
      ['transaction', 'profile', 'replay_event', 'feedback'].includes(event.type ?? '') ||
      !(event.message || event.logentry?.message)
    ) {
      return event;
    }
    const operation = event.tags?.error_operation;
    if (
      event.tags?.error_report_kind !== 'operational_failure' ||
      typeof operation !== 'string' ||
      !/^[a-z0-9][a-z0-9_.:-]{0,127}$/i.test(operation)
    ) {
      return null;
    }
    const key = JSON.stringify([
      operation,
      event.fingerprint,
      event.release,
      event.environment,
      event.tags?.error_incident_id,
    ]);
    const time = now();
    const retentionMs = Math.max(repeatWindowMs * 12, 60 * 60 * 1000);
    for (const [trackedKey, state] of operations) {
      if (time - state.sentAt >= retentionMs) operations.delete(trackedKey);
    }
    const previous = operations.get(key);
    if (previous && time >= previous.sentAt && time - previous.sentAt < repeatWindowMs) {
      previous.suppressed += 1;
      return null;
    }
    if (previous?.suppressed) {
      event.contexts = {
        ...event.contexts,
        error_reporting: {
          ...event.contexts?.error_reporting,
          suppressed_repeats: previous.suppressed,
          repeat_window_ms: repeatWindowMs,
        },
      };
    }
    operations.delete(key);
    if (operations.size >= maxTrackedKeys) {
      const oldest = operations.keys().next().value;
      if (oldest !== undefined) operations.delete(oldest);
    }
    operations.set(key, { sentAt: time, suppressed: 0 });
    return event;
  };
}
