// @vitest-environment node

import type { GenomeFeature, ResolvedTranscript } from '@waypoint/genome-data';
import { describe, expect, it } from 'vitest';

import { processAssemblyOverviewChromosomeFeatures } from './assembly-annotation-feature-pipeline';

function resolvedTranscript(
  transcriptId: string,
  input: { start: number; end: number; primary?: boolean }
): ResolvedTranscript {
  return {
    chrom: 'chrFixture',
    source: 'fixture',
    type: 'mRNA',
    start: input.start,
    end: input.end,
    score: null,
    strand: '+',
    phase: null,
    attributes: {
      ID: [transcriptId],
      gene: ['fixture-gene'],
      ...(input.primary ? { tag: ['MANE_Select'] } : {}),
    },
    raw: '',
    exons: [
      { start: input.start + 1, end: input.start + 50 },
      { start: input.end - 49, end: input.end },
    ],
    cds: [{ start: input.start + 20, end: input.end - 20 }],
    transcriptId,
    geneId: 'fixture-gene',
  };
}

describe('assembly annotation feature pipeline', () => {
  it('applies canonical/expanded policy without changing full glyph geometry or global placement', () => {
    const source = [
      resolvedTranscript('TX-PRIMARY', { start: 100, end: 900, primary: true }),
      resolvedTranscript('TX-ALT', { start: 120, end: 800 }),
    ];
    const common = {
      chrom: 'chrFixture',
      chromosomeLengthBp: 10_000,
      globalStartBp: 50_000,
      rawOrResolvedFeatures: source,
      featureModel: 'resolved-transcript-v2' as const,
      glyphV2Enabled: true,
    };

    const canonical = processAssemblyOverviewChromosomeFeatures({
      ...common,
      isoformMode: 'canonical',
    });
    const expanded = processAssemblyOverviewChromosomeFeatures({
      ...common,
      isoformMode: 'expanded',
    });

    expect(canonical.map((feature) => feature.transcriptId)).toEqual(['TX-PRIMARY']);
    expect(expanded.map((feature) => feature.transcriptId).sort()).toEqual([
      'TX-ALT',
      'TX-PRIMARY',
    ]);
    expect(canonical[0]).toMatchObject({
      start: 50_100,
      end: 50_900,
      exons: [
        { start: 50_101, end: 50_150 },
        { start: 50_851, end: 50_900 },
      ],
      cds: [{ start: 50_120, end: 50_880 }],
      annotationTrackId: 'mRNA',
    });
  });

  it('preserves bacterial gene-to-CDS annotations as compound CDS geometry', () => {
    const source: GenomeFeature[] = [
      {
        chrom: 'chrFixture',
        source: 'fixture',
        type: 'gene',
        start: 100,
        end: 900,
        score: null,
        strand: '+',
        phase: null,
        attributes: { ID: ['gene-direct'], gene: ['direct'] },
        raw: '',
      },
      {
        chrom: 'chrFixture',
        source: 'fixture',
        type: 'CDS',
        start: 100,
        end: 900,
        score: null,
        strand: '+',
        phase: '0',
        attributes: {
          ID: ['cds-direct'],
          Parent: ['gene-direct'],
          gene: ['direct'],
        },
        raw: '',
      },
    ];

    const features = processAssemblyOverviewChromosomeFeatures({
      chrom: 'chrFixture',
      chromosomeLengthBp: 10_000,
      globalStartBp: 50_000,
      rawOrResolvedFeatures: source,
      featureModel: 'raw-gff3',
      isoformMode: 'canonical',
      glyphV2Enabled: true,
    });

    expect(features).toHaveLength(1);
    expect(features[0]).toMatchObject({
      type: 'CDS',
      annotationTrackId: 'CDS',
      compositeKind: 'compound-cds',
      start: 50_100,
      end: 50_900,
      exons: [{ start: 50_101, end: 50_900 }],
      cds: [{ start: 50_101, end: 50_900 }],
    });
  });
});
