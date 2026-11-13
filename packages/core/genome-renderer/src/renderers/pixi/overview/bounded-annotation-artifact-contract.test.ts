import { describe, expect, it } from 'vitest';

import {
  annotationTrackArtifactKeyV1,
  createAnnotationTrackArtifactIdentityV1,
} from './bounded-annotation-artifact-contract';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const SHA_D = 'd'.repeat(64);
const SHA_E = 'e'.repeat(64);

const BASE = {
  assemblyIdentity: 'grch38',
  genomeIdentity: 'GRCh38 human',
  genomeLengthBp: 3_088_269_832,
  sourceFingerprint: SHA_A,
  placementFingerprint: SHA_B,
  trackId: 'mrna',
  trackType: 'mRNA',
  sourceShardManifestFingerprint: SHA_C,
  themeFingerprint: SHA_D,
  glyphGeometryFingerprint: SHA_E,
  lanePlacementContract: 'source-lanes.v1',
  broadSurfaceContract: 'compiled-broad-surface.v1',
  interactionIndexContract: 'annotation-feature-hit-index.v3',
} as const;

describe('bounded annotation artifact identity', () => {
  it('is deeply immutable and changes for every immutable source identity field', () => {
    const artifact = createAnnotationTrackArtifactIdentityV1(BASE);
    expect(Object.isFrozen(artifact)).toBe(true);
    expect(artifact.artifactKey).toBe(annotationTrackArtifactKeyV1(artifact));

    for (const [field, replacement] of [
      ['assemblyIdentity', 't2t-chm13'],
      ['genomeIdentity', 'GRCh38 alternate'],
      ['genomeLengthBp', 3_088_269_831],
      ['sourceFingerprint', '1'.repeat(64)],
      ['placementFingerprint', '2'.repeat(64)],
      ['trackId', 'lncrna'],
      ['trackType', 'lncRNA'],
      ['sourceShardManifestFingerprint', '3'.repeat(64)],
      ['themeFingerprint', '4'.repeat(64)],
      ['glyphGeometryFingerprint', '5'.repeat(64)],
      ['lanePlacementContract', 'source-lanes.v2'],
      ['broadSurfaceContract', 'compiled-broad-surface.v2'],
      ['interactionIndexContract', 'annotation-feature-hit-index.v4'],
    ] as const) {
      const changed = createAnnotationTrackArtifactIdentityV1({
        ...BASE,
        [field]: replacement,
      });
      expect(changed.artifactKey, field).not.toBe(artifact.artifactKey);
    }
  });

  it('cannot put runtime policy into the artifact key', () => {
    const expected = createAnnotationTrackArtifactIdentityV1(BASE);
    for (const isoformMode of ['canonical', 'expanded'] as const) {
      for (const laneLimit of [8, 12, 24, null] as const) {
        const withRuntimePolicy = createAnnotationTrackArtifactIdentityV1({
          ...BASE,
          isoformMode,
          laneLimit,
          visible: isoformMode === 'expanded',
        } as typeof BASE);
        expect(withRuntimePolicy.artifactKey).toBe(expected.artifactKey);
        expect(withRuntimePolicy).not.toHaveProperty('isoformMode');
        expect(withRuntimePolicy).not.toHaveProperty('laneLimit');
        expect(withRuntimePolicy).not.toHaveProperty('visible');
      }
    }
  });

  it('cannot put camera range, LOD, or transaction generation into the artifact key', () => {
    const expected = createAnnotationTrackArtifactIdentityV1(BASE);
    for (let generation = 1; generation <= 64; generation += 1) {
      const withCamera = createAnnotationTrackArtifactIdentityV1({
        ...BASE,
        viewportStartBp: generation * 1_000_000,
        viewportEndBp: generation * 1_000_000 + 200_000_000,
        lod: generation % 12,
        generation,
      } as typeof BASE);
      expect(withCamera.artifactKey).toBe(expected.artifactKey);
      expect(withCamera).not.toHaveProperty('viewportStartBp');
      expect(withCamera).not.toHaveProperty('viewportEndBp');
      expect(withCamera).not.toHaveProperty('lod');
      expect(withCamera).not.toHaveProperty('generation');
    }
  });
});
