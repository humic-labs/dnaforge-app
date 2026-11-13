import { describe, expect, it } from 'vitest';

import {
  prepackedAnnotationSceneBankCompatible,
  prepackedAnnotationSceneMetadataEqual,
  type PrepackedAnnotationSceneMetadataView,
} from './annotation-prepacked-metadata';

function meta(
  overrides: Partial<PrepackedAnnotationSceneMetadataView> = {}
): PrepackedAnnotationSceneMetadataView {
  return {
    genomeIdentity: 'g1',
    genomeLengthBp: 1000,
    partitionSpanBp: 100,
    artifactKey: 'a1',
    themeMode: 'light',
    trackType: 'mRNA',
    annotationBarHeightPx: 8,
    laneAlgorithmToken: 'lane-v1',
    mapperContractToken: 'map-v1',
    geometryContractToken: 'geo-v1',
    interactionContractToken: 'hit-v1',
    ...overrides,
  };
}

describe('annotation-prepacked-metadata', () => {
  it('requires full field equality including theme and track', () => {
    expect(prepackedAnnotationSceneMetadataEqual(meta(), meta())).toBe(true);
    expect(prepackedAnnotationSceneMetadataEqual(meta(), meta({ themeMode: 'dark' }))).toBe(false);
    expect(prepackedAnnotationSceneMetadataEqual(meta(), meta({ trackType: 'gene' }))).toBe(false);
  });

  it('bank compatibility ignores theme/artifact/track (palette variants share bank)', () => {
    expect(
      prepackedAnnotationSceneBankCompatible(
        meta({ themeMode: 'light', artifactKey: 'a-light', trackType: 'mRNA' }),
        meta({ themeMode: 'dark', artifactKey: 'a-dark', trackType: 'CDS' })
      )
    ).toBe(true);
    expect(
      prepackedAnnotationSceneBankCompatible(meta(), meta({ geometryContractToken: 'geo-v2' }))
    ).toBe(false);
  });
});
