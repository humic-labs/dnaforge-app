import path from 'node:path';

import type { SourceObject } from '../../shared/benchling-migration';

const SHA256 = /^(?:sha256:)?([a-f0-9]{64})$/u;

export type NativeSequenceSourceEvidence = Readonly<{
  entryPath: string;
  sha256: string;
  sizeBytes: number;
  archivePartId: string;
}>;

export function nativeSequenceSourceEvidence(
  sourceObject: SourceObject
): NativeSequenceSourceEvidence | null {
  if (sourceObject.sourceType !== 'dna_sequence' && sourceObject.sourceType !== 'rna_sequence') {
    return null;
  }
  if (path.posix.extname(sourceObject.sourcePath ?? '').toLowerCase() !== '.gb') return null;
  if (!isRecord(sourceObject.content)) return null;
  const content = sourceObject.content;
  const rawAccess = content.rawAccess;
  const hasAnyRawEvidence =
    content.sha256 !== undefined || content.sizeBytes !== undefined || rawAccess !== undefined;
  if (!hasAnyRawEvidence) return null;
  if (!isRecord(rawAccess)) throw new Error('Native sequence rawAccess must be an object.');

  const sha256 = normalizedSha256(content.sha256, 'Native sequence source SHA-256');
  const sizeBytes = nonnegativeInteger(content.sizeBytes, 'Native sequence source size');
  const archivePartId = nonemptyText(rawAccess.archivePartId, 'Native sequence archive part ID');
  const entryPath = nonemptyText(rawAccess.entryPath, 'Native sequence archive entry path');
  if (entryPath !== sourceObject.sourcePath) {
    throw new Error('Native sequence source path does not match rawAccess.');
  }

  const nativeExport = isRecord(sourceObject.metadata?.nativeExport)
    ? sourceObject.metadata.nativeExport
    : null;
  if (nativeExport) {
    if (nativeExport.entryPath !== entryPath) {
      throw new Error('Native sequence native-export path does not match rawAccess.');
    }
    if (
      normalizedSha256(nativeExport.entrySha256, 'Native sequence native-export SHA-256') !== sha256
    ) {
      throw new Error('Native sequence native-export SHA-256 does not match rawAccess.');
    }
    if (
      nonnegativeInteger(nativeExport.entrySizeBytes, 'Native sequence native-export size') !==
      sizeBytes
    ) {
      throw new Error('Native sequence native-export size does not match rawAccess.');
    }
  }

  return { entryPath, sha256, sizeBytes, archivePartId };
}

export function nativeSequenceSourcePersistenceRequests(
  sourceObjects: readonly SourceObject[]
): Array<{ entryPath: string; expectedSha256: string }> {
  const byPath = new Map<string, string>();
  for (const sourceObject of sourceObjects) {
    const evidence = nativeSequenceSourceEvidence(sourceObject);
    if (!evidence) continue;
    const existing = byPath.get(evidence.entryPath);
    if (existing && existing !== evidence.sha256) {
      throw new Error('Native sequence source path has conflicting SHA-256 evidence.');
    }
    byPath.set(evidence.entryPath, evidence.sha256);
  }
  return [...byPath]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([entryPath, expectedSha256]) => ({ entryPath, expectedSha256 }));
}

export function nativeRecordSourcePersistenceRequests(
  sourceObjects: readonly SourceObject[]
): Array<{ entryPath: string; expectedSha256: string }> {
  const byPath = new Map<string, string>();
  for (const sourceObject of sourceObjects) {
    const evidence =
      nativeSequenceSourceEvidence(sourceObject) ??
      nativeStrainSourceEvidence(sourceObject) ??
      fallbackSourceEvidence(sourceObject);
    if (!evidence) continue;
    const existing = byPath.get(evidence.entryPath);
    if (existing && existing !== evidence.sha256) {
      throw new Error('Native record source path has conflicting SHA-256 evidence.');
    }
    byPath.set(evidence.entryPath, evidence.sha256);
  }
  return [...byPath]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([entryPath, expectedSha256]) => ({ entryPath, expectedSha256 }));
}

function fallbackSourceEvidence(sourceObject: SourceObject): NativeSequenceSourceEvidence | null {
  if (sourceObject.sourceType !== 'unsupported_object') return null;
  if (!sourceObject.sourcePath || !isRecord(sourceObject.content)) return null;
  const rawAccess = sourceObject.content.rawAccess;
  if (!isRecord(rawAccess)) return null;
  const entryPath = nonemptyText(rawAccess.entryPath, 'Fallback source archive entry path');
  if (entryPath !== sourceObject.sourcePath) {
    throw new Error('Fallback source path does not match rawAccess.');
  }
  return {
    entryPath,
    sha256: normalizedSha256(sourceObject.content.sha256, 'Fallback source SHA-256'),
    sizeBytes: nonnegativeInteger(sourceObject.content.sizeBytes, 'Fallback source size'),
    archivePartId: nonemptyText(rawAccess.archivePartId, 'Fallback source archive part ID'),
  };
}

function nativeStrainSourceEvidence(
  sourceObject: SourceObject
): NativeSequenceSourceEvidence | null {
  if (sourceObject.sourceType !== 'strain') return null;
  if (path.posix.extname(sourceObject.sourcePath ?? '').toLowerCase() !== '.txt') return null;
  if (!isRecord(sourceObject.content) || sourceObject.content.kind !== 'benchling_strain') {
    return null;
  }
  const content = sourceObject.content;
  const rawAccess = content.rawAccess;
  if (!isRecord(rawAccess)) throw new Error('Native strain rawAccess must be an object.');
  const sha256 = normalizedSha256(content.sha256, 'Native strain source SHA-256');
  const sizeBytes = nonnegativeInteger(content.sizeBytes, 'Native strain source size');
  const archivePartId = nonemptyText(rawAccess.archivePartId, 'Native strain archive part ID');
  const entryPath = nonemptyText(rawAccess.entryPath, 'Native strain archive entry path');
  if (entryPath !== sourceObject.sourcePath) {
    throw new Error('Native strain source path does not match rawAccess.');
  }
  return { entryPath, sha256, sizeBytes, archivePartId };
}

function normalizedSha256(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be text.`);
  const match = SHA256.exec(value.trim().toLowerCase());
  if (!match) throw new Error(`${label} is invalid.`);
  return match[1];
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a nonnegative safe integer.`);
  }
  return value as number;
}

function nonemptyText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be nonempty text.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
