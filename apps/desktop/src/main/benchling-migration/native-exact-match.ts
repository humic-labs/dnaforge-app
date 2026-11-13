import { createHash } from 'node:crypto';

import { IUPAC_REGEX_CLASS } from '@waypoint/sequence-utils';

import type { SourceObject } from '../../shared/benchling-migration';
import type { Sha256Digest } from '../../shared/benchling-import-decision';

export type NativeExactMatchCandidate = Readonly<{
  entityId: string;
  displayName: string;
  nativeKind: 'dna_sequence';
  scientificSha256: Sha256Digest;
  providerBindingCount: number;
  location:
    | Readonly<{ kind: 'file'; relativePath: string; fileKind: string }>
    | Readonly<{
        kind: 'catalog-record';
        parentRelativePath: string;
        presentationKind: 'sequence';
        catalogType: 'sequence';
      }>;
}>;

export type NativeExactMatchResult =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'single'; candidate: NativeExactMatchCandidate }>
  | Readonly<{ kind: 'ambiguous'; candidateEntityIds: readonly string[] }>;

const VALID_DNA_CODES = new Set(Object.keys(IUPAC_REGEX_CLASS));

export function dnaScientificFingerprint(sourceObject: SourceObject): Sha256Digest | null {
  if (normalizedSourceType(sourceObject.sourceType) !== 'dna_sequence') return null;
  const content = sourceObject.content;
  if (!content || typeof content !== 'object' || Array.isArray(content)) return null;
  const record = content as Record<string, unknown>;
  if (record.moleculeType !== 'DNA' || typeof record.bases !== 'string') return null;
  return dnaBasesScientificFingerprint(record.bases);
}

export function dnaBasesScientificFingerprint(bases: string): Sha256Digest | null {
  const normalized = bases.replace(/\s/gu, '').toUpperCase();
  if (normalized.length === 0 || [...normalized].some((base) => !VALID_DNA_CODES.has(base))) {
    return null;
  }
  return `sha256:${createHash('sha256').update(normalized).digest('hex')}`;
}

export function findUnboundExactNativeMatch(input: {
  sourceObject: SourceObject;
  candidates: readonly NativeExactMatchCandidate[];
}): NativeExactMatchResult {
  const incomingFingerprint = dnaScientificFingerprint(input.sourceObject);
  if (!incomingFingerprint) return { kind: 'none' };
  const exact = input.candidates
    .filter(
      (candidate) =>
        candidate.nativeKind === 'dna_sequence' &&
        candidate.providerBindingCount === 0 &&
        candidate.scientificSha256 === incomingFingerprint
    )
    .sort((left, right) => left.entityId.localeCompare(right.entityId));
  if (exact.length === 0) return { kind: 'none' };
  if (exact.length === 1) return { kind: 'single', candidate: exact[0] };
  return { kind: 'ambiguous', candidateEntityIds: exact.map((candidate) => candidate.entityId) };
}

function normalizedSourceType(value: string): string {
  return value.trim().toLowerCase().replace(/[ -]+/gu, '_');
}
