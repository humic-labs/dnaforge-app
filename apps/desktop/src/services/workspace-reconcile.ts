import { SOURCE_DOCUMENT_MARKER_PATH } from '../shared/source-document-package';
import { platform } from '../platform';
import { isDeveloperImportSourcePath } from '../shared/developer-import-sources';
import { isTextSequenceFileKind } from '../shared/catalog-file-kind';
import {
  getCatalogFilesUnderPath,
  getCatalogEntity,
  inferCatalogFileKind,
  markCatalogFileMissing,
  registerWorkspaceFile,
  type CatalogEntityType,
  type DBCatalogEntityFile,
} from '../db/workspace-catalog';
import { resolveArtifactFile } from '../db/workspace-artifacts';
import { resolveSavedResidueSelectionArtifact } from '../db/saved-residue-selection-artifact';
import { NOTEBOOK_PACKAGE_MARKER_DIR, NOTEBOOK_PACKAGE_META_NAME } from '../db/notebook-package';
import { SEQUENCE_PACKAGE_META_ALIASES, isSequencePackageMetaPath } from '../db/sequence-package';
import { loadSequencePackageDocument } from '../db/sequence-package-io';
import {
  PROTOCOL_PACKAGE_META_NAME,
  PROTOCOL_RUN_PACKAGE_META_NAME,
} from '../shared/scientific-package';
import {
  BENCHLING_MIGRATION_WORKSPACE_MARKER,
  MANAGED_WORKSPACE_MARKER,
} from '../shared/workspace-git-types';
import { indexWorkspaceHeadIntoCatalog } from './workspace-git-indexer';
import { reconcilePrimerArtifactsInWorkspace } from '../features/primers/primer-artifact-service';
import { applyExternalMovesForRoot, type CurrentRegistryFile } from './external-move-reconcile';
import { cooperateWithRendererInteraction } from '../lib/renderer-interaction-activity';
import { HARD_CAP_BYTES } from '../shared/oversized-guard';
import {
  reconcileNativeWorkspaceManifest,
  type NativeWorkspaceManifestReconcileResult,
  type NativeWorkspaceManifestFileBinding,
} from './native-workspace-manifest-reconcile';
import type {
  WorkspaceArtifactDiscoveryResult,
  WorkspaceCatalogCandidate,
  WorkspaceEntityMigrationResult,
} from '../shared/workspace-git-types';
import { reconcileNativeScientificPackage } from './native-scientific-package-reconcile';
import { withRendererWorkspaceMutation } from './workspace-mutation-transaction';
import { reconcileSequencePackageCatalogEntity } from './sequence-package-catalog-reconcile';
import { getTabTypeForFile } from '../utils/fileTypes';
import type { ManagedSequenceDocumentRef } from '../shared/managed-sequence-document';
import { reconcileAcceptedScientificProjections } from './reconcile-scientific-projections';
import { reportEntityMigrationIssues } from './workspace-reconcile-report';

export type WorkspaceCatalogSource = 'head' | 'working-tree';

interface WorkspaceReconcileOptions {
  catalogSource?: WorkspaceCatalogSource;
  signal?: AbortSignal;
  healManagedHead?: boolean;
  strict?: boolean;
  mutationToken?: string;
  waitForMutationAvailability?: boolean;
  pendingSequenceDocument?: ManagedSequenceDocumentRef;
  acceptedPaths?: readonly string[];
  acceptedResourceIds?: readonly string[];
}

interface ManagedWorkspaceReconcileMutationOptions {
  signal?: AbortSignal;
  mutationToken?: string;
  waitForMutationAvailability?: boolean;
}

import type { WorkspaceReconcileResult } from './workspace-reconcile-result';
export type { WorkspaceReconcileResult } from './workspace-reconcile-result';

export async function isManagedRepo(rootPath: string): Promise<boolean> {
  try {
    const root = rootPath.replace(/\/+$/, '');
    if (await platform().fs.exists(`${root}/${MANAGED_WORKSPACE_MARKER}`)) return true;

    const [hasMigrationMarker, hasGitRepository] = await Promise.all([
      platform().fs.exists(`${root}/${BENCHLING_MIGRATION_WORKSPACE_MARKER}`),
      platform().fs.exists(`${root}/.git`),
    ]);
    return hasMigrationMarker && hasGitRepository;
  } catch {
    return false;
  }
}

export async function reconcileWorkspaceRoot(
  rootPath: string,
  options: WorkspaceReconcileOptions = {}
): Promise<WorkspaceReconcileResult> {
  options.signal?.throwIfAborted();
  if (isDeveloperImportSourcePath(rootPath)) return emptyWorkspaceReconcileResult();
  return withManagedWorkspaceReconcileMutation(
    rootPath,
    (mutationToken, managedRepo) =>
      reconcileWorkspaceRootWithinMutation(rootPath, { ...options, mutationToken }, managedRepo),
    options
  );
}

export async function withManagedWorkspaceReconcileMutation<T>(
  rootPath: string,
  operation: (mutationToken: string | undefined, managedRepo: boolean) => Promise<T>,
  options: ManagedWorkspaceReconcileMutationOptions = {}
): Promise<T> {
  options.signal?.throwIfAborted();
  const managedRepo = await isManagedRepo(rootPath);
  const knownRoot =
    managedRepo ||
    (
      await platform().db.select<Array<{ id: number }>>(
        'SELECT id FROM workspaces WHERE path = ?',
        [rootPath]
      )
    ).length > 0;
  if (knownRoot && !options.mutationToken) {
    return withRendererWorkspaceMutation(
      rootPath,
      (mutationToken) => operation(mutationToken, managedRepo),
      undefined,
      { waitForAvailability: options.waitForMutationAvailability }
    );
  }
  return operation(options.mutationToken, managedRepo);
}

async function reconcileWorkspaceRootWithinMutation(
  rootPath: string,
  options: WorkspaceReconcileOptions,
  managedRepo: boolean
): Promise<WorkspaceReconcileResult> {
  const { signal } = options;
  signal?.throwIfAborted();
  if (options.acceptedResourceIds === undefined) {
    const accepted = await reconcileAcceptedScientificProjections(rootPath, options.mutationToken);
    options = {
      ...options,
      acceptedPaths: accepted.paths,
      acceptedResourceIds: accepted.resourceIds,
    };
  }
  let nativeManifest: NativeWorkspaceManifestReconcileResult = {
    present: false,
    providerBindings: 0,
    entities: 0,
    links: 0,
    limsEntities: 0,
    events: 0,
  };
  let nativeManifestError: WorkspaceReconcileResult['errors'][number] | null = null;
  try {
    nativeManifest = await reconcileNativeWorkspaceManifest(rootPath, {
      mutationToken: options.mutationToken,
      acceptedResourceIds: options.acceptedResourceIds,
    });
  } catch (error) {
    nativeManifestError = {
      path: rootPath,
      message: `Native workspace catalog reconstruction failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  let result: WorkspaceReconcileResult;
  let fileMigration: WorkspaceEntityMigrationResult | undefined;
  if (managedRepo && options.catalogSource !== 'working-tree') {
    result = await indexWorkspaceHeadIntoCatalog(
      rootPath,
      (repoPath, preserveRelPaths) =>
        platform().workspace.indexManagedCatalogHead({
          repoPath,
          preserveRelPaths: [...preserveRelPaths],
          healWorkingTree: options.healManagedHead,
          mutationToken: options.mutationToken,
        }),
      {
        signal,
        nativeSequenceBindings: nativeManifest.atomicSequenceBindings,
        nativeFileBindings: nativeManifest.fileBindings,
        acceptedPaths: options.acceptedPaths,
        acceptedResourceIds: options.acceptedResourceIds,
        mutationToken: options.mutationToken,
        ...(options.pendingSequenceDocument
          ? { pendingSequenceDocument: options.pendingSequenceDocument }
          : {}),
      }
    );
    result.entityArtifactDiscoveryComplete = true;
  } else {
    const migrate = platform().workspace.migrateLegacyProjectFiles;
    if (options.healManagedHead !== false && !nativeManifestError && migrate) {
      try {
        fileMigration = await migrate({
          repoPath: rootPath,
          mutationToken: options.mutationToken,
        });
      } catch (error) {
        fileMigration = {
          healedFileCount: 0,
          migrationIssues: [
            {
              path: rootPath,
              kind: 'failed',
              reason: error instanceof Error ? error.message : String(error),
            },
          ],
        };
      }
      signal?.throwIfAborted();
    }
    const knownFiles = await getCatalogFilesUnderPath(rootPath);
    signal?.throwIfAborted();
    const discoverArtifacts = platform().workspace.discoverArtifacts;
    if (typeof discoverArtifacts !== 'function') {
      result = await reconcileWorkspaceRootByFsWalk(
        rootPath,
        signal,
        options.mutationToken,
        nativeManifest.fileBindings,
        options.acceptedPaths
      );
    } else {
      try {
        const discovery = await discoverArtifacts({
          rootPath,
          knownFiles: knownFiles
            .filter((file) => file.status !== 'historical' && file.file_kind !== 'folder')
            .map((file) => ({
              path: file.path,
              contentHash: file.content_hash,
              sizeBytes: file.size_bytes,
              modifiedAt: file.modified_at,
            })),
        });
        signal?.throwIfAborted();

        result = discovery.catalogProjection
          ? await reconcileWorkspaceProjection(
              rootPath,
              discovery,
              signal,
              options.mutationToken,
              nativeManifest.fileBindings,
              options.acceptedPaths
            )
          : await reconcileWorkspaceRootByFsWalk(
              rootPath,
              signal,
              options.mutationToken,
              nativeManifest.fileBindings,
              options.acceptedPaths
            );
        if (discovery.catalogProjection) {
          result.primerArtifactCandidatePaths = discovery.primerArtifactPaths;
          result.entityArtifactCandidatePaths = discovery.entityArtifactPaths;
          result.entityArtifactDiscoveryComplete = true;
        }
        result.errors.push(...discovery.errors);
      } catch (error) {
        result = emptyWorkspaceReconcileResult();
        result.primerArtifactCandidatePaths = [];
        result.entityArtifactCandidatePaths = [];
        result.entityArtifactDiscoveryComplete = false;
        result.errors.push({
          path: rootPath,
          message: `Artifact discovery failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }
  if (fileMigration) {
    result.healedFileCount = (result.healedFileCount ?? 0) + fileMigration.healedFileCount;
    result.migrationIssues = [...(result.migrationIssues ?? []), ...fileMigration.migrationIssues];
    result.errors.push(
      ...fileMigration.migrationIssues
        .filter((issue) => issue.kind === 'failed')
        .map((issue) => ({ path: issue.path, message: issue.reason }))
    );
  }
  if (nativeManifestError) result.errors.unshift(nativeManifestError);
  if (nativeManifest.present) {
    try {
      nativeManifest = await reconcileNativeWorkspaceManifest(rootPath, {
        mutationToken: options.mutationToken,
        notebookBindingPass: nativeManifest.notebookBindingPass,
        acceptedResourceIds: options.acceptedResourceIds,
      });
      result.nativeManifestEntities = nativeManifest.entities;
      result.nativeManifestLinks = nativeManifest.links;
      result.nativeManifestLimsEntities = nativeManifest.limsEntities;
      result.nativeManifestEvents = nativeManifest.events;
      result.nativeManifestProviderBindings = nativeManifest.providerBindings;
    } catch (error) {
      result.errors.push({
        path: rootPath,
        message: `Native workspace catalog reconstruction failed after discovery: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }
  signal?.throwIfAborted();
  const primerResult = await reconcilePrimerArtifactsInWorkspace(rootPath, {
    signal,
    candidatePaths: result.primerArtifactCandidatePaths,
    acceptedPaths: options.acceptedPaths,
    mutationToken: options.mutationToken,
  });
  signal?.throwIfAborted();
  result.primerArtifactsDiscovered = primerResult.discovered;
  result.primerArtifactsReconciled = primerResult.reconciled;
  result.primerArtifactErrors = primerResult.errors;
  result.errors.push(...primerResult.errors);
  reportEntityMigrationIssues(rootPath, result);
  if (options.strict && result.errors.length > 0) {
    throw new Error(
      `Workspace reconciliation failed for ${result.errors.length} item(s): ${result.errors
        .slice(0, 3)
        .map((error) => `${error.path}: ${error.message}`)
        .join('; ')}`
    );
  }
  return result;
}

const EXCLUDED_DIRS = new Set(['.git', 'node_modules']);
const MAX_FILES = 10000;
const MAX_DEPTH = 40;

type PendingRegistryFile = Readonly<{
  path: string;
  fileKind: string;
  entityType: CatalogEntityType;
  contentHash: string | null;
  sizeBytes: number;
  modifiedAt: number;
}>;

function emptyWorkspaceReconcileResult(): WorkspaceReconcileResult {
  return {
    scanned: 0,
    visibleFileCount: 0,
    registered: 0,
    repaired: 0,
    missing: 0,
    externalMovesRelinked: 0,
    externalMovesAmbiguous: 0,
    primerArtifactsDiscovered: 0,
    primerArtifactsReconciled: 0,
    primerArtifactErrors: [],
    errors: [],
  };
}

function pathName(path: string): string {
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return separator >= 0 ? path.slice(separator + 1) : path;
}

function isHidden(name: string): boolean {
  return name.startsWith('.');
}

function entityTypeForKind(fileKind: string, path: string): CatalogEntityType | null {
  if (fileKind === 'dnaforge-table') return 'file';
  if (fileKind === 'fasta' && getTabTypeForFile(path) === 'protein') return 'protein';
  if (['genbank', 'fasta', 'fastq'].includes(fileKind)) return 'sequence';
  if (fileKind === 'alignment') return 'alignment';
  if (fileKind === 'trace') return 'trace';
  if (fileKind === 'waypoint-notebook') return 'notebook';
  if (fileKind === 'waypoint-protocol') return 'protocol';
  if (fileKind === 'waypoint-protocol-run') return 'protocol_run';
  if (fileKind === 'waypoint-design') return 'design';
  if (fileKind === 'waypoint-residue-selection') return 'selection';
  if (['pdb', 'mmcif', 'binary-cif'].includes(fileKind)) return 'structure';
  return null;
}

async function existingFileEntityType(
  fileKind: string,
  path: string,
  knownFile: DBCatalogEntityFile | undefined,
  nativeBinding: NativeWorkspaceManifestFileBinding | undefined
): Promise<CatalogEntityType | null> {
  const inferred = entityTypeForKind(fileKind, path);
  if (fileKind !== 'fasta' || !knownFile) return inferred;
  if (nativeBinding?.entityId === knownFile.entity_id) return nativeBinding.type;
  const current = await getCatalogEntity(knownFile.entity_id);
  return current?.type === 'protein' || current?.type === 'sequence' ? current.type : inferred;
}

async function reconcileWorkspaceProjection(
  rootPath: string,
  discovery: WorkspaceArtifactDiscoveryResult,
  signal?: AbortSignal,
  mutationToken?: string,
  nativeFileBindings: ReadonlyArray<NativeWorkspaceManifestFileBinding> = [],
  acceptedPaths: readonly string[] = []
): Promise<WorkspaceReconcileResult> {
  const projection = discovery.catalogProjection;
  if (!projection) throw new Error('workspace catalog projection is missing');
  const result = emptyWorkspaceReconcileResult();
  result.scanned = projection.scannedFileCount;
  result.visibleFileCount = projection.visibleFileCount;
  const currentRegistryFiles: CurrentRegistryFile[] = [];
  const pendingRegistryFiles: PendingRegistryFile[] = [];
  const knownByPath = new Map(
    (await getCatalogFilesUnderPath(rootPath)).map((file) => [file.path, file])
  );
  const nativeByPath = new Map(nativeFileBindings.map((binding) => [binding.path, binding]));
  const accepted = new Set(acceptedPaths);

  for (const metaPath of discovery.entityArtifactPaths) {
    if (accepted.has(metaPath)) continue;
    if (!isSequencePackageMetaPath(metaPath)) continue;
    try {
      await reconcileSequencePackageCatalogEntity({
        metaPath,
        workspaceRoot: rootPath,
        mutationToken,
      });
      result.registered += 1;
    } catch (error) {
      result.errors.push({
        path: metaPath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (let index = 0; index < projection.candidates.length; index += 1) {
    await cooperateWithRendererInteraction(index, { signal });
    signal?.throwIfAborted();
    const candidate: WorkspaceCatalogCandidate = projection.candidates[index];
    if (accepted.has(candidate.path)) continue;
    try {
      const entityType = await existingFileEntityType(
        candidate.fileKind,
        candidate.path,
        knownByPath.get(candidate.path),
        nativeByPath.get(candidate.path)
      );
      if (!entityType) continue;
      if (candidate.fileKind === 'waypoint-notebook' || candidate.fileKind === 'waypoint-design') {
        const resolved = await resolveArtifactFile({
          path: candidate.path,
          workspaceRoot: rootPath,
          mutationToken,
        });
        result.registered += 1;
        if (resolved.repaired) result.repaired += 1;
        continue;
      }
      if (candidate.fileKind === 'waypoint-residue-selection') {
        const resolved = await resolveSavedResidueSelectionArtifact({
          path: candidate.path,
          workspaceRoot: rootPath,
          mutationToken,
        });
        result.registered += 1;
        if (resolved.repaired) result.repaired += 1;
        continue;
      }
      if (
        candidate.fileKind === 'waypoint-protocol' ||
        candidate.fileKind === 'waypoint-protocol-run'
      ) {
        await reconcileNativeScientificPackage({
          path: candidate.path,
          workspaceRoot: rootPath,
          contentHash: candidate.contentHash,
          sizeBytes: candidate.sizeBytes,
          modifiedAt: candidate.modifiedAt,
          discoveredFrom: 'workspace-reconcile',
          mutationToken: mutationToken,
        });
        result.registered += 1;
        continue;
      }
      if (isTextSequenceFileKind(candidate.fileKind)) {
        currentRegistryFiles.push({ path: candidate.path, contentHash: candidate.contentHash });
        pendingRegistryFiles.push({
          path: candidate.path,
          fileKind: candidate.fileKind,
          entityType,
          contentHash: candidate.contentHash,
          sizeBytes: candidate.sizeBytes,
          modifiedAt: candidate.modifiedAt,
        });
        continue;
      }
      await registerWorkspaceFile({
        path: candidate.path,
        name: pathName(candidate.path),
        entityType,
        fileKind: candidate.fileKind,
        workspaceRoot: rootPath,
        sizeBytes: candidate.sizeBytes,
        modifiedAt: candidate.modifiedAt,
        metadata: { discoveredFrom: 'workspace-main-projection' },
        mutationToken: mutationToken,
      });
      result.registered += 1;
    } catch (error) {
      result.errors.push({
        path: candidate.path,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const moveResult = await applyExternalMovesForRoot(rootPath, currentRegistryFiles, mutationToken);
  signal?.throwIfAborted();
  result.externalMovesRelinked = moveResult.relinked;
  result.externalMovesAmbiguous = moveResult.ambiguous;
  result.errors.push(
    ...moveResult.errors.map((error) => ({
      path: error.newPath,
      message: error.message,
    }))
  );

  for (let index = 0; index < pendingRegistryFiles.length; index += 1) {
    await cooperateWithRendererInteraction(index, { signal });
    signal?.throwIfAborted();
    const file = pendingRegistryFiles[index];
    try {
      await registerWorkspaceFile({
        path: file.path,
        name: pathName(file.path),
        entityType: file.entityType,
        fileKind: file.fileKind,
        workspaceRoot: rootPath,
        contentHash: file.contentHash,
        sizeBytes: file.sizeBytes,
        modifiedAt: file.modifiedAt,
        metadata: { discoveredFrom: 'workspace-main-projection' },
        mutationToken: mutationToken,
      });
      result.registered += 1;
    } catch (error) {
      result.errors.push({
        path: file.path,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (let index = 0; index < projection.missingPaths.length; index += 1) {
    if (accepted.has(projection.missingPaths[index])) continue;
    await cooperateWithRendererInteraction(index, { signal });
    signal?.throwIfAborted();
    await markCatalogFileMissing(projection.missingPaths[index], 'workspace-reconcile');
    result.missing += 1;
  }
  return result;
}

async function reconcileWorkspaceRootByFsWalk(
  rootPath: string,
  signal?: AbortSignal,
  mutationToken?: string,
  nativeFileBindings: ReadonlyArray<NativeWorkspaceManifestFileBinding> = [],
  acceptedPaths: readonly string[] = []
): Promise<WorkspaceReconcileResult> {
  signal?.throwIfAborted();
  const result: WorkspaceReconcileResult = {
    scanned: 0,
    visibleFileCount: 0,
    registered: 0,
    repaired: 0,
    missing: 0,
    externalMovesRelinked: 0,
    externalMovesAmbiguous: 0,
    primerArtifactsDiscovered: 0,
    primerArtifactsReconciled: 0,
    primerArtifactErrors: [],
    errors: [],
  };
  const seen = new Set<string>(acceptedPaths);
  const accepted = new Set(acceptedPaths);

  seen.add(rootPath);
  const knownBeforeScan = await getCatalogFilesUnderPath(rootPath);
  signal?.throwIfAborted();
  const knownByPath = new Map<string, DBCatalogEntityFile>(
    knownBeforeScan.map((file) => [file.path, file])
  );
  const nativeByPath = new Map(nativeFileBindings.map((binding) => [binding.path, binding]));
  const currentRegistryFiles: CurrentRegistryFile[] = [];
  const pendingRegistryFiles: PendingRegistryFile[] = [];

  async function reconcileScannedDirectory(args: {
    entry: { name: string; isDirectory: boolean; isFile: boolean };
    entryPath: string;
    dirPath: string;
    depth: number;
    sequencePackageRoot: string | null;
    scanDirectory: (
      dirPath: string,
      depth: number,
      sequencePackageRoot?: string | null
    ) => Promise<void>;
  }): Promise<void> {
    const { entry, entryPath, dirPath, depth, sequencePackageRoot, scanDirectory } = args;
    if (EXCLUDED_DIRS.has(entry.name)) return;
    if (
      entry.name === 'original' &&
      (await platform().fs.exists(dirPath + '/' + SOURCE_DOCUMENT_MARKER_PATH))
    )
      return;
    const metaPath = `${entryPath}/${NOTEBOOK_PACKAGE_MARKER_DIR}/${NOTEBOOK_PACKAGE_META_NAME}`;
    let isNotebookPackage = false;
    try {
      isNotebookPackage = await platform().fs.exists(metaPath);
    } catch {
      isNotebookPackage = false;
    }
    if (isNotebookPackage) {
      result.scanned++;
      result.visibleFileCount = (result.visibleFileCount ?? 0) + 1;
      seen.add(entryPath);
      try {
        const resolved = await resolveArtifactFile({
          path: entryPath,
          workspaceRoot: rootPath,
          mutationToken,
        });
        result.registered++;
        if (resolved.repaired) result.repaired++;
      } catch (err) {
        result.errors.push({
          path: entryPath,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
    const scientificPackage = await findScientificPackageMetaPath(entryPath);
    if (scientificPackage) {
      result.scanned++;
      result.visibleFileCount = (result.visibleFileCount ?? 0) + 1;
      seen.add(scientificPackage.path);
      try {
        const stat = await platform().fs.stat(scientificPackage.path);
        await reconcileNativeScientificPackage({
          path: scientificPackage.path,
          workspaceRoot: rootPath,
          sizeBytes: stat.size,
          modifiedAt: stat.mtime,
          discoveredFrom: 'workspace-reconcile',
          mutationToken: mutationToken,
        });
        result.registered++;
      } catch (err) {
        result.errors.push({
          path: scientificPackage.path,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
    let sequencePackageMetaPath: string | null = null;
    try {
      for (const metaName of SEQUENCE_PACKAGE_META_ALIASES) {
        const candidateMetaPath = `${entryPath}/${NOTEBOOK_PACKAGE_MARKER_DIR}/${metaName}`;
        if (await platform().fs.exists(candidateMetaPath)) {
          sequencePackageMetaPath = candidateMetaPath;
          break;
        }
      }
    } catch {
      sequencePackageMetaPath = null;
    }
    if (sequencePackageMetaPath) {
      result.scanned++;
      result.visibleFileCount = (result.visibleFileCount ?? 0) + 1;
      seen.add(entryPath);
      const fs = platform().fs;
      try {
        await loadSequencePackageDocument(
          entryPath,
          {
            exists: fs.exists,
            readTextFile: fs.readTextFile,
            writeTextFile: fs.writeTextFile,
            writeWorkspaceTextFileAtomic: fs.writeWorkspaceTextFileAtomic,
            mkdir: fs.mkdir,
            move: fs.move,
            readFile: fs.readFile,
            rename: fs.rename,
          },
          rootPath
        );
      } catch (err) {
        result.errors.push({
          path: sequencePackageMetaPath,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      try {
        await reconcileSequencePackageCatalogEntity({
          metaPath: sequencePackageMetaPath,
          workspaceRoot: rootPath,
          mutationToken: mutationToken,
        });
        result.registered++;
      } catch (err) {
        result.errors.push({
          path: sequencePackageMetaPath,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      await scanDirectory(entryPath, depth + 1, entryPath);
      return;
    }
    if (sequencePackageRoot === null) {
      seen.add(entryPath);
      try {
        await registerWorkspaceFile({
          path: entryPath,
          name: entry.name,
          entityType: 'folder',
          fileKind: 'folder',
          workspaceRoot: rootPath,
          metadata: {
            discoveredFrom: 'workspace-reconcile',
            parentPath: dirPath,
          },
          mutationToken: mutationToken,
        });
        result.registered++;
      } catch (err) {
        result.errors.push({
          path: entryPath,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    await scanDirectory(entryPath, depth + 1, sequencePackageRoot);
  }

  async function scanDirectory(
    dirPath: string,
    depth: number,
    sequencePackageRoot: string | null = null
  ): Promise<void> {
    signal?.throwIfAborted();
    if (depth > MAX_DEPTH || result.scanned >= MAX_FILES) return;

    let entries: Array<{ name: string; isDirectory: boolean; isFile: boolean }>;
    try {
      entries = await platform().fs.readDir(dirPath);
    } catch (err) {
      result.errors.push({
        path: dirPath,
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (!Array.isArray(entries)) return;

    for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
      await cooperateWithRendererInteraction(entryIndex, { signal });
      signal?.throwIfAborted();
      const entry = entries[entryIndex];
      if (result.scanned >= MAX_FILES) return;
      if (isHidden(entry.name)) continue;

      const entryPath = `${dirPath}/${entry.name}`;
      if (accepted.has(entryPath)) continue;
      if (entry.isDirectory) {
        await reconcileScannedDirectory({
          entry,
          entryPath,
          dirPath,
          depth,
          sequencePackageRoot,
          scanDirectory,
        });
        continue;
      }
      if (!entry.isFile) continue;
      if (sequencePackageRoot !== null) continue;

      const resolvedPath = entryPath;

      result.scanned++;
      if (!entry.name.toLowerCase().endsWith('.waypoint.json')) {
        result.visibleFileCount = (result.visibleFileCount ?? 0) + 1;
      }
      seen.add(resolvedPath);
      const fileKind = inferCatalogFileKind(resolvedPath);
      try {
        const entityType = await existingFileEntityType(
          fileKind,
          resolvedPath,
          knownByPath.get(resolvedPath),
          nativeByPath.get(resolvedPath)
        );
        if (!entityType) continue;
        if (fileKind === 'waypoint-notebook' || fileKind === 'waypoint-design') {
          const resolved = await resolveArtifactFile({
            path: resolvedPath,
            workspaceRoot: rootPath,
            mutationToken,
          });
          result.registered++;
          if (resolved.repaired) result.repaired++;
          continue;
        }
        if (fileKind === 'waypoint-residue-selection') {
          const resolved = await resolveSavedResidueSelectionArtifact({
            path: resolvedPath,
            workspaceRoot: rootPath,
            mutationToken,
          });
          result.registered++;
          if (resolved.repaired) result.repaired++;
          continue;
        }

        const stat = await platform().fs.stat(resolvedPath);
        let contentHash: string | null = null;
        if (isTextSequenceFileKind(fileKind)) {
          const known = knownByPath.get(resolvedPath) ?? knownByPath.get(entryPath);
          if (
            known?.content_hash &&
            known.size_bytes === stat.size &&
            known.modified_at === stat.mtime
          ) {
            contentHash = known.content_hash;
          } else if (stat.size <= HARD_CAP_BYTES) {
            try {
              contentHash = await platform().fs.sha256File(resolvedPath);
            } catch {}
          }
          currentRegistryFiles.push({ path: resolvedPath, contentHash });

          pendingRegistryFiles.push({
            path: resolvedPath,
            fileKind,
            entityType,
            contentHash,
            sizeBytes: stat.size,
            modifiedAt: stat.mtime,
          });
          continue;
        }

        await registerWorkspaceFile({
          path: resolvedPath,
          name: pathName(resolvedPath),
          entityType,
          fileKind,
          workspaceRoot: rootPath,
          sizeBytes: stat.size,
          modifiedAt: stat.mtime,
          metadata: {
            discoveredFrom: 'workspace-reconcile',
          },
          mutationToken: mutationToken,
        });
        result.registered++;
      } catch (err) {
        result.errors.push({
          path: resolvedPath,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  let rootIsNotebookPackage = false;
  try {
    rootIsNotebookPackage = await platform().fs.exists(
      `${rootPath}/${NOTEBOOK_PACKAGE_MARKER_DIR}/${NOTEBOOK_PACKAGE_META_NAME}`
    );
  } catch {
    rootIsNotebookPackage = false;
  }

  if (rootIsNotebookPackage) {
    result.scanned++;
    seen.add(rootPath);
    try {
      const resolved = await resolveArtifactFile({
        path: rootPath,
        workspaceRoot: rootPath,
        mutationToken,
      });
      result.registered++;
      if (resolved.repaired) result.repaired++;
    } catch (err) {
      result.errors.push({
        path: rootPath,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const rootScientificPackage = rootIsNotebookPackage
    ? null
    : await findScientificPackageMetaPath(rootPath);
  if (rootScientificPackage) {
    result.scanned++;
    result.visibleFileCount = (result.visibleFileCount ?? 0) + 1;
    seen.add(rootScientificPackage.path);
    try {
      const stat = await platform().fs.stat(rootScientificPackage.path);
      await reconcileNativeScientificPackage({
        path: rootScientificPackage.path,
        workspaceRoot: rootPath,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime,
        discoveredFrom: 'workspace-reconcile',
        mutationToken: mutationToken,
      });
      result.registered++;
    } catch (err) {
      result.errors.push({
        path: rootScientificPackage.path,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let rootSequencePackageMetaPath: string | null = null;
  if (!rootIsNotebookPackage && !rootScientificPackage) {
    try {
      for (const metaName of SEQUENCE_PACKAGE_META_ALIASES) {
        const candidateMetaPath = `${rootPath}/${NOTEBOOK_PACKAGE_MARKER_DIR}/${metaName}`;
        if (await platform().fs.exists(candidateMetaPath)) {
          rootSequencePackageMetaPath = candidateMetaPath;
          break;
        }
      }
    } catch {
      rootSequencePackageMetaPath = null;
    }
    if (rootSequencePackageMetaPath) {
      result.scanned++;
      result.visibleFileCount = (result.visibleFileCount ?? 0) + 1;
      seen.add(rootPath);
      try {
        await reconcileSequencePackageCatalogEntity({
          metaPath: rootSequencePackageMetaPath,
          workspaceRoot: rootPath,
          mutationToken: mutationToken,
        });
        result.registered++;
      } catch (err) {
        result.errors.push({
          path: rootSequencePackageMetaPath,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    await scanDirectory(rootPath, 0, rootSequencePackageMetaPath ? rootPath : null);
  }

  const moveResult = await applyExternalMovesForRoot(rootPath, currentRegistryFiles, mutationToken);
  signal?.throwIfAborted();
  result.externalMovesRelinked = moveResult.relinked;
  result.externalMovesAmbiguous = moveResult.ambiguous;
  result.errors.push(...moveResult.errors.map((e) => ({ path: e.newPath, message: e.message })));
  for (const file of pendingRegistryFiles) {
    signal?.throwIfAborted();
    try {
      await registerWorkspaceFile({
        path: file.path,
        name: pathName(file.path),
        entityType: file.entityType,
        fileKind: file.fileKind,
        workspaceRoot: rootPath,
        contentHash: file.contentHash,
        sizeBytes: file.sizeBytes,
        modifiedAt: file.modifiedAt,
        metadata: {
          discoveredFrom: 'workspace-reconcile',
        },
        mutationToken: mutationToken,
      });
      result.registered++;
    } catch (err) {
      result.errors.push({
        path: file.path,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  signal?.throwIfAborted();
  for (const file of knownBeforeScan) {
    signal?.throwIfAborted();
    if (file.status === 'historical') continue;
    if (!seen.has(file.path)) {
      if (
        file.file_kind === 'folder' &&
        (await platform()
          .fs.exists(file.path)
          .catch(() => false))
      ) {
        continue;
      }
      await markCatalogFileMissing(file.path, 'workspace-reconcile');
      result.missing++;
    }
  }

  return result;
}

async function findScientificPackageMetaPath(packageRoot: string): Promise<{
  path: string;
  fileKind: 'waypoint-protocol' | 'waypoint-protocol-run';
  entityType: 'protocol' | 'protocol_run';
} | null> {
  const candidates = [
    {
      name: PROTOCOL_PACKAGE_META_NAME,
      fileKind: 'waypoint-protocol' as const,
      entityType: 'protocol' as const,
    },
    {
      name: PROTOCOL_RUN_PACKAGE_META_NAME,
      fileKind: 'waypoint-protocol-run' as const,
      entityType: 'protocol_run' as const,
    },
  ];
  for (const candidate of candidates) {
    const path = `${packageRoot}/${NOTEBOOK_PACKAGE_MARKER_DIR}/${candidate.name}`;
    try {
      if (await platform().fs.exists(path)) return { path, ...candidate };
    } catch {}
  }
  return null;
}
