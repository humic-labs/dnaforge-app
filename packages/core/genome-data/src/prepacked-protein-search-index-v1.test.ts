import { describe, expect, it } from 'vitest';

import {
  PREPACKED_PROTEIN_SEARCH_MAX_RESULTS_V1,
  openRangeReadablePrepackedProteinSearchIndexV1,
  packPrepackedProteinSearchIndexV1,
  unpackPrepackedProteinSearchIndexV1,
  visitPrepackedProteinSearchResultIdentitiesV1,
} from './prepacked-protein-search-index-v1';

const datasetContract = {
  datasetId: 'refseq-grch38',
  datasetVersion: 'test-v1',
  sourceSha256: 'a'.repeat(64),
};
const assemblyContract = {
  assemblyId: 'GRCh38',
  assemblyLengthBp: 10_000,
  placementSignature: 'chr1:10000',
  sourceFingerprint: 'b'.repeat(24),
};

function feature(
  overrides: Partial<
    Parameters<typeof packPrepackedProteinSearchIndexV1>[0]['features'][number]
  > = {}
) {
  return {
    proteinSequence: 'MKWVTAA',
    segments: [
      { start: 100, end: 108 },
      { start: 200, end: 213 },
    ],
    strand: 'forward' as const,
    geneticCode: 1,
    leadingFrameOffset: 0 as const,
    label: 'alpha isoform',
    geneId: 'gene-alpha',
    transcriptId: 'rna-alpha-1',
    featureType: 'mRNA',
    annotationTrackId: 'mRNA',
    canonicalIdentity: 'annotation:alpha-1',
    ...overrides,
  };
}

async function packed(features: ReadonlyArray<ReturnType<typeof feature>> = [feature()]) {
  return packPrepackedProteinSearchIndexV1({
    datasetContract,
    assemblyContract,
    features,
  });
}

async function unpacked(features: ReadonlyArray<ReturnType<typeof feature>> = [feature()]) {
  const artifact = await packed(features);
  return unpackPrepackedProteinSearchIndexV1(artifact.manifest, artifact.payload);
}

describe('prepacked protein search index v1', () => {
  it('returns exact isoform identity and exon-junction genomic segments', async () => {
    const index = await unpacked();
    const result = index.query('WVTAA');

    expect(result).toEqual({
      matches: [
        {
          featureIndex: 0,
          proteinStart: 2,
          proteinEnd: 7,
          start: 106,
          end: 213,
          segments: [
            { start: 106, end: 108 },
            { start: 200, end: 213 },
          ],
          strand: 'forward',
          geneticCode: 1,
          label: 'alpha isoform',
          geneId: 'gene-alpha',
          transcriptId: 'rna-alpha-1',
          featureType: 'mRNA',
          annotationTrackId: 'mRNA',
          canonicalIdentity: 'annotation:alpha-1',
        },
      ],
      truncated: false,
      limit: PREPACKED_PROTEIN_SEARCH_MAX_RESULTS_V1,
    });
    const identities: Array<{ annotationTrackId: string; canonicalIdentity: string }> = [];
    visitPrepackedProteinSearchResultIdentitiesV1(index, (identity) => {
      identities.push(identity);
    });
    expect(identities).toEqual([
      {
        annotationTrackId: 'mRNA',
        canonicalIdentity: 'annotation:alpha-1',
      },
    ]);
  });

  it('maps reverse-strand matches in biological segment order', async () => {
    const entry = feature({
      proteinSequence: 'PEPTIDE',
      segments: [
        { start: 400, end: 409 },
        { start: 300, end: 312 },
      ],
      strand: 'reverse',
      transcriptId: 'rna-reverse',
      canonicalIdentity: 'annotation:reverse',
    });
    const index = await unpacked([entry]);

    expect(index.query('EPTID').matches[0]).toMatchObject({
      strand: 'reverse',
      proteinStart: 1,
      proteinEnd: 6,
      start: 303,
      end: 406,
      segments: [
        { start: 400, end: 406 },
        { start: 303, end: 312 },
      ],
    });
  });

  it('keeps isoleucine and leucine exact and enforces query bounds', async () => {
    const index = await unpacked([
      feature({
        proteinSequence: 'ACDILFG',
        segments: [{ start: 500, end: 521 }],
      }),
    ]);

    expect(index.query('ACDIL').matches).toHaveLength(1);
    expect(index.query('ACDLL').matches).toHaveLength(0);
    expect(() => index.query('ACDI')).toThrow(/at least 5/i);
    expect(() => index.query('ACDIX')).toThrow(/canonical amino acids/i);
  });

  it('caps results at 500 and reports truncation', async () => {
    const entries = Array.from({ length: 501 }, (_, index) =>
      feature({
        sourceOrdinal: index,
        proteinSequence: 'MKWVT',
        segments: [{ start: index * 6, end: index * 6 + 15 }],
        transcriptId: `rna-${index}`,
        canonicalIdentity: `annotation:${index}`,
      })
    );
    const index = await unpacked(entries);
    const result = index.query('MKWVT', 10_000);

    expect(result.matches).toHaveLength(500);
    expect(result.truncated).toBe(true);
    expect(result.limit).toBe(500);
  });

  it('supports bounded range reads and matches across scan-chunk boundaries', async () => {
    const artifact = await packed([
      feature({ proteinSequence: 'AAAAAMKWVTAAAAA', segments: [{ start: 0, end: 45 }] }),
    ]);
    const readSizes: number[] = [];
    const range = await openRangeReadablePrepackedProteinSearchIndexV1(
      artifact.manifest,
      {
        byteLength: artifact.payload.byteLength,
        async read(byteOffset, byteLength) {
          readSizes.push(byteLength);
          return artifact.payload.slice(byteOffset, byteOffset + byteLength);
        },
      },
      { scanChunkBytes: 7 }
    );

    expect((await range.query('MKWVT')).matches).toHaveLength(1);
    expect(Math.max(...readSizes)).toBeLessThan(artifact.payload.byteLength);
  });

  it('rejects payload corruption after persistence', async () => {
    const artifact = await packed();
    const persistedManifest = JSON.parse(JSON.stringify(artifact.manifest));
    const corrupt = artifact.payload.slice();
    corrupt[corrupt.length - 1] ^= 1;

    await expect(unpackPrepackedProteinSearchIndexV1(persistedManifest, corrupt)).rejects.toThrow(
      /sha256 mismatch/i
    );
  });
});
