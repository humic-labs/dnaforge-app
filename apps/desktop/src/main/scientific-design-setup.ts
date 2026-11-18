import type Database from 'better-sqlite3';
import { lstatSync, realpathSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { scientificHistoryWorkspaceIdentity } from './scientific-history-identity';
import { canonicalWorkspacePath } from './primer-artifact-files';

type Owner = {
  id: number;
  path: string;
  repo_uuid: string | null;
  access_mode: string;
  archived_at: number | null;
  trashed_at: number | null;
  access_role: string | null;
};

export function captureScientificDesignSetupOwner(
  db: Database.Database,
  workspaceId: number,
  root: string,
  beforePublish?: () => void
) {
  const read = db.prepare(`SELECT w.id,w.path,w.repo_uuid,w.access_mode,w.archived_at,w.trashed_at,
    (SELECT b.access_role FROM workspace_sync_bindings b
      WHERE b.workspace_id=w.id AND b.workspace_uuid=w.repo_uuid) AS access_role
    FROM workspaces w WHERE w.id=?`);
  const original = read.get(workspaceId) as Owner | undefined;
  const owners = db.prepare(
    'SELECT COUNT(*) AS n FROM workspaces WHERE path=? AND archived_at IS NULL AND trashed_at IS NULL'
  );
  const identity = scientificHistoryWorkspaceIdentity(db, workspaceId);
  const rootPath = realpathSync(root);
  const rootStat = lstatSync(rootPath);
  const assertCurrent = () => {
    const current = read.get(workspaceId) as Owner | undefined;
    if (
      !original ||
      !current ||
      current.path !== root ||
      current.repo_uuid !== original.repo_uuid ||
      (owners.get(root) as { n: number }).n !== 1 ||
      current.access_mode !== 'writable' ||
      current.archived_at !== null ||
      current.trashed_at !== null ||
      current.access_role === 'viewer' ||
      scientificHistoryWorkspaceIdentity(db, workspaceId) !== identity ||
      realpathSync(root) !== rootPath ||
      !sameDirectory(rootStat, lstatSync(rootPath))
    )
      throw new Error('The versioned-design setup project authority changed.');
    const result: unknown = beforePublish?.();
    if (result !== undefined) {
      void Promise.resolve(result).catch(() => undefined);
      throw new Error('Setup publication authority must be checked synchronously.');
    }
  };
  assertCurrent();
  return { assertCurrent, root: rootPath };
}

export async function captureScientificDesignSetupAbsence(root: string) {
  const map = join(root, '.dnaforge', 'scientific-objects.json');
  await canonicalWorkspacePath({ workspaceRoot: root, path: map, allowMissing: true });
  const parent = join(root, '.dnaforge');
  const parentStat = optionalStat(parent);
  if (parentStat && (!parentStat.isDirectory() || parentStat.isSymbolicLink()))
    throw new Error('The scientific namespace parent must be an owned directory.');
  const assertCurrent = () => {
    const currentParent = optionalStat(parent);
    if (
      (parentStat ? !currentParent || !sameDirectory(parentStat, currentParent) : currentParent) ||
      optionalStat(map)
    )
      throw new Error(
        'A scientific identity map or its parent changed. Inspect and submit the existing namespace explicitly.'
      );
  };
  assertCurrent();
  return assertCurrent;
}

function optionalStat(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function sameDirectory(a: Stats, b: Stats): boolean {
  return b.isDirectory() && !b.isSymbolicLink() && a.dev === b.dev && a.ino === b.ino;
}
