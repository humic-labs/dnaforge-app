// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { hasAnnotationResultShape } from './annotation-result';

const feature = {
  name: 'example',
  start: 1,
  end: 4,
  strand: 1,
  identity: 100,
  coverage: 100,
  fragment: false,
  ref_start: 1,
  ref_end: 4,
  ref_length: 4,
  db_source: 'nucleotide',
};

describe('annotation result boundary', () => {
  it('accepts empty results and origin-crossing features', () => {
    expect(hasAnnotationResultShape({ sequence_length: 0, features: [] })).toBe(true);
    expect(
      hasAnnotationResultShape({
        sequence_length: 4,
        features: [{ ...feature, start: 4, end: 2, strand: -1 }],
      })
    ).toBe(true);
  });

  it.each([
    null,
    {},
    { ...feature, name: null },
    { ...feature, fragment: 'false' },
    { ...feature, identity: Number.NaN },
    { ...feature, start: 0 },
    { ...feature, end: 5 },
    { ...feature, strand: 0 },
    { ...feature, ref_end: 5 },
    { ...feature, db_source: 'unrecognized' },
    { ...feature, description: {} },
  ])('rejects malformed retained/imported feature %j', (candidate) => {
    expect(hasAnnotationResultShape({ sequence_length: 4, features: [candidate] })).toBe(false);
  });

  it('rejects malformed errors before the renderer interprets them', () => {
    expect(hasAnnotationResultShape({ sequence_length: 4, features: [], error: {} })).toBe(false);
    expect(
      hasAnnotationResultShape({ sequence_length: 4, features: [], error: 'Unavailable' })
    ).toBe(true);
  });
});
