import { describe, expect, it } from 'vitest';

import {
  BAM_FORMAT_HANDLER,
  BCF_FORMAT_HANDLER,
  BED_FORMAT_HANDLER,
  BIGBED_FORMAT_HANDLER,
  BIGWIG_FORMAT_HANDLER,
  BUILTIN_FORMAT_HANDLERS,
  CRAM_FORMAT_HANDLER,
  FASTA_FORMAT_HANDLER,
  GENBANK_FORMAT_HANDLER,
  GENEPRED_FORMAT_HANDLER,
  GFF3_FORMAT_HANDLER,
  GTF_FORMAT_HANDLER,
  NARROWPEAK_FORMAT_HANDLER,
  BROADPEAK_FORMAT_HANDLER,
  REFFLAT_FORMAT_HANDLER,
  VCF_FORMAT_HANDLER,
  createDefaultFormatRegistry,
} from './builtin-format-handlers';

describe('built-in FormatHandlers — extension detection', () => {
  const r = createDefaultFormatRegistry();

  it.each([
    ['/d/sample.gff3', GFF3_FORMAT_HANDLER],
    ['/d/sample.gff', GFF3_FORMAT_HANDLER],
    ['/d/sample.gff3.gz', GFF3_FORMAT_HANDLER],
    ['/d/sample.gff3.bgz', GFF3_FORMAT_HANDLER],
    ['/d/sample.gtf', GTF_FORMAT_HANDLER],
    ['/d/sample.gtf.gz', GTF_FORMAT_HANDLER],
    ['/d/sample.gb', GENBANK_FORMAT_HANDLER],
    ['/d/sample.gbk', GENBANK_FORMAT_HANDLER],
    ['/d/sample.gbff', GENBANK_FORMAT_HANDLER],
    ['/d/sample.fa', FASTA_FORMAT_HANDLER],
    ['/d/sample.fasta', FASTA_FORMAT_HANDLER],
    ['/d/sample.fna', FASTA_FORMAT_HANDLER],
    ['/d/sample.fa.gz', FASTA_FORMAT_HANDLER],
    ['/d/sample.bed', BED_FORMAT_HANDLER],
    ['/d/sample.bed.gz', BED_FORMAT_HANDLER],
    ['/d/sample.bed.bgz', BED_FORMAT_HANDLER],
    ['/d/genes.genePred', GENEPRED_FORMAT_HANDLER],
    ['/d/genes.refFlat.gz', REFFLAT_FORMAT_HANDLER],
    ['/d/open.narrowPeak', NARROWPEAK_FORMAT_HANDLER],
    ['/d/domains.broadPeak.gz', BROADPEAK_FORMAT_HANDLER],
    ['/d/signal.bw', BIGWIG_FORMAT_HANDLER],
    ['/d/signal.bigWig', BIGWIG_FORMAT_HANDLER],
    ['/d/features.bb', BIGBED_FORMAT_HANDLER],
    ['/d/features.bigBed', BIGBED_FORMAT_HANDLER],
    ['/d/reads.bam', BAM_FORMAT_HANDLER],
    ['/d/reads.cram', CRAM_FORMAT_HANDLER],
    ['/d/calls.vcf', VCF_FORMAT_HANDLER],
    ['/d/calls.vcf.gz', VCF_FORMAT_HANDLER],
    ['/d/calls.bcf', BCF_FORMAT_HANDLER],
  ])('routes %s to the right handler', (path, handler) => {
    expect(r.detect({ kind: 'path', path })).toBe(handler);
  });

  it('returns null for an unknown extension', () => {
    expect(r.detect({ kind: 'path', path: '/d/sample.unknown' })).toBe(null);
  });

  it('extension is case-insensitive', () => {
    expect(r.detect({ kind: 'path', path: '/d/Sample.GFF3' })).toBe(GFF3_FORMAT_HANDLER);
  });

  it('finds GenBank via .gbff for large RefSeq files', () => {
    expect(r.detect({ kind: 'path', path: '/refseq/human/reference.gbff' })).toBe(
      GENBANK_FORMAT_HANDLER
    );
  });
});

describe('built-in FormatHandlers — mime detection', () => {
  const r = createDefaultFormatRegistry();

  it('routes by mime type when extension is missing', () => {
    expect(
      r.detect({ kind: 'url', url: 'https://example.com/x' }, { mime: 'application/x-gff3' })
    ).toBe(GFF3_FORMAT_HANDLER);
  });

  it('routes FASTA via chemical mime', () => {
    expect(
      r.detect({ kind: 'url', url: 'https://example.com/x' }, { mime: 'chemical/seq-na-fasta' })
    ).toBe(FASTA_FORMAT_HANDLER);
  });
});

describe('default registry assembly', () => {
  it('registers all built-in handlers', () => {
    const r = createDefaultFormatRegistry();
    const ids = r.list().map((h) => h.id);
    expect(ids).toContain('gff3');
    expect(ids).toContain('genbank');
    expect(ids).toContain('fasta');
    expect(ids).toContain('bed');
    expect(ids).toContain('gtf');
    expect(ids).toContain('genepred');
    expect(ids).toContain('refflat');
    expect(ids).toContain('narrowpeak');
    expect(ids).toContain('broadpeak');
    expect(ids).toContain('bigwig');
    expect(ids).toContain('bigbed');
    expect(ids).toContain('bam');
    expect(ids).toContain('cram');
    expect(ids).toContain('vcf');
    expect(ids).toContain('bcf');
    expect(r.list().length).toBe(BUILTIN_FORMAT_HANDLERS.length);
  });

  it('routes UCSC binary formats to their real renderer families', () => {
    expect(
      BIGWIG_FORMAT_HANDLER.toTrackSource({
        kind: 'url',
        url: 'https://hgdownload.soe.ucsc.edu/example.bw',
      }).recommendedTypes
    ).toEqual(['quantitative']);
    expect(
      BIGBED_FORMAT_HANDLER.toTrackSource({
        kind: 'url',
        url: 'https://hgdownload.soe.ucsc.edu/example.bb',
      }).recommendedTypes
    ).toEqual(['generic-interval', 'imported-transcript', 'peak', 'repeat']);
  });

  it('routes indexed reads and variants to their established viewer families', () => {
    expect(
      BAM_FORMAT_HANDLER.toTrackSource({ kind: 'path', path: '/data/sample.bam' }).recommendedTypes
    ).toEqual(['pileup']);
    expect(
      VCF_FORMAT_HANDLER.toTrackSource({ kind: 'path', path: '/data/sample.vcf.gz' })
        .recommendedTypes
    ).toEqual(['variant']);
  });

  it('toTrackSource returns formatId + recommendedTypes', () => {
    const r = createDefaultFormatRegistry();
    const handler = r.findById('gff3');
    expect(handler).not.toBeNull();
    const src = handler!.toTrackSource({ kind: 'path', path: '/x.gff3' });
    expect(src.formatId).toBe('gff3');
    expect(src.recommendedTypes).toEqual(['imported-transcript', 'generic-interval']);
    expect(src.input).toEqual({ kind: 'path', path: '/x.gff3' });
    expect(src.uri).toBe('file:///x.gff3');
  });

  it('GenBank recommends both annotation AND reference-sequence (sequence + features in one file)', () => {
    const src = GENBANK_FORMAT_HANDLER.toTrackSource({ kind: 'path', path: '/x.gbk' });
    expect(src.recommendedTypes).toContain('annotation');
    expect(src.recommendedTypes).toContain('reference-sequence');
  });
});
