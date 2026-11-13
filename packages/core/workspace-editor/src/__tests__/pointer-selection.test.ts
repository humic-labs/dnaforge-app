import { describe, it, expect } from 'vitest';
import {
  resolvePointerSelection,
  annotationIdentityEqual,
  orfIdentityEqual,
} from '../pointer-selection';

const showFlags = { showAnnotations: true, showTranslation: true };

describe('resolvePointerSelection', () => {
  it('returns both null when nothing was hit', () => {
    const result = resolvePointerSelection({
      annotationHit: null,
      parentCdsForCodon: null,
      classifiedCDSs: [],
      position: 100,
      orfHit: null,
      ...showFlags,
    });
    expect(result.annotation).toBeNull();
    expect(result.orf).toBeNull();
  });

  it('returns ORF identity when ORF was hit; annotation slot is null', () => {
    const result = resolvePointerSelection({
      annotationHit: null,
      parentCdsForCodon: null,
      classifiedCDSs: [],
      position: 100,
      orfHit: { start: 50, end: 200, strand: '+' },
      ...showFlags,
    });
    expect(result.orf).toEqual({ start: 50, end: 200, strand: '+' });
    expect(result.annotation).toBeNull();
  });

  it('ORF wins over annotation hit (mutex)', () => {
    const annotationHit = {
      type: 'gene',
      name: 'rbcL',
      start: 1,
      end: 100,
      direction: 1,
    };
    const result = resolvePointerSelection({
      annotationHit,
      parentCdsForCodon: null,
      classifiedCDSs: [],
      position: 50,
      orfHit: { start: 50, end: 200, strand: '+' },
      ...showFlags,
    });
    expect(result.orf).not.toBeNull();
    expect(result.annotation).toBeNull();
  });

  it('returns annotation identity when annotation is hit (no ORF)', () => {
    const result = resolvePointerSelection({
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
      orfHit: null,
      ...showFlags,
    });
    expect(result.annotation?.name).toBe('rbcL');
    expect(result.orf).toBeNull();
  });

  it('falls back to parent CDS for codon hit', () => {
    const parentCds = {
      type: 'CDS',
      name: 'rbcL',
      start: 1,
      end: 120,
      direction: 1,
    };
    const result = resolvePointerSelection({
      annotationHit: null,
      parentCdsForCodon: parentCds,
      classifiedCDSs: [parentCds],
      position: 50,
      orfHit: null,
      ...showFlags,
    });
    expect(result.annotation).toEqual({
      type: 'CDS',
      name: 'rbcL',
      start: 1,
      end: 120,
      direction: 1,
    });
  });

  it('respects showAnnotations=false (skips pill branch but ORF still works)', () => {
    const result = resolvePointerSelection({
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
      orfHit: { start: 50, end: 200, strand: '+' },
      showAnnotations: false,
      showTranslation: true,
    });
    expect(result.orf).not.toBeNull();
    expect(result.annotation).toBeNull();
  });
});

describe('annotationIdentityEqual', () => {
  it('treats identical tuples as equal', () => {
    const a = { type: 'gene', name: 'X', start: 1, end: 10, direction: 1 };
    const b = { type: 'gene', name: 'X', start: 1, end: 10, direction: 1 };
    expect(annotationIdentityEqual(a, b)).toBe(true);
  });

  it('discriminates by type (gene vs CDS at same range)', () => {
    const gene = { type: 'gene', name: 'X', start: 1, end: 10, direction: 1 };
    const cds = { type: 'CDS', name: 'X', start: 1, end: 10, direction: 1 };
    expect(annotationIdentityEqual(gene, cds)).toBe(false);
  });

  it('discriminates by direction', () => {
    const fwd = { type: 'gene', name: 'X', start: 1, end: 10, direction: 1 };
    const rev = { type: 'gene', name: 'X', start: 1, end: 10, direction: -1 };
    expect(annotationIdentityEqual(fwd, rev)).toBe(false);
  });

  it('treats null direction as 0 (default)', () => {
    const noDir = { type: 'misc_feature', name: 'X', start: 1, end: 10 };
    const zeroDir = { type: 'misc_feature', name: 'X', start: 1, end: 10, direction: 0 };
    expect(annotationIdentityEqual(noDir, zeroDir)).toBe(true);
  });

  it('null vs non-null are not equal', () => {
    const a = { type: 'gene', name: 'X', start: 1, end: 10, direction: 1 };
    expect(annotationIdentityEqual(a, null)).toBe(false);
    expect(annotationIdentityEqual(null, a)).toBe(false);
  });

  it('null vs null is equal', () => {
    expect(annotationIdentityEqual(null, null)).toBe(true);
  });
});

describe('orfIdentityEqual', () => {
  it('treats identical tuples as equal', () => {
    const a = { start: 1, end: 100, strand: '+' as const };
    const b = { start: 1, end: 100, strand: '+' as const };
    expect(orfIdentityEqual(a, b)).toBe(true);
  });

  it('discriminates by strand', () => {
    const fwd = { start: 1, end: 100, strand: '+' as const };
    const rev = { start: 1, end: 100, strand: '-' as const };
    expect(orfIdentityEqual(fwd, rev)).toBe(false);
  });
});
