import { describe, expect, it } from 'vitest';
import { synthesizeTranscript } from './transcript-synthesizer';

describe(' gene-bbox leak — synthesizeTranscript does NOT inherit gene bbox', () => {
  it("uses the transcript's OWN exon list for bbox, not the gene's span", () => {
    const mrna52OwnExons = [
      { start: 83_455_013, end: 83_459_924 },
      { start: 83_462_002, end: 83_462_093 },
      { start: 83_466_708, end: 83_466_817 },
      { start: 83_469_201, end: 83_469_373 },
      { start: 83_471_626, end: 83_471_727 },
      { start: 83_472_727, end: 83_472_777 },
      { start: 83_483_253, end: 83_483_298 },
      { start: 83_532_708, end: 83_532_783 },
      { start: 83_633_211, end: 83_633_325 },
      { start: 83_682_158, end: 83_682_288 },
    ];
    const synthesized = synthesizeTranscript({
      transcriptId: 'DLG2.mrna.52',
      geneId: 'DLG2.gene.1',
      chrom: 'chr11',
      source: 'DNAForge',
      type: 'mRNA',
      strand: '-',
      exonParts: mrna52OwnExons,
      cdsParts: [],
      cdsTranslations: [],
    });

    expect(synthesized.start).toBe(83_455_012);
    expect(synthesized.end).toBe(83_682_288);
    expect(synthesized.exons.length).toBe(10);
    expect(synthesized.end).not.toBe(85_628_373);
    expect(synthesized.exons.length).not.toBe(27);
  });

  it('keeps exon count == 10 even when called repeatedly (no side-effect accumulation)', () => {
    const exons = [
      { start: 83_455_013, end: 83_459_924 },
      { start: 83_462_002, end: 83_462_093 },
    ];
    const t1 = synthesizeTranscript({
      transcriptId: 'X',
      chrom: 'chr11',
      source: 'X',
      type: 'mRNA',
      strand: '-',
      exonParts: exons,
      cdsParts: [],
      cdsTranslations: [],
    });
    const t2 = synthesizeTranscript({
      transcriptId: 'X',
      chrom: 'chr11',
      source: 'X',
      type: 'mRNA',
      strand: '-',
      exonParts: exons,
      cdsParts: [],
      cdsTranslations: [],
    });
    expect(t1.exons.length).toBe(2);
    expect(t2.exons.length).toBe(2);
    expect(t1.exons).not.toBe(t2.exons);
  });
});
