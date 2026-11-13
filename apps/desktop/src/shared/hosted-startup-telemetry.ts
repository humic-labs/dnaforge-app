export const HOSTED_STARTUP_STEPS = [
  'sequence_fonts',
  'platform_init',
  'demo_state',
  'demo_session',
  'file_projections',
  'workspace_session',
  'demo_carry',
  'account_session',
  'shell_render',
] as const;
export const HOSTED_STARTUP_RESULTS = ['shell_requested', 'sign_in_required', 'failed'] as const;
export const HOSTED_STARTUP_ERROR_CLASSES = [
  'none',
  'http_client',
  'http_server',
  'timeout',
  'cancelled',
  'type_error',
  'unknown',
] as const;
export type HostedStartupStep = (typeof HOSTED_STARTUP_STEPS)[number];
export type HostedStartupResult = (typeof HOSTED_STARTUP_RESULTS)[number];
export type HostedStartupErrorClass = (typeof HOSTED_STARTUP_ERROR_CLASSES)[number];

export interface HostedStartupObservation {
  attemptId: string;
  step: HostedStartupStep;
  result: HostedStartupResult;
  errorClass: HostedStartupErrorClass;
  durationMs: number;
  stepDurationMs: number;
}

function member<T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === 'string' && values.some((candidate) => candidate === value);
}

export function parseHostedStartupObservation(value: unknown): HostedStartupObservation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  const keys = new Set([
    'attemptId',
    'step',
    'result',
    'errorClass',
    'durationMs',
    'stepDurationMs',
  ]);
  if (Object.keys(fields).some((key) => !keys.has(key))) return null;
  if (
    typeof fields.attemptId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      fields.attemptId
    ) ||
    !member(HOSTED_STARTUP_STEPS, fields.step) ||
    !member(HOSTED_STARTUP_RESULTS, fields.result) ||
    !member(HOSTED_STARTUP_ERROR_CLASSES, fields.errorClass)
  )
    return null;
  const { durationMs, stepDurationMs } = fields;
  if (
    typeof durationMs !== 'number' ||
    !Number.isSafeInteger(durationMs) ||
    durationMs < 0 ||
    durationMs > 86_400_000 ||
    typeof stepDurationMs !== 'number' ||
    !Number.isSafeInteger(stepDurationMs) ||
    stepDurationMs < 0 ||
    stepDurationMs > durationMs
  )
    return null;
  if ((fields.result === 'failed') !== (fields.errorClass !== 'none')) return null;
  return {
    attemptId: fields.attemptId.toLowerCase(),
    step: fields.step,
    result: fields.result,
    errorClass: fields.errorClass,
    durationMs,
    stepDurationMs,
  };
}
