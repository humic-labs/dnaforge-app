import { describe, expect, it, vi } from 'vitest';
import { synthesizeTranscript } from './transcript-synthesizer';

describe('synthesizeTranscript: collapse overlapping CDS within a single transcript', () => {
  it('keeps the LONGER of two same-start overlapping CDS (SIRT3.mrna.13 shape)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = synthesizeTranscript({
      transcriptId: 'TEST.mrna.1',
      chrom: 'chr11',
      source: 'test',
      type: 'mRNA',
      strand: '-',
      exonParts: [{ start: 215030, end: 236931 }],
      cdsParts: [
        { start: 233343, end: 233389 },
        { start: 233343, end: 233534 },
      ],
      attributes: {},
      raw: '',
    });
    expect(out.cds.length).toBe(1);
    expect(out.cds[0]).toEqual({ start: 233343, end: 233534 });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/overlapping CDS segments/);
    warnSpy.mockRestore();
  });

  it('keeps the LONGER of two same-end overlapping CDS', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = synthesizeTranscript({
      transcriptId: 'TEST.mrna.1',
      chrom: 'chr11',
      source: 'test',
      type: 'mRNA',
      strand: '+',
      exonParts: [{ start: 1_000, end: 5_000 }],
      cdsParts: [
        { start: 2_000, end: 3_500 },
        { start: 1_500, end: 3_500 },
      ],
      attributes: {},
      raw: '',
    });
    expect(out.cds.length).toBe(1);
    expect(out.cds[0]).toEqual({ start: 1_500, end: 3_500 });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('preserves non-overlapping CDS even when they touch at a single bp boundary', () => {
    const out = synthesizeTranscript({
      transcriptId: 'TEST.mrna.1',
      chrom: 'chr11',
      source: 'test',
      type: 'mRNA',
      strand: '+',
      exonParts: [
        { start: 100, end: 500 },
        { start: 600, end: 1_000 },
      ],
      cdsParts: [
        { start: 100, end: 200 },
        { start: 600, end: 700 },
      ],
      attributes: {},
      raw: '',
    });
    expect(out.cds.length).toBe(2);
  });

  it('passes through CDS that are biologically valid (no warning)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = synthesizeTranscript({
      transcriptId: 'TEST.mrna.1',
      chrom: 'chr11',
      source: 'test',
      type: 'mRNA',
      strand: '+',
      exonParts: [
        { start: 100, end: 1_000 },
        { start: 2_000, end: 3_000 },
      ],
      cdsParts: [
        { start: 200, end: 800 },
        { start: 2_100, end: 2_900 },
      ],
      attributes: {},
      raw: '',
    });
    expect(out.cds.length).toBe(2);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
