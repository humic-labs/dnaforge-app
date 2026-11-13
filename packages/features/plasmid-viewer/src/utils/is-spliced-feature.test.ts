import { describe, it, expect } from 'vitest';
import { isSplicedFeature } from './is-spliced-feature';
import type { PlasmidFeature } from '../types';

function feature(overrides: Partial<PlasmidFeature>): PlasmidFeature {
  return {
    type: 'CDS',
    displayName: 'test',
    start: 1,
    end: 100,
    direction: 'forward',
    qualifiers: {},
    color: '#888',
    ...overrides,
  };
}

describe('isSplicedFeature', () => {
  it('returns false for a single-segment feature', () => {
    expect(isSplicedFeature(feature({ start: 100, end: 500 }))).toBe(false);
  });

  it('returns false when no segments are present (even with join() in location)', () => {
    expect(
      isSplicedFeature(
        feature({
          qualifiers: { _locationString: ['join(1..100,200..300)'] },
        })
      )
    ).toBe(false);
  });

  it('returns true for a real spliced CDS (2+ segments + join() + start < end)', () => {
    expect(
      isSplicedFeature(
        feature({
          start: 1,
          end: 300,
          segments: [
            { start: 1, end: 100 },
            { start: 200, end: 300 },
          ],
          qualifiers: { _locationString: ['join(1..100,200..300)'] },
        })
      )
    ).toBe(true);
  });

  it('returns FALSE for a complement-strand origin-wrap (URA3 case)', () => {
    expect(
      isSplicedFeature(
        feature({
          start: 451,
          end: 50,
          direction: 'reverse',
          segments: [
            { start: 451, end: 500 },
            { start: 1, end: 50 },
          ],
          qualifiers: { _locationString: ['complement(join(1..50,451..500))'] },
        })
      )
    ).toBe(false);
  });

  it('returns FALSE for a forward-strand origin-wrap', () => {
    expect(
      isSplicedFeature(
        feature({
          start: 451,
          end: 50,
          direction: 'forward',
          segments: [
            { start: 451, end: 500 },
            { start: 1, end: 50 },
          ],
          qualifiers: { _locationString: ['join(451..500,1..50)'] },
        })
      )
    ).toBe(false);
  });

  it('returns FALSE for an order() location (not splicing semantics)', () => {
    expect(
      isSplicedFeature(
        feature({
          start: 1,
          end: 300,
          segments: [
            { start: 1, end: 100 },
            { start: 200, end: 300 },
          ],
          qualifiers: { _locationString: ['order(1..100,200..300)'] },
        })
      )
    ).toBe(false);
  });

  it('returns FALSE when _locationString is missing', () => {
    expect(
      isSplicedFeature(
        feature({
          start: 1,
          end: 300,
          segments: [
            { start: 1, end: 100 },
            { start: 200, end: 300 },
          ],
        })
      )
    ).toBe(false);
  });
});
