import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IncludedAllowanceReadResult } from '@waypoint/hosted-ai-contract/included-allowance';
import { electronBridge } from './electron';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Electron included allowance bridge', () => {
  it('reads the current preload session on every call without supplying identity arguments', async () => {
    const observation: Extract<IncludedAllowanceReadResult, { status: 'observed' }> = {
      status: 'observed',
      accountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      desktopSessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
      environment: 'production',
      unit: 'microusd',
      observedAt: Date.parse('2026-10-26T00:00:00Z'),
      periodStart: '2026-10-01',
      periodEnd: '2026-11-01',
      remainingIncludedMicros: 7_654_321,
    };
    const first = vi.fn(async () => observation);
    vi.stubGlobal('window', { electronAPI: { hostedAi: { readIncludedAllowance: first } } });
    await expect(electronBridge.hostedAi.readIncludedAllowance()).resolves.toBe(observation);
    expect(first).toHaveBeenCalledExactlyOnceWith();
    const changed = { ...observation, desktopSessionId: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1' };
    const second = vi.fn(async () => changed);
    vi.stubGlobal('window', { electronAPI: { hostedAi: { readIncludedAllowance: second } } });
    await expect(electronBridge.hostedAi.readIncludedAllowance()).resolves.toBe(changed);
    expect(second).toHaveBeenCalledExactlyOnceWith();
  });

  it('preserves an explicit unavailable response instead of substituting a balance', async () => {
    const result: IncludedAllowanceReadResult = {
      status: 'unavailable',
      code: 'session_unavailable',
    };
    const read = vi.fn(async () => result);
    vi.stubGlobal('window', { electronAPI: { hostedAi: { readIncludedAllowance: read } } });
    await expect(electronBridge.hostedAi.readIncludedAllowance()).resolves.toBe(result);
    expect(read).toHaveBeenCalledExactlyOnceWith();
  });
});
