import { describe, expect, it } from 'vitest';
import { primerSequenceValidationMessage, validatePrimerSequence } from './primer-validation';

describe('the shared oligo validation message', () => {
  it('accepts a successful result without an errors array', () => {
    expect(primerSequenceValidationMessage(validatePrimerSequence('ACGTACGTACGT'))).toBeNull();
  });
  it('accepts any non-empty length and explains an empty or invalid sequence', () => {
    expect(primerSequenceValidationMessage(validatePrimerSequence('ACG'))).toBeNull();
    expect(primerSequenceValidationMessage(validatePrimerSequence(''))).toBe(
      'Enter an oligo sequence.'
    );
    expect(primerSequenceValidationMessage(validatePrimerSequence('ACGXT'))).toBe(
      'Invalid base at position 4.'
    );
  });
});
