export function metadataValuesEqual(current: unknown, saved: unknown): boolean {
  if (Object.is(current, saved)) return true;
  if (Array.isArray(current) || Array.isArray(saved)) {
    return (
      Array.isArray(current) &&
      Array.isArray(saved) &&
      current.length === saved.length &&
      current.every((value, index) => metadataValuesEqual(value, saved[index]))
    );
  }
  if (
    current === null ||
    saved === null ||
    typeof current !== 'object' ||
    typeof saved !== 'object'
  )
    return false;
  const currentRecord = current as Record<string, unknown>;
  const savedRecord = saved as Record<string, unknown>;
  return [...new Set([...Object.keys(currentRecord), ...Object.keys(savedRecord)])].every((key) =>
    metadataValuesEqual(currentRecord[key], savedRecord[key])
  );
}
import type { EntitySchemaFieldSnapshot } from './entity-schema';

export function metadataFieldDraftValue(
  field: Pick<EntitySchemaFieldSnapshot, 'type'>,
  value: unknown,
  savedValue: unknown
): unknown {
  const empty = (entry: unknown) =>
    entry === undefined ||
    entry === null ||
    entry === '' ||
    (field.type === 'string_array' && Array.isArray(entry) && entry.length === 0);
  if (!empty(value)) return value;
  return empty(savedValue) ? savedValue : null;
}
