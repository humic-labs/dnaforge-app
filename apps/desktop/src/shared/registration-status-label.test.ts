// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { registrationStatusLabel, LIMS_REGISTRATION_STATUSES } from './lims';

describe('registrationStatusLabel ', () => {
  it('relabels the benign drift state as "edited", never "drifted"', () => {
    expect(registrationStatusLabel('drifted')).toBe('edited');
  });

  it('leaves the other statuses as their raw enum word (only drift is reframed)', () => {
    expect(registrationStatusLabel('tracked')).toBe('tracked');
    expect(registrationStatusLabel('registered')).toBe('registered');
    expect(registrationStatusLabel('unresolved')).toBe('unresolved');
  });

  it('covers every registration status enum value (no bare enum leaks to the UI)', () => {
    for (const status of LIMS_REGISTRATION_STATUSES) {
      const label = registrationStatusLabel(status);
      expect(label).toBeTruthy();
      expect(label.toLowerCase()).not.toBe('drifted');
    }
  });
});
