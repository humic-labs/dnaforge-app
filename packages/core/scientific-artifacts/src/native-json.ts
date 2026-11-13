import { parseUniqueJson } from '@waypoint/scientific-objects';
import type { CanonicalMap } from '@waypoint/workspace-revisions';

export function nativeRecord(value: unknown): CanonicalMap {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Native scientific data requires a JSON object.');
  return value as CanonicalMap;
}
export function parseNativeJson(text: string): CanonicalMap {
  return nativeRecord(parseUniqueJson(text, { maxDepth: 64 }));
}
export function withoutNativeKeys(input: CanonicalMap, known: readonly string[]): CanonicalMap {
  const exclude = new Set(known);
  return Object.fromEntries(Object.entries(input).filter(([key]) => !exclude.has(key)));
}
