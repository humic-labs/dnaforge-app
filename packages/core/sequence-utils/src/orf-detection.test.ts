import { describe, it, expect } from 'vitest';
import { findORFs } from './orf-detection';
import { reverseComplement } from './translation';

const codons = (...c: string[]) => c.join('');

describe('findORFs', () => {
  it('finds the same ORFs in an RNA spelling as in DNA ', () => {
    const dna =
      'CCC' +
      codons('ATG', 'AAA', 'GGG', 'TTT', 'CCC', 'TAA') +
      'GGG' +
      'TTA' +
      'CCC'.repeat(4) +
      'CAT';
    const rna = dna.replace(/T/g, 'U');

    const fromDna = findORFs(dna, 15);
    expect(fromDna.map((orf) => orf.strand).sort()).toEqual(['+', '-']);
    expect(findORFs(rna, 15)).toEqual(fromDna);
    expect(findORFs(rna.toLowerCase(), 15)).toEqual(fromDna);
  });

  describe('basic forward ORF detection', () => {
    it('finds a simple forward frame-1 ORF (ATG...TAA)', () => {
      const seq = codons(
        'ATG',
        'AAA',
        'AAA',
        'AAA',
        'AAA',
        'AAA',
        'AAA',
        'AAA',
        'AAA',
        'AAA',
        'TAA'
      );
      expect(seq.length).toBe(33);

      const orfs = findORFs(seq, 1);
      const fwd = orfs.filter((o) => o.strand === '+');
      expect(fwd.length).toBe(1);

      const orf = fwd[0];
      expect(orf.start).toBe(0);
      expect(orf.end).toBe(32);
      expect(orf.length).toBe(33);
      expect(orf.frame).toBe(1);
      expect(orf.strand).toBe('+');

      expect(seq.substring(orf.start, orf.start + 3)).toBe('ATG');
      expect(seq.substring(orf.end - 2, orf.end + 1)).toBe('TAA');
    });

    it('finds forward frame-2 ORF (offset by 1)', () => {
      const seq =
        'N' + codons('ATG', 'AAA', 'AAA', 'AAA', 'AAA', 'AAA', 'AAA', 'AAA', 'AAA', 'AAA', 'TAG');
      expect(seq.length).toBe(34);

      const orfs = findORFs(seq, 1);
      const frame2 = orfs.filter((o) => o.strand === '+' && o.frame === 2);
      expect(frame2.length).toBe(1);

      const orf = frame2[0];
      expect(orf.start).toBe(1);
      expect(orf.end).toBe(33);
      expect(orf.length).toBe(33);
      expect(seq.substring(orf.start, orf.start + 3)).toBe('ATG');
      expect(seq.substring(orf.end - 2, orf.end + 1)).toBe('TAG');
    });

    it('finds forward frame-3 ORF (offset by 2)', () => {
      const seq =
        'NN' + codons('ATG', 'AAA', 'AAA', 'AAA', 'AAA', 'AAA', 'AAA', 'AAA', 'AAA', 'AAA', 'TGA');
      expect(seq.length).toBe(35);

      const orfs = findORFs(seq, 1);
      const frame3 = orfs.filter((o) => o.strand === '+' && o.frame === 3);
      expect(frame3.length).toBe(1);

      const orf = frame3[0];
      expect(orf.start).toBe(2);
      expect(orf.end).toBe(34);
      expect(orf.length).toBe(33);
      expect(seq.substring(orf.start, orf.start + 3)).toBe('ATG');
      expect(seq.substring(orf.end - 2, orf.end + 1)).toBe('TGA');
    });
  });

  describe('ORF length is always a multiple of 3', () => {
    it('all detected ORFs have length divisible by 3', () => {
      const seq = codons(
        'ATG',
        'GCT',
        'AAA',
        'CCC',
        'GGG',
        'TTT',
        'AAA',
        'CCC',
        'GGG',
        'TTT',
        'AAA',
        'CCC',
        'GGG',
        'TTT',
        'AAA',
        'CCC',
        'GGG',
        'TTT',
        'AAA',
        'CCC',
        'GGG',
        'TTT',
        'AAA',
        'CCC',
        'GGG',
        'TTT',
        'AAA',
        'CCC',
        'GGG',
        'TTT',
        'AAA',
        'CCC',
        'GGG',
        'TTT',
        'TAA',
        'NNN',
        'NNN',
        'ATG',
        'TTT',
        'CCC',
        'GGG',
        'AAA',
        'TTT',
        'CCC',
        'GGG',
        'AAA',
        'TTT',
        'CCC',
        'GGG',
        'AAA',
        'TTT',
        'CCC',
        'GGG',
        'AAA',
        'TTT',
        'CCC',
        'GGG',
        'AAA',
        'TTT',
        'CCC',
        'GGG',
        'AAA',
        'TTT',
        'CCC',
        'GGG',
        'AAA',
        'TTT',
        'TAG'
      );

      const orfs = findORFs(seq, 1);
      for (const orf of orfs) {
        expect(orf.length % 3).toBe(0);
        expect(orf.end - orf.start + 1).toBe(orf.length);
      }
    });
  });

  describe('ORFs terminate at stop codons', () => {
    it('does NOT extend past the first in-frame stop codon', () => {
      const seq = codons(
        'ATG',
        'AAA',
        'AAA',
        'AAA',
        'AAA',
        'AAA',
        'AAA',
        'AAA',
        'AAA',
        'AAA',
        'AAA',
        'TAA',
        'AAA',
        'AAA',
        'AAA',
        'AAA',
        'TAA'
      );

      const orfs = findORFs(seq, 1);
      const frame1fwd = orfs.filter((o) => o.strand === '+' && o.frame === 1);
      expect(frame1fwd.length).toBe(1);

      const orf = frame1fwd[0];
      expect(orf.end).toBe(35);
      expect(seq.substring(orf.end - 2, orf.end + 1)).toBe('TAA');
      expect(orf.length).toBe(36);
    });

    it('handles all three stop codons (TAA, TAG, TGA)', () => {
      for (const stop of ['TAA', 'TAG', 'TGA']) {
        const seq = codons(
          'ATG',
          'AAA',
          'AAA',
          'AAA',
          'AAA',
          'AAA',
          'AAA',
          'AAA',
          'AAA',
          'AAA',
          'AAA',
          stop
        );
        const orfs = findORFs(seq, 1);
        const fwd1 = orfs.filter((o) => o.strand === '+' && o.frame === 1);
        expect(fwd1.length).toBeGreaterThanOrEqual(1);
        const orf = fwd1[0];
        expect(seq.substring(orf.end - 2, orf.end + 1)).toBe(stop);
      }
    });
  });

  describe('reverse strand ORFs', () => {
    it('correctly maps reverse ORF coordinates to forward strand', () => {
      const rcSeq = codons(
        'ATG',
        'GCT',
        'AAA',
        'CCC',
        'GGG',
        'TTT',
        'AAA',
        'CCC',
        'GGG',
        'TTT',
        'AAA',
        'TAA'
      );
      const fwdSeq = reverseComplement(rcSeq);
      expect(fwdSeq.length).toBe(36);

      expect(reverseComplement(fwdSeq)).toBe(rcSeq);

      const orfs = findORFs(fwdSeq, 1);
      const rev = orfs.filter((o) => o.strand === '-');
      expect(rev.length).toBeGreaterThanOrEqual(1);

      const orf = rev[0];
      expect(orf.start).toBe(0);
      expect(orf.end).toBe(35);
      expect(orf.length).toBe(36);

      const orfNucs = fwdSeq.substring(orf.start, orf.end + 1);
      const orfRC = reverseComplement(orfNucs);
      expect(orfRC.substring(0, 3)).toBe('ATG');
      expect(['TAA', 'TAG', 'TGA']).toContain(orfRC.substring(orfRC.length - 3));
    });

    it('reverse ORF in middle of sequence has correct coordinates', () => {
      const rcORF = codons(
        'ATG',
        'GCT',
        'AAA',
        'CCC',
        'GGG',
        'TTT',
        'AAA',
        'CCC',
        'GGG',
        'TTT',
        'AAA',
        'TAA'
      );
      const padding = 'AAAAACCCCCGGGGGTTTTT' + 'AAAAACCCCC';
      const fwdSeq = padding + reverseComplement(rcORF) + padding;

      const orfs = findORFs(fwdSeq, 1);
      const rev = orfs.filter((o) => o.strand === '-');
      expect(rev.length).toBeGreaterThanOrEqual(1);

      const orf = rev.find((o) => o.start >= 25 && o.end <= 70);
      expect(orf).toBeDefined();
      if (!orf) return;

      const orfNucs = fwdSeq.substring(orf.start, orf.end + 1);
      const orfRC = reverseComplement(orfNucs);
      expect(orfRC.substring(0, 3)).toBe('ATG');
      expect(['TAA', 'TAG', 'TGA']).toContain(orfRC.substring(orfRC.length - 3));
      expect(orf.length % 3).toBe(0);
    });
  });

  describe('minLength filtering', () => {
    it('excludes ORFs shorter than minLength', () => {
      const seq = codons(
        'ATG',
        'AAA',
        'AAA',
        'AAA',
        'AAA',
        'AAA',
        'AAA',
        'AAA',
        'AAA',
        'AAA',
        'TAA'
      );
      expect(findORFs(seq, 33).filter((o) => o.strand === '+').length).toBe(1);
      expect(findORFs(seq, 34).filter((o) => o.strand === '+').length).toBe(0);
      expect(findORFs(seq, 100).filter((o) => o.strand === '+').length).toBe(0);
    });
  });

  describe('multiple ORFs in same frame', () => {
    it('finds two consecutive ORFs separated by a stop codon', () => {
      const seq = codons('ATG', 'AAA', 'AAA', 'AAA', 'TAA', 'ATG', 'AAA', 'AAA', 'AAA', 'TAG');

      const orfs = findORFs(seq, 1);
      const frame1fwd = orfs.filter((o) => o.strand === '+' && o.frame === 1);
      expect(frame1fwd.length).toBe(2);

      expect(frame1fwd[0].start).toBe(0);
      expect(frame1fwd[0].end).toBe(14);
      expect(seq.substring(frame1fwd[0].start, frame1fwd[0].start + 3)).toBe('ATG');
      expect(seq.substring(frame1fwd[0].end - 2, frame1fwd[0].end + 1)).toBe('TAA');

      expect(frame1fwd[1].start).toBe(15);
      expect(frame1fwd[1].end).toBe(29);
      expect(seq.substring(frame1fwd[1].start, frame1fwd[1].start + 3)).toBe('ATG');
      expect(seq.substring(frame1fwd[1].end - 2, frame1fwd[1].end + 1)).toBe('TAG');
    });
  });

  describe('annotation coordinate conversion', () => {
    it('forward ORF → annotation coordinates are correct', () => {
      const seq =
        'NNNNNN' +
        codons('ATG', 'AAA', 'AAA', 'AAA', 'AAA', 'AAA', 'AAA', 'AAA', 'AAA', 'AAA', 'TAA');

      const orfs = findORFs(seq, 1);
      const orf = orfs.find((o) => o.strand === '+' && o.frame === 1);
      expect(orf).toBeDefined();
      if (!orf) return;

      const annStart = orf.start + 1;
      const annEnd = orf.end + 1;

      const drawStart = annStart - 1;
      const drawEnd = annEnd;

      expect(drawStart).toBe(orf.start);
      expect(drawEnd).toBe(orf.end + 1);

      const drawnNucs = seq.substring(drawStart, drawEnd);
      expect(drawnNucs.substring(0, 3)).toBe('ATG');
      expect(drawnNucs.substring(drawnNucs.length - 3)).toBe('TAA');
      expect(drawnNucs.length).toBe(orf.length);
    });

    it('reverse ORF → annotation coordinates are correct', () => {
      const rcORF = codons(
        'ATG',
        'GCT',
        'AAA',
        'CCC',
        'GGG',
        'TTT',
        'AAA',
        'CCC',
        'GGG',
        'TTT',
        'AAA',
        'TAA'
      );
      const fwdSeq = 'NNNNNN' + reverseComplement(rcORF) + 'NNNNNN';

      const orfs = findORFs(fwdSeq, 1);
      const orf = orfs.find((o) => o.strand === '-');
      expect(orf).toBeDefined();
      if (!orf) return;

      const annStart = orf.start + 1;
      const annEnd = orf.end + 1;

      const drawStart = annStart - 1;
      const drawEnd = annEnd;

      const drawnNucs = fwdSeq.substring(drawStart, drawEnd);
      const orfRC = reverseComplement(drawnNucs);
      expect(orfRC.substring(0, 3)).toBe('ATG');
      expect(['TAA', 'TAG', 'TGA']).toContain(orfRC.substring(orfRC.length - 3));
      expect(drawnNucs.length).toBe(orf.length);
      expect(orf.length % 3).toBe(0);
    });
  });

  describe('spliced ORFs (DNA-TG1 Phase 7)', () => {
    it('finds an ORF that spans an intron between two exons', () => {
      const exon1 = 'ATG' + 'AAA'.repeat(5);
      const exon2 = 'AAA'.repeat(5) + 'TAA';
      const intron = 'XXXXX';
      const genome = exon1 + intron + exon2;

      const contiguous = findORFs(genome, 30);
      expect(contiguous.find((o) => o.strand === '+' && o.start === 0)).toBeUndefined();

      const orfs = findORFs(genome, 30, {
        segments: [
          { start: 0, end: exon1.length },
          { start: exon1.length + intron.length, end: genome.length },
        ],
      });
      const found = orfs.find((o) => o.strand === '+' && o.frame === 1);
      expect(found).toBeDefined();
      expect(found!.segments).toBeDefined();
      expect(found!.segments!.length).toBe(2);
      expect(found!.segments![0].start).toBe(0);
      expect(found!.segments![found!.segments!.length - 1].end).toBe(genome.length);
    });

    it('reports the spliced (intron-stripped) length', () => {
      const exon1 = 'ATG' + 'AAA'.repeat(5);
      const exon2 = 'AAA'.repeat(5) + 'TAA';
      const intron = 'XXXXX';
      const genome = exon1 + intron + exon2;
      const orfs = findORFs(genome, 30, {
        segments: [
          { start: 0, end: exon1.length },
          { start: exon1.length + intron.length, end: genome.length },
        ],
      });
      const found = orfs.find((o) => o.strand === '+' && o.frame === 1);
      expect(found!.length).toBe(36);
    });

    it('preserves contiguous-mode behavior when no segments are provided', () => {
      const seq = 'NNN' + 'ATG' + 'AAA'.repeat(10) + 'TAA' + 'NNN';
      const a = findORFs(seq, 30);
      const b = findORFs(seq, 30, {});
      const c = findORFs(seq, 30, { segments: [] });
      expect(a).toEqual(b);
      expect(a).toEqual(c);
      const fwd = a.find((o) => o.strand === '+');
      expect(fwd).toBeDefined();
      expect(fwd!.segments).toBeUndefined();
    });

    it('respects minLength on the spliced (not genomic) read', () => {
      const exon1 = 'ATG' + 'AAA'.repeat(3);
      const exon2 = 'AAA'.repeat(3) + 'TAA';
      const intron = 'XXXXXX';
      const genome = exon1 + intron + exon2;
      const segs = [
        { start: 0, end: exon1.length },
        { start: exon1.length + intron.length, end: genome.length },
      ];

      const excluded = findORFs(genome, 30, { segments: segs });
      expect(excluded.find((o) => o.strand === '+' && o.frame === 1)).toBeUndefined();

      const included = findORFs(genome, 18, { segments: segs });
      const found = included.find((o) => o.strand === '+' && o.frame === 1);
      expect(found).toBeDefined();
      expect(found!.length).toBe(24);
    });
  });
});
