import { describe, expect, it } from 'vitest';

import { annotationCanonicalIdentityV2 } from '../../../geometry/annotation-canonical-identity-v2';
import { annotationTypeBadgeStyle, featureTypeColor } from '../../../feature-colors';
import type { Feature } from '../../../types';
import {
  decodePrepackedAnnotationInteractionFeatureV2,
  findPrepackedAnnotationFeatureByCanonicalIdentityV2,
  findPrepackedAnnotationFeatureByRendererIdV2,
  queryPrepackedAnnotationInteractionIndexV2,
  validatePrepackedAnnotationInteractionVisualCouplingV2,
} from './prepacked-annotation-interaction-index-v2';
import {
  PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
  PREPACKED_ANNOTATION_INTERACTION_TOKEN,
  PREPACKED_ANNOTATION_LANE_TOKEN,
  PREPACKED_ANNOTATION_MAPPER_TOKEN,
  PREPACKED_ANNOTATION_PARTITION_SPAN_BP,
  prepackedAnnotationSceneArtifactKey,
  type PrepackedAnnotationSceneMetadata,
} from './prepacked-annotation-scene';
import { compilePrepackedAnnotationScene } from './compile-prepacked-annotation-scene';
import {
  TranscriptPageBundleCompileError,
  compileTranscriptPageBundle,
  type CompileTranscriptPageBundleInput,
} from './compile-transcript-page-bundle';

const GENOME_IDENTITY = 'assembly-source';
const GENOME_LENGTH = 5_000;

function transcript(overrides: Partial<Feature> = {}): Feature {
  return {
    id: 9001,
    type: 'mRNA',
    annotationTrackId: 'mRNA',
    annotationTrackLane: 0,
    start: 100,
    end: 400,
    direction: 'forward',
    displayName: 'TX1',
    color: 0x112233,
    lane: 0,
    exons: [{ start: 101, end: 400 }],
    transcriptId: 'NM_1.1',
    sourceId: 'rna-TX1',
    ...overrides,
  };
}

function input(
  overrides: Partial<CompileTranscriptPageBundleInput> = {}
): CompileTranscriptPageBundleInput {
  return {
    ownerKey: 'page-owner:opaque-policy-is-not-parsed',
    features: [transcript()],
    genomeIdentity: GENOME_IDENTITY,
    genomeLengthBp: GENOME_LENGTH,
    themeMode: 'light',
    annotationBarHeightPx: 14,
    partitionSpanBp: 1_000,
    laneCapacity: 12,
    laneContractIdentity: 'source-lanes.v1',
    ...overrides,
  };
}

function prepackedMetadata(): PrepackedAnnotationSceneMetadata {
  return {
    genomeIdentity: GENOME_IDENTITY,
    genomeLengthBp: GENOME_LENGTH,
    partitionSpanBp: PREPACKED_ANNOTATION_PARTITION_SPAN_BP,
    artifactKey: prepackedAnnotationSceneArtifactKey({
      themeMode: 'light',
      trackType: 'mRNA',
    }),
    themeMode: 'light',
    trackType: 'mRNA',
    annotationBarHeightPx: 14,
    laneAlgorithmToken: PREPACKED_ANNOTATION_LANE_TOKEN,
    mapperContractToken: PREPACKED_ANNOTATION_MAPPER_TOKEN,
    geometryContractToken: PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
    interactionContractToken: PREPACKED_ANNOTATION_INTERACTION_TOKEN,
  };
}

describe('compileTranscriptPageBundle', () => {
  it('is byte- and interaction-equivalent to the prepacked scene wrapper', () => {
    const features = [
      transcript({
        exons: [
          { start: 101, end: 180 },
          { start: 250, end: 400 },
        ],
        cds: [{ start: 130, end: 350 }],
      }),
      transcript({
        id: 9002,
        annotationTrackLane: 11,
        start: 500,
        end: 900,
        direction: 'reverse',
        displayName: 'TX2',
        transcriptId: 'NM_2.1',
        sourceId: 'rna-TX2',
        exons: [{ start: 501, end: 900 }],
      }),
    ];
    const metadata = prepackedMetadata();
    const generic = compileTranscriptPageBundle({
      ownerKey: 'same-owner',
      features,
      genomeIdentity: metadata.genomeIdentity,
      genomeLengthBp: metadata.genomeLengthBp,
      themeMode: metadata.themeMode,
      annotationBarHeightPx: metadata.annotationBarHeightPx,
      partitionSpanBp: metadata.partitionSpanBp,
      laneCapacity: null,
      laneContractIdentity: metadata.laneAlgorithmToken,
    });
    const wrapped = compilePrepackedAnnotationScene({
      ownerKey: 'same-owner',
      features,
      metadata,
    });

    expect(generic.status).toBe('compiled');
    expect(wrapped.gpuReadyScene).toEqual(generic.gpuReadyScene);
    expect(wrapped.interactionIndex).toEqual(generic.interactionIndex);
    expect(wrapped.scene.featureFamilyIndices).toEqual(new Uint32Array(features.length));
    validatePrepackedAnnotationInteractionVisualCouplingV2(
      generic.interactionIndex,
      generic.gpuReadyScene,
      GENOME_LENGTH
    );
  });

  it('returns an explicit coupled valid-empty bundle instead of throwing', () => {
    const bundle = compileTranscriptPageBundle(input({ features: [] }));
    expect(bundle).toMatchObject({
      status: 'empty',
      featureCount: 0,
      renderedFeatureCount: 0,
      sortedPrimitives: [],
    });
    expect(bundle.gpuReadyScene.packedInstanceData).toEqual(new Float32Array());
    expect(bundle.gpuReadyScene.featureIndices).toEqual(new Uint32Array());
    expect(bundle.gpuReadyScene.partitions).toEqual([]);
    expect(bundle.interactionIndex).toMatchObject({ featureCount: 0, primitiveCount: 0 });
    validatePrepackedAnnotationInteractionVisualCouplingV2(
      bundle.interactionIndex,
      bundle.gpuReadyScene,
      GENOME_LENGTH
    );

    const outlineOnly = compileTranscriptPageBundle(
      input({
        features: [
          transcript({
            annotationTrackLane: undefined,
            outlineOnly: true,
          }),
        ],
      })
    );
    expect(outlineOnly.status).toBe('empty');
    expect(outlineOnly.interactionIndex.featureCount).toBe(1);
    expect(outlineOnly.interactionIndex.primitiveCount).toBe(0);
  });

  it('compiles one seam-spanning refined mRNA exactly once across instance partitions', () => {
    const spanning = transcript({
      id: 77,
      start: 900,
      end: 1_250,
      direction: 'forward',
      exons: [
        { start: 901, end: 950 },
        { start: 1_101, end: 1_250 },
      ],
      cds: [{ start: 920, end: 1_200 }],
      transcriptId: 'NM_SEAM.1',
      sourceId: 'rna-SEAM',
    });
    const bundle = compileTranscriptPageBundle(input({ features: [spanning] }));
    expect(bundle.status).toBe('compiled');
    expect(new Set(bundle.gpuReadyScene.featureIndices)).toEqual(new Set([0]));
    expect(bundle.gpuReadyScene.partitions.map(({ partitionIndex }) => partitionIndex)).toEqual([
      0, 1,
    ]);
    expect(bundle.renderedFeatureCount).toBe(1);
    expect(bundle.interactionIndex.featureCount).toBe(1);
    const hits: number[] = [];
    queryPrepackedAnnotationInteractionIndexV2(
      bundle.interactionIndex,
      1_150,
      1_160,
      (featureIndex) => hits.push(featureIndex)
    );
    expect(hits).toEqual([0]);
    validatePrepackedAnnotationInteractionVisualCouplingV2(
      bundle.interactionIndex,
      bundle.gpuReadyScene,
      GENOME_LENGTH
    );
  });

  it('treats owner keys as opaque and compiles theme-specific visual bytes', () => {
    const ownerKey = 'source\u0000policy:expanded?no-parser\u0000page=chr1:0';
    const light = compileTranscriptPageBundle(input({ ownerKey, themeMode: 'light' }));
    const dark = compileTranscriptPageBundle(input({ ownerKey, themeMode: 'dark' }));
    expect(light.ownerKey).toBe(ownerKey);
    expect(dark.ownerKey).toBe(ownerKey);
    expect(light.sortedPrimitives.map(({ color }) => color)).not.toEqual(
      dark.sortedPrimitives.map(({ color }) => color)
    );
    expect(light.interactionIndex).toEqual(dark.interactionIndex);
  });

  it('keeps a subclassed non-RNA row on the raw feature-type color despite exon-range transport', () => {
    const color = featureTypeColor('regulatory');
    const regulatory = transcript({
      type: 'regulatory',
      annotationTrackId: 'enhancer',
      color,
      transcriptId: undefined,
      sourceId: 'regulatory-1',
      exons: [{ start: 101, end: 400 }],
      cds: [],
    });
    const bundle = compileTranscriptPageBundle(
      input({ mode: 'resident-page', features: [regulatory] })
    );

    expect(bundle.status).toBe('compiled');
    expect(bundle.sortedPrimitives).toHaveLength(1);
    expect(bundle.sortedPrimitives[0].color).toBe(color);
    expect(annotationTypeBadgeStyle('regulatory', 'light').background).toBe('#14b8a6');
  });

  it('fails closed when any refined filled transcript lacks its local lane', () => {
    expect(() =>
      compileTranscriptPageBundle(
        input({
          features: [transcript(), transcript({ id: 2, annotationTrackLane: undefined })],
        })
      )
    ).toThrowError(
      expect.objectContaining<Partial<TranscriptPageBundleCompileError>>({
        code: 'missing-local-lane',
      })
    );
    expect(() =>
      compileTranscriptPageBundle(
        input({
          laneCapacity: 2,
          features: [transcript({ annotationTrackLane: 2 })],
        })
      )
    ).toThrowError(
      expect.objectContaining<Partial<TranscriptPageBundleCompileError>>({
        code: 'local-lane-out-of-range',
      })
    );
  });

  it('preserves durable canonical interaction identity and explicit global renderer IDs', () => {
    const features = [
      transcript({ id: 41, sourceId: 'source-A', transcriptId: 'tx-A' }),
      transcript({
        id: 97,
        sourceId: 'source-B',
        transcriptId: 'tx-B',
        start: 500,
        end: 700,
        exons: [{ start: 501, end: 700 }],
      }),
    ];
    const bundle = compileTranscriptPageBundle(
      input({ features, rendererIdForFeature: (candidate) => candidate.id })
    );
    const firstOrdinal = findPrepackedAnnotationFeatureByRendererIdV2(bundle.interactionIndex, 41);
    const secondOrdinal = findPrepackedAnnotationFeatureByRendererIdV2(bundle.interactionIndex, 97);
    expect(firstOrdinal).toBe(0);
    expect(secondOrdinal).toBe(1);
    expect(
      decodePrepackedAnnotationInteractionFeatureV2(bundle.interactionIndex, 0).rendererId
    ).toBe(41);
    expect(
      decodePrepackedAnnotationInteractionFeatureV2(bundle.interactionIndex, 1).rendererId
    ).toBe(97);

    const expectedCanonical = annotationCanonicalIdentityV2({
      genomeIdentity: GENOME_IDENTITY,
      sourceId: 'source-B',
      transcriptId: 'tx-B',
      trackId: 'mRNA',
      type: 'mRNA',
      startBp: 500,
      endBp: 700,
      direction: 'forward',
    });
    expect(
      findPrepackedAnnotationFeatureByCanonicalIdentityV2(
        bundle.interactionIndex,
        expectedCanonical
      )
    ).toBe(1);
    expect(
      decodePrepackedAnnotationInteractionFeatureV2(bundle.interactionIndex, 1).canonicalIdentity
    ).toBe(expectedCanonical);
  });

  it('validates every explicit compilation contract input without policy inference', () => {
    const cases: Array<
      [Partial<CompileTranscriptPageBundleInput>, TranscriptPageBundleCompileError['code']]
    > = [
      [{ ownerKey: '' }, 'invalid-owner'],
      [{ genomeIdentity: '' }, 'invalid-genome-identity'],
      [{ genomeLengthBp: 0 }, 'invalid-genome-length'],
      [{ themeMode: 'sepia' as 'light' }, 'invalid-theme'],
      [{ annotationBarHeightPx: 0 }, 'invalid-bar-height'],
      [{ partitionSpanBp: 0 }, 'invalid-partition-span'],
      [{ laneCapacity: 0 }, 'invalid-lane-capacity'],
      [{ laneContractIdentity: '' }, 'invalid-lane-contract'],
    ];
    for (const [override, code] of cases) {
      expect(() => compileTranscriptPageBundle(input(override))).toThrowError(
        expect.objectContaining({ code })
      );
    }
  });
});
