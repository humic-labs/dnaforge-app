import { describe, it, expect } from 'vitest';
import { parseGenBank } from './genbank';

function buildGb(
  seqLen: number,
  features: Array<{ type: string; loc: string; quals?: string[] }>
): string {
  const seq = 'a'.repeat(seqLen);
  let s = `LOCUS       testseq  ${seqLen} bp    DNA     circular\nFEATURES             Location/Qualifiers\n`;
  for (const f of features) {
    s += `     ${f.type.padEnd(16)}${f.loc}\n`;
    for (const q of f.quals ?? []) s += `                     ${q}\n`;
  }
  s += 'ORIGIN\n';
  for (let i = 0; i < seq.length; i += 60) {
    const num = String(i + 1).padStart(9);
    const chunk = (seq.slice(i, i + 60).match(/.{1,10}/g) ?? []).join(' ');
    s += `${num} ${chunk}\n`;
  }
  return s + '//';
}

describe('parseGenBank case preservation', () => {
  it('preserves original case of ORIGIN sequence', () => {
    const content = `LOCUS       test                     8 bp    DNA     circular
FEATURES             Location/Qualifiers
ORIGIN
        1 atgcATGC
//`;
    const result = parseGenBank(content);
    expect(result.sequence).toBe('atgcATGC');
  });

  it('preserves lowercase from standard GenBank format', () => {
    const content = `LOCUS       test                    12 bp    DNA     circular
FEATURES             Location/Qualifiers
ORIGIN
        1 atgcgatcga tc
//`;
    const result = parseGenBank(content);
    expect(result.sequence).toBe('atgcgatcgatc');
  });

  it('preserves linear topology for multi-word LOCUS names', () => {
    const content = `LOCUS       S288C chromosome   1531933 bp    DNA     linear     01-JAN-2025
FEATURES             Location/Qualifiers
ORIGIN
        1 atgcgatc
//`;
    const result = parseGenBank(content);
    expect(result.name).toBe('S288C chromosome');
    expect(result.length).toBe(1531933);
    expect(result.circular).toBe(false);
  });
});

describe('mergeSplitCDSFeatures guard ', () => {
  it('does NOT merge distinct same-name CDS that have a gene between them', () => {
    const gb = buildGb(500, [
      { type: 'source', loc: '1..500' },
      { type: 'gene', loc: '80..180', quals: ['/gene="otherGene"', '/label="otherGene"'] },
      { type: 'CDS', loc: '10..50', quals: ['/gene="insX"', '/label="insX"'] },
      { type: 'CDS', loc: '200..240', quals: ['/gene="insX"', '/label="insX"'] },
      { type: 'CDS', loc: '400..440', quals: ['/gene="insX"', '/label="insX"'] },
    ]);
    const { features } = parseGenBank(gb);
    const insX = features.filter((f) => f.type === 'CDS' && f.displayName === 'insX');
    expect(insX).toHaveLength(3);
    for (const f of insX) expect(f.end - f.start).toBeLessThan(100);
    expect(insX.some((f) => f.segments && f.segments.length > 1)).toBe(false);
  });

  it('STILL merges genuine adjacent split-CDS exons (no feature between parts)', () => {
    const gb = buildGb(500, [
      { type: 'source', loc: '1..500' },
      { type: 'CDS', loc: '10..50', quals: ['/gene="insY"', '/label="insY"'] },
      { type: 'CDS', loc: '60..100', quals: ['/gene="insY"', '/label="insY"'] },
      { type: 'CDS', loc: '110..150', quals: ['/gene="insY"', '/label="insY"'] },
    ]);
    const { features } = parseGenBank(gb);
    const insY = features.filter((f) => f.type === 'CDS' && f.displayName === 'insY');
    expect(insY).toHaveLength(1);
    expect(insY[0].segments).toHaveLength(3);
    expect(insY[0].start).toBe(10);
    expect(insY[0].end).toBe(150);
  });
});

describe('mergeSplitCDSFeatures — identity + sparse-input robustness  /review)', () => {
  it('does NOT merge scattered same-name CDS on a SPARSE genome — nothing in the gap (P1)', () => {
    const gb = buildGb(60000, [
      { type: 'source', loc: '1..60000' },
      { type: 'CDS', loc: '500..600', quals: ['/label="hypothetical protein"'] },
      { type: 'CDS', loc: '50000..50100', quals: ['/label="hypothetical protein"'] },
    ]);
    const { features } = parseGenBank(gb);
    const hp = features.filter((f) => f.type === 'CDS' && f.displayName === 'hypothetical protein');
    expect(hp).toHaveLength(2);
    expect(hp.some((f) => f.segments && f.segments.length > 1)).toBe(false);
  });

  it('does NOT merge same-name CDS with DISTINCT locus_tags (identity is ground truth)', () => {
    const gb = buildGb(60000, [
      { type: 'source', loc: '1..60000' },
      { type: 'CDS', loc: '500..600', quals: ['/label="transposase"', '/locus_tag="L1"'] },
      { type: 'CDS', loc: '50000..50100', quals: ['/label="transposase"', '/locus_tag="L2"'] },
    ]);
    const { features } = parseGenBank(gb);
    const tp = features.filter((f) => f.type === 'CDS' && f.displayName === 'transposase');
    expect(tp).toHaveLength(2);
    expect(tp.some((f) => f.segments && f.segments.length > 1)).toBe(false);
  });

  it('DOES merge same-locus_tag exons even with a feature annotated in the gap (P2)', () => {
    const gb = buildGb(500, [
      { type: 'source', loc: '1..500' },
      { type: 'CDS', loc: '100..200', quals: ['/label="geneX"', '/locus_tag="L9"'] },
      { type: 'misc_feature', loc: '220..260', quals: ['/label="anno"'] },
      { type: 'CDS', loc: '300..400', quals: ['/label="geneX"', '/locus_tag="L9"'] },
    ]);
    const { features } = parseGenBank(gb);
    const g = features.filter((f) => f.type === 'CDS' && f.displayName === 'geneX');
    expect(g).toHaveLength(1);
    expect(g[0].segments).toHaveLength(2);
  });
});
