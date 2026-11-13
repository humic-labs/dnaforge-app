// @vitest-environment node

import { describe, it, expect } from 'vitest';
import {
  evaluateFormula,
  evaluateAllFormulas,
  isFormula,
  columnIndexToLetter,
  getSupportedFormulas,
  adjustFormula,
  fillFormula,
  filterFormulaOptions,
  buildFormulaReferenceText,
  closeUnclosedFormula,
  insertCellReferenceAtCursor,
} from './formulas';
import type { Cell } from '../types';

const cell = (value: string, type: 'text' | 'number' | 'formula' = 'text'): Cell => ({
  value,
  type,
});

const numCell = (value: number): Cell => ({
  value: String(value),
  type: 'number',
});

const sampleCells: Cell[][] = [
  [numCell(10), numCell(20), numCell(30)],
  [numCell(5), numCell(15), numCell(25)],
  [numCell(100), numCell(200), numCell(300)],
  [cell('hello'), cell('world'), cell('')],
];

describe('Formula Engine', () => {
  it('never evaluates a saved source result beginning with an equals sign', () => {
    const saved = {
      value: '=1+1',
      type: 'text' as const,
      sourceFormula: '=BENCHLING(A1)',
      sourceRenderedValue: '=1+1',
      formulaCompatibility: 'unsupported' as const,
      stale: false,
    };
    expect(evaluateAllFormulas([[saved]])).toEqual([[saved]]);
  });
  describe('isFormula', () => {
    it('should detect formulas starting with =', () => {
      expect(isFormula('=SUM(A1:A3)')).toBe(true);
      expect(isFormula('= SUM(A1:A3)')).toBe(true);
      expect(isFormula('  =A1')).toBe(true);
    });

    it('should not detect non-formulas', () => {
      expect(isFormula('SUM(A1:A3)')).toBe(false);
      expect(isFormula('hello')).toBe(false);
      expect(isFormula('123')).toBe(false);
    });
  });

  describe('columnIndexToLetter', () => {
    it('should convert indices to letters', () => {
      expect(columnIndexToLetter(0)).toBe('A');
      expect(columnIndexToLetter(1)).toBe('B');
      expect(columnIndexToLetter(25)).toBe('Z');
      expect(columnIndexToLetter(26)).toBe('AA');
      expect(columnIndexToLetter(27)).toBe('AB');
      expect(columnIndexToLetter(701)).toBe('ZZ');
    });
  });

  describe('Cell References', () => {
    it('should resolve simple cell references', () => {
      expect(evaluateFormula('=A1', sampleCells, 3, 0)).toBe('10');
      expect(evaluateFormula('=B2', sampleCells, 3, 0)).toBe('15');
      expect(evaluateFormula('=C3', sampleCells, 3, 0)).toBe('300');
    });

    it('should return #REF for invalid references', () => {
      expect(evaluateFormula('=Z99', sampleCells, 0, 0)).toBe('#REF');
    });

    it('should return #REF for self-reference', () => {
      expect(evaluateFormula('=A1', sampleCells, 0, 0)).toBe('#REF');
    });
  });

  describe('Aggregate Functions', () => {
    it('SUM should add numbers in range', () => {
      expect(evaluateFormula('=SUM(A1:A3)', sampleCells, 3, 3)).toBe(115);
      expect(evaluateFormula('=SUM(A1:C1)', sampleCells, 3, 3)).toBe(60);
      expect(evaluateFormula('=SUM(A1:C3)', sampleCells, 3, 3)).toBe(705);
    });

    it('AVG should calculate average', () => {
      expect(evaluateFormula('=AVG(A1:A3)', sampleCells, 3, 3)).toBeCloseTo(38.333, 2);
      expect(evaluateFormula('=AVG(A1:C1)', sampleCells, 3, 3)).toBe(20);
    });

    it('COUNT should count numeric cells', () => {
      expect(evaluateFormula('=COUNT(A1:A3)', sampleCells, 3, 3)).toBe(3);
      expect(evaluateFormula('=COUNT(A1:C4)', sampleCells, 3, 3)).toBe(9);
    });

    it('MIN should find minimum', () => {
      expect(evaluateFormula('=MIN(A1:A3)', sampleCells, 3, 3)).toBe(5);
      expect(evaluateFormula('=MIN(A1:C3)', sampleCells, 3, 3)).toBe(5);
    });

    it('MAX should find maximum', () => {
      expect(evaluateFormula('=MAX(A1:A3)', sampleCells, 3, 3)).toBe(100);
      expect(evaluateFormula('=MAX(A1:C3)', sampleCells, 3, 3)).toBe(300);
    });

    it('MEDIAN should find middle value', () => {
      expect(evaluateFormula('=MEDIAN(A1:A3)', sampleCells, 3, 3)).toBe(10);
      expect(evaluateFormula('=MEDIAN(A1:B1)', sampleCells, 3, 3)).toBe(15);
    });

    it('PRODUCT should multiply all values', () => {
      expect(evaluateFormula('=PRODUCT(A1:A3)', sampleCells, 3, 3)).toBe(5000);
      expect(evaluateFormula('=PRODUCT(A1:C1)', sampleCells, 3, 3)).toBe(6000);
    });
  });

  describe('Math Functions', () => {
    it('ROUND should round to decimal places', () => {
      const cells: Cell[][] = [[numCell(3.14159)]];
      expect(evaluateFormula('=ROUND(A1, 2)', cells, 1, 0)).toBe(3.14);
      expect(evaluateFormula('=ROUND(A1, 0)', cells, 1, 0)).toBe(3);
      expect(evaluateFormula('=ROUND(A1, 4)', cells, 1, 0)).toBe(3.1416);
    });

    it('ABS should return absolute value', () => {
      const cells: Cell[][] = [[numCell(-50), numCell(30)]];
      expect(evaluateFormula('=ABS(A1)', cells, 1, 0)).toBe(50);
      expect(evaluateFormula('=ABS(B1)', cells, 1, 0)).toBe(30);
    });

    it('SQRT should return square root', () => {
      const cells: Cell[][] = [[numCell(16), numCell(2)]];
      expect(evaluateFormula('=SQRT(A1)', cells, 1, 0)).toBe(4);
      expect(evaluateFormula('=SQRT(B1)', cells, 1, 0)).toBeCloseTo(1.414, 2);
    });

    it('SQRT should return #NUM! for negative numbers', () => {
      const cells: Cell[][] = [[numCell(-4)]];
      expect(evaluateFormula('=SQRT(A1)', cells, 1, 0)).toBe('#NUM!');
    });

    it('POWER should raise to power', () => {
      expect(evaluateFormula('=POWER(2, 8)', sampleCells, 3, 3)).toBe(256);
      expect(evaluateFormula('=POWER(A1, 2)', sampleCells, 3, 3)).toBe(100);
    });
  });

  describe('Text Functions', () => {
    it('LEN should return string length', () => {
      expect(evaluateFormula('=LEN(A4)', sampleCells, 3, 3)).toBe(5);
      expect(evaluateFormula('=LEN("test")', sampleCells, 3, 3)).toBe(4);
    });

    it('TRIM should remove extra spaces', () => {
      const cells: Cell[][] = [[cell('  hello  world  ')]];
      expect(evaluateFormula('=TRIM(A1)', cells, 1, 0)).toBe('hello world');
    });

    it('UPPER should convert to uppercase', () => {
      expect(evaluateFormula('=UPPER(A4)', sampleCells, 3, 3)).toBe('HELLO');
      expect(evaluateFormula('=UPPER("Test")', sampleCells, 3, 3)).toBe('TEST');
    });

    it('LOWER should convert to lowercase', () => {
      expect(evaluateFormula('=LOWER("HELLO")', sampleCells, 3, 3)).toBe('hello');
    });

    it('LEFT should extract first N characters', () => {
      expect(evaluateFormula('=LEFT(A4, 3)', sampleCells, 3, 3)).toBe('hel');
      expect(evaluateFormula('=LEFT("testing", 4)', sampleCells, 3, 3)).toBe('test');
    });

    it('RIGHT should extract last N characters', () => {
      expect(evaluateFormula('=RIGHT(A4, 3)', sampleCells, 3, 3)).toBe('llo');
      expect(evaluateFormula('=RIGHT("testing", 4)', sampleCells, 3, 3)).toBe('ting');
    });

    it('MID should extract substring', () => {
      expect(evaluateFormula('=MID(A4, 2, 3)', sampleCells, 3, 3)).toBe('ell');
      expect(evaluateFormula('=MID("testing", 4, 2)', sampleCells, 3, 3)).toBe('ti');
    });

    it('CONCAT should join strings', () => {
      expect(evaluateFormula('=CONCAT(A4, " ", B4)', sampleCells, 3, 3)).toBe('hello world');
      expect(evaluateFormula('=CONCAT("a", "b", "c")', sampleCells, 3, 3)).toBe('abc');
    });

    it('SUBSTITUTE should replace text', () => {
      expect(evaluateFormula('=SUBSTITUTE(A4, "l", "L")', sampleCells, 3, 3)).toBe('heLLo');
      expect(evaluateFormula('=SUBSTITUTE("aaa", "a", "b", 2)', sampleCells, 3, 3)).toBe('aba');
    });
  });

  describe('Logical Functions', () => {
    it('IF should return value based on condition', () => {
      expect(evaluateFormula('=IF(A1>5, "big", "small")', sampleCells, 3, 3)).toBe('big');
      expect(evaluateFormula('=IF(A2>5, "big", "small")', sampleCells, 3, 3)).toBe('small');
      expect(evaluateFormula('=IF(A1=10, "yes", "no")', sampleCells, 3, 3)).toBe('yes');
    });

    it('IF with comparison operators', () => {
      expect(evaluateFormula('=IF(A1>=10, "yes", "no")', sampleCells, 3, 3)).toBe('yes');
      expect(evaluateFormula('=IF(A1<=10, "yes", "no")', sampleCells, 3, 3)).toBe('yes');
      expect(evaluateFormula('=IF(A1<>10, "yes", "no")', sampleCells, 3, 3)).toBe('no');
    });

    it('AND should return true when all conditions true', () => {
      expect(evaluateFormula('=AND(A1>5, B1>5)', sampleCells, 3, 3)).toBe('TRUE');
      expect(evaluateFormula('=AND(A1>5, A2>5)', sampleCells, 3, 3)).toBe('FALSE');
    });

    it('OR should return true when any condition true', () => {
      expect(evaluateFormula('=OR(A1>100, B1>5)', sampleCells, 3, 3)).toBe('TRUE');
      expect(evaluateFormula('=OR(A1>100, B1>100)', sampleCells, 3, 3)).toBe('FALSE');
    });

    it('NOT should negate condition', () => {
      expect(evaluateFormula('=NOT(A1>100)', sampleCells, 3, 3)).toBe('TRUE');
      expect(evaluateFormula('=NOT(A1>5)', sampleCells, 3, 3)).toBe('FALSE');
    });

    it('ISBLANK should check for empty cells', () => {
      expect(evaluateFormula('=ISBLANK(C4)', sampleCells, 3, 3)).toBe('TRUE');
      expect(evaluateFormula('=ISBLANK(A4)', sampleCells, 3, 3)).toBe('FALSE');
    });

    it('ISNUMBER should check for numeric values', () => {
      expect(evaluateFormula('=ISNUMBER(A1)', sampleCells, 3, 3)).toBe('TRUE');
      expect(evaluateFormula('=ISNUMBER(A4)', sampleCells, 3, 3)).toBe('FALSE');
    });

    it('IFERROR should handle errors gracefully', () => {
      expect(evaluateFormula('=IFERROR(Z99, "fallback")', sampleCells, 3, 3)).toBe('fallback');
      expect(evaluateFormula('=IFERROR(A1, "fallback")', sampleCells, 3, 3)).toBe('10');
    });
  });

  describe('String literals containing parentheses ', () => {
    it('does not end the argument list at a paren inside a literal', () => {
      expect(evaluateFormula('=LEN("a)b")', sampleCells, 3, 3)).toBe(3);
      expect(evaluateFormula('=UPPER("x)y")', sampleCells, 3, 3)).toBe('X)Y');
      expect(evaluateFormula('=CONCAT("a)b","c")', sampleCells, 3, 3)).toBe('a)bc');
    });

    it('does not count an open paren inside a literal as nesting', () => {
      expect(evaluateFormula('=CONCAT("a(b","c")', sampleCells, 3, 3)).toBe('a(bc');
      expect(evaluateFormula('=CONCAT("(",")")', sampleCells, 3, 3)).toBe('()');
    });

    it('handles single-quoted literals the same way', () => {
      expect(evaluateFormula("=LEN('a)b')", sampleCells, 3, 3)).toBe(3);
    });

    it('still resolves a nested call alongside a literal paren', () => {
      expect(evaluateFormula('=CONCAT("(",UPPER(A4))', sampleCells, 3, 3)).toBe('(HELLO');
    });

    it('leaves a genuinely unclosed call evaluating on an empty argument list', () => {
      expect(evaluateFormula('=SUM(A1:A3', sampleCells, 3, 3)).toBe(0);
    });
  });

  describe('Nested Functions', () => {
    it('should handle nested function calls', () => {
      expect(evaluateFormula('=ROUND(AVG(A1:A3), 1)', sampleCells, 3, 3)).toBeCloseTo(38.3, 1);
      expect(evaluateFormula('=IF(SUM(A1:A2)>10, "yes", "no")', sampleCells, 3, 3)).toBe('yes');
      expect(evaluateFormula('=UPPER(CONCAT(A4, B4))', sampleCells, 3, 3)).toBe('HELLOWORLD');
    });

    it('should handle complex nested conditions', () => {
      expect(evaluateFormula('=IF(AND(A1>5, B1>10), SUM(A1:B1), 0)', sampleCells, 3, 3)).toBe(30);
      expect(evaluateFormula('=IF(OR(A1>100, A3>50), "big", "small")', sampleCells, 3, 3)).toBe(
        'big'
      );
    });
  });

  describe('Error Handling', () => {
    it('should return #NAME? for unknown functions', () => {
      expect(evaluateFormula('=UNKNOWN(A1)', sampleCells, 3, 3)).toBe('#NAME?');
    });

    it('should return #VALUE! for wrong argument types', () => {
      expect(evaluateFormula('=SQRT()', sampleCells, 3, 3)).toBe('#VALUE!');
      expect(evaluateFormula('=ROUND()', sampleCells, 3, 3)).toBe('#VALUE!');
    });
  });

  describe('evaluateAllFormulas', () => {
    it('should evaluate all formula cells in a grid', () => {
      const cellsWithFormulas: Cell[][] = [
        [numCell(10), numCell(20), cell('=SUM(A1:B1)', 'formula')],
        [numCell(5), numCell(15), cell('=A1+A2', 'formula')],
      ];

      const result = evaluateAllFormulas(cellsWithFormulas);

      expect(result[0][2].computed).toBe(30);
    });

    it('should preserve non-formula cells', () => {
      const result = evaluateAllFormulas(sampleCells);
      expect(result[0][0].value).toBe('10');
      expect(result[3][0].value).toBe('hello');
    });
  });

  describe('getSupportedFormulas', () => {
    it('should return sorted list of all supported formulas', () => {
      const formulas = getSupportedFormulas();
      expect(formulas).toContain('SUM');
      expect(formulas).toContain('IF');
      expect(formulas).toContain('CONCAT');
      expect(formulas).toContain('ROUND');
      expect(formulas).toEqual([...formulas].sort());
    });
  });

  describe('Absolute References ($)', () => {
    it('should evaluate formulas with absolute column reference ($A1)', () => {
      expect(evaluateFormula('=$A1', sampleCells, 3, 3)).toBe('10');
    });

    it('should evaluate formulas with absolute row reference (A$1)', () => {
      expect(evaluateFormula('=A$1', sampleCells, 3, 3)).toBe('10');
    });

    it('should evaluate formulas with fully absolute reference ($A$1)', () => {
      expect(evaluateFormula('=$A$1', sampleCells, 3, 3)).toBe('10');
    });

    it('should evaluate SUM with absolute references', () => {
      expect(evaluateFormula('=SUM($A1:$A3)', sampleCells, 3, 3)).toBe(115);
      expect(evaluateFormula('=SUM(A$1:A$3)', sampleCells, 3, 3)).toBe(115);
    });
  });

  describe('adjustFormula', () => {
    const maxRow = 99;
    const maxCol = 25;

    it('should shift relative references', () => {
      expect(adjustFormula('=A1', 1, 0, maxRow, maxCol)).toBe('=A2');
      expect(adjustFormula('=A1', 0, 1, maxRow, maxCol)).toBe('=B1');
      expect(adjustFormula('=A1', 2, 2, maxRow, maxCol)).toBe('=C3');
    });

    it('should preserve absolute column references ($A1)', () => {
      expect(adjustFormula('=$A1', 0, 2, maxRow, maxCol)).toBe('=$A1');
      expect(adjustFormula('=$A1', 1, 0, maxRow, maxCol)).toBe('=$A2');
    });

    it('should preserve absolute row references (A$1)', () => {
      expect(adjustFormula('=A$1', 2, 0, maxRow, maxCol)).toBe('=A$1');
      expect(adjustFormula('=A$1', 0, 1, maxRow, maxCol)).toBe('=B$1');
    });

    it('should preserve fully absolute references ($A$1)', () => {
      expect(adjustFormula('=$A$1', 5, 5, maxRow, maxCol)).toBe('=$A$1');
      expect(adjustFormula('=$A$1', -5, -5, maxRow, maxCol)).toBe('=$A$1');
    });

    it('should adjust complex formulas with mixed references', () => {
      expect(adjustFormula('=SUM(A1:$B$2)', 1, 0, maxRow, maxCol)).toBe('=SUM(A2:$B$2)');
      expect(adjustFormula('=IF($A1>B$1, C1, D1)', 0, 1, maxRow, maxCol)).toBe(
        '=IF($A1>C$1, D1, E1)'
      );
    });

    it('should return #REF! when reference goes out of bounds', () => {
      expect(adjustFormula('=A1', -1, 0, maxRow, maxCol)).toBe('=#REF!');
      expect(adjustFormula('=A1', 0, -1, maxRow, maxCol)).toBe('=#REF!');
      expect(adjustFormula('=Z1', 0, 1, maxRow, 25)).toBe('=#REF!');
    });

    it('should not modify non-formula strings', () => {
      expect(adjustFormula('hello', 1, 1, maxRow, maxCol)).toBe('hello');
      expect(adjustFormula('123', 1, 1, maxRow, maxCol)).toBe('123');
    });

    it('should handle ranges correctly', () => {
      expect(adjustFormula('=SUM(A1:B2)', 1, 0, maxRow, maxCol)).toBe('=SUM(A2:B3)');
      expect(adjustFormula('=SUM(A1:B2)', 0, 1, maxRow, maxCol)).toBe('=SUM(B1:C2)');
    });
  });

  describe('fillFormula', () => {
    const maxRow = 99;
    const maxCol = 25;

    it('should fill formula from source to target', () => {
      expect(fillFormula('=B1+C1', 0, 0, 1, 0, maxRow, maxCol)).toBe('=B2+C2');
      expect(fillFormula('=A1*2', 0, 0, 0, 1, maxRow, maxCol)).toBe('=B1*2');
    });

    it('should respect absolute references when filling', () => {
      expect(fillFormula('=SUM($A$1:$A1)', 0, 0, 2, 0, maxRow, maxCol)).toBe('=SUM($A$1:$A3)');
    });

    it('should handle diagonal fills', () => {
      expect(fillFormula('=A1', 0, 0, 2, 2, maxRow, maxCol)).toBe('=C3');
    });
  });

  describe('filterFormulaOptions', () => {
    it('returns all options for an empty search term', () => {
      const all = filterFormulaOptions('');
      expect(all.length).toBeGreaterThan(0);
      expect(all.find((o) => o.name === 'SUM')).toBeDefined();
      expect(all.find((o) => o.name === 'IF')).toBeDefined();
    });

    it('filters by case-insensitive prefix', () => {
      const lower = filterFormulaOptions('su').map((o) => o.name);
      const upper = filterFormulaOptions('SU').map((o) => o.name);
      expect(lower).toEqual(upper);
      expect(lower).toContain('SUM');
      expect(lower.every((n) => n.startsWith('SU'))).toBe(true);
    });

    it('returns options whose names start with the prefix', () => {
      const names = filterFormulaOptions('I').map((o) => o.name);
      expect(names).toEqual(expect.arrayContaining(['IF', 'IFERROR']));
      expect(names.every((n) => n.startsWith('I'))).toBe(true);
    });

    it('returns empty array when nothing matches', () => {
      expect(filterFormulaOptions('xyz')).toEqual([]);
    });
  });

  describe('buildFormulaReferenceText', () => {
    const B2 = { row: 1, col: 1 };
    const D4 = { row: 3, col: 3 };

    it('returns single-cell ref when selection is null', () => {
      expect(buildFormulaReferenceText(B2, null)).toBe('B2');
    });

    it('returns single-cell ref when selection is a single cell at anchor', () => {
      expect(
        buildFormulaReferenceText(B2, {
          startRow: 1,
          startCol: 1,
          endRow: 1,
          endCol: 1,
        })
      ).toBe('B2');
    });

    it('returns range B2:D4 for a forward drag (anchor=B2, selection=B2:D4)', () => {
      expect(
        buildFormulaReferenceText(B2, {
          startRow: 1,
          startCol: 1,
          endRow: 3,
          endCol: 3,
        })
      ).toBe('B2:D4');
    });

    it('returns range B2:D4 for a backward drag (anchor=D4, normalized selection=B2:D4)', () => {
      expect(
        buildFormulaReferenceText(D4, {
          startRow: 1,
          startCol: 1,
          endRow: 3,
          endCol: 3,
        })
      ).toBe('B2:D4');
    });

    it('returns range for a single-row span (B2:D2)', () => {
      expect(
        buildFormulaReferenceText(B2, {
          startRow: 1,
          startCol: 1,
          endRow: 1,
          endCol: 3,
        })
      ).toBe('B2:D2');
    });

    it('returns range for a single-column span (B2:B4)', () => {
      expect(
        buildFormulaReferenceText(B2, {
          startRow: 1,
          startCol: 1,
          endRow: 3,
          endCol: 1,
        })
      ).toBe('B2:B4');
    });
  });

  describe('closeUnclosedFormula', () => {
    it('passes through non-formulas unchanged', () => {
      expect(closeUnclosedFormula('hello')).toBe('hello');
      expect(closeUnclosedFormula('123')).toBe('123');
      expect(closeUnclosedFormula('')).toBe('');
    });

    it('appends ) when exactly one paren is unclosed', () => {
      expect(closeUnclosedFormula('=SUM(A1:A3')).toBe('=SUM(A1:A3)');
      expect(closeUnclosedFormula('=AVG(B1')).toBe('=AVG(B1)');
      expect(closeUnclosedFormula('=sum(C2:D3')).toBe('=sum(C2:D3)');
    });

    it('leaves balanced formulas alone', () => {
      expect(closeUnclosedFormula('=SUM(A1:A3)')).toBe('=SUM(A1:A3)');
      expect(closeUnclosedFormula('=A1+B1')).toBe('=A1+B1');
      expect(closeUnclosedFormula('=IF(A1>0, "yes", "no")')).toBe('=IF(A1>0, "yes", "no")');
    });

    it('leaves multi-unclosed formulas alone (user likely still typing)', () => {
      expect(closeUnclosedFormula('=SUM(IF(A1>0')).toBe('=SUM(IF(A1>0');
      expect(closeUnclosedFormula('=IF(AND(A1>0,B1<5')).toBe('=IF(AND(A1>0,B1<5');
    });

    it('leaves over-closed formulas alone', () => {
      expect(closeUnclosedFormula('=SUM(A1))')).toBe('=SUM(A1))');
      expect(closeUnclosedFormula('=A1)')).toBe('=A1)');
    });

    it('ignores parens inside string literals', () => {
      expect(closeUnclosedFormula('=CONCAT("(text)"')).toBe('=CONCAT("(text)")');
      expect(closeUnclosedFormula('=CONCAT("hello"')).toBe('=CONCAT("hello")');
    });

    it('does not close while a string literal is still open', () => {
      expect(closeUnclosedFormula('=CONCAT("unfinished')).toBe('=CONCAT("unfinished');
    });

    it('handles single-quoted string literals', () => {
      expect(closeUnclosedFormula("=CONCAT('a','b'")).toBe("=CONCAT('a','b')");
    });
  });

  describe('insertCellReferenceAtCursor', () => {
    const insert = (value: string, ref: string) =>
      insertCellReferenceAtCursor(value, value.length, ref).newValue;

    it('inserts after = without a separator', () => {
      expect(insert('=', 'A1')).toBe('=A1');
    });

    it('inserts after ( without a separator', () => {
      expect(insert('=SUM(', 'A1')).toBe('=SUM(A1');
    });

    it('inserts after , without an extra separator', () => {
      expect(insert('=SUM(A1,', 'B1')).toBe('=SUM(A1,B1');
    });

    it('inserts after : as a range continuation (no separator)', () => {
      expect(insert('=SUM(A1:', 'B5')).toBe('=SUM(A1:B5');
    });

    it.each(['+', '-', '*', '/'])('inserts after arithmetic operator %s without a comma', (op) => {
      expect(insert(`=A1${op}`, 'B1')).toBe(`=A1${op}B1`);
    });

    it('replaces an existing cell ref at the cursor', () => {
      expect(insert('=SUM(A1', 'B2')).toBe('=SUM(B2');
    });

    it('replaces a range end at the cursor (keeps colon + start)', () => {
      expect(insert('=SUM(A1:B2', 'C3')).toBe('=SUM(A1:C3');
    });

    it('falls through to comma separator after a non-operator character', () => {
      expect(insert('=42', 'B1')).toBe('=42,B1');
    });

    it('returns updated cursor position pointing past the inserted ref', () => {
      const r = insertCellReferenceAtCursor('=A1+', 4, 'B1');
      expect(r.newValue).toBe('=A1+B1');
      expect(r.newCursorPosition).toBe(6);
    });
  });
});

describe('T3 formula revision dependencies', () => {
  const formula = (value: string, computed = -999): Cell => ({ value, type: 'formula', computed });
  const results = (cells: Cell[][]) =>
    evaluateAllFormulas(cells).map((row) =>
      row.map((value) => (value.type === 'formula' ? value.computed : value.value))
    );

  it('resolves A1=2, B1=A1+1, C1=B1+1 without mutating raw expressions or stale caches', () => {
    const cells = [[numCell(2), formula('=A1+1'), formula('=B1+1')]];
    const before = JSON.stringify(cells);
    expect(results(cells)).toEqual([['2', 3, 4]]);
    expect(JSON.stringify(cells)).toBe(before);
    const edited = [[numCell(10), ...cells[0].slice(1)]];
    expect(results(edited)).toEqual([['10', 11, 12]]);
    expect(results(cells)).toEqual([['2', 3, 4]]);
    expect(evaluateFormula('=B1+1', cells, 0, 2)).toBe(4);
  });

  it('resolves forward and reverse row chains independently of visitation order', () => {
    expect(results([[numCell(2)], [formula('=A1+1')], [formula('=A2+1')]])).toEqual([
      ['2'],
      [3],
      [4],
    ]);
    expect(results([[formula('=A2+1')], [formula('=A3+1')], [numCell(2)]])).toEqual([
      [4],
      [3],
      ['2'],
    ]);
  });

  it('shares results across diamonds, ranges, nested calls and conditional/logical arguments', () => {
    const cells = [
      [
        numCell(2),
        formula('=A1+1'),
        formula('=A1*2'),
        formula('=B1+C1'),
        formula('=SUM(B1:D1)'),
        formula('=ROUND(AVG(B1:D1),2)'),
        formula('=IF(AND(B1>2,C1>3),SUM(B1:D1),0)'),
        formula('=CONCAT("value:",D1)'),
      ],
    ];
    expect(results(cells)).toEqual([['2', 3, 4, 7, 14, 4.67, 14, 'value:7']]);
  });

  it.each([
    ['direct', [[formula('=A1')]], [['#REF']]],
    ['indirect', [[formula('=B1'), formula('=A1')]], [['#REF', '#REF']]],
    ['range', [[formula('=SUM(A1:B1)'), numCell(2)]], [['#REF', '2']]],
    [
      'range diamond',
      [[formula('=SUM(B1:C1)'), formula('=A1'), numCell(2)]],
      [['#REF', '#REF', '2']],
    ],
    ['masked cycle', [[formula('=IFERROR(B1,7)'), formula('=A1')]], [['#REF', '#REF']]],
  ] as const)(
    'reports %s cycles instead of a partial sum or cached value',
    (_name, cells, expected) => {
      expect(results(cells.map((row) => [...row]))).toEqual(expected);
    }
  );

  it('propagates range/math/text/condition errors and lets an outside IFERROR recover', () => {
    const cells = [
      [
        formula('=1/0'),
        formula('=SUM(A1:A1)'),
        formula('=ROUND(A1,2)'),
        formula('=LEN(A1)'),
        formula('=IF(A1>0,1,2)'),
        formula('=IFERROR(SUM(A1:A1),17)'),
        formula('=IFERROR(ROUND(A1,2),19)'),
        formula('=IF(1>0,23,A1)'),
      ],
    ];
    expect(results(cells)).toEqual([
      ['#DIV/0!', '#DIV/0!', '#DIV/0!', '#DIV/0!', '#DIV/0!', 17, 19, 23],
    ]);
    expect(results([[formula('=B1'), formula('=A1'), formula('=IFERROR(A1,29)')]])).toEqual([
      ['#REF', '#REF', 29],
    ]);
    expect(evaluateFormula('=AND(0,Z999)', [], 0, 0)).toBe('FALSE');
    expect(evaluateFormula('=OR(1,Z999)', [], 0, 0)).toBe('TRUE');
  });

  it.each([
    '=Z99',
    '=A0',
    '=A999999999999999999999',
    '=SUM(A1:Z999999999999999999999)',
    '=SUM(A0:A1)',
    '=IF(A99>0,1,2)',
  ])('rejects invalid or out-of-grid input %s', (value) => {
    expect(evaluateFormula(value, [[numCell(2)]], 1, 1)).toBe('#REF');
  });

  it('uses an iterative grid walk for a deep forward chain and bounds nested expressions', () => {
    const cells: Cell[][] = Array.from({ length: 2_000 }, (_, row) => [
      row === 1_999 ? numCell(2) : formula(`=A${row + 2}+1`),
    ]);
    const calculated = evaluateAllFormulas(cells);
    expect(calculated[0][0].computed).toBe(2_001);
    expect(calculated[1_998][0].computed).toBe(3);
    expect(evaluateFormula('=' + 'ABS('.repeat(200) + '1' + ')'.repeat(200), [], 0, 0)).toBe(
      '#ERROR'
    );
    expect(evaluateFormula('=' + '('.repeat(200) + '1+1' + ')'.repeat(200), [], 0, 0)).toBe(
      '#ERROR'
    );
  });

  it('retains literal controls, error literals and unsupported saved-result provenance in both shapes', () => {
    const textSaved: Cell = {
      value: '41',
      type: 'text',
      sourceFormula: '=UNSUPPORTED(A1)',
      sourceRenderedValue: '41',
      formulaCompatibility: 'unsupported',
      stale: true,
    };
    const formulaSaved: Cell = {
      value: '=UNSUPPORTED(A1)',
      type: 'formula',
      computed: '43',
      formulaCompatibility: 'unsupported',
      stale: false,
    };
    const cells = [
      [
        textSaved,
        formulaSaved,
        formula('=SUM(A1:B1)'),
        formula('=ROUND(1.2345,2)'),
        formula('=SUM(2,3)'),
        formula('=#REF!'),
      ],
    ];
    const calculated = evaluateAllFormulas(cells);
    expect(calculated[0][0]).toBe(textSaved);
    expect(calculated[0][1]).toBe(formulaSaved);
    expect(calculated[0][2].computed).toBe(84);
    expect(calculated[0][3].computed).toBe(1.23);
    expect(calculated[0][4].computed).toBe(5);
    expect(calculated[0][5].computed).toBe('#REF!');
    expect(textSaved.stale).toBe(true);
    expect(formulaSaved.stale).toBe(false);
  });
});

describe('T3 literal values and bounded wide ranges', () => {
  it('keeps error-shaped literal, calculated text and saved results distinct from actual errors', () => {
    const saved: Cell = {
      value: '=SOURCE()',
      type: 'formula',
      computed: '#ERROR',
      formulaCompatibility: 'unsupported',
      stale: false,
    };
    const cells: Cell[][] = [
      [
        cell('#REF'),
        cell('=CONCAT("#REF")', 'formula'),
        saved,
        cell('=LEN(A1)', 'formula'),
        cell('=LEN(B1)', 'formula'),
        cell('=LEN(C1)', 'formula'),
        cell('=SUM(A1:C1)', 'formula'),
        cell('=1/0', 'formula'),
        cell('=SUM(H1:H1)', 'formula'),
        cell('=IFERROR(H1,31)', 'formula'),
        cell('=IFERROR(A1,"literal fallback")', 'formula'),
      ],
    ];
    const derived = evaluateAllFormulas(cells);
    expect(derived[0].slice(3).map((value) => value.computed)).toEqual([
      4,
      4,
      6,
      0,
      '#DIV/0!',
      '#DIV/0!',
      31,
      'literal fallback',
    ]);
    expect(derived[0][2]).toBe(saved);
    expect(saved.computed).toBe('#ERROR');
  });

  it('resumes a wide forward range without rereading its already resolved prefix', () => {
    let reads = 0;
    const cells: Cell[][] = [
      [cell('=SUM(A2:A10001)', 'formula')],
      ...Array.from({ length: 10_000 }, () => [
        {
          get value() {
            reads++;
            return '=1+1';
          },
          type: 'formula' as const,
        },
      ]),
    ];
    const derived = evaluateAllFormulas(cells);
    expect(derived[0][0].computed).toBe(20_000);
    expect(derived[10_000][0].computed).toBe(2);
    expect(reads).toBeLessThan(100_000);
  });

  it('reduces a supported wide literal range without spreading values into call arguments', () => {
    const cells: Cell[][] = [
      [
        cell('=SUM(A2:A150001)', 'formula'),
        cell('=MIN(A2:A150001)', 'formula'),
        cell('=MAX(A2:A150001)', 'formula'),
      ],
      ...Array.from({ length: 150_000 }, (_, index) => [numCell(index + 1), cell(''), cell('')]),
    ];
    const derived = evaluateAllFormulas(cells);
    expect(derived[0].map((value) => value.computed)).toEqual([11_250_075_000, 1, 150_000]);
  });
});

describe('T-N2 formula relocation token boundaries', () => {
  it('moves only references outside single/double quoted and unfinished literal text', () => {
    expect(adjustFormula('=CONCAT("A1",\'B2\',$A1,A$1,$A$1)', 1, 1, 9, 9)).toBe(
      '=CONCAT("A1",\'B2\',$A2,B$1,$A$1)'
    );
    expect(adjustFormula('=CONCAT("A1""B2",A1)', 1, 1, 9, 9)).toBe('=CONCAT("A1""B2",B2)');
    expect(adjustFormula('=CONCAT("ZZ999",A1)', 0, 1, 9, 9)).toBe('=CONCAT("ZZ999",B1)');
    expect(adjustFormula('=CONCAT(A1,"unfinished B2', 1, 1, 9, 9)).toBe(
      '=CONCAT(B2,"unfinished B2'
    );
    expect(adjustFormula('=LOG10(A1)+name_A1', 0, 1, 9, 9)).toBe('=LOG10(B1)+name_A1');
  });

  it('uses the same precise mixed-reference and bounds policy for fill', () => {
    expect(fillFormula('=CONCAT("A1",$A1,A$1,$A$1)', 1, 1, 2, 2, 9, 9)).toBe(
      '=CONCAT("A1",$A2,B$1,$A$1)'
    );
    expect(fillFormula('=CONCAT("A1",A1)', 1, 1, 0, 0, 9, 9)).toBe('=#REF!');
    expect(fillFormula('=CONCAT("ZZ999",$A$1)', 1, 1, 0, 0, 9, 9)).toBe('=CONCAT("ZZ999",$A$1)');
  });
});

describe('T3 bounded work and cycle recovery policy', () => {
  it('returns an explicit error rather than an unbounded literal expression result', () => {
    const expression = '=CONCAT("' + 'x'.repeat(2_000_001) + '")';
    const raw: Cell[][] = [[cell(expression, 'formula')]];
    expect(evaluateAllFormulas(raw)[0][0].computed).toBe('#ERROR');
    expect(raw[0][0].value).toBe(expression);
    expect(evaluateFormula('=CONCAT("small")', [], 0, 0)).toBe('small');
  });
  it('classifies every cycle member consistently with either IFERROR placement', () => {
    const left = [[cell('=IFERROR(B1,7)', 'formula'), cell('=A1', 'formula')]];
    const right = [[cell('=B1', 'formula'), cell('=IFERROR(A1,7)', 'formula')]];
    expect(evaluateAllFormulas(left)[0].map((value) => value.computed)).toEqual(['#REF', '#REF']);
    expect(evaluateAllFormulas(right)[0].map((value) => value.computed)).toEqual(['#REF', '#REF']);
    expect(evaluateFormula('=IFERROR(Z99,7)', [[numCell(2)]], 1, 1)).toBe(7);
    const repaired = [[numCell(2), cell('=A1', 'formula')]];
    expect(evaluateAllFormulas(repaired)[0][1].computed).toBe('2');
  });
});

describe('T3 bounded derived text', () => {
  it('rejects multiplicative text expansion before allocating its unbounded replacement', () => {
    const cells: Cell[][] = [
      [cell('x'.repeat(2_000)), cell('r'.repeat(2_000)), cell('=SUBSTITUTE(A1,"x",B1)', 'formula')],
    ];
    expect(evaluateAllFormulas(cells)[0][2].computed).toBe('#ERROR');
    expect(evaluateFormula('=SUBSTITUTE("axa","x","pq")', [], 0, 0)).toBe('apqa');
  });
  it('bounds a chain of doubled text while leaving its raw inputs unchanged', () => {
    const cells: Cell[][] = [
      [cell('x'.repeat(1_000))],
      ...Array.from({ length: 20 }, (_, row) => [
        cell(`=CONCAT(A${row + 1},A${row + 1})`, 'formula'),
      ]),
    ];
    const before = cells.map((row) => row[0].value);
    expect(evaluateAllFormulas(cells)[20][0].computed).toBe('#ERROR');
    expect(cells.map((row) => row[0].value)).toEqual(before);
  });
});
