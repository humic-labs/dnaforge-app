import { describe, expect, it } from 'vitest';

import type { Feature } from '../../../types';
import {
  fingerprintAnnotationFeatureSet,
  internToken,
  mixNum,
  mixSpans,
  mixU32,
} from './annotation-feature-fingerprint';

function feature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: 1,
    type: 'gene',
    start: 0,
    end: 10,
    direction: 'forward',
    displayName: 'feature',
    color: 0,
    lane: 0,
    ...overrides,
  };
}

describe('annotation feature fingerprint', () => {
  it('mixes u32 and multi-word numbers stably', () => {
    expect(mixU32(0x811c9dc5, 1)).toBeGreaterThan(0);
    expect(mixNum(0, 3_000_000_000)).not.toBe(mixNum(0, 3_000_000_000 - 0x1_0000_0000));
  });

  it('interns tokens to a stable id', () => {
    const a = internToken('mRNA');
    const b = internToken('mRNA');
    const c = internToken('CDS');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('mixes empty and non-empty span lists', () => {
    expect(mixSpans(1, undefined)).toBe(mixU32(1, 0));
    expect(mixSpans(1, [])).toBe(mixU32(1, 0));
    expect(mixSpans(1, [{ start: 1, end: 5 }])).not.toBe(mixSpans(1, []));
  });

  it('fingerprints feature sets by content and length', () => {
    const a = fingerprintAnnotationFeatureSet([
      feature({ id: 1, type: 'mRNA', start: 10, end: 20 }),
      feature({ id: 2, type: 'CDS', start: 12, end: 18, direction: 'reverse' }),
    ]);
    const b = fingerprintAnnotationFeatureSet([
      feature({ id: 1, type: 'mRNA', start: 10, end: 20 }),
      feature({ id: 2, type: 'CDS', start: 12, end: 18, direction: 'reverse' }),
    ]);
    const c = fingerprintAnnotationFeatureSet([
      feature({ id: 1, type: 'mRNA', start: 10, end: 21 }),
    ]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith('fnv:')).toBe(true);
    expect(a.endsWith(':2')).toBe(true);
  });

  it('includes exons/cds spans and outline/source qualifiers in the fingerprint', () => {
    const base = fingerprintAnnotationFeatureSet([feature({ id: 9 })]);
    const withExons = fingerprintAnnotationFeatureSet([
      feature({ id: 9, exons: [{ start: 1, end: 4 }] }),
    ]);
    const outline = fingerprintAnnotationFeatureSet([feature({ id: 9, outlineOnly: true })]);
    const sourced = fingerprintAnnotationFeatureSet([
      feature({ id: 9, qualifiers: { source: 'refseq', status: 'accepted' } }),
    ]);
    expect(withExons).not.toBe(base);
    expect(outline).not.toBe(base);
    expect(sourced).not.toBe(base);
  });
});
