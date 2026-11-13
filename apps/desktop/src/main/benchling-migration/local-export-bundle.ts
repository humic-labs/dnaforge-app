import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from 'node:path';
import type {
  LocalBenchlingExportIntakeDescriptor,
  LocalBenchlingExportPlannedResource,
  LocalBenchlingExportSourceFileIdentity,
} from '../../shared/benchling-migration';
import { ContentArchive } from './content-archive';
import {
  DEFAULT_NATIVE_EXPORT_ARCHIVE_LIMITS,
  inspectNativeExportArchive,
  type NativeExportArchiveSource,
} from './native-export-archive';

const LOCAL_EXPORT_ARTIFACT_SCHEMA = 'dnaforge.benchling.local-export-artifact.v1' as const;
const LOCAL_EXPORT_INTAKE_SCHEMA = 'dnaforge.benchling.local-export-intake.v1' as const;
const WORKSPACE_MIGRATION_ARCHIVE_PATH = ['.dnaforge', 'migration', 'archive'] as const;
const HTML_SHAPE_SCAN_BYTES = 64 * 1024;
const MAX_STANDALONE_HTML_BYTES = 16 * 1024 * 1024;
const MAX_LOCAL_RESOURCE_REFERENCES = DEFAULT_NATIVE_EXPORT_ARCHIVE_LIMITS.maxEntries;
const MAX_LOCAL_RESOURCE_BYTES = DEFAULT_NATIVE_EXPORT_ARCHIVE_LIMITS.maxEntryUncompressedBytes;
const MAX_LOCAL_RESOURCES_TOTAL_BYTES =
  DEFAULT_NATIVE_EXPORT_ARCHIVE_LIMITS.maxTotalUncompressedBytes;
const RESOURCE_TAG_PATTERN = /<(?:img|source)\b[^>]*>/giu;
const RESOURCE_ATTRIBUTE_PATTERN = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/giu;
const SRCSET_ATTRIBUTE_PATTERN = /\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/giu;

export const DEFAULT_LOCAL_BENCHLING_EXPORT_MAX_BYTES =
  DEFAULT_NATIVE_EXPORT_ARCHIVE_LIMITS.maxTotalUncompressedBytes;

type LocalPathNativeExportSource = Extract<NativeExportArchiveSource, { kind: 'local_path' }>;

type VerifiedLocalBenchlingExportBase = Readonly<{
  schema: typeof LOCAL_EXPORT_ARTIFACT_SCHEMA;
  logicalFilename: string;
  sha256: `sha256:${string}`;
  sizeBytes: number;
  immutableLocalPath: string;
}>;

export type VerifiedLocalBenchlingExportResource = Readonly<{
  sourceRef: string;
  relativePath: string;
  logicalFilename: string;
  sha256: `sha256:${string}`;
  sizeBytes: number;
  mediaType: string;
  immutableLocalPath: string;
}>;

export type VerifiedLocalBenchlingZipExport = VerifiedLocalBenchlingExportBase &
  Readonly<{
    format: 'zip';
    nativeExportDecoderSource: LocalPathNativeExportSource;
    resources: readonly [];
    archive: Readonly<{
      entryCount: number;
      totalCompressedEntryBytes: number;
      totalUncompressedEntryBytes: number;
    }>;
  }>;

export type VerifiedLocalBenchlingHtmlExport = VerifiedLocalBenchlingExportBase &
  Readonly<{
    format: 'html';
    mediaType: 'text/html';
    resources: readonly VerifiedLocalBenchlingExportResource[];
    nativeExportDecoderSource: null;
    archive: null;
  }>;

export type VerifiedLocalBenchlingExportArtifact =
  | VerifiedLocalBenchlingZipExport
  | VerifiedLocalBenchlingHtmlExport;

export type LocalBenchlingExportIntakeInput = Readonly<{
  workspacePath: string;
  sourcePath: string;
  maxSourceBytes?: number;
  expectedDescriptor?: LocalBenchlingExportIntakeDescriptor;
  onProgress?: (progress: LocalBenchlingExportIntakeProgress) => void | Promise<void>;
}>;

export type LocalBenchlingExportIntakeProgress = Readonly<{
  copiedBytes: number;
  totalBytes: number;
}>;

export type LocalBenchlingExportIntakeErrorCode =
  | 'local_export_invalid_workspace_path'
  | 'local_export_invalid_source_path'
  | 'local_export_unsupported_extension'
  | 'local_export_not_regular_file'
  | 'local_export_empty'
  | 'local_export_content_mismatch'
  | 'local_export_resource_path_invalid'
  | 'local_export_resource_ambiguous'
  | 'local_export_resource_not_regular_file'
  | 'local_export_resources_too_large'
  | 'local_export_invalid_size_limit'
  | 'local_export_too_large'
  | 'local_export_source_changed'
  | 'local_export_acquisition_disabled'
  | 'local_export_migration_already_active';

export class LocalBenchlingExportIntakeError extends Error {
  constructor(
    readonly code: LocalBenchlingExportIntakeErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'LocalBenchlingExportIntakeError';
  }
}

export async function createLocalBenchlingExportIntakeDescriptor(input: {
  sourcePath: string;
  selectedAt: string;
  maxSourceBytes?: number;
}): Promise<LocalBenchlingExportIntakeDescriptor> {
  const selectedAt = normalizedTimestamp(input.selectedAt, 'Local export selection time');
  const plan = await inspectLocalBenchlingExportSources(input.sourcePath, input.maxSourceBytes);
  return {
    schema: LOCAL_EXPORT_INTAKE_SCHEMA,
    sourcePath: plan.sourcePath,
    logicalFilename: plan.logicalFilename,
    format: plan.format,
    selectedAt,
    sourceIdentity: plan.sourceIdentity,
    plannedResources: plan.plannedResources,
    plannedCopyBytes: plan.plannedCopyBytes,
  };
}

export async function verifyLocalBenchlingExportIntakeDescriptor(
  descriptor: LocalBenchlingExportIntakeDescriptor,
  maxSourceBytes?: number
): Promise<void> {
  const observed = await inspectLocalBenchlingExportSources(descriptor.sourcePath, maxSourceBytes);
  assertMatchingIntakeDescriptor(descriptor, observed);
}

export async function intakeLocalBenchlingExportBundle(
  input: LocalBenchlingExportIntakeInput
): Promise<VerifiedLocalBenchlingExportArtifact> {
  const workspacePath = requiredAbsolutePath(
    input.workspacePath,
    'local_export_invalid_workspace_path',
    'Workspace path'
  );
  const sourcePath = requiredAbsolutePath(
    input.sourcePath,
    'local_export_invalid_source_path',
    'Local export path'
  );
  const observedPlan = await inspectLocalBenchlingExportSources(sourcePath, input.maxSourceBytes);
  const expectedDescriptor = input.expectedDescriptor;
  if (expectedDescriptor) assertMatchingIntakeDescriptor(expectedDescriptor, observedPlan);
  const plan = expectedDescriptor ?? {
    schema: LOCAL_EXPORT_INTAKE_SCHEMA,
    sourcePath: observedPlan.sourcePath,
    logicalFilename: observedPlan.logicalFilename,
    format: observedPlan.format,
    selectedAt: new Date(0).toISOString(),
    sourceIdentity: observedPlan.sourceIdentity,
    plannedResources: observedPlan.plannedResources,
    plannedCopyBytes: observedPlan.plannedCopyBytes,
  };
  const { format } = plan;
  const effectiveSourceLimit =
    format === 'html'
      ? Math.min(sourceByteLimit(input.maxSourceBytes), MAX_STANDALONE_HTML_BYTES)
      : sourceByteLimit(input.maxSourceBytes);
  let copiedBytes = 0;
  const publishProgress = async (nextCopiedBytes: number): Promise<void> => {
    if (!Number.isSafeInteger(nextCopiedBytes) || nextCopiedBytes < copiedBytes) {
      throw new Error('Local export intake progress must be monotonic.');
    }
    copiedBytes = nextCopiedBytes;
    await input.onProgress?.({ copiedBytes, totalBytes: plan.plannedCopyBytes });
  };

  const logicalFilename = plan.logicalFilename;
  const archiveRoot = join(workspacePath, ...WORKSPACE_MIGRATION_ARCHIVE_PATH);
  const contentArchive = new ContentArchive(archiveRoot);
  const storedBlob = await contentArchive.putFile(sourcePath, {
    expectedSize: plan.sourceIdentity.sizeBytes,
    maxBytes: effectiveSourceLimit,
    onProgress: ({ bytesWritten }) => publishProgress(bytesWritten),
  });
  await assertSourceIdentityMatches(sourcePath, plan.sourceIdentity, 'selected local export');
  const blob = await contentArchive.assertBlobPresent(storedBlob.sha256, storedBlob.size);
  const sha256 = `sha256:${blob.sha256}` as const;
  const base = {
    schema: LOCAL_EXPORT_ARTIFACT_SCHEMA,
    logicalFilename,
    sha256,
    sizeBytes: blob.size,
    immutableLocalPath: blob.path,
  } satisfies VerifiedLocalBenchlingExportBase;

  if (format === 'html') {
    await readAndAssertUtf8HtmlArtifact(blob.path);
    const resources = await archiveReferencedHtmlResources({
      archive: contentArchive,
      plannedResources: plan.plannedResources,
      onResourceProgress: (resourceOffset, bytesWritten) =>
        publishProgress(blob.size + resourceOffset + bytesWritten),
    });
    await publishProgress(plan.plannedCopyBytes);
    return {
      ...base,
      format,
      mediaType: 'text/html',
      resources,
      nativeExportDecoderSource: null,
      archive: null,
    };
  }

  const nativeExportDecoderSource: LocalPathNativeExportSource = {
    kind: 'local_path',
    logicalFilename,
    localPath: blob.path,
    expectedSha256: sha256,
    expectedSizeBytes: blob.size,
    duplicateSupportEntryPolicy: 'identical_root_benchling_css',
  };
  const inspected = await inspectNativeExportArchive(nativeExportDecoderSource);
  await publishProgress(plan.plannedCopyBytes);

  return {
    ...base,
    format,
    nativeExportDecoderSource,
    resources: [],
    archive: {
      entryCount: inspected.entries.length,
      totalCompressedEntryBytes: inspected.totalCompressedEntryBytes,
      totalUncompressedEntryBytes: inspected.totalUncompressedEntryBytes,
    },
  };
}

type InspectedLocalBenchlingExportSources = Readonly<{
  sourcePath: string;
  logicalFilename: string;
  format: 'zip' | 'html';
  sourceIdentity: LocalBenchlingExportSourceFileIdentity;
  plannedResources: readonly LocalBenchlingExportPlannedResource[];
  plannedCopyBytes: number;
}>;

async function inspectLocalBenchlingExportSources(
  selectedSourcePath: string,
  maxSourceBytes?: number
): Promise<InspectedLocalBenchlingExportSources> {
  const sourcePath = requiredAbsolutePath(
    selectedSourcePath,
    'local_export_invalid_source_path',
    'Local export path'
  );
  const format = supportedFormat(sourcePath);
  const maxBytes = sourceByteLimit(maxSourceBytes);
  const effectiveSourceLimit =
    format === 'html' ? Math.min(maxBytes, MAX_STANDALONE_HTML_BYTES) : maxBytes;
  const sourceStat = await lstat(sourcePath, { bigint: true }).catch(() => {
    throw new LocalBenchlingExportIntakeError(
      'local_export_invalid_source_path',
      'The selected local export is missing or cannot be read.'
    );
  });
  if (!sourceStat.isFile()) {
    throw new LocalBenchlingExportIntakeError(
      'local_export_not_regular_file',
      'The selected local export must be a regular file, not a symlink or special file.'
    );
  }
  const sourceIdentity = sourceFileIdentity(sourceStat, 'selected local export');
  if (sourceIdentity.sizeBytes === 0) {
    throw new LocalBenchlingExportIntakeError(
      'local_export_empty',
      'The selected local export is empty.'
    );
  }
  if (sourceIdentity.sizeBytes > effectiveSourceLimit) {
    throw new LocalBenchlingExportIntakeError(
      'local_export_too_large',
      `The selected local export is ${sourceIdentity.sizeBytes} bytes; limit is ${effectiveSourceLimit}.`
    );
  }

  let plannedResources: readonly LocalBenchlingExportPlannedResource[] = [];
  if (format === 'html') {
    const html = await readAndAssertUtf8HtmlArtifact(sourcePath);
    await assertSourceIdentityMatches(sourcePath, sourceIdentity, 'selected local export');
    plannedResources = await planReferencedHtmlResources({
      html,
      selectedHtmlPath: sourcePath,
      topLevelSizeBytes: sourceIdentity.sizeBytes,
    });
  }
  const uniquePlannedResources = [
    ...new Map(
      plannedResources.map((resource) => [resource.relativePath, resource] as const)
    ).values(),
  ];
  const plannedCopyBytes = uniquePlannedResources.reduce((total, resource) => {
    if (resource.identity.sizeBytes > Number.MAX_SAFE_INTEGER - total) {
      throw new LocalBenchlingExportIntakeError(
        'local_export_resources_too_large',
        'The selected HTML export and its raster resources exceed the supported byte range.'
      );
    }
    return total + resource.identity.sizeBytes;
  }, sourceIdentity.sizeBytes);
  return {
    sourcePath,
    logicalFilename: basename(sourcePath),
    format,
    sourceIdentity,
    plannedResources,
    plannedCopyBytes,
  };
}

function sourceFileIdentity(
  stat: BigIntStats,
  label: string
): LocalBenchlingExportSourceFileIdentity {
  const sizeBytes = Number(stat.size);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new LocalBenchlingExportIntakeError(
      'local_export_too_large',
      `${label} exceeds the supported byte range.`
    );
  }
  return {
    deviceId: stat.dev.toString(10),
    inode: stat.ino.toString(10),
    sizeBytes,
    modifiedTimeNs: stat.mtimeNs.toString(10),
    changedTimeNs: stat.ctimeNs.toString(10),
  };
}

async function assertSourceIdentityMatches(
  sourcePath: string,
  expected: LocalBenchlingExportSourceFileIdentity,
  label: string
): Promise<void> {
  const stat = await lstat(sourcePath, { bigint: true }).catch(() => null);
  const actual = stat?.isFile() ? sourceFileIdentity(stat, label) : null;
  if (!actual || !sameSourceIdentity(actual, expected)) {
    throw new LocalBenchlingExportIntakeError(
      'local_export_source_changed',
      `The ${label} is missing or changed since it was selected.`
    );
  }
}

function sameSourceIdentity(
  left: LocalBenchlingExportSourceFileIdentity,
  right: LocalBenchlingExportSourceFileIdentity
): boolean {
  return (
    left.deviceId === right.deviceId &&
    left.inode === right.inode &&
    left.sizeBytes === right.sizeBytes &&
    left.modifiedTimeNs === right.modifiedTimeNs &&
    left.changedTimeNs === right.changedTimeNs
  );
}

function assertMatchingIntakeDescriptor(
  expected: LocalBenchlingExportIntakeDescriptor,
  observed: InspectedLocalBenchlingExportSources
): void {
  const selectedAtValid =
    typeof expected.selectedAt === 'string' && Number.isFinite(Date.parse(expected.selectedAt));
  if (
    expected.schema !== LOCAL_EXPORT_INTAKE_SCHEMA ||
    !selectedAtValid ||
    !isSourceFileIdentity(expected.sourceIdentity) ||
    !Array.isArray(expected.plannedResources) ||
    expected.sourcePath !== observed.sourcePath ||
    expected.logicalFilename !== observed.logicalFilename ||
    expected.format !== observed.format ||
    expected.plannedCopyBytes !== observed.plannedCopyBytes ||
    !sameSourceIdentity(expected.sourceIdentity, observed.sourceIdentity) ||
    JSON.stringify(expected.plannedResources) !== JSON.stringify(observed.plannedResources)
  ) {
    throw new LocalBenchlingExportIntakeError(
      'local_export_source_changed',
      'The selected local export or one of its raster resources changed before copying completed.'
    );
  }
}

function isSourceFileIdentity(value: unknown): value is LocalBenchlingExportSourceFileIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const identity = value as Partial<LocalBenchlingExportSourceFileIdentity>;
  return (
    typeof identity.deviceId === 'string' &&
    /^\d+$/u.test(identity.deviceId) &&
    typeof identity.inode === 'string' &&
    /^\d+$/u.test(identity.inode) &&
    Number.isSafeInteger(identity.sizeBytes) &&
    (identity.sizeBytes as number) >= 0 &&
    typeof identity.modifiedTimeNs === 'string' &&
    /^\d+$/u.test(identity.modifiedTimeNs) &&
    typeof identity.changedTimeNs === 'string' &&
    /^\d+$/u.test(identity.changedTimeNs)
  );
}

async function readAndAssertUtf8HtmlArtifact(immutablePath: string): Promise<string> {
  const handle = await open(immutablePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let prefix = '';
  let html = '';
  try {
    for await (const value of handle.createReadStream({ autoClose: false })) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const decoded = decoder.decode(chunk, { stream: true });
      if (decoded.includes('\0')) {
        throw contentMismatch('HTML exports cannot contain NUL bytes.');
      }
      if (prefix.length < HTML_SHAPE_SCAN_BYTES) {
        prefix += decoded.slice(0, HTML_SHAPE_SCAN_BYTES - prefix.length);
      }
      html += decoded;
    }
    const tail = decoder.decode();
    if (tail.includes('\0')) {
      throw contentMismatch('HTML exports cannot contain NUL bytes.');
    }
    if (prefix.length < HTML_SHAPE_SCAN_BYTES) prefix += tail;
    html += tail;
  } catch (error) {
    if (error instanceof LocalBenchlingExportIntakeError) throw error;
    throw contentMismatch(
      `HTML export is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    await handle.close().catch(() => undefined);
  }

  const normalizedPrefix = prefix.replace(/^\uFEFF/u, '');
  if (!/<(?:!doctype\s+html|html|head|body)\b/iu.test(normalizedPrefix)) {
    throw contentMismatch('The selected HTML file does not contain an HTML document.');
  }
  return html;
}

async function archiveReferencedHtmlResources(input: {
  archive: ContentArchive;
  plannedResources: readonly LocalBenchlingExportPlannedResource[];
  onResourceProgress: (completedResourceBytes: number, bytesWritten: number) => Promise<void>;
}): Promise<VerifiedLocalBenchlingExportResource[]> {
  const archivedByRelativePath = new Map<
    string,
    Omit<VerifiedLocalBenchlingExportResource, 'sourceRef'>
  >();
  const resources: VerifiedLocalBenchlingExportResource[] = [];
  let completedResourceBytes = 0;

  for (const planned of input.plannedResources) {
    const prior = archivedByRelativePath.get(planned.relativePath);
    if (prior) {
      resources.push({ sourceRef: planned.sourceRef, ...prior });
      continue;
    }
    await assertSourceIdentityMatches(
      planned.sourcePath,
      planned.identity,
      `planned raster resource ${planned.logicalFilename}`
    );
    const stored = await input.archive.putFile(planned.sourcePath, {
      expectedSize: planned.identity.sizeBytes,
      maxBytes: MAX_LOCAL_RESOURCE_BYTES,
      onProgress: ({ bytesWritten }) =>
        input.onResourceProgress(completedResourceBytes, bytesWritten),
    });
    await assertSourceIdentityMatches(
      planned.sourcePath,
      planned.identity,
      `planned raster resource ${planned.logicalFilename}`
    );
    const verified = await input.archive.verifyBlob(stored.sha256, stored.size);
    completedResourceBytes += verified.size;
    const resource = {
      relativePath: planned.relativePath,
      logicalFilename: planned.logicalFilename,
      sha256: `sha256:${verified.sha256}` as const,
      sizeBytes: verified.size,
      mediaType: planned.mediaType,
      immutableLocalPath: verified.path,
    } satisfies Omit<VerifiedLocalBenchlingExportResource, 'sourceRef'>;
    archivedByRelativePath.set(planned.relativePath, resource);
    resources.push({ sourceRef: planned.sourceRef, ...resource });
  }

  return resources.sort(
    (left, right) =>
      left.sourceRef.localeCompare(right.sourceRef) ||
      left.relativePath.localeCompare(right.relativePath)
  );
}

async function planReferencedHtmlResources(input: {
  html: string;
  selectedHtmlPath: string;
  topLevelSizeBytes: number;
}): Promise<LocalBenchlingExportPlannedResource[]> {
  const references = [
    ...new Set([
      ...localResourceReferences(input.html),
      ...(await linkedPreviewResourceReferences(input.html, input.selectedHtmlPath)),
    ]),
  ].sort();
  if (references.length > MAX_LOCAL_RESOURCE_REFERENCES) {
    throw new LocalBenchlingExportIntakeError(
      'local_export_resources_too_large',
      `HTML export references ${references.length} local resources; limit is ${MAX_LOCAL_RESOURCE_REFERENCES}.`
    );
  }

  const selectedDirectory = dirname(input.selectedHtmlPath);
  const realSelectedDirectory = await realpath(selectedDirectory);
  const resources: LocalBenchlingExportPlannedResource[] = [];
  const identityByRelativePath = new Map<
    string,
    Omit<LocalBenchlingExportPlannedResource, 'sourceRef'>
  >();
  let totalBytes = input.topLevelSizeBytes;

  for (const reference of references) {
    const relativePath = normalizedLocalResourcePath(reference);
    if (relativePath === null || !isSupportedRasterResource(relativePath)) continue;
    const prior = identityByRelativePath.get(relativePath);
    if (prior) {
      resources.push({ sourceRef: reference, ...prior });
      continue;
    }
    const candidatePath = resolve(selectedDirectory, ...relativePath.split('/'));
    assertPathContained(selectedDirectory, candidatePath, reference);
    const candidateStat = await lstat(candidatePath, { bigint: true }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (candidateStat === null) continue;
    if (candidateStat.isSymbolicLink() || !candidateStat.isFile()) {
      throw new LocalBenchlingExportIntakeError(
        'local_export_resource_not_regular_file',
        `Referenced local resource ${relativePath} must be a regular file without symlinks.`
      );
    }
    await assertNoSymlinkResourceSegments(selectedDirectory, relativePath);
    const canonicalCandidatePath = await realpath(candidatePath);
    assertPathContained(realSelectedDirectory, canonicalCandidatePath, reference);
    const identity = sourceFileIdentity(candidateStat, `raster resource ${relativePath}`);
    if (identity.sizeBytes > MAX_LOCAL_RESOURCE_BYTES) {
      throw new LocalBenchlingExportIntakeError(
        'local_export_resources_too_large',
        `Referenced local resource ${relativePath} is ${identity.sizeBytes} bytes; per-resource limit is ${MAX_LOCAL_RESOURCE_BYTES}.`
      );
    }
    if (identity.sizeBytes > MAX_LOCAL_RESOURCES_TOTAL_BYTES - totalBytes) {
      throw new LocalBenchlingExportIntakeError(
        'local_export_resources_too_large',
        `HTML export and referenced resources exceed ${MAX_LOCAL_RESOURCES_TOTAL_BYTES} bytes.`
      );
    }
    totalBytes += identity.sizeBytes;
    const planned = {
      sourcePath: canonicalCandidatePath,
      relativePath,
      logicalFilename: posix.basename(relativePath),
      mediaType: mediaTypeForLocalResource(relativePath),
      identity,
    } satisfies Omit<LocalBenchlingExportPlannedResource, 'sourceRef'>;
    identityByRelativePath.set(relativePath, planned);
    resources.push({ sourceRef: reference, ...planned });
  }
  return resources.sort(
    (left, right) =>
      left.sourceRef.localeCompare(right.sourceRef) ||
      left.relativePath.localeCompare(right.relativePath)
  );
}

function localResourceReferences(html: string): string[] {
  const references = new Set<string>();
  for (const tagMatch of html.matchAll(RESOURCE_TAG_PATTERN)) {
    const tag = tagMatch[0];
    for (const attribute of tag.matchAll(RESOURCE_ATTRIBUTE_PATTERN)) {
      addDecodedResourceReference(references, attribute[1] ?? attribute[2] ?? attribute[3] ?? '');
    }
    for (const attribute of tag.matchAll(SRCSET_ATTRIBUTE_PATTERN)) {
      const value = attribute[1] ?? attribute[2] ?? attribute[3] ?? '';
      for (const candidate of value.split(',')) {
        addDecodedResourceReference(references, candidate.trim().split(/\s+/u)[0] ?? '');
      }
    }
  }
  return [...references].sort();
}

async function linkedPreviewResourceReferences(
  html: string,
  selectedHtmlPath: string
): Promise<string[]> {
  const names = linkedPreviewNames(html);
  if (names.length === 0) return [];
  if (names.length > MAX_LOCAL_RESOURCE_REFERENCES) {
    throw new LocalBenchlingExportIntakeError(
      'local_export_resources_too_large',
      `HTML export contains ${names.length} linked-file previews; limit is ${MAX_LOCAL_RESOURCE_REFERENCES}.`
    );
  }

  const directory = dirname(selectedHtmlPath);
  const htmlStem = basename(selectedHtmlPath, extname(selectedHtmlPath));
  const entries = await readdir(directory, { withFileTypes: true });
  const previewCounts = countPreviewNames(names);
  const candidatesByPreview = new Map<string, string[]>();
  const ownersByCandidate = new Map<string, string[]>();

  for (const [previewKey, preview] of previewCounts) {
    const displayName = preview.displayName;
    if (
      displayName.length > 1024 ||
      displayName !== basename(displayName) ||
      hasControlCharacter(displayName) ||
      /[/\\]/u.test(displayName)
    ) {
      throw invalidResourcePath(displayName);
    }
    const extension = extname(displayName);
    if (!/^(?:\.png|\.jpe?g|\.gif|\.webp)$/iu.test(extension)) continue;
    const displayStem = basename(displayName, extension);
    const candidatePattern = new RegExp(
      `^${escapeRegExp(`${htmlStem} ${displayStem}`)}(?: (\\d+))?${escapeRegExp(extension)}$`,
      'iu'
    );
    const matches = entries
      .filter((entry) => {
        if (!candidatePattern.test(entry.name)) return false;
        const ordinal = collisionOrdinal(entry.name, candidatePattern);
        return ordinal >= 1 && ordinal <= preview.count;
      })
      .sort((left, right) => compareCollisionFilenames(left.name, right.name, candidatePattern));
    if (matches.length > preview.count) {
      throw ambiguousResource(
        `Linked preview ${JSON.stringify(displayName)} matches ${matches.length} sibling images for ${preview.count} preview occurrence(s).`
      );
    }
    const ordinals = matches.map((match) => collisionOrdinal(match.name, candidatePattern));
    if (new Set(ordinals).size !== ordinals.length) {
      throw ambiguousResource(
        `Linked preview ${JSON.stringify(displayName)} has ambiguous sibling collision ordinals.`
      );
    }
    for (const match of matches) {
      if (match.isSymbolicLink() || !match.isFile()) {
        throw new LocalBenchlingExportIntakeError(
          'local_export_resource_not_regular_file',
          `Linked preview resource ${match.name} must be a regular file without symlinks.`
        );
      }
      const owners = ownersByCandidate.get(match.name) ?? [];
      owners.push(previewKey);
      ownersByCandidate.set(match.name, owners);
    }
    candidatesByPreview.set(
      previewKey,
      matches.map((entry) => entry.name)
    );
  }

  for (const [candidate, owners] of ownersByCandidate) {
    if (owners.length > 1) {
      throw ambiguousResource(
        `Linked preview resource ${JSON.stringify(candidate)} matches more than one display name.`
      );
    }
  }
  return [...new Set([...candidatesByPreview.values()].flat())].sort();
}

function linkedPreviewNames(html: string): string[] {
  const result: string[] = [];
  const pattern =
    /<[^>]*\b(?:data-test-element\s*=\s*["']previewItemName["']|class\s*=\s*["'][^"']*\bnote-itemName\b[^"']*["'])[^>]*>([\s\S]{0,4096}?)<\/[^>]+>/giu;
  for (const match of html.matchAll(pattern)) {
    const text = decodeHtmlAttribute(match[1].replace(/<[^>]*>/gu, ' '))
      .replace(/\s+/gu, ' ')
      .trim();
    if (text) result.push(text);
  }
  return result;
}

function countPreviewNames(
  names: readonly string[]
): Map<string, { displayName: string; count: number }> {
  const result = new Map<string, { displayName: string; count: number }>();
  for (const displayName of names) {
    const key = displayName.normalize('NFC').toLowerCase();
    const existing = result.get(key);
    if (existing) existing.count += 1;
    else result.set(key, { displayName, count: 1 });
  }
  return result;
}

function compareCollisionFilenames(left: string, right: string, pattern: RegExp): number {
  const leftOrdinal = collisionOrdinal(left, pattern);
  const rightOrdinal = collisionOrdinal(right, pattern);
  return leftOrdinal - rightOrdinal || left.localeCompare(right);
}

function collisionOrdinal(filename: string, pattern: RegExp): number {
  const match = pattern.exec(filename);
  if (!match) return Number.MAX_SAFE_INTEGER;
  return match[1] === undefined ? 1 : Number.parseInt(match[1], 10);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function ambiguousResource(message: string): LocalBenchlingExportIntakeError {
  return new LocalBenchlingExportIntakeError('local_export_resource_ambiguous', message);
}

function addDecodedResourceReference(target: Set<string>, raw: string): void {
  const decoded = decodeHtmlAttribute(raw).trim();
  if (decoded.length > 0) target.add(decoded);
}

function normalizedLocalResourcePath(reference: string): string | null {
  if (
    reference.startsWith('#') ||
    reference.startsWith('//') ||
    reference.startsWith('/') ||
    /^[a-z][a-z0-9+.-]*:/iu.test(reference)
  ) {
    return null;
  }
  if (reference.length > 4096 || hasControlCharacter(reference) || reference.includes('\\')) {
    throw invalidResourcePath(reference);
  }
  const pathOnly = reference.split(/[?#]/u, 1)[0];
  if (!pathOnly) return null;
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathOnly);
  } catch {
    throw invalidResourcePath(reference);
  }
  if (
    decodedPath.length === 0 ||
    decodedPath.includes('\\') ||
    decodedPath.includes('\0') ||
    decodedPath.split('/').some((segment) => segment === '..') ||
    posix.isAbsolute(decodedPath)
  ) {
    throw invalidResourcePath(reference);
  }
  const normalized = posix.normalize(decodedPath).replace(/^\.\//u, '');
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw invalidResourcePath(reference);
  }
  return normalized;
}

function invalidResourcePath(reference: string): LocalBenchlingExportIntakeError {
  return new LocalBenchlingExportIntakeError(
    'local_export_resource_path_invalid',
    `HTML export contains an unsafe relative resource reference: ${safeReferenceLabel(reference)}.`
  );
}

function safeReferenceLabel(reference: string): string {
  return JSON.stringify(reference.slice(0, 160));
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

function assertPathContained(root: string, candidate: string, reference: string): void {
  const relativePath = relative(root, candidate);
  if (relativePath === '' || relativePath.startsWith(`..${sep}`) || relativePath === '..') {
    throw invalidResourcePath(reference);
  }
  if (isAbsolute(relativePath)) throw invalidResourcePath(reference);
}

async function assertNoSymlinkResourceSegments(
  selectedDirectory: string,
  relativePath: string
): Promise<void> {
  const segments = relativePath.split('/');
  let current = selectedDirectory;
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    const segmentStat = await lstat(current);
    if (segmentStat.isSymbolicLink() || !segmentStat.isDirectory()) {
      throw new LocalBenchlingExportIntakeError(
        'local_export_resource_not_regular_file',
        `Referenced local resource ${relativePath} traverses an unsafe filesystem segment.`
      );
    }
  }
}

function decodeHtmlAttribute(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|amp|apos|quot|lt|gt);/giu,
    (entity, decimal: string | undefined, hexadecimal: string | undefined) => {
      if (decimal) return safeCodePoint(Number.parseInt(decimal, 10), entity);
      if (hexadecimal) return safeCodePoint(Number.parseInt(hexadecimal, 16), entity);
      switch (entity.toLowerCase()) {
        case '&amp;':
          return '&';
        case '&apos;':
          return "'";
        case '&quot;':
          return '"';
        case '&lt;':
          return '<';
        case '&gt;':
          return '>';
        default:
          return entity;
      }
    }
  );
}

function safeCodePoint(codePoint: number, fallback: string): string {
  if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return fallback;
  }
}

function mediaTypeForLocalResource(relativePath: string): string {
  const extension = posix.extname(relativePath).toLowerCase();
  const mediaType = (
    {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
    } as Record<string, string>
  )[extension];
  if (!mediaType)
    throw new Error('Unsupported local raster resource reached the archive boundary.');
  return mediaType;
}

function isSupportedRasterResource(relativePath: string): boolean {
  return /\.(?:png|jpe?g|gif|webp)$/iu.test(relativePath);
}

function contentMismatch(message: string): LocalBenchlingExportIntakeError {
  return new LocalBenchlingExportIntakeError('local_export_content_mismatch', message);
}

function requiredAbsolutePath(
  value: string,
  code: Extract<
    LocalBenchlingExportIntakeErrorCode,
    'local_export_invalid_workspace_path' | 'local_export_invalid_source_path'
  >,
  label: string
): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > 4096 ||
    hasControlCharacter(value)
  ) {
    throw new LocalBenchlingExportIntakeError(code, `${label} is required.`);
  }
  if (!isAbsolute(value)) {
    throw new LocalBenchlingExportIntakeError(code, `${label} must be absolute.`);
  }
  return resolve(value);
}

function normalizedTimestamp(value: string, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new LocalBenchlingExportIntakeError(
      'local_export_invalid_source_path',
      `${label} must be an ISO timestamp.`
    );
  }
  return new Date(value).toISOString();
}

function supportedFormat(sourcePath: string): 'zip' | 'html' {
  const extension = extname(sourcePath).toLowerCase();
  if (extension === '.zip') return 'zip';
  if (extension === '.html' || extension === '.htm') return 'html';
  throw new LocalBenchlingExportIntakeError(
    'local_export_unsupported_extension',
    'Select one Benchling export with a .zip, .html, or .htm extension.'
  );
}

function sourceByteLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_LOCAL_BENCHLING_EXPORT_MAX_BYTES;
  if (
    !Number.isSafeInteger(limit) ||
    limit <= 0 ||
    limit > DEFAULT_LOCAL_BENCHLING_EXPORT_MAX_BYTES
  ) {
    throw new LocalBenchlingExportIntakeError(
      'local_export_invalid_size_limit',
      `Maximum local export size must be between 1 and ${DEFAULT_LOCAL_BENCHLING_EXPORT_MAX_BYTES} bytes.`
    );
  }
  return limit;
}
