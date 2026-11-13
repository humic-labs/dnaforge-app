// @vitest-environment node

import { describe, expect, it } from 'vitest';

import type { Feature } from '@waypoint/genome-renderer';

import {
  annotationIdentityFromFeature,
  featureMatchesAnnotation,
} from './indexed-genome-selection';

function feature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: 1,
    type: 'mRNA',
    start: 1000,
    end: 5000,
    direction: 'forward',
    displayName: 'GENE-A',
    color: 0x3b82f6,
    lane: 0,
    ...overrides,
  } as Feature;
}

describe('indexed-genome selection identity', () => {
  describe('🟥 transcript-isoform grouping regression', () => {
    const isoformA = feature({
      id: 1001,
      type: 'mRNA',
      displayName: 'GENE-A',
      start: 1000,
      end: 5000,
      direction: 'forward',
    });
    const isoformB = feature({
      id: 1002,
      type: 'mRNA',
      displayName: 'GENE-A',
      start: 1000,
      end: 5000,
      direction: 'forward',
    });
    const isoformC = feature({
      id: 1003,
      type: 'mRNA',
      displayName: 'GENE-A',
      start: 1000,
      end: 5000,
      direction: 'forward',
    });

    it('selecting isoformA matches isoformA only — NOT B or C', () => {
      const identity = annotationIdentityFromFeature(isoformA);
      expect(featureMatchesAnnotation(isoformA, identity)).toBe(true);
      expect(featureMatchesAnnotation(isoformB, identity)).toBe(false);
      expect(featureMatchesAnnotation(isoformC, identity)).toBe(false);
    });

    it('selecting isoformB matches isoformB only', () => {
      const identity = annotationIdentityFromFeature(isoformB);
      expect(featureMatchesAnnotation(isoformA, identity)).toBe(false);
      expect(featureMatchesAnnotation(isoformB, identity)).toBe(true);
      expect(featureMatchesAnnotation(isoformC, identity)).toBe(false);
    });

    it('the identity payload includes featureId (the load-bearing field)', () => {
      const identity = annotationIdentityFromFeature(isoformA);
      expect(identity.featureId).toBe(1001);
    });

    it('two features sharing all other fields produce distinct identities', () => {
      const idA = annotationIdentityFromFeature(isoformA);
      const idB = annotationIdentityFromFeature(isoformB);
      expect(idA.featureId).not.toBe(idB.featureId);
      expect(idA.type).toBe(idB.type);
      expect(idA.name).toBe(idB.name);
      expect(idA.start).toBe(idB.start);
      expect(idA.end).toBe(idB.end);
      expect(idA.direction).toBe(idB.direction);
    });
  });

  describe('annotationIdentityFromFeature', () => {
    it('captures the renderer feature id directly', () => {
      const identity = annotationIdentityFromFeature(feature({ id: 42 }));
      expect(identity.featureId).toBe(42);
    });

    it('preserves the durable canonical identity across artifact-local renderer ids', () => {
      const identity = annotationIdentityFromFeature(
        feature({ id: 4_000_000_000, canonicalIdentity: 'annotation-v2|TX41' })
      );
      expect(identity).toMatchObject({
        featureId: 4_000_000_000,
        canonicalIdentity: 'annotation-v2|TX41',
      });
    });

    it('shifts start to 1-based for the diagnostic field (matches GFF3 convention)', () => {
      const identity = annotationIdentityFromFeature(feature({ start: 1000 }));
      expect(identity.start).toBe(1001);
    });

    it('encodes direction numerically (forward=1, reverse=-1, none=undefined)', () => {
      expect(annotationIdentityFromFeature(feature({ direction: 'forward' })).direction).toBe(1);
      expect(annotationIdentityFromFeature(feature({ direction: 'reverse' })).direction).toBe(-1);
      expect(
        annotationIdentityFromFeature(feature({ direction: 'none' })).direction
      ).toBeUndefined();
    });
  });

  describe('featureMatchesAnnotation', () => {
    it('returns true only for the exact feature.id from the identity', () => {
      const identity = annotationIdentityFromFeature(feature({ id: 7 }));
      expect(featureMatchesAnnotation(feature({ id: 7 }), identity)).toBe(true);
      expect(featureMatchesAnnotation(feature({ id: 8 }), identity)).toBe(false);
    });

    it('does not match on shared display name', () => {
      const identity = annotationIdentityFromFeature(feature({ id: 1, displayName: 'X' }));
      expect(featureMatchesAnnotation(feature({ id: 2, displayName: 'X' }), identity)).toBe(false);
    });

    it('does not match on shared start/end coordinates', () => {
      const identity = annotationIdentityFromFeature(feature({ id: 1, start: 100, end: 200 }));
      expect(featureMatchesAnnotation(feature({ id: 2, start: 100, end: 200 }), identity)).toBe(
        false
      );
    });

    it('matches the same canonical annotation across different local renderer ids', () => {
      const broad = annotationIdentityFromFeature(
        feature({ id: 7, canonicalIdentity: 'annotation-v2|TX41' })
      );
      expect(
        featureMatchesAnnotation(
          feature({ id: 4_000_000_000, canonicalIdentity: 'annotation-v2|TX41' }),
          broad
        )
      ).toBe(true);
    });

    it('rejects a numeric-id collision when canonical identities disagree', () => {
      const broad = annotationIdentityFromFeature(
        feature({ id: 7, canonicalIdentity: 'annotation-v2|TX41' })
      );
      expect(
        featureMatchesAnnotation(
          feature({ id: 7, canonicalIdentity: 'annotation-v2|OTHER' }),
          broad
        )
      ).toBe(false);
    });
  });
});
