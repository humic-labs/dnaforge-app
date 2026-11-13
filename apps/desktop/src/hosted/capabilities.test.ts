import { describe, expect, it } from 'vitest';
import { HOSTED_CAPABILITIES, hostedCapabilityState } from './capabilities';

describe('hosted capability registry', () => {
  it('leaves every tool available in the desktop app', () => {
    for (const id of Object.keys(HOSTED_CAPABILITIES) as (keyof typeof HOSTED_CAPABILITIES)[]) {
      expect(hostedCapabilityState(id, false, true)).toEqual({ kind: 'available' });
    }
  });

  it('hides browser-unavailable tools and asks demo visitors to sign up for server actions', () => {
    expect(hostedCapabilityState('reference-genomes', true, false)).toEqual({ kind: 'hidden' });
    expect(hostedCapabilityState('external-lookups', true, false)).toEqual({ kind: 'available' });
    expect(hostedCapabilityState('external-lookups', true, true)).toEqual({
      kind: 'sign-up',
      label: 'Sign up to search',
    });
    expect(hostedCapabilityState('primers', true, true)).toEqual({ kind: 'available' });
    expect(hostedCapabilityState('server-jobs', true, false)).toEqual({ kind: 'available' });
    expect(hostedCapabilityState('server-jobs', true, true)).toEqual({
      kind: 'sign-up',
      label: 'Sign up to run this',
    });
    for (const entry of Object.values(HOSTED_CAPABILITIES)) {
      expect(entry.demo).not.toMatch(/plasmid/iu);
    }
  });
});
