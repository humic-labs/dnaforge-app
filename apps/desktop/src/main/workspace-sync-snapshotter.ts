import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { TextDecoder } from 'node:util';

import type Database from 'better-sqlite3';
import {
  scientificCloudVersionHashInput,
  type ScientificCloudHistoryV1,
} from '@waypoint/scientific-objects';
import {
  validateScientificCloudFileProjection,
  scientificHistoryCurrentFiles,
  type ScientificHistoryCurrentFile,
} from '@waypoint/scientific-artifacts';
import { ScientificObjectStore } from './scientific-object-store';
import {
  parseResourcePath,
  parseWorkspacePath,
  validateMaterializedTree,
} from '@waypoint/workspace-revisions';
import { SEQUENCE_PACKAGE_ADMISSION_MAX_MARKER_BYTES } from '@waypoint/share-bundle/sequence-package-admission';
import {
  classifyValidatedNotebookAssetPath,
  classifyNotebookPackageMemberPath,
  classifyShareFileForNewBundle,
  workspaceSyncResourceMediaType,
  isSafeRelativePath,
  parseWorkspaceSyncManifest,
  resolveWorkspaceSyncBundleLimits,
  resolveWorkspaceSyncEncodedBundleMaxBytes,
  validateWorkspaceSyncBundle,
  validateWorkspaceSyncUploadAdmission,
  workspaceSyncManifestHashInput,
  workspaceSyncBundleHashInput,
  type ShareBundleLimits,
  type WorkspaceSyncBundle,
  type WorkspaceSyncBundleV2,
  type WorkspaceSyncBundleV3,
  WORKSPACE_SYNC_MANIFEST_READ_LIMITS,
  workspaceSyncStoragePolicyLimits,
  type WorkspaceSyncStoragePolicy,
  type WorkspaceSyncExcludedReason,
  type WorkspaceSyncExcludedSummary as BundleExcludedSummary,
  type WorkspaceSyncFile,
  type WorkspaceSyncManifestV1,
} from '@waypoint/share-bundle';
import type { BlobRef } from '@waypoint/workspace-revisions';

import type { WorkspaceSyncExcludedSummary as StatusExcludedSummary } from '../shared/cloud-sync-status';
import type {
  WorkspaceSyncExcludedFile,
  WorkspaceSyncSelection,
} from '../shared/workspace-sync-selection';
import {
  readWorkspaceSyncMembership,
  isWorkspaceSyncProjectIgnored,
  describeWorkspaceSyncSelection,
  assertWorkspaceSyncSelectionActive,
  type WorkspaceSyncMembership,
} from './workspace-sync-membership';
import {
  SEQUENCE_PACKAGE_META_NAME,
  SEQUENCE_PACKAGE_MIGRATORS,
  parseSequencePackageDocument,
  type SequencePackageDocument,
} from '../db/sequence-package';
import {
  NATIVE_WORKSPACE_MANIFEST_PATH,
  parseNativeWorkspaceManifest,
} from '../shared/native-workspace-manifest';
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
import { prepareWorkspaceSyncProjection } from './workspace-sync-projection';
import { withActiveFilesystemWork } from './active-filesystem-work';
import {
  assertScientificCloudTransferSupported,
  hasRetainedScientificAuthority,
  hasScientificCloudHistoryBinding,
} from './scientific-cloud-admission';
import { captureScientificWorkspaceCloudHistory } from './scientific-cloud-transfer';
import { toWorkspaceSyncStatusExcludedSummary } from './workspace-sync-exclusions';
import { readBlobContentIdentityAtCommit, withManagedWorkspaceMutationLock } from './workspace-git';
import { acquireWorkspaceMutationShared } from './workspace-sync-mutation-lease';
import { assertWorkspaceMigrationActionsSettled } from './workspace-migration-admission';
import { captureWorkspaceSyncBlob } from './workspace-sync-blob-cache';
import { readWorkspaceSyncReplicaFiles } from './workspace-sync-replica-files';
import { copyStableFileSync } from './workspace-git/copy-independent-file';
import { canonicalWorkspacePath } from './primer-artifact-files';
import {
  isWorkspaceSyncOperationalPath as isOperationalSyncPath,
  WORKSPACE_SYNC_SKIP_DIRS as SYNC_SKIP_DIRS,
  WORKSPACE_SYNC_SKIP_FILES as SYNC_SKIP_FILES,
  WORKSPACE_SYNC_SKIP_RELATIVE_DIRS as SYNC_SKIP_WORKSPACE_RELATIVE_DIRS,
  WORKSPACE_SYNC_SKIP_RELATIVE_FILES as SYNC_SKIP_WORKSPACE_RELATIVE_FILES,
  WORKSPACE_SYNC_PACKAGE_TRANSACTION_DIRECTORY as PACKAGE_TRANSACTION_DIRECTORY,
  WORKSPACE_SYNC_MIGRATION_TRANSACTION_FILE as MIGRATION_TRANSACTION_FILE,
} from './workspace-sync-paths';

export type WorkspaceSyncSnapshotErrorCode =
  | 'WORKSPACE_NOT_FOUND'
  | 'WORKSPACE_NOT_MANAGED'
  | 'WORKSPACE_ARCHIVED'
  | 'WORKSPACE_TRASHED'
  | 'NO_INCLUDED_FILES'
  | 'INVALID_TEXT_ENCODING'
  | 'INVALID_BUNDLE'
  | 'QUOTA_EXCEEDED'
  | 'SHARED_FILE_OWNERSHIP_REQUIRED'
  | 'UNSUPPORTED_AUTHORITATIVE_STATE';

export class WorkspaceSyncSnapshotError extends Error {
  constructor(
    readonly code: WorkspaceSyncSnapshotErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'WorkspaceSyncSnapshotError';
  }
}

export interface BuildWorkspaceSyncSnapshotInput {
  workspaceUuid: string;
  appVersion: string;
  capturedAt?: Date;
  prepareProjection?: boolean;
  directStorage?: boolean;
  storagePolicy?: WorkspaceSyncStoragePolicy;
  captureSourceRoot?: string;
  onSourcesFrozen?: () => void | Promise<void>;

  scientificHistoryFormat?: 1;

  mutationLease?: () => void;
  signal?: AbortSignal;
}

export interface WorkspaceSyncSnapshot {
  workspaceId: number;
  workspaceUuid: string;
  repoPath: string;
  bundle: WorkspaceSyncBundle;
  fileSources?: ReadonlyMap<string, string>;
  captureFileSources?: ReadonlyMap<string, string>;
  contentSha256: string;
  bundleSizeBytes: number;
  includedFileCount: number;
  includedBytes: number;
  excludedSummary: BundleExcludedSummary;
  statusExcludedSummary: StatusExcludedSummary;
  excludedFiles?: WorkspaceSyncExcludedFile[];
  selection?: WorkspaceSyncSelection;
}

export interface WorkspaceSyncUploadCapture {
  workspaceId: number;
  workspaceUuid: string;
  repoPath: string;
  manifest: WorkspaceSyncManifestV1;
  fileSources: ReadonlyMap<string, string>;
  contentSha256: string;
  bundleSizeBytes: number;
  includedFileCount: number;
  includedBytes: number;
  excludedSummary: BundleExcludedSummary;
  statusExcludedSummary: StatusExcludedSummary;
  excludedFiles?: WorkspaceSyncExcludedFile[];
  selection?: WorkspaceSyncSelection;

  scientificHistory?: ScientificCloudHistoryV1;
  scientificBlobRefs?: readonly BlobRef[];
  scientificBlobSources?: ReadonlyMap<string, string>;
  fileManifestSha256?: string;
  recoveryOnly?: { readonly reason: 'invalid-package'; readonly missingPaths: readonly string[] };
  dispose?: () => Promise<void>;
}

export type WorkspaceSyncUploadSnapshot = WorkspaceSyncSnapshot | WorkspaceSyncUploadCapture;

interface WorkspaceRow {
  id: number;
  name: string;
  path: string;
  repo_uuid: string | null;
  archived_at: number | null;
  trashed_at: number | null;
}

interface CollectState {
  membership: WorkspaceSyncMembership;
  excludedFiles: WorkspaceSyncExcludedFile[];
  unsupportedLeafPaths?: Map<string, number>;
  files: WorkspaceSyncFile[];
  manifestResources: Array<WorkspaceSyncUploadPreviewFile & { contentType: string }>;
  sourceFilePaths: Map<string, string>;
  excludedSummary: BundleExcludedSummary;
  includedBytes: number;
  handledAbsolutePaths: Set<string>;
  notebookPackageRootsById: Map<string, string>;
  notebookPackageRoots: Set<string>;
  sequencePackageRootsById: Map<string, string>;
  packageQuotaError?: WorkspaceSyncSnapshotError;
}

interface CollectOptions {
  directStorage?: boolean;
  previewOnly?: boolean;
  captureSources?: boolean;
  manifestOnly?: boolean;
}

export interface WorkspaceSyncUploadPreviewFile {
  relativePath: string;
  name: string;
  kind: string;
  sizeBytes: number;
}

export interface WorkspaceSyncUploadPreview {
  workspaceUuid: string;
  includedFiles: WorkspaceSyncUploadPreviewFile[];
  includedFileCount: number;
  includedBytes: number;
  excludedSummary: BundleExcludedSummary;
  statusExcludedSummary: StatusExcludedSummary;
  excludedFiles: WorkspaceSyncExcludedFile[];
  selection: WorkspaceSyncSelection;
  limits: ShareBundleLimits;
}

export async function buildWorkspaceSyncSnapshot(
  db: Database.Database,
  input: BuildWorkspaceSyncSnapshotInput
): Promise<WorkspaceSyncSnapshot> {
  const workspace = selectManagedWorkspace(db, input.workspaceUuid);
  return withManagedWorkspaceMutationLock(workspace.path, async () => {
    const snapshot = await buildWorkspaceSyncSnapshotLocked(db, input, workspace);
    assertScientificCloudTransferSupported(db, workspace.id);
    return snapshot;
  });
}

export async function buildWorkspaceSyncUploadCapture(
  db: Database.Database,
  input: BuildWorkspaceSyncSnapshotInput
): Promise<WorkspaceSyncUploadCapture> {
  const workspace = selectManagedWorkspace(db, input.workspaceUuid);
  if (!input.captureSourceRoot) {
    return withManagedWorkspaceMutationLock(workspace.path, async () => {
      const capture = await buildWorkspaceSyncUploadCaptureLocked(db, input, workspace);
      assertScientificCloudTransferSupported(db, workspace.id, input.scientificHistoryFormat);
      return capture;
    });
  }
  await mkdir(input.captureSourceRoot, { recursive: true, mode: 0o700 });
  const captureRoot = await realpath(input.captureSourceRoot);
  const relativeRoot = relative(await realpath(workspace.path), captureRoot);
  if (
    relativeRoot === '' ||
    (!isAbsolute(relativeRoot) && !relativeRoot.startsWith(`..${sep}`) && relativeRoot !== '..')
  ) {
    throw new WorkspaceSyncSnapshotError(
      'INVALID_BUNDLE',
      'Upload capture staging must be outside the workspace.'
    );
  }
  const directory = await mkdtemp(join(captureRoot, `.capture-${process.pid}-`));
  const dispose = () => rm(directory, { recursive: true, force: true });
  try {
    const prepared = await withManagedWorkspaceMutationLock(workspace.path, () =>
      prepareWorkspaceSyncUploadCaptureFiles(db, input, workspace, directory)
    );
    await input.onSourcesFrozen?.();
    const capture = await hashWorkspaceSyncUploadCaptureFiles(input, workspace, prepared);
    assertScientificCloudTransferSupported(db, workspace.id, input.scientificHistoryFormat);
    return { ...capture, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

export async function buildWorkspaceSyncRecoveryCapture(
  db: Database.Database,
  input: BuildWorkspaceSyncSnapshotInput
): Promise<WorkspaceSyncUploadCapture> {
  const workspace = selectManagedWorkspace(db, input.workspaceUuid);
  assertScientificCloudTransferSupported(db, workspace.id, input.scientificHistoryFormat);
  if (!input.captureSourceRoot)
    throw new Error('Recovery capture requires private durable staging.');
  await mkdir(input.captureSourceRoot, { recursive: true, mode: 0o700 });
  const captureRoot = await realpath(input.captureSourceRoot);
  const relativeRoot = relative(await realpath(workspace.path), captureRoot);
  if (
    relativeRoot === '' ||
    (!isAbsolute(relativeRoot) && !relativeRoot.startsWith(`..${sep}`) && relativeRoot !== '..')
  ) {
    throw new Error('Recovery staging must be outside the live workspace.');
  }
  const directory = await mkdtemp(join(captureRoot, `.capture-${process.pid}-`));
  const dispose = () => rm(directory, { recursive: true, force: true });
  const limits = input.storagePolicy
    ? workspaceSyncStoragePolicyLimits(input.storagePolicy)
    : WORKSPACE_SYNC_MANIFEST_READ_LIMITS;
  const excludedSummary = emptyExcludedSummary();
  const membership = await readWorkspaceSyncMembership(db, {
    workspaceUuid: input.workspaceUuid,
    repoPath: workspace.path,
  });
  const excludedFiles: WorkspaceSyncExcludedFile[] = [];
  const requiredPaths = new Set<string>();
  const declaredMembers = new Set<string>();
  const candidates: { path: string; source: string; sizeBytes: number }[] = [];
  let includedBytes = 0;
  let scientific: Awaited<ReturnType<typeof captureScientificWorkspaceCloudHistory>> | undefined;
  try {
    await withManagedWorkspaceMutationLock(workspace.path, async () => {
      assertScientificCloudTransferSupported(db, workspace.id, input.scientificHistoryFormat);
      if (input.scientificHistoryFormat === 1 && hasRetainedScientificAuthority(db, workspace.id)) {
        if (!input.mutationLease)
          throw new Error('Scientific recovery requires its live workspace lease.');
        scientific = await captureScientificWorkspaceCloudHistory(db, {
          workspaceId: workspace.id,
          mutationLease: input.mutationLease,
          signal: input.signal,
          purpose: 'recovery',
        });
        for (const file of scientific.currentFiles) requiredPaths.add(file.path);
      }
      const collect = async (current: string): Promise<void> => {
        const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) =>
          a.name.localeCompare(b.name)
        );
        const forge = entries.find((entry) => entry.name === '.forge' && entry.isDirectory());
        if (forge) {
          const marker = join(current, '.forge', SEQUENCE_PACKAGE_META_NAME);
          try {
            const stat = await lstat(marker);
            if (stat.isFile() && !stat.isSymbolicLink()) {
              const markerRelative = normalizeRelativePath(relative(workspace.path, marker));
              requiredPaths.add(markerRelative);
              if (stat.size <= SEQUENCE_PACKAGE_ADMISSION_MAX_MARKER_BYTES) {
                try {
                  const document = JSON.parse(
                    new TextDecoder('utf-8', { fatal: true }).decode(await readFile(marker))
                  ) as unknown;
                  if (document && typeof document === 'object' && !Array.isArray(document)) {
                    const raw = document as Record<string, unknown>;
                    const product =
                      raw.product && typeof raw.product === 'object' && !Array.isArray(raw.product)
                        ? (raw.product as Record<string, unknown>)
                        : null;
                    const paths: unknown[] = [
                      product?.file,
                      ...(Array.isArray(raw.members)
                        ? raw.members.map((member: unknown) =>
                            member && typeof member === 'object'
                              ? (member as Record<string, unknown>).path
                              : undefined
                          )
                        : []),
                    ];
                    for (const path of paths) {
                      const parsed = typeof path === 'string' ? parseResourcePath(path) : null;
                      if (!parsed?.ok || parsed.value !== path) {
                        addExcluded(excludedSummary, 'unsupported', null);
                        continue;
                      }
                      const expected = `${normalizeRelativePath(relative(workspace.path, current))}/${path}`;
                      const portable = parseWorkspacePath(expected);
                      if (
                        !portable.ok ||
                        portable.value !== expected ||
                        isOperationalSyncPath(expected)
                      ) {
                        addExcluded(excludedSummary, 'unsupported', null);
                        continue;
                      }
                      requiredPaths.add(expected);
                      if (String(path).startsWith('contents/') || String(path).startsWith('files/'))
                        declaredMembers.add(expected);
                    }
                  } else addExcluded(excludedSummary, 'unsupported', stat.size);
                } catch {
                  addExcluded(excludedSummary, 'unsupported', stat.size);
                }
              } else addExcluded(excludedSummary, 'unsupported', stat.size);
              await admit(marker, markerRelative, stat.size);
            } else addExcluded(excludedSummary, 'unsupported', null);
          } catch (error) {
            if (!isMissingPathError(error)) throw error;
          }
        }
        for (const entry of entries) {
          const absolute = join(current, entry.name);
          const path = normalizeRelativePath(relative(workspace.path, absolute));
          if (entry.name === '.forge' || isOperationalSyncPath(path, entry.isDirectory())) continue;
          if (entry.isSymbolicLink()) {
            addExcluded(excludedSummary, 'unsupported', null);
            continue;
          }
          if (entry.isDirectory()) await collect(absolute);
          else if (entry.isFile()) await admit(absolute, path, (await lstat(absolute)).size);
        }
      };
      const admit = async (
        source: string,
        path: string,
        sizeBytes: number,
        acceptedScientificPath = false
      ) => {
        if (
          acceptedScientificPath ||
          declaredMembers.has(path) ||
          path === NATIVE_WORKSPACE_MANIFEST_PATH ||
          /(?:^|\/)\.forge\/(?:plasmid|notebook)\.json$/u.test(path)
        )
          membership.requiredPaths.add(path);
        if (isWorkspaceSyncProjectIgnored(membership, path)) {
          excludedFiles.push({ relativePath: path, sizeBytes, reason: 'project-ignore' });
          return;
        }
        const portable = parseWorkspacePath(path);
        if (!portable.ok || portable.value !== path) {
          addExcluded(excludedSummary, 'unsupported', sizeBytes);
          return;
        }
        const classification = classifyShareFileForNewBundle(path, sizeBytes, limits);
        const recognizedResource =
          classification.action === 'exclude' &&
          classification.reason === 'unsupported' &&
          (workspaceSyncResourceMediaType(path) || declaredMembers.has(path));
        if (classification.action === 'exclude' && !recognizedResource && !acceptedScientificPath) {
          addExcluded(excludedSummary, classification.reason ?? 'unsupported', sizeBytes);
          excludedFiles.push({
            relativePath: path,
            sizeBytes,
            reason: classification.reason ?? 'unsupported',
          });
          return;
        }
        if (sizeBytes > limits.maxFileBytes) {
          addExcluded(excludedSummary, 'file-too-large', sizeBytes);
          excludedFiles.push({ relativePath: path, sizeBytes, reason: 'file-too-large' });
          return;
        }
        if (
          candidates.length >= limits.maxFiles ||
          includedBytes + sizeBytes > limits.maxBundleBytes
        ) {
          addExcluded(excludedSummary, 'bundle-too-large', sizeBytes);
          excludedFiles.push({ relativePath: path, sizeBytes, reason: 'bundle-too-large' });
          return;
        }
        const pinned = join(directory, String(candidates.length));
        copyStableFileSync(source, pinned);
        candidates.push({ path, source: pinned, sizeBytes });
        includedBytes += sizeBytes;
      };
      await collect(workspace.path);
      for (const file of scientific?.currentFiles ?? []) {
        if (candidates.some((candidate) => candidate.path === file.path)) continue;
        const path = join(workspace.path, file.path);
        try {
          const canonical = await canonicalWorkspacePath({
            workspaceRoot: workspace.path,
            path,
            artifactNoun: 'scientific recovery',
          });
          const stat = await lstat(path);
          if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            canonical.candidate !== join(canonical.root, file.path)
          ) {
            addExcluded(excludedSummary, 'unsupported', null);
            continue;
          }
          await admit(path, file.path, stat.size, true);
        } catch (error) {
          if (!isMissingPathError(error)) throw error;
        }
      }
    });
    await input.onSourcesFrozen?.();
    if (!candidates.length)
      throw new WorkspaceSyncSnapshotError(
        'NO_INCLUDED_FILES',
        'No allowed present bytes are available for recovery.'
      );
    const entries = candidates.map((candidate) => ({
      owner: candidate.path,
      kind: 'file' as const,
      path: parseWorkspacePath(candidate.path) as ReturnType<typeof parseWorkspacePath>,
    }));
    const tree = validateMaterializedTree(
      entries.map((entry) => {
        if (!entry.path.ok) throw new Error('Recovery path changed after capture.');
        return { ...entry, path: entry.path.value };
      })
    );
    if (!tree.ok)
      throw new Error('Recovery has an ambiguous portable tree; no bytes were published.');
    const fileSources = new Map<string, string>();
    const files: WorkspaceSyncManifestV1['files'] = [];
    for (const candidate of candidates.sort((a, b) => a.path.localeCompare(b.path))) {
      const contentSha256 = await hashWorkspaceSyncCaptureFile(
        candidate.source,
        candidate.sizeBytes,
        'application/octet-stream',
        candidate.path
      );
      files.push({
        path: candidate.path,
        contentSha256,
        sizeBytes: candidate.sizeBytes,
        contentType: 'application/octet-stream',
      });
      fileSources.set(candidate.path, candidate.source);
    }
    const parsed = parseWorkspaceSyncManifest({ schemaVersion: 1, files });
    if (!parsed.ok) throw new Error(`Recovery manifest is invalid: ${parsed.errors.join('; ')}`);
    assertScientificCloudTransferSupported(db, workspace.id, input.scientificHistoryFormat);
    const missing = [...requiredPaths].filter((path) => !fileSources.has(path)).sort();
    if (missing.length > 2000) addExcluded(excludedSummary, 'bundle-too-large', null);
    const selection = describeWorkspaceSyncSelection(
      membership,
      files.map((file) => ({ relativePath: file.path, sizeBytes: file.sizeBytes }))
    );
    assertWorkspaceSyncSelectionActive(selection);
    const fileManifestSha256 = sha256Hex(workspaceSyncManifestHashInput(parsed.manifest));
    return {
      workspaceId: workspace.id,
      workspaceUuid: input.workspaceUuid,
      repoPath: workspace.path,
      manifest: parsed.manifest,
      fileSources,
      contentSha256: scientific
        ? sha256Hex(scientificCloudVersionHashInput(fileManifestSha256, scientific.descriptor))
        : fileManifestSha256,
      bundleSizeBytes: Buffer.byteLength(JSON.stringify(parsed.manifest)),
      includedFileCount: files.length,
      includedBytes,
      excludedSummary,
      statusExcludedSummary: {
        ...toWorkspaceSyncStatusExcludedSummary(excludedSummary),
        ignoredCount: excludedFiles.filter((file) => file.reason === 'project-ignore').length,
      },
      excludedFiles,
      selection,
      recoveryOnly: { reason: 'invalid-package', missingPaths: missing.slice(0, 2000) },
      dispose,
      ...(scientific
        ? {
            scientificHistory: scientific.descriptor,
            scientificBlobRefs: scientific.blobs,
            scientificBlobSources: scientific.blobSources,
            fileManifestSha256,
          }
        : {}),
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

async function admitScientificCurrentFiles(
  workspaceRoot: string,
  state: CollectState,
  limits: ShareBundleLimits,
  files: readonly ScientificHistoryCurrentFile[]
): Promise<void> {
  const included = new Set(
    [...state.files, ...state.manifestResources].map((file) => file.relativePath)
  );
  for (const file of files) {
    if (included.has(file.path)) continue;
    state.membership.requiredPaths.add(file.path);
    state.excludedFiles = state.excludedFiles.filter(
      (excluded) => excluded.relativePath !== file.path
    );
    const lexical = join(workspaceRoot, file.path);
    const canonical = await canonicalWorkspacePath({
      workspaceRoot: workspaceRoot,
      path: lexical,
      artifactNoun: 'accepted scientific history',
    });
    const stat = await lstat(lexical);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      canonical.candidate !== join(canonical.root, file.path)
    )
      throw new WorkspaceSyncSnapshotError(
        'INVALID_BUNDLE',
        `Accepted scientific file is not an owned regular file: ${file.path}`
      );
    if (
      stat.size > limits.maxFileBytes ||
      state.includedBytes + stat.size > limits.maxBundleBytes ||
      included.size >= limits.maxFiles
    )
      throw new WorkspaceSyncSnapshotError(
        'QUOTA_EXCEEDED',
        `The storage allowance would omit accepted scientific history: ${file.path}`
      );
    state.manifestResources.push({
      relativePath: file.path,
      name: basename(file.path),
      kind: 'scientific-history',
      sizeBytes: stat.size,
      contentType: 'application/json',
    });
    state.sourceFilePaths.set(file.path, lexical);
    state.includedBytes += stat.size;
    included.add(file.path);
    const excludedBytes = state.unsupportedLeafPaths?.get(file.path);
    if (excludedBytes !== undefined) {
      const entry = state.excludedSummary.unsupported;
      if (entry.count < 1 || (entry.bytesApprox ?? 0) < excludedBytes)
        throw new Error('Scientific file exclusion bookkeeping is inconsistent.');
      entry.count -= 1;
      entry.bytesApprox = (entry.bytesApprox ?? 0) - excludedBytes;
      state.unsupportedLeafPaths!.delete(file.path);
    }
  }
}

async function buildWorkspaceSyncUploadCaptureLocked(
  db: Database.Database,
  input: BuildWorkspaceSyncSnapshotInput,
  workspace: WorkspaceRow
): Promise<WorkspaceSyncUploadCapture> {
  const prepared = await prepareWorkspaceSyncUploadCaptureFiles(db, input, workspace);
  return hashWorkspaceSyncUploadCaptureFiles(input, workspace, prepared);
}

async function prepareWorkspaceSyncUploadCaptureFiles(
  db: Database.Database,
  input: BuildWorkspaceSyncSnapshotInput,
  workspace: WorkspaceRow,
  directory?: string
) {
  assertScientificCloudTransferSupported(db, workspace.id, input.scientificHistoryFormat);
  const { assertNativeCatalogRecordPublicationsSettled } =
    await import('./native-catalog-record-mutations');
  assertNativeCatalogRecordPublicationsSettled(db, workspace.path);
  await assertWorkspaceMigrationActionsSettled(workspace.path);
  const limits = input.storagePolicy
    ? workspaceSyncStoragePolicyLimits(input.storagePolicy)
    : WORKSPACE_SYNC_MANIFEST_READ_LIMITS;

  if (input.prepareProjection !== false) {
    prepareWorkspaceSyncProjection(db, {
      workspaceId: workspace.id,
      workspaceRoot: workspace.path,
      scientificHistoryFormat: input.scientificHistoryFormat,
    });
  }

  const state: CollectState = {
    membership: await readWorkspaceSyncMembership(db, {
      workspaceUuid: input.workspaceUuid,
      repoPath: workspace.path,
    }),
    excludedFiles: [],
    files: [],
    manifestResources: [],
    sourceFilePaths: new Map(),
    excludedSummary: emptyExcludedSummary(),
    unsupportedLeafPaths: input.scientificHistoryFormat === 1 ? new Map() : undefined,
    includedBytes: 0,
    handledAbsolutePaths: new Set(),
    notebookPackageRootsById: new Map(),
    notebookPackageRoots: new Set(),
    sequencePackageRootsById: new Map(),
  };

  await collectWorkspaceFiles(workspace.path, workspace.path, state, limits, {
    previewOnly: true,
    captureSources: true,
    manifestOnly: true,
  });
  let scientific: Awaited<ReturnType<typeof captureScientificWorkspaceCloudHistory>> | undefined;
  if (input.scientificHistoryFormat === 1 && hasRetainedScientificAuthority(db, workspace.id)) {
    if (!input.mutationLease)
      throw new Error('Scientific capture requires its live workspace lease.');
    scientific = await captureScientificWorkspaceCloudHistory(db, {
      workspaceId: workspace.id,
      mutationLease: input.mutationLease,
      signal: input.signal,
    });
    await admitScientificCurrentFiles(workspace.path, state, limits, scientific.currentFiles);
  }
  if (input.storagePolicy) {
    await assertStoragePolicyPreservesAcceptedFiles(
      db,
      workspace.id,
      input.workspaceUuid,
      workspace.path,
      state
    );
  }
  if (state.packageQuotaError) throw state.packageQuotaError;
  const collectedFiles = [...state.files, ...state.manifestResources].sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath)
  );
  assertWorkspaceSyncSelectionActive(
    describeWorkspaceSyncSelection(state.membership, collectedFiles)
  );
  if (collectedFiles.length === 0) {
    throw new WorkspaceSyncSnapshotError(
      'NO_INCLUDED_FILES',
      `No syncable DNAForge design files were found in workspace ${input.workspaceUuid}`
    );
  }
  if (directory) {
    for (const [index, file] of collectedFiles.entries()) {
      const original = state.sourceFilePaths.get(file.relativePath);
      if (!original)
        throw new WorkspaceSyncSnapshotError(
          'INVALID_BUNDLE',
          `Workspace sync source path is missing: ${file.relativePath}`
        );
      const pinned = join(directory, String(index));
      copyStableFileSync(original, pinned);
      state.sourceFilePaths.set(file.relativePath, pinned);
    }
  }
  return { state, collectedFiles, scientific };
}

async function hashWorkspaceSyncUploadCaptureFiles(
  input: BuildWorkspaceSyncSnapshotInput,
  workspace: WorkspaceRow,
  {
    state,
    collectedFiles,
    scientific,
  }: Awaited<ReturnType<typeof prepareWorkspaceSyncUploadCaptureFiles>>
): Promise<WorkspaceSyncUploadCapture> {
  const manifestFiles = [] as WorkspaceSyncManifestV1['files'];
  for (const file of collectedFiles) {
    const sourcePath = state.sourceFilePaths.get(file.relativePath);
    if (!sourcePath) {
      throw new WorkspaceSyncSnapshotError(
        'INVALID_BUNDLE',
        `Workspace sync source path is missing: ${file.relativePath}`
      );
    }
    const sha256 = await hashWorkspaceSyncCaptureFile(
      sourcePath,
      file.sizeBytes,
      file.contentType,
      file.relativePath
    );
    if (file.relativePath === NATIVE_WORKSPACE_MANIFEST_PATH) {
      parseNativeWorkspaceManifest(await readFile(sourcePath, 'utf8'));
    }
    manifestFiles.push({
      path: file.relativePath,
      contentSha256: sha256,
      sizeBytes: file.sizeBytes,
      contentType: file.contentType,
    });
  }

  const parsedManifest = parseWorkspaceSyncManifest({
    schemaVersion: 1,
    files: manifestFiles,
  });
  if (!parsedManifest.ok) {
    throw new WorkspaceSyncSnapshotError(
      'INVALID_BUNDLE',
      `Workspace sync manifest is invalid: ${parsedManifest.errors.join('; ')}`
    );
  }
  const manifest = parsedManifest.manifest;
  const fileManifestSha256 = sha256Hex(workspaceSyncManifestHashInput(manifest));
  if (scientific) validateScientificCloudFileProjection(scientific.currentFiles, manifest);
  const contentSha256 = scientific
    ? sha256Hex(scientificCloudVersionHashInput(fileManifestSha256, scientific.descriptor))
    : fileManifestSha256;

  return {
    workspaceId: workspace.id,
    workspaceUuid: input.workspaceUuid,
    repoPath: workspace.path,
    manifest,
    fileSources: state.sourceFilePaths,
    contentSha256,
    bundleSizeBytes: Buffer.byteLength(JSON.stringify(manifest), 'utf8'),
    includedFileCount: manifest.files.length,
    includedBytes: manifest.files.reduce((total, file) => total + file.sizeBytes, 0),
    excludedSummary: state.excludedSummary,
    statusExcludedSummary: {
      ...toWorkspaceSyncStatusExcludedSummary(state.excludedSummary),
      ignoredCount: state.excludedFiles.filter((file) => file.reason === 'project-ignore').length,
    },
    excludedFiles: state.excludedFiles,
    selection: describeWorkspaceSyncSelection(state.membership, [
      ...state.files,
      ...state.manifestResources,
    ]),
    ...(scientific
      ? {
          scientificHistory: scientific.descriptor,
          scientificBlobRefs: scientific.blobs,
          scientificBlobSources: scientific.blobSources,
          fileManifestSha256,
        }
      : {}),
  };
}

async function buildWorkspaceSyncSnapshotLocked(
  db: Database.Database,
  input: BuildWorkspaceSyncSnapshotInput,
  workspace: WorkspaceRow
): Promise<WorkspaceSyncSnapshot> {
  assertScientificCloudTransferSupported(db, workspace.id);
  const { assertNativeCatalogRecordPublicationsSettled } =
    await import('./native-catalog-record-mutations');
  assertNativeCatalogRecordPublicationsSettled(db, workspace.path);
  await assertWorkspaceMigrationActionsSettled(workspace.path);
  const limits = input.directStorage
    ? input.storagePolicy
      ? workspaceSyncStoragePolicyLimits(input.storagePolicy)
      : WORKSPACE_SYNC_MANIFEST_READ_LIMITS
    : resolveWorkspaceSyncBundleLimits();

  if (input.prepareProjection !== false) {
    prepareWorkspaceSyncProjection(db, {
      workspaceId: workspace.id,
      workspaceRoot: workspace.path,
    });
  }

  const state: CollectState = {
    membership: await readWorkspaceSyncMembership(db, {
      workspaceUuid: input.workspaceUuid,
      repoPath: workspace.path,
    }),
    excludedFiles: [],
    files: [],
    manifestResources: [],
    sourceFilePaths: new Map(),
    excludedSummary: emptyExcludedSummary(),
    includedBytes: 0,
    handledAbsolutePaths: new Set(),
    notebookPackageRootsById: new Map(),
    notebookPackageRoots: new Set(),
    sequencePackageRootsById: new Map(),
  };

  await collectWorkspaceFiles(workspace.path, workspace.path, state, limits, {
    directStorage: input.directStorage,
  });

  if (input.directStorage && input.storagePolicy) {
    await assertStoragePolicyPreservesAcceptedFiles(
      db,
      workspace.id,
      input.workspaceUuid,
      workspace.path,
      state
    );
  }
  if (state.packageQuotaError) throw state.packageQuotaError;

  assertWorkspaceSyncSelectionActive(
    describeWorkspaceSyncSelection(state.membership, [...state.files, ...state.manifestResources])
  );
  if (state.files.length === 0) {
    throw new WorkspaceSyncSnapshotError(
      'NO_INCLUDED_FILES',
      `No syncable DNAForge design files were found in workspace ${input.workspaceUuid}`
    );
  }

  state.files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  const bundle: WorkspaceSyncBundleV2 | WorkspaceSyncBundleV3 = {
    schemaVersion: input.directStorage ? 3 : 2,
    capturedAt: (input.capturedAt ?? new Date()).toISOString(),
    workspace: {
      id: input.workspaceUuid,
      name: cleanWorkspaceName(workspace.name || basename(workspace.path)),
    },
    files: state.files,
    excludedSummary: state.excludedSummary,
    limits,
    provenance: {
      source: 'dnaforge-desktop',
      appVersion: input.appVersion,
      contentSha256: '0'.repeat(64),
    },
  };
  const contentSha256 = sha256Hex(workspaceSyncBundleHashInput(bundle));
  bundle.provenance.contentSha256 = contentSha256;

  const parsed = validateWorkspaceSyncBundle(bundle);
  if (!parsed.ok) {
    throw new WorkspaceSyncSnapshotError(
      'INVALID_BUNDLE',
      `Workspace sync snapshot bundle is invalid: ${parsed.errors.join('; ')}`
    );
  }
  const admission = validateWorkspaceSyncUploadAdmission(bundle, {
    limits,
    maxEncodedBundleBytes: resolveWorkspaceSyncEncodedBundleMaxBytes(),
  });
  if (!admission.ok) {
    throw new WorkspaceSyncSnapshotError(
      'INVALID_BUNDLE',
      `Workspace sync snapshot exceeds new-upload limits: ${admission.errors.join('; ')}`
    );
  }

  return {
    workspaceId: workspace.id,
    workspaceUuid: input.workspaceUuid,
    repoPath: workspace.path,
    bundle,
    captureFileSources: state.sourceFilePaths,
    contentSha256,
    bundleSizeBytes: input.directStorage ? state.includedBytes : admission.encodedBundleBytes,
    includedFileCount: state.files.length,
    includedBytes: state.includedBytes,
    excludedSummary: state.excludedSummary,
    statusExcludedSummary: {
      ...toWorkspaceSyncStatusExcludedSummary(state.excludedSummary),
      ignoredCount: state.excludedFiles.filter((file) => file.reason === 'project-ignore').length,
    },
    excludedFiles: state.excludedFiles,
    selection: describeWorkspaceSyncSelection(state.membership, [
      ...state.files,
      ...state.manifestResources,
    ]),
  };
}

async function assertStoragePolicyPreservesAcceptedFiles(
  db: Database.Database,
  workspaceId: number,
  workspaceUuid: string,
  repoPath: string,
  state: CollectState
): Promise<void> {
  if (
    !state.excludedSummary['file-too-large'].count &&
    !state.excludedSummary['bundle-too-large'].count
  )
    return;
  const binding = db
    .prepare(
      'SELECT remote_workspace_id, remote_latest_version_id FROM workspace_sync_bindings WHERE workspace_id = ?'
    )
    .get(workspaceId) as
    | { remote_workspace_id: string | null; remote_latest_version_id: string | null }
    | undefined;
  if (!binding?.remote_workspace_id || !binding.remote_latest_version_id) return;
  const acceptedPaths = readWorkspaceSyncReplicaFiles(db, {
    workspaceUuid,
    remoteWorkspaceId: binding.remote_workspace_id,
    remoteVersionId: binding.remote_latest_version_id,
  });
  if (!acceptedPaths) {
    throw new WorkspaceSyncSnapshotError(
      'SHARED_FILE_OWNERSHIP_REQUIRED',
      'The accepted sync version file list is required before excluding files under the storage policy.'
    );
  }
  const includedPaths = new Set(
    [...state.files, ...state.manifestResources].map((file) => file.relativePath)
  );
  for (const path of acceptedPaths) {
    if (includedPaths.has(path) || isOperationalSyncPath(path)) continue;
    const stat = await lstat(join(repoPath, path)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat?.isFile()) continue;
    throw new WorkspaceSyncSnapshotError(
      'QUOTA_EXCEEDED',
      `The storage allowance would omit an already shared file: ${path}. Increase the allowance or deliberately remove the file before uploading.`
    );
  }
}

export async function assertWorkspaceSyncSnapshotMatchesCommit(
  snapshot: WorkspaceSyncSnapshot,
  commitOid: string
): Promise<void> {
  for (const file of snapshot.bundle.files) {
    let committed: { contentSha256: string; sizeBytes: number };
    try {
      committed = await withActiveFilesystemWork(() =>
        readBlobContentIdentityAtCommit(
          snapshot.repoPath,
          commitOid,
          file.relativePath,
          Number.MAX_SAFE_INTEGER,
          0
        )
      );
    } catch {
      throw new WorkspaceSyncSnapshotError(
        'INVALID_BUNDLE',
        `Workspace sync file is not present in commit ${commitOid}: ${file.relativePath}`
      );
    }
    if (committed.contentSha256 !== file.sha256 || committed.sizeBytes !== file.sizeBytes) {
      throw new WorkspaceSyncSnapshotError(
        'INVALID_BUNDLE',
        `Workspace sync file changed outside commit ${commitOid}: ${file.relativePath}`
      );
    }
  }
}

export async function assertWorkspaceSyncUploadCaptureMatchesCommit(
  capture: WorkspaceSyncUploadCapture,
  commitOid: string
): Promise<void> {
  for (const file of capture.manifest.files) {
    let committed: { sizeBytes: number; contentSha256: string };
    try {
      committed = await readBlobContentIdentityAtCommit(
        capture.repoPath,
        commitOid,
        file.path,
        file.sizeBytes,
        resolveWorkspaceSyncBundleLimits().maxFileBytes
      );
    } catch (error) {
      throw new WorkspaceSyncSnapshotError(
        'INVALID_BUNDLE',
        `Workspace sync file cannot be verified in commit ${commitOid}: ${file.path}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (committed.sizeBytes !== file.sizeBytes || committed.contentSha256 !== file.contentSha256) {
      throw new WorkspaceSyncSnapshotError(
        'INVALID_BUNDLE',
        `Workspace sync file changed outside commit ${commitOid}: ${file.path}`
      );
    }
  }
}

export async function previewWorkspaceSyncUpload(
  db: Database.Database,
  input: { workspaceUuid: string; storagePolicy?: WorkspaceSyncStoragePolicy }
): Promise<WorkspaceSyncUploadPreview> {
  const workspace = selectManagedWorkspace(db, input.workspaceUuid);
  const releaseMutation = await acquireWorkspaceMutationShared(workspace.path);
  try {
    return await withManagedWorkspaceMutationLock(workspace.path, () =>
      collectWorkspaceSyncUploadPreview(
        db,
        {
          ...input,
          ...(hasScientificCloudHistoryBinding(db, workspace.id)
            ? { scientificHistoryFormat: 1 as const }
            : {}),
        },
        workspace
      )
    );
  } finally {
    releaseMutation();
  }
}

export async function previewWorkspaceSyncUploadWithHeldMutationLease(
  db: Database.Database,
  input: {
    workspaceUuid: string;
    storagePolicy?: WorkspaceSyncStoragePolicy;
    scientificHistoryFormat?: 1;
  }
): Promise<WorkspaceSyncUploadPreview> {
  const workspace = selectManagedWorkspace(db, input.workspaceUuid);
  return withManagedWorkspaceMutationLock(workspace.path, () =>
    collectWorkspaceSyncUploadPreview(db, input, workspace)
  );
}

async function collectWorkspaceSyncUploadPreview(
  db: Database.Database,
  input: {
    workspaceUuid: string;
    storagePolicy?: WorkspaceSyncStoragePolicy;
    scientificHistoryFormat?: 1;
  },
  workspace: WorkspaceRow
): Promise<WorkspaceSyncUploadPreview> {
  const { assertNativeCatalogRecordPublicationsSettled } =
    await import('./native-catalog-record-mutations');
  assertNativeCatalogRecordPublicationsSettled(db, workspace.path);
  await assertWorkspaceMigrationActionsSettled(workspace.path);
  const limits = input.storagePolicy
    ? workspaceSyncStoragePolicyLimits(input.storagePolicy)
    : WORKSPACE_SYNC_MANIFEST_READ_LIMITS;
  prepareWorkspaceSyncProjection(db, {
    workspaceId: workspace.id,
    workspaceRoot: workspace.path,
    scientificHistoryFormat: input.scientificHistoryFormat,
  });

  const state: CollectState = {
    membership: await readWorkspaceSyncMembership(db, {
      workspaceUuid: input.workspaceUuid,
      repoPath: workspace.path,
    }),
    excludedFiles: [],
    files: [],
    manifestResources: [],
    sourceFilePaths: new Map(),
    excludedSummary: emptyExcludedSummary(),
    unsupportedLeafPaths: input.scientificHistoryFormat === 1 ? new Map() : undefined,
    includedBytes: 0,
    handledAbsolutePaths: new Set(),
    notebookPackageRootsById: new Map(),
    notebookPackageRoots: new Set(),
    sequencePackageRootsById: new Map(),
  };
  await collectWorkspaceFiles(workspace.path, workspace.path, state, limits, {
    previewOnly: true,
    manifestOnly: true,
  });
  if (input.scientificHistoryFormat === 1 && hasRetainedScientificAuthority(db, workspace.id)) {
    const { graph, head } = new ScientificObjectStore(db, workspace.id).read();
    await admitScientificCurrentFiles(
      workspace.path,
      state,
      limits,
      scientificHistoryCurrentFiles(graph, head)
    );
  }
  const collectedFiles = [...state.files, ...state.manifestResources].sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath)
  );

  return {
    workspaceUuid: input.workspaceUuid,
    includedFiles: collectedFiles.map((file) => ({
      relativePath: file.relativePath,
      name: file.name,
      kind: file.kind,
      sizeBytes: file.sizeBytes,
    })),
    includedFileCount: collectedFiles.length,
    includedBytes: state.includedBytes,
    excludedSummary: state.excludedSummary,
    statusExcludedSummary: {
      ...toWorkspaceSyncStatusExcludedSummary(state.excludedSummary),
      ignoredCount: state.excludedFiles.filter((file) => file.reason === 'project-ignore').length,
    },
    excludedFiles: state.excludedFiles,
    selection: describeWorkspaceSyncSelection(state.membership, [
      ...state.files,
      ...state.manifestResources,
    ]),
    limits,
  };
}

function selectManagedWorkspace(db: Database.Database, workspaceUuid: string): WorkspaceRow {
  const workspace = db
    .prepare(
      `SELECT id, name, path, repo_uuid, archived_at, trashed_at
       FROM workspaces
       WHERE repo_uuid = ?
       LIMIT 1`
    )
    .get(workspaceUuid) as WorkspaceRow | undefined;

  if (!workspace) {
    throw new WorkspaceSyncSnapshotError(
      'WORKSPACE_NOT_FOUND',
      `Managed workspace not found for repo_uuid ${workspaceUuid}`
    );
  }
  if (!workspace.repo_uuid) {
    throw new WorkspaceSyncSnapshotError(
      'WORKSPACE_NOT_MANAGED',
      `Workspace ${workspaceUuid} is not managed`
    );
  }
  if (workspace.archived_at !== null) {
    throw new WorkspaceSyncSnapshotError(
      'WORKSPACE_ARCHIVED',
      `Workspace ${workspaceUuid} is archived and cannot be snapshotted for sync`
    );
  }
  if (workspace.trashed_at !== null) {
    throw new WorkspaceSyncSnapshotError(
      'WORKSPACE_TRASHED',
      `Workspace ${workspaceUuid} is trashed and cannot be snapshotted for sync`
    );
  }
  return workspace;
}

async function collectWorkspaceFiles(
  rootPath: string,
  currentPath: string,
  state: CollectState,
  limits: ShareBundleLimits,
  options: CollectOptions = {}
): Promise<void> {
  const entries = await readdir(currentPath, { withFileTypes: true });
  const forgeDirectory = entries.find((entry) => entry.isDirectory() && entry.name === '.forge');
  if (forgeDirectory) {
    await collectValidatedForgeMarkers(rootPath, currentPath, state, limits, options);
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory() && SYNC_SKIP_DIRS.has(entry.name)) continue;
    if (entry.isDirectory() && PACKAGE_TRANSACTION_DIRECTORY.test(entry.name)) continue;
    if (SYNC_SKIP_FILES.has(entry.name)) continue;
    if (entry.isFile() && MIGRATION_TRANSACTION_FILE.test(entry.name)) continue;

    const absolutePath = join(currentPath, entry.name);
    if (state.handledAbsolutePaths.has(absolutePath)) continue;
    if (
      entry.isFile() &&
      SYNC_SKIP_WORKSPACE_RELATIVE_FILES.has(
        normalizeRelativePath(relative(rootPath, absolutePath))
      )
    ) {
      continue;
    }
    if (
      entry.isDirectory() &&
      SYNC_SKIP_WORKSPACE_RELATIVE_DIRS.has(normalizeRelativePath(relative(rootPath, absolutePath)))
    ) {
      continue;
    }

    if (entry.isSymbolicLink()) {
      addExcluded(state.excludedSummary, 'unsupported', null);
      state.excludedFiles.push({
        relativePath: normalizeRelativePath(relative(rootPath, absolutePath)),
        sizeBytes: 0,
        reason: 'unsupported',
      });
      continue;
    }
    if (entry.isDirectory()) {
      if (entry.name === '.forge') {
        continue;
      }
      await collectWorkspaceFiles(rootPath, absolutePath, state, limits, options);
      continue;
    }
    if (!entry.isFile()) continue;
    await collectWorkspaceFile(rootPath, absolutePath, entry.name, state, limits, options);
  }
}

async function collectValidatedForgeMarkers(
  rootPath: string,
  packageRoot: string,
  state: CollectState,
  limits: ShareBundleLimits,
  options: CollectOptions
): Promise<void> {
  const forgeRoot = join(packageRoot, '.forge');
  const maxParsedMemberBytes = Math.min(
    limits.maxFileBytes,
    resolveWorkspaceSyncBundleLimits().maxFileBytes
  );
  if (packageRoot === rootPath) {
    const manifestPath = join(rootPath, NATIVE_WORKSPACE_MANIFEST_PATH);
    const manifestStat = await lstat(manifestPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (manifestStat) {
      if (
        !manifestStat.isFile() ||
        manifestStat.isSymbolicLink() ||
        manifestStat.size > maxParsedMemberBytes
      ) {
        throw new WorkspaceSyncSnapshotError(
          'INVALID_BUNDLE',
          'Native workspace catalog is not a bounded regular file.'
        );
      }
      parseNativeWorkspaceManifest(await readFile(manifestPath, 'utf8'));
      const included = await collectWorkspaceFile(
        rootPath,
        manifestPath,
        basename(manifestPath),
        state,
        limits,
        options
      );
      if (!included)
        throw new WorkspaceSyncSnapshotError(
          'INVALID_BUNDLE',
          'Native workspace catalog could not be included in the snapshot.'
        );
    }
  }
  const plasmidMarker = join(forgeRoot, SEQUENCE_PACKAGE_META_NAME);
  let plasmidMarkerPresent = false;
  try {
    const markerStat = await lstat(plasmidMarker);
    plasmidMarkerPresent = true;
    if (
      markerStat.isSymbolicLink() ||
      !markerStat.isFile() ||
      markerStat.size > maxParsedMemberBytes
    ) {
      throw unsupportedSequencePackage(
        packageRoot,
        `${SEQUENCE_PACKAGE_META_NAME} is not a bounded regular file`
      );
    }
    const markerBytes = await readFile(plasmidMarker);
    const markerText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      markerBytes
    );
    const document = parseSequencePackageDocument(markerText);
    registerSequencePackageRoot(rootPath, packageRoot, document.id, state);
    if (!requiresSequencePackageDiskMigration(markerText)) {
      await collectSequencePackage(
        rootPath,
        packageRoot,
        plasmidMarker,
        markerBytes,
        document,
        state,
        limits,
        options
      );
    } else {
      await collectWorkspaceFile(
        rootPath,
        plasmidMarker,
        SEQUENCE_PACKAGE_META_NAME,
        state,
        limits,
        options
      );
    }
  } catch (error) {
    if (error instanceof WorkspaceSyncSnapshotError) throw error;
    if (!(!plasmidMarkerPresent && isMissingPathError(error))) {
      const detail = error instanceof Error ? error.message : String(error);
      throw unsupportedSequencePackage(packageRoot, detail);
    }
  }

  try {
    const notebookPackage = await validatedNotebookSyncPackage(rootPath, packageRoot, {
      maxMemberBytes: limits.maxFileBytes,
      maxParsedMemberBytes,
      maxMembers: limits.maxFiles,
      maxTotalBytes: limits.maxBundleBytes,
    });
    if (notebookPackage) {
      await collectNotebookPackage(rootPath, notebookPackage, state, limits, options);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new WorkspaceSyncSnapshotError(
      'INVALID_BUNDLE',
      `Notebook package is not restorable and was not snapshotted: ${packageRoot}: ${detail}`
    );
  }
}

interface SequencePackageCandidate {
  absolutePath: string;
  relativePath: string;
  name: string;
  kind: WorkspaceSyncFile['kind'];
  contentType: string;
  sizeBytes: number;
  knownBytes?: Buffer;
}

async function collectSequencePackage(
  rootPath: string,
  packageRoot: string,
  markerPath: string,
  markerBytes: Buffer,
  document: SequencePackageDocument,
  state: CollectState,
  limits: ShareBundleLimits,
  options: CollectOptions
): Promise<void> {
  const packageRootRelative = normalizeRelativePath(relative(rootPath, packageRoot));
  if (!packageRootRelative || !isSafeRelativePath(packageRootRelative)) {
    throw unsupportedSequencePackage(packageRoot, 'package root is unsafe');
  }

  const requiredPaths = [
    { absolutePath: markerPath, knownBytes: markerBytes },
    { absolutePath: join(packageRoot, document.product.file) },
    ...document.members.map((member) => ({ absolutePath: join(packageRoot, member.path) })),
  ];
  const seen = new Set<string>();
  const candidates: SequencePackageCandidate[] = [];
  for (const required of requiredPaths) {
    if (seen.has(required.absolutePath)) {
      throw unsupportedSequencePackage(packageRoot, `duplicate member ${required.absolutePath}`);
    }
    seen.add(required.absolutePath);

    let fileStat: Stats;
    try {
      await assertNoSymlinkDirectoryAncestors(rootPath, required.absolutePath, packageRoot);
      fileStat = await lstat(required.absolutePath);
    } catch (error) {
      if (isMissingPathError(error)) {
        throw unsupportedSequencePackage(
          packageRoot,
          `required member is missing: ${relative(rootPath, required.absolutePath)}`
        );
      }
      throw error;
    }
    if (fileStat.isSymbolicLink()) {
      throw unsupportedSequencePackage(
        packageRoot,
        `required member is a symbolic link: ${relative(rootPath, required.absolutePath)}`
      );
    }
    if (!fileStat.isFile()) {
      throw unsupportedSequencePackage(
        packageRoot,
        `required member is not a regular file: ${relative(rootPath, required.absolutePath)}`
      );
    }

    const relativePath = normalizeRelativePath(relative(rootPath, required.absolutePath));
    if (!relativePath || !isSafeRelativePath(relativePath)) {
      throw unsupportedSequencePackage(packageRoot, 'required member path is unsafe');
    }
    const classification = classifyShareFileForNewBundle(relativePath, fileStat.size, limits);
    if (
      classification.action === 'exclude' &&
      classification.reason !== 'unsupported' &&
      classification.reason !== 'file-too-large' &&
      classification.reason !== 'bundle-too-large'
    ) {
      throw unsupportedSequencePackage(
        packageRoot,
        `required member is excluded by ${classification.reason}: ${relativePath}`
      );
    }
    const portableClassification =
      classification.action === 'include'
        ? classification
        : classification.reason === 'unsupported'
          ? {
              action: 'include' as const,
              kind: 'assembly-sidecar' as const,
              contentType: 'application/octet-stream',
            }
          : classification;
    if (portableClassification.action === 'exclude') {
      if (!options.previewOnly || options.captureSources)
        deferSequencePackageQuotaError(
          state,
          packageRoot,
          `required member is excluded by ${portableClassification.reason}: ${relativePath}`
        );
      for (const requiredPath of requiredPaths) {
        state.handledAbsolutePaths.add(requiredPath.absolutePath);
      }
      addExcluded(state.excludedSummary, portableClassification.reason, fileStat.size);
      state.excludedFiles.push({
        relativePath,
        sizeBytes: fileStat.size,
        reason: portableClassification.reason,
      });
      return;
    }
    candidates.push({
      absolutePath: required.absolutePath,
      relativePath,
      name: basename(required.absolutePath),
      kind: portableClassification.kind,
      contentType: portableClassification.contentType,
      sizeBytes: fileStat.size,
      ...(required.knownBytes ? { knownBytes: required.knownBytes } : {}),
    });
  }

  for (const candidate of candidates) state.membership.requiredPaths.add(candidate.relativePath);
  for (const required of requiredPaths) state.handledAbsolutePaths.add(required.absolutePath);
  const packageBytes = candidates.reduce((sum, candidate) => sum + candidate.sizeBytes, 0);
  if (
    state.files.length + state.manifestResources.length + candidates.length > limits.maxFiles ||
    state.includedBytes + packageBytes > limits.maxBundleBytes
  ) {
    if (!options.previewOnly || options.captureSources)
      deferSequencePackageQuotaError(
        state,
        packageRoot,
        'complete package exceeds the workspace file-count or byte allowance'
      );
    for (const candidate of candidates) {
      addExcluded(state.excludedSummary, 'bundle-too-large', candidate.sizeBytes);
      state.excludedFiles.push({
        relativePath: candidate.relativePath,
        sizeBytes: candidate.sizeBytes,
        reason: 'bundle-too-large',
      });
    }
    return;
  }

  const staged: WorkspaceSyncFile[] = [];
  for (const candidate of candidates) {
    if (options.directStorage && !options.previewOnly) {
      staged.push(
        await captureDirectFile(
          candidate.absolutePath,
          {
            id: deterministicFileId(candidate.relativePath),
            relativePath: candidate.relativePath,
            name: candidate.name,
            kind: candidate.kind,
            contentType: candidate.contentType,
          },
          limits,
          candidate.knownBytes
        )
      );
      continue;
    }
    const bytes = options.previewOnly
      ? null
      : (candidate.knownBytes ?? (await readFile(candidate.absolutePath)));
    const binary = candidate.contentType === 'application/octet-stream';
    if (bytes && !binary) {
      try {
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        throw new WorkspaceSyncSnapshotError(
          'INVALID_TEXT_ENCODING',
          `Workspace sync requires UTF-8 text content: ${candidate.relativePath}`
        );
      }
    }
    staged.push({
      id: deterministicFileId(candidate.relativePath),
      relativePath: candidate.relativePath,
      name: candidate.name,
      kind: candidate.kind,
      contentType: candidate.contentType,
      sizeBytes: candidate.sizeBytes,
      sha256: bytes ? sha256Bytes(bytes) : '0'.repeat(64),
      content: bytes ? (binary ? bytes.toString('base64') : bytes.toString('utf8')) : '',
      ...(binary ? { encoding: 'base64' as const } : {}),
    });
    if (!options.previewOnly || options.captureSources) {
      state.sourceFilePaths.set(candidate.relativePath, candidate.absolutePath);
    }
  }
  state.files.push(...staged);
  state.includedBytes += packageBytes;
}

function registerSequencePackageRoot(
  rootPath: string,
  packageRoot: string,
  stableId: string,
  state: CollectState
): void {
  const packageRootRelative = normalizeRelativePath(relative(rootPath, packageRoot));
  if (!packageRootRelative || !isSafeRelativePath(packageRootRelative)) {
    throw unsupportedSequencePackage(packageRoot, 'package root is unsafe');
  }
  const existingRoot = state.sequencePackageRootsById.get(stableId);
  if (existingRoot && existingRoot !== packageRootRelative) {
    throw unsupportedSequencePackage(
      packageRoot,
      `duplicate stable id ${stableId} at ${existingRoot} and ${packageRootRelative}`
    );
  }
  state.sequencePackageRootsById.set(stableId, packageRootRelative);
}

function readSequencePackageOnDiskFormatVersion(content: string): number {
  const parsed: unknown = JSON.parse(content);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 1;
  const version = 'formatVersion' in parsed ? parsed.formatVersion : undefined;
  return typeof version === 'number' && Number.isInteger(version) ? version : 1;
}

function requiresSequencePackageDiskMigration(content: string): boolean {
  const onDiskFormatVersion = readSequencePackageOnDiskFormatVersion(content);
  return SEQUENCE_PACKAGE_MIGRATORS.some(
    (step) => step.from >= onDiskFormatVersion && step.disk !== undefined
  );
}

async function assertNoSymlinkDirectoryAncestors(
  rootPath: string,
  targetPath: string,
  packageRoot: string
): Promise<void> {
  const targetRelative = relative(rootPath, targetPath);
  if (
    targetRelative === '..' ||
    targetRelative.startsWith(`..${sep}`) ||
    targetRelative.split(sep).some((segment) => segment.length === 0)
  ) {
    throw unsupportedSequencePackage(packageRoot, 'required member path escapes the workspace');
  }
  let current = rootPath;
  for (const segment of targetRelative.split(sep).slice(0, -1)) {
    current = join(current, segment);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw unsupportedSequencePackage(
        packageRoot,
        `required member has an unsafe directory ancestor: ${relative(rootPath, current)}`
      );
    }
  }
}

function deferSequencePackageQuotaError(
  state: CollectState,
  packageRoot: string,
  detail: string
): void {
  state.packageQuotaError ??= new WorkspaceSyncSnapshotError(
    'QUOTA_EXCEEDED',
    `Sequence package exceeds the storage allowance and was not snapshotted: ${packageRoot}: ${detail}`
  );
}

function unsupportedSequencePackage(
  packageRoot: string,
  detail: string
): WorkspaceSyncSnapshotError {
  return new WorkspaceSyncSnapshotError(
    'UNSUPPORTED_AUTHORITATIVE_STATE',
    `Sequence package is not portable and was not snapshotted: ${packageRoot}: ${detail}`
  );
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function admitNotebookPackageRoot(
  rootPath: string,
  notebookPackage: ValidatedNotebookSyncPackage,
  state: CollectState
): string {
  const packageRootRelative = normalizeRelativePath(
    relative(rootPath, notebookPackage.packageRoot)
  );
  if (!packageRootRelative || !isSafeRelativePath(packageRootRelative)) {
    throw new WorkspaceSyncSnapshotError('INVALID_BUNDLE', 'Notebook package root is unsafe');
  }
  const nestedRoot = [...state.notebookPackageRoots].find(
    (root) =>
      packageRootRelative.startsWith(`${root}/`) || root.startsWith(`${packageRootRelative}/`)
  );
  if (nestedRoot) {
    throw new WorkspaceSyncSnapshotError(
      'INVALID_BUNDLE',
      `Workspace contains nested notebook packages: ${nestedRoot}, ${packageRootRelative}`
    );
  }
  state.notebookPackageRoots.add(packageRootRelative);
  const existingPackageRoot = state.notebookPackageRootsById.get(notebookPackage.notebookId);
  if (existingPackageRoot && existingPackageRoot !== packageRootRelative) {
    throw new WorkspaceSyncSnapshotError(
      'INVALID_BUNDLE',
      `Workspace contains duplicate notebook id ${notebookPackage.notebookId}: ${existingPackageRoot}, ${packageRootRelative}`
    );
  }
  state.notebookPackageRootsById.set(notebookPackage.notebookId, packageRootRelative);
  return packageRootRelative;
}

async function collectNotebookPackage(
  rootPath: string,
  notebookPackage: ValidatedNotebookSyncPackage,
  state: CollectState,
  limits: ShareBundleLimits,
  options: CollectOptions
): Promise<void> {
  const packageRootRelative = admitNotebookPackageRoot(rootPath, notebookPackage, state);

  const admitted: Array<{
    member: ValidatedNotebookSyncMember;
    relativePath: string;
    kind: WorkspaceSyncFile['kind'];
    contentType: string;
    sizeBytes: number;
  }> = [];
  let stagedBytes = 0;
  const handled = new Set(notebookPackage.members.map((member) => member.absolutePath));
  for (const member of notebookPackage.members) {
    const relativePath = normalizeRelativePath(relative(rootPath, member.absolutePath));
    if (!relativePath || !isSafeRelativePath(relativePath)) {
      throw new WorkspaceSyncSnapshotError('INVALID_BUNDLE', 'Notebook member path is unsafe');
    }
    const sizeBytes = member.sizeBytes;
    const classification = member.packageAsset
      ? classifyValidatedNotebookAssetPath(relativePath, packageRootRelative, sizeBytes, limits)
      : {
          action: 'include' as const,
          kind: 'notebook' as const,
          contentType: relativePath.endsWith('.md') ? 'text/markdown' : 'application/json',
        };
    if (classification.action === 'exclude') {
      addExcluded(state.excludedSummary, classification.reason, sizeBytes);
      state.excludedFiles.push({ relativePath, sizeBytes, reason: classification.reason });
      continue;
    }
    if (sizeBytes > limits.maxFileBytes) {
      for (const path of handled) state.handledAbsolutePaths.add(path);
      addExcluded(state.excludedSummary, 'file-too-large', sizeBytes);
      state.excludedFiles.push({ relativePath, sizeBytes, reason: 'file-too-large' });
      return;
    }

    admitted.push({
      member,
      relativePath,
      kind: classification.kind,
      contentType: classification.contentType,
      sizeBytes,
    });
    stagedBytes += sizeBytes;
  }

  for (const file of admitted) state.membership.requiredPaths.add(file.relativePath);
  for (const path of handled) state.handledAbsolutePaths.add(path);
  if (
    state.files.length + state.manifestResources.length + admitted.length > limits.maxFiles ||
    state.includedBytes + stagedBytes > limits.maxBundleBytes
  ) {
    for (const file of admitted) {
      addExcluded(state.excludedSummary, 'bundle-too-large', file.sizeBytes);
      state.excludedFiles.push({
        relativePath: file.relativePath,
        sizeBytes: file.sizeBytes,
        reason: 'bundle-too-large',
      });
    }
    return;
  }

  const staged: WorkspaceSyncFile[] = [];
  for (const candidate of admitted) {
    if (options.directStorage && !options.previewOnly) {
      staged.push(
        await captureDirectFile(
          candidate.member.readPath,
          {
            id: deterministicFileId(candidate.relativePath),
            relativePath: candidate.relativePath,
            name: basename(candidate.member.absolutePath),
            kind: candidate.kind,
            contentType: candidate.contentType,
          },
          limits,
          undefined,
          candidate.member
        )
      );
      continue;
    }
    const bytes = options.previewOnly
      ? null
      : await readValidatedNotebookSyncMemberBytes(candidate.member, limits.maxFileBytes);
    const binary = candidate.contentType === 'application/octet-stream';
    staged.push({
      id: deterministicFileId(candidate.relativePath),
      relativePath: candidate.relativePath,
      name: basename(candidate.member.absolutePath),
      kind: candidate.kind,
      contentType: candidate.contentType,
      sizeBytes: candidate.sizeBytes,
      sha256: bytes ? sha256Bytes(bytes) : '0'.repeat(64),
      content: bytes ? (binary ? bytes.toString('base64') : bytes.toString('utf8')) : '',
      ...(binary ? { encoding: 'base64' as const } : {}),
    });
    if (!options.previewOnly || options.captureSources) {
      state.sourceFilePaths.set(candidate.relativePath, candidate.member.readPath);
    }
  }
  state.files.push(...staged);
  state.includedBytes += stagedBytes;
}

function admitCollectedWorkspaceRelativePath(
  rootPath: string,
  absolutePath: string,
  state: CollectState
): string | null {
  if (state.handledAbsolutePaths.has(absolutePath)) return null;
  state.handledAbsolutePaths.add(absolutePath);
  const relativePath = normalizeRelativePath(relative(rootPath, absolutePath));
  if (!relativePath || !isSafeRelativePath(relativePath)) {
    addExcluded(state.excludedSummary, 'unsupported', null);
    return null;
  }
  return relativePath;
}

async function loadLegacyNotebookForSnapshot(
  rootPath: string,
  absolutePath: string,
  relativePath: string,
  entryName: string,
  maxFileBytes: number
): Promise<ValidatedLegacyNotebookSyncFile | null> {
  if (!entryName.toLowerCase().endsWith('.wpnote.json')) return null;
  try {
    return await validatedLegacyNotebookSyncFile(rootPath, absolutePath, maxFileBytes);
  } catch (error) {
    throw new WorkspaceSyncSnapshotError(
      'INVALID_BUNDLE',
      `Legacy notebook is not restorable and was not snapshotted: ${relativePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function rejectNestedOrDuplicateLegacyNotebook(
  state: CollectState,
  relativePath: string,
  legacyNotebook: ValidatedLegacyNotebookSyncFile
): void {
  const containingPackageRoot = [...state.notebookPackageRoots].find((root) =>
    relativePath.startsWith(`${root}/`)
  );
  if (containingPackageRoot) {
    throw new WorkspaceSyncSnapshotError(
      'INVALID_BUNDLE',
      `Workspace contains a notebook authority nested inside ${containingPackageRoot}: ${relativePath}`
    );
  }
  const existingPath = state.notebookPackageRootsById.get(legacyNotebook.notebookId);
  if (existingPath && existingPath !== relativePath) {
    throw new WorkspaceSyncSnapshotError(
      'INVALID_BUNDLE',
      `Workspace contains duplicate notebook id ${legacyNotebook.notebookId}: ${existingPath}, ${relativePath}`
    );
  }
  state.notebookPackageRootsById.set(legacyNotebook.notebookId, relativePath);
}

async function collectWorkspaceFile(
  rootPath: string,
  absolutePath: string,
  entryName: string,
  state: CollectState,
  limits: ShareBundleLimits,
  options: CollectOptions
): Promise<boolean> {
  const relativePath = admitCollectedWorkspaceRelativePath(rootPath, absolutePath, state);
  if (!relativePath) return false;

  const membershipStat = await lstat(absolutePath);
  if (
    relativePath === NATIVE_WORKSPACE_MANIFEST_PATH ||
    /(?:^|\/)\.forge\/(?:plasmid|notebook)\.json$/u.test(relativePath)
  )
    state.membership.requiredPaths.add(relativePath);
  if (isWorkspaceSyncProjectIgnored(state.membership, relativePath)) {
    state.excludedFiles.push({
      relativePath,
      sizeBytes: membershipStat.size,
      reason: 'project-ignore',
    });
    return false;
  }

  const legacyNotebook = await loadLegacyNotebookForSnapshot(
    rootPath,
    absolutePath,
    relativePath,
    entryName,
    Math.min(limits.maxFileBytes, resolveWorkspaceSyncBundleLimits().maxFileBytes)
  );

  const fileStat = legacyNotebook ? null : await lstat(absolutePath);
  if (fileStat && (fileStat.isSymbolicLink() || !fileStat.isFile())) {
    addExcluded(state.excludedSummary, 'unsupported', null);
    state.excludedFiles.push({
      relativePath,
      sizeBytes: fileStat?.size ?? 0,
      reason: 'unsupported',
    });
    return false;
  }
  const fileSize = legacyNotebook?.member.sizeBytes ?? fileStat?.size ?? 0;

  const pathOnlyNotebookClassification = classifyNotebookPackageMemberPath(
    relativePath.toLowerCase()
  );
  const notebookMarkdownCandidate =
    !legacyNotebook && pathOnlyNotebookClassification?.contentType === 'text/markdown'
      ? await validatedNotebookMarkdownSyncFile(rootPath, absolutePath)
      : null;
  if (
    notebookMarkdownCandidate &&
    (await validatedNotebookSyncMemberContainsMarker(notebookMarkdownCandidate))
  ) {
    throw new WorkspaceSyncSnapshotError(
      'INVALID_BUNDLE',
      `Notebook Markdown is missing its package metadata: ${relativePath}`
    );
  }

  const classification = classifyShareFileForNewBundle(relativePath, fileSize, limits);
  const resourceContentType =
    (options.directStorage || (options.previewOnly && options.manifestOnly)) &&
    classification.action === 'exclude' &&
    classification.reason === 'unsupported'
      ? workspaceSyncResourceMediaType(relativePath)
      : null;
  if (resourceContentType) {
    if (fileSize > limits.maxFileBytes) {
      addExcluded(state.excludedSummary, 'file-too-large', fileSize);
      state.excludedFiles.push({ relativePath, sizeBytes: fileSize, reason: 'file-too-large' });
      return false;
    }
    if (
      state.files.length + state.manifestResources.length >= limits.maxFiles ||
      state.includedBytes + fileSize > limits.maxBundleBytes
    ) {
      addExcluded(state.excludedSummary, 'bundle-too-large', fileSize);
      state.excludedFiles.push({ relativePath, sizeBytes: fileSize, reason: 'bundle-too-large' });
      return false;
    }
    if (options.directStorage && !options.previewOnly) {
      state.files.push(
        await captureDirectFile(
          absolutePath,
          {
            id: deterministicFileId(relativePath),
            relativePath,
            name: entryName,
            kind: 'workspace-resource',
            contentType: resourceContentType,
          },
          limits
        )
      );
      state.sourceFilePaths.set(relativePath, absolutePath);
    } else {
      state.manifestResources.push({
        relativePath,
        name: entryName,
        kind: 'workspace-resource',
        contentType: resourceContentType,
        sizeBytes: fileSize,
      });
    }
    if (options.captureSources) state.sourceFilePaths.set(relativePath, absolutePath);
    state.includedBytes += fileSize;
    return true;
  }
  if (classification.action === 'exclude') {
    if ((classification.reason ?? 'unsupported') === 'unsupported')
      state.unsupportedLeafPaths?.set(relativePath, fileSize);
    addExcluded(state.excludedSummary, classification.reason ?? 'unsupported', fileSize);
    state.excludedFiles.push({
      relativePath,
      sizeBytes: fileSize,
      reason: classification.reason ?? 'unsupported',
    });
    return false;
  }
  if (legacyNotebook) {
    rejectNestedOrDuplicateLegacyNotebook(state, relativePath, legacyNotebook);
  }
  if (
    state.files.length + state.manifestResources.length >= limits.maxFiles ||
    state.includedBytes + fileSize > limits.maxBundleBytes
  ) {
    addExcluded(state.excludedSummary, 'bundle-too-large', fileSize);
    state.excludedFiles.push({ relativePath, sizeBytes: fileSize, reason: 'bundle-too-large' });
    return false;
  }

  if (options.previewOnly) {
    const sizeBytes = fileSize;
    if (sizeBytes > limits.maxFileBytes) {
      addExcluded(state.excludedSummary, 'file-too-large', sizeBytes);
      state.excludedFiles.push({ relativePath, sizeBytes, reason: 'file-too-large' });
      return false;
    }
    state.files.push({
      id: deterministicFileId(relativePath),
      relativePath,
      name: entryName,
      kind: classification.kind ?? 'genbank',
      contentType: classification.contentType ?? 'text/plain',
      sizeBytes,
      sha256: '0'.repeat(64),
      content: '',
    });
    if (options.captureSources) {
      state.sourceFilePaths.set(
        relativePath,
        legacyNotebook?.member.readPath ?? notebookMarkdownCandidate?.readPath ?? absolutePath
      );
    }
    state.includedBytes += sizeBytes;
    return true;
  }

  if (options.directStorage) {
    const member = legacyNotebook?.member ?? notebookMarkdownCandidate ?? undefined;
    const file = await captureDirectFile(
      member?.readPath ?? absolutePath,
      {
        id: deterministicFileId(relativePath),
        relativePath,
        name: entryName,
        kind: classification.kind ?? 'genbank',
        contentType: classification.contentType ?? 'text/plain',
      },
      limits,
      undefined,
      member
    );
    if (relativePath === NATIVE_WORKSPACE_MANIFEST_PATH) parseNativeWorkspaceManifest(file.content);
    state.files.push(file);
    state.includedBytes += file.sizeBytes;
    return true;
  }

  const bytes = legacyNotebook
    ? await readValidatedNotebookSyncMemberBytes(legacyNotebook.member, limits.maxFileBytes)
    : notebookMarkdownCandidate
      ? await readValidatedNotebookSyncMemberBytes(notebookMarkdownCandidate, limits.maxFileBytes)
      : await readFile(absolutePath);
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new WorkspaceSyncSnapshotError(
      'INVALID_TEXT_ENCODING',
      `Workspace sync requires UTF-8 text content: ${relativePath}`
    );
  }
  const sizeBytes = Buffer.byteLength(content, 'utf8');
  if (relativePath === NATIVE_WORKSPACE_MANIFEST_PATH) parseNativeWorkspaceManifest(content);
  if (
    classification.kind === 'notebook' &&
    classification.contentType === 'text/markdown' &&
    content.includes(NOTEBOOK_MARKER_PREFIX)
  ) {
    throw new WorkspaceSyncSnapshotError(
      'INVALID_BUNDLE',
      `Notebook Markdown is missing its package metadata: ${relativePath}`
    );
  }
  if (sizeBytes > limits.maxFileBytes) {
    addExcluded(state.excludedSummary, 'file-too-large', sizeBytes);
    state.excludedFiles.push({ relativePath, sizeBytes, reason: 'file-too-large' });
    return false;
  }

  const binary = classification.contentType === 'application/octet-stream';
  state.files.push({
    id: deterministicFileId(relativePath),
    relativePath,
    name: entryName,
    kind: classification.kind ?? 'genbank',
    contentType: classification.contentType ?? 'text/plain',
    sizeBytes,
    sha256: sha256Bytes(bytes),
    content: binary ? bytes.toString('base64') : bytes.toString('utf8'),
    ...(binary ? { encoding: 'base64' as const } : {}),
  });
  state.sourceFilePaths.set(
    relativePath,
    legacyNotebook?.member.readPath ?? notebookMarkdownCandidate?.readPath ?? absolutePath
  );
  state.includedBytes += sizeBytes;
  return true;
}

async function hashWorkspaceSyncCaptureFile(
  sourcePath: string,
  expectedSizeBytes: number,
  contentType: string,
  relativePath: string
): Promise<string> {
  const sourceStat = await lstat(sourcePath).catch((error) => {
    throw new WorkspaceSyncSnapshotError(
      'INVALID_BUNDLE',
      `Workspace sync source cannot be read: ${relativePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  });
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new WorkspaceSyncSnapshotError(
      'INVALID_BUNDLE',
      `Workspace sync source is not a regular file: ${relativePath}`
    );
  }
  if (sourceStat.size !== expectedSizeBytes) {
    throw new WorkspaceSyncSnapshotError(
      'INVALID_BUNDLE',
      `Workspace sync source size changed: ${relativePath}`
    );
  }

  const hash = createHash('sha256');
  const binary = isBinarySyncMediaType(contentType);
  const decoder = binary ? null : new TextDecoder('utf-8', { fatal: true });
  let bytesRead = 0;
  try {
    for await (const chunk of createReadStream(sourcePath)) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytesRead += bytes.byteLength;
      if (bytesRead > expectedSizeBytes) {
        throw new Error('source grew during capture');
      }
      hash.update(bytes);
      decoder?.decode(bytes, { stream: true });
    }
    decoder?.decode();
  } catch (error) {
    if (error instanceof TypeError && decoder) {
      throw new WorkspaceSyncSnapshotError(
        'INVALID_TEXT_ENCODING',
        `Workspace sync requires UTF-8 text content: ${relativePath}`
      );
    }
    throw new WorkspaceSyncSnapshotError(
      'INVALID_BUNDLE',
      `Workspace sync source changed during capture: ${relativePath}`
    );
  }
  if (bytesRead !== expectedSizeBytes) {
    throw new WorkspaceSyncSnapshotError(
      'INVALID_BUNDLE',
      `Workspace sync source size changed: ${relativePath}`
    );
  }
  return hash.digest('hex');
}

function emptyExcludedSummary(): BundleExcludedSummary {
  return {
    unsupported: { count: 0, bytesApprox: 0 },
    'private-raw-data': { count: 0, bytesApprox: 0 },
    'reference-pointer': { count: 0, bytesApprox: 0 },
    'file-too-large': { count: 0, bytesApprox: 0 },
    'bundle-too-large': { count: 0, bytesApprox: 0 },
  };
}

function addExcluded(
  summary: BundleExcludedSummary,
  reason: WorkspaceSyncExcludedReason,
  bytesApprox: number | null
): void {
  const entry = summary[reason];
  entry.count += 1;
  if (bytesApprox !== null) {
    entry.bytesApprox = (entry.bytesApprox ?? 0) + bytesApprox;
  }
}

function deterministicFileId(relativePath: string): string {
  return `file-${sha256Hex(relativePath).slice(0, 32)}`;
}

function normalizeRelativePath(path: string): string {
  return path.split(sep).join('/');
}

function cleanWorkspaceName(value: string): string {
  return value.trim().slice(0, 160) || 'DNAForge workspace';
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sha256Bytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function isBinarySyncMediaType(contentType: string): boolean {
  return (
    contentType === 'application/octet-stream' ||
    (contentType.startsWith('image/') && contentType !== 'image/svg+xml')
  );
}

async function captureDirectFile(
  absolutePath: string,
  metadata: Pick<WorkspaceSyncFile, 'id' | 'relativePath' | 'name' | 'kind' | 'contentType'>,
  limits: ShareBundleLimits,
  knownBytes?: Buffer,
  member?: ValidatedNotebookSyncMember
): Promise<WorkspaceSyncFile> {
  const authority =
    knownBytes !== undefined ||
    metadata.relativePath === NATIVE_WORKSPACE_MANIFEST_PATH ||
    /(?:^|\/)\.forge\/(?:plasmid|notebook)\.json$/u.test(metadata.relativePath);
  if (authority) {
    const size = knownBytes?.length ?? (await lstat(absolutePath)).size;
    if (size > 1024 * 1024)
      throw new WorkspaceSyncSnapshotError(
        'INVALID_BUNDLE',
        'Workspace authority metadata exceeds 1 MiB.'
      );
    const bytes =
      knownBytes ??
      (member
        ? await readValidatedNotebookSyncMemberBytes(member, 1024 * 1024)
        : await readFile(absolutePath));
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return { ...metadata, sizeBytes: bytes.length, sha256: sha256Bytes(bytes), content };
  }
  try {
    const identity = await captureWorkspaceSyncBlob(absolutePath, {
      maxBytes: limits.maxFileBytes,
      utf8: !isBinarySyncMediaType(metadata.contentType),
      expectedIdentity: member?.deferredIdentity,
    });
    return { ...metadata, ...identity, content: '', encoding: 'blob' };
  } catch (error) {
    if (error instanceof TypeError && error.message.includes('encoded data')) {
      throw new WorkspaceSyncSnapshotError(
        'INVALID_TEXT_ENCODING',
        `Workspace sync requires UTF-8 text content: ${metadata.relativePath}`
      );
    }
    throw error;
  }
}
