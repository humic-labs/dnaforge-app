import { platform } from '../platform';
import { resolveArtifactFile } from '../db/workspace-artifacts';
import {
  getCatalogFilesUnderPath,
  getCatalogEntity,
  inferCatalogFileKind,
  markCatalogFileMissing,
  registerWorkspaceFile,
  refreshCurrentCatalogFileFingerprints,
  type CurrentCatalogFileFingerprint,
} from '../db/workspace-catalog';
import type { ManagedCatalogHeadIndex, ManagedHeadFile } from '../shared/workspace-git-types';
import type { WorkspaceReconcileResult } from './workspace-reconcile-result';
import { resolveSavedResidueSelectionArtifact } from '../db/saved-residue-selection-artifact';
import { isSequencePackageMetaPath, sequencePackagePaths } from '../db/sequence-package';
import type { ManagedSequenceDocumentRef } from '../shared/managed-sequence-document';
import { isNotebookPackageMetaPath } from '../db/notebook-package';
import { applyExternalMovesForRoot, type CurrentRegistryFile } from './external-move-reconcile';
import {
  cooperateWithRendererInteraction,
  rendererInteractionCooperationIfNeeded,
} from '../lib/renderer-interaction-activity';
import { pathRelativeToBoundary } from '../shared/path-boundary';
import {
  isManagedEntityArtifactPath,
  isManagedPrimerArtifactPath,
  isTextSequenceFileKind,
} from '../shared/catalog-file-kind';
import { reconcileNativeScientificPackage } from './native-scientific-package-reconcile';
import { reconcileSequencePackageCatalogEntity } from './sequence-package-catalog-reconcile';
import type { NativeWorkspaceManifestFileBinding } from './native-workspace-manifest-reconcile';
import { getTabTypeForFile } from '../utils/fileTypes';

export type ManagedHeadReader = (
  repoPath: string,
  preserveRelPaths: readonly string[]
) => Promise<ManagedCatalogHeadIndex>;

async function collectPlasmidPackages(
  files: readonly ManagedHeadFile[],
  cooperate: () => Promise<void> | null
): Promise<Map<string, string>> {
  const packages = new Map<string, string>();
  for (const file of files) {
    const cooperation = cooperate();
    if (cooperation) await cooperation;
    const { relPath } = file;
    const normalized = relPath.replace(/\\/g, '/');
    if (!isSequencePackageMetaPath(normalized)) continue;
    const segments = normalized.split('/');
    if (segments.length < 2) continue;
    packages.set(segments.slice(0, -2).join('/'), normalized);
  }
  return packages;
}

async function collectNotebookPackageRoots(
  files: readonly ManagedHeadFile[],
  cooperate: () => Promise<void> | null
): Promise<Set<string>> {
  const roots = new Set<string>();
  for (const file of files) {
    const cooperation = cooperate();
    if (cooperation) await cooperation;
    const { relPath } = file;
    const normalized = relPath.replace(/\\/g, '/');
    if (!isNotebookPackageMetaPath(normalized)) continue;
    const segments = normalized.split('/');
    if (segments.length < 2) continue;
    roots.add(segments.slice(0, -2).join('/'));
  }
  return roots;
}

function innermostContainingPackageRoot(
  normalizedRelPath: string,
  roots: ReadonlySet<string>
): string | null {
  if (roots.has(normalizedRelPath)) return normalizedRelPath;
  let separator = normalizedRelPath.lastIndexOf('/');
  while (separator >= 0) {
    const ancestor = normalizedRelPath.slice(0, separator);
    if (roots.has(ancestor)) return ancestor;
    separator = ancestor.lastIndexOf('/');
  }
  return roots.has('') ? '' : null;
}

function isInsidePackageRoot(normalizedRelPath: string, roots: ReadonlySet<string>): boolean {
  return innermostContainingPackageRoot(normalizedRelPath, roots) !== null;
}

const STRUCTURE_FILE_KINDS = new Set(['pdb', 'mmcif', 'binary-cif']);

function pathName(relPath: string): string {
  return relPath.split('/').filter(Boolean).pop() ?? relPath;
}

function joinRepoPath(repoPath: string, relPath: string): string {
  return `${repoPath.replace(/\/+$/, '')}/${relPath}`;
}

export function sequencePackageContentHash(
  files: readonly ManagedHeadFile[],
  packageRoot: string,
  metaRelPath: string
): string {
  const prefix = packageRoot === '' ? '' : `${packageRoot}/`;
  const members = files
    .map((file) => ({ relPath: file.relPath.replace(/\\/g, '/'), oid: file.oid }))
    .filter(
      ({ relPath }) =>
        relPath === metaRelPath ||
        (relPath.startsWith(prefix) && !relPath.slice(prefix.length).includes('/'))
    )
    .map(({ relPath, oid }) => `${relPath.slice(prefix.length)}@${oid}`)
    .sort();
  return `git-package:${members.join(',')}`;
}

export async function indexWorkspaceHeadIntoCatalog(
  repoPath: string,
  readHead: ManagedHeadReader,
  options: {
    signal?: AbortSignal;
    mutationToken?: string;
    nativeSequenceBindings?: ReadonlyArray<{ path: string; entityId: string }>;
    nativeFileBindings?: ReadonlyArray<NativeWorkspaceManifestFileBinding>;
    pendingSequenceDocument?: ManagedSequenceDocumentRef;
    acceptedPaths?: readonly string[];
    acceptedResourceIds?: readonly string[];
  } = {}
): Promise<WorkspaceReconcileResult> {
  const { signal } = options;
  let scanWorkUnits = 1;
  const cooperate = (): Promise<void> | null => {
    signal?.throwIfAborted();
    scanWorkUnits++;
    return rendererInteractionCooperationIfNeeded(scanWorkUnits, { signal });
  };
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
  const seen = new Set<string>();

  const knownBeforeHeadRead = await getCatalogFilesUnderPath(repoPath);
  const acceptedPaths = new Set(options.acceptedPaths ?? []);
  const acceptedIds = new Set(options.acceptedResourceIds ?? []);
  for (const path of acceptedPaths) seen.add(path);
  for (const file of knownBeforeHeadRead) if (acceptedIds.has(file.entity_id)) seen.add(file.path);
  const knownByPath = new Map(knownBeforeHeadRead.map((file) => [file.path, file]));
  const nativeByPath = new Map(
    options.nativeSequenceBindings?.map((binding) => [binding.path, binding.entityId])
  );
  const checkedFilesByPath = new Map(
    options.nativeFileBindings?.map((binding) => [binding.path, binding])
  );
  const nativeFingerprints: CurrentCatalogFileFingerprint[] = [];
  const preserveRelPaths = knownBeforeHeadRead
    .map((file) => pathRelativeToBoundary(file.path, repoPath))
    .filter((path): path is string => path !== null && path !== '');
  const { files, scannedFileCount, visibleFileCount, healedFileCount, migrationIssues } =
    await readHead(repoPath, preserveRelPaths);
  result.scanned = scannedFileCount;
  result.visibleFileCount = visibleFileCount;
  result.healedFileCount = healedFileCount ?? 0;
  result.migrationIssues = migrationIssues ?? [];
  result.errors.push(
    ...result.migrationIssues.map(({ path, reason }) => ({ path, message: reason }))
  );
  signal?.throwIfAborted();
  await cooperateWithRendererInteraction(scanWorkUnits, { signal });
  const notebookPackageRoots = await collectNotebookPackageRoots(files, cooperate);
  const plasmidPackages = new Map(
    [...(await collectPlasmidPackages(files, cooperate))].filter(
      ([root]) => !isInsidePackageRoot(root, notebookPackageRoots)
    )
  );
  const pending = options.pendingSequenceDocument;
  let pendingMetaPath: string | undefined;
  if (pending) {
    const relativeRoot = pathRelativeToBoundary(pending.packageRoot, repoPath);
    if (
      !options.mutationToken ||
      relativeRoot === null ||
      isInsidePackageRoot(relativeRoot, notebookPackageRoots)
    ) {
      throw new Error(
        'Pending sequence reconstruction requires its owning project lease and path.'
      );
    }

    pendingMetaPath = sequencePackagePaths(pending.packageRoot).metaPath;
    const relativeMetaPath = pathRelativeToBoundary(pendingMetaPath, repoPath);
    if (relativeMetaPath === null)
      throw new Error('Pending sequence marker is outside its project.');
    plasmidPackages.set(relativeRoot, relativeMetaPath);
  }
  const plasmidPackageRoots = new Set(plasmidPackages.keys());
  const filePlans: Array<{
    file: ManagedHeadFile;
    normalizedRelPath: string;
    kind: string;
    insideNotebookPackage: boolean;
    insidePlasmidPackage: boolean;
  }> = [];
  const primerArtifactCandidatePaths: string[] = [];
  const entityArtifactCandidatePaths: string[] = [];
  for (const file of files) {
    const cooperation = cooperate();
    if (cooperation) await cooperation;
    const normalizedRelPath = file.relPath.replace(/\\/g, '/');
    const kind = inferCatalogFileKind(normalizedRelPath);
    if (isManagedPrimerArtifactPath(normalizedRelPath)) {
      primerArtifactCandidatePaths.push(joinRepoPath(repoPath, normalizedRelPath));
    }
    if (isManagedEntityArtifactPath(normalizedRelPath, kind)) {
      entityArtifactCandidatePaths.push(joinRepoPath(repoPath, normalizedRelPath));
    }
    filePlans.push({
      file,
      normalizedRelPath,
      kind,
      insideNotebookPackage: isInsidePackageRoot(normalizedRelPath, notebookPackageRoots),
      insidePlasmidPackage: isInsidePackageRoot(normalizedRelPath, plasmidPackageRoots),
    });
  }
  result.primerArtifactCandidatePaths = primerArtifactCandidatePaths;
  if (pendingMetaPath && !entityArtifactCandidatePaths.includes(pendingMetaPath)) {
    entityArtifactCandidatePaths.push(pendingMetaPath);
  }
  result.entityArtifactCandidatePaths = entityArtifactCandidatePaths;

  const movableForDetect: CurrentRegistryFile[] = [];
  for (const plan of filePlans) {
    const cooperation = cooperate();
    if (cooperation) await cooperation;
    if (plan.insideNotebookPackage) continue;
    if (plan.insidePlasmidPackage) continue;
    if (acceptedPaths.has(joinRepoPath(repoPath, plan.file.relPath))) continue;
    const { file, kind } = plan;
    if (
      isTextSequenceFileKind(kind) ||
      STRUCTURE_FILE_KINDS.has(kind) ||
      kind === 'waypoint-residue-selection'
    ) {
      movableForDetect.push({
        path: joinRepoPath(repoPath, file.relPath),
        contentHash: `git:${file.oid}`,
      });
    }
  }
  const moveResult = await applyExternalMovesForRoot(
    repoPath,
    movableForDetect,
    options.mutationToken
  );
  result.externalMovesRelinked = moveResult.relinked;
  result.externalMovesAmbiguous = moveResult.ambiguous;
  result.errors.push(...moveResult.errors.map((e) => ({ path: e.newPath, message: e.message })));

  for (const packageRoot of notebookPackageRoots) {
    seen.add(
      packageRoot === '' ? repoPath.replace(/\/+$/, '') : joinRepoPath(repoPath, packageRoot)
    );
  }
  for (const [packageRoot, metaRelPath] of plasmidPackages) {
    const absoluteRoot =
      packageRoot === '' ? repoPath.replace(/\/+$/, '') : joinRepoPath(repoPath, packageRoot);
    seen.add(absoluteRoot);
    if (acceptedPaths.has(joinRepoPath(repoPath, metaRelPath))) continue;
    try {
      await reconcileSequencePackageCatalogEntity({
        metaPath: joinRepoPath(repoPath, metaRelPath),
        workspaceRoot: repoPath,
        mutationToken: options.mutationToken,
        ...(pending && joinRepoPath(repoPath, metaRelPath) === pendingMetaPath
          ? { expectedEntityId: pending.packageId }
          : {}),
        contentHash: sequencePackageContentHash(files, packageRoot, metaRelPath),
      });
      result.registered++;
    } catch (err) {
      result.errors.push({
        path: absoluteRoot,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  for (const plan of filePlans) {
    const cooperation = cooperate();
    if (cooperation) await cooperation;
    const { file } = plan;
    const absPath = joinRepoPath(repoPath, file.relPath);
    if (acceptedPaths.has(absPath) || acceptedIds.has(knownByPath.get(absPath)?.entity_id ?? ''))
      continue;
    if (plan.insideNotebookPackage) continue;
    if (plan.insidePlasmidPackage) continue;
    seen.add(absPath);
    const fileKind = plan.kind;
    if (fileKind === 'waypoint-protocol' || fileKind === 'waypoint-protocol-run') {
      try {
        await reconcileNativeScientificPackage({
          path: absPath,
          workspaceRoot: repoPath,
          contentHash: `git:${file.oid}`,
          sizeBytes: file.sizeBytes,
          modifiedAt: file.modifiedAt ?? undefined,
          discoveredFrom: 'git-indexer',
          mutationToken: options.mutationToken,
        });
        result.registered++;
      } catch (err) {
        result.errors.push({
          path: absPath,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }
    if (
      !isTextSequenceFileKind(fileKind) &&
      !STRUCTURE_FILE_KINDS.has(fileKind) &&
      fileKind !== 'waypoint-residue-selection'
    )
      continue;
    try {
      if (fileKind === 'waypoint-residue-selection') {
        const resolved = await resolveSavedResidueSelectionArtifact({
          path: absPath,
          workspaceRoot: repoPath,
          mutationToken: options.mutationToken,
        });
        result.registered++;
        if (resolved.repaired) result.repaired++;
        continue;
      }
      const known = knownByPath.get(absPath);
      if (
        isTextSequenceFileKind(fileKind) &&
        known &&
        known.workspace_id !== null &&
        known.status === 'current' &&
        known.object_uuid !== null &&
        known.file_kind === fileKind &&
        nativeByPath.get(absPath) === known.entity_id
      ) {
        nativeFingerprints.push({
          ...known,
          workspace_id: known.workspace_id,
          content_hash: `git:${file.oid}`,
          size_bytes: file.sizeBytes,
          modified_at: file.modifiedAt ?? null,
        });
        result.registered++;
        continue;
      }
      let entityType = STRUCTURE_FILE_KINDS.has(fileKind)
        ? ('structure' as const)
        : getTabTypeForFile(absPath) === 'protein'
          ? ('protein' as const)
          : ('sequence' as const);
      const knownFile = knownByPath.get(absPath);
      if (fileKind === 'fasta' && knownFile) {
        const checked = checkedFilesByPath.get(absPath);
        if (
          checked?.entityId === knownFile.entity_id &&
          (checked.type === 'protein' || checked.type === 'sequence')
        ) {
          entityType = checked.type;
        } else {
          const current = await getCatalogEntity(knownFile.entity_id);
          if (current?.type === 'protein' || current?.type === 'sequence')
            entityType = current.type;
        }
      }
      await registerWorkspaceFile({
        path: absPath,
        name: pathName(file.relPath),
        entityType,
        fileKind,
        workspaceRoot: repoPath,
        contentHash: `git:${file.oid}`,
        sizeBytes: file.sizeBytes,
        modifiedAt: file.modifiedAt ?? undefined,
        metadata: { discoveredFrom: 'git-indexer' },
        mutationToken: options.mutationToken,
      });
      result.registered++;
    } catch (err) {
      result.errors.push({
        path: absPath,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await refreshCurrentCatalogFileFingerprints(nativeFingerprints);

  for (const catalogFile of knownBeforeHeadRead) {
    const cooperation = cooperate();
    if (cooperation) await cooperation;
    if (catalogFile.status === 'historical') continue;
    if (acceptedIds.has(catalogFile.entity_id)) continue;
    if (!seen.has(catalogFile.path) && catalogFile.file_kind !== 'folder') {
      if (
        catalogFile.file_kind === 'waypoint-notebook' &&
        (await platform().fs.exists(catalogFile.path))
      ) {
        try {
          const resolved = await resolveArtifactFile({
            path: catalogFile.path,
            workspaceRoot: repoPath,
            mutationToken: options.mutationToken,
          });
          if (resolved.entity.id === catalogFile.entity_id) {
            result.registered++;
            continue;
          }
        } catch (error) {
          result.errors.push({
            path: catalogFile.path,
            message: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
      }
      await markCatalogFileMissing(catalogFile.path, 'git-indexer');
      result.missing++;
    }
  }

  return result;
}
