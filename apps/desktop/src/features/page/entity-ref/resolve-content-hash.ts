import type { ManagedSequenceDocumentRef } from '../../../shared/managed-sequence-document';
import { pathRelativeToBoundary } from '../../../shared/path-boundary';

const SHA256_PREFIX = 'sha256:';
const SHA256_FINGERPRINT = /^sha256:[0-9a-f]{64}$/i;

export type ContentHashFn = (input: {
  workspaceRoot: string;
  workspaceRelativePath: string;
}) => Promise<string>;

export function needsRehash(catalogHash: string | null | undefined): boolean {
  return !catalogHash || !SHA256_FINGERPRINT.test(catalogHash);
}

export async function resolveReferenceContentHash({
  catalogHash,
  workspaceRoot,
  workspaceRelativePath,
  managedDocument,
  contentHash,
}: {
  catalogHash: string | null;
  workspaceRoot: string | null;
  workspaceRelativePath: string;
  managedDocument?: ManagedSequenceDocumentRef | null;
  contentHash: ContentHashFn;
}): Promise<string | null> {
  if (!needsRehash(catalogHash)) return catalogHash;
  if (!workspaceRoot) return null;

  try {
    let contentPath = workspaceRelativePath;
    if (managedDocument) {
      if (
        pathRelativeToBoundary(managedDocument.packageRoot, workspaceRoot) !== workspaceRelativePath
      )
        return null;
      const { readBoundSequenceProduct } = await import('../../../db/bound-sequence-product');
      const product = await readBoundSequenceProduct(managedDocument, workspaceRoot);
      if (!product) return null;
      contentPath = product.path;
    }
    const hashed = await contentHash({ workspaceRoot, workspaceRelativePath: contentPath });
    if (!SHA256_FINGERPRINT.test(hashed)) {
      console.error(
        `[reference] Refusing a content hash that is not ${SHA256_PREFIX}-namespaced:`,
        hashed
      );
      return null;
    }
    return hashed;
  } catch (error) {
    console.error('[reference] Failed to hash referenced file:', error);
    return null;
  }
}
