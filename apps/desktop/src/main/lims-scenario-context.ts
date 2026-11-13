import type Database from 'better-sqlite3';

export interface LimsScenarioSeedContext {
  workspaceId: number;
  repoPath: string;
  createdFiles: Set<string>;
}

const contexts = new WeakMap<Database.Database, LimsScenarioSeedContext>();

export function currentLimsScenarioSeedContext(
  db: Database.Database
): LimsScenarioSeedContext | undefined {
  return contexts.get(db);
}

export function withLimsScenarioSeedContext<T>(
  db: Database.Database,
  context: LimsScenarioSeedContext,
  operation: () => T
): T {
  if (contexts.has(db))
    throw new Error('A Registry scenario seed is already active for this database.');
  contexts.set(db, context);
  try {
    return operation();
  } finally {
    contexts.delete(db);
  }
}
