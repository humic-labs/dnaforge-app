import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readFile, readdir, stat, unlink } from 'node:fs/promises';
import { posix, resolve, win32 } from 'node:path';

export interface ContentBlobReceipt {
  sha256: string;
  size: number;
  path: string;
}

export type ContentBlobIngestionProgress = Readonly<{
  bytesWritten: number;
  totalBytes: number | null;
}>;

export interface ContentBlobIngestionOptions {
  expectedSha256?: string;
  expectedSize?: number;
  maxBytes?: number;
  onProgress?: (progress: ContentBlobIngestionProgress) => void | Promise<void>;
}

export interface LogicalContentManifestEntry {
  logicalFilename: string;
  sourceArchivePath: string;
  sha256: string;
  size: number;
  archivePartId?: string;
  sourceObjectId?: string | null;
}

export interface ContentArchiveManifest {
  version: 1;
  entries: readonly LogicalContentManifestEntry[];
}

export interface ProviderArchiveEntry {
  path: string;
  uncompressedBytes: number;
  isDirectory?: boolean;
}

export interface ArchiveEntryLimits {
  maxEntries: number;
  maxEntryUncompressedBytes: number;
  maxTotalUncompressedBytes: number;
}

export interface ValidatedArchiveEntries {
  entries: readonly ProviderArchiveEntry[];
  totalUncompressedBytes: number;
}

export interface ArchiveEntryValidationOptions {
  allowOpaqueNestedArchives?: boolean;
}

export type ArchiveEntryValidationErrorCode =
  | 'invalid_limits'
  | 'too_many_entries'
  | 'invalid_entry_path'
  | 'absolute_entry_path'
  | 'entry_path_traversal'
  | 'entry_path_collision'
  | 'nested_archive'
  | 'invalid_entry_size'
  | 'entry_too_large'
  | 'archive_too_large';

export class ArchiveEntryValidationError extends Error {
  readonly code: ArchiveEntryValidationErrorCode;
  readonly entryPath: string | null;

  constructor(
    code: ArchiveEntryValidationErrorCode,
    message: string,
    entryPath: string | null = null
  ) {
    super(message);
    this.name = 'ArchiveEntryValidationError';
    this.code = code;
    this.entryPath = entryPath;
  }
}

export const DEFAULT_ARCHIVE_ENTRY_LIMITS: Readonly<ArchiveEntryLimits> = Object.freeze({
  maxEntries: 100_000,
  maxEntryUncompressedBytes: 2 * 1024 * 1024 * 1024,
  maxTotalUncompressedBytes: 20 * 1024 * 1024 * 1024,
});

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const INCOMING_BLOB_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.blob$/u;
const MAX_INCOMING_BLOB_CLEANUP_ENTRIES = 10_000;
const MANIFEST_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const TEMPORARY_MANIFEST_NAME =
  /^\.[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/u;
const MAX_MANIFEST_CLEANUP_ENTRIES = 100_000;
const WINDOWS_DRIVE_PATH_PATTERN = /^[a-zA-Z]:/;
const NESTED_ARCHIVE_SUFFIXES = [
  '.tar.gz',
  '.tar.bz2',
  '.tar.xz',
  '.tbz2',
  '.tgz',
  '.txz',
  '.zip',
  '.tar',
  '.7z',
  '.rar',
  '.gz',
  '.bz2',
  '.xz',
] as const;

function validationError(
  code: ArchiveEntryValidationErrorCode,
  message: string,
  entryPath: string | null = null
): never {
  throw new ArchiveEntryValidationError(code, message, entryPath);
}

function assertLimits(limits: ArchiveEntryLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      validationError('invalid_limits', `${name} must be a non-negative safe integer.`);
    }
  }
}

function assertSafeProviderPath(entryPath: string): void {
  if (entryPath.length === 0 || hasControlCharacter(entryPath)) {
    validationError('invalid_entry_path', 'Archive entry paths must be non-empty text.', entryPath);
  }
  if (entryPath.includes('\\')) {
    validationError(
      'invalid_entry_path',
      'Archive entry paths cannot contain backslashes.',
      entryPath
    );
  }
  if (
    posix.isAbsolute(entryPath) ||
    win32.isAbsolute(entryPath) ||
    WINDOWS_DRIVE_PATH_PATTERN.test(entryPath)
  ) {
    validationError('absolute_entry_path', 'Archive entry paths must be relative.', entryPath);
  }

  const segments = entryPath.split('/');
  if (segments.some((segment) => segment === '..')) {
    validationError(
      'entry_path_traversal',
      'Archive entry paths cannot traverse parent directories.',
      entryPath
    );
  }
  if (segments.some((segment) => segment === '.')) {
    validationError(
      'invalid_entry_path',
      'Archive entry paths cannot contain dot path segments.',
      entryPath
    );
  }
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

function collisionKey(entryPath: string): string {
  return posix.normalize(entryPath).replace(/\/$/, '').normalize('NFC').toLowerCase();
}

function isNestedArchive(entryPath: string): boolean {
  const lowerPath = entryPath.toLowerCase();
  return NESTED_ARCHIVE_SUFFIXES.some((suffix) => lowerPath.endsWith(suffix));
}

export function validateArchiveEntries(
  entries: readonly ProviderArchiveEntry[],
  limits: Readonly<ArchiveEntryLimits> = DEFAULT_ARCHIVE_ENTRY_LIMITS,
  options: Readonly<ArchiveEntryValidationOptions> = {}
): ValidatedArchiveEntries {
  assertLimits(limits);
  if (entries.length > limits.maxEntries) {
    validationError(
      'too_many_entries',
      `Archive contains ${entries.length} entries; limit is ${limits.maxEntries}.`
    );
  }

  const pathsByCollisionKey = new Map<string, string>();
  let totalUncompressedBytes = 0;
  const validatedEntries: ProviderArchiveEntry[] = [];

  for (const entry of entries) {
    assertSafeProviderPath(entry.path);

    const key = collisionKey(entry.path);
    const priorPath = pathsByCollisionKey.get(key);
    if (priorPath !== undefined) {
      validationError(
        'entry_path_collision',
        `Archive paths "${priorPath}" and "${entry.path}" normalize to the same path.`,
        entry.path
      );
    }
    pathsByCollisionKey.set(key, entry.path);

    if (
      !entry.isDirectory &&
      isNestedArchive(entry.path) &&
      options.allowOpaqueNestedArchives !== true
    ) {
      validationError(
        'nested_archive',
        'Nested archives are not supported in migration exports.',
        entry.path
      );
    }

    if (!Number.isSafeInteger(entry.uncompressedBytes) || entry.uncompressedBytes < 0) {
      validationError(
        'invalid_entry_size',
        'Archive entry size must be a non-negative safe integer.',
        entry.path
      );
    }
    if (entry.isDirectory && entry.uncompressedBytes !== 0) {
      validationError(
        'invalid_entry_size',
        'Archive directory entries must declare zero uncompressed bytes.',
        entry.path
      );
    }
    if (entry.uncompressedBytes > limits.maxEntryUncompressedBytes) {
      validationError(
        'entry_too_large',
        `Archive entry exceeds the ${limits.maxEntryUncompressedBytes}-byte per-entry limit.`,
        entry.path
      );
    }
    if (entry.uncompressedBytes > limits.maxTotalUncompressedBytes - totalUncompressedBytes) {
      validationError(
        'archive_too_large',
        `Archive exceeds the ${limits.maxTotalUncompressedBytes}-byte total limit.`,
        entry.path
      );
    }

    totalUncompressedBytes += entry.uncompressedBytes;
    validatedEntries.push({ ...entry });
  }

  return {
    entries: validatedEntries,
    totalUncompressedBytes,
  };
}

async function hashFile(path: string): Promise<{ sha256: string; size: number }> {
  const pathStat = await lstat(path);
  if (!pathStat.isFile()) {
    throw new Error('Content archive blobs must be regular files.');
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const openedStat = await handle.stat();
    if (
      !openedStat.isFile() ||
      openedStat.dev !== pathStat.dev ||
      openedStat.ino !== pathStat.ino ||
      openedStat.size !== pathStat.size
    ) {
      throw new Error('Content archive blob changed before integrity validation.');
    }
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(buffer);
      size += buffer.byteLength;
    }
    const finishedStat = await handle.stat();
    if (
      finishedStat.dev !== openedStat.dev ||
      finishedStat.ino !== openedStat.ino ||
      finishedStat.size !== openedStat.size ||
      size !== openedStat.size
    ) {
      throw new Error('Content archive blob changed during integrity validation.');
    }
    return { sha256: hash.digest('hex'), size };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function normalizeExpectedSha256(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^sha256:/, '');
  if (!SHA256_PATTERN.test(normalized)) {
    throw new Error('Expected content SHA-256 must contain exactly 64 hexadecimal characters.');
  }
  return normalized;
}

function optionalNonNegativeSafeInteger(
  value: number | undefined,
  label: string
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function validateIngestionOptions(
  options: Readonly<ContentBlobIngestionOptions>
): ContentBlobIngestionOptions {
  const expectedSha256 = normalizeExpectedSha256(options.expectedSha256);
  const expectedSize = optionalNonNegativeSafeInteger(
    options.expectedSize,
    'Expected content size'
  );
  const maxBytes = optionalNonNegativeSafeInteger(options.maxBytes, 'Maximum content size');
  if (expectedSize !== undefined && maxBytes !== undefined && expectedSize > maxBytes) {
    throw new Error('Expected content size exceeds the configured maximum content size.');
  }
  if (options.onProgress !== undefined && typeof options.onProgress !== 'function') {
    throw new Error('Content archive progress callback must be a function.');
  }
  return {
    ...(expectedSha256 === undefined ? {} : { expectedSha256 }),
    ...(expectedSize === undefined ? {} : { expectedSize }),
    ...(maxBytes === undefined ? {} : { maxBytes }),
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
  };
}

export class ContentArchive {
  readonly rootDirectory: string;

  constructor(rootDirectory: string) {
    if (rootDirectory.trim().length === 0) {
      throw new Error('Content archive root directory is required.');
    }
    this.rootDirectory = resolve(rootDirectory);
  }

  async cleanupIncomingBlobs(): Promise<number> {
    const incomingDirectory = resolve(this.rootDirectory, 'incoming');
    const entries = await readdir(incomingDirectory, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
    );
    if (entries.length > MAX_INCOMING_BLOB_CLEANUP_ENTRIES) {
      throw new Error('Content archive incoming cleanup exceeds the bounded entry limit.');
    }
    let removed = 0;
    for (const entry of entries) {
      if (!INCOMING_BLOB_NAME.test(entry.name) || entry.isDirectory()) continue;
      await unlink(resolve(incomingDirectory, entry.name));
      removed += 1;
    }
    return removed;
  }

  async cleanupTemporaryManifests(): Promise<number> {
    const manifestDirectory = resolve(this.rootDirectory, 'manifests');
    const entries = await readdir(manifestDirectory, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
    );
    if (entries.length > MAX_MANIFEST_CLEANUP_ENTRIES) {
      throw new Error('Content archive manifest cleanup exceeds the bounded entry limit.');
    }
    let removed = 0;
    for (const entry of entries) {
      if (!TEMPORARY_MANIFEST_NAME.test(entry.name) || entry.isDirectory()) continue;
      await unlink(resolve(manifestDirectory, entry.name));
      removed += 1;
    }
    return removed;
  }

  private blobPath(sha256: string): string {
    return resolve(this.rootDirectory, 'blobs', 'sha256', sha256.slice(0, 2), sha256);
  }

  private async assertExistingBlob(
    path: string,
    expectedSha256: string,
    expectedSize: number
  ): Promise<void> {
    const existing = await hashFile(path);
    if (existing.size !== expectedSize || existing.sha256 !== expectedSha256) {
      throw new Error(`Content archive blob failed integrity validation: ${expectedSha256}`);
    }
  }

  private async persistTemporaryBlob(
    temporaryPath: string,
    sha256: string,
    size: number
  ): Promise<ContentBlobReceipt> {
    const destinationPath = this.blobPath(sha256);
    await mkdir(resolve(destinationPath, '..'), { recursive: true });

    try {
      await link(temporaryPath, destinationPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await this.assertExistingBlob(destinationPath, sha256, size);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }

    return { sha256, size, path: destinationPath };
  }

  async putBuffer(content: Uint8Array): Promise<ContentBlobReceipt> {
    const buffer = Buffer.from(content);
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const size = buffer.byteLength;
    const destinationPath = this.blobPath(sha256);

    try {
      await stat(destinationPath);
      await this.assertExistingBlob(destinationPath, sha256, size);
      return { sha256, size, path: destinationPath };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const temporaryDirectory = resolve(this.rootDirectory, 'incoming');
    await mkdir(temporaryDirectory, { recursive: true });
    const temporaryPath = resolve(temporaryDirectory, `${randomUUID()}.blob`);
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(buffer);
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    await handle.close();

    return this.persistTemporaryBlob(temporaryPath, sha256, size);
  }

  async putStream(
    content: AsyncIterable<Uint8Array>,
    options: Readonly<ContentBlobIngestionOptions> = {}
  ): Promise<ContentBlobReceipt> {
    if (!content || typeof content[Symbol.asyncIterator] !== 'function') {
      throw new Error('Content archive stream must be an async iterable of bytes.');
    }
    const validated = validateIngestionOptions(options);
    const temporaryDirectory = resolve(this.rootDirectory, 'incoming');
    await mkdir(temporaryDirectory, { recursive: true });
    const temporaryPath = resolve(temporaryDirectory, `${randomUUID()}.blob`);
    const handle = await open(temporaryPath, 'wx', 0o600);
    const hash = createHash('sha256');
    let size = 0;

    try {
      await validated.onProgress?.({
        bytesWritten: 0,
        totalBytes: validated.expectedSize ?? null,
      });
      for await (const value of content) {
        const byteArray =
          Buffer.isBuffer(value) ||
          (ArrayBuffer.isView(value) &&
            (value as Uint8Array).BYTES_PER_ELEMENT === Uint8Array.BYTES_PER_ELEMENT);
        if (!byteArray) {
          throw new Error('Content archive streams may yield only byte arrays.');
        }
        const chunk = Buffer.isBuffer(value)
          ? value
          : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        if (chunk.byteLength > Number.MAX_SAFE_INTEGER - size) {
          throw new Error('Content archive stream exceeds the maximum safe byte length.');
        }
        const nextSize = size + chunk.byteLength;
        if (validated.expectedSize !== undefined && nextSize > validated.expectedSize) {
          throw new Error(
            `Content size exceeds expected size ${validated.expectedSize} while streaming.`
          );
        }
        if (validated.maxBytes !== undefined && nextSize > validated.maxBytes) {
          throw new Error(
            `Content size exceeds configured maximum ${validated.maxBytes} while streaming.`
          );
        }
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.byteLength) {
          const written = await handle.write(chunk, offset, chunk.byteLength - offset);
          if (written.bytesWritten <= 0) {
            throw new Error('Content archive stream write made no forward progress.');
          }
          offset += written.bytesWritten;
        }
        size = nextSize;
        await validated.onProgress?.({
          bytesWritten: size,
          totalBytes: validated.expectedSize ?? null,
        });
      }

      if (validated.expectedSize !== undefined && size !== validated.expectedSize) {
        throw new Error(
          `Content size ${size} does not match expected size ${validated.expectedSize}.`
        );
      }
      const sha256 = hash.digest('hex');
      if (validated.expectedSha256 !== undefined && sha256 !== validated.expectedSha256) {
        throw new Error(`Content SHA-256 ${sha256} does not match the expected digest.`);
      }
      await handle.sync();
      await handle.close();
      return await this.persistTemporaryBlob(temporaryPath, sha256, size);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  async putFile(
    sourcePath: string,
    options: Readonly<ContentBlobIngestionOptions> = {}
  ): Promise<ContentBlobReceipt> {
    const sourceStat = await lstat(sourcePath);
    if (!sourceStat.isFile()) {
      throw new Error('Content archive inputs must be regular files.');
    }
    const validated = validateIngestionOptions(options);
    if (validated.expectedSize !== undefined && sourceStat.size !== validated.expectedSize) {
      throw new Error(
        `Content file size ${sourceStat.size} does not match expected size ${validated.expectedSize}.`
      );
    }
    if (validated.maxBytes !== undefined && sourceStat.size > validated.maxBytes) {
      throw new Error(`Content file size exceeds configured maximum ${validated.maxBytes}.`);
    }

    const sourceHandle = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const openedStat = await sourceHandle.stat();
      if (
        !openedStat.isFile() ||
        openedStat.dev !== sourceStat.dev ||
        openedStat.ino !== sourceStat.ino ||
        openedStat.size !== sourceStat.size
      ) {
        throw new Error('Content archive input changed before it could be read.');
      }
      return await this.putStream(sourceHandle.createReadStream({ autoClose: false }), {
        ...validated,
        expectedSize: validated.expectedSize ?? openedStat.size,
      });
    } finally {
      await sourceHandle.close().catch(() => undefined);
    }
  }

  async writeManifest(
    manifestId: string,
    manifest: Readonly<ContentArchiveManifest>
  ): Promise<string> {
    if (!MANIFEST_ID_PATTERN.test(manifestId) || manifestId === '.' || manifestId === '..') {
      throw new Error('Manifest ID contains unsupported characters.');
    }
    if (manifest.version !== 1 || !Array.isArray(manifest.entries)) {
      throw new Error('Unsupported content archive manifest.');
    }

    const sourcePathCollisionKeys = new Set<string>();
    for (const entry of manifest.entries) {
      assertSafeProviderPath(entry.sourceArchivePath);
      const key = collisionKey(entry.sourceArchivePath);
      if (sourcePathCollisionKeys.has(key)) {
        throw new Error(`Content manifest source path collision: ${entry.sourceArchivePath}`);
      }
      sourcePathCollisionKeys.add(key);
    }

    for (const entry of manifest.entries) {
      if (entry.logicalFilename.length === 0 || entry.logicalFilename.includes('\u0000')) {
        throw new Error('Logical filenames must be non-empty text.');
      }
      if (!SHA256_PATTERN.test(entry.sha256)) {
        throw new Error(`Manifest entry has an invalid SHA-256 digest: ${entry.sha256}`);
      }
      const hasArchivePartId = Object.prototype.hasOwnProperty.call(entry, 'archivePartId');
      const hasSourceObjectId = Object.prototype.hasOwnProperty.call(entry, 'sourceObjectId');
      if (hasArchivePartId !== hasSourceObjectId) {
        throw new Error('Content manifest association must include both identities.');
      }
      if (hasArchivePartId) {
        assertManifestAssociation(entry.archivePartId, entry.sourceObjectId);
      }
      const blobPath = this.blobPath(entry.sha256);
      const blobStat = await stat(blobPath);
      if (!blobStat.isFile() || blobStat.size !== entry.size) {
        throw new Error(`Manifest entry does not match its archived blob: ${entry.sha256}`);
      }
    }

    const manifestDirectory = resolve(this.rootDirectory, 'manifests');
    const destinationPath = resolve(manifestDirectory, `${manifestId}.json`);
    await mkdir(manifestDirectory, { recursive: true });
    const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
    const temporaryPath = resolve(manifestDirectory, `.${manifestId}.${randomUUID()}.tmp`);
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    await handle.close();

    try {
      await link(temporaryPath, destinationPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await readFile(destinationPath, 'utf8');
      if (existing !== serialized) {
        throw new Error(`Content archive manifest already exists: ${manifestId}`);
      }
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }

    return destinationPath;
  }

  async readManifest(manifestId: string): Promise<ContentArchiveManifest> {
    if (!MANIFEST_ID_PATTERN.test(manifestId) || manifestId === '.' || manifestId === '..') {
      throw new Error('Manifest ID contains unsupported characters.');
    }
    const path = resolve(this.rootDirectory, 'manifests', `${manifestId}.json`);
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Content archive manifest is malformed: ${manifestId}`);
    }
    const candidate = parsed as Record<string, unknown>;
    if (
      candidate.version !== 1 ||
      !Array.isArray(candidate.entries) ||
      Object.keys(candidate).some((key) => key !== 'version' && key !== 'entries')
    ) {
      throw new Error(`Content archive manifest is malformed: ${manifestId}`);
    }
    const entries = candidate.entries.map((entry, index): LogicalContentManifestEntry => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`Content archive manifest entry ${index + 1} is malformed.`);
      }
      const value = entry as Record<string, unknown>;
      const hasArchivePartId = Object.prototype.hasOwnProperty.call(value, 'archivePartId');
      const hasSourceObjectId = Object.prototype.hasOwnProperty.call(value, 'sourceObjectId');
      if (
        typeof value.logicalFilename !== 'string' ||
        value.logicalFilename.length === 0 ||
        value.logicalFilename.includes('\u0000') ||
        typeof value.sourceArchivePath !== 'string' ||
        typeof value.sha256 !== 'string' ||
        !SHA256_PATTERN.test(value.sha256) ||
        !Number.isSafeInteger(value.size) ||
        (value.size as number) < 0 ||
        Object.keys(value).some(
          (key) =>
            key !== 'logicalFilename' &&
            key !== 'sourceArchivePath' &&
            key !== 'sha256' &&
            key !== 'size' &&
            key !== 'archivePartId' &&
            key !== 'sourceObjectId'
        )
      ) {
        throw new Error(`Content archive manifest entry ${index + 1} is malformed.`);
      }
      if (hasArchivePartId !== hasSourceObjectId) {
        throw new Error(`Content archive manifest entry ${index + 1} is malformed.`);
      }
      if (hasArchivePartId) {
        assertManifestAssociation(value.archivePartId, value.sourceObjectId);
      }
      assertSafeProviderPath(value.sourceArchivePath);
      return {
        logicalFilename: value.logicalFilename,
        sourceArchivePath: value.sourceArchivePath,
        sha256: value.sha256,
        size: value.size as number,
        ...(hasArchivePartId
          ? {
              archivePartId: value.archivePartId as string,
              sourceObjectId: value.sourceObjectId as string | null,
            }
          : {}),
      };
    });
    const collisionKeys = new Set<string>();
    for (const entry of entries) {
      const key = collisionKey(entry.sourceArchivePath);
      if (collisionKeys.has(key)) {
        throw new Error(`Content manifest source path collision: ${entry.sourceArchivePath}`);
      }
      collisionKeys.add(key);
    }
    return { version: 1, entries };
  }

  async verifyBlob(expectedSha256: string, expectedSize: number): Promise<ContentBlobReceipt> {
    const sha256 = normalizeExpectedSha256(expectedSha256);
    const size = optionalNonNegativeSafeInteger(expectedSize, 'Expected content size');
    if (sha256 === undefined || size === undefined) {
      throw new Error('Content archive blob verification requires a digest and size.');
    }
    const path = this.blobPath(sha256);
    await this.assertExistingBlob(path, sha256, size);
    return { sha256, size, path };
  }

  async assertBlobPresent(
    expectedSha256: string,
    expectedSize: number
  ): Promise<ContentBlobReceipt> {
    const sha256 = normalizeExpectedSha256(expectedSha256);
    const size = optionalNonNegativeSafeInteger(expectedSize, 'Expected content size');
    if (sha256 === undefined || size === undefined) {
      throw new Error('Content archive blob presence requires a digest and size.');
    }
    const path = this.blobPath(sha256);
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size !== size) {
      throw new Error(`Content archive blob is missing or has the wrong size: ${sha256}`);
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.size !== before.size
      ) {
        throw new Error('Content archive blob changed during presence validation.');
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
    return { sha256, size, path };
  }

  async verifyManifest(manifestId: string): Promise<ContentArchiveManifest> {
    const manifest = await this.readManifest(manifestId);
    for (const entry of manifest.entries) {
      await this.verifyBlob(entry.sha256, entry.size);
    }
    return manifest;
  }
}

function assertManifestAssociation(archivePartId: unknown, sourceObjectId: unknown): void {
  if (!isStableManifestIdentity(archivePartId)) {
    throw new Error('Content manifest archive-part identity is invalid.');
  }
  if (sourceObjectId !== null && !isStableManifestIdentity(sourceObjectId)) {
    throw new Error('Content manifest source-object identity is invalid.');
  }
}

function isStableManifestIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    value.normalize('NFC') === value &&
    value.trim() === value &&
    !hasAsciiControlCharacter(value)
  );
}

function hasAsciiControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}
