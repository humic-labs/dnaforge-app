import { platform } from '../platform';
import type { ManagedSequenceDocumentRef } from '../shared/managed-sequence-document';
import { pathRelativeToBoundary } from '../shared/path-boundary';
import { parseSequencePackageDocument, sequencePackagePaths } from './sequence-package';
import { locateSequencePackageMetaPath } from './sequence-package-io';

export async function readBoundSequenceProduct(
  binding: ManagedSequenceDocumentRef,
  workspaceRoot: string
): Promise<{ name: string; path: string } | null> {
  if (pathRelativeToBoundary(binding.packageRoot, workspaceRoot) === null) return null;
  const fs = platform().fs;
  const marker = await locateSequencePackageMetaPath(binding.packageRoot, (path) =>
    fs.exists(path)
  );
  if (
    !marker ||
    !(await fs.validateWorkspacePath({ workspaceRoot, path: marker, artifactNoun: 'reference' }))
  )
    return null;
  const document = parseSequencePackageDocument(await fs.readTextFile(marker));
  if (document.id !== binding.packageId) return null;
  const product = sequencePackagePaths(binding.packageRoot, { productFile: document.product.file });
  const path = pathRelativeToBoundary(product.productPath, workspaceRoot);
  if (
    !path ||
    !(await fs.validateWorkspacePath({
      workspaceRoot,
      path: product.productPath,
      artifactNoun: 'reference',
    }))
  )
    return null;
  return { name: document.product.file, path };
}
