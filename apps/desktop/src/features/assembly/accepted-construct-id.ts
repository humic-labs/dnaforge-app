export function resolveConstructIdForFinalize(input: {
  designConstructId?: string | null;
  existingPackageId?: string | null;
  requestedConstructId?: string | null;
  mint?: () => string;
}): string {
  if (input.requestedConstructId) return input.requestedConstructId;
  if (input.designConstructId) return input.designConstructId;
  if (input.existingPackageId) return input.existingPackageId;
  return (input.mint ?? mintConstructId)();
}

export function requireConstructId(
  constructId: string | undefined | null,
  context: string
): string {
  if (!constructId) {
    throw new Error(`${context} requires a construct id; do not fall back to the draft id.`);
  }
  return constructId;
}

export function mintConstructId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `construct-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
