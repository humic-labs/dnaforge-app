export interface HostedToolExecutionDenied {
  readonly __dnaforgeHostedExecutionDenied: true;
  readonly code: 'USER_DECLINED';
  readonly reason: string;
}

export interface HostedToolExecutionFailureResult {
  readonly __dnaforgeHostedExecutionFailure: true;
  readonly code?: 'STOPPED' | 'TOOL_FAILED';
  readonly message: string;
}

export function isHostedToolExecutionDenied(value: unknown): value is HostedToolExecutionDenied {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { __dnaforgeHostedExecutionDenied?: unknown }).__dnaforgeHostedExecutionDenied ===
      true &&
    (value as { code?: unknown }).code === 'USER_DECLINED' &&
    typeof (value as { reason?: unknown }).reason === 'string'
  );
}

export function isHostedToolExecutionFailure(
  value: unknown
): value is HostedToolExecutionFailureResult {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { __dnaforgeHostedExecutionFailure?: unknown }).__dnaforgeHostedExecutionFailure ===
      true &&
    ((value as { code?: unknown }).code === undefined ||
      (value as { code?: unknown }).code === 'TOOL_FAILED' ||
      (value as { code?: unknown }).code === 'STOPPED') &&
    typeof (value as { message?: unknown }).message === 'string'
  );
}
