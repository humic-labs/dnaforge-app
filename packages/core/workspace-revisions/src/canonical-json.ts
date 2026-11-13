import type { CanonicalJson, Result } from './identity';
import { isUnicodeScalarString } from './unicode';
import { utf8ToBytes } from '@noble/hashes/utils';

export type CanonicalError =
  | { readonly kind: 'invalid-number' }
  | { readonly kind: 'unsupported-value' }
  | { readonly kind: 'non-plain-object' }
  | { readonly kind: 'cycle' }
  | { readonly kind: 'duplicate-set-value' }
  | { readonly kind: 'invalid-unicode' }
  | { readonly kind: 'max-depth-exceeded' }
  | { readonly kind: 'node-budget-exceeded' }
  | { readonly kind: 'envelope-budget-exceeded' }
  | { readonly kind: 'key-budget-exceeded' }
  | { readonly kind: 'scalar-budget-exceeded' }
  | { readonly kind: 'invalid-json' }
  | { readonly kind: 'non-canonical-json' };

export interface CanonicalizeOptions {
  readonly setLikeArrayPaths?: readonly string[];
}

const MAX_CANONICAL_DEPTH = 100;
const MAX_CANONICAL_NODES = 100_000;
export const MAX_CANONICAL_JSON_BYTES = 1_048_576;
export const MAX_CANONICAL_KEY_BYTES = 1_024;
export const MAX_CANONICAL_SCALAR_BYTES = 65_536;

export function canonicalize(
  value: unknown,
  options: CanonicalizeOptions = {}
): Result<CanonicalJson, CanonicalError> {
  const setLikePaths = new Set(options.setLikeArrayPaths ?? []);
  const serialized = serialize(value, '', setLikePaths, new WeakSet(), {
    visited: 0,
  });
  if (!serialized.ok) return serialized;
  return { ok: true, value: serialized.value as CanonicalJson };
}

export function parseStrictCanonicalJson(text: string): Result<CanonicalJson, CanonicalError> {
  if (utf8ToBytes(text).length > MAX_CANONICAL_JSON_BYTES) {
    return { ok: false, error: { kind: 'envelope-budget-exceeded' } };
  }
  const stringBudget = preflightJsonStringBudgets(text);
  if (!stringBudget.ok) return stringBudget;
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return { ok: false, error: { kind: 'invalid-json' } };
  }
  const canonical = canonicalize(decoded);
  if (!canonical.ok) return canonical;
  if (canonical.value !== text) {
    return { ok: false, error: { kind: 'non-canonical-json' } };
  }
  return canonical;
}

function serialize(
  value: unknown,
  path: string,
  setLikePaths: ReadonlySet<string>,
  active: WeakSet<object>,
  budget: { visited: number },
  depth = 0
): Result<string, CanonicalError> {
  if (depth > MAX_CANONICAL_DEPTH) {
    return { ok: false, error: { kind: 'max-depth-exceeded' } };
  }
  budget.visited += 1;
  if (budget.visited > MAX_CANONICAL_NODES) {
    return { ok: false, error: { kind: 'node-budget-exceeded' } };
  }
  if (value === null) return { ok: true, value: 'null' };
  if (typeof value === 'boolean') return { ok: true, value: value ? 'true' : 'false' };
  if (typeof value === 'string') {
    if (!isUnicodeScalarString(value)) {
      return { ok: false, error: { kind: 'invalid-unicode' } };
    }
    if (utf8ToBytes(value).length > MAX_CANONICAL_SCALAR_BYTES) {
      return { ok: false, error: { kind: 'scalar-budget-exceeded' } };
    }
    return { ok: true, value: JSON.stringify(value) };
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || !Number.isFinite(value) || Object.is(value, -0)) {
      return { ok: false, error: { kind: 'invalid-number' } };
    }
    return { ok: true, value: String(value) };
  }
  if (typeof value !== 'object') {
    return { ok: false, error: { kind: 'unsupported-value' } };
  }
  if (active.has(value)) return { ok: false, error: { kind: 'cycle' } };
  active.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const item = serialize(
          value[index],
          `${path}/${index}`,
          setLikePaths,
          active,
          budget,
          depth + 1
        );
        if (!item.ok) return item;
        items.push(item.value);
      }
      if (setLikePaths.has(path)) {
        items.sort();
        for (let index = 1; index < items.length; index += 1) {
          if (items[index] === items[index - 1]) {
            return { ok: false, error: { kind: 'duplicate-set-value' } };
          }
        }
      }
      return { ok: true, value: `[${items.join(',')}]` };
    }
    if (!isPlainRecord(value)) {
      return { ok: false, error: { kind: 'non-plain-object' } };
    }
    const fields: string[] = [];
    for (const key of Object.keys(value).sort()) {
      if (!isUnicodeScalarString(key)) {
        return { ok: false, error: { kind: 'invalid-unicode' } };
      }
      if (utf8ToBytes(key).length > MAX_CANONICAL_KEY_BYTES) {
        return { ok: false, error: { kind: 'key-budget-exceeded' } };
      }
      const field = serialize(
        value[key],
        `${path}/${escapeJsonPointerSegment(key)}`,
        setLikePaths,
        active,
        budget,
        depth + 1
      );
      if (!field.ok) return field;
      fields.push(`${JSON.stringify(key)}:${field.value}`);
    }
    return { ok: true, value: `{${fields.join(',')}}` };
  } finally {
    active.delete(value);
  }
}

function preflightJsonStringBudgets(text: string): Result<CanonicalJson, CanonicalError> {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== 0x22) continue;
    let decodedBytes = 0;
    let closed = false;
    for (index += 1; index < text.length; index += 1) {
      const codeUnit = text.charCodeAt(index);
      if (codeUnit === 0x22) {
        closed = true;
        break;
      }
      if (codeUnit === 0x5c) {
        index += 1;
        if (index >= text.length) return { ok: false, error: { kind: 'invalid-json' } };
        const escape = text[index];
        if (escape === 'u') {
          const first = parseHexCodeUnit(text, index + 1);
          if (first === null) return { ok: false, error: { kind: 'invalid-json' } };
          index += 4;
          if (first >= 0xd800 && first <= 0xdbff) {
            if (text.slice(index + 1, index + 3) !== '\\u') {
              return { ok: false, error: { kind: 'invalid-unicode' } };
            }
            const second = parseHexCodeUnit(text, index + 3);
            if (second === null || second < 0xdc00 || second > 0xdfff) {
              return { ok: false, error: { kind: 'invalid-unicode' } };
            }
            decodedBytes += 4;
            index += 6;
          } else if (first >= 0xdc00 && first <= 0xdfff) {
            return { ok: false, error: { kind: 'invalid-unicode' } };
          } else {
            decodedBytes += utf8CodePointBytes(first);
          }
        } else if (
          escape === '"' ||
          escape === '\\' ||
          escape === '/' ||
          escape === 'b' ||
          escape === 'f' ||
          escape === 'n' ||
          escape === 'r' ||
          escape === 't'
        ) {
          decodedBytes += 1;
        } else {
          return { ok: false, error: { kind: 'invalid-json' } };
        }
      } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
        const low = text.charCodeAt(index + 1);
        if (low < 0xdc00 || low > 0xdfff) {
          return { ok: false, error: { kind: 'invalid-unicode' } };
        }
        decodedBytes += 4;
        index += 1;
      } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
        return { ok: false, error: { kind: 'invalid-unicode' } };
      } else {
        decodedBytes += utf8CodePointBytes(codeUnit);
      }
    }
    if (!closed) return { ok: false, error: { kind: 'invalid-json' } };
    const isKey = text[index + 1] === ':';
    if (isKey && decodedBytes > MAX_CANONICAL_KEY_BYTES) {
      return { ok: false, error: { kind: 'key-budget-exceeded' } };
    }
    if (!isKey && decodedBytes > MAX_CANONICAL_SCALAR_BYTES) {
      return { ok: false, error: { kind: 'scalar-budget-exceeded' } };
    }
  }
  return { ok: true, value: text as CanonicalJson };
}

function parseHexCodeUnit(text: string, start: number): number | null {
  const digits = text.slice(start, start + 4);
  return /^[0-9a-fA-F]{4}$/u.test(digits) ? Number.parseInt(digits, 16) : null;
}

function utf8CodePointBytes(codePoint: number): number {
  return codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : 3;
}

function isPlainRecord(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function escapeJsonPointerSegment(value: string): string {
  return value.replace(/~/gu, '~0').replace(/\//gu, '~1');
}
