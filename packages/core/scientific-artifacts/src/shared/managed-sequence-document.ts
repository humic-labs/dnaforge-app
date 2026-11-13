import type { GeneticCodeSpec } from '@waypoint/sequence-utils';

export interface ManagedSequenceDocumentRef {
  kind: 'managed-sequence';
  packageId: string;
  packageRoot: string;
}

export interface ManagedSequenceContentSummary {
  fileContentHash?: string;
  normalizedSequenceHash?: string;
  topology?: 'circular' | 'linear';
  length?: number;
  geneticCode?: GeneticCodeSpec;
}

export interface CatalogSequenceDocumentRef {
  kind: 'catalog-sequence';
  entityId: string;
}

export interface IndexedSequenceDocumentRef {
  kind: 'indexed-sequence';
  documentId: string;
}

export interface ImportSourceSequenceDocumentRef {
  kind: 'import-source-sequence';
  documentId: string;
  sourcePath: string;
}

export type SequenceDocumentRef =
  | ManagedSequenceDocumentRef
  | CatalogSequenceDocumentRef
  | IndexedSequenceDocumentRef
  | ImportSourceSequenceDocumentRef;

export const MANAGED_SEQUENCE_DOCUMENT_FIELD = '_managedSequenceDocument' as const;
export const MANAGED_SEQUENCE_CONTENT_FIELD = '_managedSequenceContent' as const;

export function readManagedSequenceContentSummary(
  value: unknown
): ManagedSequenceContentSummary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<ManagedSequenceContentSummary>;
  const fileContentHash =
    typeof candidate.fileContentHash === 'string' && candidate.fileContentHash.startsWith('sha256:')
      ? candidate.fileContentHash
      : undefined;
  const normalizedSequenceHash =
    typeof candidate.normalizedSequenceHash === 'string' &&
    candidate.normalizedSequenceHash.startsWith('sha256:')
      ? candidate.normalizedSequenceHash
      : undefined;
  const topology =
    candidate.topology === 'circular' || candidate.topology === 'linear'
      ? candidate.topology
      : undefined;
  const length =
    typeof candidate.length === 'number' &&
    Number.isSafeInteger(candidate.length) &&
    candidate.length >= 0
      ? candidate.length
      : undefined;
  const geneticCode =
    (typeof candidate.geneticCode === 'number' && Number.isInteger(candidate.geneticCode)) ||
    (typeof candidate.geneticCode === 'object' && candidate.geneticCode !== null)
      ? (candidate.geneticCode as GeneticCodeSpec)
      : undefined;
  if (
    !fileContentHash &&
    !normalizedSequenceHash &&
    !topology &&
    length === undefined &&
    geneticCode === undefined
  )
    return null;
  return { fileContentHash, normalizedSequenceHash, topology, length, geneticCode };
}

export function readManagedSequenceDocumentRef(value: unknown): ManagedSequenceDocumentRef | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<ManagedSequenceDocumentRef>;
  if (
    candidate.kind !== 'managed-sequence' ||
    typeof candidate.packageId !== 'string' ||
    !candidate.packageId.trim() ||
    typeof candidate.packageRoot !== 'string' ||
    !candidate.packageRoot.trim()
  ) {
    return null;
  }
  return {
    kind: 'managed-sequence',
    packageId: candidate.packageId,
    packageRoot: candidate.packageRoot,
  };
}

export function sequenceDocumentKey(ref: SequenceDocumentRef): string {
  if (ref.kind === 'managed-sequence') return ref.packageId;
  if (ref.kind === 'catalog-sequence') return ref.entityId;
  return ref.documentId;
}
