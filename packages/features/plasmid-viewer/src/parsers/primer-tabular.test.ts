import { describe, it, expect } from 'vitest';
import {
  parsePrimerTabular,
  detectColumnMapping,
  parseCSV,
  parseTSV,
  detectDelimiter,
  isPrimerTabular,
  extractTabularPreview,
  parsePrimersWithMapping,
  PrimerParseError,
} from './primer-tabular';

describe('parseCSV', () => {
  it('parses simple CSV', () => {
    const content = `Name,Sequence
Primer1,ATGC
Primer2,GCTA`;

    const result = parseCSV(content);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual(['Name', 'Sequence']);
    expect(result[1]).toEqual(['Primer1', 'ATGC']);
    expect(result[2]).toEqual(['Primer2', 'GCTA']);
  });

  it('handles quoted fields', () => {
    const content = `Name,Description
"Primer, 1","Has, commas"`;

    const result = parseCSV(content);

    expect(result[1]).toEqual(['Primer, 1', 'Has, commas']);
  });

  it('handles escaped quotes', () => {
    const content = `Name,Description
"Say ""Hello""",Test`;

    const result = parseCSV(content);

    expect(result[1]).toEqual(['Say "Hello"', 'Test']);
  });

  it('skips empty lines', () => {
    const content = `Name,Sequence

Primer1,ATGC

Primer2,GCTA`;

    const result = parseCSV(content);

    expect(result).toHaveLength(3);
  });
});

describe('parseTSV', () => {
  it('parses tab-separated values', () => {
    const content = `Name\tSequence
Primer1\tATGC
Primer2\tGCTA`;

    const result = parseTSV(content);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual(['Name', 'Sequence']);
    expect(result[1]).toEqual(['Primer1', 'ATGC']);
  });
});

describe('detectDelimiter', () => {
  it('detects CSV format', () => {
    expect(detectDelimiter('Name,Sequence,Tm')).toBe('csv');
  });

  it('detects TSV format', () => {
    expect(detectDelimiter('Name\tSequence\tTm')).toBe('tsv');
  });

  it('defaults to CSV when unclear', () => {
    expect(detectDelimiter('NoDelimiters')).toBe('csv');
  });
});

describe('detectColumnMapping', () => {
  it('detects standard column names', () => {
    const headers = ['Name', 'Sequence', 'Description', 'Tm'];

    const mapping = detectColumnMapping(headers);

    expect(mapping.name).toBe(0);
    expect(mapping.sequence).toBe(1);
    expect(mapping.description).toBe(2);
    expect(mapping.tm).toBe(3);
  });

  it('handles alternative column names', () => {
    const headers = ['Primer ID', 'Oligo Sequence', 'Notes', 'Melting Temp'];

    const mapping = detectColumnMapping(headers);

    expect(mapping.name).toBe(0);
    expect(mapping.sequence).toBe(1);
    expect(mapping.description).toBe(2);
    expect(mapping.tm).toBe(3);
  });

  it('handles case-insensitive matching', () => {
    const headers = ['NAME', 'SEQUENCE', 'TM'];

    const mapping = detectColumnMapping(headers);

    expect(mapping.name).toBe(0);
    expect(mapping.sequence).toBe(1);
    expect(mapping.tm).toBe(2);
  });

  it('handles underscore variations', () => {
    const headers = ['primer_name', 'primer_sequence'];

    const mapping = detectColumnMapping(headers);

    expect(mapping.name).toBe(0);
    expect(mapping.sequence).toBe(1);
  });

  it('detects direction column', () => {
    const headers = ['Name', 'Seq', 'Direction'];

    const mapping = detectColumnMapping(headers);

    expect(mapping.direction).toBe(2);
  });

  it('returns null for missing columns', () => {
    const headers = ['Name', 'Seq'];

    const mapping = detectColumnMapping(headers);

    expect(mapping.description).toBeNull();
    expect(mapping.tm).toBeNull();
    expect(mapping.direction).toBeNull();
  });
});

describe('parsePrimerTabular', () => {
  it('parses valid primer CSV', () => {
    const content = `Name,Sequence
M13-Forward,GTAAAACGACGGCCAGT
M13-Reverse,CAGGAAACAGCTATGAC`;

    const result = parsePrimerTabular(content);

    expect(result.primers).toHaveLength(2);
    expect(result.primers[0].name).toBe('M13-Forward');
    expect(result.primers[0].sequence).toBe('GTAAAACGACGGCCAGT');
    expect(result.primers[1].name).toBe('M13-Reverse');
    expect(result.totalRows).toBe(2);
    expect(result.skippedRows).toBe(0);
  });

  it('calculates Tm and GC when not provided', () => {
    const content = `Name,Sequence
TestPrimer,ATGCGATCGATCGATCG`;

    const result = parsePrimerTabular(content);

    expect(result.primers[0].tm).toBeGreaterThan(0);
    expect(result.primers[0].gc).toBeGreaterThan(0);
    expect(result.primers[0].gc).toBeLessThanOrEqual(100);
  });

  it('uses provided Tm value', () => {
    const content = `Name,Sequence,Tm
TestPrimer,ATGCGATCGATCGATCG,55.5`;

    const result = parsePrimerTabular(content);

    expect(result.primers[0].tm).toBe(55.5);
  });

  it('generates names when missing', () => {
    const content = `Name,Sequence
,ATGCGATCGATCGATCG`;

    const result = parsePrimerTabular(content);

    expect(result.primers[0].name).toBe('Primer_1');
  });

  it('skips rows with invalid sequences', () => {
    const content = `Name,Sequence
Good,ATGCGATCGATCG
Bad,InvalidXYZ123
Another,GCTAGCTAGCTA`;

    const result = parsePrimerTabular(content);

    expect(result.primers).toHaveLength(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].row).toBe(3);
  });

  it('handles direction values', () => {
    const content = `Name,Sequence,Direction
Forward,ATGC,F
Reverse,GCTA,R
Forward2,TTTT,Forward
Reverse2,AAAA,Rev`;

    const result = parsePrimerTabular(content);

    expect(result.primers[0].direction).toBe('forward');
    expect(result.primers[1].direction).toBe('reverse');
    expect(result.primers[2].direction).toBe('forward');
    expect(result.primers[3].direction).toBe('reverse');
  });

  it('throws error for missing sequence column', () => {
    const content = `Name,Description
Primer1,Notes`;

    expect(() => parsePrimerTabular(content)).toThrow(PrimerParseError);
    expect(() => parsePrimerTabular(content)).toThrow('Could not detect sequence column');
  });

  it('throws error for no valid primers', () => {
    const content = `Name,Sequence
Bad1,InvalidXYZ123
Bad2,123456`;

    expect(() => parsePrimerTabular(content)).toThrow('No valid primers found');
  });

  it('parses TSV format', () => {
    const content = `name\tseq
Primer1\tATGC`;

    const result = parsePrimerTabular(content);

    expect(result.primers).toHaveLength(1);
    expect(result.primers[0].name).toBe('Primer1');
  });

  it('preserves original base case while removing formatting', () => {
    const content = `Name,Sequence
Test,atgc GATC gatcg`;

    const result = parsePrimerTabular(content);

    expect(result.primers[0].sequence).toBe('atgcGATCgatcg');
  });

  it('handles IUPAC ambiguity codes', () => {
    const content = `Name,Sequence
Degenerate,ATGCRYSWKMBDHVN`;

    const result = parsePrimerTabular(content);

    expect(result.primers[0].sequence).toBe('ATGCRYSWKMBDHVN');
  });
});

describe('isPrimerTabular', () => {
  it('returns true for valid primer data', () => {
    const content = `Name,Sequence
Primer1,ATGC`;

    expect(isPrimerTabular(content)).toBe(true);
  });

  it('returns false for empty or single-line content', () => {
    expect(isPrimerTabular('')).toBe(false);
    expect(isPrimerTabular('Name\n')).toBe(false);
    expect(isPrimerTabular('LOCUS pUC19')).toBe(false);
  });

  it('returns true when sequence-like column is detected', () => {
    expect(isPrimerTabular('>Seq1\nATGC')).toBe(true);

    const content = `ID,Notes
1,Some notes`;
    expect(isPrimerTabular(content)).toBe(true);
  });

  it('properly identifies clearly non-tabular content', () => {
    expect(isPrimerTabular('LOCUS       pUC19')).toBe(false);
  });
});

describe('extractTabularPreview', () => {
  it('extracts preview data for UI with headers', () => {
    const content = `Name,Sequence,Notes
Primer1,ATGC,Test1
Primer2,GCTA,Test2`;

    const preview = extractTabularPreview(content);

    expect(preview.headers).toEqual(['Name', 'Sequence', 'Notes']);
    expect(preview.rows).toHaveLength(2);
    expect(preview.rows[0]).toEqual(['Primer1', 'ATGC', 'Test1']);
    expect(preview.autoMapping.name).toBe(0);
    expect(preview.autoMapping.sequence).toBe(1);
    expect(preview.hasDetectedHeaders).toBe(true);
  });

  it('handles files without headers - generates synthetic headers', () => {
    const content = `M13-Forward,GTAAAACGACGGCCAGT,Standard primer
M13-Reverse,CAGGAAACAGCTATGAC,Standard primer`;

    const preview = extractTabularPreview(content);

    expect(preview.headers).toEqual(['Column A', 'Column B', 'Column C']);
    expect(preview.rows).toHaveLength(2);
    expect(preview.rows[0]).toEqual(['M13-Forward', 'GTAAAACGACGGCCAGT', 'Standard primer']);
    expect(preview.rows[1]).toEqual(['M13-Reverse', 'CAGGAAACAGCTATGAC', 'Standard primer']);
    expect(preview.autoMapping.name).toBe(0);
    expect(preview.autoMapping.sequence).toBe(1);
    expect(preview.hasDetectedHeaders).toBe(false);
  });

  it('handles TSV files without headers', () => {
    const content = `Primer1\tATGCGATCGATCGATCG\tDescription1
Primer2\tGCTAGCTAGCTAGCTA\tDescription2`;

    const preview = extractTabularPreview(content);

    expect(preview.headers).toEqual(['Column A', 'Column B', 'Column C']);
    expect(preview.rows).toHaveLength(2);
    expect(preview.hasDetectedHeaders).toBe(false);
  });

  it('correctly identifies headers when first row has recognizable column names', () => {
    const content = `Primer Name,Oligo Sequence,Notes
TestPrimer,ATGCGATCGATCGATCG,Test notes`;

    const preview = extractTabularPreview(content);

    expect(preview.headers).toEqual(['Primer Name', 'Oligo Sequence', 'Notes']);
    expect(preview.rows).toHaveLength(1);
    expect(preview.hasDetectedHeaders).toBe(true);
  });

  it('detects no headers when first row contains DNA sequence', () => {
    const content = `Name,ATGCGATCGATCGATCGATCG
Primer2,GCTAGCTAGCTAGCTA`;

    const preview = extractTabularPreview(content);

    expect(preview.hasDetectedHeaders).toBe(false);
    expect(preview.rows).toHaveLength(2);
  });
});

describe('parsePrimersWithMapping', () => {
  it('parses with custom column mapping', () => {
    const headers = ['ID', 'Bases', 'Notes'];
    const rows = [
      ['P1', 'ATGCGATCGATCG', 'First primer'],
      ['P2', 'GCTAGCTAGCTA', 'Second primer'],
    ];
    const mapping = {
      nameColumn: 0,
      sequenceColumn: 1,
      customColumns: { 2: 'notes' },
    };

    const result = parsePrimersWithMapping(headers, rows, mapping);

    expect(result.primers).toHaveLength(2);
    expect(result.primers[0].name).toBe('P1');
    expect(result.primers[0].sequence).toBe('ATGCGATCGATCG');
    expect(result.primers[0].metadata).toEqual({ notes: 'First primer' });
  });

  it('calculates Tm and GC (never imports from file)', () => {
    const headers = ['Name', 'Sequence', 'Tm'];
    const rows = [['Test', 'ATGCGATCGATCGATCG', '99.9']];
    const mapping = {
      nameColumn: 0,
      sequenceColumn: 1,
      customColumns: {},
    };

    const result = parsePrimersWithMapping(headers, rows, mapping);

    expect(result.primers[0].tm).not.toBe(99.9);
    expect(result.primers[0].tm).toBeGreaterThan(0);
  });

  it('includes multiple custom metadata columns', () => {
    const headers = ['Name', 'Seq', 'Target', 'Project', 'Box'];
    const rows = [['P1', 'ATGC', 'Gene1', 'ProjectA', 'B1']];
    const mapping = {
      nameColumn: 0,
      sequenceColumn: 1,
      customColumns: { 2: 'target', 3: 'project', 4: 'box_location' },
    };

    const result = parsePrimersWithMapping(headers, rows, mapping);

    expect(result.primers[0].metadata).toEqual({
      target: 'Gene1',
      project: 'ProjectA',
      box_location: 'B1',
    });
  });

  it('skips empty metadata values', () => {
    const headers = ['Name', 'Seq', 'Notes'];
    const rows = [['P1', 'ATGC', '']];
    const mapping = {
      nameColumn: 0,
      sequenceColumn: 1,
      customColumns: { 2: 'notes' },
    };

    const result = parsePrimersWithMapping(headers, rows, mapping);

    expect(result.primers[0].metadata).toEqual({});
  });
});
