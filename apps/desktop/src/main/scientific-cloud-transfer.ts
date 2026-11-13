import type Database from 'better-sqlite3';
import { readFile } from 'node:fs/promises';
import type { ScientificCloudHistoryV1 } from '@waypoint/scientific-objects';
import type { WorkspaceSyncManifestV1 } from '@waypoint/share-bundle';
import type { BlobRef, WorkspaceVersionId } from '@waypoint/workspace-revisions';
import type { ScientificHistoryCurrentFile } from '@waypoint/scientific-artifacts';
import {
  ScientificObjectStore,
  createScientificRestoreObjectStore,
} from './scientific-object-store';
import type { ScientificCloudReplicaCommit } from './workspace-sync-scientific-commit';
import { runScientificHistoryInDedicatedWorker } from './scientific-history-worker-client';
import { acquireWorkspaceSyncDatabaseFence } from './workspace-sync-database-fence';
import { assertWorkspaceMutationLease } from './workspace-sync-mutation-lease';
import { forEachSyncFileBounded } from './workspace-sync-transfer-pool';
import {
  receiveWorkspaceSyncBlob,
  verifyWorkspaceSyncBlob,
  workspaceSyncBlobPath,
} from './workspace-sync-blob-cache';

export interface ScientificWorkspaceSyncHistoryCapture {
  readonly descriptor: ScientificCloudHistoryV1;
  readonly blobs: readonly BlobRef[];

  readonly blobSources: ReadonlyMap<string, string>;
  readonly currentFiles: readonly ScientificHistoryCurrentFile[];
}

export async function downloadScientificWorkspaceCloudHistory(input: {
  descriptor: ScientificCloudHistoryV1;
  blobs: readonly BlobRef[];
  downloadBlob: (blob: BlobRef, signal?: AbortSignal) => Promise<Response>;
  beforeBlob: () => Promise<void>;
  signal?: AbortSignal;
  cacheRoot?: string;
}): Promise<{ archive: Uint8Array; sources: readonly { blob: BlobRef; sourcePath: string }[] }> {
  const inventory = new Map<string, BlobRef>();
  for (const blob of [input.descriptor.archive, ...input.blobs]) {
    const previous = inventory.get(blob.hash);
    if (previous && previous.byteLength !== blob.byteLength)
      throw new Error('Scientific download repeats a digest with inconsistent lengths.');
    inventory.set(blob.hash, blob);
  }
  const sources = new Map<string, string>();
  await forEachSyncFileBounded([...inventory.values()], input.signal, async (blob, signal) => {
    await input.beforeBlob();
    const identity = { sha256: blob.hash.slice('sha256:'.length), sizeBytes: blob.byteLength };
    try {
      await verifyWorkspaceSyncBlob(identity, { signal, cacheRoot: input.cacheRoot });
    } catch (error) {
      signal.throwIfAborted();
      const response = await input.downloadBlob(blob, signal);
      if (!response.ok || !response.body)
        throw new Error('Scientific history download has no authorized bytes.');
      const body = response.body;
      const chunks = async function* (): AsyncGenerator<Uint8Array> {
        const reader = body.getReader();
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) return;
            yield chunk.value;
          }
        } finally {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      };
      await receiveWorkspaceSyncBlob(chunks(), identity, { signal, cacheRoot: input.cacheRoot });
    }
    await input.beforeBlob();
    sources.set(blob.hash, await workspaceSyncBlobPath(identity.sha256, input.cacheRoot));
  });
  input.signal?.throwIfAborted();
  return {
    archive: await readFile(sources.get(input.descriptor.archive.hash)!),
    sources: input.blobs.map((blob) => ({ blob, sourcePath: sources.get(blob.hash)! })),
  };
}

export async function captureScientificWorkspaceCloudHistory(
  db: Database.Database,
  input: {
    workspaceId: number;
    mutationLease: () => void;
    manifest?: WorkspaceSyncManifestV1;
    signal?: AbortSignal;
    cacheRoot?: string;
    purpose?: 'recovery';
  }
): Promise<ScientificWorkspaceSyncHistoryCapture> {
  const store = new ScientificObjectStore(db, input.workspaceId);
  assertWorkspaceMutationLease(input.mutationLease, store.workspaceRoot());
  if (db.inTransaction)
    throw new Error('Scientific cloud capture cannot borrow an open transaction.');
  const release = await acquireWorkspaceSyncDatabaseFence(db);
  try {
    const result = await runScientificHistoryInDedicatedWorker(
      {
        kind: 'export',
        databasePath: db.name,
        workspaceId: input.workspaceId,
        manifest: input.manifest,
        purpose: input.purpose,
      },
      { signal: input.signal }
    );
    if (result.kind !== 'exported')
      throw new Error('Scientific cloud capture returned another operation.');
    const sources = new Map<string, string>();
    for (const blob of [result.descriptor.archive, ...result.blobs]) {
      input.signal?.throwIfAborted();
      if (sources.has(blob.hash)) continue;
      const identity = { sha256: blob.hash.slice('sha256:'.length), sizeBytes: blob.byteLength };
      try {
        await verifyWorkspaceSyncBlob(identity, {
          signal: input.signal,
          cacheRoot: input.cacheRoot,
        });
      } catch {
        input.signal?.throwIfAborted();
        const bytes =
          blob.hash === result.descriptor.archive.hash ? result.archive : store.readBlob(blob);
        if (!bytes) throw new Error('Accepted scientific cloud bytes disappeared during capture.');
        await receiveWorkspaceSyncBlob([bytes], identity, {
          signal: input.signal,
          cacheRoot: input.cacheRoot,
        });
      }
      sources.set(blob.hash, await workspaceSyncBlobPath(identity.sha256, input.cacheRoot));
    }
    return {
      descriptor: result.descriptor,
      blobs: result.blobs,
      blobSources: sources,
      currentFiles: result.files,
    };
  } finally {
    release();
  }
}

export async function installScientificWorkspaceCloudHistory(
  db: Database.Database,
  input: {
    workspaceId: number;
    mutationLease: () => void;
    descriptor: ScientificCloudHistoryV1;
    archive: Uint8Array;
    sources: readonly { blob: BlobRef; sourcePath: string }[];
    manifest?: WorkspaceSyncManifestV1;
    blobRefs?: readonly BlobRef[];
    expectedHead: WorkspaceVersionId | null;
    remoteWorkspaceId?: string;
    binding?: { ownerAccountId: string; remoteWorkspaceId: string; baseVersionId: string | null };
    resolution?: 'fast-forward' | 'replace-and-retain' | 'retain-only';
    signal?: AbortSignal;
    beforeCommit: () => Promise<void>;
    replicaCommit?: ScientificCloudReplicaCommit;
    localRecovery?: Extract<
      import('./scientific-history-worker-job').ScientificHistoryWorkerJob,
      { kind: 'install' }
    >['localRecovery'];
  }
) {
  const commit = input.replicaCommit;
  const store =
    commit?.mode === 'restore'
      ? createScientificRestoreObjectStore(db, input.workspaceId, {
          workspaceUuid: commit.workspaceUuid,
          repoPath: commit.repoPath,
          ownerAccountId: commit.ownerAccountId,
          remoteWorkspaceId: commit.remote.workspaceId,
          remoteVersionId: commit.version.id,
          lockId: commit.restoreLockId!,
        })
      : new ScientificObjectStore(db, input.workspaceId);
  assertWorkspaceMutationLease(input.mutationLease, store.workspaceRoot());
  if (db.inTransaction)
    throw new Error('Scientific cloud installation cannot borrow an open transaction.');
  const release = await acquireWorkspaceSyncDatabaseFence(db);
  try {
    const result = await runScientificHistoryInDedicatedWorker(
      {
        kind: 'install',
        databasePath: db.name,
        workspaceId: input.workspaceId,
        descriptor: input.descriptor,
        archive: input.archive,
        sources: input.sources,
        manifest: input.manifest,
        blobRefs: input.blobRefs,
        expectedHead: input.expectedHead,
        remoteWorkspaceId: input.remoteWorkspaceId,
        binding: input.binding,
        resolution: input.resolution,
        replicaCommit: input.replicaCommit,
        localRecovery: input.localRecovery,
      },
      { signal: input.signal, beforeCommit: input.beforeCommit }
    );
    if (result.kind !== 'installed')
      throw new Error('Scientific cloud installation returned another operation.');
    return result.installation;
  } finally {
    release();
  }
}
