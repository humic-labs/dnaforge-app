import { describe, expect, it } from 'vitest';

import type { ManagedOperationsSnapshot } from '../../../services/managed-operations';
import { watchTrackRegistrations } from './track-registration-refresh';

function snapshotWith(
  records: readonly { readonly id: string; readonly kind: string; readonly state: string }[]
): ManagedOperationsSnapshot {
  return {
    status: 'connected',
    scopeId: 'scope',
    ownerId: null,
    ownerInstanceId: null,
    records: records.map((record) => ({
      snapshot: record as unknown as ManagedOperationsSnapshot['records'][number]['snapshot'],
      observation: { freshness: 'current', observedAtMs: 0 },
    })),
    historySummary: null,
    supportedActionsByKind: {},
    kindCatalogByKind: {},
    reconnectAvailable: false,
  };
}

function fakeSource(initial: ManagedOperationsSnapshot) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next: ManagedOperationsSnapshot) {
      snapshot = next;
      for (const listener of listeners) listener();
    },
  };
}

describe('watchTrackRegistrations', () => {
  it('refreshes once per newly succeeded registration and ignores history, failures and other kinds', async () => {
    const source = fakeSource(
      snapshotWith([{ id: 'old', kind: 'track-registration', state: 'succeeded' }])
    );
    let refreshes = 0;
    const stop = watchTrackRegistrations(source, async () => {
      refreshes += 1;
    });
    expect(refreshes).toBe(0);

    source.set(
      snapshotWith([
        { id: 'old', kind: 'track-registration', state: 'succeeded' },
        { id: 'running', kind: 'track-registration', state: 'running' },
        { id: 'other', kind: 'genome-indexing', state: 'succeeded' },
      ])
    );
    expect(refreshes).toBe(0);

    source.set(
      snapshotWith([
        { id: 'old', kind: 'track-registration', state: 'succeeded' },
        { id: 'running', kind: 'track-registration', state: 'succeeded' },
        { id: 'failed', kind: 'track-registration', state: 'failed' },
      ])
    );
    expect(refreshes).toBe(1);

    source.set(
      snapshotWith([
        { id: 'old', kind: 'track-registration', state: 'succeeded' },
        { id: 'running', kind: 'track-registration', state: 'succeeded' },
      ])
    );
    expect(refreshes).toBe(1);

    stop();
    source.set(snapshotWith([{ id: 'late', kind: 'track-registration', state: 'succeeded' }]));
    expect(refreshes).toBe(1);
  });
});
