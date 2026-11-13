import type Database from 'better-sqlite3';
import { lstat, mkdir, readFile, readdir, realpath, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { scientificHistoryCurrentFiles } from '@waypoint/scientific-artifacts';
import { ScientificObjectStore } from './scientific-object-store';
import { acquireWorkspaceSyncMutationLease } from './workspace-sync-mutation-lease';
import { acquireWorkspaceSyncDatabaseFence } from './workspace-sync-database-fence';
import {
  canonicalWorkspacePath,
  writeWorkspaceBinaryFileAtomicInMain,
} from './primer-artifact-files';
import { hashWorkspaceSyncFileOnDisk } from './workspace-sync-blob-cache';
import { syncDirectory } from './fs-durability';
import {
  commitPathsIfDirty,
  flushManagedCommitDurably,
  initManagedRepo,
  resolveHeadCommit,
  readBlobContentIdentityAtCommit,
} from './workspace-git';
import { MANAGED_WORKSPACE_MARKER } from '../shared/workspace-git-types';
import { assertSelfContainedScientificGit } from './scientific-recovery-checkpoint';

export async function recoverMissingScientificRepo(
  db: Database.Database,
  input: {
    workspaceId: number;
    workspaceUuid: string;
    repoPath: string;
    managedRootDir: string;
    beforeWrite?: (path: string) => void;
    beforeFinalValidation?: () => Promise<void>;
    beforePublishRoot?: () => void;
  }
): Promise<void> {
  const managed = await realpath(input.managedRootDir);
  const container = join(managed, input.workspaceUuid);
  const containerStat = await lstat(container);
  if (
    input.repoPath !== join(container, 'repo') ||
    !containerStat.isDirectory() ||
    containerStat.isSymbolicLink() ||
    (await realpath(container)) !== container ||
    (process.getuid && containerStat.uid !== process.getuid())
  )
    throw new Error('Scientific repository recovery requires its exact managed container.');
  const release = await acquireWorkspaceSyncMutationLease(input.repoPath);
  const releaseFence = await acquireWorkspaceSyncDatabaseFence(db);
  try {
    const store = new ScientificObjectStore(db, input.workspaceId);
    if (store.workspaceRoot() !== input.repoPath)
      throw new Error('Scientific recovery owner changed.');
    const { graph, head } = store.read();
    if (!head) throw new Error('Scientific repository recovery has no accepted history.');
    const files = scientificHistoryCurrentFiles(graph, head);

    store.exportHistory();
    for (const file of files)
      if (!store.readBlob(file.blob))
        throw new Error('Scientific recovery is missing accepted bytes.');
    const authority = {
      schema: 'dnaforge.scientific-missing-repo/v1',
      workspaceId: input.workspaceId,
      workspaceUuid: input.workspaceUuid,
      repoPath: input.repoPath,
      head,
    };
    let receipt = JSON.stringify(authority);
    const receiptPath = join(container, '.scientific-missing-repo-recovery.json');
    const key = `scientific-missing-repo-recovery:${input.workspaceId}`;
    const existingRoot = await lstat(input.repoPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (existingRoot) {
      const receiptStat = await lstat(receiptPath);
      const previous =
        receiptStat.isFile() && !receiptStat.isSymbolicLink()
          ? JSON.parse(await readFile(receiptPath, 'utf8'))
          : null;
      if (
        !receiptStat.isFile() ||
        receiptStat.isSymbolicLink() ||
        !existingRoot.isDirectory() ||
        existingRoot.isSymbolicLink() ||
        (await realpath(input.repoPath)) !== input.repoPath ||
        !previous ||
        JSON.stringify(previous.authority) !== receipt ||
        previous.device !== String(existingRoot.dev) ||
        previous.inode !== String(existingRoot.ino)
      )
        throw new Error('Scientific recovery cannot overwrite a recreated repository.');
      receipt = JSON.stringify(previous);
    } else {
      const priorStat = await lstat(receiptPath).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      });
      let stagedPath: string;
      if (priorStat) {
        if (!priorStat.isFile() || priorStat.isSymbolicLink())
          throw new Error('Scientific recovery receipt is not regular.');
        const previous = JSON.parse(await readFile(receiptPath, 'utf8'));
        if (
          JSON.stringify(previous.authority) !== receipt ||
          typeof previous.stagedName !== 'string' ||
          !/^\.scientific-repo-recovery-[a-f0-9-]{36}$/.test(previous.stagedName)
        )
          throw new Error('Scientific recovery receipt changed.');
        stagedPath = join(container, previous.stagedName);
        const stat = await lstat(stagedPath);
        if (
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          String(stat.dev) !== previous.device ||
          String(stat.ino) !== previous.inode ||
          (await realpath(stagedPath)) !== stagedPath
        )
          throw new Error('Scientific staged recovery root changed.');
        receipt = JSON.stringify(previous);
      } else {
        const stagedName = `.scientific-repo-recovery-${randomUUID()}`;
        stagedPath = join(container, stagedName);
        await mkdir(stagedPath, { recursive: false, mode: 0o700 });
        await syncDirectory(stagedPath);
        await syncDirectory(container);
        const created = await lstat(stagedPath);
        receipt = JSON.stringify({
          authority,
          stagedName,
          device: String(created.dev),
          inode: String(created.ino),
        });
        await writeWorkspaceBinaryFileAtomicInMain(
          {
            workspaceRoot: container,
            path: receiptPath,
            content: Buffer.from(receipt),
            artifactNoun: 'scientific recovery receipt',
          },
          { mode: 'create', durable: true }
        );
      }

      if (
        await lstat(input.repoPath).then(
          () => true,
          (error) => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
            throw error;
          }
        )
      )
        throw new Error('Scientific recovery cannot overwrite a recreated repository.');
      input.beforePublishRoot?.();
      await rename(stagedPath, input.repoPath);
      await syncDirectory(container);
    }

    db.prepare(
      'INSERT INTO settings(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at'
    ).run(key, receipt, Date.now());
    const assertRoot = async () => {
      const current = await lstat(input.repoPath);
      const owned = JSON.parse(receipt);
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        String(current.dev) !== owned.device ||
        String(current.ino) !== owned.inode ||
        (await realpath(input.repoPath)) !== input.repoPath
      )
        throw new Error('Scientific recovery root was replaced.');
    };
    const assertGit = async () => {
      await assertRoot();
      const gitPath = join(input.repoPath, '.git');
      const stat = await lstat(gitPath).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      });
      if (!stat) return;
      if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(gitPath)) !== gitPath)
        throw new Error('Scientific recovery Git metadata is not owned regular storage.');
      const inspect = async (path: string): Promise<void> => {
        for (const entry of await readdir(path, { withFileTypes: true })) {
          const target = join(path, entry.name);
          const value = await lstat(target);
          if (value.isSymbolicLink() || (!value.isFile() && !value.isDirectory()))
            throw new Error('Scientific recovery Git metadata contains a foreign path.');
          if (value.isDirectory()) await inspect(target);
        }
      };
      await inspect(gitPath);
      await assertSelfContainedScientificGit(input.repoPath);
    };
    for (const file of files) {
      await assertRoot();
      const path = join(input.repoPath, file.path);
      const canonical = await canonicalWorkspacePath({
        workspaceRoot: input.repoPath,
        path,
        allowMissing: true,
      });
      if (canonical.candidate !== path) throw new Error('Scientific recovery path was redirected.');
      const stat = await lstat(path).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      });
      if (stat) {
        if (!stat.isFile() || stat.isSymbolicLink())
          throw new Error('Scientific recovery cannot overwrite another path.');
        const actual = await hashWorkspaceSyncFileOnDisk(path);
        if (actual.sha256 !== file.blob.hash.slice(7) || actual.sizeBytes !== file.blob.byteLength)
          throw new Error(
            'Scientific recovery retained a changed working file; it cannot overwrite it.'
          );
      } else {
        input.beforeWrite?.(file.path);
        await writeWorkspaceBinaryFileAtomicInMain(
          {
            workspaceRoot: input.repoPath,
            path,
            content: store.readBlob(file.blob)!,
            artifactNoun: 'recovered scientific object',
          },
          { mode: 'create', durable: true }
        );
      }
    }
    const marker =
      JSON.stringify(
        { schema: 1, workspaceUuid: input.workspaceUuid, originPath: null, importedAt: Date.now() },
        null,
        2
      ) + '\n';
    const markerPath = join(input.repoPath, MANAGED_WORKSPACE_MARKER);
    const priorMarker = await readFile(markerPath, 'utf8').catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (priorMarker) {
      const value = JSON.parse(priorMarker);
      if (value.schema !== 1 || value.workspaceUuid !== input.workspaceUuid)
        throw new Error('Scientific recovery marker changed.');
    } else
      await writeWorkspaceBinaryFileAtomicInMain(
        {
          workspaceRoot: input.repoPath,
          path: markerPath,
          content: Buffer.from(marker),
          artifactNoun: 'workspace marker',
        },
        { mode: 'create', durable: true }
      );
    const validateFiles = async () => {
      await assertRoot();
      for (const file of files) {
        const actual = await hashWorkspaceSyncFileOnDisk(join(input.repoPath, file.path));
        if (actual.sha256 !== file.blob.hash.slice(7) || actual.sizeBytes !== file.blob.byteLength)
          throw new Error('Scientific recovery working files changed before completion.');
      }
    };
    await input.beforeFinalValidation?.();
    await validateFiles();
    await assertGit();
    await initManagedRepo(input.repoPath);
    await assertGit();
    await commitPathsIfDirty(input.repoPath, 'Recover accepted scientific repository', {
      paths: [MANAGED_WORKSPACE_MARKER, ...files.map((file) => file.path)],
    });
    const commit = await resolveHeadCommit(input.repoPath);
    if (!commit) throw new Error('Scientific recovery has no durable repository head.');
    await flushManagedCommitDurably(input.repoPath, commit, [
      MANAGED_WORKSPACE_MARKER,
      ...files.map((file) => file.path),
    ]);
    await validateFiles();
    for (const file of files) {
      const actual = await readBlobContentIdentityAtCommit(
        input.repoPath,
        commit,
        file.path,
        file.blob.byteLength,
        file.blob.byteLength
      );
      if (
        !actual ||
        actual.contentSha256 !== file.blob.hash.slice(7) ||
        actual.sizeBytes !== file.blob.byteLength
      )
        throw new Error('Scientific recovery commit differs from accepted history.');
    }
    if (store.catalog().head !== head)
      throw new Error('Scientific recovery accepted head changed.');
    db.prepare('DELETE FROM settings WHERE key=? AND value=?').run(key, receipt);
  } finally {
    releaseFence();
    release();
  }
}
