// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  defaultVisibleAnnotationTypes,
  reconcileVisibleAnnotationTypes,
} from './indexed-genome-viewer-controls';

describe('defaultVisibleAnnotationTypes', () => {
  it('selects the transcript glyph when the published roster contains it', () => {
    expect([...defaultVisibleAnnotationTypes(['ncRNA', 'mRNA', 'tRNA'])]).toEqual(['mRNA']);
  });

  it('never selects an absent hard-coded transcript track', () => {
    expect([...defaultVisibleAnnotationTypes(['ncRNA', 'rRNA', 'tRNA'])]).toEqual(['ncRNA']);
  });

  it('falls back to the first published track when no preferred biological class exists', () => {
    expect([...defaultVisibleAnnotationTypes(['enhancer', 'promoter'])]).toEqual(['enhancer']);
  });
});

describe('reconcileVisibleAnnotationTypes', () => {
  it('replaces a loading-time assumption with the first published default', () => {
    expect([
      ...reconcileVisibleAnnotationTypes(new Set(['mRNA']), ['ncRNA', 'rRNA'], new Set(['ncRNA'])),
    ]).toEqual(['ncRNA']);
  });

  it('preserves admitted selections and removes only unpublished tracks', () => {
    expect([
      ...reconcileVisibleAnnotationTypes(
        new Set(['mRNA', 'gene', 'tRNA']),
        ['mRNA', 'tRNA'],
        new Set(['mRNA'])
      ),
    ]).toEqual(['mRNA', 'tRNA']);
  });

  it('preserves an explicit annotations-off selection', () => {
    const hidden = new Set<string>();
    expect(reconcileVisibleAnnotationTypes(hidden, ['mRNA'], new Set(['mRNA']))).toBe(hidden);
  });

  it('does not reconcile while the published roster is still loading', () => {
    const assumed = new Set(['mRNA']);
    expect(reconcileVisibleAnnotationTypes(assumed, undefined, new Set(['ncRNA']))).toBe(assumed);
  });
});
