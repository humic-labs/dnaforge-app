import { describe, expect, it } from 'vitest';

import {
  PREPACKED_ANNOTATION_SEARCH_FEATURE_RECORD_BYTES,
  PREPACKED_ANNOTATION_SEARCH_FIELD_SEPARATOR,
  PREPACKED_ANNOTATION_SEARCH_MAX_QUERY_CODE_UNITS_V1,
  PREPACKED_ANNOTATION_SEARCH_MAX_RESULT_TEXT_CODE_UNITS_V1,
  PREPACKED_ANNOTATION_SEARCH_MAX_CANONICAL_IDENTITY_CODE_UNITS_V1,
  openRangeReadablePrepackedAnnotationSearchIndexV1,
  packPrepackedAnnotationSearchIndexV1,
  unpackPrepackedAnnotationSearchIndexV1,
  validatePrepackedAnnotationSearchIndexV1,
  visitPrepackedAnnotationSearchResultIdentitiesV1,
  type IndexableAnnotationSearchFeatureV1,
  type PrepackedAnnotationSearchIndexManifestV1,
} from './prepacked-annotation-search-index-v1';

const DATASET = {
  datasetId: 'refseq-grch38',
  datasetVersion: 'test-v1',
  sourceSha256: 'a'.repeat(64),
};
const ASSEMBLY = {
  assemblyId: 'GRCh38',
  assemblyLengthBp: 3_088_269_832,
  placementSignature: 'chr1:248956422|chr2:242193529',
  sourceFingerprint: 'b'.repeat(24),
};

function feature(
  overrides: Partial<IndexableAnnotationSearchFeatureV1> &
    Pick<IndexableAnnotationSearchFeatureV1, 'start' | 'end'>
): IndexableAnnotationSearchFeatureV1 {
  return {
    type: 'mRNA',
    annotationTrackId: 'mRNA',
    canonicalIdentity: 'annotation.v2:test-default',
    direction: 'forward',
    displayName: '',
    qualifiers: {},
    attributes: {},
    ...overrides,
  };
}

async function pack(features: ReadonlyArray<IndexableAnnotationSearchFeatureV1>) {
  return packPrepackedAnnotationSearchIndexV1({
    datasetContract: DATASET,
    assemblyContract: ASSEMBLY,
    trackType: 'mRNA',
    features,
  });
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join(
    ''
  );
}

function cloneManifest(
  manifest: PrepackedAnnotationSearchIndexManifestV1
): PrepackedAnnotationSearchIndexManifestV1 {
  return JSON.parse(JSON.stringify(manifest)) as PrepackedAnnotationSearchIndexManifestV1;
}

describe('prepacked annotation search index v1', () => {
  it('reports finite monotonic work through packing and semantic validation', async () => {
    const progress: Array<{ phase: string; completed: number; total: number }> = [];
    await packPrepackedAnnotationSearchIndexV1({
      datasetContract: DATASET,
      assemblyContract: ASSEMBLY,
      trackType: 'mRNA',
      features: [
        feature({ sourceOrdinal: 0, start: 100, end: 250, displayName: 'PROGRESS_ONE' }),
        feature({ sourceOrdinal: 1, start: 300, end: 450, displayName: 'PROGRESS_TWO' }),
      ],
      onProgress: (update) => progress.push(update),
    });

    expect(progress[0]).toEqual({ phase: 'validating-features', completed: 0, total: 2 });
    expect(progress.at(-1)).toEqual({
      phase: 'validating-payload-completeness',
      completed: 2,
      total: 2,
    });
    for (const phase of new Set(progress.map((update) => update.phase))) {
      const updates = progress.filter((update) => update.phase === phase);
      expect(updates[0]?.completed, phase).toBe(0);
      expect(updates.at(-1)?.completed, phase).toBe(updates.at(-1)?.total);
      expect(
        updates.every(
          (update, index) => index === 0 || update.completed >= updates[index - 1].completed
        ),
        phase
      ).toBe(true);
    }
  });

  it('round-trips exact fields and returns zero-copy views over the payload', async () => {
    const packed = await pack([
      feature({
        sourceOrdinal: 17,
        start: 100,
        end: 250,
        displayName: 'LGALS12 transcript variant 2',
        qualifiers: { gene: ['LGALS12'], product: ['galectin 12'] },
      }),
      feature({
        sourceOrdinal: 41,
        start: 900,
        end: 1_200,
        type: 'lnc_RNA',
        annotationTrackId: 'lncRNA',
        canonicalIdentity: 'annotation.v2:test-linc-one',
        displayName: 'LINC-ONE',
      }),
    ]);
    const view = await unpackPrepackedAnnotationSearchIndexV1(packed.manifest, packed.payload);

    expect(view.size).toBe(2);
    expect(view.query('  gAlEcTiN  ')).toEqual([
      {
        featureIndex: 17,
        start: 100,
        end: 250,
        label: 'LGALS12 transcript variant 2',
        featureType: 'mRNA',
        annotationTrackId: 'mRNA',
        canonicalIdentity: 'annotation.v2:test-default',
        direction: 'forward',
      },
    ]);
    expect(view.query('LINC-ONE')).toEqual([
      expect.objectContaining({
        featureType: 'lnc_RNA',
        annotationTrackId: 'lncRNA',
        canonicalIdentity: 'annotation.v2:test-linc-one',
      }),
    ]);
    expect(view.featureRecords.buffer).toBe(packed.payload.buffer);
    expect(view.textCodeUnits.buffer).toBe(packed.payload.buffer);
    expect(view.gramKeys.buffer).toBe(packed.payload.buffer);
    expect(view.postingOffsets.buffer).toBe(packed.payload.buffer);
    expect(view.postingFeatureIndices.buffer).toBe(packed.payload.buffer);
    const identities: Array<{ annotationTrackId: string; canonicalIdentity: string }> = [];
    visitPrepackedAnnotationSearchResultIdentitiesV1(view, (identity) => {
      identities.push(identity);
    });
    expect(identities).toEqual([
      {
        annotationTrackId: 'mRNA',
        canonicalIdentity: 'annotation.v2:test-default',
      },
      {
        annotationTrackId: 'lncRNA',
        canonicalIdentity: 'annotation.v2:test-linc-one',
      },
    ]);
    expect(packed.manifest.sections.featureRecords.recordBytes).toBe(
      PREPACKED_ANNOTATION_SEARCH_FEATURE_RECORD_BYTES
    );
    expect(packed.manifest.integrity.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(packed.manifest.integrity.contractSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('round-trips required renderer direction through memory and bounded-range queries', async () => {
    const packed = await pack([
      {
        ...feature({
          sourceOrdinal: 17,
          start: 100,
          end: 250,
          displayName: 'FORWARD-DIRECTION-HIT',
        }),
        direction: 'forward',
      },
      {
        ...feature({
          sourceOrdinal: 41,
          start: 900,
          end: 1_200,
          displayName: 'REVERSE-DIRECTION-HIT',
        }),
        direction: 'reverse',
      },
      {
        ...feature({
          sourceOrdinal: 53,
          start: 1_500,
          end: 1_700,
          displayName: 'NONE-DIRECTION-HIT',
        }),
        direction: 'none',
      },
    ]);
    const inMemory = await unpackPrepackedAnnotationSearchIndexV1(packed.manifest, packed.payload);
    const ranged = await openRangeReadablePrepackedAnnotationSearchIndexV1(packed.manifest, {
      byteLength: packed.payload.byteLength,
      async read(byteOffset, byteLength) {
        return packed.payload.slice(byteOffset, byteOffset + byteLength);
      },
    });

    expect(inMemory.query('direction-hit').map((match) => match.direction)).toEqual([
      'forward',
      'reverse',
      'none',
    ]);
    await expect(ranged.query('direction-hit')).resolves.toEqual(inMemory.query('direction-hit'));
  });

  it('queries through bounded ranges with exact in-memory parity and no whole-payload read', async () => {
    const packed = await pack([
      feature({ sourceOrdinal: 7, start: 900, end: 950, displayName: 'HBB alpha' }),
      feature({ sourceOrdinal: 12, start: 100, end: 200, displayName: 'HBB beta' }),
      feature({ sourceOrdinal: 19, start: 300, end: 400, displayName: 'ABCxxBCD' }),
      feature({ sourceOrdinal: 25, start: 500, end: 600, displayName: 'P53 gamma' }),
    ]);
    const reads: Array<{ byteOffset: number; byteLength: number }> = [];
    const ranged = await openRangeReadablePrepackedAnnotationSearchIndexV1(packed.manifest, {
      byteLength: packed.payload.byteLength,
      async read(byteOffset, byteLength) {
        reads.push({ byteOffset, byteLength });
        return packed.payload.slice(byteOffset, byteOffset + byteLength);
      },
    });
    const expected = await unpackPrepackedAnnotationSearchIndexV1(packed.manifest, packed.payload);

    for (const [query, limit] of [
      ['hbb', 200],
      ['abcd', 200],
      ['hbb', 1],
      ['missing', 200],
    ] as const) {
      await expect(ranged.query(query, limit)).resolves.toEqual(expected.query(query, limit));
    }
    await expect(ranged.query('p5', 200)).resolves.toEqual([]);
    expect(reads.length).toBeGreaterThan(0);
    expect(Math.max(...reads.map((read) => read.byteLength))).toBeLessThan(
      packed.payload.byteLength
    );
    expect(reads).not.toContainEqual({ byteOffset: 0, byteLength: packed.payload.byteLength });
  });

  it('rejects an oversized range query before reading any query plane', async () => {
    const packed = await pack([
      feature({ sourceOrdinal: 7, start: 100, end: 200, displayName: 'HBB alpha' }),
    ]);
    const reads: Array<{ byteOffset: number; byteLength: number }> = [];
    const ranged = await openRangeReadablePrepackedAnnotationSearchIndexV1(packed.manifest, {
      byteLength: packed.payload.byteLength,
      async read(byteOffset, byteLength) {
        reads.push({ byteOffset, byteLength });
        return packed.payload.slice(byteOffset, byteOffset + byteLength);
      },
    });
    const directoryReadCount = reads.length;

    await expect(
      ranged.query('x'.repeat(PREPACKED_ANNOTATION_SEARCH_MAX_QUERY_CODE_UNITS_V1 + 1))
    ).rejects.toThrow(/query exceeds 256 UTF-16 code units/);
    expect(reads).toHaveLength(directoryReadCount);
  });

  it('cooperatively cancels a range query after an in-flight bounded read', async () => {
    const packed = await pack(
      Array.from({ length: 1_000 }, (_, index) =>
        feature({
          sourceOrdinal: index,
          start: index * 1_000,
          end: index * 1_000 + 100,
          displayName: `COMMON-${index}`,
        })
      )
    );
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => (releaseRead = resolve));
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => (markReadStarted = resolve));
    let blocked = false;
    const ranged = await openRangeReadablePrepackedAnnotationSearchIndexV1(packed.manifest, {
      byteLength: packed.payload.byteLength,
      async read(byteOffset, byteLength) {
        if (!blocked && byteOffset >= packed.manifest.sections.postingFeatureIndices.byteOffset) {
          blocked = true;
          markReadStarted();
          await readGate;
        }
        return packed.payload.slice(byteOffset, byteOffset + byteLength);
      },
    });
    const controller = new AbortController();
    const cancellation = new Error('superseded annotation query');
    cancellation.name = 'AbortError';
    const query = ranged.query('common', 500, { signal: controller.signal });

    await readStarted;
    controller.abort(cancellation);
    releaseRead();

    await expect(query).rejects.toBe(cancellation);
  });

  it('cancels within one text page and does not continue scanning a stale long haystack', async () => {
    const packed = await pack([
      feature({
        start: 100,
        end: 200,
        qualifiers: { note: `${'a'.repeat(200_000)}TAIL-NEEDLE` },
      }),
    ]);
    const textSection = packed.manifest.sections.textCodeUnits;
    let textReadCount = 0;
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => (releaseRead = resolve));
    let markSecondTextReadStarted!: () => void;
    const secondTextReadStarted = new Promise<void>((resolve) => {
      markSecondTextReadStarted = resolve;
    });
    const ranged = await openRangeReadablePrepackedAnnotationSearchIndexV1(packed.manifest, {
      byteLength: packed.payload.byteLength,
      async read(byteOffset, byteLength) {
        if (
          byteOffset >= textSection.byteOffset &&
          byteOffset < textSection.byteOffset + textSection.byteLength
        ) {
          textReadCount += 1;
          if (textReadCount === 2) {
            markSecondTextReadStarted();
            await readGate;
          }
        }
        return packed.payload.slice(byteOffset, byteOffset + byteLength);
      },
    });
    const controller = new AbortController();
    const cancellation = new Error('superseded during text scan');
    cancellation.name = 'AbortError';
    const query = ranged.query('tail-needle', 200, { signal: controller.signal });

    await secondTextReadStarted;
    controller.abort(cancellation);
    releaseRead();

    await expect(query).rejects.toBe(cancellation);
    expect(textReadCount).toBe(2);
  });

  it('preserves exact long-query parity while intersecting only bounded rare grams', async () => {
    const needle = Array.from({ length: 200 }, (_, index) =>
      String.fromCharCode(0xe000 + index)
    ).join('');
    const separatedGrams = Array.from({ length: needle.length - 2 }, (_, index) =>
      needle.slice(index, index + 3)
    ).join('|');
    const packed = await pack([
      feature({ sourceOrdinal: 7, start: 900, end: 950, displayName: needle }),
      feature({ sourceOrdinal: 12, start: 100, end: 200, displayName: separatedGrams }),
      feature({ sourceOrdinal: 19, start: 300, end: 400, displayName: 'unrelated' }),
    ]);
    const ranged = await openRangeReadablePrepackedAnnotationSearchIndexV1(packed.manifest, {
      byteLength: packed.payload.byteLength,
      async read(byteOffset, byteLength) {
        return packed.payload.slice(byteOffset, byteOffset + byteLength);
      },
    });
    const expected = await unpackPrepackedAnnotationSearchIndexV1(packed.manifest, packed.payload);

    expect(needle.length).toBeLessThanOrEqual(PREPACKED_ANNOTATION_SEARCH_MAX_QUERY_CODE_UNITS_V1);
    await expect(ranged.query(needle, 200)).resolves.toEqual(expected.query(needle, 200));
    await expect(ranged.query(needle, 200)).resolves.toHaveLength(1);
  });

  it('caps returned labels without truncating exact search haystacks', async () => {
    const prefix = 'A'.repeat(PREPACKED_ANNOTATION_SEARCH_MAX_RESULT_TEXT_CODE_UNITS_V1 - 1);
    const typePrefix = 'B'.repeat(PREPACKED_ANNOTATION_SEARCH_MAX_RESULT_TEXT_CODE_UNITS_V1 - 1);
    const longLabel = `${prefix}😀-TAIL-NEEDLE`;
    const longType = `${typePrefix}😀-LONG-TYPE`;
    const packed = await pack([
      feature({
        sourceOrdinal: 7,
        start: 100,
        end: 200,
        displayName: longLabel,
        type: longType,
      }),
    ]);
    const ranged = await openRangeReadablePrepackedAnnotationSearchIndexV1(packed.manifest, {
      byteLength: packed.payload.byteLength,
      async read(byteOffset, byteLength) {
        return packed.payload.slice(byteOffset, byteOffset + byteLength);
      },
    });
    const inMemory = await unpackPrepackedAnnotationSearchIndexV1(packed.manifest, packed.payload);

    expect(packed.manifest.searchContract.contractToken).toBe(
      'annotation-search-js-lower-trim-type-values-utf16-trigram-v6-track-canonical-direction'
    );
    expect(packed.manifest.searchContract.resultDirectionEncoding).toBe(
      'none-0-forward-1-reverse-2.u32.v1'
    );
    const inMemoryMatches = inMemory.query('tail-needle');
    await expect(ranged.query('tail-needle')).resolves.toEqual(inMemoryMatches);
    expect(inMemoryMatches).toEqual([
      {
        featureIndex: 7,
        start: 100,
        end: 200,
        label: prefix,
        featureType: typePrefix,
        annotationTrackId: 'mRNA',
        canonicalIdentity: 'annotation.v2:test-default',
        direction: 'forward',
      },
    ]);
    expect(inMemoryMatches[0].label.length).toBeLessThanOrEqual(
      PREPACKED_ANNOTATION_SEARCH_MAX_RESULT_TEXT_CODE_UNITS_V1
    );
    expect(inMemoryMatches[0].featureType.length).toBeLessThanOrEqual(
      PREPACKED_ANNOTATION_SEARCH_MAX_RESULT_TEXT_CODE_UNITS_V1
    );
  });

  it('round-trips exact renderer identities beyond the display-text limit', async () => {
    const canonicalIdentity = `annotation.v2:${'renderer-identity-segment'.repeat(16)}`;
    expect(canonicalIdentity.length).toBeGreaterThan(
      PREPACKED_ANNOTATION_SEARCH_MAX_RESULT_TEXT_CODE_UNITS_V1
    );
    expect(canonicalIdentity.length).toBeLessThanOrEqual(
      PREPACKED_ANNOTATION_SEARCH_MAX_CANONICAL_IDENTITY_CODE_UNITS_V1
    );
    const packed = await pack([
      feature({
        sourceOrdinal: 7,
        start: 100,
        end: 200,
        displayName: 'LONG-IDENTITY-HIT',
        canonicalIdentity,
      }),
    ]);
    const inMemory = await unpackPrepackedAnnotationSearchIndexV1(packed.manifest, packed.payload);
    const ranged = await openRangeReadablePrepackedAnnotationSearchIndexV1(packed.manifest, {
      byteLength: packed.payload.byteLength,
      async read(byteOffset, byteLength) {
        return packed.payload.slice(byteOffset, byteOffset + byteLength);
      },
    });

    expect(inMemory.query('LONG-IDENTITY-HIT')[0]?.canonicalIdentity).toBe(canonicalIdentity);
    await expect(ranged.query('LONG-IDENTITY-HIT')).resolves.toEqual(
      inMemory.query('LONG-IDENTITY-HIT')
    );
  });

  it('stores the canonical source authority once and only per-feature suffixes thereafter', async () => {
    const genomeIdentity = `assembly-annotation-source-sha256.v1:${'c'.repeat(64)}`;
    const identities = Array.from({ length: 256 }, (_, index) =>
      JSON.stringify([
        'annotation.v2',
        genomeIdentity,
        String.fromCharCode(0xe000 + index),
        `transcript-${index}`,
        index % 2 === 0 ? 'mRNA' : 'lncRNA',
        index % 2 === 0 ? 'mRNA' : 'ncRNA',
        index * 1_000,
        index * 1_000 + 100,
        'forward',
      ])
    );
    const packed = await pack(
      identities.map((canonicalIdentity, index) =>
        feature({
          sourceOrdinal: index,
          start: index * 1_000,
          end: index * 1_000 + 100,
          displayName: `PREFIX-SIZE-${index}`,
          canonicalIdentity,
        })
      )
    );
    const prefix = packed.manifest.canonicalIdentityPrefix;
    const expectedSuffixCodeUnits = identities.reduce(
      (total, identity) => total + identity.length - prefix.length,
      0
    );
    const naiveCanonicalCodeUnits = identities.reduce(
      (total, identity) => total + identity.length,
      0
    );
    const compactCanonicalCodeUnits = prefix.length + expectedSuffixCodeUnits;

    expect(prefix).toContain(genomeIdentity);
    expect(packed.packWork.canonicalIdentityPrefixCodeUnitCount).toBe(prefix.length);
    expect(packed.packWork.canonicalIdentitySuffixCodeUnitCount).toBe(expectedSuffixCodeUnits);
    expect(compactCanonicalCodeUnits).toBeLessThan(naiveCanonicalCodeUnits * 0.5);
    expect(naiveCanonicalCodeUnits - compactCanonicalCodeUnits).toBe(
      prefix.length * (identities.length - 1)
    );
  });

  it('does not split a supplementary character at the manifest-prefix boundary', async () => {
    const firstIdentity = 'annotation.v2:shared-😀-first';
    const secondIdentity = 'annotation.v2:shared-😁-second';
    const packed = await pack([
      feature({
        sourceOrdinal: 0,
        start: 100,
        end: 200,
        displayName: 'SURROGATE-FIRST',
        canonicalIdentity: firstIdentity,
      }),
      feature({
        sourceOrdinal: 1,
        start: 300,
        end: 400,
        displayName: 'SURROGATE-SECOND',
        canonicalIdentity: secondIdentity,
      }),
    ]);
    const ranged = await openRangeReadablePrepackedAnnotationSearchIndexV1(packed.manifest, {
      byteLength: packed.payload.byteLength,
      async read(byteOffset, byteLength) {
        return packed.payload.slice(byteOffset, byteOffset + byteLength);
      },
    });

    expect(packed.manifest.canonicalIdentityPrefix).toBe('annotation.v2:shared-');
    await expect(ranged.query('surrogate')).resolves.toEqual([
      expect.objectContaining({ canonicalIdentity: firstIdentity }),
      expect.objectContaining({ canonicalIdentity: secondIdentity }),
    ]);
  });

  it('searches every qualifier and attribute array value, including second and third values', async () => {
    const packed = await pack([
      feature({
        start: 100,
        end: 200,
        qualifiers: {
          gene: ['FIRST-GENE', 'SECOND-GENE', 'THIRD-GENE'],
          scalar: 'SCALAR-QUALIFIER',
        },
        attributes: {
          product: ['first product', 'second product', 'third product'],
          note: 'SCALAR-ATTRIBUTE',
        },
      }),
    ]);
    const view = await unpackPrepackedAnnotationSearchIndexV1(packed.manifest, packed.payload);

    for (const query of [
      'second-gene',
      'third-gene',
      'second product',
      'third product',
      'scalar-qualifier',
      'scalar-attribute',
    ]) {
      expect(view.query(query), query).toHaveLength(1);
    }
    expect(view.query('product')).toHaveLength(1);
    expect(view.query('note')).toHaveLength(0);
  });

  it('preserves primary-label fallback insertion and array order', async () => {
    const packed = await pack([
      feature({
        start: 100,
        end: 200,
        qualifiers: {
          empty: [],
          firstInserted: ['', 'FIRST-LABEL', 'later'],
          secondInserted: ['SECOND-LABEL'],
        },
      }),
      feature({
        start: 300,
        end: 400,
        qualifiers: {},
        attributes: { firstAttribute: ['', 'ATTRIBUTE-LABEL'] },
      }),
      feature({ start: 500, end: 600, type: 'enhancer' }),
    ]);
    const view = await unpackPrepackedAnnotationSearchIndexV1(packed.manifest, packed.payload);

    expect(view.query('first-label')[0]?.label).toBe('FIRST-LABEL');
    expect(view.query('attribute-label')[0]?.label).toBe('ATTRIBUTE-LABEL');
    expect(view.query('enhancer')[0]?.label).toBe('enhancer');
  });

  it('uses the bounded linear fallback for two-character queries and handles repeated trigrams', async () => {
    const packed = await pack([
      feature({ start: 100, end: 200, displayName: 'TP53-AAAAA' }),
      feature({ start: 300, end: 400, displayName: 'P53-AAAA' }),
      feature({ start: 500, end: 600, displayName: 'OTHER' }),
    ]);
    const view = await unpackPrepackedAnnotationSearchIndexV1(packed.manifest, packed.payload);

    expect(view.query('p5').map((match) => match.featureIndex)).toEqual([0, 1]);
    expect(view.query('aaaa').map((match) => match.featureIndex)).toEqual([0, 1]);
    expect(view.query('aaab')).toEqual([]);
  });

  it('verifies contiguous substrings after all query grams intersect', async () => {
    const packed = await pack([feature({ start: 100, end: 200, displayName: 'ABCxxBCD' })]);
    const view = await unpackPrepackedAnnotationSearchIndexV1(packed.manifest, packed.payload);

    expect(view.query('abcd')).toEqual([]);
    expect(view.query('abcxxbcd')).toHaveLength(1);
    expect(view.query('abz')).toEqual([]);
  });

  it('preserves exact separator boundaries without accidental direct concatenation', async () => {
    const packed = await pack([
      feature({
        start: 100,
        end: 200,
        displayName: 'alpha',
        qualifiers: { product: ['beta'] },
      }),
    ]);
    const view = await unpackPrepackedAnnotationSearchIndexV1(packed.manifest, packed.payload);

    expect(view.query('alphabeta')).toEqual([]);
    expect(view.query(`alpha${PREPACKED_ANNOTATION_SEARCH_FIELD_SEPARATOR}beta`)).toEqual([]);
    expect(view.query(`alpha${PREPACKED_ANNOTATION_SEARCH_FIELD_SEPARATOR}mrna`)).toHaveLength(1);
    expect(view.query(`mrna${PREPACKED_ANNOTATION_SEARCH_FIELD_SEPARATOR}beta`)).toHaveLength(1);
  });

  it('preserves JavaScript UTF-16 lowercasing, supplementary pairs, and lone surrogates', async () => {
    const loneHigh = '\ud83d';
    const packed = await pack([
      feature({
        start: 100,
        end: 200,
        displayName: `İSTANBUL-😀-${loneHigh}X`,
        attributes: { aliases: ['CAFÉ', '東京'] },
      }),
    ]);
    const view = await unpackPrepackedAnnotationSearchIndexV1(packed.manifest, packed.payload);

    expect(view.query('i\u0307stanbul')).toHaveLength(1);
    expect(view.query('😀')).toHaveLength(1);
    expect(view.query(loneHigh)).toHaveLength(1);
    expect(view.query(`${loneHigh}x`)).toHaveLength(1);
    expect(view.query('café')).toHaveLength(1);
    expect(view.query('東京')).toHaveLength(1);
    expect(view.query('istanbul')).toEqual([]);
  });

  it('takes the source-order prefix before genomic sorting when a limit truncates', async () => {
    const packed = await pack([
      feature({ sourceOrdinal: 10, start: 900, end: 950, displayName: 'MATCH-A' }),
      feature({ sourceOrdinal: 20, start: 500, end: 550, displayName: 'MATCH-B' }),
      feature({ sourceOrdinal: 30, start: 10, end: 20, displayName: 'MATCH-C' }),
      feature({ sourceOrdinal: 40, start: 100, end: 150, displayName: 'MATCH-D' }),
    ]);
    const view = await unpackPrepackedAnnotationSearchIndexV1(packed.manifest, packed.payload);

    expect(view.query('match', 2).map((match) => match.featureIndex)).toEqual([20, 10]);
    expect(view.query('match', 3).map((match) => match.featureIndex)).toEqual([30, 20, 10]);
    expect(view.query('match', 0)).toEqual([]);
    expect(view.query('   ')).toEqual([]);
  });

  it('sorts ties by start, end, then global source ordinal', async () => {
    const packed = await pack([
      feature({ sourceOrdinal: 7, start: 100, end: 300, displayName: 'tie' }),
      feature({ sourceOrdinal: 12, start: 100, end: 200, displayName: 'tie' }),
      feature({ sourceOrdinal: 19, start: 100, end: 200, displayName: 'tie' }),
    ]);
    const view = await unpackPrepackedAnnotationSearchIndexV1(packed.manifest, packed.payload);
    expect(view.query('tie').map((match) => match.featureIndex)).toEqual([12, 19, 7]);
  });

  it('reports exact section byte accounting and validation work', async () => {
    const packed = await pack([
      feature({ start: 100, end: 200, displayName: 'ABC' }),
      feature({ start: 300, end: 400, displayName: 'XYZ' }),
    ]);
    const work = await validatePrepackedAnnotationSearchIndexV1(packed.manifest, packed.payload);
    const sections = Object.values(packed.manifest.sections);

    expect(packed.packWork.featureCount).toBe(2);
    expect(packed.manifest.sections.featureRecords.byteLength).toBe(
      2 * PREPACKED_ANNOTATION_SEARCH_FEATURE_RECORD_BYTES
    );
    expect(packed.payload.byteLength).toBe(packed.packWork.byteLength);
    expect(Math.max(...sections.map((section) => section.byteOffset + section.byteLength))).toBe(
      packed.payload.byteLength
    );
    expect(work).toEqual({
      featureRecordsScanned: 2,
      gramKeysScanned: packed.packWork.gramCount,
      postingsScanned: packed.packWork.postingCount,
      expectedPostingsVerified: packed.packWork.postingCount,
    });
  });

  it('rejects payload and contract hash drift', async () => {
    const packed = await pack([feature({ start: 100, end: 200, displayName: 'ABC' })]);
    const corruptPayload = new Uint8Array(packed.payload);
    corruptPayload[0] ^= 1;
    await expect(
      validatePrepackedAnnotationSearchIndexV1(packed.manifest, corruptPayload)
    ).rejects.toThrow(/payload sha256 mismatch/);

    const corruptContract = cloneManifest(packed.manifest);
    corruptContract.trackType = 'enhancer';
    await expect(
      validatePrepackedAnnotationSearchIndexV1(corruptContract, packed.payload)
    ).rejects.toThrow(/contract sha256 mismatch/);
  });

  it('rejects directionless legacy contracts before admission', async () => {
    const packed = await pack([feature({ start: 100, end: 200, displayName: 'ABC' })]);
    const staleV3Manifest = cloneManifest(packed.manifest) as unknown as {
      searchContract: {
        contractToken: string;
        resultIdentity?: unknown;
        resultIdentityEncoding?: unknown;
      };
    };
    staleV3Manifest.searchContract.contractToken =
      'annotation-search-js-lower-trim-type-values-utf16-trigram-v3';
    delete staleV3Manifest.searchContract.resultIdentity;
    delete staleV3Manifest.searchContract.resultIdentityEncoding;

    await expect(
      validatePrepackedAnnotationSearchIndexV1(
        staleV3Manifest as unknown as PrepackedAnnotationSearchIndexManifestV1,
        packed.payload
      )
    ).rejects.toThrow(/manifest contract is invalid/);

    const staleV4Manifest = cloneManifest(packed.manifest) as unknown as {
      searchContract: { contractToken: string; resultIdentityEncoding?: unknown };
      canonicalIdentityPrefix?: unknown;
    };
    staleV4Manifest.searchContract.contractToken =
      'annotation-search-js-lower-trim-type-values-utf16-trigram-v4-track-canonical';
    delete staleV4Manifest.searchContract.resultIdentityEncoding;
    delete staleV4Manifest.canonicalIdentityPrefix;

    await expect(
      validatePrepackedAnnotationSearchIndexV1(
        staleV4Manifest as unknown as PrepackedAnnotationSearchIndexManifestV1,
        packed.payload
      )
    ).rejects.toThrow(/manifest contract is invalid/);

    const staleV5Manifest = cloneManifest(packed.manifest) as unknown as {
      searchContract: { contractToken: string; resultDirectionEncoding?: unknown };
    };
    staleV5Manifest.searchContract.contractToken =
      'annotation-search-js-lower-trim-type-values-utf16-trigram-v5-track-canonical-prefix';
    delete staleV5Manifest.searchContract.resultDirectionEncoding;

    await expect(
      validatePrepackedAnnotationSearchIndexV1(
        staleV5Manifest as unknown as PrepackedAnnotationSearchIndexManifestV1,
        packed.payload
      )
    ).rejects.toThrow(/manifest contract is invalid/);
  });

  it('rejects an invalid direction code even after payload rehash', async () => {
    const packed = await pack([feature({ start: 100, end: 200, displayName: 'ABC' })]);
    const corrupt = new Uint8Array(packed.payload);
    const records = packed.manifest.sections.featureRecords;
    new DataView(corrupt.buffer).setUint32(records.byteOffset + 4, 3, true);
    const manifest = cloneManifest(packed.manifest);
    manifest.integrity.payloadSha256 = await sha256Hex(corrupt);

    await expect(validatePrepackedAnnotationSearchIndexV1(manifest, corrupt)).rejects.toThrow(
      /feature record is invalid/
    );
  });

  it('rejects out-of-range text references even after payload rehash', async () => {
    const packed = await pack([feature({ start: 100, end: 200, displayName: 'ABC' })]);
    const corrupt = new Uint8Array(packed.payload);
    const records = packed.manifest.sections.featureRecords;
    new DataView(corrupt.buffer).setUint32(records.byteOffset + 24, 0xffff_ffff, true);
    const manifest = cloneManifest(packed.manifest);
    manifest.integrity.payloadSha256 = await sha256Hex(corrupt);

    await expect(validatePrepackedAnnotationSearchIndexV1(manifest, corrupt)).rejects.toThrow(
      /text reference is out of range/
    );
  });

  it('rejects posting corruption even after payload rehash', async () => {
    const packed = await pack([
      feature({ start: 100, end: 200, displayName: 'ABC' }),
      feature({ start: 300, end: 400, displayName: 'XYZ' }),
    ]);
    const corrupt = new Uint8Array(packed.payload);
    const postings = packed.manifest.sections.postingFeatureIndices;
    new DataView(corrupt.buffer).setUint32(postings.byteOffset, 0xffff_ffff, true);
    const manifest = cloneManifest(packed.manifest);
    manifest.integrity.payloadSha256 = await sha256Hex(corrupt);

    await expect(validatePrepackedAnnotationSearchIndexV1(manifest, corrupt)).rejects.toThrow(
      /posting list is not strictly sorted/
    );
  });

  it('rejects a structurally valid posting substitution that would create a false negative', async () => {
    const packed = await pack([
      feature({ start: 100, end: 200, displayName: 'ABC-ONLY' }),
      feature({ start: 300, end: 400, displayName: 'XYZ-ONLY' }),
    ]);
    const abKey = (3n << 48n) | (97n << 32n) | (98n << 16n) | 99n;
    const gramIndex = packed.manifest.sections.gramKeys.count
      ? new BigUint64Array(
          packed.payload.buffer,
          packed.payload.byteOffset + packed.manifest.sections.gramKeys.byteOffset,
          packed.manifest.sections.gramKeys.count
        ).findIndex((key) => key === abKey)
      : -1;
    expect(gramIndex).toBeGreaterThanOrEqual(0);
    const offsets = new Uint32Array(
      packed.payload.buffer,
      packed.payload.byteOffset + packed.manifest.sections.postingOffsets.byteOffset,
      packed.manifest.sections.postingOffsets.count
    );
    expect(offsets[gramIndex + 1] - offsets[gramIndex]).toBe(1);

    const corrupt = new Uint8Array(packed.payload);
    const postingByteOffset =
      packed.manifest.sections.postingFeatureIndices.byteOffset + offsets[gramIndex] * 4;
    new DataView(corrupt.buffer).setUint32(postingByteOffset, 1, true);
    const manifest = cloneManifest(packed.manifest);
    manifest.integrity.payloadSha256 = await sha256Hex(corrupt);

    await expect(validatePrepackedAnnotationSearchIndexV1(manifest, corrupt)).rejects.toThrow(
      /posting list is incomplete/
    );
  });

  it('rejects nonzero alignment padding', async () => {
    let packed: Awaited<ReturnType<typeof pack>> | null = null;
    for (let suffixLength = 0; suffixLength < 8; suffixLength += 1) {
      const candidate = await pack([
        feature({
          start: 100,
          end: 200,
          displayName: `ABC${'X'.repeat(suffixLength)}`,
        }),
      ]);
      const candidateText = candidate.manifest.sections.textCodeUnits;
      if (
        candidate.manifest.sections.gramKeys.byteOffset >
        candidateText.byteOffset + candidateText.byteLength
      ) {
        packed = candidate;
        break;
      }
    }
    expect(packed).not.toBeNull();
    if (!packed) throw new Error('test fixture did not produce alignment padding');
    const text = packed.manifest.sections.textCodeUnits;
    const gram = packed.manifest.sections.gramKeys;
    expect(gram.byteOffset).toBeGreaterThan(text.byteOffset + text.byteLength);
    const corrupt = new Uint8Array(packed.payload);
    corrupt[text.byteOffset + text.byteLength] = 1;

    await expect(
      validatePrepackedAnnotationSearchIndexV1(packed.manifest, corrupt)
    ).rejects.toThrow(/padding is not zero/);
  });

  it('rejects duplicate or decreasing source ordinals at build time', async () => {
    await expect(
      pack([
        feature({ sourceOrdinal: 5, start: 100, end: 200 }),
        feature({ sourceOrdinal: 5, start: 300, end: 400 }),
      ])
    ).rejects.toThrow(/feature input is invalid/);
  });

  it('refuses to build a directionless or unknown-direction record', async () => {
    const valid = feature({ start: 100, end: 200 });
    const { direction: _direction, ...directionless } = valid;

    await expect(
      pack([directionless as unknown as IndexableAnnotationSearchFeatureV1])
    ).rejects.toThrow(/feature input is invalid/);
    await expect(
      pack([
        {
          ...valid,
          direction: 'sideways',
        } as unknown as IndexableAnnotationSearchFeatureV1,
      ])
    ).rejects.toThrow(/feature input is invalid/);
  });

  it('refuses to build hits without both exact result-identity fields', async () => {
    await expect(pack([feature({ start: 100, end: 200, annotationTrackId: '' })])).rejects.toThrow(
      /feature input is invalid/
    );
    await expect(pack([feature({ start: 100, end: 200, canonicalIdentity: '' })])).rejects.toThrow(
      /feature input is invalid/
    );
    await expect(
      pack([
        feature({
          start: 100,
          end: 200,
          canonicalIdentity: 'x'.repeat(
            PREPACKED_ANNOTATION_SEARCH_MAX_CANONICAL_IDENTITY_CODE_UNITS_V1 + 1
          ),
        }),
      ])
    ).rejects.toThrow(/feature input is invalid/);
    await expect(
      pack([feature({ start: 100, end: 200, canonicalIdentity: 'annotation.v2:\ud83d' })])
    ).rejects.toThrow(/feature input is invalid/);

    const packed = await pack([feature({ start: 100, end: 200 })]);
    const overlongPrefix = cloneManifest(packed.manifest);
    overlongPrefix.canonicalIdentityPrefix = 'x'.repeat(
      PREPACKED_ANNOTATION_SEARCH_MAX_CANONICAL_IDENTITY_CODE_UNITS_V1 + 1
    );
    await expect(
      validatePrepackedAnnotationSearchIndexV1(overlongPrefix, packed.payload)
    ).rejects.toThrow(/manifest contract is invalid/);
  });
});
