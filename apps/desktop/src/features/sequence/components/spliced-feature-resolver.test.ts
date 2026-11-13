// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  isResolvedGene,
  isResolvedTranscript,
  type GenomeFeature,
  type ResolvedAnnotation,
} from '@waypoint/genome-data';
import {
  joinLocationString,
  resolveSplicedFeatures,
  resolveTranscripts,
} from './spliced-feature-resolver';

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

describe('resolveSplicedFeatures', () => {
  it('passes features through unchanged when none are parents or children of relevant types', () => {
    const features = [
      feat({ type: 'gene', start: 100, end: 1000, attributes: { ID: ['gene-A'] } }),
      feat({ type: 'regulatory', start: 50, end: 80, attributes: { ID: ['reg-A'] } }),
    ];
    const out = resolveSplicedFeatures(features);
    expect(out).toEqual(features);
    expect(out.every((f) => !('segments' in f) || !f.segments)).toBe(true);
  });

  it('aggregates exon children into the parent mRNA segments (1-indexed inclusive)', () => {
    const features = [
      feat({
        type: 'mRNA',
        start: 100,
        end: 1000,
        attributes: { ID: ['mRNA-X'], Name: ['NM_001'], gene: ['HXT15'] },
      }),
      feat({
        type: 'exon',
        start: 100,
        end: 200,
        attributes: { ID: ['exon-1'], Parent: ['mRNA-X'] },
      }),
      feat({
        type: 'exon',
        start: 400,
        end: 500,
        attributes: { ID: ['exon-2'], Parent: ['mRNA-X'] },
      }),
      feat({
        type: 'exon',
        start: 800,
        end: 1000,
        attributes: { ID: ['exon-3'], Parent: ['mRNA-X'] },
      }),
    ];

    const out = resolveSplicedFeatures(features);

    const mRNA = out.find((f) => f.type === 'mRNA');
    expect(mRNA).toBeDefined();
    expect(mRNA?.segments).toEqual([
      { start: 101, end: 200 },
      { start: 401, end: 500 },
      { start: 801, end: 1000 },
    ]);
    expect(mRNA?.childCount).toBe(3);

    expect(out.filter((f) => f.type === 'exon')).toHaveLength(0);
  });

  it('sorts segments by genomic start regardless of GFF3 line order', () => {
    const features = [
      feat({ type: 'mRNA', start: 100, end: 1000, attributes: { ID: ['mRNA-X'] } }),
      feat({ type: 'exon', start: 800, end: 1000, attributes: { Parent: ['mRNA-X'] } }),
      feat({ type: 'exon', start: 100, end: 200, attributes: { Parent: ['mRNA-X'] } }),
      feat({ type: 'exon', start: 400, end: 500, attributes: { Parent: ['mRNA-X'] } }),
    ];
    const out = resolveSplicedFeatures(features);
    const mRNA = out.find((f) => f.type === 'mRNA');
    expect(mRNA?.segments?.map((s) => s.start)).toEqual([101, 401, 801]);
  });

  it('handles multiple mRNA isoforms with their own exon sets', () => {
    const features = [
      feat({ type: 'gene', start: 100, end: 1000, attributes: { ID: ['gene-A'] } }),
      feat({
        type: 'mRNA',
        start: 100,
        end: 1000,
        attributes: { ID: ['mRNA-1'], Parent: ['gene-A'] },
      }),
      feat({
        type: 'mRNA',
        start: 100,
        end: 800,
        attributes: { ID: ['mRNA-2'], Parent: ['gene-A'] },
      }),
      feat({ type: 'exon', start: 100, end: 200, attributes: { Parent: ['mRNA-1'] } }),
      feat({ type: 'exon', start: 400, end: 500, attributes: { Parent: ['mRNA-1'] } }),
      feat({ type: 'exon', start: 800, end: 1000, attributes: { Parent: ['mRNA-1'] } }),
      feat({ type: 'exon', start: 100, end: 200, attributes: { Parent: ['mRNA-2'] } }),
      feat({ type: 'exon', start: 600, end: 800, attributes: { Parent: ['mRNA-2'] } }),
    ];
    const out = resolveSplicedFeatures(features);
    const mRNA1 = out.find((f) => f.attributes.ID?.[0] === 'mRNA-1');
    const mRNA2 = out.find((f) => f.attributes.ID?.[0] === 'mRNA-2');
    expect(mRNA1?.segments).toHaveLength(3);
    expect(mRNA2?.segments).toHaveLength(2);
    expect(out.filter((f) => f.type === 'gene')).toHaveLength(1);
    expect(out.filter((f) => f.type === 'exon')).toHaveLength(0);
  });

  it('keeps an mRNA without children as a flat feature (no segments)', () => {
    const features = [
      feat({ type: 'mRNA', start: 100, end: 1000, attributes: { ID: ['mRNA-orphan'] } }),
    ];
    const out = resolveSplicedFeatures(features);
    expect(out).toHaveLength(1);
    expect(out[0].segments).toBeUndefined();
  });

  it('keeps orphan exons (Parent= references a non-mRNA type or a missing ID) in the output', () => {
    const features = [
      feat({ type: 'gene', start: 100, end: 1000, attributes: { ID: ['gene-A'] } }),
      feat({ type: 'exon', start: 100, end: 200, attributes: { Parent: ['gene-A'] } }),
      feat({ type: 'exon', start: 400, end: 500, attributes: { Parent: ['mRNA-ghost'] } }),
      feat({ type: 'exon', start: 800, end: 900, attributes: {} }),
    ];
    const out = resolveSplicedFeatures(features);
    expect(out.filter((f) => f.type === 'exon')).toHaveLength(3);
  });

  it('honors a custom childTypes filter (e.g. CDS instead of exon for coding-only view)', () => {
    const features = [
      feat({ type: 'mRNA', start: 100, end: 1000, attributes: { ID: ['mRNA-X'] } }),
      feat({ type: 'CDS', start: 200, end: 250, attributes: { Parent: ['mRNA-X'] } }),
      feat({ type: 'CDS', start: 400, end: 500, attributes: { Parent: ['mRNA-X'] } }),
      feat({ type: 'exon', start: 100, end: 200, attributes: { Parent: ['mRNA-X'] } }),
    ];
    const out = resolveSplicedFeatures(features, {
      parentTypes: new Set(['mRNA']),
      childTypes: new Set(['CDS']),
    });
    const mRNA = out.find((f) => f.type === 'mRNA');
    expect(mRNA?.segments).toHaveLength(2);
    expect(out.filter((f) => f.type === 'exon')).toHaveLength(1);
  });

  it('handles multi-parent children (Parent=A,B) by attributing to all listed parents', () => {
    const features = [
      feat({ type: 'mRNA', start: 100, end: 1000, attributes: { ID: ['mRNA-1'] } }),
      feat({ type: 'mRNA', start: 100, end: 1000, attributes: { ID: ['mRNA-2'] } }),
      feat({
        type: 'exon',
        start: 100,
        end: 200,
        attributes: { ID: ['shared-exon'], Parent: ['mRNA-1', 'mRNA-2'] },
      }),
    ];
    const out = resolveSplicedFeatures(features);
    const mRNA1 = out.find((f) => f.attributes.ID?.[0] === 'mRNA-1');
    const mRNA2 = out.find((f) => f.attributes.ID?.[0] === 'mRNA-2');
    expect(mRNA1?.segments).toEqual([{ start: 101, end: 200 }]);
    expect(mRNA2?.segments).toEqual([{ start: 101, end: 200 }]);
    expect(out.filter((f) => f.type === 'exon')).toHaveLength(0);
  });

  it('treats child IDs as the dedup key — duplicate Parent= values across passes do not double-emit', () => {
    const features = [
      feat({ type: 'mRNA', start: 100, end: 1000, attributes: { ID: ['mRNA-1'] } }),
      feat({
        type: 'exon',
        start: 100,
        end: 200,
        attributes: { ID: ['exon-1'], Parent: ['mRNA-1'] },
      }),
    ];
    const out = resolveSplicedFeatures(features);
    expect(out).toHaveLength(1);
  });
});

describe('canonical GFF3 shape  Step 6 — dna-indexer Rust emit)', () => {
  it('folds exon rows under a real mRNA bbox row', () => {
    const features = [
      feat({
        type: 'mRNA',
        start: 5225463,
        end: 5227071,
        attributes: { ID: ['HBB.mrna.1'], gene: ['HBB'] },
      }),
      feat({
        type: 'exon',
        start: 5226929,
        end: 5227071,
        attributes: { ID: ['HBB.exon.1-0'], Parent: ['HBB.mrna.1'] },
      }),
      feat({
        type: 'exon',
        start: 5226576,
        end: 5226799,
        attributes: { ID: ['HBB.exon.1-1'], Parent: ['HBB.mrna.1'] },
      }),
      feat({
        type: 'exon',
        start: 5225463,
        end: 5225726,
        attributes: { ID: ['HBB.exon.1-2'], Parent: ['HBB.mrna.1'] },
      }),
    ];

    const out = resolveSplicedFeatures(features);
    const mrna = out.find((f) => f.attributes.ID?.[0] === 'HBB.mrna.1');
    expect(mrna?.segments).toHaveLength(3);
    expect(mrna?.segments).toEqual([
      { start: 5225464, end: 5225726 },
      { start: 5226577, end: 5226799 },
      { start: 5226930, end: 5227071 },
    ]);
    expect(mrna?.childCount).toBe(3);

    expect(out.filter((f) => f.type === 'exon')).toHaveLength(0);
  });

  it('passes CDS rows through unchanged (CDS is NOT in default childTypes)', () => {
    const features = [
      feat({ type: 'mRNA', start: 100, end: 1000, attributes: { ID: ['mRNA-X'] } }),
      feat({
        type: 'CDS',
        start: 150,
        end: 200,
        attributes: { ID: ['X.cds.1-0'], Parent: ['mRNA-X'] },
      }),
      feat({
        type: 'CDS',
        start: 300,
        end: 400,
        attributes: { ID: ['X.cds.1-1'], Parent: ['mRNA-X'] },
      }),
    ];
    const out = resolveSplicedFeatures(features);
    const cdsRows = out.filter((f) => f.type === 'CDS');
    expect(cdsRows).toHaveLength(2);
    for (const cds of cdsRows) {
      expect(cds.attributes.Parent).toEqual(['mRNA-X']);
    }
  });

  it('groups multiple mRNAs from the same gene independently', () => {
    const features = [
      feat({
        type: 'mRNA',
        start: 100,
        end: 1000,
        attributes: { ID: ['HBB.mrna.1'], gene: ['HBB'] },
      }),
      feat({
        type: 'exon',
        start: 100,
        end: 200,
        attributes: { ID: ['HBB.exon.1-0'], Parent: ['HBB.mrna.1'] },
      }),
      feat({
        type: 'exon',
        start: 400,
        end: 500,
        attributes: { ID: ['HBB.exon.1-1'], Parent: ['HBB.mrna.1'] },
      }),
      feat({
        type: 'mRNA',
        start: 100,
        end: 1200,
        attributes: { ID: ['HBB.mrna.2'], gene: ['HBB'] },
      }),
      feat({
        type: 'exon',
        start: 100,
        end: 250,
        attributes: { ID: ['HBB.exon.2-0'], Parent: ['HBB.mrna.2'] },
      }),
      feat({
        type: 'exon',
        start: 400,
        end: 600,
        attributes: { ID: ['HBB.exon.2-1'], Parent: ['HBB.mrna.2'] },
      }),
    ];
    const out = resolveSplicedFeatures(features);
    const m1 = out.find((f) => f.attributes.ID?.[0] === 'HBB.mrna.1');
    const m2 = out.find((f) => f.attributes.ID?.[0] === 'HBB.mrna.2');
    expect(m1?.segments).toHaveLength(2);
    expect(m2?.segments).toHaveLength(2);
    expect(out.filter((f) => f.type === 'exon')).toHaveLength(0);
  });

  it('preserves non-mRNA bbox rows (promoter, regulatory, primer_bind, …)', () => {
    const features = [
      feat({
        type: 'promoter',
        start: 541,
        end: 571,
        attributes: { ID: ['cpuc19_541-571_F_promoter'], label: ['lac promoter'] },
      }),
      feat({
        type: 'regulatory',
        start: 100,
        end: 200,
        attributes: { ID: ['cpuc19_100-200_F_regulatory'] },
      }),
      feat({
        type: 'primer_bind',
        start: 50,
        end: 70,
        attributes: { ID: ['cpuc19_50-70_F_primer_bind'] },
      }),
    ];
    const out = resolveSplicedFeatures(features);
    expect(out).toHaveLength(3);
    expect(out.map((f) => f.type).sort()).toEqual(['primer_bind', 'promoter', 'regulatory']);
  });

  it('keeps mRNA without exon children as a flat bbox row (no segments)', () => {
    const features = [
      feat({
        type: 'mRNA',
        start: 100,
        end: 1000,
        attributes: { ID: ['X.mrna.1'], gene: ['X'] },
      }),
    ];
    const out = resolveSplicedFeatures(features);
    const mrna = out.find((f) => f.attributes.ID?.[0] === 'X.mrna.1');
    expect(mrna).toBeDefined();
    expect(mrna?.segments).toBeUndefined();
  });
});

describe('legacy multipart synthesis (pre- BioPython bundles)', () => {
  it('synthesizes an mRNA parent from N mRNA rows sharing a synthetic Parent= ref', () => {
    const features = [
      feat({
        type: 'mRNA',
        start: 100,
        end: 200,
        attributes: { ID: ['LOC124905154-3-0'], Parent: ['LOC124905154-3'] },
      }),
      feat({
        type: 'mRNA',
        start: 400,
        end: 500,
        attributes: { ID: ['LOC124905154-3-1'], Parent: ['LOC124905154-3'] },
      }),
      feat({
        type: 'mRNA',
        start: 800,
        end: 1000,
        attributes: { ID: ['LOC124905154-3-2'], Parent: ['LOC124905154-3'] },
      }),
    ];
    const out = resolveSplicedFeatures(features);

    expect(out).toHaveLength(1);
    const synth = out[0];
    expect(synth.type).toBe('mRNA');
    expect(synth.attributes.ID).toEqual(['LOC124905154-3']);
    expect(synth.start).toBe(100);
    expect(synth.end).toBe(1000);
    expect(synth.segments).toEqual([
      { start: 101, end: 200 },
      { start: 401, end: 500 },
      { start: 801, end: 1000 },
    ]);
    expect(synth.childCount).toBe(3);
  });

  it('synthesizes a CDS parent from N CDS rows sharing a synthetic Parent= ref', () => {
    const features = [
      feat({
        type: 'CDS',
        start: 200,
        end: 250,
        attributes: { ID: ['CDS-A-0'], Parent: ['CDS-A'] },
      }),
      feat({
        type: 'CDS',
        start: 400,
        end: 500,
        attributes: { ID: ['CDS-A-1'], Parent: ['CDS-A'] },
      }),
    ];
    const out = resolveSplicedFeatures(features);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('CDS');
    expect(out[0].segments).toHaveLength(2);
  });

  it('does NOT synthesize when the Parent= referent has a real row (canonical-emit path wins)', () => {
    const features = [
      feat({
        type: 'mRNA',
        start: 100,
        end: 1000,
        attributes: { ID: ['mRNA-real'] },
      }),
      feat({
        type: 'CDS',
        start: 200,
        end: 300,
        attributes: { ID: ['CDS-1'], Parent: ['mRNA-real'] },
      }),
    ];
    const out = resolveSplicedFeatures(features);
    expect(out).toHaveLength(2);
    const mrna = out.find((f) => f.type === 'mRNA');
    expect(mrna?.attributes.ID).toEqual(['mRNA-real']);
    expect(mrna?.segments).toBeUndefined();
    const cds = out.find((f) => f.type === 'CDS');
    expect(cds?.attributes.Parent).toEqual(['mRNA-real']);
  });

  it('handles mixed bundles: real-parent mRNA + synthetic-parent legacy CDS in same file', () => {
    const features = [
      feat({
        type: 'mRNA',
        start: 100,
        end: 1000,
        attributes: { ID: ['mRNA-canonical'] },
      }),
      feat({
        type: 'exon',
        start: 100,
        end: 200,
        attributes: { ID: ['exon-1'], Parent: ['mRNA-canonical'] },
      }),
      feat({
        type: 'exon',
        start: 400,
        end: 500,
        attributes: { ID: ['exon-2'], Parent: ['mRNA-canonical'] },
      }),
      feat({
        type: 'CDS',
        start: 5000,
        end: 5050,
        attributes: { ID: ['CDS-legacy-0'], Parent: ['CDS-legacy'] },
      }),
      feat({
        type: 'CDS',
        start: 5200,
        end: 5300,
        attributes: { ID: ['CDS-legacy-1'], Parent: ['CDS-legacy'] },
      }),
    ];
    const out = resolveSplicedFeatures(features);
    const mrna = out.find((f) => f.attributes.ID?.[0] === 'mRNA-canonical');
    const synthCds = out.find((f) => f.attributes.ID?.[0] === 'CDS-legacy');
    expect(mrna?.segments).toHaveLength(2);
    expect(synthCds?.segments).toHaveLength(2);
    expect(out.filter((f) => f.type === 'exon')).toHaveLength(0);
    expect(out).toHaveLength(2);
  });

  it('leaves a single-part legacy row in synthesis as a degenerate 1-segment parent', () => {
    const features = [
      feat({
        type: 'mRNA',
        start: 100,
        end: 200,
        attributes: { ID: ['mRNA-only-0'], Parent: ['mRNA-only'] },
      }),
    ];
    const out = resolveSplicedFeatures(features);
    expect(out).toHaveLength(1);
    expect(out[0].segments).toHaveLength(1);
    expect(out[0].childCount).toBe(1);
  });
});

describe('resolveTranscripts — transcript-model fold (DNA-TG1)', () => {
  function findTranscript(
    out: ResolvedAnnotation[],
    id: string
  ): ReturnType<typeof isResolvedTranscript> extends true ? never : ResolvedAnnotation | undefined {
    return out.find((f) => isResolvedTranscript(f) && f.transcriptId === id);
  }

  it('Pass 2C: folds canonical mRNA + exon + CDS into one ResolvedTranscript', () => {
    const features = [
      feat({
        type: 'mRNA',
        start: 99,
        end: 1000,
        attributes: { ID: ['HBB.mrna.1'], gene: ['HBB'] },
      }),
      feat({ type: 'exon', start: 99, end: 200, attributes: { Parent: ['HBB.mrna.1'] } }),
      feat({ type: 'exon', start: 399, end: 500, attributes: { Parent: ['HBB.mrna.1'] } }),
      feat({ type: 'exon', start: 799, end: 1000, attributes: { Parent: ['HBB.mrna.1'] } }),
      feat({
        type: 'CDS',
        start: 149,
        end: 200,
        attributes: { Parent: ['HBB.mrna.1'], translation: ['MVHLT'] },
      }),
      feat({
        type: 'CDS',
        start: 399,
        end: 500,
        attributes: { Parent: ['HBB.mrna.1'], translation: ['MVHLT'] },
      }),
      feat({
        type: 'CDS',
        start: 799,
        end: 950,
        attributes: { Parent: ['HBB.mrna.1'], translation: ['MVHLT'] },
      }),
    ];
    const out = resolveTranscripts(features);
    const mrna = findTranscript(out, 'HBB.mrna.1');
    expect(mrna).toBeDefined();
    expect(isResolvedTranscript(mrna!)).toBe(true);
    if (!isResolvedTranscript(mrna!)) throw new Error('unreachable');
    expect(mrna.exons).toHaveLength(3);
    expect(mrna.cds).toEqual([
      { start: 150, end: 200 },
      { start: 400, end: 500 },
      { start: 800, end: 950 },
    ]);
    expect(mrna.translation).toBe('MVHLT');
    expect(out.filter((f) => f.type === 'exon')).toHaveLength(0);
    expect(out.filter((f) => f.type === 'CDS')).toHaveLength(0);
  });

  it('Pass 2C: consumes UTR/start/stop child rows into the transcript object', () => {
    const features = [
      feat({
        type: 'mRNA',
        start: 99,
        end: 400,
        attributes: { ID: ['TX-with-utr'] },
      }),
      feat({ type: 'exon', start: 99, end: 400, attributes: { Parent: ['TX-with-utr'] } }),
      feat({
        type: 'five_prime_UTR',
        start: 99,
        end: 149,
        attributes: { Parent: ['TX-with-utr'] },
      }),
      feat({ type: 'CDS', start: 149, end: 300, attributes: { Parent: ['TX-with-utr'] } }),
      feat({
        type: 'three_prime_UTR',
        start: 300,
        end: 400,
        attributes: { Parent: ['TX-with-utr'] },
      }),
      feat({ type: 'start_codon', start: 149, end: 152, attributes: { Parent: ['TX-with-utr'] } }),
      feat({ type: 'stop_codon', start: 297, end: 300, attributes: { Parent: ['TX-with-utr'] } }),
    ];

    const out = resolveTranscripts(features);
    const tx = findTranscript(out, 'TX-with-utr');
    if (!isResolvedTranscript(tx!)) throw new Error('unreachable');
    expect(tx.exons).toEqual([{ start: 100, end: 400 }]);
    expect(tx.cds).toEqual([{ start: 150, end: 300 }]);
    expect(out.map((f) => f.type)).toEqual(['mRNA']);
  });

  it('Pass 2C: synthesizes exon coverage from UTR + CDS rows when explicit exon rows are absent', () => {
    const features = [
      feat({
        type: 'mRNA',
        start: 99,
        end: 900,
        attributes: { ID: ['TX-no-exon-rows'] },
      }),
      feat({
        type: 'five_prime_UTR',
        start: 99,
        end: 149,
        attributes: { Parent: ['TX-no-exon-rows'] },
      }),
      feat({ type: 'CDS', start: 149, end: 300, attributes: { Parent: ['TX-no-exon-rows'] } }),
      feat({
        type: 'three_prime_UTR',
        start: 300,
        end: 400,
        attributes: { Parent: ['TX-no-exon-rows'] },
      }),
      feat({ type: 'CDS', start: 649, end: 800, attributes: { Parent: ['TX-no-exon-rows'] } }),
      feat({
        type: 'UTR',
        start: 800,
        end: 900,
        attributes: { Parent: ['TX-no-exon-rows'] },
      }),
    ];

    const out = resolveTranscripts(features);
    const tx = findTranscript(out, 'TX-no-exon-rows');
    if (!isResolvedTranscript(tx!)) throw new Error('unreachable');
    expect(tx.exons).toEqual([
      { start: 100, end: 400 },
      { start: 650, end: 900 },
    ]);
    expect(tx.cds).toEqual([
      { start: 150, end: 300 },
      { start: 650, end: 800 },
    ]);
    expect(
      out.filter((f) => ['CDS', 'five_prime_UTR', 'three_prime_UTR', 'UTR'].includes(f.type))
    ).toHaveLength(0);
  });

  it('Pass 2D: groups transcripts under their parent gene', () => {
    const features = [
      feat({ type: 'gene', start: 99, end: 1000, attributes: { ID: ['gene-HBB'] } }),
      feat({
        type: 'mRNA',
        start: 99,
        end: 1000,
        attributes: { ID: ['HBB.mrna.1'], Parent: ['gene-HBB'] },
      }),
      feat({ type: 'exon', start: 99, end: 200, attributes: { Parent: ['HBB.mrna.1'] } }),
      feat({ type: 'exon', start: 799, end: 1000, attributes: { Parent: ['HBB.mrna.1'] } }),
      feat({
        type: 'mRNA',
        start: 99,
        end: 800,
        attributes: { ID: ['HBB.mrna.2'], Parent: ['gene-HBB'] },
      }),
      feat({ type: 'exon', start: 99, end: 200, attributes: { Parent: ['HBB.mrna.2'] } }),
      feat({ type: 'exon', start: 599, end: 800, attributes: { Parent: ['HBB.mrna.2'] } }),
    ];
    const out = resolveTranscripts(features);
    const gene = out.find((f) => isResolvedGene(f));
    expect(gene).toBeDefined();
    if (!isResolvedGene(gene!)) throw new Error('unreachable');
    expect(gene.geneId).toBe('gene-HBB');
    expect(gene.transcripts).toHaveLength(2);
    expect(gene.transcripts.map((t) => t.transcriptId).sort()).toEqual([
      'HBB.mrna.1',
      'HBB.mrna.2',
    ]);
    expect(out.filter((f) => isResolvedTranscript(f))).toHaveLength(0);
  });

  it('Pass 2D: keeps gene-only annotation (no transcript kids) as ResolvedGene with empty transcripts', () => {
    const features = [
      feat({ type: 'gene', start: 99, end: 1000, attributes: { ID: ['lncRNA-region'] } }),
    ];
    const out = resolveTranscripts(features);
    const gene = out.find((f) => isResolvedGene(f));
    if (!isResolvedGene(gene!)) throw new Error('unreachable');
    expect(gene.transcripts).toEqual([]);
  });

  it('Pass 2C: handles ncRNA + exon kids (no CDS) — non-coding transcript', () => {
    const features = [
      feat({
        type: 'ncRNA',
        start: 99,
        end: 500,
        attributes: { ID: ['lnc-1'], ncRNA_class: ['lncRNA'] },
      }),
      feat({ type: 'exon', start: 99, end: 200, attributes: { Parent: ['lnc-1'] } }),
      feat({ type: 'exon', start: 399, end: 500, attributes: { Parent: ['lnc-1'] } }),
    ];
    const out = resolveTranscripts(features);
    const tx = findTranscript(out, 'lnc-1');
    if (!isResolvedTranscript(tx!)) throw new Error('unreachable');
    expect(tx.type).toBe('ncRNA');
    expect(tx.exons).toHaveLength(2);
    expect(tx.cds).toEqual([]);
    expect(tx.translation).toBeUndefined();
  });

  it('Pass 2C: handles RefSeq transcript-class terms with direct exon children', () => {
    const features = [
      feat({
        type: 'primary_transcript',
        start: 99,
        end: 200,
        attributes: { ID: ['MIR.primary_transcript.1'], gene: ['MIR'] },
      }),
      feat({
        type: 'exon',
        start: 99,
        end: 200,
        attributes: { Parent: ['MIR.primary_transcript.1'] },
      }),
      feat({
        type: 'scaRNA',
        start: 399,
        end: 500,
        attributes: { ID: ['sca-1'], gene: ['SCA'] },
      }),
      feat({
        type: 'exon',
        start: 399,
        end: 500,
        attributes: { Parent: ['sca-1'] },
      }),
      feat({
        type: 'antisense_RNA',
        start: 799,
        end: 900,
        attributes: { ID: ['as-1'], gene: ['AS'] },
      }),
      feat({
        type: 'exon',
        start: 799,
        end: 900,
        attributes: { Parent: ['as-1'] },
      }),
    ];

    const out = resolveTranscripts(features);
    expect(out.filter((f) => f.type === 'exon')).toHaveLength(0);
    for (const id of ['MIR.primary_transcript.1', 'sca-1', 'as-1']) {
      const tx = findTranscript(out, id);
      expect(isResolvedTranscript(tx!)).toBe(true);
      if (!isResolvedTranscript(tx!)) throw new Error('unreachable');
      expect(tx.exons).toHaveLength(1);
      expect(tx.cds).toEqual([]);
    }
  });

  it('Pass 2C: folds direct pseudogene/gene-segment exon children without duplicating an empty gene', () => {
    const features = [
      feat({
        type: 'pseudogene',
        start: 999,
        end: 1400,
        attributes: { ID: ['Pseudo.pseudogene.1'], gene: ['Pseudo'] },
      }),
      feat({
        type: 'exon',
        start: 999,
        end: 1100,
        attributes: { Parent: ['Pseudo.pseudogene.1'] },
      }),
      feat({
        type: 'exon',
        start: 1299,
        end: 1400,
        attributes: { Parent: ['Pseudo.pseudogene.1'] },
      }),
      feat({
        type: 'V_gene_segment',
        start: 1999,
        end: 2200,
        attributes: { ID: ['TRV.segment.1'], gene: ['TRV'] },
      }),
      feat({
        type: 'exon',
        start: 1999,
        end: 2200,
        attributes: { Parent: ['TRV.segment.1'] },
      }),
    ];

    const out = resolveTranscripts(features);
    expect(out.filter((f) => f.type === 'exon')).toHaveLength(0);
    expect(out.filter((f) => isResolvedGene(f))).toHaveLength(0);

    const pseudo = findTranscript(out, 'Pseudo.pseudogene.1');
    if (!isResolvedTranscript(pseudo!)) throw new Error('unreachable');
    expect(pseudo.type).toBe('pseudogene');
    expect(pseudo.exons).toEqual([
      { start: 1000, end: 1100 },
      { start: 1300, end: 1400 },
    ]);

    const segment = findTranscript(out, 'TRV.segment.1');
    if (!isResolvedTranscript(segment!)) throw new Error('unreachable');
    expect(segment.type).toBe('V_gene_segment');
    expect(segment.exons).toEqual([{ start: 2000, end: 2200 }]);
  });

  it('Bacterial CDS auto-promote: bare CDS keeps CDS semantics with composite geometry', () => {
    const features = [
      feat({
        type: 'CDS',
        start: 999,
        end: 2000,
        attributes: { ID: ['lacZ'], gene: ['lacZ'], translation: ['MTMITDS'] },
      }),
    ];
    const out = resolveTranscripts(features);
    expect(out).toHaveLength(1);
    expect(isResolvedTranscript(out[0])).toBe(true);
    if (!isResolvedTranscript(out[0])) throw new Error('unreachable');
    expect(out[0].type).toBe('CDS');
    expect(out[0].compositeKind).toBe('compound-cds');
    expect(out[0].exons).toEqual([{ start: 1000, end: 2000 }]);
    expect(out[0].cds).toEqual([{ start: 1000, end: 2000 }]);
    expect(out[0].translation).toBe('MTMITDS');
    expect(out[0].attributes._syntheticCompositeFeature).toEqual(['true']);
    expect(out[0].attributes._syntheticTranscript).toBeUndefined();
  });

  it('Bacterial CDS auto-promote: direct gene parent retains a nested CDS model', () => {
    const features = [
      feat({
        type: 'gene',
        start: 999,
        end: 2000,
        attributes: { ID: ['gene-lacZ'], gene: ['lacZ'] },
      }),
      feat({
        type: 'CDS',
        start: 999,
        end: 2000,
        attributes: {
          ID: ['cds-lacZ'],
          Parent: ['gene-lacZ'],
          gene: ['lacZ'],
          translation: ['MTMITDS'],
        },
      }),
    ];

    const out = resolveTranscripts(features);
    expect(out).toHaveLength(1);
    expect(isResolvedGene(out[0])).toBe(true);
    if (!isResolvedGene(out[0])) throw new Error('unreachable');
    expect(out[0].transcripts).toHaveLength(1);
    expect(out[0].transcripts[0]).toMatchObject({
      type: 'CDS',
      compositeKind: 'compound-cds',
      transcriptId: 'cds-lacZ',
      geneId: 'gene-lacZ',
      exons: [{ start: 1000, end: 2000 }],
      cds: [{ start: 1000, end: 2000 }],
    });
    expect(out.filter((feature) => feature.type === 'CDS')).toHaveLength(0);
  });

  it('groups the real MG1655 prfB row shape by protein identity and records its +1 slippage junction', () => {
    const features = [
      feat({
        type: 'gene',
        start: 3_035_183,
        end: 3_036_282,
        strand: '-',
        attributes: { ID: ['prfB.gene.1'], gene: ['prfB'], gene_biotype: ['protein_coding'] },
      }),
      feat({
        type: 'CDS',
        start: 3_035_183,
        end: 3_036_206,
        strand: '-',
        attributes: {
          ID: ['prfB.cds.1-1'],
          Parent: ['prfB.gene.1'],
          gene: ['prfB'],
          protein_id: ['NP_417367.1'],
          exception: ['ribosomal slippage'],
        },
      }),
      feat({
        type: 'CDS',
        start: 3_036_207,
        end: 3_036_282,
        strand: '-',
        attributes: {
          ID: ['prfB.cds.1-0'],
          Parent: ['prfB.gene.1'],
          gene: ['prfB'],
          protein_id: ['NP_417367.1'],
          exception: ['ribosomal slippage'],
        },
      }),
    ];

    const out = resolveTranscripts(features);
    expect(out).toHaveLength(1);
    expect(isResolvedGene(out[0])).toBe(true);
    if (!isResolvedGene(out[0])) throw new Error('unreachable');
    expect(out[0].transcripts).toHaveLength(1);
    expect(out[0].transcripts[0]).toMatchObject({
      type: 'CDS',
      compositeKind: 'compound-cds',
      transcriptId: 'NP_417367.1',
      exons: [
        { start: 3_035_184, end: 3_036_206 },
        { start: 3_036_208, end: 3_036_282 },
      ],
      cds: [
        { start: 3_035_184, end: 3_036_206 },
        { start: 3_036_208, end: 3_036_282 },
      ],
      junctions: [
        expect.objectContaining({
          relation: 'gap',
          gapBp: 1,
          interpretation: 'ribosomal-slippage-plus-one',
        }),
      ],
    });
  });

  it('keeps insertion-disrupted MG1655 pseudogene CDS fragments separate from transcript models', () => {
    const features = [
      feat({
        type: 'pseudogene',
        start: 566_683,
        end: 568_247,
        attributes: {
          ID: ['renD.pseudogene.1'],
          gene: ['renD'],
          gene_biotype: ['pseudogene'],
          pseudo: ['true'],
        },
      }),
      feat({
        type: 'CDS',
        start: 566_683,
        end: 566_776,
        attributes: {
          ID: ['renD.cds.1-0'],
          Parent: ['renD.pseudogene.1'],
          gene: ['renD'],
          pseudo: ['true'],
        },
      }),
      feat({
        type: 'CDS',
        start: 568_034,
        end: 568_247,
        attributes: {
          ID: ['renD.cds.1-1'],
          Parent: ['renD.pseudogene.1'],
          gene: ['renD'],
          pseudo: ['true'],
        },
      }),
    ];

    const out = resolveTranscripts(features);
    const gene = out.find(isResolvedGene);
    expect(gene?.transcripts).toEqual([]);
    const fragments = out.filter((feature) => feature.type === 'CDS');
    expect(fragments).toHaveLength(2);
    expect(fragments.every((feature) => !isResolvedTranscript(feature))).toBe(true);
  });

  it('Bacterial CDS auto-promote: distinct direct CDS IDs remain distinct isoforms', () => {
    const features = [
      feat({
        type: 'gene',
        start: 999,
        end: 2200,
        attributes: { ID: ['gene-infB'], gene: ['infB'] },
      }),
      feat({
        type: 'CDS',
        start: 999,
        end: 2200,
        attributes: {
          ID: ['cds-infB-long'],
          Parent: ['gene-infB'],
          gene: ['infB'],
        },
      }),
      feat({
        type: 'CDS',
        start: 999,
        end: 1900,
        attributes: {
          ID: ['cds-infB-short'],
          Parent: ['gene-infB'],
          gene: ['infB'],
        },
      }),
    ];

    const out = resolveTranscripts(features);
    expect(out).toHaveLength(1);
    expect(isResolvedGene(out[0])).toBe(true);
    if (!isResolvedGene(out[0])) throw new Error('unreachable');
    expect(out[0].transcripts).toHaveLength(2);
    expect(out[0].transcripts.map((transcript) => transcript.transcriptId).sort()).toEqual([
      'cds-infB-long',
      'cds-infB-short',
    ]);
    expect(out[0].transcripts.map((transcript) => transcript.cds)).toEqual([
      [{ start: 1000, end: 2200 }],
      [{ start: 1000, end: 1900 }],
    ]);
  });

  it('Legacy fold-up: synthetic mRNA cluster + synthetic CDS cluster sharing parent ref → one transcript with both', () => {
    const features = [
      feat({
        type: 'mRNA',
        start: 99,
        end: 200,
        attributes: { ID: ['LOC.mrna.0'], Parent: ['LOC124905154-3'] },
      }),
      feat({
        type: 'mRNA',
        start: 399,
        end: 500,
        attributes: { ID: ['LOC.mrna.1'], Parent: ['LOC124905154-3'] },
      }),
      feat({
        type: 'mRNA',
        start: 799,
        end: 1000,
        attributes: { ID: ['LOC.mrna.2'], Parent: ['LOC124905154-3'] },
      }),
      feat({
        type: 'CDS',
        start: 149,
        end: 200,
        attributes: { ID: ['LOC.cds.0'], Parent: ['LOC124905154-3'], translation: ['MTG'] },
      }),
      feat({
        type: 'CDS',
        start: 399,
        end: 500,
        attributes: { ID: ['LOC.cds.1'], Parent: ['LOC124905154-3'], translation: ['MTG'] },
      }),
      feat({
        type: 'CDS',
        start: 799,
        end: 950,
        attributes: { ID: ['LOC.cds.2'], Parent: ['LOC124905154-3'], translation: ['MTG'] },
      }),
    ];
    const out = resolveTranscripts(features);
    expect(out).toHaveLength(1);
    if (!isResolvedTranscript(out[0])) throw new Error('unreachable');
    expect(out[0].transcriptId).toBe('LOC124905154-3');
    expect(out[0].exons).toHaveLength(3);
    expect(out[0].cds).toEqual([
      { start: 150, end: 200 },
      { start: 400, end: 500 },
      { start: 800, end: 950 },
    ]);
    expect(out[0].translation).toBe('MTG');
    expect(out[0].attributes._legacyMultipart).toEqual(['true']);
  });

  it('Legacy fold-up: GBFF split mRNA and CDS clusters with different synthetic refs combine by gene and exon coverage', () => {
    const features = [
      feat({
        type: 'mRNA',
        start: 100,
        end: 140,
        attributes: { ID: ['OR4F5.mrna.0'], Parent: ['OR4F5-mrna'], gene: ['OR4F5'] },
      }),
      feat({
        type: 'mRNA',
        start: 200,
        end: 260,
        attributes: { ID: ['OR4F5.mrna.1'], Parent: ['OR4F5-mrna'], gene: ['OR4F5'] },
      }),
      feat({
        type: 'CDS',
        start: 220,
        end: 250,
        attributes: { ID: ['OR4F5.cds.0'], Parent: ['OR4F5-cds'], gene: ['OR4F5'] },
      }),
    ];

    const out = resolveTranscripts(features);
    expect(out).toHaveLength(1);
    if (!isResolvedTranscript(out[0])) throw new Error('unreachable');
    expect(out[0].transcriptId).toBe('OR4F5-mrna');
    expect(out[0].exons).toEqual([
      { start: 101, end: 140 },
      { start: 201, end: 260 },
    ]);
    expect(out[0].cds).toEqual([{ start: 221, end: 250 }]);
  });

  it('Legacy fold-up: GBFF parentless CDS attaches to matching parentless mRNA instead of becoming a separate transcript', () => {
    const features = [
      feat({
        type: 'gene',
        start: 999,
        end: 1500,
        attributes: { ID: ['B3GALT6.gene'], gene: ['B3GALT6'] },
      }),
      feat({
        type: 'mRNA',
        start: 999,
        end: 1500,
        attributes: { ID: ['B3GALT6.mrna'], gene: ['B3GALT6'] },
      }),
      feat({
        type: 'CDS',
        start: 1099,
        end: 1300,
        attributes: { ID: ['B3GALT6.cds'], gene: ['B3GALT6'] },
      }),
    ];

    const out = resolveTranscripts(features);
    const transcripts = out.filter((f) => isResolvedTranscript(f));
    expect(transcripts).toHaveLength(1);
    if (!isResolvedTranscript(transcripts[0])) throw new Error('unreachable');
    expect(transcripts[0].transcriptId).toBe('B3GALT6.mrna');
    expect(transcripts[0].exons).toEqual([{ start: 1000, end: 1500 }]);
    expect(transcripts[0].cds).toEqual([{ start: 1100, end: 1300 }]);
    expect(out.filter((f) => f.type === 'CDS')).toHaveLength(0);
  });

  it('Legacy CDS cluster WITHOUT matching mRNA cluster → standalone compound CDS', () => {
    const features = [
      feat({
        type: 'CDS',
        start: 99,
        end: 200,
        attributes: { ID: ['OrphCDS.0'], Parent: ['orph-cds-ref'] },
      }),
      feat({
        type: 'CDS',
        start: 399,
        end: 500,
        attributes: { ID: ['OrphCDS.1'], Parent: ['orph-cds-ref'] },
      }),
    ];
    const out = resolveTranscripts(features);
    expect(out).toHaveLength(1);
    if (!isResolvedTranscript(out[0])) throw new Error('unreachable');
    expect(out[0].type).toBe('CDS');
    expect(out[0].compositeKind).toBe('compound-cds');
    expect(out[0].exons).toEqual(out[0].cds);
    expect(out[0].cds).toHaveLength(2);
  });

  it('passes through non-transcript-class rows unchanged (promoter, primer_bind, regulatory)', () => {
    const features = [
      feat({
        type: 'promoter',
        start: 540,
        end: 571,
        attributes: { ID: ['lac-prom'], label: ['lac promoter'] },
      }),
      feat({ type: 'primer_bind', start: 49, end: 70, attributes: { ID: ['M13-fwd'] } }),
      feat({ type: 'regulatory', start: 99, end: 200, attributes: { ID: ['enh-1'] } }),
    ];
    const out = resolveTranscripts(features);
    expect(out).toHaveLength(3);
    expect(out.map((f) => f.type).sort()).toEqual(['primer_bind', 'promoter', 'regulatory']);
  });

  it('handles mixed canonical + legacy bundle in one resolve pass', () => {
    const features = [
      feat({
        type: 'mRNA',
        start: 99,
        end: 1000,
        attributes: { ID: ['ABL1.mrna.1'] },
      }),
      feat({ type: 'exon', start: 99, end: 1000, attributes: { Parent: ['ABL1.mrna.1'] } }),
      feat({
        type: 'CDS',
        start: 199,
        end: 800,
        attributes: { Parent: ['ABL1.mrna.1'], translation: ['MGE'] },
      }),
      feat({
        type: 'mRNA',
        start: 4999,
        end: 5500,
        attributes: { ID: ['HBB.0'], Parent: ['HBB-legacy'] },
      }),
      feat({
        type: 'CDS',
        start: 5099,
        end: 5400,
        attributes: { ID: ['HBB.cds.0'], Parent: ['HBB-legacy'] },
      }),
    ];
    const out = resolveTranscripts(features);
    expect(out).toHaveLength(2);
    const canonical = out.find((f) => isResolvedTranscript(f) && f.transcriptId === 'ABL1.mrna.1');
    const legacy = out.find((f) => isResolvedTranscript(f) && f.transcriptId === 'HBB-legacy');
    if (!isResolvedTranscript(canonical!) || !isResolvedTranscript(legacy!)) {
      throw new Error('unreachable');
    }
    expect(canonical.cds[0].start).toBe(200);
    expect(legacy.cds[0].start).toBe(5100);
    expect(legacy.attributes._legacyMultipart).toEqual(['true']);
  });

  it('Trans-splicing rejection: child with strand mismatched to parent is dropped, not folded', () => {
    const features = [
      feat({
        type: 'mRNA',
        start: 99,
        end: 1000,
        strand: '+',
        attributes: { ID: ['tx-fwd'] },
      }),
      feat({
        type: 'exon',
        start: 99,
        end: 200,
        strand: '+',
        attributes: { Parent: ['tx-fwd'] },
      }),
      feat({
        type: 'exon',
        start: 399,
        end: 500,
        strand: '-',
        attributes: { Parent: ['tx-fwd'] },
      }),
    ];
    const out = resolveTranscripts(features);
    if (!isResolvedTranscript(out[0])) throw new Error('unreachable');
    expect(out[0].exons).toHaveLength(1);
    expect(out[0].strand).toBe('+');
  });

  it('Single-exon coding (yeast typical): one exon, one CDS, flush', () => {
    const features = [
      feat({
        type: 'mRNA',
        start: 999,
        end: 2500,
        strand: '-',
        attributes: { ID: ['YAL001C'] },
      }),
      feat({
        type: 'exon',
        start: 999,
        end: 2500,
        attributes: { Parent: ['YAL001C'], strand: '-' },
        strand: '-',
      }),
      feat({
        type: 'CDS',
        start: 999,
        end: 2500,
        attributes: { Parent: ['YAL001C'] },
        strand: '-',
      }),
    ];
    const out = resolveTranscripts(features);
    if (!isResolvedTranscript(out[0])) throw new Error('unreachable');
    expect(out[0].exons).toEqual([{ start: 1000, end: 2500 }]);
    expect(out[0].cds).toEqual([{ start: 1000, end: 2500 }]);
  });
});

describe('joinLocationString', () => {
  it('emits a single-segment join() for a single-exon transcript', () => {
    expect(joinLocationString([{ start: 100, end: 200 }])).toBe('join(100..200)');
  });

  it('emits a multi-segment join() in genomic order', () => {
    const segments = [
      { start: 100, end: 200 },
      { start: 400, end: 500 },
      { start: 800, end: 1000 },
    ];
    expect(joinLocationString(segments)).toBe('join(100..200,400..500,800..1000)');
  });
});
