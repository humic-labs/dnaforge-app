export const ActionErrorCode = Object.freeze({
  BAD_INPUT: 'BAD_INPUT',
  STALE_STATE: 'STALE_STATE',
  SCOPE_DENIED: 'SCOPE_DENIED',
  EXECUTION_FAILED: 'EXECUTION_FAILED',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
} as const);

export type ActionErrorCode = (typeof ActionErrorCode)[keyof typeof ActionErrorCode];

export const ALL_ACTION_ERROR_CODES: readonly ActionErrorCode[] = Object.freeze(
  Object.values(ActionErrorCode)
);

const ACTION_ERROR_CODE_SET: ReadonlySet<string> = new Set<string>(ALL_ACTION_ERROR_CODES);

export function isActionErrorCode(value: unknown): value is ActionErrorCode {
  return typeof value === 'string' && ACTION_ERROR_CODE_SET.has(value);
}

export interface ActionErrorPayload {
  code: ActionErrorCode;
  message: string;
  retriable: boolean;
  details?: Record<string, unknown>;
}

export interface ActionErrorOptions {
  cause?: unknown;
  retriable?: boolean;
  details?: Record<string, unknown>;
}

function defaultRetriable(code: ActionErrorCode): boolean {
  return code === ActionErrorCode.STALE_STATE;
}

export const ACTION_ERROR_BRAND: unique symbol = Symbol.for('@waypoint/agent-tools.ActionError');

export class ActionError extends Error {
  readonly code: ActionErrorCode;
  readonly retriable: boolean;
  readonly details?: Record<string, unknown>;
  readonly [ACTION_ERROR_BRAND] = true as const;

  constructor(code: ActionErrorCode, message: string, options: ActionErrorOptions = {}) {
    super(message);
    this.name = 'ActionError';
    if (!isActionErrorCode(code)) {
      throw new TypeError(
        `ActionError: invalid code ${JSON.stringify(code)}. ` +
          `Must be one of: ${ALL_ACTION_ERROR_CODES.join(', ')}.`
      );
    }
    this.code = code;
    this.retriable = options.retriable ?? defaultRetriable(code);
    if (options.details) this.details = options.details;
    if (options.cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        value: options.cause,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    }
  }

  toPayload(): ActionErrorPayload {
    const payload: ActionErrorPayload = {
      code: this.code,
      message: this.message,
      retriable: this.retriable,
    };
    if (this.details) payload.details = this.details;
    return payload;
  }
}

export function isActionError(value: unknown): value is ActionError {
  if (value instanceof ActionError) return true;
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as {
    [ACTION_ERROR_BRAND]?: unknown;
    code?: unknown;
    message?: unknown;
    toPayload?: unknown;
  };
  return (
    candidate[ACTION_ERROR_BRAND] === true &&
    typeof candidate.code === 'string' &&
    ACTION_ERROR_CODE_SET.has(candidate.code) &&
    typeof candidate.message === 'string' &&
    typeof candidate.toPayload === 'function'
  );
}
