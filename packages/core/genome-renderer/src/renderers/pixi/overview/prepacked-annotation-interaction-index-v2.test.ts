import { describe, expect, it } from 'vitest';

import { annotationCanonicalIdentityV2 } from '../../../geometry/annotation-canonical-identity-v2';
import type { AnnotationScenePrimitiveV1 } from './annotation-scene-binary-v1';
import {
  buildPrepackedAnnotationInteractionIndexV2,
  buildPrepackedAnnotationPrimitiveCsrV2,
  decodePrepackedAnnotationInteractionFeatureV2,
  findPrepackedAnnotationFeatureByCanonicalIdentityV2,
  forEachPrepackedAnnotationFeaturePrimitiveV2,
  projectPrepackedAnnotationFeatureLookupIndexV2,
  queryPrepackedAnnotationInteractionIndexV2,
  validatePrepackedAnnotationFeatureLookupIndexV2,
  validatePrepackedAnnotationInteractionIndexV2,
  type PrepackedAnnotationInteractionFeatureInputV2,
} from './prepacked-annotation-interaction-index-v2';

const features: PrepackedAnnotationInteractionFeatureInputV2[] = [
  {
    rendererId: 101,
    startBp: 99_999_900,
    endBp: 100_000_200,
    lane: 0,
    direction: 'forward',
    displayName: 'SEAM-TX',
    type: 'mRNA',
    transcriptId: 'NM_SEAM.1',
    sourceId: 'rna-seam',
    canonicalIdentity: 'mRNA|rna-seam|NM_SEAM.1|99999900|100000200|forward',
  },
  {
    rendererId: 202,
    startBp: 1,
    endBp: 250_000_000,
    lane: 1,
    direction: 'reverse',
    displayName: 'LONG-TX',
    type: 'mRNA',
    transcriptId: 'NM_LONG.2',
    sourceId: 'rna-long',
    canonicalIdentity: 'mRNA|rna-long|NM_LONG.2|1|250000000|reverse',
  },
  {
    rendererId: 303,
    startBp: 100_000_050,
    endBp: 100_000_080,
    lane: 0,
    direction: 'none',
    displayName: 'OVERLAP-TX',
    type: 'ncRNA',
    transcriptId: null,
    sourceId: 'rna-overlap',
    canonicalIdentity: 'ncRNA|rna-overlap||100000050|100000080|none',
  },
];

const primitive = (
  featureIndex: number,
  startBp: number,
  endBp: number,
  offsetCenter: number
): AnnotationScenePrimitiveV1 => ({
  featureIndex,
  startBp,
  endBp,
  offsetCenter,
  halfH: 7,
  color: 0x3b82f6,
  alpha: 1,
  cdsFade: 0,
  dirSign: featureIndex === 1 ? -1 : featureIndex === 0 ? 1 : 0,
});

const primitives = [
  primitive(1, 1, 250_000_000, 32),
  primitive(0, 99_999_900, 100_000_000, 16),
  primitive(0, 100_000_100, 100_000_200, 16),
  primitive(2, 100_000_050, 100_000_080, 16),
];

describe('prepacked annotation interaction index v2', () => {
  it('finds prior-partition long intervals and seam-local overlaps without scanning every feature', () => {
    const index = buildPrepackedAnnotationInteractionIndexV2(features, primitives);
    const hits: number[] = [];
    const visited = queryPrepackedAnnotationInteractionIndexV2(
      index,
      100_000_060,
      100_000_061,
      (featureIndex) => {
        hits.push(featureIndex);
      }
    );

    expect(hits.sort((a, b) => a - b)).toEqual([0, 1, 2]);
    expect(visited).toBeLessThanOrEqual(features.length);
  });

  it('prunes a full-assembly sparse index sublinearly and preserves half-open seam ownership', () => {
    const sparseFeatures = Array.from({ length: 4_095 }, (_, featureIndex) => {
      const startBp = featureIndex * 700_000;
      return {
        rendererId: featureIndex + 1,
        startBp,
        endBp: startBp + 1_000,
        lane: featureIndex % 12,
        direction: 'none' as const,
        displayName: `SPARSE-${featureIndex}`,
        type: 'mRNA',
        transcriptId: null,
        sourceId: `sparse-${featureIndex}`,
        canonicalIdentity: `mRNA|sparse-${featureIndex}||${startBp}|${startBp + 1_000}|none`,
      };
    });
    const sparsePrimitives = sparseFeatures.map((feature, featureIndex) =>
      primitive(featureIndex, feature.startBp, feature.endBp, featureIndex % 12)
    );
    const sparseIndex = buildPrepackedAnnotationInteractionIndexV2(
      sparseFeatures,
      sparsePrimitives
    );
    const targetFeatureIndex = 2_047;
    const hits: number[] = [];
    const visited = queryPrepackedAnnotationInteractionIndexV2(
      sparseIndex,
      sparseFeatures[targetFeatureIndex].startBp + 500,
      sparseFeatures[targetFeatureIndex].startBp + 501,
      (featureIndex) => hits.push(featureIndex)
    );

    expect(hits).toEqual([targetFeatureIndex]);
    expect(visited).toBeLessThanOrEqual(64);

    const seamIndex = buildPrepackedAnnotationInteractionIndexV2(features, primitives);
    const beforeSeamStart: number[] = [];
    queryPrepackedAnnotationInteractionIndexV2(seamIndex, 99_999_899, 99_999_900, (featureIndex) =>
      beforeSeamStart.push(featureIndex)
    );
    expect(beforeSeamStart).toEqual([1]);
  });

  it('keeps deterministic rich identity records without a resident Feature object graph', () => {
    const index = buildPrepackedAnnotationInteractionIndexV2(features, primitives);

    expect(decodePrepackedAnnotationInteractionFeatureV2(index, 1)).toEqual({
      rendererId: 202,
      featureIndex: 1,
      startBp: 1,
      endBp: 250_000_000,
      lane: 1,
      direction: 'reverse',
      displayName: 'LONG-TX',
      type: 'mRNA',
      transcriptId: 'NM_LONG.2',
      sourceId: 'rna-long',
      canonicalIdentity: 'mRNA|rna-long|NM_LONG.2|1|250000000|reverse',
    });
  });

  it('projects a feature-only lookup authority without retaining primitive geometry', () => {
    const full = buildPrepackedAnnotationInteractionIndexV2(features, primitives);
    const lookup = projectPrepackedAnnotationFeatureLookupIndexV2(full);

    expect('featurePrimitiveIndices' in lookup).toBe(false);
    expect(lookup.featurePrimitiveOffsets).toBe(full.featurePrimitiveOffsets);
    expect(() => validatePrepackedAnnotationFeatureLookupIndexV2(lookup)).not.toThrow();

    const hits: string[] = [];
    queryPrepackedAnnotationInteractionIndexV2(lookup, 100_000_060, 100_000_061, (featureIndex) => {
      hits.push(decodePrepackedAnnotationInteractionFeatureV2(lookup, featureIndex).type);
    });
    expect(hits.sort()).toEqual(['mRNA', 'mRNA', 'ncRNA']);
    expect(
      findPrepackedAnnotationFeatureByCanonicalIdentityV2(lookup, features[2].canonicalIdentity)
    ).toBe(2);
  });

  it('finds exact canonical identity in logarithmic order independent of local renderer IDs', () => {
    const canonicalIdentity = annotationCanonicalIdentityV2({
      genomeIdentity: 'GRCh38-🧬',
      sourceId: 'rna-β',
      transcriptId: 'NM_β.1',
      trackId: 'mRNA',
      type: 'mRNA',
      startBp: 10,
      endBp: 20,
      direction: 'forward',
    });
    const build = (rendererId: number) =>
      buildPrepackedAnnotationInteractionIndexV2(
        [
          {
            rendererId,
            startBp: 10,
            endBp: 20,
            lane: 0,
            direction: 'forward',
            displayName: 'β transcript',
            type: 'mRNA',
            transcriptId: 'NM_β.1',
            sourceId: 'rna-β',
            canonicalIdentity,
          },
        ],
        [primitive(0, 10, 20, 0)]
      );

    const firstArtifact = build(7);
    const secondArtifact = build(4_000_000_000);
    expect(
      findPrepackedAnnotationFeatureByCanonicalIdentityV2(firstArtifact, canonicalIdentity)
    ).toBe(0);
    expect(
      findPrepackedAnnotationFeatureByCanonicalIdentityV2(secondArtifact, canonicalIdentity)
    ).toBe(0);
    expect(decodePrepackedAnnotationInteractionFeatureV2(firstArtifact, 0).rendererId).toBe(7);
    expect(decodePrepackedAnnotationInteractionFeatureV2(secondArtifact, 0).rendererId).toBe(
      4_000_000_000
    );
    expect(
      findPrepackedAnnotationFeatureByCanonicalIdentityV2(firstArtifact, `${canonicalIdentity}-x`)
    ).toBeNull();
    expect(
      findPrepackedAnnotationFeatureByCanonicalIdentityV2(firstArtifact, 'broken-\ud800')
    ).toBeNull();
  });

  it('persists an exact canonical-identity permutation and rejects missing or corrupt order', () => {
    const index = buildPrepackedAnnotationInteractionIndexV2(features, primitives);
    expect(index.canonicalIdentityFeatureIndices).toEqual(new Uint32Array([1, 0, 2]));

    const missing = {
      ...buildPrepackedAnnotationInteractionIndexV2(features, primitives),
      canonicalIdentityFeatureIndices: undefined,
    } as unknown as Parameters<typeof validatePrepackedAnnotationInteractionIndexV2>[0];
    expect(() => validatePrepackedAnnotationInteractionIndexV2(missing)).toThrow(/section lengths/);

    const duplicate = buildPrepackedAnnotationInteractionIndexV2(features, primitives);
    duplicate.canonicalIdentityFeatureIndices[1] = duplicate.canonicalIdentityFeatureIndices[0];
    expect(() => validatePrepackedAnnotationInteractionIndexV2(duplicate)).toThrow(
      /canonical identity index is not a permutation/
    );

    const reordered = buildPrepackedAnnotationInteractionIndexV2(features, primitives);
    reordered.canonicalIdentityFeatureIndices.reverse();
    expect(() => validatePrepackedAnnotationInteractionIndexV2(reordered)).toThrow(
      /canonical identity index ordering/
    );
  });

  it('stores a CSR feature-to-primitive reverse map for hover and selection outlines', () => {
    const index = buildPrepackedAnnotationInteractionIndexV2(features, primitives);
    const primitiveIndices: number[] = [];
    forEachPrepackedAnnotationFeaturePrimitiveV2(index, 0, (primitiveIndex) => {
      primitiveIndices.push(primitiveIndex);
    });

    expect(primitiveIndices).toEqual([1, 2]);
    expect(index.featurePrimitiveOffsets).toEqual(new Uint32Array([0, 2, 3, 4]));
    expect(index.featurePrimitiveIndices).toEqual(new Uint32Array([1, 2, 0, 3]));
  });

  it('sizes viewport primitive CSR storage by active features rather than parent feature count', () => {
    const csr = buildPrepackedAnnotationPrimitiveCsrV2(
      10_000_000,
      new Uint32Array([9_999_999, 42, 9_999_999])
    );

    expect(csr.activeFeatureIndices).toEqual(new Uint32Array([42, 9_999_999]));
    expect(csr.featurePrimitiveOffsets).toEqual(new Uint32Array([0, 1, 3]));
    expect(csr.featurePrimitiveIndices).toEqual(new Uint32Array([1, 0, 2]));
  });

  it('rejects primitive ordinals and malformed canonical identities outside the feature contract', () => {
    expect(() =>
      buildPrepackedAnnotationInteractionIndexV2(
        [{ ...features[0], canonicalIdentity: '' }],
        [primitive(1, 1, 2, 0)]
      )
    ).toThrow(/canonicalIdentity/);
    expect(() =>
      buildPrepackedAnnotationInteractionIndexV2([features[0]], [primitive(1, 1, 2, 0)])
    ).toThrow(/featureIndex/);
    expect(() =>
      buildPrepackedAnnotationInteractionIndexV2(
        [{ ...features[0], canonicalIdentity: 'broken-\ud800' }],
        [primitive(0, features[0].startBp, features[0].endBp, 0)]
      )
    ).toThrow(/UTF-16/);
    expect(() =>
      buildPrepackedAnnotationInteractionIndexV2(
        [{ ...features[0], transcriptId: '' }],
        [primitive(0, features[0].startBp, features[0].endBp, 0)]
      )
    ).toThrow(/optional identity/);
  });

  it('rejects a reordered interval tree and a non-permutation CSR even when all ordinals are in range', () => {
    const reordered = buildPrepackedAnnotationInteractionIndexV2(features, primitives);
    [reordered.intervalFeatureIndices[0], reordered.intervalFeatureIndices[1]] = [
      reordered.intervalFeatureIndices[1],
      reordered.intervalFeatureIndices[0],
    ];
    const maxEndView = new DataView(
      reordered.intervalSubtreeMaxEndBytes.buffer,
      reordered.intervalSubtreeMaxEndBytes.byteOffset,
      reordered.intervalSubtreeMaxEndBytes.byteLength
    );
    for (let node = reordered.intervalFeatureIndices.length - 1; node >= 0; node -= 1) {
      const featureIndex = reordered.intervalFeatureIndices[node];
      const left = node * 2 + 1;
      const right = left + 1;
      let maxEnd = features[featureIndex].endBp;
      if (left < reordered.intervalFeatureIndices.length) {
        maxEnd = Math.max(maxEnd, Number(maxEndView.getBigUint64(left * 8, true)));
      }
      if (right < reordered.intervalFeatureIndices.length) {
        maxEnd = Math.max(maxEnd, Number(maxEndView.getBigUint64(right * 8, true)));
      }
      maxEndView.setBigUint64(node * 8, BigInt(maxEnd), true);
    }
    expect(() => validatePrepackedAnnotationInteractionIndexV2(reordered)).toThrow(/ordering/);

    const duplicatePrimitive = buildPrepackedAnnotationInteractionIndexV2(features, primitives);
    duplicatePrimitive.featurePrimitiveIndices[0] = duplicatePrimitive.featurePrimitiveIndices[1];
    expect(() => validatePrepackedAnnotationInteractionIndexV2(duplicatePrimitive)).toThrow(
      /primitive permutation/
    );
  });
});
