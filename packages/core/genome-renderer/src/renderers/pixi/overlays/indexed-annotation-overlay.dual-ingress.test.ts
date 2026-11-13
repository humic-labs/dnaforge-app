import { describe, expect, it } from 'vitest';
import type { Feature, Genome } from '../../../types';
import { IndexedAnnotationOverlay } from './annotation-overlay';

function decoyFeature(): Feature {
  return {
    id: 7,
    type: 'CDS',
    start: 10,
    end: 40,
    direction: 'forward',
    color: 0x3366ff,
    lane: 0,
    displayName: 'decoy',
  };
}

function genomeWithFeatures(features: Feature[]): Genome {
  return {
    name: 'chr1',
    sourceIdentity: 'chr1',
    length: 1_000,
    circular: false,
    features,
    sequenceAvailable: true,
  };
}

describe('IndexedAnnotationOverlay dual-ingress loadGenome', () => {
  it('unarmed overlay keeps genome.features as the retained-immediate draw set', () => {
    const overlay = new IndexedAnnotationOverlay();
    const feature = decoyFeature();
    overlay.loadGenome(genomeWithFeatures([feature]));
    expect(overlay.getAnnotationPresentationFeatures()).toEqual([feature]);
    expect(overlay.getAnnotationBodyPresentationAuthoritySnapshot().frameOwner).not.toBe(
      'compiled-broad'
    );
  });

  it('armed overlay does not make a non-empty features[] the exclusive body owner', () => {
    const overlay = new IndexedAnnotationOverlay();
    expect(
      overlay.requireCompiledBroadSurface({
        genomeLengthBp: 1_000,
        broadCorridorFinestSpanBp: 200,
      })
    ).toBe(true);
    overlay.loadGenome(genomeWithFeatures([decoyFeature()]));
    const authority = overlay.getAnnotationBodyPresentationAuthoritySnapshot();
    expect(overlay.getAnnotationPresentationFeatures()).toHaveLength(1);
    expect(authority.frameOwner).not.toBe('retained-immediate');
    expect(authority.eligibility['retained-immediate']).toBe(false);
  });
});
