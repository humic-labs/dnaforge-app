export const ANNOTATION_SCENE_BINARY_V1 = 'annotation-scene-binary.v1' as const;
export const ANNOTATION_SCENE_PRIMITIVE_RECORD_BYTES = 40;
const FEATURE_FAMILY_RECORD_BYTES = Uint32Array.BYTES_PER_ELEMENT;
const MAX_UINT32 = 0xffff_ffff;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export type AnnotationSceneJsonValue =
  | null
  | boolean
  | number
  | string
  | AnnotationSceneJsonValue[]
  | { [key: string]: AnnotationSceneJsonValue };

export interface AnnotationShapeFamilyV1 {
  id: string;
  kind: 'transcript' | 'source-shape';
  metadata: AnnotationSceneJsonValue;
}

export interface AnnotationScenePrimitiveV1 {
  startBp: number;
  endBp: number;
  featureIndex: number;
  offsetCenter: number;
  halfH: number;
  color: number;
  alpha: number;
  cdsFade: number;
  dirSign: 0 | 1 | -1;
  roleIndex?: number;
}

export interface AnnotationSceneDatasetContractV1 {
  datasetId: string;
  datasetVersion: string;
  sourceSha256: string;
}

export interface AnnotationSceneAssemblyContractV1 {
  assemblyId: string;
  assemblyLengthBp: number;
}

export interface AnnotationSceneGeometryContractV1 {
  geometryId: 'retained-linear-directional-block.v1';
  coordinateSpace: 'assembly-global-bp';
  coordinateSystem: 'zero-based-half-open';
  coordinateEncoding: 'uint64-le-number-safe';
  floatEncoding: 'float32-le';
  colorEncoding: 'rgb24-with-direction-byte';
  primitiveRecordBytes: 40;
}

interface AnnotationSceneSectionV1 {
  byteOffset: number;
  byteLength: number;
  count: number;
  recordBytes: number;
}

export interface AnnotationSceneBinaryManifestV1 {
  schema: typeof ANNOTATION_SCENE_BINARY_V1;
  datasetContract: AnnotationSceneDatasetContractV1;
  assemblyContract: AnnotationSceneAssemblyContractV1;
  geometryContract: AnnotationSceneGeometryContractV1;
  families: AnnotationShapeFamilyV1[];
  sections: {
    primitives: AnnotationSceneSectionV1;
    featureFamilies: AnnotationSceneSectionV1;
  };
  byteLength: number;
  integrity: {
    algorithm: 'sha256';
    payloadSha256: string;
    contractSha256: string;
  };
}

export interface PackAnnotationSceneBinaryV1Input {
  datasetContract: AnnotationSceneDatasetContractV1;
  assemblyContract: AnnotationSceneAssemblyContractV1;
  families: ReadonlyArray<AnnotationShapeFamilyV1>;
  featureFamilyIndices: ArrayLike<number>;
  primitives: ReadonlyArray<AnnotationScenePrimitiveV1>;
}

export interface PackedAnnotationSceneBinaryV1 {
  manifest: AnnotationSceneBinaryManifestV1;
  payload: Uint8Array;
}

export interface UnpackedAnnotationSceneBinaryV1 {
  primitives: AnnotationScenePrimitiveV1[];
  featureFamilyIndices: Uint32Array;
  families: AnnotationShapeFamilyV1[];
}

const GEOMETRY_CONTRACT: AnnotationSceneGeometryContractV1 = {
  geometryId: 'retained-linear-directional-block.v1',
  coordinateSpace: 'assembly-global-bp',
  coordinateSystem: 'zero-based-half-open',
  coordinateEncoding: 'uint64-le-number-safe',
  floatEncoding: 'float32-le',
  colorEncoding: 'rgb24-with-direction-byte',
  primitiveRecordBytes: 40,
};

const PRIMITIVE_OFFSETS = {
  startBp: 0,
  endBp: 8,
  featureIndex: 16,
  offsetCenter: 20,
  halfH: 24,
  colorAndDirection: 28,
  alpha: 32,
  cdsFade: 36,
} as const;

export async function packAnnotationSceneBinaryV1(
  input: PackAnnotationSceneBinaryV1Input
): Promise<PackedAnnotationSceneBinaryV1> {
  validateDatasetContract(input.datasetContract);
  validateAssemblyContract(input.assemblyContract);
  const families = normalizeFamilies(input.families);
  const featureFamilyIndices = normalizeFeatureFamilies(
    input.featureFamilyIndices,
    families.length
  );
  validatePrimitives(
    input.primitives,
    featureFamilyIndices.length,
    input.assemblyContract.assemblyLengthBp
  );

  const primitiveBytes = checkedSectionByteLength(
    input.primitives.length,
    ANNOTATION_SCENE_PRIMITIVE_RECORD_BYTES,
    'primitives'
  );
  const featureFamilyBytes = checkedSectionByteLength(
    featureFamilyIndices.length,
    FEATURE_FAMILY_RECORD_BYTES,
    'feature families'
  );
  const byteLength = primitiveBytes + featureFamilyBytes;
  if (!Number.isSafeInteger(byteLength)) throw new Error('annotation scene byteLength overflow');

  const payload = new Uint8Array(byteLength);
  const view = new DataView(payload.buffer);
  for (let i = 0; i < input.primitives.length; i++) {
    writePrimitive(view, i * ANNOTATION_SCENE_PRIMITIVE_RECORD_BYTES, input.primitives[i]);
  }
  for (let i = 0; i < featureFamilyIndices.length; i++) {
    view.setUint32(primitiveBytes + i * FEATURE_FAMILY_RECORD_BYTES, featureFamilyIndices[i], true);
  }

  const manifest: AnnotationSceneBinaryManifestV1 = {
    schema: ANNOTATION_SCENE_BINARY_V1,
    datasetContract: { ...input.datasetContract },
    assemblyContract: { ...input.assemblyContract },
    geometryContract: { ...GEOMETRY_CONTRACT },
    families,
    sections: {
      primitives: {
        byteOffset: 0,
        byteLength: primitiveBytes,
        count: input.primitives.length,
        recordBytes: ANNOTATION_SCENE_PRIMITIVE_RECORD_BYTES,
      },
      featureFamilies: {
        byteOffset: primitiveBytes,
        byteLength: featureFamilyBytes,
        count: featureFamilyIndices.length,
        recordBytes: FEATURE_FAMILY_RECORD_BYTES,
      },
    },
    byteLength,
    integrity: {
      algorithm: 'sha256',
      payloadSha256: '',
      contractSha256: '',
    },
  };
  manifest.integrity.payloadSha256 = await sha256Hex(payload);
  manifest.integrity.contractSha256 = await hashManifestContract(manifest);
  return { manifest, payload };
}

export async function validateAnnotationSceneBinaryV1(
  manifest: AnnotationSceneBinaryManifestV1,
  payload: Uint8Array
): Promise<void> {
  validateManifestStructure(manifest, payload.byteLength);

  const payloadHash = await sha256Hex(payload);
  if (payloadHash !== manifest.integrity.payloadSha256) {
    throw new Error('annotation scene payload sha256 mismatch');
  }
  const contractHash = await hashManifestContract(manifest);
  if (contractHash !== manifest.integrity.contractSha256) {
    throw new Error('annotation scene contract sha256 mismatch');
  }

  validatePayloadSemantics(manifest, payload);
}

export async function unpackAnnotationSceneBinaryV1(
  manifest: AnnotationSceneBinaryManifestV1,
  payload: Uint8Array
): Promise<UnpackedAnnotationSceneBinaryV1> {
  await validateAnnotationSceneBinaryV1(manifest, payload);
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const primitives = new Array<AnnotationScenePrimitiveV1>(manifest.sections.primitives.count);
  for (let i = 0; i < primitives.length; i++) {
    primitives[i] = readPrimitive(
      view,
      manifest.sections.primitives.byteOffset + i * ANNOTATION_SCENE_PRIMITIVE_RECORD_BYTES
    );
  }
  const featureFamilyIndices = new Uint32Array(manifest.sections.featureFamilies.count);
  for (let i = 0; i < featureFamilyIndices.length; i++) {
    featureFamilyIndices[i] = view.getUint32(
      manifest.sections.featureFamilies.byteOffset + i * FEATURE_FAMILY_RECORD_BYTES,
      true
    );
  }
  return {
    primitives,
    featureFamilyIndices,
    families: normalizeFamilies(manifest.families),
  };
}

function validateManifestStructure(
  manifest: AnnotationSceneBinaryManifestV1,
  payloadByteLength: number
): void {
  if (!manifest || manifest.schema !== ANNOTATION_SCENE_BINARY_V1) {
    throw new Error(`annotation scene schema must be ${ANNOTATION_SCENE_BINARY_V1}`);
  }
  validateDatasetContract(manifest.datasetContract);
  validateAssemblyContract(manifest.assemblyContract);
  validateGeometryContract(manifest.geometryContract);
  normalizeFamilies(manifest.families);
  if (manifest.integrity?.algorithm !== 'sha256') {
    throw new Error('annotation scene integrity algorithm must be sha256');
  }
  if (!SHA256_HEX.test(manifest.integrity.payloadSha256)) {
    throw new Error('annotation scene payloadSha256 must be lowercase sha256 hex');
  }
  if (!SHA256_HEX.test(manifest.integrity.contractSha256)) {
    throw new Error('annotation scene contractSha256 must be lowercase sha256 hex');
  }

  const primitives = manifest.sections?.primitives;
  const featureFamilies = manifest.sections?.featureFamilies;
  validateSection(primitives, ANNOTATION_SCENE_PRIMITIVE_RECORD_BYTES, 'primitive');
  validateSection(featureFamilies, FEATURE_FAMILY_RECORD_BYTES, 'feature-family');
  if (primitives.byteOffset !== 0) {
    throw new Error('annotation scene primitive section must begin at byte 0');
  }
  if (featureFamilies.byteOffset !== primitives.byteOffset + primitives.byteLength) {
    throw new Error('annotation scene feature-family section must immediately follow primitives');
  }
  const expectedByteLength = featureFamilies.byteOffset + featureFamilies.byteLength;
  if (
    !Number.isSafeInteger(expectedByteLength) ||
    !Number.isSafeInteger(manifest.byteLength) ||
    manifest.byteLength !== expectedByteLength ||
    payloadByteLength !== expectedByteLength
  ) {
    throw new Error('annotation scene payload byteLength does not match contiguous sections');
  }
}

function validateGeometryContract(contract: AnnotationSceneGeometryContractV1): void {
  if (contract?.geometryId !== GEOMETRY_CONTRACT.geometryId) {
    throw new Error('annotation scene geometry id is unsupported');
  }
  if (contract.coordinateSpace !== GEOMETRY_CONTRACT.coordinateSpace) {
    throw new Error('annotation scene geometry coordinate space is unsupported');
  }
  if (contract.coordinateSystem !== GEOMETRY_CONTRACT.coordinateSystem) {
    throw new Error('annotation scene geometry coordinate system is unsupported');
  }
  if (contract.coordinateEncoding !== GEOMETRY_CONTRACT.coordinateEncoding) {
    throw new Error('annotation scene geometry coordinate encoding is unsupported');
  }
  if (contract.floatEncoding !== GEOMETRY_CONTRACT.floatEncoding) {
    throw new Error('annotation scene geometry float encoding is unsupported');
  }
  if (contract.colorEncoding !== GEOMETRY_CONTRACT.colorEncoding) {
    throw new Error('annotation scene geometry color encoding is unsupported');
  }
  if (contract.primitiveRecordBytes !== ANNOTATION_SCENE_PRIMITIVE_RECORD_BYTES) {
    throw new Error('annotation scene geometry primitive record size is unsupported');
  }
}

function validateDatasetContract(contract: AnnotationSceneDatasetContractV1): void {
  requireNonEmptyString(contract?.datasetId, 'datasetId');
  requireNonEmptyString(contract?.datasetVersion, 'datasetVersion');
  if (!SHA256_HEX.test(contract?.sourceSha256 ?? '')) {
    throw new Error('annotation scene sourceSha256 must be lowercase sha256 hex');
  }
}

function validateAssemblyContract(contract: AnnotationSceneAssemblyContractV1): void {
  requireNonEmptyString(contract?.assemblyId, 'assemblyId');
  if (
    !Number.isInteger(contract?.assemblyLengthBp) ||
    contract.assemblyLengthBp <= 0 ||
    contract.assemblyLengthBp > Number.MAX_SAFE_INTEGER
  ) {
    throw new Error(
      'annotation scene assemblyLengthBp must be an integer in [1, Number.MAX_SAFE_INTEGER]'
    );
  }
}

function validateSection(
  section: AnnotationSceneSectionV1,
  expectedRecordBytes: number,
  label: string
): void {
  if (!section) throw new Error(`annotation scene ${label} section is missing`);
  for (const [field, value] of Object.entries({
    byteOffset: section.byteOffset,
    byteLength: section.byteLength,
    count: section.count,
    recordBytes: section.recordBytes,
  })) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`annotation scene ${label} section ${field} is invalid`);
    }
  }
  if (section.recordBytes !== expectedRecordBytes) {
    throw new Error(`annotation scene ${label} record size is invalid`);
  }
  if (section.byteLength !== section.count * section.recordBytes) {
    throw new Error(`annotation scene ${label} section byteLength/count mismatch`);
  }
}

function normalizeFamilies(
  families: ReadonlyArray<AnnotationShapeFamilyV1>
): AnnotationShapeFamilyV1[] {
  if (!Array.isArray(families) || families.length === 0) {
    throw new Error('annotation scene families must contain at least one family');
  }
  if (families.length > MAX_UINT32) {
    throw new Error('annotation scene family count exceeds uint32');
  }
  const ids = new Set<string>();
  return families.map((family, index) => {
    requireNonEmptyString(family?.id, `families[${index}].id`);
    if (ids.has(family.id)) throw new Error(`annotation scene duplicate family id ${family.id}`);
    ids.add(family.id);
    if (family.kind !== 'transcript' && family.kind !== 'source-shape') {
      throw new Error(`annotation scene families[${index}].kind is unsupported`);
    }
    return {
      id: family.id,
      kind: family.kind,
      metadata: normalizeJson(family.metadata, `families[${index}].metadata`, new Set()),
    };
  });
}

function normalizeFeatureFamilies(indices: ArrayLike<number>, familyCount: number): Uint32Array {
  const length = indices?.length;
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new Error('annotation scene featureFamilyIndices length is invalid');
  }
  if (length > MAX_UINT32) {
    throw new Error('annotation scene feature count exceeds uint32');
  }
  const normalized = new Uint32Array(length);
  for (let i = 0; i < length; i++) {
    const value = indices[i];
    if (!Number.isInteger(value) || value < 0 || value >= familyCount) {
      throw new Error(`annotation scene featureFamilyIndices[${i}] is out of range`);
    }
    normalized[i] = value;
  }
  return normalized;
}

function validatePrimitives(
  primitives: ReadonlyArray<AnnotationScenePrimitiveV1>,
  featureCount: number,
  assemblyLengthBp: number
): void {
  if (!Array.isArray(primitives)) throw new Error('annotation scene primitives must be an array');
  for (let i = 0; i < primitives.length; i++) {
    validatePrimitive(primitives[i], i, featureCount, assemblyLengthBp);
  }
}

function validatePrimitive(
  primitive: AnnotationScenePrimitiveV1,
  index: number,
  featureCount: number,
  assemblyLengthBp: number
): void {
  validateCoordinate(primitive.startBp, `primitives[${index}].startBp`, assemblyLengthBp, false);
  validateCoordinate(primitive.endBp, `primitives[${index}].endBp`, assemblyLengthBp, true);
  if (primitive.endBp <= primitive.startBp) {
    throw new Error(`annotation scene primitives[${index}] must have endBp > startBp`);
  }
  if (
    !Number.isInteger(primitive.featureIndex) ||
    primitive.featureIndex < 0 ||
    primitive.featureIndex > MAX_UINT32 ||
    primitive.featureIndex >= featureCount
  ) {
    throw new Error(`annotation scene primitives[${index}].featureIndex is out of range`);
  }
  validateFiniteFloat(primitive.offsetCenter, `primitives[${index}].offsetCenter`);
  validateFiniteFloat(primitive.halfH, `primitives[${index}].halfH`);
  if (primitive.halfH < 0)
    throw new Error(`annotation scene primitives[${index}].halfH is negative`);
  if (!Number.isInteger(primitive.color) || primitive.color < 0 || primitive.color > 0xff_ffff) {
    throw new Error(`annotation scene primitives[${index}].color is not rgb24`);
  }
  validateUnitFloat(primitive.alpha, `primitives[${index}].alpha`);
  validateUnitFloat(primitive.cdsFade, `primitives[${index}].cdsFade`);
  if (primitive.dirSign !== -1 && primitive.dirSign !== 0 && primitive.dirSign !== 1) {
    throw new Error(`annotation scene primitives[${index}].dirSign is invalid`);
  }
}

function validatePayloadSemantics(
  manifest: AnnotationSceneBinaryManifestV1,
  payload: Uint8Array
): void {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const primitiveSection = manifest.sections.primitives;
  for (let i = 0; i < primitiveSection.count; i++) {
    const primitive = readPrimitive(
      view,
      primitiveSection.byteOffset + i * ANNOTATION_SCENE_PRIMITIVE_RECORD_BYTES
    );
    validatePrimitive(
      primitive,
      i,
      manifest.sections.featureFamilies.count,
      manifest.assemblyContract.assemblyLengthBp
    );
  }
  const familySection = manifest.sections.featureFamilies;
  for (let i = 0; i < familySection.count; i++) {
    const familyIndex = view.getUint32(
      familySection.byteOffset + i * FEATURE_FAMILY_RECORD_BYTES,
      true
    );
    if (familyIndex >= manifest.families.length) {
      throw new Error(`annotation scene featureFamilyIndices[${i}] is out of range`);
    }
  }
}

function writePrimitive(
  view: DataView,
  offset: number,
  primitive: AnnotationScenePrimitiveV1
): void {
  view.setBigUint64(offset + PRIMITIVE_OFFSETS.startBp, BigInt(primitive.startBp), true);
  view.setBigUint64(offset + PRIMITIVE_OFFSETS.endBp, BigInt(primitive.endBp), true);
  view.setUint32(offset + PRIMITIVE_OFFSETS.featureIndex, primitive.featureIndex, true);
  view.setFloat32(offset + PRIMITIVE_OFFSETS.offsetCenter, primitive.offsetCenter, true);
  view.setFloat32(offset + PRIMITIVE_OFFSETS.halfH, primitive.halfH, true);
  const directionCode = primitive.dirSign === 1 ? 1 : primitive.dirSign === -1 ? 2 : 0;
  view.setUint32(
    offset + PRIMITIVE_OFFSETS.colorAndDirection,
    ((directionCode << 24) | primitive.color) >>> 0,
    true
  );
  view.setFloat32(offset + PRIMITIVE_OFFSETS.alpha, primitive.alpha, true);
  view.setFloat32(offset + PRIMITIVE_OFFSETS.cdsFade, primitive.cdsFade, true);
}

function readPrimitive(view: DataView, offset: number): AnnotationScenePrimitiveV1 {
  const startBp = uint64ToSafeNumber(
    view.getBigUint64(offset + PRIMITIVE_OFFSETS.startBp, true),
    'startBp'
  );
  const endBp = uint64ToSafeNumber(
    view.getBigUint64(offset + PRIMITIVE_OFFSETS.endBp, true),
    'endBp'
  );
  const colorAndDirection = view.getUint32(offset + PRIMITIVE_OFFSETS.colorAndDirection, true);
  const directionCode = colorAndDirection >>> 24;
  if (directionCode > 2) throw new Error('annotation scene primitive direction byte is invalid');
  return {
    startBp,
    endBp,
    featureIndex: view.getUint32(offset + PRIMITIVE_OFFSETS.featureIndex, true),
    offsetCenter: view.getFloat32(offset + PRIMITIVE_OFFSETS.offsetCenter, true),
    halfH: view.getFloat32(offset + PRIMITIVE_OFFSETS.halfH, true),
    color: colorAndDirection & 0xff_ffff,
    alpha: view.getFloat32(offset + PRIMITIVE_OFFSETS.alpha, true),
    cdsFade: view.getFloat32(offset + PRIMITIVE_OFFSETS.cdsFade, true),
    dirSign: directionCode === 1 ? 1 : directionCode === 2 ? -1 : 0,
  };
}

function validateCoordinate(
  value: number,
  label: string,
  assemblyLengthBp: number,
  allowAssemblyEnd: boolean
): void {
  const max = allowAssemblyEnd ? assemblyLengthBp : assemblyLengthBp - 1;
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new Error(`annotation scene ${label} is outside the assembly coordinate contract`);
  }
}

function uint64ToSafeNumber(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`annotation scene primitive ${label} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return Number(value);
}

function validateFiniteFloat(value: number, label: string): void {
  if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value))) {
    throw new Error(`annotation scene ${label} is not finite float32`);
  }
}

function validateUnitFloat(value: number, label: string): void {
  validateFiniteFloat(value, label);
  if (value < 0 || value > 1) throw new Error(`annotation scene ${label} is outside [0,1]`);
}

function checkedSectionByteLength(count: number, recordBytes: number, label: string): number {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`annotation scene ${label} count is invalid`);
  }
  const bytes = count * recordBytes;
  if (!Number.isSafeInteger(bytes))
    throw new Error(`annotation scene ${label} byteLength overflow`);
  return bytes;
}

function requireNonEmptyString(value: string, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`annotation scene ${label} must be a non-empty string`);
  }
}

function normalizeJson(
  value: unknown,
  path: string,
  ancestors: Set<object>
): AnnotationSceneJsonValue {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new Error(`annotation scene ${path} must use finite JSON number`);
    return value;
  }
  if (typeof value !== 'object') {
    throw new Error(`annotation scene ${path} is not JSON-safe`);
  }
  if (ancestors.has(value)) throw new Error(`annotation scene ${path} contains a cycle`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) => normalizeJson(entry, `${path}[${index}]`, ancestors));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`annotation scene ${path} must use a plain JSON object`);
    }
    const result: { [key: string]: AnnotationSceneJsonValue } = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      result[key] = normalizeJson(
        (value as Record<string, unknown>)[key],
        `${path}.${key}`,
        ancestors
      );
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function canonicalJson(value: AnnotationSceneJsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

function manifestContractMaterial(
  manifest: AnnotationSceneBinaryManifestV1
): AnnotationSceneJsonValue {
  return normalizeJson(
    {
      schema: manifest.schema,
      datasetContract: manifest.datasetContract,
      assemblyContract: manifest.assemblyContract,
      geometryContract: manifest.geometryContract,
      families: manifest.families,
      sections: manifest.sections,
      byteLength: manifest.byteLength,
    },
    'manifest',
    new Set()
  );
}

async function hashManifestContract(manifest: AnnotationSceneBinaryManifestV1): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalJson(manifestContractMaterial(manifest))));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('annotation scene sha256 is unavailable');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
