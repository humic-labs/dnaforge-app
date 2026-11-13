import { act, renderHook, waitFor } from '@testing-library/react';
import { DEFAULT_QUANTITATIVE_TRACK_PRESENTATION } from '@waypoint/genome-data';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IndexedGenomeDataTrackState } from '../../../shared/indexed-genome';
import { INTERNAL_TRACK_FIXTURES } from '../../../shared/internal-track-fixtures';
import { useLaneContractStore } from '../lane-contract-store';
import { usePersistedDataTracks } from './usePersistedUcscTracks';

const mocks = vi.hoisted(() => ({
  projectRoot: vi.fn(),
  recoverTrack: vi.fn(),
  admit: vi.fn(),
}));
vi.mock('../../../platform', () => ({
  platform: () => ({
    path: { projectRoot: mocks.projectRoot },
    internalFixtures: { recoverTrack: mocks.recoverTrack },
  }),
}));
vi.mock('../indexed-track-admission', () => ({ admitIndexedBigWigRequest: mocks.admit }));

const fixture = Object.values(INTERNAL_TRACK_FIXTURES)[0];
const references = [{ name: 'chr1', length: 1000 }];
const originalPath = `/removed-checkout/${fixture.relativePath}`;

function track(): IndexedGenomeDataTrackState {
  return {
    trackId: 'signal',
    trackType: 'quantitative',
    label: 'Unsaved label',
    order: 2,
    color: 0x8b5cf6,
    trackPx: 96,
    laneHeightPx: 18,
    maxLanes: 1,
    visible: false,
    quantitativePresentation: DEFAULT_QUANTITATIVE_TRACK_PRESENTATION,
    source: {
      admissionVersion: 1,
      uri: `file://${originalPath}`,
      input: { kind: 'path', path: originalPath },
      formatId: 'bigwig',
      fingerprint: 'old-source',
      readerKind: 'bbi',
      scientificKind: 'quantitative',
      assemblyId: 'danRer11',
      referenceReceipt: {
        assemblyId: 'danRer11',
        referenceSignature: 'reference',
        sourceSignature: 'old-source',
        contigMap: { chr1: 'chr1' },
        checkedContigs: 1,
        status: 'compatible',
        checkedAt: '2026-09-29T00:00:00.000Z',
      },
      provenance: {
        provider: 'local-file',
        sourceKind: 'local-file',
        label: 'Signal',
        devScenarioFixture: true,
      },
      expectedValidators: { contentLength: fixture.sizeBytes },
    },
  };
}

function mount() {
  let persisted: readonly IndexedGenomeDataTrackState[] = [track()];
  const hook = renderHook(() =>
    usePersistedDataTracks({
      laneOwnerId: 'restored-tab',
      assemblyId: 'danRer11',
      persistedTracks: persisted,
      references,
      onChange: (update) => {
        persisted = update(persisted);
      },
    })
  );
  return { ...hook, persisted: () => persisted };
}

beforeEach(() => {
  vi.resetAllMocks();
  useLaneContractStore.getState().clear();
  mocks.projectRoot.mockResolvedValue('/current-checkout');
  mocks.recoverTrack.mockResolvedValue({ path: '/profile/Track assets/verified/signal.bw' });
  const source = track().source;
  mocks.admit.mockResolvedValue({
    ...source,
    fingerprint: 'recovered-source',
    uri: 'file:///profile/Track assets/verified/signal.bw',
    input: { kind: 'path', path: '/profile/Track assets/verified/signal.bw' },
    provenance: { ...source.provenance, devScenarioFixture: undefined },
  });
});

describe('restored legacy scenario sources', () => {
  it('recovers a restored tab without reopening or saving its dirty view', async () => {
    const original = track();
    const hook = mount();
    await waitFor(() => expect(hook.persisted()[0].source.fingerprint).toBe('recovered-source'));
    const { source: _source, ...presentation } = hook.persisted()[0];
    const { source: _originalSource, ...expected } = original;
    expect(presentation).toEqual(expected);
    expect(mocks.recoverTrack).toHaveBeenCalledWith({
      relativePath: fixture.relativePath,
      previousPath: originalPath,
    });
    expect(mocks.admit).toHaveBeenCalledWith(
      expect.objectContaining({ assemblyReferences: references })
    );
    expect(hook.result.current).toEqual({ status: 'ready', issues: [] });
  });

  it('preserves presentation edits made while verified recovery is pending', async () => {
    let finish!: (value: { path: string }) => void;
    mocks.recoverTrack.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const hook = mount();
    await waitFor(() => expect(mocks.recoverTrack).toHaveBeenCalledTimes(1));
    act(() => {
      const store = useLaneContractStore.getState();
      store.updateLanePresentation('restored-tab', 'signal', {
        label: 'Edited during recovery',
        color: 0xff0000,
        heightPx: 170,
      });
      finish({ path: '/profile/Track assets/verified/signal.bw' });
    });
    await waitFor(() => expect(hook.persisted()[0].source.fingerprint).toBe('recovered-source'));
    expect(hook.persisted()[0]).toMatchObject({
      label: 'Edited during recovery',
      color: 0xff0000,
      trackPx: 170,
      visible: false,
      order: 2,
    });
  });

  it('does not overwrite a replacement chosen during recovery', async () => {
    let finish!: (value: { path: string }) => void;
    mocks.recoverTrack.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const hook = mount();
    await waitFor(() => expect(mocks.recoverTrack).toHaveBeenCalledTimes(1));
    act(() => {
      const store = useLaneContractStore.getState();
      const lane = store.lanesForOwner('restored-tab')[0];
      store.replaceLaneDataset('restored-tab', 'signal', 'danRer11', lane.dataset, {
        ...track().source,
        fingerprint: 'user-replacement',
      });
      finish({ path: '/profile/Track assets/verified/signal.bw' });
    });
    await waitFor(() => expect(hook.result.current.status).toBe('ready'));
    expect(hook.persisted()[0].source.fingerprint).toBe('user-replacement');
  });

  it('retains an unavailable source and its presentation when recovery fails', async () => {
    mocks.recoverTrack.mockRejectedValue(new Error('Verified fixture is unavailable'));
    const hook = mount();
    await waitFor(() =>
      expect(hook.result.current.issues).toEqual([
        {
          trackId: 'signal',
          label: 'Unsaved label',
          message: 'Verified fixture is unavailable',
        },
      ])
    );
    expect(hook.persisted()).toEqual([track()]);
    expect(hook.result.current.status).toBe('ready');
    expect(mocks.admit).not.toHaveBeenCalled();
  });
});
