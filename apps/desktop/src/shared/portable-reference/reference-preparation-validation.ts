import type { AssemblySequenceAliases, AssemblySequenceRole } from '@waypoint/genome-data';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CONTRACT_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/;
const SEQUENCE_ROLES = new Set<AssemblySequenceRole>([
  'assembled-molecule',
  'unlocalized-scaffold',
  'unplaced-scaffold',
  'mitochondrion',
  'plastid',
  'other',
]);
const ALIAS_KEYS = ['refseq', 'genbank', 'ucsc', 'ensembl'] as const;

export function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  if (value.length > 2_048 || containsUnsupportedControlCharacter(value)) {
    throw new Error(`${label} contains unsupported characters or is too long.`);
  }
  return value.trim();
}

function containsUnsupportedControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) return true;
  }
  return false;
}

export function optionalText(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requireText(value, label);
}

export function requireSafeId(value: unknown, label: string): string {
  const id = requireText(value, label);
  if (!SAFE_ID.test(id)) {
    throw new Error(
      `${label} must match ${SAFE_ID.source} so it cannot escape the reference cache.`
    );
  }
  return id;
}

export function requireContractToken(value: unknown, label: string): string {
  const token = requireText(value, label);
  if (!CONTRACT_TOKEN.test(token) || token.includes('..')) {
    throw new Error(`${label} must match ${CONTRACT_TOKEN.source} without '..'.`);
  }
  return token;
}

export function optionalSafeId(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requireSafeId(value, label);
}

export function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return value as number;
}

export function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : requirePositiveInteger(value, label);
}

export function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean.`);
  return value;
}

export function requireBoolean(value: unknown, label: string): boolean {
  const parsed = optionalBoolean(value, label);
  if (parsed === undefined) throw new Error(`${label} is required.`);
  return parsed;
}

export function optionalDigest(value: unknown, pattern: RegExp, label: string): string | undefined {
  if (value === undefined) return undefined;
  const digest = requireText(value, label).toLowerCase();
  if (!pattern.test(digest)) throw new Error(`${label} has an invalid digest.`);
  return digest;
}

export function requireDigest(value: unknown, pattern: RegExp, label: string): string {
  const digest = optionalDigest(value, pattern, label);
  if (!digest) throw new Error(`${label} is required.`);
  return digest;
}

export function optionalSequenceRole(
  value: unknown,
  label: string
): AssemblySequenceRole | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !SEQUENCE_ROLES.has(value as AssemblySequenceRole)) {
    throw new Error(`${label} is not a supported assembly sequence role.`);
  }
  return value as AssemblySequenceRole;
}

export function optionalAliases(
  value: unknown,
  label: string
): AssemblySequenceAliases | undefined {
  if (value === undefined) return undefined;
  const raw = requireRecord(value, label);
  const aliases: AssemblySequenceAliases = {};
  for (const key of ALIAS_KEYS) {
    const alias = optionalText(raw[key], `${label}.${key}`);
    if (alias !== undefined) aliases[key] = alias;
  }
  const unknown = Object.keys(raw).filter(
    (key) => !(ALIAS_KEYS as readonly string[]).includes(key)
  );
  if (unknown.length > 0) {
    throw new Error(`${label} contains unsupported alias keys: ${unknown.join(', ')}.`);
  }
  return Object.keys(aliases).length > 0 ? aliases : undefined;
}

export function assertAliasUniqueness(
  aliases: AssemblySequenceAliases | undefined,
  aliasesByNamespace: Map<string, Set<string>>,
  label: string
): void {
  if (!aliases) return;
  for (const key of ALIAS_KEYS) {
    const value = aliases[key];
    if (!value) continue;
    const seen = aliasesByNamespace.get(key) ?? new Set<string>();
    if (seen.has(value)) {
      throw new Error(`${label}.aliases.${key} duplicates alias "${value}".`);
    }
    seen.add(value);
    aliasesByNamespace.set(key, seen);
  }
}

export function assertOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlyArray<string>,
  label: string
): void {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} contains unsupported fields: ${unknown.sort().join(', ')}.`);
  }
}

export function requireCanonicalPreparedPath(
  value: unknown,
  label: string,
  expected: string
): string {
  const path = requireText(value, label);
  if (path !== expected) {
    throw new Error(`${label} must be the canonical cache-relative path "${expected}".`);
  }
  return path;
}

export const TBI_MAX_REFERENCE_LENGTH_BP = 2 ** 29;

export function preparedAnnotationIndexSuffix(lengthBp: number): 'gff3.gz.csi' | 'gff3.gz.tbi' {
  return lengthBp > TBI_MAX_REFERENCE_LENGTH_BP ? 'gff3.gz.csi' : 'gff3.gz.tbi';
}

export function preparedAnnotationIndexPath(chrom: string, lengthBp: number): string {
  return `prepared/${chrom}/${chrom}.${preparedAnnotationIndexSuffix(lengthBp)}`;
}

export function preparedSequenceManifestPaths(chrom: string): {
  readonly uncompressed: { readonly fastaPath: string; readonly faiPath: string };
  readonly bgzf: { readonly fastaPath: string; readonly faiPath: string };
} {
  return {
    uncompressed: {
      fastaPath: `prepared/${chrom}/${chrom}.fa`,
      faiPath: `prepared/${chrom}/${chrom}.fa.fai`,
    },
    bgzf: {
      fastaPath: `prepared/${chrom}/${chrom}.fa.gz`,
      faiPath: `prepared/${chrom}/${chrom}.fa.gz.fai`,
    },
  };
}

export function requirePreparedSequenceManifestPaths(
  manifest: Record<string, unknown>,
  chrom: string,
  label: string
): { fastaPath: string; faiPath: string } {
  const fastaPath = requireText(manifest.fastaPath, `${label}.fastaPath`);
  const faiPath = requireText(manifest.faiPath, `${label}.faiPath`);
  const expected = preparedSequenceManifestPaths(chrom);
  const matches =
    (fastaPath === expected.uncompressed.fastaPath && faiPath === expected.uncompressed.faiPath) ||
    (fastaPath === expected.bgzf.fastaPath && faiPath === expected.bgzf.faiPath);
  if (!matches) {
    throw new Error(
      `${label} sequence paths must be prepared/${chrom}/${chrom}.fa[.gz] with the matching .fai.`
    );
  }
  return { fastaPath, faiPath };
}
