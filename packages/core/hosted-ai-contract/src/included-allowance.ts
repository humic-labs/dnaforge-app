export type IncludedAllowanceUnavailableCode =
  | 'not_configured'
  | 'signed_out'
  | 'session_changed'
  | 'read_unavailable'
  | 'session_unavailable'
  | 'allowance_not_initialized'
  | 'invalid_observation';

export type IncludedAllowanceReadResult =
  | {
      readonly status: 'observed';
      readonly accountId: string;
      readonly desktopSessionId: string;
      readonly environment: 'development' | 'staging' | 'production';
      readonly unit: 'microusd';
      readonly observedAt: number;
      readonly periodStart: string;
      readonly periodEnd: string;
      readonly remainingIncludedMicros: number;
    }
  | { readonly status: 'unavailable'; readonly code: IncludedAllowanceUnavailableCode };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function monthStart(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-01$/.test(value)) return undefined;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value
    ? timestamp
    : undefined;
}

export function parseIncludedAllowanceReadResult(
  value: unknown,
  identity: { readonly accountId: string; readonly desktopSessionId: string }
): IncludedAllowanceReadResult | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if ('status' in value && value.status === 'unavailable' && 'code' in value) {
    switch (value.code) {
      case 'not_configured':
      case 'signed_out':
      case 'session_changed':
      case 'read_unavailable':
      case 'session_unavailable':
      case 'allowance_not_initialized':
      case 'invalid_observation':
        return { status: 'unavailable', code: value.code };
      default:
        return undefined;
    }
  }
  if (
    !('status' in value) ||
    value.status !== 'observed' ||
    !('accountId' in value) ||
    typeof value.accountId !== 'string' ||
    !UUID.test(value.accountId) ||
    value.accountId !== identity.accountId ||
    !('desktopSessionId' in value) ||
    typeof value.desktopSessionId !== 'string' ||
    !UUID.test(value.desktopSessionId) ||
    value.desktopSessionId !== identity.desktopSessionId ||
    !('environment' in value) ||
    !('unit' in value) ||
    value.unit !== 'microusd' ||
    !('observedAt' in value) ||
    typeof value.observedAt !== 'number' ||
    !Number.isSafeInteger(value.observedAt) ||
    !('remainingIncludedMicros' in value) ||
    typeof value.remainingIncludedMicros !== 'number' ||
    !Number.isSafeInteger(value.remainingIncludedMicros) ||
    value.remainingIncludedMicros < 0 ||
    !('periodStart' in value) ||
    typeof value.periodStart !== 'string' ||
    !('periodEnd' in value) ||
    typeof value.periodEnd !== 'string'
  )
    return undefined;
  const { environment } = value;
  if (environment !== 'development' && environment !== 'staging' && environment !== 'production')
    return undefined;
  const start = monthStart(value.periodStart);
  const end = monthStart(value.periodEnd);
  if (
    start === undefined ||
    end === undefined ||
    new Date(start).setUTCMonth(new Date(start).getUTCMonth() + 1) !== end ||
    value.observedAt < start ||
    value.observedAt >= end
  )
    return undefined;
  return {
    status: 'observed',
    accountId: value.accountId,
    desktopSessionId: value.desktopSessionId,
    environment,
    unit: 'microusd',
    observedAt: value.observedAt,
    periodStart: value.periodStart,
    periodEnd: value.periodEnd,
    remainingIncludedMicros: value.remainingIncludedMicros,
  };
}
