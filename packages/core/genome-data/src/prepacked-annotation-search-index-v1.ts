export const PREPACKED_ANNOTATION_SEARCH_INDEX_V1 = 'prepacked-annotation-search-index.v1' as const;
export const PREPACKED_ANNOTATION_SEARCH_FEATURE_RECORD_BYTES = 64;
export const PREPACKED_ANNOTATION_SEARCH_MAX_QUERY_CODE_UNITS_V1 = 256;
export const PREPACKED_ANNOTATION_SEARCH_MAX_RESULT_TEXT_CODE_UNITS_V1 = 256;
export const PREPACKED_ANNOTATION_SEARCH_MAX_CANONICAL_IDENTITY_CODE_UNITS_V1 = 4_096;
export const PREPACKED_ANNOTATION_SEARCH_FIELD_SEPARATOR = '|][|';
export const PREPACKED_ANNOTATION_SEARCH_CONTRACT_TOKEN =
  'annotation-search-js-lower-trim-type-values-utf16-trigram-v6-track-canonical-direction' as const;

const MAX_UINT32 = 0xffff_ffff;
const U16_BYTES = Uint16Array.BYTES_PER_ELEMENT;
const U32_BYTES = Uint32Array.BYTES_PER_ELEMENT;
const U64_BYTES = BigUint64Array.BYTES_PER_ELEMENT;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SOURCE_FINGERPRINT = /^[0-9a-f]{24}$/;
const PACK_PROGRESS_RECORD_INTERVAL = 8_192;

const RECORD = {
  sourceOrdinal: 0,
  directionCode: 4,
  startBp: 8,
  endBp: 16,
  labelOffset: 24,
  labelLength: 28,
  typeOffset: 32,
  typeLength: 36,
  trackIdOffset: 40,
  trackIdLength: 44,
  canonicalIdentityOffset: 48,
  canonicalIdentityLength: 52,
  haystackOffset: 56,
  haystackLength: 60,
} as const;

type SectionKeyV1 =
  | 'featureRecords'
  | 'textCodeUnits'
  | 'gramKeys'
  | 'postingOffsets'
  | 'postingFeatureIndices';

export interface PrepackedAnnotationSearchBinarySectionV1 {
  byteOffset: number;
  byteLength: number;
  count: number;
  recordBytes: number;
  alignmentBytes: 2 | 4 | 8;
}

export interface PrepackedAnnotationSearchDatasetContractV1 {
  datasetId: string;
  datasetVersion: string;
  sourceSha256: string;
}

export interface PrepackedAnnotationSearchAssemblyContractV1 {
  assemblyId: string;
  assemblyLengthBp: number;
  placementSignature: string;
  sourceFingerprint: string;
}

export interface PrepackedAnnotationSearchContractV1 {
  contractToken: typeof PREPACKED_ANNOTATION_SEARCH_CONTRACT_TOKEN;
  featureRecordBytes: typeof PREPACKED_ANNOTATION_SEARCH_FEATURE_RECORD_BYTES;
  textEncoding: 'utf-16le-code-units.v1';
  gramLengths: [3];
  gramKeyEncoding: 'length-and-three-utf16-code-units.u64.v1';
  fields: ['displayName', 'type', 'qualifier-values', 'attribute-values'];
  resultIdentity: ['annotationTrackId', 'canonicalIdentity'];
  resultIdentityEncoding: 'manifest-common-prefix-plus-record-suffix.v1';
  resultDirectionEncoding: 'none-0-forward-1-reverse-2.u32.v1';
  fieldSeparator: typeof PREPACKED_ANNOTATION_SEARCH_FIELD_SEPARATOR;
  queryFold: 'javascript-string-to-lower-case.v1';
  queryTrim: 'javascript-string-trim.v1';
  resultOrder: 'source-prefix-then-start-end-source-ordinal.v1';
}

export interface PrepackedAnnotationSearchIndexManifestV1 {
  schema: typeof PREPACKED_ANNOTATION_SEARCH_INDEX_V1;
  datasetContract: PrepackedAnnotationSearchDatasetContractV1;
  assemblyContract: PrepackedAnnotationSearchAssemblyContractV1;
  trackType: string;
  searchContract: PrepackedAnnotationSearchContractV1;
  canonicalIdentityPrefix: string;
  featureCount: number;
  gramCount: number;
  postingCount: number;
  sections: Record<SectionKeyV1, PrepackedAnnotationSearchBinarySectionV1>;
  byteLength: number;
  integrity: {
    algorithm: 'sha256';
    payloadSha256: string;
    contractSha256: string;
  };
}

export type PrepackedAnnotationSearchDirectionV1 = 'forward' | 'reverse' | 'none';

export interface IndexableAnnotationSearchFeatureV1 {
  sourceOrdinal?: number;
  type: string;
  annotationTrackId: string;
  canonicalIdentity: string;
  direction: PrepackedAnnotationSearchDirectionV1;
  start: number;
  end: number;
  displayName?: string;
  qualifiers?: Record<string, ReadonlyArray<string> | string | undefined>;
  attributes?: Record<string, ReadonlyArray<string> | string | undefined>;
}

export interface PackPrepackedAnnotationSearchIndexV1Input {
  datasetContract: PrepackedAnnotationSearchDatasetContractV1;
  assemblyContract: PrepackedAnnotationSearchAssemblyContractV1;
  trackType: string;
  features: ReadonlyArray<IndexableAnnotationSearchFeatureV1>;
  payloadSha256?: PrepackedAnnotationSearchSha256V1;
  onProgress?: (progress: PrepackedAnnotationSearchPackProgressV1) => void;
}

export interface PrepackedAnnotationSearchPackProgressV1 {
  readonly phase:
    | 'validating-features'
    | 'building-postings'
    | 'writing-records'
    | 'writing-text'
    | 'writing-postings'
    | 'hashing-payload'
    | 'validating-payload-records'
    | 'validating-payload-grams'
    | 'validating-payload-postings'
    | 'validating-payload-completeness';
  readonly completed: number;
  readonly total: number;
}

export type PrepackedAnnotationSearchSha256V1 = (bytes: Uint8Array) => Promise<string>;

export interface PackedPrepackedAnnotationSearchIndexV1 {
  manifest: PrepackedAnnotationSearchIndexManifestV1;
  payload: Uint8Array;
  packWork: {
    featureCount: number;
    textCodeUnitCount: number;
    canonicalIdentityPrefixCodeUnitCount: number;
    canonicalIdentitySuffixCodeUnitCount: number;
    gramCount: number;
    postingCount: number;
    byteLength: number;
  };
}

export interface PrepackedAnnotationSearchMatchV1 {
  featureIndex: number;
  start: number;
  end: number;
  label: string;
  featureType: string;
  annotationTrackId: string;
  canonicalIdentity: string;
  direction: PrepackedAnnotationSearchDirectionV1;
}

export interface PrepackedAnnotationSearchIndexViewV1 {
  schema: typeof PREPACKED_ANNOTATION_SEARCH_INDEX_V1;
  manifest: PrepackedAnnotationSearchIndexManifestV1;
  payload: Uint8Array;
  size: number;
  featureRecords: DataView;
  textCodeUnits: Uint16Array;
  gramKeys: BigUint64Array;
  postingOffsets: Uint32Array;
  postingFeatureIndices: Uint32Array;
  query(input: string, limit?: number): PrepackedAnnotationSearchMatchV1[];
}

export interface PrepackedSearchResultIdentityV1 {
  readonly annotationTrackId: string;
  readonly canonicalIdentity: string;
}

export type PrepackedSearchResultIdentityVisitorV1 = (
  identity: PrepackedSearchResultIdentityV1,
  recordIndex: number
) => void;

export interface PrepackedAnnotationSearchValidationWorkV1 {
  featureRecordsScanned: number;
  gramKeysScanned: number;
  postingsScanned: number;
  expectedPostingsVerified: number;
}

export interface PrepackedAnnotationSearchRangeReaderV1 {
  readonly byteLength: number;
  read(byteOffset: number, byteLength: number): Promise<Uint8Array>;
}

export interface PrepackedAnnotationSearchRangeIndexV1 {
  readonly schema: typeof PREPACKED_ANNOTATION_SEARCH_INDEX_V1;
  readonly manifest: PrepackedAnnotationSearchIndexManifestV1;
  readonly size: number;
  query(
    input: string,
    limit?: number,
    options?: PrepackedAnnotationSearchQueryOptionsV1
  ): Promise<PrepackedAnnotationSearchMatchV1[]>;
}

export interface PrepackedAnnotationSearchQueryOptionsV1 {
  readonly signal?: AbortSignal;
}

interface TextRef {
  offset: number;
  length: number;
}

interface PreparedFeatureRecord {
  sourceOrdinal: number;
  direction: PrepackedAnnotationSearchDirectionV1;
  start: number;
  end: number;
  label: TextRef;
  type: TextRef;
  trackId: TextRef;
  canonicalIdentity: TextRef;
  haystack: TextRef;
}

interface PreparedViews {
  featureRecords: DataView;
  textCodeUnits: Uint16Array;
  gramKeys: BigUint64Array;
  postingOffsets: Uint32Array;
  postingFeatureIndices: Uint32Array;
}

const SECTION_DEFINITIONS: ReadonlyArray<{
  key: SectionKeyV1;
  recordBytes: number;
  alignmentBytes: 2 | 4 | 8;
}> = [
  {
    key: 'featureRecords',
    recordBytes: PREPACKED_ANNOTATION_SEARCH_FEATURE_RECORD_BYTES,
    alignmentBytes: 8,
  },
  { key: 'textCodeUnits', recordBytes: U16_BYTES, alignmentBytes: 2 },
  { key: 'gramKeys', recordBytes: U64_BYTES, alignmentBytes: 8 },
  { key: 'postingOffsets', recordBytes: U32_BYTES, alignmentBytes: 4 },
  { key: 'postingFeatureIndices', recordBytes: U32_BYTES, alignmentBytes: 4 },
];

const SEARCH_CONTRACT: PrepackedAnnotationSearchContractV1 = {
  contractToken: PREPACKED_ANNOTATION_SEARCH_CONTRACT_TOKEN,
  featureRecordBytes: PREPACKED_ANNOTATION_SEARCH_FEATURE_RECORD_BYTES,
  textEncoding: 'utf-16le-code-units.v1',
  gramLengths: [3],
  gramKeyEncoding: 'length-and-three-utf16-code-units.u64.v1',
  fields: ['displayName', 'type', 'qualifier-values', 'attribute-values'],
  resultIdentity: ['annotationTrackId', 'canonicalIdentity'],
  resultIdentityEncoding: 'manifest-common-prefix-plus-record-suffix.v1',
  resultDirectionEncoding: 'none-0-forward-1-reverse-2.u32.v1',
  fieldSeparator: PREPACKED_ANNOTATION_SEARCH_FIELD_SEPARATOR,
  queryFold: 'javascript-string-to-lower-case.v1',
  queryTrim: 'javascript-string-trim.v1',
  resultOrder: 'source-prefix-then-start-end-source-ordinal.v1',
};

export async function packPrepackedAnnotationSearchIndexV1(
  input: PackPrepackedAnnotationSearchIndexV1Input
): Promise<PackedPrepackedAnnotationSearchIndexV1> {
  validatePackMetadata(input);
  if (input.features.length > MAX_UINT32) {
    throw new Error('prepacked annotation search feature count exceeds uint32');
  }

  let previousSourceOrdinal = -1;
  emitPackProgress(input.onProgress, 'validating-features', 0, input.features.length);
  for (let recordIndex = 0; recordIndex < input.features.length; recordIndex += 1) {
    const feature = input.features[recordIndex];
    const sourceOrdinal = feature.sourceOrdinal ?? recordIndex;
    validateFeatureInput(feature, sourceOrdinal, previousSourceOrdinal, input.assemblyContract);
    previousSourceOrdinal = sourceOrdinal;
    emitPackProgress(
      input.onProgress,
      'validating-features',
      recordIndex + 1,
      input.features.length
    );
  }
  const canonicalIdentityPrefix = commonCanonicalIdentityPrefix(input.features);

  const textChunks: Uint16Array[] = [];
  let textCodeUnitCount = 0;
  let canonicalIdentitySuffixCodeUnitCount = 0;
  const appendText = (value: string, label: string): TextRef => {
    const units = stringCodeUnits(value);
    if (textCodeUnitCount + units.length > MAX_UINT32) {
      throw new Error(`prepacked annotation search ${label} text exceeds uint32`);
    }
    const ref = { offset: textCodeUnitCount, length: units.length };
    textChunks.push(units);
    textCodeUnitCount += units.length;
    return ref;
  };

  const records: PreparedFeatureRecord[] = new Array(input.features.length);
  const haystacks: string[] = new Array(input.features.length);
  const grams = new TrigramIdTable();
  let gramCounts = new Uint32Array(4_096);
  let gramStamps = new Int32Array(4_096).fill(-1);
  emitPackProgress(input.onProgress, 'building-postings', 0, input.features.length);
  for (let recordIndex = 0; recordIndex < input.features.length; recordIndex += 1) {
    const feature = input.features[recordIndex];
    const sourceOrdinal = feature.sourceOrdinal ?? recordIndex;
    const haystack = buildAnnotationSearchHaystackV1(feature);
    const primaryLabel = feature.displayName || firstQualifierValue(feature) || feature.type;
    const canonicalIdentitySuffix = feature.canonicalIdentity.slice(canonicalIdentityPrefix.length);
    canonicalIdentitySuffixCodeUnitCount = checkedAdd(
      canonicalIdentitySuffixCodeUnitCount,
      canonicalIdentitySuffix.length,
      'canonical identity suffix text'
    );
    records[recordIndex] = {
      sourceOrdinal,
      direction: feature.direction,
      start: feature.start,
      end: feature.end,
      label: appendText(primaryLabel, 'label'),
      type: appendText(feature.type, 'type'),
      trackId: appendText(feature.annotationTrackId, 'annotation track id'),
      canonicalIdentity: appendText(canonicalIdentitySuffix, 'canonical identity suffix'),
      haystack: appendText(haystack, 'haystack'),
    };
    haystacks[recordIndex] = haystack;
    for (let offset = 0; offset + 3 <= haystack.length; offset += 1) {
      const id = grams.idOf(
        haystack.charCodeAt(offset),
        haystack.charCodeAt(offset + 1),
        haystack.charCodeAt(offset + 2),
        true
      );
      if (id >= gramCounts.length) {
        gramCounts = grownUint32(gramCounts);
        gramStamps = grownStamps(gramStamps);
      }
      if (gramStamps[id] !== recordIndex) {
        gramStamps[id] = recordIndex;
        gramCounts[id] += 1;
      }
    }
    emitPackProgress(input.onProgress, 'building-postings', recordIndex + 1, input.features.length);
  }

  const gramOrder = Array.from({ length: grams.keys.length }, (_, id) => id).sort(
    (left, right) => grams.keys[left] - grams.keys[right]
  );
  if (gramOrder.length > MAX_UINT32) {
    throw new Error('prepacked annotation search gram count exceeds uint32');
  }
  const gramFill = new Float64Array(grams.keys.length);
  let postingCount = 0;
  for (const id of gramOrder) {
    gramFill[id] = postingCount;
    postingCount = checkedAdd(postingCount, gramCounts[id], 'posting count');
  }
  const postingFeatureIndices = new Uint32Array(postingCount);
  gramStamps.fill(-1);
  for (let recordIndex = 0; recordIndex < haystacks.length; recordIndex += 1) {
    const haystack = haystacks[recordIndex];
    for (let offset = 0; offset + 3 <= haystack.length; offset += 1) {
      const id = grams.idOf(
        haystack.charCodeAt(offset),
        haystack.charCodeAt(offset + 1),
        haystack.charCodeAt(offset + 2),
        false
      );
      if (gramStamps[id] !== recordIndex) {
        gramStamps[id] = recordIndex;
        postingFeatureIndices[gramFill[id]] = recordIndex;
        gramFill[id] += 1;
      }
    }
  }

  const counts: Record<SectionKeyV1, number> = {
    featureRecords: records.length,
    textCodeUnits: textCodeUnitCount,
    gramKeys: gramOrder.length,
    postingOffsets: gramOrder.length + 1,
    postingFeatureIndices: postingCount,
  };
  const layout = buildSectionLayout(counts);
  const payload = new Uint8Array(layout.byteLength);
  const views = prepareViewsFromSections(layout.sections, payload);

  emitPackProgress(input.onProgress, 'writing-records', 0, records.length);
  for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
    writeFeatureRecord(views.featureRecords, recordIndex, records[recordIndex]);
    emitPackProgress(input.onProgress, 'writing-records', recordIndex + 1, records.length);
  }
  let textCursor = 0;
  emitPackProgress(input.onProgress, 'writing-text', 0, textChunks.length);
  for (let chunkIndex = 0; chunkIndex < textChunks.length; chunkIndex += 1) {
    const chunk = textChunks[chunkIndex];
    views.textCodeUnits.set(chunk, textCursor);
    textCursor += chunk.length;
    emitPackProgress(input.onProgress, 'writing-text', chunkIndex + 1, textChunks.length);
  }
  let postingCursor = 0;
  views.postingOffsets[0] = 0;
  views.postingFeatureIndices.set(postingFeatureIndices);
  emitPackProgress(input.onProgress, 'writing-postings', 0, gramOrder.length);
  for (let gramIndex = 0; gramIndex < gramOrder.length; gramIndex += 1) {
    const id = gramOrder[gramIndex];
    views.gramKeys[gramIndex] = BigInt(grams.keys[id]);
    postingCursor += gramCounts[id];
    views.postingOffsets[gramIndex + 1] = postingCursor;
    emitPackProgress(input.onProgress, 'writing-postings', gramIndex + 1, gramOrder.length);
  }

  const manifest: PrepackedAnnotationSearchIndexManifestV1 = {
    schema: PREPACKED_ANNOTATION_SEARCH_INDEX_V1,
    datasetContract: { ...input.datasetContract },
    assemblyContract: { ...input.assemblyContract },
    trackType: input.trackType,
    searchContract: {
      ...SEARCH_CONTRACT,
      gramLengths: [...SEARCH_CONTRACT.gramLengths],
      fields: [...SEARCH_CONTRACT.fields],
      resultIdentity: [...SEARCH_CONTRACT.resultIdentity],
    },
    canonicalIdentityPrefix,
    featureCount: records.length,
    gramCount: gramOrder.length,
    postingCount,
    sections: layout.sections,
    byteLength: payload.byteLength,
    integrity: { algorithm: 'sha256', payloadSha256: '', contractSha256: '' },
  };
  const hash = input.payloadSha256 ?? sha256Hex;
  emitPackProgress(input.onProgress, 'hashing-payload', 0, 1);
  manifest.integrity.payloadSha256 = await hash(payload);
  manifest.integrity.contractSha256 = await hashContract(manifest);
  emitPackProgress(input.onProgress, 'hashing-payload', 1, 1);

  validatePayloadSemantics(manifest, views, input.onProgress);
  return {
    manifest,
    payload,
    packWork: {
      featureCount: records.length,
      textCodeUnitCount,
      canonicalIdentityPrefixCodeUnitCount: canonicalIdentityPrefix.length,
      canonicalIdentitySuffixCodeUnitCount,
      gramCount: gramOrder.length,
      postingCount,
      byteLength: payload.byteLength,
    },
  };
}

export async function validatePrepackedAnnotationSearchIndexV1(
  manifest: PrepackedAnnotationSearchIndexManifestV1,
  payload: Uint8Array,
  payloadSha256: PrepackedAnnotationSearchSha256V1 = sha256Hex
): Promise<PrepackedAnnotationSearchValidationWorkV1> {
  validateManifestStructure(manifest, payload);
  if ((await payloadSha256(payload)) !== manifest.integrity.payloadSha256) {
    throw new Error('prepacked annotation search payload sha256 mismatch');
  }
  if ((await hashContract(manifest)) !== manifest.integrity.contractSha256) {
    throw new Error('prepacked annotation search contract sha256 mismatch');
  }
  return validatePayloadSemantics(manifest, prepareViews(manifest, payload));
}

export async function unpackPrepackedAnnotationSearchIndexV1(
  manifest: PrepackedAnnotationSearchIndexManifestV1,
  payload: Uint8Array,
  payloadSha256: PrepackedAnnotationSearchSha256V1 = sha256Hex
): Promise<PrepackedAnnotationSearchIndexViewV1> {
  await validatePrepackedAnnotationSearchIndexV1(manifest, payload, payloadSha256);
  return createIndexView(manifest, payload);
}

export function visitPrepackedAnnotationSearchResultIdentitiesV1(
  index: PrepackedAnnotationSearchIndexViewV1,
  visitor: PrepackedSearchResultIdentityVisitorV1
): void {
  for (let recordIndex = 0; recordIndex < index.manifest.featureCount; recordIndex += 1) {
    const trackId = recordTextRef(index.featureRecords, recordIndex, RECORD.trackIdOffset);
    const canonicalIdentitySuffix = recordTextRef(
      index.featureRecords,
      recordIndex,
      RECORD.canonicalIdentityOffset
    );
    visitor(
      {
        annotationTrackId: decodeCodeUnitsBounded(
          index.textCodeUnits,
          trackId,
          PREPACKED_ANNOTATION_SEARCH_MAX_RESULT_TEXT_CODE_UNITS_V1
        ),
        canonicalIdentity:
          index.manifest.canonicalIdentityPrefix +
          decodeCodeUnitsBounded(
            index.textCodeUnits,
            canonicalIdentitySuffix,
            PREPACKED_ANNOTATION_SEARCH_MAX_CANONICAL_IDENTITY_CODE_UNITS_V1 -
              index.manifest.canonicalIdentityPrefix.length
          ),
      },
      recordIndex
    );
  }
}

export async function openRangeReadablePrepackedAnnotationSearchIndexV1(
  manifest: PrepackedAnnotationSearchIndexManifestV1,
  reader: PrepackedAnnotationSearchRangeReaderV1
): Promise<PrepackedAnnotationSearchRangeIndexV1> {
  validateManifestLayout(manifest, reader.byteLength, 0);
  if ((await hashContract(manifest)) !== manifest.integrity.contractSha256) {
    throw new Error('prepacked annotation search contract sha256 mismatch');
  }
  await validateRangePadding(manifest, reader);

  const [keys, offsets] = await Promise.allSettled([
    readExactRange(reader, manifest.sections.gramKeys),
    readExactRange(reader, manifest.sections.postingOffsets),
  ]);
  if (keys.status === 'rejected') throw keys.reason;
  if (offsets.status === 'rejected') throw offsets.reason;
  const gramKeys = bigUint64ArrayFromOwnedBytes(keys.value);
  const postingOffsets = uint32ArrayFromOwnedBytes(offsets.value);
  validateRangeDirectoryV1(manifest, gramKeys, postingOffsets);
  const postings = new PagedUint32PlaneV1(reader, manifest.sections.postingFeatureIndices);
  const records = new PagedFeatureRecordPlaneV1(reader, manifest.sections.featureRecords);
  const text = new PagedTextPlaneV1(reader, manifest.sections.textCodeUnits);

  return {
    schema: PREPACKED_ANNOTATION_SEARCH_INDEX_V1,
    manifest,
    size: manifest.featureCount,
    query(input: string, limit = 200, options?: PrepackedAnnotationSearchQueryOptionsV1) {
      return queryRangeReadableIndexV1(
        manifest,
        gramKeys,
        postingOffsets,
        postings,
        records,
        text,
        input,
        limit,
        options
      );
    },
  };
}

function createIndexView(
  manifest: PrepackedAnnotationSearchIndexManifestV1,
  payload: Uint8Array
): PrepackedAnnotationSearchIndexViewV1 {
  const views = prepareViews(manifest, payload);
  const index: PrepackedAnnotationSearchIndexViewV1 = {
    schema: PREPACKED_ANNOTATION_SEARCH_INDEX_V1,
    manifest,
    payload,
    size: manifest.featureCount,
    ...views,
    query(input: string, limit = 200): PrepackedAnnotationSearchMatchV1[] {
      return queryPreparedIndex(manifest, views, input, limit);
    },
  };
  return index;
}

export function buildAnnotationSearchHaystackV1(
  feature: IndexableAnnotationSearchFeatureV1
): string {
  const parts: string[] = [];
  if (feature.displayName) parts.push(feature.displayName.toLowerCase());
  if (feature.type) parts.push(feature.type.toLowerCase());
  collectFieldValues(feature.qualifiers, parts);
  collectFieldValues(feature.attributes, parts);
  return parts.join(PREPACKED_ANNOTATION_SEARCH_FIELD_SEPARATOR);
}

function collectFieldValues(
  source: Record<string, ReadonlyArray<string> | string | undefined> | undefined,
  out: string[]
): void {
  if (!source) return;
  for (const value of Object.values(source)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === 'string' && entry.length > 0) out.push(entry.toLowerCase());
      }
    } else if (typeof value === 'string' && value.length > 0) {
      out.push(value.toLowerCase());
    }
  }
}

function firstQualifierValue(feature: IndexableAnnotationSearchFeatureV1): string {
  return firstString(feature.qualifiers) ?? firstString(feature.attributes) ?? '';
}

function firstString(
  source: Record<string, ReadonlyArray<string> | string | undefined> | undefined
): string | null {
  if (!source) return null;
  for (const value of Object.values(source)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === 'string' && entry.length > 0) return entry;
      }
    } else if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return null;
}

function validatePackMetadata(input: PackPrepackedAnnotationSearchIndexV1Input): void {
  if (
    !nonemptyContractString(input?.datasetContract?.datasetId) ||
    !nonemptyContractString(input.datasetContract.datasetVersion) ||
    !SHA256_HEX.test(input.datasetContract.sourceSha256) ||
    !nonemptyContractString(input?.assemblyContract?.assemblyId) ||
    !Number.isSafeInteger(input.assemblyContract.assemblyLengthBp) ||
    input.assemblyContract.assemblyLengthBp <= 0 ||
    !nonemptyContractString(input.assemblyContract.placementSignature) ||
    !SOURCE_FINGERPRINT.test(input.assemblyContract.sourceFingerprint) ||
    !nonemptyContractString(input.trackType) ||
    !Array.isArray(input.features)
  ) {
    throw new Error('prepacked annotation search pack contract is invalid');
  }
}

function validateFeatureInput(
  feature: IndexableAnnotationSearchFeatureV1,
  sourceOrdinal: number,
  previousSourceOrdinal: number,
  assembly: PrepackedAnnotationSearchAssemblyContractV1
): void {
  if (
    !feature ||
    typeof feature.type !== 'string' ||
    !isAnnotationSearchDirectionV1(feature.direction) ||
    !nonemptyContractString(feature.annotationTrackId) ||
    !nonemptyContractString(feature.canonicalIdentity) ||
    !hasWellFormedUtf16(feature.canonicalIdentity) ||
    feature.annotationTrackId.length > PREPACKED_ANNOTATION_SEARCH_MAX_RESULT_TEXT_CODE_UNITS_V1 ||
    feature.canonicalIdentity.length >
      PREPACKED_ANNOTATION_SEARCH_MAX_CANONICAL_IDENTITY_CODE_UNITS_V1 ||
    (feature.displayName !== undefined && typeof feature.displayName !== 'string') ||
    !Number.isInteger(sourceOrdinal) ||
    sourceOrdinal < 0 ||
    sourceOrdinal > MAX_UINT32 ||
    sourceOrdinal <= previousSourceOrdinal ||
    !Number.isSafeInteger(feature.start) ||
    !Number.isSafeInteger(feature.end) ||
    feature.start < 0 ||
    feature.end <= feature.start ||
    feature.end > assembly.assemblyLengthBp
  ) {
    throw new Error('prepacked annotation search feature input is invalid');
  }
}

function isAnnotationSearchDirectionV1(
  value: unknown
): value is PrepackedAnnotationSearchDirectionV1 {
  return value === 'forward' || value === 'reverse' || value === 'none';
}

function encodeDirectionV1(direction: PrepackedAnnotationSearchDirectionV1): number {
  switch (direction) {
    case 'none':
      return 0;
    case 'forward':
      return 1;
    case 'reverse':
      return 2;
  }
}

function isDirectionCodeV1(code: number): boolean {
  return code === 0 || code === 1 || code === 2;
}

function decodeDirectionV1(code: number): PrepackedAnnotationSearchDirectionV1 {
  switch (code) {
    case 0:
      return 'none';
    case 1:
      return 'forward';
    case 2:
      return 'reverse';
    default:
      throw new Error('prepacked annotation search feature direction is invalid');
  }
}

function commonCanonicalIdentityPrefix(
  features: ReadonlyArray<IndexableAnnotationSearchFeatureV1>
): string {
  if (features.length === 0) return '';
  const first = features[0].canonicalIdentity;
  let prefixLength = first.length;
  for (
    let featureIndex = 1;
    featureIndex < features.length && prefixLength > 0;
    featureIndex += 1
  ) {
    const candidate = features[featureIndex].canonicalIdentity;
    prefixLength = Math.min(prefixLength, candidate.length);
    let offset = 0;
    while (offset < prefixLength && first.charCodeAt(offset) === candidate.charCodeAt(offset)) {
      offset += 1;
    }
    prefixLength = offset;
  }
  if (prefixLength > 0 && isHighSurrogate(first.charCodeAt(prefixLength - 1))) {
    prefixLength -= 1;
  }
  return first.slice(0, prefixLength);
}

const GRAM3_KEY_TAG = 3 * 2 ** 48;

class TrigramIdTable {
  private readonly ascii = new Int32Array(1 << 21).fill(-1);
  private readonly other = new Map<number, number>();
  readonly keys: number[] = [];

  idOf(first: number, second: number, third: number, add: boolean): number {
    if ((first | second | third) < 128) {
      const slot = (first << 14) | (second << 7) | third;
      let id = this.ascii[slot];
      if (id < 0 && add) {
        id = this.keys.length;
        this.ascii[slot] = id;
        this.keys.push(GRAM3_KEY_TAG + first * 2 ** 32 + second * 2 ** 16 + third);
      }
      return id;
    }
    const key = GRAM3_KEY_TAG + first * 2 ** 32 + second * 2 ** 16 + third;
    let id = this.other.get(key);
    if (id === undefined) {
      if (!add) return -1;
      id = this.keys.length;
      this.other.set(key, id);
      this.keys.push(key);
    }
    return id;
  }

  define(key: number, id: number): void {
    const first = Math.floor(key / 2 ** 32) & 0xffff;
    const second = Math.floor(key / 2 ** 16) & 0xffff;
    const third = key & 0xffff;
    if (
      (first | second | third) < 128 &&
      key - (first * 2 ** 32 + second * 2 ** 16 + third) === GRAM3_KEY_TAG
    ) {
      this.ascii[(first << 14) | (second << 7) | third] = id;
    } else {
      this.other.set(key, id);
    }
  }
}

function grownUint32(values: Uint32Array): Uint32Array {
  const grown = new Uint32Array(values.length * 2);
  grown.set(values);
  return grown;
}

function grownStamps(values: Int32Array): Int32Array {
  const grown = new Int32Array(values.length * 2).fill(-1);
  grown.set(values);
  return grown;
}

function gramKeyAt(value: string, offset: number, length: 2 | 3): bigint {
  return gramKey(
    length,
    value.charCodeAt(offset),
    value.charCodeAt(offset + 1),
    length === 3 ? value.charCodeAt(offset + 2) : 0
  );
}

function gramKey(length: 2 | 3, first: number, second: number, third: number): bigint {
  return (BigInt(length) << 48n) | (BigInt(first) << 32n) | (BigInt(second) << 16n) | BigInt(third);
}

function decodeGramKey(key: bigint): {
  length: number;
  first: number;
  second: number;
  third: number;
} {
  return {
    length: Number((key >> 48n) & 0xffn),
    first: Number((key >> 32n) & 0xffffn),
    second: Number((key >> 16n) & 0xffffn),
    third: Number(key & 0xffffn),
  };
}

function buildSectionLayout(counts: Record<SectionKeyV1, number>): {
  sections: Record<SectionKeyV1, PrepackedAnnotationSearchBinarySectionV1>;
  byteLength: number;
} {
  const sections = {} as Record<SectionKeyV1, PrepackedAnnotationSearchBinarySectionV1>;
  let cursor = 0;
  for (const definition of SECTION_DEFINITIONS) {
    cursor = align(cursor, definition.alignmentBytes);
    const count = counts[definition.key];
    const byteLength = checkedMultiply(count, definition.recordBytes, definition.key);
    sections[definition.key] = {
      byteOffset: cursor,
      byteLength,
      count,
      recordBytes: definition.recordBytes,
      alignmentBytes: definition.alignmentBytes,
    };
    cursor = checkedAdd(cursor, byteLength, definition.key);
  }
  return { sections, byteLength: cursor };
}

function writeFeatureRecord(
  view: DataView,
  recordIndex: number,
  record: PreparedFeatureRecord
): void {
  const offset = recordIndex * PREPACKED_ANNOTATION_SEARCH_FEATURE_RECORD_BYTES;
  view.setUint32(offset + RECORD.sourceOrdinal, record.sourceOrdinal, true);
  view.setUint32(offset + RECORD.directionCode, encodeDirectionV1(record.direction), true);
  view.setBigUint64(offset + RECORD.startBp, BigInt(record.start), true);
  view.setBigUint64(offset + RECORD.endBp, BigInt(record.end), true);
  writeTextRef(view, offset + RECORD.labelOffset, record.label);
  writeTextRef(view, offset + RECORD.typeOffset, record.type);
  writeTextRef(view, offset + RECORD.trackIdOffset, record.trackId);
  writeTextRef(view, offset + RECORD.canonicalIdentityOffset, record.canonicalIdentity);
  writeTextRef(view, offset + RECORD.haystackOffset, record.haystack);
}

function writeTextRef(view: DataView, offset: number, ref: TextRef): void {
  view.setUint32(offset, ref.offset, true);
  view.setUint32(offset + U32_BYTES, ref.length, true);
}

function validateManifestStructure(
  manifest: PrepackedAnnotationSearchIndexManifestV1,
  payload: Uint8Array
): void {
  validateManifestLayout(manifest, payload.byteLength, payload.byteOffset);
  let cursor = 0;
  for (const definition of SECTION_DEFINITIONS) {
    const previousCursor = cursor;
    cursor = align(cursor, definition.alignmentBytes);
    for (let padding = previousCursor; padding < cursor; padding += 1) {
      if (payload[padding] !== 0) {
        throw new Error('prepacked annotation search section padding is not zero');
      }
    }
    cursor += manifest.sections[definition.key].byteLength;
  }
}

function validateManifestLayout(
  manifest: PrepackedAnnotationSearchIndexManifestV1,
  payloadByteLength: number,
  payloadByteOffset: number
): void {
  if (
    manifest?.schema !== PREPACKED_ANNOTATION_SEARCH_INDEX_V1 ||
    !nonemptyContractString(manifest.datasetContract?.datasetId) ||
    !nonemptyContractString(manifest.datasetContract?.datasetVersion) ||
    !SHA256_HEX.test(manifest.datasetContract?.sourceSha256 ?? '') ||
    !nonemptyContractString(manifest.assemblyContract?.assemblyId) ||
    !Number.isSafeInteger(manifest.assemblyContract?.assemblyLengthBp) ||
    manifest.assemblyContract.assemblyLengthBp <= 0 ||
    !nonemptyContractString(manifest.assemblyContract?.placementSignature) ||
    !SOURCE_FINGERPRINT.test(manifest.assemblyContract?.sourceFingerprint ?? '') ||
    !nonemptyContractString(manifest.trackType) ||
    !searchContractMatches(manifest.searchContract) ||
    !validCanonicalIdentityPrefix(manifest.canonicalIdentityPrefix) ||
    !validCount(manifest.featureCount) ||
    !validCount(manifest.gramCount) ||
    !validCount(manifest.postingCount) ||
    manifest.integrity?.algorithm !== 'sha256' ||
    !SHA256_HEX.test(manifest.integrity.payloadSha256) ||
    !SHA256_HEX.test(manifest.integrity.contractSha256)
  ) {
    throw new Error('prepacked annotation search manifest contract is invalid');
  }

  let cursor = 0;
  for (const definition of SECTION_DEFINITIONS) {
    cursor = align(cursor, definition.alignmentBytes);
    const section = manifest.sections?.[definition.key];
    if (
      !section ||
      section.byteOffset !== cursor ||
      section.recordBytes !== definition.recordBytes ||
      section.alignmentBytes !== definition.alignmentBytes ||
      !validCount(section.count) ||
      section.byteLength !== checkedMultiply(section.count, section.recordBytes, definition.key) ||
      (payloadByteOffset + section.byteOffset) % definition.alignmentBytes !== 0
    ) {
      throw new Error('prepacked annotation search sections are not exact and aligned');
    }
    cursor += section.byteLength;
  }
  const sections = manifest.sections;
  if (
    cursor !== manifest.byteLength ||
    payloadByteLength !== manifest.byteLength ||
    sections.featureRecords.count !== manifest.featureCount ||
    sections.gramKeys.count !== manifest.gramCount ||
    sections.postingOffsets.count !== manifest.gramCount + 1 ||
    sections.postingFeatureIndices.count !== manifest.postingCount
  ) {
    throw new Error('prepacked annotation search section counts are inconsistent');
  }
}

function searchContractMatches(contract: PrepackedAnnotationSearchContractV1 | undefined): boolean {
  return Boolean(
    contract &&
    contract.contractToken === SEARCH_CONTRACT.contractToken &&
    contract.featureRecordBytes === SEARCH_CONTRACT.featureRecordBytes &&
    contract.textEncoding === SEARCH_CONTRACT.textEncoding &&
    sameArray(contract.gramLengths, SEARCH_CONTRACT.gramLengths) &&
    contract.gramKeyEncoding === SEARCH_CONTRACT.gramKeyEncoding &&
    sameArray(contract.fields, SEARCH_CONTRACT.fields) &&
    sameArray(contract.resultIdentity, SEARCH_CONTRACT.resultIdentity) &&
    contract.resultIdentityEncoding === SEARCH_CONTRACT.resultIdentityEncoding &&
    contract.resultDirectionEncoding === SEARCH_CONTRACT.resultDirectionEncoding &&
    contract.fieldSeparator === SEARCH_CONTRACT.fieldSeparator &&
    contract.queryFold === SEARCH_CONTRACT.queryFold &&
    contract.queryTrim === SEARCH_CONTRACT.queryTrim &&
    contract.resultOrder === SEARCH_CONTRACT.resultOrder
  );
}

function sameArray(left: readonly unknown[] | undefined, right: readonly unknown[]): boolean {
  return Boolean(
    left && left.length === right.length && left.every((value, index) => value === right[index])
  );
}

function validatePayloadSemantics(
  manifest: PrepackedAnnotationSearchIndexManifestV1,
  views: PreparedViews,
  onProgress?: (progress: PrepackedAnnotationSearchPackProgressV1) => void
): PrepackedAnnotationSearchValidationWorkV1 {
  let previousSourceOrdinal = -1;
  emitPackProgress(onProgress, 'validating-payload-records', 0, manifest.featureCount);
  for (let recordIndex = 0; recordIndex < manifest.featureCount; recordIndex += 1) {
    const base = recordIndex * PREPACKED_ANNOTATION_SEARCH_FEATURE_RECORD_BYTES;
    const sourceOrdinal = views.featureRecords.getUint32(base + RECORD.sourceOrdinal, true);
    const directionCode = views.featureRecords.getUint32(base + RECORD.directionCode, true);
    const start = readSafeUint64(views.featureRecords, base + RECORD.startBp, 'feature start');
    const end = readSafeUint64(views.featureRecords, base + RECORD.endBp, 'feature end');
    if (
      !isDirectionCodeV1(directionCode) ||
      sourceOrdinal <= previousSourceOrdinal ||
      start < 0 ||
      end <= start ||
      end > manifest.assemblyContract.assemblyLengthBp
    ) {
      throw new Error('prepacked annotation search feature record is invalid');
    }
    previousSourceOrdinal = sourceOrdinal;
    validateTextRef(views.featureRecords, base + RECORD.labelOffset, views.textCodeUnits.length);
    validateTextRef(views.featureRecords, base + RECORD.typeOffset, views.textCodeUnits.length);
    validateTextRef(views.featureRecords, base + RECORD.trackIdOffset, views.textCodeUnits.length);
    validateTextRef(
      views.featureRecords,
      base + RECORD.canonicalIdentityOffset,
      views.textCodeUnits.length
    );
    const annotationTrackId = recordTextRef(
      views.featureRecords,
      recordIndex,
      RECORD.trackIdOffset
    );
    const canonicalIdentitySuffix = recordTextRef(
      views.featureRecords,
      recordIndex,
      RECORD.canonicalIdentityOffset
    );
    if (
      !validResultIdentityTextRef(annotationTrackId) ||
      !validCanonicalIdentitySuffixTextRef(
        canonicalIdentitySuffix,
        manifest.canonicalIdentityPrefix
      )
    ) {
      throw new Error('prepacked annotation search result identity is invalid');
    }
    validateTextRef(views.featureRecords, base + RECORD.haystackOffset, views.textCodeUnits.length);
    emitPackProgress(
      onProgress,
      'validating-payload-records',
      recordIndex + 1,
      manifest.featureCount
    );
  }

  let previousKey = -1n;
  emitPackProgress(onProgress, 'validating-payload-grams', 0, views.gramKeys.length);
  for (let gramIndex = 0; gramIndex < views.gramKeys.length; gramIndex += 1) {
    const key = views.gramKeys[gramIndex];
    const decoded = decodeGramKey(key);
    if (key <= previousKey || decoded.length !== 3) {
      throw new Error('prepacked annotation search gram key is invalid');
    }
    previousKey = key;
    emitPackProgress(onProgress, 'validating-payload-grams', gramIndex + 1, views.gramKeys.length);
  }
  if (
    views.postingOffsets.length !== views.gramKeys.length + 1 ||
    views.postingOffsets[0] !== 0 ||
    views.postingOffsets[views.postingOffsets.length - 1] !== views.postingFeatureIndices.length
  ) {
    throw new Error('prepacked annotation search posting offsets are invalid');
  }
  emitPackProgress(onProgress, 'validating-payload-postings', 0, views.gramKeys.length);
  for (let gramIndex = 0; gramIndex < views.gramKeys.length; gramIndex += 1) {
    const start = views.postingOffsets[gramIndex];
    const end = views.postingOffsets[gramIndex + 1];
    if (end <= start) {
      throw new Error('prepacked annotation search posting list is empty or reversed');
    }
    let previousFeatureIndex = -1;
    for (let cursor = start; cursor < end; cursor += 1) {
      const featureIndex = views.postingFeatureIndices[cursor];
      if (featureIndex >= manifest.featureCount || featureIndex <= previousFeatureIndex) {
        throw new Error('prepacked annotation search posting list is not strictly sorted');
      }
      previousFeatureIndex = featureIndex;
    }
    emitPackProgress(
      onProgress,
      'validating-payload-postings',
      gramIndex + 1,
      views.gramKeys.length
    );
  }

  const gramIndexByKey = new TrigramIdTable();
  for (let gramIndex = 0; gramIndex < views.gramKeys.length; gramIndex += 1) {
    gramIndexByKey.define(Number(views.gramKeys[gramIndex]), gramIndex);
  }
  const cursors = views.postingOffsets.slice(0, views.gramKeys.length);
  const stamps = new Int32Array(views.gramKeys.length).fill(-1);
  const text = views.textCodeUnits;
  let expectedPostingsVerified = 0;
  emitPackProgress(onProgress, 'validating-payload-completeness', 0, manifest.featureCount);
  for (let recordIndex = 0; recordIndex < manifest.featureCount; recordIndex += 1) {
    const haystack = recordTextRef(views.featureRecords, recordIndex, RECORD.haystackOffset);
    const last = haystack.offset + haystack.length - 3;
    for (let offset = haystack.offset; offset <= last; offset += 1) {
      const gramIndex = gramIndexByKey.idOf(
        text[offset],
        text[offset + 1],
        text[offset + 2],
        false
      );
      if (gramIndex < 0) {
        throw new Error('prepacked annotation search gram dictionary is incomplete');
      }
      if (stamps[gramIndex] === recordIndex) continue;
      stamps[gramIndex] = recordIndex;
      expectedPostingsVerified += 1;
      const cursor = cursors[gramIndex];
      if (
        cursor >= views.postingOffsets[gramIndex + 1] ||
        views.postingFeatureIndices[cursor] !== recordIndex
      ) {
        throw new Error('prepacked annotation search posting list is incomplete');
      }
      cursors[gramIndex] = cursor + 1;
    }
    emitPackProgress(
      onProgress,
      'validating-payload-completeness',
      recordIndex + 1,
      manifest.featureCount
    );
  }
  if (expectedPostingsVerified !== manifest.postingCount) {
    throw new Error('prepacked annotation search posting census is inconsistent');
  }
  return {
    featureRecordsScanned: manifest.featureCount,
    gramKeysScanned: manifest.gramCount,
    postingsScanned: manifest.postingCount,
    expectedPostingsVerified,
  };
}

function emitPackProgress(
  onProgress: ((progress: PrepackedAnnotationSearchPackProgressV1) => void) | undefined,
  phase: PrepackedAnnotationSearchPackProgressV1['phase'],
  completed: number,
  total: number
): void {
  if (
    !onProgress ||
    (completed !== 0 && completed !== total && completed % PACK_PROGRESS_RECORD_INTERVAL !== 0)
  ) {
    return;
  }
  onProgress({ phase, completed, total });
}

function validateTextRef(view: DataView, offset: number, textLength: number): void {
  const refOffset = view.getUint32(offset, true);
  const refLength = view.getUint32(offset + U32_BYTES, true);
  if (refOffset > textLength || refLength > textLength - refOffset) {
    throw new Error('prepacked annotation search text reference is out of range');
  }
}

function recordTextRef(view: DataView, recordIndex: number, offsetInRecord: number): TextRef {
  const offset = recordIndex * PREPACKED_ANNOTATION_SEARCH_FEATURE_RECORD_BYTES + offsetInRecord;
  return {
    offset: view.getUint32(offset, true),
    length: view.getUint32(offset + U32_BYTES, true),
  };
}

interface RangeReadableFeatureRecordV1 {
  sourceOrdinal: number;
  direction: PrepackedAnnotationSearchDirectionV1;
  start: number;
  end: number;
  label: TextRef;
  type: TextRef;
  trackId: TextRef;
  canonicalIdentity: TextRef;
  haystack: TextRef;
}

const RANGE_RECORD_PAGE_BYTES = PREPACKED_ANNOTATION_SEARCH_FEATURE_RECORD_BYTES * 4_096;
const RANGE_TEXT_PAGE_BYTES = 256 * 1_024;
const RANGE_TEXT_SCAN_CHUNK_CODE_UNITS = 32 * 1_024;
const RANGE_POSTING_PAGE_BYTES = 64 * 1_024;
const RANGE_PAGE_CACHE_ENTRIES = 8;
const RANGE_MAX_INTERSECTION_GRAMS = 8;

class RangeBytePageCacheV1 {
  private readonly pages = new Map<number, Promise<Uint8Array>>();

  constructor(
    private readonly reader: PrepackedAnnotationSearchRangeReaderV1,
    private readonly section: PrepackedAnnotationSearchBinarySectionV1,
    private readonly pageBytes: number,
    private readonly maxPages = RANGE_PAGE_CACHE_ENTRIES
  ) {}

  async read(
    relativeByteOffset: number,
    byteLength: number,
    signal?: AbortSignal
  ): Promise<Uint8Array> {
    throwIfRangeQueryAborted(signal);
    if (
      !Number.isSafeInteger(relativeByteOffset) ||
      !Number.isSafeInteger(byteLength) ||
      relativeByteOffset < 0 ||
      byteLength < 0 ||
      relativeByteOffset > this.section.byteLength ||
      byteLength > this.section.byteLength - relativeByteOffset
    ) {
      throw new Error('prepacked annotation search range read is out of bounds');
    }
    if (byteLength === 0) return new Uint8Array(0);

    const firstPage = Math.floor(relativeByteOffset / this.pageBytes);
    const lastPage = Math.floor((relativeByteOffset + byteLength - 1) / this.pageBytes);
    if (firstPage === lastPage) {
      throwIfRangeQueryAborted(signal);
      const page = await this.page(firstPage);
      throwIfRangeQueryAborted(signal);
      const offsetInPage = relativeByteOffset - firstPage * this.pageBytes;
      return page.subarray(offsetInPage, offsetInPage + byteLength);
    }

    throwIfRangeQueryAborted(signal);
    const result = new Uint8Array(byteLength);
    let destinationOffset = 0;
    let cursor = relativeByteOffset;
    while (destinationOffset < byteLength) {
      throwIfRangeQueryAborted(signal);
      const pageIndex = Math.floor(cursor / this.pageBytes);
      const page = await this.page(pageIndex);
      throwIfRangeQueryAborted(signal);
      const offsetInPage = cursor - pageIndex * this.pageBytes;
      const copyLength = Math.min(page.byteLength - offsetInPage, byteLength - destinationOffset);
      result.set(page.subarray(offsetInPage, offsetInPage + copyLength), destinationOffset);
      cursor += copyLength;
      destinationOffset += copyLength;
    }
    throwIfRangeQueryAborted(signal);
    return result;
  }

  private page(pageIndex: number): Promise<Uint8Array> {
    const incumbent = this.pages.get(pageIndex);
    if (incumbent) {
      this.pages.delete(pageIndex);
      this.pages.set(pageIndex, incumbent);
      return incumbent;
    }
    const relativeOffset = pageIndex * this.pageBytes;
    const byteLength = Math.min(this.pageBytes, this.section.byteLength - relativeOffset);
    const pending = readExactBytes(
      this.reader,
      this.section.byteOffset + relativeOffset,
      byteLength
    );
    this.pages.set(pageIndex, pending);
    while (this.pages.size > this.maxPages) {
      const oldest = this.pages.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      this.pages.delete(oldest);
    }
    return pending;
  }
}

class PagedUint32PlaneV1 {
  private readonly bytes: RangeBytePageCacheV1;

  constructor(
    reader: PrepackedAnnotationSearchRangeReaderV1,
    private readonly section: PrepackedAnnotationSearchBinarySectionV1
  ) {
    this.bytes = new RangeBytePageCacheV1(reader, section, RANGE_POSTING_PAGE_BYTES);
  }

  async read(start: number, count: number): Promise<Uint32Array> {
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(count) ||
      start < 0 ||
      count < 0 ||
      start > this.section.count ||
      count > this.section.count - start
    ) {
      throw new Error('prepacked annotation search posting range is out of bounds');
    }
    if (count === 0) return new Uint32Array(0);
    const bytes = await this.bytes.read(start * U32_BYTES, count * U32_BYTES);
    if (bytes.byteOffset % U32_BYTES === 0) {
      return new Uint32Array(bytes.buffer, bytes.byteOffset, count);
    }
    const owned = new Uint8Array(bytes.byteLength);
    owned.set(bytes);
    return new Uint32Array(owned.buffer);
  }
}

class PagedFeatureRecordPlaneV1 {
  private readonly bytes: RangeBytePageCacheV1;

  constructor(
    reader: PrepackedAnnotationSearchRangeReaderV1,
    private readonly section: PrepackedAnnotationSearchBinarySectionV1
  ) {
    this.bytes = new RangeBytePageCacheV1(reader, section, RANGE_RECORD_PAGE_BYTES);
  }

  async get(index: number): Promise<RangeReadableFeatureRecordV1> {
    if (!Number.isInteger(index) || index < 0 || index >= this.section.count) {
      throw new Error('prepacked annotation search feature index is out of bounds');
    }
    const bytes = await this.bytes.read(
      index * PREPACKED_ANNOTATION_SEARCH_FEATURE_RECORD_BYTES,
      PREPACKED_ANNOTATION_SEARCH_FEATURE_RECORD_BYTES
    );
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
      sourceOrdinal: view.getUint32(RECORD.sourceOrdinal, true),
      direction: decodeDirectionV1(view.getUint32(RECORD.directionCode, true)),
      start: readSafeUint64(view, RECORD.startBp, 'query start'),
      end: readSafeUint64(view, RECORD.endBp, 'query end'),
      label: textRefFromRecordViewV1(view, RECORD.labelOffset),
      type: textRefFromRecordViewV1(view, RECORD.typeOffset),
      trackId: textRefFromRecordViewV1(view, RECORD.trackIdOffset),
      canonicalIdentity: textRefFromRecordViewV1(view, RECORD.canonicalIdentityOffset),
      haystack: textRefFromRecordViewV1(view, RECORD.haystackOffset),
    };
  }
}

class PagedTextPlaneV1 {
  private readonly bytes: RangeBytePageCacheV1;

  constructor(
    reader: PrepackedAnnotationSearchRangeReaderV1,
    private readonly section: PrepackedAnnotationSearchBinarySectionV1
  ) {
    this.bytes = new RangeBytePageCacheV1(reader, section, RANGE_TEXT_PAGE_BYTES);
  }

  async contains(ref: TextRef, query: Uint16Array, signal?: AbortSignal): Promise<boolean> {
    this.validateRef(ref);
    throwIfRangeQueryAborted(signal);
    if (query.length === 0) return true;
    if (query.length > ref.length) return false;

    const overlap = query.length - 1;
    let relativeOffset = 0;
    while (relativeOffset < ref.length) {
      throwIfRangeQueryAborted(signal);
      const length = Math.min(RANGE_TEXT_SCAN_CHUNK_CODE_UNITS, ref.length - relativeOffset);
      const text = await this.codeUnits(ref, relativeOffset, length, signal);
      throwIfRangeQueryAborted(signal);
      if (containsCodeUnits(text, { offset: 0, length: text.length }, query)) return true;
      if (relativeOffset + length >= ref.length) return false;
      relativeOffset += length - Math.min(overlap, length - 1);
    }
    return false;
  }

  async decodeBounded(ref: TextRef, maxCodeUnits: number, signal?: AbortSignal): Promise<string> {
    this.validateRef(ref);
    if (!Number.isInteger(maxCodeUnits) || maxCodeUnits < 0) {
      throw new Error('prepacked annotation search result text bound is invalid');
    }
    const length = Math.min(ref.length, maxCodeUnits);
    const text = await this.codeUnits(ref, 0, length, signal);
    throwIfRangeQueryAborted(signal);
    const safeLength =
      ref.length > maxCodeUnits && length > 0 && isHighSurrogate(text[length - 1])
        ? length - 1
        : length;
    return decodeCodeUnits(text, { offset: 0, length: safeLength });
  }

  private validateRef(ref: TextRef): void {
    if (
      !Number.isInteger(ref.offset) ||
      !Number.isInteger(ref.length) ||
      ref.offset < 0 ||
      ref.length < 0 ||
      ref.offset > this.section.count ||
      ref.length > this.section.count - ref.offset
    ) {
      throw new Error('prepacked annotation search text reference is out of range');
    }
  }

  private async codeUnits(
    ref: TextRef,
    relativeOffset: number,
    length: number,
    signal?: AbortSignal
  ): Promise<Uint16Array> {
    if (
      !Number.isInteger(relativeOffset) ||
      !Number.isInteger(length) ||
      relativeOffset < 0 ||
      length < 0 ||
      relativeOffset > ref.length ||
      length > ref.length - relativeOffset
    ) {
      throw new Error('prepacked annotation search text subrange is out of range');
    }
    const bytes = await this.bytes.read(
      (ref.offset + relativeOffset) * U16_BYTES,
      length * U16_BYTES,
      signal
    );
    throwIfRangeQueryAborted(signal);
    if (bytes.byteOffset % U16_BYTES === 0) {
      return new Uint16Array(bytes.buffer, bytes.byteOffset, length);
    }
    const owned = new Uint8Array(bytes.byteLength);
    owned.set(bytes);
    return new Uint16Array(owned.buffer);
  }
}

async function queryRangeReadableIndexV1(
  manifest: PrepackedAnnotationSearchIndexManifestV1,
  gramKeys: BigUint64Array,
  postingOffsets: Uint32Array,
  postings: PagedUint32PlaneV1,
  records: PagedFeatureRecordPlaneV1,
  text: PagedTextPlaneV1,
  input: string,
  limit: number,
  options: PrepackedAnnotationSearchQueryOptionsV1 = {}
): Promise<PrepackedAnnotationSearchMatchV1[]> {
  const { signal } = options;
  throwIfRangeQueryAborted(signal);
  if (input.length > PREPACKED_ANNOTATION_SEARCH_MAX_QUERY_CODE_UNITS_V1) {
    throw new Error(
      `prepacked annotation search query exceeds ${PREPACKED_ANNOTATION_SEARCH_MAX_QUERY_CODE_UNITS_V1} UTF-16 code units`
    );
  }
  const folded = input.toLowerCase().trim();
  if (folded.length < 3 || limit <= 0) return [];
  const queryUnits = stringCodeUnits(folded);
  let candidateStart = 0;
  let candidateEnd = 0;
  const otherRanges: Array<{ start: number; end: number }> = [];

  {
    const queryKeys = new Set<bigint>();
    for (let offset = 0; offset <= folded.length - 3; offset += 1) {
      queryKeys.add(gramKeyAt(folded, offset, 3));
    }
    const ranges: Array<{ start: number; end: number }> = [];
    for (const key of queryKeys) {
      const gramIndex = binarySearchBigUint64(gramKeys, key);
      if (gramIndex < 0) return [];
      ranges.push({ start: postingOffsets[gramIndex], end: postingOffsets[gramIndex + 1] });
    }
    ranges.sort((left, right) => left.end - left.start - (right.end - right.start));
    const retainedRanges = ranges.slice(0, RANGE_MAX_INTERSECTION_GRAMS);
    const shortest = retainedRanges.shift();
    if (!shortest) return [];
    candidateStart = shortest.start;
    candidateEnd = shortest.end;
    otherRanges.push(...retainedRanges);
  }

  const matches: PrepackedAnnotationSearchMatchV1[] = [];
  const otherCursors = otherRanges.map(
    (range) => new MonotonicPostingCursorV1(postings, range.start, range.end, signal)
  );
  let scannedCandidates = 0;
  for (
    let blockStart = candidateStart;
    blockStart < candidateEnd && matches.length < limit;
    blockStart += RANGE_POSTING_BLOCK_VALUES
  ) {
    const candidateBlock = await postings.read(
      blockStart,
      Math.min(RANGE_POSTING_BLOCK_VALUES, candidateEnd - blockStart)
    );
    throwIfRangeQueryAborted(signal);
    for (let offset = 0; offset < candidateBlock.length && matches.length < limit; offset += 1) {
      const recordIndex = candidateBlock[offset];
      scannedCandidates += 1;
      let presentInEveryPosting = true;
      for (const postingCursor of otherCursors) {
        const postingContainsRecord = await postingCursor.contains(recordIndex);
        throwIfRangeQueryAborted(signal);
        if (!postingContainsRecord) {
          presentInEveryPosting = false;
          break;
        }
      }
      if (presentInEveryPosting) {
        const record = await records.get(recordIndex);
        throwIfRangeQueryAborted(signal);
        const haystackContainsQuery = await text.contains(record.haystack, queryUnits, signal);
        throwIfRangeQueryAborted(signal);
        if (haystackContainsQuery) {
          if (
            !validResultIdentityTextRef(record.trackId) ||
            !validCanonicalIdentitySuffixTextRef(
              record.canonicalIdentity,
              manifest.canonicalIdentityPrefix
            )
          ) {
            throw new Error('prepacked annotation search result identity is invalid');
          }
          const label = await text.decodeBounded(
            record.label,
            PREPACKED_ANNOTATION_SEARCH_MAX_RESULT_TEXT_CODE_UNITS_V1,
            signal
          );
          throwIfRangeQueryAborted(signal);
          const featureType = await text.decodeBounded(
            record.type,
            PREPACKED_ANNOTATION_SEARCH_MAX_RESULT_TEXT_CODE_UNITS_V1,
            signal
          );
          throwIfRangeQueryAborted(signal);
          const annotationTrackId = await text.decodeBounded(
            record.trackId,
            PREPACKED_ANNOTATION_SEARCH_MAX_RESULT_TEXT_CODE_UNITS_V1,
            signal
          );
          throwIfRangeQueryAborted(signal);
          const canonicalIdentitySuffix = await text.decodeBounded(
            record.canonicalIdentity,
            PREPACKED_ANNOTATION_SEARCH_MAX_CANONICAL_IDENTITY_CODE_UNITS_V1 -
              manifest.canonicalIdentityPrefix.length,
            signal
          );
          throwIfRangeQueryAborted(signal);
          matches.push({
            featureIndex: record.sourceOrdinal,
            direction: record.direction,
            start: record.start,
            end: record.end,
            label,
            featureType,
            annotationTrackId,
            canonicalIdentity: manifest.canonicalIdentityPrefix + canonicalIdentitySuffix,
          });
        }
      }
      if ((scannedCandidates & 0x0fff) === 0) {
        await yieldRangeQueryV1();
        throwIfRangeQueryAborted(signal);
      }
    }
  }
  matches.sort(
    (left, right) =>
      left.start - right.start || left.end - right.end || left.featureIndex - right.featureIndex
  );
  return matches;
}

function throwIfRangeQueryAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  const error = new Error('prepacked annotation search query was cancelled');
  error.name = 'AbortError';
  throw error;
}

class MonotonicPostingCursorV1 {
  private cursor: number;
  private blockStart = -1;
  private block = new Uint32Array(0);

  constructor(
    private readonly postings: PagedUint32PlaneV1,
    start: number,
    private readonly end: number,
    private readonly signal?: AbortSignal
  ) {
    this.cursor = start;
  }

  async contains(target: number): Promise<boolean> {
    while (this.cursor < this.end) {
      throwIfRangeQueryAborted(this.signal);
      if (
        this.blockStart < 0 ||
        this.cursor < this.blockStart ||
        this.cursor >= this.blockStart + this.block.length
      ) {
        this.blockStart = this.cursor;
        this.block = await this.postings.read(
          this.blockStart,
          Math.min(RANGE_POSTING_BLOCK_VALUES, this.end - this.blockStart)
        );
        throwIfRangeQueryAborted(this.signal);
      }
      const value = this.block[this.cursor - this.blockStart];
      if (value >= target) return value === target;
      this.cursor += 1;
    }
    return false;
  }
}

const RANGE_POSTING_BLOCK_VALUES = RANGE_POSTING_PAGE_BYTES / U32_BYTES;

function validateRangeDirectoryV1(
  manifest: PrepackedAnnotationSearchIndexManifestV1,
  gramKeys: BigUint64Array,
  postingOffsets: Uint32Array
): void {
  if (
    gramKeys.length !== manifest.gramCount ||
    postingOffsets.length !== manifest.gramCount + 1 ||
    postingOffsets[0] !== 0 ||
    postingOffsets[postingOffsets.length - 1] !== manifest.postingCount
  ) {
    throw new Error('prepacked annotation search posting offsets are invalid');
  }
  let previousKey = -1n;
  for (let index = 0; index < gramKeys.length; index += 1) {
    const key = gramKeys[index];
    if (key <= previousKey || decodeGramKey(key).length !== 3) {
      throw new Error('prepacked annotation search gram key is invalid');
    }
    const start = postingOffsets[index];
    const end = postingOffsets[index + 1];
    if (end <= start || end > manifest.postingCount) {
      throw new Error('prepacked annotation search posting offsets are invalid');
    }
    previousKey = key;
  }
}

function textRefFromRecordViewV1(view: DataView, offset: number): TextRef {
  return {
    offset: view.getUint32(offset, true),
    length: view.getUint32(offset + U32_BYTES, true),
  };
}

async function validateRangePadding(
  manifest: PrepackedAnnotationSearchIndexManifestV1,
  reader: PrepackedAnnotationSearchRangeReaderV1
): Promise<void> {
  let cursor = 0;
  for (const definition of SECTION_DEFINITIONS) {
    const aligned = align(cursor, definition.alignmentBytes);
    if (aligned > cursor) {
      const padding = await readExactBytes(reader, cursor, aligned - cursor);
      if (padding.some((value) => value !== 0)) {
        throw new Error('prepacked annotation search section padding is not zero');
      }
    }
    cursor = aligned + manifest.sections[definition.key].byteLength;
  }
}

async function readExactRange(
  reader: PrepackedAnnotationSearchRangeReaderV1,
  section: PrepackedAnnotationSearchBinarySectionV1
): Promise<Uint8Array> {
  return readExactBytes(reader, section.byteOffset, section.byteLength);
}

async function readExactBytes(
  reader: PrepackedAnnotationSearchRangeReaderV1,
  byteOffset: number,
  byteLength: number
): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(byteOffset) ||
    !Number.isSafeInteger(byteLength) ||
    byteOffset < 0 ||
    byteLength < 0 ||
    byteOffset > reader.byteLength ||
    byteLength > reader.byteLength - byteOffset
  ) {
    throw new Error('prepacked annotation search range read is out of bounds');
  }
  const bytes = await reader.read(byteOffset, byteLength);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== byteLength) {
    throw new Error('prepacked annotation search range read was incomplete');
  }
  const owned = new Uint8Array(byteLength);
  owned.set(bytes);
  return owned;
}

function bigUint64ArrayFromOwnedBytes(bytes: Uint8Array): BigUint64Array {
  if (bytes.byteLength % U64_BYTES !== 0) {
    throw new Error('prepacked annotation search gram dictionary is misaligned');
  }
  return new BigUint64Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / U64_BYTES);
}

function uint32ArrayFromOwnedBytes(bytes: Uint8Array): Uint32Array {
  if (bytes.byteLength % U32_BYTES !== 0) {
    throw new Error('prepacked annotation search posting offsets are misaligned');
  }
  return new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / U32_BYTES);
}

function yieldRangeQueryV1(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}

function queryPreparedIndex(
  manifest: PrepackedAnnotationSearchIndexManifestV1,
  views: PreparedViews,
  input: string,
  limit: number
): PrepackedAnnotationSearchMatchV1[] {
  const folded = input.toLowerCase().trim();
  if (folded.length === 0 || limit <= 0) return [];
  const queryUnits = stringCodeUnits(folded);

  let candidatePostingStart = 0;
  let candidatePostingEnd = manifest.featureCount;
  let candidatePlane: Uint32Array | null = null;
  const otherPostingRanges: Array<{ start: number; end: number }> = [];
  if (folded.length >= 3) {
    const gramLength = 3 as const;
    const queryKeys = new Set<bigint>();
    for (let offset = 0; offset <= folded.length - gramLength; offset += 1) {
      queryKeys.add(gramKeyAt(folded, offset, gramLength));
    }
    const ranges: Array<{ start: number; end: number }> = [];
    for (const key of queryKeys) {
      const gramIndex = binarySearchBigUint64(views.gramKeys, key);
      if (gramIndex < 0) return [];
      ranges.push({
        start: views.postingOffsets[gramIndex],
        end: views.postingOffsets[gramIndex + 1],
      });
    }
    ranges.sort((left, right) => left.end - left.start - (right.end - right.start));
    const shortest = ranges.shift();
    if (!shortest) return [];
    candidatePlane = views.postingFeatureIndices;
    candidatePostingStart = shortest.start;
    candidatePostingEnd = shortest.end;
    otherPostingRanges.push(...ranges);
  }

  const matches: PrepackedAnnotationSearchMatchV1[] = [];
  for (let cursor = candidatePostingStart; cursor < candidatePostingEnd; cursor += 1) {
    if (matches.length >= limit) break;
    const recordIndex = candidatePlane ? candidatePlane[cursor] : cursor;
    let presentInEveryPosting = true;
    for (const range of otherPostingRanges) {
      if (
        !binarySearchUint32Range(views.postingFeatureIndices, range.start, range.end, recordIndex)
      ) {
        presentInEveryPosting = false;
        break;
      }
    }
    if (!presentInEveryPosting) continue;
    const haystack = recordTextRef(views.featureRecords, recordIndex, RECORD.haystackOffset);
    if (!containsCodeUnits(views.textCodeUnits, haystack, queryUnits)) continue;
    const base = recordIndex * PREPACKED_ANNOTATION_SEARCH_FEATURE_RECORD_BYTES;
    const label = recordTextRef(views.featureRecords, recordIndex, RECORD.labelOffset);
    const type = recordTextRef(views.featureRecords, recordIndex, RECORD.typeOffset);
    const trackId = recordTextRef(views.featureRecords, recordIndex, RECORD.trackIdOffset);
    const canonicalIdentitySuffix = recordTextRef(
      views.featureRecords,
      recordIndex,
      RECORD.canonicalIdentityOffset
    );
    matches.push({
      featureIndex: views.featureRecords.getUint32(base + RECORD.sourceOrdinal, true),
      direction: decodeDirectionV1(
        views.featureRecords.getUint32(base + RECORD.directionCode, true)
      ),
      start: readSafeUint64(views.featureRecords, base + RECORD.startBp, 'query start'),
      end: readSafeUint64(views.featureRecords, base + RECORD.endBp, 'query end'),
      label: decodeCodeUnitsBounded(
        views.textCodeUnits,
        label,
        PREPACKED_ANNOTATION_SEARCH_MAX_RESULT_TEXT_CODE_UNITS_V1
      ),
      featureType: decodeCodeUnitsBounded(
        views.textCodeUnits,
        type,
        PREPACKED_ANNOTATION_SEARCH_MAX_RESULT_TEXT_CODE_UNITS_V1
      ),
      annotationTrackId: decodeCodeUnitsBounded(
        views.textCodeUnits,
        trackId,
        PREPACKED_ANNOTATION_SEARCH_MAX_RESULT_TEXT_CODE_UNITS_V1
      ),
      canonicalIdentity:
        manifest.canonicalIdentityPrefix +
        decodeCodeUnitsBounded(
          views.textCodeUnits,
          canonicalIdentitySuffix,
          PREPACKED_ANNOTATION_SEARCH_MAX_CANONICAL_IDENTITY_CODE_UNITS_V1 -
            manifest.canonicalIdentityPrefix.length
        ),
    });
  }
  matches.sort(
    (left, right) =>
      left.start - right.start || left.end - right.end || left.featureIndex - right.featureIndex
  );
  return matches;
}

function containsCodeUnits(text: Uint16Array, ref: TextRef, query: Uint16Array): boolean {
  if (query.length > ref.length) return false;
  outer: for (let offset = 0; offset <= ref.length - query.length; offset += 1) {
    for (let index = 0; index < query.length; index += 1) {
      if (text[ref.offset + offset + index] !== query[index]) continue outer;
    }
    return true;
  }
  return false;
}

function decodeCodeUnits(text: Uint16Array, ref: TextRef): string {
  const end = ref.offset + ref.length;
  let result = '';
  for (let cursor = ref.offset; cursor < end; cursor += 8_192) {
    const chunkEnd = Math.min(end, cursor + 8_192);
    result += String.fromCharCode(...text.subarray(cursor, chunkEnd));
  }
  return result;
}

function decodeCodeUnitsBounded(text: Uint16Array, ref: TextRef, maxCodeUnits: number): string {
  const length = Math.min(ref.length, maxCodeUnits);
  const safeLength =
    ref.length > maxCodeUnits && length > 0 && isHighSurrogate(text[ref.offset + length - 1])
      ? length - 1
      : length;
  return decodeCodeUnits(text, { offset: ref.offset, length: safeLength });
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function stringCodeUnits(value: string): Uint16Array {
  const result = new Uint16Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    result[index] = value.charCodeAt(index);
  }
  return result;
}

function binarySearchBigUint64(values: BigUint64Array, target: bigint): number {
  let low = 0;
  let high = values.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const value = values[mid];
    if (value === target) return mid;
    if (value < target) low = mid + 1;
    else high = mid - 1;
  }
  return -1;
}

function binarySearchUint32Range(
  values: Uint32Array,
  start: number,
  end: number,
  target: number
): boolean {
  let low = start;
  let high = end - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const value = values[mid];
    if (value === target) return true;
    if (value < target) low = mid + 1;
    else high = mid - 1;
  }
  return false;
}

function prepareViews(
  manifest: PrepackedAnnotationSearchIndexManifestV1,
  payload: Uint8Array
): PreparedViews {
  return prepareViewsFromSections(manifest.sections, payload);
}

function prepareViewsFromSections(
  sections: Record<SectionKeyV1, PrepackedAnnotationSearchBinarySectionV1>,
  payload: Uint8Array
): PreparedViews {
  return {
    featureRecords: new DataView(
      payload.buffer,
      payload.byteOffset + sections.featureRecords.byteOffset,
      sections.featureRecords.byteLength
    ),
    textCodeUnits: new Uint16Array(
      payload.buffer,
      payload.byteOffset + sections.textCodeUnits.byteOffset,
      sections.textCodeUnits.count
    ),
    gramKeys: new BigUint64Array(
      payload.buffer,
      payload.byteOffset + sections.gramKeys.byteOffset,
      sections.gramKeys.count
    ),
    postingOffsets: new Uint32Array(
      payload.buffer,
      payload.byteOffset + sections.postingOffsets.byteOffset,
      sections.postingOffsets.count
    ),
    postingFeatureIndices: new Uint32Array(
      payload.buffer,
      payload.byteOffset + sections.postingFeatureIndices.byteOffset,
      sections.postingFeatureIndices.count
    ),
  };
}

function readSafeUint64(view: DataView, offset: number, label: string): number {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`prepacked annotation search ${label} exceeds safe integer`);
  }
  return Number(value);
}

function align(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function checkedAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result > MAX_UINT32) {
    throw new Error(`prepacked annotation search ${label} exceeds uint32`);
  }
  return result;
}

function checkedMultiply(left: number, right: number, label: string): number {
  const result = left * right;
  if (!Number.isSafeInteger(result) || result > MAX_UINT32) {
    throw new Error(`prepacked annotation search ${label} byte length exceeds uint32`);
  }
  return result;
}

function validCount(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= MAX_UINT32;
}

function validResultIdentityTextRef(ref: TextRef): boolean {
  return ref.length > 0 && ref.length <= PREPACKED_ANNOTATION_SEARCH_MAX_RESULT_TEXT_CODE_UNITS_V1;
}

function validCanonicalIdentityPrefix(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= PREPACKED_ANNOTATION_SEARCH_MAX_CANONICAL_IDENTITY_CODE_UNITS_V1 &&
    !/[\r\n]/.test(value) &&
    hasWellFormedUtf16(value)
  );
}

function validCanonicalIdentitySuffixTextRef(ref: TextRef, prefix: string): boolean {
  return (
    ref.length >= 0 &&
    prefix.length + ref.length > 0 &&
    prefix.length + ref.length <= PREPACKED_ANNOTATION_SEARCH_MAX_CANONICAL_IDENTITY_CODE_UNITS_V1
  );
}

function nonemptyContractString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/[\r\n]/.test(value);
}

function hasWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (isHighSurrogate(codeUnit)) {
      if (index + 1 >= value.length || !isLowSurrogate(value.charCodeAt(index + 1))) return false;
      index += 1;
    } else if (isLowSurrogate(codeUnit)) {
      return false;
    }
  }
  return true;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

function contractMaterial(manifest: PrepackedAnnotationSearchIndexManifestV1): CanonicalJsonValue {
  const { integrity: _integrity, ...contract } = manifest;
  return contract as unknown as CanonicalJsonValue;
}

function canonicalJson(value: CanonicalJsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

async function hashContract(manifest: PrepackedAnnotationSearchIndexManifestV1): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalJson(contractMaterial(manifest))));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('prepacked annotation search sha256 is unavailable');
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join(
    ''
  );
}
