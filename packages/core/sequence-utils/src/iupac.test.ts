import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { describe, it, expect } from 'vitest';
import {
  IUPAC_COMPLEMENT,
  IUPAC_EXPANSION,
  IUPAC_REGEX_CLASS,
  IUPAC_DEGENERACY,
  complementBase,
  reverseComplement,
  isDegenerateBase,
  containsDegenerateBases,
  expandDegenerateSequence,
  DNA_ALPHABET,
} from './iupac';

const INVOLUTIVE_ALPHABET = 'ACGTNRYSWKMBDHV';

describe('IUPAC complement table', () => {
  it('covers every code in the accepted alphabet', () => {
    for (const base of INVOLUTIVE_ALPHABET) {
      expect(IUPAC_COMPLEMENT[base], `missing complement for ${base}`).toBeDefined();
      expect(IUPAC_COMPLEMENT[base.toLowerCase()], `missing lowercase ${base}`).toBeDefined();
    }
  });

  it.each([
    ['A', 'T'],
    ['T', 'A'],
    ['G', 'C'],
    ['C', 'G'],
    ['R', 'Y'],
    ['Y', 'R'],
    ['S', 'S'],
    ['W', 'W'],
    ['K', 'M'],
    ['M', 'K'],
    ['B', 'V'],
    ['V', 'B'],
    ['D', 'H'],
    ['H', 'D'],
    ['N', 'N'],
    ['U', 'A'],
  ])('complements %s to %s', (base, expected) => {
    expect(complementBase(base)).toBe(expected);
  });

  it('preserves case', () => {
    expect(complementBase('r')).toBe('y');
    expect(complementBase('R')).toBe('Y');
    expect(complementBase('n')).toBe('n');
    expect(complementBase('b')).toBe('v');
  });

  it('passes gap and pad characters through unchanged', () => {
    expect(complementBase('-')).toBe('-');
    expect(complementBase('.')).toBe('.');
    expect(complementBase('*')).toBe('*');
  });
});

describe('reverseComplement', () => {
  it('is an involution over the full accepted alphabet', () => {
    const seq = INVOLUTIVE_ALPHABET;
    expect(reverseComplement(reverseComplement(seq))).toBe(seq);
  });

  it('is an involution for each base individually', () => {
    for (const base of INVOLUTIVE_ALPHABET) {
      expect(reverseComplement(reverseComplement(base)), `involution failed for ${base}`).toBe(
        base
      );
    }
  });

  it('is an involution with mixed case preserved', () => {
    const seq = 'acgtnryswkmbdhvACGTNRYSWKMBDHV';
    expect(reverseComplement(reverseComplement(seq))).toBe(seq);
  });

  it('does NOT leave degenerate bases unchanged (the  bug)', () => {
    expect(reverseComplement('R')).not.toBe('R');
    expect(reverseComplement('R')).toBe('Y');
    expect(reverseComplement('AAR')).toBe('YTT');
  });

  it('reverse-complements an NNK saturation codon correctly', () => {
    expect(reverseComplement('NNK')).toBe('MNN');
  });

  it('handles a realistic degenerate primer', () => {
    expect(reverseComplement('ATGNNKCGT')).toBe('ACGMNNCAT');
  });

  it('preserves gaps positionally', () => {
    expect(reverseComplement('AC-GT')).toBe('AC-GT');
  });

  it('reverse-complements a 16 MiB search window inside the worker heap budget', () => {
    const source = readFileSync(new URL('./iupac.ts', import.meta.url), 'utf8');
    const compiled = transpileModule(source, {
      compilerOptions: { module: ModuleKind.ES2022, target: ScriptTarget.ES2022 },
    }).outputText;
    const child = spawnSync(process.execPath, ['--max-old-space-size=384', '--input-type=module'], {
      input: `${compiled}\nconst input = 'A'.repeat(16 * 1024 * 1024);\nconst output = reverseComplement(input);\nif (output.length !== input.length || output[0] !== 'T' || output.at(-1) !== 'T') process.exit(1);`,
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });

    expect(child.signal, child.stderr).toBeNull();
    expect(child.status, child.stderr).toBe(0);
  });
});

describe('degeneracy predicates', () => {
  it('identifies degenerate bases', () => {
    for (const base of 'RYSWKMBDHVN') {
      expect(isDegenerateBase(base), `${base} should be degenerate`).toBe(true);
      expect(isDegenerateBase(base.toLowerCase())).toBe(true);
    }
    for (const base of 'ACGTU') {
      expect(isDegenerateBase(base), `${base} should NOT be degenerate`).toBe(false);
    }
  });

  it('detects degeneracy anywhere in a sequence', () => {
    expect(containsDegenerateBases('ATGCATGC')).toBe(false);
    expect(containsDegenerateBases('ATGCNTGC')).toBe(true);
    expect(containsDegenerateBases('atgcrtgc')).toBe(true);
    expect(containsDegenerateBases('ATGC-ATGC')).toBe(false);
  });
});

describe('expansion tables agree with the complement table', () => {
  it('derives every complement from the expansion set', () => {
    for (const base of INVOLUTIVE_ALPHABET) {
      const expanded = IUPAC_EXPANSION[base].split('');
      const complementedSet = expanded
        .map((b) => IUPAC_COMPLEMENT[b])
        .sort()
        .join('');
      const viaTable = IUPAC_EXPANSION[IUPAC_COMPLEMENT[base]].split('').sort().join('');
      expect(complementedSet, `expansion/complement mismatch for ${base}`).toBe(viaTable);
    }
  });

  it('reports degeneracy counts matching the expansion size', () => {
    for (const base of INVOLUTIVE_ALPHABET) {
      expect(IUPAC_DEGENERACY[base]).toBe(IUPAC_EXPANSION[base].length);
    }
  });

  it('produces regex classes matching the expansion set', () => {
    expect(IUPAC_REGEX_CLASS['R']).toBe('[AG]');
    expect(IUPAC_REGEX_CLASS['N']).toBe('[ACGT]');
    expect(IUPAC_REGEX_CLASS['A']).toBe('A');
    for (const base of INVOLUTIVE_ALPHABET) {
      const cls = IUPAC_REGEX_CLASS[base];
      const bases = IUPAC_EXPANSION[base];
      for (const b of bases) {
        expect(new RegExp(`^${cls}$`).test(b), `${cls} should match ${b}`).toBe(true);
      }
    }
  });

  it('exposes the canonical DNA alphabet', () => {
    expect([...DNA_ALPHABET].sort().join('')).toBe('ACGT');
  });
});

describe('expandDegenerateSequence', () => {
  it('returns the sequence itself when unambiguous', () => {
    expect(expandDegenerateSequence('ATGC')).toEqual(['ATGC']);
  });

  it('expands a single degenerate position', () => {
    expect(expandDegenerateSequence('ATR')?.sort()).toEqual(['ATA', 'ATG']);
  });

  it('expands an NNK codon to 32 variants', () => {
    const expanded = expandDegenerateSequence('NNK');
    expect(expanded).toHaveLength(32);
    expect(new Set(expanded).size).toBe(32);
    for (const v of expanded!) expect(/^[ACGT]+$/.test(v)).toBe(true);
  });

  it('returns null when the expansion exceeds the cap', () => {
    expect(expandDegenerateSequence('NNNNNNNNNN', { maxCombinations: 1024 })).toBeNull();
  });

  it('honours a custom cap boundary exactly', () => {
    expect(expandDegenerateSequence('NN', { maxCombinations: 16 })).toHaveLength(16);
    expect(expandDegenerateSequence('NNN', { maxCombinations: 16 })).toBeNull();
  });

  it('normalises U to T when expanding', () => {
    expect(expandDegenerateSequence('AUG')).toEqual(['ATG']);
  });
});
