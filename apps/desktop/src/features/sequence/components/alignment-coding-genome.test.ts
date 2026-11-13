import { describe, expect, it } from 'vitest';
import { translateCDS, type Feature, type Genome } from '@waypoint/genome-renderer';
import { buildAlignmentCodingProjection } from './alignment-coding-genome';

const cds: Feature = {
  id: 8,
  type: 'CDS',
  start: 0,
  end: 9,
  direction: 'forward',
  displayName: 'coding feature',
  color: 0x33aa55,
  lane: 0,
};
function project(reference: string, query: string, feature: Feature = cds, circular = false) {
  const genome: Genome = {
    name: 'Reference',
    sequence: reference.replace(/-/g, ''),
    length: reference.replace(/-/g, '').length,
    circular,
    features: [feature],
  };
  const before = structuredClone(genome);
  const result = buildAlignmentCodingProjection(genome, {
    mode: 'gapped',
    gappedSequence: reference,
    alignedQuery: query,
  });
  expect(genome).toEqual(before);
  return result;
}
function protein(projection: ReturnType<typeof project>): string {
  const feature = projection.genome.features![0];
  return translateCDS(
    projection.genome.sequence!,
    feature.start,
    feature.end,
    feature.direction,
    projection.genome.length,
    projection.genome.circular,
    {
      segments: feature.segments,
      qualifiers: feature.qualifiers,
      sequenceGeneticCode: projection.genome.geneticCode,
    }
  )
    .map((codon) => codon.aa)
    .join('');
}

describe('query-derived CDS coding projection', () => {
  it.each([
    { reference: 'ATGAAATAA', query: 'ATGGAATAA', expected: 'ME*' },
    { reference: 'ATG-AAATAA', query: 'ATGCAAATAA', expected: 'MQI' },
    { reference: 'ATGAAATAA', query: 'ATG-AATAA', expected: 'MN' },
    { reference: 'ATG---AAATAA', query: 'ATGCCCAAATAA', expected: 'MPK*' },
  ])(
    'translates actual substitutions and indel frames: $query',
    ({ reference, query, expected }) => {
      const result = project(reference, query);
      expect(result.genome.sequence).toBe(query.replace(/-/g, ''));
      expect(result.genome.length).toBe(query.replace(/-/g, '').length);
      expect(protein(result)).toBe(expected);
      for (let base = 0; base < result.genome.length; base++) {
        const column = result.axis.bioToColumn(base)!;
        expect(query[column]).toBe(result.genome.sequence![base]);
        expect(result.axis.columnToBio(column)).toBe(base);
      }
    }
  );

  it('retains reverse-strand reading direction', () => {
    expect(protein(project('TTATTTCAT', 'TTATTCCAT', { ...cds, direction: 'reverse' }))).toBe(
      'ME*'
    );
  });

  it('maps splice intervals and excludes insertions confined to introns', () => {
    const result = project('ATG---CCCAAATAA', 'ATGTTTCCCGAATAA', {
      ...cds,
      end: 12,
      segments: [
        { start: 1, end: 3 },
        { start: 7, end: 12 },
      ],
    });
    expect(result.genome.features![0].segments).toEqual([
      { start: 1, end: 3 },
      { start: 10, end: 15 },
    ]);
    expect(protein(result)).toBe('ME*');
  });

  it('preserves codon phase and genetic-code qualifiers', () => {
    const result = project('AATGAAATAA', 'AATGGAATAA', {
      ...cds,
      end: 10,
      qualifiers: { codon_start: '2', transl_table: '1' },
    });
    expect(result.genome.features![0].qualifiers).toEqual({ codon_start: '2', transl_table: '1' });
    expect(protein(result)).toBe('ME*');
  });

  it('does not draw an invented CDS when the query deletes every coding base', () => {
    expect(project('ATGAAATAACCCC', '---------CCCC').genome.features).toEqual([]);
  });

  it('retains coding order across a circular origin', () => {
    expect(protein(project('AAATAAATG', 'GAATAAATG', { ...cds, start: 6, end: 3 }, true))).toBe(
      'ME'
    );
  });

  it('updates translation when a same-length replacement query changes the protein', () => {
    const first = project('ATGAAATAA', 'ATGGAATAA');
    const second = project('ATGAAATAA', 'ATGCCCTAA');
    expect(protein(first)).toBe('ME*');
    expect(protein(second)).toBe('MP*');
    expect(second.genome).not.toBe(first.genome);
  });

  it.each([
    ['ATGAAATAA', '-TGAAATAA', 'forward', 'K*'],
    ['ATGAAATAA', '--GAAATAA', 'forward', 'K*'],
    ['TTATTTCAT', 'TTATTTC--', 'reverse', 'K*'],
  ] as const)(
    'preserves the reference phase in a partial read %s / %s',
    (reference, query, direction, expected) => {
      expect(protein(project(reference, query, { ...cds, direction }))).toBe(expected);
    }
  );

  it('maps repeated translation exceptions through an upstream in-frame insertion', () => {
    const result = project('ATG---TAGTGATAA', 'ATGCCCTAGTGATAA', {
      ...cds,
      end: 12,
      qualifiers: { transl_except: '(pos:4..6,aa:Pyl)' },
      qualifierValues: { transl_except: ['(pos:4..6,aa:Pyl)', '(pos:7..9,aa:Sec)'] },
    });
    expect(result.genome.features![0].qualifierValues?.transl_except).toEqual([
      '(pos:7..9,aa:Pyl)',
      '(pos:10..12,aa:Sec)',
    ]);
    expect(result.genome.features![0].qualifiers?.transl_except).toBe('(pos:7..9,aa:Pyl)');
  });
});
