import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { visibleWorkProjects, type WorkProjectAccess } from './work-task-projects';

const connections = new WeakMap<Database.Database, string>();

function databaseVersion(db: Database.Database): string {
  return JSON.stringify(
    db
      .prepare(
        'SELECT total_changes(), data_version, schema_version FROM pragma_data_version, pragma_schema_version'
      )
      .raw()
      .get()
  );
}

export function readWorkQuerySnapshot<T extends object>(
  db: Database.Database,
  root: string | undefined,
  read: (projects: WorkProjectAccess[]) => T
): T & { snapshotId: string } {
  let connection = connections.get(db);
  if (!connection) {
    connection = randomUUID();
    connections.set(db, connection);
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const previous = databaseVersion(db);
    const projects = visibleWorkProjects(db, root);
    const result = db
      .transaction(() => {
        if (databaseVersion(db) !== previous) return null;
        const view = read(projects);
        const scope = [...projects].sort((a, b) => a.workspaceId - b.workspaceId);
        const snapshotId = createHash('sha256')
          .update(JSON.stringify([connection, databaseVersion(db), scope]))
          .digest('hex');
        return { ...view, snapshotId };
      })
      .deferred();
    if (result) return result;
  }
  throw new Error('Project scope changed while reading work. Refresh to read its current dates.');
}
