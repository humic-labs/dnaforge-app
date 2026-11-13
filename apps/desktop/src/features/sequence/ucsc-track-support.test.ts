// @vitest-environment node

import type { UcscCatalogLeaf } from '@waypoint/genome-data';
import { describe, expect, it } from 'vitest';

import { classifyUcscCatalogTrackSupport } from './ucsc-track-support';

const BASE_TRACK: UcscCatalogLeaf = {
  sourceKind: 'ucsc-native',
  catalogId: 'hg38:track',
  track: 'track',
  shortLabel: 'Track',
  longLabel: 'Track',
  scientificKind: 'interval',
  formatId: 'ucsc-native',
  assembly: { ucscGenome: 'hg38', aliases: ['GRCh38'] },
};

describe('classifyUcscCatalogTrackSupport', () => {
  it('supports native REST, quantitative BBI, and semantic BigBed paths', () => {
    expect(classifyUcscCatalogTrackSupport(BASE_TRACK)).toEqual({
      supported: true,
      path: 'native-table',
    });
    expect(
      classifyUcscCatalogTrackSupport({
        ...BASE_TRACK,
        formatId: 'bigwig',
        scientificKind: 'quantitative',
      })
    ).toEqual({ supported: true, path: 'bigwig-quantitative' });
    for (const scientificKind of ['transcript', 'interval', 'peak', 'repeat'] as const) {
      expect(
        classifyUcscCatalogTrackSupport({
          ...BASE_TRACK,
          formatId: 'bigbed',
          scientificKind,
        })
      ).toEqual({ supported: true, path: 'bigbed-semantic' });
      expect(
        classifyUcscCatalogTrackSupport({
          ...BASE_TRACK,
          sourceKind: 'ucsc-hub',
          hubUrl: 'https://hub.example.org/hub.txt',
          formatId: 'bigbed',
          scientificKind,
        })
      ).toEqual({ supported: true, path: 'bigbed-semantic' });
    }
  });

  it('admits every meaning a native UCSC table can carry, not interval alone', () => {
    for (const scientificKind of ['interval', 'transcript', 'peak', 'repeat'] as const) {
      expect(classifyUcscCatalogTrackSupport({ ...BASE_TRACK, scientificKind })).toEqual({
        supported: true,
        path: 'native-table',
      });
    }
  });

  it('streams hub reads and calls through the aligned-read and variant paths', () => {
    const hub = {
      ...BASE_TRACK,
      sourceKind: 'ucsc-hub' as const,
      hubUrl: 'https://hub.example.org/hub.txt',
    };
    expect(
      classifyUcscCatalogTrackSupport({
        ...hub,
        scientificKind: 'reads',
        formatId: 'bam',
        bigDataUrl: 'reads.cram',
      })
    ).toEqual({ supported: true, path: 'hub-reads' });
    expect(
      classifyUcscCatalogTrackSupport({
        ...hub,
        scientificKind: 'variants',
        formatId: 'vcf',
        bigDataUrl: 'https://hub.example.org/calls.vcf.gz',
      })
    ).toEqual({ supported: true, path: 'hub-variants' });
  });

  it.each([
    [{ ...BASE_TRACK, sourceKind: 'ucsc-hub' as const }, 'proven interval path'],
    [
      {
        ...BASE_TRACK,
        sourceKind: 'ucsc-hub' as const,
        scientificKind: 'reads' as const,
        formatId: 'bam' as const,
      },
      'publishes no indexed file',
    ],
    [
      { ...BASE_TRACK, formatId: 'bigbed' as const, scientificKind: 'quantitative' as const },
      'scientific meaning',
    ],
    [{ ...BASE_TRACK, scientificKind: 'reads' as const, formatId: 'bam' as const }, 'BAM'],
    [{ ...BASE_TRACK, scientificKind: 'variants' as const, formatId: 'vcf' as const }, 'mutation'],
  ])('rejects an unproven source shape with a stable reason', (track, reasonFragment) => {
    expect(classifyUcscCatalogTrackSupport(track)).toMatchObject({
      supported: false,
      reason: expect.stringContaining(reasonFragment),
    });
  });
});
