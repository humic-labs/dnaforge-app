import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  recognitionToRegex,
  reverseComplement,
  isPalindrome,
  findCutSites,
  findAllCutSites,
  countCutSites,
  cutSiteRecognitionSelection,
  filterCutSitesByCutterType,
} from './cut-site-calculator';
import type { CutSite, RestrictionEnzyme } from './types';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..');
const HOMING_FIXTURE_PATH = resolve(
  REPO_ROOT,
  'test-fixtures/sequences/circular/homing-endo-targets-synthetic.gb'
);

function loadSequenceFromGenBank(text: string): string {
  const originIdx = text.indexOf('ORIGIN');
  if (originIdx < 0) throw new Error('no ORIGIN block in fixture');
  const lines = text.slice(originIdx).split('\n').slice(1);
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith('//')) break;
    out.push(line.replace(/[^acgtACGT]/g, ''));
  }
  return out.join('').toUpperCase();
}

function enzyme(
  partial: Partial<RestrictionEnzyme> & { name: string; recognition_sequence: string }
): RestrictionEnzyme {
  const base: RestrictionEnzyme = {
    name: partial.name,
    recognition_sequence: partial.recognition_sequence,
    recognition_sequence_length:
      partial.recognition_sequence_length ?? partial.recognition_sequence.length,
    cut_position_top: 0,
    cut_position_bottom: partial.recognition_sequence.length,
    overhang_type: null,
    overhang_length: null,
    enzyme_type: partial.enzyme_type ?? 'Type_II',
    prototype: null,
    source_organism: null,
    methylation_site: null,
    methylation_sensitivity: null,
    optimal_temperature: null,
    heat_inactivation: null,
    suppliers: [],
    rebase_id: null,
    isoschizomers: [],
    neoschizomers: [],
  };
  return { ...base, ...partial };
}

const EcoRI = enzyme({
  name: 'EcoRI',
  recognition_sequence: 'GAATTC',
  cut_position_top: 1,
  cut_position_bottom: 5,
  overhang_type: '5_prime',
  overhang_length: 4,
});

const BsaI = enzyme({
  name: 'BsaI',
  recognition_sequence: 'GGTCTC',
  cut_position_top: 7,
  cut_position_bottom: 11,
  overhang_type: '5_prime',
  overhang_length: 4,
  enzyme_type: 'Type_IIS',
});

const ISceI = enzyme({
  name: 'I-SceI',
  recognition_sequence: 'TAGGGATAACAGGGTAAT',
  cut_position_top: 13,
  cut_position_bottom: 9,
  overhang_type: '3_prime',
  overhang_length: 4,
  enzyme_type: 'homing',
});

describe('reverseComplement', () => {
  it('round-trips ACGT', () => {
    expect(reverseComplement(reverseComplement('GAATTC'))).toBe('GAATTC');
  });
  it('handles IUPAC codes', () => {
    expect(reverseComplement('GGNCC')).toBe('GGNCC');
    expect(reverseComplement('RGCY')).toBe('RGCY');
  });
});

describe('isPalindrome', () => {
  it('detects palindromes', () => {
    expect(isPalindrome('GAATTC')).toBe(true);
    expect(isPalindrome('GGATCC')).toBe(true);
  });
  it('detects non-palindromes', () => {
    expect(isPalindrome('GGTCTC')).toBe(false);
    expect(isPalindrome('TAGGGATAACAGGGTAAT')).toBe(false);
  });
});

describe('recognitionToRegex', () => {
  it('compiles plain ACGT to literal', () => {
    expect('AAGAATTCAA'.match(recognitionToRegex('GAATTC'))?.[0]).toBe('GAATTC');
  });
  it('expands N to any base', () => {
    expect('GGGCC'.match(recognitionToRegex('GGNCC'))?.[0]).toBe('GGGCC');
    expect('GGTCC'.match(recognitionToRegex('GGNCC'))?.[0]).toBe('GGTCC');
  });
  it('expands two-letter IUPAC codes', () => {
    expect('GACGT'.match(recognitionToRegex('GRCGT'))?.[0]).toBe('GACGT');
    expect('GGCGT'.match(recognitionToRegex('GRCGT'))?.[0]).toBe('GGCGT');
    expect('GTCGT'.match(recognitionToRegex('GRCGT'))).toBeNull();
  });
});

describe('findCutSites', () => {
  it('stops collecting once maxHits is reached', () => {
    const hits = findCutSites('GAATTC'.repeat(1000), EcoRI, { maxHits: 3 });
    expect(hits).toHaveLength(3);
  });

  it('finds palindromic Type II sites once per occurrence', () => {
    const seq = 'AAAGAATTCAAA' + 'GAATTC' + 'TTTT';
    const hits = findCutSites(seq, EcoRI);
    expect(hits.map((h) => h.recognitionStart)).toEqual([3, 12]);
    expect(hits.every((h) => h.strand === 'forward')).toBe(true);
  });

  it('cut positions are at recognition_start + cut_position_*', () => {
    const seq = 'AAA' + 'GAATTC' + 'TTT';
    const [hit] = findCutSites(seq, EcoRI);
    expect(hit.recognitionStart).toBe(3);
    expect(hit.cutPositionTop).toBe(3 + 1);
    expect(hit.cutPositionBottom).toBe(3 + 5);
  });

  it('finds non-palindromic Type IIS sites on both orientations', () => {
    const fwd = 'AAA' + 'GGTCTC' + 'NNNNNN' + 'AAA';
    const fwdHits = findCutSites(fwd, BsaI);
    expect(fwdHits).toHaveLength(1);
    expect(fwdHits[0].strand).toBe('forward');

    const rev = 'AAA' + 'NNNNNN' + 'GAGACC' + 'AAA';
    const revHits = findCutSites(rev, BsaI);
    expect(revHits).toHaveLength(1);
    expect(revHits[0].strand).toBe('reverse');
    expect(revHits[0].cutPositionTop).toBeLessThan(revHits[0].recognitionStart);
  });

  it('returns no hits when cut_position is null', () => {
    const broken = enzyme({
      name: 'broken',
      recognition_sequence: 'GAATTC',
      cut_position_top: null as unknown as number,
      cut_position_bottom: null as unknown as number,
    });
    expect(findCutSites('GAATTCGAATTC', broken)).toEqual([]);
  });
});

describe('cutSiteRecognitionSelection', () => {
  it('preserves an origin-spanning recognition range', () => {
    expect(cutSiteRecognitionSelection({ recognitionStart: 12, recognitionEnd: 2 }, 16)).toEqual({
      start: 12,
      end: 1,
      wraps: true,
    });
  });

  it('does not emit a negative end when a site ends exactly at the origin', () => {
    expect(cutSiteRecognitionSelection({ recognitionStart: 12, recognitionEnd: 0 }, 16)).toEqual({
      start: 12,
      end: 15,
    });
  });
});

describe('homing endonuclease scan  acceptance)', () => {
  const NATURAL_FRAGMENT = (
    'TCGCGCGTTTCGGTGATGACGGTGAAAACCTCTGACACATGCAGCTCCCGGAGACGGTCACAGCTTGTCTGTAAGCGGAT' +
    'GCCGGGAGCAGACAAGCCCGTCAGGGCGCGTCAGCGGGTGTTGGCGGGTGTCGGGGCTGGCTTAACTATGCGGCATCAGAGC' +
    'AGATTGTACTGAGAGTGCACCATATGCGGTGTGAAATACCGCACAGATGCGTAAGGAGAAAATACCGCATCAGGCGCCATTC' +
    'GCCATTCAGGCTGCGCAACTGTTGGGAAGGGCGATCGGTGCGGGCCTCTTCGCTATTACGCCAGCTGGCGAAAGGGGGATGT'
  ).repeat(4);

  it('finds 0 hits on a sequence without the canonical site', () => {
    expect(findCutSites(NATURAL_FRAGMENT, ISceI)).toHaveLength(0);
  });

  it('finds exactly 1 hit when the canonical I-SceI site is engineered into the sequence', () => {
    const targeted =
      NATURAL_FRAGMENT.slice(0, 500) + 'TAGGGATAACAGGGTAAT' + NATURAL_FRAGMENT.slice(500);
    const hits = findCutSites(targeted, ISceI);
    expect(hits).toHaveLength(1);
    expect(hits[0].recognitionStart).toBe(500);
    expect(hits[0].cutPositionTop).toBe(500 + 13);
    expect(hits[0].cutPositionBottom).toBe(500 + 9);
  });

  it('finds the reverse-complement of an asymmetric homing endo site', () => {
    const rcSite = reverseComplement('TAGGGATAACAGGGTAAT');
    const targeted = NATURAL_FRAGMENT.slice(0, 800) + rcSite + NATURAL_FRAGMENT.slice(800);
    const hits = findCutSites(targeted, ISceI);
    expect(hits).toHaveLength(1);
    expect(hits[0].strand).toBe('reverse');
    expect(hits[0].recognitionStart).toBe(800);
  });
});

describe('homing-endo target fixture ', () => {
  const homingEnzymes = {
    'I-CeuI': enzyme({
      name: 'I-CeuI',
      recognition_sequence: 'TAACTATAACGGTCCTAAGGTAGCGAA',
      cut_position_top: 18,
      cut_position_bottom: 14,
      overhang_type: '3_prime',
      overhang_length: 4,
      enzyme_type: 'homing',
    }),
    'I-SceI': ISceI,
    'PI-PspI': enzyme({
      name: 'PI-PspI',
      recognition_sequence: 'TGGCAAACAGCTATTATGGGTATTATGGGT',
      cut_position_top: 17,
      cut_position_bottom: 13,
      overhang_type: '3_prime',
      overhang_length: 4,
      enzyme_type: 'homing',
    }),
    'PI-SceI': enzyme({
      name: 'PI-SceI',
      recognition_sequence: 'ATCTATGTCGGGTGCGGAGAAAGAGGTAATGAAATGG',
      cut_position_top: 17,
      cut_position_bottom: 13,
      overhang_type: '3_prime',
      overhang_length: 4,
      enzyme_type: 'homing',
    }),
  };

  const EXPECTED_STARTS: Record<string, number> = {
    'I-CeuI': 200,
    'I-SceI': 800,
    'PI-PspI': 1500,
    'PI-SceI': 2200,
  };

  const fixtureText = readFileSync(HOMING_FIXTURE_PATH, 'utf-8');
  const fixtureSeq = loadSequenceFromGenBank(fixtureText);

  it('fixture is the expected length (pUC19 + sum of 4 sites)', () => {
    expect(fixtureSeq.length).toBe(2686 + 27 + 18 + 30 + 37);
  });

  for (const [name, expectedStart] of Object.entries(EXPECTED_STARTS)) {
    it(`${name} finds exactly 1 hit at recognitionStart=${expectedStart}`, () => {
      const enzymeRec = homingEnzymes[name as keyof typeof homingEnzymes];
      const hits = findCutSites(fixtureSeq, enzymeRec);
      expect(hits).toHaveLength(1);
      expect(hits[0].recognitionStart).toBe(expectedStart);
      expect(hits[0].strand).toBe('forward');
    });
  }

  it('all 4 homing endos together find exactly 4 hits', () => {
    const hits = findAllCutSites(fixtureSeq, Object.values(homingEnzymes));
    expect(hits).toHaveLength(4);
    const byName = new Map<string, number>();
    for (const h of hits) byName.set(h.enzyme.name, h.recognitionStart);
    expect(Object.fromEntries(byName)).toEqual(EXPECTED_STARTS);
  });
});

describe('findAllCutSites + countCutSites', () => {
  const seq = 'AAA' + 'GAATTC' + 'AAA' + 'GGTCTC' + 'NNNNNN' + 'AAA';

  it('aggregates hits across enzymes', () => {
    const hits = findAllCutSites(seq, [EcoRI, BsaI]);
    expect(hits).toHaveLength(2);
    expect(new Set(hits.map((h) => h.enzyme.name))).toEqual(new Set(['EcoRI', 'BsaI']));
  });

  it('countCutSites matches findCutSites length', () => {
    expect(countCutSites(seq, EcoRI)).toBe(findCutSites(seq, EcoRI).length);
    expect(countCutSites(seq, BsaI)).toBe(findCutSites(seq, BsaI).length);
  });
});

describe('filterCutSitesByCutterType', () => {
  const mk = (name: string, pos: number): CutSite =>
    ({ enzyme: { name }, cutPositionTop: pos }) as unknown as CutSite;
  const sites: CutSite[] = [
    mk('A', 10),
    mk('B', 20),
    mk('B', 30),
    mk('C', 40),
    mk('C', 50),
    mk('C', 60),
    mk('D', 70),
  ];
  const noneActive = new Set<string>();

  it('single keeps only 1-cutters', () => {
    const out = filterCutSitesByCutterType(sites, 'single', noneActive);
    expect(new Set(out.map((s) => s.enzyme.name))).toEqual(new Set(['A', 'D']));
  });

  it('double keeps only 2-cutters', () => {
    const out = filterCutSitesByCutterType(sites, 'double', noneActive);
    expect(new Set(out.map((s) => s.enzyme.name))).toEqual(new Set(['B']));
    expect(out).toHaveLength(2);
  });

  it('single-double keeps 1- and 2-cutters and drops 3+', () => {
    const out = filterCutSitesByCutterType(sites, 'single-double', noneActive);
    expect(new Set(out.map((s) => s.enzyme.name))).toEqual(new Set(['A', 'B', 'D']));
    expect(out).toHaveLength(4);
    expect(out.map((s) => s.enzyme.name)).not.toContain('C');
  });

  it('both returns every site unfiltered', () => {
    expect(filterCutSitesByCutterType(sites, 'both', noneActive)).toHaveLength(sites.length);
  });

  it('none keeps only active enzymes regardless of cut count', () => {
    const out = filterCutSitesByCutterType(sites, 'none', new Set(['C']));
    expect(new Set(out.map((s) => s.enzyme.name))).toEqual(new Set(['C']));
    expect(out).toHaveLength(3);
  });
});

const BSA_I = enzyme({
  name: 'BsaI',
  recognition_sequence: 'GGTCTC',
  recognition_sequence_length: 6,
  cut_position_top: 7,
  cut_position_bottom: 11,
  overhang_type: '5_prime',
  overhang_length: 4,
  enzyme_type: 'Type_IIS',
  prototype: null,
  source_organism: null,
  methylation_site: null,
  methylation_sensitivity: null,
});

describe('findCutSites — circular origin-straddling sites  C2)', () => {
  const filler = 'AAAACCCCTTTTAAAACCCCTTTTAAAACCCCTTTT';
  const straddling = 'TC' + filler + 'GGTC';

  it('finds a site that straddles the origin when the sequence is circular', () => {
    const linear = findCutSites(straddling, BSA_I);
    expect(linear).toHaveLength(0);

    const circular = findCutSites(straddling, BSA_I, { circular: true });
    expect(circular).toHaveLength(1);
    expect(circular[0].strand).toBe('forward');
    expect(circular[0].recognitionStart).toBe(straddling.length - 4);
  });

  it('does not change linear scanning', () => {
    const inner = filler + 'GGTCTC' + filler;
    expect(findCutSites(inner, BSA_I)).toHaveLength(1);
    expect(findCutSites(inner, BSA_I, { circular: true })).toHaveLength(1);
  });

  it('does not double-count a site that merely sits near the origin', () => {
    const nearStart = 'GGTCTC' + filler;
    expect(findCutSites(nearStart, BSA_I, { circular: true })).toHaveLength(1);
    const nearEnd = filler + 'GGTCTC';
    expect(findCutSites(nearEnd, BSA_I, { circular: true })).toHaveLength(1);
  });

  it('normalizes wrapped coordinates into [0, length)', () => {
    const sites = findCutSites(straddling, BSA_I, { circular: true });
    for (const site of sites) {
      expect(site.recognitionStart).toBeGreaterThanOrEqual(0);
      expect(site.recognitionStart).toBeLessThan(straddling.length);
      expect(site.cutPositionTop).toBeGreaterThanOrEqual(0);
      expect(site.cutPositionTop).toBeLessThan(straddling.length);
      expect(site.cutPositionBottom).toBeGreaterThanOrEqual(0);
      expect(site.cutPositionBottom).toBeLessThan(straddling.length);
    }
  });

  it('finds a reverse-strand site across the origin too', () => {
    const revStraddling = 'CC' + filler + 'GAGA';
    expect(findCutSites(revStraddling, BSA_I)).toHaveLength(0);
    const circular = findCutSites(revStraddling, BSA_I, { circular: true });
    expect(circular).toHaveLength(1);
    expect(circular[0].strand).toBe('reverse');
  });
});
