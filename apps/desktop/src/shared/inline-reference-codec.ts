import {
  INLINE_REFERENCE_ENTITY_TYPES,
  type InlineReferenceDeclaration,
  type InlineReferenceFailureCode,
} from './inline-reference-declaration';
import { savedReferenceHref, savedReferenceIdFromHref } from './saved-reference-url';
import {
  molecularDocumentReferenceFromHref,
  molecularDocumentReferenceHref,
} from './molecular-document-reference';

export const INLINE_REFERENCE_SCHEME = 'dnaforge-chat';
export const MAX_INLINE_REFERENCE_URI_BYTES = 2_048;
export const MAX_INLINE_REFERENCE_SEGMENTS = 64;
export const MAX_INLINE_REFERENCE_SEGMENT_BYTES = 255;
export const MAX_INLINE_REFERENCE_LABEL_SCALARS = 200;
export const MAX_INLINE_REFERENCES_PER_MESSAGE = 8;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENCODED_SEPARATOR_PATTERN = /%(?:2f|5c)/i;

export type InlineReferenceDecodeResult =
  | { ok: true; declaration: InlineReferenceDeclaration }
  | { ok: false; code: InlineReferenceFailureCode };

type SegmentDecodeResult =
  | { ok: true; value: string }
  | { ok: false; code: InlineReferenceFailureCode };

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function decodeSegment(raw: string): SegmentDecodeResult {
  if (raw.length === 0) return { ok: false, code: 'empty-segment' };
  if (raw.includes('\\') || ENCODED_SEPARATOR_PATTERN.test(raw)) {
    return { ok: false, code: 'unsafe-segment' };
  }

  let value: string;
  try {
    value = decodeURIComponent(raw);
  } catch {
    return { ok: false, code: 'invalid-encoding' };
  }

  if (
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    hasControlCharacter(value)
  ) {
    return { ok: false, code: value.length === 0 ? 'empty-segment' : 'unsafe-segment' };
  }
  if (byteLength(value) > MAX_INLINE_REFERENCE_SEGMENT_BYTES) {
    return { ok: false, code: 'segment-too-long' };
  }
  return { ok: true, value };
}

function decodeSegments(
  rawPath: string
): { ok: true; values: string[] } | { ok: false; code: InlineReferenceFailureCode } {
  const rawSegments = rawPath.split('/');
  if (rawSegments.length > MAX_INLINE_REFERENCE_SEGMENTS) {
    return { ok: false, code: 'invalid-shape' };
  }

  const values: string[] = [];
  for (const rawSegment of rawSegments) {
    const decoded = decodeSegment(rawSegment);
    if (!decoded.ok) return decoded;
    values.push(decoded.value);
  }
  return { ok: true, values };
}

export function decodeInlineReferenceUrl(url: string): InlineReferenceDecodeResult {
  if (byteLength(url) > MAX_INLINE_REFERENCE_URI_BYTES) {
    return { ok: false, code: 'uri-too-long' };
  }
  const document = molecularDocumentReferenceFromHref(url);
  if (document && url.startsWith(`${INLINE_REFERENCE_SCHEME}://`))
    return { ok: true, declaration: { kind: 'molecular-document', document } };
  const prefix = `${INLINE_REFERENCE_SCHEME}://`;
  if (!url.startsWith(prefix)) return { ok: false, code: 'invalid-scheme' };
  if (url.includes('?') || url.includes('#')) return { ok: false, code: 'invalid-shape' };

  const body = url.slice(prefix.length);
  const separator = body.indexOf('/');
  if (separator <= 0 || body.includes('@')) return { ok: false, code: 'invalid-shape' };

  const authority = body.slice(0, separator);
  const rawPath = body.slice(separator + 1);
  const segments = decodeSegments(rawPath);
  if (!segments.ok) return segments;

  if (authority === 'reference') {
    if (segments.values.length !== 1 || !UUID_PATTERN.test(segments.values[0])) {
      return { ok: false, code: 'invalid-reference-id' };
    }
    return {
      ok: true,
      declaration: {
        kind: 'existing-reference',
        referenceId: savedReferenceIdFromHref(url)!,
      },
    };
  }

  if (authority === 'entity') {
    if (segments.values.length < 3) return { ok: false, code: 'invalid-shape' };
    const [entityType, root, ...pathSegments] = segments.values;
    if (!INLINE_REFERENCE_ENTITY_TYPES.includes(entityType as 'sequence' | 'structure')) {
      return { ok: false, code: 'unsupported-entity-type' };
    }
    return {
      ok: true,
      declaration: {
        kind: 'path-entity',
        entityType: entityType as 'sequence' | 'structure',
        root,
        segments: pathSegments,
      },
    };
  }

  if (authority === 'workspace') {
    if (segments.values.length < 2) return { ok: false, code: 'invalid-shape' };
    const [root, ...pathSegments] = segments.values;
    return {
      ok: true,
      declaration: { kind: 'workspace-path', root, segments: pathSegments },
    };
  }

  return { ok: false, code: 'invalid-shape' };
}

function encodeSegment(value: string): string {
  const decoded = decodeSegment(encodeURIComponent(value));
  if (!decoded.ok) throw new Error(`Invalid inline reference segment: ${decoded.code}`);
  return encodeURIComponent(value);
}

export function encodeInlineReferenceDeclaration(declaration: InlineReferenceDeclaration): string {
  let url: string;
  switch (declaration.kind) {
    case 'molecular-document':
      url = molecularDocumentReferenceHref(declaration.document);
      break;
    case 'existing-reference':
      if (!UUID_PATTERN.test(declaration.referenceId)) {
        throw new Error('Invalid inline reference UUID.');
      }
      url = savedReferenceHref(declaration.referenceId);
      break;
    case 'path-entity':
      url = [
        `${INLINE_REFERENCE_SCHEME}://entity`,
        encodeSegment(declaration.entityType),
        encodeSegment(declaration.root),
        ...declaration.segments.map(encodeSegment),
      ].join('/');
      break;
    case 'workspace-path':
      url = [
        `${INLINE_REFERENCE_SCHEME}://workspace`,
        encodeSegment(declaration.root),
        ...declaration.segments.map(encodeSegment),
      ].join('/');
      break;
  }

  const decoded = decodeInlineReferenceUrl(url);
  if (!decoded.ok) throw new Error(`Invalid inline reference URI: ${decoded.code}`);
  return url;
}

export function isInlineReferenceLabelValid(label: string): boolean {
  return (
    label.length > 0 &&
    Array.from(label).length <= MAX_INLINE_REFERENCE_LABEL_SCALARS &&
    !label.includes('[') &&
    !label.includes(']') &&
    !label.includes('\r') &&
    !label.includes('\n')
  );
}
