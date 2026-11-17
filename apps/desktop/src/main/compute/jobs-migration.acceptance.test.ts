import * as fs from 'node:fs';
import * as git from 'isomorphic-git';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComputeJobRecord, ComputeRecoveryResult } from '../../shared/compute-jobs-ipc';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => '1.0.0' },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('../analytics', () => ({ trackEvent: vi.fn() }));

import { createFileTestDb, openFileTestDb } from '../__tests__/test-db';
import { ensureSchema } from '../schema';
import { ComputeJobRegistry } from './jobs';
import { recoverComputeResult } from '../workspace-git/compute-result-recovery';
import { inventoryComputeSource } from '../workspace-git/compute-result-retention';
import { createRegisteredProjectAuthority } from '../registered-project-authority';
import { NativeDocumentWorkspaces } from '../native-document-workspaces';
import { createNativeFileDocuments } from '../native-file-documents';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const run of cleanup.splice(0).reverse()) run();
});

async function fixture() {
  const file = createFileTestDb('compute-startup-migration');
  cleanup.push(file.cleanup);
  let db: Database.Database = file.db;
  ensureSchema(db, file.dbPath);
  const root = join(realpathSync(file.tmpDir), 'project');
  const source = join(root, 'compute/boltz/remote-1');
  mkdirSync(join(source, 'empty'), { recursive: true });
  writeFileSync(join(source, 'data.bin'), Buffer.from([255, 0, 128]));
  writeFileSync(join(source, '.receipt'), 'original receipt');
  writeFileSync(
    join(source, 'model.pdb'),
    'HEADER    LEGACY COMPUTE RESULT\nATOM      1  CA  ALA A   1\nEND\n'
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
    message: 'retained compute source',
    author: { name: 'Test', email: 'test@example.invalid' },
  });
  db.prepare('INSERT INTO workspaces(name,path,created_at,repo_uuid) VALUES (?,?,?,?)').run(
    'Project',
    root,
    1,
    randomUUID()
  );
  db.prepare(
    `INSERT INTO compute_jobs (id,provider,tool_id,settings_hash,settings_json,provider_job_ref,state,workspace_root,imported_paths_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    'job',
    'boltz',
    'boltz-2',
    'a'.repeat(64),
    '{}',
    'remote-1',
    'imported',
    root,
    JSON.stringify([join(source, 'model.pdb'), join(source, 'result.gb')]),
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
  const successes: ComputeRecoveryResult[] = [];
  const failures: unknown[] = [];
  const attempts: Promise<unknown>[] = [];
  const recoverLegacyResult = vi.fn((job: ComputeJobRecord) => {
    const task = (async () => {
      if (!job.workspaceRoot || !job.remoteId) throw new Error('Missing compute owner');
      const assertCurrent = workspaces.capture(job.workspaceRoot);
      const result = await documents.withCleanPaths([job.workspaceRoot], () =>
        recoverComputeResult(
          db,
          {
            workspaceRoot: job.workspaceRoot!,
            provider: job.provider,
            remoteId: job.remoteId!,
          },
          { assertCurrent }
        )
      );
      successes.push(result);
      return result;
    })();
    attempts.push(
      task.catch((error) => {
        failures.push(error);
      })
    );
    return task;
  });
  const createRegistry = () => {
    const deps: ConstructorParameters<typeof ComputeJobRegistry>[0] & {
      recoverLegacyResult: (job: ComputeJobRecord) => Promise<ComputeRecoveryResult>;
    } = {
      db: () => db,
      recoverLegacyResult,
      sidecarFetch: vi.fn(async () => {
        throw new Error('Local migration must not call the provider');
      }),
      readCredential: vi.fn(async () => null),
      grantedCapabilities: () => [],
      schedule: () => ({ cancel() {} }),
      now: () => 1000,
    };
    const registry = new ComputeJobRegistry(deps);
    cleanup.push(() => registry.stop());
    return registry;
  };
  const reopen = () => {
    db.close();
    db = openFileTestDb(file.dbPath);
    cleanup.push(() => db.close());
    return createRegistry();
  };
  return {
    get db() {
      return db;
    },
    root,
    source,
    createRegistry,
    reopen,
    recoverLegacyResult,
    successes,
    failures,
    attempts,
  };
}

describe('automatic migration of imported legacy compute results', () => {
  it('retries a retained startup result after legacy draft transfer and recovers the same owner exactly once', async () => {
    const f = await fixture();
    const before = await inventoryComputeSource(f.source);
    f.recoverLegacyResult.mockRejectedValueOnce(new Error('LEGACY_FILE_DRAFT_MIGRATION_REQUIRED'));
    const registry = f.createRegistry();
    registry.start();
    await vi.waitFor(() =>
      expect(registry.get('job')?.lastError).toContain('LEGACY_FILE_DRAFT_MIGRATION_REQUIRED')
    );
    expect(f.successes).toEqual([]);
    expect((await inventoryComputeSource(f.source)).treeSha256).toBe(before.treeSha256);
    const retry = (
      registry as ComputeJobRegistry & { retryLegacyResultMigrations?: () => void | Promise<void> }
    ).retryLegacyResultMigrations;
    expect(retry, 'native draft completion has a retained-job retry owner').toBeTypeOf('function');
    await retry!.call(registry);
    await vi.waitFor(() => expect(f.successes).toHaveLength(1));
    await Promise.all(f.attempts);
    expect(f.failures).toEqual([]);
    expect(registry.get('job')?.lastError).toBeNull();
    const result = f.successes[0];
    const output = await inventoryComputeSource(join(f.root, result.targetRelativePath));
    const head = await git.resolveRef({ fs, dir: f.root, ref: 'HEAD' });
    await retry!.call(registry);
    await Promise.resolve();
    expect(f.recoverLegacyResult).toHaveBeenCalledTimes(2);
    expect((await inventoryComputeSource(join(f.root, result.targetRelativePath))).treeSha256).toBe(
      output.treeSha256
    );
    expect((await inventoryComputeSource(f.source)).treeSha256).toBe(before.treeSha256);
    expect(await git.resolveRef({ fs, dir: f.root, ref: 'HEAD' })).toBe(head);
  });

  it('recovers on registry startup and preserves exact source and one stable output across restart', async () => {
    const f = await fixture();
    const before = await inventoryComputeSource(f.source);
    const registry = f.createRegistry();
    registry.start();
    await vi.waitFor(() => expect(f.recoverLegacyResult).toHaveBeenCalledOnce());
    await Promise.all(f.attempts);
    expect(f.failures).toEqual([]);
    expect(f.successes).toHaveLength(1);
    const result = f.successes[0];
    expect(result.kind).toBe('committed');
    const target = join(f.root, result.targetRelativePath);
    const output = await inventoryComputeSource(target);
    expect(
      output.entries.some((entry) => entry.relativePath.endsWith('.dnaforge-molecular.json'))
    ).toBe(true);
    expect(output.entries.some((entry) => entry.relativePath.endsWith('.forge/plasmid.json'))).toBe(
      true
    );
    expect((await inventoryComputeSource(f.source)).treeSha256).toBe(before.treeSha256);
    expect(
      (await inventoryComputeSource(join(f.root, result.retainedRelativePath))).treeSha256
    ).toBe(before.treeSha256);
    const paths = registry.get('job')!.importedPaths;
    expect(paths.every((path) => path.startsWith(`${target}/`))).toBe(true);
    const head = await git.resolveRef({ fs, dir: f.root, ref: 'HEAD' });
    registry.stop();
    const restarted = f.reopen();
    restarted.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await Promise.all(f.attempts);
    expect(readdirSync(f.root).filter((path) => path.startsWith('Recovered compute '))).toEqual([
      result.targetRelativePath,
    ]);
    expect(restarted.get('job')!.importedPaths).toEqual(paths);
    expect((await inventoryComputeSource(target)).treeSha256).toBe(output.treeSha256);
    expect((await inventoryComputeSource(f.source)).treeSha256).toBe(before.treeSha256);
    expect(await git.resolveRef({ fs, dir: f.root, ref: 'HEAD' })).toBe(head);
  });

  it('recovers an old-format result that becomes imported after registry startup', async () => {
    const f = await fixture();
    const row = f.db
      .prepare("SELECT imported_paths_json FROM compute_jobs WHERE id='job'")
      .get() as { imported_paths_json: string };
    const paths = JSON.parse(row.imported_paths_json) as string[];
    f.db
      .prepare("UPDATE compute_jobs SET state='completed',imported_paths_json='[]' WHERE id='job'")
      .run();
    const registry = f.createRegistry();
    registry.start();
    registry.markImported('job', paths);
    await vi.waitFor(() => expect(f.recoverLegacyResult).toHaveBeenCalledOnce());
    await Promise.all(f.attempts);
    expect(f.failures).toEqual([]);
    expect(f.successes).toHaveLength(1);
    expect(existsSync(join(f.root, f.successes[0].targetRelativePath))).toBe(true);
  });

  it.each(['readonly', 'missing-owner'])(
    'retains source and job paths when %s blocks native write authority',
    async (state) => {
      const f = await fixture();
      const before = await inventoryComputeSource(f.source);
      const paths = (
        f.db.prepare("SELECT imported_paths_json FROM compute_jobs WHERE id='job'").get() as {
          imported_paths_json: string;
        }
      ).imported_paths_json;
      if (state === 'readonly') f.db.prepare("UPDATE workspaces SET access_mode='reference'").run();
      else f.db.prepare('DELETE FROM workspaces').run();
      const registry = f.createRegistry();
      registry.start();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await Promise.all(f.attempts);
      expect(f.successes).toEqual([]);
      expect(readdirSync(f.root).filter((path) => path.startsWith('Recovered compute '))).toEqual(
        []
      );
      expect(
        (
          f.db.prepare("SELECT imported_paths_json FROM compute_jobs WHERE id='job'").get() as {
            imported_paths_json: string;
          }
        ).imported_paths_json
      ).toBe(paths);
      expect((await inventoryComputeSource(f.source)).treeSha256).toBe(before.treeSha256);
      expect(readFileSync(join(f.source, '.receipt'), 'utf8')).toBe('original receipt');
    }
  );
});
