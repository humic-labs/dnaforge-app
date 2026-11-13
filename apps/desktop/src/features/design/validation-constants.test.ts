// @vitest-environment node

import { describe, expect, it } from 'vitest';
import * as validationConstants from './validation-constants';
import * as publicValidationConstants from './public/validation-constants';

const UNUSED_RUNTIME_EXPORTS = [
  'GIBSON_MIN_TM',
  'GOLDENGATE_STANDARD_OVERHANG_LENGTH',
  'GOLDENGATE_SAPI_OVERHANG_LENGTH',
  'GOLDENGATE_MAX_DUPLICATE_OVERHANGS',
  'createValidationResult',
  'addError',
  'addWarning',
] as const;

describe('design validation constants', () => {
  it('does not export unused assembly-validation helpers', () => {
    for (const name of UNUSED_RUNTIME_EXPORTS) {
      expect(validationConstants).not.toHaveProperty(name);
      expect(publicValidationConstants).not.toHaveProperty(name);
    }
    expect(typeof validationConstants.isPalindrome).toBe('function');
    expect(typeof validationConstants.GIBSON_MIN_HOMOLOGY_LENGTH).toBe('number');
    expect(typeof validationConstants.GOLDENGATE_DEFAULT_PCR_TM).toBe('number');
  });
});
