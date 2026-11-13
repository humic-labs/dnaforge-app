import { describe, expect, it } from 'vitest';

import { InMemoryGenomeDataSource } from './in-memory-genome-data-source';
import {
  REFERENCE_INTERVAL_MAX_FEATURE_WINDOW_BP,
  REFERENCE_INTERVAL_MAX_INLINE_BP,
  REFERENCE_INTERVAL_MAX_SEARCH_RESULTS,
  ReferenceIntervalSourceUnavailableError,
  isReferenceIntervalFailure,
  runReferenceIntervalAction,
  type ReferenceIntervalRequest,
  type ReferenceIntervalSourceIdentity,
} from './reference-interval-action';
import type {
  FeatureDetails,
  FeatureDetailsRequest,
  GenomeDataSource,
  GenomeFeature,
  SearchHit,
  SearchOpts,
} from './types';

const IDENTITY: ReferenceIntervalSourceIdentity = {
  sourceId: 'fixtures/tiny.fa',
  fastaPath: 'fixtures/tiny.fa',
};

function cds(start: number, end: number, extra: Partial<GenomeFeature> = {}): GenomeFeature {
  return {
    chrom: extra.chrom ?? 'chrI',
    source: extra.source ?? 'fixture',
    type: extra.type ?? 'CDS',
    start,
    end,
    score: extra.score ?? null,
    strand: extra.strand ?? '+',
    phase: extra.phase ?? '0',
    attributes: extra.attributes ?? { ID: ['cds1'], Parent: ['rna1'] },
    raw: extra.raw ?? 'chrI\tfixture\tCDS',
  };
}

function transcript(start: number, end: number, extra: Partial<GenomeFeature> = {}): GenomeFeature {
  return cds(start, end, {
    type: 'mRNA',
    phase: null,
    attributes: { ID: ['rna1'], Parent: ['gene1'] },
    ...extra,
  });
}

function exon(start: number, end: number, extra: Partial<GenomeFeature> = {}): GenomeFeature {
  return cds(start, end, {
    type: 'exon',
    phase: null,
    attributes: { ID: [`exon-${start}-${end}`], Parent: ['rna1'] },
    ...extra,
  });
}

function request(
  partial: Partial<ReferenceIntervalRequest> & Pick<ReferenceIntervalRequest, 'operation'>
): ReferenceIntervalRequest {
  return {
    chrom: 'chrI',
    start0: 0,
    end0: 9,
    strand: '+',
    ...partial,
  };
}

async function run(
  sequence: string,
  req: ReferenceIntervalRequest,
  features: GenomeFeature[] = [],
  source?: GenomeDataSource | null
) {
  const resolvedSource =
    source === undefined
      ? new InMemoryGenomeDataSource({ chrom: 'chrI', sequence, features })
      : source;
  return runReferenceIntervalAction(resolvedSource, req, IDENTITY);
}

describe('runReferenceIntervalAction — reads', () => {
  it('returns exact forward-strand bases for a 0-based half-open interval', async () => {
    const result = await run('ATGAAATGA', request({ operation: 'read', start0: 0, end0: 6 }));
    expect(isReferenceIntervalFailure(result)).toBe(false);
    if (isReferenceIntervalFailure(result)) return;
    expect(result.operation).toBe('read');
    expect(result.sequence).toBe('ATGAAA');
    expect(result.interval).toEqual({
      chrom: 'chrI',
      start0: 0,
      end0: 6,
      strand: '+',
      length: 6,
    });
    expect(result.provenance.sourceId).toBe('fixtures/tiny.fa');
    expect(result.provenance.chromosomeLength).toBe(9);
    expect(result.provenance.sequenceFingerprint).toMatch(/^[0-9a-f]{8}$/);
  });

  it('upper-cases bases to match the indexed data plane', async () => {
    const result = await run('atgaaatga', request({ operation: 'read', start0: 3, end0: 6 }));
    expect(isReferenceIntervalFailure(result)).toBe(false);
    if (isReferenceIntervalFailure(result)) return;
    expect(result.sequence).toBe('AAA');
  });

  it('reverse-complements through the canonical IUPAC table, including ambiguity codes', async () => {
    const result = await run(
      'ACGTNRY',
      request({ operation: 'reverse_complement', start0: 0, end0: 7 })
    );
    expect(isReferenceIntervalFailure(result)).toBe(false);
    if (isReferenceIntervalFailure(result)) return;
    expect(result.sequence).toBe('RYNACGT');
  });
});

describe('runReferenceIntervalAction — spliced transcript reads', () => {
  it('copies exon bases in transcript order without introns', async () => {
    const features = [transcript(0, 9), exon(0, 3), exon(6, 9)];
    const result = await run(
      'AAACCCTTT',
      request({ operation: 'read_spliced', start0: 0, end0: 9, featureId: 'rna1' }),
      features
    );

    expect(isReferenceIntervalFailure(result)).toBe(false);
    if (isReferenceIntervalFailure(result)) return;
    expect(result.splicedSequence).toEqual({
      sequence: 'AAATTT',
      length: 6,
      featureId: 'rna1',
      segments: [
        { start0: 0, end0: 3, strand: '+' },
        { start0: 6, end0: 9, strand: '+' },
      ],
    });
  });

  it('reverse-complements minus-strand exons in reverse genomic order', async () => {
    const features = [
      transcript(0, 9, { strand: '-' }),
      exon(0, 3, { strand: '-' }),
      exon(6, 9, { strand: '-' }),
    ];
    const result = await run(
      'ATGCCCGTA',
      request({
        operation: 'read_spliced',
        start0: 0,
        end0: 9,
        strand: '-',
        featureId: 'rna1',
      }),
      features
    );

    expect(isReferenceIntervalFailure(result)).toBe(false);
    if (isReferenceIntervalFailure(result)) return;
    expect(result.splicedSequence?.sequence).toBe('TACCAT');
  });

  it('uses the transcript span for a single-part RNA without explicit exon rows', async () => {
    const features = [transcript(1, 7)];
    const result = await run(
      'AATGCCCT',
      request({ operation: 'read_spliced', start0: 1, end0: 7, featureId: 'rna1' }),
      features
    );

    expect(isReferenceIntervalFailure(result)).toBe(false);
    if (isReferenceIntervalFailure(result)) return;
    expect(result.splicedSequence?.sequence).toBe('ATGCCC');
    expect(result.splicedSequence?.segments).toEqual([{ start0: 1, end0: 7, strand: '+' }]);
  });

  it('infers complete exon coverage from direct CDS and UTR children when exon rows are absent', async () => {
    const features = [
      transcript(0, 12),
      cds(0, 2, { type: 'five_prime_UTR', phase: null }),
      cds(2, 5),
      cds(8, 10),
      cds(10, 12, { type: 'three_prime_UTR', phase: null }),
    ];
    const result = await run(
      'AAACCGGGTTTA',
      request({ operation: 'read_spliced', start0: 0, end0: 12, featureId: 'rna1' }),
      features
    );

    expect(isReferenceIntervalFailure(result)).toBe(false);
    if (isReferenceIntervalFailure(result)) return;
    expect(result.splicedSequence?.sequence).toBe('AAACCTTTA');
    expect(result.splicedSequence?.segments).toEqual([
      { start0: 0, end0: 5, strand: '+' },
      { start0: 8, end0: 12, strand: '+' },
    ]);
  });

  it('rejects CDS/UTR inference when child coverage does not prove both transcript ends', async () => {
    const features = [transcript(0, 9), cds(2, 7)];
    const result = await run(
      'AAACCCTTT',
      request({ operation: 'read_spliced', start0: 0, end0: 9, featureId: 'rna1' }),
      features
    );

    expect(result).toMatchObject({ ok: false, code: 'NO_TRANSCRIPT_SEGMENTS' });
  });

  it('rejects a non-transcript feature instead of copying its bounding box', async () => {
    const gene = transcript(0, 9, { type: 'gene', attributes: { ID: ['gene1'] } });
    const result = await run(
      'AAACCCTTT',
      request({ operation: 'read_spliced', start0: 0, end0: 9, featureId: 'gene1' }),
      [gene]
    );

    expect(result).toMatchObject({ ok: false, code: 'NO_TRANSCRIPT_SEGMENTS' });
  });

  it('caps the total exon bases before materializing sequence', async () => {
    const length = REFERENCE_INTERVAL_MAX_INLINE_BP + 1;
    const features = [transcript(0, length), exon(0, length)];
    const result = await run(
      'A'.repeat(length),
      request({ operation: 'read_spliced', start0: 0, end0: 1, featureId: 'rna1' }),
      features
    );

    expect(result).toMatchObject({
      ok: false,
      code: 'OVER_LIMIT',
      details: { requestedLength: length, maxInlineBp: REFERENCE_INTERVAL_MAX_INLINE_BP },
    });
  });
});

describe('runReferenceIntervalAction — six-frame translation', () => {
  it('returns all six frames with explicit strand, frame, incomplete-codon, and stop behavior', async () => {
    const result = await run('ATGAAATGA', request({ operation: 'translate', start0: 0, end0: 9 }));
    expect(isReferenceIntervalFailure(result)).toBe(false);
    if (isReferenceIntervalFailure(result)) return;
    expect(result.translations).toHaveLength(6);

    const plus0 = result.translations?.find((row) => row.strand === '+' && row.frame === 0);
    expect(plus0?.protein).toBe('MK*');
    expect(plus0?.incompleteCodon).toBe(false);
    expect(plus0?.codonCount).toBe(3);

    const plus1 = result.translations?.find((row) => row.strand === '+' && row.frame === 1);
    expect(plus1?.protein).toBe('*N');
    expect(plus1?.incompleteCodon).toBe(true);

    const minus0 = result.translations?.find((row) => row.strand === '-' && row.frame === 0);
    expect(minus0?.protein).toBe('SFH');
    expect(minus0?.incompleteCodon).toBe(false);
  });

  it('translates degenerate codons the way sequence-utils does: CGN is arginine, NNK is X', async () => {
    const result = await run('CGNNNK', request({ operation: 'translate', start0: 0, end0: 6 }));
    expect(isReferenceIntervalFailure(result)).toBe(false);
    if (isReferenceIntervalFailure(result)) return;
    const plus0 = result.translations?.find((row) => row.strand === '+' && row.frame === 0);
    expect(plus0?.protein).toBe('RX');
  });
});

describe('runReferenceIntervalAction — spliced phase-aware translation', () => {
  it('concatenates CDS children in coding order and drops a trailing stop', async () => {
    const sequence = 'ATGAAACCCGGGTTTTAA';
    const features = [
      cds(0, 6, { attributes: { ID: ['cdsA'], Parent: ['rna1'] } }),
      cds(9, 18, { attributes: { ID: ['cdsB'], Parent: ['rna1'] } }),
    ];
    const result = await run(
      sequence,
      request({ operation: 'translate_spliced', start0: 0, end0: 18, featureId: 'rna1' }),
      features
    );
    expect(isReferenceIntervalFailure(result)).toBe(false);
    if (isReferenceIntervalFailure(result)) return;
    expect(result.spliced?.protein).toBe('MKGF');
    expect(result.spliced?.codingLength).toBe(15);
    expect(result.spliced?.frameOffset).toBe(0);
    expect(result.spliced?.incompleteCodon).toBe(false);
    expect(result.spliced?.hadTrailingStop).toBe(true);
    expect(result.spliced?.segments).toEqual([
      { start0: 0, end0: 6, strand: '+' },
      { start0: 9, end0: 18, strand: '+' },
    ]);
  });

  it('applies GFF phase from the first coding-order CDS part', async () => {
    const sequence = 'CATGAAA';
    const features = [cds(0, 7, { phase: '1', attributes: { ID: ['cds1'], Parent: ['rna1'] } })];
    const result = await run(
      sequence,
      request({ operation: 'translate_spliced', start0: 0, end0: 7, featureId: 'rna1' }),
      features
    );
    expect(isReferenceIntervalFailure(result)).toBe(false);
    if (isReferenceIntervalFailure(result)) return;
    expect(result.spliced?.frameOffset).toBe(1);
    expect(result.spliced?.protein).toBe('MK');
    expect(result.spliced?.incompleteCodon).toBe(false);
  });

  it('reverse-complements minus-strand CDS parts in reverse genomic order', async () => {
    const sequence = 'TTAAAACAT';
    const features = [
      cds(0, 9, {
        strand: '-',
        attributes: { ID: ['cds1'], Parent: ['rna1'] },
      }),
    ];
    const result = await run(
      sequence,
      request({
        operation: 'translate_spliced',
        start0: 0,
        end0: 9,
        strand: '-',
        featureId: 'rna1',
      }),
      features
    );
    expect(isReferenceIntervalFailure(result)).toBe(false);
    if (isReferenceIntervalFailure(result)) return;
    expect(result.spliced?.protein).toBe('MF');
    expect(result.spliced?.hadTrailingStop).toBe(true);
  });

  it('refuses when two unrelated CDS groups overlap and no featureId is given', async () => {
    const sequence = 'ATGAAATGAATGAAATGA';
    const features = [
      cds(0, 9, { attributes: { ID: ['cdsA'], Parent: ['rnaA'] } }),
      cds(9, 18, { attributes: { ID: ['cdsB'], Parent: ['rnaB'] } }),
    ];
    const result = await run(
      sequence,
      request({ operation: 'translate_spliced', start0: 0, end0: 18 }),
      features
    );
    expect(result).toMatchObject({ ok: false, code: 'AMBIGUOUS_FEATURE' });
  });

  it('enumerates exact-interval CDS groups before asking an indexed source for closure', async () => {
    class BroadPrimarySource extends InMemoryGenomeDataSource {
      async getFeatureDetails(): Promise<FeatureDetails> {
        throw new Error('ambiguous interval must not choose a primary closure');
      }
    }
    const features = [
      cds(0, 9, { attributes: { ID: ['cdsA'], Parent: ['rnaA'] } }),
      cds(9, 18, { attributes: { ID: ['cdsB'], Parent: ['rnaB'] } }),
    ];
    const source = new BroadPrimarySource({
      chrom: 'chrI',
      sequence: 'ATGAAATGAATGAAATGA',
      features,
    });

    const result = await run(
      'ATGAAATGAATGAAATGA',
      request({ operation: 'translate_spliced', start0: 0, end0: 18 }),
      features,
      source
    );

    expect(result).toMatchObject({ ok: false, code: 'AMBIGUOUS_FEATURE' });
  });

  it('rejects a featureId whose CDS does not overlap the requested interval', async () => {
    class PaddedFeatureSource extends InMemoryGenomeDataSource {
      async getFeatureDetails(request: FeatureDetailsRequest): Promise<FeatureDetails> {
        return {
          chrom: request.chrom,
          featureId: 'rna1',
          feature: cds(3, 9, { attributes: { ID: ['rna1'] }, type: 'mRNA' }),
          relatedFeatures: [cds(3, 9, { attributes: { ID: ['cds1'], Parent: ['rna1'] } })],
          sourceRecordCount: 2,
          window: { start: 0, end: 9 },
          truncated: false,
        };
      }
    }
    const features = [cds(3, 9, { attributes: { ID: ['cds1'], Parent: ['rna1'] } })];
    const source = new PaddedFeatureSource({
      chrom: 'chrI',
      sequence: 'AAAATGTAA',
      features,
    });

    const result = await run(
      'AAAATGTAA',
      request({ operation: 'translate_spliced', start0: 0, end0: 3, featureId: 'rna1' }),
      features,
      source
    );

    expect(result).toMatchObject({ ok: false, code: 'MISSING_FEATURE' });
  });

  it('loads a complete CDS closure after one overlapping group is selected', async () => {
    class CompleteClosureSource extends InMemoryGenomeDataSource {
      async getFeatureDetails(request: FeatureDetailsRequest): Promise<FeatureDetails> {
        return {
          chrom: request.chrom,
          featureId: 'rna1',
          feature: cds(0, 18, { attributes: { ID: ['rna1'] }, type: 'mRNA' }),
          relatedFeatures: [
            cds(0, 6, { attributes: { ID: ['cdsA'], Parent: ['rna1'] } }),
            cds(9, 18, { attributes: { ID: ['cdsB'], Parent: ['rna1'] } }),
          ],
          sourceRecordCount: 3,
          window: { start: 0, end: 18 },
          truncated: false,
        };
      }
    }
    const intervalFeatures = [cds(0, 6, { attributes: { ID: ['cdsA'], Parent: ['rna1'] } })];
    const source = new CompleteClosureSource({
      chrom: 'chrI',
      sequence: 'ATGAAACCCGGGTTTTAA',
      features: intervalFeatures,
    });

    const result = await run(
      'ATGAAACCCGGGTTTTAA',
      request({ operation: 'translate_spliced', start0: 0, end0: 6 }),
      intervalFeatures,
      source
    );

    expect(isReferenceIntervalFailure(result)).toBe(false);
    if (isReferenceIntervalFailure(result)) return;
    expect(result.spliced?.protein).toBe('MKGF');
    expect(result.spliced?.segments).toHaveLength(2);
  });

  it('fails closed when the source cannot provide a complete feature closure', async () => {
    const delegate = new InMemoryGenomeDataSource({
      chrom: 'chrI',
      sequence: 'ATGCCCCCCCAAATTT',
      features: [cds(0, 3, { attributes: { ID: ['cds1'], Parent: ['rna1'] } })],
    });
    const source: GenomeDataSource = {
      getChromosomeLength: (chrom) => delegate.getChromosomeLength(chrom),
      getSequence: (chrom, start, end, options) => delegate.getSequence(chrom, start, end, options),
      getFeatures: (chrom, start, end, zoomLevel, options) =>
        delegate.getFeatures(chrom, start, end, zoomLevel, options),
      searchSequence: (chrom, motif, options) => delegate.searchSequence(chrom, motif, options),
    };

    const result = await run(
      'ATGCCCCCCCAAATTT',
      request({ operation: 'translate_spliced', start0: 0, end0: 3, featureId: 'rna1' }),
      [],
      source
    );

    expect(result).toMatchObject({ ok: false, code: 'INVALID_SOURCE' });
    if (isReferenceIntervalFailure(result))
      expect(result.error).toMatch(/complete feature closure/i);
  });

  it('loads transcript siblings when featureId names one child CDS', async () => {
    class ChildClosureSource extends InMemoryGenomeDataSource {
      async getFeatureDetails(request: FeatureDetailsRequest): Promise<FeatureDetails> {
        return {
          chrom: request.chrom,
          featureId: 'cdsA',
          feature: cds(0, 6, { attributes: { ID: ['cdsA'], Parent: ['rna1'] } }),
          relatedFeatures: [
            cds(0, 18, { attributes: { ID: ['rna1'] }, type: 'mRNA' }),
            cds(0, 6, { attributes: { ID: ['cdsA'], Parent: ['rna1'] } }),
            cds(9, 18, { attributes: { ID: ['cdsB'], Parent: ['rna1'] } }),
          ],
          sourceRecordCount: 3,
          window: { start: 0, end: 18 },
          truncated: false,
        };
      }
    }
    const intervalFeatures = [cds(0, 6, { attributes: { ID: ['cdsA'], Parent: ['rna1'] } })];
    const source = new ChildClosureSource({
      chrom: 'chrI',
      sequence: 'ATGAAACCCGGGTTTTAA',
      features: intervalFeatures,
    });

    const result = await run(
      'ATGAAACCCGGGTTTTAA',
      request({ operation: 'translate_spliced', start0: 0, end0: 6, featureId: 'cdsA' }),
      intervalFeatures,
      source
    );

    expect(isReferenceIntervalFailure(result)).toBe(false);
    if (isReferenceIntervalFailure(result)) return;
    expect(result.spliced?.protein).toBe('MKGF');
    expect(result.spliced?.segments).toHaveLength(2);
  });

  it('rejects a shared CDS interval instead of silently choosing its first parent transcript', async () => {
    const shared = cds(0, 6, {
      attributes: { ID: ['cds-shared'], Parent: ['rna1', 'rna2'] },
    });

    const result = await run(
      'ATGAAA',
      request({ operation: 'translate_spliced', start0: 0, end0: 6 }),
      [shared]
    );

    expect(result).toMatchObject({ ok: false, code: 'AMBIGUOUS_FEATURE' });
  });

  it('rejects a multi-parent child CDS featureId as transcript-ambiguous', async () => {
    const shared = cds(0, 6, {
      attributes: { ID: ['cds-shared'], Parent: ['rna1', 'rna2'] },
    });

    const result = await run(
      'ATGAAA',
      request({
        operation: 'translate_spliced',
        start0: 0,
        end0: 6,
        featureId: 'cds-shared',
      }),
      [shared]
    );

    expect(result).toMatchObject({ ok: false, code: 'AMBIGUOUS_FEATURE' });
  });

  it.each([null, '.', '3'])('rejects missing or malformed CDS phase %s', async (phase) => {
    const features = [
      {
        ...cds(0, 6, {
          attributes: { ID: ['cds1'], Parent: ['rna1'] },
        }),
        phase,
      },
    ];

    const result = await run(
      'ATGAAA',
      request({ operation: 'translate_spliced', start0: 0, end0: 6, featureId: 'rna1' }),
      features
    );

    expect(result).toMatchObject({ ok: false, code: 'INVALID_SOURCE' });
  });

  it('rejects a legal downstream phase that contradicts the accumulated coding frame', async () => {
    const features = [
      cds(0, 4, {
        phase: '0',
        attributes: { ID: ['cds1'], Parent: ['rna1'] },
      }),
      cds(4, 8, {
        phase: '1',
        attributes: { ID: ['cds2'], Parent: ['rna1'] },
      }),
    ];

    const result = await run(
      'ATGAAAAT',
      request({ operation: 'translate_spliced', start0: 0, end0: 8, featureId: 'rna1' }),
      features
    );

    expect(result).toMatchObject({ ok: false, code: 'INVALID_SOURCE' });
    if (isReferenceIntervalFailure(result)) expect(result.error).toMatch(/frame-inconsistent/i);
  });

  it('derives the frame when every segment carries phase 0 that the lengths contradict', async () => {
    const features = [
      cds(0, 4, { phase: '0', attributes: { ID: ['cds1'], Parent: ['rna1'] } }),
      cds(10, 15, { phase: '0', attributes: { ID: ['cds2'], Parent: ['rna1'] } }),
    ];

    const result = await run(
      'ATGGCCCCCCAATAAAAAAA',
      request({ operation: 'translate_spliced', start0: 0, end0: 15, featureId: 'rna1' }),
      features
    );

    expect(result).toMatchObject({
      ok: true,
      spliced: { protein: 'ME', phaseSource: 'derived', hadTrailingStop: true },
    });
  });

  it('refuses a derived frame that runs into an internal stop', async () => {
    const features = [
      cds(0, 4, { phase: '0', attributes: { ID: ['cds1'], Parent: ['rna1'] } }),
      cds(10, 19, { phase: '0', attributes: { ID: ['cds2'], Parent: ['rna1'] } }),
    ];

    const result = await run(
      'ATGGCCCCCCAATAAAGCCC',
      request({ operation: 'translate_spliced', start0: 0, end0: 19, featureId: 'rna1' }),
      features
    );

    expect(result).toMatchObject({ ok: false, code: 'INVALID_SOURCE' });
    if (isReferenceIntervalFailure(result)) expect(result.error).toMatch(/reading frame/i);
  });

  it('marks consistent source phases as source', async () => {
    const features = [
      cds(0, 4, { phase: '0', attributes: { ID: ['cds1'], Parent: ['rna1'] } }),
      cds(10, 15, { phase: '2', attributes: { ID: ['cds2'], Parent: ['rna1'] } }),
    ];

    const result = await run(
      'ATGGCCCCCCAATAAAAAAA',
      request({ operation: 'translate_spliced', start0: 0, end0: 15, featureId: 'rna1' }),
      features
    );

    expect(result).toMatchObject({ ok: true, spliced: { phaseSource: 'source' } });
  });

  it('rejects unsupported codon-level translation exceptions', async () => {
    const features = [
      cds(0, 6, {
        attributes: {
          ID: ['cds1'],
          Parent: ['rna1'],
          transl_except: ['(pos:4..6,aa:Sec)'],
        },
      }),
    ];

    const result = await run(
      'ATGTGA',
      request({ operation: 'translate_spliced', start0: 0, end0: 6, featureId: 'rna1' }),
      features
    );

    expect(result).toMatchObject({ ok: false, code: 'INVALID_SOURCE' });
    if (isReferenceIntervalFailure(result)) expect(result.error).toMatch(/transl_except/);
  });

  it.each([
    {
      label: 'non-standard CDS table',
      features: [
        cds(0, 6, {
          attributes: { ID: ['cds1'], Parent: ['rna1'], transl_table: ['4'] },
        }),
      ],
    },
    {
      label: 'transcript-level table declaration',
      features: [
        cds(0, 6, {
          type: 'mRNA',
          attributes: { ID: ['rna1'], transl_table: ['4'] },
        }),
        cds(0, 6, { attributes: { ID: ['cds1'], Parent: ['rna1'] } }),
      ],
    },
    {
      label: 'conflicting table declarations',
      features: [
        cds(0, 3, {
          attributes: { ID: ['cds1'], Parent: ['rna1'], transl_table: ['1'] },
        }),
        cds(3, 6, {
          attributes: { ID: ['cds2'], Parent: ['rna1'], transl_table: ['4'] },
        }),
      ],
    },
  ])('fails closed for $label instead of returning a table-1 protein', async ({ features }) => {
    const result = await run(
      'ATGTGA',
      request({ operation: 'translate_spliced', start0: 0, end0: 6, featureId: 'rna1' }),
      features
    );

    expect(result).toMatchObject({ ok: false, code: 'INVALID_SOURCE' });
  });

  it('ignores a genetic-code declaration on an unrelated closure row', async () => {
    const features = [
      cds(0, 6, {
        type: 'mRNA',
        attributes: { ID: ['rna-other'], transl_table: ['4'] },
      }),
      cds(0, 6, {
        attributes: { ID: ['cds1'], Parent: ['rna1'], transl_table: ['1'] },
      }),
    ];

    const result = await run(
      'ATGTAA',
      request({ operation: 'translate_spliced', start0: 0, end0: 6, featureId: 'rna1' }),
      features
    );

    expect(isReferenceIntervalFailure(result)).toBe(false);
    if (isReferenceIntervalFailure(result)) return;
    expect(result.spliced?.protein).toBe('M');
  });

  it('rejects a selected CDS whose strand disagrees with request provenance', async () => {
    const features = [
      cds(0, 9, {
        strand: '-',
        attributes: { ID: ['cds1'], Parent: ['rna1'] },
      }),
    ];
    const result = await run(
      'TTAAAACAT',
      request({
        operation: 'translate_spliced',
        start0: 0,
        end0: 9,
        strand: '+',
        featureId: 'rna1',
      }),
      features
    );

    expect(result).toMatchObject({ ok: false, code: 'INVALID_STRAND' });
  });

  it.each([
    {
      label: 'negative start',
      features: [cds(-1, 3, { attributes: { ID: ['cds1'], Parent: ['rna1'] } })],
    },
    {
      label: 'reversed range',
      features: [cds(6, 3, { attributes: { ID: ['cds1'], Parent: ['rna1'] } })],
    },
    {
      label: 'past chromosome end',
      features: [cds(0, 10, { attributes: { ID: ['cds1'], Parent: ['rna1'] } })],
    },
    {
      label: 'foreign chromosome',
      features: [
        cds(0, 3, {
          chrom: 'chrII',
          attributes: { ID: ['cds1'], Parent: ['rna1'] },
        }),
      ],
    },
    {
      label: 'overlapping segments',
      features: [
        cds(0, 6, { attributes: { ID: ['cds1'], Parent: ['rna1'] } }),
        cds(3, 9, { attributes: { ID: ['cds2'], Parent: ['rna1'] } }),
      ],
    },
  ])('rejects $label CDS geometry before reading sequence', async ({ features }) => {
    let sequenceReads = 0;
    class CraftedFeatureSource extends InMemoryGenomeDataSource {
      async getFeatures(): Promise<GenomeFeature[]> {
        return features;
      }

      async getFeatureDetails(request: FeatureDetailsRequest): Promise<FeatureDetails> {
        return {
          chrom: request.chrom,
          featureId: request.featureId,
          feature: null,
          relatedFeatures: features,
          sourceRecordCount: features.length,
          window: { start: 0, end: 9 },
          truncated: false,
        };
      }

      async getSequence(
        chrom: string,
        start: number,
        end: number,
        options?: { signal?: AbortSignal }
      ): Promise<string> {
        sequenceReads += 1;
        return super.getSequence(chrom, start, end, options);
      }
    }
    const source = new CraftedFeatureSource({ chrom: 'chrI', sequence: 'ATGAAATGA', features: [] });

    const result = await run(
      'ATGAAATGA',
      request({ operation: 'translate_spliced', start0: 0, end0: 9, featureId: 'rna1' }),
      [],
      source
    );

    expect(result).toMatchObject({ ok: false, code: 'INVALID_SOURCE' });
    expect(sequenceReads).toBe(0);
  });

  it('returns NO_CODING_SEGMENTS when the window has no CDS', async () => {
    const result = await run(
      'ATGAAATGA',
      request({ operation: 'translate_spliced', start0: 0, end0: 9 }),
      []
    );
    expect(result).toMatchObject({ ok: false, code: 'NO_CODING_SEGMENTS' });
  });

  it('fails closed when the indexed feature-details closure is truncated', async () => {
    class TruncatedFeatureSource extends InMemoryGenomeDataSource {
      async getFeatureDetails(request: FeatureDetailsRequest): Promise<FeatureDetails> {
        return {
          chrom: request.chrom,
          ...(request.featureId ? { featureId: request.featureId } : {}),
          feature: cds(0, 6, { attributes: { ID: ['rna1'] }, type: 'mRNA' }),
          relatedFeatures: [cds(0, 6, { attributes: { ID: ['cdsA'], Parent: ['rna1'] } })],
          sourceRecordCount: 2,
          window: { start: 0, end: 6 },
          truncated: true,
        };
      }
    }
    const source = new TruncatedFeatureSource({
      chrom: 'chrI',
      sequence: 'ATGAAA',
      features: [cds(0, 6, { attributes: { ID: ['cdsA'], Parent: ['rna1'] } })],
    });

    const result = await run(
      'ATGAAA',
      request({ operation: 'translate_spliced', start0: 0, end0: 6, featureId: 'rna1' }),
      [],
      source
    );

    expect(result).toMatchObject({
      ok: false,
      code: 'OVER_LIMIT',
      details: { maxWindowBp: REFERENCE_INTERVAL_MAX_FEATURE_WINDOW_BP },
    });
  });
});

describe('runReferenceIntervalAction — bounded motif search', () => {
  it('finds forward and reverse IUPAC hits without loading past the requested window', async () => {
    const result = await run(
      'ACGTACGT',
      request({ operation: 'search', start0: 0, end0: 8, motif: 'RY' })
    );
    expect(isReferenceIntervalFailure(result)).toBe(false);
    if (isReferenceIntervalFailure(result)) return;
    expect(result.searchHits?.some((hit) => hit.start === 0 && hit.strand === 'forward')).toBe(
      true
    );
    expect(result.searchHits?.length).toBeGreaterThan(0);
    expect(result.searchHits?.every((hit) => hit.start >= 0 && hit.end <= 8)).toBe(true);
  });

  it('rejects a motif that is not IUPAC DNA', async () => {
    const result = await run(
      'ACGT',
      request({ operation: 'search', start0: 0, end0: 4, motif: 'QZ' })
    );
    expect(result).toMatchObject({ ok: false, code: 'INVALID_MOTIF' });
  });

  it('caps search results at the documented bound', async () => {
    expect(REFERENCE_INTERVAL_MAX_SEARCH_RESULTS).toBe(500);
    const result = await run(
      'AAAAAAAAAAAAAAAA',
      request({ operation: 'search', start0: 0, end0: 16, motif: 'A', maxResults: 3 })
    );
    expect(isReferenceIntervalFailure(result)).toBe(false);
    if (isReferenceIntervalFailure(result)) return;
    expect(result.searchHits).toHaveLength(3);
    expect(result.searchTruncated).toBe(true);
  });

  it('distinguishes an exact result count from a truncated result set', async () => {
    const result = await run(
      'AAATAA',
      request({ operation: 'search', start0: 0, end0: 6, motif: 'AAA', maxResults: 1 })
    );
    expect(isReferenceIntervalFailure(result)).toBe(false);
    if (isReferenceIntervalFailure(result)) return;
    expect(result.searchHits).toHaveLength(1);
    expect(result.searchTruncated).toBe(false);
  });

  it('rejects malformed FASTA chunks during the same bounded motif scan', async () => {
    const source = new InMemoryGenomeDataSource({
      chrom: 'chrI',
      sequence: 'ACG!ACG',
      features: [],
    });

    const result = await run(
      'ACG!ACG',
      request({ operation: 'search', start0: 0, end0: 7, motif: 'ACG' }),
      [],
      source
    );

    expect(result).toMatchObject({ ok: false, code: 'INVALID_SOURCE' });
  });

  it('validates and matches in one source scan without a renderer-side sequence pass', async () => {
    let sequenceReads = 0;
    let validationRequested = false;
    class SinglePassSearchSource extends InMemoryGenomeDataSource {
      async getSequence(
        chrom: string,
        start: number,
        end: number,
        options?: { signal?: AbortSignal }
      ): Promise<string> {
        sequenceReads += 1;
        return super.getSequence(chrom, start, end, options);
      }

      async *searchSequence(
        chrom: string,
        motif: string,
        options: SearchOpts = {}
      ): AsyncIterable<SearchHit> {
        validationRequested = options.validateIupacDna === true;
        yield* super.searchSequence(chrom, motif, options);
      }
    }
    const source = new SinglePassSearchSource({
      chrom: 'chrI',
      sequence: 'ACGTACGT',
      features: [],
    });

    const result = await run(
      'ACGTACGT',
      request({ operation: 'search', start0: 0, end0: 8, motif: 'ACG' }),
      [],
      source
    );

    expect(isReferenceIntervalFailure(result)).toBe(false);
    expect(validationRequested).toBe(true);
    expect(sequenceReads).toBe(0);
  });

  it('returns a long search motif once instead of repeating it in every bounded hit', async () => {
    const motif = 'A'.repeat(16_384);
    class ManyHitSource extends InMemoryGenomeDataSource {
      async *searchSequence(
        chrom: string,
        searchMotif: string,
        _opts?: SearchOpts
      ): AsyncIterable<SearchHit> {
        for (let index = 0; index < REFERENCE_INTERVAL_MAX_SEARCH_RESULTS; index += 1) {
          yield {
            chrom,
            start: index,
            end: index + searchMotif.length,
            strand: 'forward',
            motif: searchMotif,
          };
        }
      }
    }
    const source = new ManyHitSource({
      chrom: 'chrI',
      sequence: 'A'.repeat(motif.length + REFERENCE_INTERVAL_MAX_SEARCH_RESULTS),
      features: [],
    });

    const result = await run(
      motif,
      request({
        operation: 'search',
        start0: 0,
        end0: motif.length + REFERENCE_INTERVAL_MAX_SEARCH_RESULTS,
        motif,
      }),
      [],
      source
    );

    expect(isReferenceIntervalFailure(result)).toBe(false);
    if (isReferenceIntervalFailure(result)) return;
    expect(result.searchMotif).toBe(motif);
    expect(result.searchHits).toHaveLength(REFERENCE_INTERVAL_MAX_SEARCH_RESULTS);
    expect(result.searchHits?.[0]).toEqual({
      start: 0,
      end: motif.length,
      strand: 'forward',
    });
    expect(JSON.stringify(result).length).toBeLessThan(100_000);
  });
});

describe('runReferenceIntervalAction — circular wrap and extract', () => {
  it('refuses wraps on a linear source', async () => {
    const result = await run(
      'ACGTACGTAC',
      request({ operation: 'read', start0: 8, end0: 2, wraps: true, circular: false })
    );
    expect(result).toMatchObject({ ok: false, code: 'WRAP_NOT_CIRCULAR' });
  });

  it('refuses wraps when start0 is not after end0', async () => {
    const result = await run(
      'ACGTACGTAC',
      request({ operation: 'read', start0: 2, end0: 8, wraps: true, circular: true })
    );
    expect(result).toMatchObject({ ok: false, code: 'WRAP_REQUIRES_ORIGIN_CROSSING' });
  });

  it.each(['search', 'read_spliced', 'translate_spliced'] as const)(
    'returns a structured failure for wrapped %s instead of reaching an incompatible IPC request',
    async (operation) => {
      const result = await run(
        'ACGTACGTAC',
        request({
          operation,
          start0: 8,
          end0: 2,
          wraps: true,
          circular: true,
          ...(operation === 'search' ? { motif: 'AC' } : {}),
        })
      );
      expect(result).toMatchObject({
        ok: false,
        code: 'WRAP_UNSUPPORTED_OPERATION',
        error: expect.stringContaining('not supported'),
      });
    }
  );

  it('reads the tail plus the head across the origin', async () => {
    const result = await run(
      'ACGTACGTAC',
      request({ operation: 'read', start0: 8, end0: 2, wraps: true, circular: true })
    );
    expect(isReferenceIntervalFailure(result)).toBe(false);
    if (isReferenceIntervalFailure(result)) return;
    expect(result.sequence).toBe('ACAC');
    expect(result.interval.length).toBe(4);
    expect(result.interval.wraps).toBe(true);
  });

  it('reverse-complements a wrapped interval', async () => {
    const result = await run(
      'ACGTACGTAC',
      request({
        operation: 'reverse_complement',
        start0: 8,
        end0: 2,
        wraps: true,
        circular: true,
      })
    );
    expect(isReferenceIntervalFailure(result)).toBe(false);
    if (isReferenceIntervalFailure(result)) return;
    expect(result.sequence).toBe('GTGT');
  });

  it('extracts a linear interval with provenance and does not rewrite the source', async () => {
    const result = await run(
      'ATGAAATGA',
      request({ operation: 'extract', start0: 0, end0: 6, strand: '+' })
    );
    expect(isReferenceIntervalFailure(result)).toBe(false);
    if (isReferenceIntervalFailure(result)) return;
    expect(result.derived?.sequence).toBe('ATGAAA');
    expect(result.derived?.topology).toBe('linear');
    expect(result.provenance.sourceId).toBe('fixtures/tiny.fa');
    expect(result.provenance.sequenceFingerprint).toMatch(/^[0-9a-f]{8}$/);
  });

  it('extracts the reverse complement when strand is minus', async () => {
    const result = await run(
      'ATGAAA',
      request({ operation: 'extract', start0: 0, end0: 6, strand: '-' })
    );
    expect(isReferenceIntervalFailure(result)).toBe(false);
    if (isReferenceIntervalFailure(result)) return;
    expect(result.derived?.sequence).toBe('TTTCAT');
  });
});

describe('runReferenceIntervalAction — structured failures', () => {
  it('returns MISSING_SOURCE when the data source is absent', async () => {
    const result = await runReferenceIntervalAction(null, request({ operation: 'read' }), IDENTITY);
    expect(result).toMatchObject({ ok: false, code: 'MISSING_SOURCE' });
  });

  it('returns MISSING_SOURCE when an admitted source disappears before initialization', async () => {
    class MissingSource extends InMemoryGenomeDataSource {
      async getChromosomeLength(): Promise<number> {
        throw new ReferenceIntervalSourceUnavailableError();
      }
    }
    const source = new MissingSource({ chrom: 'chrI', sequence: 'ACGT', features: [] });

    const result = await runReferenceIntervalAction(
      source,
      request({ operation: 'read', start0: 0, end0: 4 }),
      IDENTITY
    );

    expect(result).toMatchObject({ ok: false, code: 'MISSING_SOURCE' });
  });

  it('returns MISSING_SOURCE when an admitted source disappears during a read', async () => {
    class MissingSource extends InMemoryGenomeDataSource {
      async getSequence(): Promise<string> {
        throw new ReferenceIntervalSourceUnavailableError();
      }
    }
    const source = new MissingSource({ chrom: 'chrI', sequence: 'ACGT', features: [] });

    const result = await runReferenceIntervalAction(
      source,
      request({ operation: 'read', start0: 0, end0: 4 }),
      IDENTITY
    );

    expect(result).toMatchObject({ ok: false, code: 'MISSING_SOURCE' });
  });

  it.each([Number.NaN, -1, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid chromosome length %s as malformed source metadata',
    async (chromosomeLength) => {
      class InvalidLengthSource extends InMemoryGenomeDataSource {
        async getChromosomeLength(): Promise<number> {
          return chromosomeLength;
        }
      }
      const source = new InvalidLengthSource({ chrom: 'chrI', sequence: 'ACGT', features: [] });

      const result = await runReferenceIntervalAction(
        source,
        request({ operation: 'read', start0: 0, end0: 4 }),
        IDENTITY
      );

      expect(result).toMatchObject({ ok: false, code: 'INVALID_SOURCE' });
    }
  );

  it('rejects non-IUPAC bytes returned through a crafted FASTA index', async () => {
    const result = await run(
      'SECRET_TOKEN=topsecret',
      request({ operation: 'read', start0: 0, end0: 12 })
    );
    expect(result).toMatchObject({ ok: false, code: 'INVALID_SOURCE' });
  });

  it('rejects alignment gaps in an indexed reference window', async () => {
    const result = await run('ATG-AA', request({ operation: 'translate', start0: 0, end0: 6 }));
    expect(result).toMatchObject({ ok: false, code: 'INVALID_SOURCE' });
  });

  it('returns MISSING_CHROMOSOME when the source does not own the contig', async () => {
    const result = await run(
      'ACGT',
      request({ operation: 'read', chrom: 'chrII', start0: 0, end0: 4 })
    );
    expect(result).toMatchObject({ ok: false, code: 'MISSING_CHROMOSOME' });
  });

  it('returns EMPTY_INTERVAL for a zero-width range', async () => {
    const result = await run('ACGT', request({ operation: 'read', start0: 2, end0: 2 }));
    expect(result).toMatchObject({ ok: false, code: 'EMPTY_INTERVAL' });
  });

  it('returns REVERSED_INTERVAL when end0 is before start0', async () => {
    const result = await run('ACGT', request({ operation: 'read', start0: 3, end0: 1 }));
    expect(result).toMatchObject({ ok: false, code: 'REVERSED_INTERVAL' });
  });

  it('returns OUT_OF_BOUNDS instead of silently clamping past the chromosome end', async () => {
    const result = await run('ACGT', request({ operation: 'read', start0: 0, end0: 8 }));
    expect(result).toMatchObject({ ok: false, code: 'OUT_OF_BOUNDS' });
  });

  it('returns OVER_LIMIT before materializing an oversized read', async () => {
    const sequence = 'A'.repeat(REFERENCE_INTERVAL_MAX_INLINE_BP + 1);
    const result = await run(
      sequence,
      request({
        operation: 'read',
        start0: 0,
        end0: REFERENCE_INTERVAL_MAX_INLINE_BP + 1,
      })
    );
    expect(result).toMatchObject({ ok: false, code: 'OVER_LIMIT' });
    if (isReferenceIntervalFailure(result)) {
      expect(result.error).toMatch(/capped/i);
      expect(result.details?.maxInlineBp).toBe(REFERENCE_INTERVAL_MAX_INLINE_BP);
    }
  });

  it('returns OVER_LIMIT before an unsupported translate_spliced feature window reaches IPC', async () => {
    const sequence = 'A'.repeat(REFERENCE_INTERVAL_MAX_FEATURE_WINDOW_BP + 1);
    const result = await run(
      sequence,
      request({
        operation: 'translate_spliced',
        start0: 0,
        end0: REFERENCE_INTERVAL_MAX_FEATURE_WINDOW_BP + 1,
      })
    );
    expect(result).toMatchObject({
      ok: false,
      code: 'OVER_LIMIT',
      details: {
        requestedLength: REFERENCE_INTERVAL_MAX_FEATURE_WINDOW_BP + 1,
        maxWindowBp: REFERENCE_INTERVAL_MAX_FEATURE_WINDOW_BP,
      },
    });
  });

  it('allows motif search of a window larger than the inline read cap', async () => {
    const sequence = 'A'.repeat(REFERENCE_INTERVAL_MAX_INLINE_BP + 8) + 'ATG';
    const start0 = REFERENCE_INTERVAL_MAX_INLINE_BP;
    const result = await run(
      sequence,
      request({
        operation: 'search',
        start0,
        end0: start0 + 11,
        motif: 'ATG',
      })
    );
    expect(isReferenceIntervalFailure(result)).toBe(false);
    if (isReferenceIntervalFailure(result)) return;
    expect(result.searchHits?.some((hit) => hit.start === start0 + 8)).toBe(true);
  });

  it('returns CANCELLED when the abort signal is already fired', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await run(
      'ACGT',
      request({ operation: 'read', start0: 0, end0: 4, signal: controller.signal })
    );
    expect(result).toMatchObject({ ok: false, code: 'CANCELLED' });
  });

  it('returns CANCELLED when the source aborts mid-read', async () => {
    const controller = new AbortController();
    const source = new InMemoryGenomeDataSource({
      chrom: 'chrI',
      sequence: 'ACGT',
      features: [],
    });
    const original = source.getSequence.bind(source);
    source.getSequence = async (chrom, start, end, options) => {
      controller.abort();
      return original(chrom, start, end, options);
    };
    const result = await runReferenceIntervalAction(
      source,
      request({ operation: 'read', start0: 0, end0: 4, signal: controller.signal }),
      IDENTITY
    );
    expect(result).toMatchObject({ ok: false, code: 'CANCELLED' });
  });
});
