import {
  packPrepackedProteinSearchIndexV1,
  unpackPrepackedProteinSearchIndexV1,
  type GenomeFeature,
  type ResolvedGene,
  type ResolvedTranscript,
} from '@waypoint/genome-data';
import { annotationCanonicalIdentityV2 } from '@waypoint/genome-renderer/pure';
import { describe, expect, it } from 'vitest';

import {
  rendererAnnotationIdentityProjection,
  transcriptCarrierFeatureForRendererIdentity,
} from '../../features/sequence/components/indexed-genome-legacy-adapter';
import {
  ASSEMBLY_PROTEIN_SEARCH_MAX_QUARANTINE_DIAGNOSTICS_V1,
  compileChromosomeProteinSearchFeaturesFromRangesV1,
  compileChromosomeProteinSearchFeaturesV1,
  nodeBufferProteinSubsequenceFinderV1,
  translateCodingDnaWithGeneticCodeV1,
} from './assembly-protein-search-compiler';

function raw(
  overrides: Partial<GenomeFeature> & Pick<GenomeFeature, 'start' | 'end'>
): GenomeFeature {
  return {
    chrom: 'chr1',
    source: 'RefSeq',
    type: 'CDS',
    score: null,
    strand: '+',
    phase: '0',
    attributes: {},
    raw: '',
    ...overrides,
  };
}

function transcript(
  transcriptId: string,
  overrides: Partial<ResolvedTranscript> = {}
): ResolvedTranscript {
  return {
    ...raw({ start: 0, end: 33 }),
    type: 'mRNA',
    attributes: { ID: [transcriptId], Parent: ['gene-alpha'] },
    exons: [{ start: 1, end: 33 }],
    cds: [
      { start: 1, end: 8 },
      { start: 21, end: 33 },
    ],
    transcriptId,
    geneId: 'gene-alpha',
    ...overrides,
  };
}

describe('assembly protein search compiler', () => {
  it('indexes every CDS isoform with phase, source genetic code, and biological strand', async () => {
    const forward = transcript('rna-forward');
    const reverse = transcript('rna-reverse', {
      start: 49,
      end: 64,
      strand: '-',
      exons: [{ start: 50, end: 64 }],
      cds: [{ start: 50, end: 64 }],
    });
    const phased = transcript('rna-phased', {
      start: 69,
      end: 85,
      exons: [{ start: 70, end: 85 }],
      cds: [{ start: 70, end: 85 }],
    });
    const gene: ResolvedGene = {
      ...raw({ start: 0, end: 85 }),
      type: 'gene',
      attributes: { ID: ['gene-alpha'], Name: ['ALPHA'] },
      geneId: 'gene-alpha',
      transcripts: [forward, reverse],
    };
    const sequence = Array.from({ length: 100 }, () => 'N');
    sequence.splice(0, 8, ...'ATGAAATG');
    sequence.splice(20, 13, ...'GGTTACCGCTGCT');
    sequence.splice(49, 15, ...'GGTAACCCATTTTAT');
    sequence.splice(69, 16, ...'AATGAAATGGGTTACC');

    const result = compileChromosomeProteinSearchFeaturesV1({
      chromosomeLengthBp: 100,
      globalStartBp: 0,
      chromosomeSequence: sequence.join(''),
      resolvedAnnotations: [gene, phased],
      rawFeatures: [
        raw({ start: 0, end: 8, attributes: { Parent: ['rna-forward'] } }),
        raw({
          start: 20,
          end: 33,
          phase: '1',
          attributes: { Parent: ['rna-forward'] },
        }),
        raw({
          start: 49,
          end: 64,
          strand: '-',
          attributes: { Parent: ['rna-reverse'], transl_table: ['2'] },
        }),
        raw({
          start: 69,
          end: 85,
          phase: '1',
          attributes: { Parent: ['rna-phased'] },
        }),
      ],
      genomeIdentity: 'assembly-source:test',
    });

    expect(result.features.map((entry) => entry.transcriptId)).toEqual([
      'rna-forward',
      'rna-reverse',
      'rna-phased',
    ]);
    expect(result.features.map((entry) => entry.proteinSequence)).toEqual([
      'MKWVTAA',
      'MKWVT',
      'MKWVT',
    ]);
    expect(result.features[1]).toMatchObject({
      strand: 'reverse',
      geneticCode: 2,
      segments: [{ start: 49, end: 64 }],
    });
    expect(result.features[2].leadingFrameOffset).toBe(1);
    expect(result.work).toEqual({
      transcriptCount: 3,
      sourceTranslationCount: 0,
      derivedTranslationCount: 3,
      skippedEmptyTranslationCount: 0,
      quarantinedIsoformCount: 0,
      quarantinedIsoforms: [],
      quarantineDiagnosticsTruncated: false,
    });

    const artifact = await packPrepackedProteinSearchIndexV1({
      datasetContract: {
        datasetId: 'refseq-grch38',
        datasetVersion: 'test-v1',
        sourceSha256: 'a'.repeat(64),
      },
      assemblyContract: {
        assemblyId: 'GRCh38',
        assemblyLengthBp: 100,
        placementSignature: 'chr1:100',
        sourceFingerprint: 'b'.repeat(24),
      },
      features: result.features,
    });
    const index = await unpackPrepackedProteinSearchIndexV1(artifact.manifest, artifact.payload);
    expect(index.query('KWVTA').matches[0]).toMatchObject({
      transcriptId: 'rna-forward',
      geneId: 'gene-alpha',
      segments: [
        { start: 3, end: 8 },
        { start: 20, end: 30 },
      ],
    });
  });

  it('prefers a valid source translation and records its declared table', () => {
    const sourceTranslated = transcript('rna-source', {
      translation: 'PEPTIDE',
      cds: [{ start: 1, end: 21 }],
      exons: [{ start: 1, end: 21 }],
      end: 21,
    });
    const result = compileChromosomeProteinSearchFeaturesV1({
      chromosomeLengthBp: 30,
      globalStartBp: 0,
      chromosomeSequence: 'N'.repeat(30),
      resolvedAnnotations: [sourceTranslated],
      rawFeatures: [
        raw({
          start: 0,
          end: 21,
          attributes: { Parent: ['rna-source'], transl_table: ['11'] },
        }),
      ],
      genomeIdentity: 'assembly-source:test',
    });

    expect(result.features[0]).toMatchObject({
      proteinSequence: 'PEPTIDE',
      geneticCode: 11,
    });
    expect(result.work.sourceTranslationCount).toBe(1);
  });

  it('reads only untranslated CDS ranges instead of materializing a chromosome', async () => {
    const sourceTranslated = transcript('rna-source', {
      translation: 'PEPTIDE',
      cds: [{ start: 1, end: 21 }],
      exons: [{ start: 1, end: 21 }],
      end: 21,
    });
    const derived = transcript('rna-derived', {
      start: 69,
      end: 85,
      cds: [{ start: 70, end: 85 }],
      exons: [{ start: 70, end: 85 }],
    });
    const chromosome = `${'N'.repeat(69)}AATGAAATGGGTTACC${'N'.repeat(15)}`;
    const reads: Array<[number, number]> = [];
    const result = await compileChromosomeProteinSearchFeaturesFromRangesV1({
      chromosomeLengthBp: 100,
      globalStartBp: 0,
      resolvedAnnotations: [sourceTranslated, derived],
      rawFeatures: [
        raw({
          start: 0,
          end: 21,
          attributes: {
            Parent: ['rna-source'],
            translation: ['PEPTIDE'],
          },
        }),
        raw({
          start: 69,
          end: 85,
          phase: '1',
          attributes: { Parent: ['rna-derived'] },
        }),
      ],
      genomeIdentity: 'assembly-source:test',
      async readSequence(start, end) {
        reads.push([start, end]);
        return chromosome.slice(start, end);
      },
    });

    expect(reads).toEqual([[69, 85]]);
    expect(result.features.map((entry) => entry.proteinSequence)).toEqual(['PEPTIDE', 'MKWVT']);
  });

  it('indexes real gene-parent CDS carriers as distinct deduplicated isoforms', () => {
    const gene: ResolvedGene = {
      ...raw({ start: 0, end: 60 }),
      type: 'gene',
      attributes: { ID: ['gene-direct'], Name: ['DIRECT'] },
      geneId: 'gene-direct',
      transcripts: [],
    };
    const first = raw({
      start: 0,
      end: 9,
      attributes: {
        ID: ['cds-direct'],
        Parent: ['gene-direct'],
        translation: ['PEPTIDE'],
        transl_table: ['11'],
      },
    });
    const second = raw({
      start: 20,
      end: 32,
      attributes: {
        ID: ['cds-direct'],
        Parent: ['gene-direct'],
        translation: ['PEPTIDE'],
        transl_table: ['11'],
      },
    });
    const alternate = raw({
      start: 40,
      end: 55,
      attributes: {
        ID: ['cds-alternate'],
        Parent: ['gene-direct'],
        translation: ['MKWVT'],
        transl_table: ['11'],
      },
    });
    const result = compileChromosomeProteinSearchFeaturesV1({
      chromosomeLengthBp: 60,
      globalStartBp: 0,
      chromosomeSequence: 'N'.repeat(60),
      resolvedAnnotations: [gene, first, second, alternate],
      rawFeatures: [gene, first, second, alternate],
      genomeIdentity: 'assembly-source:test',
    });

    expect(result.features).toHaveLength(2);
    expect(result.features[0]).toMatchObject({
      proteinSequence: 'PEPTIDE',
      transcriptId: 'cds-direct',
      geneId: 'gene-direct',
      featureType: 'CDS',
      annotationTrackId: 'CDS',
      segments: [
        { start: 0, end: 9 },
        { start: 20, end: 32 },
      ],
    });
    expect(result.features[1]).toMatchObject({
      proteinSequence: 'MKWVT',
      transcriptId: 'cds-alternate',
      geneId: 'gene-direct',
    });
    const carrier = rendererAnnotationIdentityProjection(
      transcriptCarrierFeatureForRendererIdentity(first)
    );
    expect(result.features[0].canonicalIdentity).toBe(
      annotationCanonicalIdentityV2({
        genomeIdentity: 'assembly-source:test',
        sourceId: carrier.sourceId,
        transcriptId: carrier.transcriptId,
        trackId: carrier.annotationTrackId,
        type: carrier.type,
        startBp: carrier.start,
        endBp: carrier.end,
        direction: carrier.direction,
      })
    );
  });

  it('quarantines malformed raw CDS groups with order-stable source identities', () => {
    const gene: ResolvedGene = {
      ...raw({ start: 0, end: 40 }),
      type: 'gene',
      attributes: { ID: ['gene-raw'] },
      geneId: 'gene-raw',
      transcripts: [],
    };
    const valid = raw({
      start: 20,
      end: 29,
      attributes: {
        ID: ['cds-valid-raw'],
        Parent: ['gene-raw'],
        translation: ['MKW'],
      },
    });
    const anonymousInvalid = raw({
      start: -1,
      end: 5,
      attributes: { Parent: ['gene-raw'], translation: ['M'] },
    });
    const overlappingFirst = raw({
      start: 6,
      end: 15,
      attributes: {
        ID: ['cds-overlap'],
        Parent: ['gene-raw'],
        translation: ['MKW'],
      },
    });
    const overlappingSecond = raw({
      start: 14,
      end: 20,
      attributes: {
        ID: ['cds-overlap'],
        Parent: ['gene-raw'],
        translation: ['MKW'],
      },
    });
    const compile = (
      resolvedAnnotations: Array<ResolvedGene | GenomeFeature>,
      rawFeatures: GenomeFeature[]
    ) =>
      compileChromosomeProteinSearchFeaturesV1({
        chromosomeLengthBp: 40,
        globalStartBp: 0,
        chromosomeSequence: 'N'.repeat(40),
        resolvedAnnotations,
        rawFeatures,
        genomeIdentity: 'assembly-source:test',
      });

    const first = compile(
      [gene, anonymousInvalid, overlappingFirst, overlappingSecond],
      [gene, anonymousInvalid, overlappingFirst, overlappingSecond]
    );
    const shifted = compile(
      [gene, valid, anonymousInvalid, overlappingFirst, overlappingSecond],
      [gene, valid, anonymousInvalid, overlappingFirst, overlappingSecond]
    );

    expect(
      first.work.quarantinedIsoforms.map(({ isoformId, reason }) => ({
        isoformId,
        reason,
      }))
    ).toEqual([
      {
        isoformId: first.work.quarantinedIsoforms[0].isoformId,
        reason: 'invalid-cds-bounds',
      },
      { isoformId: 'cds-overlap', reason: 'overlapping-cds-segments' },
    ]);
    expect(shifted.features.map((feature) => feature.transcriptId)).toEqual(['cds-valid-raw']);
    expect(shifted.work.quarantinedIsoforms).toEqual(first.work.quarantinedIsoforms);
    expect(first.work.quarantinedIsoforms[0].isoformId).toContain('gene-raw:CDS:chr1:+:0-5:');
  });

  it('quarantines resolved and raw CDS carriers with unknown strand', () => {
    const unknownTranscript = transcript('rna-unknown', {
      strand: '.',
      translation: 'PEPTIDE',
      cds: [{ start: 1, end: 21 }],
      exons: [{ start: 1, end: 21 }],
      end: 21,
    });
    const unknownResolvedRow = raw({
      start: 0,
      end: 21,
      strand: '.',
      attributes: { Parent: ['rna-unknown'], translation: ['PEPTIDE'] },
    });
    const unknownRawCarrier = raw({
      start: 30,
      end: 45,
      strand: '.',
      attributes: { ID: ['cds-unknown'], Parent: ['gene-unknown'], translation: ['MKWVT'] },
    });
    const result = compileChromosomeProteinSearchFeaturesV1({
      chromosomeLengthBp: 50,
      globalStartBp: 0,
      chromosomeSequence: 'N'.repeat(50),
      resolvedAnnotations: [unknownTranscript, unknownRawCarrier],
      rawFeatures: [unknownResolvedRow, unknownRawCarrier],
      genomeIdentity: 'assembly-source:test',
    });

    expect(result.features).toEqual([]);
    expect(result.work).toMatchObject({
      transcriptCount: 2,
      quarantinedIsoformCount: 2,
      quarantineDiagnosticsTruncated: false,
      quarantinedIsoforms: [
        {
          chrom: 'chr1',
          source: 'RefSeq',
          isoformId: 'rna-unknown',
          reason: 'unknown-strand',
        },
        {
          chrom: 'chr1',
          source: 'RefSeq',
          isoformId: 'cds-unknown',
          reason: 'unknown-strand',
        },
      ],
    });
  });

  it('uses valid source translations, derives only absent translations, and quarantines malformed declarations', async () => {
    const sourceTranslated = transcript('rna-source-policy', {
      translation: 'PEPTIDE',
      cds: [{ start: 1, end: 21 }],
      exons: [{ start: 1, end: 21 }],
      end: 21,
    });
    const derived = transcript('rna-derived-policy', {
      start: 30,
      end: 39,
      translation: undefined,
      cds: [{ start: 31, end: 39 }],
      exons: [{ start: 31, end: 39 }],
    });
    const malformed = transcript('rna-malformed-source', {
      start: 40,
      end: 61,
      translation: 'PEPT1DE',
      cds: [{ start: 41, end: 61 }],
      exons: [{ start: 41, end: 61 }],
    });
    const oversized = transcript('rna-oversized-source', {
      start: 69,
      end: 72,
      translation: 'PEPTIDE',
      cds: [{ start: 70, end: 72 }],
      exons: [{ start: 70, end: 72 }],
    });
    const chromosome = `${'N'.repeat(30)}ATGAAATTT${'N'.repeat(61)}`;
    const reads: Array<[number, number]> = [];
    const result = await compileChromosomeProteinSearchFeaturesFromRangesV1({
      chromosomeLengthBp: 100,
      globalStartBp: 0,
      resolvedAnnotations: [sourceTranslated, derived, malformed, oversized],
      rawFeatures: [
        raw({ start: 0, end: 21, attributes: { Parent: ['rna-source-policy'] } }),
        raw({ start: 30, end: 39, attributes: { Parent: ['rna-derived-policy'] } }),
        raw({ start: 40, end: 61, attributes: { Parent: ['rna-malformed-source'] } }),
        raw({ start: 69, end: 72, attributes: { Parent: ['rna-oversized-source'] } }),
      ],
      genomeIdentity: 'assembly-source:test',
      async readSequence(start, end) {
        reads.push([start, end]);
        return chromosome.slice(start, end);
      },
    });

    expect(reads).toEqual([[30, 39]]);
    expect(
      result.features.map(({ transcriptId, proteinSequence }) => ({
        transcriptId,
        proteinSequence,
      }))
    ).toEqual([
      { transcriptId: 'rna-source-policy', proteinSequence: 'PEPTIDE' },
      { transcriptId: 'rna-derived-policy', proteinSequence: 'MKF' },
    ]);
    expect(result.work).toMatchObject({
      transcriptCount: 4,
      sourceTranslationCount: 1,
      derivedTranslationCount: 1,
      quarantinedIsoformCount: 2,
      quarantinedIsoforms: [
        {
          isoformId: 'rna-malformed-source',
          reason: 'invalid-source-translation',
        },
        {
          isoformId: 'rna-oversized-source',
          reason: 'source-translation-exceeds-cds',
        },
      ],
    });
  });

  it('keeps valid isoforms when genetic-code declarations are malformed', () => {
    const valid = transcript('rna-valid-table', {
      translation: 'MKW',
      cds: [{ start: 1, end: 9 }],
      exons: [{ start: 1, end: 9 }],
      end: 9,
    });
    const conflicting = transcript('rna-conflicting-table', {
      start: 10,
      end: 19,
      translation: 'MKW',
      attributes: {
        ID: ['rna-conflicting-table'],
        Parent: ['gene-alpha'],
        transl_table: ['1'],
      },
      cds: [{ start: 11, end: 19 }],
      exons: [{ start: 11, end: 19 }],
    });
    const unsupported = transcript('rna-unsupported-table', {
      start: 20,
      end: 29,
      translation: 'MKW',
      attributes: {
        ID: ['rna-unsupported-table'],
        Parent: ['gene-alpha'],
        transl_table: ['999'],
      },
      cds: [{ start: 21, end: 29 }],
      exons: [{ start: 21, end: 29 }],
    });
    const invalid = transcript('rna-invalid-table', {
      start: 30,
      end: 39,
      translation: 'MKW',
      attributes: {
        ID: ['rna-invalid-table'],
        Parent: ['gene-alpha'],
        transl_table: ['11x'],
      },
      cds: [{ start: 31, end: 39 }],
      exons: [{ start: 31, end: 39 }],
    });
    const result = compileChromosomeProteinSearchFeaturesV1({
      chromosomeLengthBp: 50,
      globalStartBp: 0,
      chromosomeSequence: 'N'.repeat(50),
      resolvedAnnotations: [valid, conflicting, unsupported, invalid],
      rawFeatures: [
        raw({ start: 0, end: 9, attributes: { Parent: ['rna-valid-table'] } }),
        raw({
          start: 10,
          end: 19,
          attributes: { Parent: ['rna-conflicting-table'], transl_table: ['2'] },
        }),
        raw({ start: 20, end: 29, attributes: { Parent: ['rna-unsupported-table'] } }),
        raw({ start: 30, end: 39, attributes: { Parent: ['rna-invalid-table'] } }),
      ],
      genomeIdentity: 'assembly-source:test',
    });

    expect(result.features.map((feature) => feature.transcriptId)).toEqual(['rna-valid-table']);
    expect(
      result.work.quarantinedIsoforms.map(({ isoformId, reason }) => ({
        isoformId,
        reason,
      }))
    ).toEqual([
      { isoformId: 'rna-conflicting-table', reason: 'conflicting-genetic-codes' },
      { isoformId: 'rna-unsupported-table', reason: 'unsupported-genetic-code' },
      { isoformId: 'rna-invalid-table', reason: 'invalid-genetic-code' },
    ]);
  });

  it('quarantines one short FASTA read and continues with later valid isoforms', async () => {
    const short = transcript('rna-short-read', {
      cds: [{ start: 1, end: 9 }],
      exons: [{ start: 1, end: 9 }],
      end: 9,
    });
    const valid = transcript('rna-after-short-read', {
      start: 10,
      end: 19,
      cds: [{ start: 11, end: 19 }],
      exons: [{ start: 11, end: 19 }],
    });
    const result = await compileChromosomeProteinSearchFeaturesFromRangesV1({
      chromosomeLengthBp: 30,
      globalStartBp: 0,
      resolvedAnnotations: [short, valid],
      rawFeatures: [
        raw({ start: 0, end: 9, attributes: { Parent: ['rna-short-read'] } }),
        raw({ start: 10, end: 19, attributes: { Parent: ['rna-after-short-read'] } }),
      ],
      genomeIdentity: 'assembly-source:test',
      async readSequence(start, end) {
        return start === 0 ? 'ATG' : 'ATGAAATTT'.slice(0, end - start);
      },
    });

    expect(result.features.map((feature) => feature.transcriptId)).toEqual([
      'rna-after-short-read',
    ]);
    expect(result.work.quarantinedIsoforms).toEqual([
      {
        chrom: 'chr1',
        source: 'RefSeq',
        isoformId: 'rna-short-read',
        reason: 'fasta-read-length-mismatch',
      },
    ]);
  });

  it('does not convert range-reader I/O failures into isoform quarantine', async () => {
    const candidate = transcript('rna-reader-error', {
      cds: [{ start: 1, end: 9 }],
      exons: [{ start: 1, end: 9 }],
      end: 9,
    });
    await expect(
      compileChromosomeProteinSearchFeaturesFromRangesV1({
        chromosomeLengthBp: 20,
        globalStartBp: 0,
        resolvedAnnotations: [candidate],
        rawFeatures: [raw({ start: 0, end: 9, attributes: { Parent: ['rna-reader-error'] } })],
        genomeIdentity: 'assembly-source:test',
        async readSequence() {
          throw new Error('FASTA device unavailable');
        },
      })
    ).rejects.toThrow('FASTA device unavailable');
  });

  it('bounds the detailed quarantine report while retaining the exact total', () => {
    const candidates = Array.from(
      { length: ASSEMBLY_PROTEIN_SEARCH_MAX_QUARANTINE_DIAGNOSTICS_V1 + 2 },
      (_, index) =>
        transcript(`rna-bounded-${index}`, {
          strand: '.',
          translation: 'MKWVTAA',
        })
    );
    const result = compileChromosomeProteinSearchFeaturesV1({
      chromosomeLengthBp: 40,
      globalStartBp: 0,
      chromosomeSequence: 'N'.repeat(40),
      resolvedAnnotations: candidates,
      rawFeatures: [],
      genomeIdentity: 'assembly-source:test',
    });

    expect(result.features).toEqual([]);
    expect(result.work.quarantinedIsoformCount).toBe(candidates.length);
    expect(result.work.quarantinedIsoforms).toHaveLength(
      ASSEMBLY_PROTEIN_SEARCH_MAX_QUARANTINE_DIAGNOSTICS_V1
    );
    expect(result.work.quarantineDiagnosticsTruncated).toBe(true);
  });

  it('supports every NCBI translation table declared by current sources', () => {
    expect(translateCodingDnaWithGeneticCodeV1('ATAAAATGA', 1, true)).toBe('IK*');
    expect(translateCodingDnaWithGeneticCodeV1('ATAAAATGA', 2, true)).toBe('MKW');
    expect(translateCodingDnaWithGeneticCodeV1('GTGAAATGA', 11, true)).toBe('MK*');
    expect(() => translateCodingDnaWithGeneticCodeV1('ATG', 999, true)).toThrow(
      /unsupported NCBI genetic code/i
    );
  });

  it('uses Node native byte search without copying the search corpus', () => {
    const encoder = new TextEncoder();
    expect(
      nodeBufferProteinSubsequenceFinderV1(
        encoder.encode('AAAAAMKWVTAAAAA'),
        encoder.encode('MKWVT'),
        0
      )
    ).toBe(5);
  });
});
