import type Database from 'better-sqlite3';

const statementCaches = new WeakMap<Database.Database, Map<string, Database.Statement>>();

export function prepareCachedStatement(db: Database.Database, sql: string): Database.Statement {
  let cache = statementCaches.get(db);
  if (!cache) {
    cache = new Map();
    statementCaches.set(db, cache);
  }
  const existing = cache.get(sql);
  if (existing) return existing;
  const statement = db.prepare(sql);
  cache.set(sql, statement);
  return statement;
}
