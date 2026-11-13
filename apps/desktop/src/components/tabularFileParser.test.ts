// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { parseTabularPreview, serializeDelimitedRows } from './tabularFileParser';

describe('parseTabularPreview', () => {
  it('parses CSV headers and quoted cells containing commas', () => {
    const parsed = parseTabularPreview('sample,condition,notes\nA1,control,"alpha, beta"\n', {
      delimiter: ',',
      maxRows: 100,
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.headers).toEqual(['sample', 'condition', 'notes']);
    expect(parsed.rows).toEqual([['A1', 'control', 'alpha, beta']]);
    expect(parsed.sourceRows).toEqual([
      ['sample', 'condition', 'notes'],
      ['A1', 'control', 'alpha, beta'],
    ]);
    expect(parsed.totalRows).toBe(1);
    expect(parsed.totalSourceRows).toBe(2);
  });

  it('parses TSV without splitting commas inside cells', () => {
    const parsed = parseTabularPreview('read\tsequence\tnote\nr1\tACGT\tcomma, inside\n', {
      delimiter: '\t',
      maxRows: 100,
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.rows[0]).toEqual(['r1', 'ACGT', 'comma, inside']);
  });

  it('reports unclosed quotes instead of rendering a misleading table', () => {
    const parsed = parseTabularPreview('sample,notes\nA1,"unterminated\n', {
      delimiter: ',',
      maxRows: 100,
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatch(/unterminated quoted field/i);
  });

  it('limits stored preview rows while still counting total data rows', () => {
    const parsed = parseTabularPreview('id,value\n1,a\n2,b\n3,c\n', {
      delimiter: ',',
      maxRows: 2,
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.rows).toEqual([
      ['1', 'a'],
      ['2', 'b'],
    ]);
    expect(parsed.sourceRows).toEqual([
      ['id', 'value'],
      ['1', 'a'],
      ['2', 'b'],
    ]);
    expect(parsed.totalRows).toBe(3);
    expect(parsed.totalSourceRows).toBe(4);
    expect(parsed.truncated).toBe(true);
  });

  it('drops an incomplete trailing row from sliced oversized input', () => {
    const parsed = parseTabularPreview('id\tvalue\n1\talpha\n2\tbeta\n3\tpart', {
      delimiter: '\t',
      maxRows: 100,
      inputTruncated: true,
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.sourceRows).toEqual([
      ['id', 'value'],
      ['1', 'alpha'],
      ['2', 'beta'],
    ]);
    expect(parsed.rows).toEqual([
      ['1', 'alpha'],
      ['2', 'beta'],
    ]);
    expect(parsed.truncated).toBe(true);
  });
});

describe('serializeDelimitedRows', () => {
  it('quotes CSV fields only when required and escapes quotes', () => {
    expect(
      serializeDelimitedRows(
        [
          ['sample', 'notes'],
          ['A1', 'contains comma, here'],
          ['A2', 'escaped "quote"'],
        ],
        ','
      )
    ).toBe('sample,notes\nA1,"contains comma, here"\nA2,"escaped ""quote"""');
  });

  it('quotes TSV fields containing tabs or newlines', () => {
    expect(
      serializeDelimitedRows(
        [
          ['read', 'note'],
          ['r1', 'tab\tinside'],
          ['r2', 'line\nbreak'],
        ],
        '\t'
      )
    ).toBe('read\tnote\nr1\t"tab\tinside"\nr2\t"line\nbreak"');
  });
});
