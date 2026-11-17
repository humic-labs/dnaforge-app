import type { AnnotationScenePrimitiveV1 } from './annotation-scene-binary-v1';
import { unpackBpCoordinate } from './bp-coordinate-packing';
import type { GpuReadyPartitionedTranscriptScene } from './partitioned-transcript-scene';
import { TRANSCRIPT_GLYPH_INSTANCE_LAYOUT } from './transcript-glyph-instances';

export const PREPACKED_ANNOTATION_INTERACTION_INDEX_V2 =
  'prepacked-annotation-interaction-index.v2' as const;
export const PREPACKED_ANNOTATION_INTERACTION_FEATURE_RECORD_BYTES = 72;

const UINT32_BYTES = Uint32Array.BYTES_PER_ELEMENT;
const UINT64_BYTES = BigUint64Array.BYTES_PER_ELEMENT;
const MAX_UINT32 = 0xffff_ffff;
const EMPTY_STRING_REF = { offset: 0, length: 0 } as const;
const UINT32_RANGE = 0x1_0000_0000;

interface PreparedInteractionViewsV2 {
  featureRecords: DataView;
  subtreeMaxEnds: DataView;
}

const preparedViews = new WeakMap<
  PrepackedAnnotationFeatureLookupIndexV2,
  PreparedInteractionViewsV2
>();

const RECORD = {
  rendererId: 0,
  featureIndex: 4,
  startBp: 8,
  endBp: 16,
  lane: 24,
  direction: 28,
  displayName: 32,
  type: 40,
  transcriptId: 48,
  sourceId: 56,
  canonicalIdentity: 64,
} as const;

type Direction = 'forward' | 'reverse' | 'none';

export interface PrepackedAnnotationInteractionFeatureInputV2 {
  rendererId: number;
  startBp: number;
  endBp: number;
  lane: number;
  direction: Direction;
  displayName: string;
  type: string;
  transcriptId: string | null;
  sourceId: string | null;
  canonicalIdentity: string;
}

export interface DecodedPrepackedAnnotationInteractionFeatureV2 extends PrepackedAnnotationInteractionFeatureInputV2 {
  featureIndex: number;
}

export interface PrepackedAnnotationFeatureLookupIndexV2 {
  schema: typeof PREPACKED_ANNOTATION_INTERACTION_INDEX_V2;
  featureCount: number;
  primitiveCount: number;
  featureRecordBytes: Uint8Array;
  intervalFeatureIndices: Uint32Array;
  rendererIdFeatureIndices: Uint32Array;
  canonicalIdentityFeatureIndices: Uint32Array;
  intervalSubtreeMaxEndBytes: Uint8Array;
  featurePrimitiveOffsets: Uint32Array;
  featurePrimitiveActiveFeatureIndices?: Uint32Array;
  stringBytes: Uint8Array;
}

export interface PrepackedAnnotationInteractionIndexV2 extends PrepackedAnnotationFeatureLookupIndexV2 {
  featurePrimitiveIndices: Uint32Array;
}

export interface PrepackedAnnotationPrimitiveCsrV2 {
  readonly featureCount: number;
  readonly primitiveCount: number;
  readonly featurePrimitiveOffsets: Uint32Array;
  readonly featurePrimitiveIndices: Uint32Array;
  readonly activeFeatureIndices: Uint32Array;
}

interface StringRef {
  offset: number;
  length: number;
}

interface FeatureStringRefs {
  displayName: StringRef;
  type: StringRef;
  transcriptId: StringRef;
  sourceId: StringRef;
  canonicalIdentity: StringRef;
}

export function buildPrepackedAnnotationInteractionIndexV2(
  features: ReadonlyArray<PrepackedAnnotationInteractionFeatureInputV2>,
  sortedPrimitives: ReadonlyArray<Pick<AnnotationScenePrimitiveV1, 'featureIndex'>>
): PrepackedAnnotationInteractionIndexV2 {
  if (features.length > MAX_UINT32 || sortedPrimitives.length > MAX_UINT32) {
    throw new Error('prepacked annotation interaction counts exceed uint32');
  }

  const encoder = new TextEncoder();
  const interned = new Map<string, StringRef>();
  const chunks: Uint8Array[] = [];
  let stringByteLength = 0;
  const intern = (value: string | null, label: string, required: boolean): StringRef => {
    if (value === null) return EMPTY_STRING_REF;
    if (typeof value !== 'string' || (required && value.length === 0)) {
      throw new Error(`prepacked annotation ${label} is invalid`);
    }
    if (value.length === 0) return EMPTY_STRING_REF;
    const existing = interned.get(value);
    if (existing) return existing;
    const bytes = encoder.encode(value);
    if (stringByteLength + bytes.byteLength > MAX_UINT32) {
      throw new Error('prepacked annotation interaction strings exceed uint32');
    }
    const ref = { offset: stringByteLength, length: bytes.byteLength };
    interned.set(value, ref);
    chunks.push(bytes);
    stringByteLength += bytes.byteLength;
    return ref;
  };

  const rendererIds = new Set<number>();
  const canonicalIdentities = new Set<string>();
  const refs: FeatureStringRefs[] = new Array(features.length);
  for (let featureIndex = 0; featureIndex < features.length; featureIndex += 1) {
    const feature = features[featureIndex];
    validateFeatureInput(feature, featureIndex);
    if (rendererIds.has(feature.rendererId)) {
      throw new Error(`prepacked annotation rendererId collision at feature ${featureIndex}`);
    }
    if (canonicalIdentities.has(feature.canonicalIdentity)) {
      throw new Error(
        `prepacked annotation canonicalIdentity collision at feature ${featureIndex}`
      );
    }
    rendererIds.add(feature.rendererId);
    canonicalIdentities.add(feature.canonicalIdentity);
    refs[featureIndex] = {
      displayName: intern(feature.displayName, 'displayName', true),
      type: intern(feature.type, 'type', true),
      transcriptId: intern(feature.transcriptId, 'transcriptId', false),
      sourceId: intern(feature.sourceId, 'sourceId', false),
      canonicalIdentity: intern(feature.canonicalIdentity, 'canonicalIdentity', true),
    };
  }

  const stringBytes = new Uint8Array(stringByteLength);
  let stringCursor = 0;
  for (const chunk of chunks) {
    stringBytes.set(chunk, stringCursor);
    stringCursor += chunk.byteLength;
  }

  const featureRecordBytes = new Uint8Array(
    checkedByteLength(
      features.length,
      PREPACKED_ANNOTATION_INTERACTION_FEATURE_RECORD_BYTES,
      'feature records'
    )
  );
  const recordView = new DataView(featureRecordBytes.buffer);
  for (let featureIndex = 0; featureIndex < features.length; featureIndex += 1) {
    writeFeatureRecord(recordView, featureIndex, features[featureIndex], refs[featureIndex]);
  }

  const primitiveCounts = new Uint32Array(features.length);
  for (let primitiveIndex = 0; primitiveIndex < sortedPrimitives.length; primitiveIndex += 1) {
    const featureIndex = sortedPrimitives[primitiveIndex]?.featureIndex;
    if (!Number.isInteger(featureIndex) || featureIndex! < 0 || featureIndex! >= features.length) {
      throw new Error(
        `prepacked annotation primitives[${primitiveIndex}].featureIndex is out of range`
      );
    }
    primitiveCounts[featureIndex!] += 1;
  }
  const featurePrimitiveOffsets = new Uint32Array(features.length + 1);
  for (let featureIndex = 0; featureIndex < features.length; featureIndex += 1) {
    featurePrimitiveOffsets[featureIndex + 1] =
      featurePrimitiveOffsets[featureIndex] + primitiveCounts[featureIndex];
  }
  const featurePrimitiveIndices = new Uint32Array(sortedPrimitives.length);
  const writeCursors = featurePrimitiveOffsets.slice(0, features.length);
  for (let primitiveIndex = 0; primitiveIndex < sortedPrimitives.length; primitiveIndex += 1) {
    const featureIndex = sortedPrimitives[primitiveIndex].featureIndex;
    featurePrimitiveIndices[writeCursors[featureIndex]++] = primitiveIndex;
  }

  const activeFeatureIndices: number[] = [];
  for (let featureIndex = 0; featureIndex < features.length; featureIndex += 1) {
    if (primitiveCounts[featureIndex] > 0) activeFeatureIndices.push(featureIndex);
  }
  activeFeatureIndices.sort(
    (a, b) =>
      features[a].startBp - features[b].startBp ||
      features[a].endBp - features[b].endBp ||
      compareExactStrings(features[a].canonicalIdentity, features[b].canonicalIdentity) ||
      a - b
  );
  const intervalFeatureIndices = new Uint32Array(activeFeatureIndices.length);
  let sortedCursor = 0;
  const fillEytzinger = (node: number): void => {
    if (node >= intervalFeatureIndices.length) return;
    fillEytzinger(node * 2 + 1);
    intervalFeatureIndices[node] = activeFeatureIndices[sortedCursor++];
    fillEytzinger(node * 2 + 2);
  };
  fillEytzinger(0);
  const byRendererId = features.map((_, featureIndex) => featureIndex);
  byRendererId.sort(
    (left, right) => features[left].rendererId - features[right].rendererId || left - right
  );
  const rendererIdFeatureIndices = new Uint32Array(byRendererId);
  const byCanonicalIdentity = features.map((_, featureIndex) => featureIndex);
  byCanonicalIdentity.sort(
    (left, right) =>
      compareExactStrings(features[left].canonicalIdentity, features[right].canonicalIdentity) ||
      left - right
  );
  const canonicalIdentityFeatureIndices = new Uint32Array(byCanonicalIdentity);

  const intervalSubtreeMaxEndBytes = new Uint8Array(
    checkedByteLength(activeFeatureIndices.length, UINT64_BYTES, 'interval subtree maxima')
  );
  const maxEndView = new DataView(intervalSubtreeMaxEndBytes.buffer);
  for (let node = intervalFeatureIndices.length - 1; node >= 0; node -= 1) {
    const featureEnd = features[intervalFeatureIndices[node]].endBp;
    const left = node * 2 + 1;
    const right = left + 1;
    let subtreeMaxEnd = featureEnd;
    if (left < intervalFeatureIndices.length) {
      subtreeMaxEnd = Math.max(subtreeMaxEnd, readUint64(maxEndView, left * UINT64_BYTES));
    }
    if (right < intervalFeatureIndices.length) {
      subtreeMaxEnd = Math.max(subtreeMaxEnd, readUint64(maxEndView, right * UINT64_BYTES));
    }
    maxEndView.setBigUint64(node * UINT64_BYTES, BigInt(subtreeMaxEnd), true);
  }

  const index: PrepackedAnnotationInteractionIndexV2 = {
    schema: PREPACKED_ANNOTATION_INTERACTION_INDEX_V2,
    featureCount: features.length,
    primitiveCount: sortedPrimitives.length,
    featureRecordBytes,
    intervalFeatureIndices,
    rendererIdFeatureIndices,
    canonicalIdentityFeatureIndices,
    intervalSubtreeMaxEndBytes,
    featurePrimitiveOffsets,
    featurePrimitiveIndices,
    stringBytes,
  };
  validatePrepackedAnnotationInteractionIndexV2(index);
  return index;
}

export function projectPrepackedAnnotationFeatureLookupIndexV2(
  index: PrepackedAnnotationInteractionIndexV2
): Readonly<PrepackedAnnotationFeatureLookupIndexV2> {
  return Object.freeze({
    schema: index.schema,
    featureCount: index.featureCount,
    primitiveCount: index.primitiveCount,
    featureRecordBytes: index.featureRecordBytes,
    intervalFeatureIndices: index.intervalFeatureIndices,
    rendererIdFeatureIndices: index.rendererIdFeatureIndices,
    canonicalIdentityFeatureIndices: index.canonicalIdentityFeatureIndices,
    intervalSubtreeMaxEndBytes: index.intervalSubtreeMaxEndBytes,
    featurePrimitiveOffsets: index.featurePrimitiveOffsets,
    stringBytes: index.stringBytes,
  });
}

export function bindPrepackedAnnotationFeatureLookupToPrimitiveBankV2(
  featureLookup: PrepackedAnnotationFeatureLookupIndexV2,
  primitiveFeatureIndices: Uint32Array
): PrepackedAnnotationInteractionIndexV2 {
  return bindPrepackedAnnotationFeatureLookupToPrimitiveCsrV2(
    featureLookup,
    buildPrepackedAnnotationPrimitiveCsrV2(featureLookup.featureCount, primitiveFeatureIndices)
  );
}

export function buildPrepackedAnnotationPrimitiveCsrV2(
  featureCount: number,
  primitiveFeatureIndices: Uint32Array
): PrepackedAnnotationPrimitiveCsrV2 {
  if (!Number.isSafeInteger(featureCount) || featureCount < 0) {
    throw new Error('prepacked annotation primitive CSR feature count is invalid');
  }
  if (!(primitiveFeatureIndices instanceof Uint32Array)) {
    throw new Error('prepacked annotation primitive feature bank is invalid');
  }
  const counts = new Map<number, number>();
  for (let primitiveIndex = 0; primitiveIndex < primitiveFeatureIndices.length; primitiveIndex++) {
    const featureIndex = primitiveFeatureIndices[primitiveIndex];
    if (featureIndex >= featureCount) {
      throw new Error('prepacked annotation primitive feature is outside its parent lookup');
    }
    counts.set(featureIndex, (counts.get(featureIndex) ?? 0) + 1);
  }
  const activeFeatureIndices = Uint32Array.from(counts.keys()).sort();
  const featurePrimitiveOffsets = new Uint32Array(activeFeatureIndices.length + 1);
  const activeOrdinals = new Map<number, number>();
  for (let ordinal = 0; ordinal < activeFeatureIndices.length; ordinal++) {
    const featureIndex = activeFeatureIndices[ordinal];
    activeOrdinals.set(featureIndex, ordinal);
    featurePrimitiveOffsets[ordinal + 1] =
      featurePrimitiveOffsets[ordinal] + counts.get(featureIndex)!;
  }
  const featurePrimitiveIndices = new Uint32Array(primitiveFeatureIndices.length);
  const writeOffsets = featurePrimitiveOffsets.slice(0, activeFeatureIndices.length);
  for (let primitiveIndex = 0; primitiveIndex < primitiveFeatureIndices.length; primitiveIndex++) {
    const featureIndex = primitiveFeatureIndices[primitiveIndex];
    const ordinal = activeOrdinals.get(featureIndex)!;
    featurePrimitiveIndices[writeOffsets[ordinal]++] = primitiveIndex;
  }
  return Object.freeze({
    featureCount,
    primitiveCount: primitiveFeatureIndices.length,
    featurePrimitiveOffsets,
    featurePrimitiveIndices,
    activeFeatureIndices,
  });
}

export function bindPrepackedAnnotationFeatureLookupToPrimitiveCsrV2(
  featureLookup: PrepackedAnnotationFeatureLookupIndexV2,
  primitiveCsr: PrepackedAnnotationPrimitiveCsrV2
): PrepackedAnnotationInteractionIndexV2 {
  if (
    primitiveCsr.featureCount !== featureLookup.featureCount ||
    !Number.isSafeInteger(primitiveCsr.primitiveCount) ||
    primitiveCsr.primitiveCount < 0 ||
    !(primitiveCsr.activeFeatureIndices instanceof Uint32Array) ||
    !(primitiveCsr.featurePrimitiveOffsets instanceof Uint32Array) ||
    primitiveCsr.featurePrimitiveOffsets.length !== primitiveCsr.activeFeatureIndices.length + 1 ||
    !(primitiveCsr.featurePrimitiveIndices instanceof Uint32Array) ||
    primitiveCsr.featurePrimitiveIndices.length !== primitiveCsr.primitiveCount
  ) {
    throw new Error('prepacked annotation primitive CSR does not match its parent lookup');
  }
  validateSparsePrimitiveCsrV2(primitiveCsr);

  return Object.freeze({
    ...featureLookup,
    primitiveCount: primitiveCsr.primitiveCount,
    featurePrimitiveOffsets: primitiveCsr.featurePrimitiveOffsets,
    featurePrimitiveActiveFeatureIndices: primitiveCsr.activeFeatureIndices,
    featurePrimitiveIndices: primitiveCsr.featurePrimitiveIndices,
  });
}

function validateSparsePrimitiveCsrV2(primitiveCsr: PrepackedAnnotationPrimitiveCsrV2): void {
  if (primitiveCsr.featurePrimitiveOffsets[0] !== 0) {
    throw new Error('prepacked annotation sparse primitive CSR must start at zero');
  }
  let previousFeatureIndex = -1;
  for (let ordinal = 0; ordinal < primitiveCsr.activeFeatureIndices.length; ordinal++) {
    const featureIndex = primitiveCsr.activeFeatureIndices[ordinal];
    const start = primitiveCsr.featurePrimitiveOffsets[ordinal];
    const end = primitiveCsr.featurePrimitiveOffsets[ordinal + 1];
    if (
      featureIndex >= primitiveCsr.featureCount ||
      featureIndex <= previousFeatureIndex ||
      end <= start ||
      end > primitiveCsr.primitiveCount
    ) {
      throw new Error(`prepacked annotation sparse primitive CSR ordinal ${ordinal} is invalid`);
    }
    previousFeatureIndex = featureIndex;
  }
  if (
    primitiveCsr.featurePrimitiveOffsets[primitiveCsr.activeFeatureIndices.length] !==
    primitiveCsr.primitiveCount
  ) {
    throw new Error('prepacked annotation sparse primitive CSR does not cover every primitive');
  }
}

export function findPrepackedAnnotationFeaturePrimitiveCsrOrdinalV2(
  index: PrepackedAnnotationFeatureLookupIndexV2,
  featureIndex: number
): number {
  requireFeatureIndex(index, featureIndex);
  const active = index.featurePrimitiveActiveFeatureIndices;
  if (!active) return featureIndex;
  let low = 0;
  let high = active.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const candidate = active[middle];
    if (candidate === featureIndex) return middle;
    if (candidate < featureIndex) low = middle + 1;
    else high = middle - 1;
  }
  return -1;
}

function assertValidFeatureLookupSectionLengths(
  index: PrepackedAnnotationFeatureLookupIndexV2
): void {
  if (
    !Number.isSafeInteger(index.featureCount) ||
    index.featureCount < 0 ||
    !Number.isSafeInteger(index.primitiveCount) ||
    index.primitiveCount < 0 ||
    !(index.featureRecordBytes instanceof Uint8Array) ||
    index.featureRecordBytes.byteLength !==
      index.featureCount * PREPACKED_ANNOTATION_INTERACTION_FEATURE_RECORD_BYTES ||
    !(index.intervalFeatureIndices instanceof Uint32Array) ||
    !(index.rendererIdFeatureIndices instanceof Uint32Array) ||
    !(index.canonicalIdentityFeatureIndices instanceof Uint32Array) ||
    !(index.intervalSubtreeMaxEndBytes instanceof Uint8Array) ||
    index.intervalSubtreeMaxEndBytes.byteLength !==
      index.intervalFeatureIndices.length * UINT64_BYTES ||
    index.rendererIdFeatureIndices.length !== index.featureCount ||
    index.canonicalIdentityFeatureIndices.length !== index.featureCount ||
    !(index.featurePrimitiveOffsets instanceof Uint32Array) ||
    (index.featurePrimitiveActiveFeatureIndices !== undefined &&
      !(index.featurePrimitiveActiveFeatureIndices instanceof Uint32Array)) ||
    index.featurePrimitiveOffsets.length !==
      (index.featurePrimitiveActiveFeatureIndices?.length ?? index.featureCount) + 1 ||
    !(index.stringBytes instanceof Uint8Array)
  ) {
    throw new Error('prepacked annotation interaction section lengths are invalid');
  }
}

export function validatePrepackedAnnotationFeatureLookupIndexV2(
  index: PrepackedAnnotationFeatureLookupIndexV2
): void {
  if (index?.schema !== PREPACKED_ANNOTATION_INTERACTION_INDEX_V2) {
    throw new Error('prepacked annotation interaction schema is invalid');
  }
  assertValidFeatureLookupSectionLengths(index);
  assertValidFeatureLookupCsr(index);
  const { featureRecords: recordView, subtreeMaxEnds: maxEndView } = prepareViews(index);
  const seen = assertValidFeatureLookupIntervalTree(index, recordView, maxEndView);
  assertUniqueFeatureLookupIdentities(index, recordView, seen);
  assertRendererIdIndexPermutation(index, recordView);
  assertCanonicalIdentityIndexPermutation(index, recordView);
  assertFeatureLookupIntervalOrdering(index, recordView);
}

function assertValidFeatureLookupCsr(index: PrepackedAnnotationFeatureLookupIndexV2): void {
  if (index.featurePrimitiveOffsets[0] !== 0) {
    throw new Error('prepacked annotation interaction CSR must start at zero');
  }
  let previousActiveFeatureIndex = -1;
  const csrFeatureCount = index.featurePrimitiveOffsets.length - 1;
  for (let i = 0; i < csrFeatureCount; i += 1) {
    const start = index.featurePrimitiveOffsets[i];
    const end = index.featurePrimitiveOffsets[i + 1];
    const activeFeatureIndex = index.featurePrimitiveActiveFeatureIndices?.[i];
    if (
      end < start ||
      end > index.primitiveCount ||
      (activeFeatureIndex !== undefined &&
        (activeFeatureIndex >= index.featureCount ||
          activeFeatureIndex <= previousActiveFeatureIndex ||
          end === start))
    ) {
      throw new Error(`prepacked annotation interaction CSR offset ${i} is invalid`);
    }
    if (activeFeatureIndex !== undefined) previousActiveFeatureIndex = activeFeatureIndex;
  }
  if (index.featurePrimitiveOffsets[csrFeatureCount] !== index.primitiveCount) {
    throw new Error('prepacked annotation interaction CSR does not cover every primitive');
  }
}

function assertValidFeatureLookupIntervalTree(
  index: PrepackedAnnotationFeatureLookupIndexV2,
  recordView: DataView,
  maxEndView: DataView
): Uint8Array {
  const seen = new Uint8Array(index.featureCount);
  for (let node = index.intervalFeatureIndices.length - 1; node >= 0; node -= 1) {
    const featureIndex = index.intervalFeatureIndices[node];
    if (featureIndex >= index.featureCount || seen[featureIndex] !== 0) {
      throw new Error(`prepacked annotation interaction interval node ${node} is invalid`);
    }
    seen[featureIndex] = 1;
    validateFeatureRecord(index, recordView, featureIndex);
    const left = node * 2 + 1;
    const right = left + 1;
    let expectedMax = recordEnd(recordView, featureIndex);
    if (left < index.intervalFeatureIndices.length) {
      expectedMax = Math.max(expectedMax, readUint64(maxEndView, left * UINT64_BYTES));
    }
    if (right < index.intervalFeatureIndices.length) {
      expectedMax = Math.max(expectedMax, readUint64(maxEndView, right * UINT64_BYTES));
    }
    if (readUint64(maxEndView, node * UINT64_BYTES) !== expectedMax) {
      throw new Error(`prepacked annotation interaction subtree max ${node} is invalid`);
    }
  }
  return seen;
}

function assertUniqueFeatureLookupIdentities(
  index: PrepackedAnnotationFeatureLookupIndexV2,
  recordView: DataView,
  seen: Uint8Array
): void {
  const sparseUsesParentIntervalAuthority =
    index.featurePrimitiveActiveFeatureIndices !== undefined &&
    index.intervalFeatureIndices.length === index.featureCount;
  const rendererIds = new Set<number>();
  const canonicalIdentities = new Set<string>();
  for (let featureIndex = 0; featureIndex < index.featureCount; featureIndex += 1) {
    validateFeatureRecord(index, recordView, featureIndex);
    const offset = featureIndex * PREPACKED_ANNOTATION_INTERACTION_FEATURE_RECORD_BYTES;
    const rendererId = recordView.getUint32(offset + RECORD.rendererId, true);
    const canonicalIdentity = decodeString(
      index,
      recordView,
      offset + RECORD.canonicalIdentity,
      false
    )!;
    if (rendererIds.has(rendererId) || canonicalIdentities.has(canonicalIdentity)) {
      throw new Error(
        `prepacked annotation interaction persisted identity ${featureIndex} is not unique`
      );
    }
    rendererIds.add(rendererId);
    canonicalIdentities.add(canonicalIdentity);
    const csrOrdinal = findPrepackedAnnotationFeaturePrimitiveCsrOrdinalV2(index, featureIndex);
    const active =
      csrOrdinal >= 0 &&
      index.featurePrimitiveOffsets[csrOrdinal + 1] > index.featurePrimitiveOffsets[csrOrdinal];
    if (
      sparseUsesParentIntervalAuthority
        ? seen[featureIndex] === 0
        : (seen[featureIndex] !== 0) !== active
    ) {
      throw new Error(`prepacked annotation interaction active feature ${featureIndex} is invalid`);
    }
  }
}

function assertRendererIdIndexPermutation(
  index: PrepackedAnnotationFeatureLookupIndexV2,
  recordView: DataView
): void {
  const rendererOrdinalSeen = new Uint8Array(index.featureCount);
  let previousRendererId = -1;
  for (let ordinal = 0; ordinal < index.rendererIdFeatureIndices.length; ordinal += 1) {
    const featureIndex = index.rendererIdFeatureIndices[ordinal];
    if (featureIndex >= index.featureCount || rendererOrdinalSeen[featureIndex] !== 0) {
      throw new Error('prepacked annotation interaction renderer index is not a permutation');
    }
    rendererOrdinalSeen[featureIndex] = 1;
    const rendererId = recordView.getUint32(
      featureIndex * PREPACKED_ANNOTATION_INTERACTION_FEATURE_RECORD_BYTES + RECORD.rendererId,
      true
    );
    if (rendererId <= previousRendererId) {
      throw new Error('prepacked annotation interaction renderer index ordering is invalid');
    }
    previousRendererId = rendererId;
  }
}

function assertCanonicalIdentityIndexPermutation(
  index: PrepackedAnnotationFeatureLookupIndexV2,
  recordView: DataView
): void {
  const canonicalOrdinalSeen = new Uint8Array(index.featureCount);
  let previousSortedCanonicalIdentity: string | null = null;
  for (let ordinal = 0; ordinal < index.canonicalIdentityFeatureIndices.length; ordinal += 1) {
    const featureIndex = index.canonicalIdentityFeatureIndices[ordinal];
    if (featureIndex >= index.featureCount || canonicalOrdinalSeen[featureIndex] !== 0) {
      throw new Error(
        'prepacked annotation interaction canonical identity index is not a permutation'
      );
    }
    canonicalOrdinalSeen[featureIndex] = 1;
    const canonicalIdentity = decodeString(
      index,
      recordView,
      featureIndex * PREPACKED_ANNOTATION_INTERACTION_FEATURE_RECORD_BYTES +
        RECORD.canonicalIdentity,
      false
    )!;
    if (
      previousSortedCanonicalIdentity !== null &&
      compareExactStrings(canonicalIdentity, previousSortedCanonicalIdentity) <= 0
    ) {
      throw new Error(
        'prepacked annotation interaction canonical identity index ordering is invalid'
      );
    }
    previousSortedCanonicalIdentity = canonicalIdentity;
  }
}

function assertFeatureLookupIntervalOrdering(
  index: PrepackedAnnotationFeatureLookupIndexV2,
  recordView: DataView
): void {
  let previousFeatureIndex = -1;
  let previousStart = -1;
  let previousEnd = -1;
  let previousCanonicalIdentity = '';
  const validateIntervalOrdering = (node: number): void => {
    if (node >= index.intervalFeatureIndices.length) return;
    validateIntervalOrdering(node * 2 + 1);
    const featureIndex = index.intervalFeatureIndices[node];
    const start = recordStart(recordView, featureIndex);
    const end = recordEnd(recordView, featureIndex);
    const canonicalIdentity = decodeString(
      index,
      recordView,
      featureIndex * PREPACKED_ANNOTATION_INTERACTION_FEATURE_RECORD_BYTES +
        RECORD.canonicalIdentity,
      false
    )!;
    if (
      previousFeatureIndex >= 0 &&
      (start < previousStart ||
        (start === previousStart && end < previousEnd) ||
        (start === previousStart &&
          end === previousEnd &&
          compareExactStrings(canonicalIdentity, previousCanonicalIdentity) < 0) ||
        (start === previousStart &&
          end === previousEnd &&
          canonicalIdentity === previousCanonicalIdentity &&
          featureIndex <= previousFeatureIndex))
    ) {
      throw new Error('prepacked annotation interaction interval ordering is invalid');
    }
    previousFeatureIndex = featureIndex;
    previousStart = start;
    previousEnd = end;
    previousCanonicalIdentity = canonicalIdentity;
    validateIntervalOrdering(node * 2 + 2);
  };
  validateIntervalOrdering(0);
}

export function validatePrepackedAnnotationInteractionIndexV2(
  index: PrepackedAnnotationInteractionIndexV2
): void {
  validatePrepackedAnnotationFeatureLookupIndexV2(index);
  if (
    !(index.featurePrimitiveIndices instanceof Uint32Array) ||
    index.featurePrimitiveIndices.length !== index.primitiveCount
  ) {
    throw new Error('prepacked annotation interaction section lengths are invalid');
  }
  const seenPrimitives = new Uint8Array(index.primitiveCount);
  for (let ordinal = 0; ordinal < index.featurePrimitiveIndices.length; ordinal += 1) {
    const primitiveIndex = index.featurePrimitiveIndices[ordinal];
    if (primitiveIndex >= index.primitiveCount) {
      throw new Error(`prepacked annotation interaction primitive ordinal ${ordinal} is invalid`);
    }
    if (seenPrimitives[primitiveIndex] !== 0) {
      throw new Error('prepacked annotation interaction primitive permutation is invalid');
    }
    seenPrimitives[primitiveIndex] = 1;
  }
}

export interface PrepackedAnnotationInteractionVisualCouplingValidationWorkV2 {
  readonly interactionIndexValidationCount: 0 | 1;
  readonly featureScanCardinality: number;
  readonly primitiveScanCardinality: number;
}

export function validatePrepackedAnnotationInteractionVisualCouplingV2(
  index: PrepackedAnnotationInteractionIndexV2,
  scene: GpuReadyPartitionedTranscriptScene,
  assemblyLengthBp: number
): PrepackedAnnotationInteractionVisualCouplingValidationWorkV2 {
  validatePrepackedAnnotationInteractionIndexV2(index);
  const work = validatePrepackedAnnotationInteractionVisualCouplingAfterValidatedIndexV2(
    index,
    scene,
    assemblyLengthBp
  );
  return { ...work, interactionIndexValidationCount: 1 };
}

export function validatePrepackedAnnotationViewportInteractionVisualCouplingV2(
  index: PrepackedAnnotationInteractionIndexV2,
  admittedParent: PrepackedAnnotationFeatureLookupIndexV2,
  scene: GpuReadyPartitionedTranscriptScene,
  assemblyLengthBp: number
): PrepackedAnnotationInteractionVisualCouplingValidationWorkV2 {
  if (!Number.isSafeInteger(assemblyLengthBp) || assemblyLengthBp <= 0) {
    throw new Error('prepacked annotation viewport interaction assembly length is invalid');
  }
  if (
    index?.schema !== PREPACKED_ANNOTATION_INTERACTION_INDEX_V2 ||
    index.featureCount !== admittedParent.featureCount ||
    index.primitiveCount > admittedParent.primitiveCount ||
    index.featureRecordBytes !== admittedParent.featureRecordBytes ||
    index.intervalFeatureIndices !== admittedParent.intervalFeatureIndices ||
    index.intervalSubtreeMaxEndBytes !== admittedParent.intervalSubtreeMaxEndBytes ||
    index.rendererIdFeatureIndices !== admittedParent.rendererIdFeatureIndices ||
    index.canonicalIdentityFeatureIndices !== admittedParent.canonicalIdentityFeatureIndices ||
    index.stringBytes !== admittedParent.stringBytes
  ) {
    throw new Error('prepacked annotation viewport interaction parent authority mismatch');
  }
  if (
    !Number.isSafeInteger(index.primitiveCount) ||
    index.primitiveCount < 0 ||
    !(index.intervalFeatureIndices instanceof Uint32Array) ||
    !(index.intervalSubtreeMaxEndBytes instanceof Uint8Array) ||
    index.intervalSubtreeMaxEndBytes.byteLength !==
      index.intervalFeatureIndices.length * UINT64_BYTES ||
    !(index.featurePrimitiveActiveFeatureIndices instanceof Uint32Array) ||
    !(index.featurePrimitiveOffsets instanceof Uint32Array) ||
    index.featurePrimitiveOffsets.length !==
      index.featurePrimitiveActiveFeatureIndices.length + 1 ||
    !(index.featurePrimitiveIndices instanceof Uint32Array) ||
    index.featurePrimitiveIndices.length !== index.primitiveCount ||
    index.primitiveCount !== scene.featureIndices.length ||
    scene.packedInstanceData.length !==
      index.primitiveCount * TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideFloats
  ) {
    throw new Error('prepacked annotation viewport interaction section lengths are invalid');
  }
  if (index.featurePrimitiveOffsets[0] !== 0) {
    throw new Error('prepacked annotation viewport interaction CSR must start at zero');
  }

  const records = prepareViews(index).featureRecords;
  const packed = scene.packedInstanceData;
  const stride = TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideFloats;
  const seenPrimitives = new Uint8Array(index.primitiveCount);
  let previousActiveFeatureIndex = -1;
  for (
    let csrOrdinal = 0;
    csrOrdinal < index.featurePrimitiveActiveFeatureIndices.length;
    csrOrdinal += 1
  ) {
    const featureIndex = index.featurePrimitiveActiveFeatureIndices[csrOrdinal];
    const csrStart = index.featurePrimitiveOffsets[csrOrdinal];
    const csrEnd = index.featurePrimitiveOffsets[csrOrdinal + 1];
    if (csrEnd < csrStart || csrEnd > index.primitiveCount) {
      throw new Error(
        `prepacked annotation viewport interaction CSR offset ${featureIndex} is invalid`
      );
    }
    if (
      featureIndex >= index.featureCount ||
      featureIndex <= previousActiveFeatureIndex ||
      csrEnd === csrStart
    ) {
      throw new Error(
        `prepacked annotation viewport interaction active feature ${featureIndex} is invalid`
      );
    }
    previousActiveFeatureIndex = featureIndex;
    const featureStart = recordStart(records, featureIndex);
    const featureEnd = recordEnd(records, featureIndex);
    if (featureEnd > assemblyLengthBp) {
      throw new Error(
        `prepacked annotation viewport interaction feature ${featureIndex} exceeds assembly length`
      );
    }
    for (let cursor = csrStart; cursor < csrEnd; cursor += 1) {
      const primitiveIndex = index.featurePrimitiveIndices[cursor];
      if (primitiveIndex >= index.primitiveCount || seenPrimitives[primitiveIndex] !== 0) {
        throw new Error(
          'prepacked annotation viewport interaction primitive permutation is invalid'
        );
      }
      seenPrimitives[primitiveIndex] = 1;
      if (scene.featureIndices[primitiveIndex] !== featureIndex) {
        throw new Error(
          `prepacked annotation viewport interaction primitive ${primitiveIndex} visual owner mismatch`
        );
      }
      const base = primitiveIndex * stride;
      const primitiveStart = unpackBpCoordinate(
        packed[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpStartChunk],
        packed[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpStartDelta]
      );
      const primitiveEnd = unpackBpCoordinate(
        packed[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpEndChunk],
        packed[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpEndDelta]
      );
      if (
        !Number.isSafeInteger(primitiveStart) ||
        !Number.isSafeInteger(primitiveEnd) ||
        primitiveStart < featureStart ||
        primitiveEnd > featureEnd ||
        primitiveEnd <= primitiveStart ||
        primitiveEnd > assemblyLengthBp
      ) {
        throw new Error(
          `prepacked annotation viewport interaction primitive ${primitiveIndex} coordinate mismatch`
        );
      }
    }
  }
  if (
    index.featurePrimitiveOffsets[index.featurePrimitiveActiveFeatureIndices.length] !==
    index.primitiveCount
  ) {
    throw new Error('prepacked annotation viewport interaction CSR does not cover every primitive');
  }

  return {
    interactionIndexValidationCount: 0,
    featureScanCardinality: index.featurePrimitiveActiveFeatureIndices.length,
    primitiveScanCardinality: index.primitiveCount,
  };
}

export function validatePrepackedAnnotationInteractionVisualCouplingAfterValidatedIndexV2(
  index: PrepackedAnnotationInteractionIndexV2,
  scene: GpuReadyPartitionedTranscriptScene,
  assemblyLengthBp: number
): PrepackedAnnotationInteractionVisualCouplingValidationWorkV2 {
  if (!Number.isSafeInteger(assemblyLengthBp) || assemblyLengthBp <= 0) {
    throw new Error('prepacked annotation interaction assembly length is invalid');
  }
  if (
    index.primitiveCount !== scene.featureIndices.length ||
    scene.packedInstanceData.length !==
      index.primitiveCount * TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideFloats
  ) {
    throw new Error('prepacked annotation interaction visual counts do not match');
  }
  const records = prepareViews(index).featureRecords;
  const packed = scene.packedInstanceData;
  const stride = TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideFloats;
  const csrFeatureCount = index.featurePrimitiveActiveFeatureIndices?.length ?? index.featureCount;
  for (let csrOrdinal = 0; csrOrdinal < csrFeatureCount; csrOrdinal += 1) {
    const featureIndex = index.featurePrimitiveActiveFeatureIndices?.[csrOrdinal] ?? csrOrdinal;
    const featureStart = recordStart(records, featureIndex);
    const featureEnd = recordEnd(records, featureIndex);
    if (featureEnd > assemblyLengthBp) {
      throw new Error(
        `prepacked annotation interaction feature ${featureIndex} exceeds assembly length`
      );
    }
    const csrStart = index.featurePrimitiveOffsets[csrOrdinal];
    const csrEnd = index.featurePrimitiveOffsets[csrOrdinal + 1];
    for (let cursor = csrStart; cursor < csrEnd; cursor += 1) {
      const primitiveIndex = index.featurePrimitiveIndices[cursor];
      if (scene.featureIndices[primitiveIndex] !== featureIndex) {
        throw new Error(
          `prepacked annotation interaction primitive ${primitiveIndex} visual owner mismatch`
        );
      }
      const base = primitiveIndex * stride;
      const primitiveStart = unpackBpCoordinate(
        packed[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpStartChunk],
        packed[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpStartDelta]
      );
      const primitiveEnd = unpackBpCoordinate(
        packed[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpEndChunk],
        packed[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpEndDelta]
      );
      if (
        !Number.isSafeInteger(primitiveStart) ||
        !Number.isSafeInteger(primitiveEnd) ||
        primitiveStart < featureStart ||
        primitiveEnd > featureEnd ||
        primitiveEnd <= primitiveStart ||
        primitiveEnd > assemblyLengthBp
      ) {
        throw new Error(
          `prepacked annotation interaction primitive ${primitiveIndex} coordinate mismatch`
        );
      }
    }
  }
  return {
    interactionIndexValidationCount: 0,
    featureScanCardinality: csrFeatureCount,
    primitiveScanCardinality: index.primitiveCount,
  };
}

export function queryPrepackedAnnotationInteractionIndexV2(
  index: PrepackedAnnotationFeatureLookupIndexV2,
  queryStartBp: number,
  queryEndBp: number,
  visit: (featureIndex: number) => void
): number {
  if (
    !Number.isSafeInteger(queryStartBp) ||
    !Number.isSafeInteger(queryEndBp) ||
    queryStartBp < 0 ||
    queryEndBp <= queryStartBp
  ) {
    throw new Error('prepacked annotation interaction query is invalid');
  }
  if (index.intervalFeatureIndices.length === 0) return 0;
  const { featureRecords, subtreeMaxEnds } = prepareViews(index);
  return queryNode(index, featureRecords, subtreeMaxEnds, 0, queryStartBp, queryEndBp, visit);
}

export function decodePrepackedAnnotationInteractionFeatureV2(
  index: PrepackedAnnotationFeatureLookupIndexV2,
  featureIndex: number
): DecodedPrepackedAnnotationInteractionFeatureV2 {
  requireFeatureIndex(index, featureIndex);
  const view = prepareViews(index).featureRecords;
  const offset = featureIndex * PREPACKED_ANNOTATION_INTERACTION_FEATURE_RECORD_BYTES;
  return {
    rendererId: view.getUint32(offset + RECORD.rendererId, true),
    featureIndex: view.getUint32(offset + RECORD.featureIndex, true),
    startBp: readUint64(view, offset + RECORD.startBp),
    endBp: readUint64(view, offset + RECORD.endBp),
    lane: view.getInt32(offset + RECORD.lane, true),
    direction: decodeDirection(view.getUint32(offset + RECORD.direction, true)),
    displayName: decodeString(index, view, offset + RECORD.displayName, false)!,
    type: decodeString(index, view, offset + RECORD.type, false)!,
    transcriptId: decodeString(index, view, offset + RECORD.transcriptId, true),
    sourceId: decodeString(index, view, offset + RECORD.sourceId, true),
    canonicalIdentity: decodeString(index, view, offset + RECORD.canonicalIdentity, false)!,
  };
}

export function prepackedAnnotationInteractionFeatureMatchesResidentV2(
  index: PrepackedAnnotationFeatureLookupIndexV2,
  featureIndex: number,
  resident: Pick<
    PrepackedAnnotationInteractionFeatureInputV2,
    'startBp' | 'endBp' | 'direction' | 'type' | 'transcriptId' | 'displayName'
  >
): boolean {
  requireFeatureIndex(index, featureIndex);
  const view = prepareViews(index).featureRecords;
  const offset = featureIndex * PREPACKED_ANNOTATION_INTERACTION_FEATURE_RECORD_BYTES;
  if (
    recordStart(view, featureIndex) !== resident.startBp ||
    recordEnd(view, featureIndex) !== resident.endBp ||
    decodeDirection(view.getUint32(offset + RECORD.direction, true)) !== resident.direction
  ) {
    return false;
  }
  if (decodeString(index, view, offset + RECORD.type, false) !== resident.type) return false;
  return resident.transcriptId
    ? decodeString(index, view, offset + RECORD.transcriptId, true) === resident.transcriptId
    : decodeString(index, view, offset + RECORD.displayName, false) === resident.displayName;
}

export function prepackedAnnotationInteractionFeatureStartBpV2(
  index: PrepackedAnnotationFeatureLookupIndexV2,
  featureIndex: number
): number {
  requireFeatureIndex(index, featureIndex);
  return recordStart(prepareViews(index).featureRecords, featureIndex);
}

export function prepackedAnnotationInteractionFeatureEndBpV2(
  index: PrepackedAnnotationFeatureLookupIndexV2,
  featureIndex: number
): number {
  requireFeatureIndex(index, featureIndex);
  return recordEnd(prepareViews(index).featureRecords, featureIndex);
}

export function findPrepackedAnnotationFeatureByRendererIdV2(
  index: PrepackedAnnotationFeatureLookupIndexV2,
  rendererId: number
): number | null {
  if (!Number.isInteger(rendererId) || rendererId < 0 || rendererId > MAX_UINT32) return null;
  const records = prepareViews(index).featureRecords;
  let low = 0;
  let high = index.rendererIdFeatureIndices.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const featureIndex = index.rendererIdFeatureIndices[middle];
    const candidate = records.getUint32(
      featureIndex * PREPACKED_ANNOTATION_INTERACTION_FEATURE_RECORD_BYTES + RECORD.rendererId,
      true
    );
    if (candidate === rendererId) return featureIndex;
    if (candidate < rendererId) low = middle + 1;
    else high = middle - 1;
  }
  return null;
}

export function findPrepackedAnnotationFeatureByCanonicalIdentityV2(
  index: PrepackedAnnotationFeatureLookupIndexV2,
  canonicalIdentity: string
): number | null {
  if (
    typeof canonicalIdentity !== 'string' ||
    canonicalIdentity.length === 0 ||
    !hasWellFormedUtf16(canonicalIdentity)
  ) {
    return null;
  }
  const records = prepareViews(index).featureRecords;
  let low = 0;
  let high = index.canonicalIdentityFeatureIndices.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const featureIndex = index.canonicalIdentityFeatureIndices[middle];
    const candidate = decodeString(
      index,
      records,
      featureIndex * PREPACKED_ANNOTATION_INTERACTION_FEATURE_RECORD_BYTES +
        RECORD.canonicalIdentity,
      false
    )!;
    const comparison = compareExactStrings(candidate, canonicalIdentity);
    if (comparison === 0) return featureIndex;
    if (comparison < 0) low = middle + 1;
    else high = middle - 1;
  }
  return null;
}

export function forEachPrepackedAnnotationFeaturePrimitiveV2(
  index: PrepackedAnnotationInteractionIndexV2,
  featureIndex: number,
  visit: (primitiveIndex: number) => void
): void {
  const csrOrdinal = findPrepackedAnnotationFeaturePrimitiveCsrOrdinalV2(index, featureIndex);
  if (csrOrdinal < 0) return;
  const start = index.featurePrimitiveOffsets[csrOrdinal];
  const end = index.featurePrimitiveOffsets[csrOrdinal + 1];
  for (let cursor = start; cursor < end; cursor += 1) {
    visit(index.featurePrimitiveIndices[cursor]);
  }
}

function queryNode(
  index: PrepackedAnnotationFeatureLookupIndexV2,
  recordView: DataView,
  maxEndView: DataView,
  node: number,
  queryStartBp: number,
  queryEndBp: number,
  visit: (featureIndex: number) => void
): number {
  if (node >= index.intervalFeatureIndices.length) return 0;
  let visited = 1;
  if (readUint64(maxEndView, node * UINT64_BYTES) <= queryStartBp) return visited;
  const featureIndex = index.intervalFeatureIndices[node];
  const featureStart = recordStart(recordView, featureIndex);
  const left = node * 2 + 1;
  visited += queryNode(index, recordView, maxEndView, left, queryStartBp, queryEndBp, visit);
  if (featureStart < queryEndBp) {
    if (
      recordEnd(recordView, featureIndex) > queryStartBp &&
      (index.featurePrimitiveActiveFeatureIndices === undefined ||
        findPrepackedAnnotationFeaturePrimitiveCsrOrdinalV2(index, featureIndex) >= 0)
    ) {
      visit(featureIndex);
    }
    visited += queryNode(index, recordView, maxEndView, left + 1, queryStartBp, queryEndBp, visit);
  }
  return visited;
}

function validateFeatureInput(
  feature: PrepackedAnnotationInteractionFeatureInputV2,
  featureIndex: number
): void {
  if (
    !Number.isInteger(feature.rendererId) ||
    feature.rendererId < 0 ||
    feature.rendererId > MAX_UINT32
  ) {
    throw new Error(`prepacked annotation features[${featureIndex}].rendererId is invalid`);
  }
  if (
    !Number.isSafeInteger(feature.startBp) ||
    !Number.isSafeInteger(feature.endBp) ||
    feature.startBp < 0 ||
    feature.endBp <= feature.startBp
  ) {
    throw new Error(`prepacked annotation features[${featureIndex}] coordinates are invalid`);
  }
  if (!Number.isInteger(feature.lane) || feature.lane < 0 || feature.lane > 0x7fff_ffff) {
    throw new Error(`prepacked annotation features[${featureIndex}].lane is invalid`);
  }
  if (!['forward', 'reverse', 'none'].includes(feature.direction)) {
    throw new Error(`prepacked annotation features[${featureIndex}].direction is invalid`);
  }
  if (typeof feature.displayName !== 'string' || feature.displayName.length === 0) {
    throw new Error(`prepacked annotation features[${featureIndex}].displayName is invalid`);
  }
  if (typeof feature.type !== 'string' || feature.type.length === 0) {
    throw new Error(`prepacked annotation features[${featureIndex}].type is invalid`);
  }
  if (
    (feature.transcriptId !== null &&
      (typeof feature.transcriptId !== 'string' || feature.transcriptId.length === 0)) ||
    (feature.sourceId !== null &&
      (typeof feature.sourceId !== 'string' || feature.sourceId.length === 0))
  ) {
    throw new Error(`prepacked annotation features[${featureIndex}] optional identity is invalid`);
  }
  if (typeof feature.canonicalIdentity !== 'string' || feature.canonicalIdentity.length === 0) {
    throw new Error(`prepacked annotation features[${featureIndex}].canonicalIdentity is invalid`);
  }
  for (const [label, value] of [
    ['displayName', feature.displayName],
    ['type', feature.type],
    ['transcriptId', feature.transcriptId],
    ['sourceId', feature.sourceId],
    ['canonicalIdentity', feature.canonicalIdentity],
  ] as const) {
    if (value !== null && !hasWellFormedUtf16(value)) {
      throw new Error(
        `prepacked annotation features[${featureIndex}].${label} has malformed UTF-16`
      );
    }
  }
}

function writeFeatureRecord(
  view: DataView,
  featureIndex: number,
  feature: PrepackedAnnotationInteractionFeatureInputV2,
  refs: FeatureStringRefs
): void {
  const offset = featureIndex * PREPACKED_ANNOTATION_INTERACTION_FEATURE_RECORD_BYTES;
  view.setUint32(offset + RECORD.rendererId, feature.rendererId, true);
  view.setUint32(offset + RECORD.featureIndex, featureIndex, true);
  view.setBigUint64(offset + RECORD.startBp, BigInt(feature.startBp), true);
  view.setBigUint64(offset + RECORD.endBp, BigInt(feature.endBp), true);
  view.setInt32(offset + RECORD.lane, feature.lane, true);
  view.setUint32(offset + RECORD.direction, encodeDirection(feature.direction), true);
  writeStringRef(view, offset + RECORD.displayName, refs.displayName);
  writeStringRef(view, offset + RECORD.type, refs.type);
  writeStringRef(view, offset + RECORD.transcriptId, refs.transcriptId);
  writeStringRef(view, offset + RECORD.sourceId, refs.sourceId);
  writeStringRef(view, offset + RECORD.canonicalIdentity, refs.canonicalIdentity);
}

function validateFeatureRecord(
  index: PrepackedAnnotationFeatureLookupIndexV2,
  view: DataView,
  featureIndex: number
): void {
  const offset = featureIndex * PREPACKED_ANNOTATION_INTERACTION_FEATURE_RECORD_BYTES;
  if (
    view.getUint32(offset + RECORD.featureIndex, true) !== featureIndex ||
    recordEnd(view, featureIndex) <= recordStart(view, featureIndex) ||
    view.getInt32(offset + RECORD.lane, true) < 0 ||
    view.getUint32(offset + RECORD.direction, true) > 2
  ) {
    throw new Error(`prepacked annotation interaction feature record ${featureIndex} is invalid`);
  }
  validateStringRef(index, view, offset + RECORD.displayName, false);
  validateStringRef(index, view, offset + RECORD.type, false);
  validateStringRef(index, view, offset + RECORD.transcriptId, true);
  validateStringRef(index, view, offset + RECORD.sourceId, true);
  validateStringRef(index, view, offset + RECORD.canonicalIdentity, false);
}

function validateStringRef(
  index: PrepackedAnnotationFeatureLookupIndexV2,
  view: DataView,
  offset: number,
  optional: boolean
): void {
  const stringOffset = view.getUint32(offset, true);
  const length = view.getUint32(offset + UINT32_BYTES, true);
  if ((length === 0 && !optional) || stringOffset + length > index.stringBytes.byteLength) {
    throw new Error('prepacked annotation interaction string reference is invalid');
  }
}

function decodeString(
  index: PrepackedAnnotationFeatureLookupIndexV2,
  view: DataView,
  offset: number,
  optional: boolean
): string | null {
  const stringOffset = view.getUint32(offset, true);
  const length = view.getUint32(offset + UINT32_BYTES, true);
  if (length === 0) return optional ? null : '';
  return new TextDecoder().decode(index.stringBytes.subarray(stringOffset, stringOffset + length));
}

function writeStringRef(view: DataView, offset: number, ref: StringRef): void {
  view.setUint32(offset, ref.offset, true);
  view.setUint32(offset + UINT32_BYTES, ref.length, true);
}

function recordStart(view: DataView, featureIndex: number): number {
  return readUint64(
    view,
    featureIndex * PREPACKED_ANNOTATION_INTERACTION_FEATURE_RECORD_BYTES + RECORD.startBp
  );
}

function recordEnd(view: DataView, featureIndex: number): number {
  return readUint64(
    view,
    featureIndex * PREPACKED_ANNOTATION_INTERACTION_FEATURE_RECORD_BYTES + RECORD.endBp
  );
}

function readUint64(view: DataView, offset: number): number {
  const low = view.getUint32(offset, true);
  const high = view.getUint32(offset + UINT32_BYTES, true);
  const value = high * UINT32_RANGE + low;
  if (!Number.isSafeInteger(value)) {
    throw new Error('prepacked annotation interaction coordinate exceeds Number.MAX_SAFE_INTEGER');
  }
  return value;
}

function dataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function prepareViews(index: PrepackedAnnotationFeatureLookupIndexV2): PreparedInteractionViewsV2 {
  const existing = preparedViews.get(index);
  if (existing) return existing;
  const prepared = {
    featureRecords: dataView(index.featureRecordBytes),
    subtreeMaxEnds: dataView(index.intervalSubtreeMaxEndBytes),
  };
  preparedViews.set(index, prepared);
  return prepared;
}

function checkedByteLength(count: number, recordBytes: number, label: string): number {
  const byteLength = count * recordBytes;
  if (!Number.isSafeInteger(byteLength)) {
    throw new Error(`prepacked annotation interaction ${label} overflow`);
  }
  return byteLength;
}

function requireFeatureIndex(
  index: PrepackedAnnotationFeatureLookupIndexV2,
  featureIndex: number
): void {
  if (!Number.isInteger(featureIndex) || featureIndex < 0 || featureIndex >= index.featureCount) {
    throw new Error('prepacked annotation interaction featureIndex is out of range');
  }
}

function encodeDirection(direction: Direction): number {
  return direction === 'forward' ? 1 : direction === 'reverse' ? 2 : 0;
}

function decodeDirection(code: number): Direction {
  return code === 1 ? 'forward' : code === 2 ? 'reverse' : 'none';
}

function compareExactStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}
