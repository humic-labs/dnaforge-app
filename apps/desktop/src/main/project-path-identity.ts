import type Database from 'better-sqlite3';
import { join, relative } from 'node:path';
import { normalizePathForBoundary, pathRelativeToBoundary } from '../shared/path-boundary';

export async function resolveRegisteredProjectPath(
  requested: string,
  dependencies: { db: Database.Database; admit(path: string): Promise<string> }
): Promise<string> {
  const physical = await dependencies.admit(requested);
  const { db } = dependencies;
  const registered = (path: string): boolean =>
    Boolean(
      db.prepare('SELECT path FROM workspaces WHERE path=?').get(path) ||
      db
        .prepare(
          `SELECT f.path FROM catalog_entity_files f JOIN catalog_entities e ON e.id=f.entity_id
      WHERE f.path=? AND f.status='current' AND e.status='active'`
        )
        .get(path)
    );
  if (registered(requested)) return requested;
  if (registered(physical)) return physical;

  const roots = db.prepare('SELECT path FROM workspaces').all() as Array<{ path: string }>;
  const located: Array<{ path: string; physical: string }> = [];
  for (const root of roots) {
    located.push({ path: root.path, physical: await dependencies.admit(root.path) });
  }
  const sameRoots = located.filter((root) => samePath(root.physical, physical));
  if (sameRoots.length === 1) return sameRoots[0].path;
  if (sameRoots.length > 1) throw ambiguousProjectPath();

  const owners = located.filter((root) => pathRelativeToBoundary(physical, root.physical) !== null);
  const candidates = [
    ...new Set(owners.map((root) => join(root.path, relative(root.physical, physical)))),
  ];
  if (candidates.length > 0) {
    const rows = db
      .prepare(
        `SELECT f.path FROM catalog_entity_files f JOIN catalog_entities e ON e.id=f.entity_id
      WHERE f.path IN (${candidates.map(() => '?').join(',')}) AND f.status='current' AND e.status='active'`
      )
      .all(...candidates) as Array<{ path: string }>;
    if (rows.length === 1) return rows[0].path;
    if (rows.length > 1) throw ambiguousProjectPath();
  }
  owners.sort((a, b) => b.physical.length - a.physical.length);
  const owner = owners[0];
  if (!owner) return physical;
  if (owners.filter((root) => samePath(root.physical, owner.physical)).length > 1)
    throw ambiguousProjectPath();
  return join(owner.path, relative(owner.physical, physical));
}

function ambiguousProjectPath(): Error {
  return new Error('More than one stored project refers to this location. Open a listed project.');
}

function samePath(a: string, b: string): boolean {
  return normalizePathForBoundary(a) === normalizePathForBoundary(b);
}
