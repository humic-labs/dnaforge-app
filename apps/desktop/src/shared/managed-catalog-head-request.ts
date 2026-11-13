import type { ManagedCatalogHeadIndexRequest } from './workspace-git-types';

export const MAX_MANAGED_CATALOG_PRESERVE_PATHS = 10_000;
export const MAX_MANAGED_CATALOG_REL_PATH_LENGTH = 4_096;

export function validateManagedCatalogHeadIndexRequest(
  request: ManagedCatalogHeadIndexRequest
): void {
  if (!Array.isArray(request.preserveRelPaths)) {
    throw new Error('MANAGED_CATALOG_PRESERVE_PATHS_INVALID');
  }
  if (request.preserveRelPaths.length > MAX_MANAGED_CATALOG_PRESERVE_PATHS) {
    throw new Error('MANAGED_CATALOG_PRESERVE_PATHS_LIMIT');
  }
  for (const relPath of request.preserveRelPaths) {
    if (
      typeof relPath !== 'string' ||
      relPath.length === 0 ||
      relPath.length > MAX_MANAGED_CATALOG_REL_PATH_LENGTH ||
      relPath.includes('\0') ||
      relPath.includes('\\') ||
      relPath.startsWith('/') ||
      relPath.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
    ) {
      throw new Error('MANAGED_CATALOG_PRESERVE_PATH_INVALID');
    }
  }
}
