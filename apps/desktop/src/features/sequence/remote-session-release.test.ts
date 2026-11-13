import type { TileTransport } from '@waypoint/genome-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useLaneContractStore } from './lane-contract-store';
import { buildReadPileupDataset } from './read-pileup-import';
import {
  disconnectRemoteSessionsAfterRendererDrain,
  forgetRemoteSessionLease,
  registerRemoteSessionLease,
} from './remote-session-release';
import { trackRemoteTileSessionTransport } from './remote-tile-session-drain';

const { disconnectSession } = vi.hoisted(() => ({
  disconnectSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../platform', () => ({
  platform: () => ({ remoteGenomics: { disconnectSession } }),
}));

function addRemoteLane(
  sessionId: string,
  ownerId = 'tab-1',
  sourceId = `source-${sessionId}`
): void {
  useLaneContractStore.getState().addLane(
    ownerId,
    'grch37',
    buildReadPileupDataset({
      assemblyId: 'grch37',
      assemblyDisplayName: 'GRCh37',
      bamPath: `http://127.0.0.1:43119/v1/${sourceId}/alignment.cram`,
      indexPath: `/tmp/${sessionId}/alignment.cram.crai`,
      remote: {
        locator: {
          contract: 'remote-alignment-locator.v1',
          endpointId: 'endpoint-1',
          target: 'lab-hpc',
          alignmentPath: '/data/alignment.cram',
          indexPath: '/data/alignment.cram.crai',
        },
        sessionId,
      },
    })
  );
}

function addRemoteSignalLane(sourceId: string, ownerId = 'tab-1'): void {
  const uri = `http://127.0.0.1:43119/v1/${sourceId}/signal.bigWig`;
  useLaneContractStore.getState().addLane(
    ownerId,
    'grch37',
    {
      trackType: 'quantitative',
      trackId: 'remote-signal',
      label: 'signal.bigWig',
      color: 0x2563eb,
      trackPx: 96,
      records: [],
      kind: 'annotation',
    },
    true,
    {
      admissionVersion: 1,
      uri,
      input: { kind: 'url', url: uri },
      formatId: 'bigwig',
      readerKind: 'bbi',
      scientificKind: 'quantitative',
      assemblyId: 'grch37',
      referenceReceipt: {
        assemblyId: 'grch37',
        referenceSignature: 'chr1',
        sourceSignature: 'chr1',
        contigMap: { chr1: 'chr1' },
        checkedContigs: 1,
        status: 'compatible',
        checkedAt: '2026-09-24T00:00:00.000Z',
      },
      provenance: {
        provider: 'direct-url',
        sourceKind: 'remote-url',
        label: 'signal.bigWig',
      },
      fingerprint: `remote-signal\u0000ssh://lab-hpc/data/signal.bigWig\u0000${uri}\u00001024`,
      expectedValidators: { contentLength: 1_024 },
    }
  );
}

function replaceRemoteLane(
  previousSessionId: string,
  sessionId: string,
  sourceId: string,
  ownerId = 'tab-1'
): string {
  const store = useLaneContractStore.getState();
  const lane = store
    .lanesForOwner(ownerId)
    .find((candidate) => candidate.dataset.source?.remote?.sessionId === previousSessionId)!;
  expect(lane).toBeDefined();
  const previous = lane.dataset.source!;
  expect(
    store.replaceLaneDataset(ownerId, lane.dataset.trackId, 'grch37', {
      ...lane.dataset,
      source: {
        ...previous,
        bamPath: `http://127.0.0.1:43119/v1/${sourceId}/alignment.cram`,
        remote: { ...previous.remote!, sessionId },
      },
    })
  ).toBe('replaced');
  return lane.dataset.trackId;
}

describe('remote session release', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    disconnectSession.mockClear();
    useLaneContractStore.getState().clear();
  });

  afterEach(async () => {
    useLaneContractStore.getState().clear();
    await vi.runAllTimersAsync();
    vi.useRealTimers();
  });

  it('keeps a drained SSH session alive while a surviving lane still references it', async () => {
    addRemoteLane('session-survives-remount');

    disconnectRemoteSessionsAfterRendererDrain(['session-survives-remount']);
    await vi.runAllTimersAsync();

    expect(disconnectSession).not.toHaveBeenCalled();

    useLaneContractStore
      .getState()
      .removeLane(
        'tab-1',
        useLaneContractStore.getState().lanesForOwner('tab-1')[0]!.dataset.trackId
      );
    await vi.runAllTimersAsync();

    expect(disconnectSession).toHaveBeenCalledTimes(1);
    expect(disconnectSession).toHaveBeenCalledWith('session-survives-remount');
  });

  it('keeps the tunnel alive while its sibling BigWig still owns the loopback URL', async () => {
    const sessionId = 'session-with-signal';
    const sourceId = 'stable-source-with-signal';
    registerRemoteSessionLease({ laneOwnerId: 'tab-1', sessionId, sourceId });
    addRemoteLane(sessionId, 'tab-1', sourceId);
    addRemoteSignalLane(sourceId);

    disconnectRemoteSessionsAfterRendererDrain([sessionId]);
    const alignmentTrackId = useLaneContractStore.getState().lanesForOwner('tab-1')[0]!.dataset
      .trackId;
    useLaneContractStore.getState().removeLane('tab-1', alignmentTrackId);
    await vi.runAllTimersAsync();

    expect(disconnectSession).not.toHaveBeenCalled();

    useLaneContractStore.getState().removeLane('tab-1', 'remote-signal');
    await vi.runAllTimersAsync();
    expect(disconnectSession).toHaveBeenCalledWith(sessionId);
  });

  it('releases a closed view independently of another view on the same pooled source', async () => {
    const sourceId = 'pooled-source-for-two-views';
    const firstLease = 'first-view-lease';
    const secondLease = 'second-view-lease';
    registerRemoteSessionLease({ laneOwnerId: 'tab-1', sessionId: firstLease, sourceId });
    registerRemoteSessionLease({ laneOwnerId: 'tab-2', sessionId: secondLease, sourceId });
    addRemoteLane(firstLease, 'tab-1', sourceId);
    addRemoteSignalLane(sourceId, 'tab-1');
    addRemoteLane(secondLease, 'tab-2', sourceId);
    addRemoteSignalLane(sourceId, 'tab-2');

    disconnectRemoteSessionsAfterRendererDrain([firstLease, secondLease]);
    useLaneContractStore.getState().clearOwner('tab-1');
    await vi.runAllTimersAsync();
    expect(disconnectSession.mock.calls).toEqual([[firstLease]]);
    expect(useLaneContractStore.getState().lanesForOwner('tab-2')).toHaveLength(2);

    const secondReads = useLaneContractStore.getState().lanesForOwner('tab-2')[0]!.dataset.trackId;
    useLaneContractStore.getState().removeLane('tab-2', secondReads);
    await vi.runAllTimersAsync();
    expect(disconnectSession.mock.calls).toEqual([[firstLease]]);

    useLaneContractStore.getState().removeLane('tab-2', 'remote-signal');
    await vi.runAllTimersAsync();
    expect(disconnectSession.mock.calls).toEqual([[firstLease], [secondLease]]);
  });

  it('releases superseded leases after repeated same-source reconnects with a signal sibling', async () => {
    const sourceId = 'stable-source-for-reconnects';
    let sessionId = 'reconnect-lease-0';
    registerRemoteSessionLease({ laneOwnerId: 'tab-1', sessionId, sourceId });
    addRemoteLane(sessionId, 'tab-1', sourceId);
    addRemoteSignalLane(sourceId);

    for (let index = 1; index <= 3; index += 1) {
      const replacementId = `reconnect-lease-${index}`;
      registerRemoteSessionLease({ laneOwnerId: 'tab-1', sessionId: replacementId, sourceId });
      replaceRemoteLane(sessionId, replacementId, sourceId);
      disconnectRemoteSessionsAfterRendererDrain([sessionId]);
      await vi.runAllTimersAsync();
      sessionId = replacementId;
    }

    expect(useLaneContractStore.getState().lanesForOwner('tab-1')).toHaveLength(2);
    expect(disconnectSession.mock.calls).toEqual([
      ['reconnect-lease-0'],
      ['reconnect-lease-1'],
      ['reconnect-lease-2'],
    ]);

    disconnectRemoteSessionsAfterRendererDrain([sessionId]);
  });

  it('hands off signal retention when a replacement primary is published after release already waits', async () => {
    const sourceId = 'waiting-source-with-signal';
    const oldSessionId = 'waiting-old-lease';
    const newSessionId = 'waiting-new-lease';
    registerRemoteSessionLease({ laneOwnerId: 'tab-1', sessionId: oldSessionId, sourceId });
    addRemoteLane(oldSessionId, 'tab-1', sourceId);
    addRemoteSignalLane(sourceId);
    disconnectRemoteSessionsAfterRendererDrain([oldSessionId]);
    await vi.runAllTimersAsync();
    expect(disconnectSession).not.toHaveBeenCalled();

    registerRemoteSessionLease({ laneOwnerId: 'tab-1', sessionId: newSessionId, sourceId });
    const trackId = replaceRemoteLane(oldSessionId, newSessionId, sourceId);
    await vi.runAllTimersAsync();
    expect(disconnectSession.mock.calls).toEqual([[oldSessionId]]);

    useLaneContractStore.getState().removeLane('tab-1', trackId);
    disconnectRemoteSessionsAfterRendererDrain([newSessionId]);
    await vi.runAllTimersAsync();
    expect(disconnectSession.mock.calls).toEqual([[oldSessionId]]);
    useLaneContractStore.getState().removeLane('tab-1', 'remote-signal');
    await vi.runAllTimersAsync();
    expect(disconnectSession.mock.calls).toEqual([[oldSessionId], [newSessionId]]);
  });

  it('rechecks a pending old release and drains slow reads while the new lease retains a standalone signal', async () => {
    const sourceId = 'slow-drain-source-with-signal';
    const oldSessionId = 'slow-drain-old-lease';
    const newSessionId = 'slow-drain-new-lease';
    registerRemoteSessionLease({ laneOwnerId: 'tab-1', sessionId: oldSessionId, sourceId });
    addRemoteLane(oldSessionId, 'tab-1', sourceId);
    addRemoteSignalLane(sourceId);
    let finishOldRead!: (value: Awaited<ReturnType<TileTransport>>) => void;
    const oldRead = trackRemoteTileSessionTransport(
      oldSessionId,
      () => new Promise((resolve) => (finishOldRead = resolve))
    )({ kind: 'alignment', level: 0, tileIndex: 1, body: {} }, new AbortController().signal);

    disconnectRemoteSessionsAfterRendererDrain([oldSessionId]);
    registerRemoteSessionLease({ laneOwnerId: 'tab-1', sessionId: newSessionId, sourceId });
    const trackId = replaceRemoteLane(oldSessionId, newSessionId, sourceId);
    disconnectRemoteSessionsAfterRendererDrain([oldSessionId]);
    useLaneContractStore.getState().removeLane('tab-1', trackId);
    disconnectRemoteSessionsAfterRendererDrain([newSessionId]);
    await vi.runAllTimersAsync();
    expect(disconnectSession).not.toHaveBeenCalled();

    finishOldRead({ ok: true, status: 200, body: {} });
    await oldRead;
    await vi.runAllTimersAsync();
    expect(disconnectSession.mock.calls).toEqual([[oldSessionId]]);
    expect(useLaneContractStore.getState().lanesForOwner('tab-1')).toHaveLength(1);

    useLaneContractStore.getState().removeLane('tab-1', 'remote-signal');
    await vi.runAllTimersAsync();
    expect(disconnectSession.mock.calls).toEqual([[oldSessionId], [newSessionId]]);
  });

  it('rechecks a waiting release when a published replacement becomes registered without a lane change', async () => {
    const sourceId = 'late-registration-source';
    const oldSessionId = 'late-registration-old-lease';
    const newSessionId = 'late-registration-new-lease';
    registerRemoteSessionLease({ laneOwnerId: 'tab-1', sessionId: oldSessionId, sourceId });
    addRemoteLane(oldSessionId, 'tab-1', sourceId);
    addRemoteSignalLane(sourceId);
    disconnectRemoteSessionsAfterRendererDrain([oldSessionId]);
    await vi.runAllTimersAsync();
    replaceRemoteLane(oldSessionId, newSessionId, sourceId);
    await vi.runAllTimersAsync();
    expect(disconnectSession).not.toHaveBeenCalled();

    registerRemoteSessionLease({ laneOwnerId: 'tab-1', sessionId: newSessionId, sourceId });
    disconnectRemoteSessionsAfterRendererDrain([oldSessionId]);
    await vi.runAllTimersAsync();
    expect(disconnectSession.mock.calls).toEqual([[oldSessionId]]);
    disconnectRemoteSessionsAfterRendererDrain([newSessionId]);
  });

  it('does not transfer signal retention to a registered candidate that is rejected before publication', async () => {
    const sourceId = 'unpublished-candidate-source';
    const oldSessionId = 'unpublished-current-lease';
    const candidateSessionId = 'unpublished-rejected-lease';
    registerRemoteSessionLease({ laneOwnerId: 'tab-1', sessionId: oldSessionId, sourceId });
    addRemoteLane(oldSessionId, 'tab-1', sourceId);
    addRemoteSignalLane(sourceId);
    disconnectRemoteSessionsAfterRendererDrain([oldSessionId]);
    await vi.runAllTimersAsync();

    registerRemoteSessionLease({ laneOwnerId: 'tab-1', sessionId: candidateSessionId, sourceId });
    disconnectRemoteSessionsAfterRendererDrain([oldSessionId]);
    forgetRemoteSessionLease(candidateSessionId);
    const trackId = useLaneContractStore.getState().lanesForOwner('tab-1')[0]!.dataset.trackId;
    useLaneContractStore.getState().removeLane('tab-1', trackId);
    await vi.runAllTimersAsync();
    expect(disconnectSession).not.toHaveBeenCalled();
    useLaneContractStore.getState().removeLane('tab-1', 'remote-signal');
    await vi.runAllTimersAsync();
    expect(disconnectSession.mock.calls).toEqual([[oldSessionId]]);
  });

  it('does not transfer signal retention to a published primary in another owner', async () => {
    const sourceId = 'different-owner-replacement-source';
    const oldSessionId = 'same-view-needed-lease';
    const otherSessionId = 'other-view-replacement-lease';
    registerRemoteSessionLease({ laneOwnerId: 'tab-1', sessionId: oldSessionId, sourceId });
    addRemoteLane(oldSessionId, 'tab-1', sourceId);
    addRemoteSignalLane(sourceId);
    registerRemoteSessionLease({ laneOwnerId: 'tab-2', sessionId: otherSessionId, sourceId });
    addRemoteLane(otherSessionId, 'tab-2', sourceId);
    disconnectRemoteSessionsAfterRendererDrain([oldSessionId]);
    const trackId = useLaneContractStore.getState().lanesForOwner('tab-1')[0]!.dataset.trackId;
    useLaneContractStore.getState().removeLane('tab-1', trackId);
    await vi.runAllTimersAsync();
    expect(disconnectSession).not.toHaveBeenCalled();
    useLaneContractStore.getState().removeLane('tab-1', 'remote-signal');
    await vi.runAllTimersAsync();
    expect(disconnectSession.mock.calls).toEqual([[oldSessionId]]);
    disconnectRemoteSessionsAfterRendererDrain([otherSessionId]);
  });

  it('does not transfer the old signal to an unregistered or different-source published lease', async () => {
    const sourceId = 'old-generation-source-with-signal';
    const newSourceId = 'new-generation-source-with-signal';
    const oldSessionId = 'old-generation-view-lease';
    const newSessionId = 'new-generation-view-lease';
    registerRemoteSessionLease({ laneOwnerId: 'tab-1', sessionId: oldSessionId, sourceId });
    addRemoteLane(oldSessionId, 'tab-1', sourceId);
    addRemoteSignalLane(sourceId);
    const trackId = replaceRemoteLane(oldSessionId, newSessionId, sourceId);
    disconnectRemoteSessionsAfterRendererDrain([oldSessionId]);
    await vi.runAllTimersAsync();
    expect(disconnectSession).not.toHaveBeenCalled();

    registerRemoteSessionLease({
      laneOwnerId: 'tab-1',
      sessionId: newSessionId,
      sourceId: newSourceId,
    });
    replaceRemoteLane(newSessionId, newSessionId, newSourceId);
    disconnectRemoteSessionsAfterRendererDrain([oldSessionId]);
    useLaneContractStore.getState().removeLane('tab-1', trackId);
    await vi.runAllTimersAsync();
    expect(disconnectSession).not.toHaveBeenCalled();
    useLaneContractStore.getState().removeLane('tab-1', 'remote-signal');
    await vi.runAllTimersAsync();
    expect(disconnectSession.mock.calls).toEqual([[oldSessionId]]);
    forgetRemoteSessionLease(newSessionId);
  });
});
