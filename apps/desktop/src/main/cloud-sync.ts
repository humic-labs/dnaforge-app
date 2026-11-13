import { app } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import {
  BUNDLE_SCHEMA_CAPABILITY_HEADER,
  DEFAULT_SHARE_BUNDLE_LIMITS,
  SHARE_BUNDLE_SCHEMA_VERSION,
  classifyNotebookPackageMemberPath,
  classifyShareFileForNewBundle,
  classifyValidatedNotebookAssetPath,
  isSafeRelativePath,
  shareBundleHashInput,
  decodeBundleFileContent,
  type ShareBundle,
  type ShareBundleExcludedFile,
  type ShareBundleFile,
  type ShareBundleV2,
} from '@waypoint/share-bundle';
import { getActiveStoredSession } from './auth/session-store';
import { getWebBaseUrl } from './auth/auth-config';
import { canonicalizeWebApiOrigin } from './auth/web-api-origin';
import { getDb } from './ipc/database';
import { assertSafePath } from './ipc/path-allowlist';
import { managedRootDir } from './ipc/workspace-git';
import { importIntoManagedWorkspaceRepo } from './workspace-git/import';
import { SEQUENCE_PACKAGE_META_NAME, parseSequencePackageDocument } from '../db/sequence-package';
import { NOTEBOOK_MARKER_PREFIX } from '../db/notebook-markdown-codec';
import {
  readValidatedNotebookSyncMemberBytes,
  validatedLegacyNotebookSyncFile,
  validatedNotebookMarkdownSyncFile,
  validatedNotebookSyncPackage,
  validatedNotebookSyncMemberContainsMarker,
  type ValidatedLegacyNotebookSyncFile,
  type ValidatedNotebookSyncMember,
  type ValidatedNotebookSyncPackage,
} from './notebook-sync-package';
import type {
  CloudSyncBackupResult,
  CloudSyncRestoreResult,
  CloudSyncShareResult,
  CloudSyncSnapshotSummary,
  CloudSyncWorkspaceRequest,
  CloudSyncWorkspaceRoot,
} from '../shared/cloud-sync-types';

const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'dist-electron']);
const INCLUDED_HIDDEN_DIRS = new Set(['.waypoint']);

export async function backupWorkspaceSnapshot(
  request: CloudSyncWorkspaceRequest
): Promise<CloudSyncBackupResult> {
  const bundle = await buildShareBundle(request);
  const uploaded = await postDesktopSync<{ snapshot: CloudSyncSnapshotSummary }>(
    '/api/desktop-sync/snapshots',
    'POST',
    { bundle }
  );
  return {
    snapshot: uploaded.snapshot,
    bundle: publicBundleSummary(bundle),
  };
}

export async function shareWorkspaceSnapshot(
  request: CloudSyncWorkspaceRequest
): Promise<CloudSyncShareResult> {
  const backup = await backupWorkspaceSnapshot(request);
  const shared = await postDesktopSync<{
    share: { id: string; shortId?: string; short_id?: string; url?: string };
    url?: string;
  }>(`/api/desktop-sync/snapshots/${encodeURIComponent(backup.snapshot.id)}/share`, 'POST', {
    scopeMode: 'anyone-with-link',
    displayLabel: request.workspaceName ?? backup.snapshot.displayName,
  });
  const shortId = shared.share.shortId ?? shared.share.short_id;
  const url = shared.share.url ?? shared.url;
  if (!shortId || !url) throw new Error('Share API returned an incomplete link.');
  return {
    ...backup,
    share: { id: shared.share.id, shortId, url },
  };
}

export async function listWorkspaceSnapshots(): Promise<CloudSyncSnapshotSummary[]> {
  const data = await postDesktopSync<{ snapshots: CloudSyncSnapshotSummary[] }>(
    '/api/desktop-sync/snapshots',
    'GET'
  );
  return data.snapshots;
}

export async function restoreWorkspaceSnapshot(
  snapshotId?: string
): Promise<CloudSyncRestoreResult> {
  const snapshots = await listWorkspaceSnapshots();
  const snapshot = snapshotId ? snapshots.find((entry) => entry.id === snapshotId) : snapshots[0];
  if (!snapshot) throw new Error('No cloud snapshots are available to restore.');

  const downloaded = await postDesktopSync<{
    snapshot: CloudSyncSnapshotSummary;
    bundle: ShareBundle;
  }>(`/api/desktop-sync/snapshots/${encodeURIComponent(snapshot.id)}`, 'GET');
  const sourcePath = await materializeBundleSource(downloaded.bundle, downloaded.snapshot.id);
  const workspace = await importIntoManagedWorkspaceRepo(sourcePath, {
    db: getDb(),
    managedRootDir: managedRootDir(),
    largeFilePolicy: 'copy',
  });
  return {
    snapshot: downloaded.snapshot,
    bundle: publicBundleSummary(downloaded.bundle),
    workspace,
  };
}

export async function buildShareBundle(request: CloudSyncWorkspaceRequest): Promise<ShareBundleV2> {
  const roots = request.roots.filter((root) => !root.pinned);
  if (roots.length === 0) throw new Error('Open a project before backing it up.');
  const serializedRootNames = new Map<string, string>();
  for (const root of roots) {
    await assertSafePath(root.path, { requireAbsolute: true, errorPrefix: 'cloud-sync' });
    const rootName = safePathSegment(root.name || basename(root.path) || 'workspace');
    const rootKey = rootName.toLocaleLowerCase('en-US');
    const existingRoot = serializedRootNames.get(rootKey);
    if (existingRoot) {
      throw new Error(
        `Project roots must have distinct names for backup: ${existingRoot}, ${root.path}`
      );
    }
    serializedRootNames.set(rootKey, root.path);
  }

  const files: ShareBundleFile[] = [];
  const excludedFiles: ShareBundleExcludedFile[] = [];
  const notebookPackageRootsById = new Map<string, string>();
  let bundleBytes = 0;

  for (const root of roots) {
    await collectRootFiles(root, files, excludedFiles, notebookPackageRootsById, (bytes) => {
      if (bundleBytes + bytes > DEFAULT_SHARE_BUNDLE_LIMITS.maxBundleBytes) return false;
      bundleBytes += bytes;
      return true;
    });
  }

  if (files.length === 0) {
    throw new Error('No small DNAForge design files were found to back up.');
  }

  const now = new Date().toISOString();
  const bundle: ShareBundleV2 = {
    schemaVersion: 2,
    capturedAt: now,
    workspace: {
      id: `desktop-${randomUUID()}`,
      name: cleanWorkspaceName(
        request.workspaceName ??
          (roots.length === 1 ? roots[0]?.name : `${roots.length} DNAForge projects`) ??
          'DNAForge project'
      ),
    },
    files,
    excludedFiles,
    limits: DEFAULT_SHARE_BUNDLE_LIMITS,
    provenance: {
      source: 'dnaforge-desktop',
      appVersion: app.getVersion(),
      contentSha256: '0'.repeat(64),
    },
  };
  bundle.provenance.contentSha256 = sha256Hex(shareBundleHashInput(bundle));
  return bundle;
}

async function collectRootFiles(
  root: CloudSyncWorkspaceRoot,
  files: ShareBundleFile[],
  excludedFiles: ShareBundleExcludedFile[],
  notebookPackageRootsById: Map<string, string>,
  reserveBytes: (bytes: number) => boolean
): Promise<void> {
  const rootName = safePathSegment(root.name || basename(root.path) || 'workspace');
  const collectionResults = new Map<string, boolean>();
  const notebookPackageRoots = new Set<string>();

  function bundlePathFor(absolutePath: string): string {
    const relativePath = relative(root.path, absolutePath).split(sep).join('/');
    return `${rootName}/${relativePath}`;
  }

  async function collectFile(absolutePath: string, entryName: string): Promise<boolean> {
    const previousResult = collectionResults.get(absolutePath);
    if (previousResult !== undefined) return previousResult;

    const bundlePath = bundlePathFor(absolutePath);
    let legacyNotebook: ValidatedLegacyNotebookSyncFile | null = null;
    if (entryName.toLowerCase().endsWith('.wpnote.json')) {
      legacyNotebook = await validatedLegacyNotebookSyncFile(
        root.path,
        absolutePath,
        DEFAULT_SHARE_BUNDLE_LIMITS.maxFileBytes
      );
    }
    const fileStat = legacyNotebook ? null : await stat(absolutePath);
    if (fileStat && !fileStat.isFile()) {
      collectionResults.set(absolutePath, false);
      return false;
    }
    const fileSize = legacyNotebook?.member.sizeBytes ?? fileStat?.size ?? 0;
    const pathOnlyNotebookClassification = classifyNotebookPackageMemberPath(
      bundlePath.toLowerCase()
    );
    const notebookMarkdownCandidate =
      !legacyNotebook && pathOnlyNotebookClassification?.contentType === 'text/markdown'
        ? await validatedNotebookMarkdownSyncFile(root.path, absolutePath)
        : null;
    if (
      notebookMarkdownCandidate &&
      (await validatedNotebookSyncMemberContainsMarker(notebookMarkdownCandidate))
    ) {
      throw new Error(`Notebook Markdown is missing its package metadata: ${bundlePath}`);
    }
    const classification = classifyShareFileForNewBundle(bundlePath, fileSize);
    if (classification.action === 'exclude') {
      excludedFiles.push({
        relativePath: bundlePath,
        reason: classification.reason ?? 'unsupported',
        sizeBytes: fileSize,
      });
      collectionResults.set(absolutePath, false);
      return false;
    }
    if (legacyNotebook) {
      const containingPackageRoot = [...notebookPackageRoots].find((root) =>
        bundlePath.startsWith(`${root}/`)
      );
      if (containingPackageRoot) {
        throw new Error(
          `Workspace contains a notebook authority nested inside ${containingPackageRoot}: ${bundlePath}`
        );
      }
      const existingPath = notebookPackageRootsById.get(legacyNotebook.notebookId);
      if (existingPath && existingPath !== bundlePath) {
        throw new Error(
          `Workspace contains duplicate notebook id ${legacyNotebook.notebookId}: ${existingPath}, ${bundlePath}`
        );
      }
      notebookPackageRootsById.set(legacyNotebook.notebookId, bundlePath);
    }
    if (files.length >= DEFAULT_SHARE_BUNDLE_LIMITS.maxFiles || !reserveBytes(fileSize)) {
      excludedFiles.push({
        relativePath: bundlePath,
        reason: 'bundle-too-large',
        sizeBytes: fileSize,
      });
      collectionResults.set(absolutePath, false);
      return false;
    }
    const bytes = legacyNotebook
      ? await readValidatedNotebookSyncMemberBytes(
          legacyNotebook.member,
          DEFAULT_SHARE_BUNDLE_LIMITS.maxFileBytes
        )
      : notebookMarkdownCandidate
        ? await readValidatedNotebookSyncMemberBytes(
            notebookMarkdownCandidate,
            DEFAULT_SHARE_BUNDLE_LIMITS.maxFileBytes
          )
        : await readFile(absolutePath);
    const binary = classification.contentType === 'application/octet-stream';
    const content = binary ? bytes.toString('base64') : bytes.toString('utf8');
    if (
      classification.kind === 'notebook' &&
      classification.contentType === 'text/markdown' &&
      content.includes(NOTEBOOK_MARKER_PREFIX)
    ) {
      throw new Error(`Notebook Markdown is missing its package metadata: ${bundlePath}`);
    }
    files.push({
      id: randomUUID(),
      relativePath: bundlePath,
      name: entryName,
      kind: classification.kind ?? 'genbank',
      contentType: classification.contentType ?? 'text/plain',
      sizeBytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      content,
      ...(binary ? { encoding: 'base64' as const } : {}),
    });
    collectionResults.set(absolutePath, true);
    return true;
  }

  async function collectValidatedForgeMarkers(packageRoot: string): Promise<void> {
    const forgeRoot = join(packageRoot, '.forge');
    const plasmidMarker = join(forgeRoot, SEQUENCE_PACKAGE_META_NAME);
    try {
      const content = await readFile(plasmidMarker, 'utf8');
      const document = parseSequencePackageDocument(content);
      const productPath = join(packageRoot, document.product.file);
      const product = await lstat(productPath);
      if (product.isFile() || product.isSymbolicLink()) {
        const productIncluded = await collectFile(productPath, basename(document.product.file));
        if (productIncluded) {
          await collectFile(plasmidMarker, SEQUENCE_PACKAGE_META_NAME);
        }
      }
    } catch {}

    const notebookPackage = await validatedNotebookSyncPackage(root.path, packageRoot, {
      maxMemberBytes: DEFAULT_SHARE_BUNDLE_LIMITS.maxFileBytes,
      maxMembers: DEFAULT_SHARE_BUNDLE_LIMITS.maxFiles,
      maxTotalBytes: DEFAULT_SHARE_BUNDLE_LIMITS.maxBundleBytes,
    });
    if (notebookPackage) {
      await collectNotebookPackage(notebookPackage);
    }
  }

  async function collectNotebookPackage(
    notebookPackage: ValidatedNotebookSyncPackage
  ): Promise<void> {
    const packageRootPath = bundlePathFor(notebookPackage.packageRoot);
    if (!isSafeRelativePath(packageRootPath)) {
      throw new Error(`Unsafe notebook package path: ${packageRootPath}`);
    }
    const nestedRoot = [...notebookPackageRoots].find(
      (root) => packageRootPath.startsWith(`${root}/`) || root.startsWith(`${packageRootPath}/`)
    );
    if (nestedRoot) {
      throw new Error(
        `Workspace contains nested notebook packages: ${nestedRoot}, ${packageRootPath}`
      );
    }
    notebookPackageRoots.add(packageRootPath);
    const existingPackageRoot = notebookPackageRootsById.get(notebookPackage.notebookId);
    if (existingPackageRoot && existingPackageRoot !== packageRootPath) {
      throw new Error(
        `Workspace contains duplicate notebook id ${notebookPackage.notebookId}: ${existingPackageRoot}, ${packageRootPath}`
      );
    }
    notebookPackageRootsById.set(notebookPackage.notebookId, packageRootPath);

    const admitted: Array<{
      member: ValidatedNotebookSyncMember;
      relativePath: string;
      kind: ShareBundleFile['kind'];
      contentType: string;
      sizeBytes: number;
    }> = [];
    const stagedExcluded: ShareBundleExcludedFile[] = [];
    let stagedBytes = 0;
    for (const member of notebookPackage.members) {
      collectionResults.set(member.absolutePath, false);
    }
    for (const member of notebookPackage.members) {
      const bundlePath = bundlePathFor(member.absolutePath);
      if (!isSafeRelativePath(bundlePath)) {
        throw new Error(`Unsafe notebook package member path: ${bundlePath}`);
      }
      const sizeBytes = member.sizeBytes;
      const classification = member.packageAsset
        ? classifyValidatedNotebookAssetPath(
            bundlePath,
            packageRootPath,
            sizeBytes,
            DEFAULT_SHARE_BUNDLE_LIMITS
          )
        : {
            action: 'include' as const,
            kind: 'notebook' as const,
            contentType: bundlePath.endsWith('.md') ? 'text/markdown' : 'application/json',
          };
      if (classification.action === 'exclude') {
        stagedExcluded.push({
          relativePath: bundlePath,
          reason: classification.reason,
          sizeBytes,
        });
        continue;
      }
      if (sizeBytes > DEFAULT_SHARE_BUNDLE_LIMITS.maxFileBytes) {
        for (const stagedFile of admitted) {
          excludedFiles.push({
            relativePath: stagedFile.relativePath,
            reason: 'file-too-large',
            sizeBytes: stagedFile.sizeBytes,
          });
        }
        excludedFiles.push({
          relativePath: bundlePath,
          reason: 'file-too-large',
          sizeBytes,
        });
        return;
      }

      admitted.push({
        member,
        relativePath: bundlePath,
        kind: classification.kind,
        contentType: classification.contentType,
        sizeBytes,
      });
      stagedBytes += sizeBytes;
    }

    if (
      files.length + admitted.length > DEFAULT_SHARE_BUNDLE_LIMITS.maxFiles ||
      !reserveBytes(stagedBytes)
    ) {
      for (const stagedFile of admitted) {
        excludedFiles.push({
          relativePath: stagedFile.relativePath,
          reason: 'bundle-too-large',
          sizeBytes: stagedFile.sizeBytes,
        });
      }
      excludedFiles.push(...stagedExcluded);
      return;
    }

    const staged: ShareBundleFile[] = [];
    for (const candidate of admitted) {
      const bytes = await readValidatedNotebookSyncMemberBytes(
        candidate.member,
        DEFAULT_SHARE_BUNDLE_LIMITS.maxFileBytes
      );
      const binary = candidate.contentType === 'application/octet-stream';
      staged.push({
        id: randomUUID(),
        relativePath: candidate.relativePath,
        name: basename(candidate.member.absolutePath),
        kind: candidate.kind,
        contentType: candidate.contentType,
        sizeBytes: candidate.sizeBytes,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        content: binary ? bytes.toString('base64') : bytes.toString('utf8'),
        ...(binary ? { encoding: 'base64' as const } : {}),
      });
    }
    files.push(...staged);
    excludedFiles.push(...stagedExcluded);
    for (const member of notebookPackage.members) {
      collectionResults.set(member.absolutePath, true);
    }
  }

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    const forgeDirectory = entries.find((entry) => entry.isDirectory() && entry.name === '.forge');
    if (forgeDirectory) {
      await collectValidatedForgeMarkers(dir);
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (entry.name === '.forge') {
          continue;
        }
        if (entry.name.startsWith('.') && !INCLUDED_HIDDEN_DIRS.has(entry.name)) continue;
        await walk(join(dir, entry.name));
        continue;
      }
      if (entry.name.startsWith('.')) continue;
      if (!entry.isFile()) continue;
      const absolutePath = join(dir, entry.name);
      await collectFile(absolutePath, entry.name);
    }
  }
  await walk(root.path);
}

async function materializeBundleSource(bundle: ShareBundle, snapshotId: string): Promise<string> {
  const root = join(app.getPath('userData'), 'sync-restores', `${snapshotId}-${Date.now()}`);
  await mkdir(root, { recursive: true });
  for (const file of bundle.files) {
    if (!isSafeRelativePath(file.relativePath)) {
      throw new Error(`Unsafe snapshot path: ${file.relativePath}`);
    }
    const target = join(root, ...file.relativePath.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, decodeBundleFileContent(file));
  }
  return root;
}

async function postDesktopSync<T>(
  path: string,
  method: 'GET' | 'POST',
  body?: unknown
): Promise<T> {
  const session = await getActiveStoredSession();
  if (!session) throw new Error('Sign in before using cloud backup.');
  const res = await fetch(`${canonicalizeWebApiOrigin(getWebBaseUrl())}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      Authorization: `Bearer ${session.accessToken}`,
      [BUNDLE_SCHEMA_CAPABILITY_HEADER]: String(SHARE_BUNDLE_SCHEMA_VERSION),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = {};
  if (text) {
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      json = {};
    }
  }
  if (!res.ok) {
    const message =
      json && typeof json === 'object' && 'message' in json && typeof json.message === 'string'
        ? json.message
        : `Cloud sync request failed (${res.status}).`;
    throw new Error(message);
  }
  return json as T;
}

function publicBundleSummary(bundle: ShareBundle) {
  return {
    fileCount: bundle.files.length,
    excludedFiles: bundle.excludedFiles,
    contentSha256: bundle.provenance.contentSha256,
  };
}

function cleanWorkspaceName(value: string): string {
  return value.trim().slice(0, 160) || 'DNAForge project';
}

function safePathSegment(value: string): string {
  return cleanWorkspaceName(value).replace(/[\\/:\0]/g, '-');
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
