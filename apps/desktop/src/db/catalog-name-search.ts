import { platform } from '../platform';
import { catalogNameSearch as search } from '../shared/catalog-name-search';
export { escapeLikeWildcards } from '../shared/catalog-name-search';
export function catalogNameSearch(query: string, order: 'name' | 'updated') {
  return search(
    query,
    order,
    <T>(sql: string, params: import('../shared/sqlite-ipc').SqliteIpcValue[]) =>
      platform().db.select<T>(sql, params)
  );
}
