import { describe, it, expect } from 'vitest';
import {
  parseGenBankFull,
  parseGenBankRecords,
  indexGenBankRecords,
  extractRawSequence,
  isGenBankFormat,
  parseFeatureLocation,
} from './genbank';

describe('parseGenBankRecords', () => {
  it('returns every record in a concatenated GenBank file', () => {
    const content = `LOCUS       chromosome_one            8 bp    DNA     linear
DEFINITION  First chromosome.
ORIGIN
        1 atgcATGC
//
LOCUS       chromosome_two            6 bp    DNA     linear
DEFINITION  Second chromosome.
ORIGIN
        1 ttgCaa
//`;

    const records = parseGenBankRecords(content);

    expect(records).toHaveLength(2);
    expect(records.map(({ name, sequence }) => ({ name, sequence }))).toEqual([
      { name: 'chromosome_one', sequence: 'atgcATGC' },
      { name: 'chromosome_two', sequence: 'ttgCaa' },
    ]);
  });

  it('rejects an unterminated later record instead of returning partial data', () => {
    const content =
      'LOCUS       one       4 bp    DNA     linear\nORIGIN\n        1 acgt\n//\n' +
      'LOCUS       two       4 bp    DNA     linear\nORIGIN\n        1 tgca\n';

    expect(() => parseGenBankRecords(content)).toThrow('missing its // terminator');
  });
});

describe('indexGenBankRecords', () => {
  it('returns exact LF byte ranges for every complete record', () => {
    const prefix = 'download header\n';
    const first = `LOCUS       chromosome_one            4 bp    DNA     linear\nORIGIN\n        1 acgt\n//\n`;
    const gap = '\n';
    const second = `LOCUS       chromosome_two            6 bp    DNA     linear\nORIGIN\n        1 ttgcaa\n//\n`;
    const source = new TextEncoder().encode(`${prefix}${first}${gap}${second}`);

    const records = indexGenBankRecords(source);

    expect(records.map(({ name, length }) => ({ name, length }))).toEqual([
      { name: 'chromosome_one', length: 4 },
      { name: 'chromosome_two', length: 6 },
    ]);
    expect(
      new TextDecoder().decode(source.slice(records[0].startByte, records[0].endByteExclusive))
    ).toBe(first);
    expect(
      new TextDecoder().decode(source.slice(records[1].startByte, records[1].endByteExclusive))
    ).toBe(second);
  });

  it('preserves CRLF bytes and ignores indented slashes inside a record', () => {
    const record =
      'LOCUS       chromosome_one            4 bp    DNA     linear\r\n' +
      'FEATURES             Location/Qualifiers\r\n' +
      '     misc_feature    1..4\r\n' +
      '                     /note="// is not a terminator"\r\n' +
      'ORIGIN\r\n' +
      '        1 acgt\r\n' +
      '//\r\n';
    const source = new TextEncoder().encode(record);

    const [indexed] = indexGenBankRecords(source);

    expect(
      new TextDecoder().decode(source.slice(indexed.startByte, indexed.endByteExclusive))
    ).toBe(record);
  });

  it('rejects a later unterminated record instead of returning the first record', () => {
    const source = new TextEncoder().encode(
      'LOCUS       one       4 bp    DNA     linear\nORIGIN\n        1 acgt\n//\n' +
        'LOCUS       two       4 bp    DNA     linear\nORIGIN\n        1 tgca\n'
    );

    expect(() => indexGenBankRecords(source)).toThrow('missing its // terminator');
  });

  it('stops at a caller-supplied record limit before parsing the full collection', () => {
    const source = new TextEncoder().encode(
      Array.from(
        { length: 3 },
        (_, index) =>
          `LOCUS       record_${index}       1 bp    DNA     linear\nORIGIN\n        1 a\n//\n`
      ).join('')
    );

    expect(() => indexGenBankRecords(source, { maxRecords: 2 })).toThrow('more than 2 records');
  });
});

describe('parseGenBankFull', () => {
  it('parses LOCUS line for name, length, and topology', () => {
    const content = `LOCUS       pUC19                   2686 bp    DNA     circular
FEATURES             Location/Qualifiers
ORIGIN
        1 atcgatcg
//`;
    const result = parseGenBankFull(content);
    expect(result.name).toBe('pUC19');
    expect(result.length).toBe(2686);
    expect(result.circular).toBe(true);
  });

  it('parses linear topology', () => {
    const content = `LOCUS       linear_seq              100 bp    DNA     linear
ORIGIN
        1 atcgatcg
//`;
    const result = parseGenBankFull(content);
    expect(result.circular).toBe(false);
  });

  it('parses multi-word LOCUS names without forcing circular topology', () => {
    const content = `LOCUS       S288C chromosome   1531933 bp    DNA     linear     01-JAN-2025
FEATURES             Location/Qualifiers
ORIGIN
        1 atcgatcg
//`;
    const result = parseGenBankFull(content);
    expect(result.name).toBe('S288C chromosome');
    expect(result.length).toBe(1531933);
    expect(result.circular).toBe(false);
  });

  it('extracts sequence from ORIGIN section', () => {
    const content = `LOCUS       test                     12 bp    DNA     circular
ORIGIN
        1 atcgatcg atcg
//`;
    const result = parseGenBankFull(content);
    expect(result.sequence).toBe('atcgatcgatcg');
  });

  it('preserves original case of ORIGIN sequence', () => {
    const content = `LOCUS       test                     8 bp    DNA     circular
FEATURES             Location/Qualifiers
ORIGIN
        1 atgcATGC
//`;
    const result = parseGenBankFull(content);
    expect(result.sequence).toBe('atgcATGC');
  });

  it('parses simple forward annotation', () => {
    const content = `LOCUS       test                     100 bp    DNA     circular
FEATURES             Location/Qualifiers
     CDS             10..50
                     /label="AmpR"
                     /note="Ampicillin resistance"
ORIGIN
        1 atcgatcg
//`;
    const result = parseGenBankFull(content);
    expect(result.annotations).toHaveLength(1);
    expect(result.annotations[0]).toMatchObject({
      name: 'AmpR',
      type: 'CDS',
      start: 10,
      end: 50,
      direction: 1,
    });
    expect(result.annotations[0].qualifiers?.note).toEqual(['Ampicillin resistance']);
  });

  it('preserves forward direction for RNA feature types used by structure search', () => {
    const content = `LOCUS       test                     200 bp    DNA     circular
FEATURES             Location/Qualifiers
     ncRNA           10..80
                     /label="ffs ncRNA"
     misc_RNA        90..120
                     /label="misc RNA"
     tmRNA           complement(130..180)
                     /label="ssrA tmRNA"
ORIGIN
        1 atcgatcg
//`;
    const result = parseGenBankFull(content);
    expect(result.annotations.map(({ type, direction }) => [type, direction])).toEqual([
      ['ncRNA', 1],
      ['misc_RNA', 1],
      ['tmRNA', -1],
    ]);
  });

  it('parses complement (reverse) annotation', () => {
    const content = `LOCUS       test                     100 bp    DNA     circular
FEATURES             Location/Qualifiers
     CDS             complement(100..500)
                     /label="KanR"
ORIGIN
        1 atcgatcg
//`;
    const result = parseGenBankFull(content);
    expect(result.annotations[0]).toMatchObject({
      name: 'KanR',
      type: 'CDS',
      start: 100,
      end: 500,
      direction: -1,
    });
  });

  it('parses join() location', () => {
    const content = `LOCUS       test                     500 bp    DNA     circular
FEATURES             Location/Qualifiers
     CDS             join(1..100,200..300)
                     /label="SplitFeature"
ORIGIN
        1 atcgatcg
//`;
    const result = parseGenBankFull(content);
    expect(result.annotations[0]).toMatchObject({
      name: 'SplitFeature',
      type: 'CDS',
      start: 1,
      end: 300,
      direction: 1,
    });
  });

  it('parses complement(join()) location', () => {
    const content = `LOCUS       test                     500 bp    DNA     circular
FEATURES             Location/Qualifiers
     CDS             complement(join(1..100,200..300))
                     /label="RevSplit"
ORIGIN
        1 atcgatcg
//`;
    const result = parseGenBankFull(content);
    expect(result.annotations[0]).toMatchObject({
      name: 'RevSplit',
      type: 'CDS',
      start: 1,
      end: 300,
      direction: -1,
    });
  });

  it('detects complement-strand origin-wrap (parts ascending, strict adjacency)', () => {
    const content = `LOCUS       test                     500 bp    DNA     circular
FEATURES             Location/Qualifiers
     CDS             complement(join(1..100,401..500))
                     /label="URA3"
ORIGIN
        1 atcgatcg
//`;
    const result = parseGenBankFull(content);
    const ann = result.annotations[0];
    expect(ann).toMatchObject({
      name: 'URA3',
      type: 'CDS',
      start: 401,
      end: 100,
      direction: -1,
    });
    expect(ann.segments).toEqual([
      { start: 401, end: 500 },
      { start: 1, end: 100 },
    ]);
  });

  it('does NOT mistake interior complement splice for origin-wrap (no strict adjacency)', () => {
    const content = `LOCUS       test                     500 bp    DNA     circular
FEATURES             Location/Qualifiers
     CDS             complement(join(1..100,200..300))
                     /label="InteriorSplice"
ORIGIN
        1 atcgatcg
//`;
    const result = parseGenBankFull(content);
    expect(result.annotations[0]).toMatchObject({
      start: 1,
      end: 300,
      direction: -1,
    });
  });

  it('linear sequence: complement-join with boundary-touching parts is NOT an origin-wrap', () => {
    const content = `LOCUS       test                     500 bp    DNA     linear
FEATURES             Location/Qualifiers
     CDS             complement(join(1..100,401..500))
                     /label="LinearSplice"
ORIGIN
        1 atcgatcg
//`;
    const result = parseGenBankFull(content);
    expect(result.annotations[0]).toMatchObject({
      start: 1,
      end: 500,
      direction: -1,
    });
  });

  it('parses multiple annotations', () => {
    const content = `LOCUS       test                     1000 bp    DNA     circular
FEATURES             Location/Qualifiers
     CDS             10..50
                     /label="Gene1"
     promoter        60..80
                     /label="Prom1"
     rep_origin      200..500
                     /label="ori"
ORIGIN
        1 atcgatcg
//`;
    const result = parseGenBankFull(content);
    expect(result.annotations).toHaveLength(3);
    expect(result.annotations[0].name).toBe('Gene1');
    expect(result.annotations[1].name).toBe('Prom1');
    expect(result.annotations[1].direction).toBe(1);
    expect(result.annotations[2].name).toBe('ori');
    expect(result.annotations[2].direction).toBe(0);
  });

  it('falls back to qualifier gene/product/note for name', () => {
    const content = `LOCUS       test                     100 bp    DNA     circular
FEATURES             Location/Qualifiers
     CDS             10..50
                     /gene="myGene"
                     /product="MyProtein"
ORIGIN
        1 atcgatcg
//`;
    const result = parseGenBankFull(content);
    expect(result.annotations[0].name).toBe('myGene');
  });

  it('handles multiline qualifier values', () => {
    const content = `LOCUS       test                     100 bp    DNA     circular
FEATURES             Location/Qualifiers
     CDS             10..50
                     /label="GFP"
                     /translation="MSKGEELFTGVVPILVELDGDVNGHKFSVSGEGEGDATYG
                     KLTLKFICTTGKLPVPWPTLVTTLTYGVQCFSRYPDHMKQHDFFKSAMPEG"
ORIGIN
        1 atcgatcg
//`;
    const result = parseGenBankFull(content);
    expect(result.annotations[0].qualifiers?.translation?.[0]).toContain('MSKGEELFTGVVPILVELDG');
    expect(result.annotations[0].qualifiers?.translation?.[0]).toContain('AMPEG');
  });

  it('decodes doubled quotes without changing the qualifier text', () => {
    const content = `LOCUS       test                       8 bp    DNA     linear
FEATURES             Location/Qualifiers
     misc_feature    1..4
                     /label="Quoted feature"
                     /note="note: note=""synthetic"" translation=""EL"""
ORIGIN
        1 atcgatcg
//`;
    const result = parseGenBankFull(content);

    expect(result.annotations[0].qualifiers?.note).toEqual([
      'note: note="synthetic" translation="EL"',
    ]);
  });

  it('keeps a slash-leading wrapped line inside its open qualifier', () => {
    const content = `LOCUS       test                       8 bp    DNA     linear
FEATURES             Location/Qualifiers
     misc_feature    1..4
                     /label="URL feature"
                     /note="This source value is deliberately wrapped immediately before
                     /the/path so the slash cannot be parsed as another qualifier."
ORIGIN
        1 atcgatcg
//`;
    const result = parseGenBankFull(content);

    expect(result.annotations[0].qualifiers?.note).toEqual([
      'This source value is deliberately wrapped immediately before/the/path so the slash cannot be parsed as another qualifier.',
    ]);
    expect(result.annotations[0].qualifiers).not.toHaveProperty('the');
  });

  it('parses DEFINITION line', () => {
    const content = `LOCUS       test                     100 bp    DNA     circular
DEFINITION  pUC19 cloning vector.
ORIGIN
        1 atcgatcg
//`;
    const result = parseGenBankFull(content);
    expect(result.description).toBe('pUC19 cloning vector.');
  });

  it('handles empty features section', () => {
    const content = `LOCUS       test                     8 bp    DNA     circular
FEATURES             Location/Qualifiers
ORIGIN
        1 atcgatcg
//`;
    const result = parseGenBankFull(content);
    expect(result.annotations).toEqual([]);
  });

  it('generates stable id from name', () => {
    const content = `LOCUS       pUC19                   8 bp    DNA     circular
ORIGIN
        1 atcgatcg
//`;
    const result = parseGenBankFull(content);
    expect(result.id).toBe('puc19');
  });
});

describe('extractRawSequence', () => {
  it('extracts sequence from ORIGIN section', () => {
    const gb = `LOCUS test 10 bp DNA linear
ORIGIN
        1 atcgatcgat
//`;
    expect(extractRawSequence(gb)).toBe('atcgatcgat');
  });

  it('strips line numbers and spaces', () => {
    const gb = `ORIGIN\n        1 atcg atcg\n       11 tttt\n//`;
    expect(extractRawSequence(gb)).toBe('atcgatcgtttt');
  });

  it('returns empty for an empty ORIGIN section', () => {
    expect(extractRawSequence('ORIGIN\n//')).toBe('');
  });

  it('extracts CRLF ORIGIN sections the same as LF', () => {
    const lf = `LOCUS test 12 bp DNA linear
ORIGIN
        1 acgtacgtacgt
//`;
    const crlf = lf.replace(/\n/g, '\r\n');
    expect(extractRawSequence(crlf)).toBe(extractRawSequence(lf));
    expect(extractRawSequence(crlf)).toBe('acgtacgtacgt');
    expect(parseGenBankFull(crlf).sequence).toBe(extractRawSequence(crlf));
    expect(parseGenBankFull(lf).sequence).toBe(extractRawSequence(lf));
  });

  it('throws when ORIGIN is missing instead of treating the record as empty DNA', () => {
    expect(() => extractRawSequence('LOCUS test')).toThrow(/ORIGIN section is missing/i);
  });
});

describe('isGenBankFormat', () => {
  it('returns true for GenBank content', () => {
    expect(isGenBankFormat('LOCUS test 100 bp DNA circular')).toBe(true);
  });

  it('returns false for non-GenBank content', () => {
    expect(isGenBankFormat('>seq1\nATCG')).toBe(false);
  });
});

describe('parseFeatureLocation', () => {
  it('parses simple range', () => {
    const loc = parseFeatureLocation('100..500');
    expect(loc).toMatchObject({ start: 100, end: 500, complement: false });
  });

  it('parses complement', () => {
    const loc = parseFeatureLocation('complement(100..500)');
    expect(loc).toMatchObject({ start: 100, end: 500, complement: true });
  });

  it('parses join', () => {
    const loc = parseFeatureLocation('join(1..100,200..300)');
    expect(loc).toMatchObject({ start: 1, end: 300, complement: false });
    expect(loc.segments).toEqual([
      { start: 1, end: 100 },
      { start: 200, end: 300 },
    ]);
  });

  it('parses complement(join())', () => {
    const loc = parseFeatureLocation('complement(join(1..100,200..300))');
    expect(loc).toMatchObject({ start: 1, end: 300, complement: true });
    expect(loc.segments).toHaveLength(2);
  });

  it('parses single position', () => {
    const loc = parseFeatureLocation('42');
    expect(loc).toMatchObject({ start: 42, end: 42, complement: false });
  });

  it('parses partial locations with < and >', () => {
    const loc = parseFeatureLocation('<1..>100');
    expect(loc).toMatchObject({ start: 1, end: 100, complement: false });
  });
});

describe('join() → Annotation segment pipeline', () => {
  it('preserves segments on Annotation for join() CDS', () => {
    const content = `LOCUS       test                     500 bp    DNA     circular
FEATURES             Location/Qualifiers
     CDS             join(1..100,200..300,400..500)
                     /label="ThreeExon"
ORIGIN
        1 atcgatcg
//`;
    const result = parseGenBankFull(content);
    const cds = result.annotations[0];
    expect(cds.segments).toBeDefined();
    expect(cds.segments).toEqual([
      { start: 1, end: 100 },
      { start: 200, end: 300 },
      { start: 400, end: 500 },
    ]);
    expect(cds.start).toBe(1);
    expect(cds.end).toBe(500);
  });

  it('does NOT set segments for order() locations (guard)', () => {
    const content = `LOCUS       test                     500 bp    DNA     circular
FEATURES             Location/Qualifiers
     CDS             order(1..100,200..300)
                     /label="OrderFeature"
ORIGIN
        1 atcgatcg
//`;
    const result = parseGenBankFull(content);
    const cds = result.annotations[0];
    expect(cds.segments).toBeUndefined();
  });

  it('preserves _locationString in qualifiers for join() CDS', () => {
    const content = `LOCUS       test                     500 bp    DNA     circular
FEATURES             Location/Qualifiers
     CDS             join(1..100,200..300)
                     /label="SplicedGene"
ORIGIN
        1 atcgatcg
//`;
    const result = parseGenBankFull(content);
    const cds = result.annotations[0];
    expect(cds.qualifiers?._locationString?.[0]).toBe('join(1..100,200..300)');
  });

  it('merges split CDS features with same name (Benchling export format)', () => {
    const content = `LOCUS       test                    1000 bp    DNA     circular
FEATURES             Location/Qualifiers
     CDS             100..200
                     /label="EFB1 CDS"
     gene            100..500
                     /label="EFB1 gene"
     CDS             300..500
                     /label="EFB1 CDS"
ORIGIN
        1 ${'atcg'.repeat(250)}
//`;
    const result = parseGenBankFull(content);
    const cdsFeatures = result.annotations.filter((a) => a.type === 'CDS' && a.name === 'EFB1 CDS');
    expect(cdsFeatures).toHaveLength(1);
    const cds = cdsFeatures[0];
    expect(cds.segments).toEqual([
      { start: 100, end: 200 },
      { start: 300, end: 500 },
    ]);
    expect(cds.start).toBe(100);
    expect(cds.end).toBe(500);
    expect(cds.qualifiers?._locationString?.[0]).toBe('join(100..200,300..500)');
  });

  it('merges split reverse-strand CDS features (Benchling export)', () => {
    const content = `LOCUS       test                    1000 bp    DNA     circular
FEATURES             Location/Qualifiers
     CDS             complement(100..200)
                     /label="REV_CDS"
     CDS             complement(300..500)
                     /label="REV_CDS"
ORIGIN
        1 ${'atcg'.repeat(250)}
//`;
    const result = parseGenBankFull(content);
    const cdsFeatures = result.annotations.filter((a) => a.type === 'CDS' && a.name === 'REV_CDS');
    expect(cdsFeatures).toHaveLength(1);
    const cds = cdsFeatures[0];
    expect(cds.segments).toEqual([
      { start: 100, end: 200 },
      { start: 300, end: 500 },
    ]);
    expect(cds.qualifiers?._locationString?.[0]).toBe('complement(join(100..200,300..500))');
    expect(cds.direction).toBe(-1);
  });

  it('does NOT merge CDS features with different names', () => {
    const content = `LOCUS       test                    1000 bp    DNA     circular
FEATURES             Location/Qualifiers
     CDS             100..200
                     /label="GeneA"
     CDS             300..500
                     /label="GeneB"
ORIGIN
        1 ${'atcg'.repeat(250)}
//`;
    const result = parseGenBankFull(content);
    const cdsFeatures = result.annotations.filter((a) => a.type === 'CDS');
    expect(cdsFeatures).toHaveLength(2);
    expect(cdsFeatures[0].segments).toBeUndefined();
    expect(cdsFeatures[1].segments).toBeUndefined();
  });

  it('does NOT merge same-label CDS features across intervening CDS features', () => {
    const content = `LOCUS       test                    1200 bp    DNA     circular
FEATURES             Location/Qualifiers
     CDS             100..190
                     /label="renD CDS"
     CDS             250..500
                     /label="insE CDS"
     CDS             600..800
                     /label="insF CDS"
     CDS             900..1100
                     /label="renD CDS"
ORIGIN
        1 ${'atcg'.repeat(300)}
//`;
    const result = parseGenBankFull(content);
    const renD = result.annotations.filter((a) => a.type === 'CDS' && a.name === 'renD CDS');
    expect(renD).toHaveLength(2);
    expect(renD[0].segments).toBeUndefined();
    expect(renD[1].segments).toBeUndefined();
  });

  it('does NOT collapse repeated IS-element CDS scattered across a genome ', () => {
    const content = `LOCUS       teststrain             60000 bp    DNA     circular
FEATURES             Location/Qualifiers
     CDS             500..600
                     /label="insA"
     gene            2000..3000
                     /label="yfgA"
     CDS             5000..5100
                     /label="insA"
     gene            20000..21000
                     /label="yfgB"
     CDS             50000..50100
                     /label="insA"
ORIGIN
        1 ${'atcg'.repeat(50)}
//`;
    const result = parseGenBankFull(content);
    const insA = result.annotations.filter((a) => a.type === 'CDS' && a.name === 'insA');
    expect(insA).toHaveLength(3);
    for (const copy of insA) {
      expect(copy.segments).toBeUndefined();
    }
    expect(insA.some((a) => a.start === 500 && a.end >= 50100)).toBe(false);
  });
});
