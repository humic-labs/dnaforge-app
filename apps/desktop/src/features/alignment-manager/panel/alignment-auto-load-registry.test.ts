// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAlignmentAutoLoadLifecycleSnapshot,
  resetAlignmentAutoLoadRegistryForTests,
  startAlignmentEnrichmentAutoLoad,
  subscribeAlignmentAutoLoadCapacity,
} from './alignment-auto-load-registry';

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
}

describe('alignment auto-load admission', () => {
  beforeEach(resetAlignmentAutoLoadRegistryForTests);
  afterEach(resetAlignmentAutoLoadRegistryForTests);

  it('wakes a capped caller after a physical operation settles', async () => {
    const pending = Array.from({ length: 33 }, () => deferred());
    const onRejected = (): void => undefined;
    for (let index = 0; index < 32; index += 1) {
      expect(
        startAlignmentEnrichmentAutoLoad({
          key: `document-${index}`,
          run: () => pending[index].promise,
          onRejected,
        })
      ).toBe('started');
    }
    expect(
      startAlignmentEnrichmentAutoLoad({
        key: 'document-32',
        run: () => pending[32].promise,
        onRejected,
      })
    ).toBe('capacity');
    expect(getAlignmentAutoLoadLifecycleSnapshot()).toMatchObject({
      enrichmentInFlight: 32,
      enrichmentStarted: 32,
      enrichmentSettled: 0,
      enrichmentRefused: 1,
      enrichmentPeakInFlight: 32,
    });

    let notifications = 0;
    let resolveNotification: (() => void) | undefined;
    const notification = new Promise<void>((resolve) => {
      resolveNotification = resolve;
    });
    const unsubscribe = subscribeAlignmentAutoLoadCapacity('enrichment', 'document-32', () => {
      notifications += 1;
      resolveNotification?.();
    });
    pending[0].resolve();
    await notification;

    expect(notifications).toBe(1);
    expect(
      startAlignmentEnrichmentAutoLoad({
        key: 'document-32',
        run: () => pending[32].promise,
        onRejected,
      })
    ).toBe('started');

    unsubscribe();
    for (const operation of pending) operation.resolve();
    await Promise.all(pending.map((operation) => operation.promise));
    await vi.waitFor(() =>
      expect(getAlignmentAutoLoadLifecycleSnapshot()).toMatchObject({
        enrichmentInFlight: 0,
        enrichmentStarted: 33,
        enrichmentSettled: 33,
        enrichmentRefused: 1,
        enrichmentPeakInFlight: 32,
      })
    );
  });

  it('drains 33 no-op owners once without a global retry storm', async () => {
    const onRejected = (): void => undefined;
    for (let index = 0; index < 32; index += 1) {
      expect(
        startAlignmentEnrichmentAutoLoad({
          key: `no-op-${index}`,
          run: () => Promise.resolve(),
          onRejected,
        })
      ).toBe('started');
    }
    expect(
      startAlignmentEnrichmentAutoLoad({
        key: 'no-op-32',
        run: () => Promise.resolve(),
        onRejected,
      })
    ).toBe('capacity');

    let retryStatus: string | null = null;
    subscribeAlignmentAutoLoadCapacity('enrichment', 'no-op-32', () => {
      retryStatus = startAlignmentEnrichmentAutoLoad({
        key: 'no-op-32',
        run: () => Promise.resolve(),
        onRejected,
      });
    });

    await vi.waitFor(() => {
      expect(retryStatus).toBe('started');
      expect(getAlignmentAutoLoadLifecycleSnapshot()).toMatchObject({
        enrichmentInFlight: 0,
        enrichmentStarted: 33,
        enrichmentSettled: 33,
        enrichmentRefused: 1,
        capacitySubscribers: 0,
        capacityWaitingKeys: 0,
      });
    });
  });
});
