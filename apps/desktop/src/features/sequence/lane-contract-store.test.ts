import { beforeEach, describe, expect, it } from 'vitest';

import {
  LEGACY_BUCKET,
  useLaneContractStore,
  type ActiveStressDataset,
} from './lane-contract-store';

function dataset(trackId: string, over: Partial<ActiveStressDataset> = {}): ActiveStressDataset {
  return {
    trackType: 'pileup',
    trackId,
    label: trackId,
    color: 0x3366cc,
    trackPx: 60,
    records: [],
    kind: 'pileup',
    ...over,
  };
}

const store = () => useLaneContractStore.getState();

describe('lane-contract-store', () => {
  beforeEach(() => store().clear());

  it('keeps multiple lanes ordered and independently visible', () => {
    store().addLane('grch38', 'grch38', dataset('a'));
    store().addLane('grch38', 'grch38', dataset('b'));
    store().setLaneVisible('grch38', 'a', false);

    expect(
      store()
        .lanesForOwner('grch38')
        .map((lane) => lane.dataset.trackId)
    ).toEqual(['a', 'b']);
    expect(
      store()
        .lanesForOwner('grch38')
        .map((lane) => lane.visible)
    ).toEqual([false, true]);
    expect(store().activeDatasets.map((entry) => entry.trackId)).toEqual(['b']);
  });

  it('moves one lane before or after a peer and normalizes the durable order', () => {
    store().addLane('grch38', 'grch38', dataset('signal'));
    store().addLane('grch38', 'grch38', dataset('interval'));
    store().addLane('grch38', 'grch38', dataset('reads'));

    store().moveLane('grch38', 'interval', 'signal', 'before');

    expect(
      store()
        .lanesForOwner('grch38')
        .map((lane) => ({ trackId: lane.dataset.trackId, order: lane.order }))
    ).toEqual([
      { trackId: 'interval', order: 0 },
      { trackId: 'signal', order: 1 },
      { trackId: 'reads', order: 2 },
    ]);

    store().moveLane('grch38', 'interval', 'reads', 'after');

    expect(
      store()
        .lanesForOwner('grch38')
        .map((lane) => ({ trackId: lane.dataset.trackId, order: lane.order }))
    ).toEqual([
      { trackId: 'signal', order: 0 },
      { trackId: 'reads', order: 1 },
      { trackId: 'interval', order: 2 },
    ]);
  });

  it('can place a derived lane after its source without creating user undo history', () => {
    store().addLane('grch38', 'grch38', dataset('reads'), true, undefined, undefined, 'skip');
    store().addLane('grch38', 'grch38', dataset('hybrid'), true, undefined, undefined, 'skip');
    store().addLane('grch38', 'grch38', dataset('signal'), true, undefined, undefined, 'skip');

    store().moveLane('grch38', 'hybrid', 'signal', 'after', 'skip');

    expect(
      store()
        .lanesForOwner('grch38')
        .map((lane) => lane.dataset.trackId)
    ).toEqual(['reads', 'signal', 'hybrid']);
    expect(store().canUndoLaneChange('grch38')).toBe(false);
  });

  it('removes dependent signal-to-reads lanes atomically with a removed source', () => {
    store().addLane('tab-a', 'grch38', dataset('reads'));
    store().addLane(
      'tab-a',
      'grch38',
      dataset('signal', { trackType: 'quantitative', kind: 'annotation' })
    );
    store().addLane(
      'tab-a',
      'grch38',
      dataset('combined', {
        experimentalHybrid: {
          alignmentTrackId: 'reads',
          quantitativeTrackId: 'signal',
          loadingAnimation: 'diagonal-scan',
        },
      })
    );
    store().addLane('tab-a', 'grch38', dataset('unrelated'));
    store().clearOwnerHistory('tab-a');

    store().removeLane('tab-a', 'signal');

    expect(
      store()
        .lanesForOwner('tab-a')
        .map((lane) => lane.dataset.trackId)
    ).toEqual(['reads', 'unrelated']);
    expect(store().undoLaneChange('tab-a')).toBe(true);
    expect(
      store()
        .lanesForOwner('tab-a')
        .map((lane) => lane.dataset.trackId)
    ).toEqual(['reads', 'signal', 'combined', 'unrelated']);
    expect(store().canUndoLaneChange('tab-a')).toBe(false);
  });

  it('admits only one signal-to-reads composition for the same source pair', () => {
    const first = dataset('combined-a', {
      experimentalHybrid: {
        alignmentTrackId: 'reads',
        quantitativeTrackId: 'signal',
        loadingAnimation: 'diagonal-scan',
      },
    });
    const second = dataset('combined-b', {
      experimentalHybrid: {
        alignmentTrackId: 'reads',
        quantitativeTrackId: 'signal',
        loadingAnimation: 'diagonal-scan',
      },
    });

    expect(store().addLane('tab-a', 'grch38', first)).toBe('added');
    expect(store().addLane('tab-a', 'grch38', second)).toBe('duplicate');
    expect(
      store()
        .lanesForOwner('tab-a')
        .map((lane) => lane.dataset.trackId)
    ).toEqual(['combined-a']);
  });

  it('commits an exact owner permutation once and rejects incomplete or ambiguous orders', () => {
    store().addLane('tab-a', 'grch38', dataset('signal'));
    store().addLane('tab-a', 'grch38', dataset('interval'));
    store().addLane('tab-a', 'grch38', dataset('reads'));

    expect(store().setLaneOrder('tab-a', ['reads', 'signal', 'interval'])).toBe(true);
    expect(
      store()
        .lanesForOwner('tab-a')
        .map((lane) => ({ trackId: lane.dataset.trackId, order: lane.order }))
    ).toEqual([
      { trackId: 'reads', order: 0 },
      { trackId: 'signal', order: 1 },
      { trackId: 'interval', order: 2 },
    ]);

    expect(store().setLaneOrder('tab-a', ['reads', 'signal'])).toBe(false);
    expect(store().setLaneOrder('tab-a', ['reads', 'signal', 'other'])).toBe(false);
    expect(store().setLaneOrder('tab-a', ['reads', 'reads', 'interval'])).toBe(false);
    expect(store().setLaneOrder('tab-a', ['reads', 'signal', 'interval'])).toBe(false);
    expect(
      store()
        .lanesForOwner('tab-a')
        .map((lane) => lane.dataset.trackId)
    ).toEqual(['reads', 'signal', 'interval']);
  });

  it('preserves persisted cross-family order when restore hooks finish out of order', () => {
    store().addLane('grch38', 'grch38', dataset('reads'), true, undefined, 1);
    store().addLane(
      'grch38',
      'grch38',
      dataset('interval', { trackType: 'generic-interval', kind: 'interval' }),
      true,
      undefined,
      0
    );

    expect(
      store()
        .lanesForOwner('grch38')
        .map((lane) => ({ trackId: lane.dataset.trackId, order: lane.order }))
    ).toEqual([
      { trackId: 'interval', order: 0 },
      { trackId: 'reads', order: 1 },
    ]);
  });

  it('atomically admits a restored lane with its persisted hidden state', () => {
    store().addLane('grch38', 'grch38', dataset('restored-hidden'), false);

    expect(store().lanesForOwner('grch38')[0]?.visible).toBe(false);
    expect(store().activeDatasets).toEqual([]);
  });

  it('atomically replaces a complete owner lane set with normalized order', () => {
    const first = dataset('first', { color: 0x112233 });
    const second = dataset('second', { color: 0x445566 });

    store().replaceOwnerLanes(
      'tab-a',
      [
        { assemblyId: 'grch38', order: 8, dataset: second, visible: false },
        { assemblyId: 'grch38', order: 3, dataset: first, visible: true },
      ],
      'skip'
    );

    expect(store().lanesForOwner('tab-a')).toEqual([
      { assemblyId: 'grch38', order: 0, dataset: first, visible: true },
      { assemblyId: 'grch38', order: 1, dataset: second, visible: false },
    ]);
    expect(store().activeDatasets).toEqual([first]);
  });

  it('updates the cutoff for one BAM lane without mutating its peer', () => {
    store().addLane('grch38', 'grch38', dataset('a'));
    store().addLane('grch38', 'grch38', dataset('b', { coverageCutoffDepth: 25 }));

    store().setLaneCoverageCutoff('grch38', 'a', 115);

    const [a, b] = store().lanesForOwner('grch38');
    expect(a.dataset.coverageCutoffDepth).toBe(115);
    expect(b.dataset.coverageCutoffDepth).toBe(25);
  });

  it('updates one track color without mutating its peer or scientific records', () => {
    const aRecords = [{ chrom: 'chr1', start: 0, end: 5, value: 42 }];
    const bRecords = [{ chrom: 'chr1', start: 5, end: 10, value: 58 }];
    store().addLane(
      'grch38',
      'grch38',
      dataset('a', { trackType: 'quantitative', records: aRecords })
    );
    store().addLane(
      'grch38',
      'grch38',
      dataset('b', { trackType: 'quantitative', records: bRecords })
    );

    store().setLaneColor('grch38', 'a', 0xe11d48);

    const [a, b] = store().lanesForOwner('grch38');
    expect(a.dataset.color).toBe(0xe11d48);
    expect(a.dataset.records).toBe(aRecords);
    expect(b.dataset.color).toBe(0x3366cc);
    expect(b.dataset.records).toBe(bRecords);
  });

  it('updates common and type-specific settings through one validated mutation boundary', () => {
    store().addLane(
      'grch38',
      'grch38',
      dataset('signal', {
        trackType: 'quantitative',
        kind: 'annotation',
        quantitativeSourceSummary: {
          contract: 'dnaforge.quantitative-source-summary.v1',
          algorithm: 'equal-genomic-bin-means-r7-quantiles-v1',
          targetSampleCount: 65_536,
          sampleCount: 100,
          lowerQuantile: 0.005,
          upperQuantile: 0.995,
          robustMin: 0,
          robustMax: 20,
          fullMin: 0,
          fullMax: 100,
          missingData: 'excluded',
        },
      })
    );

    expect(
      store().updateLanePresentation('grch38', 'signal', {
        label: 'RNA signal',
        color: 0xe11d48,
        heightPx: 144,
        quantitative: {
          version: 1,
          graph: 'bar',
          showRange: true,
          scale: { mode: 'full-global', transform: 'log1p' },
        },
      }).status
    ).toBe('updated');
    expect(store().lanesForOwner('grch38')[0].dataset).toMatchObject({
      label: 'RNA signal',
      color: 0xe11d48,
      trackPx: 144,
      quantitativePresentation: {
        scale: { mode: 'full-global', transform: 'log1p' },
      },
    });
    expect(
      store().updateLanePresentation('grch38', 'signal', { coverageCutoffDepth: 20 })
    ).toMatchObject({ status: 'invalid', message: expect.stringContaining('BAM/CRAM') });
  });

  it('previews a height drag without history noise and commits the whole gesture as one undo step', () => {
    store().addLane('grch38', 'grch38', dataset('signal', { trackPx: 60 }));
    store().clearOwnerHistory('grch38');

    expect(
      store().updateLanePresentation('grch38', 'signal', { heightPx: 72 }, 'skip').status
    ).toBe('updated');
    expect(
      store().updateLanePresentation('grch38', 'signal', { heightPx: 96 }, 'skip').status
    ).toBe('updated');
    expect(store().canUndoLaneChange('grch38')).toBe(false);

    expect(store().commitLaneHeightResize('grch38', 'signal', 60, 96).status).toBe('updated');
    expect(store().lanesForOwner('grch38')[0].dataset.trackPx).toBe(96);
    expect(store().undoLaneChange('grch38')).toBe(true);
    expect(store().lanesForOwner('grch38')[0].dataset.trackPx).toBe(60);
    expect(store().canUndoLaneChange('grch38')).toBe(false);
    expect(store().redoLaneChange('grch38')).toBe(true);
    expect(store().lanesForOwner('grch38')[0].dataset.trackPx).toBe(96);
  });

  it('normalizes an invalid cutoff to per-track auto', () => {
    store().addLane('grch38', 'grch38', dataset('a', { coverageCutoffDepth: 40 }));
    store().setLaneCoverageCutoff('grch38', 'a', Number.NaN);
    expect(store().lanesForOwner('grch38')[0].dataset.coverageCutoffDepth).toBe(0);
  });

  it('preserves assembly lanes when a legacy scenario replaces its tracks', () => {
    store().addLane('grch38', 'grch38', dataset('assembly'));
    store().setActiveDatasets([dataset('legacy')]);
    expect(store().lanesForOwner('grch38')).toHaveLength(1);
    expect(store().lanesForOwner(LEGACY_BUCKET)[0].dataset.trackId).toBe('legacy');
  });

  it('rejects a duplicate stable track identity without replacing the live lane', () => {
    expect(store().addLane('grch38', 'grch38', dataset('a', { label: 'first' }))).toBe('added');
    expect(store().addLane('grch38', 'grch38', dataset('a', { label: 'replacement' }))).toBe(
      'duplicate'
    );
    expect(store().lanesForOwner('grch38')).toHaveLength(1);
    expect(store().lanesForOwner('grch38')[0].dataset.label).toBe('first');
  });

  it('isolates lanes for two tabs that display the same assembly', () => {
    store().addLane('tab-a', 'grch38', dataset('tumor'));
    store().addLane('tab-b', 'grch38', dataset('normal'));

    store().setLaneVisible('tab-a', 'tumor', false);
    store().removeLane('tab-b', 'normal');

    expect(store().lanesForOwner('tab-a')).toMatchObject([
      { assemblyId: 'grch38', visible: false, dataset: { trackId: 'tumor' } },
    ]);
    expect(store().lanesForOwner('tab-b')).toEqual([]);
  });

  it('atomically replaces a lane source while preserving its durable presentation identity', () => {
    store().addLane(
      'tab-a',
      'grch38',
      dataset('tumor', {
        label: 'Tumor reads',
        color: 0xe11d48,
        coverageCutoffDepth: 175,
        source: { bamPath: '/old/tumor.bam', indexPath: '/old/tumor.bam.bai' },
      }),
      false
    );

    expect(
      store().replaceLaneDataset(
        'tab-a',
        'tumor',
        'grch38',
        dataset('replacement-generated-id', {
          label: 'Replacement file label',
          color: 0x123456,
          coverageCutoffDepth: 5,
          source: { bamPath: '/new/tumor.bam', indexPath: '/new/tumor.bam.bai' },
        })
      )
    ).toBe('replaced');

    expect(store().lanesForOwner('tab-a')).toMatchObject([
      {
        assemblyId: 'grch38',
        visible: false,
        dataset: {
          trackId: 'tumor',
          label: 'Tumor reads',
          color: 0xe11d48,
          coverageCutoffDepth: 175,
          source: { bamPath: '/new/tumor.bam', indexPath: '/new/tumor.bam.bai' },
        },
      },
    ]);
  });

  it('undoes and redoes every user-facing data-track mutation in exact order', () => {
    const first = dataset('signal', {
      trackType: 'quantitative',
      kind: 'annotation',
      label: 'Signal',
      color: 0x112233,
    });
    const second = dataset('reads', {
      label: 'Reads',
      source: { bamPath: '/data/reads.bam', indexPath: '/data/reads.bam.bai' },
    });
    store().replaceOwnerLanes(
      'tab-a',
      [
        { assemblyId: 'grch38', order: 0, dataset: first, visible: true },
        {
          assemblyId: 'grch38',
          order: 1,
          dataset: second,
          visible: false,
          source: {
            admissionVersion: 1,
            uri: 'file:///data/reads.bam',
            formatId: 'bam',
            fingerprint: 'reads-generation',
            readerKind: 'bam',
            scientificKind: 'reads',
            assemblyId: 'grch38',
            referenceReceipt: {
              assemblyId: 'grch38',
              referenceSignature: 'grch38',
              sourceSignature: 'reads',
              contigMap: { chr1: 'chr1' },
              checkedContigs: 1,
              status: 'compatible',
              checkedAt: '2026-09-17T00:00:00.000Z',
            },
            provenance: { provider: 'local-file' },
          },
        },
      ],
      'skip'
    );

    expect(store().canUndoLaneChange('tab-a')).toBe(false);
    store().updateLanePresentation('tab-a', 'signal', { label: 'Edited signal', color: 0xe11d48 });
    store().setLaneVisible('tab-a', 'reads', true);
    store().setLaneOrder('tab-a', ['reads', 'signal']);
    store().removeLane('tab-a', 'reads');
    store().addLane('tab-a', 'grch38', dataset('peaks'));

    expect(store().canUndoLaneChange('tab-a')).toBe(true);
    expect(store().undoLaneChange('tab-a')).toBe(true);
    expect(
      store()
        .lanesForOwner('tab-a')
        .map((lane) => lane.dataset.trackId)
    ).toEqual(['signal']);

    expect(store().undoLaneChange('tab-a')).toBe(true);
    expect(store().lanesForOwner('tab-a')).toMatchObject([
      { order: 0, visible: true, dataset: { trackId: 'reads' } },
      { order: 1, visible: true, dataset: { trackId: 'signal' } },
    ]);
    expect(store().lanesForOwner('tab-a')[0].source).toEqual({
      admissionVersion: 1,
      uri: 'file:///data/reads.bam',
      formatId: 'bam',
      fingerprint: 'reads-generation',
      readerKind: 'bam',
      scientificKind: 'reads',
      assemblyId: 'grch38',
      referenceReceipt: expect.objectContaining({ sourceSignature: 'reads' }),
      provenance: { provider: 'local-file' },
    });

    expect(store().undoLaneChange('tab-a')).toBe(true);
    expect(
      store()
        .lanesForOwner('tab-a')
        .map((lane) => lane.dataset.trackId)
    ).toEqual(['signal', 'reads']);
    expect(store().undoLaneChange('tab-a')).toBe(true);
    expect(store().lanesForOwner('tab-a')[1].visible).toBe(false);
    expect(store().undoLaneChange('tab-a')).toBe(true);
    expect(store().lanesForOwner('tab-a')[0].dataset).toMatchObject({
      label: 'Signal',
      color: 0x112233,
    });
    expect(store().undoLaneChange('tab-a')).toBe(false);

    for (let index = 0; index < 5; index += 1) {
      expect(store().redoLaneChange('tab-a')).toBe(true);
    }
    expect(
      store()
        .lanesForOwner('tab-a')
        .map((lane) => lane.dataset.trackId)
    ).toEqual(['signal', 'peaks']);
    expect(store().canRedoLaneChange('tab-a')).toBe(false);
  });

  it('clears redo after a new track operation and keeps history isolated by view', () => {
    store().replaceOwnerLanes(
      'tab-a',
      [{ assemblyId: 'grch38', order: 0, dataset: dataset('a'), visible: true }],
      'skip'
    );
    store().replaceOwnerLanes(
      'tab-b',
      [{ assemblyId: 'grch38', order: 0, dataset: dataset('b'), visible: true }],
      'skip'
    );

    store().setLaneVisible('tab-a', 'a', false);
    expect(store().undoLaneChange('tab-a')).toBe(true);
    expect(store().canRedoLaneChange('tab-a')).toBe(true);
    expect(store().canUndoLaneChange('tab-b')).toBe(false);

    store().updateLanePresentation('tab-a', 'a', { color: 0xaabbcc });
    expect(store().canRedoLaneChange('tab-a')).toBe(false);
    expect(store().lanesForOwner('tab-b')[0].dataset.color).toBe(0x3366cc);
  });
});
