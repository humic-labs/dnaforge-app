import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { AnnotationScenePrimitiveV1 } from './annotation-scene-binary-v1';
import { buildPartitionedTranscriptScene } from './partitioned-transcript-scene';
import {
  packGpuReadyPartitionedTranscriptSceneBinaryV4,
  resealPartitionedTranscriptSceneBinaryDatasetContractV4,
} from './partitioned-transcript-scene-binary-v4';
import {
  assertPartitionedTranscriptSceneRangeCatalogV1,
  buildPartitionedTranscriptSceneRangeCatalogV1,
  resealPartitionedTranscriptSceneRangeCatalogV1,
} from './partitioned-transcript-scene-range-catalog-v1';
import { buildPrepackedAnnotationInteractionIndexV2 } from './prepacked-annotation-interaction-index-v2';

const sha256 = async (bytes: Uint8Array): Promise<string> =>
  createHash('sha256').update(bytes).digest('hex');

describe('partitioned transcript scene range catalog v1', () => {
  it('authenticates each coordinate partition against one exact parent scene', async () => {
    const source = [primitive(0, 10, 40, 0), primitive(1, 110, 160, 1)];
    const scene = buildPartitionedTranscriptScene(source, 100);
    const packed = await packGpuReadyPartitionedTranscriptSceneBinaryV4({
      datasetContract: {
        datasetId: 'fixture',
        datasetVersion: '1',
        sourceSha256: 'a'.repeat(64),
      },
      assemblyContract: { assemblyId: 'fixture', assemblyLengthBp: 300 },
      families: [{ id: 'transcript-glyph-v2', kind: 'transcript', metadata: {} }],
      featureFamilyIndices: new Uint32Array([0, 0]),
      scene,
      interactionIndex: buildPrepackedAnnotationInteractionIndexV2(
        [interactionFeature(0, 10, 40, 0), interactionFeature(1, 110, 160, 1)],
        scene.sortedPrimitives
      ),
      policyProjection: {
        features: [policyFeature(0, 0), policyFeature(1, null)],
        expandedBandOrder: ['mRNA'],
        canonicalBandOrder: ['mRNA'],
      },
      payloadSha256: sha256,
    });

    const catalog = await buildPartitionedTranscriptSceneRangeCatalogV1(
      packed.manifest,
      packed.payload,
      sha256
    );

    expect(catalog.expanded.partitions).toHaveLength(2);
    expect(catalog.canonical.partitions).toHaveLength(2);
    for (const mode of [catalog.expanded, catalog.canonical]) {
      for (const partition of mode.partitions) {
        for (const range of [partition.glyphs, partition.featureIndices, partition.lanePrefixes]) {
          expect(
            await sha256(
              packed.payload.subarray(range.byteOffset, range.byteOffset + range.byteLength)
            )
          ).toBe(range.sha256);
        }
      }
    }
    expect(
      await sha256(
        packed.payload.subarray(
          catalog.featureFamilyIndices.byteOffset,
          catalog.featureFamilyIndices.byteOffset + catalog.featureFamilyIndices.byteLength
        )
      )
    ).toBe(catalog.featureFamilyIndices.sha256);
    expect(() =>
      assertPartitionedTranscriptSceneRangeCatalogV1(catalog, packed.manifest)
    ).not.toThrow();

    expect(() =>
      assertPartitionedTranscriptSceneRangeCatalogV1(
        {
          ...catalog,
          sourceScene: { ...catalog.sourceScene, contractSha256: 'b'.repeat(64) },
        },
        packed.manifest
      )
    ).toThrow(/source identity/);

    const installedManifest = await resealPartitionedTranscriptSceneBinaryDatasetContractV4(
      packed.manifest,
      {
        ...packed.manifest.datasetContract,
        sourceSha256: 'c'.repeat(64),
      }
    );
    const installedCatalog = resealPartitionedTranscriptSceneRangeCatalogV1(
      catalog,
      packed.manifest,
      installedManifest
    );
    expect(installedCatalog.sourceScene.contractSha256).toBe(
      installedManifest.integrity.contractSha256
    );
    expect(() =>
      assertPartitionedTranscriptSceneRangeCatalogV1(installedCatalog, installedManifest)
    ).not.toThrow();
    expect(() =>
      resealPartitionedTranscriptSceneRangeCatalogV1(catalog, packed.manifest, {
        ...installedManifest,
        integrity: {
          ...installedManifest.integrity,
          payloadSha256: 'd'.repeat(64),
        },
      })
    ).toThrow(/source identity/);
  });
});

function primitive(
  featureIndex: number,
  startBp: number,
  endBp: number,
  trackLane: number
): AnnotationScenePrimitiveV1 {
  return {
    startBp,
    endBp,
    featureIndex,
    offsetCenter: -7 - trackLane * 16,
    halfH: 7,
    color: 0x123456,
    alpha: 0.85,
    cdsFade: 0,
    dirSign: 1,
  };
}

function interactionFeature(rendererId: number, startBp: number, endBp: number, lane: number) {
  return {
    rendererId,
    startBp,
    endBp,
    lane,
    direction: 'forward' as const,
    displayName: `feature-${rendererId}`,
    type: 'mRNA',
    transcriptId: `TX-${rendererId}`,
    sourceId: `source-${rendererId}`,
    canonicalIdentity: `fixture|mRNA|${rendererId}`,
  };
}

function policyFeature(expandedTrackLane: number, canonicalTrackLane: number | null) {
  return {
    annotationType: 'mRNA',
    expandedLane: expandedTrackLane,
    expandedTrackLane,
    canonicalLane: canonicalTrackLane,
    canonicalTrackLane,
  };
}
