import { createHash, randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { SAVED_FILE_RESTORE_STAGE_PREFIX } from '../shared/catalog-binding';
import { promotePathExclusively } from './exclusive-path-promotion';
import { syncDirectory } from './fs-durability';
import { createKeyedMutex } from './workspace-git/keyed-mutex';
import { assertWorkspaceProjectionPathSafe } from './workspace-projection-boundary';
import {
  hashWorkspaceSyncFileOnDisk,
  materializeWorkspaceSyncFile,
} from './workspace-sync-blob-cache';

type Member = { relativePath: string } & (
  | { kind: 'directory' }
  | { kind: 'file'; sha256: string; sizeBytes: number }
);
type Identity = { device: string; inode: string; birth: string };
const identitySchema = z
  .object({ device: z.string(), inode: z.string(), birth: z.string() })
  .strict();
const journalSchema = z
  .object({
    revision: z.string(),
    destination: z.string(),
    stage: z.string(),
    stageId: identitySchema,
    packageId: identitySchema,
  })
  .strict();
const restoreMutex = createKeyedMutex();
const identity = (path: string): Identity | undefined => {
  const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (!stat?.isDirectory()) return;
  return { device: String(stat.dev), inode: String(stat.ino), birth: String(stat.birthtimeNs) };
};
function matches(path: string, id: Identity): boolean {
  const observed = identity(path);
  return (
    observed?.device === id.device && observed.inode === id.inode && observed.birth === id.birth
  );
}
async function readJournal(path: string) {
  try {
    return journalSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

export async function restoreSavedDirectory(input: {
  revision: string;
  destination: string;
  blobRoot: string;
  members: readonly Member[];
  matchesManifest(path: string): Promise<boolean>;
  assertCurrent?: () => void;
}): Promise<void> {
  await restoreMutex(input.destination, async () => {
    const parent = dirname(input.destination);
    const journals = join(input.blobRoot, '.restore-operations');
    await mkdir(journals, { recursive: true, mode: 0o700 });
    await syncDirectory(input.blobRoot);
    const key = createHash('sha256')
      .update(JSON.stringify([input.revision, input.destination]))
      .digest('hex');
    const journalPath = join(journals, key + '.json');
    let record = await readJournal(journalPath);
    if (!record) {
      if (lstatSync(input.destination, { throwIfNoEntry: false }))
        throw new Error('The restoration destination is occupied.');
      const stageParent =
        (await lstat(parent)).dev === (await lstat(journals)).dev ? journals : parent;
      const stage = await mkdtemp(join(stageParent, SAVED_FILE_RESTORE_STAGE_PREFIX));
      const payload = join(stage, 'package');
      await mkdir(payload, { mode: 0o700 });
      const stageId = identity(stage),
        packageId = identity(payload);
      if (!stageId || !packageId)
        throw new Error('The restored package preparation directory changed.');
      const created = {
        revision: input.revision,
        destination: input.destination,
        stage,
        stageId,
        packageId,
      };
      await syncDirectory(stage);
      await syncDirectory(stageParent);
      const temporary = join(journals, key + '.' + randomUUID() + '.pending');
      const receipt = await open(temporary, 'wx', 0o600);
      try {
        await receipt.writeFile(JSON.stringify(created), 'utf8');
        await receipt.sync();
      } finally {
        await receipt.close();
      }
      try {
        promotePathExclusively(temporary, journalPath);
        await syncDirectory(journals);
        record = created;
      } catch (error) {
        const winner = await readJournal(journalPath);
        if (!winner || winner.stage === stage) throw error;
        record = winner;
        if (matches(payload, packageId)) await rmdir(payload);
        if (matches(stage, stageId)) await rmdir(stage);
      } finally {
        await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
    }
    const { stage, stageId, packageId } = record;
    if (
      record.revision !== input.revision ||
      record.destination !== input.destination ||
      ![journals, parent].includes(dirname(stage)) ||
      !basename(stage).startsWith(SAVED_FILE_RESTORE_STAGE_PREFIX)
    )
      throw new Error('The retained restore preparation belongs to another destination.');
    const payload = join(stage, 'package');
    const assertStage = () => {
      input.assertCurrent?.();
      if (!matches(stage, stageId) || !matches(payload, packageId))
        throw new Error('The preparation for this package was replaced.');
    };
    input.assertCurrent?.();
    if (matches(input.destination, packageId)) {
      if (!(await input.matchesManifest(input.destination)))
        throw new Error('The restored destination changed after publication.');
    } else {
      assertStage();
      if (lstatSync(input.destination, { throwIfNoEntry: false }))
        throw new Error('The restoration destination is occupied.');
      const directories: string[] = [];
      for (const member of input.members) {
        assertStage();
        const path = join(payload, member.relativePath);
        assertWorkspaceProjectionPathSafe(payload, path);
        const stat = lstatSync(path, { throwIfNoEntry: false });
        if (member.kind === 'directory') {
          if (stat && !stat.isDirectory())
            throw new Error('A restored directory member has been replaced.');
          if (!stat) await mkdir(path, { mode: 0o700 });
          directories.push(path);
        } else if (!stat) {
          const work = join(stage, 'work-' + randomUUID());
          await materializeWorkspaceSyncFile({ ...member, encoding: 'blob', content: '' }, work, {
            cacheRoot: input.blobRoot,
          });
          assertStage();
          assertWorkspaceProjectionPathSafe(payload, path);
          promotePathExclusively(work, path);
        } else if (
          !stat.isFile() ||
          stat.size !== member.sizeBytes ||
          (await hashWorkspaceSyncFileOnDisk(path)).sha256 !== member.sha256
        ) {
          throw new Error('A retained restore member changed before publication.');
        }
      }
      for (const dir of directories.reverse()) await syncDirectory(dir);
      if (!(await input.matchesManifest(payload)))
        throw new Error('The staged directory does not match the entire retained package.');
      assertStage();
      promotePathExclusively(payload, input.destination);
    }
    if (!matches(input.destination, packageId))
      throw new Error('The restored destination changed during publication.');
    await syncDirectory(parent);
    if (matches(stage, stageId)) {
      for (const entry of await readdir(stage)) {
        if (!/^work-[0-9a-f-]{36}(?:\.sync-[0-9a-f-]{36})?$/.test(entry)) continue;
        const path = join(stage, entry);
        if (lstatSync(path, { throwIfNoEntry: false })?.isFile()) await unlink(path);
      }
      await rmdir(stage).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOTEMPTY') throw error;
      });
    }
    await unlink(journalPath);
    await syncDirectory(journals);
  });
}
