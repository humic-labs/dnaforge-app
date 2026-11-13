export const HOSTED_TELEMETRY_ACTOR_HEADER = 'x-dnaforge-telemetry-actor';

export interface HostedTelemetryActorContext {
  readonly actor: string;
  readonly appVersion?: string;
  readonly buildTag?: string;
  readonly releaseChannel?: string;
  readonly assertion?: string;
  readonly ciRunId?: string;
}

const FIELD_LIMITS: Readonly<Record<string, number>> = {
  actor: 32,
  appVersion: 64,
  buildTag: 64,
  releaseChannel: 32,
  assertion: 2048,
  ciRunId: 20,
};

export function parseHostedTelemetryActorContext(
  value: unknown
): HostedTelemetryActorContext | null {
  if (typeof value !== 'string' || value.length > 3072) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.actor !== 'string') return null;
    if (
      Object.entries(record).some(
        ([key, field]) =>
          !Object.prototype.hasOwnProperty.call(FIELD_LIMITS, key) ||
          typeof field !== 'string' ||
          field.length === 0 ||
          field.length > FIELD_LIMITS[key]! ||
          !/^[\x20-\x7e]+$/.test(field)
      )
    )
      return null;
    return {
      actor: record.actor,
      ...(typeof record.appVersion === 'string' ? { appVersion: record.appVersion } : {}),
      ...(typeof record.buildTag === 'string' ? { buildTag: record.buildTag } : {}),
      ...(typeof record.releaseChannel === 'string'
        ? { releaseChannel: record.releaseChannel }
        : {}),
      ...(typeof record.assertion === 'string' ? { assertion: record.assertion } : {}),
      ...(typeof record.ciRunId === 'string' ? { ciRunId: record.ciRunId } : {}),
    };
  } catch {
    return null;
  }
}

export function encodeHostedTelemetryActorContext(
  context: HostedTelemetryActorContext
): string | null {
  try {
    const encoded = JSON.stringify(context);
    return parseHostedTelemetryActorContext(encoded) ? encoded : null;
  } catch {
    return null;
  }
}
