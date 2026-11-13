import { describe, it, expect } from 'vitest';
import {
  parseActionName,
  isValidActionName,
  assertValidActionName,
  InvalidActionNameError,
} from './naming';

describe('parseActionName', () => {
  it('parses a v1 (unsuffixed) name', () => {
    expect(parseActionName('sequence.findFeatures')).toEqual({
      qualifiedName: 'sequence.findFeatures',
      domain: 'sequence',
      verb: 'findFeatures',
      version: 1,
      raw: 'sequence.findFeatures',
    });
  });

  it('parses a single-word verb', () => {
    expect(parseActionName('external.fetch')).toEqual({
      qualifiedName: 'external.fetch',
      domain: 'external',
      verb: 'fetch',
      version: 1,
      raw: 'external.fetch',
    });
  });

  it('parses a _v2 versioned name', () => {
    expect(parseActionName('sequence.findFeatures_v2')).toEqual({
      qualifiedName: 'sequence.findFeatures',
      domain: 'sequence',
      verb: 'findFeatures',
      version: 2,
      raw: 'sequence.findFeatures_v2',
    });
  });

  it('parses double-digit version suffixes', () => {
    const parsed = parseActionName('design.addRegion_v22');
    expect(parsed?.version).toBe(22);
    expect(parsed?.qualifiedName).toBe('design.addRegion');
  });

  it.each([10, 11, 19, 99, 100, 101, 199, 1000, 9999])(
    'parses _v%i (leading-1 versions used to be silently rejected)',
    (v) => {
      const parsed = parseActionName(`design.addRegion_v${v}`);
      expect(parsed?.version).toBe(v);
      expect(parsed?.qualifiedName).toBe('design.addRegion');
    }
  );

  it('allows alphanumeric domains', () => {
    expect(parseActionName('s3.upload')?.domain).toBe('s3');
  });

  it.each([
    ['empty', ''],
    ['no dot', 'findFeatures'],
    ['trailing dot', 'sequence.'],
    ['leading dot', '.findFeatures'],
    ['extra dot', 'sequence.find.features'],
    ['capitalized domain', 'Sequence.findFeatures'],
    ['capitalized verb start', 'sequence.FindFeatures'],
    ['underscore in verb', 'sequence.find_features'],
    ['digit at start of domain', '1sequence.findFeatures'],
    ['digit at start of verb', 'sequence.1findFeatures'],
    ['explicit v1 suffix', 'sequence.findFeatures_v1'],
    ['v0 suffix', 'sequence.findFeatures_v0'],
    ['_v with no number', 'sequence.findFeatures_v'],
    ['leading-zero version', 'sequence.findFeatures_v02'],
    ['hyphen in name', 'sequence.find-features'],
    ['whitespace', 'sequence.findFeatures '],
    ['space inside', 'sequence.find Features'],
    ['kebab domain', 'my-domain.verb'],
    ['underscore-only verb separator', 'sequence_findFeatures'],
  ])('rejects %s', (_label, name) => {
    expect(parseActionName(name)).toBeNull();
  });

  it('rejects non-string inputs', () => {
    expect(parseActionName(null as unknown as string)).toBeNull();
    expect(parseActionName(undefined as unknown as string)).toBeNull();
    expect(parseActionName(123 as unknown as string)).toBeNull();
  });
});

describe('isValidActionName', () => {
  it('matches parseActionName !== null', () => {
    expect(isValidActionName('sequence.findFeatures')).toBe(true);
    expect(isValidActionName('sequence.findFeatures_v2')).toBe(true);
    expect(isValidActionName('sequence.find_features')).toBe(false);
    expect(isValidActionName('')).toBe(false);
  });
});

describe('assertValidActionName', () => {
  it('returns the parsed name on success', () => {
    const parsed = assertValidActionName('design.addRegion');
    expect(parsed.domain).toBe('design');
    expect(parsed.verb).toBe('addRegion');
  });

  it('throws InvalidActionNameError with the offending name', () => {
    try {
      assertValidActionName('Bad.Name');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidActionNameError);
      expect((err as InvalidActionNameError).actionName).toBe('Bad.Name');
      expect((err as Error).message).toContain('Bad.Name');
    }
  });
});
