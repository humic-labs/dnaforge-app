import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createIndexedBbiTrackId,
  type PileupRecord,
  type PileupTrackData,
  type QuantitativeBin,
} from '@waypoint/genome-data';

import type { ActiveStressDataset, Lane } from './lane-contract-store';
import {
  buildExperimentalHybridPileupDataset,
  buildExperimentalHybridStreamingLanes,
  buildHybridPileupCoverage,
  buildPileupReadSourcesByTrackId,
  createSignalReadPileupViewState,
  deriveExperimentalHybridPileupLanes,
  EXPERIMENTAL_HYBRID_LOADING_ANIMATIONS,
  ExperimentalHybridPileupPublisher,
  indexedGenomeSignalReadPileupViewFromLane,
  laneFromIndexedGenomeSignalReadPileupView,
  writeExperimentalHybridLoadingAnimationPreference,
} from './experimental-hybrid-pileup';

const ALIGNMENT: ActiveStressDataset = {
  kind: 'pileup',
  trackType: 'pileup-genomewide',
  trackId: 'bam-a',
  label: 'GRCh37: sample.cram',
  color: 0xa8ceff,
  laneHeightPx: 3,
  maxLanes: 80,
  overflowBandHeightPx: 36,
  trackPx: 276,
  records: [],
  source: {
    bamPath: 'http://127.0.0.1/alignment',
    indexPath: '/tmp/sample.crai',
  },
};

const SIGNAL: ActiveStressDataset = {
  kind: 'annotation',
  trackType: 'quantitative',
  trackId: 'bigwig-a',
  label: 'sample.bigWig',
  color: 0x3b82f6,
  laneHeightPx: 8,
  maxLanes: 32,
  trackPx: 96,
  records: [],
};

const BIGWIG_RECORDS: QuantitativeBin[] = [
  { chrom: 'chr16', start: 100, end: 102, value: 3 },
  { chrom: 'chr16', start: 102, end: 104, value: 7 },
];

const READS: PileupRecord[] = [
  { chrom: 'chr16', start: 100, end: 103, readId: 'r1', strand: '+', mapq: 60 },
];

describe('experimental BigWig to BAM hybrid pileup', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('uses the BAM lane geometry and maps one signal-depth unit to one read-row pitch', () => {
    const dataset = buildExperimentalHybridPileupDataset({
      alignment: ALIGNMENT,
      signal: SIGNAL,
    });

    expect(dataset).toMatchObject({
      kind: 'pileup',
      trackType: ALIGNMENT.trackType,
      laneHeightPx: ALIGNMENT.laneHeightPx,
      maxLanes: ALIGNMENT.maxLanes,
      overflowBandHeightPx: ALIGNMENT.overflowBandHeightPx,
      trackPx: ALIGNMENT.trackPx,
      coverageCutoffDepth: 80,
      experimentalHybrid: {
        alignmentTrackId: 'bam-a',
        quantitativeTrackId: 'bigwig-a',
        loadingAnimation: 'diagonal-scan',
      },
    });
    expect(dataset.source).toBeUndefined();
    expect(dataset.label).toContain('BigWig → reads');
    expect(EXPERIMENTAL_HYBRID_LOADING_ANIMATIONS).toHaveLength(1);
    expect(new Set(EXPERIMENTAL_HYBRID_LOADING_ANIMATIONS.map((option) => option.value)).size).toBe(
      1
    );
  });

  it('creates one stable durable descriptor for UI and manifest composition writers', () => {
    const first = createSignalReadPileupViewState({
      assemblyId: 'grch37',
      alignment: ALIGNMENT,
      signal: SIGNAL,
      label: 'Accessibility + reads',
      order: 4,
      presentation: { maxRows: 64, rowHeightPx: 4 },
    });
    const second = createSignalReadPileupViewState({
      assemblyId: 'grch37',
      alignment: ALIGNMENT,
      signal: SIGNAL,
      label: 'Accessibility + reads',
      order: 4,
      presentation: { maxRows: 64, rowHeightPx: 4 },
    });

    expect(second.trackId).toBe(first.trackId);
    expect(first).toMatchObject({
      contract: 'dnaforge.signal-read-pileup-view.v1',
      readsTrackId: ALIGNMENT.trackId,
      signalTrackId: SIGNAL.trackId,
      label: 'Accessibility + reads',
      order: 4,
      visible: true,
      color: ALIGNMENT.color,
      trackPx: ALIGNMENT.trackPx,
      laneHeightPx: 4,
      maxLanes: 64,
      coverageCutoffDepth: 64,
      loadingAnimation: 'diagonal-scan',
    });
  });

  it('aliases the BAM source onto the hybrid track so read hover and selection stay interactive', () => {
    const hybrid = buildExperimentalHybridPileupDataset({
      alignment: ALIGNMENT,
      signal: SIGNAL,
    });

    const sources = buildPileupReadSourcesByTrackId([SIGNAL, hybrid, ALIGNMENT]);

    expect(sources.get(ALIGNMENT.trackId)).toBe(ALIGNMENT.source);
    expect(sources.get(hybrid.trackId)).toBe(ALIGNMENT.source);
  });

  it('round-trips an explicit signal-to-reads view independently of source filenames', () => {
    const restored = laneFromIndexedGenomeSignalReadPileupView(
      {
        contract: 'dnaforge.signal-read-pileup-view.v1',
        trackId: 'gm12878-accessibility',
        readsTrackId: ALIGNMENT.trackId,
        signalTrackId: SIGNAL.trackId,
        label: 'GM12878 accessibility + reads',
        order: 2,
        visible: true,
        color: 0xa8ceff,
        trackPx: 300,
        laneHeightPx: 4,
        maxLanes: 70,
        overflowBandHeightPx: 40,
        coverageCutoffDepth: 70,
        loadingAnimation: 'diagonal-scan',
      },
      'grch38',
      [
        { assemblyId: 'grch38', order: 0, visible: true, dataset: ALIGNMENT },
        { assemblyId: 'grch38', order: 1, visible: true, dataset: SIGNAL },
      ]
    );

    expect(restored.dataset).toMatchObject({
      trackId: 'gm12878-accessibility',
      label: 'GM12878 accessibility + reads',
      color: 0xa8ceff,
      trackPx: 300,
      laneHeightPx: 4,
      maxLanes: 70,
      overflowBandHeightPx: 40,
      coverageCutoffDepth: 70,
      experimentalHybrid: {
        alignmentTrackId: ALIGNMENT.trackId,
        quantitativeTrackId: SIGNAL.trackId,
        loadingAnimation: 'diagonal-scan',
      },
    });
    expect(indexedGenomeSignalReadPileupViewFromLane(restored)).toEqual({
      contract: 'dnaforge.signal-read-pileup-view.v1',
      trackId: 'gm12878-accessibility',
      readsTrackId: ALIGNMENT.trackId,
      signalTrackId: SIGNAL.trackId,
      label: 'GM12878 accessibility + reads',
      order: 2,
      visible: true,
      color: 0xa8ceff,
      trackPx: 300,
      laneHeightPx: 4,
      maxLanes: 70,
      overflowBandHeightPx: 40,
      coverageCutoffDepth: 70,
      loadingAnimation: 'diagonal-scan',
    });
  });

  it('normalizes an obsolete persisted experiment to the diagonal scan', () => {
    writeExperimentalHybridLoadingAnimationPreference('read-waterfall');

    const dataset = buildExperimentalHybridPileupDataset({
      alignment: ALIGNMENT,
      signal: SIGNAL,
    });

    expect(dataset.experimentalHybrid?.loadingAnimation).toBe('diagonal-scan');
  });

  it('keeps hidden BAM and BigWig dependencies streaming while only the hybrid lane is visible', () => {
    const hybrid = buildExperimentalHybridPileupDataset({
      alignment: ALIGNMENT,
      signal: SIGNAL,
    });
    const lanes: Lane[] = [
      { assemblyId: 'hg19', order: 0, dataset: ALIGNMENT, visible: false },
      { assemblyId: 'hg19', order: 1, dataset: SIGNAL, visible: false },
      { assemblyId: 'hg19', order: 2, dataset: hybrid, visible: true },
    ];

    const streaming = buildExperimentalHybridStreamingLanes(lanes);

    expect(streaming.map((lane) => lane.dataset.trackId)).toEqual([
      ALIGNMENT.trackId,
      SIGNAL.trackId,
      hybrid.trackId,
    ]);
    expect(streaming.every((lane) => lane.visible)).toBe(true);
    expect(lanes[0]!.visible).toBe(false);
    expect(lanes[1]!.visible).toBe(false);
  });

  it('respects saved compositions, including an explicitly empty list on remount', () => {
    const remoteAlignment: ActiveStressDataset = {
      ...ALIGNMENT,
      source: {
        ...ALIGNMENT.source!,
        remote: {
          sessionId: 'session-1',
          locator: {
            contract: 'remote-alignment-locator.v1',
            endpointId: 'lab-hpc',
            target: 'lab-hpc',
            alignmentPath: '/run/sample.cram',
            indexPath: '/run/sample.cram.crai',
            signalPath: '/run/sample.bigWig',
          },
          generation: {
            alignment: {
              canonicalPath: '/run/sample.cram',
              size: 1,
              mtimeNs: '1',
              ctimeNs: '1',
              device: null,
              inode: null,
            },
            index: {
              canonicalPath: '/run/sample.cram.crai',
              size: 1,
              mtimeNs: '1',
              ctimeNs: '1',
              device: null,
              inode: null,
            },
          },
        },
      },
    };
    const signalTrackId = createIndexedBbiTrackId({
      assemblyId: 'grch37',
      source: { kind: 'url', url: 'ssh://lab-hpc/run/sample.bigWig' },
    });
    const signal = { ...SIGNAL, trackId: signalTrackId };
    const explicit = buildExperimentalHybridPileupDataset({
      alignment: remoteAlignment,
      signal,
      view: {
        contract: 'dnaforge.signal-read-pileup-view.v1',
        trackId: 'declared-composition',
        readsTrackId: remoteAlignment.trackId,
        signalTrackId,
        label: 'Declared composition',
        order: 2,
        visible: true,
        color: remoteAlignment.color,
        trackPx: remoteAlignment.trackPx,
        laneHeightPx: remoteAlignment.laneHeightPx!,
        maxLanes: remoteAlignment.maxLanes!,
        overflowBandHeightPx: remoteAlignment.overflowBandHeightPx!,
        coverageCutoffDepth: remoteAlignment.maxLanes!,
        loadingAnimation: 'diagonal-scan',
      },
    });

    expect(
      deriveExperimentalHybridPileupLanes([
        { assemblyId: 'grch37', order: 0, dataset: remoteAlignment, visible: false },
        { assemblyId: 'grch37', order: 1, dataset: signal, visible: false },
        { assemblyId: 'grch37', order: 2, dataset: explicit, visible: true },
      ])
    ).toEqual([]);
    expect(
      deriveExperimentalHybridPileupLanes(
        [
          { assemblyId: 'grch37', order: 0, dataset: remoteAlignment, visible: true },
          { assemblyId: 'grch37', order: 1, dataset: signal, visible: true },
        ],
        false
      )
    ).toEqual([]);
  });

  it('builds a base-pair-anchored uniform coverage signal from the BigWig height map', () => {
    const coverage = buildHybridPileupCoverage(BIGWIG_RECORDS, 'bigwig-a:L4:10|11');

    expect(coverage).toMatchObject({
      coverageRevision: 'hybrid-bigwig:bigwig-a:L4:10|11',
      startBp: 100,
      binSize: 2,
      bins: [3, 7],
      maxDepth: 7,
      provenance: {
        exact: true,
        method: 'bigwig-pileup-height-map',
        source: 'bigwig-a',
      },
    });
  });

  it('keeps histogram loading independent from read loading and clears it after an empty BigWig response', () => {
    const setTrackData = vi.fn<(trackId: string, data: PileupTrackData) => void>();
    const publisher = new ExperimentalHybridPileupPublisher({
      definitions: [
        {
          trackId: 'hybrid-a',
          alignmentTrackId: 'bam-a',
          quantitativeTrackId: 'bigwig-a',
          coverageCutoffDepth: 80,
          loadingAnimation: 'diagonal-scan',
        },
      ],
      target: {
        getRenderer: () => ({ hasTrackInstance: () => true, setTrackData }),
        requestRender: vi.fn(),
      },
    });
    const intervals = [{ startBp: 80, endBp: 140, state: 'pending' as const }];
    publisher.publishHistogramPendingIntervals('bigwig-a', intervals);
    expect(setTrackData.mock.calls.at(-1)?.[1].experimentalReadHandoff).toMatchObject({
      readsLoading: true,
      histogramPendingIntervals: intervals,
    });
    publisher.publishQuantitative('bigwig-a', [], 'loaded-empty');
    publisher.publishHistogramPendingIntervals('bigwig-a', []);
    expect(setTrackData.mock.calls.at(-1)?.[1].experimentalReadHandoff).toMatchObject({
      readsLoading: true,
      histogramPendingIntervals: [],
    });
    publisher.publishAlignment('bam-a', {
      dataAuthority: 'tile-engine',
      records: [],
      referenceIntervals: [],
    });
    expect(setTrackData.mock.calls.at(-1)?.[1].experimentalReadHandoff?.readsLoading).toBe(false);
  });

  it('publishes BigWig immediately, then replaces it with exact BAM reads without losing the height map', () => {
    const setTrackData = vi.fn<(trackId: string, data: PileupTrackData) => void>();
    const requestRender = vi.fn();
    const publisher = new ExperimentalHybridPileupPublisher({
      definitions: [
        {
          trackId: 'hybrid-a',
          alignmentTrackId: 'bam-a',
          quantitativeTrackId: 'bigwig-a',
          coverageCutoffDepth: 80,
          loadingAnimation: 'diagonal-scan',
        },
      ],
      target: {
        getRenderer: () => ({ hasTrackInstance: () => true, setTrackData }),
        requestRender,
      },
    });

    publisher.publishQuantitative('bigwig-a', BIGWIG_RECORDS, 'L4:10|11');
    const provisional = setTrackData.mock.calls.at(-1)?.[1];
    expect(provisional).toMatchObject({
      dataAuthority: 'static',
      records: [],
      coverageCutoffDepth: 80,
      experimentalReadHandoff: {
        kind: 'bigwig-height-morph-to-reads',
        readsLoading: true,
        loadingAnimation: 'diagonal-scan',
      },
    });
    expect(provisional?.coverage?.bins).toEqual([3, 7]);

    publisher.publishAlignment('bam-a', {
      dataAuthority: 'tile-engine',
      records: READS,
      readSource: { windowStartBp: 80, windowEndBp: 140, truncated: false },
      referenceIntervals: [
        { startBp: 80, endBp: 100, state: 'pending' },
        { startBp: 104, endBp: 120, state: 'empty' },
      ],
    });
    const replaced = setTrackData.mock.calls.at(-1)?.[1];
    expect(replaced?.coverage).toBe(provisional?.coverage);
    expect(replaced).toMatchObject({
      dataAuthority: 'static',
      records: READS,
      readSource: { windowStartBp: 80, windowEndBp: 140, truncated: false },
      referenceIntervals: [
        { startBp: 80, endBp: 100, state: 'pending' },
        { startBp: 104, endBp: 120, state: 'empty' },
      ],
      coverageCutoffDepth: 80,
      experimentalReadHandoff: {
        readsLoading: true,
      },
    });

    publisher.publishAlignment('bam-a', {
      dataAuthority: 'tile-engine',
      records: READS,
      readSource: { windowStartBp: 80, windowEndBp: 140, truncated: false },
      referenceIntervals: [],
    });
    expect(setTrackData.mock.calls.at(-1)?.[1].experimentalReadHandoff?.readsLoading).toBe(false);
    expect(requestRender).toHaveBeenCalledTimes(3);
  });
});
