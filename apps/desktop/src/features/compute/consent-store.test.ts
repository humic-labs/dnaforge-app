// @vitest-environment node

import { beforeEach, describe, expect, it } from 'vitest';

import { describeCost, describeSubmission, useComputeConsentStore } from './consent-store';

beforeEach(() => {
  useComputeConsentStore.getState().resetForTests();
});

describe('first-submit gate and session budget', () => {
  it('asks on the first submit per provider, then not until the budget is reached', () => {
    const s = useComputeConsentStore.getState;
    expect(s().needsConfirmation('tamarind', 0.4)).toBe(true);
    s().recordConfirmation('tamarind');
    expect(s().needsConfirmation('tamarind', 0.4)).toBe(false);
    for (let i = 0; i < 9; i += 1) s().recordSubmit('tamarind', 0.4);
    expect(s().needsConfirmation('tamarind', 0.4)).toBe(false);
    s().recordSubmit('tamarind', 0.4);
    expect(s().needsConfirmation('tamarind', 0.4)).toBe(true);
    s().recordConfirmation('tamarind');
    expect(s().needsConfirmation('tamarind', 0.4)).toBe(false);
  });

  it('asks again when the cost budget would be exceeded, even under the job cap', () => {
    const s = useComputeConsentStore.getState;
    s().recordConfirmation('tamarind');
    s().recordSubmit('tamarind', 6);
    expect(s().needsConfirmation('tamarind', 3)).toBe(false);
    expect(s().needsConfirmation('tamarind', 5)).toBe(true);
    expect(s().needsConfirmation('tamarind', null)).toBe(false);
  });

  it('is per provider', () => {
    const s = useComputeConsentStore.getState;
    s().recordConfirmation('tamarind');
    expect(s().needsConfirmation('tamarind', 1)).toBe(false);
    expect(s().needsConfirmation('subseq', 1)).toBe(true);
  });

  it('honours a custom budget', () => {
    const s = useComputeConsentStore.getState;
    s().setBudget({ maxJobs: 1, maxCost: 100 });
    s().recordConfirmation('tamarind');
    s().recordSubmit('tamarind', 0);
    expect(s().needsConfirmation('tamarind', 0)).toBe(true);
  });
});

describe('describeSubmission / describeCost', () => {
  it('summarizes sequences, files, and other settings without leaking content', () => {
    const text = describeSubmission(
      { sequence: 'MKTAYIAKQRQISFVKSHFSRQ', chainB: 'GGGG', numModels: 5 },
      { 'target.pdb': 'ATOM'.repeat(100) }
    );
    expect(text).toBe('Sequences: 2 (26 residues); files: 1 (400 bytes); other settings: 1');
    expect(text).not.toContain('MKTAY');
  });
  it('counts sequences nested inside provider-specific shapes (Boltz-2 polymers, multimer lists)', () => {
    expect(
      describeSubmission(
        {
          polymers: [
            { id: 'A', molecule_type: 'protein', sequence: 'MKTAYIAKQR' },
            { id: 'B', molecule_type: 'protein', sequence: 'GGGGS' },
          ],
          recycling_steps: 1,
        },
        {}
      )
    ).toBe('Sequences: 2 (15 residues); files: 0 (0 bytes); other settings: 2');
    expect(describeSubmission({ sequences: ['MKT', 'GGG'] }, {})).toBe(
      'Sequences: 2 (6 residues); files: 0 (0 bytes); other settings: 0'
    );
  });

  it('handles an empty job', () => {
    expect(describeSubmission({}, {})).toBe(
      'Sequences: 0 (0 residues); files: 0 (0 bytes); other settings: 0'
    );
  });
  it('describes known and unknown cost', () => {
    expect(describeCost(0.4, 'weighted_hours')).toBe('Estimated cost: 0.4 weighted hours.');
    expect(describeCost(3, 'credits')).toBe('Estimated cost: 3 credits.');
    expect(describeCost(null, 'weighted_hours')).toMatch(/not available/);
  });
});

describe('describeSubmission sequence accounting', () => {
  it('counts Boltz entity sequences and not their chain ids', () => {
    const text = describeSubmission(
      {
        entities: [{ type: 'protein', value: 'MKTAYIAKQR', chain_ids: ['A', 'B'] }],
        num_samples: 1,
      },
      {}
    );
    expect(text).toBe('Sequences: 1 (10 residues); files: 0 (0 bytes); other settings: 2');
  });

  it('does not count a chain id as a sequence', () => {
    expect(describeSubmission({ sequence: 'MKT', chain_id: 'A' }, {})).toBe(
      'Sequences: 1 (3 residues); files: 0 (0 bytes); other settings: 1'
    );
  });
});
