// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  BBI_RANGE_GRANT_EXPIRED_ERROR_NAME,
  findBbiRangeGrantExpiredError,
  throwIfBbiRangeGrantExpiredResponse,
} from './bbi-range-grant-recovery';

describe('BBI range grant recovery contract', () => {
  it('recognizes only the sidecar missing-grant response and survives fetch wrapping', async () => {
    const response = new Response(
      JSON.stringify({
        detail: {
          error: 'range_read_failed',
          failure_kind: 'grant_expired',
          message: 'The remote range grant is missing or expired',
        },
      }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );

    let expired: Error | null = null;
    try {
      await throwIfBbiRangeGrantExpiredResponse(response);
    } catch (error) {
      expired = error as Error;
    }
    expect(expired?.name).toBe(BBI_RANGE_GRANT_EXPIRED_ERROR_NAME);
    expect(findBbiRangeGrantExpiredError(new Error('wrapped', { cause: expired }))).toBe(expired);
  });

  it('does not classify other range failures as an expired grant', async () => {
    const response = new Response(
      JSON.stringify({
        detail: {
          error: 'range_read_failed',
          failure_kind: 'remote_http_error',
          message: 'The remote track request failed (HTTP 503)',
        },
      }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );

    await expect(throwIfBbiRangeGrantExpiredResponse(response)).resolves.toBeUndefined();
  });
});
