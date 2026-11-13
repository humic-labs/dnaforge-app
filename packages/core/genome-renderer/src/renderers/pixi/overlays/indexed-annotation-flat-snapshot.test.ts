import { describe, expect, it } from 'vitest';
import type { AnnotationFlatPresentationSnapshot, Feature, Genome } from '../../../types';
import {
  setAnnotationFlatPresentationSnapshot,
  type FlatPresentationSnapshotHost,
} from './indexed-annotation-flat-snapshot';

function snapshot(
  overrides: Partial<AnnotationFlatPresentationSnapshot> = {}
): AnnotationFlatPresentationSnapshot {
  return {
    contract: 'annotation-presentation-snapshot.v1',
    sourceIdentity: 'src',
    genomeLengthBp: 100,
    policyKey: 'pol',
    generation: 1,
    features: [
      {
        id: 1,
        type: 'gene',
        start: 0,
        end: 10,
        direction: 'forward',
        color: 0x3366ff,
        lane: 0,
        displayName: 'gene',
      } satisfies Feature,
    ],
    requestedLayerTypes: ['mRNA'],
    layout: { maxAnnotationLane: 0, maxCdsLane: -1 },
    exactCoverage: [{ startBp: 0, endBp: 100 }],
    ...overrides,
  };
}

function snapshotHost(
  overrides: Partial<FlatPresentationSnapshotHost> = {}
): FlatPresentationSnapshotHost {
  return {
    currentGenomeIdentity: 'src',
    genomeLength: 100,
    genomeCircular: false,
    currentAnnotationSourceFingerprint: null,
    currentAnnotationPlacementFingerprint: null,
    annotationPresentationStreams: new Map(),
    activeAnnotationPresentationStreamKey: null,
    applyAnnotationGenome() {},
    ...overrides,
  };
}

describe('indexed annotation flat snapshot', () => {
  it('rejects a snapshot when no genome is loaded', () => {
    expect(
      setAnnotationFlatPresentationSnapshot(
        snapshotHost({ currentGenomeIdentity: null }),
        snapshot()
      )
    ).toEqual({ status: 'rejected', reason: 'no-genome' });
    expect(
      setAnnotationFlatPresentationSnapshot(snapshotHost({ genomeLength: 0 }), snapshot())
    ).toEqual({ status: 'rejected', reason: 'no-genome' });
    expect(
      setAnnotationFlatPresentationSnapshot(snapshotHost(), snapshot({ sourceIdentity: 'other' }))
    ).toEqual({ status: 'rejected', reason: 'source-mismatch' });
  });

  it('applies a valid snapshot and no-ops the same generation', () => {
    const genomes: Genome[] = [];
    const host = snapshotHost({
      applyAnnotationGenome(genome) {
        genomes.push(genome);
      },
    });
    const applied = snapshot();
    expect(setAnnotationFlatPresentationSnapshot(host, applied)).toEqual({
      status: 'applied',
      generation: 1,
      invalidatedHover: true,
    });
    expect(genomes).toHaveLength(1);
    expect(genomes[0]).toMatchObject({
      name: 'src',
      sourceIdentity: 'src',
      length: 100,
      circular: false,
      annotationLayerTypes: ['mRNA'],
      annotationLayout: { maxAnnotationLane: 0, maxCdsLane: -1 },
    });
    expect(host.activeAnnotationPresentationStreamKey).toBe('src\u0000pol');
    expect(host.annotationPresentationStreams.get('src\u0000pol')?.generation).toBe(1);

    expect(setAnnotationFlatPresentationSnapshot(host, applied)).toEqual({
      status: 'noop',
      generation: 1,
    });
    expect(genomes).toHaveLength(1);

    expect(setAnnotationFlatPresentationSnapshot(host, snapshot({ generation: 0 }))).toEqual({
      status: 'rejected',
      reason: 'stale-generation',
    });
  });
});
