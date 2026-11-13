export const ANNOTATION_POLICY_PROJECTION_V1 = 'annotation-policy-projection.v1' as const;
export const ANNOTATION_POLICY_FEATURE_RECORD_BYTES = 20;
export const ANNOTATION_POLICY_ABSENT_LANE = 0xffff_ffff;

const MAX_POLICY_LANE = ANNOTATION_POLICY_ABSENT_LANE - 1;
const SPACER_LANES = 1;
const FIXED_CAPACITY_EXCEPTION_TYPE = 'CDS';

const RECORD = {
  annotationTypeIndex: 0,
  expandedLane: 4,
  expandedTrackLane: 8,
  canonicalLane: 12,
  canonicalTrackLane: 16,
} as const;

export interface AnnotationPolicyProjectionFeatureInputV1 {
  annotationType: string;
  expandedLane: number;
  expandedTrackLane: number;
  canonicalLane: number | null;
  canonicalTrackLane: number | null;
}

export interface BuildAnnotationPolicyProjectionTableV1Input {
  features: ReadonlyArray<AnnotationPolicyProjectionFeatureInputV1>;
  expandedBandOrder: ReadonlyArray<string>;
  canonicalBandOrder: ReadonlyArray<string>;
}

export interface AnnotationPolicyProjectionTableV1 {
  schema: typeof ANNOTATION_POLICY_PROJECTION_V1;
  featureCount: number;
  annotationTypes: ReadonlyArray<string>;
  expandedBandTypeIndices: ReadonlyArray<number>;
  canonicalBandTypeIndices: ReadonlyArray<number>;
  featureRecordBytes: Uint8Array;
}

export interface AnnotationPolicyProjectionFeatureV1 {
  featureIndex: number;
  annotationTypeIndex: number;
  annotationType: string;
  expandedLane: number;
  expandedTrackLane: number;
  canonicalLane: number | null;
  canonicalTrackLane: number | null;
}

export type AnnotationPolicyIsoformModeV1 = 'canonical' | 'expanded';

export interface AnnotationPolicyRuntimeProjectionInputV1 {
  isoformMode: AnnotationPolicyIsoformModeV1;
  laneLimit: number | null;
}

export interface ProjectedAnnotationPolicyFeatureV1 {
  featureIndex: number;
  annotationType: string;
  lane: number;
  trackLane: number;
}

export interface ProjectedAnnotationPolicyV1 {
  features: ProjectedAnnotationPolicyFeatureV1[];
  typeFilteredCount: number;
  droppedCount: number;
}

export function buildAnnotationPolicyProjectionTableV1(
  input: BuildAnnotationPolicyProjectionTableV1Input
): AnnotationPolicyProjectionTableV1 {
  const annotationTypes = collectAnnotationTypes(input);
  const typeIndexByName = new Map(annotationTypes.map((type, index) => [type, index]));
  const expandedBandTypeIndices = mapBandOrder(
    input.expandedBandOrder,
    typeIndexByName,
    'expanded'
  );
  const canonicalBandTypeIndices = mapBandOrder(
    input.canonicalBandOrder,
    typeIndexByName,
    'canonical'
  );
  const featureRecordBytes = new Uint8Array(
    checkedMultiply(input.features.length, ANNOTATION_POLICY_FEATURE_RECORD_BYTES)
  );
  const view = new DataView(
    featureRecordBytes.buffer,
    featureRecordBytes.byteOffset,
    featureRecordBytes.byteLength
  );
  for (let featureIndex = 0; featureIndex < input.features.length; featureIndex += 1) {
    const feature = input.features[featureIndex];
    const annotationTypeIndex = typeIndexByName.get(feature.annotationType);
    if (annotationTypeIndex === undefined) {
      throw new Error(`annotation policy feature ${featureIndex} type is invalid`);
    }
    validateLanePair(feature, featureIndex);
    const offset = featureIndex * ANNOTATION_POLICY_FEATURE_RECORD_BYTES;
    view.setUint32(offset + RECORD.annotationTypeIndex, annotationTypeIndex, true);
    view.setUint32(offset + RECORD.expandedLane, feature.expandedLane, true);
    view.setUint32(offset + RECORD.expandedTrackLane, feature.expandedTrackLane, true);
    view.setUint32(
      offset + RECORD.canonicalLane,
      feature.canonicalLane ?? ANNOTATION_POLICY_ABSENT_LANE,
      true
    );
    view.setUint32(
      offset + RECORD.canonicalTrackLane,
      feature.canonicalTrackLane ?? ANNOTATION_POLICY_ABSENT_LANE,
      true
    );
  }

  const table: AnnotationPolicyProjectionTableV1 = {
    schema: ANNOTATION_POLICY_PROJECTION_V1,
    featureCount: input.features.length,
    annotationTypes,
    expandedBandTypeIndices,
    canonicalBandTypeIndices,
    featureRecordBytes,
  };
  validateAnnotationPolicyProjectionTableV1(table);
  return table;
}

export function validateAnnotationPolicyProjectionTableV1(
  table: AnnotationPolicyProjectionTableV1
): void {
  if (table?.schema !== ANNOTATION_POLICY_PROJECTION_V1) {
    throw new Error(`annotation policy schema must be ${ANNOTATION_POLICY_PROJECTION_V1}`);
  }
  if (!Number.isSafeInteger(table.featureCount) || table.featureCount < 0) {
    throw new Error('annotation policy featureCount is invalid');
  }
  if (
    !(table.featureRecordBytes instanceof Uint8Array) ||
    table.featureRecordBytes.byteLength !==
      checkedMultiply(table.featureCount, ANNOTATION_POLICY_FEATURE_RECORD_BYTES)
  ) {
    throw new Error('annotation policy feature records have an invalid length');
  }
  const types = validateAnnotationTypes(table.annotationTypes);
  validateBandIndices(table.expandedBandTypeIndices, types.length, 'expanded');
  validateBandIndices(table.canonicalBandTypeIndices, types.length, 'canonical');

  const expandedTypesWithFeatures = new Set<number>();
  const canonicalTypesWithFeatures = new Set<number>();
  for (let featureIndex = 0; featureIndex < table.featureCount; featureIndex += 1) {
    const feature = decodeAnnotationPolicyProjectionFeatureV1(table, featureIndex);
    expandedTypesWithFeatures.add(feature.annotationTypeIndex);
    validateLane(feature.expandedLane, `features[${featureIndex}].expandedLane`);
    validateLane(feature.expandedTrackLane, `features[${featureIndex}].expandedTrackLane`);
    if ((feature.canonicalLane === null) !== (feature.canonicalTrackLane === null)) {
      throw new Error(`annotation policy feature ${featureIndex} canonical membership is split`);
    }
    if (feature.canonicalLane !== null && feature.canonicalTrackLane !== null) {
      validateLane(feature.canonicalLane, `features[${featureIndex}].canonicalLane`);
      validateLane(feature.canonicalTrackLane, `features[${featureIndex}].canonicalTrackLane`);
      canonicalTypesWithFeatures.add(feature.annotationTypeIndex);
    }
  }
  requireExactBandMembership(table.expandedBandTypeIndices, expandedTypesWithFeatures, 'expanded');
  requireExactBandMembership(
    table.canonicalBandTypeIndices,
    canonicalTypesWithFeatures,
    'canonical'
  );
}

export function decodeAnnotationPolicyProjectionFeatureV1(
  table: AnnotationPolicyProjectionTableV1,
  featureIndex: number
): AnnotationPolicyProjectionFeatureV1 {
  if (
    !Number.isSafeInteger(featureIndex) ||
    featureIndex < 0 ||
    featureIndex >= table.featureCount
  ) {
    throw new Error('annotation policy featureIndex is out of range');
  }
  const view = new DataView(
    table.featureRecordBytes.buffer,
    table.featureRecordBytes.byteOffset,
    table.featureRecordBytes.byteLength
  );
  const offset = featureIndex * ANNOTATION_POLICY_FEATURE_RECORD_BYTES;
  const annotationTypeIndex = view.getUint32(offset + RECORD.annotationTypeIndex, true);
  const annotationType = table.annotationTypes[annotationTypeIndex];
  if (annotationType === undefined) {
    throw new Error(`annotation policy feature ${featureIndex} type index is invalid`);
  }
  const canonicalLane = decodeOptionalLane(view.getUint32(offset + RECORD.canonicalLane, true));
  const canonicalTrackLane = decodeOptionalLane(
    view.getUint32(offset + RECORD.canonicalTrackLane, true)
  );
  return {
    featureIndex,
    annotationTypeIndex,
    annotationType,
    expandedLane: view.getUint32(offset + RECORD.expandedLane, true),
    expandedTrackLane: view.getUint32(offset + RECORD.expandedTrackLane, true),
    canonicalLane,
    canonicalTrackLane,
  };
}

export function projectAnnotationPolicyV1(
  table: AnnotationPolicyProjectionTableV1,
  input: AnnotationPolicyRuntimeProjectionInputV1
): ProjectedAnnotationPolicyV1 {
  const features: ProjectedAnnotationPolicyFeatureV1[] = [];
  let typeFilteredCount = 0;
  visitAnnotationPolicyProjectionV1(
    table,
    input,
    (feature) => features.push(feature),
    (count) => {
      typeFilteredCount = count;
    }
  );
  return {
    features,
    typeFilteredCount,
    droppedCount: typeFilteredCount - features.length,
  };
}

export function visitAnnotationPolicyProjectionV1(
  table: AnnotationPolicyProjectionTableV1,
  input: AnnotationPolicyRuntimeProjectionInputV1,
  visit: (feature: ProjectedAnnotationPolicyFeatureV1) => void,
  reportTypeFilteredCount?: (count: number) => void
): void {
  validateRuntimeInput(input);
  const canonical = input.isoformMode === 'canonical';
  const bandOrder = canonical ? table.canonicalBandTypeIndices : table.expandedBandTypeIndices;
  const laneLimit = input.laneLimit;
  const realizedLaneCountByType = new Uint32Array(table.annotationTypes.length);
  let typeFilteredCount = 0;

  for (let featureIndex = 0; featureIndex < table.featureCount; featureIndex += 1) {
    const feature = decodeAnnotationPolicyProjectionFeatureV1(table, featureIndex);
    const trackLane = canonical ? feature.canonicalTrackLane : feature.expandedTrackLane;
    if (trackLane === null) continue;
    typeFilteredCount += 1;
    if (laneLimit !== null && trackLane >= laneLimit) continue;
    realizedLaneCountByType[feature.annotationTypeIndex] = Math.max(
      realizedLaneCountByType[feature.annotationTypeIndex],
      trackLane + 1
    );
  }
  reportTypeFilteredCount?.(typeFilteredCount);

  const laneStartByType = new Uint32Array(table.annotationTypes.length);
  if (laneLimit !== null) {
    const fixedBandCapacity = !bandOrder.some(
      (typeIndex) => table.annotationTypes[typeIndex] === FIXED_CAPACITY_EXCEPTION_TYPE
    );
    let laneCursor = 0;
    for (let bandIndex = 0; bandIndex < bandOrder.length; bandIndex += 1) {
      const typeIndex = bandOrder[bandIndex];
      laneStartByType[typeIndex] = laneCursor;
      const realizedLaneCount = realizedLaneCountByType[typeIndex];
      const laneCapacity = fixedBandCapacity ? laneLimit : realizedLaneCount;
      laneCursor = checkedLaneAdd(laneCursor, laneCapacity);
      if (laneCapacity > 0 && bandIndex < bandOrder.length - 1) {
        laneCursor = checkedLaneAdd(laneCursor, SPACER_LANES);
      }
    }
  }

  for (let featureIndex = 0; featureIndex < table.featureCount; featureIndex += 1) {
    const feature = decodeAnnotationPolicyProjectionFeatureV1(table, featureIndex);
    const uncappedLane = canonical ? feature.canonicalLane : feature.expandedLane;
    const trackLane = canonical ? feature.canonicalTrackLane : feature.expandedTrackLane;
    if (uncappedLane === null || trackLane === null) continue;
    if (laneLimit !== null && trackLane >= laneLimit) continue;
    visit({
      featureIndex,
      annotationType: feature.annotationType,
      lane:
        laneLimit === null
          ? uncappedLane
          : laneStartByType[feature.annotationTypeIndex] + trackLane,
      trackLane,
    });
  }
}

function collectAnnotationTypes(input: BuildAnnotationPolicyProjectionTableV1Input): string[] {
  const types: string[] = [];
  const seen = new Set<string>();
  for (const feature of input.features) appendType(feature.annotationType, types, seen);
  for (const type of input.expandedBandOrder) appendType(type, types, seen);
  for (const type of input.canonicalBandOrder) appendType(type, types, seen);
  return types;
}

function appendType(type: string, types: string[], seen: Set<string>): void {
  if (typeof type !== 'string' || type.length === 0 || type !== type.trim()) {
    throw new Error('annotation policy type must be a nonempty trimmed string');
  }
  if (seen.has(type)) return;
  seen.add(type);
  types.push(type);
}

function mapBandOrder(
  order: ReadonlyArray<string>,
  indexByName: ReadonlyMap<string, number>,
  label: string
): number[] {
  const result: number[] = [];
  const seen = new Set<number>();
  for (const type of order) {
    const typeIndex = indexByName.get(type);
    if (typeIndex === undefined || seen.has(typeIndex)) {
      throw new Error(`annotation policy ${label} band order is invalid`);
    }
    seen.add(typeIndex);
    result.push(typeIndex);
  }
  return result;
}

function validateLanePair(feature: AnnotationPolicyProjectionFeatureInputV1, index: number): void {
  validateLane(feature.expandedLane, `features[${index}].expandedLane`);
  validateLane(feature.expandedTrackLane, `features[${index}].expandedTrackLane`);
  if ((feature.canonicalLane === null) !== (feature.canonicalTrackLane === null)) {
    throw new Error(`annotation policy feature ${index} canonical membership is split`);
  }
  if (feature.canonicalLane !== null && feature.canonicalTrackLane !== null) {
    validateLane(feature.canonicalLane, `features[${index}].canonicalLane`);
    validateLane(feature.canonicalTrackLane, `features[${index}].canonicalTrackLane`);
  }
}

function validateLane(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_POLICY_LANE) {
    throw new Error(`annotation policy ${label} is invalid`);
  }
}

function decodeOptionalLane(value: number): number | null {
  return value === ANNOTATION_POLICY_ABSENT_LANE ? null : value;
}

function validateAnnotationTypes(types: ReadonlyArray<string>): string[] {
  if (!Array.isArray(types)) throw new Error('annotation policy types are invalid');
  const result: string[] = [];
  const seen = new Set<string>();
  for (const type of types) {
    if (typeof type !== 'string' || type.length === 0 || type !== type.trim()) {
      throw new Error('annotation policy type must be a nonempty trimmed string');
    }
    if (seen.has(type)) throw new Error('annotation policy types are duplicated');
    seen.add(type);
    result.push(type);
  }
  return result;
}

function validateBandIndices(
  indices: ReadonlyArray<number>,
  typeCount: number,
  label: string
): void {
  if (!Array.isArray(indices) && !(indices instanceof Uint32Array)) {
    throw new Error(`annotation policy ${label} band indices are invalid`);
  }
  const seen = new Set<number>();
  for (const index of indices) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= typeCount || seen.has(index)) {
      throw new Error(`annotation policy ${label} band indices are invalid`);
    }
    seen.add(index);
  }
}

function requireExactBandMembership(
  bandIndices: ReadonlyArray<number>,
  featureTypes: ReadonlySet<number>,
  label: string
): void {
  if (
    bandIndices.length !== featureTypes.size ||
    bandIndices.some((typeIndex) => !featureTypes.has(typeIndex))
  ) {
    throw new Error(`annotation policy ${label} band membership is not exact`);
  }
}

function validateRuntimeInput(input: AnnotationPolicyRuntimeProjectionInputV1): void {
  if (input.isoformMode !== 'canonical' && input.isoformMode !== 'expanded') {
    throw new Error('annotation policy isoform mode is invalid');
  }
  if (
    input.laneLimit !== null &&
    (!Number.isSafeInteger(input.laneLimit) ||
      input.laneLimit <= 0 ||
      input.laneLimit > MAX_POLICY_LANE)
  ) {
    throw new Error('annotation policy lane limit is invalid');
  }
}

function checkedMultiply(left: number, right: number): number {
  const value = left * right;
  if (!Number.isSafeInteger(value)) throw new Error('annotation policy byte length overflows');
  return value;
}

function checkedLaneAdd(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value > MAX_POLICY_LANE) {
    throw new Error('annotation policy projected lane overflows');
  }
  return value;
}
