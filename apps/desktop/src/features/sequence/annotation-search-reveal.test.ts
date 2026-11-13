// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  deriveAnnotationSearchReveal,
  persistTemporarilyRevealedTrack,
} from './annotation-search-reveal';

describe('annotation search reveal', () => {
  const hiddenHit = {
    start: 369_302_556,
    end: 369_308_225,
    featureType: 'ncRNA',
    annotationTrackId: 'lncRNA',
    canonicalIdentity: 'annotation.v2:H19-transcript',
  } as const;

  it('returns only an exact temporary overlay target without deriving another visibility set', () => {
    const persisted = new Set(['gene', 'mRNA']);
    const reveal = deriveAnnotationSearchReveal(persisted, hiddenHit);

    expect(reveal).toMatchObject({
      kind: 'temporary',
      trackId: 'lncRNA',
      featureType: 'ncRNA',
      canonicalIdentity: hiddenHit.canonicalIdentity,
      focusRange: [hiddenHit.start, hiddenHit.end],
    });
    expect('effectiveVisibleTypes' in reveal).toBe(false);
    expect([...persisted].sort()).toEqual(['gene', 'mRNA']);
  });

  it('retains exact focus for an already-visible track without creating promotion state', () => {
    const persisted = new Set(['gene', 'lncRNA', 'mRNA']);
    const reveal = deriveAnnotationSearchReveal(persisted, hiddenHit);

    expect(reveal.kind).toBe('visible');
    expect(reveal.focusRange).toEqual([hiddenHit.start, hiddenHit.end]);
    expect('effectiveVisibleTypes' in reveal).toBe(false);
  });

  it('matches track identity case-insensitively without changing canonical spelling', () => {
    const reveal = deriveAnnotationSearchReveal(new Set(['gene', 'LNCRNA']), hiddenHit);

    expect(reveal.kind).toBe('visible');
    expect('effectiveVisibleTypes' in reveal).toBe(false);
  });

  it('keeps exact case-only scientific identities independently visible', () => {
    const visibleTracks = new Set(['transposon:DM88', 'transposon:Dm88']);
    const reveal = deriveAnnotationSearchReveal(visibleTracks, {
      ...hiddenHit,
      annotationTrackId: 'transposon:DM88',
    });

    expect(reveal.kind).toBe('visible');
    expect(reveal.trackId).toBe('transposon:DM88');
  });

  it('fails closed for an ambiguous case-insensitive track alias', () => {
    const visibleTracks = new Set(['transposon:DM88', 'transposon:Dm88']);
    const reveal = deriveAnnotationSearchReveal(visibleTracks, {
      ...hiddenHit,
      annotationTrackId: 'transposon:dm88',
    });

    expect(reveal).toEqual({ kind: 'unavailable', focusRange: null });
  });

  it('changes only exact overlay identity when focus changes within the same hidden track', () => {
    const persisted = new Set(['gene', 'mRNA']);
    const first = deriveAnnotationSearchReveal(persisted, hiddenHit);
    const repeated = deriveAnnotationSearchReveal(persisted, { ...hiddenHit });
    const second = deriveAnnotationSearchReveal(persisted, {
      ...hiddenHit,
      start: hiddenHit.start + 10_000,
      end: hiddenHit.end + 10_000,
      canonicalIdentity: 'annotation.v2:second-lncRNA-transcript',
    });

    expect(first.kind).toBe('temporary');
    expect(repeated.kind).toBe('temporary');
    expect(second.kind).toBe('temporary');
    expect(repeated).toEqual(first);
    expect(second.canonicalIdentity).not.toBe(first.canonicalIdentity);
    expect('effectiveVisibleTypes' in first).toBe(false);
    expect([...persisted].sort()).toEqual(['gene', 'mRNA']);
  });

  it('fails closed when a search hit lacks track or canonical annotation identity', () => {
    const persisted = new Set(['gene', 'mRNA']);
    expect(
      deriveAnnotationSearchReveal(persisted, {
        ...hiddenHit,
        annotationTrackId: undefined,
      })
    ).toMatchObject({
      kind: 'unavailable',
      focusRange: null,
    });
    expect(
      deriveAnnotationSearchReveal(persisted, {
        ...hiddenHit,
        canonicalIdentity: undefined,
      })
    ).toMatchObject({
      kind: 'unavailable',
      focusRange: null,
    });
  });

  it('persists only the temporary track selected by Show track', () => {
    const persisted = new Set(['gene', 'mRNA']);
    const next = persistTemporarilyRevealedTrack(persisted, 'lncRNA');

    expect([...next].sort()).toEqual(['gene', 'lncRNA', 'mRNA']);
    expect([...persisted].sort()).toEqual(['gene', 'mRNA']);
  });

  it('does not persist a third spelling for an ambiguous case-insensitive alias', () => {
    const persisted = new Set(['transposon:DM88', 'transposon:Dm88']);
    const next = persistTemporarilyRevealedTrack(persisted, 'transposon:dm88');

    expect(next).toBe(persisted);
    expect([...next]).toEqual(['transposon:DM88', 'transposon:Dm88']);
  });
});
