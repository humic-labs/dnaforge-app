import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  alignmentColumnToLocus,
  alignmentLocusToColumn,
  buildGenomeComparisonLayout,
  createGenomeComparisonBlock,
  parseGenomeComparisonCigar,
  parseGenomeComparisonPaf,
} from './genome-comparison';

const references = {
  target: { id: 'target', length: 1000 },
  query: { id: 'query', length: 1000 },
};

function block(strand: '+' | '-' = '+') {
  return createGenomeComparisonBlock({
    id: 'gap-block', target: { referenceId: 'target', start: 10, end: 19 },
    query: { referenceId: 'query', start: 100, end: 108 }, strand,
    matchingBases: 6, alignmentColumns: 11, mappingQuality: 60, cigar: '3M2I2M3D1M',
  });
}

describe('exact genome comparison columns', () => {
  it('preserves insertion and deletion gaps without inventing nearby bases', () => {
    const value = block();
    expect(value.columnLength).toBe(11);
    expect(alignmentColumnToLocus(value, 'target', 3)).toEqual({ kind: 'gap', referenceId: 'target', boundary: 13 });
    expect(alignmentColumnToLocus(value, 'query', 3)).toEqual({ kind: 'base', referenceId: 'query', position: 103 });
    expect(alignmentColumnToLocus(value, 'query', 7)).toEqual({ kind: 'gap', referenceId: 'query', boundary: 107 });
    expect(alignmentColumnToLocus(value, 'target', 7)).toEqual({ kind: 'base', referenceId: 'target', position: 15 });
    expect(alignmentLocusToColumn(value, 'target', 15)).toBe(7);
    expect(alignmentLocusToColumn(value, 'query', 103)).toBe(3);
  });

  it('maps reverse-query bases and deletion boundaries in original biological coordinates', () => {
    const value = block('-');
    expect(alignmentColumnToLocus(value, 'query', 0)).toEqual({ kind: 'base', referenceId: 'query', position: 107 });
    expect(alignmentColumnToLocus(value, 'query', 3)).toEqual({ kind: 'base', referenceId: 'query', position: 104 });
    expect(alignmentColumnToLocus(value, 'query', 7)).toEqual({ kind: 'gap', referenceId: 'query', boundary: 101 });
    expect(alignmentLocusToColumn(value, 'query', 100)).toBe(10);
  });

  it.each(['+', '-'] as const)('roundtrips every biological base on strand %s', (strand) => {
    const value = block(strand);
    for (const side of ['target', 'query'] as const) {
      for (let position = value[side].start; position < value[side].end; position += 1) {
        const column = alignmentLocusToColumn(value, side, position);
        expect(column).not.toBeNull();
        expect(alignmentColumnToLocus(value, side, column!)).toEqual({ kind: 'base', referenceId: value[side].referenceId, position });
      }
    }
  });

  it('does not coerce outside or fractional positions into aligned bases', () => {
    const value = block();
    for (const column of [-1, 11, NaN, 0.5]) expect(alignmentColumnToLocus(value, 'query', column)).toBeNull();
    for (const position of [99, 108, NaN, 100.5]) expect(alignmentLocusToColumn(value, 'query', position)).toBeNull();
  });

  it('retains exact match and mismatch operations', () => {
    expect(parseGenomeComparisonCigar('2=1X3M')).toEqual([{ code: '=', length: 2 }, { code: 'X', length: 1 }, { code: 'M', length: 3 }]);
  });

  it.each(['', '0M', '2Mgarbage', '2M1S', '1N', '1H', '1P', '1.5M', '01M'])('rejects unsupported or malformed CIGAR %j', (cigar) => {
    expect(() => parseGenomeComparisonCigar(cigar)).toThrow();
  });

  it('refuses CIGAR whose consumption disagrees with declared source intervals', () => {
    expect(() => createGenomeComparisonBlock({ ...block(), cigar: '9M' })).toThrow(/consume/u);
    expect(() => createGenomeComparisonBlock({ ...block(), alignmentColumns: 12 })).toThrow(/consume/u);
  });
});

describe('paired-reference PAF ownership', () => {
  const line = 'query\t1000\t100\t108\t-\ttarget\t1000\t10\t19\t6\t11\t60\ttp:A:P\tcg:Z:3M2I2M3D1M';

  it('parses exact reference versions, source intervals and quality', () => {
    expect(parseGenomeComparisonPaf(`${line}\n`, references).blocks[0]).toMatchObject({
      query: { referenceId: 'query', start: 100, end: 108 }, target: { referenceId: 'target', start: 10, end: 19 },
      strand: '-', mappingQuality: 60, matchingBases: 6, columnLength: 11,
    });
  });

  it('refuses reference identity or length drift rather than borrowing another genome', () => {
    expect(() => parseGenomeComparisonPaf(line.replace('query\t', 'query.2\t'), references)).toThrow(/another reference/u);
    expect(() => parseGenomeComparisonPaf(line, { ...references, query: { id: 'query', length: 999 } })).toThrow(/another reference/u);
    expect(() => parseGenomeComparisonPaf(line.replace('\t100\t108\t', '\t100\t1001\t'), references)).toThrow(/exceeds/u);
  });

  it('requires actual base-alignment evidence and never infers gaps from endpoints', () => {
    expect(() => parseGenomeComparisonPaf(line.replace('\tcg:Z:3M2I2M3D1M', ''), references)).toThrow(/CIGAR/u);
    expect(() => parseGenomeComparisonPaf(`${line}\tcg:Z:3M2I2M3D1M`, references)).toThrow(/CIGAR/u);
  });

  it('retains ambiguous alignment columns separately from PAF nonambiguous length', () => {
    const value = parseGenomeComparisonPaf(line.replace('\t6\t11\t', '\t6\t10\t') + '\tnn:i:1', references).blocks[0];
    expect(value.alignmentColumns).toBe(10);
    expect(value.ambiguousBases).toBe(1);
    expect(value.columnLength).toBe(11);
    expect(() => parseGenomeComparisonPaf(line + '\tnn:i:1', references)).toThrow(/consume/u);
  });

  it('keeps mapQ zero and filters secondary rows only when requested', () => {
    expect(parseGenomeComparisonPaf(line.replace('\t60\t', '\t0\t'), references).blocks[0].mappingQuality).toBe(0);
    expect(parseGenomeComparisonPaf(line.replace('tp:A:P', 'tp:A:S'), references).blocks).toEqual([]);
    expect(parseGenomeComparisonPaf(line.replace('tp:A:P', 'tp:A:S'), { ...references, primaryOnly: false }).blocks).toHaveLength(1);
  });

  it('applies a source alignment-column threshold without changing retained intervals', () => {
    expect(parseGenomeComparisonPaf(line, { ...references, minimumAlignmentColumns: 12 }).blocks).toEqual([]);
    expect(parseGenomeComparisonPaf(line, { ...references, minimumAlignmentColumns: 11 }).blocks[0]).toEqual(parseGenomeComparisonPaf(line, references).blocks[0]);
  });

  it('reads the genuine minimap2 compact fixture and roundtrips every segment endpoint', async () => {
    const file = fileURLToPath(new URL('../../../../test-fixtures/genome-view-prototypes/MG1655-Shigella2457T-gapped.paf', import.meta.url));
    const comparison = parseGenomeComparisonPaf(await readFile(file, 'utf8'), {
      target: { id: 'NC_000913.3', length: 4641652 }, query: { id: 'NC_004741.1', length: 4599354 },
    });
    expect(comparison.blocks).toHaveLength(261);
    expect(comparison.blocks.some((value) => value.strand === '-')).toBe(true);
    for (const code of ['I', 'D']) expect(comparison.blocks.some((value) => value.segments.some((segment) => segment.code === code))).toBe(true);
    for (const value of comparison.blocks) {
      for (const segment of value.segments) {
        for (const side of ['target', 'query'] as const) {
          for (const column of [segment.columnStart, segment.columnEnd - 1]) {
            const locus = alignmentColumnToLocus(value, side, column)!;
            if (locus.kind === 'base') expect(alignmentLocusToColumn(value, side, locus.position)).toBe(column);
          }
        }
      }
    }
  });
});

describe('multi-block comparison layout', () => {
  const moved = (id: string, targetStart: number, queryStart: number, strand: '+' | '-' = '+') => createGenomeComparisonBlock({
    id, target: { referenceId: 'target', start: targetStart, end: targetStart + 4 },
    query: { referenceId: 'query', start: queryStart, end: queryStart + 4 },
    strand, cigar: '4M', matchingBases: 4, alignmentColumns: 4, mappingQuality: 60,
  });

  it('keeps unaligned joins distinct from the base-level gapped blocks', () => {
    const result = buildGenomeComparisonLayout([moved('b', 30, 50), moved('a', 10, 20)], 8);
    expect(result.columnLength).toBe(16);
    expect(result.entries[1]).toEqual({ kind: 'unaligned-join', previousBlockId: 'a', nextBlockId: 'b', columnStart: 4, columnEnd: 12,
      targetGap: { start: 14, end: 30 }, queryGap: { start: 24, end: 50 }, reason: 'unaligned' });
  });

  it('does not hide inversions, reordered query blocks or overlapping target placements', () => {
    expect(buildGenomeComparisonLayout([moved('a', 10, 100), moved('b', 30, 200, '-')]).entries[1]).toMatchObject({ kind: 'unaligned-join', reason: 'rearrangement' });
    expect(buildGenomeComparisonLayout([moved('a', 10, 100), moved('b', 30, 20)]).entries[1]).toMatchObject({ kind: 'unaligned-join', reason: 'rearrangement' });
    expect(buildGenomeComparisonLayout([moved('a', 10, 100), moved('b', 12, 200)]).entries[1]).toMatchObject({ kind: 'unaligned-join', reason: 'overlap' });
  });

  it('returns an empty layout and refuses mixed references or duplicate block IDs', () => {
    expect(buildGenomeComparisonLayout([])).toEqual({ entries: [], columnLength: 0 });
    expect(() => buildGenomeComparisonLayout([moved('a', 10, 20), moved('a', 20, 30)])).toThrow(/unique/u);
    const other = { ...moved('b', 30, 40), target: { referenceId: 'target.2', start: 30, end: 34 } };
    expect(() => buildGenomeComparisonLayout([moved('a', 10, 20), other])).toThrow(/mix/u);
  });
});
