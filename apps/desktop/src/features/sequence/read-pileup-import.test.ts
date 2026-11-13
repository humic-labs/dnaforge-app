import { describe, expect, it } from 'vitest';

import { buildReadPileupDataset } from './read-pileup-import';

describe('buildReadPileupDataset', () => {
  it('derives a stable source identity and a renderer-ready pileup lane', () => {
    const first = buildReadPileupDataset({
      assemblyId: 'grch38',
      assemblyDisplayName: 'GRCh38',
      bamPath: '/data/HG002.bam',
      indexPath: '/data/HG002.bam.bai',
    });
    const second = buildReadPileupDataset({
      assemblyId: 'grch38',
      assemblyDisplayName: 'GRCh38',
      bamPath: '/data/HG002.bam',
    });

    expect(first.trackId).toBe(second.trackId);
    expect(first).toMatchObject({
      kind: 'pileup',
      trackType: 'pileup-genomewide',
      label: 'GRCh38: HG002.bam',
      trackPx: 276,
      source: { bamPath: '/data/HG002.bam', indexPath: '/data/HG002.bam.bai' },
    });
  });

  it('does not collapse distinct BAM paths that collided under the legacy 32-bit hash', () => {
    const first = buildReadPileupDataset({
      assemblyId: 'grch38',
      assemblyDisplayName: 'GRCh38',
      bamPath: '/data/1k2ik54-hbn3p3-93ib8q.bam',
    });
    const second = buildReadPileupDataset({
      assemblyId: 'grch38',
      assemblyDisplayName: 'GRCh38',
      bamPath: '/data/bvmwbk-ndawov-rit3rm.bam',
    });

    expect(first.trackId).not.toBe(second.trackId);
  });

  it('carries the exact CRAM, CRAI, and reference FASTA identities into the lane', () => {
    const dataset = buildReadPileupDataset({
      assemblyId: 'grch38',
      assemblyDisplayName: 'GRCh38',
      bamPath: '/data/NA12718.final.cram',
      indexPath: '/data/NA12718.final.cram.crai',
      referencePath: '/references/GRCh38.fa',
    });

    expect(dataset).toMatchObject({
      label: 'GRCh38: NA12718.final.cram',
      source: {
        bamPath: '/data/NA12718.final.cram',
        indexPath: '/data/NA12718.final.cram.crai',
        referencePath: '/references/GRCh38.fa',
      },
    });
  });
});
