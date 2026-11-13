import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseCSV,
  cellsToCSV,
  csvToCells,
  isCSVLike,
  downloadCSV,
  clipboardTextToCells,
} from './csv';
import type { Cell } from '../types';

describe('parseCSV', () => {
  it('parses simple CSV', () => {
    const csv = 'a,b,c\n1,2,3';
    const result = parseCSV(csv);
    expect(result).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('handles tab-separated values', () => {
    const tsv = 'a\tb\tc\n1\t2\t3';
    const result = parseCSV(tsv);
    expect(result).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('handles quoted fields with commas', () => {
    const csv = 'name,description\ntest,"hello, world"';
    const result = parseCSV(csv);
    expect(result).toEqual([
      ['name', 'description'],
      ['test', 'hello, world'],
    ]);
  });

  it('handles quoted fields with newlines', () => {
    const csv = 'name,description\ntest,"line1\nline2"';
    const result = parseCSV(csv);
    expect(result).toEqual([
      ['name', 'description'],
      ['test', 'line1\nline2'],
    ]);
  });

  it('handles escaped quotes in quoted fields', () => {
    const csv = 'name,description\ntest,"say ""hello"""';
    const result = parseCSV(csv);
    expect(result).toEqual([
      ['name', 'description'],
      ['test', 'say "hello"'],
    ]);
  });

  it('handles CRLF line endings', () => {
    const csv = 'a,b\r\n1,2';
    const result = parseCSV(csv);
    expect(result).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('skips empty rows', () => {
    const csv = 'a,b\n\n1,2\n  \n3,4';
    const result = parseCSV(csv);
    expect(result).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('handles empty string', () => {
    const result = parseCSV('');
    expect(result).toEqual([]);
  });

  it('handles single value', () => {
    const result = parseCSV('hello');
    expect(result).toEqual([['hello']]);
  });

  it('handles carriage return only (ignored)', () => {
    const csv = 'a,b\rc,d';
    const result = parseCSV(csv);
    expect(result).toEqual([['a', 'bc', 'd']]);
  });
});

describe('cellsToCSV', () => {
  it('converts cells to CSV', () => {
    const cells: Cell[][] = [
      [
        { value: 'a', type: 'text' },
        { value: 'b', type: 'text' },
      ],
      [
        { value: '1', type: 'text' },
        { value: '2', type: 'text' },
      ],
    ];
    const result = cellsToCSV(cells);
    expect(result).toBe('a,b\n1,2');
  });

  it('quotes fields with commas', () => {
    const cells: Cell[][] = [[{ value: 'hello, world', type: 'text' }]];
    const result = cellsToCSV(cells);
    expect(result).toBe('"hello, world"');
  });

  it('quotes fields with newlines', () => {
    const cells: Cell[][] = [[{ value: 'line1\nline2', type: 'text' }]];
    const result = cellsToCSV(cells);
    expect(result).toBe('"line1\nline2"');
  });

  it('escapes quotes in quoted fields', () => {
    const cells: Cell[][] = [[{ value: 'say "hello"', type: 'text' }]];
    const result = cellsToCSV(cells);
    expect(result).toBe('"say ""hello"""');
  });

  it('uses computed value for formula cells', () => {
    const cells: Cell[][] = [[{ value: '=SUM(A1:A2)', type: 'formula', computed: 42 }]];
    const result = cellsToCSV(cells);
    expect(result).toBe('42');
  });

  it('uses value for formula cells without computed', () => {
    const cells: Cell[][] = [[{ value: '=SUM(A1:A2)', type: 'formula' }]];
    const result = cellsToCSV(cells);
    expect(result).toBe('=SUM(A1:A2)');
  });
});

describe('csvToCells', () => {
  it('converts string array to cells', () => {
    const data = [
      ['a', 'b'],
      ['1', '2'],
    ];
    const result = csvToCells(data);
    expect(result).toEqual([
      [
        { value: 'a', type: 'text' },
        { value: 'b', type: 'text' },
      ],
      [
        { value: '1', type: 'text' },
        { value: '2', type: 'text' },
      ],
    ]);
  });

  it('normalizes column count', () => {
    const data = [['a', 'b', 'c'], ['1']];
    const result = csvToCells(data);
    expect(result).toEqual([
      [
        { value: 'a', type: 'text' },
        { value: 'b', type: 'text' },
        { value: 'c', type: 'text' },
      ],
      [
        { value: '1', type: 'text' },
        { value: '', type: 'text' },
        { value: '', type: 'text' },
      ],
    ]);
  });

  it('handles empty array', () => {
    const result = csvToCells([]);
    expect(result).toEqual([]);
  });
});

describe('isCSVLike', () => {
  it('returns true for comma-separated values', () => {
    const csv = 'a,b,c\n1,2,3';
    expect(isCSVLike(csv)).toBe(true);
  });

  it('returns true for tab-separated values', () => {
    const tsv = 'a\tb\tc\n1\t2\t3';
    expect(isCSVLike(tsv)).toBe(true);
  });

  it('returns false for plain text', () => {
    const text = 'hello world\nfoo bar';
    expect(isCSVLike(text)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isCSVLike('')).toBe(false);
  });

  it('returns false for single line without delimiter', () => {
    expect(isCSVLike('hello world')).toBe(false);
  });

  it('returns true when 80%+ of rows have consistent column count', () => {
    const csv = 'a,b,c\n1,2,3\n4,5,6\n7,8,9\n10,11';
    expect(isCSVLike(csv)).toBe(true);
  });

  it('returns true when rows have inconsistent column counts but contain delimiters', () => {
    const csv = 'a,b,c\n1,2\n4\n7\n10,11,12,13';
    expect(isCSVLike(csv)).toBe(true);
  });

  it('handles CRLF line endings', () => {
    const csv = 'a,b,c\r\n1,2,3';
    expect(isCSVLike(csv)).toBe(true);
  });
});

describe('downloadCSV', () => {
  let originalCreateObjectURL: typeof URL.createObjectURL;
  let originalRevokeObjectURL: typeof URL.revokeObjectURL;

  beforeEach(() => {
    originalCreateObjectURL = URL.createObjectURL;
    originalRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn().mockReturnValue('blob:test-url');
    URL.revokeObjectURL = vi.fn();
  });

  const cleanup = () => {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    vi.restoreAllMocks();
  };

  it('creates and clicks download link', () => {
    const appendChildSpy = vi
      .spyOn(document.body, 'appendChild')
      .mockImplementation((node) => node);
    const removeChildSpy = vi
      .spyOn(document.body, 'removeChild')
      .mockImplementation((node) => node);

    const cells: Cell[][] = [
      [
        { value: 'a', type: 'text' },
        { value: 'b', type: 'text' },
      ],
    ];

    downloadCSV(cells, 'test.csv');

    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(appendChildSpy).toHaveBeenCalled();
    expect(removeChildSpy).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-url');
    cleanup();
  });

  it('uses default filename', () => {
    let capturedLink: HTMLAnchorElement | null = null;
    vi.spyOn(document.body, 'appendChild').mockImplementation((node) => {
      capturedLink = node as HTMLAnchorElement;
      return node;
    });
    vi.spyOn(document.body, 'removeChild').mockImplementation((node) => node);

    const cells: Cell[][] = [[{ value: 'a', type: 'text' }]];
    downloadCSV(cells);

    expect(capturedLink!.download).toBe('table.csv');
    cleanup();
  });
});

describe('clipboard block parsing options', () => {
  it('keeps literal commas and interior empty rows in an explicitly tab-delimited block', () => {
    expect(parseCSV('a,b\tc\n\t\nz\tw\n', { delimiter: '\t', preserveEmptyRows: true })).toEqual([
      ['a,b', 'c'],
      ['', ''],
      ['z', 'w'],
    ]);
  });
  it('retains quoted field semantics when the delimiter is explicit', () => {
    expect(parseCSV('"a\tb",c\n"d,e",f', { delimiter: ',', preserveEmptyRows: true })).toEqual([
      ['a\tb', 'c'],
      ['d,e', 'f'],
    ]);
  });
});

it('preserves quotes inside an unquoted TSV formula and still decodes quoted CSV fields', () => {
  expect(parseCSV('=CONCAT("B1",B1)\t=SUM(B1:B2)', { delimiter: '\t' })).toEqual([
    ['=CONCAT("B1",B1)', '=SUM(B1:B2)'],
  ]);
  expect(parseCSV('"=CONCAT(""B1"",B1)","a,b"', { delimiter: ',' })).toEqual([
    ['=CONCAT("B1",B1)', 'a,b'],
  ]);
  expect(parseCSV('literal"quote\t"line1\nline2"', { delimiter: '\t' })).toEqual([
    ['literal"quote', 'line1\nline2'],
  ]);
});

it('detects real TSV after an interior literal quote without misclassifying quoted CSV tabs', () => {
  expect(
    clipboardTextToCells('literal"quote\t2').map((row) => row.map((cell) => cell.value))
  ).toEqual([['literal"quote', '2']]);
  expect(
    clipboardTextToCells('=CONCAT("B1",B1)\t=SUM(B1:B2)').map((row) =>
      row.map((cell) => cell.value)
    )
  ).toEqual([['=CONCAT("B1",B1)', '=SUM(B1:B2)']]);
  expect(
    clipboardTextToCells('"a\tb",c\n"d,e",f').map((row) => row.map((cell) => cell.value))
  ).toEqual([
    ['a\tb', 'c'],
    ['d,e', 'f'],
  ]);
});
