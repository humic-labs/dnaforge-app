import { preferCurrentThread } from './thread-scheduling.cjs';
import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parentPort } from 'node:worker_threads';
import Database from 'better-sqlite3';
import {
  describeScientificCloudHistory,
  serializeScientificHistory,
} from '@waypoint/scientific-objects';
import {
  ScientificObjectStore,
  createScientificRestoreObjectStore,
} from './scientific-object-store';
import { reconcileScientificNativeProjectionsInsideTx } from './scientific-native-projection';
import {
  commitScientificCloudReplicaInsideTx,
  activateScientificRestoreInsideTx,
} from './workspace-sync-scientific-commit';
import {
  validateScientificCloudManifest,
  scientificHistoryCurrentFiles,
} from '@waypoint/scientific-artifacts';
import type { BlobRef } from '@waypoint/workspace-revisions';
import type {
  ScientificHistoryWorkerJob,
  ScientificHistoryWorkerResponse,
} from './scientific-history-worker-job';
import { isWorkspaceSyncRemoteUuid } from './workspace-sync-remote-id';

preferCurrentThread('userInitiated');

if (!parentPort) throw new Error('Scientific history worker started without its native owner.');
const port = parentPort;
port.once('message', (job: ScientificHistoryWorkerJob) => {
  void execute(job).catch((error: unknown) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    post({ type: 'error', error: { name: normalized.name, message: normalized.message } });
  });
});

async function execute(job: ScientificHistoryWorkerJob): Promise<void> {
  if (
    !job ||
    !['export', 'install'].includes(job.kind) ||
    !Number.isSafeInteger(job.workspaceId) ||
    job.workspaceId < 1
  )
    throw new Error('Scientific history worker received an invalid owned job.');
  const db = new Database(job.databasePath, {
    readonly: job.kind === 'export',
    fileMustExist: true,
  });
  try {
    db.pragma('foreign_keys = ON');
    const commit = job.kind === 'install' ? job.replicaCommit : undefined;
    const store =
      commit?.mode === 'restore'
        ? createScientificRestoreObjectStore(db, job.workspaceId, {
            workspaceUuid: commit.workspaceUuid,
            repoPath: commit.repoPath,
            ownerAccountId: commit.ownerAccountId,
            remoteWorkspaceId: commit.remote.workspaceId,
            remoteVersionId: commit.version.id,
            lockId: commit.restoreLockId!,
          })
        : new ScientificObjectStore(db, job.workspaceId);
    if (job.kind === 'export') {
      const snapshot = db
        .transaction(() => {
          if (job.purpose === 'recovery' && job.manifest)
            throw new Error('Recovery history cannot claim accepted current-file binding.');
          if (store.pendingMaterializations().length && job.purpose !== 'recovery')
            throw new Error('Scientific history has unfinished local file delivery.');
          if (job.manifest) {
            const { graph, head } = store.read();
            validateScientificCloudManifest(graph, head, job.manifest);
          }
          const { graph, head } = store.read();
          return {
            history: store.exportHistory(),
            files: scientificHistoryCurrentFiles(graph, head),
          };
        })
        .deferred();
      const { history, files } = snapshot;
      const archive = serializeScientificHistory(history);
      const result = {
        kind: 'exported' as const,
        archive,
        descriptor: describeScientificCloudHistory(history),
        blobs: history.blobs,
        files,
      };
      db.close();
      port.postMessage({ type: 'result', result } satisfies ScientificHistoryWorkerResponse, [
        archive.buffer,
      ]);
      return;
    }
    if (job.localRecovery) {
      if (
        job.replicaCommit ||
        job.binding ||
        job.remoteWorkspaceId ||
        job.manifest ||
        (job.resolution && job.resolution !== 'fast-forward')
      )
        throw new Error('Local recovery cannot acknowledge a cloud version or claim its binding.');
      const receipt = JSON.parse(job.localRecovery.receiptJson) as Record<string, unknown>;
      if (
        job.localRecovery.receiptJson.length > 4096 ||
        receipt.schema !== 'dnaforge.scientific-local-recovery/v1' ||
        receipt.workspaceUuid !== job.localRecovery.workspaceUuid ||
        !isWorkspaceSyncRemoteUuid(receipt.workspaceUuid) ||
        !isWorkspaceSyncRemoteUuid(receipt.accountId) ||
        !isWorkspaceSyncRemoteUuid(receipt.remoteWorkspaceId) ||
        !isWorkspaceSyncRemoteUuid(receipt.candidateId) ||
        typeof receipt.contentSha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(receipt.contentSha256) ||
        typeof receipt.requestSha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(receipt.requestSha256) ||
        JSON.stringify(receipt.scientificHistory) !== JSON.stringify(job.descriptor)
      )
        throw new Error('Local scientific recovery receipt is invalid.');
    }
    const sources = new Map<string, { blob: BlobRef; sourcePath: string }>();
    for (const source of job.sources) {
      if (sources.has(source.blob.hash))
        throw new Error('Scientific history download has duplicate blob sources.');
      sources.set(source.blob.hash, source);
    }
    const prepared = store.prepareHistoryInstallation({
      archive: { descriptor: job.descriptor, bytes: job.archive },
      expectedHead: job.expectedHead,
      remoteWorkspaceId: job.remoteWorkspaceId,
      binding: job.binding,
      manifest: job.manifest,
      blobRefs: job.blobRefs,
      resolution: job.resolution,
      readBlob: (blob) => {
        const source = sources.get(blob.hash);
        if (!source || source.blob.byteLength !== blob.byteLength) return null;
        const fd = openSync(source.sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = fstatSync(fd);
          if (!stat.isFile() || stat.size !== blob.byteLength)
            throw new Error('Scientific history download has a different file length.');
          return readFileSync(fd);
        } finally {
          closeSync(fd);
        }
      },
    });

    const challenge = randomUUID();
    const permission = new Promise<void>((resolve, reject) => {
      port.once('message', (message: unknown) => {
        if (
          !message ||
          typeof message !== 'object' ||
          (message as { type?: unknown }).type !== 'commit' ||
          (message as { challenge?: unknown }).challenge !== challenge
        )
          reject(new Error('Scientific history owner did not admit this exact installation.'));
        else resolve();
      });
    });
    post({ type: 'prepared', challenge });
    await permission;
    const assertLocalRecoveryOwner = (): undefined => {
      if (job.localRecovery) {
        const target = db
          .prepare(
            'SELECT repo_uuid,path FROM workspaces WHERE id=? AND archived_at IS NULL AND trashed_at IS NULL'
          )
          .get(job.workspaceId) as { repo_uuid: string; path: string } | undefined;
        if (
          !target ||
          target.repo_uuid !== job.localRecovery.workspaceUuid ||
          target.path !== job.localRecovery.repoPath
        )
          throw new Error('Local scientific recovery target changed before adoption.');
        const key = `scientific-cloud-recovery:${job.workspaceId}`;
        const existing = db.prepare('SELECT value FROM settings WHERE key=?').get(key) as
          | { value: string }
          | undefined;
        if (existing && existing.value !== job.localRecovery.receiptJson)
          throw new Error('Local scientific recovery already belongs to another capture.');
        if (
          db
            .prepare('SELECT 1 FROM workspace_sync_bindings WHERE workspace_id=?')
            .get(job.workspaceId)
        )
          throw new Error('Local scientific recovery cannot replace a bound project.');
        if (
          !existing &&
          db
            .prepare('SELECT 1 FROM scientific_revision_records WHERE workspace_id=? LIMIT 1')
            .get(job.workspaceId)
        )
          throw new Error('Local scientific recovery cannot replace existing history.');
      }
      return undefined;
    };
    const installation = store.installPreparedHistory(
      prepared,
      () => {
        if (job.localRecovery) {
          db.prepare('INSERT OR IGNORE INTO settings(key,value,updated_at) VALUES (?,?,?)').run(
            `scientific-cloud-recovery:${job.workspaceId}`,
            job.localRecovery.receiptJson,
            Date.now()
          );
        }
        if (job.replicaCommit?.mode === 'restore')
          activateScientificRestoreInsideTx(db, job.workspaceId, job.replicaCommit);
        reconcileScientificNativeProjectionsInsideTx(db, job.workspaceId);
        if (job.replicaCommit) {
          if (!job.manifest || !job.blobRefs)
            throw new Error(
              'Scientific replica commit requires complete manifest and history inventory.'
            );
          commitScientificCloudReplicaInsideTx(
            db,
            job.workspaceId,
            job.replicaCommit,
            job.descriptor,
            job.manifest
          );
        }
        return undefined;
      },
      assertLocalRecoveryOwner
    );
    post({ type: 'result', result: { kind: 'installed', installation } });
  } finally {
    if (db.open) db.close();
  }
}

function post(response: ScientificHistoryWorkerResponse): void {
  port.postMessage(response);
}
