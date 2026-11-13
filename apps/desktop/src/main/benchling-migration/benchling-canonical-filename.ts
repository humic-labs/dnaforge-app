import path from 'node:path';

import type { LinkedItemRecoveryObjectType } from '../../shared/benchling-migration';

const CANONICAL_SUFFIX =
  /\(((?:seq|prtn|prt|etr|bfi)_[A-Za-z0-9]+)\)\.(gb|gbk|genbank|fasta|fa|faa|html?|txt)$/iu;
const MIN_OBSERVED_STABLE_ID_PAYLOAD_LENGTH = 8;

export function canonicalIdentitiesInFilename(entryPath: string): string[] {
  const pattern = /(?:^|[^A-Za-z0-9])((?:seq|prtn|prt|etr|bfi)_[A-Za-z0-9]+)(?=$|[^A-Za-z0-9])/gu;
  const filename = path.posix.basename(entryPath);
  return [...filename.matchAll(pattern)].map((match) => match[1]);
}

export function filenameNamesExactlyOneCanonicalId(entryPath: string, sourceId: string): boolean {
  const identities = canonicalIdentitiesInFilename(entryPath);
  const plausibleIdentities = new Set(
    identities.filter(
      (identity) =>
        identity === sourceId ||
        identity.slice(identity.indexOf('_') + 1).length >= MIN_OBSERVED_STABLE_ID_PAYLOAD_LENGTH
    )
  );
  return plausibleIdentities.size === 1 && plausibleIdentities.has(sourceId);
}

export function canonicalExportSuffixSourceId(entryPath: string): string | null {
  const match = CANONICAL_SUFFIX.exec(path.posix.basename(entryPath));
  return match?.[1] ?? null;
}

export function canonicalExportSuffixIdentity(entryPath: string): {
  sourceId: string;
  objectType: LinkedItemRecoveryObjectType;
} | null {
  const filename = path.posix.basename(entryPath);
  const match = CANONICAL_SUFFIX.exec(filename);
  if (!match) return null;
  const sourceId = match[1];
  const extension = match[2].toLowerCase();
  if (sourceId.startsWith('seq_') && ['gb', 'gbk', 'genbank'].includes(extension)) {
    return { sourceId, objectType: 'dna_rna_sequence' };
  }
  if (sourceId.startsWith('prtn_') && ['fasta', 'fa', 'faa'].includes(extension)) {
    return { sourceId, objectType: 'protein' };
  }
  if (sourceId.startsWith('prt_') && ['html', 'htm'].includes(extension)) {
    return { sourceId, objectType: 'protocol' };
  }
  if (sourceId.startsWith('etr_') && ['html', 'htm'].includes(extension)) {
    return { sourceId, objectType: 'other' };
  }
  if (sourceId.startsWith('bfi_') && ['html', 'htm'].includes(extension)) {
    return { sourceId, objectType: 'other' };
  }
  if (sourceId.startsWith('bfi_') && extension === 'txt') {
    return { sourceId, objectType: 'other' };
  }
  return null;
}
