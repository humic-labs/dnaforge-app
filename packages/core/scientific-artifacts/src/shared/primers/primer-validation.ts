import type { ValidationResult, ValidationError } from './types';
import type { OligoOrderType } from './oligo-modifications';

const IUPAC_REGEX = /^[ATCGRYSWKMBDHVNatcgryswkmbdhvn]+$/;
const RNA_AND_DNA_IUPAC_REGEX = /^[ATCGRUYSWKMBDHVNatcgruyswkmbdhvn]+$/;

export function validatePrimerSequence(
  sequence: string,
  options: { orderType?: OligoOrderType } = {}
): ValidationResult {
  const trimmed = sequence.trim();
  const errors: ValidationError[] = [];

  if (trimmed.length === 0) {
    return { valid: false, errors: [{ reason: 'empty' }] };
  }

  if (/\s/.test(trimmed)) {
    return { valid: false, errors: [{ reason: 'invalid_char' }] };
  }

  const validSequence = options.orderType === 'rna' ? RNA_AND_DNA_IUPAC_REGEX : IUPAC_REGEX;
  const validCharacter =
    options.orderType === 'rna'
      ? /[ATCGRUYSWKMBDHVNatcgruyswkmbdhvn]/
      : /[ATCGRYSWKMBDHVNatcgryswkmbdhvn]/;
  if (!validSequence.test(trimmed)) {
    for (let i = 0; i < trimmed.length; i++) {
      if (!validCharacter.test(trimmed[i])) {
        errors.push({ position: i, char: trimmed[i] });
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, trimmed };
}

export function primerSequenceValidationMessage(result: ValidationResult): string | null {
  if (result.valid) return null;
  return (
    result.errors
      ?.map((error) => {
        switch (error.reason) {
          case 'empty':
            return 'Enter an oligo sequence.';
          case 'too_short':
            return `Enter at least ${error.min} bases.`;
          case 'too_long':
            return `Use no more than ${error.max} bases.`;
          default:
            return error.position === undefined
              ? 'The sequence contains an invalid base.'
              : `Invalid base at position ${error.position + 1}.`;
        }
      })
      .join(' ') || 'The oligo sequence is invalid.'
  );
}
