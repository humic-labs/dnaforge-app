import { searchMountedCatalogEntityPage } from '../../db/catalog-reference-search';
import {
  searchWorkspace as runWorkspaceSearch,
  type WorkspaceSearchRequest,
  type WorkspaceSearchContext,
} from './search-owner';
export * from './search-owner';
export { settleCatalogSearchOpen } from './search-open-outcome';

export function searchWorkspace(
  request: WorkspaceSearchRequest,
  getContext: () => WorkspaceSearchContext,
  signal?: AbortSignal
) {
  return runWorkspaceSearch(request, getContext, searchMountedCatalogEntityPage, signal);
}
