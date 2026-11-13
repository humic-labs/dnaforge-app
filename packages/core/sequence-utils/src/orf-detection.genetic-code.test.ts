import { describe, expect, it } from 'vitest';
import { buildCustomGeneticCode } from './custom-genetic-codes';
import { findORFs } from './orf-detection';

const WITH_INTERNAL_TGA = `ATG${'AAA'.repeat(40)}TGA${'AAA'.repeat(40)}TAA`;

function forwardFrameOne(sequence: string, options = {}) {
  return findORFs(sequence, 30, options).filter((orf) => orf.strand === '+' && orf.frame === 1);
}

describe('findORFs and the genetic code', () => {
  it('ends at an internal TGA under the standard code', () => {
    const [orf] = forwardFrameOne(WITH_INTERNAL_TGA);
    expect(orf).toBeDefined();
    expect(orf.length).toBe(126);
  });

  it('reads straight through that TGA under a code where it is tryptophan', () => {
    const [orf] = forwardFrameOne(WITH_INTERNAL_TGA, { geneticCode: 4 });
    expect(orf).toBeDefined();
    expect(orf.length).toBe(249);
  });

  it('stops at AGA under the vertebrate mitochondrial code, which the standard reads as arginine', () => {
    const withAga = `ATG${'AAA'.repeat(40)}AGA${'AAA'.repeat(40)}TAA`;
    expect(forwardFrameOne(withAga)[0].length).toBe(249);
    expect(forwardFrameOne(withAga, { geneticCode: 2 })[0].length).toBe(126);
  });

  it('keeps ATG-only starts by default, even under a code with more initiators', () => {
    const ttgStart = `TTG${'AAA'.repeat(40)}TAA`;
    expect(forwardFrameOne(ttgStart)).toHaveLength(0);
    expect(forwardFrameOne(ttgStart, { allowAlternativeStartCodons: true })).toHaveLength(1);
  });

  it("uses the code's own initiator set when alternatives are allowed", () => {
    const ataStart = `ATA${'AAA'.repeat(40)}TAA`;
    expect(
      forwardFrameOne(ataStart, { allowAlternativeStartCodons: true, geneticCode: 3 })
    ).toHaveLength(1);
    expect(
      forwardFrameOne(ataStart, { allowAlternativeStartCodons: true, geneticCode: 1 })
    ).toHaveLength(0);
  });

  it('scans exactly as before when given no code', () => {
    expect(findORFs(WITH_INTERNAL_TGA, 30)).toEqual(
      findORFs(WITH_INTERNAL_TGA, 30, { geneticCode: 1 })
    );
  });

  it('carries the code into a spliced scan', () => {
    const spliced = { segments: [{ start: 0, end: WITH_INTERNAL_TGA.length }] };
    expect(findORFs(WITH_INTERNAL_TGA, 30, { ...spliced, geneticCode: 4 })[0].length).toBe(249);
    expect(findORFs(WITH_INTERNAL_TGA, 30, spliced)[0].length).toBe(126);
  });
});

describe('findORFs and a custom genetic code', () => {
  function custom(
    changes: Parameters<typeof buildCustomGeneticCode>[0]['changes'],
    residues = [] as { abbreviation: string; name: string }[]
  ) {
    const result = buildCustomGeneticCode({
      id: 'gc-0a0b0c0d',
      revision: 1,
      name: 'Test',
      base: 11,
      changes,
      residues,
    });
    if (!result.ok) throw new Error(result.issues.map((issue) => issue.message).join('; '));
    return result.definition;
  }

  it('reads through TAG when TAG encodes a non-standard residue', () => {
    const withTag = `ATG${'AAA'.repeat(40)}TAG${'AAA'.repeat(40)}TAA`;
    const amber = custom({ TAG: { kind: 'residue', residue: 'pAzF' } }, [
      { abbreviation: 'pAzF', name: 'p-azido-L-phenylalanine' },
    ]);
    expect(forwardFrameOne(withTag)[0].length).toBe(126);
    expect(forwardFrameOne(withTag, { geneticCode: amber })[0].length).toBe(249);
  });

  it('ends at an unassigned codon, since nothing can decode it', () => {
    const withTcg = `ATG${'AAA'.repeat(40)}TCG${'AAA'.repeat(40)}TAA`;
    const freed = custom({ TCG: { kind: 'unassigned' } });
    expect(forwardFrameOne(withTcg)[0].length).toBe(249);
    expect(forwardFrameOne(withTcg, { geneticCode: freed })[0].length).toBe(126);
  });
});
