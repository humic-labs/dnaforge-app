export const ALIGNED_READ_SOURCE_GENERATION_V1 = 'aligned-read-source-generation.v1' as const;
export const ALIGNED_READ_REFERENCE_GENERATION_V1 = 'aligned-read-reference-generation.v1' as const;

export interface AlignedReadFileGenerationV1 {
  readonly canonicalPath: string;
  readonly size: number;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
  readonly device?: string;
  readonly inode?: string;
}

export interface AlignedReadSourceGenerationV1 {
  readonly contract: typeof ALIGNED_READ_SOURCE_GENERATION_V1;
  readonly alignment: AlignedReadFileGenerationV1;
  readonly index: AlignedReadFileGenerationV1;
  readonly reference?: AlignedReadFileGenerationV1;
  readonly referenceIndex?: AlignedReadFileGenerationV1;
}

export interface AlignedReadReferenceGenerationV1 {
  readonly contract: typeof ALIGNED_READ_REFERENCE_GENERATION_V1;
  readonly reference: AlignedReadFileGenerationV1;
  readonly referenceIndex: AlignedReadFileGenerationV1;
}

export function isAlignedReadSourceGeneration(
  value: unknown
): value is AlignedReadSourceGenerationV1 {
  if (!isRecord(value) || value.contract !== ALIGNED_READ_SOURCE_GENERATION_V1) return false;
  if (!isFileGeneration(value.alignment) || !isFileGeneration(value.index)) return false;
  const hasReference = value.reference !== undefined;
  const hasReferenceIndex = value.referenceIndex !== undefined;
  if (hasReference !== hasReferenceIndex) return false;
  return (
    (!hasReference && !hasReferenceIndex) ||
    (isFileGeneration(value.reference) && isFileGeneration(value.referenceIndex))
  );
}

export function isAlignedReadReferenceGeneration(
  value: unknown
): value is AlignedReadReferenceGenerationV1 {
  return (
    isRecord(value) &&
    value.contract === ALIGNED_READ_REFERENCE_GENERATION_V1 &&
    isFileGeneration(value.reference) &&
    isFileGeneration(value.referenceIndex)
  );
}

export function alignedReadSourceGenerationsEqual(
  left: AlignedReadSourceGenerationV1 | undefined,
  right: AlignedReadSourceGenerationV1 | undefined
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    fileGenerationsEqual(left.alignment, right.alignment) &&
    fileGenerationsEqual(left.index, right.index) &&
    optionalFileGenerationsEqual(left.reference, right.reference) &&
    optionalFileGenerationsEqual(left.referenceIndex, right.referenceIndex)
  );
}

export function alignedReadReferenceGenerationsEqual(
  left: AlignedReadReferenceGenerationV1 | undefined,
  right: AlignedReadReferenceGenerationV1 | undefined
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    fileGenerationsEqual(left.reference, right.reference) &&
    fileGenerationsEqual(left.referenceIndex, right.referenceIndex)
  );
}

export function alignedReadSourceGenerationKey(
  value: AlignedReadSourceGenerationV1 | undefined
): string {
  if (!value) return '';
  return [
    value.contract,
    fileGenerationKey(value.alignment),
    fileGenerationKey(value.index),
    value.reference ? fileGenerationKey(value.reference) : '',
    value.referenceIndex ? fileGenerationKey(value.referenceIndex) : '',
  ].join('\u0001');
}

export function alignedReadReferenceGenerationKey(
  value: AlignedReadReferenceGenerationV1 | undefined
): string {
  if (!value) return '';
  return [
    value.contract,
    fileGenerationKey(value.reference),
    fileGenerationKey(value.referenceIndex),
  ].join('\u0001');
}

function isFileGeneration(value: unknown): value is AlignedReadFileGenerationV1 {
  if (!isRecord(value)) return false;
  return (
    typeof value.canonicalPath === 'string' &&
    value.canonicalPath.length > 0 &&
    typeof value.size === 'number' &&
    Number.isSafeInteger(value.size) &&
    value.size >= 0 &&
    isDecimalInteger(value.mtimeNs) &&
    isDecimalInteger(value.ctimeNs) &&
    (value.device === undefined || isDecimalInteger(value.device)) &&
    (value.inode === undefined || isDecimalInteger(value.inode))
  );
}

function isDecimalInteger(value: unknown): value is string {
  return typeof value === 'string' && /^\d+$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function optionalFileGenerationsEqual(
  left: AlignedReadFileGenerationV1 | undefined,
  right: AlignedReadFileGenerationV1 | undefined
): boolean {
  if (left === right) return true;
  return Boolean(left && right && fileGenerationsEqual(left, right));
}

function fileGenerationsEqual(
  left: AlignedReadFileGenerationV1,
  right: AlignedReadFileGenerationV1
): boolean {
  return (
    left.canonicalPath === right.canonicalPath &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.device === right.device &&
    left.inode === right.inode
  );
}

function fileGenerationKey(value: AlignedReadFileGenerationV1): string {
  return [
    value.canonicalPath,
    value.size,
    value.mtimeNs,
    value.ctimeNs,
    value.device ?? '',
    value.inode ?? '',
  ].join('\u0000');
}
