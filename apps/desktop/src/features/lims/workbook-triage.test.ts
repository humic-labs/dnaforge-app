// @vitest-environment node

import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';

import { SHEET_VERDICTS } from '../../shared/lims';
import { build187SheetWorkbook } from './__fixtures__/messy-workbook';
import { boundedSheetRange, triageWorkbook } from './workbook-triage';

describe('triageWorkbook', () => {
  const workbook = XLSX.read(build187SheetWorkbook(), { type: 'array' });
  const triage = triageWorkbook(workbook);

  it('is EXHAUSTIVE — one visible disposition per sheet, nothing invisibly excluded', () => {
    expect(triage.sheetsTotal).toBe(187);
    expect(triage.sheets).toHaveLength(187);
    expect(triage.sheets.length).toBe(triage.sheetsTotal);
    expect(triage.sheets.length).toBe(workbook.SheetNames.length);
  });

  it('gives every sheet a verdict drawn from SHEET_VERDICTS', () => {
    for (const disposition of triage.sheets) {
      expect(SHEET_VERDICTS).toContain(disposition.verdict);
    }
  });

  it('preserves SheetNames order', () => {
    expect(triage.sheets.map((s) => s.sheetName)).toEqual(workbook.SheetNames);
  });

  it('classifies exactly the two real tables as entity-table', () => {
    expect(triage.entitySheetNames).toEqual(['Strains', 'Oligos']);
  });

  it('detects the header buried under a title + blank spacer (Strains, headerRowIndex 2)', () => {
    const strains = triage.sheets.find((s) => s.sheetName === 'Strains');
    expect(strains?.verdict).toBe('entity-table');
    expect(strains?.headerRowIndex).toBe(2);
    expect(strains?.rowCount).toBe(34);
  });

  it('recognizes the headerless plate grid (Oligos) as an entity-table via its sequence column', () => {
    const oligos = triage.sheets.find((s) => s.sheetName === 'Oligos');
    expect(oligos?.verdict).toBe('entity-table');
    expect(oligos?.headerRowIndex).toBeUndefined();
  });

  it('flags the side-by-side sheet as leftover-region, not a clean entity table', () => {
    const sideBySide = triage.sheets.find((s) => s.sheetName === 'SideBySide');
    expect(sideBySide?.verdict).toBe('leftover-region');
  });

  it('keeps a real-but-tiny entity sheet VISIBLE as possible-table (never absent)', () => {
    const tiny = triage.sheets.find((s) => s.sheetName === 'TinyPrimers');
    expect(tiny).toBeDefined();
    expect(tiny?.verdict).toBe('possible-table');
    expect(triage.entitySheetNames).not.toContain('TinyPrimers');
  });
});

describe('boundedSheetRange — OOM/freeze guard ', () => {
  it('caps a bloated `!ref` (stray cell near XFD1048576) so the read is finite, not ~17e9 cells', () => {
    const bounded = boundedSheetRange(
      { '!ref': 'A1:XFD1048576' },
      { maxRows: 100_000, maxCols: 512 }
    );
    expect(bounded.range).toBeDefined();
    expect(bounded.clippedCols).toBeGreaterThan(15_000);
    expect(bounded.clippedRows).toBeGreaterThan(900_000);
    const decoded = XLSX.utils.decode_range(bounded.range!);
    expect(decoded.e.c).toBe(511);
    expect(decoded.e.r).toBe(99_999);
  });

  it('does NOT clip a sheet already within the caps (range undefined = read everything)', () => {
    const bounded = boundedSheetRange({ '!ref': 'A1:D40' }, { maxRows: 100_000, maxCols: 512 });
    expect(bounded.range).toBeUndefined();
    expect(bounded.clippedRows).toBe(0);
    expect(bounded.clippedCols).toBe(0);
  });

  it('is a no-op for a sheet with no declared range', () => {
    expect(boundedSheetRange(undefined, { maxRows: 10, maxCols: 10 }).range).toBeUndefined();
    expect(boundedSheetRange({}, { maxRows: 10, maxCols: 10 }).range).toBeUndefined();
  });
});
