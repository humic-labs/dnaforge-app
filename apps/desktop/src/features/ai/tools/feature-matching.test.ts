import { describe, it, expect } from 'vitest';
import { matchFeatures } from './feature-matching';
import type { BiologyFeature } from './parse-biology-file';

function makeFeature(
  overrides: Partial<BiologyFeature> & { displayName: string; type: string }
): BiologyFeature {
  return {
    start: 1,
    end: 100,
    direction: 'forward',
    qualifiers: {},
    color: '#000',
    ...overrides,
  };
}

const features: BiologyFeature[] = [
  makeFeature({ displayName: 'AmpR', type: 'CDS', start: 1629, end: 2489, qualifiers: { gene: ['bla'], product: ['beta-lactamase'] } }),
  makeFeature({ displayName: 'AmpR promoter', type: 'promoter', start: 2490, end: 2594, qualifiers: { label: ['AmpR promoter'] } }),
  makeFeature({ displayName: 'ori', type: 'rep_origin', start: 2315, end: 2686, qualifiers: { note: ['high-copy-number ColE1/pMB1/pBR322/pUC origin of replication'] } }),
  makeFeature({ displayName: 'lacZ-alpha', type: 'CDS', start: 217, end: 596, qualifiers: { gene: ['lacZ'] } }),
  makeFeature({ displayName: 'lac promoter', type: 'promoter', start: 146, end: 216 }),
];

describe('matchFeatures', () => {
  it('returns all features when no filters provided', () => {
    expect(matchFeatures(features)).toHaveLength(5);
  });

  it('matches by query substring (case-insensitive) against displayName', () => {
    const result = matchFeatures(features, 'amp');
    expect(result).toHaveLength(2);
    expect(result.map(f => f.displayName)).toEqual(['AmpR', 'AmpR promoter']);
  });

  it('matches by query against qualifier gene', () => {
    const result = matchFeatures(features, 'bla');
    expect(result).toHaveLength(1);
    expect(result[0].displayName).toBe('AmpR');
  });

  it('matches by query against qualifier product', () => {
    const result = matchFeatures(features, 'beta-lactamase');
    expect(result).toHaveLength(1);
    expect(result[0].displayName).toBe('AmpR');
  });

  it('matches by query against qualifier note', () => {
    const result = matchFeatures(features, 'ColE1');
    expect(result).toHaveLength(1);
    expect(result[0].displayName).toBe('ori');
  });

  it('matches by query against qualifier label', () => {
    const result = matchFeatures(features, 'AmpR promoter');
    expect(result).toHaveLength(1);
    expect(result[0].displayName).toBe('AmpR promoter');
  });

  it('filters by type (case-insensitive exact match)', () => {
    const result = matchFeatures(features, undefined, 'CDS');
    expect(result).toHaveLength(2);
    expect(result.map(f => f.displayName)).toEqual(['AmpR', 'lacZ-alpha']);
  });

  it('filters by type case-insensitively', () => {
    const result = matchFeatures(features, undefined, 'cds');
    expect(result).toHaveLength(2);
  });

  it('AND logic: query + type narrows results', () => {
    const result = matchFeatures(features, 'amp', 'CDS');
    expect(result).toHaveLength(1);
    expect(result[0].displayName).toBe('AmpR');
  });

  it('returns empty for no matches', () => {
    expect(matchFeatures(features, 'nonexistent')).toHaveLength(0);
  });

  it('returns empty for no type matches', () => {
    expect(matchFeatures(features, undefined, 'intron')).toHaveLength(0);
  });
});
