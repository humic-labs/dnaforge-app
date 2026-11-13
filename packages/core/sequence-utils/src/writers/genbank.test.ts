import { describe, it, expect } from 'vitest';
import { formatOrigin, formatFeature, formatFeatures, serializeGenBank } from './genbank';
import { parseGenBankFull } from '../parsers/genbank';
import type { Annotation, AnnotatedSequence } from '../types';

describe('formatOrigin', () => {
  it('formats sequence into 60bp lines with 10bp groups', () => {
    const seq = 'atcgatcgatcgatcgatcgatcgatcgatcgatcgatcgatcgatcgatcgatcgatcgatcgatcgatcg';
    const result = formatOrigin(seq);
    expect(result).toContain(
      '        1 atcgatcgat cgatcgatcg atcgatcgat cgatcgatcg atcgatcgat cgatcgatcg'
    );
    expect(result).toContain('       61 atcgatcgat');
    expect(result.startsWith('ORIGIN')).toBe(true);
    expect(result.endsWith('//\n')).toBe(true);
  });

  it('handles short sequences (<60bp)', () => {
    const result = formatOrigin('atcg');
    expect(result).toContain('        1 atcg');
  });

  it('handles empty sequence', () => {
    const result = formatOrigin('');
    expect(result).toBe('ORIGIN\n//\n');
  });

  it('preserves the input case', () => {
    const result = formatOrigin('ATCG');
    expect(result).toContain('        1 ATCG');
  });

  it('handles exact 60bp boundary', () => {
    const seq = 'a'.repeat(60);
    const result = formatOrigin(seq);
    const lines = result.split('\n');
    expect(lines).toHaveLength(4);
  });
});

describe('formatFeature', () => {
  it.each([
    { type: 'misc_feature', direction: 1 as const },
    { type: 'misc_feature', direction: -1 as const },
    { type: 'CDS', direction: 0 as const },
  ])(
    'round-trips an explicit $type direction of $direction without changing another feature',
    ({ type, direction }) => {
      const sequence: AnnotatedSequence = {
        id: 'direction-roundtrip',
        name: 'Direction roundtrip',
        sequence: 'TTAACCaaccggttacgt',
        length: 18,
        circular: false,
        annotations: [
          { name: 'Agent parity', type, start: 1, end: 6, direction },
          {
            name: 'Keep marker',
            type: 'misc_feature',
            start: 9,
            end: 11,
            direction: 0,
            qualifiers: { note: ['Preserve this native qualifier'] },
          },
        ],
      };
      const reopened = parseGenBankFull(serializeGenBank(sequence));
      expect(
        reopened.annotations.find((annotation) => annotation.name === 'Agent parity')
      ).toMatchObject({
        start: 1,
        end: 6,
        direction,
      });
      expect(
        reopened.annotations.find((annotation) => annotation.name === 'Keep marker')
      ).toMatchObject({
        start: 9,
        end: 11,
        direction: 0,
        qualifiers: { note: ['Preserve this native qualifier'] },
      });
    }
  );

  it('updates a stale explicit direction while preserving unrelated qualifiers', () => {
    const sequence: AnnotatedSequence = {
      id: 'direction-edit',
      name: 'Direction edit',
      sequence: 'aaccgg',
      length: 6,
      circular: false,
      annotations: [
        {
          name: 'Edited feature',
          type: 'misc_feature',
          start: 1,
          end: 6,
          direction: 1,
          qualifiers: { direction: ['LEFT'], note: ['Keep this note'], db_xref: ['source:123'] },
        },
      ],
    };
    const reopened = parseGenBankFull(serializeGenBank(sequence));
    expect(reopened.annotations[0]).toMatchObject({
      direction: 1,
      qualifiers: { direction: ['RIGHT'], note: ['Keep this note'], db_xref: ['source:123'] },
    });
  });

  it('retains an unchanged explicit direction qualifier verbatim', () => {
    const text = formatFeature({
      name: 'Existing feature',
      type: 'misc_feature',
      start: 1,
      end: 6,
      direction: 1,
      qualifiers: { direction: ['right'], note: ['Keep this note'] },
    });
    expect(text).toContain('/direction="right"');
    expect(text).toContain('/note="Keep this note"');
  });

  it('formats a simple forward annotation', () => {
    const ann: Annotation = {
      name: 'AmpR',
      type: 'CDS',
      start: 100,
      end: 500,
      direction: 1,
    };
    const result = formatFeature(ann);
    expect(result).toContain('     CDS             100..500');
    expect(result).toContain('                     /label="AmpR"');
  });

  it('formats a reverse complement annotation', () => {
    const ann: Annotation = {
      name: 'KanR',
      type: 'CDS',
      start: 100,
      end: 500,
      direction: -1,
    };
    const result = formatFeature(ann);
    expect(result).toContain('     CDS             complement(100..500)');
  });

  it('formats annotation with qualifiers', () => {
    const ann: Annotation = {
      name: 'GFP',
      type: 'CDS',
      start: 1,
      end: 300,
      direction: 1,
      qualifiers: { note: ['Green fluorescent protein'], codon_start: ['1'] },
    };
    const result = formatFeature(ann);
    expect(result).toContain('/note="Green fluorescent protein"');
    expect(result).toContain('/codon_start="1"');
  });

  it('wraps long prose at word boundaries near column 80', () => {
    const longNote = 'A long note with words. '.repeat(6).trim();
    const ann: Annotation = {
      name: 'Test',
      type: 'misc_feature',
      start: 1,
      end: 10,
      direction: 1,
      qualifiers: { note: [longNote] },
    };
    const result = formatFeature(ann);
    const lines = result.split('\n');
    lines.forEach((line) => expect(line.length).toBeLessThanOrEqual(80));
  });

  it('keeps an unbroken note token on one line instead of inserting a semantic space', () => {
    const note = 'A'.repeat(100);
    const result = formatFeature({
      name: 'Test',
      type: 'misc_feature',
      start: 1,
      end: 10,
      direction: 1,
      qualifiers: { note: [note] },
    });
    expect(result).toContain(`/note="${note}"`);
  });

  it('escapes quotes in qualifier values', () => {
    const ann: Annotation = {
      name: 'Test',
      type: 'misc_feature',
      start: 1,
      end: 10,
      direction: 1,
      qualifiers: { note: ['contains "special" chars'] },
    };
    const result = formatFeature(ann);
    expect(result).toContain('/note="contains ""special"" chars"');
  });

  it('round-trips embedded quotes exactly', () => {
    const note = 'note: note="synthetic" translation="EL"';
    const ann: Annotation = {
      name: 'Quoted feature',
      type: 'misc_feature',
      start: 1,
      end: 4,
      direction: 1,
      qualifiers: { note: [note] },
    };

    const reparsed = parseGenBankFull(`LOCUS       test                       8 bp    DNA     linear
FEATURES             Location/Qualifiers
${formatFeature(ann)}
ORIGIN
        1 atcgatcg
//`);

    expect(reparsed.annotations[0].qualifiers?.note).toEqual([note]);
  });

  it('does not split an unbroken path token even when it exceeds the preferred width', () => {
    const prefixLength = 80 - '                     /note="'.length;
    const note = `${'A'.repeat(prefixLength)}/the/path remains part of the value`;
    const ann: Annotation = {
      name: 'URL feature',
      type: 'misc_feature',
      start: 1,
      end: 4,
      direction: 1,
      qualifiers: { note: [note] },
    };
    const formatted = formatFeature(ann);
    expect(formatted).toContain(`${'A'.repeat(prefixLength)}/the/path`);

    const reparsed = parseGenBankFull(`LOCUS       test                       8 bp    DNA     linear
FEATURES             Location/Qualifiers
${formatted}
ORIGIN
        1 atcgatcg
//`);

    expect(reparsed.annotations[0].qualifiers?.note).toEqual([note]);
  });

  it('validates annotations with missing name', () => {
    const ann = {
      name: '',
      type: 'CDS',
      start: 1,
      end: 100,
      direction: 1 as const,
    };
    const result = formatFeature(ann);
    expect(result).toContain('/label="CDS"');
  });

  it('filters _-prefixed qualifiers from output', () => {
    const ann: Annotation = {
      name: 'SplicedGene',
      type: 'CDS',
      start: 1,
      end: 300,
      direction: 1,
      qualifiers: {
        gene: ['HBB'],
        _locationString: ['join(1..100,200..300)'],
        _internalFlag: ['some-internal-value'],
      },
    };
    const result = formatFeature(ann);
    expect(result).toContain('/gene="HBB"');
    expect(result).not.toContain('_locationString');
    expect(result).not.toContain('_internalFlag');
  });
});

describe('formatFeatures', () => {
  it('includes FEATURES header', () => {
    const anns: Annotation[] = [{ name: 'Test', type: 'CDS', start: 1, end: 10, direction: 1 }];
    const result = formatFeatures(anns);
    expect(result).toContain('FEATURES             Location/Qualifiers');
  });

  it('returns empty string for no annotations', () => {
    expect(formatFeatures([])).toBe('');
  });
});

describe('serializeGenBank', () => {
  it('uses an explicit stable product date without changing sequence or features', () => {
    const sequence: AnnotatedSequence = {
      id: 'accepted-date-fixture',
      name: 'accepted',
      sequence: 'ATGC',
      length: 4,
      circular: true,
      annotations: [{ name: 'part', type: 'misc_feature', start: 1, end: 4, direction: 1 }],
    };
    const content = serializeGenBank(sequence, { date: new Date('2026-05-17T12:00:00Z') });
    expect(content.split('\n')[0]).toContain('17-MAY-2026');
    expect(parseGenBankFull(content)).toMatchObject({
      sequence: 'ATGC',
      length: 4,
      circular: true,
    });
    expect(parseGenBankFull(content).annotations).toHaveLength(1);
  });

  it('produces valid GenBank with LOCUS, FEATURES, ORIGIN', () => {
    const seq: AnnotatedSequence = {
      id: 'puc19',
      name: 'pUC19',
      sequence: 'ATCGATCG',
      length: 2686,
      circular: true,
      annotations: [{ name: 'AmpR', type: 'CDS', start: 100, end: 500, direction: 1 }],
    };
    const result = serializeGenBank(seq);
    expect(result).toMatch(/^LOCUS\s+pUC19\s+2686 bp\s+DNA\s+circular/);
    expect(result).toContain('FEATURES             Location/Qualifiers');
    expect(result).toContain('ORIGIN');
    expect(result).toContain('//');
  });

  it('handles linear topology', () => {
    const seq: AnnotatedSequence = {
      id: 'linear',
      name: 'linear',
      sequence: 'ATCG',
      length: 4,
      circular: false,
      annotations: [],
    };
    const result = serializeGenBank(seq);
    expect(result).toMatch(/linear/);
  });

  it('includes DEFINITION when description is present', () => {
    const seq: AnnotatedSequence = {
      id: 'test',
      name: 'test',
      sequence: 'ATCG',
      length: 4,
      circular: true,
      annotations: [],
      description: 'Test plasmid.',
    };
    const result = serializeGenBank(seq);
    expect(result).toContain('DEFINITION  Test plasmid.');
  });

  it('handles sequence with no annotations', () => {
    const seq: AnnotatedSequence = {
      id: 'empty',
      name: 'empty',
      sequence: 'ATCGATCG',
      length: 8,
      circular: true,
      annotations: [],
    };
    const result = serializeGenBank(seq);
    expect(result).not.toContain('FEATURES');
    expect(result).toContain('ORIGIN');
  });
});

describe('round-trip: parse → serialize → re-parse', () => {
  it('round-trips a simple plasmid', () => {
    const original: AnnotatedSequence = {
      id: 'test',
      name: 'TestPlasmid',
      sequence: 'atcgatcgatcgatcgatcgatcgatcgatcgatcgatcgatcgatcgatcgatcgatcgatcgatcg',
      length: 68,
      circular: true,
      annotations: [
        { name: 'AmpR', type: 'CDS', start: 1, end: 30, direction: 1 },
        { name: 'ori', type: 'rep_origin', start: 40, end: 60, direction: 0 },
      ],
    };

    const serialized = serializeGenBank(original);
    const reparsed = parseGenBankFull(serialized);

    expect(reparsed.sequence).toBe(original.sequence);
    expect(reparsed.circular).toBe(original.circular);
    expect(reparsed.annotations.length).toBe(original.annotations.length);

    for (let i = 0; i < original.annotations.length; i++) {
      expect(reparsed.annotations[i].name).toBe(original.annotations[i].name);
      expect(reparsed.annotations[i].start).toBe(original.annotations[i].start);
      expect(reparsed.annotations[i].end).toBe(original.annotations[i].end);
      expect(reparsed.annotations[i].type).toBe(original.annotations[i].type);
    }
  });

  it('round-trips reverse complement annotations', () => {
    const original: AnnotatedSequence = {
      id: 'test',
      name: 'RevTest',
      sequence: 'atcgatcgatcg',
      length: 12,
      circular: true,
      annotations: [{ name: 'RevGene', type: 'CDS', start: 1, end: 10, direction: -1 }],
    };

    const serialized = serializeGenBank(original);
    const reparsed = parseGenBankFull(serialized);

    expect(reparsed.annotations[0].name).toBe('RevGene');
    expect(reparsed.annotations[0].direction).toBe(-1);
  });

  it('round-trips annotation qualifiers', () => {
    const original: AnnotatedSequence = {
      id: 'test',
      name: 'QualTest',
      sequence: 'atcgatcg',
      length: 8,
      circular: true,
      annotations: [
        {
          name: 'GFP',
          type: 'CDS',
          start: 1,
          end: 8,
          direction: 1,
          qualifiers: { note: ['Green fluorescent protein'], codon_start: ['1'] },
        },
      ],
    };

    const serialized = serializeGenBank(original);
    const reparsed = parseGenBankFull(serialized);

    expect(reparsed.annotations[0].qualifiers?.note?.[0]).toBe('Green fluorescent protein');
    expect(reparsed.annotations[0].qualifiers?.codon_start?.[0]).toBe('1');
  });

  it('round-trips linear topology', () => {
    const original: AnnotatedSequence = {
      id: 'linear',
      name: 'LinearSeq',
      sequence: 'atcg',
      length: 4,
      circular: false,
      annotations: [],
    };

    const serialized = serializeGenBank(original);
    const reparsed = parseGenBankFull(serialized);

    expect(reparsed.circular).toBe(false);
  });

  it('round-trips a GenBank string (parse → serialize → re-parse)', () => {
    const genbankInput = `LOCUS       pTest                   20 bp    DNA     circular
DEFINITION  Test plasmid for round-trip.
FEATURES             Location/Qualifiers
     CDS             1..10
                     /label="Gene1"
                     /note="First gene"
     promoter        complement(11..20)
                     /label="Prom1"
ORIGIN
        1 atcgatcgat cgatcgatcg
//
`;
    const parsed = parseGenBankFull(genbankInput);
    const serialized = serializeGenBank(parsed);
    const reparsed = parseGenBankFull(serialized);

    expect(reparsed.name).toBe(parsed.name);
    expect(reparsed.sequence).toBe(parsed.sequence);
    expect(reparsed.circular).toBe(parsed.circular);
    expect(reparsed.annotations.length).toBe(parsed.annotations.length);

    for (let i = 0; i < parsed.annotations.length; i++) {
      expect(reparsed.annotations[i].name).toBe(parsed.annotations[i].name);
      expect(reparsed.annotations[i].type).toBe(parsed.annotations[i].type);
      expect(reparsed.annotations[i].start).toBe(parsed.annotations[i].start);
      expect(reparsed.annotations[i].end).toBe(parsed.annotations[i].end);
    }
  });

  it('round-trips join() location with segments', () => {
    const genbankInput = `LOCUS       test                     500 bp    DNA     circular
FEATURES             Location/Qualifiers
     CDS             join(1..100,200..300,400..500)
                     /label="ThreeExon"
                     /gene="HBB"
ORIGIN
        1 atcgatcg
//
`;
    const parsed = parseGenBankFull(genbankInput);
    const serialized = serializeGenBank(parsed);
    const reparsed = parseGenBankFull(serialized);

    expect(reparsed.annotations[0].segments).toEqual([
      { start: 1, end: 100 },
      { start: 200, end: 300 },
      { start: 400, end: 500 },
    ]);
    expect(serialized).toContain('join(1..100,200..300,400..500)');
  });

  it('round-trips embedded quotes in qualifiers', () => {
    const original: AnnotatedSequence = {
      id: 'test',
      name: 'QuoteTest',
      sequence: 'atcg',
      length: 4,
      circular: true,
      annotations: [
        {
          name: 'Test',
          type: 'misc_feature',
          start: 1,
          end: 4,
          direction: 0,
          qualifiers: { note: ['contains "quoted" text'] },
        },
      ],
    };

    const serialized = serializeGenBank(original);
    expect(serialized).toContain('""quoted""');

    const reparsed = parseGenBankFull(serialized);
    const note = reparsed.annotations[0].qualifiers?.note?.[0] || '';
    expect(note).toContain('quoted');
  });
});
