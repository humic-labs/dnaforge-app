import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import yauzl, { type Entry, type ZipFile } from 'yauzl';
import {
  ArchiveEntryValidationError,
  validateArchiveEntries,
  type ContentArchive,
  type ContentBlobReceipt,
} from './content-archive';
import { traceNativeExportStage } from './native-export-stage-trace';

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const UNIX_PLATFORM = 3;
const UNIX_FILE_TYPE = 0o170000;
const UNIX_REGULAR_FILE = 0o100000;
const UNIX_DIRECTORY = 0o040000;
const UNIX_SYMLINK = 0o120000;
const MAX_NATIVE_EXPORT_PERSISTENCE_CONCURRENCY = 32;
const BENCHLING_SEQUENCE_SNAPSHOT_PREVIEW_PATH =
  /(?:^|\/)assets\/benchling-html-asset-snapshot-seq_[A-Za-z0-9]+\.svg$/u;

export type NativeExportArchiveSource =
  | {
      kind: 'bytes';
      logicalFilename: string;
      bytes: Uint8Array;
      expectedSha256: string;
      expectedSizeBytes: number;
      declaredUncompressedBytes?: number;
      duplicateSupportEntryPolicy?: 'identical_root_benchling_css';
    }
  | {
      kind: 'local_path';
      logicalFilename: string;
      localPath: string;
      expectedSha256: string;
      expectedSizeBytes: number;
      declaredUncompressedBytes?: number;
      duplicateSupportEntryPolicy?: 'identical_root_benchling_css';
    };

export type NativeExportArchiveLimits = {
  maxEntries: number;
  maxEntryUncompressedBytes: number;
  maxTotalUncompressedBytes: number;
  maxCompressionRatio: number;
};

export const DEFAULT_NATIVE_EXPORT_ARCHIVE_LIMITS: NativeExportArchiveLimits = {
  maxEntries: 100_000,
  maxEntryUncompressedBytes: 512 * 1024 * 1024,
  maxTotalUncompressedBytes: 8 * 1024 * 1024 * 1024,
  maxCompressionRatio: 1_000,
};

export type NativeExportArchiveEntry = {
  path: string;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  compressionMethod: 0 | 8;
  isDirectory: boolean;
};

export type NativeExportArchiveInventory = {
  physicalCentralDirectoryEntryCount: number;
  canonicalUniqueEntryCount: number;
  collapsedIdenticalDuplicateEntryCount: number;
};

export type ValidatedNativeExportArchive = {
  source: NativeExportArchiveSource;
  logicalFilename: string;
  sha256: string;
  sizeBytes: number;
  totalCompressedEntryBytes: number;
  totalUncompressedEntryBytes: number;
  entries: NativeExportArchiveEntry[];
  semanticPathByPhysicalOrdinal: Array<string | null>;
  inventory: NativeExportArchiveInventory;
  limits: NativeExportArchiveLimits;
};

export type NativeExportEntryCapture =
  | { kind: 'none' }
  | { kind: 'prefix'; maxBytes: number }
  | { kind: 'full'; maxBytes: number };

export type NativeExportArchiveEntryEvidence = NativeExportArchiveEntry & {
  sha256: string;
  actualSize: number;
};

export type NativeExportArchiveEntryPersistenceRequest = {
  entryPath: string;
  expectedSha256?: string;
};

export type NativeExportArchivePersistenceOptions = Readonly<{
  sourceAlreadyVerified?: boolean;
  reuseExistingExpectedBlobs?: boolean;
  maxConcurrentWrites?: number;
  onProgress?: (progress: Readonly<{ completed: number; total: number }>) => void;
}>;

export type PersistedNativeExportArchiveEntry = {
  evidence: NativeExportArchiveEntryEvidence;
  blob: ContentBlobReceipt;
};

export class NativeExportArchiveError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly entryPath?: string
  ) {
    super(message);
    this.name = 'NativeExportArchiveError';
  }
}

export async function inspectNativeExportArchive(
  input: NativeExportArchiveSource,
  overrides: Partial<NativeExportArchiveLimits> = {}
): Promise<ValidatedNativeExportArchive> {
  const limits = validateLimits({ ...DEFAULT_NATIVE_EXPORT_ARCHIVE_LIMITS, ...overrides });
  traceNativeExportStage('bind_archive_start');
  const source = await bindArchiveSource(input);
  traceNativeExportStage('bind_archive_complete');
  traceNativeExportStage('list_catalog_start');
  const catalog = await listArchiveEntries(source, limits);
  const entries = catalog.entries;
  traceNativeExportStage('list_catalog_complete', { count: entries.length });
  const totalCompressedEntryBytes = safeSum(
    catalog.allEntries.map((entry) => entry.compressedSize),
    'native_export_archive_compressed_size_overflow'
  );
  const totalUncompressedEntryBytes = safeSum(
    catalog.allEntries.map((entry) => entry.uncompressedSize),
    'native_export_archive_uncompressed_size_overflow'
  );
  if (totalUncompressedEntryBytes > limits.maxTotalUncompressedBytes) {
    throw new NativeExportArchiveError(
      'native_export_archive_too_large',
      `Archive declares ${totalUncompressedEntryBytes} uncompressed bytes; limit is ${limits.maxTotalUncompressedBytes}.`
    );
  }
  if (
    source.declaredUncompressedBytes !== undefined &&
    source.declaredUncompressedBytes !== totalUncompressedEntryBytes
  ) {
    throw new NativeExportArchiveError(
      'native_export_declared_uncompressed_size_mismatch',
      `Archive declares ${source.declaredUncompressedBytes} uncompressed bytes outside the ZIP but its central directory declares ${totalUncompressedEntryBytes}.`
    );
  }
  return {
    source,
    logicalFilename: source.logicalFilename,
    sha256: source.expectedSha256,
    sizeBytes: source.expectedSizeBytes,
    totalCompressedEntryBytes,
    totalUncompressedEntryBytes,
    entries,
    semanticPathByPhysicalOrdinal: catalog.semanticPathByPhysicalOrdinal,
    inventory: catalog.inventory,
    limits,
  };
}

export async function walkNativeExportArchive(
  archive: ValidatedNativeExportArchive,
  captureFor: (entry: NativeExportArchiveEntry) => NativeExportEntryCapture,
  onEntry: (
    evidence: NativeExportArchiveEntryEvidence,
    captured: Uint8Array | null
  ) => void | Promise<void>
): Promise<void> {
  const expectedByPath = new Map(archive.entries.map((entry) => [entry.path, entry]));
  const visited = new Set<string>();
  let supportStylesheetSha256: string | undefined;
  const zipFile = await openZip(archive.source);
  try {
    await iterateZip(zipFile, 'walk', async (rawEntry, ordinal) => {
      const entry = semanticEntryForPhysicalOrdinal(archive, rawEntry, ordinal);
      if (!entry) return;
      const expected = expectedByPath.get(entry.path);
      if (!expected || stableEntryIdentity(expected) !== stableEntryIdentity(entry)) {
        throw new NativeExportArchiveError(
          'native_export_archive_changed_during_parse',
          `ZIP entry ${entry.path} changed after inspection.`,
          entry.path
        );
      }
      if (entry.isDirectory) return;
      if (visited.has(entry.path)) return;
      if (isBenchlingRootSupportStylesheet(archive.source, entry)) {
        const stream = await openZipEntryStream(zipFile, rawEntry);
        traceNativeExportStage('walk_entry_stream_open', { ordinal });
        const consumed = await consumeEntry(stream, entry, { kind: 'none' }, archive.limits);
        traceNativeExportStage('walk_entry_stream_complete', { ordinal });
        supportStylesheetSha256 = retainIdenticalSupportEntrySha256(
          supportStylesheetSha256,
          consumed.sha256,
          entry
        );
        visited.add(entry.path);
        return;
      }
      const capture = validateCapture(captureFor(entry));
      if (capture.kind === 'full' && entry.uncompressedSize > capture.maxBytes) {
        throw new NativeExportArchiveError(
          'native_export_entry_capture_limit',
          `Entry ${entry.path} is ${entry.uncompressedSize} bytes; parser capture limit is ${capture.maxBytes}.`,
          entry.path
        );
      }
      const stream = await openZipEntryStream(zipFile, rawEntry);
      traceNativeExportStage('walk_entry_stream_open', { ordinal });
      const consumed = await consumeEntry(stream, entry, capture, archive.limits);
      traceNativeExportStage('walk_entry_stream_complete', { ordinal });
      visited.add(entry.path);
      await onEntry(
        { ...entry, sha256: consumed.sha256, actualSize: consumed.actualSize },
        consumed.captured
      );
      traceNativeExportStage('walk_entry_semantic_complete', { ordinal });
    });
  } finally {
    closeZip(zipFile);
  }
  traceNativeExportStage('walk_complete', { count: visited.size });
  const expectedFiles = archive.entries.filter((entry) => !entry.isDirectory);
  if (visited.size !== expectedFiles.length) {
    throw new NativeExportArchiveError(
      'native_export_archive_entry_count_changed',
      `Visited ${visited.size} files after inspecting ${expectedFiles.length}.`
    );
  }
}

export async function readNativeExportArchiveEntries(
  archive: ValidatedNativeExportArchive,
  entryPaths: readonly string[],
  maxEntryBytes: number,
  maxTotalBytes: number
): Promise<Map<string, Uint8Array>> {
  positiveSafeInteger(maxEntryBytes, 'control-entry byte limit');
  positiveSafeInteger(maxTotalBytes, 'total control-entry byte limit');
  const requested = new Set(entryPaths);
  if (requested.size === 0) {
    traceNativeExportStage('empty_control_pass_start', { count: 0, empty: true });
    traceNativeExportStage('empty_control_pass_complete', { count: 0, empty: true });
    return new Map();
  }
  const expectedByPath = new Map(archive.entries.map((entry) => [entry.path, entry]));
  for (const entryPath of requested) {
    const expected = expectedByPath.get(entryPath);
    if (!expected || expected.isDirectory) {
      throw new NativeExportArchiveError(
        'native_export_control_entry_missing',
        `Requested control entry ${entryPath} is absent.`,
        entryPath
      );
    }
    if (isBenchlingRootSupportStylesheet(archive.source, expected)) {
      throw new NativeExportArchiveError(
        'native_export_control_entry_unsupported',
        'Benchling root support stylesheet is retained only in the immutable source archive.',
        entryPath
      );
    }
    if (isDiscardableBenchlingSequenceSnapshotPreview(expected)) {
      throw new NativeExportArchiveError(
        'native_export_control_entry_unsupported',
        'Benchling sequence snapshot previews are non-semantic export support files.',
        entryPath
      );
    }
    if (expected.uncompressedSize > maxEntryBytes) {
      throw new NativeExportArchiveError(
        'native_export_entry_capture_limit',
        `Control entry ${entryPath} exceeds ${maxEntryBytes} bytes.`,
        entryPath
      );
    }
  }
  const result = new Map<string, Uint8Array>();
  let total = 0;
  traceNativeExportStage('control_pass_start', { count: requested.size, empty: false });
  const zipFile = await openZip(archive.source);
  try {
    await iterateZip(zipFile, 'control', async (rawEntry, ordinal) => {
      const entry = semanticEntryForPhysicalOrdinal(archive, rawEntry, ordinal);
      if (!entry || !requested.has(entry.path)) return;
      const expected = expectedByPath.get(entry.path);
      if (!expected || stableEntryIdentity(expected) !== stableEntryIdentity(entry)) {
        throw new NativeExportArchiveError(
          'native_export_archive_changed_during_parse',
          `Control entry ${entry.path} changed after inspection.`,
          entry.path
        );
      }
      total += entry.uncompressedSize;
      if (total > maxTotalBytes) {
        throw new NativeExportArchiveError(
          'native_export_control_entries_too_large',
          `Control entries exceed ${maxTotalBytes} bytes.`
        );
      }
      const stream = await openZipEntryStream(zipFile, rawEntry);
      const consumed = await consumeEntry(
        stream,
        entry,
        { kind: 'full', maxBytes: maxEntryBytes },
        archive.limits
      );
      if (!consumed.captured) {
        throw new NativeExportArchiveError(
          'native_export_control_entry_missing',
          `Control entry ${entry.path} could not be captured.`,
          entry.path
        );
      }
      result.set(entry.path, consumed.captured);
    });
  } finally {
    closeZip(zipFile);
  }
  traceNativeExportStage('control_pass_complete', { count: result.size, empty: false });
  if (result.size !== requested.size) {
    throw new NativeExportArchiveError(
      'native_export_control_entry_missing',
      'One or more requested control entries could not be read.'
    );
  }
  return result;
}

export type NativeExportArchiveEntryPreview = Readonly<{
  evidence: NativeExportArchiveEntryEvidence;
  bytes: Uint8Array;
  truncated: boolean;
}>;

export async function readNativeExportArchiveEntryPreview(
  archive: ValidatedNativeExportArchive,
  entryPath: string,
  maxBytes: number
): Promise<NativeExportArchiveEntryPreview> {
  positiveSafeInteger(maxBytes, 'entry preview byte limit');
  const expected = archive.entries.find((entry) => entry.path === entryPath);
  if (!expected || expected.isDirectory) {
    throw new NativeExportArchiveError(
      'native_export_control_entry_missing',
      `Requested source entry ${entryPath} is absent.`,
      entryPath
    );
  }
  let result: NativeExportArchiveEntryPreview | null = null;
  const zipFile = await openZip(archive.source);
  try {
    await iterateZip(zipFile, 'entry_preview', async (rawEntry, ordinal) => {
      const entry = semanticEntryForPhysicalOrdinal(archive, rawEntry, ordinal);
      if (!entry || entry.path !== entryPath) return;
      if (stableEntryIdentity(expected) !== stableEntryIdentity(entry)) {
        throw new NativeExportArchiveError(
          'native_export_archive_changed_during_parse',
          `Source entry ${entry.path} changed after inspection.`,
          entry.path
        );
      }
      const stream = await openZipEntryStream(zipFile, rawEntry);
      const consumed = await consumeEntry(
        stream,
        entry,
        { kind: 'prefix', maxBytes },
        archive.limits
      );
      if (!consumed.captured) {
        throw new NativeExportArchiveError(
          'native_export_control_entry_missing',
          `Source entry ${entry.path} could not be captured.`,
          entry.path
        );
      }
      result = {
        evidence: { ...entry, sha256: consumed.sha256, actualSize: consumed.actualSize },
        bytes: consumed.captured,
        truncated: consumed.actualSize > consumed.captured.byteLength,
      };
    });
  } finally {
    closeZip(zipFile);
  }
  if (!result) {
    throw new NativeExportArchiveError(
      'native_export_control_entry_missing',
      `Requested source entry ${entryPath} could not be read.`,
      entryPath
    );
  }
  return result;
}

export async function persistNativeExportArchiveEntries(
  archive: ValidatedNativeExportArchive,
  requests: readonly NativeExportArchiveEntryPersistenceRequest[],
  contentArchive: ContentArchive,
  options: NativeExportArchivePersistenceOptions = {}
): Promise<PersistedNativeExportArchiveEntry[]> {
  const selected = normalizePersistenceRequests(archive, requests);
  if (selected.size === 0) return [];
  const maxConcurrentWrites = normalizePersistenceConcurrency(options.maxConcurrentWrites);
  let completedSelectedEntries = 0;
  options.onProgress?.({ completed: 0, total: selected.size });

  const reboundSource = options.sourceAlreadyVerified
    ? archive.source
    : await bindArchiveSource(archive.source);
  const reboundCatalog = options.sourceAlreadyVerified
    ? {
        entries: archive.entries,
        semanticPathByPhysicalOrdinal: archive.semanticPathByPhysicalOrdinal,
      }
    : await listArchiveEntries(reboundSource, archive.limits);
  const reboundEntries = reboundCatalog.entries;
  if (!options.sourceAlreadyVerified) {
    assertEntryCatalogUnchanged(
      archive.entries,
      archive.semanticPathByPhysicalOrdinal,
      reboundEntries,
      reboundCatalog.semanticPathByPhysicalOrdinal
    );
  }
  const expectedByPath = new Map(reboundEntries.map((entry) => [entry.path, entry]));
  const persisted = new Map<string, PersistedNativeExportArchiveEntry>();
  const visited = new Set<string>();
  let supportStylesheetSha256: string | undefined;
  const zipFile = await openZip(reboundSource);
  try {
    await iterateZip(
      zipFile,
      'persist_walk',
      async (rawEntry, ordinal) => {
        const semanticPath = reboundCatalog.semanticPathByPhysicalOrdinal[ordinal];
        if (semanticPath === undefined) {
          throw new NativeExportArchiveError(
            'native_export_archive_changed_during_persistence',
            'Native-export ZIP gained a physical entry after persistence preflight.'
          );
        }
        if (semanticPath === null) return;
        const entry = { ...validateRawEntry(rawEntry, archive.limits), path: semanticPath };
        const expected = expectedByPath.get(entry.path);
        if (!expected || stableEntryIdentity(expected) !== stableEntryIdentity(entry)) {
          throw new NativeExportArchiveError(
            'native_export_archive_changed_during_persistence',
            `ZIP entry ${entry.path} changed after persistence preflight.`,
            entry.path
          );
        }
        if (visited.has(entry.path)) return;
        if (isBenchlingRootSupportStylesheet(reboundSource, entry)) {
          const stream = await openZipEntryStream(zipFile, rawEntry);
          const consumed = await consumeEntry(stream, entry, { kind: 'none' }, archive.limits);
          supportStylesheetSha256 = retainIdenticalSupportEntrySha256(
            supportStylesheetSha256,
            consumed.sha256,
            entry
          );
          visited.add(entry.path);
          return;
        }
        visited.add(entry.path);
        const request = selected.get(entry.path);
        if (!request) return;
        if (entry.isDirectory) {
          throw new NativeExportArchiveError(
            'native_export_persistence_entry_invalid',
            `Cannot persist ZIP directory ${entry.path} as a blob.`,
            entry.path
          );
        }
        if (options.reuseExistingExpectedBlobs && request.expectedSha256) {
          try {
            const blob = await contentArchive.assertBlobPresent(
              request.expectedSha256,
              entry.uncompressedSize
            );
            persisted.set(entry.path, {
              evidence: {
                ...entry,
                sha256: `sha256:${blob.sha256}`,
                actualSize: blob.size,
              },
              blob,
            });
            completedSelectedEntries += 1;
            options.onProgress?.({
              completed: completedSelectedEntries,
              total: selected.size,
            });
            return;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
        const stream = await openZipEntryStream(zipFile, rawEntry);
        const blob = await contentArchive.putStream(
          verifiedNativeExportEntryChunks(stream, entry, archive.limits),
          {
            expectedSize: entry.uncompressedSize,
            maxBytes: archive.limits.maxEntryUncompressedBytes,
            ...(request.expectedSha256 === undefined
              ? {}
              : { expectedSha256: request.expectedSha256 }),
          }
        );
        persisted.set(entry.path, {
          evidence: {
            ...entry,
            sha256: `sha256:${blob.sha256}`,
            actualSize: blob.size,
          },
          blob,
        });
        completedSelectedEntries += 1;
        options.onProgress?.({ completed: completedSelectedEntries, total: selected.size });
      },
      maxConcurrentWrites
    );
  } finally {
    closeZip(zipFile);
  }

  if (visited.size !== reboundEntries.length) {
    throw new NativeExportArchiveError(
      'native_export_archive_entry_count_changed',
      `Visited ${visited.size} entries after persistence preflight found ${reboundEntries.length}.`
    );
  }
  if (persisted.size !== selected.size) {
    throw new NativeExportArchiveError(
      'native_export_persistence_entry_missing',
      `Persisted ${persisted.size} selected entries but expected ${selected.size}.`
    );
  }
  return [...persisted.values()].sort((left, right) =>
    left.evidence.path.localeCompare(right.evidence.path)
  );
}

function normalizePersistenceConcurrency(value: number | undefined): number {
  if (value === undefined) return 1;
  const concurrency = positiveSafeInteger(value, 'native-export persistence concurrency');
  if (concurrency > MAX_NATIVE_EXPORT_PERSISTENCE_CONCURRENCY) {
    throw new NativeExportArchiveError(
      'native_export_invalid_size',
      `Native-export persistence concurrency cannot exceed ${MAX_NATIVE_EXPORT_PERSISTENCE_CONCURRENCY}.`
    );
  }
  return concurrency;
}

function normalizePersistenceRequests(
  archive: ValidatedNativeExportArchive,
  requests: readonly NativeExportArchiveEntryPersistenceRequest[]
): Map<string, { expectedSha256?: string }> {
  if (!Array.isArray(requests)) {
    throw new NativeExportArchiveError(
      'native_export_persistence_request_invalid',
      'Native-export persistence requests must be an array.'
    );
  }
  const catalog = new Map(archive.entries.map((entry) => [entry.path, entry]));
  const result = new Map<string, { expectedSha256?: string }>();
  for (const request of requests) {
    const entryPath = typeof request?.entryPath === 'string' ? request.entryPath : '';
    const entry = catalog.get(entryPath);
    if (!entry || entry.isDirectory) {
      throw new NativeExportArchiveError(
        'native_export_persistence_entry_missing',
        `Selected persistence entry ${entryPath || '(missing path)'} is absent or not a file.`,
        entryPath || undefined
      );
    }
    if (isBenchlingRootSupportStylesheet(archive.source, entry)) {
      throw new NativeExportArchiveError(
        'native_export_persistence_entry_invalid',
        'Benchling root support stylesheet is retained only in the immutable source archive.',
        entryPath
      );
    }
    if (isDiscardableBenchlingSequenceSnapshotPreview(entry)) {
      throw new NativeExportArchiveError(
        'native_export_persistence_entry_invalid',
        'Benchling sequence snapshot previews are non-semantic export support files.',
        entryPath
      );
    }
    const expectedSha256 =
      request.expectedSha256 === undefined ? undefined : normalizeSha256(request.expectedSha256);
    const prior = result.get(entryPath);
    if (prior) {
      if (prior.expectedSha256 !== expectedSha256) {
        throw new NativeExportArchiveError(
          'native_export_persistence_request_conflict',
          `Selected persistence entry ${entryPath} has conflicting expected hashes.`,
          entryPath
        );
      }
      continue;
    }
    result.set(entryPath, expectedSha256 === undefined ? {} : { expectedSha256 });
  }
  return result;
}

function assertEntryCatalogUnchanged(
  inspected: readonly NativeExportArchiveEntry[],
  inspectedSemanticPaths: readonly (string | null)[],
  rebound: readonly NativeExportArchiveEntry[],
  reboundSemanticPaths: readonly (string | null)[]
): void {
  if (
    inspected.length !== rebound.length ||
    inspectedSemanticPaths.length !== reboundSemanticPaths.length ||
    inspectedSemanticPaths.some((entryPath, index) => entryPath !== reboundSemanticPaths[index]) ||
    inspected.some(
      (entry, index) => stableEntryIdentity(entry) !== stableEntryIdentity(rebound[index])
    )
  ) {
    throw new NativeExportArchiveError(
      'native_export_archive_changed_during_persistence',
      'Native-export ZIP metadata changed after its original inspection.'
    );
  }
}

async function* verifiedNativeExportEntryChunks(
  stream: Readable,
  entry: NativeExportArchiveEntry,
  limits: NativeExportArchiveLimits
): AsyncGenerator<Uint8Array> {
  let actualSize = 0;
  let crc = 0xffffffff;
  try {
    for await (const chunk of eventDrivenReadableChunks(stream)) {
      actualSize += chunk.byteLength;
      if (actualSize > entry.uncompressedSize || actualSize > limits.maxEntryUncompressedBytes) {
        throw new NativeExportArchiveError(
          'native_export_actual_size_limit',
          `Entry ${entry.path} produced more bytes than declared or allowed.`,
          entry.path
        );
      }
      crc = updateCrc32(crc, chunk);
      yield chunk;
    }
    if (actualSize !== entry.uncompressedSize) {
      throw new NativeExportArchiveError(
        'native_export_entry_size_mismatch',
        `Entry ${entry.path} produced ${actualSize} bytes but declared ${entry.uncompressedSize}.`,
        entry.path
      );
    }
    const actualCrc = (crc ^ 0xffffffff) >>> 0;
    if (actualCrc !== entry.crc32) {
      throw new NativeExportArchiveError(
        'native_export_entry_crc_mismatch',
        `Entry ${entry.path} CRC-32 does not match the central directory.`,
        entry.path
      );
    }
  } catch (error) {
    if (error instanceof NativeExportArchiveError) throw error;
    throw new NativeExportArchiveError(
      'native_export_entry_read_failed',
      `Failed to read ZIP entry ${entry.path}: ${error instanceof Error ? error.message : String(error)}`,
      entry.path
    );
  }
}

async function bindArchiveSource(
  input: NativeExportArchiveSource
): Promise<NativeExportArchiveSource> {
  const expectedSha256 = normalizeSha256(input.expectedSha256);
  const expectedSizeBytes = positiveSafeInteger(input.expectedSizeBytes, 'expected archive size');
  const declaredUncompressedBytes =
    input.declaredUncompressedBytes === undefined
      ? undefined
      : nonNegativeSafeInteger(input.declaredUncompressedBytes, 'declared uncompressed size');
  const logicalFilename = requiredLogicalFilename(input.logicalFilename);

  if (input.kind === 'bytes') {
    const bytes = Uint8Array.from(input.bytes);
    if (bytes.byteLength !== expectedSizeBytes) {
      throw new NativeExportArchiveError(
        'native_export_archive_size_mismatch',
        `Expected ${expectedSizeBytes} archive bytes but received ${bytes.byteLength}.`
      );
    }
    const actualSha256 = sha256Buffer(bytes);
    if (actualSha256 !== expectedSha256) {
      throw new NativeExportArchiveError(
        'native_export_archive_hash_mismatch',
        `Archive SHA-256 ${actualSha256} does not match ${expectedSha256}.`
      );
    }
    return {
      kind: 'bytes',
      logicalFilename,
      bytes,
      expectedSha256,
      expectedSizeBytes,
      ...(declaredUncompressedBytes === undefined ? {} : { declaredUncompressedBytes }),
      ...(input.duplicateSupportEntryPolicy === undefined
        ? {}
        : { duplicateSupportEntryPolicy: input.duplicateSupportEntryPolicy }),
    };
  }

  const localPath = requiredLocalPath(input.localPath);
  const stat = await lstat(localPath).catch((error: unknown) => {
    throw new NativeExportArchiveError(
      'native_export_archive_unreadable',
      `Cannot inspect local archive ${localPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  });
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new NativeExportArchiveError(
      'native_export_archive_not_regular_file',
      'Live native-export input must be a regular file, not a symlink or special file.'
    );
  }
  if (stat.size !== expectedSizeBytes) {
    throw new NativeExportArchiveError(
      'native_export_archive_size_mismatch',
      `Expected ${expectedSizeBytes} archive bytes but local file has ${stat.size}.`
    );
  }
  const actualSha256 = await sha256File(localPath);
  if (actualSha256 !== expectedSha256) {
    throw new NativeExportArchiveError(
      'native_export_archive_hash_mismatch',
      `Archive SHA-256 ${actualSha256} does not match ${expectedSha256}.`
    );
  }
  return {
    kind: 'local_path',
    logicalFilename,
    localPath,
    expectedSha256,
    expectedSizeBytes,
    ...(declaredUncompressedBytes === undefined ? {} : { declaredUncompressedBytes }),
    ...(input.duplicateSupportEntryPolicy === undefined
      ? {}
      : { duplicateSupportEntryPolicy: input.duplicateSupportEntryPolicy }),
  };
}

type NativeExportArchiveCatalog = Readonly<{
  entries: NativeExportArchiveEntry[];
  allEntries: NativeExportArchiveEntry[];
  semanticPathByPhysicalOrdinal: Array<string | null>;
  inventory: NativeExportArchiveInventory;
}>;

async function listArchiveEntries(
  source: NativeExportArchiveSource,
  limits: NativeExportArchiveLimits
): Promise<NativeExportArchiveCatalog> {
  const zipFile = await openZip(source);
  if (zipFile.entryCount > limits.maxEntries) {
    closeZip(zipFile);
    throw new NativeExportArchiveError(
      'native_export_archive_entry_limit',
      `Archive contains ${zipFile.entryCount} entries; limit is ${limits.maxEntries}.`
    );
  }
  const entries: NativeExportArchiveEntry[] = [];
  const allEntries: NativeExportArchiveEntry[] = [];
  const semanticPathByPhysicalOrdinal: Array<string | null> = [];
  const entryByPath = new Map<string, NativeExportArchiveEntry>();
  const firstRawEntryByPath = new Map<string, Parameters<typeof openZipEntryStream>[1]>();
  const firstOrdinalByPath = new Map<string, number>();
  const variantPathByRawPathAndSha256 = new Map<string, Map<string, string>>();
  let declaredUncompressedBytes = 0;
  const sha256ByPath = new Map<string, string>();
  let supportStylesheetSha256: string | undefined;
  let collapsedIdenticalDuplicateEntryCount = 0;
  try {
    await iterateZip(zipFile, 'catalog', async (rawEntry, ordinal) => {
      if (entries.length >= limits.maxEntries) {
        throw new NativeExportArchiveError(
          'native_export_archive_entry_limit',
          `Archive exceeds the ${limits.maxEntries}-entry limit.`
        );
      }
      const entry = validateRawEntry(rawEntry, limits);
      allEntries.push(entry);
      declaredUncompressedBytes = safeSum(
        [declaredUncompressedBytes, entry.uncompressedSize],
        'native_export_archive_uncompressed_size_overflow'
      );
      if (declaredUncompressedBytes > limits.maxTotalUncompressedBytes) {
        throw new NativeExportArchiveError(
          'native_export_archive_too_large',
          `Archive declares ${declaredUncompressedBytes} uncompressed bytes; limit is ${limits.maxTotalUncompressedBytes}.`
        );
      }
      const previous = entryByPath.get(entry.path);
      if (previous) {
        const firstRawEntry = firstRawEntryByPath.get(entry.path);
        const discardableSequenceSnapshot = isDiscardableBenchlingSequenceSnapshotPreview(entry);
        const legacyGenBankDisplayName = isLegacyGenBankDisplayNamePath(entry.path);
        if (
          !firstRawEntry ||
          (!discardableSequenceSnapshot &&
            !legacyGenBankDisplayName &&
            stableEntryIdentity(entry) !== stableEntryIdentity(previous))
        ) {
          throw new NativeExportArchiveError(
            'native_export_duplicate_path',
            `Archive contains duplicate path ${entry.path}.`,
            entry.path
          );
        }
        const firstSha256 =
          sha256ByPath.get(entry.path) ??
          (
            await consumeEntry(
              await openZipEntryStream(zipFile, firstRawEntry),
              previous,
              { kind: 'none' },
              limits
            )
          ).sha256;
        sha256ByPath.set(entry.path, firstSha256);
        const duplicate = await consumeEntry(
          await openZipEntryStream(zipFile, rawEntry),
          entry,
          { kind: 'none' },
          limits
        );
        if (duplicate.sha256 === firstSha256) {
          semanticPathByPhysicalOrdinal[ordinal] = null;
          collapsedIdenticalDuplicateEntryCount += 1;
          return;
        }
        if (discardableSequenceSnapshot) {
          semanticPathByPhysicalOrdinal[ordinal] = null;
          return;
        }
        if (!legacyGenBankDisplayName) {
          throw new NativeExportArchiveError(
            'native_export_duplicate_path',
            `Archive contains non-identical duplicate path ${entry.path}.`,
            entry.path
          );
        }

        let variants = variantPathByRawPathAndSha256.get(entry.path);
        if (!variants) {
          const firstOrdinal = firstOrdinalByPath.get(entry.path);
          const firstIndex = entries.indexOf(previous);
          if (firstOrdinal === undefined || firstIndex < 0) {
            throw new NativeExportArchiveError(
              'native_export_duplicate_path',
              `Archive contains duplicate path ${entry.path}.`,
              entry.path
            );
          }
          const firstVariantPath = legacyGenBankVariantPath(entry.path, firstSha256);
          entries[firstIndex] = { ...previous, path: firstVariantPath };
          semanticPathByPhysicalOrdinal[firstOrdinal] = firstVariantPath;
          variants = new Map([[firstSha256, firstVariantPath]]);
          variantPathByRawPathAndSha256.set(entry.path, variants);
        }

        if (variants.has(duplicate.sha256)) {
          semanticPathByPhysicalOrdinal[ordinal] = null;
          collapsedIdenticalDuplicateEntryCount += 1;
          return;
        }
        const variantPath = legacyGenBankVariantPath(entry.path, duplicate.sha256);
        variants.set(duplicate.sha256, variantPath);
        semanticPathByPhysicalOrdinal[ordinal] = variantPath;
        entries.push({ ...entry, path: variantPath });
        return;
      }
      if (isBenchlingRootSupportStylesheet(source, entry)) {
        const stream = await openZipEntryStream(zipFile, rawEntry);
        const consumed = await consumeEntry(stream, entry, { kind: 'none' }, limits);
        supportStylesheetSha256 = retainIdenticalSupportEntrySha256(
          supportStylesheetSha256,
          consumed.sha256,
          entry
        );
        sha256ByPath.set(entry.path, consumed.sha256);
      }
      firstRawEntryByPath.set(entry.path, rawEntry);
      firstOrdinalByPath.set(entry.path, ordinal);
      entryByPath.set(entry.path, entry);
      semanticPathByPhysicalOrdinal[ordinal] = entry.path;
      entries.push(entry);
    });
  } finally {
    closeZip(zipFile);
  }
  assertPermanentArchiveGate(entries, limits);
  return {
    entries: entries.sort((left, right) => left.path.localeCompare(right.path)),
    allEntries,
    semanticPathByPhysicalOrdinal,
    inventory: {
      physicalCentralDirectoryEntryCount: allEntries.length,
      canonicalUniqueEntryCount: entries.length,
      collapsedIdenticalDuplicateEntryCount,
    },
  };
}

function isLegacyGenBankDisplayNamePath(entryPath: string): boolean {
  const filename = entryPath.slice(entryPath.lastIndexOf('/') + 1);
  return (
    /\.(?:gb|gbk|genbank)$/iu.test(filename) &&
    !/\((?:seq|prtn|prt|etr)_[A-Za-z0-9]+\)\.(?:gb|gbk|genbank)$/iu.test(filename)
  );
}

function legacyGenBankVariantPath(entryPath: string, sha256: string): string {
  const digest = sha256.replace(/^sha256:/u, '');
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    throw new NativeExportArchiveError(
      'native_export_duplicate_path',
      `Archive contains duplicate path ${entryPath}.`,
      entryPath
    );
  }
  const extensionIndex = entryPath.lastIndexOf('.');
  return `${entryPath.slice(0, extensionIndex)} [DNAForge variant sha256-${digest}]${entryPath.slice(extensionIndex)}`;
}

function semanticEntryForPhysicalOrdinal(
  archive: ValidatedNativeExportArchive,
  rawEntry: Entry,
  ordinal: number
): NativeExportArchiveEntry | null {
  const semanticPath = archive.semanticPathByPhysicalOrdinal[ordinal];
  if (semanticPath === undefined) {
    throw new NativeExportArchiveError(
      'native_export_archive_changed_during_parse',
      'Native-export ZIP gained a physical entry after inspection.'
    );
  }
  if (semanticPath === null) return null;
  return { ...validateRawEntry(rawEntry, archive.limits), path: semanticPath };
}

function isBenchlingRootSupportStylesheet(
  source: NativeExportArchiveSource,
  entry: NativeExportArchiveEntry
): boolean {
  return (
    source.duplicateSupportEntryPolicy === 'identical_root_benchling_css' &&
    entry.path === 'benchling.css' &&
    !entry.isDirectory
  );
}

function isDiscardableBenchlingSequenceSnapshotPreview(entry: NativeExportArchiveEntry): boolean {
  return !entry.isDirectory && BENCHLING_SEQUENCE_SNAPSHOT_PREVIEW_PATH.test(entry.path);
}

function retainIdenticalSupportEntrySha256(
  expectedSha256: string | undefined,
  actualSha256: string,
  entry: NativeExportArchiveEntry
): string {
  if (expectedSha256 !== undefined && actualSha256 !== expectedSha256) {
    throw new NativeExportArchiveError(
      'native_export_duplicate_path',
      `Archive contains non-identical duplicate path ${entry.path}.`,
      entry.path
    );
  }
  return expectedSha256 ?? actualSha256;
}

function assertPermanentArchiveGate(
  entries: NativeExportArchiveEntry[],
  limits: NativeExportArchiveLimits
): void {
  try {
    validateArchiveEntries(
      entries.map((entry) => ({
        path: entry.path,
        uncompressedBytes: entry.uncompressedSize,
        isDirectory: entry.isDirectory,
      })),
      {
        maxEntries: limits.maxEntries,
        maxEntryUncompressedBytes: limits.maxEntryUncompressedBytes,
        maxTotalUncompressedBytes: limits.maxTotalUncompressedBytes,
      },
      {
        allowOpaqueNestedArchives: true,
      }
    );
  } catch (error) {
    if (!(error instanceof ArchiveEntryValidationError)) throw error;
    const code =
      error.code === 'entry_path_collision'
        ? 'native_export_path_collision'
        : error.code === 'nested_archive'
          ? 'native_export_nested_archive'
          : `native_export_archive_gate_${error.code}`;
    throw new NativeExportArchiveError(code, error.message, error.entryPath ?? undefined);
  }
}

function validateRawEntry(
  entry: Entry,
  limits: NativeExportArchiveLimits
): NativeExportArchiveEntry {
  const entryPath = validateArchivePath(entry.fileName);
  if (entry.isEncrypted() || (entry.generalPurposeBitFlag & 0x1) !== 0) {
    throw new NativeExportArchiveError(
      'native_export_encrypted_entry',
      `Encrypted ZIP entry ${entryPath} is unsupported.`,
      entryPath
    );
  }
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
    throw new NativeExportArchiveError(
      'native_export_compression_unsupported',
      `ZIP entry ${entryPath} uses unsupported compression method ${entry.compressionMethod}.`,
      entryPath
    );
  }
  const compressedSize = nonNegativeSafeInteger(entry.compressedSize, 'entry compressed size');
  const uncompressedSize = nonNegativeSafeInteger(
    entry.uncompressedSize,
    'entry uncompressed size'
  );
  if (uncompressedSize > limits.maxEntryUncompressedBytes) {
    throw new NativeExportArchiveError(
      'native_export_entry_too_large',
      `Entry ${entryPath} declares ${uncompressedSize} bytes; limit is ${limits.maxEntryUncompressedBytes}.`,
      entryPath
    );
  }
  const isDirectory = entryPath.endsWith('/');
  assertNotSymlinkOrSpecial(entry, entryPath, isDirectory);
  if (!isDirectory && uncompressedSize > 0) {
    if (compressedSize === 0 || uncompressedSize / compressedSize > limits.maxCompressionRatio) {
      throw new NativeExportArchiveError(
        'native_export_compression_ratio_limit',
        `Entry ${entryPath} exceeds the ${limits.maxCompressionRatio}:1 compression-ratio limit.`,
        entryPath
      );
    }
  }
  return {
    path: entryPath,
    compressedSize,
    uncompressedSize,
    crc32: entry.crc32 >>> 0,
    compressionMethod: entry.compressionMethod,
    isDirectory,
  };
}

function assertNotSymlinkOrSpecial(entry: Entry, entryPath: string, isDirectory: boolean): void {
  const platform = (entry.versionMadeBy >>> 8) & 0xff;
  if (platform !== UNIX_PLATFORM) return;
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const fileType = mode & UNIX_FILE_TYPE;
  if (fileType === UNIX_SYMLINK) {
    throw new NativeExportArchiveError(
      'native_export_symlink_entry',
      `Archive entry ${entryPath} is a symbolic link.`,
      entryPath
    );
  }
  if (fileType !== 0 && fileType !== UNIX_REGULAR_FILE && fileType !== UNIX_DIRECTORY) {
    throw new NativeExportArchiveError(
      'native_export_special_entry',
      `Archive entry ${entryPath} is not a regular file or directory.`,
      entryPath
    );
  }
  if (
    (fileType === UNIX_DIRECTORY && !isDirectory) ||
    (fileType === UNIX_REGULAR_FILE && isDirectory)
  ) {
    throw new NativeExportArchiveError(
      'native_export_entry_type_mismatch',
      `Archive entry ${entryPath} has conflicting path and UNIX type metadata.`,
      entryPath
    );
  }
}

function validateArchivePath(value: string): string {
  if (!value || value.includes('\0')) {
    throw new NativeExportArchiveError('native_export_invalid_path', 'ZIP entry path is empty.');
  }
  if (
    value.startsWith('/') ||
    value.startsWith('\\') ||
    value.includes('\\') ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw new NativeExportArchiveError(
      'native_export_absolute_path',
      `ZIP entry path ${value} is not a safe relative POSIX path.`,
      value
    );
  }
  const directory = value.endsWith('/');
  const body = directory ? value.slice(0, -1) : value;
  const segments = body.split('/');
  if (!body || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new NativeExportArchiveError(
      'native_export_path_traversal',
      `ZIP entry path ${value} contains an unsafe segment.`,
      value
    );
  }
  return value;
}

async function consumeEntry(
  stream: Readable,
  entry: NativeExportArchiveEntry,
  capture: NativeExportEntryCapture,
  limits: NativeExportArchiveLimits
): Promise<{ sha256: string; actualSize: number; captured: Uint8Array | null }> {
  const hash = createHash('sha256');
  const chunks: Buffer[] = [];
  let capturedBytes = 0;
  let actualSize = 0;
  let crc = 0xffffffff;
  try {
    for await (const chunk of eventDrivenReadableChunks(stream)) {
      actualSize += chunk.byteLength;
      if (actualSize > entry.uncompressedSize || actualSize > limits.maxEntryUncompressedBytes) {
        throw new NativeExportArchiveError(
          'native_export_actual_size_limit',
          `Entry ${entry.path} produced more bytes than declared or allowed.`,
          entry.path
        );
      }
      hash.update(chunk);
      crc = updateCrc32(crc, chunk);
      if (capture.kind === 'full') {
        chunks.push(chunk);
        capturedBytes += chunk.byteLength;
      } else if (capture.kind === 'prefix' && capturedBytes < capture.maxBytes) {
        const remaining = capture.maxBytes - capturedBytes;
        const prefix = chunk.subarray(0, remaining);
        if (prefix.byteLength > 0) {
          chunks.push(prefix);
          capturedBytes += prefix.byteLength;
        }
      }
    }
  } catch (error) {
    if (error instanceof NativeExportArchiveError) throw error;
    throw new NativeExportArchiveError(
      'native_export_entry_read_failed',
      `Failed to read ZIP entry ${entry.path}: ${error instanceof Error ? error.message : String(error)}`,
      entry.path
    );
  }
  if (actualSize !== entry.uncompressedSize) {
    throw new NativeExportArchiveError(
      'native_export_entry_size_mismatch',
      `Entry ${entry.path} produced ${actualSize} bytes but declared ${entry.uncompressedSize}.`,
      entry.path
    );
  }
  const actualCrc = (crc ^ 0xffffffff) >>> 0;
  if (actualCrc !== entry.crc32) {
    throw new NativeExportArchiveError(
      'native_export_entry_crc_mismatch',
      `Entry ${entry.path} CRC-32 does not match the central directory.`,
      entry.path
    );
  }
  return {
    sha256: `sha256:${hash.digest('hex')}`,
    actualSize,
    captured: capture.kind === 'none' ? null : Uint8Array.from(Buffer.concat(chunks)),
  };
}

async function* eventDrivenReadableChunks(stream: Readable): AsyncGenerator<Buffer> {
  let pendingChunk: Buffer | null = null;
  let ended = false;
  let closed = false;
  let active = true;
  let failure: Error | null = null;
  let wake: (() => void) | null = null;

  const signal = (): void => {
    const resolve = wake;
    wake = null;
    resolve?.();
  };
  const fail = (error: unknown): void => {
    if (!active || ended || failure) return;
    failure = error instanceof Error ? error : new Error(String(error));
    stream.pause();
    signal();
  };
  const handleData = (value: unknown): void => {
    stream.pause();
    if (!active || ended || failure) return;
    if (pendingChunk) {
      fail(new Error('ZIP entry stream exceeded its one-chunk backpressure boundary.'));
      return;
    }
    try {
      pendingChunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
      signal();
    } catch (error) {
      fail(error);
    }
  };
  const handleEnd = (): void => {
    if (!active || ended || failure) return;
    ended = true;
    signal();
  };
  const handleError = (error: Error): void => fail(error);
  const handleAborted = (): void => fail(new Error('ZIP entry stream was aborted.'));
  const handleClose = (): void => {
    closed = true;
    if (active && !ended) fail(new Error('ZIP entry stream closed before reaching its end.'));
  };

  stream.pause();
  stream.on('error', handleError);
  stream.on('end', handleEnd);
  stream.on('aborted', handleAborted);
  stream.on('close', handleClose);
  stream.on('data', handleData);
  stream.pause();

  try {
    while (true) {
      if (failure) throw failure;
      if (pendingChunk) {
        const chunk = pendingChunk;
        pendingChunk = null;
        yield chunk;
        continue;
      }
      if (ended) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
        try {
          stream.resume();
        } catch (error) {
          fail(error);
        }
      });
    }
  } finally {
    active = false;
    signal();
    stream.removeListener('data', handleData);
    stream.removeListener('end', handleEnd);
    stream.removeListener('error', handleError);
    stream.removeListener('aborted', handleAborted);
    stream.removeListener('close', handleClose);
    if (!ended) {
      stream.on('error', swallowLateStreamError);
      if (!closed && !stream.destroyed) stream.destroy();
    }
  }
}

function swallowLateStreamError(): void {}

function openZip(source: NativeExportArchiveSource): Promise<ZipFile> {
  const options = {
    lazyEntries: true,
    autoClose: false,
    decodeStrings: true,
    validateEntrySizes: true,
    strictFileNames: true,
  } as const;
  return new Promise((resolve, reject) => {
    const callback = (error: Error | null, zipFile: ZipFile): void => {
      if (error) {
        reject(
          new NativeExportArchiveError(
            'native_export_zip_open_failed',
            `Cannot open native-export ZIP: ${error.message}`
          )
        );
      } else {
        resolve(zipFile);
      }
    };
    if (source.kind === 'local_path') yauzl.open(source.localPath, options, callback);
    else yauzl.fromBuffer(Buffer.from(source.bytes), options, callback);
  });
}

export function iterateZip(
  zipFile: ZipFile,
  phase: 'catalog' | 'control' | 'entry_preview' | 'walk' | 'persist_walk',
  onEntry: (entry: Entry, ordinal: number) => Promise<void>,
  maxConcurrency = 1
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let ended = false;
    let readPending = false;
    let failure: unknown;
    let hasFailure = false;
    let active = 0;
    let ordinal = 0;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      zipFile.removeListener('entry', handleEntry);
      zipFile.removeListener('end', handleEnd);
      zipFile.removeListener('error', handleError);
      zipFile.on('error', ignoreErrorAfterSettlement);
      if (error) reject(error);
      else resolve();
    };
    const requestNext = (): void => {
      if (settled || ended || readPending || hasFailure || active >= maxConcurrency) return;
      readPending = true;
      zipFile.readEntry();
    };
    const fail = (error: unknown): void => {
      if (!hasFailure) {
        hasFailure = true;
        failure = error ?? new Error('Native-export ZIP iteration failed without an error.');
      }
      if (active === 0 && !readPending) finish(failure);
    };
    const handleError = (error: Error): void => {
      readPending = false;
      fail(normalizeZipRuntimeError(error));
    };
    const handleEnd = (): void => {
      readPending = false;
      ended = true;
      if (active === 0) {
        if (hasFailure) finish(failure);
        else finish();
      }
    };
    const handleEntry = (entry: Entry): void => {
      readPending = false;
      if (hasFailure) {
        if (active === 0) finish(failure);
        return;
      }
      const currentOrdinal = ordinal;
      ordinal += 1;
      active += 1;
      traceNativeExportStage(`${phase}_entry_start`, { ordinal: currentOrdinal });
      void Promise.resolve(onEntry(entry, currentOrdinal)).then(
        () => {
          active -= 1;
          traceNativeExportStage(`${phase}_entry_complete`, { ordinal: currentOrdinal });
          if (hasFailure) fail(failure);
          else if (ended && active === 0) finish();
          else requestNext();
        },
        (error) => {
          active -= 1;
          fail(error);
        }
      );
      requestNext();
    };
    zipFile.on('error', handleError);
    zipFile.on('end', handleEnd);
    zipFile.on('entry', handleEntry);
    requestNext();
  });
}

function normalizeZipRuntimeError(error: Error): Error {
  const relativePath = error.message.match(/^invalid relative path: (.+)$/i)?.[1];
  if (relativePath) {
    return new NativeExportArchiveError(
      'native_export_path_traversal',
      `ZIP entry path ${relativePath} contains an unsafe segment.`,
      relativePath
    );
  }
  return error;
}

function openZipEntryStream(zipFile: ZipFile, entry: Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) reject(error);
      else resolve(stream);
    });
  });
}

function ignoreErrorAfterSettlement(): void {}

function closeZip(zipFile: ZipFile): void {
  if (zipFile.isOpen) zipFile.close();
}

function validateCapture(value: NativeExportEntryCapture): NativeExportEntryCapture {
  if (!value || !['none', 'prefix', 'full'].includes(value.kind)) {
    throw new NativeExportArchiveError(
      'native_export_invalid_capture_policy',
      'Entry capture policy is invalid.'
    );
  }
  if (value.kind === 'none') return value;
  nonNegativeSafeInteger(value.maxBytes, 'capture byte limit');
  return value;
}

function validateLimits(value: NativeExportArchiveLimits): NativeExportArchiveLimits {
  positiveSafeInteger(value.maxEntries, 'maximum archive entries');
  positiveSafeInteger(value.maxEntryUncompressedBytes, 'maximum entry size');
  positiveSafeInteger(value.maxTotalUncompressedBytes, 'maximum archive size');
  if (!Number.isFinite(value.maxCompressionRatio) || value.maxCompressionRatio < 1) {
    throw new NativeExportArchiveError(
      'native_export_invalid_limit',
      'Maximum compression ratio must be at least one.'
    );
  }
  return value;
}

function stableEntryIdentity(entry: NativeExportArchiveEntry): string {
  return JSON.stringify(entry);
}

function requiredLogicalFilename(value: string): string {
  const filename = value.trim();
  if (!filename || filename.includes('\0') || filename.includes('/') || filename.includes('\\')) {
    throw new NativeExportArchiveError(
      'native_export_invalid_filename',
      'Archive logical filename must be one safe filename.'
    );
  }
  return filename;
}

function requiredLocalPath(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new NativeExportArchiveError(
      'native_export_invalid_local_path',
      'Archive local path is required.'
    );
  }
  return value;
}

function normalizeSha256(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^sha256:/, 'sha256:');
  const prefixed = normalized.startsWith('sha256:') ? normalized : `sha256:${normalized}`;
  if (!SHA256.test(prefixed)) {
    throw new NativeExportArchiveError(
      'native_export_invalid_hash',
      'Expected archive SHA-256 must contain exactly 64 hexadecimal characters.'
    );
  }
  return prefixed;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new NativeExportArchiveError(
      'native_export_invalid_size',
      `${label} must be a positive safe integer.`
    );
  }
  return value;
}

function nonNegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new NativeExportArchiveError(
      'native_export_invalid_size',
      `${label} must be a non-negative safe integer.`
    );
  }
  return value;
}

function safeSum(values: number[], code: string): number {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) {
      throw new NativeExportArchiveError(code, 'ZIP entry sizes exceed safe integer precision.');
    }
  }
  return total;
}

function sha256Buffer(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function sha256File(localPath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const value of createReadStream(localPath)) hash.update(value as Buffer);
  return `sha256:${hash.digest('hex')}`;
}

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

const CRC32_SLICES = (() => {
  const slices = [CRC32_TABLE];
  for (let slice = 1; slice < 8; slice += 1) {
    const prior = slices[slice - 1];
    slices.push(
      Uint32Array.from({ length: 256 }, (_, index) => {
        const value = prior[index];
        return (CRC32_TABLE[value & 0xff] ^ (value >>> 8)) >>> 0;
      })
    );
  }
  return slices;
})();

function updateCrc32(crc: number, bytes: Uint8Array): number {
  let value = crc >>> 0;
  let offset = 0;
  const eightByteLimit = bytes.byteLength - (bytes.byteLength % 8);
  while (offset < eightByteLimit) {
    const firstWord =
      bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24);
    value = (value ^ firstWord) >>> 0;
    value =
      CRC32_SLICES[7][value & 0xff] ^
      CRC32_SLICES[6][(value >>> 8) & 0xff] ^
      CRC32_SLICES[5][(value >>> 16) & 0xff] ^
      CRC32_SLICES[4][value >>> 24] ^
      CRC32_SLICES[3][bytes[offset + 4]] ^
      CRC32_SLICES[2][bytes[offset + 5]] ^
      CRC32_SLICES[1][bytes[offset + 6]] ^
      CRC32_SLICES[0][bytes[offset + 7]];
    offset += 8;
  }
  while (offset < bytes.byteLength) {
    value = CRC32_TABLE[(value ^ bytes[offset]) & 0xff] ^ (value >>> 8);
    offset += 1;
  }
  return value >>> 0;
}
