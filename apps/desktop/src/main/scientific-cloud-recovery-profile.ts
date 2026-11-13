import Database from 'better-sqlite3';
import { app } from 'electron';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureSchema } from './schema';
import { syncDirectory } from './fs-durability';
import { flushScientificRecoveryFile } from './scientific-recovery-checkpoint';
import { createEmptyManagedWorkspace } from './workspace-git/import';
import { createKeyedMutex } from './workspace-git/keyed-mutex';
import { acquireWorkspaceSyncMutationLease } from './workspace-sync-mutation-lease';
import { restoreScientificWorkspaceFromCloudRecovery } from './scientific-cloud-recovery';
import { createScientificWorkspaceSyncRecoveryClient } from './workspace-sync-recovery-candidate';
import type { DesktopSyncClient } from './desktop-sync-client';
import { acquireScientificRecoveryProfileOwner } from './scientific-recovery-profile-owner';

const serializeRecovery = createKeyedMutex();

async function ownedDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (await realpath(path)) !== path ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error('Scientific recovery directory has a different owner.');
}

export async function restoreScientificCloudRecoveryInIsolatedProfile(input: {
  client: DesktopSyncClient;
  context: { workspaceId: string; candidateId: string; accountId: string };
  projectName: string;
  signal?: AbortSignal;
}) {
  if (!input.client.assertAccount)
    throw new Error('Scientific recovery requires a pinned account.');
  await input.client.assertAccount(input.context.accountId);
  await createScientificWorkspaceSyncRecoveryClient(input.client).readDetail(
    input.context,
    input.signal
  );
  const owner = JSON.stringify({
    schema: 'dnaforge.scientific-recovery-profile/v1',
    ...input.context,
  });
  const root = await realpath(app.getPath('userData'));
  const parent = join(root, 'scientific-cloud-recovery');
  await ownedDirectory(parent);
  const directory = join(parent, createHash('sha256').update(owner).digest('hex'));
  return serializeRecovery(directory, async () => {
    await ownedDirectory(directory);
    const ownerPath = join(directory, 'owner.json');
    try {
      await writeFile(ownerPath, owner, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
        (await readFile(ownerPath, 'utf8')) !== owner
      )
        throw error;
    }
    const ownerStat = await lstat(ownerPath);
    if (!ownerStat.isFile() || ownerStat.isSymbolicLink())
      throw new Error('Scientific recovery ownership receipt is not regular.');
    await flushScientificRecoveryFile(ownerPath);
    const profilePath = join(directory, 'profile');
    await ownedDirectory(profilePath);
    const releaseProfile = acquireScientificRecoveryProfileOwner(profilePath, 'recovery');
    if (!releaseProfile) throw new Error('Scientific recovery profile has no native owner.');
    try {
      for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
        const lock = await lstat(join(profilePath, name)).catch((error) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        });
        if (lock)
          throw new Error('Close the isolated recovery application before retrying its recovery.');
      }
      await syncDirectory(profilePath);
      await syncDirectory(directory);
      await syncDirectory(parent);
      const databasePath = join(profilePath, 'dnaforge.db');
      const existing = await lstat(databasePath).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      });
      if (existing && (!existing.isFile() || existing.isSymbolicLink()))
        throw new Error('Scientific recovery database is not owned regular storage.');
      const db = new Database(databasePath);
      try {
        db.pragma('foreign_keys = ON');
        db.pragma('journal_mode = WAL');
        ensureSchema(db, databasePath);
        const key = 'scientific-cloud-recovery-target';
        const previous = db.prepare('SELECT value FROM settings WHERE key=?').get(key) as
          | { value: string }
          | undefined;
        let target: { workspaceUuid: string; repoPath: string };
        if (previous) target = JSON.parse(previous.value) as typeof target;
        else {
          await input.client.assertAccount!(input.context.accountId);
          target = await createEmptyManagedWorkspace(`${input.projectName} — recovered history`, {
            db,
            managedRootDir: join(profilePath, 'managed-workspaces'),
            recordCreatedInsideTx(identity) {
              db.prepare('INSERT INTO settings(key,value,updated_at) VALUES (?,?,?)').run(
                key,
                JSON.stringify(identity),
                Date.now()
              );
            },
          });
        }
        const row = db
          .prepare(
            'SELECT id,path FROM workspaces WHERE repo_uuid=? AND archived_at IS NULL AND trashed_at IS NULL'
          )
          .get(target?.workspaceUuid) as { id: number; path: string } | undefined;
        if (!row || row.path !== target.repoPath)
          throw new Error('The isolated recovery destination changed.');
        const release = await acquireWorkspaceSyncMutationLease(row.path);
        let result;
        try {
          result = await restoreScientificWorkspaceFromCloudRecovery(db, {
            workspaceId: row.id,
            mutationLease: release,
            client: input.client,
            context: input.context,
            signal: input.signal,
            profilePath,
          });
        } finally {
          release();
        }
        db.pragma('wal_checkpoint(TRUNCATE)');
        const instructions = `# Scientific history recovery\n\nAccepted project: ${row.path}\n\nIndependent profile: ${profilePath}\n\nOpen this profile with the current DNAForge executable using --user-data-dir followed by the profile path. Open the accepted project in that application. Its original scientific and Registry IDs are preserved in this independent database.\n\nCaptured working differences are separate drafts, not accepted revisions. See the recovery report for missing or excluded files. Keep this folder and the original project. No cloud binding is enabled in this recovered profile.\n`;
        const instructionsPath = join(directory, 'RECOVERY.md');
        try {
          await writeFile(instructionsPath, instructions, { flag: 'wx', mode: 0o600 });
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
            (await readFile(instructionsPath, 'utf8')) !== instructions
          )
            throw error;
        }
        await flushScientificRecoveryFile(instructionsPath);
        await flushScientificRecoveryFile(databasePath);
        await syncDirectory(profilePath);
        await syncDirectory(directory);
        return { ...result, profilePath, projectPath: row.path, directory };
      } finally {
        db.close();
      }
    } finally {
      releaseProfile();
    }
  });
}
