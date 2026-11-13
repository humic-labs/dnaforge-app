// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TRACK_ORDER,
  EMPTY_ANNOTATION_TRACK_PREFERENCES,
  deriveAnnotationTrackRegistry,
  visibleTracks,
  type AnnotationTrackPreferences,
} from './annotation-track-registry';

describe('deriveAnnotationTrackRegistry', () => {
  it('returns empty registry when no annotation types are present', () => {
    expect(deriveAnnotationTrackRegistry([])).toEqual([]);
    expect(deriveAnnotationTrackRegistry(new Set())).toEqual([]);
  });

  it('orders canonical kinds by DEFAULT_TRACK_ORDER, unknowns alphabetically after', () => {
    const result = deriveAnnotationTrackRegistry([
      'rRNA',
      'something-novel',
      'gene',
      'mRNA',
      'another-thing',
    ]);
    expect(result.map((t) => t.trackId)).toEqual([
      'gene',
      'mRNA',
      'rRNA',
      'another-thing',
      'something-novel',
    ]);
    result.forEach((track, idx) => expect(track.order).toBe(idx));
  });

  it('marks every track visible by default', () => {
    const result = deriveAnnotationTrackRegistry(['gene', 'mRNA']);
    expect(result.every((t) => t.visible)).toBe(true);
  });

  it("user 'orderedTrackIds' override beats default order; unspecified types fall to defaults", () => {
    const prefs: AnnotationTrackPreferences = {
      visibilityByTrackId: new Map(),
      orderedTrackIds: ['mRNA', 'lncRNA'],
    };
    const result = deriveAnnotationTrackRegistry(['gene', 'mRNA', 'lncRNA', 'regulatory'], prefs);
    expect(result.map((t) => t.trackId)).toEqual(['mRNA', 'lncRNA', 'gene', 'regulatory']);
  });

  it('visibility map can force-hide tracks', () => {
    const prefs: AnnotationTrackPreferences = {
      visibilityByTrackId: new Map([['mRNA', false]]),
      orderedTrackIds: [],
    };
    const result = deriveAnnotationTrackRegistry(['gene', 'mRNA'], prefs);
    const mrna = result.find((t) => t.trackId === 'mRNA');
    const gene = result.find((t) => t.trackId === 'gene');
    expect(mrna?.visible).toBe(false);
    expect(gene?.visible).toBe(true);
  });

  it('visibility map can force-show otherwise default tracks (cooperates with future default-hide)', () => {
    const prefs: AnnotationTrackPreferences = {
      visibilityByTrackId: new Map([['mRNA', true]]),
      orderedTrackIds: [],
    };
    const result = deriveAnnotationTrackRegistry(['mRNA'], prefs);
    expect(result[0].visible).toBe(true);
  });

  it('label aliases map known multi-word kinds to readable labels', () => {
    const result = deriveAnnotationTrackRegistry([
      'gene',
      'mRNA',
      'misc_feature',
      'protein_bind',
      'rep_origin',
    ]);
    const labelById = new Map(result.map((t) => [t.trackId, t.label]));
    expect(labelById.get('gene')).toBe('gene');
    expect(labelById.get('mRNA')).toBe('mRNA');
    expect(labelById.get('misc_feature')).toBe('Misc. feature');
    expect(labelById.get('protein_bind')).toBe('Protein-binding site');
    expect(labelById.get('rep_origin')).toBe('Replication origin');
  });

  it('pure: same inputs → same outputs across calls', () => {
    const types = ['mRNA', 'gene', 'enhancer'];
    const a = deriveAnnotationTrackRegistry(types);
    const b = deriveAnnotationTrackRegistry(types);
    expect(a.map((t) => t.trackId)).toEqual(['gene', 'mRNA', 'enhancer']);
    expect(a).toEqual(b);
  });

  it('EMPTY preferences object is a valid input that yields default ordering', () => {
    const a = deriveAnnotationTrackRegistry(['mRNA', 'gene']);
    const b = deriveAnnotationTrackRegistry(['mRNA', 'gene'], EMPTY_ANNOTATION_TRACK_PREFERENCES);
    expect(a.map((t) => t.trackId)).toEqual(['gene', 'mRNA']);
    expect(a).toEqual(b);
  });

  it('handles duplicate / empty / non-string inputs defensively', () => {
    const result = deriveAnnotationTrackRegistry(['mRNA', 'mRNA', '', 'gene'] as Iterable<string>);
    expect(result.map((t) => t.trackId)).toEqual(['gene', 'mRNA']);
  });
});

describe('visibleTracks', () => {
  it('returns only the visible tracks, preserving order', () => {
    const registry = deriveAnnotationTrackRegistry(['gene', 'mRNA', 'lncRNA'], {
      visibilityByTrackId: new Map([['mRNA', false]]),
      orderedTrackIds: [],
    });
    const visible = visibleTracks(registry);
    expect(visible.map((t) => t.trackId)).toEqual(['gene', 'lncRNA']);
  });
});

describe('DEFAULT_TRACK_ORDER spec', () => {
  it('includes the canonical gene-centric kinds first', () => {
    expect(DEFAULT_TRACK_ORDER[0]).toBe('gene');
    expect(DEFAULT_TRACK_ORDER[1]).toBe('mRNA');
    expect(DEFAULT_TRACK_ORDER.indexOf('lncRNA')).toBeLessThan(
      DEFAULT_TRACK_ORDER.indexOf('regulatory')
    );
  });

  it('contains no duplicates', () => {
    expect(new Set(DEFAULT_TRACK_ORDER).size).toBe(DEFAULT_TRACK_ORDER.length);
  });
});
