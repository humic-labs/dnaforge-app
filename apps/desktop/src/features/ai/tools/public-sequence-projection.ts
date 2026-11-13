export function projectPublicSequenceValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(projectPublicSequenceValue);
  if (!value || typeof value !== 'object') return value;

  const record = value as Record<string, unknown>;
  const isFileBackedDnaSequence =
    record.mode === 'file' && typeof record.documentId === 'string';
  const isManagedSequenceDocument =
    record.kind === 'managed-sequence' && typeof record.packageId === 'string';
  const projected: Record<string, unknown> = {};

  for (const [key, item] of Object.entries(record)) {
    if (isFileBackedDnaSequence && key === 'relPath') continue;
    if (isManagedSequenceDocument && key === 'packageRoot') continue;
    projected[key] = projectPublicSequenceValue(item);
  }
  return projected;
}
