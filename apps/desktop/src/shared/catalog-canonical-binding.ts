export interface CanonicalBindingCandidate {
  path: string;
}

export function pickCanonicalBinding<T extends CanonicalBindingCandidate>(files: readonly T[]): T {
  if (files.length === 0) {
    throw new Error('pickCanonicalBinding requires at least one candidate');
  }
  const underNotebooks = files.filter((f) => f.path.includes('/notebooks/'));
  const pool = underNotebooks.length > 0 ? underNotebooks : files;
  return [...pool].sort((a, b) => a.path.localeCompare(b.path))[0];
}
