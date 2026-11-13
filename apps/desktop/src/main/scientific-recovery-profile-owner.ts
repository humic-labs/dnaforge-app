import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const heldOwners = new Set<Database.Database>();

export function acquireScientificRecoveryProfileOwner(
  profilePath: string,
  _kind: 'recovery' | 'application'
): (() => void) | null {
  const directory = dirname(profilePath);
  if (
    basename(profilePath) !== 'profile' ||
    basename(dirname(directory)) !== 'scientific-cloud-recovery' ||
    !/^[a-f0-9]{64}$/.test(basename(directory))
  )
    return null;
  for (const path of [directory, profilePath]) {
    const stat = lstatSync(path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      realpathSync(path) !== path ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error('Scientific recovery profile has a different physical owner.');
  }
  const ownerPath = join(directory, 'owner.json');
  const ownerStat = lstatSync(ownerPath);
  if (
    !ownerStat.isFile() ||
    ownerStat.isSymbolicLink() ||
    (process.getuid && ownerStat.uid !== process.getuid())
  )
    throw new Error('Scientific recovery profile ownership is unavailable.');
  const ownerBytes = readFileSync(ownerPath, 'utf8');
  const owner = JSON.parse(ownerBytes) as Record<string, unknown>;
  if (
    owner.schema !== 'dnaforge.scientific-recovery-profile/v1' ||
    ![owner.workspaceId, owner.candidateId, owner.accountId].every(
      (value) => typeof value === 'string' && UUID.test(value)
    ) ||
    createHash('sha256').update(ownerBytes).digest('hex') !== basename(directory)
  )
    throw new Error('Scientific recovery profile receipt changed.');

  const legacyPath = join(profilePath, '.scientific-recovery-profile-owner.lock');
  try {
    const stat = lstatSync(legacyPath);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('Scientific recovery profile owner is unknown.');
    const legacy = JSON.parse(readFileSync(legacyPath, 'utf8')) as {
      schema?: string;
      profilePath?: string;
      pid?: number;
      kind?: string;
      token?: string;
    };
    if (
      legacy.schema !== 'dnaforge.scientific-recovery-profile-owner/v1' ||
      legacy.profilePath !== profilePath ||
      !Number.isSafeInteger(legacy.pid) ||
      legacy.pid! < 1 ||
      !['application', 'recovery'].includes(legacy.kind!) ||
      typeof legacy.token !== 'string' ||
      !UUID.test(legacy.token) ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error('Scientific recovery profile owner is unknown.');
    try {
      process.kill(legacy.pid!, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return claimSqliteOwner(profilePath);
      throw error;
    }
    throw new Error('Scientific recovery profile still has a live previous owner.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return claimSqliteOwner(profilePath);
}

function claimSqliteOwner(profilePath: string): () => void {
  const path = join(profilePath, '.scientific-recovery-profile-owner.sqlite');
  try {
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error('Scientific recovery ownership database is not regular owned storage.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const db = new Database(path, { timeout: 0 });
  try {
    db.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    db.close();
    if ((error as { code?: string }).code === 'SQLITE_BUSY')
      throw new Error(
        'Scientific recovery profile is owned by another application or recovery process. Close it before opening or retrying this copy.'
      );
    throw error;
  }
  heldOwners.add(db);
  let released = false;
  return () => {
    if (released) return;
    db.exec('ROLLBACK');
    db.close();
    heldOwners.delete(db);
    released = true;
  };
}
