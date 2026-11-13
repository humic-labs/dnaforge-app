// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  assessOligoClassification as assess,
  parseOligoClassificationEvidence,
  type OligoClassificationEvidence,
} from './oligo-classification';
const assessOligoClassification = (
  input: Omit<Parameters<typeof assess>[0], 'evidenceLimited' | 'targetSourceId'> & {
    evidenceLimited?: boolean;
    targetSourceId?: string;
  }
) => assess({ evidenceLimited: false, targetSourceId: 'seq_OLIGO001', ...input });

const source = {
  sourceObjectId: 'etr_NOTEBOOK01',
  targetSourceId: 'seq_OLIGO001',
  sourceEntryPath: 'Lab/Experiment.html',
  sourceEntrySha256: `sha256:${'a'.repeat(64)}`,
  occurrence: 0,
};
const declared: OligoClassificationEvidence = {
  ...source,
  channel: 'provider_display_type',
  value: 'oligo',
};
const role: OligoClassificationEvidence = {
  ...source,
  channel: 'authored_role',
  value: 'primer',
  excerpt: 'Redesigned forward primer',
};
const sequence = {
  molecule: 'dna' as const,
  available: true,
  length: 24,
  topology: 'linear' as const,
};

describe('reviewed oligo classification evidence', () => {
  it('validates persisted evidence before it can support a review', () => {
    const packet = {
      schema: 'dnaforge.benchling.classification-evidence.v1',
      limited: false,
      facts: [declared, role],
    };
    expect(parseOligoClassificationEvidence(packet)).toEqual(packet);
    for (const invalid of [
      null,
      { ...packet, limited: undefined },
      { ...packet, facts: [{ ...role, value: 'unknown-role' }] },
      { ...packet, facts: [{ ...declared, targetSourceId: 'not-an-id' }] },
      { ...packet, facts: [{ ...role, occurrence: -1 }] },
      { ...packet, facts: Array(257).fill(declared) },
    ])
      expect(parseOligoClassificationEvidence(invalid)).toBeNull();
  });
  it('does not recommend from incomplete evidence or a homogeneous wrong target', () => {
    expect(
      assessOligoClassification({ sequence, evidence: [declared, role], evidenceLimited: true })
    ).toMatchObject({ status: 'needs_review', reason: 'incomplete_evidence' });
    expect(
      assessOligoClassification({
        sequence,
        evidence: [declared, role],
        targetSourceId: 'seq_OTHER001',
      })
    ).toMatchObject({ status: 'needs_review', reason: 'mixed_targets' });
  });
  it('preserves contradictory provider types but permits generic sequence descriptions', () => {
    expect(
      assessOligoClassification({
        sequence,
        evidence: [declared, role, { ...declared, value: 'plasmid' }],
      })
    ).toMatchObject({ status: 'needs_review', reason: 'conflicting_types' });
    expect(
      assessOligoClassification({
        sequence,
        evidence: [declared, role, { ...declared, value: 'sequence' }],
      })
    ).toMatchObject({ status: 'suggested' });
  });
  it('requires a provider type and an authored role, not name or short length', () => {
    expect(assessOligoClassification({ sequence, evidence: [] })).toMatchObject({
      status: 'needs_review',
    });
    expect(assessOligoClassification({ sequence, evidence: [declared] })).toMatchObject({
      status: 'needs_review',
    });
    expect(assessOligoClassification({ sequence, evidence: [role] })).toMatchObject({
      status: 'needs_review',
    });
    expect(assessOligoClassification({ sequence, evidence: [declared, role] })).toMatchObject({
      status: 'suggested',
      kind: 'oligo',
      use: 'primer',
    });
  });
  it('does not count repeated icons as independent evidence', () => {
    expect(
      assessOligoClassification({
        sequence,
        evidence: Array.from({ length: 10 }, (_, occurrence) => ({ ...declared, occurrence })),
      })
    ).toMatchObject({ status: 'needs_review' });
  });
  it('requires review when authored roles disagree', () => {
    expect(
      assessOligoClassification({
        sequence,
        evidence: [declared, role, { ...role, value: 'probe', excerpt: 'Probe' }],
      })
    ).toMatchObject({ status: 'needs_review', reason: 'conflicting_roles' });
  });
  it('does not mix evidence addressed to different objects', () => {
    expect(
      assessOligoClassification({
        sequence,
        evidence: [declared, { ...role, targetSourceId: 'seq_DIFFERENT1' }],
      })
    ).toMatchObject({ status: 'needs_review', reason: 'mixed_targets' });
  });
  it('preserves RNA as RNA', () => {
    expect(
      assessOligoClassification({
        sequence: { ...sequence, molecule: 'rna' },
        evidence: [declared, role],
      })
    ).toMatchObject({ status: 'suggested', kind: 'rna_oligo', use: 'primer' });
  });
  it.each([
    { ...sequence, available: false },
    { ...sequence, length: 0 },
    { ...sequence, topology: 'circular' as const },
  ])('does not offer application without a usable linear sequence', (sequence) => {
    expect(assessOligoClassification({ sequence, evidence: [declared, role] })).toMatchObject({
      status: 'unavailable',
    });
  });
});
