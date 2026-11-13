import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseGenBankFull } from './genbank';
import { serializeGenBank } from '../writers/genbank';
import type { AnnotatedSequence } from '../types';

const FIXTURE_PATH = join(
  __dirname,
  '../../../../../test-fixtures/sequences/linear/mg1655-thrL-multi-xref-synthetic.gb'
);

describe(' multi-value qualifier preservation', () => {
  let parsed: AnnotatedSequence;

  beforeAll(() => {
    const raw = readFileSync(FIXTURE_PATH, 'utf-8');
    parsed = parseGenBankFull(raw);
  });

  describe('parser', () => {
    it('preserves all four /db_xref entries on the thrL CDS', () => {
      const thrL = parsed.annotations.find((a) => a.name === 'thrL');
      expect(thrL).toBeDefined();
      expect(thrL!.qualifiers?.db_xref).toEqual([
        'UniProtKB/Swiss-Prot:P0AD86',
        'ASAP:ABE-0000006',
        'ECOCYC:EG10998',
        'EcoGene:EG10998',
      ]);
    });

    it('preserves /db_xref ordering independently per feature', () => {
      const rev = parsed.annotations.find((a) => a.name === 'rev_dual_xref');
      expect(rev).toBeDefined();
      expect(rev!.qualifiers?.db_xref).toEqual(['UniProtKB/Swiss-Prot:P00000', 'GeneID:99999']);
    });

    it('parses singleton qualifiers as length-1 arrays', () => {
      const thrL = parsed.annotations.find((a) => a.name === 'thrL');
      expect(thrL!.qualifiers?.gene).toEqual(['thrL']);
      expect(thrL!.qualifiers?.locus_tag).toEqual(['b0001']);
      expect(thrL!.qualifiers?.protein_id).toEqual(['AAC73112.1']);
      expect(thrL!.qualifiers?.codon_start).toEqual(['1']);
      expect(thrL!.qualifiers?.transl_table).toEqual(['11']);
      expect(thrL!.qualifiers?.translation).toEqual(['MKRISTTITTTITITTGNGAG']);
    });

    it('non-empty-array invariant: every present key carries at least one entry', () => {
      for (const ann of parsed.annotations) {
        if (!ann.qualifiers) continue;
        for (const [key, values] of Object.entries(ann.qualifiers)) {
          expect(values, `qualifier "${key}" on "${ann.name}"`).toBeDefined();
          expect(values.length, `qualifier "${key}" on "${ann.name}"`).toBeGreaterThan(0);
        }
      }
    });
  });

  describe('serializer', () => {
    it('emits one /db_xref="..." line per array entry, in original order', () => {
      const serialized = serializeGenBank(parsed);
      const thrLBlock = serialized.match(/CDS\s+1\.\.66[\s\S]*?(?=\s{5}CDS|\nORIGIN)/);
      expect(thrLBlock).toBeTruthy();
      const xrefLines = (thrLBlock![0].match(/\/db_xref="[^"]+"/g) ?? []).map((l) =>
        l.replace(/^\/db_xref="(.+)"$/, '$1')
      );
      expect(xrefLines).toEqual([
        'UniProtKB/Swiss-Prot:P0AD86',
        'ASAP:ABE-0000006',
        'ECOCYC:EG10998',
        'EcoGene:EG10998',
      ]);
    });

    it('emits one line per /db_xref entry on the complement-strand CDS too', () => {
      const serialized = serializeGenBank(parsed);
      const revBlock = serialized.match(
        /CDS\s+complement\(100\.\.165\)[\s\S]*?(?=\s{5}CDS|\nORIGIN)/
      );
      expect(revBlock).toBeTruthy();
      const xrefLines = (revBlock![0].match(/\/db_xref="[^"]+"/g) ?? []).map((l) =>
        l.replace(/^\/db_xref="(.+)"$/, '$1')
      );
      expect(xrefLines).toEqual(['UniProtKB/Swiss-Prot:P00000', 'GeneID:99999']);
    });
  });

  describe('round-trip', () => {
    it('parse → serialize → parse preserves all xref entries on every feature', () => {
      const serialized = serializeGenBank(parsed);
      const reparsed = parseGenBankFull(serialized);

      const thrLOriginal = parsed.annotations.find((a) => a.name === 'thrL')!;
      const thrLReparsed = reparsed.annotations.find((a) => a.name === 'thrL');
      expect(thrLReparsed?.qualifiers?.db_xref).toEqual(thrLOriginal.qualifiers?.db_xref);

      const revOriginal = parsed.annotations.find((a) => a.name === 'rev_dual_xref')!;
      const revReparsed = reparsed.annotations.find((a) => a.name === 'rev_dual_xref');
      expect(revReparsed?.qualifiers?.db_xref).toEqual(revOriginal.qualifiers?.db_xref);
    });

    it('parse → serialize → parse preserves singleton qualifiers without duplication', () => {
      const serialized = serializeGenBank(parsed);
      const reparsed = parseGenBankFull(serialized);
      const thrL = reparsed.annotations.find((a) => a.name === 'thrL')!;
      expect(thrL.qualifiers?.translation).toHaveLength(1);
      expect(thrL.qualifiers?.translation?.[0]).toBe('MKRISTTITTTITITTGNGAG');
    });
  });
});
