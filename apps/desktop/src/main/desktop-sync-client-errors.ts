export type DesktopSyncClientErrorCode =
  | 'SIGNED_OUT'
  | 'SESSION_REVOKED'
  | 'ACCOUNT_CHANGED'
  | 'NETWORK'
  | 'CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'MANIFEST_RESTORE_REQUIRED'
  | 'RECOVERY_CANDIDATE_EXPIRED'
  | 'QUOTA_EXCEEDED'
  | 'RATE_LIMITED'
  | 'SERVER'
  | 'IN_PROGRESS'
  | 'BAD_RESPONSE'
  | 'VALIDATION'
  | 'UPGRADE_REQUIRED'
  | 'FEATURE_DISABLED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'NOT_CONFIGURED'
  | 'UNKNOWN';

export class DesktopSyncClientError extends Error {
  constructor(
    readonly code: DesktopSyncClientErrorCode,
    message: string,
    readonly options: {
      status?: number;
      retryable: boolean;
      terminal: boolean;
      authPaused?: boolean;
      details?: Record<string, unknown>;
    }
  ) {
    super(message);
    this.name = 'DesktopSyncClientError';
  }

  get status(): number | undefined {
    return this.options.status;
  }

  get retryable(): boolean {
    return this.options.retryable;
  }

  get terminal(): boolean {
    return this.options.terminal;
  }

  get authPaused(): boolean {
    return this.options.authPaused ?? false;
  }

  get details(): Record<string, unknown> | undefined {
    return this.options.details;
  }
}
