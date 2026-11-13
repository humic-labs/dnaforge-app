import {
  loadSequencePackageDocument,
  locateSequencePackageMetaPath,
} from '../../db/sequence-package-io';
import { platform } from '../../platform';
import { findWorkspaceRootForPath } from '../../db/workspace-catalog';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import {
  SequencePackageFormatError,
  parseSequencePackageDocument,
  sequencePackagePaths,
  resolveSequenceProductFile,
} from '../../db/sequence-package';

export async function resolveSequencePackageProductPath(packageRoot: string): Promise<string> {
  const paths = sequencePackagePaths(packageRoot);
  const fs = platform().fs;

  let recordedFile: string | undefined;
  try {
    recordedFile = (
      await loadSequencePackageDocument(
        packageRoot,
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
        findWorkspaceRootForPath(useWorkspaceStore.getState().folders, packageRoot) ?? packageRoot
      )
    ).product.file;
  } catch (err) {
    if (err instanceof SequencePackageFormatError) throw err;
    try {
      const metaPath = await locateSequencePackageMetaPath(packageRoot, (path) => fs.exists(path));
      if (metaPath) {
        recordedFile = parseSequencePackageDocument(await fs.readTextFile(metaPath)).product.file;
      }
    } catch {
      recordedFile = undefined;
    }
  }

  const entries = await fs.readDir(paths.root);
  const productFile = resolveSequenceProductFile(
    recordedFile,
    entries.map((entry) => ({ name: entry.name, isFile: !entry.isDirectory }))
  );
  return sequencePackagePaths(paths.root, { productFile }).productPath;
}

export async function resolveSequencePackageRootForProductPath(
  productPath: string
): Promise<string | null> {
  const normalized = productPath.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  if (slash <= 0) return null;
  const packageRoot = productPath.slice(0, productPath.length - normalized.length + slash);
  const metaPath = await locateSequencePackageMetaPath(packageRoot, (path) =>
    platform().fs.exists(path)
  );
  return metaPath ? packageRoot : null;
}
