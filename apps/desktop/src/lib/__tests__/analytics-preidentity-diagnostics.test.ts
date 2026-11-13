// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPreidentityDiagnostics } from '../analytics-preidentity-diagnostics';
import type { AnalyticsIdentitySyncResult } from '../../shared/analytics-types';

let monotonicMs = 1_000;
let owners: Array<ReturnType<typeof createPreidentityDiagnostics>> = [];

function fixture() {
  const profile = { enabled: true };
  const owner = createPreidentityDiagnostics(
    () => profile.enabled,
    (generation) => ({
      ready: false,
      consentClass: 'on',
      generation,
      pendingCount: 1,
      pendingHead: 0,
      publicControlCount: 1,
      occurrenceClockRange: { first: 100, last: 100 },
      syntheticSentinelPresent: false,
    })
  );
  owners.push(owner);
  owner.armNext();
  owner.transitionStarted(1);
  const gate = owner.publicationGate()!;
  expect(gate).toBeTypeOf('function');
  return { owner, gate, profile };
}

function nativeResult(accepted = true): AnalyticsIdentitySyncResult {
  return {
    accepted,
    authority: accepted
      ? { actorKind: 'test', executionMode: 'synthetic', impersonated: false }
      : { actorKind: 'unknown', executionMode: 'interactive', impersonated: false },
  };
}

describe('preidentity diagnostic monotonic deadline', () => {
  beforeEach(() => {
    owners = [];
    monotonicMs = 1_000;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(globalThis.performance, 'now').mockImplementation(() => monotonicMs);
  });

  afterEach(() => {
    for (const owner of owners) owner.dispose();
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('releases at 1999ms and does not retroactively expire a completed release', async () => {
    const { owner, gate } = fixture();
    const original = nativeResult();
    const published = gate(original);
    expect(await owner.waitForNativeResult()).toBe(original);
    monotonicMs = 2_999;
    expect(vi.getTimerCount()).toBe(1);
    expect(await owner.release()).toBe(original);
    expect(await published).toBe(original);
    expect(vi.getTimerCount()).toBe(0);
    monotonicMs = 5_000;
    expect(owner.read().generation).toBe(1);
    expect(await owner.waitForNativeResult()).toBe(original);
    expect(() => owner.armNext()).toThrow('cancelled');
    await expect(owner.release()).rejects.toThrow('cancelled');
  });

  it.each([true, false])(
    'expires at exactly 2000ms without timer delivery; original accepted=%s',
    async (accepted) => {
      const { owner, gate } = fixture();
      const original = nativeResult(accepted);
      const authority = original.authority;
      const published = gate(original);
      expect(await owner.waitForNativeResult()).toBe(original);
      monotonicMs = 3_000;
      expect(vi.getTimerCount()).toBe(1);
      await expect(owner.release()).rejects.toThrow('cancelled');
      expect(await published).toBe(original);
      expect(original.authority).toBe(authority);
      expect(original.accepted).toBe(accepted);
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it('expires an unobserved waiter but forwards an original still in flight unchanged', async () => {
    const { owner, gate } = fixture();
    const original = nativeResult();
    let resolveNative!: (value: AnalyticsIdentitySyncResult) => void;
    const originalNative = new Promise<AnalyticsIdentitySyncResult>((resolve) => {
      resolveNative = resolve;
    });
    const published = originalNative.then(gate);
    const rejectedWaiter = expect(owner.waitForNativeResult()).rejects.toThrow('cancelled');
    monotonicMs = 3_001;
    expect(vi.getTimerCount()).toBe(1);
    await expect(owner.release()).rejects.toThrow('cancelled');
    await rejectedWaiter;
    resolveNative(original);
    expect(await originalNative).toBe(original);
    expect(await published).toBe(original);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reconciles after release awaits native even when native resolved just before the boundary', async () => {
    const { owner, gate } = fixture();
    const original = nativeResult();
    monotonicMs = 2_999;
    const rejectedRelease = expect(owner.release()).rejects.toThrow('cancelled');
    const published = gate(original);
    monotonicMs = 3_000;
    expect(vi.getTimerCount()).toBe(1);
    await rejectedRelease;
    expect(await published).toBe(original);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reconciles the native diagnostic waiter continuation without changing the original publication', async () => {
    const { owner, gate } = fixture();
    const original = nativeResult();
    const rejectedWaiter = expect(owner.waitForNativeResult()).rejects.toThrow('cancelled');
    monotonicMs = 2_999;
    const published = gate(original);
    monotonicMs = 3_000;
    expect(vi.getTimerCount()).toBe(1);
    await rejectedWaiter;
    expect(await published).toBe(original);
  });

  it('reconciles expiry on a read without requiring a release or timer task', async () => {
    const { owner, gate } = fixture();
    const rejectedWaiter = expect(owner.waitForNativeResult()).rejects.toThrow('cancelled');
    monotonicMs = 3_000;
    expect(vi.getTimerCount()).toBe(1);
    expect(owner.read().publicControlCount).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    await rejectedWaiter;
    const original = nativeResult();
    expect(await gate(original)).toBe(original);
  });

  it.each(['cancel', 'dispose', 'profile-disabled', 'new-generation'] as const)(
    'preserves the %s fence when expiry callback is overdue',
    async (fence) => {
      const { owner, gate, profile } = fixture();
      const original = nativeResult();
      const authority = original.authority;
      const rejectedWaiter = expect(owner.waitForNativeResult()).rejects.toThrow('cancelled');
      monotonicMs = 3_000;
      expect(vi.getTimerCount()).toBe(1);
      if (fence === 'cancel') owner.cancel();
      else if (fence === 'dispose') owner.dispose();
      else if (fence === 'new-generation') owner.transitionStarted(2);
      else {
        profile.enabled = false;
        expect(() => owner.read()).toThrow('cancelled');
      }
      await rejectedWaiter;
      await expect(gate(original)).rejects.toThrow('cancelled');
      expect(original.accepted).toBe(true);
      expect(original.authority).toBe(authority);
      expect(vi.getTimerCount()).toBe(0);
    }
  );
});
