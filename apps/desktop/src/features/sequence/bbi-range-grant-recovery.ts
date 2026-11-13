export const BBI_RANGE_GRANT_EXPIRED_ERROR_NAME = 'BbiRangeGrantExpiredError';

export async function throwIfBbiRangeGrantExpiredResponse(response: Response): Promise<void> {
  if (response.ok) return;
  try {
    const body = (await response.clone().json()) as {
      detail?: { error?: unknown; failure_kind?: unknown; message?: unknown };
    };
    if (
      body.detail?.error === 'range_read_failed' &&
      body.detail.failure_kind === 'grant_expired' &&
      typeof body.detail.message === 'string'
    ) {
      const error = new Error(body.detail.message);
      error.name = BBI_RANGE_GRANT_EXPIRED_ERROR_NAME;
      throw error;
    }
  } catch (error) {
    if (isBbiRangeGrantExpiredError(error)) throw error;
  }
}

export function isBbiRangeGrantExpiredError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === BBI_RANGE_GRANT_EXPIRED_ERROR_NAME
  );
}

export function findBbiRangeGrantExpiredError(error: unknown): Error | null {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    if (isBbiRangeGrantExpiredError(current)) return current as Error;
    current =
      typeof current === 'object' && current !== null && 'cause' in current ? current.cause : null;
  }
  return null;
}
