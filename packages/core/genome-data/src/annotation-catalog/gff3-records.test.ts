import { describe, expect, it } from 'vitest';

import { GFF3_TYPE_BY_KIND, parseGff3Track } from './gff3-records';
import { assemblyAccession } from './ids';
import { recordAnchorBp } from './records';

const ASSEMBLY = { accession: assemblyAccession('NC_000913.3'), lengthBp: 1000 };
const HEADER = '##gff-version 3\n##sequence-region NC_000913.3 1 1000\n';
const row = (cols: string[]) => cols.join('\t');

describe('parseGff3Track', () => {
  it('reads every kind, converting 1-based columns and attributes to 0-based records', () => {
    const text =
      HEADER +
      [
        row([
          'NC_000913.3',
          'demo',
          'terminator',
          '280',
          '316',
          '4.5',
          '+',
          '.',
          'ID=t1;Name=Terminator after istR-1%2C istR-2;condition=LB%2C OD600 ~0.4,M9;mechanism=intrinsic;termination_site=308;parts=stem:280-287,loop:288-293,stem:294-301,u_tract:302-316',
        ]),
        row([
          'NC_000913.3',
          'demo',
          'terminator',
          '1',
          '900',
          '1.94',
          '+',
          '.',
          'ID=rho1;mechanism=rho-dependent;peak=241',
        ]),
        row([
          'NC_000913.3',
          'demo',
          'terminator',
          '145',
          '145',
          '.',
          '+',
          '.',
          'ID=pt;resolution=point;mechanism=intrinsic;termination_site=145',
        ]),
        row([
          'NC_000913.3',
          'demo',
          'promoter',
          '100',
          '160',
          '.',
          '-',
          '.',
          'ID=p1;transcription_start=101;sigma_factor=sigma70;parts=minus35:150-155,minus10:127-132',
        ]),
        row([
          'NC_000913.3',
          'demo',
          'TSS',
          '148',
          '148',
          '33.3',
          '+',
          '.',
          'ID=s1;Name=Start site for thrL;classification=primary',
        ]),
        row([
          'NC_000913.3',
          'demo',
          'transcript',
          '148',
          '733',
          '.',
          '+',
          '.',
          'ID=u1;Name=thrL-thrB;gene=thrL,thrA,thrB;locus_tag=b0001,b0002,b0003;end_evidence=gene-derived',
        ]),
      ].join('\n') +
      '\n';
    const result = parseGff3Track({
      text,
      track: 'demo',
      assembly: ASSEMBLY,
      kinds: ['terminator', 'promoter', 'tss', 'transcription_unit'],
    });
    expect(result.rejected).toEqual({ count: 0, examples: [] });
    expect(result.skipped).toBe(0);
    expect(result.records).toEqual([
      {
        id: 'demo:t1',
        kind: 'terminator',
        strand: '+',
        name: 'Terminator after istR-1, istR-2',
        score: 4.5,
        conditions: ['LB, OD600 ~0.4', 'M9'],
        location: { shape: 'region', start: 279, end: 316 },
        mechanism: 'intrinsic',
        parts: [
          { element: 'stem', start: 279, end: 287 },
          { element: 'loop', start: 287, end: 293 },
          { element: 'stem', start: 293, end: 301 },
          { element: 'u-tract', start: 301, end: 316 },
        ],
        terminationBp: 307,
        peakBp: null,
      },
      {
        id: 'demo:rho1',
        kind: 'terminator',
        strand: '+',
        name: null,
        score: 1.94,
        conditions: [],
        location: { shape: 'region', start: 0, end: 900 },
        mechanism: 'rho-dependent',
        parts: [],
        terminationBp: null,
        peakBp: 240,
      },
      {
        id: 'demo:pt',
        kind: 'terminator',
        strand: '+',
        name: null,
        score: null,
        conditions: [],
        location: { shape: 'point', bp: 144 },
        mechanism: 'intrinsic',
        parts: [],
        terminationBp: 144,
        peakBp: null,
      },
      {
        id: 'demo:p1',
        kind: 'promoter',
        strand: '-',
        name: null,
        score: null,
        conditions: [],
        location: { shape: 'region', start: 99, end: 160 },
        transcriptionStartBp: 100,
        boxes: [
          { element: 'minus35', start: 149, end: 155 },
          { element: 'minus10', start: 126, end: 132 },
        ],
        sigmaFactor: 'sigma70',
      },
      {
        id: 'demo:s1',
        kind: 'tss',
        strand: '+',
        name: 'Start site for thrL',
        score: 33.3,
        conditions: [],
        location: { shape: 'point', bp: 147 },
        classification: 'primary',
      },
      {
        id: 'demo:u1',
        kind: 'transcription_unit',
        strand: '+',
        name: 'thrL-thrB',
        score: null,
        conditions: [],
        location: { shape: 'region', start: 147, end: 733 },
        genes: ['thrL', 'thrA', 'thrB'],
        geneLocusTags: ['b0001', 'b0002', 'b0003'],
        endEvidence: 'gene-derived',
      },
    ]);
    expect(result.records.map(recordAnchorBp)).toEqual([307, 240, 144, 100, 147, 147]);
  });

  it('skips rows of types the track does not declare, and reads the alternative type names', () => {
    const text =
      HEADER +
      [
        row(['NC_000913.3', 'x', 'gene', '1', '90', '.', '+', '.', 'ID=g1']),
        row(['NC_000913.3', 'x', 'CDS', '1', '90', '.', '+', '0', 'ID=c1;Parent=g1']),
        row(['NC_000913.3', 'x', 'operon', '1', '90', '.', '+', '.', 'ID=o1;gene=a,b']),
        row(['NC_000913.3', 'x', 'transcription_start_site', '5', '5', '.', '+', '.', 'ID=s1']),
        row(['NC_000913.3', 'x', 'terminator', '80', '90', '.', '+', '.', 'ID=t1']),
      ].join('\n');
    const units = parseGff3Track({
      text,
      track: 'x',
      assembly: ASSEMBLY,
      kinds: ['transcription_unit', 'tss'],
    });
    expect(units.records.map((r) => [r.id, r.kind])).toEqual([
      ['x:o1', 'transcription_unit'],
      ['x:s1', 'tss'],
    ]);
    expect(units.skipped).toBe(3);
    expect(units.rejected.count).toBe(0);
  });

  it('rejects rows of a declared kind that break the rules, with bounded examples', () => {
    const lines = [
      row(['NC_000913.3', 'x', 'terminator', '10', '20', '.', '+', '.', 'Name=no id']),
      row(['NC_000913.3', 'x', 'terminator', '10', '20', '.', '.', '.', 'ID=nostrand']),
      row(['NC_000913.3', 'x', 'terminator', '0', '20', '.', '+', '.', 'ID=zero']),
      row(['NC_000913.3', 'x', 'terminator', '990', '1001', '.', '+', '.', 'ID=past']),
      row(['NC_000913.3', 'x', 'terminator', '30', '20', '.', '+', '.', 'ID=backwards']),
      row(['chr1', 'x', 'terminator', '10', '20', '.', '+', '.', 'ID=otherseq']),
      row(['NC_000913.3', 'x', 'terminator', '10', '20', 'high', '+', '.', 'ID=badscore']),
      row(['NC_000913.3', 'x', 'terminator', '10', '20', '.', '+', '.', 'ID=dup']),
      row(['NC_000913.3', 'x', 'terminator', '10', '20', '.', '+', '.', 'ID=dup']),
      row([
        'NC_000913.3',
        'x',
        'terminator',
        '10',
        '25',
        '.',
        '+',
        '.',
        'ID=notapoint;resolution=point',
      ]),
      row(['NC_000913.3', 'x', 'TSS', '10', '11', '.', '+', '.', 'ID=widetss']),
      'NC_000913.3\tx\tterminator\t10',
      row(['NC_000913.3', 'x', 'terminator', '50', '60', '.', '+', '.', 'ID=fine']),
    ];
    const result = parseGff3Track({
      text: HEADER + lines.join('\n'),
      track: 'x',
      assembly: ASSEMBLY,
      kinds: ['terminator', 'tss'],
    });
    expect(result.records.map((r) => r.id)).toEqual(['x:dup', 'x:fine']);
    expect(result.rejected.count).toBe(11);
    expect(result.rejected.examples).toEqual([
      'line 3: no ID attribute',
      'line 4 (nostrand): strand must be + or -',
      'line 5 (zero): columns 4-5 give [0, 20], outside 1..1000',
      'line 6 (past): columns 4-5 give [990, 1001], outside 1..1000',
      'line 7 (backwards): columns 4-5 give [30, 20], outside 1..1000',
      'line 8 (otherseq): column 1 is chr1, not NC_000913.3',
      'line 9 (badscore): column 6 "high" is not a number',
      'line 11: duplicate ID dup',
      'line 12 (notapoint): resolution=point on a row longer than one base',
      'line 13 (widetss): a TSS must be one base long',
      'line 14: not a nine-column GFF3 row',
    ]);
  });

  it('caps the examples at 25 while counting every rejection', () => {
    const lines = Array.from({ length: 40 }, (_, i) =>
      row(['NC_000913.3', 'x', 'terminator', '10', '20', '.', '.', '.', `ID=r${i}`])
    );
    const result = parseGff3Track({
      text: lines.join('\n'),
      track: 'x',
      assembly: ASSEMBLY,
      kinds: ['terminator'],
    });
    expect(result.rejected.count).toBe(40);
    expect(result.rejected.examples).toHaveLength(25);
  });

  it('accepts an alias in column 1, stops at ##FASTA, and tolerates Windows line endings', () => {
    const text =
      '##gff-version 3\r\n' +
      row(['U00096.3', 'x', 'TSS', '5', '5', '.', '+', '.', 'ID=s1']) +
      '\r\n# a comment\r\n' +
      row(['U00096.3', 'x', 'TSS', '6', '6', '.', '-', '.', 'ID=s2']) +
      '\r\n##FASTA\r\n>NC_000913.3\r\nACGT\r\n';
    const result = parseGff3Track({
      text,
      track: 'x',
      assembly: ASSEMBLY,
      aliases: ['U00096.3'],
      kinds: ['tss'],
    });
    expect(result.rejected.count).toBe(0);
    expect(result.records.map((r) => [r.id, r.strand, r.location])).toEqual([
      ['x:s1', '+', { shape: 'point', bp: 4 }],
      ['x:s2', '-', { shape: 'point', bp: 5 }],
    ]);
  });

  it('decodes the reserved characters a writer must escape, and treats an unescaped comma as a separator', () => {
    const text = row([
      'NC_000913.3',
      'x',
      'terminator',
      '10',
      '20',
      '.',
      '+',
      '.',
      'ID=e;Name=a%3Bb%3Dc%26d%25e%09f;condition=one%2C two,three',
    ]);
    const [record] = parseGff3Track({
      text,
      track: 'x',
      assembly: ASSEMBLY,
      kinds: ['terminator'],
    }).records;
    expect(record?.name).toBe('a;b=c&d%e\tf');
    expect(record?.conditions).toEqual(['one, two', 'three']);
  });

  it('drops locus tags that do not line up with genes, and ignores positions outside the assembly', () => {
    const text = [
      row([
        'NC_000913.3',
        'x',
        'transcript',
        '100',
        '900',
        '.',
        '-',
        '.',
        'ID=short;gene=thrL,thrA;locus_tag=b0001',
      ]),
      row(['NC_000913.3', 'x', 'transcript', '100', '900', '.', '-', '.', 'ID=untagged;gene=yaaA']),
      row([
        'NC_000913.3',
        'x',
        'terminator',
        '279',
        '316',
        '.',
        '+',
        '.',
        'ID=far;termination_site=5000',
      ]),
      row([
        'NC_000913.3',
        'x',
        'terminator',
        '279',
        '316',
        '.',
        '+',
        '.',
        'ID=text;termination_site=abc',
      ]),
      row([
        'NC_000913.3',
        'x',
        'terminator',
        '279',
        '316',
        '.',
        '+',
        '.',
        'ID=badparts;parts=stem:5-1,loop:x,u_tract:300-316',
      ]),
    ].join('\n');
    const result = parseGff3Track({
      text,
      track: 'x',
      assembly: ASSEMBLY,
      kinds: ['transcription_unit', 'terminator'],
    });
    expect(result.rejected.count).toBe(0);
    const [short, untagged, far, text2, badparts] = result.records;
    expect(short).toMatchObject({ genes: ['thrL', 'thrA'], geneLocusTags: [] });
    expect(untagged).toMatchObject({ genes: ['yaaA'], geneLocusTags: [] });
    expect(far).toMatchObject({ terminationBp: null });
    expect(recordAnchorBp(far)).toBe(315);
    expect(text2).toMatchObject({ terminationBp: null });
    expect(badparts).toMatchObject({ parts: [{ element: 'u-tract', start: 299, end: 316 }] });
  });

  it('names the type each kind is written with', () => {
    expect(GFF3_TYPE_BY_KIND).toEqual({
      promoter: 'promoter',
      terminator: 'terminator',
      tss: 'TSS',
      transcription_unit: 'transcript',
    });
  });
});
