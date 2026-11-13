import { describe, it, expect } from 'vitest';
import { getCDSIntrons, translateCDS } from './translation';

describe('translateCDS', () => {
  const seq = 'ATGAAAGCCTGA';

  it('flags the AUG start of an RNA CDS ', () => {
    const codons = translateCDS('AUGAAAGCCUGA', 0, 12, 'forward', 12, false);
    expect(codons.map((c) => c.aa).join('')).toBe('MKA*');
    expect(codons[0].isStart).toBe(true);
    expect(codons[3].isStop).toBe(true);
  });
  it.each([
    ['CATGAAA', 'forward', '2', [1, 4]],
    ['CCATGAAA', 'forward', '3', [2, 5]],
    ['TTTCATG', 'reverse', '2', [3, 0]],
    ['TTTCATGG', 'reverse', '3', [3, 0]],
  ] as const)(
    'honors the recorded frame in an ordinary %s %s CDS',
    (sequence, direction, codonStart, starts) => {
      const codons = translateCDS(sequence, 0, sequence.length, direction, sequence.length, false, {
        qualifiers: { codon_start: codonStart },
      });
      expect(codons.map((codon) => codon.codon)).toEqual(['ATG', 'AAA']);
      expect(codons.map((codon) => codon.aa)).toEqual(['M', 'K']);
      expect(codons.map((codon) => codon.startBp)).toEqual(starts);
      expect(codons.map((codon) => codon.residueIndex)).toEqual([1, 2]);
    }
  );

  it('translates forward CDS', () => {
    const codons = translateCDS(seq, 0, 12, 'forward', 12, false);
    expect(codons).toHaveLength(4);
    expect(codons.map((c) => c.aa).join('')).toBe('MKA*');
    expect(codons[0].isStart).toBe(true);
    expect(codons[3].isStop).toBe(true);
  });

  it('returns empty for direction=none', () => {
    expect(translateCDS(seq, 0, 12, 'none', 12, false)).toHaveLength(0);
  });

  it('handles partial codons (truncates)', () => {
    const codons = translateCDS(seq, 0, 11, 'forward', 12, false);
    expect(codons).toHaveLength(3);
    expect(codons.map((c) => c.aa).join('')).toBe('MKA');
  });

  it('translates reverse CDS', () => {
    const codons = translateCDS(seq, 0, 9, 'reverse', 12, false);
    expect(codons).toHaveLength(3);
    expect(codons[0].aa).toBe('G');
    expect(codons[1].aa).toBe('F');
    expect(codons[2].aa).toBe('H');
  });

  it('returns empty for sequences shorter than 3bp', () => {
    expect(translateCDS(seq, 0, 2, 'forward', 12, false)).toHaveLength(0);
  });

  it('handles circular wrap-around (CDS spanning origin)', () => {
    const codons = translateCDS(seq, 9, 6, 'forward', 12, true);
    expect(codons).toHaveLength(3);
    expect(codons[0].codon).toBe('TGA');
    expect(codons[0].aa).toBe('*');
    expect(codons[1].codon).toBe('ATG');
    expect(codons[1].aa).toBe('M');
    expect(codons[2].codon).toBe('AAA');
    expect(codons[2].aa).toBe('K');
  });

  it('translates spliced CDS features by skipping introns', () => {
    const splicedSeq = 'ATGAAAxxxGCCTGA';
    const codons = translateCDS(splicedSeq, 0, 15, 'forward', splicedSeq.length, false, {
      segments: [
        { start: 1, end: 6 },
        { start: 10, end: 15 },
      ],
      qualifiers: { _locationString: 'join(1..6,10..15)' },
    });

    expect(codons.map((codon) => codon.codon)).toEqual(['ATG', 'AAA', 'GCC', 'TGA']);
    expect(codons.map((codon) => codon.startBp)).toEqual([0, 3, 9, 12]);
    expect(
      getCDSIntrons(splicedSeq, 0, 15, 'forward', {
        segments: [
          { start: 1, end: 6 },
          { start: 10, end: 15 },
        ],
        qualifiers: { _locationString: 'join(1..6,10..15)' },
      })
    ).toMatchObject([{ genomicStart: 6, genomicEnd: 8, length: 3 }]);
  });

  it('splits codons that cross intron boundaries', () => {
    const splicedSeq = 'ATGAAAGxxxCCTGAA';
    const codons = translateCDS(splicedSeq, 0, 16, 'forward', splicedSeq.length, false, {
      segments: [
        { start: 1, end: 7 },
        { start: 11, end: 16 },
      ],
      qualifiers: { _locationString: 'join(1..7,11..16)' },
    });

    const splitFragments = codons.filter(
      (codon) => codon.isPartialPreIntron || codon.isPartialPostIntron
    );
    expect(splitFragments).toHaveLength(2);
    expect(splitFragments[0]).toMatchObject({
      startBp: 6,
      endBp: 7,
      codonStartBp: 6,
      codonEndBp: 11,
      renderLetter: false,
      isPartialPreIntron: true,
    });
    expect(splitFragments[1]).toMatchObject({
      startBp: 10,
      endBp: 12,
      codonStartBp: 6,
      codonEndBp: 11,
      renderLetter: true,
      isPartialPostIntron: true,
    });
  });
});

describe('translateCDS / getCDSIntrons — windowed BaseReader ', () => {
  const seq = 'ATGAAAGCCTGA';
  const fullReader = (bp: number): string | undefined => seq[bp];

  const windowed =
    (winStart: number, winEnd: number) =>
    (bp: number): string | undefined =>
      bp >= winStart && bp < winEnd ? seq[bp] : undefined;

  it('reader wrapping the full string ≡ passing the string (forward)', () => {
    expect(translateCDS(fullReader, 0, 12, 'forward', 12, false)).toEqual(
      translateCDS(seq, 0, 12, 'forward', 12, false)
    );
  });

  it('reader ≡ string (reverse strand)', () => {
    expect(translateCDS(fullReader, 0, 9, 'reverse', 12, false)).toEqual(
      translateCDS(seq, 0, 9, 'reverse', 12, false)
    );
  });

  it('a window that fully covers the CDS yields the correct codons', () => {
    const codons = translateCDS(windowed(0, 12), 0, 12, 'forward', 12, false);
    expect(codons.map((c) => c.aa).join('')).toBe('MKA*');
    expect(codons[0].isStart).toBe(true);
  });

  it('resolves IUPAC-degenerate codons when every concrete codon has the same amino acid', () => {
    const sequence = 'GARGARCTBTTRTCNAARAAYTAYCAYCTBGARAAYGARGTNGCNCGBCTBAARAARGGNTCNGGNAGYGGN';
    const codons = translateCDS(sequence, 0, sequence.length, 'forward', sequence.length, false);

    expect(codons.map((codon) => codon.aa).join('')).toBe('EELLSKNYHLENEVARLKKGSGSG');
  });

  it('uses X only when an IUPAC-degenerate codon can encode different amino acids', () => {
    const codons = translateCDS('NNK', 0, 3, 'forward', 3, false);

    expect(codons[0]?.aa).toBe('X');
  });

  it('spliced v2-mRNA CDS through a windowed reader ≡ string path', () => {
    const splicedSeq = 'ATGAAAxxxGCCTGA';
    const opts = {
      segments: [
        { start: 1, end: 6 },
        { start: 10, end: 15 },
      ],
      qualifiers: { _locationString: 'join(1..6,10..15)' },
    };
    const reader = (bp: number): string | undefined => splicedSeq[bp];
    expect(translateCDS(reader, 0, 15, 'forward', splicedSeq.length, false, opts)).toEqual(
      translateCDS(splicedSeq, 0, 15, 'forward', splicedSeq.length, false, opts)
    );
    expect(getCDSIntrons(reader, 0, 15, 'forward', opts)).toEqual(
      getCDSIntrons(splicedSeq, 0, 15, 'forward', opts)
    );
  });

  it('null/empty access degrades safely (no throw, no codons)', () => {
    const empty = (): string | undefined => undefined;
    const codons = translateCDS(empty, 0, 12, 'forward', 12, false);
    expect(codons.every((c) => c.aa === 'X' || c.aa === '*')).toBe(true);
  });
});
