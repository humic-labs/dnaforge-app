// @vitest-environment node

import { describe, expect, it } from 'vitest';

import type { TranscriptCarrierFeature } from './indexed-genome-legacy-adapter';
import { collapseToCanonicalIsoforms } from './isoform-collapse';

interface BuildOptions {
  exonsLen?: number;
  cdsLen?: number;
  start?: number;
  tag?: string;
  geneId?: string;
}

function mrna(transcriptId: string, opts: BuildOptions = {}): TranscriptCarrierFeature {
  const start = opts.start ?? 100;
  const exonsLen = opts.exonsLen ?? 200;
  const cdsLen = opts.cdsLen ?? exonsLen;
  const exons = [{ start: start + 1, end: start + exonsLen }];
  const cds = cdsLen > 0 ? [{ start: start + 1, end: start + cdsLen }] : [];
  return {
    chrom: 'chr11',
    source: 'DNAForge',
    type: 'mRNA',
    start,
    end: start + exonsLen,
    score: null,
    strand: '+',
    phase: null,
    attributes: {
      ID: [transcriptId],
      ...(opts.tag ? { tag: [opts.tag] } : {}),
    },
    raw: '',
    exons,
    cds,
    transcriptId,
    ...(opts.geneId ? { geneId: opts.geneId } : {}),
    _resolvedExons: exons,
    _resolvedCds: cds,
    _resolvedTranscriptId: transcriptId,
  } as unknown as TranscriptCarrierFeature;
}

describe('collapseToCanonicalIsoforms', () => {
  it("'canonical' mode keeps only one isoform per gene, picking MANE Select when tagged", () => {
    const features = [
      mrna('DLG2.mrna.1', { geneId: 'DLG2.gene.1', exonsLen: 300, cdsLen: 300 }),
      mrna('DLG2.mrna.2', {
        geneId: 'DLG2.gene.1',
        exonsLen: 500,
        cdsLen: 200,
        tag: 'MANE_Select',
      }),
      mrna('DLG2.mrna.3', { geneId: 'DLG2.gene.1', exonsLen: 1000, cdsLen: 1000 }),
    ];
    const result = collapseToCanonicalIsoforms(features, { mode: 'canonical' });
    expect(result).toHaveLength(1);
    expect(result[0].transcriptId).toBe('DLG2.mrna.2');
  });

  it("'canonical' mode falls back to longest-CDS when no MANE Select tag", () => {
    const features = [
      mrna('DLG2.mrna.1', { geneId: 'DLG2.gene.1', exonsLen: 300, cdsLen: 100 }),
      mrna('DLG2.mrna.2', { geneId: 'DLG2.gene.1', exonsLen: 500, cdsLen: 500 }),
      mrna('DLG2.mrna.3', { geneId: 'DLG2.gene.1', exonsLen: 1000, cdsLen: 200 }),
    ];
    const result = collapseToCanonicalIsoforms(features, { mode: 'canonical' });
    expect(result).toHaveLength(1);
    expect(result[0].transcriptId).toBe('DLG2.mrna.2');
  });

  it("'expanded' mode returns every isoform untouched", () => {
    const features = [
      mrna('A', { geneId: 'GENE_A' }),
      mrna('B', { geneId: 'GENE_A' }),
      mrna('C', { geneId: 'GENE_B' }),
    ];
    const result = collapseToCanonicalIsoforms(features, { mode: 'expanded' });
    expect(result.map((f) => f.transcriptId)).toEqual(['A', 'B', 'C']);
  });

  it('per-gene expand override keeps all isoforms for the named gene', () => {
    const features = [
      mrna('A1', { geneId: 'A', exonsLen: 100, cdsLen: 100 }),
      mrna('A2', { geneId: 'A', exonsLen: 200, cdsLen: 200 }),
      mrna('B1', { geneId: 'B', exonsLen: 100, cdsLen: 100 }),
      mrna('B2', { geneId: 'B', exonsLen: 200, cdsLen: 200 }),
    ];
    const result = collapseToCanonicalIsoforms(features, {
      mode: 'canonical',
      expandedGeneIds: new Set(['A']),
    });
    expect(result.map((f) => f.transcriptId).sort()).toEqual(['A1', 'A2', 'B2']);
  });

  it('features without geneId pass through unchanged', () => {
    const noGene: TranscriptCarrierFeature = {
      chrom: 'chr11',
      source: 'DNAForge',
      type: 'regulatory',
      start: 100,
      end: 200,
      score: null,
      strand: '+',
      phase: null,
      attributes: { ID: ['enhancer-1'] },
      raw: '',
    } as unknown as TranscriptCarrierFeature;
    const result = collapseToCanonicalIsoforms(
      [
        noGene,
        mrna('A1', { geneId: 'A' }),
        mrna('A2', { geneId: 'A', exonsLen: 1000, cdsLen: 1000 }),
      ],
      { mode: 'canonical' }
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(noGene);
    expect(result[1].transcriptId).toBe('A2');
  });

  it('preserves slot order so downstream lane assignment is stable', () => {
    const features = [
      mrna('reg1', {}),
      mrna('A1', { geneId: 'A' }),
      mrna('reg2', {}),
      mrna('A2', { geneId: 'A', exonsLen: 1000, cdsLen: 1000 }),
      mrna('B1', { geneId: 'B' }),
    ];
    delete (features[0] as unknown as { geneId?: unknown }).geneId;
    delete (features[2] as unknown as { geneId?: unknown }).geneId;
    const result = collapseToCanonicalIsoforms(features, { mode: 'canonical' });
    expect(result.map((f) => f.transcriptId)).toEqual(['reg1', 'A2', 'reg2', 'B1']);
  });

  it('single-isoform gene survives both modes unchanged', () => {
    const features = [mrna('SOLO', { geneId: 'SOLOGENE' })];
    expect(collapseToCanonicalIsoforms(features, { mode: 'canonical' })).toHaveLength(1);
    expect(collapseToCanonicalIsoforms(features, { mode: 'expanded' })).toHaveLength(1);
  });

  it('falls back to attributes.gene when geneId is unset (RefSeq-flat GFF3 shape)', () => {
    const features: TranscriptCarrierFeature[] = [
      mrna('DLG2.mrna.1', { exonsLen: 300, cdsLen: 300 }),
      mrna('DLG2.mrna.2', { exonsLen: 500, cdsLen: 500 }),
      mrna('DLG2.mrna.3', { exonsLen: 800, cdsLen: 200 }),
    ];
    for (const f of features) {
      delete (f as unknown as { geneId?: unknown }).geneId;
      f.attributes = { ...f.attributes, gene: ['DLG2'] };
    }
    const result = collapseToCanonicalIsoforms(features, { mode: 'canonical' });
    expect(result).toHaveLength(1);
    expect(result[0].transcriptId).toBe('DLG2.mrna.2');
  });
});
