import { describe, it, expect } from 'vitest';
import { resolveAnnotationTarget } from '../resolve-annotation-target';

const showFlags = { showAnnotations: true, showTranslation: true };

describe('resolveAnnotationTarget', () => {
  it('returns null when nothing was hit', () => {
    const result = resolveAnnotationTarget({
      annotationHit: null,
      parentCdsForCodon: null,
      classifiedCDSs: [],
      position: 100,
      ...showFlags,
    });
    expect(result).toBeNull();
  });

  it('returns the annotation pill identity when one is hit', () => {
    const result = resolveAnnotationTarget({
      annotationHit: {
        type: 'gene',
        name: 'rbcL',
        start: 1,
        end: 100,
        direction: 1,
      },
      parentCdsForCodon: null,
      classifiedCDSs: [],
      position: 50,
      ...showFlags,
    });
    expect(result).toEqual({ type: 'gene', name: 'rbcL', start: 1, end: 100, direction: 1 });
  });

  it('annotation pill takes priority over codon hit', () => {
    const annotationHit = {
      type: 'gene',
      name: 'rbcL',
      start: 1,
      end: 100,
      direction: 1,
    };
    const parentCds = {
      type: 'CDS',
      name: 'rbcL',
      start: 1,
      end: 100,
      direction: 1,
    };
    const result = resolveAnnotationTarget({
      annotationHit,
      parentCdsForCodon: parentCds,
      classifiedCDSs: [parentCds],
      position: 50,
      ...showFlags,
    });
    expect(result?.type).toBe('gene');
  });

  it('falls back to the parent CDS when only a codon was hit', () => {
    const parentCds = {
      type: 'CDS',
      name: 'rbcL',
      start: 1,
      end: 120,
      direction: 1,
    };
    const result = resolveAnnotationTarget({
      annotationHit: null,
      parentCdsForCodon: parentCds,
      classifiedCDSs: [parentCds],
      position: 50,
      ...showFlags,
    });
    expect(result).toEqual({ type: 'CDS', name: 'rbcL', start: 1, end: 120, direction: 1 });
  });

  it('falls back to the parent CDS for an intron-gap hit on a spliced CDS', () => {
    const splicedCds = {
      type: 'CDS',
      name: 'rbcL',
      start: 1,
      end: 200,
      direction: 1,
      segments: [
        { start: 1, end: 50 },
        { start: 100, end: 200 },
      ],
      qualifiers: { _locationString: ['join(1..50,100..200)'] },
    };
    const result = resolveAnnotationTarget({
      annotationHit: null,
      parentCdsForCodon: null,
      classifiedCDSs: [splicedCds],
      position: 75,
      ...showFlags,
    });
    expect(result?.name).toBe('rbcL');
    expect(result?.type).toBe('CDS');
  });

  it('does not select an adjacent-segment CDS from a bare position elsewhere on the molecule', () => {
    const adjacentSegmentCds = {
      type: 'CDS',
      name: 'AmpR',
      start: 1284,
      end: 2144,
      direction: 1,
      segments: [
        { start: 1284, end: 1352 },
        { start: 1353, end: 2144 },
      ],
      qualifiers: { _locationString: ['join(1284..1352,1353..2144)'] },
    };
    const result = resolveAnnotationTarget({
      annotationHit: null,
      parentCdsForCodon: null,
      classifiedCDSs: [adjacentSegmentCds],
      position: 299,
      ...showFlags,
    });

    expect(result).toBeNull();
  });

  it('intron-gap fallback is skipped when a codon was already hit', () => {
    const splicedCds = {
      type: 'CDS',
      name: 'rbcL',
      start: 1,
      end: 200,
      direction: 1,
      segments: [
        { start: 1, end: 50 },
        { start: 100, end: 200 },
      ],
      qualifiers: { _locationString: ['join(1..50,100..200)'] },
    };
    const otherCds = {
      type: 'CDS',
      name: 'other',
      start: 300,
      end: 400,
      direction: 1,
    };
    const result = resolveAnnotationTarget({
      annotationHit: null,
      parentCdsForCodon: otherCds,
      classifiedCDSs: [splicedCds, otherCds],
      position: 75,
      ...showFlags,
    });
    expect(result?.name).toBe('other');
  });

  it('non-spliced CDS does NOT match the intron-gap branch', () => {
    const fakeSplicedCds = {
      type: 'CDS',
      name: 'rbcL',
      start: 1,
      end: 200,
      direction: 1,
      segments: [
        { start: 1, end: 50 },
        { start: 100, end: 200 },
      ],
      qualifiers: { _locationString: ['order(1..50,100..200)'] },
    };
    const result = resolveAnnotationTarget({
      annotationHit: null,
      parentCdsForCodon: null,
      classifiedCDSs: [fakeSplicedCds],
      position: 75,
      ...showFlags,
    });
    expect(result).toBeNull();
  });

  it('respects showAnnotations=false (skip pill branch)', () => {
    const result = resolveAnnotationTarget({
      annotationHit: {
        type: 'gene',
        name: 'rbcL',
        start: 1,
        end: 100,
        direction: 1,
      },
      parentCdsForCodon: null,
      classifiedCDSs: [],
      position: 50,
      showAnnotations: false,
      showTranslation: true,
    });
    expect(result).toBeNull();
  });

  it('respects showTranslation=false (skip intron branch)', () => {
    const splicedCds = {
      type: 'CDS',
      name: 'rbcL',
      start: 1,
      end: 200,
      direction: 1,
      segments: [
        { start: 1, end: 50 },
        { start: 100, end: 200 },
      ],
      qualifiers: { _locationString: ['join(1..50,100..200)'] },
    };
    const result = resolveAnnotationTarget({
      annotationHit: null,
      parentCdsForCodon: null,
      classifiedCDSs: [splicedCds],
      position: 75,
      showAnnotations: true,
      showTranslation: false,
    });
    expect(result).toBeNull();
  });

  it('null position skips the intron branch (e.g., off-canvas hover)', () => {
    const splicedCds = {
      type: 'CDS',
      name: 'rbcL',
      start: 1,
      end: 200,
      direction: 1,
      segments: [
        { start: 1, end: 50 },
        { start: 100, end: 200 },
      ],
      qualifiers: { _locationString: ['join(1..50,100..200)'] },
    };
    const result = resolveAnnotationTarget({
      annotationHit: null,
      parentCdsForCodon: null,
      classifiedCDSs: [splicedCds],
      position: null,
      ...showFlags,
    });
    expect(result).toBeNull();
  });

  it('handles reverse-strand annotations (direction = -1)', () => {
    const result = resolveAnnotationTarget({
      annotationHit: {
        type: 'CDS',
        name: 'reverseGene',
        start: 100,
        end: 1,
        direction: -1,
      },
      parentCdsForCodon: null,
      classifiedCDSs: [],
      position: 50,
      ...showFlags,
    });
    expect(result?.direction).toBe(-1);
    expect(result?.start).toBe(100);
    expect(result?.end).toBe(1);
  });
});

describe('the exons the hover tooltip needs', () => {
  it("carries a spliced feature's exons through to the hover identity", () => {
    const result = resolveAnnotationTarget({
      annotationHit: {
        type: 'CDS',
        name: 'spliced',
        start: 1,
        end: 15,
        direction: 1,
        segments: [
          { start: 1, end: 6 },
          { start: 10, end: 15 },
        ],
      },
      parentCdsForCodon: null,
      classifiedCDSs: [],
      position: 3,
      ...showFlags,
    });
    expect(result?.segments).toEqual([
      { start: 1, end: 6 },
      { start: 10, end: 15 },
    ]);
  });

  it('leaves the field off a feature that has no exons', () => {
    const result = resolveAnnotationTarget({
      annotationHit: { type: 'gene', name: 'rbcL', start: 1, end: 100, direction: 1 },
      parentCdsForCodon: null,
      classifiedCDSs: [],
      position: 50,
      ...showFlags,
    });
    expect(result).not.toHaveProperty('segments');
  });
});
