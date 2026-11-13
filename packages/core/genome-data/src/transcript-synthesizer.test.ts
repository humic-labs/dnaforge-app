import { describe, expect, it } from 'vitest';

import type { BpInterval, GenomeFeature, ResolvedTranscript } from './types';
import {
  pickCanonicalIsoform,
  promoteBacterialCds,
  synthesizeTranscript,
} from './transcript-synthesizer';

function feat(
  overrides: Partial<GenomeFeature> & Pick<GenomeFeature, 'type' | 'start' | 'end'>
): GenomeFeature {
  return {
    chrom: overrides.chrom ?? 'chr1',
    source: overrides.source ?? 'test',
    type: overrides.type,
    start: overrides.start,
    end: overrides.end,
    score: overrides.score ?? null,
    strand: overrides.strand ?? '+',
    phase: overrides.phase ?? null,
    attributes: overrides.attributes ?? {},
    raw: overrides.raw ?? '',
  };
}

function tx(
  overrides: Partial<ResolvedTranscript> & {
    transcriptId: string;
    exons: ReadonlyArray<BpInterval>;
    cds: ReadonlyArray<BpInterval>;
  }
): ResolvedTranscript {
  return {
    chrom: 'chr1',
    source: 'test',
    type: 'mRNA',
    start: overrides.exons[0].start - 1,
    end: overrides.exons[overrides.exons.length - 1].end,
    score: null,
    strand: '+',
    phase: null,
    attributes: { ID: [overrides.transcriptId] },
    raw: '',
    ...overrides,
  };
}

describe('synthesizeTranscript', () => {
  it('builds the canonical happy path: 3 exons, 3 CDS, all aligned', () => {
    const result = synthesizeTranscript({
      transcriptId: 'NM_001.mrna.1',
      geneId: 'gene-HBB',
      chrom: 'chr11',
      source: 'RefSeq',
      type: 'mRNA',
      strand: '+',
      exonParts: [
        { start: 100, end: 200 },
        { start: 400, end: 500 },
        { start: 800, end: 1000 },
      ],
      cdsParts: [
        { start: 100, end: 200 },
        { start: 400, end: 500 },
        { start: 800, end: 1000 },
      ],
      attributes: { gene: ['HBB'] },
    });

    expect(result.transcriptId).toBe('NM_001.mrna.1');
    expect(result.geneId).toBe('gene-HBB');
    expect(result.type).toBe('mRNA');
    expect(result.start).toBe(99);
    expect(result.end).toBe(1000);
    expect(result.exons).toHaveLength(3);
    expect(result.cds).toHaveLength(3);
    expect(result.attributes.ID).toEqual(['NM_001.mrna.1']);
    expect(result.attributes.Parent).toEqual(['gene-HBB']);
    expect(result.attributes.gene).toEqual(['HBB']);
  });

  it('handles single-exon yeast-style transcript (degenerate case)', () => {
    const result = synthesizeTranscript({
      transcriptId: 'YAL001C',
      chrom: 'chrI',
      source: 'SGD',
      type: 'mRNA',
      strand: '-',
      exonParts: [{ start: 1000, end: 2500 }],
      cdsParts: [{ start: 1000, end: 2500 }],
    });
    expect(result.exons).toEqual([{ start: 1000, end: 2500 }]);
    expect(result.cds).toEqual([{ start: 1000, end: 2500 }]);
  });

  it('handles partial-CDS case (UTRs on either end)', () => {
    const result = synthesizeTranscript({
      transcriptId: 'tx-utr',
      chrom: 'chr1',
      source: 'test',
      type: 'mRNA',
      strand: '+',
      exonParts: [
        { start: 100, end: 200 },
        { start: 400, end: 500 },
        { start: 800, end: 1000 },
      ],
      cdsParts: [
        { start: 150, end: 200 },
        { start: 400, end: 500 },
        { start: 800, end: 950 },
      ],
    });
    expect(result.exons).toHaveLength(3);
    expect(result.cds).toEqual([
      { start: 150, end: 200 },
      { start: 400, end: 500 },
      { start: 800, end: 950 },
    ]);
  });

  it('aggregates per-CDS-row translation into single string (concat in input order)', () => {
    const result = synthesizeTranscript({
      transcriptId: 'tx-translation',
      chrom: 'chr1',
      source: 'test',
      type: 'mRNA',
      strand: '+',
      exonParts: [
        { start: 100, end: 102 },
        { start: 200, end: 202 },
      ],
      cdsParts: [
        { start: 100, end: 102 },
        { start: 200, end: 202 },
      ],
      cdsTranslations: ['MA', 'TG'],
    });
    expect(result.translation).toBe('MATG');
  });

  it('deduplicates per-CDS translation when all parts carry identical strings (BioPython quirk)', () => {
    const result = synthesizeTranscript({
      transcriptId: 'tx-biopython',
      chrom: 'chr1',
      source: 'test',
      type: 'mRNA',
      strand: '+',
      exonParts: [
        { start: 100, end: 102 },
        { start: 200, end: 202 },
      ],
      cdsParts: [
        { start: 100, end: 102 },
        { start: 200, end: 202 },
      ],
      cdsTranslations: ['MATG', 'MATG'],
    });
    expect(result.translation).toBe('MATG');
  });

  it('returns undefined translation when cds is empty (non-coding transcript)', () => {
    const result = synthesizeTranscript({
      transcriptId: 'lnc-1',
      chrom: 'chr1',
      source: 'test',
      type: 'ncRNA',
      strand: '+',
      exonParts: [
        { start: 100, end: 200 },
        { start: 400, end: 500 },
      ],
      cdsParts: [],
    });
    expect(result.cds).toEqual([]);
    expect(result.translation).toBeUndefined();
    expect(result.type).toBe('ncRNA');
  });

  it('sorts and dedups out-of-order exons', () => {
    const result = synthesizeTranscript({
      transcriptId: 'tx-unsorted',
      chrom: 'chr1',
      source: 'test',
      type: 'mRNA',
      strand: '+',
      exonParts: [
        { start: 800, end: 1000 },
        { start: 100, end: 200 },
        { start: 400, end: 500 },
        { start: 100, end: 200 },
      ],
      cdsParts: [],
    });
    expect(result.exons).toEqual([
      { start: 100, end: 200 },
      { start: 400, end: 500 },
      { start: 800, end: 1000 },
    ]);
  });

  it('clips CDS to exon coverage when CDS extends past exon by 1-2 bp (rounding errors)', () => {
    const result = synthesizeTranscript({
      transcriptId: 'tx-clip',
      chrom: 'chr1',
      source: 'test',
      type: 'mRNA',
      strand: '+',
      exonParts: [{ start: 100, end: 200 }],
      cdsParts: [{ start: 95, end: 205 }],
    });
    expect(result.cds).toEqual([{ start: 100, end: 200 }]);
  });

  it('drops CDS intervals lying entirely outside exon coverage', () => {
    const result = synthesizeTranscript({
      transcriptId: 'tx-orphan-cds',
      chrom: 'chr1',
      source: 'test',
      type: 'mRNA',
      strand: '+',
      exonParts: [
        { start: 100, end: 200 },
        { start: 800, end: 1000 },
      ],
      cdsParts: [{ start: 600, end: 700 }],
    });
    expect(result.cds).toEqual([]);
  });

  it('throws when exonParts is empty (caller must promote bacterial CDS via promoteBacterialCds)', () => {
    expect(() =>
      synthesizeTranscript({
        transcriptId: 'invalid',
        chrom: 'chr1',
        source: 'test',
        type: 'mRNA',
        strand: '+',
        exonParts: [],
        cdsParts: [],
      })
    ).toThrow(/no exons/);
  });
});

describe('promoteBacterialCds', () => {
  it('preserves CDS semantics while adding degenerate single-part composite geometry', () => {
    const cds = feat({
      type: 'CDS',
      start: 999,
      end: 2000,
      strand: '+',
      attributes: { ID: ['lacZ'], gene: ['lacZ'], translation: ['MTMITDSLAVVLQ...'] },
    });
    const result = promoteBacterialCds(cds);
    expect(result.type).toBe('CDS');
    expect(result.compositeKind).toBe('compound-cds');
    expect(result.exons).toEqual([{ start: 1000, end: 2000 }]);
    expect(result.cds).toEqual([{ start: 1000, end: 2000 }]);
    expect(result.translation).toBe('MTMITDSLAVVLQ...');
    expect(result.attributes._syntheticCompositeFeature).toEqual(['true']);
    expect(result.attributes._syntheticTranscript).toBeUndefined();
    expect(result.transcriptId).toBe('lacZ');
  });

  it('synthesizes a transcriptId when bare CDS has no ID attribute', () => {
    const cds = feat({ type: 'CDS', start: 999, end: 2000, strand: '+', attributes: {} });
    const result = promoteBacterialCds(cds);
    expect(result.transcriptId).toMatch(/_synth\.\d+_\d+/);
  });

  it('preserves the original CDS attributes (gene, locus_tag, etc.) for downstream consumers', () => {
    const cds = feat({
      type: 'CDS',
      start: 0,
      end: 100,
      strand: '+',
      attributes: { gene: ['rpoB'], locus_tag: ['b3987'], product: ['RNA polymerase'] },
    });
    const result = promoteBacterialCds(cds);
    expect(result.attributes.gene).toEqual(['rpoB']);
    expect(result.attributes.locus_tag).toEqual(['b3987']);
    expect(result.attributes.product).toEqual(['RNA polymerase']);
  });
});

describe('pickCanonicalIsoform', () => {
  it('picks the MANE Select tagged isoform when present', () => {
    const isoforms = [
      tx({
        transcriptId: 'NM_001.1',
        exons: [{ start: 100, end: 1000 }],
        cds: [{ start: 200, end: 800 }],
        attributes: { ID: ['NM_001.1'], tag: ['Ensembl_canonical'] },
      }),
      tx({
        transcriptId: 'NM_001.2',
        exons: [{ start: 100, end: 2000 }],
        cds: [{ start: 200, end: 1900 }],
        attributes: { ID: ['NM_001.2'], tag: ['MANE_Select'] },
      }),
      tx({
        transcriptId: 'NM_001.3',
        exons: [{ start: 100, end: 1500 }],
        cds: [{ start: 200, end: 1200 }],
        attributes: { ID: ['NM_001.3'] },
      }),
    ];
    expect(pickCanonicalIsoform(isoforms)?.transcriptId).toBe('NM_001.2');
  });

  it('falls back to longest-CDS when no MANE Select tagged', () => {
    const isoforms = [
      tx({
        transcriptId: 'iso-short-cds',
        exons: [{ start: 100, end: 1000 }],
        cds: [{ start: 200, end: 500 }],
      }),
      tx({
        transcriptId: 'iso-long-cds',
        exons: [{ start: 100, end: 1000 }],
        cds: [{ start: 200, end: 900 }],
      }),
    ];
    expect(pickCanonicalIsoform(isoforms)?.transcriptId).toBe('iso-long-cds');
  });

  it('tiebreaks longest-CDS by longest-exon-coverage, then lowest start', () => {
    const isoforms = [
      tx({
        transcriptId: 'iso-tied-A',
        start: 99,
        end: 500,
        exons: [{ start: 100, end: 500 }],
        cds: [{ start: 200, end: 300 }],
      }),
      tx({
        transcriptId: 'iso-tied-B',
        start: 99,
        end: 1000,
        exons: [{ start: 100, end: 1000 }],
        cds: [{ start: 200, end: 300 }],
      }),
    ];
    expect(pickCanonicalIsoform(isoforms)?.transcriptId).toBe('iso-tied-B');
  });

  it('returns undefined for empty input', () => {
    expect(pickCanonicalIsoform([])).toBeUndefined();
  });

  it('returns the only entry for single-isoform input', () => {
    const only = tx({
      transcriptId: 'solo',
      exons: [{ start: 100, end: 500 }],
      cds: [{ start: 200, end: 400 }],
    });
    expect(pickCanonicalIsoform([only])?.transcriptId).toBe('solo');
  });

  it('handles non-coding transcripts (empty cds) by falling back to longest exon coverage', () => {
    const isoforms = [
      tx({
        transcriptId: 'lnc-short',
        exons: [{ start: 100, end: 500 }],
        cds: [],
      }),
      tx({
        transcriptId: 'lnc-long',
        exons: [{ start: 100, end: 2000 }],
        cds: [],
      }),
    ];
    expect(pickCanonicalIsoform(isoforms)?.transcriptId).toBe('lnc-long');
  });
});
