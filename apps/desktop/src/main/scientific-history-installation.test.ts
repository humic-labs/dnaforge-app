import { afterEach, describe, expect, it, vi } from 'vitest';
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, realpath, readdir, rename, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  workspaceSyncManifestHashInput,
  type WorkspaceSyncManifestV1,
} from '@waypoint/share-bundle';
import { join } from 'node:path';
import { build } from 'esbuild';
import { createFileTestDb, openFileTestDb } from './__tests__/test-db';
import { defineScientificDocument, serializeScientificHistory } from '@waypoint/scientific-objects';
import {
  parseOperationId,
  parseResourceId,
  parseWorkspacePath,
  type BlobRef,
} from '@waypoint/workspace-revisions';
import { exportCanonicalClosure } from '@waypoint/workspace-revisions/codec';
vi.mock('electron', () => ({
  app: { getPath: vi.fn(), getVersion: () => '1.0.0' },
  dialog: { showErrorBox: vi.fn() },
}));
const workerHarness = vi.hoisted(() => ({ load: null as null | (() => Promise<Worker>) }));
vi.mock('./scientific-history-worker-entry?nodeWorker', () => ({
  default: async () => {
    if (!workerHarness.load) throw new Error('No owned Node worker.');
    return workerHarness.load();
  },
}));
vi.mock('./analytics', () => ({ trackEvent: vi.fn() }));
import { ensureSchema } from './schema';
import { ScientificObjectStore } from './scientific-object-store';
import { runScientificHistoryInDedicatedWorker } from './scientific-history-worker-client';
import { workspaceSyncScientificContentSha256 } from './workspace-sync-scientific-history';
import {
  scientificCloudReplicaWasCommitted,
  type ScientificCloudReplicaCommit,
} from './workspace-sync-scientific-commit';
import { app } from 'electron';
import { describeScientificCloudHistory } from '@waypoint/scientific-objects';
import { restoreScientificWorkspaceFromCloudRecovery } from './scientific-cloud-recovery';
import {
  workspaceSyncRecoveryCandidateRequest,
  WORKSPACE_SYNC_RECOVERY_RETENTION_MS,
} from './workspace-sync-recovery-candidate';
import { acquireWorkspaceSyncMutationLease } from './workspace-sync-mutation-lease';
import { hasWorkingChanges, initManagedRepo } from './workspace-git';
import type { DesktopSyncClient } from './desktop-sync-client';
import { recoverMissingScientificRepo } from './scientific-missing-repo-recovery';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
const must = <T>(value: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!value.ok) throw new Error(JSON.stringify(value.error));
  return value.value;
};
const resourceId = must(parseResourceId('shared-primer'));
function profile(offset: number, uuid: string | null) {
  const file = createFileTestDb('scientific-history-profile');
  cleanups.push(file.cleanup);
  ensureSchema(file.db, file.dbPath);
  file.db
    .prepare('INSERT INTO workspaces (id,name,path,repo_uuid,created_at) VALUES (?,?,?,?,?)')
    .run(offset, 'Scientific history', `${file.tmpDir}/project`, uuid, 1);
  return { ...file, store: new ScientificObjectStore(file.db, offset), workspaceId: offset };
}
function save(f: ReturnType<typeof profile>, name: string, operation: string) {
  const before = f.store.read();
  const pin = before.reader.current(resourceId);
  const defined = defineScientificDocument({
    formatVersion: 1,
    kind: 'primer',
    name,
    molecule: 'DNA',
    bases: 'ACGT',
    modifications: [],
    fields: {},
  });
  const result = f.store.submit({
    expectedHead: before.head,
    operationId: must(parseOperationId(operation)),
    blobs: [new TextEncoder().encode(defined.text)],
    mutations: [
      pin
        ? {
            kind: 'edit-resource',
            resourceId,
            expectedRevision: pin.revisionId,
            state: defined.state,
          }
        : {
            kind: 'create-resource',
            resourceId,
            path: must(parseWorkspacePath('primer.json')),
            state: defined.state,
            origin: { kind: 'created' },
          },
    ],
  });
  if (result.kind !== 'changed') throw new Error('Fixture Save did not accept.');

  f.db.prepare("UPDATE scientific_materialization_jobs SET status='succeeded'").run();
  return result.version.id;
}
const transfer = (from: ReturnType<typeof profile>, to: ReturnType<typeof profile>) =>
  to.store.installHistory({
    envelope: from.store.exportHistory(),
    expectedHead: to.store.read().head,
    readBlob: (blob: BlobRef) => from.store.readBlob(blob),
  });
const settle = (f: ReturnType<typeof profile>) =>
  f.db.prepare("UPDATE scientific_materialization_jobs SET status='succeeded'").run();

async function buildOwnedNodeWorker(directory: string) {
  const require = createRequire(import.meta.url);
  const workerEntry = join(directory, 'scientific-history-worker.cjs');
  await build({
    entryPoints: [join(import.meta.dirname, 'scientific-history-worker-entry.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: workerEntry,
    plugins: [
      {
        name: 'native-node-dependencies',
        setup(builder) {
          builder.onResolve({ filter: /^electron$/ }, () => ({
            path: 'electron',
            namespace: 'native-test-electron',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'native-test-electron' }, () => ({
            contents: `export const app = { getPath: () => ${JSON.stringify(directory)}, getVersion: () => '1.0.0', isPackaged: false };
              export const dialog = { showErrorBox() {} };
              export const shell = { openPath: async () => '', openExternal: async () => {} };`,
            loader: 'js',
          }));
          builder.onResolve({ filter: /^dugite$/ }, (args) => ({
            path: require.resolve(args.path),
            external: true,
          }));

          builder.onResolve({ filter: /^better-sqlite3$/ }, () => ({
            path: 'sqlite-node-binding',
            namespace: 'native-test-binding',
          }));
          builder.onResolve({ filter: /.*/, namespace: 'native-test-binding' }, (args) => ({
            path: args.path,
            external: true,
          }));
          builder.onLoad({ filter: /.*/, namespace: 'native-test-binding' }, () => ({
            contents: `const Database = require(${JSON.stringify(require.resolve('better-sqlite3'))});
             module.exports = class extends Database {
               constructor(path, options) { super(path, { ...options, nativeBinding: ${JSON.stringify(join(import.meta.dirname, '__tests__/__fixtures__/better_sqlite3_node.node'))} }); }
             };`,
            loader: 'js',
          }));
        },
      },
    ],
  });
  return async () => new Worker(workerEntry);
}

describe('atomic scientific history installation on independent real SQLite profiles', () => {
  it('preserves a file edited during missing-root reconstruction and withholds completion', async () => {
    const f = profile(19, '31da3243-0000-4000-8000-000000000019');
    save(f, 'Retained primer', 'missing-repo-concurrent-edit');
    const managed = await realpath(f.tmpDir),
      container = join(managed, '31da3243-0000-4000-8000-000000000019'),
      root = join(container, 'repo');
    await mkdir(container, { recursive: true });
    f.db.prepare('UPDATE workspaces SET path=? WHERE id=?').run(root, f.workspaceId);
    const before = f.store.exportHistory();
    await expect(
      recoverMissingScientificRepo(f.db, {
        workspaceId: f.workspaceId,
        workspaceUuid: '31da3243-0000-4000-8000-000000000019',
        repoPath: root,
        managedRootDir: managed,
        beforeFinalValidation: () =>
          writeFile(join(root, 'primer.json'), 'Concurrent working edit'),
      })
    ).rejects.toThrow('working files changed');
    expect(await readFile(join(root, 'primer.json'), 'utf8')).toBe('Concurrent working edit');
    expect(f.store.exportHistory()).toEqual(before);
    expect(
      f.db
        .prepare('SELECT value FROM settings WHERE key=?')
        .get(`scientific-missing-repo-recovery:${f.workspaceId}`)
    ).toBeTruthy();
  });
  it('refuses a recreated recovery root with foreign Git storage before mutating it', async () => {
    const f = profile(18, '31da3243-0000-4000-8000-000000000018');
    save(f, 'Retained primer', 'missing-repo-foreign-git');
    const managed = await realpath(f.tmpDir),
      container = join(managed, '31da3243-0000-4000-8000-000000000018'),
      root = join(container, 'repo');
    await mkdir(container, { recursive: true });
    f.db.prepare('UPDATE workspaces SET path=? WHERE id=?').run(root, f.workspaceId);
    const request = {
      workspaceId: f.workspaceId,
      workspaceUuid: '31da3243-0000-4000-8000-000000000018',
      repoPath: root,
      managedRootDir: managed,
    };
    await expect(
      recoverMissingScientificRepo(f.db, {
        ...request,
        beforePublishRoot() {
          throw Error('interrupt after durable owner before root publication');
        },
      })
    ).rejects.toThrow('interrupt after durable owner before root publication');
    await expect(
      recoverMissingScientificRepo(f.db, {
        ...request,
        beforeWrite() {
          throw Error('interruption');
        },
      })
    ).rejects.toThrow('interruption');
    await rename(root, join(container, 'interrupted-root-preserved'));
    await mkdir(root);
    const foreign = join(managed, 'foreign-git');
    await mkdir(foreign);
    await writeFile(join(foreign, 'HEAD'), 'untouched');
    await symlink(foreign, join(root, '.git'));
    await expect(recoverMissingScientificRepo(f.db, request)).rejects.toThrow(
      'recreated repository'
    );
    expect(await readFile(join(foreign, 'HEAD'), 'utf8')).toBe('untouched');
    expect(await readdir(foreign)).toEqual(['HEAD']);
  });
  it('resumes an interrupted missing repository rebuild without changing accepted history or overwriting edits', async () => {
    const f = profile(17, '31da3243-0000-4000-8000-000000000017');
    save(f, 'Retained primer', 'missing-repo-save');
    const managed = await realpath(f.tmpDir);
    const container = join(managed, '31da3243-0000-4000-8000-000000000017');
    const root = join(container, 'repo');
    await mkdir(root, { recursive: true });
    f.db.prepare('UPDATE workspaces SET path=? WHERE id=?').run(root, f.workspaceId);
    await writeFile(join(root, 'original-evidence.txt'), 'Retain this original root');
    await rename(root, join(container, 'original-root-preserved'));
    const before = f.store.exportHistory();
    const request = {
      workspaceId: f.workspaceId,
      workspaceUuid: '31da3243-0000-4000-8000-000000000017',
      repoPath: root,
      managedRootDir: managed,
    };
    await expect(
      recoverMissingScientificRepo(f.db, {
        ...request,
        beforeWrite() {
          throw Error('interrupt before first accepted file');
        },
      })
    ).rejects.toThrow('interrupt before first accepted file');
    expect(f.store.exportHistory()).toEqual(before);
    await recoverMissingScientificRepo(f.db, request);
    expect(f.store.exportHistory()).toEqual(before);
    const saved = f.store.read().reader.current(resourceId)!;
    expect(
      (JSON.parse(await readFile(join(root, 'primer.json'), 'utf8')) as { name: string }).name
    ).toBe('Retained primer');
    expect(
      await readFile(join(container, 'original-root-preserved', 'original-evidence.txt'), 'utf8')
    ).toBe('Retain this original root');
    await recoverMissingScientificRepo(f.db, request);
    expect(f.store.read().reader.current(resourceId)?.revisionId).toBe(saved.revisionId);
    await writeFile(join(root, 'primer.json'), 'Keep my working edit');
    await expect(recoverMissingScientificRepo(f.db, request)).rejects.toThrow('cannot overwrite');
    expect(await readFile(join(root, 'primer.json'), 'utf8')).toBe('Keep my working edit');
    expect(f.store.exportHistory()).toEqual(before);
  });
  it('resumes interrupted private recovery into the same local project and preserves captured drafts separately', async () => {
    const source = profile(7, null),
      receiver = profile(91, '31da3243-0000-4000-8000-000000000091');
    save(source, 'Original', 'private-recovery-create');
    const original = source.store.exportHistory();
    const descriptor = describeScientificCloudHistory(original);
    const archive = serializeScientificHistory(original);
    const draft = new TextEncoder().encode('Unaccepted working metadata');
    const digest = createHash('sha256').update(draft).digest('hex');
    const request = {
      remoteWorkspaceId: '31da3243-0000-4000-8000-000000000001',
      ownerAccountId: '31da3243-0000-4000-8000-000000000002',
      baseVersionId: null,
      reason: 'dirty' as const,
      manifest: {
        schemaVersion: 1 as const,
        files: [
          {
            path: 'primer.json',
            contentSha256: digest,
            sizeBytes: draft.byteLength,
            contentType: 'application/json',
          },
        ],
      },
      scientificHistory: descriptor,
      scientificBlobRefs: original.blobs,
    };
    const normalized = workspaceSyncRecoveryCandidateRequest({
      ...request,
      fileManifestSha256: createHash('sha256')
        .update(workspaceSyncManifestHashInput(request.manifest))
        .digest('hex'),
    });
    const now = Date.now();
    const candidate = {
      id: '31da3243-0000-4000-8000-000000000003',
      accountId: request.ownerAccountId,
      ...normalized.body,
      ...normalized.scientific,
      contentSha256: normalized.contentSha256,
      requestSha256: normalized.requestSha256,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + WORKSPACE_SYNC_RECOVERY_RETENTION_MS).toISOString(),
      coverage: 'captured-bytes',
    };
    const detail = {
      workspaceId: request.remoteWorkspaceId,
      candidate,
      manifest: request.manifest,
      resourceIdentities: normalized.body.resourceIdentities,
      excludedSummary: normalized.body.excludedSummary,
      missingPaths: [],
    };
    const bytes = new Map(
      original.blobs.map((blob) => [blob.hash.slice(7), source.store.readBlob(blob)!])
    );
    bytes.set(descriptor.archive.hash.slice(7), archive);
    let reads = 0;
    const client: DesktopSyncClient = {
      assertAccount: async (account) => {
        expect(account).toBe(request.ownerAccountId);
      },
      requestJson: async <T>() => detail as T,
      requestStream: async (path) => {
        reads++;
        return new Response(path.includes('/files?') ? draft : bytes.get(path.split('/').at(-1)!)!);
      },
    };
    const root = join(receiver.tmpDir, 'project');
    await mkdir(root);
    const canonical = await realpath(root);
    receiver.db.prepare('UPDATE workspaces SET path=? WHERE id=91').run(canonical);
    await initManagedRepo(canonical);
    vi.mocked(app.getPath).mockReturnValue(receiver.tmpDir);
    const load = await buildOwnedNodeWorker(receiver.tmpDir);
    const lostReplyWorker = join(receiver.tmpDir, 'scientific-recovery-lost-reply.cjs');
    await writeFile(
      lostReplyWorker,
      `const ownedPort = require('node:worker_threads').parentPort;
      const sendOwned = ownedPort.postMessage.bind(ownedPort);
      ownedPort.postMessage = (message, ...args) => {
        if (message.type === 'result' && message.result.kind === 'installed') throw new Error('scientific recovery reply lost');
        return sendOwned(message, ...args);
      };
      require(${JSON.stringify(join(receiver.tmpDir, 'scientific-history-worker.cjs'))});`
    );
    workerHarness.load = async () => new Worker(lostReplyWorker);
    const release = await acquireWorkspaceSyncMutationLease(canonical);
    const input = {
      workspaceId: 91,
      mutationLease: release,
      client,
      context: {
        workspaceId: request.remoteWorkspaceId,
        candidateId: candidate.id,
        accountId: request.ownerAccountId,
      },
    };
    try {
      await expect(restoreScientificWorkspaceFromCloudRecovery(receiver.db, input)).rejects.toThrow(
        'scientific recovery reply lost'
      );
      expect(receiver.store.catalog().head).toBe(source.store.catalog().head);
      expect(
        receiver.db
          .prepare('SELECT 1 FROM settings WHERE key=?')
          .get('scientific-cloud-recovery:91')
      ).toBeDefined();
      expect(
        receiver.db.prepare('SELECT 1 FROM workspace_sync_bindings WHERE workspace_id=91').get()
      ).toBeUndefined();
      workerHarness.load = load;
      const restored = await restoreScientificWorkspaceFromCloudRecovery(receiver.db, input);
      expect(restored.state).toBe('restored');
      if (restored.state !== 'restored') throw new Error('Recovery delivery remains pending.');
      expect(await readFile(join(canonical, 'primer.json'))).toEqual(
        Buffer.from(source.store.readBlob(original.blobs[0]!)!)
      );
      expect(await readFile(join(restored.draftsPath, 'files/primer.json'))).toEqual(
        Buffer.from(draft)
      );
      const previousReads = reads;
      await writeFile(join(canonical, 'local-notes.txt'), 'Unrelated working notes');
      const repeated = await restoreScientificWorkspaceFromCloudRecovery(receiver.db, input);
      expect(repeated).toEqual(restored);
      expect(reads).toBe(previousReads);
      expect(await hasWorkingChanges(canonical)).toBe(true);
      expect(await readdir(join(receiver.tmpDir, 'scientific-recovery-drafts'))).toHaveLength(1);
      await writeFile(join(restored.draftsPath, 'files/primer.json'), 'User draft edit');
      await expect(restoreScientificWorkspaceFromCloudRecovery(receiver.db, input)).rejects.toThrow(
        'draft was edited'
      );
      expect(await readFile(join(restored.draftsPath, 'files/primer.json'), 'utf8')).toBe(
        'User draft edit'
      );
      await writeFile(join(canonical, 'primer.json'), 'Unaccepted local edit');
      await expect(restoreScientificWorkspaceFromCloudRecovery(receiver.db, input)).rejects.toThrow(
        'project has working edits'
      );
      expect(await readFile(join(canonical, 'primer.json'), 'utf8')).toBe('Unaccepted local edit');
      expect(source.store.exportHistory()).toEqual(original);
    } finally {
      release();
      workerHarness.load = null;
    }
  });
  it('exports and installs through real worker threads after a fresh native authorization check', async () => {
    const source = profile(7, null),
      receiver = profile(91, 'receiver');
    save(source, 'Original', 'worker-source-create');
    const loadWorker = await buildOwnedNodeWorker(receiver.tmpDir);
    const workerEntry = join(receiver.tmpDir, 'scientific-history-worker.cjs');
    source.db
      .prepare("UPDATE scientific_materialization_jobs SET status='pending' WHERE workspace_id=7")
      .run();
    await expect(
      runScientificHistoryInDedicatedWorker(
        { kind: 'export', databasePath: source.dbPath, workspaceId: 7 },
        { loadWorker }
      )
    ).rejects.toThrow('unfinished local file delivery');
    const recoveryExport = await runScientificHistoryInDedicatedWorker(
      { kind: 'export', databasePath: source.dbPath, workspaceId: 7, purpose: 'recovery' },
      { loadWorker }
    );
    expect(recoveryExport).toMatchObject({
      kind: 'exported',
      descriptor: { acceptedHead: source.store.read().head },
    });
    settle(source);
    const exported = await runScientificHistoryInDedicatedWorker(
      { kind: 'export', databasePath: source.dbPath, workspaceId: source.workspaceId },
      { loadWorker }
    );
    if (exported.kind !== 'exported') throw new Error('Worker exported another job.');
    expect(exported.descriptor.acceptedHead).toBe(source.store.read().head);
    const sources = await Promise.all(
      exported.blobs.map(async (blob) => {
        const sourcePath = join(receiver.tmpDir, blob.hash.slice('sha256:'.length));
        await writeFile(sourcePath, source.store.readBlob(blob)!);
        return { blob, sourcePath };
      })
    );
    let admitted = 0;
    const installed = await runScientificHistoryInDedicatedWorker(
      {
        kind: 'install',
        databasePath: receiver.dbPath,
        workspaceId: receiver.workspaceId,
        archive: exported.archive,
        descriptor: exported.descriptor,
        sources,
        expectedHead: null,
        remoteWorkspaceId: '31da3243-0000-4000-8000-000000000001',
      },
      {
        loadWorker,
        beforeCommit: async () => {
          expect(receiver.store.read().head).toBeNull();
          admitted++;
        },
      }
    );
    expect(admitted).toBe(1);
    expect(installed).toMatchObject({ kind: 'installed', installation: { kind: 'adopted' } });
    expect(receiver.store.read().reader.current(resourceId)).toEqual(
      source.store.read().reader.current(resourceId)
    );
    expect(receiver.store.exportHistory().graph.workspaceId).toBe('ws7');

    const atomic = profile(92, '31da3243-0000-4000-8000-000000000092');
    const repoPath = join(atomic.tmpDir, 'project');
    await mkdir(repoPath);
    const blob = exported.blobs[0]!;
    await writeFile(join(repoPath, 'primer.json'), source.store.readBlob(blob)!);
    const manifest: WorkspaceSyncManifestV1 = {
      schemaVersion: 1,
      files: [
        {
          path: 'primer.json',
          contentSha256: blob.hash.slice('sha256:'.length),
          sizeBytes: blob.byteLength,
          contentType: 'application/json',
        },
      ],
    };
    const fileSha = createHash('sha256')
      .update(workspaceSyncManifestHashInput(manifest))
      .digest('hex');
    const version = {
      id: '31da3243-0000-4000-8000-000000000101',
      versionNumber: 1,
      representation: 'scientific_manifest_v1' as const,
      contentSha256: workspaceSyncScientificContentSha256(fileSha, exported.descriptor),
      fileManifestSha256: fileSha,
      sizeBytes: blob.byteLength,
      fileCount: 1,
      manifestSchemaVersion: 1 as const,
      createdAt: '2026-10-13T00:00:00.000Z',
      finalizedAt: '2026-10-13T00:00:01.000Z',
    };
    const accountId = '31da3243-0000-4000-8000-000000000099';
    const remote = {
      workspaceId: '31da3243-0000-4000-8000-000000000001',
      clientWorkspaceId: 'source',
      displayName: 'Retained scientific project',
      owner: { kind: 'personal' as const, accountId },
      latest: { versionId: version.id, versionNumber: 1, contentSha256: version.contentSha256 },
      storageBytesUsed: blob.byteLength,
      versionCount: 1,
      updatedAt: version.finalizedAt,
      lastSeenAt: version.finalizedAt,
      deviceId: 'source-device',
    };
    const replicaCommit: ScientificCloudReplicaCommit = {
      mode: 'restore',
      workspaceUuid: '31da3243-0000-4000-8000-000000000092',
      repoPath,
      ownerAccountId: accountId,
      remote,
      version,
      baseVersionId: null,
      baseVersionNumber: null,
      localHeadSha: '1'.repeat(40),
      installedPaths: ['primer.json'],
      excludedSummary: {},
      nowMs: 2,
      restoreLockId: 'owned-scientific-restore',
    };
    atomic.db
      .prepare(
        `INSERT INTO workspace_sync_restore_locks (workspace_id,lock_id,source_remote_version_id,remote_workspace_id,owner_account_id,status,started_at,expires_at)
      VALUES (92,?,?,?,?, 'restoring',1,9999999999999)`
      )
      .run(replicaCommit.restoreLockId, version.id, remote.workspaceId, accountId);
    atomic.db.prepare('UPDATE workspaces SET archived_at=1 WHERE id=92').run();
    expect(() => new ScientificObjectStore(atomic.db, 92)).toThrow('not registered');
    const job = {
      kind: 'install' as const,
      databasePath: atomic.dbPath,
      workspaceId: 92,
      archive: exported.archive,
      descriptor: exported.descriptor,
      sources,
      expectedHead: null,
      remoteWorkspaceId: remote.workspaceId,
      manifest,
      blobRefs: exported.blobs,
      replicaCommit,
    };
    atomic.db.exec(
      "CREATE TRIGGER scientific_cloud_commit_fault BEFORE INSERT ON workspace_sync_versions BEGIN SELECT RAISE(ABORT,'cloud acceptance interrupted'); END"
    );
    let scientificCommitAdmittedAtMs = 0;
    const beforeScientificCommit = async () => {
      expect(
        atomic.db
          .prepare(
            'SELECT lock_id,status,started_at,completed_at FROM workspace_sync_restore_locks WHERE workspace_id=92'
          )
          .get()
      ).toEqual({
        lock_id: replicaCommit.restoreLockId,
        status: 'restoring',
        started_at: 1,
        completed_at: null,
      });
      scientificCommitAdmittedAtMs = Date.now();
    };
    await expect(
      runScientificHistoryInDedicatedWorker(job, {
        loadWorker,
        beforeCommit: beforeScientificCommit,
      })
    ).rejects.toThrow('cloud acceptance interrupted');
    expect(() => atomic.store.read()).toThrow('not registered');
    expect(atomic.db.prepare('SELECT archived_at FROM workspaces WHERE id=92').get()).toEqual({
      archived_at: 1,
    });
    for (const table of [
      'scientific_revision_records',
      'scientific_revision_blobs',
      'workspace_sync_bindings',
      'workspace_sync_versions',
    ])
      expect(
        atomic.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE workspace_id=92`).get()
      ).toEqual({ n: 0 });
    expect(await readFile(join(repoPath, 'primer.json'))).toEqual(
      Buffer.from(source.store.readBlob(blob)!)
    );
    atomic.db.exec('DROP TRIGGER scientific_cloud_commit_fault');
    await expect(
      runScientificHistoryInDedicatedWorker(job, {
        loadWorker,
        beforeCommit: beforeScientificCommit,
      })
    ).resolves.toMatchObject({ kind: 'installed', installation: { kind: 'adopted' } });
    expect(
      scientificCloudReplicaWasCommitted(atomic.db, 92, replicaCommit, exported.descriptor)
    ).toBe(true);
    expect(
      atomic.db
        .prepare(
          'SELECT status,started_at,completed_at FROM workspace_sync_restore_locks WHERE workspace_id=92'
        )
        .get()
    ).toEqual({ status: 'completed', started_at: 1, completed_at: expect.any(Number) });
    const scientificCompletedAtMs = atomic.db
      .prepare('SELECT completed_at FROM workspace_sync_restore_locks WHERE workspace_id=92')
      .pluck()
      .get();
    expect(scientificCompletedAtMs).toBeGreaterThanOrEqual(scientificCommitAdmittedAtMs);
    expect(scientificCompletedAtMs).toBeLessThanOrEqual(Date.now());
    expect(atomic.store.pendingMaterializations()).toEqual([]);

    const notes = Buffer.from('Independent project note');
    await writeFile(join(repoPath, 'notes.md'), notes);
    const nextManifest: WorkspaceSyncManifestV1 = {
      ...manifest,
      files: [
        ...manifest.files,
        {
          path: 'notes.md',
          contentSha256: createHash('sha256').update(notes).digest('hex'),
          sizeBytes: notes.length,
          contentType: 'text/markdown',
        },
      ],
    };
    const nextSha = createHash('sha256')
      .update(workspaceSyncManifestHashInput(nextManifest))
      .digest('hex');
    const nextCommit: ScientificCloudReplicaCommit = {
      ...replicaCommit,
      mode: 'apply',
      restoreLockId: undefined,
      baseVersionId: version.id,
      baseVersionNumber: 1,
      localHeadSha: '2'.repeat(40),
      installedPaths: ['primer.json', 'notes.md'],
      version: {
        ...version,
        id: '31da3243-0000-4000-8000-000000000102',
        versionNumber: 2,
        fileManifestSha256: nextSha,
        contentSha256: workspaceSyncScientificContentSha256(nextSha, exported.descriptor),
        fileCount: 2,
        sizeBytes: blob.byteLength + notes.length,
      },
    };
    const lostReplyWorker = join(atomic.tmpDir, 'scientific-lost-reply.cjs');
    await writeFile(
      lostReplyWorker,
      `const ownedPort = require('node:worker_threads').parentPort;
      const sendOwned = ownedPort.postMessage.bind(ownedPort);
      ownedPort.postMessage = (message, ...args) => {
        if (message.type === 'result' && message.result.kind === 'installed') throw new Error('scientific commit reply lost');
        return sendOwned(message, ...args);
      };\n` + (await readFile(workerEntry, 'utf8'))
    );
    await expect(
      runScientificHistoryInDedicatedWorker(
        {
          ...job,
          expectedHead: exported.descriptor.acceptedHead,
          manifest: nextManifest,
          replicaCommit: nextCommit,
          binding: {
            ownerAccountId: accountId,
            remoteWorkspaceId: remote.workspaceId,
            baseVersionId: version.id,
          },
        },
        { loadWorker: async () => new Worker(lostReplyWorker), beforeCommit: async () => {} }
      )
    ).rejects.toThrow('scientific commit reply lost');
    expect(scientificCloudReplicaWasCommitted(atomic.db, 92, nextCommit, exported.descriptor)).toBe(
      true
    );
    expect(atomic.store.read().head).toBe(exported.descriptor.acceptedHead);
    expect(await readFile(join(repoPath, 'notes.md'))).toEqual(notes);
  });

  it('requires its owning validated capability and preserves frozen bytes between preparation and acceptance', () => {
    const source = profile(7, null),
      receiver = profile(91, 'receiver'),
      foreign = profile(92, 'foreign');
    save(source, 'Original', 'prepared-source-create');
    const envelope = source.store.exportHistory();
    const bytes = new Map(
      envelope.blobs.map((blob) => [blob.hash, new Uint8Array(source.store.readBlob(blob)!)])
    );
    const prepared = receiver.store.prepareHistoryInstallation({
      envelope,
      expectedHead: null,
      readBlob: (blob) => bytes.get(blob.hash) ?? null,
    });
    expect(receiver.store.read().head).toBeNull();
    expect(
      receiver.db.prepare('SELECT count(*) AS n FROM scientific_revision_records').get()
    ).toEqual({ n: 0 });
    expect(() => receiver.store.installPreparedHistory({} as never)).toThrow(/not validated/);
    expect(() => foreign.store.installPreparedHistory(prepared)).toThrow(/database owner/);
    for (const value of bytes.values()) value.fill(0);
    expect(receiver.store.installPreparedHistory(prepared).kind).toBe('adopted');
    expect(receiver.store.read().reader.current(resourceId)).toEqual(
      source.store.read().reader.current(resourceId)
    );
    expect(() => receiver.store.installPreparedHistory(prepared)).toThrow(/not validated/);
  });

  it('refuses a prepared installation after its cloud binding is disabled without installing any authority', () => {
    const source = profile(7, null),
      receiver = profile(91, 'receiver');
    save(source, 'Original', 'binding-source-create');
    const remoteWorkspaceId = '31da3243-0000-4000-8000-000000000001';
    receiver.db
      .prepare(
        `INSERT INTO workspace_sync_bindings
      (workspace_id,workspace_uuid,owner_account_id,remote_workspace_id,enabled,created_at,updated_at)
      VALUES (91,'receiver','owner',?,1,1,1)`
      )
      .run(remoteWorkspaceId);
    const prepared = receiver.store.prepareHistoryInstallation({
      envelope: source.store.exportHistory(),
      expectedHead: null,
      remoteWorkspaceId,
      binding: { ownerAccountId: 'owner', remoteWorkspaceId, baseVersionId: null },
      readBlob: (blob) => source.store.readBlob(blob),
    });
    receiver.db.prepare('UPDATE workspace_sync_bindings SET enabled=0 WHERE workspace_id=91').run();
    expect(() => receiver.store.installPreparedHistory(prepared)).toThrow(/binding changed/);
    expect(receiver.store.read().head).toBeNull();
    for (const table of [
      'scientific_workspace_identities',
      'scientific_revision_records',
      'scientific_revision_refs',
      'scientific_revision_blobs',
      'scientific_materialization_jobs',
    ])
      expect(receiver.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
  });

  it('preserves legacy ws<N> identity, exact records and blobs under a different local workspace ID and after restart', () => {
    const source = profile(7, null),
      receiver = profile(91, 'receiver-local-repository');
    save(source, 'Original primer', 'source-create');
    save(source, 'Reviewed primer', 'source-review');
    const before = source.store.exportHistory();
    expect(transfer(source, receiver).kind).toBe('adopted');
    expect(receiver.store.read().head).toBe(source.store.read().head);
    expect(receiver.store.read().reader.current(resourceId)).toEqual(
      source.store.read().reader.current(resourceId)
    );
    expect(receiver.store.exportHistory().graph.workspaceId).toBe('ws7');
    expect(receiver.db.prepare('SELECT repo_uuid FROM workspaces WHERE id=91').get()).toEqual({
      repo_uuid: 'receiver-local-repository',
    });
    const records = receiver.store.exportHistory().graph.records;
    expect(records).toEqual(before.graph.records);
    for (const blob of before.blobs)
      expect(receiver.store.readBlob(blob)).toEqual(source.store.readBlob(blob));
    for (const job of receiver.store.pendingMaterializations())
      receiver.store.validateMaterialization(job, JSON.parse(job.manifest_json));
    settle(receiver);
    receiver.db.close();
    const restarted = openFileTestDb(receiver.dbPath);
    try {
      expect(new ScientificObjectStore(restarted, 91).exportHistory().graph.records).toEqual(
        records
      );
    } finally {
      restarted.close();
    }
  });
  it('retains a remote successor without adopting it when local history was explicitly selected', () => {
    const source = profile(7, null),
      receiver = profile(91, 'receiver');
    const localHead = save(source, 'Original', 'keep-local-base');
    transfer(source, receiver);
    settle(receiver);
    const before = receiver.store.exportHistory();
    save(source, 'Remote update', 'keep-local-remote');
    const incoming = source.store.exportHistory();
    const retained = receiver.store.installHistory({
      envelope: incoming,
      expectedHead: localHead,
      resolution: 'retain-only',
      readBlob: (blob) => source.store.readBlob(blob),
    });
    expect(retained).toMatchObject({
      kind: 'retained',
      head: localHead,
      incomingHead: source.store.read().head,
    });
    expect(receiver.store.read().reader.current(resourceId)?.document).toMatchObject({
      name: 'Original',
    });
    expect(receiver.store.pendingMaterializations()).toEqual([]);
    const after = new Map(
      receiver.store.exportHistory().graph.records.map((record) => [record.id, record])
    );
    for (const record of [...before.graph.records, ...incoming.graph.records])
      expect(after.get(record.id)).toEqual(record);
    for (const blob of incoming.blobs)
      expect(receiver.store.readBlob(blob)).toEqual(source.store.readBlob(blob));
  });

  it('retains both divergent branches and permits an explicit replacement without deleting the local history', () => {
    const source = profile(7, null),
      receiver = profile(91, 'receiver');
    save(source, 'Original', 'source-create');
    transfer(source, receiver);
    settle(receiver);
    const local = save(receiver, 'Local review', 'receiver-review');
    const remote = save(source, 'Remote review', 'source-review');
    const rejected = transfer(source, receiver);
    expect(rejected).toMatchObject({
      kind: 'conflict',
      head: local,
      incomingHead: remote,
      reason: 'diverged',
    });
    expect(receiver.store.read().reader.current(resourceId)?.document).toMatchObject({
      name: 'Local review',
    });
    const all = exportCanonicalClosure(receiver.store.read().graph);
    expect(all.records.some((record) => record.id === remote)).toBe(true);
    const resolved = receiver.store.installHistory({
      envelope: source.store.exportHistory(),
      readBlob: (blob) => source.store.readBlob(blob),
      expectedHead: local,
      resolution: 'replace-and-retain',
    });
    expect(resolved.kind).toBe('adopted');
    expect(receiver.store.read().head).toBe(remote);
    expect(receiver.store.exportHistory().graph.refs).toContainEqual({
      name: `preserved/${local}`,
      head: local,
    });
  });
  it('leaves the database byte authority unchanged after missing bytes or a failed projection', () => {
    const source = profile(7, null),
      receiver = profile(91, 'receiver');
    save(source, 'Original', 'source-create');
    const before = serializeScientificHistory(receiver.store.exportHistory());
    expect(() =>
      receiver.store.installHistory({
        envelope: source.store.exportHistory(),
        expectedHead: null,
        readBlob: () => null,
      })
    ).toThrow('blob unavailable');
    expect(serializeScientificHistory(receiver.store.exportHistory())).toEqual(before);
    expect(() =>
      receiver.store.installHistory(
        {
          envelope: source.store.exportHistory(),
          expectedHead: null,
          readBlob: (blob) => source.store.readBlob(blob),
        },
        () => {
          throw new Error('Registry collision');
        }
      )
    ).toThrow('Registry collision');
    expect(serializeScientificHistory(receiver.store.exportHistory())).toEqual(before);
    expect(receiver.store.pendingMaterializations()).toEqual([]);
    expect(receiver.db.prepare('SELECT * FROM scientific_workspace_identities').all()).toEqual([]);
  });
});
