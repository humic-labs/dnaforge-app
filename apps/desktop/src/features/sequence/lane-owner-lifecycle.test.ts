import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { retainLaneOwner } from './lane-owner-lifecycle';
import { useLaneContractStore } from './lane-contract-store';

function addLane(ownerId: string): void {
  useLaneContractStore.getState().addLane(ownerId, 'grch37', {
    trackType: 'quantitative',
    trackId: 'signal',
    label: 'signal',
    color: 0x2563eb,
    trackPx: 80,
    records: [],
  });
}

describe('lane owner lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useLaneContractStore.getState().clear();
  });

  afterEach(async () => {
    await vi.runAllTimersAsync();
    useLaneContractStore.getState().clear();
    vi.useRealTimers();
  });

  it('does not clear lanes when React releases and reacquires the same owner', async () => {
    addLane('tab-1');
    const releaseOldInstance = retainLaneOwner('tab-1');

    releaseOldInstance();
    const releaseReplacement = retainLaneOwner('tab-1');
    await vi.runAllTimersAsync();

    expect(useLaneContractStore.getState().lanesForOwner('tab-1')).toHaveLength(1);

    releaseReplacement();
    await vi.runAllTimersAsync();
    expect(useLaneContractStore.getState().lanesForOwner('tab-1')).toEqual([]);
  });

  it('also survives a replacement retain that arrives before the old cleanup', async () => {
    addLane('tab-2');
    const releaseOldInstance = retainLaneOwner('tab-2');
    const releaseReplacement = retainLaneOwner('tab-2');

    releaseOldInstance();
    await vi.runAllTimersAsync();
    expect(useLaneContractStore.getState().lanesForOwner('tab-2')).toHaveLength(1);

    releaseReplacement();
    await vi.runAllTimersAsync();
    expect(useLaneContractStore.getState().lanesForOwner('tab-2')).toEqual([]);
  });
});
