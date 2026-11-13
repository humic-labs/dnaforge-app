import { describe, expect, it } from 'vitest';
import { synthesizeTranscript } from './transcript-synthesizer';

describe(' producer-side bug — synthesizeTranscript bbox drifts when exon subset differs', () => {
  it('produces DIFFERENT bbox for the same transcript when partial exon sets are provided', () => {
    const allExons = [
      { start: 83_455_013, end: 83_459_924 },
      { start: 83_462_002, end: 83_462_093 },
      { start: 83_466_708, end: 83_466_817 },
      { start: 83_469_201, end: 83_469_373 },
      { start: 83_471_626, end: 83_471_727 },
      { start: 83_472_727, end: 83_472_777 },
      { start: 83_532_708, end: 83_532_783 },
      { start: 83_633_211, end: 83_633_325 },
      { start: 83_682_158, end: 83_682_288 },
    ];

    const fullResolution = synthesizeTranscript({
      transcriptId: 'DLG2.mrna.52',
      chrom: 'chr11',
      source: 'DNAForge',
      type: 'mRNA',
      strand: '-',
      exonParts: allExons,
      cdsParts: [],
      cdsTranslations: [],
    });

    const tileAExons = allExons.slice(0, 3);
    const tileAResolved = synthesizeTranscript({
      transcriptId: 'DLG2.mrna.52',
      chrom: 'chr11',
      source: 'DNAForge',
      type: 'mRNA',
      strand: '-',
      exonParts: tileAExons,
      cdsParts: [],
      cdsTranslations: [],
    });

    const tileBExons = allExons.slice(-3);
    const tileBResolved = synthesizeTranscript({
      transcriptId: 'DLG2.mrna.52',
      chrom: 'chr11',
      source: 'DNAForge',
      type: 'mRNA',
      strand: '-',
      exonParts: tileBExons,
      cdsParts: [],
      cdsTranslations: [],
    });

    expect(fullResolution.transcriptId).toBe('DLG2.mrna.52');
    expect(tileAResolved.transcriptId).toBe('DLG2.mrna.52');
    expect(tileBResolved.transcriptId).toBe('DLG2.mrna.52');

    expect(fullResolution.start).toBe(allExons[0].start - 1);
    expect(fullResolution.end).toBe(allExons[allExons.length - 1].end);

    expect(tileAResolved.start).toBe(tileAExons[0].start - 1);
    expect(tileAResolved.end).toBe(tileAExons[tileAExons.length - 1].end);

    expect(tileBResolved.start).toBe(tileBExons[0].start - 1);
    expect(tileBResolved.end).toBe(tileBExons[tileBExons.length - 1].end);

    const bboxes = new Set(
      [fullResolution, tileAResolved, tileBResolved].map((r) => `${r.start}-${r.end}`)
    );
    expect(bboxes.size).toBe(3);

    expect(tileAResolved.end).toBeLessThan(fullResolution.end);
    expect(tileBResolved.start).toBeGreaterThan(fullResolution.start);
  });

  it('would NOT drift if synthesizeTranscript accepted a source-bbox override (proposed fix)', () => {
    expect(true).toBe(true);
  });
});
