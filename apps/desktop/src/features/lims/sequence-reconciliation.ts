export interface ReconcileCandidate {
  name: string;
  normalizedSequenceHash?: string | null;
  fileContentHash?: string | null;
  accessionKeys?: readonly string[];
}

export interface ReconcileEntity {
  id: string;
  name: string;
  normalizedSequenceHash?: string | null;
  fileContentHash?: string | null;
  accessionKeys?: readonly string[];
}

export type ReconcileVerdict = 'exact-auto' | 'fuzzy-suggest' | 'none';

export interface ReconcileResult {
  verdict: ReconcileVerdict;
  matchId?: string;
  link?: { type: 'same_as' | 'associated_with'; accepted: boolean };
}

function isUsableHash(hash: string | null | undefined): hash is string {
  return typeof hash === 'string' && hash.trim().length > 0;
}

function usableAccessionKeys(keys: readonly string[] | undefined): string[] {
  if (!keys) {
    return [];
  }
  return keys.filter((key) => typeof key === 'string' && key.trim().length > 0);
}

function hashesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  return isUsableHash(a) && isUsableHash(b) && a === b;
}

function accessionKeysIntersect(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined
): boolean {
  const left = usableAccessionKeys(a);
  if (left.length === 0) {
    return false;
  }
  const right = new Set(usableAccessionKeys(b));
  if (right.size === 0) {
    return false;
  }
  return left.some((key) => right.has(key));
}

export function isProvablyExact(candidate: ReconcileCandidate, entity: ReconcileEntity): boolean {
  if (hashesMatch(candidate.normalizedSequenceHash, entity.normalizedSequenceHash)) {
    return true;
  }
  if (hashesMatch(candidate.fileContentHash, entity.fileContentHash)) {
    return true;
  }
  if (accessionKeysIntersect(candidate.accessionKeys, entity.accessionKeys)) {
    return true;
  }
  return false;
}

function normalizeName(name: string): string {
  return name
    .replace(/[\ufeff\s]+/g, ' ')
    .trim()
    .toLowerCase();
}

function nameTokens(normalized: string): string[] {
  return normalized.split(' ').filter((token) => token.length > 0);
}

function isFuzzyNameMatch(candidateName: string, entityName: string): boolean {
  const a = normalizeName(candidateName);
  const b = normalizeName(entityName);
  if (a.length === 0 || b.length === 0) {
    return false;
  }
  if (a === b) {
    return true;
  }
  const aTokens = nameTokens(a);
  const bTokens = nameTokens(b);
  return containsAllTokens(aTokens, bTokens) || containsAllTokens(bTokens, aTokens);
}

function containsAllTokens(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0) {
    return false;
  }
  const haystackSet = new Set(haystack);
  return needle.every((token) => haystackSet.has(token));
}

export function reconcileSequenceToRegistry(
  candidate: ReconcileCandidate,
  registry: readonly ReconcileEntity[]
): ReconcileResult {
  const exact = registry.find((entity) => isProvablyExact(candidate, entity));
  if (exact) {
    return {
      verdict: 'exact-auto',
      matchId: exact.id,
      link: { type: 'same_as', accepted: true },
    };
  }

  const fuzzy = registry.find((entity) => isFuzzyNameMatch(candidate.name, entity.name));
  if (fuzzy) {
    return {
      verdict: 'fuzzy-suggest',
      matchId: fuzzy.id,
      link: { type: 'associated_with', accepted: false },
    };
  }

  return { verdict: 'none' };
}
