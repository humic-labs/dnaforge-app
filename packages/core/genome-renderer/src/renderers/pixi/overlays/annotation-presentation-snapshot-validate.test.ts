import { describe, expect, it } from 'vitest';

import {
  validAnnotationPresentationSnapshot,
  validAnnotationResidentPagePublication,
} from './annotation-presentation-snapshot-validate';

describe('annotation-presentation-snapshot-validate', () => {
  it('accepts a minimal valid presentation snapshot', () => {
    expect(
      validAnnotationPresentationSnapshot({
        contract: 'annotation-presentation-snapshot.v1',
        sourceIdentity: 'src',
        policyKey: 'pol',
        genomeLengthBp: 100,
        generation: 1,
        layout: { maxAnnotationLane: 0, maxCdsLane: -1 },
        features: [{ id: 1, start: 0, end: 10, lane: 0 }],
        requestedLayerTypes: ['mRNA'],
        exactCoverage: [{ startBp: 0, endBp: 100 }],
      })
    ).toBe(true);
  });

  it('rejects bad contracts and out-of-range features', () => {
    expect(validAnnotationPresentationSnapshot(null)).toBe(false);
    expect(
      validAnnotationPresentationSnapshot({
        contract: 'wrong',
        sourceIdentity: 'src',
        policyKey: 'pol',
        genomeLengthBp: 100,
        generation: 1,
        layout: { maxAnnotationLane: 0, maxCdsLane: -1 },
        features: [],
        requestedLayerTypes: ['mRNA'],
        exactCoverage: [],
      })
    ).toBe(false);
    expect(
      validAnnotationPresentationSnapshot({
        contract: 'annotation-presentation-snapshot.v1',
        sourceIdentity: 'src',
        policyKey: 'pol',
        genomeLengthBp: 100,
        generation: 1,
        layout: { maxAnnotationLane: 0, maxCdsLane: -1 },
        features: [{ id: 1, start: 0, end: 200, lane: 0 }],
        requestedLayerTypes: ['mRNA'],
        exactCoverage: [{ startBp: 0, endBp: 100 }],
      })
    ).toBe(false);
  });

  it('accepts resident page publications and codon carriers', () => {
    const base = {
      sourceIdentity: 'src',
      policyKey: 'pol',
      genomeLengthBp: 100,
      generation: 2,
      requestedLayerTypes: ['mRNA'],
      exactCoverage: [{ startBp: 0, endBp: 50 }],
      pages: [],
    };
    expect(
      validAnnotationResidentPagePublication({
        ...base,
        contract: 'annotation-resident-page-publication.v1',
      })
    ).toBe(true);
    expect(
      validAnnotationResidentPagePublication({
        ...base,
        contract: 'annotation-codon-carrier-page-publication.v1',
      })
    ).toBe(true);
    expect(validAnnotationResidentPagePublication({ ...base, contract: 'nope' })).toBe(false);
  });
});
