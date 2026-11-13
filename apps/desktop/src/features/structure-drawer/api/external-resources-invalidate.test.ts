// @vitest-environment node

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  EXTERNAL_RESOURCES_INVALIDATE_CHANNEL,
  MAX_IDS_PER_BATCH,
  _resetSubscribersForTesting,
  dispatchExternalResourceInvalidation,
  subscribeToExternalResourceInvalidations,
  type InvalidationPayload,
} from './external-resources-invalidate';

beforeEach(() => {
  _resetSubscribersForTesting();
});

describe('external-resources:invalidate — wire contract', () => {
  it('exposes the channel name as a stable constant', () => {
    expect(EXTERNAL_RESOURCES_INVALIDATE_CHANNEL).toBe('external-resources:invalidate');
  });

  it('caps each batch at MAX_IDS_PER_BATCH = 100', () => {
    expect(MAX_IDS_PER_BATCH).toBe(100);
  });
});

describe('external-resources:invalidate — subscribe + dispatch', () => {
  function makePayload(count: number, reason: 'refreshed' = 'refreshed'): InvalidationPayload {
    return {
      event: 'invalidate',
      reason,
      entries: Array.from({ length: count }, (_, i) => ({
        provider: 'uniprot',
        externalId: `P${String(i).padStart(5, '0')}`,
        newVersion: '178',
      })),
    };
  }

  it('delivers a single in-cap batch to the subscriber', () => {
    const handler = vi.fn();
    subscribeToExternalResourceInvalidations(handler);
    dispatchExternalResourceInvalidation(makePayload(3));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].entries).toHaveLength(3);
  });

  it('splits a 250-id payload into 3 batches (100 / 100 / 50)', () => {
    const handler = vi.fn();
    subscribeToExternalResourceInvalidations(handler);
    dispatchExternalResourceInvalidation(makePayload(250));
    expect(handler).toHaveBeenCalledTimes(3);
    expect(handler.mock.calls[0][0].entries).toHaveLength(100);
    expect(handler.mock.calls[1][0].entries).toHaveLength(100);
    expect(handler.mock.calls[2][0].entries).toHaveLength(50);
  });

  it('delivers to every subscriber', () => {
    const a = vi.fn();
    const b = vi.fn();
    subscribeToExternalResourceInvalidations(a);
    subscribeToExternalResourceInvalidations(b);
    dispatchExternalResourceInvalidation(makePayload(2));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe stops further deliveries', () => {
    const handler = vi.fn();
    const off = subscribeToExternalResourceInvalidations(handler);
    off();
    dispatchExternalResourceInvalidation(makePayload(1));
    expect(handler).not.toHaveBeenCalled();
  });

  it('isolates a subscriber that throws so siblings still fire', () => {
    const broken = vi.fn(() => {
      throw new Error('boom');
    });
    const sibling = vi.fn();
    subscribeToExternalResourceInvalidations(broken);
    subscribeToExternalResourceInvalidations(sibling);
    dispatchExternalResourceInvalidation(makePayload(1));
    expect(broken).toHaveBeenCalled();
    expect(sibling).toHaveBeenCalledTimes(1);
  });

  it('treats an empty payload as a no-op', () => {
    const handler = vi.fn();
    subscribeToExternalResourceInvalidations(handler);
    dispatchExternalResourceInvalidation({
      event: 'invalidate',
      reason: 'evicted',
      entries: [],
    });
    expect(handler).not.toHaveBeenCalled();
  });
});
