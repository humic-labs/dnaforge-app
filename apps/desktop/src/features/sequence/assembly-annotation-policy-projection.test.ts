// @vitest-environment node

import type { ResolvedTranscript } from '@waypoint/genome-data';
import {
  buildAnnotationPolicyGpuInstanceDataV1,
  buildAnnotationPolicyProjectionTableV1,
  projectAnnotationPolicyV1,
  resolveAnnotationPolicyGpuInstanceV1,
} from '@waypoint/genome-renderer/pure';
import { describe, expect, it } from 'vitest';

import {
  buildAssemblyAnnotationPolicyProjectionIr,
  projectAssemblyAnnotationPolicy,
  type AssemblyAnnotationLaneLimit,
} from './assembly-annotation-policy-projection';
import { processAssemblyOverviewChromosomeFeatures } from './assembly-annotation-feature-pipeline';
import { resolveAnnotationFeaturesForViewer } from './components/indexed-genome-legacy-adapter';
import type { TranscriptDisplayMode } from './components/isoform-collapse';

const CHROM = 'chrFixture';
const CHROMOSOME_LENGTH_BP = 100_000;

function resolvedTranscript(input: {
  geneIndex: number;
  isoform: 'alternative' | 'primary';
  type: 'mRNA' | 'lncRNA';
}): ResolvedTranscript {
  const transcriptId = `TX-${input.geneIndex}-${input.isoform}`;
  const start = 100 + input.geneIndex;
  const end = 90_000 - input.geneIndex;
  return {
    chrom: CHROM,
    source: 'fixture',
    type: input.type,
    start,
    end,
    score: null,
    strand: input.geneIndex % 2 === 0 ? '+' : '-',
    phase: null,
    attributes: {
      ID: [transcriptId],
      gene: [`fixture-gene-${input.geneIndex}`],
      ...(input.isoform === 'primary' ? { tag: ['MANE_Select'] } : {}),
    },
    raw: '',
    exons: [
      { start: start + 1, end: start + 50 },
      { start: end - 49, end },
    ],
    cds: [{ start: start + 20, end: end - 20 }],
    transcriptId,
    geneId: `fixture-gene-${input.geneIndex}`,
  };
}

function overlappingIsoformFixture(): ResolvedTranscript[] {
  const features: ResolvedTranscript[] = [];
  for (let geneIndex = 0; geneIndex < 30; geneIndex += 1) {
    const type = geneIndex % 2 === 0 ? 'mRNA' : 'lncRNA';
    features.push(resolvedTranscript({ geneIndex, isoform: 'alternative', type }));
    features.push(resolvedTranscript({ geneIndex, isoform: 'primary', type }));
  }
  return features;
}

function transcriptId(feature: { sourceGeometry: { transcriptId?: string } }): string {
  const id = feature.sourceGeometry.transcriptId;
  if (!id) throw new Error('Fixture projection lost transcript identity');
  return id;
}

describe('assembly annotation policy-projection IR', () => {
  it('carries stable identity, source geometry, and both policy lanes from one expanded input', () => {
    const source = overlappingIsoformFixture();
    const resolvedExpanded = resolveAnnotationFeaturesForViewer(
      source,
      'resolved-transcript-v2',
      true
    );
    const ir = buildAssemblyAnnotationPolicyProjectionIr({
      chrom: CHROM,
      chromosomeLengthBp: CHROMOSOME_LENGTH_BP,
      resolvedExpandedFeatures: resolvedExpanded,
    });

    expect(ir.features).toHaveLength(source.length);
    expect(new Set(ir.features.map((feature) => feature.stableFeatureIdentity)).size).toBe(
      source.length
    );
    const primary = ir.features.find(
      (feature) => feature.sourceGeometry.transcriptId === 'TX-0-primary'
    );
    const alternative = ir.features.find(
      (feature) => feature.sourceGeometry.transcriptId === 'TX-0-alternative'
    );
    expect(primary).toMatchObject({
      sourceGeometry: {
        chrom: CHROM,
        type: 'mRNA',
        start: 100,
        end: 90_000,
        exons: [
          { start: 101, end: 150 },
          { start: 89_951, end: 90_000 },
        ],
        cds: [{ start: 120, end: 89_980 }],
      },
      expandedLane: expect.any(Number),
      expandedTrackLane: expect.any(Number),
      canonicalLane: expect.any(Number),
      canonicalTrackLane: expect.any(Number),
    });
    expect(alternative?.canonicalLane).toBeNull();
    expect(alternative?.canonicalTrackLane).toBeNull();
  });

  it.each([8, 12, 24, null] as const)(
    'matches current canonical and expanded membership, global lanes, local lanes, and overflow at lane limit %s',
    (laneLimit) => {
      const source = overlappingIsoformFixture();
      const resolvedExpanded = resolveAnnotationFeaturesForViewer(
        source,
        'resolved-transcript-v2',
        true
      );
      const ir = buildAssemblyAnnotationPolicyProjectionIr({
        chrom: CHROM,
        chromosomeLengthBp: CHROMOSOME_LENGTH_BP,
        resolvedExpandedFeatures: resolvedExpanded,
      });

      for (const isoformMode of ['expanded', 'canonical'] as const) {
        expectProjectionToMatchCurrentPipeline({ source, ir, isoformMode, laneLimit });
      }
    }
  );

  it('round-trips the lane-complete IR through the durable runtime policy contract exactly', () => {
    const source = overlappingIsoformFixture();
    const resolvedExpanded = resolveAnnotationFeaturesForViewer(
      source,
      'resolved-transcript-v2',
      true
    );
    const ir = buildAssemblyAnnotationPolicyProjectionIr({
      chrom: CHROM,
      chromosomeLengthBp: CHROMOSOME_LENGTH_BP,
      resolvedExpandedFeatures: resolvedExpanded,
    });
    const table = buildAnnotationPolicyProjectionTableV1({
      features: ir.features.map((feature) => ({
        annotationType: feature.annotationType,
        expandedLane: feature.expandedLane,
        expandedTrackLane: feature.expandedTrackLane,
        canonicalLane: feature.canonicalLane,
        canonicalTrackLane: feature.canonicalTrackLane,
      })),
      expandedBandOrder: ir.expandedBandOrder,
      canonicalBandOrder: ir.canonicalBandOrder,
    });
    const primitiveFeatureIndices = Uint32Array.from(
      ir.features.map((_feature, featureIndex) => featureIndex)
    );
    const policyGpuData = buildAnnotationPolicyGpuInstanceDataV1(primitiveFeatureIndices, table);

    for (const laneLimit of [8, 12, 24, null] as const) {
      for (const isoformMode of ['expanded', 'canonical'] as const) {
        const current = processAssemblyOverviewChromosomeFeatures({
          chrom: CHROM,
          chromosomeLengthBp: CHROMOSOME_LENGTH_BP,
          globalStartBp: 0,
          rawOrResolvedFeatures: source,
          featureModel: 'resolved-transcript-v2',
          isoformMode,
          laneLimit,
          glyphV2Enabled: true,
        });
        const projected = projectAnnotationPolicyV1(table, { isoformMode, laneLimit });
        const currentByTranscript = new Map(
          current.map((feature) => [
            feature.transcriptId,
            { lane: feature.lane, trackLane: feature.annotationTrackLane },
          ])
        );
        const artifactByTranscript = new Map(
          projected.features.map((feature) => [
            transcriptId(ir.features[feature.featureIndex]),
            { lane: feature.lane, trackLane: feature.trackLane },
          ])
        );
        expect([...artifactByTranscript.entries()].sort()).toEqual(
          [...currentByTranscript.entries()].sort()
        );
        expect(projected.typeFilteredCount).toBe(isoformMode === 'expanded' ? 60 : 30);
        expect(projected.droppedCount).toBe(projected.typeFilteredCount - current.length);

        const projectedByFeatureIndex = new Map(
          projected.features.map((feature) => [feature.featureIndex, feature])
        );
        for (let featureIndex = 0; featureIndex < ir.features.length; featureIndex += 1) {
          const expected = projectedByFeatureIndex.get(featureIndex);
          const gpu = resolveAnnotationPolicyGpuInstanceV1(policyGpuData, featureIndex, {
            isoformMode,
            laneLimit,
          });
          expect(gpu.visible).toBe(Boolean(expected));
          if (!expected) {
            expect(gpu).toMatchObject({
              lane: null,
              trackLane: null,
              offsetCenterPx: null,
            });
            continue;
          }
          expect(gpu.trackLane).toBe(expected.trackLane);
          expect(gpu.lane).toBe(expected.trackLane);
          expect(gpu.offsetCenterPx).toBe(-7 - expected.trackLane * 16);
        }
      }
    }
  });
});

function expectProjectionToMatchCurrentPipeline(input: {
  source: ResolvedTranscript[];
  ir: ReturnType<typeof buildAssemblyAnnotationPolicyProjectionIr>;
  isoformMode: TranscriptDisplayMode;
  laneLimit: AssemblyAnnotationLaneLimit;
}): void {
  const current = processAssemblyOverviewChromosomeFeatures({
    chrom: CHROM,
    chromosomeLengthBp: CHROMOSOME_LENGTH_BP,
    globalStartBp: 0,
    rawOrResolvedFeatures: input.source,
    featureModel: 'resolved-transcript-v2',
    isoformMode: input.isoformMode,
    laneLimit: input.laneLimit,
    glyphV2Enabled: true,
  });
  const projected = projectAssemblyAnnotationPolicy(input.ir, {
    isoformMode: input.isoformMode,
    laneLimit: input.laneLimit,
  });

  const currentByTranscript = new Map(
    current.map((feature) => [
      feature.transcriptId,
      { lane: feature.lane, trackLane: feature.annotationTrackLane },
    ])
  );
  const projectedByTranscript = new Map(
    projected.features.map((feature) => [
      transcriptId(feature),
      { lane: feature.lane, trackLane: feature.trackLane },
    ])
  );
  expect([...projectedByTranscript.entries()].sort()).toEqual(
    [...currentByTranscript.entries()].sort()
  );

  const policySourceCount = input.isoformMode === 'expanded' ? input.source.length : 30;
  expect(projected.typeFilteredCount).toBe(policySourceCount);
  expect(projected.droppedCount).toBe(policySourceCount - current.length);

  const allPolicyTranscriptIds =
    input.isoformMode === 'expanded'
      ? input.source.map((feature) => feature.transcriptId)
      : input.source
          .filter((feature) => feature.attributes.tag?.includes('MANE_Select'))
          .map((feature) => feature.transcriptId);
  const currentOverflow = allPolicyTranscriptIds
    .filter((id) => !currentByTranscript.has(id))
    .sort();
  const projectedOverflow = allPolicyTranscriptIds
    .filter((id) => !projectedByTranscript.has(id))
    .sort();
  expect(projectedOverflow).toEqual(currentOverflow);
}
