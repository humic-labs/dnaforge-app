import { describe, it, expect } from 'vitest';
import { parseGff3AsPlasmid, isGff3Format } from './gff3';

const MINIMAL_GFF3 = `##gff-version 3
chr11	DNAForge	gene	1000	2000	.	+	.	ID=gene1;Name=HBB
chr11	DNAForge	mRNA	1000	2000	.	+	.	ID=mrna1;Parent=gene1;Name=HBB-201
chr11	DNAForge	exon	1000	1100	.	+	.	ID=exon1;Parent=mrna1
chr11	DNAForge	exon	1300	1450	.	+	.	ID=exon2;Parent=mrna1
chr11	DNAForge	exon	1700	2000	.	+	.	ID=exon3;Parent=mrna1
chr11	DNAForge	CDS	1050	1100	.	+	0	ID=cds1;Parent=mrna1
chr11	DNAForge	CDS	1300	1450	.	+	0	ID=cds2;Parent=mrna1
chr11	DNAForge	CDS	1700	1950	.	+	2	ID=cds3;Parent=mrna1
`;

const GFF3_WITH_PROMOTER = `##gff-version 3
chr1	DNAForge	mRNA	1	500	.	+	.	ID=mrna1;gene=foo
chr1	DNAForge	exon	1	500	.	+	.	ID=exon1;Parent=mrna1
chr1	DNAForge	CDS	1	500	.	+	0	ID=cds1;Parent=mrna1
chr1	DNAForge	promoter	900	1000	.	+	.	ID=p1;Name=lac promoter
`;

const GFF3_TOPOLOGY_CIRCULAR = `##gff-version 3
##dna-indexer-topology circular
puc19	DNAForge	rep_origin	100	200	.	+	.	ID=ori1
`;

describe('isGff3Format', () => {
  it('recognizes the canonical pragma', () => {
    expect(isGff3Format('##gff-version 3\nfoo')).toBe(true);
  });

  it('rejects GFF2 / GTF', () => {
    expect(isGff3Format('##gff-version 2\nfoo')).toBe(false);
  });

  it('rejects non-pragma payloads', () => {
    expect(isGff3Format('LOCUS pUC19 2686 bp')).toBe(false);
    expect(isGff3Format('>chrom1\nACGT')).toBe(false);
  });

  it('skips leading blank lines', () => {
    expect(isGff3Format('\n\n##gff-version 3\nfoo')).toBe(true);
  });
});

describe('parseGff3AsPlasmid — transcript folding', () => {
  it('folds 3 exon + 3 CDS rows into a single transcript with segments', () => {
    const result = parseGff3AsPlasmid(MINIMAL_GFF3);
    const mrnas = result.features.filter((f) => f.type === 'mRNA');
    expect(mrnas.length).toBe(1);
    const m = mrnas[0];
    expect(m.start).toBe(1000);
    expect(m.end).toBe(2000);
    expect(m.direction).toBe('forward');
    expect(m.exons?.length).toBe(3);
    expect(m.cds?.length).toBe(3);
    expect(m.segments?.length).toBe(3);
  });

  it('exon and CDS arrays are sorted by start', () => {
    const result = parseGff3AsPlasmid(MINIMAL_GFF3);
    const m = result.features.find((f) => f.type === 'mRNA')!;
    const exonStarts = m.exons!.map((s) => s.start);
    const cdsStarts = m.cds!.map((s) => s.start);
    expect(exonStarts).toEqual([...exonStarts].sort((a, b) => a - b));
    expect(cdsStarts).toEqual([...cdsStarts].sort((a, b) => a - b));
  });

  it('does NOT re-emit consumed exon/CDS children as standalone features', () => {
    const result = parseGff3AsPlasmid(MINIMAL_GFF3);
    expect(result.features.filter((f) => f.type === 'exon').length).toBe(0);
    expect(result.features.filter((f) => f.type === 'CDS').length).toBe(0);
  });

  it('emits non-transcript rows (gene, promoter) through unchanged', () => {
    const result = parseGff3AsPlasmid(GFF3_WITH_PROMOTER);
    const promoter = result.features.find((f) => f.type === 'promoter');
    expect(promoter).toBeDefined();
    expect(promoter!.start).toBe(900);
    expect(promoter!.end).toBe(1000);
    expect(promoter!.displayName).toBe('lac promoter');
  });

  it('honors ##dna-indexer-topology circular', () => {
    const result = parseGff3AsPlasmid(GFF3_TOPOLOGY_CIRCULAR);
    expect(result.circular).toBe(true);
  });

  it('defaults to linear when no topology pragma is present', () => {
    const result = parseGff3AsPlasmid(MINIMAL_GFF3);
    expect(result.circular).toBe(false);
  });

  it('uses the first row chrom as the plasmid name', () => {
    const result = parseGff3AsPlasmid(MINIMAL_GFF3);
    expect(result.name).toBe('chr11');
  });

  it('records the transcriptId on each folded transcript', () => {
    const result = parseGff3AsPlasmid(MINIMAL_GFF3);
    const m = result.features.find((f) => f.type === 'mRNA')!;
    expect(m.transcriptId).toBe('mrna1');
  });
});
