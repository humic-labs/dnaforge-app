import type { SourceObject } from '../../../shared/benchling-migration';

export const SYNTHETIC_STRAIN_A_ID = 'bfi_STRAINAA';
export const SYNTHETIC_STRAIN_B_ID = 'bfi_STRAINBB';
export const SYNTHETIC_EMPTY_DNA_ID = 'seq_EMPTYDNA';
export const SYNTHETIC_UNKNOWN_ID = 'bfi_UNKNOWNX';

export const SYNTHETIC_STRAIN_TEXT = [
  'Shared synthetic strain',
  'Genotype: deltaX',
  'Tag: first',
  'Tag: second',
  'Blank: ',
  '',
].join('\n');

export const SYNTHETIC_STRAIN_TEXT_SIBLING = [
  'Shared synthetic strain',
  'Genotype: deltaY',
  'Organism: Synthetic organism',
  '',
].join('\n');

export const SYNTHETIC_INVALID_STRAIN_TEXT = [
  'Not a strain record',
  'this line has no field separator',
  '',
].join('\n');

export const SYNTHETIC_ZERO_BASE_GENBANK = [
  'LOCUS       EMPTYDNA                   0 bp    DNA     linear       26-AUG-2026',
  'DEFINITION  Synthetic unresolved DNA.',
  'ACCESSION   ',
  'VERSION     ',
  'KEYWORDS    .',
  'SOURCE      synthetic source',
  'COMMENT     Synthetic comment only.',
  'FEATURES             Location/Qualifiers',
  'ORIGIN',
  '//',
  '',
].join('\n');

export function annotationQuoteRoundTripSource(): SourceObject {
  return sequenceSource({
    stableId: 'seq_QUOTES1',
    bases: 'ACGTACGT',
    annotations: [
      {
        type: 'misc_feature',
        label: 'Synthetic quote feature',
        start: 1,
        end: 4,
        strand: 0,
        color: '#6B7280',
        qualifiers: {
          label: ['Synthetic quote feature'],
          note: ['note: note=""synthetic"" translation=""EL""'],
        },
        translations: [],
      },
    ],
  });
}

export function nonstandardTranslationSource(): SourceObject {
  return sequenceSource({
    stableId: 'seq_TRANSLATE1',
    bases: 'ATGAAATAA',
    annotations: [
      {
        type: 'CDS',
        label: 'Synthetic CDS',
        start: 1,
        end: 9,
        strand: 1,
        color: '#3B82F6',
        qualifiers: {
          translation: ['M?*'],
        },
        translations: ['M?*'],
      },
    ],
  });
}

export function inferredPortableTypeRoundTripSource(): SourceObject {
  return sequenceSource({
    stableId: 'seq_INFERRED1',
    bases: 'ACGTACGT',
    annotations: [
      {
        type: 'Rho-independ...',
        label: 'terminator (putative)',
        start: 1,
        end: 4,
        strand: 0,
        color: '#6B7280',
        qualifiers: { label: ['terminator (putative)'] },
        translations: [],
      },
    ],
  });
}

export function strainSourceForIdentity(input: { stableId: string; name?: string }): SourceObject {
  return {
    id: input.stableId,
    stableId: input.stableId,
    sourceType: 'strain',
    name: input.name ?? 'Shared synthetic strain',
    aliases: [],
    sourceUrl: 'urn:dnaforge:test:' + input.stableId,
    sourcePath: 'Registry/' + input.stableId + '.txt',
    attachmentHashes: [],
    memberships: [],
    metadata: {},
    content: {},
    relationships: [],
  };
}

export function nativeStrainSource(): SourceObject {
  const sourcePath = `Registry/Shared synthetic strain (${SYNTHETIC_STRAIN_A_ID}).txt`;
  const sha256 = 'c'.repeat(64);
  return {
    ...strainSourceForIdentity({ stableId: SYNTHETIC_STRAIN_A_ID }),
    sourcePath,
    metadata: nativeExportMetadata(sourcePath, sha256, SYNTHETIC_STRAIN_TEXT.length),
    content: {
      kind: 'benchling_strain',
      displayName: 'Shared synthetic strain',
      fields: [
        { label: 'Genotype', value: 'deltaX', position: 0 },
        { label: 'Tag', value: 'first', position: 1 },
        { label: 'Tag', value: 'second', position: 2 },
        { label: 'Blank', value: '', position: 3 },
      ],
      sha256,
      sizeBytes: SYNTHETIC_STRAIN_TEXT.length,
      rawAccess: {
        archivePartId: `supplemental-local-export:${'a'.repeat(64)}`,
        entryPath: sourcePath,
      },
    },
  };
}

export function needsSequenceSource(): SourceObject {
  const sourcePath = `Registry/Empty DNA (${SYNTHETIC_EMPTY_DNA_ID}).gb`;
  const sha256 = 'd'.repeat(64);
  return {
    id: SYNTHETIC_EMPTY_DNA_ID,
    stableId: SYNTHETIC_EMPTY_DNA_ID,
    sourceType: 'dna_sequence',
    name: 'Empty DNA',
    aliases: [],
    sourceUrl: `urn:dnaforge:test:${SYNTHETIC_EMPTY_DNA_ID}`,
    sourcePath,
    attachmentHashes: [],
    memberships: [],
    metadata: nativeExportMetadata(sourcePath, sha256, SYNTHETIC_ZERO_BASE_GENBANK.length),
    content: {
      kind: 'dna_sequence_needs_sequence',
      moleculeType: 'DNA',
      bases: '',
      topology: 'linear',
      annotations: [],
      genbankMetadata: {
        locus: {
          raw: 'EMPTYDNA 0 bp DNA linear 26-AUG-2026',
          name: 'EMPTYDNA',
          declaredLength: 0,
          moleculeType: 'DNA',
          topology: 'linear',
          date: '26-AUG-2026',
        },
        definition: 'Synthetic unresolved DNA.',
        keywords: [],
        comments: ['Synthetic comment only.'],
        sourceFields: [],
      },
      sha256,
      sizeBytes: SYNTHETIC_ZERO_BASE_GENBANK.length,
      rawAccess: {
        archivePartId: `supplemental-local-export:${'a'.repeat(64)}`,
        entryPath: sourcePath,
      },
    },
    relationships: [],
  };
}

function sequenceSource(input: {
  stableId: string;
  bases: string;
  annotations: unknown[];
}): SourceObject {
  const sourcePath = 'Registry/' + input.stableId + '.gb';
  const entrySha256 = 'b'.repeat(64);
  return {
    id: input.stableId,
    stableId: input.stableId,
    sourceType: 'dna_sequence',
    name: 'Synthetic sequence',
    aliases: [],
    sourceUrl: 'urn:dnaforge:test:' + input.stableId,
    sourcePath,
    attachmentHashes: [],
    memberships: [],
    metadata: {
      nativeExport: {
        archiveSha256: 'sha256:' + 'a'.repeat(64),
        entryPath: sourcePath,
        entrySha256: 'sha256:' + entrySha256,
        entrySizeBytes: 123,
      },
    },
    content: {
      moleculeType: 'DNA',
      bases: input.bases,
      topology: 'linear',
      sha256: 'sha256:' + entrySha256,
      sizeBytes: 123,
      rawAccess: {
        archivePartId: 'supplemental-local-export:' + 'a'.repeat(64),
        entryPath: sourcePath,
      },
      annotations: input.annotations,
    },
    relationships: [],
  };
}

function nativeExportMetadata(sourcePath: string, sha256: string, sizeBytes: number) {
  return {
    nativeExport: {
      archiveSha256: 'sha256:' + 'a'.repeat(64),
      entryPath: sourcePath,
      entrySha256: 'sha256:' + sha256,
      entrySizeBytes: sizeBytes,
    },
  };
}
