import type Database from 'better-sqlite3';
import { app } from 'electron';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { DesktopSyncClient } from './desktop-sync-client';
import { scientificHistoryCurrentFiles } from '@waypoint/scientific-artifacts';
import { parseBlobHash, type BlobRef } from '@waypoint/workspace-revisions';
import { MANAGED_WORKSPACE_MARKER } from '../shared/workspace-git-types';
import { createScientificWorkspaceSyncRecoveryClient } from './workspace-sync-recovery-candidate';
import {
  downloadScientificWorkspaceCloudHistory,
  installScientificWorkspaceCloudHistory,
} from './scientific-cloud-transfer';
import { ScientificObjectStore } from './scientific-object-store';
import { materializeScientificWorkspace } from './scientific-object-materializer';
import { acquireWorkspaceSyncDatabaseFence } from './workspace-sync-database-fence';
import { assertWorkspaceMutationLease } from './workspace-sync-mutation-lease';
import { canonicalWorkspacePath } from './primer-artifact-files';
import { copyIndependentFile } from './workspace-git/copy-independent-file';
import { hashWorkspaceSyncFileOnDisk, workspaceSyncBlobPath } from './workspace-sync-blob-cache';
import { commitPathsIfDirty, flushManagedCommitDurably, resolveHeadCommit } from './workspace-git';
import { syncDirectory } from './fs-durability';

export async function restoreScientificWorkspaceFromCloudRecovery(
  db: Database.Database,
  input: {
    workspaceId: number;
    mutationLease: () => void;
    client: DesktopSyncClient;
    context: { workspaceId: string; candidateId: string; accountId: string };
    signal?: AbortSignal;

    profilePath?: string;
  }
) {
  if (!input.client.assertAccount)
    throw new Error('Scientific recovery requires its pinned acting account.');
  await input.client.assertAccount(input.context.accountId);
  const recovery = createScientificWorkspaceSyncRecoveryClient(input.client);
  const detail = await recovery.readDetail(input.context, input.signal);
  const target = db
    .prepare(
      'SELECT repo_uuid,path FROM workspaces WHERE id=? AND archived_at IS NULL AND trashed_at IS NULL'
    )
    .get(input.workspaceId) as { repo_uuid: string; path: string } | undefined;
  if (!target?.repo_uuid)
    throw new Error('Scientific recovery needs its new managed local project.');
  const store = new ScientificObjectStore(db, input.workspaceId);
  assertWorkspaceMutationLease(input.mutationLease, store.workspaceRoot());
  if (
    db.prepare('SELECT 1 FROM workspace_sync_bindings WHERE workspace_id=?').get(input.workspaceId)
  )
    throw new Error('Scientific recovery cannot replace a bound project.');
  const receiptJson = JSON.stringify({
    schema: 'dnaforge.scientific-local-recovery/v1',
    workspaceUuid: target.repo_uuid,
    accountId: input.context.accountId,
    remoteWorkspaceId: input.context.workspaceId,
    candidateId: input.context.candidateId,
    contentSha256: detail.candidate.contentSha256,
    requestSha256: detail.candidate.requestSha256,
    scientificHistory: detail.candidate.scientificHistory,
  });
  const key = `scientific-cloud-recovery:${input.workspaceId}`;
  const assertEmptyDestination = async () => {
    assertWorkspaceMutationLease(input.mutationLease, store.workspaceRoot());
    if ((await realpath(target.path)) !== target.path)
      throw new Error('Scientific local recovery destination was redirected.');
    const marker = db.prepare('SELECT value FROM settings WHERE key=?').get(key) as
      | { value: string }
      | undefined;
    if (marker?.value === receiptJson) return;
    if (
      marker ||
      db
        .prepare('SELECT 1 FROM scientific_revision_records WHERE workspace_id=? LIMIT 1')
        .get(input.workspaceId) ||
      (await readdir(target.path)).some(
        (name) => name !== '.git' && name !== MANAGED_WORKSPACE_MARKER
      )
    )
      throw new Error(
        'Recover scientific history into a new empty local project; existing work is retained.'
      );
  };
  await assertEmptyDestination();
  const userData = await realpath(input.profilePath ?? app.getPath('userData'));
  const cacheRoot = join(userData, 'workspace-sync', 'blobs');
  const historyHashes = new Set([
    detail.candidate.scientificHistory.archive.hash,
    ...detail.candidate.scientificBlobRefs.map((blob) => blob.hash),
  ]);
  const capturedByHash = new Map(
    detail.manifest.files.map((file) => [`sha256:${file.contentSha256}`, file])
  );
  const inventory = new Map<string, BlobRef>(
    detail.candidate.scientificBlobRefs.map((blob) => [blob.hash, blob])
  );
  for (const file of detail.manifest.files) {
    const hash = parseBlobHash(`sha256:${file.contentSha256}`);
    if (!hash.ok) throw new Error('Scientific captured draft digest is invalid.');
    const previous = inventory.get(hash.value);
    if (previous && previous.byteLength !== file.sizeBytes)
      throw new Error('Scientific recovery repeats a digest with inconsistent lengths.');
    inventory.set(hash.value, { hash: hash.value, byteLength: file.sizeBytes });
  }
  const downloaded = await downloadScientificWorkspaceCloudHistory({
    descriptor: detail.candidate.scientificHistory,
    blobs: [...inventory.values()],
    signal: input.signal,
    cacheRoot,
    beforeBlob: () => input.client.assertAccount!(input.context.accountId),
    downloadBlob: (blob, signal) =>
      historyHashes.has(blob.hash)
        ? recovery.downloadHistoryBlob(input.context, blob, signal)
        : recovery.downloadCapturedFile(input.context, capturedByHash.get(blob.hash)!.path, signal),
  });
  const installed = await installScientificWorkspaceCloudHistory(db, {
    workspaceId: input.workspaceId,
    mutationLease: input.mutationLease,
    descriptor: detail.candidate.scientificHistory,
    archive: downloaded.archive,
    sources: downloaded.sources,
    blobRefs: detail.candidate.scientificBlobRefs,
    expectedHead: store.catalog().head,
    signal: input.signal,
    localRecovery: { workspaceUuid: target.repo_uuid, repoPath: target.path, receiptJson },
    beforeCommit: async () => {
      await input.client.assertAccount!(input.context.accountId);
      const fresh = await recovery.readDetail(input.context, input.signal);
      if (JSON.stringify(fresh) !== JSON.stringify(detail))
        throw new Error('Scientific recovery capture changed before local adoption.');
      await assertEmptyDestination();
    },
  });
  if (installed.kind === 'conflict')
    throw new Error('Scientific local recovery acquired competing work; every branch is retained.');
  const releaseFence = await acquireWorkspaceSyncDatabaseFence(db);
  let delivery;
  try {
    delivery = await materializeScientificWorkspace(store);
  } finally {
    releaseFence();
  }
  if (delivery.kind !== 'complete')
    return {
      state: 'pending' as const,
      workspaceUuid: target.repo_uuid,
      acceptedHead: store.catalog().head,
      delivery,
    };

  const { graph, head } = store.read();
  const accepted = new Map(
    scientificHistoryCurrentFiles(graph, head).map((file) => [file.path, file.blob])
  );
  for (const [path, blob] of accepted) {
    const file = await hashWorkspaceSyncFileOnDisk(join(target.path, path));
    if (file.sha256 !== blob.hash.slice('sha256:'.length) || file.sizeBytes !== blob.byteLength)
      throw new Error(
        'Recovered project has working edits; its files and accepted history are preserved.'
      );
  }
  const drafts = detail.manifest.files.filter((file) => {
    const blob = accepted.get(file.path);
    return (
      !blob || blob.hash !== `sha256:${file.contentSha256}` || blob.byteLength !== file.sizeBytes
    );
  });
  const parent = join(userData, 'scientific-recovery-drafts');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if ((await lstat(parent)).isSymbolicLink() || (await realpath(parent)) !== parent)
    throw new Error('Scientific draft storage is not owned regular storage.');
  const draftsPath = join(parent, createHash('sha256').update(receiptJson).digest('hex'));
  await mkdir(draftsPath, { recursive: true, mode: 0o700 });
  if ((await lstat(draftsPath)).isSymbolicLink() || (await realpath(draftsPath)) !== draftsPath)
    throw new Error('Scientific draft recovery directory changed ownership.');
  const filesRoot = join(draftsPath, 'files');
  await mkdir(filesRoot, { recursive: true, mode: 0o700 });
  if ((await lstat(filesRoot)).isSymbolicLink() || (await realpath(filesRoot)) !== filesRoot)
    throw new Error('Scientific recovered draft files changed ownership.');
  const directories = new Set<string>([filesRoot, draftsPath, parent, userData]);
  for (const file of drafts) {
    input.signal?.throwIfAborted();
    const path = join(filesRoot, file.path);
    const canonical = await canonicalWorkspacePath({
      workspaceRoot: filesRoot,
      path,
      allowMissing: true,
      artifactNoun: 'recovered scientific draft',
    });
    await mkdir(dirname(canonical.candidate), { recursive: true, mode: 0o700 });
    const owned = await canonicalWorkspacePath({
      workspaceRoot: filesRoot,
      path,
      allowMissing: true,
      artifactNoun: 'recovered scientific draft',
    });
    if (owned.candidate !== path)
      throw new Error('Scientific recovered draft has a redirected parent.');
    try {
      const present = await hashWorkspaceSyncFileOnDisk(canonical.candidate);
      if (present.sha256 !== file.contentSha256 || present.sizeBytes !== file.sizeBytes)
        throw new Error('Recovered draft was edited; its bytes are preserved.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await copyIndependentFile(
        await workspaceSyncBlobPath(file.contentSha256, cacheRoot),
        canonical.candidate
      );
      await chmod(canonical.candidate, 0o600);
    }
    const verified = await hashWorkspaceSyncFileOnDisk(canonical.candidate);
    if (verified.sha256 !== file.contentSha256 || verified.sizeBytes !== file.sizeBytes)
      throw new Error('Scientific recovered draft differs from its verified capture.');
    const handle = await open(canonical.candidate, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    for (let directory = dirname(canonical.candidate); ; ) {
      directories.add(directory);
      if (directory === filesRoot) break;
      directory = dirname(directory);
    }
  }
  const manifestPath = join(draftsPath, 'recovery.json');
  const report = JSON.stringify(
    {
      scope: 'captured-working-drafts',
      context: input.context,
      candidate: detail.candidate,
      files: drafts,
      missingPaths: detail.missingPaths,
      excludedSummary: detail.excludedSummary,
    },
    null,
    2
  );
  try {
    await writeFile(manifestPath, report, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
      (await readFile(manifestPath, 'utf8')) !== report
    )
      throw error;
  }
  const reportHandle = await open(manifestPath, 'r');
  try {
    await reportHandle.sync();
  } finally {
    await reportHandle.close();
  }
  for (const directory of [...directories].sort((a, b) => b.length - a.length))
    await syncDirectory(directory);
  const current = await commitPathsIfDirty(target.path, 'Restore accepted scientific history', {
    paths: [...accepted.keys()],
    forceInclude: [...accepted.keys()],
  });
  const gitHead = current ?? (await resolveHeadCommit(target.path));
  if (!gitHead) throw new Error('Recovered scientific project has no durable repository head.');
  await flushManagedCommitDurably(target.path, gitHead, [...accepted.keys()]);
  return {
    state: 'restored' as const,
    workspaceUuid: target.repo_uuid,
    acceptedHead: head,
    draftsPath,
    changedDraftFiles: drafts.length,
    coverage: detail.candidate.coverage,
    missingPaths: detail.missingPaths,
  };
}
