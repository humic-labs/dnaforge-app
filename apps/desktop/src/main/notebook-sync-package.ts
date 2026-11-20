import type { Stats } from 'node:fs';
import { lstat, open, opendir, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { classifyNotebookPackageMemberPath } from '@waypoint/share-bundle';

import {
  notebookPackagePaths,
  parseNotebookPackageDocument,
  parseNotebookPackageMetadata,
} from '../db/notebook-package';
import {
  NOTEBOOK_MARKER_PREFIX,
  notebookPayloadPathsFromMarkdown,
  parseNotebookMarkdown,
} from '../db/notebook-markdown-codec';
import { withNotebookPackageAuthorityLock } from '../db/notebook-package-migration';

export interface ValidatedNotebookSyncMember {
  absolutePath: string;
  readPath: string;
  deferredIdentity: ValidatedNotebookFileIdentity;
  sizeBytes: number;
  packageAsset: boolean;
}

interface ValidatedNotebookFileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface ValidatedNotebookSyncPackage {
  packageRoot: string;
  notebookId: string;
  members: ValidatedNotebookSyncMember[];
}

export interface ValidatedLegacyNotebookSyncFile {
  notebookId: string;
  member: ValidatedNotebookSyncMember;
}

export interface NotebookSyncCaptureLimits {
  maxMemberBytes: number;
  maxParsedMemberBytes?: number;
  maxMembers: number;
  maxTotalBytes: number;
}

interface NotebookSyncCaptureBudget {
  remainingMembers: number;
  remainingBytes: number;
  remainingDirectoryEntries: number;
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function fileIdentity(stat: Stats): ValidatedNotebookFileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function hasFileIdentity(stat: Stats, expected: ValidatedNotebookFileIdentity): boolean {
  return (
    stat.isFile() &&
    stat.dev === expected.dev &&
    stat.ino === expected.ino &&
    stat.size === expected.size &&
    stat.mtimeMs === expected.mtimeMs &&
    stat.ctimeMs === expected.ctimeMs
  );
}

async function fileContainsNotebookMarkerAtIdentity(
  path: string,
  expectedIdentity: ValidatedNotebookFileIdentity
): Promise<boolean> {
  const marker = Buffer.from(NOTEBOOK_MARKER_PREFIX, 'utf8');
  const chunk = Buffer.allocUnsafe(64 * 1024);
  const handle = await open(path, 'r');
  let offset = 0;
  let carry = Buffer.alloc(0);
  let found = false;
  try {
    if (!hasFileIdentity(await handle.stat(), expectedIdentity)) {
      throw new Error(`Notebook Markdown changed before marker inspection: ${path}`);
    }
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, offset);
      if (bytesRead === 0) break;
      const current = chunk.subarray(0, bytesRead);
      const searchable = carry.byteLength > 0 ? Buffer.concat([carry, current]) : current;
      if (searchable.includes(marker)) {
        found = true;
        break;
      }
      carry = Buffer.from(
        searchable.subarray(Math.max(0, searchable.byteLength - marker.byteLength + 1))
      );
      offset += bytesRead;
    }
    if (!hasFileIdentity(await handle.stat(), expectedIdentity)) {
      throw new Error(`Notebook Markdown changed during marker inspection: ${path}`);
    }
    return found;
  } finally {
    await handle.close();
  }
}

export async function validatedNotebookMarkdownSyncFile(
  workspaceRoot: string,
  path: string
): Promise<ValidatedNotebookSyncMember> {
  return capturedMember({
    lexicalPath: path,
    lexicalPackageRoot: workspaceRoot,
    canonicalPackageRoot: await realpath(workspaceRoot),
  });
}

export async function validatedNotebookSyncMemberContainsMarker(
  member: ValidatedNotebookSyncMember
): Promise<boolean> {
  return fileContainsNotebookMarkerAtIdentity(member.readPath, member.deferredIdentity);
}

export async function readValidatedNotebookSyncMemberBytes(
  member: ValidatedNotebookSyncMember,
  maxBytes: number
): Promise<Buffer> {
  if (member.sizeBytes > maxBytes) {
    throw new Error(`Notebook package member exceeds its byte limit: ${member.absolutePath}`);
  }
  const handle = await open(member.readPath, 'r');
  try {
    const before = await handle.stat();
    if (!hasFileIdentity(before, member.deferredIdentity)) {
      throw new Error(`Notebook package member changed before capture: ${member.absolutePath}`);
    }

    const bytes = Buffer.allocUnsafe(member.sizeBytes);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead === 0) {
        throw new Error(`Notebook package member changed during capture: ${member.absolutePath}`);
      }
      offset += result.bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    const extraRead = await handle.read(extra, 0, 1, bytes.byteLength);
    const after = await handle.stat();
    if (extraRead.bytesRead !== 0 || !hasFileIdentity(after, member.deferredIdentity)) {
      throw new Error(`Notebook package member changed during capture: ${member.absolutePath}`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function canonicalRegularFile(input: {
  lexicalPath: string;
  lexicalPackageRoot: string;
  canonicalPackageRoot: string;
}): Promise<{
  readPath: string;
  identity: ValidatedNotebookFileIdentity;
  sizeBytes: number;
}> {
  const fileStat = await lstat(input.lexicalPath);
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
    throw new Error(`Notebook package member is not a regular file: ${input.lexicalPath}`);
  }
  const readPath = await realpath(input.lexicalPath);
  if (!isContained(input.canonicalPackageRoot, readPath)) {
    throw new Error(`Notebook package member escaped its package: ${input.lexicalPath}`);
  }
  const expectedReadPath = resolve(
    input.canonicalPackageRoot,
    relative(resolve(input.lexicalPackageRoot), resolve(input.lexicalPath))
  );
  if (readPath !== expectedReadPath) {
    throw new Error(`Notebook package member traverses a symbolic link: ${input.lexicalPath}`);
  }
  return { readPath, identity: fileIdentity(fileStat), sizeBytes: fileStat.size };
}

async function optionalRegularFilesRecursively(input: {
  lexicalDirectory: string;
  lexicalPackageRoot: string;
  canonicalPackageRoot: string;
  budget: NotebookSyncCaptureBudget;
}): Promise<ValidatedNotebookSyncMember[]> {
  let directoryStat;
  try {
    directoryStat = await lstat(input.lexicalDirectory);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error(
      `Notebook managed directory is not a real directory: ${input.lexicalDirectory}`
    );
  }
  const canonicalDirectory = await realpath(input.lexicalDirectory);
  if (!isContained(input.canonicalPackageRoot, canonicalDirectory)) {
    throw new Error(`Notebook managed directory escaped its package: ${input.lexicalDirectory}`);
  }

  const members: ValidatedNotebookSyncMember[] = [];
  const directory = await opendir(canonicalDirectory);
  for await (const entry of directory) {
    if (input.budget.remainingDirectoryEntries <= 0) {
      throw new Error('Notebook package exceeds its directory-entry limit');
    }
    input.budget.remainingDirectoryEntries -= 1;
    const lexicalPath = join(input.lexicalDirectory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Notebook package contains a symbolic link: ${lexicalPath}`);
    }
    if (entry.isDirectory()) {
      members.push(
        ...(await optionalRegularFilesRecursively({
          lexicalDirectory: lexicalPath,
          lexicalPackageRoot: input.lexicalPackageRoot,
          canonicalPackageRoot: input.canonicalPackageRoot,
          budget: input.budget,
        }))
      );
      continue;
    }
    if (!entry.isFile()) continue;
    if (input.budget.remainingMembers <= 0) {
      throw new Error('Notebook package exceeds its member-count limit');
    }
    input.budget.remainingMembers -= 1;
    members.push(
      await capturedMember({
        lexicalPath,
        lexicalPackageRoot: input.lexicalPackageRoot,
        canonicalPackageRoot: input.canonicalPackageRoot,
        packageAsset: true,
      })
    );
  }
  return members.sort((left, right) => left.absolutePath.localeCompare(right.absolutePath));
}

async function assertManagedDirectory(input: {
  lexicalDirectory: string;
  canonicalPackageRoot: string;
  optional?: boolean;
}): Promise<void> {
  let directoryStat;
  try {
    directoryStat = await lstat(input.lexicalDirectory);
  } catch (error) {
    if (input.optional && isMissing(error)) return;
    throw error;
  }
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error(
      `Notebook managed directory is not a real directory: ${input.lexicalDirectory}`
    );
  }
  const canonicalDirectory = await realpath(input.lexicalDirectory);
  if (!isContained(input.canonicalPackageRoot, canonicalDirectory)) {
    throw new Error(`Notebook managed directory escaped its package: ${input.lexicalDirectory}`);
  }
}

async function capturedMember(input: {
  lexicalPath: string;
  lexicalPackageRoot: string;
  canonicalPackageRoot: string;
  packageAsset?: boolean;
  budget?: NotebookSyncCaptureBudget;
  chargeBytes?: boolean;
}): Promise<ValidatedNotebookSyncMember> {
  const captured = await canonicalRegularFile(input);
  if (input.budget) {
    if (input.budget.remainingMembers <= 0) {
      throw new Error('Notebook package exceeds its member-count limit');
    }
    if (input.chargeBytes !== false && captured.sizeBytes > input.budget.remainingBytes) {
      throw new Error('Notebook package exceeds its aggregate byte limit');
    }
    input.budget.remainingMembers -= 1;
    if (input.chargeBytes !== false) input.budget.remainingBytes -= captured.sizeBytes;
  }
  return {
    absolutePath: input.lexicalPath,
    readPath: captured.readPath,
    deferredIdentity: captured.identity,
    sizeBytes: captured.sizeBytes,
    packageAsset: input.packageAsset ?? false,
  };
}

async function assertAssetsContainNoNestedNotebookAuthority(
  members: readonly ValidatedNotebookSyncMember[],
  packageRoot: string
): Promise<void> {
  for (const member of members) {
    const relativePath = relative(packageRoot, member.absolutePath).split('\\').join('/');
    const lower = relativePath.toLowerCase();
    if (lower.endsWith('.wpnote.json') || /(^|\/)\.forge\/notebook\.json$/.test(lower)) {
      throw new Error(`Notebook package contains a nested notebook authority: ${relativePath}`);
    }
    const classification = classifyNotebookPackageMemberPath(lower);
    if (
      classification?.contentType === 'text/markdown' &&
      (await fileContainsNotebookMarkerAtIdentity(member.readPath, member.deferredIdentity))
    ) {
      throw new Error(`Notebook package contains nested notebook Markdown: ${relativePath}`);
    }
  }
}

async function readValidatedNotebookSyncMemberText(
  member: ValidatedNotebookSyncMember,
  maxBytes: number
): Promise<string> {
  const bytes = await readValidatedNotebookSyncMemberBytes(member, maxBytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`Notebook package member is not valid UTF-8: ${member.absolutePath}`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

export async function validatedLegacyNotebookSyncFile(
  workspaceRoot: string,
  absolutePath: string,
  maxMemberBytes: number
): Promise<ValidatedLegacyNotebookSyncFile> {
  const canonicalWorkspaceRoot = await realpath(workspaceRoot);
  const member = await capturedMember({
    lexicalPath: absolutePath,
    lexicalPackageRoot: workspaceRoot,
    canonicalPackageRoot: canonicalWorkspaceRoot,
  });
  const raw = await readValidatedNotebookSyncMemberText(member, maxMemberBytes);
  const notebook = parseNotebookPackageDocument(raw);
  return { notebookId: notebook.id, member };
}

export async function captureValidatedNotebookPackage(
  workspaceRoot: string,
  packageRoot: string,
  limits: NotebookSyncCaptureLimits,
  purpose: 'sync' | 'retention'
): Promise<ValidatedNotebookSyncPackage | null> {
  if (
    !Number.isSafeInteger(limits.maxMemberBytes) ||
    limits.maxMemberBytes <= 0 ||
    (limits.maxParsedMemberBytes !== undefined &&
      (!Number.isSafeInteger(limits.maxParsedMemberBytes) || limits.maxParsedMemberBytes <= 0)) ||
    !Number.isSafeInteger(limits.maxMembers) ||
    limits.maxMembers <= 0 ||
    !Number.isSafeInteger(limits.maxTotalBytes) ||
    limits.maxTotalBytes <= 0
  ) {
    throw new Error('Notebook sync capture limits must be positive safe integers');
  }
  const maxParsedMemberBytes = Math.min(
    limits.maxMemberBytes,
    limits.maxParsedMemberBytes ?? limits.maxMemberBytes
  );
  const budget: NotebookSyncCaptureBudget = {
    remainingMembers: limits.maxMembers,
    remainingBytes: limits.maxTotalBytes,
    remainingDirectoryEntries: limits.maxMembers,
  };
  const canonicalWorkspaceRoot = await realpath(workspaceRoot);
  let packageStat;
  try {
    packageStat = await lstat(packageRoot);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  if (packageStat.isSymbolicLink() || !packageStat.isDirectory()) {
    throw new Error(`Notebook package root is not a real directory: ${packageRoot}`);
  }
  const canonicalPackageRoot = await realpath(packageRoot);
  if (!isContained(canonicalWorkspaceRoot, canonicalPackageRoot)) {
    throw new Error(`Notebook package root escaped its workspace: ${packageRoot}`);
  }

  const paths = notebookPackagePaths(packageRoot);
  await assertManagedDirectory({
    lexicalDirectory: paths.metaDir,
    canonicalPackageRoot,
  });
  await assertManagedDirectory({
    lexicalDirectory: paths.blocksDir,
    canonicalPackageRoot,
    optional: true,
  });
  await assertManagedDirectory({
    lexicalDirectory: paths.migrationsDir,
    canonicalPackageRoot,
    optional: true,
  });
  let metadataMember: ValidatedNotebookSyncMember;
  try {
    metadataMember = await capturedMember({
      lexicalPath: paths.metaPath,
      lexicalPackageRoot: packageRoot,
      canonicalPackageRoot,
      budget,
    });
  } catch (error) {
    if (isMissing(error)) {
      if (
        (await pathExists(paths.markdownPath)) ||
        (await pathExists(paths.migrationJournalPath))
      ) {
        throw new Error(
          'Notebook publication is incomplete: canonical Markdown exists without metadata; reopen the notebook to recover before sync'
        );
      }
      return null;
    }
    throw error;
  }
  const metadataRaw = await readValidatedNotebookSyncMemberText(
    metadataMember,
    maxParsedMemberBytes
  );

  let candidate: unknown;
  try {
    candidate = JSON.parse(metadataRaw);
  } catch {
    throw new Error(`Notebook metadata is malformed: ${paths.metaPath}`);
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error(`Notebook metadata is not an object: ${paths.metaPath}`);
  }

  const assets = await optionalRegularFilesRecursively({
    lexicalDirectory: paths.assetsDir,
    lexicalPackageRoot: packageRoot,
    canonicalPackageRoot,
    budget,
  });
  await assertAssetsContainNoNestedNotebookAuthority(assets, packageRoot);
  const record = candidate as Record<string, unknown>;
  if (record.formatVersion === undefined) {
    const legacy = parseNotebookPackageDocument(metadataRaw);
    try {
      const markdownMember = await capturedMember({
        lexicalPath: paths.markdownPath,
        lexicalPackageRoot: packageRoot,
        canonicalPackageRoot,
        budget,
      });
      const markdown = await readValidatedNotebookSyncMemberText(
        markdownMember,
        maxParsedMemberBytes
      );
      if (purpose === 'sync' && markdown.includes('<!-- dnaforge:notebook ')) {
        throw new Error(
          'Notebook migration published Markdown before metadata; reopen the notebook to recover before sync'
        );
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    return { packageRoot, notebookId: legacy.id, members: [metadataMember, ...assets] };
  }

  const metadata = parseNotebookPackageMetadata(metadataRaw);
  if (purpose === 'sync' && metadata.migration?.sourceShape === 'legacy-wpnote') {
    const siblings = await readdir(dirname(packageRoot), { withFileTypes: true });
    for (const sibling of siblings) {
      if (!sibling.isFile() || !sibling.name.toLowerCase().endsWith('.wpnote.json')) continue;
      const legacyPath = join(dirname(packageRoot), sibling.name);
      const legacy = await validatedLegacyNotebookSyncFile(
        workspaceRoot,
        legacyPath,
        maxParsedMemberBytes
      );
      if (legacy.notebookId === metadata.id) {
        throw new Error(
          `Notebook migration still exposes both legacy and v2 authorities: ${legacyPath}`
        );
      }
    }
  }
  if (metadata.authority.path !== basename(paths.markdownPath)) {
    throw new Error(
      `Notebook canonical path does not match its package stem: ${metadata.authority.path}`
    );
  }
  const markdownMember = await capturedMember({
    lexicalPath: paths.markdownPath,
    lexicalPackageRoot: packageRoot,
    canonicalPackageRoot,
    budget,
  });
  const markdown = await readValidatedNotebookSyncMemberText(markdownMember, maxParsedMemberBytes);
  const payloads = new Map<string, string>();
  const payloadMembers: ValidatedNotebookSyncMember[] = [];
  for (const relativePath of notebookPayloadPathsFromMarkdown(markdown)) {
    const member = await capturedMember({
      lexicalPath: join(packageRoot, relativePath),
      lexicalPackageRoot: packageRoot,
      canonicalPackageRoot,
      budget,
    });
    payloadMembers.push(member);
    payloads.set(
      relativePath,
      await readValidatedNotebookSyncMemberText(member, maxParsedMemberBytes)
    );
  }
  parseNotebookMarkdown({
    markdown,
    payloads,
    expected: { id: metadata.id, title: metadata.title, formatVersion: metadata.formatVersion },
  });
  const migrationMembers: ValidatedNotebookSyncMember[] = [];
  if (metadata.migration?.archivePath) {
    const archivePath = resolve(paths.metaDir, metadata.migration.archivePath);
    if (!isContained(resolve(paths.migrationsDir), archivePath)) {
      throw new Error('Notebook migration archive path escaped its managed directory');
    }
    const recoveredWithoutArchive =
      ['new-package', 'v2-package'].includes(metadata.migration.sourceShape) &&
      !(await pathExists(archivePath));
    if (!recoveredWithoutArchive) {
      migrationMembers.push(
        await capturedMember({
          lexicalPath: archivePath,
          lexicalPackageRoot: packageRoot,
          canonicalPackageRoot,
          budget,
          chargeBytes: false,
        })
      );
    }
  }

  return {
    packageRoot,
    notebookId: metadata.id,
    members: [
      metadataMember,
      markdownMember,
      ...payloadMembers.sort((left, right) => left.absolutePath.localeCompare(right.absolutePath)),
      ...migrationMembers,
      ...assets,
    ],
  };
}

export async function validatedNotebookSyncPackage(
  workspaceRoot: string,
  packageRoot: string,
  limits: NotebookSyncCaptureLimits
): Promise<ValidatedNotebookSyncPackage | null> {
  return withNotebookPackageAuthorityLock(packageRoot, () =>
    captureValidatedNotebookPackage(workspaceRoot, packageRoot, limits, 'sync')
  );
}
