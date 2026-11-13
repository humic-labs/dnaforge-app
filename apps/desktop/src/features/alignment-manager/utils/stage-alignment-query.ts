import {
  addSequencePackageMember,
  locateSequencePackageMetaPath,
  type SequencePackageIoFs,
} from '../../../db/sequence-package-io';
import { parseSequencePackageDocument } from '../../../db/sequence-package';
import { findWorkspaceRootForPath } from '../../../db/workspace-catalog';
import { platform } from '../../../platform';
import { resolveSequencePackageRootForProductPath } from '../../sequence/public/sequence-package-product';
import { withRendererWorkspaceMutation } from '../../../services/workspace-mutation-transaction';
import { isAlignmentQueryPath } from '../../../shared/alignment-query-extensions';
import {
  listProjectEditFolders,
  projectPathIsReadOnly,
} from '../../workspace-loader/public/project-edit-folders';
import {
  dirnameOfFilesystemPath,
  isAbsoluteFilesystemPath,
  resolveAlignmentQueryPath,
} from './alignment-query-path';

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export async function findSequencePackageRootForReference(
  referencePath: string
): Promise<string | null> {
  const parent = dirnameOfFilesystemPath(referencePath);
  if (!parent) return null;
  const metaPath = await locateSequencePackageMetaPath(parent, (path) =>
    platform().fs.exists(path)
  );
  if (!metaPath) return null;
  try {
    const doc = parseSequencePackageDocument(await platform().fs.readTextFile(metaPath));
    if (doc.product.file !== fileNameOf(referencePath)) return null;
    return parent;
  } catch {
    return null;
  }
}

export async function findAlignmentWorkspaceRoot(referencePath: string): Promise<string | null> {
  const folders = await listProjectEditFolders();
  if (projectPathIsReadOnly(referencePath, folders)) return null;
  return findWorkspaceRootForPath(folders, referencePath);
}

export async function stageAlignmentQueryPaths(
  referencePath: string,
  queryPaths: readonly string[]
): Promise<string[]> {
  const packageRoot = await findSequencePackageRootForReference(referencePath);
  if (!packageRoot) return [...queryPaths];
  const workspaceRoot = await findAlignmentWorkspaceRoot(referencePath);
  if (!workspaceRoot) return [...queryPaths];

  return withRendererWorkspaceMutation(
    packageRoot.startsWith('/hosted/') ? packageRoot : null,
    async () => {
      const staged: string[] = [];
      for (const raw of queryPaths) {
        const resolved = resolveAlignmentQueryPath(raw, referencePath);
        staged.push(await stageOneQuery(resolved, packageRoot, workspaceRoot));
      }
      return staged;
    }
  );
}

async function stageOneQuery(
  queryPath: string,
  packageRoot: string,
  workspaceRoot: string
): Promise<string> {
  if (!queryPath || !isAbsoluteFilesystemPath(queryPath)) return queryPath;
  if (queryPath.split(/[\\/]/).includes('..')) return queryPath;
  if (!isAlignmentQueryPath(queryPath)) return queryPath;
  if (await resolveSequencePackageRootForProductPath(queryPath)) return queryPath;

  const fs = platform().fs;
  if (!fs.move || !fs.writeTextFile) return queryPath;
  if (fs.stat) {
    try {
      const info = await fs.stat(queryPath);
      if (info.isDirectory || (info as { isSymbolicLink?: boolean }).isSymbolicLink === true) {
        return queryPath;
      }
    } catch {
      return queryPath;
    }
  }

  try {
    const { destPath } = await addSequencePackageMember({
      packageRoot,
      workspaceRoot,
      role: 'sequencing-read',
      sourcePath: queryPath,
      fs: {
        exists: fs.exists,
        readTextFile: fs.readTextFile,
        writeTextFile: fs.writeTextFile,
        writeWorkspaceTextFileAtomic: fs.writeWorkspaceTextFileAtomic,
        mkdir: fs.mkdir,
        move: fs.move,
        readFile: fs.readFile,
        writeFile: (fs as { writeFile?: SequencePackageIoFs['writeFile'] }).writeFile,
        rename: fs.rename,
      },
    });
    return destPath;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('MOVE_NOOP')) return queryPath;
    if (!(await fs.exists(queryPath).catch(() => false))) throw err;
    console.warn(
      '[stageAlignmentQuery] left query in place; could not add as a package member:',
      queryPath,
      message
    );
    return queryPath;
  }
}
