import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { basename, extname, isAbsolute, resolve } from 'node:path';

import type { ExternalZipEntryEvidence, ExternalZipSource } from '../../shared/benchling-migration';
import {
  isExactProviderStableId,
  providerObjectClassForStableId,
} from '../../shared/provider-object-reference';
import {
  DEFAULT_NATIVE_EXPORT_ARCHIVE_LIMITS,
  inspectNativeExportArchive,
  walkNativeExportArchive,
  type NativeExportArchiveSource,
  type ValidatedNativeExportArchive,
} from './native-export-archive';

export type ExternalZipSourceErrorCode =
  | 'source_unavailable'
  | 'source_changed'
  | 'source_integrity_error';

export class ExternalZipSourceError extends Error {
  constructor(
    readonly code: ExternalZipSourceErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ExternalZipSourceError';
  }
}

export type SelectedExternalZipSource = Readonly<{
  source: ExternalZipSource;
  entries: readonly ExternalZipEntryEvidence[];
  archive: Readonly<{
    entryCount: number;
    totalCompressedEntryBytes: number;
    totalUncompressedEntryBytes: number;
  }>;
  nativeExportDecoderSource: Extract<NativeExportArchiveSource, { kind: 'local_path' }>;
}>;

export async function selectExternalZipSource(input: {
  sourcePath: string;
  selectedAt: string;
}): Promise<SelectedExternalZipSource> {
  const originalPath = requiredAbsoluteZipPath(input.sourcePath);
  const selectedAt = normalizedTimestamp(input.selectedAt);
  const sourceStat = await regularSourceStat(originalPath);
  if (sourceStat.size === 0) {
    throw new ExternalZipSourceError('source_integrity_error', 'The selected ZIP is empty.');
  }
  if (sourceStat.size > DEFAULT_NATIVE_EXPORT_ARCHIVE_LIMITS.maxTotalUncompressedBytes) {
    throw new ExternalZipSourceError(
      'source_integrity_error',
      'The selected ZIP exceeds the migration source size limit.'
    );
  }
  const zipSha256 = `sha256:${await sha256OfFile(originalPath)}` as const;
  const sourceId = `external-zip-${zipSha256.slice('sha256:'.length, 'sha256:'.length + 24)}`;
  const source: ExternalZipSource = {
    schema: 'dnaforge.benchling.external-zip-source.v1',
    sourceId,
    originalPath,
    displayName: basename(originalPath),
    zipSha256,
    sizeBytes: sourceStat.size,
    selectedAt,
  };
  const nativeExportDecoderSource = externalZipDecoderSource(source);
  const inspected = await inspectNativeExportArchive(nativeExportDecoderSource);
  const entries: ExternalZipEntryEvidence[] = [];
  await walkNativeExportArchive(
    inspected,
    () => ({ kind: 'none' }),
    (evidence) => {
      if (evidence.isDirectory) return;
      const association = sourceAssociationForEntry(evidence.path);
      const sourceObjectId = association?.sourceObjectId ?? source.sourceId;
      entries.push({
        schema: 'dnaforge.benchling.external-zip-entry.v1',
        sourceId: source.sourceId,
        sourceObjectId,
        entryPath: evidence.path,
        entrySha256: normalizedSha256(evidence.sha256),
        sizeBytes: evidence.actualSize,
        mediaType: mediaTypeForPath(evidence.path),
        role: association?.role ?? 'attachment',
      });
    }
  );
  return {
    source,
    entries: entries.sort((left, right) => left.entryPath.localeCompare(right.entryPath)),
    archive: archiveCounts(inspected),
    nativeExportDecoderSource,
  };
}

export async function verifyExternalZipSource(source: ExternalZipSource): Promise<string> {
  const sourceStat = await regularSourceStat(source.originalPath);
  if (sourceStat.size !== source.sizeBytes) {
    throw new ExternalZipSourceError(
      'source_changed',
      `The original ZIP changed after selection: ${source.originalPath}`
    );
  }
  let actualSha256: string;
  try {
    actualSha256 = `sha256:${await sha256OfFile(source.originalPath)}`;
  } catch {
    throw new ExternalZipSourceError(
      'source_unavailable',
      `The original ZIP is unavailable: ${source.originalPath}`
    );
  }
  if (actualSha256 !== source.zipSha256) {
    throw new ExternalZipSourceError(
      'source_changed',
      `The original ZIP changed after selection: ${source.originalPath}`
    );
  }
  return source.originalPath;
}

export function externalZipDecoderSource(
  source: ExternalZipSource
): Extract<NativeExportArchiveSource, { kind: 'local_path' }> {
  return {
    kind: 'local_path',
    logicalFilename: source.displayName,
    localPath: source.originalPath,
    expectedSha256: source.zipSha256,
    expectedSizeBytes: source.sizeBytes,
    duplicateSupportEntryPolicy: 'identical_root_benchling_css',
  };
}

async function regularSourceStat(path: string): Promise<{ size: number }> {
  let value;
  try {
    value = await lstat(path);
  } catch {
    throw new ExternalZipSourceError(
      'source_unavailable',
      `The original ZIP is unavailable: ${path}`
    );
  }
  if (!value.isFile()) {
    throw new ExternalZipSourceError(
      'source_unavailable',
      `The original ZIP is unavailable: ${path}`
    );
  }
  const size = Number(value.size);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new ExternalZipSourceError('source_integrity_error', 'ZIP source size is invalid.');
  }
  return { size };
}

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolveStream, reject) => {
    createReadStream(path)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', resolveStream);
  });
  return hash.digest('hex');
}

function requiredAbsoluteZipPath(value: string): string {
  if (!value.trim() || !isAbsolute(value) || extname(value).toLowerCase() !== '.zip') {
    throw new ExternalZipSourceError(
      'source_integrity_error',
      'External Benchling source must be an absolute ZIP path.'
    );
  }
  return resolve(value);
}

function normalizedTimestamp(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new ExternalZipSourceError('source_integrity_error', 'ZIP selection time is invalid.');
  }
  return new Date(milliseconds).toISOString();
}

function normalizedSha256(value: string): `sha256:${string}` {
  const digest = value.replace(/^sha256:/u, '').toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    throw new ExternalZipSourceError('source_integrity_error', 'ZIP entry SHA-256 is invalid.');
  }
  return `sha256:${digest}`;
}

function sourceAssociationForEntry(entryPath: string): Readonly<{
  sourceObjectId: string;
  role: ExternalZipEntryEvidence['role'];
}> | null {
  const segments = entryPath.split('/');
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (!segment) continue;
    const recordSuffixId = /\(([A-Za-z0-9_]+)\)\.[A-Za-z0-9]+$/u.exec(segment)?.[1];
    const candidates = [...segment.matchAll(/\(([A-Za-z0-9_]+)\)/gu)].map((match) => match[1]);
    for (const candidate of candidates.reverse()) {
      if (!candidate || !isExactProviderStableId(candidate)) continue;
      if (providerObjectClassForStableId(candidate) !== null) {
        return {
          sourceObjectId: candidate,
          role:
            index === segments.length - 1 && recordSuffixId === candidate
              ? 'source-record'
              : 'attachment',
        };
      }
    }
  }
  return null;
}

function mediaTypeForPath(entryPath: string): string | null {
  switch (extname(entryPath).toLowerCase()) {
    case '.gb':
    case '.gbk':
    case '.genbank':
      return 'chemical/x-genbank';
    case '.fasta':
    case '.fa':
      return 'text/x-fasta';
    case '.html':
    case '.htm':
      return 'text/html';
    case '.json':
      return 'application/json';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.txt':
    case '.css':
      return 'text/plain';
    default:
      return null;
  }
}

function archiveCounts(archive: ValidatedNativeExportArchive) {
  return {
    entryCount: archive.entries.length,
    totalCompressedEntryBytes: archive.totalCompressedEntryBytes,
    totalUncompressedEntryBytes: archive.totalUncompressedEntryBytes,
  };
}
