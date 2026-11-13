import type { SqliteIpcValue } from './sqlite-ipc';

export function escapeLikeWildcards(input: string): string {
  return input.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export async function catalogNameSearch(
  query: string,
  order: 'name' | 'updated',
  select: <T>(sql: string, params: SqliteIpcValue[]) => Promise<T>
): Promise<{ sql: string; params: string[]; indexSql: string }> {
  const params = [`%${escapeLikeWildcards(query)}%`];
  let sql = ` AND e.name LIKE ? ESCAPE '\\'`;
  let indexSql = '';

  if ([...query].length >= 3 && !query.includes('\0')) {
    const phrase = `"${query.replace(/"/g, '""')}"`;
    const rows = await select<Array<{ match_count: number }>>(
      `SELECT COUNT(*) AS match_count FROM (
        SELECT rowid FROM catalog_entity_name_fts WHERE name MATCH ? LIMIT 1001
      )`,
      [phrase]
    );
    const count = rows[0]?.match_count;
    if (typeof count !== 'number') {
      throw new Error('Catalog search candidate count is unavailable');
    }
    if (count > 1000) {
      indexSql =
        order === 'name'
          ? ' INDEXED BY idx_catalog_entities_active_name'
          : ' INDEXED BY idx_catalog_entities_active_updated';
    } else {
      sql += ` AND e.rowid IN (
        SELECT rowid FROM catalog_entity_name_fts WHERE name MATCH ?
      )`;
      params.push(phrase);
    }
  }

  return { sql, params, indexSql };
}
