// @vitest-environment node

import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { parseXlsxPreview } from './tabularFileParser';

function xlsxBuffer(rows: (string | number)[][]): Uint8Array {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Sheet1');
  return XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as Uint8Array;
}

describe('parseXlsxPreview ', () => {
  it('parses the first sheet into headers + rows', () => {
    const buf = xlsxBuffer([
      ['name', 'vendor', 'conc'],
      ['primer-A', 'IDT', 100],
      ['primer-B', 'Twist', 50],
    ]);
    const r = parseXlsxPreview(buf, { maxRows: 100 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.headers).toEqual(['name', 'vendor', 'conc']);
    expect(r.rows).toEqual([
      ['primer-A', 'IDT', '100'],
      ['primer-B', 'Twist', '50'],
    ]);
    expect(r.totalColumns).toBe(3);
  });

  it('truncates to maxRows', () => {
    const rows: (string | number)[][] = [['a', 'b']];
    for (let i = 0; i < 50; i++) rows.push([`r${i}`, i]);
    const r = parseXlsxPreview(xlsxBuffer(rows), { maxRows: 10 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows.length).toBe(10);
    expect(r.truncated).toBe(true);
  });

  it('fails gracefully on non-workbook bytes (does not throw)', () => {
    const r = parseXlsxPreview(new Uint8Array([1, 2, 3, 4]), { maxRows: 100 });
    expect(r.ok).toBe(false);
  });
});
