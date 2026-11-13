import { AA_COLOR_SCHEMES } from './colors';
import { describe, expect, it } from 'vitest';

import {
  buildCustomGeneticCode,
  codonDisplay,
  codonLabelThatFits,
  nonStandardResidueColor,
  UNNAMED_RESIDUE_COLOR,
  codonMeaning,
  nonStandardResidueLegend,
  validateCustomGeneticCode,
  type BuildCustomGeneticCodeInput,
  type CustomGeneticCodeDefinition,
} from './custom-genetic-codes';
import {
  geneticCodeLabel,
  geneticCodesAssignIdenticalAminoAcids,
  resolveGeneticCode,
} from './genetic-codes';
import { isStartCodon, isStopCodon, translateCodon, translateSequence } from './translation';

const PAZF = { abbreviation: 'pAzF', name: 'p-azido-L-phenylalanine', ccd: 'AZF' } as const;

function amberSuppression(overrides: Partial<BuildCustomGeneticCodeInput> = {}) {
  return buildCustomGeneticCode({
    id: 'gc-3f2a9c1e',
    revision: 1,
    name: 'Amber suppression (pAzF at TAG)',
    base: 11,
    changes: { TAG: { kind: 'residue', residue: 'pAzF' } },
    residues: [PAZF],
    ...overrides,
  });
}

function mustBuild(result: ReturnType<typeof buildCustomGeneticCode>): CustomGeneticCodeDefinition {
  if (!result.ok) throw new Error(result.issues.map((issue) => issue.message).join('; '));
  return result.definition;
}

describe('building a custom code from a starting code plus changes', () => {
  it('records only what differs from the standard code', () => {
    const definition = mustBuild(amberSuppression());
    expect(definition.codons).toEqual({ TAG: { kind: 'residue', residue: 'pAzF' } });
  });

  it("carries a starting code's own reassignments into the stored differences", () => {
    const definition = mustBuild(amberSuppression({ base: 4 }));
    expect(definition.codons.TGA).toEqual({ kind: 'amino-acid', letter: 'W' });
    expect(definition.codons.TAG).toEqual({ kind: 'residue', residue: 'pAzF' });
  });

  it("inherits the starting code's start codons unless told otherwise", () => {
    const definition = mustBuild(amberSuppression());
    expect(definition.startCodons).toContain('GTG');
    expect(definition.startCodons).toContain('ATG');
    const narrowed = mustBuild(amberSuppression({ startCodons: ['ATG'] }));
    expect(narrowed.startCodons).toEqual(['ATG']);
  });

  it('drops a change that restores the standard meaning, so equal codes store equally', () => {
    const definition = mustBuild(
      amberSuppression({
        changes: {
          TAG: { kind: 'residue', residue: 'pAzF' },
          TTT: { kind: 'amino-acid', letter: 'F' },
        },
      })
    );
    expect(Object.keys(definition.codons)).toEqual(['TAG']);
  });

  it('can start from another custom code', () => {
    const first = mustBuild(amberSuppression());
    const second = mustBuild(
      buildCustomGeneticCode({
        id: 'gc-0b1c2d3e',
        revision: 1,
        name: 'Amber pAzF, TCG freed',
        base: first,
        changes: { TCG: { kind: 'unassigned' } },
        residues: [PAZF],
      })
    );
    expect(second.codons).toEqual({
      TAG: { kind: 'residue', residue: 'pAzF' },
      TCG: { kind: 'unassigned' },
    });
  });
});

describe('what a custom code refuses', () => {
  const messages = (input: Partial<BuildCustomGeneticCodeInput>) => {
    const result = amberSuppression(input);
    return result.ok ? [] : result.issues.map((issue) => issue.message);
  };

  it('refuses a code identical to a published table, and names the table', () => {
    const result = buildCustomGeneticCode({
      id: 'gc-11111111',
      revision: 1,
      name: 'Just bacterial',
      base: 11,
      changes: {},
      residues: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0].message).toMatch(/identical to published genetic code 11/i);
  });

  it('refuses a codon pointing at a residue that is not defined', () => {
    expect(messages({ residues: [] })).toContainEqual(expect.stringMatching(/pAzF.*not defined/i));
  });

  it('refuses a defined residue that no codon uses', () => {
    expect(
      messages({ residues: [PAZF, { abbreviation: 'pAcF', name: 'p-acetyl-L-phenylalanine' }] })
    ).toContainEqual(expect.stringMatching(/pAcF.*not used/i));
  });

  it('refuses an abbreviation that could be read as a standard one-letter code', () => {
    expect(
      messages({
        changes: { TAG: { kind: 'residue', residue: 'K' } },
        residues: [{ abbreviation: 'K', name: 'Not lysine' }],
      })
    ).toContainEqual(expect.stringMatching(/abbreviation/i));
  });

  it('refuses two residues with the same abbreviation, ignoring case', () => {
    expect(
      messages({
        changes: {
          TAG: { kind: 'residue', residue: 'pAzF' },
          TGA: { kind: 'residue', residue: 'PAZF' },
        },
        residues: [PAZF, { abbreviation: 'PAZF', name: 'Duplicate' }],
      })
    ).toContainEqual(expect.stringMatching(/more than once/i));
  });

  it('refuses a name longer than a GenBank line can carry', () => {
    expect(messages({ name: 'x'.repeat(41) })).toContainEqual(expect.stringMatching(/40/));
  });

  it('refuses a code with no start codon', () => {
    expect(messages({ startCodons: [] })).toContainEqual(expect.stringMatching(/start codon/i));
  });

  it('refuses a start codon that cannot be read', () => {
    expect(
      messages({
        changes: { TAG: { kind: 'residue', residue: 'pAzF' }, TCG: { kind: 'unassigned' } },
        startCodons: ['ATG', 'TCG'],
      })
    ).toContainEqual(expect.stringMatching(/TCG.*start/i));
    expect(messages({ startCodons: ['ATG', 'TAA'] })).toContainEqual(
      expect.stringMatching(/TAA.*start/i)
    );
  });

  it('refuses something that is not a codon', () => {
    expect(
      messages({
        changes: { TAG: { kind: 'residue', residue: 'pAzF' }, TNG: { kind: 'stop' } },
      })
    ).toContainEqual(expect.stringMatching(/TNG/));
  });

  it('refuses a letter that is not a standard amino acid', () => {
    expect(
      messages({
        changes: {
          TAG: { kind: 'residue', residue: 'pAzF' },
          TGA: { kind: 'amino-acid', letter: 'B' as 'A' },
        },
      })
    ).toContainEqual(expect.stringMatching(/"B"/));
  });

  it('validates a stored definition the same way it validates a new one', () => {
    const definition = mustBuild(amberSuppression());
    expect(validateCustomGeneticCode(definition)).toEqual([]);
    expect(
      validateCustomGeneticCode({
        ...definition,
        codons: { ...definition.codons, TTT: { kind: 'amino-acid', letter: 'F' } },
      })
    ).toContainEqual(expect.objectContaining({ message: expect.stringMatching(/TTT.*already/i) }));
  });
});

describe('translating on a custom code', () => {
  const definition = mustBuild(amberSuppression());

  it('reads TAG as the non-standard residue, not stop', () => {
    expect(codonMeaning('TAG', definition)).toEqual({ kind: 'residue', residue: 'pAzF' });
    expect(isStopCodon('TAG', definition)).toBe(false);
  });

  it('writes a non-standard residue as X in protein text', () => {
    expect(translateCodon('TAG', definition)).toBe('X');
    expect(
      translateSequence('ATGTAGTAA', 1, 0, definition)
        .map((residue) => residue.aminoAcid)
        .join('')
    ).toBe('MX*');
  });

  it('keeps every other codon on the starting code', () => {
    expect(translateCodon('TGA', definition)).toBe('*');
    expect(isStartCodon('GTG', definition)).toBe(true);
  });

  it('treats an unassigned codon as neither a residue nor a stop', () => {
    const freed = mustBuild(
      amberSuppression({
        changes: { TAG: { kind: 'residue', residue: 'pAzF' }, TCG: { kind: 'unassigned' } },
      })
    );
    const code = resolveGeneticCode(freed);
    expect(translateCodon('TCG', freed)).toBe('X');
    expect(isStopCodon('TCG', freed)).toBe(false);
    expect(code.unassignedCodons.has('TCG')).toBe(true);
    expect(codonMeaning('TCG', freed)).toEqual({ kind: 'unassigned' });
  });

  it('gives published tables the same meanings view', () => {
    expect(codonMeaning('TGA', 4)).toEqual({ kind: 'amino-acid', letter: 'W' });
    expect(codonMeaning('TGA', 1)).toEqual({ kind: 'stop' });
    expect(resolveGeneticCode(1).unassignedCodons.size).toBe(0);
  });

  it('builds the runtime table once per distinct definition', () => {
    const again = mustBuild(amberSuppression());
    expect(resolveGeneticCode(again)).toBe(resolveGeneticCode(definition));
  });

  it('labels a custom code by its name', () => {
    expect(geneticCodeLabel(definition)).toBe('Amber suppression (pAzF at TAG)');
    expect(geneticCodeLabel(3)).toBe('3 — Yeast Mitochondrial');
  });
});

describe('comparing codes by what codons mean, never by letter', () => {
  const pazf = mustBuild(amberSuppression());

  it('calls two codes with different residues at TAG different, though both read X', () => {
    const pacf = mustBuild(
      amberSuppression({
        id: 'gc-aaaaaaaa',
        name: 'Amber suppression (pAcF at TAG)',
        changes: { TAG: { kind: 'residue', residue: 'pAcF' } },
        residues: [{ abbreviation: 'pAcF', name: 'p-acetyl-L-phenylalanine', ccd: 'PFF' }],
      })
    );
    expect(translateCodon('TAG', pazf)).toBe(translateCodon('TAG', pacf));
    expect(geneticCodesAssignIdenticalAminoAcids(pazf, pacf)).toBe(false);
  });

  it('calls the same assignments under a different name the same', () => {
    const renamed = mustBuild(amberSuppression({ id: 'gc-bbbbbbbb', name: 'Our amber strain' }));
    expect(geneticCodesAssignIdenticalAminoAcids(pazf, renamed)).toBe(true);
  });

  it('calls a custom code different from the table it started from', () => {
    expect(geneticCodesAssignIdenticalAminoAcids(pazf, 11)).toBe(false);
  });

  it('keeps codes 1 and 11 identical', () => {
    expect(geneticCodesAssignIdenticalAminoAcids(1, 11)).toBe(true);
  });
});

describe('what a codon shows on screen', () => {
  const amber = mustBuild(
    amberSuppression({
      changes: { TAG: { kind: 'residue', residue: 'pAzF' }, TCG: { kind: 'unassigned' } },
    })
  );

  it('shows a standard amino acid as its letter', () => {
    expect(codonDisplay('ATG', amber)).toEqual({ short: 'M', full: 'M', kind: 'amino-acid' });
  });

  it('shows a stop as the asterisk every sequence viewer already draws', () => {
    expect(codonDisplay('TGA', amber)).toMatchObject({ short: '*', full: '*', kind: 'stop' });
  });

  it('shows a non-standard residue by name where there is room, and X where there is not', () => {
    expect(codonDisplay('TAG', amber)).toEqual({ short: 'X', full: 'pAzF', kind: 'residue' });
  });

  it('marks a codon nothing decodes as a question, never as a residue', () => {
    expect(codonDisplay('TCG', amber)).toEqual({ short: 'X', full: '?', kind: 'unassigned' });
  });

  it('keeps a residue name a notch under the letter size, even in a wide cell', () => {
    const display = codonDisplay('TAG', amber);
    const fit = codonLabelThatFits(display, 400, 12);
    expect(fit.text).toBe('pAzF');
    expect(fit.scale).toBeCloseTo(0.9, 5);
  });

  it('shrinks a name to fit a narrow codon cell rather than hiding it', () => {
    const display = codonDisplay('TAG', amber);
    const fit = codonLabelThatFits(display, 30, 15, (text) => text.length * 9);
    expect(fit.text).toBe('pAzF');
    expect(fit.scale).toBeGreaterThanOrEqual(0.63);
    expect(fit.scale).toBeLessThanOrEqual(0.9);
    expect(fit.scale * 4 * 9).toBeLessThanOrEqual(30 * 0.9 + 1e-9);
  });

  it('keeps showing the name in every cell that showed one before the margin', () => {
    const display = codonDisplay('TAG', amber);
    const needed = 36;
    const fit = codonLabelThatFits(display, needed * 0.7, 15, () => needed);
    expect(fit.text).toBe('pAzF');
  });

  it('gives up on the name once it would be too small to read', () => {
    const display = codonDisplay('TAG', amber);
    expect(codonLabelThatFits(display, 12, 12)).toEqual({ text: 'X', scale: 1 });
  });

  it('never shrinks a one-character label, however narrow the cell', () => {
    expect(codonLabelThatFits(codonDisplay('ATG', amber), 1, 12)).toEqual({ text: 'M', scale: 1 });
  });

  it('falls back to X when a residue is somehow missing from the code', () => {
    const broken = { ...amber, residues: [] };
    expect(codonDisplay('TAG', broken)).toMatchObject({ short: 'X', full: 'X' });
  });
});

describe('the colour a non-standard residue is drawn in', () => {
  it('is stable for a residue, so it does not change between sessions or surfaces', () => {
    expect(nonStandardResidueColor('pAzF')).toBe(nonStandardResidueColor('pAzF'));
  });

  it('separates residues that share a codon, which is the case that misleads', () => {
    expect(nonStandardResidueColor('pAzF')).not.toBe(nonStandardResidueColor('BocK'));
  });

  it('never lands in the stop-codon red band, so a residue never reads as a stop', () => {
    const hues = ['pAzF', 'BocK', 'pBpa', 'AzK', 'CypK', 'DOPA', 'Sec', 'Pyl', 'X1', 'Nle'].map(
      (abbrev) => {
        const hex = nonStandardResidueColor(abbrev);
        const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255);
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const d = max - min;
        if (d === 0) return 0;
        const h =
          max === r
            ? ((g - b) / d + (g < b ? 6 : 0)) / 6
            : max === g
              ? ((b - r) / d + 2) / 6
              : ((r - g) / d + 4) / 6;
        return Math.round(h * 360);
      }
    );
    for (const hue of hues) expect(hue >= 20 && hue <= 340).toBe(true);
  });

  it('never invents a colour for a codon the file flagged but did not name', () => {
    for (const placeholder of ['X', '?', '', '*']) {
      expect(nonStandardResidueColor(placeholder)).toBe(UNNAMED_RESIDUE_COLOR);
    }
  });

  it('keeps the unnamed colour clear of the stop grey and the standard palette', () => {
    const paletteAndStop = [...Object.values(AA_COLOR_SCHEMES.rasmol.colors), '#9CA3AF'];
    expect(paletteAndStop.map((c) => c.toUpperCase())).not.toContain(UNNAMED_RESIDUE_COLOR);
  });

  it('is a plain hex colour the renderers can adapt for dark mode', () => {
    expect(nonStandardResidueColor('pAzF')).toMatch(/^#[0-9A-F]{6}$/);
  });
});

describe('saying what X stands for', () => {
  it('names each non-standard residue and the codons that encode it', () => {
    const code = mustBuild(
      amberSuppression({
        changes: {
          TAG: { kind: 'residue', residue: 'pAzF' },
          TAA: { kind: 'residue', residue: 'pAzF' },
        },
      })
    );
    expect(nonStandardResidueLegend(code)).toBe('X marks pAzF (TAA, TAG).');
  });

  it('says nothing for a code that encodes only standard residues', () => {
    expect(nonStandardResidueLegend(3)).toBeUndefined();
  });
});
