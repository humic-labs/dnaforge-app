export const ANNOTATION_CANONICAL_IDENTITY_V2 = 'annotation.v2' as const;

export type AnnotationCanonicalDirectionV2 = 'forward' | 'reverse' | 'none';

export interface AnnotationCanonicalIdentityV2Input {
  readonly genomeIdentity: string;
  readonly sourceId: string;
  readonly transcriptId: string | null;
  readonly trackId: string;
  readonly type: string;
  readonly startBp: number;
  readonly endBp: number;
  readonly direction: AnnotationCanonicalDirectionV2;
}

const INPUT_KEYS = new Set<PropertyKey>([
  'genomeIdentity',
  'sourceId',
  'transcriptId',
  'trackId',
  'type',
  'startBp',
  'endBp',
  'direction',
]);

export function annotationCanonicalIdentityV2(input: AnnotationCanonicalIdentityV2Input): string {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('annotation canonical identity input must be an object');
  }
  const unexpectedKeys = Reflect.ownKeys(input).filter((key) => !INPUT_KEYS.has(key));
  if (unexpectedKeys.length > 0) {
    throw new Error(
      `annotation canonical identity contains unsupported input: ${unexpectedKeys
        .map(String)
        .join(', ')}`
    );
  }

  validateRequiredIdentity(input.genomeIdentity, 'genomeIdentity');
  validateRequiredIdentity(input.sourceId, 'sourceId');
  validateRequiredIdentity(input.trackId, 'trackId');
  validateRequiredIdentity(input.type, 'type');
  if (input.transcriptId !== null) {
    validateRequiredIdentity(input.transcriptId, 'transcriptId');
  }
  if (
    !Number.isSafeInteger(input.startBp) ||
    !Number.isSafeInteger(input.endBp) ||
    input.startBp < 0 ||
    input.endBp <= input.startBp
  ) {
    throw new Error('annotation canonical identity coordinates must be a safe half-open range');
  }
  if (
    input.direction !== 'forward' &&
    input.direction !== 'reverse' &&
    input.direction !== 'none'
  ) {
    throw new Error('annotation canonical identity direction is invalid');
  }

  return JSON.stringify([
    ANNOTATION_CANONICAL_IDENTITY_V2,
    input.genomeIdentity,
    input.sourceId,
    input.transcriptId,
    input.trackId,
    input.type,
    input.startBp,
    input.endBp,
    input.direction,
  ]);
}

function validateRequiredIdentity(value: string, field: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`annotation canonical identity ${field} must be a nonempty string`);
  }
  if (!hasWellFormedUtf16(value)) {
    throw new Error(`annotation canonical identity ${field} has malformed UTF-16`);
  }
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
