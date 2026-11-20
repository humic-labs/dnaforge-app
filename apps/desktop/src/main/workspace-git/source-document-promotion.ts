import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
import { QUICK_LOOK_PACKAGE_STORE_DIRECTORY } from '../../shared/file-associations';
import { SOURCE_DOCUMENT_MARKER_PATH } from '../../shared/source-document-package';
import {
  readProjectSourceDocumentPackage,
  readSourceDocumentPackage,
  writeProjectSourceDocumentCopy,
} from '../source-document-package-store';
import {
  activatePreparedQuickLookDestinationWorkspace,
  discardPreparedQuickLookDestinationWorkspace,
  importQuickLookPackageIntoWorkspaceRoot,
  prepareQuickLookDestinationWorkspace,
  type ImportFileIntoWorkspaceDeps,
} from './import';
import { findKnownWorkspaceRoot } from './known-workspace-scope';
import { assertSharedProjectContentWritable } from '../shared-project-write-access';

export async function importSourceDocumentPackage(
  storeRoot: string,
  packageId: string,
  targetRoot: string | null,
  deps: ImportFileIntoWorkspaceDeps,
  requestedName?: string,
  keepBoth = false
) {
  const snapshot = await readSourceDocumentPackage(storeRoot, packageId);
  const name =
    basename(snapshot.descriptor.sourceName, extname(snapshot.descriptor.sourceName)) ||
    'Imported document';
  const promotionJournalRoot = join(
    dirname(deps.managedRootDir),
    QUICK_LOOK_PACKAGE_STORE_DIRECTORY,
    '.promotions'
  );
  const preparation = {
    ...deps,
    preparationJournalRoot: join(promotionJournalRoot, 'workspace-preparations'),
    packagePromotionJournalRoot: promotionJournalRoot,
  };
  const owner = targetRoot ? await findKnownWorkspaceRoot(targetRoot, deps) : null;
  if (targetRoot) {
    if (!owner) throw new Error('Choose a known project destination.');
    assertSharedProjectContentWritable(deps.db, owner);
  }
  const prepared = targetRoot
    ? null
    : await prepareQuickLookDestinationWorkspace(requestedName?.trim() || name, preparation);
  const destination = targetRoot ?? prepared!.repoPath;
  let stage: string | undefined;
  try {
    stage = await mkdtemp(join(tmpdir(), 'dnaforge-project-package-'));
    const projectIdentity = createHash('sha256')
      .update(await realpath(destination))
      .update(keepBoth ? randomUUID() : '')
      .digest('hex');
    const { descriptor: source, manifest } = await writeProjectSourceDocumentCopy(
      snapshot,
      stage,
      projectIdentity
    );
    const markerHash = createHash('sha256')
      .update(await readFile(join(source.packageRoot, SOURCE_DOCUMENT_MARKER_PATH)))
      .digest('hex');
    const promoted = await importQuickLookPackageIntoWorkspaceRoot(
      {
        recordId: packageId,
        packageRoot: source.packageRoot,
        productRelativePath: relative(source.packageRoot, source.entryPath).split(sep).join('/'),
        files: [
          ...manifest.files.map((file) => ({ relativePath: file.path, sha256: file.sha256 })),
          { relativePath: SOURCE_DOCUMENT_MARKER_PATH, sha256: markerHash },
        ],
      },
      destination,
      { ...deps, promotionJournalRoot },
      { packageName: name, publicationKey: source.packageId }
    );
    const { descriptor } = await readProjectSourceDocumentPackage(destination, promoted.destPath);
    if (descriptor.packageId !== source.packageId)
      throw new Error('The imported document has a different package identity.');
    if (prepared) await activatePreparedQuickLookDestinationWorkspace(prepared, preparation);
    const workspaceRoot = owner ?? destination;
    return {
      ...promoted,
      relPath: relative(workspaceRoot, promoted.destPath),
      descriptor,
      workspaceRoot,
      createdNewWorkspace: !!prepared,
      createdWorkspaceName: prepared?.displayName ?? null,
      workspaceUuid: prepared?.workspaceUuid,
      records:
        manifest.presentation === 'sequence-package'
          ? descriptor.productPaths.map((path, index) => ({
              recordId: packageId + ':' + index,
              destPath: path,
              relPath: relative(workspaceRoot, path),
            }))
          : [],
      packageProductPaths: descriptor.productPaths,
    };
  } catch (error) {
    if (prepared) await discardPreparedQuickLookDestinationWorkspace(prepared, preparation);
    throw error;
  } finally {
    prepared?.releaseMutationBlock();
    if (stage) await rm(stage, { recursive: true, force: true });
  }
}
