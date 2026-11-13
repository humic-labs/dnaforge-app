// @vitest-environment node

import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import {
  buildFeatureIdentity,
  buildIdentityRequestKey,
  canonicalJson,
  canonicalProtein,
  evidenceId,
  normalizeInitiator,
} from './protein-identity';

describe('protein identity primitives', () => {
  it('canonicalizes provider lookup bytes with unicode whitespace and one trailing stop', () => {
    const result = canonicalProtein(' mSN\u00a0itiy\nhnpac*\t');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sequence).toBe('MSNITIYHNPAC');
    expect(result.exactLookupEligible).toBe(true);
    expect(result.evidence.map((item) => item.kind)).toEqual([]);
  });

  it('rejects invalid residue characters and records internal stops as ineligible', () => {
    expect(canonicalProtein('MSN-ITI')).toMatchObject({
      ok: false,
      reason: 'invalid_residue',
      evidence: [{ kind: 'protein_invalid_residue' }],
    });

    const internalStop = canonicalProtein('MSN*ITI');
    expect(internalStop.ok).toBe(true);
    if (!internalStop.ok) return;
    expect(internalStop.sequence).toBe('MSN*ITI');
    expect(internalStop.exactLookupEligible).toBe(false);
    expect(internalStop.evidence).toEqual([{ kind: 'internal_stop', residue: '*' }]);
  });

  it('normalizes only derived CDS initiators for bacterial start codons', () => {
    expect(normalizeInitiator('VDTELL', 'GTG', 'derived_cds')).toEqual({
      sequence: 'MDTELL',
      applied: true,
    });
    expect(normalizeInitiator('VDTELL', 'GTG', 'qualifier_translation')).toEqual({
      sequence: 'VDTELL',
      applied: false,
    });
    expect(normalizeInitiator('LDTELL', 'AAA', 'derived_cds')).toEqual({
      sequence: 'LDTELL',
      applied: false,
    });
  });

  it('builds stable evidence IDs independent of object key order and undefined fields', () => {
    const payload = {
      ...leftPayload(),
      details: { start0: 10, strand: 1, ignored: undefined },
    };
    const left = evidenceId(payload);
    const right = evidenceId({
      label: 'derived translation',
      confidence: 'authoritative',
      source: 'waypoint',
      kind: 'derived_cds_translation',
      schemaVersion: 2,
      details: { strand: 1, start0: 10 },
    });

    expect(left).toBe(right);
    expect(left).toBe(
      `ev:derived_cds_translation:waypoint:${sha256Hex(canonicalJson(payload)).slice(0, 16)}`
    );
    expect(evidenceId({ ...leftPayload(), details: { start0: 11 } })).not.toBe(left);
  });

  it('uses scalar-only canonical JSON for evidence details', () => {
    expect(canonicalJson({ b: 2, a: undefined, c: null })).toBe('{"b":2,"c":null}');
    expect(() => canonicalJson({ chains: ['A', 'B'] })).toThrow(/arrays/i);
  });

  it('builds feature keys from canonicalized segments instead of outer span alone', () => {
    const first = buildFeatureIdentity({
      type: 'CDS',
      label: 'geneX CDS',
      entityId: '/tmp/ref.gb',
      circular: true,
      segments: [
        { start0: 450, end0: 499, strand: 1 },
        { start0: 0, end0: 49, strand: 1 },
      ],
      hintSummary: { dbXrefCount: 0, hasProteinId: false, hasLocusTag: false, hasGeneName: true },
    });
    const reordered = buildFeatureIdentity({
      type: 'CDS',
      label: 'geneX CDS',
      entityId: '/tmp/ref.gb',
      circular: true,
      segments: [
        { start0: 0, end0: 49, strand: 1 },
        { start0: 450, end0: 499, strand: 1 },
      ],
      hintSummary: { dbXrefCount: 0, hasProteinId: false, hasLocusTag: false, hasGeneName: true },
    });
    const differentGap = buildFeatureIdentity({
      type: 'CDS',
      label: 'geneX CDS',
      entityId: '/tmp/ref.gb',
      circular: true,
      segments: [
        { start0: 400, end0: 449, strand: 1 },
        { start0: 0, end0: 49, strand: 1 },
      ],
      hintSummary: { dbXrefCount: 0, hasProteinId: false, hasLocusTag: false, hasGeneName: true },
    });

    expect(first.featureKey).toBe(reordered.featureKey);
    expect(first.featureKey).not.toBe(differentGap.featureKey);
  });

  it('freezes request identity as feature plus protein identity', () => {
    expect(buildIdentityRequestKey('feature:v2:abc', 'protein-sequence:v2:def')).toBe(
      'req:feature:v2:abc:protein-sequence:v2:def'
    );
  });
});

function leftPayload() {
  return {
    schemaVersion: 2 as const,
    kind: 'derived_cds_translation' as const,
    source: 'waypoint' as const,
    confidence: 'authoritative' as const,
    label: 'derived translation',
  };
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
