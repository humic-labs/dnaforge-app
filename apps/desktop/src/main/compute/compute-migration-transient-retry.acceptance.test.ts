import * as fs from 'node:fs';
import * as git from 'isomorphic-git';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ComputeJobRecord, ComputeRecoveryResult } from '../../shared/compute-jobs-ipc';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => '1.0.0' },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('../analytics', () => ({ trackEvent: vi.fn() }));

import { createFileTestDb } from '../__tests__/test-db';
import { ensureSchema } from '../schema';
import { ComputeJobRegistry } from './jobs';
import { recoverComputeResult } from '../workspace-git/compute-result-recovery';
import { inventoryComputeSource } from '../workspace-git/compute-result-retention';
import { createRegisteredProjectAuthority } from '../registered-project-authority';
import { NativeDocumentWorkspaces } from '../native-document-workspaces';
import { createNativeFileDocuments } from '../native-file-documents';
import { acquireWorkspaceSyncDatabaseFence } from '../workspace-sync-database-fence';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const run of cleanup.splice(0).reverse()) run();
});

async function fixture() {
  const file = createFileTestDb('compute-transient-owner-retry');
  cleanup.push(file.cleanup);
  const db = file.db;
  let currentProfileDb = db;
  ensureSchema(db, file.dbPath);
  const root = join(realpathSync(file.tmpDir), 'project');
  const source = join(root, 'compute/boltz/remote-1');
  mkdirSync(join(source, 'empty'), { recursive: true });
  writeFileSync(join(source, '.receipt'), 'historical provider source');
  writeFileSync(join(source, 'data.bin'), Buffer.from([0, 255, 128]));
  writeFileSync(
    join(source, 'model.pdb'),
    'HEADER    TRANSIENT RECOVERY\nATOM      1  CA  ALA A   1\nEND\n'
  );
  writeFileSync(
    join(source, 'result.gb'),
    'LOCUS       retained  12 bp    DNA     linear SYN\nORIGIN\n        1 atgacgatcgat\n//\n'
  );
  await git.init({ fs, dir: root });
  await git.add({ fs, dir: root, filepath: '.' });
  await git.commit({
    fs,
    dir: root,
    message: 'historical source before transient admission fence',
    author: { name: 'Test', email: 'test@example.invalid' },
  });
  db.prepare('INSERT INTO workspaces(name,path,created_at,repo_uuid) VALUES(?,?,?,?)').run(
    'Project',
    root,
    1,
    randomUUID()
  );
  const originalPaths = [join(source, 'model.pdb'), join(source, 'result.gb')];
  db.prepare(
    `INSERT INTO compute_jobs(id,provider,tool_id,settings_hash,settings_json,provider_job_ref,state,workspace_root,imported_paths_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    'job',
    'boltz',
    'boltz-2',
    'a'.repeat(64),
    '{}',
    'remote-1',
    'imported',
    root,
    JSON.stringify(originalPaths),
    1,
    1
  );
  const workspaces = new NativeDocumentWorkspaces({
    authority: createRegisteredProjectAuthority({
      db: () => db,
      managedRootDir: () => join(file.tmpDir, 'managed'),
    }),
  });
  const documents = createNativeFileDocuments({
    db: () => db,
    workspaceRoots: () => workspaces.readableRoots(),
    writableWorkspaceRoots: () => workspaces.roots(),
    captureWorkspace: (path, mutating) =>
      mutating ? workspaces.capture(path) : workspaces.captureReadable(path),
    profileDirectory: () => join(file.tmpDir, 'profile'),
  });
  let clock = 1000;
  const timers: Array<{ at: number; run: () => void; cancelled: boolean }> = [];
  const recoveries: ComputeRecoveryResult[] = [];
  const sidecarFetch = vi.fn(async () => {
    throw new Error('Local migration must not call a provider');
  });
  const recoverLegacyResult = vi.fn(async (job: ComputeJobRecord, assertJobCurrent: () => void) => {
    const assertWorkspace = workspaces.capture(job.workspaceRoot!);
    const assertCurrent = () => {
      assertJobCurrent();
      assertWorkspace();
    };
    const result = await documents.withCleanPaths([source], () =>
      recoverComputeResult(
        db,
        { workspaceRoot: job.workspaceRoot!, provider: job.provider, remoteId: job.remoteId! },
        { assertCurrent }
      )
    );
    recoveries.push(result);
    return result;
  });
  const registry = new ComputeJobRegistry({
    db: () => currentProfileDb,
    sidecarFetch,
    readCredential: async () => null,
    grantedCapabilities: () => [],
    recoverLegacyResult,
    now: () => clock,
    schedule: (run, delay) => {
      const timer = { at: clock + delay, run, cancelled: false };
      timers.push(timer);
      return {
        cancel: () => {
          timer.cancelled = true;
        },
      };
    },
    random: () => 0,
  });
  cleanup.push(() => registry.stop());
  const runAutomaticDeadlines = async () => {
    const end = clock + 60_000;
    for (let step = 0; step < 100; step++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const next = timers
        .filter((timer) => !timer.cancelled && timer.at <= end)
        .sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      next.cancelled = true;
      clock = Math.max(clock, next.at);
      next.run();
    }
    clock = end;
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  return {
    db,
    root,
    source,
    originalPaths,
    registry,
    recoveries,
    recoverLegacyResult,
    sidecarFetch,
    runAutomaticDeadlines,
    timers,
    useProfileDb: (next: typeof db) => {
      currentProfileDb = next;
    },
  };
}

it('automatically resumes the retained imported result after a real temporary native admission fence clears', async () => {
  const f = await fixture();
  const original = await inventoryComputeSource(f.source);
  const originalHead = await git.resolveRef({ fs, dir: f.root, ref: 'HEAD' });
  const release = await acquireWorkspaceSyncDatabaseFence(f.db);
  try {
    f.registry.start();
    await vi.waitFor(() =>
      expect(f.registry.get('job')?.lastError).toContain('WORKSPACE_SYNC_DATABASE_BUSY')
    );
    expect(f.recoverLegacyResult).toHaveBeenCalledOnce();
    expect(f.recoveries).toEqual([]);
    expect(f.registry.get('job')?.importedPaths).toEqual(f.originalPaths);
    expect((await inventoryComputeSource(f.source)).treeSha256).toBe(original.treeSha256);
    expect(await git.resolveRef({ fs, dir: f.root, ref: 'HEAD' })).toBe(originalHead);
  } finally {
    release();
  }
  await f.runAutomaticDeadlines();
  expect(
    f.recoverLegacyResult.mock.calls.length,
    'the imported terminal job retains an automatic owner after a temporary admission refusal'
  ).toBeGreaterThan(1);
  await vi.waitFor(() => expect(f.recoveries).toHaveLength(1), { timeout: 10_000 });
  expect(f.registry.get('job')?.lastError).toBeNull();
  expect(f.sidecarFetch).not.toHaveBeenCalled();
  const result = f.recoveries[0];
  const target = join(f.root, result.targetRelativePath);
  const output = await inventoryComputeSource(target);
  expect(output.entries.some((entry) => entry.relativePath.endsWith('.forge/plasmid.json'))).toBe(
    true
  );
  expect(
    output.entries.some((entry) => entry.relativePath.endsWith('.dnaforge-molecular.json'))
  ).toBe(true);
  expect((await inventoryComputeSource(f.source)).treeSha256).toBe(original.treeSha256);
  expect((await inventoryComputeSource(join(f.root, result.retainedRelativePath))).treeSha256).toBe(
    original.treeSha256
  );
  const paths = f.registry.get('job')!.importedPaths;
  expect(paths.every((path) => path.startsWith(`${target}/`))).toBe(true);
  const head = await git.resolveRef({ fs, dir: f.root, ref: 'HEAD' });
  await f.runAutomaticDeadlines();
  expect(f.recoveries).toHaveLength(1);
  expect(f.registry.get('job')!.importedPaths).toEqual(paths);
  expect(readdirSync(f.root).filter((name) => name.startsWith('Recovered compute '))).toEqual([
    result.targetRelativePath,
  ]);
  expect((await inventoryComputeSource(target)).treeSha256).toBe(output.treeSha256);
  expect(await git.resolveRef({ fs, dir: f.root, ref: 'HEAD' })).toBe(head);
}, 15_000);

it('retains the readonly owner refusal without publishing or changing imported paths', async () => {
  const f = await fixture();
  const original = await inventoryComputeSource(f.source);
  const head = await git.resolveRef({ fs, dir: f.root, ref: 'HEAD' });
  f.db.prepare("UPDATE workspaces SET access_mode='reference'").run();
  f.registry.start();
  await vi.waitFor(() =>
    expect(f.registry.get('job')?.lastError).toContain('PROJECT_ACCESS_DENIED')
  );
  await f.runAutomaticDeadlines();
  expect(f.recoveries).toEqual([]);
  expect(f.sidecarFetch).not.toHaveBeenCalled();
  expect(f.registry.get('job')?.importedPaths).toEqual(f.originalPaths);
  expect(readdirSync(f.root).filter((name) => name.startsWith('Recovered compute '))).toEqual([]);
  expect((await inventoryComputeSource(f.source)).treeSha256).toBe(original.treeSha256);
  expect(await git.resolveRef({ fs, dir: f.root, ref: 'HEAD' })).toBe(head);
});

async function capturePendingRetry(f: Awaited<ReturnType<typeof fixture>>) {
  const release = await acquireWorkspaceSyncDatabaseFence(f.db);
  try {
    f.registry.start();
    await vi.waitFor(() =>
      expect(f.registry.get('job')?.lastError).toContain('WORKSPACE_SYNC_DATABASE_BUSY')
    );
    const pending = f.timers.filter((timer) => !timer.cancelled);
    expect(pending).toHaveLength(1);
    expect(f.recoverLegacyResult).toHaveBeenCalledOnce();
    return { release, timer: pending[0] };
  } catch (error) {
    release();
    throw error;
  }
}

it('cancels its pending automatic retry on stop and refuses a queued callback after stop', async () => {
  const f = await fixture();
  const source = await inventoryComputeSource(f.source);
  const head = await git.resolveRef({ fs, dir: f.root, ref: 'HEAD' });
  const pending = await capturePendingRetry(f);
  try {
    const job = f.db.prepare("SELECT * FROM compute_jobs WHERE id='job'").get();
    f.registry.stop();
    expect(pending.timer.cancelled).toBe(true);
    pending.release();
    pending.timer.run();
    await f.runAutomaticDeadlines();
    await Promise.allSettled(f.recoverLegacyResult.mock.results.map(({ value }) => value));
    expect(f.recoverLegacyResult).toHaveBeenCalledOnce();
    expect(f.recoveries).toEqual([]);
    expect(f.db.prepare("SELECT * FROM compute_jobs WHERE id='job'").get()).toEqual(job);
    expect(f.sidecarFetch).not.toHaveBeenCalled();
    expect(readdirSync(f.root).filter((name) => name.startsWith('Recovered compute '))).toEqual([]);
    expect((await inventoryComputeSource(f.source)).treeSha256).toBe(source.treeSha256);
    expect(await git.resolveRef({ fs, dir: f.root, ref: 'HEAD' })).toBe(head);
  } finally {
    pending.release();
  }
});

it('refuses a scheduled retry after profile replacement without changing either source job', async () => {
  const f = await fixture();
  const replacement = await fixture();
  const source = await inventoryComputeSource(f.source);
  const replacementSource = await inventoryComputeSource(replacement.source);
  const head = await git.resolveRef({ fs, dir: f.root, ref: 'HEAD' });
  const replacementHead = await git.resolveRef({ fs, dir: replacement.root, ref: 'HEAD' });
  const pending = await capturePendingRetry(f);
  try {
    const job = f.db.prepare("SELECT * FROM compute_jobs WHERE id='job'").get();
    const replacementJob = replacement.db
      .prepare("SELECT * FROM compute_jobs WHERE id='job'")
      .get();
    pending.release();
    f.useProfileDb(replacement.db);
    await f.runAutomaticDeadlines();
    await Promise.allSettled(f.recoverLegacyResult.mock.results.map(({ value }) => value));
    expect(f.recoverLegacyResult).toHaveBeenCalledOnce();
    expect(f.recoveries).toEqual([]);
    expect(f.db.prepare("SELECT * FROM compute_jobs WHERE id='job'").get()).toEqual(job);
    expect(replacement.db.prepare("SELECT * FROM compute_jobs WHERE id='job'").get()).toEqual(
      replacementJob
    );
    expect(f.sidecarFetch).not.toHaveBeenCalled();
    expect(replacement.sidecarFetch).not.toHaveBeenCalled();
    expect(readdirSync(f.root).filter((name) => name.startsWith('Recovered compute '))).toEqual([]);
    expect(
      readdirSync(replacement.root).filter((name) => name.startsWith('Recovered compute '))
    ).toEqual([]);
    expect((await inventoryComputeSource(f.source)).treeSha256).toBe(source.treeSha256);
    expect((await inventoryComputeSource(replacement.source)).treeSha256).toBe(
      replacementSource.treeSha256
    );
    expect(await git.resolveRef({ fs, dir: f.root, ref: 'HEAD' })).toBe(head);
    expect(await git.resolveRef({ fs, dir: replacement.root, ref: 'HEAD' })).toBe(replacementHead);
  } finally {
    pending.release();
  }
});

it('refuses a scheduled retry when the same database job changes its project owner', async () => {
  const f = await fixture();
  const replacement = await fixture();
  f.db
    .prepare('INSERT INTO workspaces(name,path,created_at,repo_uuid) VALUES(?,?,?,?)')
    .run('Changed project', replacement.root, 2, randomUUID());
  const source = await inventoryComputeSource(f.source);
  const replacementSource = await inventoryComputeSource(replacement.source);
  const head = await git.resolveRef({ fs, dir: f.root, ref: 'HEAD' });
  const replacementHead = await git.resolveRef({ fs, dir: replacement.root, ref: 'HEAD' });
  const pending = await capturePendingRetry(f);
  try {
    pending.release();
    f.db
      .prepare("UPDATE compute_jobs SET workspace_root=?,imported_paths_json=? WHERE id='job'")
      .run(replacement.root, JSON.stringify(replacement.originalPaths));
    const job = f.db.prepare("SELECT * FROM compute_jobs WHERE id='job'").get();
    const replacementJob = replacement.db
      .prepare("SELECT * FROM compute_jobs WHERE id='job'")
      .get();
    await f.runAutomaticDeadlines();
    await Promise.allSettled(f.recoverLegacyResult.mock.results.map(({ value }) => value));
    expect(f.recoverLegacyResult).toHaveBeenCalledOnce();
    expect(f.recoveries).toEqual([]);
    expect(f.db.prepare("SELECT * FROM compute_jobs WHERE id='job'").get()).toEqual(job);
    expect(replacement.db.prepare("SELECT * FROM compute_jobs WHERE id='job'").get()).toEqual(
      replacementJob
    );
    expect(f.sidecarFetch).not.toHaveBeenCalled();
    expect(readdirSync(f.root).filter((name) => name.startsWith('Recovered compute '))).toEqual([]);
    expect(
      readdirSync(replacement.root).filter((name) => name.startsWith('Recovered compute '))
    ).toEqual([]);
    expect((await inventoryComputeSource(f.source)).treeSha256).toBe(source.treeSha256);
    expect((await inventoryComputeSource(replacement.source)).treeSha256).toBe(
      replacementSource.treeSha256
    );
    expect(await git.resolveRef({ fs, dir: f.root, ref: 'HEAD' })).toBe(head);
    expect(await git.resolveRef({ fs, dir: replacement.root, ref: 'HEAD' })).toBe(replacementHead);
  } finally {
    pending.release();
  }
});
