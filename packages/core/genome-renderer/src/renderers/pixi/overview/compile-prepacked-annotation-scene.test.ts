import { describe, expect, it } from 'vitest';

import type { Feature } from '../../../types';
import {
  PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
  PREPACKED_ANNOTATION_INTERACTION_TOKEN,
  PREPACKED_ANNOTATION_LANE_TOKEN,
  PREPACKED_ANNOTATION_MAPPER_TOKEN,
  PREPACKED_ANNOTATION_PARTITION_SPAN_BP,
  prepackedAnnotationSceneArtifactKey,
  type PrepackedAnnotationSceneMetadata,
} from './prepacked-annotation-scene';
import {
  PrepackedAnnotationSceneCompileError,
  compilePrepackedAnnotationScene,
} from './compile-prepacked-annotation-scene';

function metadata(trackType = 'mRNA'): PrepackedAnnotationSceneMetadata {
  return {
    genomeIdentity: 'assembly-source',
    genomeLengthBp: 1_000_000,
    partitionSpanBp: PREPACKED_ANNOTATION_PARTITION_SPAN_BP,
    artifactKey: prepackedAnnotationSceneArtifactKey({
      themeMode: 'light',
      trackType,
    }),
    themeMode: 'light',
    trackType,
    annotationBarHeightPx: 14,
    laneAlgorithmToken: PREPACKED_ANNOTATION_LANE_TOKEN,
    mapperContractToken: PREPACKED_ANNOTATION_MAPPER_TOKEN,
    geometryContractToken: PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
    interactionContractToken: PREPACKED_ANNOTATION_INTERACTION_TOKEN,
  };
}

function transcript(overrides: Partial<Feature> = {}): Feature {
  return {
    id: 0,
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

describe('compilePrepackedAnnotationScene', () => {
  it('compiles exact track-local geometry and coupled interaction without Pixi state', () => {
    const contract = metadata();
    const result = compilePrepackedAnnotationScene({
      ownerKey: 'expanded-owner',
      features: [
        transcript(),
        transcript({
          id: 1,
          annotationTrackLane: 11,
          start: 500,
          end: 900,
          displayName: 'TX2',
          transcriptId: 'NM_2.1',
          sourceId: 'rna-TX2',
          exons: [{ start: 501, end: 900 }],
        }),
      ],
      metadata: contract,
    });

    expect(result.ownerKey).toBe('expanded-owner');
    expect(result.scene.primitives).toEqual([]);
    expect(result.gpuReadyScene?.featureIndices).toEqual(new Uint32Array([0, 1]));
    const stride = 12;
    expect(result.gpuReadyScene?.packedInstanceData[4]).toBe(-7);
    expect(result.gpuReadyScene?.packedInstanceData[stride + 4]).toBe(-183);
    expect(result.interactionIndex.featureCount).toBe(2);
    expect(result.interactionIndex.primitiveCount).toBe(2);
    expect(result.metadata).toEqual(contract);
    expect(result.metadata).not.toBe(contract);
  });

  it('fails closed before packing when one rendered transcript lacks its local lane', () => {
    expect(() =>
      compilePrepackedAnnotationScene({
        ownerKey: 'expanded-owner',
        features: [transcript(), transcript({ id: 1, annotationTrackLane: undefined })],
        metadata: metadata(),
      })
    ).toThrowError(
      expect.objectContaining<Partial<PrepackedAnnotationSceneCompileError>>({
        code: 'missing-local-lane',
      })
    );
  });

  it('uses the same spliced primitive bank for a noncoding RNA without inventing CDS detail', () => {
    const result = compilePrepackedAnnotationScene({
      ownerKey: 'lnc-owner',
      features: [
        transcript({
          type: 'lnc_RNA',
          annotationTrackId: 'lnc_RNA',
          exons: [
            { start: 101, end: 150 },
            { start: 251, end: 300 },
            { start: 351, end: 400 },
          ],
          cds: [],
        }),
      ],
      metadata: metadata('lnc_RNA'),
    });

    expect(result.gpuReadyScene?.featureIndices).toHaveLength(5);
    expect(result.interactionIndex.featureCount).toBe(1);
    expect(result.interactionIndex.primitiveCount).toBe(5);
    expect(result.metadata.trackType).toBe('lnc_RNA');
  });

  it('routes an unlisted RNA subtype with exons through that same spliced bank', () => {
    const result = compilePrepackedAnnotationScene({
      ownerKey: 'antisense-owner',
      features: [
        transcript({
          type: 'antisense_RNA',
          annotationTrackId: 'antisense_RNA',
          exons: [
            { start: 101, end: 150 },
            { start: 251, end: 300 },
          ],
          cds: [],
        }),
      ],
      metadata: metadata('antisense_RNA'),
    });

    expect(result.gpuReadyScene?.featureIndices).toHaveLength(3);
    expect(result.interactionIndex.primitiveCount).toBe(3);
  });

  it('compiles an exonless annotation through the ordinary source-shape primitive', () => {
    const result = compilePrepackedAnnotationScene({
      ownerKey: 'enhancer-owner',
      features: [
        transcript({
          type: 'enhancer',
          annotationTrackId: 'enhancer',
          exons: undefined,
          cds: undefined,
          transcriptId: undefined,
        }),
      ],
      metadata: metadata('enhancer'),
    });

    expect(result.gpuReadyScene?.featureIndices).toEqual(new Uint32Array([0]));
    expect(result.interactionIndex.featureCount).toBe(1);
    expect(result.interactionIndex.primitiveCount).toBe(1);
    expect(result.metadata.trackType).toBe('enhancer');
  });

  it('rejects empty geometry and invalid provenance contracts', () => {
    expect(() =>
      compilePrepackedAnnotationScene({
        ownerKey: '',
        features: [transcript()],
        metadata: metadata(),
      })
    ).toThrowError(expect.objectContaining({ code: 'invalid-owner' }));
    expect(() =>
      compilePrepackedAnnotationScene({
        ownerKey: 'owner',
        features: [],
        metadata: metadata(),
      })
    ).toThrowError(expect.objectContaining({ code: 'empty-geometry' }));
  });
});
