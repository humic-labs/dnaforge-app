// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parsePrimerFile } from './primer-import-parser';

function loadFixture(name: string): string {
  return readFileSync(join(__dirname, '__fixtures__', name), 'utf-8');
}

describe('parsePrimerFile', () => {
  describe('standard CSV', () => {
    it('keeps imported base case while removing ordering whitespace', () => {
      const result = parsePrimerFile(
        'Name,Sequence\nCase_F1,acgt ACGT acgt ACGT acgt\n',
        'case.csv'
      );
      expect(result.errors).toEqual([]);
      expect(result.primers[0].sequence).toBe('acgtACGTacgtACGTacgt');
    });

    it('parses all 12 primers from standard CSV', () => {
      const csv = loadFixture('primers.csv');
      const result = parsePrimerFile(csv, 'primers.csv');

      expect(result.primers).toHaveLength(12);
      expect(result.errors).toHaveLength(0);
      expect(result.format).toBe('csv');
    });

    it('maps name and sequence correctly', () => {
      const csv = loadFixture('primers.csv');
      const result = parsePrimerFile(csv, 'primers.csv');

      const m13f = result.primers[0];
      expect(m13f.name).toBe('M13-Forward');
      expect(m13f.sequence).toBe('GTAAAACGACGGCCAGT');
    });

    it('does not surface direction on parsed primers (orientation belongs to bindings)', () => {
      const csv = loadFixture('primers.csv');
      const result = parsePrimerFile(csv, 'primers.csv');

      expect((result.primers[0] as Record<string, unknown>).direction).toBeUndefined();
      expect((result.primers[1] as Record<string, unknown>).direction).toBeUndefined();
    });

    it('flags hadDirectionColumn when source has Direction column', () => {
      const csv = loadFixture('primers.csv');
      const result = parsePrimerFile(csv, 'primers.csv');

      expect(result.hadDirectionColumn).toBe(true);
    });

    it('does not flag hadDirectionColumn when source has none', () => {
      const csv = 'Name,Sequence\nP1,ATCGATCGATCGATCGATCG\n';
      const result = parsePrimerFile(csv, 'no-dir.csv');

      expect(result.hadDirectionColumn).toBe(false);
    });

    it('maps description/notes when present', () => {
      const csv = loadFixture('primers.csv');
      const result = parsePrimerFile(csv, 'primers.csv');

      expect(result.primers[0].notes).toBe('Standard M13 forward primer');
    });
  });

  describe('TSV', () => {
    it('parses TSV with minimal headers', () => {
      const tsv = loadFixture('primers-minimal.tsv');
      const result = parsePrimerFile(tsv, 'primers-minimal.tsv');

      expect(result.primers).toHaveLength(6);
      expect(result.errors).toHaveLength(0);
      expect(result.format).toBe('tsv');
    });

    it('detects name and sequence columns from short headers', () => {
      const tsv = loadFixture('primers-minimal.tsv');
      const result = parsePrimerFile(tsv, 'primers-minimal.tsv');

      expect(result.primers[0].name).toBe('FwdPrimer1');
      expect(result.primers[0].sequence).toBe('ATGCGATCGATCGATCGATCG');
    });
  });

  describe('alt headers', () => {
    it('maps IDT-style column headers', () => {
      const csv = loadFixture('primers-alt-headers.csv');
      const result = parsePrimerFile(csv, 'primers-alt-headers.csv');

      expect(result.primers).toHaveLength(8);
      expect(result.primers[0].name).toBe('OL001');
      expect(result.primers[0].sequence).toBe('ATGCGATCGATCGATCG');
    });
  });

  describe('headerless CSV', () => {
    it('auto-detects sequence column in headerless CSV', () => {
      const csv = loadFixture('primers-no-headers.csv');
      const result = parsePrimerFile(csv, 'primers-no-headers.csv');

      expect(result.primers.length).toBeGreaterThanOrEqual(4);
      expect(result.primers[0].sequence).toBe('GTAAAACGACGGCCAGT');
    });
  });

  describe('plate format', () => {
    it('parses plate CSV with Well column', () => {
      const csv = loadFixture('plate-primers.csv');
      const result = parsePrimerFile(csv, 'plate-primers.csv');

      expect(result.primers.length).toBeGreaterThan(10);
      expect(result.primers[0].name).toBe('M13uni_F');
      expect(result.primers[0].sequence).toContain('GGCCAGT');
    });
  });

  describe('IDT COA format', () => {
    it('parses 52 primers from an IDT COA export', () => {
      const csv = loadFixture('idt-order-mock.csv');
      const result = parsePrimerFile(csv, 'idt-order-mock.csv');

      expect(result.primers.length).toBe(52);
      expect(result.primers[0].name).toBe('PAU8_F');
    });

    it('strips spaces from IDT sequences', () => {
      const csv = loadFixture('idt-order-mock.csv');
      const result = parsePrimerFile(csv, 'idt-order-mock.csv');

      expect(result.primers[0].sequence).not.toContain(' ');
      expect(result.primers[0].sequence.length).toBeGreaterThan(20);
    });

    it('handles a full 351-primer IDT export', () => {
      const csv = loadFixture('idt-order-mock-full.csv');
      const result = parsePrimerFile(csv, 'idt-order-mock-full.csv');

      expect(result.primers.length).toBeGreaterThan(300);
    });
  });

  describe('edge cases', () => {
    it('returns error for empty input', () => {
      const result = parsePrimerFile('', 'empty.csv');
      expect(result.primers).toHaveLength(0);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('skips rows with invalid sequences', () => {
      const csv = 'Name,Sequence\nGood,ATCGATCGATCG\nBad,NOT_DNA_12345\n';
      const result = parsePrimerFile(csv, 'test.csv');

      expect(result.primers).toHaveLength(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].reason).toContain('invalid');
    });

    it('handles Windows line endings (CRLF)', () => {
      const csv = 'Name,Sequence\r\nTest,ATCGATCGATCG\r\n';
      const result = parsePrimerFile(csv, 'test.csv');

      expect(result.primers).toHaveLength(1);
    });

    it('trims whitespace from names and sequences', () => {
      const csv = 'Name,Sequence\n  Test  ,  ATCGATCGATCG  \n';
      const result = parsePrimerFile(csv, 'test.csv');

      expect(result.primers[0].name).toBe('Test');
      expect(result.primers[0].sequence).toBe('ATCGATCGATCG');
    });
  });
});
