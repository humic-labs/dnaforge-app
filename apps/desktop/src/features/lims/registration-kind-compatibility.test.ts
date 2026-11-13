import { describe, expect, it } from 'vitest';
import {
  getOpenSequenceRegistrationKindOptions,
  isOpenSequenceRegistrationKindCompatible,
} from './registration-kind-compatibility';

describe('open sequence registration kind compatibility', () => {
  it('offers one base DNA sequence type for circular files', () => {
    const options = getOpenSequenceRegistrationKindOptions({
      sourceType: 'file_dna_sequence',
      topology: 'circular',
      length: 2686,
    });

    expect(options.map((option) => option.kind)).toEqual(['sequence']);
    expect(options[0]).toMatchObject({
      disabled: false,
      title: 'Register as a DNA sequence (2,686 bp)',
    });
    expect(isOpenSequenceRegistrationKindCompatible('sequence', { topology: 'circular' })).toBe(
      true
    );
  });

  it('does not turn linear topology into a different import type', () => {
    const options = getOpenSequenceRegistrationKindOptions({
      sourceType: 'file_dna_sequence',
      topology: 'linear',
      length: 78_000,
    });

    expect(options[0]).toMatchObject({
      kind: 'sequence',
      disabled: false,
      title: 'Register as a DNA sequence (78,000 bp)',
    });
    expect(isOpenSequenceRegistrationKindCompatible('sequence', { topology: 'linear' })).toBe(true);
  });
});
