import type { JSONContent } from '@tiptap/core';
import type {
  WorkspaceTextFileAtomicWriteInput,
  WorkspaceTextFileAtomicWriteResult,
} from '../shared/workspace-file-atomic';
import type {
  MigrateNotebookPackageAtPathInput,
  NotebookMigrationInterruptionPoint,
  NotebookMigrationSourceShape,
  NotebookPackageMetadata,
  ParsedNotebookMarkdown,
  PrepareNotebookPackageRenameInput,
  PublishNotebookPackageInput,
  PublishNotebookPackageResult,
  RecoverNotebookPackageRenameInput,
  SerializablePublishNotebookPackageInput,
} from '../shared/notebook-package-ipc';

export type {
  MigrateNotebookPackageAtPathInput,
  NotebookMigrationInterruptionPoint,
  NotebookMigrationSourceShape,
  PrepareNotebookPackageRenameInput,
  PublishNotebookPackageInput,
  PublishNotebookPackageResult,
  RecoverNotebookPackageRenameInput,
  SerializablePublishNotebookPackageInput,
} from '../shared/notebook-package-ipc';

import {
  canonicalNotebookJson,
  notebookMarkdownPreamble,
  notebookPayloadPathsFromMarkdown,
  parseNotebookMarkdown,
  serializeNotebookMarkdown,
} from './notebook-markdown-codec';
import {
  buildNotebookPackageMetadata,
  notebookPackagePaths,
  notebookPackageWindowsDrivePathKey,
  parseNotebookPackageMetadata,
  serializeNotebookPackageMetadata,
  NOTEBOOK_PACKAGE_FORMAT_VERSION,
  parseNotebookPackageDocument,
} from './notebook-package';
import { contentFingerprint } from '../shared/content-fingerprint';

export interface NotebookPackageDirectoryEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink?: boolean;
}

export type RetainNotebookSource = (id: string, stage: 'before' | 'published') => Promise<void>;

export interface NotebookPackageFileOps {
  exists(path: string): Promise<boolean>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, content: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  readDir?(path: string): Promise<NotebookPackageDirectoryEntry[]>;
  removeFile?(path: string): Promise<void>;
  writeWorkspaceTextFileAtomic?(
    input: WorkspaceTextFileAtomicWriteInput
  ): Promise<WorkspaceTextFileAtomicWriteResult>;
  publishNotebookPackageV2InMain?(
    input: SerializablePublishNotebookPackageInput
  ): Promise<PublishNotebookPackageResult>;
  migrateNotebookPackageAtPathInMain?(
    input: MigrateNotebookPackageAtPathInput
  ): Promise<PublishNotebookPackageResult | null>;
  prepareNotebookPackageRenameInMain?(input: PrepareNotebookPackageRenameInput): Promise<void>;
  recoverNotebookPackageRenameIfNeededInMain?(
    input: RecoverNotebookPackageRenameInput
  ): Promise<PublishNotebookPackageResult | null>;
}

export interface ReadNotebookPackageV2Result {
  metadata: NotebookPackageMetadata;
  parsed: ParsedNotebookMarkdown;
  markdown: string;
}

export const NOTEBOOK_PACKAGE_MIGRATORS = [
  { from: 1, to: NOTEBOOK_PACKAGE_FORMAT_VERSION, name: 'json-authority-to-markdown-v2' },
] as const;

interface NotebookMigrationJournal {
  schema: 'waypoint.notebook-migration.v1';
  fromFormatVersion: number;
  toFormatVersion: typeof NOTEBOOK_PACKAGE_FORMAT_VERSION;
  sourceShape: NotebookMigrationSourceShape;
  state: 'started' | 'staged' | 'published' | 'complete';
  archivePath: string;
  startedAt: string;
  updatedAt: string;
}

interface NotebookRenameJournal {
  schema: 'waypoint.notebook-rename.v1';
  oldStem: string;
  newStem: string;
  title: string;
  packageDepthFromWorkspaceRoot: number;
  state: 'prepared' | 'complete';
  updatedAt: string;
}

export class NotebookMigrationInterruptedError extends Error {
  constructor(readonly point: NotebookMigrationInterruptionPoint) {
    super(`Injected notebook migration interruption: ${point}`);
    this.name = 'NotebookMigrationInterruptedError';
  }
}

export class NotebookExternalConflictError extends Error {
  readonly code = 'NOTEBOOK_EXTERNAL_CONFLICT';

  constructor(
    readonly canonicalPath: string,
    options?: ErrorOptions
  ) {
    super(`Notebook Markdown changed on disk before save: ${canonicalPath}`, options);
    this.name = 'NotebookExternalConflictError';
  }
}

function fileName(path: string): string {
  return path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? 'Untitled.md';
}

function joinPath(root: string, relativePath: string): string {
  return `${root.replace(/[\\/]+$/, '')}/${relativePath.replace(/^\/+/, '')}`;
}

function assertPathWithinDirectory(root: string, candidate: string): void {
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedCandidate = candidate.replace(/\\/g, '/');
  const relative = normalizedCandidate.slice(normalizedRoot.length + 1);
  if (
    !normalizedCandidate.startsWith(`${normalizedRoot}/`) ||
    !relative ||
    relative.split('/').some((segment) => segment === '..' || segment === '.')
  ) {
    throw new Error(`Notebook package write escaped its managed directory: ${candidate}`);
  }
}

function packageDepthFromWorkspaceRoot(workspaceRoot: string, packageRoot: string): number {
  const normalizedWorkspaceRoot = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedPackageRoot = packageRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const relative = normalizedPackageRoot.slice(normalizedWorkspaceRoot.length + 1);
  const segments = relative.split('/').filter(Boolean);
  if (
    !normalizedPackageRoot.startsWith(`${normalizedWorkspaceRoot}/`) ||
    segments.length === 0 ||
    segments.some((segment) => segment === '.' || segment === '..')
  ) {
    throw new Error(`Notebook package is outside its workspace: ${packageRoot}`);
  }
  return segments.length;
}

function workspaceRootFromPackageDepth(packageRoot: string, packageDepth: number): string {
  const normalizedPackageRoot = packageRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const segments = normalizedPackageRoot.split('/');
  if (!Number.isSafeInteger(packageDepth) || packageDepth < 1 || segments.length <= packageDepth) {
    throw new Error('Notebook rename journal has an invalid project depth');
  }
  const workspaceRoot = segments.slice(0, -packageDepth).join('/');
  if (!workspaceRoot) {
    throw new Error('Notebook rename journal cannot derive its project root');
  }
  return workspaceRoot;
}

let atomicWriteSequence = 0;

async function writeAtomic(
  ops: NotebookPackageFileOps,
  path: string,
  content: string,
  options: { withinDirectory?: string } = {}
): Promise<boolean> {
  if (options.withinDirectory) assertPathWithinDirectory(options.withinDirectory, path);
  if (await ops.exists(path)) {
    const current = await ops.readTextFile(path);
    if (current === content) return false;
  }
  const temporary = `${path}.dnaforge-tmp-${contentFingerprint(content)}-${++atomicWriteSequence}`;
  if (options.withinDirectory) assertPathWithinDirectory(options.withinDirectory, temporary);
  await ops.writeTextFile(temporary, content);
  await ops.rename(temporary, path);
  return true;
}

const packagePublishTails = new Map<string, Promise<void>>();

export async function withNotebookPackageAuthorityLock<T>(
  packageRoot: string,
  operation: () => Promise<T>
): Promise<T> {
  const lockKey =
    typeof process !== 'undefined' && process.platform === 'win32'
      ? (notebookPackageWindowsDrivePathKey(packageRoot) ?? packageRoot)
      : packageRoot;
  const previous = packagePublishTails.get(lockKey) ?? Promise.resolve();
  let release = (): void => {};
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => {}).then(() => turn);
  packagePublishTails.set(lockKey, tail);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (packagePublishTails.get(lockKey) === tail) packagePublishTails.delete(lockKey);
  }
}

function parseRecord(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function payloadMapFromDisk(
  ops: Pick<NotebookPackageFileOps, 'exists' | 'readTextFile'>,
  packageRoot: string,
  markdown: string
): Promise<ReadonlyMap<string, string>> {
  const payloads = new Map<string, string>();
  const paths = notebookPayloadPathsFromMarkdown(markdown);
  for (let offset = 0; offset < paths.length; offset += 16) {
    const batch = await Promise.allSettled(
      paths.slice(offset, offset + 16).map(async (relativePath) => {
        const absolutePath = joinPath(packageRoot, relativePath);
        return (await ops.exists(absolutePath))
          ? ([relativePath, await ops.readTextFile(absolutePath)] as const)
          : null;
      })
    );
    for (const result of batch) {
      if (result.status === 'rejected') throw result.reason;
      if (result.value) payloads.set(...result.value);
    }
  }
  return payloads;
}

async function parseCanonical(
  ops: NotebookPackageFileOps,
  packageRoot: string,
  markdown: string,
  expectedId: string,
  expectedTitle?: string
): Promise<ParsedNotebookMarkdown> {
  return parseNotebookMarkdown({
    markdown,
    payloads: await payloadMapFromDisk(ops, packageRoot, markdown),
    expected: {
      id: expectedId,
      title: expectedTitle,
      formatVersion: NOTEBOOK_PACKAGE_FORMAT_VERSION,
    },
  });
}

export async function readNotebookPackageV2(
  ops: NotebookPackageFileOps,
  packageRoot: string,
  metadataRaw?: string,
  recoveryInput?: RecoverNotebookPackageRenameInput,
  retainSource?: RetainNotebookSource
): Promise<ReadNotebookPackageV2Result> {
  const recoveredRename =
    ops.recoverNotebookPackageRenameIfNeededInMain && !recoveryInput
      ? null
      : await recoverNotebookPackageRenameIfNeeded(ops, recoveryInput ?? packageRoot, retainSource);
  const paths = notebookPackagePaths(packageRoot);
  return readCanonicalNotebookPackage(
    ops,
    packageRoot,
    recoveredRename ? await ops.readTextFile(paths.metaPath) : metadataRaw
  );
}

export async function readCanonicalNotebookPackage(
  ops: Pick<NotebookPackageFileOps, 'exists' | 'readTextFile'>,
  packageRoot: string,
  metadataRaw?: string
): Promise<ReadNotebookPackageV2Result> {
  const paths = notebookPackagePaths(packageRoot);
  const metadata = parseNotebookPackageMetadata(
    metadataRaw ?? (await ops.readTextFile(paths.metaPath))
  );
  if (metadata.authority.path !== fileName(paths.markdownPath)) {
    throw new Error(
      `Notebook canonical path does not match its package stem: ${metadata.authority.path}`
    );
  }
  const markdown = await ops.readTextFile(paths.markdownPath);
  const parsed = parseNotebookMarkdown({
    markdown,
    payloads: await payloadMapFromDisk(ops, packageRoot, markdown),
    expected: { id: metadata.id, title: metadata.title, formatVersion: metadata.formatVersion },
  });
  return { metadata, parsed, markdown };
}

function parseRenameJournal(raw: string): NotebookRenameJournal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Notebook rename journal is malformed');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Notebook rename journal is not an object');
  }
  const journal = parsed as Partial<NotebookRenameJournal>;
  const validStem = (value: unknown): value is string =>
    typeof value === 'string' &&
    Boolean(value) &&
    !/[\\/]/.test(value) &&
    value !== '.' &&
    value !== '..';
  if (
    journal.schema !== 'waypoint.notebook-rename.v1' ||
    !validStem(journal.oldStem) ||
    !validStem(journal.newStem) ||
    typeof journal.title !== 'string' ||
    !Number.isSafeInteger(journal.packageDepthFromWorkspaceRoot) ||
    (journal.packageDepthFromWorkspaceRoot ?? 0) < 1 ||
    (journal.state !== 'prepared' && journal.state !== 'complete') ||
    typeof journal.updatedAt !== 'string'
  ) {
    throw new Error('Notebook rename journal is incomplete');
  }
  return journal as NotebookRenameJournal;
}

function renameJournalBytes(journal: NotebookRenameJournal): string {
  return `${JSON.stringify(journal, null, 2)}\n`;
}

export async function prepareNotebookPackageRename(
  ops: NotebookPackageFileOps,
  input: PrepareNotebookPackageRenameInput,
  retainSource?: RetainNotebookSource
): Promise<void> {
  if (ops.prepareNotebookPackageRenameInMain && !input.now) {
    await ops.prepareNotebookPackageRenameInMain(input);
    return;
  }
  const current = await readNotebookPackageV2(
    ops,
    input.packageRoot,
    undefined,
    undefined,
    retainSource
  );
  if (
    input.expectedCanonicalFingerprint !== undefined &&
    contentFingerprint(current.markdown) !== input.expectedCanonicalFingerprint
  ) {
    throw new NotebookExternalConflictError(notebookPackagePaths(input.packageRoot).markdownPath);
  }
  await retainSource?.(current.metadata.id, 'before');
  const paths = notebookPackagePaths(input.packageRoot);
  const journal: NotebookRenameJournal = {
    schema: 'waypoint.notebook-rename.v1',
    oldStem: fileName(input.packageRoot),
    newStem: fileName(input.nextPackageRoot),
    title: input.title,
    packageDepthFromWorkspaceRoot: packageDepthFromWorkspaceRoot(
      input.workspaceRoot,
      input.packageRoot
    ),
    state: 'prepared',
    updatedAt: (input.now ?? (() => new Date()))().toISOString(),
  };
  await writeAtomic(ops, paths.renameJournalPath, renameJournalBytes(journal));
}

export async function recoverNotebookPackageRenameIfNeeded(
  ops: NotebookPackageFileOps,
  input: string | RecoverNotebookPackageRenameInput,
  retainSource?: RetainNotebookSource
): Promise<PublishNotebookPackageResult | null> {
  const packageRoot = typeof input === 'string' ? input : input.packageRoot;
  if (ops.recoverNotebookPackageRenameIfNeededInMain) {
    if (typeof input === 'string') {
      throw new Error('Notebook rename recovery requires declared project authority');
    }
    return ops.recoverNotebookPackageRenameIfNeededInMain(input);
  }
  const paths = notebookPackagePaths(packageRoot);
  if (!(await ops.exists(paths.renameJournalPath))) return null;
  const journal = parseRenameJournal(await ops.readTextFile(paths.renameJournalPath));
  if (journal.state === 'complete') return null;

  const currentStem = fileName(packageRoot);
  if (currentStem === journal.oldStem) return null;
  if (currentStem !== journal.newStem) {
    throw new Error(`Notebook rename journal does not match package root: ${packageRoot}`);
  }

  const oldMarkdownPath = joinPath(packageRoot, `${journal.oldStem}.md`);
  if (!(await ops.exists(paths.markdownPath))) {
    if (!(await ops.exists(oldMarkdownPath))) {
      throw new Error('Notebook rename recovery cannot find either canonical Markdown path');
    }
    await ops.rename(oldMarkdownPath, paths.markdownPath);
  }

  const metadataRaw = await ops.readTextFile(paths.metaPath);
  const metadata = parseNotebookPackageMetadata(metadataRaw);
  const markdown = await ops.readTextFile(paths.markdownPath);
  const parsed = await parseCanonical(ops, packageRoot, markdown, metadata.id, metadata.title);
  const published = await publishNotebookPackageV2(
    ops,
    {
      packageRoot,
      workspaceRoot: workspaceRootFromPackageDepth(
        packageRoot,
        journal.packageDepthFromWorkspaceRoot
      ),
      id: metadata.id,
      title: journal.title,
      content: parsed.content,
      sourceShape: 'v2-package',
      existingMetadataRaw: metadataRaw,
      formerAuthorityRaw: null,
      preservedPreamble: parsed.preservedPreamble,
      preservedTitleProjection: parsed.preservedTitleProjection,
      expectedCanonicalFingerprint: contentFingerprint(markdown),
    },
    retainSource &&
      ((id, stage) => (stage === 'published' ? retainSource(id, stage) : Promise.resolve()))
  );
  await writeAtomic(
    ops,
    paths.renameJournalPath,
    renameJournalBytes({ ...journal, state: 'complete', updatedAt: new Date().toISOString() })
  );
  return published;
}

export async function migrateNotebookPackageAtPath(
  ops: NotebookPackageFileOps,
  input: MigrateNotebookPackageAtPathInput,
  retainSource?: RetainNotebookSource
): Promise<PublishNotebookPackageResult | null> {
  if (ops.migrateNotebookPackageAtPathInMain) {
    return ops.migrateNotebookPackageAtPathInMain(input);
  }
  const paths = notebookPackagePaths(input.packageRoot);
  const metadataRaw = await ops.readTextFile(paths.metaPath);
  let record: unknown;
  try {
    record = JSON.parse(metadataRaw);
  } catch {
    throw new Error(`Notebook metadata is malformed and cannot be migrated: ${paths.metaPath}`);
  }
  if (
    record &&
    typeof record === 'object' &&
    !Array.isArray(record) &&
    (record as Record<string, unknown>).formatVersion !== undefined
  ) {
    parseNotebookPackageMetadata(metadataRaw);
    return null;
  }

  const legacy = parseNotebookPackageDocument(metadataRaw);
  const migrator = NOTEBOOK_PACKAGE_MIGRATORS.find(
    (candidate) => candidate.from === 1 && candidate.to === NOTEBOOK_PACKAGE_FORMAT_VERSION
  );
  if (!migrator) {
    throw new Error('No ordered notebook package migrator is registered from version 1');
  }
  let preservedPreamble = '';
  if (await ops.exists(paths.markdownPath)) {
    preservedPreamble = notebookMarkdownPreamble(await ops.readTextFile(paths.markdownPath));
  }
  return publishNotebookPackageV2(
    ops,
    {
      packageRoot: input.packageRoot,
      workspaceRoot: input.workspaceRoot,
      id: legacy.id,
      title: legacy.title,
      content: legacy.content as JSONContent,
      sourceShape: 'v1-package',
      existingMetadataRaw: metadataRaw,
      formerAuthorityRaw: metadataRaw,
      preservedPreamble,
      updatedAt: legacy.updatedAt,
    },
    retainSource
  );
}

function journalBytes(journal: NotebookMigrationJournal): string {
  return `${JSON.stringify(journal, null, 2)}\n`;
}

async function sha256Text(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function removeFileIfPresent(ops: NotebookPackageFileOps, path: string): Promise<void> {
  if (!ops.removeFile || !(await ops.exists(path))) return;
  await ops.removeFile(path);
}

async function cleanupCompletedNotebookPackage(
  ops: NotebookPackageFileOps,
  packageRoot: string
): Promise<void> {
  if (!ops.readDir || !ops.removeFile) return;
  const paths = notebookPackagePaths(packageRoot);
  for (const entry of await ops.readDir(paths.metaDir)) {
    if (
      entry.isFile &&
      !entry.isSymbolicLink &&
      entry.name.startsWith('notebook.md.dnaforge-stage-')
    ) {
      await removeFileIfPresent(ops, joinPath(paths.metaDir, entry.name));
    }
  }
}

async function writePackageMetadata(
  ops: NotebookPackageFileOps,
  input: PublishNotebookPackageInput,
  path: string,
  content: string
): Promise<boolean> {
  const expectedV1 = input.sourceShape === 'v1-package' ? input.existingMetadataRaw : null;
  if (!expectedV1) return writeAtomic(ops, path, content);
  if (ops.writeWorkspaceTextFileAtomic) {
    try {
      await ops.writeWorkspaceTextFileAtomic({
        workspaceRoot: input.workspaceRoot,
        path,
        content,
        mode: 'replace',
        expectedContentHash: await sha256Text(expectedV1),
        artifactNoun: 'notebook metadata',
        mutationToken: input.mutationToken,
      });
      return true;
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'WorkspaceFilePreconditionError') throw error;
      throw new NotebookExternalConflictError(path, { cause: error });
    }
  }
  if ((await ops.readTextFile(path)) !== expectedV1) {
    throw new NotebookExternalConflictError(path);
  }
  return writeAtomic(ops, path, content);
}

export async function publishNotebookPackageV2(
  ops: NotebookPackageFileOps,
  input: PublishNotebookPackageInput,
  retainSource?: RetainNotebookSource
): Promise<PublishNotebookPackageResult> {
  if (ops.publishNotebookPackageV2InMain && !input.now && !input.interruptAt) {
    return ops.publishNotebookPackageV2InMain(input);
  }
  return withNotebookPackageAuthorityLock(input.packageRoot, async () => {
    await retainSource?.(input.id, 'before');
    const result = await publishNotebookPackageV2Unlocked(ops, input);
    await retainSource?.(result.metadata.id, 'published');
    return result;
  });
}

function provisionalLegacyCutoverNeedsRepublish(args: {
  sourceShape: PublishNotebookPackageInput['sourceShape'];
  currentMetadata: NotebookPackageMetadata | null;
  parsed: ParsedNotebookMarkdown;
  input: PublishNotebookPackageInput;
}): boolean {
  return (
    args.sourceShape === 'legacy-wpnote' &&
    !args.currentMetadata &&
    (args.parsed.title !== args.input.title ||
      canonicalNotebookJson(args.parsed.content) !== canonicalNotebookJson(args.input.content))
  );
}

async function provisionalV1MigrationNeedsRepublish(args: {
  sourceShape: PublishNotebookPackageInput['sourceShape'];
  currentMetadata: NotebookPackageMetadata | null;
  existingMetadataRaw: string | null;
  archivePath: string;
  ops: NotebookPackageFileOps;
}): Promise<boolean> {
  return (
    args.sourceShape === 'v1-package' &&
    !args.currentMetadata &&
    args.existingMetadataRaw !== null &&
    (!(await args.ops.exists(args.archivePath)) ||
      (await args.ops.readTextFile(args.archivePath)) !== args.existingMetadataRaw)
  );
}

function reusableUnchangedV2Notebook(args: {
  currentMetadata: NotebookPackageMetadata | null;
  sourceShape: PublishNotebookPackageInput['sourceShape'];
  parsed: ParsedNotebookMarkdown;
  input: PublishNotebookPackageInput;
  markdownFileName: string;
}): NotebookPackageMetadata | null {
  if (
    !args.currentMetadata ||
    args.sourceShape !== 'v2-package' ||
    args.parsed.title !== args.input.title ||
    args.currentMetadata.authority.path !== args.markdownFileName ||
    args.currentMetadata.title !== args.input.title ||
    canonicalNotebookJson(args.parsed.content) !== canonicalNotebookJson(args.input.content)
  ) {
    return null;
  }
  return args.currentMetadata;
}

async function publishNotebookPackageV2Unlocked(
  ops: NotebookPackageFileOps,
  input: PublishNotebookPackageInput
): Promise<PublishNotebookPackageResult> {
  const paths = notebookPackagePaths(input.packageRoot);
  const now = input.now ?? (() => new Date());
  const existingRecord = parseRecord(input.existingMetadataRaw);
  const archiveRelativePath = `migrations/v1-notebook-${await sha256Text(input.id)}.json`;
  const archivePath = joinPath(paths.metaDir, archiveRelativePath);
  assertPathWithinDirectory(paths.migrationsDir, archivePath);
  const startedAt = now().toISOString();
  let canonicalParsed: ParsedNotebookMarkdown | null = null;
  let validatedCanonical: string | null = null;

  await ops.mkdir(paths.metaDir, { recursive: true });
  await ops.mkdir(paths.blocksDir, { recursive: true });
  await ops.mkdir(paths.migrationsDir, { recursive: true });
  await ops.mkdir(paths.assetsDir, { recursive: true });

  if (await ops.exists(paths.markdownPath)) {
    const canonical = await ops.readTextFile(paths.markdownPath);
    validatedCanonical = canonical;
    if (
      input.expectedCanonicalFingerprint !== undefined &&
      contentFingerprint(canonical) !== input.expectedCanonicalFingerprint
    ) {
      throw new NotebookExternalConflictError(paths.markdownPath);
    }
    try {
      const parsed = await parseCanonical(
        ops,
        input.packageRoot,
        canonical,
        input.id,
        input.sourceShape === 'v2-package' ? input.title : undefined
      );
      canonicalParsed = parsed;
      if (
        input.expectedCanonicalFingerprint === undefined &&
        input.expectedProjectionContent !== undefined &&
        canonicalNotebookJson(parsed.content) !==
          canonicalNotebookJson(input.expectedProjectionContent)
      ) {
        throw new NotebookExternalConflictError(paths.markdownPath);
      }
      let currentMetadata: NotebookPackageMetadata | null = null;
      if (input.existingMetadataRaw) {
        try {
          currentMetadata = parseNotebookPackageMetadata(input.existingMetadataRaw);
        } catch {
          currentMetadata = null;
        }
      }
      const needsLegacyCutoverRepublish = provisionalLegacyCutoverNeedsRepublish({
        sourceShape: input.sourceShape,
        currentMetadata,
        parsed,
        input,
      });
      const needsV1MigrationRepublish = await provisionalV1MigrationNeedsRepublish({
        sourceShape: input.sourceShape,
        currentMetadata,
        existingMetadataRaw: input.existingMetadataRaw ?? null,
        archivePath,
        ops,
      });
      if (!currentMetadata && !needsLegacyCutoverRepublish && !needsV1MigrationRepublish) {
        const metadata = buildNotebookPackageMetadata({
          id: parsed.id,
          title: parsed.title,
          markdownFileName: fileName(paths.markdownPath),
          updatedAt: input.updatedAt ?? startedAt,
          existing: existingRecord,
          ...((await ops.exists(archivePath)) && {
            migration: {
              fromFormatVersion: 1,
              completedAt: startedAt,
              archivePath: archiveRelativePath,
              sourceShape: input.sourceShape,
            },
          }),
        });
        await writePackageMetadata(
          ops,
          input,
          paths.metaPath,
          serializeNotebookPackageMetadata(metadata)
        );
        const recoveredJournal: NotebookMigrationJournal = {
          schema: 'waypoint.notebook-migration.v1',
          fromFormatVersion: 1,
          toFormatVersion: NOTEBOOK_PACKAGE_FORMAT_VERSION,
          sourceShape: input.sourceShape,
          state: 'complete',
          archivePath: archiveRelativePath,
          startedAt,
          updatedAt: startedAt,
        };
        await writeAtomic(ops, paths.migrationJournalPath, journalBytes(recoveredJournal));
        await cleanupCompletedNotebookPackage(ops, input.packageRoot);
        return {
          metadata,
          parsed,
          markdownBytes: new TextEncoder().encode(canonical).length,
          canonicalFingerprint: contentFingerprint(canonical),
          recovered: true,
          changed: true,
        };
      }
      const reusableMetadata = reusableUnchangedV2Notebook({
        currentMetadata,
        sourceShape: input.sourceShape,
        parsed,
        input,
        markdownFileName: fileName(paths.markdownPath),
      });
      if (reusableMetadata) {
        await cleanupCompletedNotebookPackage(ops, input.packageRoot);
        return {
          metadata: reusableMetadata,
          parsed,
          markdownBytes: new TextEncoder().encode(canonical).length,
          canonicalFingerprint: contentFingerprint(canonical),
          recovered: false,
          changed: false,
        };
      }
    } catch (error) {
      if (canonical.includes('<!-- dnaforge:notebook ')) throw error;
    }
  }

  if (
    input.sourceShape === 'v1-package' &&
    input.existingMetadataRaw &&
    (await ops.readTextFile(paths.metaPath)) !== input.existingMetadataRaw
  ) {
    throw new NotebookExternalConflictError(paths.metaPath);
  }

  if (input.formerAuthorityRaw) {
    await writeAtomic(ops, archivePath, input.formerAuthorityRaw, {
      withinDirectory: paths.migrationsDir,
    });
  }

  const initialJournal: NotebookMigrationJournal = {
    schema: 'waypoint.notebook-migration.v1',
    fromFormatVersion:
      input.sourceShape === 'v2-package' || input.sourceShape === 'new-package' ? 2 : 1,
    toFormatVersion: NOTEBOOK_PACKAGE_FORMAT_VERSION,
    sourceShape: input.sourceShape,
    state: 'started',
    archivePath: archiveRelativePath,
    startedAt,
    updatedAt: startedAt,
  };
  await writeAtomic(ops, paths.migrationJournalPath, journalBytes(initialJournal));

  const serialized = serializeNotebookMarkdown({
    identity: {
      id: input.id,
      title: input.title,
      formatVersion: NOTEBOOK_PACKAGE_FORMAT_VERSION,
    },
    content: input.content,
    roots: { workspaceRoot: input.workspaceRoot, packageRoot: input.packageRoot },
    preservedPreamble: input.preservedPreamble ?? canonicalParsed?.preservedPreamble,
    preservedTitleProjection:
      input.preservedTitleProjection ?? canonicalParsed?.preservedTitleProjection,
  });
  let changed = false;
  for (const payload of serialized.payloads) {
    const absolutePath = joinPath(input.packageRoot, payload.relativePath);
    changed = (await writeAtomic(ops, absolutePath, payload.content)) || changed;
  }

  const stagePath = `${paths.metaDir}/notebook.md.dnaforge-stage-${contentFingerprint(serialized.markdown)}-${++atomicWriteSequence}`;
  assertPathWithinDirectory(paths.metaDir, stagePath);
  await ops.writeTextFile(stagePath, serialized.markdown);
  const staged = await ops.readTextFile(stagePath);
  await parseCanonical(ops, input.packageRoot, staged, input.id);
  await writeAtomic(
    ops,
    paths.migrationJournalPath,
    journalBytes({ ...initialJournal, state: 'staged', updatedAt: now().toISOString() })
  );
  if (input.interruptAt === 'after-stage-before-publish') {
    throw new NotebookMigrationInterruptedError(input.interruptAt);
  }

  const canonicalBefore = validatedCanonical;
  if (canonicalBefore !== staged) {
    if (ops.writeWorkspaceTextFileAtomic) {
      try {
        await ops.writeWorkspaceTextFileAtomic({
          workspaceRoot: input.workspaceRoot,
          path: paths.markdownPath,
          content: staged,
          mode: canonicalBefore === null ? 'create' : 'replace',
          ...(canonicalBefore === null
            ? {}
            : { expectedContentHash: await sha256Text(canonicalBefore) }),
          artifactNoun: 'notebook',
          mutationToken: input.mutationToken,
        });
      } catch (error) {
        await removeFileIfPresent(ops, stagePath);
        if (!(error instanceof Error) || error.name !== 'WorkspaceFilePreconditionError')
          throw error;
        throw new NotebookExternalConflictError(paths.markdownPath, { cause: error });
      }
      await removeFileIfPresent(ops, stagePath);
    } else {
      await ops.rename(stagePath, paths.markdownPath);
    }
    changed = true;
  } else {
    await removeFileIfPresent(ops, stagePath);
  }
  const canonical = await ops.readTextFile(paths.markdownPath);
  if (canonical !== staged) {
    throw new NotebookExternalConflictError(paths.markdownPath);
  }
  const parsed = await parseCanonical(ops, input.packageRoot, canonical, input.id);
  await writeAtomic(
    ops,
    paths.migrationJournalPath,
    journalBytes({ ...initialJournal, state: 'published', updatedAt: now().toISOString() })
  );
  if (input.interruptAt === 'after-publish-before-metadata') {
    throw new NotebookMigrationInterruptedError(input.interruptAt);
  }

  const metadata = buildNotebookPackageMetadata({
    id: parsed.id,
    title: parsed.title,
    markdownFileName: fileName(paths.markdownPath),
    updatedAt: input.updatedAt ?? startedAt,
    existing: existingRecord,
    ...(input.sourceShape === 'v2-package' || input.sourceShape === 'new-package'
      ? {}
      : {
          migration: {
            fromFormatVersion: 1,
            completedAt: now().toISOString(),
            archivePath: archiveRelativePath,
            sourceShape: input.sourceShape,
          },
        }),
  });
  changed =
    (await writePackageMetadata(
      ops,
      input,
      paths.metaPath,
      serializeNotebookPackageMetadata(metadata)
    )) || changed;
  await writeAtomic(
    ops,
    paths.migrationJournalPath,
    journalBytes({ ...initialJournal, state: 'complete', updatedAt: now().toISOString() })
  );
  await cleanupCompletedNotebookPackage(ops, input.packageRoot);

  return {
    metadata,
    parsed,
    markdownBytes: new TextEncoder().encode(canonical).length,
    canonicalFingerprint: contentFingerprint(canonical),
    recovered: false,
    changed,
  };
}
