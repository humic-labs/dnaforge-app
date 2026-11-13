import { describe, expect, it } from 'vitest';

import {
  indexedGenomeDataTrackFromLane,
  indexedGenomeDataTracksEqual,
  laneFromIndexedGenomeDataTrack,
} from './ucsc-track-persistence';

const PERSISTED = {
  trackId: 'ucsc:hg38-knownGene',
  trackType: 'imported-transcript',
  label: 'MANE Select',
  order: 3,
  color: 0x3b82f6,
  trackPx: 160,
  laneHeightPx: 8,
  maxLanes: 32,
  visible: true,
  source: {
    admissionVersion: 1 as const,
    uri: 'https://example.org/knownGene.bb',
    formatId: 'bigbed' as const,
    readerKind: 'bbi' as const,
    scientificKind: 'transcript' as const,
    assemblyId: 'grch38',
    referenceReceipt: {
      assemblyId: 'grch38',
      referenceSignature: 'grch38',
      sourceSignature: 'known-gene',
      contigMap: { chr1: 'chr1' },
      checkedContigs: 1,
      status: 'compatible' as const,
      checkedAt: '2026-07-28T00:00:00.000Z',
    },
    provenance: {
      provider: 'ucsc' as const,
      sourceKind: 'ucsc-native' as const,
      catalogId: 'hg38:knownGene',
      ucscGenome: 'hg38',
      track: 'knownGene',
      label: 'MANE Select',
    },
    fingerprint: 'ucsc-native\u0000hg38\u0000knownGene\u0000',
  },
};

describe('UCSC track persistence', () => {
  it('round-trips a current admission request without weakening legacy restore support', () => {
    const current = {
      ...PERSISTED,
      source: {
        ...PERSISTED.source,
        admissionVersion: 2 as const,
        request: {
          contract: 'dnaforge.track-admission-request.v1' as const,
          assemblyId: 'grch38',
          source: {
            kind: 'ucsc-track' as const,
            sourceKind: 'ucsc-native' as const,
            genome: 'hg38',
            track: 'knownGene',
          },
          formatId: 'bigbed',
          scientificKind: 'transcript' as const,
          label: 'MANE Select',
          ingress: { kind: 'catalog' as const },
        },
        admittedAt: '2026-09-21T18:00:00.000Z',
      },
    };

    expect(
      indexedGenomeDataTrackFromLane(laneFromIndexedGenomeDataTrack(current, 'grch38'))
    ).toEqual(current);
    expect(() =>
      laneFromIndexedGenomeDataTrack(
        {
          ...current,
          source: {
            ...current.source,
            request: { ...current.source.request, assemblyId: 'ce11' },
          },
        },
        'grch38'
      )
    ).toThrow(/admission request/i);
  });

  it('round-trips a local BigWig through the same source-neutral descriptor', () => {
    const localTrack = {
      ...PERSISTED,
      trackId: 'data:signal-local',
      label: 'signal.bigWig',
      trackType: 'quantitative',
      quantitativePresentation: {
        version: 1 as const,
        graph: 'bar' as const,
        showRange: true,
        smoothingSigmaBins: 0,
        scale: { mode: 'robust-global' as const, transform: 'linear' as const },
      },
      source: {
        ...PERSISTED.source,
        uri: 'file:///analysis/output/signal.bigWig',
        input: { kind: 'path' as const, path: '/analysis/output/signal.bigWig' },
        formatId: 'bigwig' as const,
        scientificKind: 'quantitative' as const,
        fingerprint: 'local-generation',
        provenance: {
          provider: 'local-file' as const,
          sourceKind: 'local-file' as const,
          label: 'signal.bigWig',
        },
      },
    };

    expect(
      indexedGenomeDataTrackFromLane(laneFromIndexedGenomeDataTrack(localTrack, 'grch38'))
    ).toEqual(localTrack);
  });

  it('round-trips a current local BED receipt without persisting parsed records', () => {
    const localBed = {
      ...PERSISTED,
      trackId: 'data:regions-bed',
      label: 'regions.bed',
      trackType: 'generic-interval',
      source: {
        admissionVersion: 2 as const,
        request: {
          contract: 'dnaforge.track-admission-request.v1' as const,
          assemblyId: 'grch38',
          source: { kind: 'local-file' as const, path: '/analysis/regions.bed' },
          formatId: 'bed',
          scientificKind: 'interval' as const,
          ingress: { kind: 'file-picker' as const },
        },
        admittedAt: '2026-09-21T19:00:00.000Z',
        uri: 'file:///analysis/regions.bed',
        input: { kind: 'path' as const, path: '/analysis/regions.bed' },
        formatId: 'bed' as const,
        readerKind: 'interval-text' as const,
        scientificKind: 'interval' as const,
        assemblyId: 'grch38',
        referenceReceipt: {
          ...PERSISTED.source.referenceReceipt,
          sourceSignature: 'bed-extents',
        },
        provenance: {
          provider: 'local-file' as const,
          sourceKind: 'local-file' as const,
          label: 'regions.bed',
        },
        fingerprint: `bed:sha256:${'a'.repeat(64)}`,
        expectedValidators: { contentLength: 100 },
      },
    };

    const lane = laneFromIndexedGenomeDataTrack(localBed, 'grch38');

    expect(lane.dataset.records).toEqual([]);
    expect(indexedGenomeDataTrackFromLane(lane)).toEqual(localBed);
  });

  it('does not persist a tunnel-scoped sibling BigWig as an independent data source', () => {
    const remoteSignalTrack = {
      ...PERSISTED,
      trackId: 'data:remote-signal',
      label: 'signal.bigWig',
      trackType: 'quantitative',
      source: {
        ...PERSISTED.source,
        uri: 'http://127.0.0.1:43119/v1/session-1/signal.bigWig',
        input: {
          kind: 'url' as const,
          url: 'http://127.0.0.1:43119/v1/session-1/signal.bigWig',
        },
        formatId: 'bigwig' as const,
        scientificKind: 'quantitative' as const,
        fingerprint:
          'remote-signal\u0000ssh://lab-hpc/data/signal.bigWig\u0000http://127.0.0.1:43119/v1/session-1/signal.bigWig\u00001024',
        provenance: {
          provider: 'direct-url' as const,
          sourceKind: 'remote-url' as const,
          label: 'signal.bigWig',
        },
      },
    };

    expect(() => laneFromIndexedGenomeDataTrack(remoteSignalTrack, 'grch38')).toThrow(
      'cannot be restored independently'
    );
    const runtimeLane = {
      ...laneFromIndexedGenomeDataTrack(PERSISTED, 'grch38'),
      source: remoteSignalTrack.source,
    };
    expect(indexedGenomeDataTrackFromLane(runtimeLane)).toBeNull();
  });

  it('round-trips only the durable source and presentation descriptor', () => {
    const lane = laneFromIndexedGenomeDataTrack(PERSISTED, 'grch38');
    expect(lane.order).toBe(3);
    expect(lane.dataset.records).toEqual([]);
    expect(indexedGenomeDataTrackFromLane(lane)).toEqual(PERSISTED);
  });

  it('restores GRCz12tu only with its exact UCSC GenArk accession', () => {
    const grcz12tu = {
      ...PERSISTED,
      trackId: 'ucsc:GCF_049306965.2-ncbiRefSeq',
      label: 'GRCz12tu genes',
      source: {
        ...PERSISTED.source,
        assemblyId: 'grcz12tu',
        referenceReceipt: {
          ...PERSISTED.source.referenceReceipt,
          assemblyId: 'grcz12tu',
        },
        provenance: {
          ...PERSISTED.source.provenance,
          catalogId: 'GCF_049306965.2:ncbiRefSeq',
          ucscGenome: 'GCF_049306965.2',
          track: 'ncbiRefSeq',
        },
      },
    };

    expect(
      indexedGenomeDataTrackFromLane(laneFromIndexedGenomeDataTrack(grcz12tu, 'grcz12tu'))
    ).toEqual(grcz12tu);
    expect(() =>
      laneFromIndexedGenomeDataTrack(
        {
          ...grcz12tu,
          source: {
            ...grcz12tu.source,
            provenance: { ...grcz12tu.source.provenance, ucscGenome: 'GCF_049306965.1' },
          },
        },
        'grcz12tu'
      )
    ).toThrow('maps to UCSC genome GCF_049306965.2, not GCF_049306965.1');
  });

  it('treats hub identity as durable state, not decoded tile data', () => {
    const hubTrack = {
      ...PERSISTED,
      trackId: 'ucsc:hg38-knownGene-source',
      source: {
        ...PERSISTED.source,
        provenance: {
          ...PERSISTED.source.provenance,
          sourceKind: 'ucsc-hub' as const,
          hubUrl: 'https://example.org/one/hub.txt',
        },
      },
    };
    expect(indexedGenomeDataTracksEqual([hubTrack], [{ ...hubTrack }])).toBe(true);
    expect(
      indexedGenomeDataTracksEqual(
        [hubTrack],
        [
          {
            ...hubTrack,
            source: {
              ...hubTrack.source,
              fingerprint: 'different-hub-fingerprint',
              provenance: {
                ...hubTrack.source.provenance,
                hubUrl: 'https://example.org/two/hub.txt',
              },
            },
          },
        ]
      )
    ).toBe(false);
  });

  it('restores a connected hub track that the hosted mapping does not know', () => {
    const hubTrack = {
      ...PERSISTED,
      trackId: 'ucsc:lab-hub-genes',
      source: {
        ...PERSISTED.source,
        provenance: {
          ...PERSISTED.source.provenance,
          sourceKind: 'ucsc-hub' as const,
          ucscGenome: 'labAssembly',
          hubUrl: 'https://hub.example.org/hub.txt',
        },
      },
    };
    expect(laneFromIndexedGenomeDataTrack(hubTrack, 'grch38').source?.provenance).toMatchObject({
      sourceKind: 'ucsc-hub',
      hubUrl: 'https://hub.example.org/hub.txt',
    });
    expect(() =>
      laneFromIndexedGenomeDataTrack(
        {
          ...hubTrack,
          source: {
            ...hubTrack.source,
            provenance: { ...hubTrack.source.provenance, hubUrl: 'ftp://hub.example.org/hub.txt' },
          },
        },
        'grch38'
      )
    ).toThrow('invalid hub URL');
  });

  it('persists whether quantitative widths are native data or storage summaries', () => {
    const nativeIntervals = {
      ...PERSISTED,
      trackType: 'quantitative',
      quantitativePresentation: {
        version: 1 as const,
        graph: 'bar' as const,
        showRange: true,
        smoothingSigmaBins: 0,
        scale: { mode: 'robust-global' as const, transform: 'linear' as const },
      },
      source: {
        ...PERSISTED.source,
        formatId: 'bigwig' as const,
        scientificKind: 'quantitative' as const,
        quantitativeColumnSemantics: 'native-interval' as const,
      },
    };

    expect(
      indexedGenomeDataTrackFromLane(laneFromIndexedGenomeDataTrack(nativeIntervals, 'grch38'))
    ).toEqual(nativeIntervals);
    expect(
      indexedGenomeDataTracksEqual(
        [nativeIntervals],
        [
          {
            ...nativeIntervals,
            source: {
              ...nativeIntervals.source,
              quantitativeColumnSemantics: 'continuous-signal' as const,
            },
          },
        ]
      )
    ).toBe(false);
  });

  it('rejects a durable source copied into a different assembly tab', () => {
    expect(() => laneFromIndexedGenomeDataTrack(PERSISTED, 'ce11')).toThrow(
      'belongs to assembly grch38, not ce11'
    );
  });

  it('rejects a receipt or UCSC genome that disagrees with the active assembly', () => {
    expect(() =>
      laneFromIndexedGenomeDataTrack(
        {
          ...PERSISTED,
          source: {
            ...PERSISTED.source,
            referenceReceipt: {
              ...PERSISTED.source.referenceReceipt,
              assemblyId: 'ce11',
            },
          },
        },
        'grch38'
      )
    ).toThrow('receipt belongs to assembly ce11, not grch38');

    expect(() =>
      laneFromIndexedGenomeDataTrack(
        {
          ...PERSISTED,
          source: {
            ...PERSISTED.source,
            provenance: { ...PERSISTED.source.provenance, ucscGenome: 'ce11' },
          },
        },
        'grch38'
      )
    ).toThrow('maps to UCSC genome hg38, not ce11');
  });
});
