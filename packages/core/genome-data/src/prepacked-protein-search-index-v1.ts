import { indexOfSubsequenceBmh, normalizeProteinSearchQuery } from '@waypoint/sequence-utils';
export { indexOfSubsequenceBmh } from '@waypoint/sequence-utils';
import type {
  PrepackedAnnotationSearchAssemblyContractV1,
  PrepackedAnnotationSearchDatasetContractV1,
  PrepackedAnnotationSearchSha256V1,
  PrepackedSearchResultIdentityVisitorV1,
} from './prepacked-annotation-search-index-v1';

export const PREPACKED_PROTEIN_SEARCH_INDEX_V1 = 'prepacked-protein-search-index.v1' as const;
export const PREPACKED_PROTEIN_SEARCH_CONTRACT_TOKEN =
  'annotated-cds-protein-exact-ascii-v1-min5-cap500-il-exact-spliced-segments' as const;
export const PREPACKED_PROTEIN_SEARCH_FEATURE_RECORD_BYTES = 72;
export const PREPACKED_PROTEIN_SEARCH_SEGMENT_RECORD_BYTES = 16;
export const PREPACKED_PROTEIN_SEARCH_MIN_QUERY_RESIDUES_V1 = 5;
export const PREPACKED_PROTEIN_SEARCH_MAX_QUERY_RESIDUES_V1 = 256;
export const PREPACKED_PROTEIN_SEARCH_MAX_RESULTS_V1 = 500;
export const PREPACKED_PROTEIN_SEARCH_DEFAULT_SCAN_CHUNK_BYTES_V1 = 4 * 1024 * 1024;

const MAX_UINT32 = 0xffff_ffff;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SOURCE_FINGERPRINT = /^[0-9a-f]{24}$/;
const PROTEIN_SOURCE_ALPHABET = /^[ACDEFGHIKLMNPQRSTVWYX*]+$/;
const PROTEIN_QUERY_ALPHABET = /^[ACDEFGHIKLMNPQRSTVWY]+$/;
const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

const RECORD = {
  sourceOrdinal: 0,
  sequenceOffset: 4,
  sequenceLength: 8,
  segmentOffset: 12,
  segmentCount: 16,
  strandCode: 20,
  leadingFrameOffset: 21,
  geneticCode: 22,
  labelOffset: 24,
  labelLength: 28,
  geneIdOffset: 32,
  geneIdLength: 36,
  transcriptIdOffset: 40,
  transcriptIdLength: 44,
  trackIdOffset: 48,
  trackIdLength: 52,
  canonicalIdentityOffset: 56,
  canonicalIdentityLength: 60,
  featureTypeOffset: 64,
  featureTypeLength: 68,
} as const;

type ProteinSectionKeyV1 = 'featureRecords' | 'segments' | 'proteinSequences' | 'textBytes';

export interface PrepackedProteinSearchBinarySectionV1 {
  byteOffset: number;
  byteLength: number;
  count: number;
  recordBytes: number;
  alignmentBytes: 1 | 8;
}

export interface PrepackedProteinSearchContractV1 {
  contractToken: typeof PREPACKED_PROTEIN_SEARCH_CONTRACT_TOKEN;
  featureRecordBytes: typeof PREPACKED_PROTEIN_SEARCH_FEATURE_RECORD_BYTES;
  segmentRecordBytes: typeof PREPACKED_PROTEIN_SEARCH_SEGMENT_RECORD_BYTES;
  proteinEncoding: 'uppercase-ascii-zero-separated.v1';
  textEncoding: 'utf-8.v1';
  queryNormalization: 'trim-remove-whitespace-uppercase.v1';
  queryAlphabet: 'ACDEFGHIKLMNPQRSTVWY';
  isoleucineLeucineSemantics: 'exact-distinct';
  minimumQueryResidues: typeof PREPACKED_PROTEIN_SEARCH_MIN_QUERY_RESIDUES_V1;
  maximumQueryResidues: typeof PREPACKED_PROTEIN_SEARCH_MAX_QUERY_RESIDUES_V1;
  maximumResults: typeof PREPACKED_PROTEIN_SEARCH_MAX_RESULTS_V1;
  coordinates: 'zero-based-half-open-global-bp.v1';
  segmentOrder: 'biological-five-prime-to-three-prime.v1';
}

export interface PrepackedProteinSearchIndexManifestV1 {
  schema: typeof PREPACKED_PROTEIN_SEARCH_INDEX_V1;
  datasetContract: PrepackedAnnotationSearchDatasetContractV1;
  assemblyContract: PrepackedAnnotationSearchAssemblyContractV1;
  searchContract: PrepackedProteinSearchContractV1;
  featureCount: number;
  segmentCount: number;
  proteinResidueCount: number;
  sections: Record<ProteinSectionKeyV1, PrepackedProteinSearchBinarySectionV1>;
  byteLength: number;
  integrity: {
    algorithm: 'sha256';
    payloadSha256: string;
    contractSha256: string;
  };
}

export type PrepackedProteinSearchStrandV1 = 'forward' | 'reverse';

export interface PrepackedProteinSearchGenomicSegmentV1 {
  start: number;
  end: number;
}

export interface IndexableProteinSearchFeatureV1 {
  sourceOrdinal?: number;
  proteinSequence: string;
  segments: ReadonlyArray<PrepackedProteinSearchGenomicSegmentV1>;
  strand: PrepackedProteinSearchStrandV1;
  geneticCode: number;
  leadingFrameOffset: 0 | 1 | 2;
  label: string;
  geneId?: string;
  transcriptId: string;
  featureType: string;
  annotationTrackId: string;
  canonicalIdentity: string;
}

export interface PackPrepackedProteinSearchIndexV1Input {
  datasetContract: PrepackedAnnotationSearchDatasetContractV1;
  assemblyContract: PrepackedAnnotationSearchAssemblyContractV1;
  features: ReadonlyArray<IndexableProteinSearchFeatureV1>;
  payloadSha256?: PrepackedAnnotationSearchSha256V1;
}

export interface PackedPrepackedProteinSearchIndexV1 {
  manifest: PrepackedProteinSearchIndexManifestV1;
  payload: Uint8Array;
}

export interface PrepackedProteinSearchMatchV1 {
  featureIndex: number;
  proteinStart: number;
  proteinEnd: number;
  start: number;
  end: number;
  segments: PrepackedProteinSearchGenomicSegmentV1[];
  strand: PrepackedProteinSearchStrandV1;
  geneticCode: number;
  label: string;
  geneId?: string;
  transcriptId: string;
  featureType: string;
  annotationTrackId: string;
  canonicalIdentity: string;
}

export interface PrepackedProteinSearchQueryResultV1 {
  matches: PrepackedProteinSearchMatchV1[];
  truncated: boolean;
  limit: number;
}

export interface PrepackedProteinSearchIndexViewV1 {
  readonly schema: typeof PREPACKED_PROTEIN_SEARCH_INDEX_V1;
  readonly manifest: PrepackedProteinSearchIndexManifestV1;
  readonly payload: Uint8Array;
  readonly size: number;
  query(input: string, limit?: number): PrepackedProteinSearchQueryResultV1;
}

export interface PrepackedProteinSearchRangeReaderV1 {
  readonly byteLength: number;
  read(byteOffset: number, byteLength: number): Promise<Uint8Array>;
}

export type PrepackedProteinSubsequenceFinderV1 = (
  haystack: Uint8Array,
  needle: Uint8Array,
  fromIndex: number
) => number;

export interface OpenRangeReadablePrepackedProteinSearchOptionsV1 {
  scanChunkBytes?: number;
  findSubsequence?: PrepackedProteinSubsequenceFinderV1;
}

export interface PrepackedProteinSearchRangeIndexV1 {
  readonly schema: typeof PREPACKED_PROTEIN_SEARCH_INDEX_V1;
  readonly manifest: PrepackedProteinSearchIndexManifestV1;
  readonly size: number;
  query(
    input: string,
    limit?: number,
    options?: { signal?: AbortSignal }
  ): Promise<PrepackedProteinSearchQueryResultV1>;
}

interface TextRef {
  offset: number;
  length: number;
}

interface PreparedRecord {
  sourceOrdinal: number;
  sequenceOffset: number;
  sequenceLength: number;
  segmentOffset: number;
  segmentCount: number;
  strand: PrepackedProteinSearchStrandV1;
  leadingFrameOffset: 0 | 1 | 2;
  geneticCode: number;
  label: TextRef;
  geneId: TextRef;
  transcriptId: TextRef;
  trackId: TextRef;
  canonicalIdentity: TextRef;
  featureType: TextRef;
}

interface ProteinViews {
  records: DataView;
  segments: DataView;
  sequences: Uint8Array;
  text: Uint8Array;
}

const SEARCH_CONTRACT: PrepackedProteinSearchContractV1 = {
  contractToken: PREPACKED_PROTEIN_SEARCH_CONTRACT_TOKEN,
  featureRecordBytes: PREPACKED_PROTEIN_SEARCH_FEATURE_RECORD_BYTES,
  segmentRecordBytes: PREPACKED_PROTEIN_SEARCH_SEGMENT_RECORD_BYTES,
  proteinEncoding: 'uppercase-ascii-zero-separated.v1',
  textEncoding: 'utf-8.v1',
  queryNormalization: 'trim-remove-whitespace-uppercase.v1',
  queryAlphabet: 'ACDEFGHIKLMNPQRSTVWY',
  isoleucineLeucineSemantics: 'exact-distinct',
  minimumQueryResidues: PREPACKED_PROTEIN_SEARCH_MIN_QUERY_RESIDUES_V1,
  maximumQueryResidues: PREPACKED_PROTEIN_SEARCH_MAX_QUERY_RESIDUES_V1,
  maximumResults: PREPACKED_PROTEIN_SEARCH_MAX_RESULTS_V1,
  coordinates: 'zero-based-half-open-global-bp.v1',
  segmentOrder: 'biological-five-prime-to-three-prime.v1',
};

export async function packPrepackedProteinSearchIndexV1(
  input: PackPrepackedProteinSearchIndexV1Input
): Promise<PackedPrepackedProteinSearchIndexV1> {
  validatePackContract(input);
  const textRefs = new Map<string, TextRef>();
  const encodedText: Uint8Array[] = [];
  let textByteCount = 0;
  const addText = (value: string): TextRef => {
    const cached = textRefs.get(value);
    if (cached) return cached;
    const bytes = utf8.encode(value);
    const ref = { offset: textByteCount, length: bytes.length };
    textByteCount = checkedAdd(textByteCount, bytes.length, 'protein text bytes');
    textRefs.set(value, ref);
    encodedText.push(bytes);
    return ref;
  };

  let sequenceByteCount = 0;
  let residueCount = 0;
  let segmentCount = 0;
  let previousSourceOrdinal = -1;
  const records: PreparedRecord[] = [];
  const encodedProteins: Uint8Array[] = [];
  for (let recordIndex = 0; recordIndex < input.features.length; recordIndex += 1) {
    const feature = input.features[recordIndex];
    const sourceOrdinal = feature.sourceOrdinal ?? recordIndex;
    validateFeature(feature, sourceOrdinal, previousSourceOrdinal, input.assemblyContract);
    previousSourceOrdinal = sourceOrdinal;
    const protein = utf8.encode(feature.proteinSequence.toUpperCase());
    records.push({
      sourceOrdinal,
      sequenceOffset: sequenceByteCount,
      sequenceLength: protein.length,
      segmentOffset: segmentCount,
      segmentCount: feature.segments.length,
      strand: feature.strand,
      leadingFrameOffset: feature.leadingFrameOffset,
      geneticCode: feature.geneticCode,
      label: addText(feature.label),
      geneId: addText(feature.geneId ?? ''),
      transcriptId: addText(feature.transcriptId),
      trackId: addText(feature.annotationTrackId),
      canonicalIdentity: addText(feature.canonicalIdentity),
      featureType: addText(feature.featureType),
    });
    encodedProteins.push(protein);
    residueCount = checkedAdd(residueCount, protein.length, 'protein residue count');
    sequenceByteCount = checkedAdd(sequenceByteCount, protein.length + 1, 'protein sequence bytes');
    segmentCount = checkedAdd(segmentCount, feature.segments.length, 'protein segment count');
  }

  const sections = buildSectionLayout({
    featureRecords: records.length,
    segments: segmentCount,
    proteinSequences: sequenceByteCount,
    textBytes: textByteCount,
  });
  const payload = new Uint8Array(sections.textBytes.byteOffset + sections.textBytes.byteLength);
  const views = viewsFromSections(sections, payload);

  for (let index = 0; index < records.length; index += 1) {
    writeRecord(views.records, index, records[index]);
  }
  let segmentCursor = 0;
  for (const feature of input.features) {
    for (const segment of feature.segments) {
      const offset = segmentCursor * PREPACKED_PROTEIN_SEARCH_SEGMENT_RECORD_BYTES;
      views.segments.setBigUint64(offset, BigInt(segment.start), true);
      views.segments.setBigUint64(offset + 8, BigInt(segment.end), true);
      segmentCursor += 1;
    }
  }
  let sequenceCursor = 0;
  for (const protein of encodedProteins) {
    views.sequences.set(protein, sequenceCursor);
    sequenceCursor += protein.length + 1;
  }
  let textCursor = 0;
  for (const bytes of encodedText) {
    views.text.set(bytes, textCursor);
    textCursor += bytes.length;
  }

  const manifest: PrepackedProteinSearchIndexManifestV1 = {
    schema: PREPACKED_PROTEIN_SEARCH_INDEX_V1,
    datasetContract: { ...input.datasetContract },
    assemblyContract: { ...input.assemblyContract },
    searchContract: { ...SEARCH_CONTRACT },
    featureCount: records.length,
    segmentCount,
    proteinResidueCount: residueCount,
    sections,
    byteLength: payload.byteLength,
    integrity: { algorithm: 'sha256', payloadSha256: '', contractSha256: '' },
  };
  const hash = input.payloadSha256 ?? sha256Hex;
  manifest.integrity.payloadSha256 = await hash(payload);
  manifest.integrity.contractSha256 = await hashManifestContract(manifest, hash);
  validatePayloadSemantics(manifest, views);
  return { manifest, payload };
}

export async function unpackPrepackedProteinSearchIndexV1(
  manifest: PrepackedProteinSearchIndexManifestV1,
  payload: Uint8Array,
  payloadSha256: PrepackedAnnotationSearchSha256V1 = sha256Hex
): Promise<PrepackedProteinSearchIndexViewV1> {
  validateManifestLayout(manifest, payload.byteLength);
  if ((await payloadSha256(payload)) !== manifest.integrity.payloadSha256) {
    throw new Error('prepacked protein search payload sha256 mismatch');
  }
  if ((await hashManifestContract(manifest, payloadSha256)) !== manifest.integrity.contractSha256) {
    throw new Error('prepacked protein search contract sha256 mismatch');
  }
  const views = viewsFromSections(manifest.sections, payload);
  validatePayloadSemantics(manifest, views);
  return {
    schema: PREPACKED_PROTEIN_SEARCH_INDEX_V1,
    manifest,
    payload,
    size: manifest.featureCount,
    query(input: string, limit = PREPACKED_PROTEIN_SEARCH_MAX_RESULTS_V1) {
      const normalized = normalizeQuery(input);
      const boundedLimit = normalizeLimit(limit);
      const hitOffsets = findSequenceHits(
        views.sequences,
        utf8.encode(normalized),
        boundedLimit + 1
      );
      return materializeResult(
        manifest,
        views.records,
        views.segments,
        views.text,
        hitOffsets,
        normalized.length,
        boundedLimit
      );
    },
  };
}

export function visitPrepackedProteinSearchResultIdentitiesV1(
  index: PrepackedProteinSearchIndexViewV1,
  visitor: PrepackedSearchResultIdentityVisitorV1
): void {
  const views = viewsFromSections(index.manifest.sections, index.payload);
  for (let recordIndex = 0; recordIndex < index.manifest.featureCount; recordIndex += 1) {
    const base = recordIndex * PREPACKED_PROTEIN_SEARCH_FEATURE_RECORD_BYTES;
    visitor(
      {
        annotationTrackId: readText(
          views.text,
          recordRef(views.records, base, RECORD.trackIdOffset)
        ),
        canonicalIdentity: readText(
          views.text,
          recordRef(views.records, base, RECORD.canonicalIdentityOffset)
        ),
      },
      recordIndex
    );
  }
}

export async function openRangeReadablePrepackedProteinSearchIndexV1(
  manifest: PrepackedProteinSearchIndexManifestV1,
  reader: PrepackedProteinSearchRangeReaderV1,
  options: OpenRangeReadablePrepackedProteinSearchOptionsV1 = {}
): Promise<PrepackedProteinSearchRangeIndexV1> {
  validateManifestLayout(manifest, reader.byteLength);
  if ((await hashManifestContract(manifest, sha256Hex)) !== manifest.integrity.contractSha256) {
    throw new Error('prepacked protein search contract sha256 mismatch');
  }
  const [recordBytes, segmentBytes, textBytes] = await Promise.all([
    readSection(reader, manifest.sections.featureRecords),
    readSection(reader, manifest.sections.segments),
    readSection(reader, manifest.sections.textBytes),
  ]);
  const records = new DataView(recordBytes.buffer, recordBytes.byteOffset, recordBytes.byteLength);
  const segments = new DataView(
    segmentBytes.buffer,
    segmentBytes.byteOffset,
    segmentBytes.byteLength
  );
  validateMetadataSemantics(manifest, records, segments, textBytes);
  const scanChunkBytes = normalizeScanChunkBytes(options.scanChunkBytes);

  return {
    schema: PREPACKED_PROTEIN_SEARCH_INDEX_V1,
    manifest,
    size: manifest.featureCount,
    async query(input, limit = PREPACKED_PROTEIN_SEARCH_MAX_RESULTS_V1, queryOptions) {
      const normalized = normalizeQuery(input);
      const boundedLimit = normalizeLimit(limit);
      const needle = utf8.encode(normalized);
      const offsets: number[] = [];
      const sequenceSection = manifest.sections.proteinSequences;
      for (
        let coreStart = 0;
        coreStart < sequenceSection.byteLength && offsets.length <= boundedLimit;
        coreStart += scanChunkBytes
      ) {
        throwIfAborted(queryOptions?.signal);
        const coreEnd = Math.min(sequenceSection.byteLength, coreStart + scanChunkBytes);
        const readEnd = Math.min(sequenceSection.byteLength, coreEnd + needle.length - 1);
        const chunk = await reader.read(
          sequenceSection.byteOffset + coreStart,
          readEnd - coreStart
        );
        if (chunk.byteLength !== readEnd - coreStart) {
          throw new Error('prepacked protein search range reader returned a short read');
        }
        let from = 0;
        while (offsets.length <= boundedLimit) {
          const found = options.findSubsequence
            ? options.findSubsequence(chunk, needle, from)
            : indexOfSubsequenceBmh(chunk, needle, from);
          if (found < 0) break;
          const absolute = coreStart + found;
          if (absolute >= coreEnd) break;
          offsets.push(absolute);
          from = found + 1;
        }
      }
      throwIfAborted(queryOptions?.signal);
      return materializeResult(
        manifest,
        records,
        segments,
        textBytes,
        offsets,
        needle.length,
        boundedLimit
      );
    },
  };
}

function materializeResult(
  manifest: PrepackedProteinSearchIndexManifestV1,
  records: DataView,
  segments: DataView,
  text: Uint8Array,
  sequenceOffsets: ReadonlyArray<number>,
  queryLength: number,
  limit: number
): PrepackedProteinSearchQueryResultV1 {
  const matches: PrepackedProteinSearchMatchV1[] = [];
  for (const sequenceOffset of sequenceOffsets) {
    if (matches.length >= limit) break;
    const recordIndex = recordIndexForSequenceOffset(manifest, records, sequenceOffset);
    if (recordIndex < 0) continue;
    const base = recordIndex * PREPACKED_PROTEIN_SEARCH_FEATURE_RECORD_BYTES;
    const featureSequenceOffset = records.getUint32(base + RECORD.sequenceOffset, true);
    const featureSequenceLength = records.getUint32(base + RECORD.sequenceLength, true);
    const proteinStart = sequenceOffset - featureSequenceOffset;
    const proteinEnd = proteinStart + queryLength;
    if (proteinStart < 0 || proteinEnd > featureSequenceLength) continue;
    const strand = decodeStrand(records.getUint8(base + RECORD.strandCode));
    const leadingFrameOffset = records.getUint8(base + RECORD.leadingFrameOffset);
    const featureSegments = readFeatureSegments(records, segments, recordIndex);
    const matchedSegments = mapProteinRangeToGenome(
      featureSegments,
      strand,
      leadingFrameOffset,
      proteinStart,
      proteinEnd
    );
    if (matchedSegments.length === 0) continue;
    matches.push({
      featureIndex: records.getUint32(base + RECORD.sourceOrdinal, true),
      proteinStart,
      proteinEnd,
      start: Math.min(...matchedSegments.map((segment) => segment.start)),
      end: Math.max(...matchedSegments.map((segment) => segment.end)),
      segments: matchedSegments,
      strand,
      geneticCode: records.getUint16(base + RECORD.geneticCode, true),
      label: readText(text, recordRef(records, base, RECORD.labelOffset)),
      ...(readText(text, recordRef(records, base, RECORD.geneIdOffset))
        ? { geneId: readText(text, recordRef(records, base, RECORD.geneIdOffset)) }
        : {}),
      transcriptId: readText(text, recordRef(records, base, RECORD.transcriptIdOffset)),
      featureType: readText(text, recordRef(records, base, RECORD.featureTypeOffset)),
      annotationTrackId: readText(text, recordRef(records, base, RECORD.trackIdOffset)),
      canonicalIdentity: readText(text, recordRef(records, base, RECORD.canonicalIdentityOffset)),
    });
  }
  return {
    matches,
    truncated: sequenceOffsets.length > limit,
    limit,
  };
}

function mapProteinRangeToGenome(
  segments: ReadonlyArray<PrepackedProteinSearchGenomicSegmentV1>,
  strand: PrepackedProteinSearchStrandV1,
  leadingFrameOffset: number,
  proteinStart: number,
  proteinEnd: number
): PrepackedProteinSearchGenomicSegmentV1[] {
  const nucleotideStart = leadingFrameOffset + proteinStart * 3;
  const nucleotideEnd = leadingFrameOffset + proteinEnd * 3;
  const mapped: PrepackedProteinSearchGenomicSegmentV1[] = [];
  let cursor = 0;
  for (const segment of segments) {
    const length = segment.end - segment.start;
    const overlapStart = Math.max(nucleotideStart, cursor);
    const overlapEnd = Math.min(nucleotideEnd, cursor + length);
    if (overlapStart < overlapEnd) {
      const localStart = overlapStart - cursor;
      const localEnd = overlapEnd - cursor;
      mapped.push(
        strand === 'forward'
          ? { start: segment.start + localStart, end: segment.start + localEnd }
          : { start: segment.end - localEnd, end: segment.end - localStart }
      );
    }
    cursor += length;
    if (cursor >= nucleotideEnd) break;
  }
  return mapped;
}

function findSequenceHits(haystack: Uint8Array, needle: Uint8Array, maxHits: number): number[] {
  const hits: number[] = [];
  let from = 0;
  while (hits.length < maxHits) {
    const found = indexOfSubsequenceBmh(haystack, needle, from);
    if (found < 0) break;
    hits.push(found);
    from = found + 1;
  }
  return hits;
}

function recordIndexForSequenceOffset(
  manifest: PrepackedProteinSearchIndexManifestV1,
  records: DataView,
  sequenceOffset: number
): number {
  let low = 0;
  let high = manifest.featureCount - 1;
  let candidate = -1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const base = middle * PREPACKED_PROTEIN_SEARCH_FEATURE_RECORD_BYTES;
    const start = records.getUint32(base + RECORD.sequenceOffset, true);
    if (start <= sequenceOffset) {
      candidate = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return candidate;
}

function readFeatureSegments(
  records: DataView,
  segments: DataView,
  recordIndex: number
): PrepackedProteinSearchGenomicSegmentV1[] {
  const base = recordIndex * PREPACKED_PROTEIN_SEARCH_FEATURE_RECORD_BYTES;
  const segmentOffset = records.getUint32(base + RECORD.segmentOffset, true);
  const segmentCount = records.getUint32(base + RECORD.segmentCount, true);
  const result: PrepackedProteinSearchGenomicSegmentV1[] = [];
  for (let index = 0; index < segmentCount; index += 1) {
    const offset = (segmentOffset + index) * PREPACKED_PROTEIN_SEARCH_SEGMENT_RECORD_BYTES;
    result.push({
      start: readSafeUint64(segments, offset, 'protein segment start'),
      end: readSafeUint64(segments, offset + 8, 'protein segment end'),
    });
  }
  return result;
}

function validatePackContract(input: PackPrepackedProteinSearchIndexV1Input): void {
  if (
    !nonempty(input?.datasetContract?.datasetId) ||
    !nonempty(input.datasetContract.datasetVersion) ||
    !SHA256_HEX.test(input.datasetContract.sourceSha256) ||
    !nonempty(input?.assemblyContract?.assemblyId) ||
    !Number.isSafeInteger(input.assemblyContract.assemblyLengthBp) ||
    input.assemblyContract.assemblyLengthBp <= 0 ||
    !nonempty(input.assemblyContract.placementSignature) ||
    !SOURCE_FINGERPRINT.test(input.assemblyContract.sourceFingerprint) ||
    !Array.isArray(input.features) ||
    input.features.length > MAX_UINT32
  ) {
    throw new Error('prepacked protein search pack contract is invalid');
  }
}

function validateFeature(
  feature: IndexableProteinSearchFeatureV1,
  sourceOrdinal: number,
  previousSourceOrdinal: number,
  assembly: PrepackedAnnotationSearchAssemblyContractV1
): void {
  const sequence = feature?.proteinSequence?.toUpperCase();
  if (
    !feature ||
    !sequence ||
    !PROTEIN_SOURCE_ALPHABET.test(sequence) ||
    feature.proteinSequence !== sequence ||
    !Number.isInteger(sourceOrdinal) ||
    sourceOrdinal < 0 ||
    sourceOrdinal > MAX_UINT32 ||
    sourceOrdinal <= previousSourceOrdinal ||
    !Array.isArray(feature.segments) ||
    feature.segments.length === 0 ||
    (feature.strand !== 'forward' && feature.strand !== 'reverse') ||
    !Number.isInteger(feature.geneticCode) ||
    feature.geneticCode <= 0 ||
    feature.geneticCode > 0xffff ||
    ![0, 1, 2].includes(feature.leadingFrameOffset) ||
    !nonempty(feature.label) ||
    !nonempty(feature.transcriptId) ||
    !nonempty(feature.featureType) ||
    !nonempty(feature.annotationTrackId) ||
    !nonempty(feature.canonicalIdentity)
  ) {
    throw new Error('prepacked protein search feature input is invalid');
  }
  let nucleotideCount = 0;
  let previous: PrepackedProteinSearchGenomicSegmentV1 | undefined;
  for (const segment of feature.segments) {
    if (
      !Number.isSafeInteger(segment.start) ||
      !Number.isSafeInteger(segment.end) ||
      segment.start < 0 ||
      segment.end <= segment.start ||
      segment.end > assembly.assemblyLengthBp ||
      (previous &&
        (feature.strand === 'forward'
          ? segment.start < previous.end
          : segment.end > previous.start))
    ) {
      throw new Error('prepacked protein search genomic segment is invalid');
    }
    nucleotideCount = checkedAdd(
      nucleotideCount,
      segment.end - segment.start,
      'protein nucleotide span'
    );
    previous = segment;
  }
  if (feature.leadingFrameOffset + sequence.length * 3 > nucleotideCount) {
    throw new Error('prepacked protein search translation exceeds CDS nucleotide span');
  }
}

function validateManifestLayout(
  manifest: PrepackedProteinSearchIndexManifestV1,
  payloadByteLength: number
): void {
  if (
    manifest?.schema !== PREPACKED_PROTEIN_SEARCH_INDEX_V1 ||
    !nonempty(manifest.datasetContract?.datasetId) ||
    !nonempty(manifest.datasetContract?.datasetVersion) ||
    !SHA256_HEX.test(manifest.datasetContract?.sourceSha256 ?? '') ||
    !nonempty(manifest.assemblyContract?.assemblyId) ||
    !Number.isSafeInteger(manifest.assemblyContract?.assemblyLengthBp) ||
    manifest.assemblyContract.assemblyLengthBp <= 0 ||
    !nonempty(manifest.assemblyContract?.placementSignature) ||
    !SOURCE_FINGERPRINT.test(manifest.assemblyContract?.sourceFingerprint ?? '') ||
    !searchContractMatches(manifest.searchContract) ||
    !validCount(manifest.featureCount) ||
    !validCount(manifest.segmentCount) ||
    !validCount(manifest.proteinResidueCount) ||
    manifest.integrity?.algorithm !== 'sha256' ||
    !SHA256_HEX.test(manifest.integrity.payloadSha256) ||
    !SHA256_HEX.test(manifest.integrity.contractSha256)
  ) {
    throw new Error('prepacked protein search manifest contract is invalid');
  }
  const expected = buildSectionLayout({
    featureRecords: manifest.featureCount,
    segments: manifest.segmentCount,
    proteinSequences: manifest.sections?.proteinSequences?.count ?? -1,
    textBytes: manifest.sections?.textBytes?.count ?? -1,
  });
  for (const key of Object.keys(expected) as ProteinSectionKeyV1[]) {
    const actual = manifest.sections?.[key];
    const wanted = expected[key];
    if (
      !actual ||
      actual.byteOffset !== wanted.byteOffset ||
      actual.byteLength !== wanted.byteLength ||
      actual.count !== wanted.count ||
      actual.recordBytes !== wanted.recordBytes ||
      actual.alignmentBytes !== wanted.alignmentBytes
    ) {
      throw new Error('prepacked protein search sections are not exact and aligned');
    }
  }
  const computedLength = expected.textBytes.byteOffset + expected.textBytes.byteLength;
  if (
    manifest.sections.featureRecords.count !== manifest.featureCount ||
    manifest.sections.segments.count !== manifest.segmentCount ||
    manifest.sections.proteinSequences.count !==
      manifest.proteinResidueCount + manifest.featureCount ||
    manifest.byteLength !== computedLength ||
    payloadByteLength !== computedLength
  ) {
    throw new Error('prepacked protein search section counts are inconsistent');
  }
}

function validatePayloadSemantics(
  manifest: PrepackedProteinSearchIndexManifestV1,
  views: ProteinViews
): void {
  validateMetadataSemantics(manifest, views.records, views.segments, views.text);
  let residues = 0;
  for (let recordIndex = 0; recordIndex < manifest.featureCount; recordIndex += 1) {
    const base = recordIndex * PREPACKED_PROTEIN_SEARCH_FEATURE_RECORD_BYTES;
    const sequenceOffset = views.records.getUint32(base + RECORD.sequenceOffset, true);
    const sequenceLength = views.records.getUint32(base + RECORD.sequenceLength, true);
    for (let index = 0; index < sequenceLength; index += 1) {
      const code = views.sequences[sequenceOffset + index];
      if (!isSourceProteinAscii(code)) {
        throw new Error('prepacked protein search sequence alphabet is invalid');
      }
    }
    if (views.sequences[sequenceOffset + sequenceLength] !== 0) {
      throw new Error('prepacked protein search sequence separator is invalid');
    }
    residues += sequenceLength;
  }
  if (residues !== manifest.proteinResidueCount) {
    throw new Error('prepacked protein search residue count is inconsistent');
  }
}

function validateMetadataSemantics(
  manifest: PrepackedProteinSearchIndexManifestV1,
  records: DataView,
  segments: DataView,
  text: Uint8Array
): void {
  let previousSourceOrdinal = -1;
  let previousSequenceEnd = 0;
  let previousSegmentEnd = 0;
  for (let recordIndex = 0; recordIndex < manifest.featureCount; recordIndex += 1) {
    const base = recordIndex * PREPACKED_PROTEIN_SEARCH_FEATURE_RECORD_BYTES;
    const sourceOrdinal = records.getUint32(base + RECORD.sourceOrdinal, true);
    const sequenceOffset = records.getUint32(base + RECORD.sequenceOffset, true);
    const sequenceLength = records.getUint32(base + RECORD.sequenceLength, true);
    const segmentOffset = records.getUint32(base + RECORD.segmentOffset, true);
    const segmentCount = records.getUint32(base + RECORD.segmentCount, true);
    const strand = decodeStrand(records.getUint8(base + RECORD.strandCode));
    const leading = records.getUint8(base + RECORD.leadingFrameOffset);
    const geneticCode = records.getUint16(base + RECORD.geneticCode, true);
    if (
      sourceOrdinal <= previousSourceOrdinal ||
      sequenceOffset !== previousSequenceEnd ||
      sequenceLength === 0 ||
      sequenceOffset + sequenceLength >= manifest.sections.proteinSequences.count ||
      segmentOffset !== previousSegmentEnd ||
      segmentCount === 0 ||
      segmentOffset + segmentCount > manifest.segmentCount ||
      leading > 2 ||
      geneticCode === 0
    ) {
      throw new Error('prepacked protein search feature record is invalid');
    }
    for (const offset of [
      RECORD.labelOffset,
      RECORD.geneIdOffset,
      RECORD.transcriptIdOffset,
      RECORD.trackIdOffset,
      RECORD.canonicalIdentityOffset,
      RECORD.featureTypeOffset,
    ]) {
      const ref = recordRef(records, base, offset);
      if (ref.offset + ref.length > text.length) {
        throw new Error('prepacked protein search text reference is invalid');
      }
      readText(text, ref);
    }
    const genomicSegments = readFeatureSegments(records, segments, recordIndex);
    let nucleotideCount = 0;
    let previous: PrepackedProteinSearchGenomicSegmentV1 | undefined;
    for (const segment of genomicSegments) {
      if (
        segment.start < 0 ||
        segment.end <= segment.start ||
        segment.end > manifest.assemblyContract.assemblyLengthBp ||
        (previous &&
          (strand === 'forward' ? segment.start < previous.end : segment.end > previous.start))
      ) {
        throw new Error('prepacked protein search genomic segment is invalid');
      }
      nucleotideCount += segment.end - segment.start;
      previous = segment;
    }
    if (leading + sequenceLength * 3 > nucleotideCount) {
      throw new Error('prepacked protein search translation exceeds CDS nucleotide span');
    }
    previousSourceOrdinal = sourceOrdinal;
    previousSequenceEnd = sequenceOffset + sequenceLength + 1;
    previousSegmentEnd = segmentOffset + segmentCount;
  }
  if (
    previousSequenceEnd !== manifest.sections.proteinSequences.count ||
    previousSegmentEnd !== manifest.segmentCount
  ) {
    throw new Error('prepacked protein search planes are not completely owned');
  }
}

function buildSectionLayout(
  counts: Record<ProteinSectionKeyV1, number>
): Record<ProteinSectionKeyV1, PrepackedProteinSearchBinarySectionV1> {
  for (const count of Object.values(counts)) {
    if (!validCount(count)) throw new Error('prepacked protein search section count is invalid');
  }
  let cursor = 0;
  const featureRecords = section(cursor, counts.featureRecords, 72, 8);
  cursor = featureRecords.byteOffset + featureRecords.byteLength;
  const segments = section(cursor, counts.segments, 16, 8);
  cursor = segments.byteOffset + segments.byteLength;
  const proteinSequences = section(cursor, counts.proteinSequences, 1, 1);
  cursor = proteinSequences.byteOffset + proteinSequences.byteLength;
  const textBytes = section(cursor, counts.textBytes, 1, 1);
  return { featureRecords, segments, proteinSequences, textBytes };
}

function section(
  cursor: number,
  count: number,
  recordBytes: number,
  alignmentBytes: 1 | 8
): PrepackedProteinSearchBinarySectionV1 {
  const byteOffset = align(cursor, alignmentBytes);
  return {
    byteOffset,
    byteLength: checkedMultiply(count, recordBytes, 'protein section'),
    count,
    recordBytes,
    alignmentBytes,
  };
}

function viewsFromSections(
  sections: Record<ProteinSectionKeyV1, PrepackedProteinSearchBinarySectionV1>,
  payload: Uint8Array
): ProteinViews {
  return {
    records: new DataView(
      payload.buffer,
      payload.byteOffset + sections.featureRecords.byteOffset,
      sections.featureRecords.byteLength
    ),
    segments: new DataView(
      payload.buffer,
      payload.byteOffset + sections.segments.byteOffset,
      sections.segments.byteLength
    ),
    sequences: payload.subarray(
      sections.proteinSequences.byteOffset,
      sections.proteinSequences.byteOffset + sections.proteinSequences.byteLength
    ),
    text: payload.subarray(
      sections.textBytes.byteOffset,
      sections.textBytes.byteOffset + sections.textBytes.byteLength
    ),
  };
}

function writeRecord(view: DataView, recordIndex: number, record: PreparedRecord): void {
  const base = recordIndex * PREPACKED_PROTEIN_SEARCH_FEATURE_RECORD_BYTES;
  view.setUint32(base + RECORD.sourceOrdinal, record.sourceOrdinal, true);
  view.setUint32(base + RECORD.sequenceOffset, record.sequenceOffset, true);
  view.setUint32(base + RECORD.sequenceLength, record.sequenceLength, true);
  view.setUint32(base + RECORD.segmentOffset, record.segmentOffset, true);
  view.setUint32(base + RECORD.segmentCount, record.segmentCount, true);
  view.setUint8(base + RECORD.strandCode, record.strand === 'forward' ? 1 : 2);
  view.setUint8(base + RECORD.leadingFrameOffset, record.leadingFrameOffset);
  view.setUint16(base + RECORD.geneticCode, record.geneticCode, true);
  writeRef(view, base + RECORD.labelOffset, record.label);
  writeRef(view, base + RECORD.geneIdOffset, record.geneId);
  writeRef(view, base + RECORD.transcriptIdOffset, record.transcriptId);
  writeRef(view, base + RECORD.trackIdOffset, record.trackId);
  writeRef(view, base + RECORD.canonicalIdentityOffset, record.canonicalIdentity);
  writeRef(view, base + RECORD.featureTypeOffset, record.featureType);
}

function writeRef(view: DataView, offset: number, ref: TextRef): void {
  view.setUint32(offset, ref.offset, true);
  view.setUint32(offset + 4, ref.length, true);
}

function recordRef(view: DataView, base: number, offset: number): TextRef {
  return {
    offset: view.getUint32(base + offset, true),
    length: view.getUint32(base + offset + 4, true),
  };
}

function readText(bytes: Uint8Array, ref: TextRef): string {
  return utf8Decoder.decode(bytes.subarray(ref.offset, ref.offset + ref.length));
}

function decodeStrand(code: number): PrepackedProteinSearchStrandV1 {
  if (code === 1) return 'forward';
  if (code === 2) return 'reverse';
  throw new Error('prepacked protein search strand is invalid');
}

export function normalizePrepackedProteinSearchQuery(input: string): string | null {
  const normalized = normalizeProteinSearchQuery(input);
  return normalized.length >= PREPACKED_PROTEIN_SEARCH_MIN_QUERY_RESIDUES_V1 &&
    normalized.length <= PREPACKED_PROTEIN_SEARCH_MAX_QUERY_RESIDUES_V1 &&
    PROTEIN_QUERY_ALPHABET.test(normalized)
    ? normalized
    : null;
}

function normalizeQuery(input: string): string {
  if (typeof input !== 'string') {
    throw new Error('protein search query must be a string');
  }
  const query = normalizeProteinSearchQuery(input);
  if (query.length < PREPACKED_PROTEIN_SEARCH_MIN_QUERY_RESIDUES_V1) {
    throw new Error(
      `protein search query must contain at least ${PREPACKED_PROTEIN_SEARCH_MIN_QUERY_RESIDUES_V1} residues`
    );
  }
  if (query.length > PREPACKED_PROTEIN_SEARCH_MAX_QUERY_RESIDUES_V1) {
    throw new Error(
      `protein search query exceeds ${PREPACKED_PROTEIN_SEARCH_MAX_QUERY_RESIDUES_V1} residues`
    );
  }
  if (!PROTEIN_QUERY_ALPHABET.test(query)) {
    throw new Error('protein search query must contain canonical amino acids only');
  }
  return query;
}

function normalizeLimit(limit: number): number {
  if (!Number.isFinite(limit)) return PREPACKED_PROTEIN_SEARCH_MAX_RESULTS_V1;
  return Math.max(1, Math.min(PREPACKED_PROTEIN_SEARCH_MAX_RESULTS_V1, Math.floor(limit)));
}

function normalizeScanChunkBytes(value: number | undefined): number {
  if (value === undefined) return PREPACKED_PROTEIN_SEARCH_DEFAULT_SCAN_CHUNK_BYTES_V1;
  if (!Number.isSafeInteger(value) || value < PREPACKED_PROTEIN_SEARCH_MIN_QUERY_RESIDUES_V1) {
    throw new Error('prepacked protein search scan chunk size is invalid');
  }
  return value;
}

function searchContractMatches(contract: PrepackedProteinSearchContractV1 | undefined): boolean {
  return Boolean(
    contract &&
    Object.entries(SEARCH_CONTRACT).every(
      ([key, value]) => contract[key as keyof PrepackedProteinSearchContractV1] === value
    )
  );
}

async function readSection(
  reader: PrepackedProteinSearchRangeReaderV1,
  sectionValue: PrepackedProteinSearchBinarySectionV1
): Promise<Uint8Array> {
  const bytes = await reader.read(sectionValue.byteOffset, sectionValue.byteLength);
  if (bytes.byteLength !== sectionValue.byteLength) {
    throw new Error('prepacked protein search range reader returned a short read');
  }
  return bytes;
}

async function hashManifestContract(
  manifest: PrepackedProteinSearchIndexManifestV1,
  hash: PrepackedAnnotationSearchSha256V1
): Promise<string> {
  return hash(
    utf8.encode(
      stableStringify({
        ...manifest,
        integrity: { ...manifest.integrity, contractSha256: '' },
      })
    )
  );
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b)
  );
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(',')}}`;
}

function readSafeUint64(view: DataView, offset: number, label: string): number {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return Number(value);
}

function isSourceProteinAscii(code: number): boolean {
  return (
    code === 42 ||
    code === 88 ||
    code === 65 ||
    code === 67 ||
    code === 68 ||
    code === 69 ||
    code === 70 ||
    code === 71 ||
    code === 72 ||
    code === 73 ||
    code === 75 ||
    code === 76 ||
    code === 77 ||
    code === 78 ||
    code === 80 ||
    code === 81 ||
    code === 82 ||
    code === 83 ||
    code === 84 ||
    code === 86 ||
    code === 87 ||
    code === 89
  );
}

function checkedAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result > MAX_UINT32) {
    throw new Error(`prepacked ${label} exceeds uint32`);
  }
  return result;
}

function checkedMultiply(left: number, right: number, label: string): number {
  const result = left * right;
  if (!Number.isSafeInteger(result) || result > MAX_UINT32) {
    throw new Error(`prepacked ${label} exceeds uint32`);
  }
  return result;
}

function align(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= MAX_UINT32;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
}
