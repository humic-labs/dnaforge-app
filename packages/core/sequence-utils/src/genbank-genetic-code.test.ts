import { describe, expect, it } from 'vitest';
import {
  formatGenBankGeneticCodeLines,
  readGenBankGeneticCode,
  updateGenBankGeneticCodeComment,
} from './genbank-genetic-code';
import { buildCustomGeneticCode, type CustomGeneticCodeDefinition } from './custom-genetic-codes';
import { parseGenBankFull } from './parsers/genbank';
import { serializeGenBank } from './writers/genbank';
import { resolveSequenceGeneticCode } from './genetic-codes';
import type { AnnotatedSequence } from './types';

function minimalRecord(overrides: Partial<AnnotatedSequence> = {}): AnnotatedSequence {
  return {
    id: 'rec',
    name: 'rec',
    sequence: 'ATGTGAAAATAA',
    length: 12,
    annotations: [],
    circular: false,
    ...overrides,
  };
}

describe('the genetic-code COMMENT marker', () => {
  it('formats and reads back a published code as one line', () => {
    const lines = formatGenBankGeneticCodeLines(3);
    expect(lines).toEqual(['COMMENT     DNAForge genetic-code: 3']);
    expect(readGenBankGeneticCode(lines)).toEqual({ kind: 'code', spec: 3 });
  });

  it('ignores unrelated lines', () => {
    expect(readGenBankGeneticCode(['COMMENT     Assembled by hand'])).toEqual({ kind: 'none' });
    expect(readGenBankGeneticCode(['DEFINITION  something', ''])).toEqual({ kind: 'none' });
  });

  it('reports a non-numeric or zero value as unreadable rather than defaulting', () => {
    expect(readGenBankGeneticCode(['COMMENT     DNAForge genetic-code: x']).kind).toBe(
      'unreadable'
    );
    expect(readGenBankGeneticCode(['COMMENT     DNAForge genetic-code: 0']).kind).toBe(
      'unreadable'
    );
  });
});

describe('a chosen genetic code survives the file', () => {
  it('round-trips through serialize and parse', () => {
    const written = serializeGenBank(minimalRecord({ chosenGeneticCode: 3 }));
    expect(written).toContain('DNAForge genetic-code: 3');
    expect(parseGenBankFull(written).chosenGeneticCode).toBe(3);
  });

  it('writes nothing when no code was chosen', () => {
    const written = serializeGenBank(minimalRecord());
    expect(written).not.toContain('DNAForge genetic-code');
    expect(parseGenBankFull(written).chosenGeneticCode).toBeUndefined();
  });

  it('drives the record resolution after a reopen', () => {
    const reopened = parseGenBankFull(serializeGenBank(minimalRecord({ chosenGeneticCode: 4 })));
    expect(resolveSequenceGeneticCode(reopened)).toMatchObject({ code: 4, basis: 'chosen' });
  });

  it('leaves an externally written record untouched when the marker is absent', () => {
    const external = [
      'LOCUS       ext                       12 bp    DNA     linear   UNK 01-JAN-2026',
      'COMMENT     Exported by some other tool',
      'ORIGIN',
      '        1 atgtgaaaataa',
      '//',
      '',
    ].join('\n');
    expect(parseGenBankFull(external).chosenGeneticCode).toBeUndefined();
  });

  it('does not mistake a feature qualifier for the record marker', () => {
    const withFeature = [
      'LOCUS       ext                       12 bp    DNA     linear   UNK 01-JAN-2026',
      'FEATURES             Location/Qualifiers',
      '     CDS             1..12',
      '                     /note="COMMENT     DNAForge genetic-code: 3"',
      'ORIGIN',
      '        1 atgtgaaaataa',
      '//',
      '',
    ].join('\n');
    const parsed = parseGenBankFull(withFeature);
    expect(parsed.chosenGeneticCode).toBeUndefined();
    expect(parsed.annotations).toHaveLength(1);
  });
});

function amberCode(): CustomGeneticCodeDefinition {
  const built = buildCustomGeneticCode({
    id: 'gc-3f2a9c1e',
    revision: 2,
    name: 'Amber suppression (pAzF at TAG)',
    base: 11,
    changes: { TAG: { kind: 'residue', residue: 'pAzF' }, TCG: { kind: 'unassigned' } },
    residues: [{ abbreviation: 'pAzF', name: 'p-azido-L-phenylalanine', ccd: 'AZF' }],
  });
  if (!built.ok) throw new Error(built.issues.map((issue) => issue.message).join('; '));
  return built.definition;
}

describe('a custom genetic code inside the file', () => {
  it('writes the whole definition, readable by a person', () => {
    expect(formatGenBankGeneticCodeLines(amberCode())).toEqual([
      'COMMENT     DNAForge genetic-code: custom gc-3f2a9c1e rev 2',
      'COMMENT     DNAForge genetic-code-name: Amber suppression (pAzF at TAG)',
      'COMMENT     DNAForge genetic-code-codons: TCG=unassigned TAG=pAzF',
      'COMMENT     DNAForge genetic-code-starts: TTG CTG ATT ATC ATA ATG GTG',
      'COMMENT     DNAForge genetic-code-residue: pAzF AZF p-azido-L-phenylalanine',
    ]);
  });

  it('reads back exactly the definition it wrote', () => {
    const definition = amberCode();
    expect(readGenBankGeneticCode(formatGenBankGeneticCodeLines(definition))).toEqual({
      kind: 'code',
      spec: definition,
    });
  });

  it('keeps every line within 80 columns for a typical code', () => {
    for (const line of formatGenBankGeneticCodeLines(amberCode())) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });

  it('wraps a long codon list onto more lines rather than one very long one', () => {
    const built = buildCustomGeneticCode({
      id: 'gc-0f0f0f0f',
      revision: 1,
      name: 'Heavily recoded',
      base: 1,
      changes: Object.fromEntries(
        ['TCG', 'TCA', 'AGC', 'AGT', 'TTG', 'TTA', 'CTC', 'CTT', 'ACG', 'ACA'].map((codon) => [
          codon,
          { kind: 'unassigned' as const },
        ])
      ),
      startCodons: ['ATG'],
      residues: [],
    });
    if (!built.ok) throw new Error(built.issues.map((issue) => issue.message).join('; '));
    const lines = formatGenBankGeneticCodeLines(built.definition);
    expect(lines.filter((line) => line.includes('genetic-code-codons:')).length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
    expect(readGenBankGeneticCode(lines)).toEqual({ kind: 'code', spec: built.definition });
  });

  it('writes a residue with no chemical code with a placeholder, so its name is never misread', () => {
    const built = buildCustomGeneticCode({
      id: 'gc-12345678',
      revision: 1,
      name: 'Methyl tyrosine at TAG',
      base: 11,
      changes: { TAG: { kind: 'residue', residue: 'OMeY' } },
      residues: [{ abbreviation: 'OMeY', name: 'O-methyl-L-tyrosine' }],
    });
    if (!built.ok) throw new Error('fixture must build');
    const lines = formatGenBankGeneticCodeLines(built.definition);
    expect(lines).toContain(
      'COMMENT     DNAForge genetic-code-residue: OMeY - O-methyl-L-tyrosine'
    );
    expect(readGenBankGeneticCode(lines)).toEqual({ kind: 'code', spec: built.definition });
  });

  it('reports a damaged definition as unreadable, naming what is wrong', () => {
    const lines = formatGenBankGeneticCodeLines(amberCode()).filter(
      (line) => !line.includes('genetic-code-residue:')
    );
    const reading = readGenBankGeneticCode(lines);
    expect(reading.kind).toBe('unreadable');
    if (reading.kind !== 'unreadable') return;
    expect(reading.message).toMatch(/pAzF/);
  });

  it('round-trips through serialize and parse', () => {
    const definition = amberCode();
    const written = serializeGenBank(minimalRecord({ chosenGeneticCode: definition }));
    const reopened = parseGenBankFull(written);
    expect(reopened.chosenGeneticCode).toEqual(definition);
    expect(resolveSequenceGeneticCode(reopened)).toMatchObject({ basis: 'chosen' });
  });

  it('marks a record whose custom code cannot be read, instead of quietly using the standard code', () => {
    const written = serializeGenBank(minimalRecord({ chosenGeneticCode: amberCode() })).replace(
      /COMMENT {5}DNAForge genetic-code-residue:.*\n/,
      ''
    );
    const reopened = parseGenBankFull(written);
    expect(reopened.chosenGeneticCode).toBeUndefined();
    expect(reopened.unreadableGeneticCode).toMatch(/pAzF/);
    expect(resolveSequenceGeneticCode(reopened).needsUserChoice).toBe(true);
  });
});

describe('changing the recorded code in place', () => {
  const CURATED = [
    'LOCUS       NC_001224              85779 bp    DNA     circular PLN 03-APR-2023',
    'DEFINITION  Saccharomyces cerevisiae S288C mitochondrion, complete genome.',
    'COMMENT     PROVISIONAL REFSEQ: This record has not yet been subject to final',
    '            NCBI review.',
    'FEATURES             Location/Qualifiers',
    '     CDS             1..12',
    '                     /transl_table=3',
    'ORIGIN',
    '        1 atgtgaaaataa',
    '//',
    '',
  ].join('\n');

  it('replaces a published code with a custom one, and back, leaving the rest byte-identical', () => {
    const published = updateGenBankGeneticCodeComment(CURATED, 3);
    const custom = updateGenBankGeneticCodeComment(published, amberCode());
    expect(custom).not.toContain('DNAForge genetic-code: 3');
    expect(custom).toContain('DNAForge genetic-code-residue: pAzF');
    const cleared = updateGenBankGeneticCodeComment(custom, null);
    expect(cleared).toBe(CURATED);
  });

  it('puts every line of a custom code together in the header', () => {
    const lines = updateGenBankGeneticCodeComment(CURATED, amberCode()).split('\n');
    const first = lines.findIndex((line) => line.includes('DNAForge genetic-code'));
    const markers = lines.filter((line) => line.includes('DNAForge genetic-code'));
    expect(lines.slice(first, first + markers.length)).toEqual(markers);
    expect(first).toBe(1);
  });

  it('is a no-op when the same definition is already recorded', () => {
    const once = updateGenBankGeneticCodeComment(CURATED, amberCode());
    expect(updateGenBankGeneticCodeComment(once, amberCode())).toBe(once);
  });

  it('replaces an older revision rather than adding a second definition', () => {
    const older = { ...amberCode(), revision: 1 };
    const twice = updateGenBankGeneticCodeComment(
      updateGenBankGeneticCodeComment(CURATED, older),
      amberCode()
    );
    expect(twice.match(/DNAForge genetic-code: /g)).toHaveLength(1);
    expect(twice).toContain('rev 2');
  });
});
